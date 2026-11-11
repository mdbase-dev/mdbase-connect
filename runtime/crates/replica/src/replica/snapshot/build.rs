//! Building, uploading and registering a snapshot, and when to build one.

use super::*;

/// Chunk rows per bucket or ordinal.
type Chunks = Vec<(u64, Vec<Cbor>)>;

/// Snapshot object uploads in flight at once. A large state has hundreds of
/// chunks; a native app host takes at most 64 log calls in one turn.
const PUTS_IN_FLIGHT: usize = 8;

/// The longest wait between periodic builds whose uploads go unanswered, ms.
const BUILD_RETRY_MAX_MS: u64 = 60 * 60 * 1000;

/// The head a build was last declined at, so a new wake waits for the next period.
const DECLINED_AT: &str = "replica.snapshot.declined";

impl<S: Store> Replica<S> {
    /// Build and upload a snapshot of the confirmed state at the head now.
    pub fn build_snapshot_now(&mut self) -> Result<(), StoreError> {
        self.build_snapshot_body(true)
    }
    #[cfg(test)]
    pub(crate) fn test_build_native_snapshot(&mut self) -> Result<(), StoreError> {
        self.build_snapshot_body(true)
    }
    fn build_snapshot_body(&mut self, native: bool) -> Result<(), StoreError> {
        crate::mirror_admission::ensure_open(&self.store)?;
        if self.apply_fault || self.is_apply_recovering() {
            return Err(StoreError::Io("apply state is unavailable".into()));
        }
        if self.store.durability_deferred() {
            return Err(StoreError::Io(
                "deferred-durability window open: no snapshot before its barrier".into(),
            ));
        }
        if self.build.is_some() || self.install.is_some() || self.head.seq == 0 {
            return Ok(());
        }
        // Only a device with write authority authors a snapshot: no replica
        // installs or endorses another's ([`Self::verify_manifest`]).
        if !self.policy.device_can_write(&self.cfg.device_id) {
            return Ok(());
        }
        let Some(epoch) = self.sealer.current_epoch() else {
            return Ok(());
        };
        let previous: Option<ManifestPayload> = self
            .store
            .meta(LAST_MANIFEST)?
            .and_then(|b| ManifestPayload::from_bytes(&b).ok());
        let prev_refs: BTreeMap<(u64, u64, Hash), B32> = previous
            .iter()
            .flat_map(|m| m.sections.iter())
            .flat_map(|s| {
                s.chunks
                    .iter()
                    .map(move |c| ((s.kind.value(), c.bucket, c.plain_hash), c.address))
            })
            .collect();
        let native_roots = super::unindexed_inventory::Roots::collect(&self.store)?;
        let mut native_refs = Vec::new();
        if native_roots.descriptors().next().is_some() {
            match self.native_snapshot_inventory(&native_roots)? {
                super::unindexed_inventory::Inventory::Complete(refs) => native_refs = refs,
                super::unindexed_inventory::Inventory::Pending(missing) => {
                    self.resolve_inventories(missing);
                    if native {
                        return Ok(());
                    }
                }
            }
            if !native {
                return Err(StoreError::Io("unindexed_snapshot_not_yet".into()));
            }
        }
        let Some(records) = records_within(&self.store, self.snapshot_record_bytes)? else {
            return self.decline_snapshot();
        };
        let files = all_files(&self.store)?;
        let total: u64 = records.iter().map(|r| r.doc.len() as u64).sum();
        let bits = ceil_log2(total.div_ceil(TARGET_CHUNK).max(1)).min(16);
        let buckets = 1u64 << bits;
        let shift = 16 - bits;
        let in_bucket = |b16: u16, b: u64| (u64::from(b16) >> shift) == b;

        let mut sections: Vec<(SectionKind, Chunks)> = Vec::new();
        // Resources.
        let mut res = self.store.resources()?;
        res.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        let rows: Vec<Cbor> = res
            .into_iter()
            .map(|(path, doc)| {
                ResourceRow {
                    path,
                    doc: TextOrBlob::Text(doc),
                }
                .to_cbor()
            })
            .collect();
        sections.push((SectionKind::Legacy(L::Resources), split(rows)));
        // Index, records, files: one chunk per bucket. Attachment file rows go to
        // the critical AttachmentFiles section (10), bucketed by file ID exactly as
        // the legacy Files section; it is present only when such rows exist, so a
        // collection without attachments keeps producing legacy manifests.
        let mut index = Vec::new();
        let mut recs = Vec::new();
        let mut fls = Vec::new();
        let mut afls = Vec::new();
        let mut nfls = Vec::new();
        let mut blob_refs: Vec<mdbn_wire::intent::BlobRef> = Vec::new();
        let mut held = Held::default();
        for b in 0..buckets {
            let mut irows: Vec<(mdbn_wire::common::Uuid, Cbor)> = Vec::new();
            let mut rrows = Vec::new();
            for r in records.iter().filter(|r| in_bucket(r.bucket, b)) {
                irows.push((
                    r.id,
                    IndexRow {
                        id: r.id,
                        kind: EntityKind::Record,
                        path: r.path.clone(),
                        revision: r.revision,
                        size: r.doc.len() as u64,
                        modified_seq: r.modified_seq,
                        mtime: r.mtime,
                    }
                    .to_cbor(),
                ));
                rrows.push(
                    WRecordRow {
                        id: r.id,
                        path: r.path.clone(),
                        doc: TextOrBlob::Text(r.doc.clone()),
                    }
                    .to_cbor(),
                );
            }
            let mut frows = Vec::new();
            let mut arows = Vec::new();
            let mut nrows = Vec::new();
            for f in files.iter().filter(|f| in_bucket(f.bucket, b)) {
                irows.push((
                    f.id,
                    IndexRow {
                        id: f.id,
                        kind: EntityKind::File,
                        path: f.path.clone(),
                        revision: f.content.plain_hash(),
                        size: f.content.size(),
                        modified_seq: f.modified_seq,
                        mtime: None,
                    }
                    .to_cbor(),
                ));
                if f.kind == mdbn_wire::unindexed_markdown::FileKindV1::UnindexedOversizedMarkdown {
                    nrows.push(
                        mdbn_wire::unindexed_markdown::UnindexedMarkdownFileRowV1 {
                            id: f.id,
                            path: f.path.clone(),
                            payload: mdbn_wire::unindexed_markdown::UnindexedMarkdownPayloadV1 {
                                content: f.content.clone(),
                            },
                            media: f.media,
                        }
                        .to_cbor(),
                    );
                    continue;
                }
                match row_content(&f.content)? {
                    RowContent::Blob(blob) => {
                        blob_refs.push(blob.clone());
                        frows.push(
                            WFileRow {
                                id: f.id,
                                path: f.path.clone(),
                                blob: blob.clone(),
                                media: f.media,
                            }
                            .to_cbor(),
                        );
                    }
                    RowContent::Attachment(a) => {
                        held.add(a);
                        arows.push(
                            AttachmentFileRowV1 {
                                id: f.id,
                                path: f.path.clone(),
                                content: a.clone(),
                                media: f.media,
                                mtime: f.mtime,
                            }
                            .to_cbor(),
                        );
                    }
                }
            }
            irows.sort_by(|a, b| a.0.cmp(&b.0));
            index.push((b, irows.into_iter().map(|(_, c)| c).collect()));
            recs.push((b, rrows));
            fls.push((b, frows));
            afls.push((b, arows));
            nfls.push((b, nrows));
        }
        sections.push((SectionKind::Legacy(L::Index), index));
        sections.push((SectionKind::Legacy(L::Records), recs));
        sections.push((SectionKind::Legacy(L::Files), fls));
        let mut attachment_sections: Vec<(SectionKind, Chunks)> = Vec::new();
        if afls.iter().any(|(_, rows)| !rows.is_empty()) {
            attachment_sections.push((SectionKind::AttachmentFiles, afls));
        }
        if nfls.iter().any(|(_, rows)| !rows.is_empty()) {
            attachment_sections.push((SectionKind::UnindexedMarkdownFiles, nfls));
        }
        // Unbucketed side tables. Retained attachment tombstones go to the
        // critical AttachmentTombstones section (11), never a fabricated blob.
        let tombs = all_tombstones(&self.store)?;
        let mut trows: Vec<Cbor> = Vec::new();
        let mut atrows: Vec<Cbor> = Vec::new();
        let mut ntrows: Vec<Cbor> = Vec::new();
        for t in &tombs {
            let last = match &t.last {
                TombstoneLast::UnindexedMarkdown(p) => {
                    if t.kind != EntityKind::File {
                        return Err(StoreError::Corrupt("native tombstone is not a file".into()));
                    }
                    ntrows.push(
                        mdbn_wire::unindexed_markdown::UnindexedMarkdownTombstoneRowV1 {
                            id: t.id,
                            path: t.path.clone(),
                            payload: p.clone(),
                            seq: t.seq,
                            time: t.time,
                        }
                        .to_cbor(),
                    );
                    continue;
                }
                TombstoneLast::Doc(d) => TextOrBlob::Text(d.clone()),
                TombstoneLast::Blob(b) => {
                    blob_refs.push(b.clone());
                    TextOrBlob::Blob(b.clone())
                }
                TombstoneLast::Attachment(a) => {
                    if t.kind != EntityKind::File {
                        return Err(StoreError::Corrupt(
                            "an attachment tombstone that is not a file".into(),
                        ));
                    }
                    held.add(a);
                    atrows.push(
                        AttachmentTombstoneRowV1 {
                            id: t.id,
                            path: t.path.clone(),
                            content: a.clone(),
                            seq: t.seq,
                            time: t.time,
                        }
                        .to_cbor(),
                    );
                    continue;
                }
            };
            trows.push(
                WTombstoneRow {
                    id: t.id,
                    kind: t.kind,
                    path: t.path.clone(),
                    last,
                    seq: t.seq,
                    time: t.time,
                }
                .to_cbor(),
            );
        }
        sections.push((SectionKind::Legacy(L::Tombstones), split(trows)));
        if !atrows.is_empty() {
            attachment_sections.push((SectionKind::AttachmentTombstones, split(atrows)));
        }
        if !ntrows.is_empty() {
            attachment_sections.push((SectionKind::UnindexedMarkdownTombstones, split(ntrows)));
        }
        let mut aliases = self.store.aliases()?;
        aliases.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
        let arows: Vec<Cbor> = aliases
            .iter()
            .map(|a| {
                Alias {
                    path: a.path.clone(),
                    record: a.record,
                }
                .to_cbor()
            })
            .collect();
        sections.push((SectionKind::Legacy(L::Aliases), split(arows)));
        // Conflict rows in the runtime family: a legacy conflict encodes exactly
        // as before, and an attachment side keeps its whole descriptor (and roots).
        let conflicts = self.store.conflicts(None)?;
        for c in &conflicts {
            let sides = [
                Some(&c.conflict.kept),
                Some(&c.conflict.lost),
                c.conflict.base.as_ref(),
            ];
            for v in sides.into_iter().flatten() {
                match v {
                    rt::ConflictValue::Legacy(mdbn_wire::entry::ConflictValue::Blob(b)) => {
                        blob_refs.push(b.clone());
                    }
                    rt::ConflictValue::Attachment(a) => held.add(a),
                    rt::ConflictValue::UnindexedMarkdown(_) => {}
                    rt::ConflictValue::Legacy(_) => {}
                }
            }
        }
        let crows: Vec<Cbor> = conflicts
            .into_iter()
            .map(|c| {
                WConflictRow {
                    mutation: c.mutation,
                    seq: c.seq,
                    conflict: c.conflict,
                }
                .to_cbor()
            })
            .collect();
        sections.push((SectionKind::Legacy(L::Conflicts), split(crows)));
        let rrows: Vec<Cbor> = all_receipts(&self.store)?
            .iter()
            .map(|r| {
                WReceiptRow {
                    mutation: r.mutation,
                    seq: r.seq,
                    time: r.time,
                }
                .to_cbor()
            })
            .collect();
        sections.push((SectionKind::Legacy(L::Receipts), split(rrows)));
        let settings = self
            .store
            .settings()?
            .unwrap_or_else(|| crate::convert::winclusion(&Default::default()));
        sections.push((
            SectionKind::Legacy(L::Settings),
            vec![(0, vec![settings.to_cbor()])],
        ));
        sections.extend(attachment_sections);

        // Every attachment the state holds contributes its complete, authenticated
        // object inventory (manifest and every chunk) to the refs. A missing
        // inventory blocks the build: the previous snapshot and its roots stay.
        let mut attachment_refs: Vec<B32> = Vec::new();
        let mut missing: Vec<AttachmentContentV1> = Vec::new();
        for a in held.0.values() {
            match self.attachment_inventory(&a.reference.manifest_cipher_hash)? {
                Some(objects) => attachment_refs.extend(objects),
                None => missing.push(a.clone()),
            }
        }
        if !missing.is_empty() {
            let unavailable = missing
                .iter()
                .filter(|a| self.inventory_unavailable(&a.reference.manifest_cipher_hash))
                .count() as u64;
            self.snapshot_blocked = Some(if unavailable > 0 {
                SnapshotBlocked::InventoryUnavailable {
                    attachments: unavailable,
                }
            } else {
                SnapshotBlocked::InventoryPending {
                    attachments: missing.len() as u64,
                }
            });
            self.resolve_inventories(missing);
            return Ok(());
        }

        // Seal chunks.
        let mut uploads = Vec::new();
        let mut out_sections = Vec::new();
        let mut refs = attachment_refs;
        refs.extend(native_refs);
        for (kind, chunks) in sections {
            let mut crefs = Vec::new();
            for (bucket, rows) in chunks {
                let n = rows.len() as u64;
                let payload = ChunkPayload {
                    section: kind,
                    bucket,
                    rows,
                };
                let plain = enc(&payload.to_cbor());
                let plain_hash = mdbn_wire::hash::sha256(&plain);
                let address = match prev_refs.get(&(kind.value(), bucket, plain_hash)) {
                    Some(a) => *a,
                    None => {
                        let mut item = object_item(ItemKind::Chunk, self.cfg.collection, epoch);
                        if self
                            .sealer
                            .seal_object(&mut item, &plain, true, false, self.host.entropy.as_mut())
                            .is_err()
                        {
                            return Ok(());
                        }
                        let bytes = item.to_bytes().unwrap_or_default();
                        let address = mdbn_wire::hash::sha256(&bytes);
                        uploads.push(Upload {
                            address,
                            kind: ItemKind::Chunk,
                            bytes,
                        });
                        address
                    }
                };
                refs.push(address);
                crefs.push(ChunkRef {
                    address,
                    plain_hash,
                    rows: n,
                    bucket,
                    plain_size: plain.len() as u64,
                });
            }
            out_sections.push(Section {
                kind,
                chunks: crefs,
            });
        }
        for b in &blob_refs {
            if let Some(a) = self.sealer.blob_part_addresses(b) {
                refs.extend(a);
            }
        }
        refs.sort();
        refs.dedup();
        // Past the direct threshold the refs travel in ref-index objects.
        let indexed = match super::ref_index::index_refs(self.cfg.collection, refs) {
            Ok(x) => x,
            Err(blocked) => {
                self.snapshot_blocked = Some(blocked);
                self.stats.snapshot_builds_refused += 1;
                return Ok(());
            }
        };
        let refs = indexed.refs;
        uploads.extend(indexed.uploads);
        let sem = mdbn_core::semantics::SEM;
        let payload = ManifestPayload {
            seq: self.head.seq,
            chain: self.head.chain,
            state_digest: state_digest(&self.store)?,
            bucket_bits: bits,
            sections: out_sections,
            horizon: Horizon {
                seq_floor: self.head.seq.saturating_sub(HORIZON_ENTRIES),
                time_floor: self.log_time.saturating_sub(HORIZON_MS),
            },
            sem: Version {
                major: sem.major,
                minor: sem.minor,
            },
            record_count: records.len() as u64,
            file_count: files.len() as u64,
            control_chain: self.policy.ctl_chain,
            sem_ratchet: Some(self.sem_ratchet),
            previous: self
                .store
                .meta(&format!("{LAST_MANIFEST}.address"))?
                .and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok())
                .map(B32),
        };
        let mut item = object_item(ItemKind::Manifest, self.cfg.collection, epoch);
        item.signer = Some(self.cfg.device_id);
        item.refs = (!refs.is_empty()).then(|| refs.clone());
        let Ok(plain) = mdbn_wire::ref_index::encode_manifest(&payload, &indexed.ref_indices)
        else {
            return Ok(());
        };
        if self
            .sealer
            .seal_object(&mut item, &plain, true, true, self.host.entropy.as_mut())
            .is_err()
        {
            return Ok(());
        }
        // The log service decodes `put_snapshot` and the manifest object within one
        // whole-request CBOR budget. A refs inventory that cannot fit is refused,
        // typed: never truncated, never registered without some of its roots.
        if let Err(blocked) = snapshot_refs_fit(self.cfg.collection, self.head.seq, &item) {
            self.snapshot_blocked = Some(blocked);
            self.stats.snapshot_builds_refused += 1;
            return Ok(());
        }
        self.snapshot_blocked = None;
        let bytes = item.to_bytes().unwrap_or_default();
        let manifest = mdbn_wire::hash::sha256(&bytes);
        uploads.push(Upload {
            address: manifest,
            kind: ItemKind::Manifest,
            bytes,
        });
        self.build = Some(Build {
            seq: self.head.seq,
            manifest,
            refs,
            uploads: uploads.into(),
            outstanding: 0,
            failed: None,
            payload,
        });
        self.snap_put_next();
        Ok(())
    }

    /// Send the build's next uploads, up to [`PUTS_IN_FLIGHT`].
    fn snap_put_next(&mut self) {
        while let Some(b) = self.build.as_mut() {
            if b.failed.is_some() || b.outstanding >= PUTS_IN_FLIGHT {
                return;
            }
            let Some(u) = b.uploads.pop_front() else {
                return;
            };
            b.outstanding += 1;
            let id = self.queue(LogRequest::PutObject {
                collection: self.cfg.collection,
                address: u.address,
                kind: u.kind,
                bytes: u.bytes,
            });
            self.inflight.insert(id, Inflight::SnapPut);
        }
    }

    pub(crate) fn on_snap_put(&mut self, reply: &crate::log::LogReply) {
        let Some(b) = self.build.as_mut() else {
            return;
        };
        b.outstanding = b.outstanding.saturating_sub(1);
        if !matches!(reply, Ok(LogResponse::PutObject { .. })) {
            // A refusal outranks an unanswered upload of the same build.
            b.failed = b.failed.max(Some(BuildFailure::of(reply)));
        }
        self.snap_put_next();
        let Some(b) = self.build.as_mut() else {
            return;
        };
        if b.outstanding > 0 {
            return;
        }
        if let Some(why) = b.failed {
            let seq = b.seq;
            self.build = None;
            return self.build_failed(seq, why);
        }
        let params = PutSnapshotParams {
            collection: self.cfg.collection,
            seq: b.seq,
            manifest: b.manifest,
            refs: if b.refs.is_empty() {
                vec![b.manifest]
            } else {
                b.refs.clone()
            },
        };
        let id = self.queue(LogRequest::PutSnapshot(params));
        self.inflight.insert(id, Inflight::SnapRegister);
    }

    pub(crate) fn on_snap_registered(&mut self, reply: &crate::log::LogReply) {
        let Some(b) = self.build.take() else {
            return;
        };
        match reply {
            Ok(LogResponse::PutSnapshot(true)) => self.build_retry = None,
            // The log already holds a snapshot at or past this one (another
            // replica registered it first): do not rebuild until the next period.
            Ok(LogResponse::PutSnapshot(false)) => {
                self.build_retry = None;
                self.snapshot_declined = self.snapshot_declined.max(b.seq);
                return;
            }
            _ => return self.build_failed(b.seq, BuildFailure::of(reply)),
        }
        let _ = self.store.commit(Tx {
            meta: vec![
                (LAST_MANIFEST.into(), b.payload.to_bytes().ok()),
                (
                    format!("{LAST_MANIFEST}.address"),
                    Some(b.manifest.0.to_vec()),
                ),
            ],
            ..Tx::default()
        });
        self.stats.snapshots_built += 1;
    }

    /// The build at `seq` ended without a snapshot (`snapshot.md` §5.3). A
    /// rebuild seals and uploads every chunk again, so neither outcome may
    /// repeat on every tick.
    fn build_failed(&mut self, seq: u64, why: BuildFailure) {
        match why {
            // The answer will not change at this head: the periodic build
            // counts from here, as when the log already held a snapshot.
            BuildFailure::Refused => {
                self.build_retry = None;
                self.snapshot_declined = self.snapshot_declined.max(seq);
            }
            BuildFailure::Unanswered { retry_after_ms } => {
                let ms = self
                    .build_retry
                    .map_or(self.tuning.retry_ms, |r| r.wait_ms.saturating_mul(2))
                    .max(retry_after_ms)
                    .min(BUILD_RETRY_MAX_MS);
                self.build_retry = Some(BuildRetry {
                    at: self
                        .now()
                        .saturating_add(i64::try_from(ms).unwrap_or(i64::MAX)),
                    wait_ms: ms,
                });
            }
        }
    }

    /// Build a snapshot when enough has been appended since the last one.
    /// Too much record text to build in memory. Nothing is lost: the previous
    /// snapshot and its compaction floor stay, and this head is not tried again.
    fn decline_snapshot(&mut self) -> Result<(), StoreError> {
        let seq = self.head.seq;
        self.snapshot_blocked = Some(SnapshotBlocked::RecordBytes {
            limit: self.snapshot_record_bytes,
        });
        self.stats.snapshot_builds_refused += 1;
        self.snapshot_declined = self.snapshot_declined.max(seq);
        self.snapshot_decline_seen = true;
        self.store.commit(Tx {
            meta: vec![(DECLINED_AT.into(), Some(seq.to_be_bytes().to_vec()))],
            ..Tx::default()
        })?;
        Ok(())
    }

    /// One report per decline or wake that finds one in force: true at most once.
    pub fn take_snapshot_declined(&mut self) -> bool {
        std::mem::take(&mut self.snapshot_decline_seen)
    }

    pub(crate) fn maybe_build(&mut self) {
        if self.build.is_some() || self.install.is_some() || !self.caught_up {
            return;
        }
        if self.build_retry.is_some_and(|r| self.now() < r.at) {
            return;
        }
        let manifest = self
            .store
            .meta(LAST_MANIFEST)
            .ok()
            .flatten()
            .and_then(|b| ManifestPayload::from_bytes(&b).ok())
            .map(|m| m.seq)
            .unwrap_or(0);
        if !std::mem::replace(&mut self.snapshot_decline_read, true) {
            let at = self
                .store
                .meta(DECLINED_AT)
                .ok()
                .flatten()
                .and_then(|b| <[u8; 8]>::try_from(b.as_slice()).ok())
                .map_or(0, u64::from_be_bytes);
            self.snapshot_declined = self.snapshot_declined.max(at);
            self.snapshot_decline_seen |= at > manifest;
        }
        let last = manifest.max(self.snapshot_declined);
        if self.head.seq >= last + self.snapshot_every {
            let _ = self.build_snapshot_now();
        }
    }
}
