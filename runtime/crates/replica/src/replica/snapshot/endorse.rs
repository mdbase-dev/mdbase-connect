//! Checking and endorsing another device's snapshot at this replica's head.

use super::*;

/// Why a snapshot is not endorsed.
enum Stop {
    /// Nothing this replica can tell is wrong with it: the head moved, the
    /// service answered with other bytes, or checking it takes what this replica
    /// cannot do (a newer codec, a record whose text is in a blob, more record
    /// text than it may read).
    Decline,
    /// It is not this replica's state, or an install would refuse it.
    Differs(String),
    /// This replica's own state could not be read.
    Store(StoreError),
}

impl From<StoreError> for Stop {
    fn from(e: StoreError) -> Stop {
        Stop::Store(e)
    }
}

fn differs(what: &str) -> Stop {
    Stop::Differs(format!("a {what} row is not this replica's"))
}

impl<S: Store> Replica<S> {
    // ------------------------------------------------------------ endorsement

    /// Ask the service for its snapshot pointers; an unendorsed one from another
    /// device at exactly this replica's head is checked and endorsed.
    ///
    /// An endorsed snapshot is one an install accepts and that equals this
    /// replica's state (`snapshot.md` §5.2). The manifest passes the install's
    /// own check ([`Self::verify_manifest`]) against the policy at the head, and
    /// its state digest is this replica's. Every chunk it references is then
    /// fetched, one at a time, opened as an install opens it and decoded by the
    /// install's decoder ([`ChunkRows`]); each row is compared with this
    /// replica's own ([`Self::rows_are_own`]), and the decoded rows must hash to
    /// the manifest's digest. The digest alone covers neither the documents'
    /// text nor the rows' positions, capture times and receipts.
    pub fn check_snapshots(&mut self) {
        if self.apply_fault
            || self.is_apply_recovering()
            || !self.snapshot_install_available()
            || self.endorse.is_some()
        {
            return;
        }
        let id = self.queue(LogRequest::GetSnapshot {
            collection: self.cfg.collection,
        });
        self.inflight.insert(id, Inflight::Endorse);
    }

    pub(crate) fn on_endorse_pointers(&mut self, reply: crate::log::LogReply) {
        let Ok(LogResponse::GetSnapshot(ptrs)) = reply else {
            return;
        };
        for p in ptrs {
            if p.endorsed || p.author == self.cfg.device_id || p.seq != self.head.seq {
                continue;
            }
            self.endorse = Some(Endorse::Manifest(p.clone()));
            let id = self.queue(LogRequest::GetObject {
                collection: self.cfg.collection,
                address: p.manifest,
                range: None,
            });
            self.inflight.insert(id, Inflight::EndorseManifest);
            return;
        }
    }

    pub(crate) fn on_endorse_manifest(&mut self, reply: crate::log::LogReply) {
        if self.apply_fault || self.is_apply_recovering() {
            self.endorse = None;
            return;
        }
        let Some(state) = self.endorse.take() else {
            return;
        };
        let Ok(LogResponse::GetObject { bytes, .. }) = reply else {
            return;
        };
        let (seq, step) = match state {
            Endorse::Manifest(p) => (p.seq, self.endorse_manifest(p, &bytes)),
            Endorse::Chunks {
                p,
                state_digest,
                queue,
                next,
                mut rows,
                mut receipts,
            } => {
                let step = self
                    .endorse_chunk(&p, queue.get(next), &mut rows, &mut receipts, &bytes)
                    .map(|()| Endorse::Chunks {
                        p: p.clone(),
                        state_digest,
                        queue,
                        next: next + 1,
                        rows,
                        receipts,
                    });
                (p.seq, step)
            }
        };
        match step {
            Ok(next) => {
                self.endorse = Some(next);
                self.endorse_next();
            }
            Err(stop) => self.endorse_stop(seq, stop),
        }
    }

    /// No endorsement. A snapshot that differs is an incident; so is a store
    /// that cannot be read, as one.
    fn endorse_stop(&mut self, seq: u64, stop: Stop) {
        match stop {
            Stop::Decline => {}
            Stop::Differs(why) => self.incident(
                IncidentKind::VerificationMismatch,
                Some(Value::Text(format!("snapshot at {seq}: {why}"))),
            ),
            Stop::Store(e) => self.incident(
                IncidentKind::Integrity,
                Some(Value::Text(format!("snapshot check at {seq}: store: {e}"))),
            ),
        }
    }

