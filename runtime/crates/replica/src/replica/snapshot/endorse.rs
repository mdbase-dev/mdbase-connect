//! Checking and endorsing another device's snapshot at this replica's head.

use super::*;

impl<S: Store> Replica<S> {
    // ------------------------------------------------------------ endorsement

    /// Ask the service for its snapshot pointers; an unendorsed one from another
    /// device at exactly this replica's head is checked and endorsed.
    ///
    /// The manifest's signature (signer's rights at the head) and every chunk it
    /// references are verified before endorsing.
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
        match state {
            Endorse::Manifest(p) => {
                if mdbn_wire::hash::sha256(&bytes) != p.manifest || p.seq != self.head.seq {
                    return;
                }
                let Ok(item) = Item::from_bytes(&bytes) else {
                    return;
                };
                let Some(m) = self
                    .sealer
                    .open(&item, &bytes)
                    .ok()
                    .and_then(|b| mdbn_wire::ref_index::decode_manifest(&b).ok())
                    .map(|(m, _)| m)
                else {
                    return;
                };
                let at = self.policy.clone();
                let ours = state_digest(&self.store).ok();
                let ok = item.kind == ItemKind::Manifest
                    && item.collection == self.cfg.collection
                    && m.seq == self.head.seq
                    && m.chain == self.head.chain
                    && ours == Some(m.state_digest)
                    && self.verify_manifest(&bytes, &item, &m, &at).is_ok();
                if !ok {
                    self.incident(
                        IncidentKind::VerificationMismatch,
                        Some(Value::Text(format!(
                            "snapshot at {} differs from this replica",
                            p.seq
                        ))),
                    );
                    return;
                }
                let queue: Vec<ChunkRef> = m
                    .sections
                    .iter()
                    .flat_map(|s| s.chunks.iter().cloned())
                    .filter(|c| !self.verified_chunks.contains(&c.address))
                    .collect();
                self.endorse = Some(Endorse::Chunks { p, queue, next: 0 });
                self.endorse_next();
            }
            Endorse::Chunks { p, queue, next } => {
                let Some(c) = queue.get(next) else {
                    return;
                };
                let good = mdbn_wire::hash::sha256(&bytes) == c.address
                    && Item::from_bytes(&bytes)
                        .ok()
                        .and_then(|i| self.sealer.open(&i, &bytes).ok())
                        .is_some_and(|plain| mdbn_wire::hash::sha256(&plain) == c.plain_hash);
                if !good {
                    self.incident(
                        IncidentKind::VerificationMismatch,
                        Some(Value::Text(format!(
                            "snapshot at {}: a chunk does not verify",
                            p.seq
                        ))),
                    );
                    return;
                }
                self.verified_chunks.insert(c.address);
                self.endorse = Some(Endorse::Chunks {
                    p,
                    queue,
                    next: next + 1,
                });
                self.endorse_next();
            }
        }
    }

    fn endorse_next(&mut self) {
        let Some(Endorse::Chunks { p, queue, next }) = self.endorse.take() else {
            return;
        };
        if let Some(c) = queue.get(next) {
            let id = self.queue(LogRequest::GetObject {
                collection: self.cfg.collection,
                address: c.address,
                range: None,
            });
            self.inflight.insert(id, Inflight::EndorseManifest);
            self.endorse = Some(Endorse::Chunks { p, queue, next });
            return;
        }
        if p.seq != self.head.seq {
            return;
        }
        let id = self.queue(LogRequest::EndorseSnapshot(EndorseSnapshotParams {
            collection: self.cfg.collection,
            seq: p.seq,
            manifest: p.manifest,
        }));
        self.inflight.insert(id, Inflight::Other);
    }
}
