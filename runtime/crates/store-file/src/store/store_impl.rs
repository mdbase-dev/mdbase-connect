//! The replica `Store` trait implementation, mostly delegating to the inner store.

use super::*;

impl<P: FilePlatform + 'static, M: Store, D: DiskDb> Store for FileStore<P, M, D> {
    fn head(&self) -> StoreResult<Head> {
        self.ensure_commit_available()?;
        self.inner.head()
    }
    fn record(&self, id: &Uuid) -> StoreResult<Option<RecordRow>> {
        self.inner.record(id)
    }
    fn record_at(&self, path_key: &str) -> StoreResult<Option<Uuid>> {
        self.inner.record_at(path_key)
    }
    fn records(&self, page: Page) -> StoreResult<Vec<RecordRow>> {
        self.inner.records(page)
    }
    fn records_visit<B>(
        &self,
        page: Page,
        visitor: &mut dyn FnMut(RecordRow) -> std::ops::ControlFlow<B>,
    ) -> StoreResult<std::ops::ControlFlow<B>> {
        self.inner.records_visit(page, visitor)
    }
    fn records_in_buckets(
        &self,
        range: std::ops::Range<u32>,
        page: Page,
    ) -> StoreResult<Vec<RecordRow>> {
        self.inner.records_in_buckets(range, page)
    }
    fn record_count(&self) -> StoreResult<u64> {
        self.inner.record_count()
    }
    fn file(&self, id: &Uuid) -> StoreResult<Option<FileRow>> {
        self.inner.file(id)
    }
    fn file_at(&self, path_key: &str) -> StoreResult<Option<Uuid>> {
        self.inner.file_at(path_key)
    }
    fn files(&self, page: Page) -> StoreResult<Vec<FileRow>> {
        self.inner.files(page)
    }
    fn files_in_buckets(
        &self,
        range: std::ops::Range<u32>,
        page: Page,
    ) -> StoreResult<Vec<FileRow>> {
        self.inner.files_in_buckets(range, page)
    }
    fn resource(&self, path: &str) -> StoreResult<Option<String>> {
        self.inner.resource(path)
    }
    fn resources(&self) -> StoreResult<Vec<(String, String)>> {
        self.inner.resources()
    }
    fn resource_observation_batch_complete(
        &self,
        observations: &[Observation],
    ) -> StoreResult<bool> {
        let timers = self.timers.clone();
        run_ready(&timers, self.resource_batch_complete_task(observations)).ok_or_else(suspended)?
    }
    fn resource_observation_batch_complete_async<'a>(
        &'a self,
        observations: &'a [Observation],
    ) -> mdbn_replica::store::StoreFuture<'a, bool> {
        Box::pin(self.resource_batch_complete_task(observations))
    }
    fn resource_observation_refused(
        &mut self,
        tokens: &[ObservationId],
        mutation: Uuid,
    ) -> StoreResult<()> {
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        if tokens.len() > 64 || self.refused_resource_sets.len() >= 64 {
            return Err(StoreError::Full);
        }
        for token in tokens {
            if let Some(original) = self.outstanding.get_mut(&token.0) {
                original.deferred = true;
            }
        }
        let mut set = tokens.iter().map(|o| o.0).collect::<Vec<_>>();
        set.sort_unstable();
        if !self
            .refused_resource_sets
            .iter()
            .any(|(old, _)| old == &set)
        {
            self.refused_resource_sets.push((set, mutation));
        }
        Ok(())
    }
    fn release_disk_observation(&mut self, token: ObservationId) -> StoreResult<()> {
        self.ensure_commit_available()?;
        if self
            .outstanding
            .get(&token.0)
            .is_some_and(|o| o.evidence.is_some())
        {
            return Err(StoreError::Io(
                "cannot release retained observation evidence".into(),
            ));
        }
        self.take_outstanding(token.0);
        Ok(())
    }

    fn defer_disk_observations(&mut self, tokens: &[ObservationId]) -> StoreResult<()> {
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        if tokens.len() > 65536 {
            return Err(StoreError::Full);
        }
        for token in tokens {
            if let Some(original) = self.outstanding.get_mut(&token.0) {
                original.deferred = true;
            }
        }
        Ok(())
    }
    fn resource_observation_current(&mut self, o: &Observation) -> StoreResult<bool> {
        let timers = self.timers.clone();
        run_ready(&timers, self.resource_current_task(o)).ok_or_else(suspended)?
    }
    fn resource_observation_current_async<'a>(
        &'a mut self,
        o: &'a Observation,
    ) -> mdbn_replica::store::StoreFuture<'a, bool> {
        Box::pin(self.resource_current_task(o))
    }
    fn resource_observation_text(
        &mut self,
        observation: &Observation,
        limit: usize,
    ) -> StoreResult<Option<String>> {
        let timers = self.timers.clone();
        run_ready(&timers, self.resource_text_task(observation, limit)).ok_or_else(suspended)?
    }
    fn resource_observation_text_async<'a>(
        &'a mut self,
        observation: &'a Observation,
        limit: usize,
    ) -> mdbn_replica::store::StoreFuture<'a, Option<String>> {
        Box::pin(self.resource_text_task(observation, limit))
    }
    fn resource_paths_page(
        &self,
        page: mdbn_replica::store::ResourcePathPage<'_>,
    ) -> StoreResult<Vec<String>> {
        self.inner.resource_paths_page(page)
    }
    fn resource_bounded(
        &self,
        path: &str,
        copy_limit: usize,
    ) -> StoreResult<Option<mdbn_replica::store::BoundedResource>> {
        self.inner.resource_bounded(path, copy_limit)
    }
    fn settings(&self) -> StoreResult<Option<FileInclusion>> {
        self.inner.settings()
    }
    fn tombstone(&self, id: &Uuid) -> StoreResult<Option<TombstoneRow>> {
        self.inner.tombstone(id)
    }
    fn tombstones_at(&self, path_key: &str) -> StoreResult<Vec<TombstoneRow>> {
        self.inner.tombstones_at(path_key)
    }
    fn tombstones(&self, page: Page) -> StoreResult<Vec<TombstoneRow>> {
        self.inner.tombstones(page)
    }
    fn alias(&self, path_key: &str) -> StoreResult<Option<Uuid>> {
        self.inner.alias(path_key)
    }
    fn aliases(&self) -> StoreResult<Vec<AliasRow>> {
        self.inner.aliases()
    }
    fn conflicts(&self, of: Option<&Uuid>) -> StoreResult<Vec<ConflictRow>> {
        self.inner.conflicts(of)
    }
    fn conflict_count(&self) -> StoreResult<u64> {
        self.inner.conflict_count()
    }
    fn receipt(&self, mutation: &Uuid) -> StoreResult<Option<ReceiptRow>> {
        self.inner.receipt(mutation)
    }
    fn receipts(&self, after: Option<Uuid>, limit: u32) -> StoreResult<Vec<ReceiptRow>> {
        self.inner.receipts(after, limit)
    }
    fn referrers(&self, target_keys: &[String]) -> StoreResult<Vec<Uuid>> {
        self.inner.referrers(target_keys)
    }
    fn unique_holders(&self, field: &str, value_key: &str) -> StoreResult<Vec<Uuid>> {
        self.inner.unique_holders(field, value_key)
    }
    fn candidates(&self, q: &Candidate, page: Page) -> StoreResult<Vec<RecordRow>> {
        self.inner.candidates(q, page)
    }
    fn query_projection_state(
        &self,
    ) -> StoreResult<Option<mdbn_replica::store_query::QueryProjectionState>> {
        self.inner.query_projection_state()
    }
    fn query_projection_page(
        &self,
        request: &mdbn_replica::store_query::QueryProjectionRequest,
    ) -> StoreResult<mdbn_replica::store_query::QueryProjectionPage> {
        self.inner.query_projection_page(request)
    }
    fn query_index_supported(&self) -> bool {
        self.inner.query_index_supported()
    }
    fn query_index_state(&self) -> StoreResult<Option<mdbn_replica::store_query::QueryIndexState>> {
        self.inner.query_index_state()
    }
    fn query_index_page(
        &self,
        request: &mdbn_replica::store_query::QueryIndexRequest,
    ) -> StoreResult<Option<mdbn_replica::store_query::QueryIndexPage>> {
        self.inner.query_index_page(request)
    }
    fn hydrate_query_at(
        &self,
        ids: &[Uuid],
        head: Head,
        budget: &mut mdbn_replica::store_query::QueryBudget,
    ) -> StoreResult<Vec<RecordRow>> {
        self.inner.hydrate_query_at(ids, head, budget)
    }
    fn query_record_sizes_at(
        &self,
        page: Page,
        head: Head,
    ) -> StoreResult<Vec<mdbn_replica::store_query::QueryRecordSize>> {
        self.inner.query_record_sizes_at(page, head)
    }
    fn tail(&self, after: u64, limit: u32) -> StoreResult<Vec<mdbn_replica::store::TailRow>> {
        self.inner.tail(after, limit)
    }
    fn tail_stats(&self) -> StoreResult<mdbn_replica::store::TailStats> {
        self.inner.tail_stats()
    }
    fn own_retained_stats(&self) -> StoreResult<mdbn_replica::store::TailStats> {
        self.inner.own_retained_stats()
    }
    fn own_retained(&self, after: u64, limit: u32) -> StoreResult<Vec<(u64, PendingRow)>> {
        self.inner.own_retained(after, limit)
    }
    fn pending(&self, after_order: Option<u64>, limit: u32) -> StoreResult<Vec<PendingRow>> {
        self.inner.pending(after_order, limit)
    }
    fn pending_get(&self, mutation: &Uuid) -> StoreResult<Option<PendingRow>> {
        self.inner.pending_get(mutation)
    }
    fn pending_count(&self) -> StoreResult<u64> {
        self.inner.pending_count()
    }
    fn local_receipt(&self, mutation: &Uuid) -> StoreResult<Option<LocalReceipt>> {
        self.inner.local_receipt(mutation)
    }
    fn holds(&self) -> StoreResult<Vec<Hold>> {
        self.inner.holds()
    }
    fn hold(&self, id: &Uuid) -> StoreResult<Option<Hold>> {
        self.inner.hold(id)
    }
    fn meta(&self, key: &str) -> StoreResult<Option<Vec<u8>>> {
        self.ensure_commit_available()?;
        self.inner.meta(key)
    }
    fn transfer(&self, id: &Uuid) -> StoreResult<Option<TransferRow>> {
        self.inner.transfer(id)
    }
    fn transfer_chunk(&self, id: &Uuid, index: u64) -> StoreResult<Option<Vec<u8>>> {
        self.inner.transfer_chunk(id, index)
    }
    fn blob_size(&self, digest: &Hash) -> StoreResult<Option<u64>> {
        self.inner.blob_size(digest)
    }
    fn blob_read(&self, digest: &Hash, offset: u64, len: u64) -> StoreResult<Vec<u8>> {
        self.inner.blob_read(digest, offset, len)
    }

    fn durability_deferred(&self) -> bool {
        self.deferred
    }

    fn defer_durability(&mut self, on: bool) -> StoreResult<()> {
        if !on {
            return self.end_deferral();
        }
        if !self.deferred {
            // Only with a disk database that defers alongside: otherwise an
            // acknowledgement could become durable before its commit.
            if !self.db.defer_sync(true).map_err(db_err)? {
                return Ok(());
            }
            self.deferred = true;
            self.inner.defer_durability(true)?;
        }
        Ok(())
    }

    fn commit(&mut self, tx: Tx) -> StoreResult<CommitReport> {
        if self.cfg.queued_publication {
            self.queue_commit(tx)
        } else {
            self.immediate = true;
            let report = self.start_commit(tx).finish_immediate();
            self.immediate = false;
            report
        }
    }

    fn take_publish_results(&mut self) -> Vec<PublishResult> {
        if self.ensure_commit_available().is_err() {
            return Vec::new();
        }
        self.queued.take_results()
    }

    fn has_files(&self) -> bool {
        true
    }

    /// Snapshot-install staging lives in the inner store: staged rows are
    /// never published to, or observed on, the disk.
    fn stages(&self) -> bool {
        self.inner.stages()
    }

    fn materializes_attachments(&self) -> bool {
        self.attachments_supported()
    }

    fn attachment_source(
        &mut self,
        path: &str,
        size: u64,
    ) -> StoreResult<Option<Box<dyn mdbn_replica::replica::AttachmentSource>>> {
        self.open_source(path, size)
    }

    fn attachment_staged(&mut self, key: &StageKey) -> StoreResult<u64> {
        self.att_staged(key)
    }

    fn attachment_stage(&mut self, key: &StageKey, offset: u64, plain: &[u8]) -> StoreResult<()> {
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        self.end_deferral()?;
        self.att_stage(key, offset, plain)
    }

    fn attachment_stage_read(
        &mut self,
        key: &StageKey,
        offset: u64,
        len: u32,
    ) -> StoreResult<Vec<u8>> {
        self.att_stage_read(key, offset, len)
    }

    fn attachment_unstage(&mut self, key: &StageKey) -> StoreResult<()> {
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        self.end_deferral()?;
        self.att_unstage(key)
    }

    fn attachment_publish(
        &mut self,
        key: &StageKey,
        rev: Hash,
        path: &str,
        expect: RExpect,
    ) -> DiskResult {
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        self.end_deferral()?;
        self.att_publish(key, rev, path, expect)
    }

    fn attachment_remove(&mut self, id: Uuid, path: &str, expect: Hash) -> DiskResult {
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        self.end_deferral()?;
        self.att_remove(id, path, expect)
    }

    fn attachment_move(&mut self, id: Uuid, from: &str, to: &str, expect: Hash) -> DiskResult {
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        self.end_deferral()?;
        self.att_move(id, from, to, expect)
    }

    fn disk_revision(&self, path: &str) -> StoreResult<Option<Hash>> {
        Ok(FileStore::disk_revision(self, path))
    }

    fn disk_paths(&self) -> StoreResult<Vec<(String, Hash)>> {
        Ok(FileStore::disk_paths(self))
    }

    fn observe(&mut self, paths: Option<&[String]>) -> StoreResult<Vec<Observation>> {
        self.start_observe(paths).finish_immediate()
    }
    fn observe_async<'a>(
        &'a mut self,
        paths: Option<&'a [String]>,
    ) -> mdbn_replica::store::StoreFuture<'a, Vec<Observation>> {
        let paths = paths.map(<[String]>::to_vec);
        Box::pin(self.observe_task(paths))
    }
}
