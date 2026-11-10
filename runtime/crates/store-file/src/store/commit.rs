//! Commit entry points, the queued-commit path and observation acknowledgements.

use super::*;

impl<P: FilePlatform, M: Store, D: DiskDb> FileStore<P, M, D> {
    /// Retain one original transaction, including evidence ACK and publication.
    /// This explicit owner is not yet Replica deferred/progress integration.
    pub fn start_commit(&mut self, tx: Tx) -> crate::Committing<'_> {
        let timers = self.timers.clone();
        if let Err(e) = self
            .ensure_commit_available()
            .and_then(|()| self.ensure_queue_drained())
        {
            return crate::Committing::new(timers, None, std::future::ready(Err(e)));
        }
        let lease = self.commit_active.clone();
        lease.set(true);
        crate::Committing::new(timers, Some(lease), self.commit_task(tx))
    }

    /// Drive all ORIGINAL queued ACK/publication work in FIFO order. This owner
    /// never repeats inner commits or reallocates a pending intent. Release the
    /// completed owner before Replica::on_store_progress consumes results.
    pub fn start_progress(&mut self) -> crate::Committing<'_> {
        let timers = self.timers.clone();
        if let Err(e) = self.ensure_commit_available() {
            return crate::Committing::new(timers, None, std::future::ready(Err(e)));
        }
        let lease = self.commit_active.clone();
        lease.set(true);
        crate::Committing::new(timers, Some(lease), self.progress_task())
    }

    pub(super) fn ensure_queue_drained(&self) -> StoreResult<()> {
        if self.queued.queue.is_empty() {
            Ok(())
        } else {
            Err(StoreError::Io(
                "original queued file work pending: retain FileStore::start_progress".into(),
            ))
        }
    }

    pub(super) fn ensure_commit_available(&self) -> StoreResult<()> {
        if self.commit_active.get() || self.queued.fault {
            Err(StoreError::Io(
                "original file commit unresolved: drain original host IO and reopen".into(),
            ))
        } else {
            Ok(())
        }
    }

    fn queue_charge(&self, tx: &Tx) -> StoreResult<deferred::Charge> {
        use deferred::{MAX_BYTES, MAX_OPERATIONS, MAX_PATH_BYTES, MAX_TEXT_BYTES, bounds_error};
        let operations = (tx.publish.len() as u64)
            .checked_add(tx.ack_observations.len() as u64)
            .ok_or_else(bounds_error)?;
        if operations > MAX_OPERATIONS {
            return Err(bounds_error());
        }
        let mut bytes = operations.checked_mul(128).ok_or_else(bounds_error)?;
        for publish in &tx.publish {
            let (paths, content): (Vec<&str>, Option<&Content>) = match publish {
                Publish::Write { path, content, .. } => (vec![path], Some(content)),
                Publish::Delete { path, .. } => (vec![path], None),
                Publish::Move {
                    from, to, content, ..
                } => (vec![from, to], content.as_ref()),
            };
            for path in paths {
                if path.is_empty() || path.len() > MAX_PATH_BYTES {
                    return Err(bounds_error());
                }
                RelPath::new(path).map_err(|_| bounds_error())?;
                bytes = bytes
                    .checked_add(path.len() as u64)
                    .ok_or_else(bounds_error)?;
            }
            let payload = match content {
                Some(Content::Text(text)) => {
                    if text.len() > MAX_TEXT_BYTES {
                        return Err(bounds_error());
                    }
                    text.len() as u64
                }
                Some(Content::Blob(digest)) => {
                    self.inner.blob_size(digest)?.ok_or_else(bounds_error)?
                }
                None => 0,
            };
            bytes = bytes.checked_add(payload).ok_or_else(bounds_error)?;
            if bytes > MAX_BYTES {
                return Err(bounds_error());
            }
        }
        Ok(deferred::Charge { bytes, operations })
    }

    fn queue_blobs(&self, tx: &Tx) -> StoreResult<BTreeMap<Hash, Vec<u8>>> {
        let mut blobs = BTreeMap::new();
        for publish in &tx.publish {
            let content = match publish {
                Publish::Write { content, .. } => Some(content),
                Publish::Move { content, .. } => content.as_ref(),
                Publish::Delete { .. } => None,
            };
            if let Some(Content::Blob(digest)) = content {
                if blobs.contains_key(digest) {
                    continue;
                }
                let size = self
                    .inner
                    .blob_size(digest)?
                    .ok_or_else(deferred::bounds_error)?;
                if size > deferred::MAX_BYTES {
                    return Err(deferred::bounds_error());
                }
                let original = self.inner.blob_read(digest, 0, size)?;
                if original.len() as u64 != size || revision(&original) != *digest {
                    return Err(deferred::bounds_error());
                }
                blobs.insert(*digest, original);
            }
        }
        Ok(blobs)
    }

    pub(super) fn queue_commit(&mut self, tx: Tx) -> StoreResult<CommitReport> {
        self.ensure_commit_available()?;
        if tx.clear_confirmed && !self.queued.is_idle() {
            return Err(StoreError::CommitAborted(
                "drain ORIGINAL queued file work/results before snapshot reset".into(),
            ));
        }
        // Check before ANY inner rows, ACK state or owned queue changes.
        mdbn_replica::mirror_admission::check_tx(
            self.inner
                .meta(mdbn_replica::mirror_admission::META)?
                .as_deref(),
            &tx,
        )?;
        let required = !tx.publish.is_empty()
            || tx.ack_observations.iter().any(|id| {
                self.outstanding
                    .get(&id.0)
                    .is_some_and(|o| o.evidence.is_some())
            });
        if !required {
            // Ordinary ACKs have no host IO. Preserve their immediate native
            // bookkeeping so original disk captures do not manufacture writes.
            let (publishes, acks) = self.prepare_commit(tx)?;
            return run_ready(&self.timers.clone(), self.finish_commit(&publishes, &acks))
                .ok_or_else(suspended)?;
        }
        let charge = self.queue_charge(&tx)?;
        let batch = self.queued.reserve(charge, !tx.publish.is_empty())?;
        let blobs = match self.queue_blobs(&tx) {
            Ok(blobs) => blobs,
            Err(error) => {
                self.queued.release(batch, charge);
                return Err(error);
            }
        };
        let (publishes, acks) = match self.prepare_commit(tx) {
            Ok(work) => work,
            Err(error) => {
                self.queued.release(batch, charge);
                self.queued.fault = true;
                return Err(error);
            }
        };
        self.queued.queue.push_back(deferred::Work {
            batch,
            publishes,
            acks,
            charge,
            blobs,
        });
        Ok(CommitReport {
            drifts: Vec::new(),
            deferred: batch,
        })
    }

    async fn progress_task(&mut self) -> StoreResult<CommitReport> {
        // Later metadata-only commits may have reopened index deferral. Close
        // it before any original queued outside effect.
        if let Err(error) = mdbn_replica::mirror_admission::ensure_open(&self.inner)
            .and_then(|()| self.end_deferral())
        {
            self.queued.fault = true;
            return Err(error);
        }
        while let Some(work) = self.queued.queue.pop_front() {
            self.queued.active_blobs = work.blobs;
            let report = match self.finish_commit(&work.publishes, &work.acks).await {
                Ok(report) => report,
                Err(error) => {
                    self.queued.fault = true;
                    return Err(error);
                }
            };
            self.queued.active_blobs.clear();
            if let Some(batch) = work.batch {
                self.queued.results.push(PublishResult {
                    batch,
                    drifts: report.drifts,
                });
            } else {
                // Zero-publish evidence ACKs are real FIFO cleanup obligations,
                // not publication results or invented Replica wait ownership.
                self.queued.release(None, work.charge);
            }
        }
        Ok(CommitReport::default())
    }

    fn prepare_commit(&mut self, mut tx: Tx) -> StoreResult<(Vec<Publish>, Vec<ObservationId>)> {
        mdbn_replica::mirror_admission::check_tx(
            self.inner
                .meta(mdbn_replica::mirror_admission::META)?
                .as_deref(),
            &tx,
        )?;
        let publishes = std::mem::take(&mut tx.publish);
        let acks = tx.ack_observations.clone();
        if !publishes.is_empty()
            || acks.iter().any(|a| {
                self.outstanding
                    .get(&a.0)
                    .is_some_and(|o| o.evidence.is_some())
            })
        {
            self.end_deferral()?;
        }
        self.inner.commit(tx).map_err(inner_commit_error)?;
        Ok((publishes, acks))
    }

    async fn commit_task(&mut self, tx: Tx) -> StoreResult<CommitReport> {
        let (publishes, acks) = self.prepare_commit(tx)?;
        self.finish_commit(&publishes, &acks).await
    }

    async fn finish_commit(
        &mut self,
        publishes: &[Publish],
        acks: &[ObservationId],
    ) -> StoreResult<CommitReport> {
        let mut changes = Vec::new();
        self.ack(acks, &mut changes).await?;
        self.db.apply(changes).map_err(db_err)?;
        let mut report = CommitReport::default();
        let mut held = AlreadyHeld::default();
        let mut i = 0;
        while i < publishes.len() {
            // A run of plain creates (an install, a join) shares one journal
            // write, one barrier and one flush instead of four syncs a file.
            let (taken, run) = self.create_run(&publishes[i..], &mut held).await?;
            if taken > 0 {
                i += taken;
                self.flush_held(&mut held)?;
                if run.len() >= BATCH_MIN {
                    report.drifts.extend(self.publish_batch(run).await?);
                } else {
                    for p in run {
                        if let Some(d) = self.perform(p).await? {
                            report.drifts.push(d);
                        }
                    }
                }
                continue;
            }
            let p = &publishes[i];
            i += 1;
            if self.already_held(p, &mut held).await? {
                continue;
            }
            self.flush_held(&mut held)?;
            if let Some(d) = self.perform(p).await? {
                report.drifts.push(d);
            }
        }
        self.flush_held(&mut held)?;
        Ok(report)
    }

    async fn ack(&mut self, ids: &[ObservationId], changes: &mut Vec<Change>) -> StoreResult<()> {
        for ObservationId(id) in ids {
            let Some(o) = self.take_outstanding(*id) else {
                continue;
            };
            if let Some(ev) = &o.evidence {
                // The inner commit finished. Retain ORIGINAL cleanup IO until
                // completion; failure keeps the persisted evidence obligation.
                match self.observe_io(|| self.p.remove_file(ev)).await? {
                    Ok(()) => {}
                    Err(e) if e.is_not_found() => {}
                    Err(e) => return Err(fs_err(e)),
                }
                mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
                changes.push((Kind::Observation, counter_bytes(*id), None));
                self.evidence.remove(id);
                continue;
            }
            if let Some(from) = &o.moved_from {
                self.set_disk(changes, from, None);
            }
            self.set_disk(changes, &o.path, o.known_after.clone());
        }
        Ok(())
    }
}