    fn endorse_manifest(&self, p: SnapshotPointer, bytes: &[u8]) -> Result<Endorse, Stop> {
        if mdbn_wire::hash::sha256(bytes) != p.manifest || p.seq != self.head.seq {
            return Err(Stop::Decline);
        }
        let Ok(item) = Item::from_bytes(bytes) else {
            return Err(Stop::Decline);
        };
        let Some(m) = self
            .sealer
            .open(&item, bytes)
            .ok()
            .and_then(|b| mdbn_wire::ref_index::decode_manifest(&b).ok())
            .map(|(m, _)| m)
        else {
            return Err(Stop::Decline);
        };
        if item.kind != ItemKind::Manifest
            || item.collection != self.cfg.collection
            || m.seq != self.head.seq
            || m.chain != self.head.chain
        {
            return Err(Stop::Differs(
                "its manifest is not of this replica's head".into(),
            ));
        }
        // The head is the manifest's position, so this replica's policy is the
        // policy at that position.
        self.verify_manifest(bytes, &item, &m, &self.policy)
            .map_err(|why| Stop::Differs(why.into()))?;
        // An installer takes its semantics ratchet from the manifest (§8).
        if m.sem_ratchet.is_some_and(|r| r != self.sem_ratchet) {
            return Err(Stop::Differs(
                "its semantics ratchet is not this replica's".into(),
            ));
        }
        match state_digest_within(&self.store, self.snapshot_record_bytes)? {
            None => return Err(Stop::Decline),
            Some(ours) if ours != m.state_digest => {
                return Err(Stop::Differs(
                    "its state digest is not this replica's".into(),
                ));
            }
            Some(_) => {}
        }
        Ok(Endorse::Chunks {
            p,
            state_digest: m.state_digest,
            queue: chunk_queue(&m),
            next: 0,
            rows: Box::new(ChunkRows::new(self.cfg.collection, self.policy.epoch)),
            receipts: Default::default(),
        })
    }

    /// One fetched chunk: it opens as an install opens it, decodes as an install
    /// decodes it, and holds this replica's rows.
    fn endorse_chunk(
        &self,
        p: &SnapshotPointer,
        expected: Option<&(SectionKind, ChunkRef)>,
        rows: &mut ChunkRows,
        receipts: &mut std::collections::BTreeSet<mdbn_wire::common::Uuid>,
        bytes: &[u8],
    ) -> Result<(), Stop> {
        let Some((kind, cref)) = expected else {
            return Err(Stop::Decline);
        };
        // The rows are compared with the state at the snapshot's position only.
        if p.seq != self.head.seq {
            return Err(Stop::Decline);
        }
        let chunk = match self.open_chunk(bytes, *kind, cref) {
            Ok(chunk) => chunk,
            Err(ChunkError::NewerCodec) => return Err(Stop::Decline),
            Err(ChunkError::Bad(why)) => return Err(Stop::Differs(why.into())),
        };
        let decoded = rows.decode(&chunk).map_err(Stop::Differs)?;
        // The text of such a record is in a blob this replica would have to
        // fetch and authenticate, as an install does, to compare it.
        if !decoded.text_sources.is_empty() {
            return Err(Stop::Decline);
        }
        self.rows_are_own(&decoded.rows, receipts)
    }

