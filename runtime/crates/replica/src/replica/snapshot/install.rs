//! Installing a snapshot or a generation-0 base: control read, manifest checks, chunk fetch and swap.

use super::*;

/// A manifest's chunks in the order they are decoded: resources before the
/// records indexed under them, and the index before the rows it positions.
pub(super) fn chunk_queue(manifest: &ManifestPayload) -> Vec<(SectionKind, ChunkRef)> {
    let mut queue = Vec::new();
    for want in [
        SectionKind::Legacy(L::Resources),
        SectionKind::Legacy(L::Settings),
        SectionKind::Legacy(L::Index),
        SectionKind::Legacy(L::Records),
        SectionKind::Legacy(L::Files),
        SectionKind::AttachmentFiles,
        SectionKind::UnindexedMarkdownFiles,
        SectionKind::Legacy(L::Tombstones),
        SectionKind::AttachmentTombstones,
        SectionKind::UnindexedMarkdownTombstones,
        SectionKind::Legacy(L::Aliases),
        SectionKind::Legacy(L::Conflicts),
        SectionKind::Legacy(L::Receipts),
    ] {
        for s in manifest.sections.iter().filter(|s| s.kind == want) {
            queue.extend(s.chunks.iter().map(|c| (want, c.clone())));
        }
    }
    queue
}

/// Why a fetched chunk object is not the chunk its reference names.
pub(super) enum ChunkError {
    /// It is that chunk, in a payload this build cannot decode.
    NewerCodec,
    Bad(&'static str),
}

impl<S: Store> Replica<S> {
    // ------------------------------------------------------------ install

    /// Start installing the latest snapshot (behind retention, or bootstrapping).
    ///
    /// **Bounded.** Reachable when the store stages persistently
    /// ([`Replica::snapshot_install_available`]). A replica over a store without
    /// a staging area that is behind reports an incident instead.
    pub(crate) fn begin_install(&mut self) {
        if crate::mirror_admission::ensure_open(&self.store).is_err() {
            return;
        }
        // A snapshot-installed policy is not a replay this instance verified.
        self.hosted_origin_unproven();
        if !self.snapshot_install_available() {
            self.incident(
                IncidentKind::UpgradeRequired,
                Some(Value::Text(
                    "behind retention: this store cannot stage a snapshot install".into(),
                )),
            );
            return;
        }
        if self.install.is_some() {
            return;
        }
        self.install_refs = None;
        self.install = Some(Install::Control);
        self.install_refs = None;
        self.install_points = vec![ControlPoint {
            seq: self.policy.seq,
            policy: self.policy.clone(),
        }];
        self.caught_up = false;
        self.request_control_read();
        self.status_dirty = true;
    }

    /// Start installing the generation-0 manifest named by a valid `base` at
    /// `base.seq` (`snapshot.md` §7). The staged install machinery is the same as a
    /// snapshot's, with the base checks of [`Self::verify_base_manifest`]; apply
    /// waits before the base until the install swaps in its state at the base's
    /// position. Bounded staging is required exactly as for a snapshot install.
    pub(crate) fn begin_base_install(
        &mut self,
        base: BaseInstall,
        manifest: B32,
        signer: mdbn_wire::common::Uuid,
    ) {
        if crate::mirror_admission::ensure_open(&self.store).is_err() {
            return;
        }
        if self.install.is_some() {
            return;
        }
        self.install_refs = None;
        // The policy in force at the base: the manifest is verified against it.
        self.install_points = vec![ControlPoint {
            seq: 0,
            policy: self.policy.clone(),
        }];
        self.install_base = Some(base);
        self.caught_up = false;
        let p = SnapshotPointer {
            seq: 0,
            manifest,
            author: signer,
            created_at: 0,
            endorsed: false,
        };
        self.request_manifest(p);
        self.status_dirty = true;
    }

    /// A generation-0 manifest for the `base` being installed: `seq = 0`, zero
    /// chain and control chain, the base's state digest, signed by a device that is
    /// active and keyed in the policy at the base.
    fn verify_base_manifest(
        &self,
        raw: &[u8],
        item: &Item,
        m: &ManifestPayload,
        base: &BaseInstall,
    ) -> Result<(), &'static str> {
        super::mirror_install::check_gen0_manifest(
            raw,
            item,
            m,
            base.epoch,
            base.state_digest,
            &self.policy,
            self.sealer.verifier(),
        )
        .map(|_| ())
        .map_err(super::mirror_install::Error::message)
    }

    fn request_control_read(&mut self) {
        let id = self.queue(LogRequest::Read(ReadParams {
            collection: self.cfg.collection,
            after: self.policy.seq,
            limit: 1000,
            kinds: Some(mdbn_wire::log_service::ReadKinds::Control),
            max_bytes: self.read_bytes(),
        }));
        self.inflight.insert(id, Inflight::Install);
    }

    /// The policy state in force at `seq` (the last control item at or before it).
    fn policy_at(&self, seq: u64) -> Option<&crate::policy::PolicyState> {
        self.install_points
            .iter()
            .rev()
            .find(|c| c.seq <= seq)
            .map(|c| &c.policy)
    }

    /// The manifest's signer had write authority in `at`, the policy state at the
    /// manifest's position (the rule for the signer of an `entry` or a `base`:
    /// a keyed device of an editor or owner, or the hosted replica in a cloud
    /// copy), the signature verifies over the received bytes, and its control
    /// chain is the one this replica computed from the control items.
    ///
    /// A snapshot replaces the log before it, so only a device that could have
    /// written that log may author one: a read-only member's device holds the key
    /// and could otherwise seal and sign any state.
    pub(crate) fn verify_manifest(
        &self,
        raw: &[u8],
        item: &Item,
        m: &ManifestPayload,
        at: &crate::policy::PolicyState,
    ) -> Result<(), &'static str> {
        let signer = item.signer.ok_or("manifest has no signer")?;
        let d = at
            .devices
            .get(&signer)
            .filter(|_| at.device_can_write(&signer))
            .ok_or("manifest signer had no write authority at its position")?;
        let digest =
            crate::crypto::raw::signed_digest_from_bytes(raw).map_err(|_| "manifest digest")?;
        let sig = item.sig.ok_or("manifest is not signed")?;
        if !self.sealer.verifier().verify(&d.sign_pk.0, &digest, &sig.0) {
            return Err("manifest signature does not verify");
        }
        if m.control_chain != at.ctl_chain {
            return Err("manifest control chain differs from the control items read");
        }
        Ok(())
    }

    /// A fetched chunk object, checked against its reference and opened: its
    /// address, its plaintext's hash and size, and the section it says it is of.
    pub(super) fn open_chunk(
        &self,
        bytes: &[u8],
        kind: SectionKind,
        cref: &ChunkRef,
    ) -> Result<ChunkPayload, ChunkError> {
        if mdbn_wire::hash::sha256(bytes) != cref.address {
            return Err(ChunkError::Bad("chunk address mismatch"));
        }
        let plain = Item::from_bytes(bytes)
            .ok()
            .and_then(|i| self.sealer.open(&i, bytes).ok())
            .ok_or(ChunkError::Bad("chunk does not open"))?;
        if mdbn_wire::hash::sha256(&plain) != cref.plain_hash
            || plain.len() as u64 != cref.plain_size
        {
            return Err(ChunkError::Bad(
                "chunk plaintext differs from its reference",
            ));
        }
        let chunk = ChunkPayload::from_bytes(&plain).map_err(|e| {
            if e.is_unknown() {
                ChunkError::NewerCodec
            } else {
                ChunkError::Bad("chunk does not decode")
            }
        })?;
        if chunk.section != kind {
            return Err(ChunkError::Bad("chunk section differs"));
        }
        Ok(chunk)
    }

    /// Whether this replica can install (and endorse) a snapshot: its store
    /// stages persistently, so an install never holds the whole snapshot.
    pub fn snapshot_install_available(&self) -> bool {
        self.store.stages() || (IN_MEMORY_INSTALL && !self.shipped_install_gate)
    }

    /// Apply the shipped build's install gate even in a test or simulator build
    /// (where the `testing` feature allows in-memory staging): install then
    /// needs a staging store. Only ever tightens the gate.
    pub fn enforce_shipped_install_gate(&mut self) {
        self.shipped_install_gate = true;
    }

    /// Whether an install is in progress (queries answer `complete: false`).
    pub fn installing(&self) -> bool {
        self.install.is_some()
    }

    /// Chunks staged and chunks in the snapshot, while an install runs. Both are
    /// counts only, so a host can report them without carrying any content.
    pub fn install_status(&self) -> Option<(u64, u64)> {
        self.install.as_ref().map(|_| self.install_progress)
    }

    /// The snapshot being installed is refused. Nothing was written: the staged
    /// rows are dropped and the previous confirmed state and head stay as they
    /// were. The older retained snapshot is tried next (`snapshot.md` §8); the
    /// install is abandoned when there is none, or it is refused too.
    pub(in crate::replica) fn install_fail(&mut self, why: &str) {
        self.install_fail_as(IncidentKind::Integrity, why);
    }

    fn install_fail_as(&mut self, kind: IncidentKind, why: &str) {
        let older = self.install_offer.as_mut().and_then(|o| o.older.take());
        if let Some(older) = older
            && self.install_reset().is_ok()
        {
            if let Some(o) = self.install_offer.as_mut() {
                o.refused = Some((kind, why.to_string()));
            }
            self.stats.snapshot_fallbacks += 1;
            self.install_refs = None;
            self.status_dirty = true;
            return self.request_manifest(older);
        }
        // Every snapshot offered is refused. Fetching them again would end the
        // same way: wait for a newer one.
        let offer = self.install_offer.take();
        if let Some(o) = &offer {
            self.install_refused = Some(o.newest);
        }
        match offer.and_then(|o| o.refused) {
            Some((kind, newest)) => {
                self.install_abort(kind, &format!("{newest}; older snapshot: {why}"));
            }
            None => self.install_abort(kind, why),
        }
    }

    /// Abandon the install and report why: no snapshot is left to try, or the
    /// failure is this replica's (its store), not a snapshot's.
    fn install_abort(&mut self, mut kind: IncidentKind, why: &str) {
        self.install = None;
        self.install_offer = None;
        if let Some(b) = self.install_base.take() {
            self.base_install_failed = Some(b.seq);
        }
        self.install_refs = None;
        let cleanup = self.install_reset();
        self.install_points.clear();
        let detail = match cleanup {
            Ok(()) => format!("snapshot install: {why}"),
            Err(e) => {
                // A cleanup/store failure is never downgraded to codec availability.
                kind = IncidentKind::Integrity;
                format!("snapshot install: {why}; staging cleanup failed: {e}")
            }
        };
        self.incident(kind, Some(Value::Text(detail)));
    }

    /// Fetch the manifest `p` names.
    fn request_manifest(&mut self, p: SnapshotPointer) {
        let id = self.queue(LogRequest::GetObject {
            collection: self.cfg.collection,
            address: p.manifest,
            range: None,
        });
        self.inflight.insert(id, Inflight::Install);
        self.install = Some(Install::Manifest(p));
    }

    /// Drop everything staged: in memory, and in the store's staging area.
    fn install_reset(&mut self) -> Result<(), StoreError> {
        // A control-read failure may have an unknown committed outcome. Do not
        // issue a staging cleanup transaction after the terminal fail-stop.
        // Known-abort recovery can still discard/refetch and finish an install.
        if self.apply_fault {
            return Err(StoreError::Io("apply_reopen_required".into()));
        }
        self.install_staged = Tx::default();
        self.install_native_roots = Default::default();
        self.install_native_auth = Default::default();
        self.install_text_sources = Default::default();
        self.install_rows.clear();
        if self.store.stages() {
            // Put/Swap must never consume leftovers from another install.
            // Commit is atomic and durable under the Store contract. If it fails,
            // initialization remains blocked and retries before fetching any chunk.
            if let Err(e) = self.store.commit(Tx {
                stage: crate::store::Stage::Discard,
                ..Tx::default()
            }) {
                if !matches!(e, StoreError::CommitAborted(_)) {
                    self.committed_read_fault();
                }
                return Err(e);
            }
        }
        Ok(())
    }

    fn install_start_chunks(&mut self, manifest: Box<ManifestPayload>) {
        if let Err(e) = self.install_reset() {
            self.install = Some(Install::Reset(manifest));
            self.install_retry = true;
            self.incident(
                IncidentKind::Integrity,
                Some(Value::Text(format!("snapshot staging initialization: {e}"))),
            );
            return;
        }
        let queue = chunk_queue(&manifest);
        self.install_progress = (0, queue.len() as u64);
        self.install = Some(Install::Chunks {
            manifest,
            queue,
            next: 0,
        });
        self.install_next();
    }

    pub(crate) fn on_install_reply(&mut self, reply: crate::log::LogReply) {
        self.on_install_reply_body(reply, true);
    }
    #[cfg(test)]
    pub(crate) fn test_on_native_snapshot_reply(&mut self, reply: crate::log::LogReply) {
        self.on_install_reply_body(reply, true);
    }
    fn on_install_reply_body(&mut self, reply: crate::log::LogReply, native: bool) {
        let Some(state) = self.install.take() else {
            return;
        };
        let resp = match reply {
            Ok(r) => r,
            Err(e) => {
                // The service does not have an object of this snapshot, and
                // asking again gets the same answer: the snapshot is refused.
                if let Some(object) = state.object().filter(|_| e.object_missing()) {
                    return self.install_fail(&format!("the service does not have {object}"));
                }
                // Transient: keep everything staged and retry this step on the next
                // tick. An install is never left half-applied.
                self.install = Some(state);
                self.install_retry = true;
                return;
            }
        };
        match (state, resp) {
            (Install::Control, LogResponse::Read(r)) => {
                for it in r.items {
                    if it.seq <= self.policy.seq {
                        continue;
                    }
                    match self.evaluate_control_bytes(it.seq, &it.item.0) {
                        Ok(()) => {}
                        Err(why) => return self.install_fail(&why),
                    }
                    self.install_points.push(ControlPoint {
                        seq: it.seq,
                        policy: self.policy.clone(),
                    });
                }
                self.install = Some(Install::Control);
                if r.more {
                    return self.request_control_read();
                }
                self.install = Some(Install::Pointer);
                let id = self.queue(LogRequest::GetSnapshot {
                    collection: self.cfg.collection,
                });
                self.inflight.insert(id, Inflight::Install);
            }
            (Install::Pointer, LogResponse::GetSnapshot(ptrs)) => {
                // The retained pointers, newest first: the newest, and the older
                // one to fall back to if the newest is refused.
                let mut ptrs = ptrs.into_iter();
                let Some(p) = ptrs.next() else {
                    return self.install_fail("no snapshot to install");
                };
                if self.install_refused == Some(p.manifest) {
                    // Refused already, and still the newest: its incident stands.
                    self.install_points.clear();
                    self.status_dirty = true;
                    return;
                }
                self.install_offer = Some(Offer {
                    newest: p.manifest,
                    older: ptrs.next(),
                    refused: None,
                });
                self.request_manifest(p);
            }
            (Install::Manifest(p), LogResponse::GetObject { bytes, .. }) => {
                if mdbn_wire::hash::sha256(&bytes) != p.manifest {
                    return self.install_fail("manifest address mismatch");
                }
                let Ok(item) = Item::from_bytes(&bytes) else {
                    return self.install_fail("manifest does not decode");
                };
                if item.kind != ItemKind::Manifest || item.collection != self.cfg.collection {
                    return self.install_fail("not a manifest of this collection");
                }
                let Ok(plain) = self.sealer.open(&item, &bytes) else {
                    return self.install_fail("manifest does not open");
                };
                // The closed runtime family decodes legacy1–9, attachment10/11
                // and unindexed12/13. Unsupported decoded sections below stall
                // before any row; genuinely future sections fail decoding.
                let (m, ref_indices) = match mdbn_wire::ref_index::decode_manifest(&plain) {
                    Ok(m) => m,
                    Err(e) if e.is_unknown() => {
                        return self.install_fail_as(
                            IncidentKind::UpgradeRequired,
                            "manifest payload requires a newer codec",
                        );
                    }
                    Err(_) => return self.install_fail("manifest payload does not decode"),
                };
                if !native
                    && m.sections.iter().any(|s| {
                        matches!(
                            s.kind,
                            SectionKind::UnindexedMarkdownFiles
                                | SectionKind::UnindexedMarkdownTombstones
                        )
                    })
                {
                    return self.install_fail_as(
                        IncidentKind::UpgradeRequired,
                        "unindexed_markdown_snapshot_not_yet",
                    );
                }
                if m.seq != p.seq {
                    return self.install_fail("manifest position differs from its pointer");
                }
                if self.install_base.is_none() {
                    // State planned under a semantics major this build does not
                    // have (`00-overview.md` §6.3).
                    if m.sem.major > mdbn_core::semantics::SEM.major {
                        return self.install_fail_as(
                            IncidentKind::UpgradeRequired,
                            "snapshot was built by newer semantics than this build has",
                        );
                    }
                    // The ratchet only rises, and this replica's is the log's at
                    // its own head, below the manifest's position.
                    if m.sem_ratchet.is_some_and(|r| r < self.sem_ratchet) {
                        return self
                            .install_fail("manifest semantics ratchet is below this replica's");
                    }
                }
                let verdict = match (&self.install_base, self.policy_at(m.seq)) {
                    (Some(base), _) => self.verify_base_manifest(&bytes, &item, &m, base),
                    (None, Some(at)) => self.verify_manifest(&bytes, &item, &m, at),
                    (None, None) => Err("no policy state at the manifest's position"),
                };
                if let Err(why) = verdict {
                    return self.install_fail(why);
                }
                // Direct refs retain their source closure as before. Fmt-2
                // keeps header refs in the charged compact vector, not an extra
                // preview tree alongside verified members/final conversion.
                self.install_refs = ref_indices
                    .is_empty()
                    .then(|| item.refs.clone().unwrap_or_default().into_iter().collect());
                // The key epoch in force at the snapshot's position bounds the
                // attachment descriptors its rows may carry (V7).
                self.install_rows = ChunkRows::new(
                    self.cfg.collection,
                    self.policy_at(m.seq).map_or(0, |p| p.epoch),
                );
                if self.install_base.is_none() && self.head.seq > 0 && m.seq <= self.head.seq {
                    return self.install_fail("snapshot is not ahead of this replica's head");
                }
                let item_refs = item.refs.unwrap_or_default();
                self.install_after_manifest(p, Box::new(m), item_refs, ref_indices);
            }
            (state @ Install::RefIndices { .. }, LogResponse::GetObject { bytes, .. }) => {
                self.on_ref_index_object(state, bytes);
            }
            (Install::Chain(_p, m), LogResponse::Read(r)) => {
                let ok = match r.items.first() {
                    Some(it) if it.seq == m.seq + 1 => {
                        Item::from_bytes(&it.item.0).ok().and_then(|i| i.prev) == Some(m.chain)
                    }
                    _ => r.head == m.seq && r.head_chain == m.chain,
                };
                if !ok {
                    return self.install_fail("manifest chain does not match the log");
                }
                // Stage only after old staging was successfully discarded.
                // Confirmed state stays untouched until the verified swap.
                self.install_start_chunks(m);
            }
            (
                Install::Chunks {
                    manifest,
                    queue,
                    next,
                },
                LogResponse::GetObject { bytes, .. },
            ) => {
                let Some((kind, cref)) = queue.get(next).cloned() else {
                    return self.install_fail("chunk out of order");
                };
                let chunk = match self.open_chunk(&bytes, kind, &cref) {
                    Ok(chunk) => chunk,
                    Err(ChunkError::NewerCodec) => {
                        return self.install_fail_as(
                            IncidentKind::UpgradeRequired,
                            "chunk payload requires a newer codec",
                        );
                    }
                    Err(ChunkError::Bad(why)) => return self.install_fail(why),
                };
                let extended = matches!(
                    chunk.section,
                    SectionKind::UnindexedMarkdownFiles | SectionKind::UnindexedMarkdownTombstones
                ) || (chunk.section == SectionKind::Legacy(L::Conflicts)
                    && chunk.rows_as::<WConflictRow>().is_ok_and(|rows| {
                        rows.iter().any(|r| {
                            super::attachment_runtime::extended_conflict_not_yet(&r.conflict)
                        })
                    }));
                if extended && !native {
                    return self.install_fail_as(
                        IncidentKind::UpgradeRequired,
                        "unindexed_markdown_snapshot_not_yet",
                    );
                }
                if let Err(e) = self.install_chunk(&chunk) {
                    return self.install_fail(&e);
                }
                self.install_progress.0 += 1;
                self.status_dirty = true;
                self.install = Some(Install::Chunks {
                    manifest,
                    queue,
                    next: next + 1,
                });
                self.install_next();
            }
            _ => self.install_fail("unexpected reply"),
        }
    }

    /// Re-issue the current install step after a transient failure.
    pub(crate) fn retry_install(&mut self) {
        if !std::mem::take(&mut self.install_retry) {
            return;
        }
        if matches!(self.install, Some(Install::Reset(_))) {
            if let Some(Install::Reset(manifest)) = self.install.take() {
                self.install_start_chunks(manifest);
            }
            return;
        }
        let request = match &self.install {
            Some(Install::Control) => return self.request_control_read(),
            Some(Install::Pointer) => LogRequest::GetSnapshot {
                collection: self.cfg.collection,
            },
            Some(Install::Manifest(p)) => LogRequest::GetObject {
                collection: self.cfg.collection,
                address: p.manifest,
                range: None,
            },
            Some(Install::RefIndices { .. }) => return self.request_next_ref_index(),
            Some(Install::Chain(_, m)) => LogRequest::Read(ReadParams {
                collection: self.cfg.collection,
                after: m.seq,
                limit: 1,
                kinds: None,
                max_bytes: None,
            }),
            Some(Install::Sources(_)) => {
                if let Some(Install::Sources(m)) = self.install.take() {
                    self.install_finish(m);
                }
                return;
            }
            Some(Install::Chunks { .. }) => return self.install_next(),
            Some(Install::Reset(_)) | None => return,
        };
        let id = self.queue(request);
        self.inflight.insert(id, Inflight::Install);
    }

    fn install_next(&mut self) {
        let Some(Install::Chunks {
            manifest,
            queue,
            next,
        }) = self.install.take()
        else {
            return;
        };
        if let Some((_, c)) = queue.get(next) {
            let id = self.queue(LogRequest::GetObject {
                collection: self.cfg.collection,
                address: c.address,
                range: None,
            });
            self.inflight.insert(id, Inflight::Install);
            self.install = Some(Install::Chunks {
                manifest,
                queue,
                next,
            });
            return;
        }
        self.install_finish(manifest);
    }
    fn install_finish(&mut self, manifest: Box<ManifestPayload>) {
        self.install = Some(Install::Sources(manifest.clone()));
        match self.snapshot_text_check(&manifest) {
            super::snapshot_text::Check::Pending => {
                self.install_retry = true;
                return;
            }
            super::snapshot_text::Check::Ready => {}
            super::snapshot_text::Check::Failed(crate::attachments::StreamError::NoKey) => {
                self.snapshot_text_wait_key();
                self.incident(
                    IncidentKind::WaitingForKey,
                    Some(Value::Text("snapshot record source key unavailable".into())),
                );
                return;
            }
            super::snapshot_text::Check::Failed(e) => {
                return self.install_fail(&format!("record source: {e:?}"));
            }
        }
        let source_meta = match self.native_install_check(&manifest) {
            super::unindexed_snapshot::Check::Pending => {
                self.install_retry = true;
                return;
            }
            super::unindexed_snapshot::Check::Ready(meta) => meta,
            super::unindexed_snapshot::Check::StoreFailed(e) => {
                return self.install_abort(IncidentKind::Integrity, &format!("source store: {e}"));
            }
            super::unindexed_snapshot::Check::Failed(crate::attachments::StreamError::NoKey) => {
                self.native_install_wait_key();
                self.incident(
                    IncidentKind::WaitingForKey,
                    Some(Value::Text("snapshot native source key unavailable".into())),
                );
                return;
            }
            super::unindexed_snapshot::Check::Failed(e) => {
                return self.install_fail(&format!("native source: {e:?}"));
            }
        };
        // Finish only after complete source authentication and the exact digest.
        let digest = self.install_rows.index.digest();
        self.install_rows.clear();
        if digest != manifest.state_digest {
            return self.install_fail("state digest mismatch");
        }
        let mut staged = std::mem::take(&mut self.install_staged);
        let base = self.install_base.clone();
        let head = match &base {
            Some(b) => Head {
                seq: b.seq,
                chain: b.chain,
            },
            None => Head {
                seq: manifest.seq,
                chain: manifest.chain,
            },
        };
        let log_time = match &base {
            Some(_) => self.log_time,
            None => manifest.horizon.time_floor.saturating_add(HORIZON_MS),
        };
        // The log's semantics ratchet at the snapshot, as its builder held it. A
        // manifest that predates the field leaves this replica's own.
        let sem_ratchet = match (&base, manifest.sem_ratchet) {
            (None, Some(r)) => r,
            _ => self.sem_ratchet,
        };
        // A base: its policy effect (content seen, control chain) and its retained
        // item commit in the same transaction as the swap.
        let policy_before = self.policy.clone();
        if let Some(b) = &base {
            self.policy.note_base(b.seq, &b.chain);
            staged.meta.push(self.policy_meta());
            staged.tail_put.push(crate::store::TailRow {
                seq: b.seq,
                item: b.item.clone(),
                applied_at: self.now(),
            });
            if let Some(facts) = &b.facts {
                staged
                    .meta
                    .push((meta_keys::BASE.into(), Some(facts.encode())));
            }
        }
        if self.store.stages() {
            staged.stage = crate::store::Stage::Swap;
        } else {
            staged.clear_confirmed = true;
        }
        staged.head = Some(head);
        staged.meta.extend(source_meta);
        staged.meta.push((
            meta_keys::LOG_STATE.into(),
            log_state(log_time, sem_ratchet),
        ));
        staged
            .meta
            .push((LAST_MANIFEST.into(), manifest.to_bytes().ok()));
        if let Err(e) = self.store.commit(staged) {
            self.policy = policy_before;
            if !matches!(e, StoreError::CommitAborted(_)) {
                self.committed_read_fault();
            }
            return self.install_abort(IncidentKind::Integrity, &format!("store: {e}"));
        }
        // Swapped in: nothing after this is a reason to try another snapshot.
        self.install_offer = None;
        self.install_refused = None;
        if base.is_some() {
            self.stats.applied += 1;
            self.tail_stats_dirty = true;
        }
        self.install_base = None;
        self.install = None;
        self.install_native_auth = Default::default();
        self.install_text_sources = Default::default();
        self.install_native_roots = Default::default();
        #[cfg(test)]
        {
            self.installed_refs = self.install_refs.clone();
        }
        self.install_refs = None;
        self.head = head;
        self.store_generation += 1;
        if base.is_some() {
            self.original_history
                .carry_over_base(self.store_generation - 1, self.store_generation);
        }
        self.log_time = log_time;
        self.sem_ratchet = sem_ratchet;
        // The accumulator must be recomputed from the control items read
        // from position 1 and compared with the manifest's; that check lands with
        // policy wiring (the control-item read happens there). Until then the
        // manifest's value is adopted.
        // The policy state is the one read from the control items; control items
        // after `seq` are applied already and only advance the head on the tail read.
        self.install_points.clear();
        self.stats.snapshots_installed += 1;
        match crate::plan::load_catalog(&self.store) {
            Ok(c) => {
                self.catalog = std::sync::Arc::new(c);
                // Invalidate the cached query context after snapshot install.
                self.query_context = None;
            }
            Err(e) => return self.install_abort(IncidentKind::Integrity, &format!("store: {e}")),
        }
        // The install replaced confirmed state; the derived query index follows.
        // A failure leaves it unready (queries use the per-record path) and is
        // reported, never swallowed.
        let backfill = self.backfill_query_index();
        self.clear_incident(IncidentKind::Integrity);
        self.clear_incident(IncidentKind::WaitingForKey);
        if let Err(e) = backfill {
            self.query_context = None;
            self.incident(
                IncidentKind::Integrity,
                Some(Value::Text(format!("store: query index backfill: {e}"))),
            );
        }
        let all: std::collections::BTreeSet<String> =
            self.pending_keys.values().flatten().cloned().collect();
        let mut ids = super::live::ids_from_keys(&all);
        match self.rebuild_local_view(&all) {
            Ok(more) => ids.extend(more),
            Err(e) => return self.install_abort(IncidentKind::Integrity, &format!("store: {e}")),
        }
        // The folder is made to match the installed view from what the store knows
        // is on disk, never by assuming what was there.
        self.before.clear();
        let _ = self.reconcile_disk();
        self.status_dirty = true;
        self.notify(&ids);
        // Resubscribe at the new head and read the tail.
        self.queue_head_fetch();
        self.request_read();
    }
}