    /// Every row an install would write from one chunk equals this replica's row,
    /// field by field.
    ///
    /// Not compared, because an install does not read them from the snapshot: a
    /// record's derived index entries (`meta`, computed from the resources, the
    /// path and the document, which are compared), where a file's bytes are on
    /// this device (`local`), and the capture time of an unindexed Markdown file,
    /// which its section does not carry. The sealed bytes, the addresses and the
    /// split into chunks are the builder's and are never compared.
    fn rows_are_own(
        &self,
        tx: &Tx,
        receipts: &mut std::collections::BTreeSet<mdbn_wire::common::Uuid>,
    ) -> Result<(), Stop> {
        for (path, doc) in &tx.resources_put {
            if self.store.resource(path)?.as_ref() != Some(doc) {
                return Err(differs("resource"));
            }
        }
        if let Some(settings) = &tx.settings {
            let own = self
                .store
                .settings()?
                .unwrap_or_else(|| crate::convert::winclusion(&Default::default()));
            if *settings != own {
                return Err(differs("settings"));
            }
        }
        for r in &tx.records_put {
            let own = self.store.record(&r.id)?.map(|own| RecordRow {
                meta: r.meta.clone(),
                ..own
            });
            if own.as_ref() != Some(r) {
                return Err(differs("record"));
            }
        }
        for f in &tx.files_put {
            let unindexed =
                f.kind == mdbn_wire::unindexed_markdown::FileKindV1::UnindexedOversizedMarkdown;
            let own = self.store.file(&f.id)?.map(|own| FileRow {
                local: f.local,
                mtime: if unindexed { f.mtime } else { own.mtime },
                ..own
            });
            if own.as_ref() != Some(f) {
                return Err(differs("file"));
            }
        }
        for t in &tx.tombstones_put {
            if self.store.tombstone(&t.id)?.as_ref() != Some(t) {
                return Err(differs("tombstone"));
            }
        }
        if !tx.aliases_put.is_empty() {
            let own = self.store.aliases()?;
            let own: BTreeMap<&str, &AliasRow> =
                own.iter().map(|a| (a.path_key.as_str(), a)).collect();
            if tx
                .aliases_put
                .iter()
                .any(|a| own.get(a.path_key.as_str()) != Some(&a))
            {
                return Err(differs("alias"));
            }
        }
        if !tx.conflicts_put.is_empty() {
            let key = |c: &ConflictRow| (c.mutation, c.conflict.id, c.conflict.kind.value());
            let own = self.store.conflicts(None)?;
            let own: BTreeMap<_, &ConflictRow> = own.iter().map(|c| (key(c), c)).collect();
            if tx
                .conflicts_put
                .iter()
                .any(|c| own.get(&key(c)) != Some(&c))
            {
                return Err(differs("conflict"));
            }
        }
        for r in &tx.receipts_put {
            if self.store.receipt(&r.mutation)?.as_ref() != Some(r) || !receipts.insert(r.mutation)
            {
                return Err(differs("receipt"));
            }
        }
        Ok(())
    }

    /// Every chunk held this replica's rows. Nothing of this replica's state is
    /// missing from them: the rows hash to the digest this replica's state has,
    /// and the receipts, which the digest leaves out, are counted.
    fn endorse_complete(
        &self,
        state_digest: Hash,
        rows: &ChunkRows,
        receipts: usize,
    ) -> Result<(), Stop> {
        if rows.index.digest() != state_digest {
            return Err(Stop::Differs(
                "its rows do not hash to its state digest".into(),
            ));
        }
        let mut own = 0usize;
        let mut after = None;
        loop {
            let page = self.store.receipts(after, 1024)?;
            let Some(last) = page.last() else {
                break;
            };
            after = Some(last.mutation);
            own += page.len();
        }
        if own != receipts {
            return Err(Stop::Differs("its receipts are not this replica's".into()));
        }
        Ok(())
    }

    fn endorse_next(&mut self) {
        let Some(Endorse::Chunks {
            p,
            state_digest,
            queue,
            next,
            rows,
            receipts,
        }) = self.endorse.take()
        else {
            return;
        };
        if let Some((_, c)) = queue.get(next) {
            let id = self.queue(LogRequest::GetObject {
                collection: self.cfg.collection,
                address: c.address,
                range: None,
            });
            self.inflight.insert(id, Inflight::EndorseManifest);
            self.endorse = Some(Endorse::Chunks {
                p,
                state_digest,
                queue,
                next,
                rows,
                receipts,
            });
            return;
        }
        if p.seq != self.head.seq {
            return;
        }
        if let Err(stop) = self.endorse_complete(state_digest, &rows, receipts.len()) {
            return self.endorse_stop(p.seq, stop);
        }
        let id = self.queue(LogRequest::EndorseSnapshot(EndorseSnapshotParams {
            collection: self.cfg.collection,
            seq: p.seq,
            manifest: p.manifest,
        }));
        self.inflight.insert(id, Inflight::Other);
    }
}
