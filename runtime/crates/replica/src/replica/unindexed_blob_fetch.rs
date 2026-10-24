//! Bounded native Blob materialization; never uses the whole-blob cache.
use super::{Replica, UnindexedSourceNeed, UnindexedSourceReader};
use crate::{
    attachments::{PlainSink, StreamError, WholeFileHasher},
    log::{CallId, LogReply, LogRequest, LogResponse},
    store::{Expect, FileLocal, FileRow, StageKey, Store, StoreError},
};
use mdbn_wire::{attachment::FileContent, common::Uuid, unindexed_markdown::FileKindV1};
use std::collections::VecDeque;
#[derive(Default)]
pub(crate) struct Fetches {
    queue: VecDeque<Uuid>,
    current: Option<Fetch>,
    retry_at: Option<i64>,
}
struct Fetch {
    file: Uuid,
    content: FileContent,
    key: StageKey,
    reader: UnindexedSourceReader,
    staged: u64,
    call: Option<CallId>,
    retry_at: Option<i64>,
}
struct Sink<'a, S: Store> {
    store: &'a mut S,
    key: StageKey,
    staged: &'a mut u64,
}
impl<S: Store> PlainSink for Sink<'_, S> {
    fn write(&mut self, at: u64, plain: &[u8]) -> Result<(), String> {
        if at != *self.staged {
            return Err("non-contiguous native staging".into());
        }
        self.store
            .attachment_stage(&self.key, at, plain)
            .map_err(|e| e.to_string())?;
        *self.staged += plain.len() as u64;
        Ok(())
    }
}
impl Fetches {
    pub(crate) fn next_wakeup(&self) -> Option<i64> {
        [
            self.current.as_ref().and_then(|f| f.retry_at),
            self.retry_at,
        ]
        .into_iter()
        .flatten()
        .min()
    }
}
impl<S: Store> Replica<S> {
    fn native_blob_read_ready(&self) -> bool {
        self.store.materializes_attachments()
            && !self.is_hosted()
            && !self.local_only()
            && !self.apply_fault
            && self.stalled.is_none()
            && self.install.is_none()
            && !self.repairing()
            && !self.is_apply_recovering()
            && self.log_move == super::LogMove::None
            && self
                .policy
                .devices
                .get(&self.cfg.device_id)
                .is_some_and(|d| {
                    d.active && d.keyed && self.policy.members.contains_key(&d.account)
                })
    }
    pub(crate) fn cancel_native_blob(&mut self, id: Uuid) -> Result<(), StoreError> {
        self.unindexed_blob_fetches.queue.retain(|f| *f != id);
        if self
            .unindexed_blob_fetches
            .current
            .as_ref()
            .is_some_and(|f| f.file == id)
            && let Some(f) = self.unindexed_blob_fetches.current.take()
        {
            if let Some(call) = f.call {
                self.inflight.remove(&call);
            }
            self.store.attachment_unstage(&f.key)?;
        }
        Ok(())
    }
    pub(crate) fn reconcile_native_blob(&mut self, row: FileRow) -> Result<(), StoreError> {
        let id = row.id;
        if self.file_materialization_fenced(id, Some(&row.path))? {
            return self.cancel_native_blob(id);
        }
        let rev = row.content.plain_hash();
        if let Some((path, old)) = self.attachment_shown(&id)?
            && old == rev
            && (path == row.path
                || self
                    .store
                    .attachment_move(id, &path, &row.path, rev)?
                    .is_none()
                || self.store.disk_revision(&row.path)? == Some(rev))
        {
            self.cancel_native_blob(id)?;
            return self.commit_shown(
                Self::with_local(&row, FileLocal::Materialized),
                &id,
                Some((&row.path, rev)),
            );
        }
        if self.store.disk_revision(&row.path)? == Some(rev) {
            self.cancel_native_blob(id)?;
            return self.commit_shown(
                Self::with_local(&row, FileLocal::Materialized),
                &id,
                Some((&row.path, rev)),
            );
        }
        if self
            .unindexed_blob_fetches
            .current
            .as_ref()
            .is_some_and(|f| f.file == id && f.content != row.content)
        {
            self.cancel_native_blob(id)?;
        }
        if !self.unindexed_blob_fetches.queue.contains(&id)
            && self
                .unindexed_blob_fetches
                .current
                .as_ref()
                .is_none_or(|f| f.file != id)
        {
            self.unindexed_blob_fetches.queue.push_back(id);
        }
        self.commit_shown(
            Self::with_local(&row, FileLocal::Remote),
            &id,
            self.attachment_shown(&id)?
                .as_ref()
                .map(|(p, h)| (p.as_str(), *h)),
        )?;
        self.native_blob_step();
        Ok(())
    }
    pub(crate) fn native_blob_step(&mut self) {
        if !self.native_blob_read_ready() {
            return;
        }
        if self
            .unindexed_blob_fetches
            .retry_at
            .is_some_and(|t| self.now() < t)
        {
            return;
        }
        self.unindexed_blob_fetches.retry_at = None;
        if self.unindexed_blob_fetches.current.is_none() {
            let Some(id) = self.unindexed_blob_fetches.queue.pop_front() else {
                return;
            };
            let result = (|| {
                let Some(row) = self.store.file(&id)? else {
                    return Ok(None);
                };
                if row.kind != FileKindV1::UnindexedOversizedMarkdown
                    || !matches!(row.content, FileContent::Blob(_))
                {
                    return Ok(None);
                }
                let descriptor = mdbn_wire::schema::Wire::to_bytes(&row.content)
                    .map_err(|e| StoreError::Corrupt(e.to_string()))?;
                let key = StageKey {
                    file: id,
                    manifest: mdbn_wire::hash::sha256(&descriptor),
                };
                // No persisted prefix can stand in for this full proof.
                self.store.attachment_unstage(&key)?;
                let reader = UnindexedSourceReader::new(
                    &*self.sealer,
                    row.content.clone(),
                    self.cfg.collection,
                )
                .map_err(|e| StoreError::Io(format!("native source: {e:?}")))?;
                Ok(Some(Fetch {
                    file: id,
                    content: row.content,
                    key,
                    reader,
                    staged: 0,
                    call: None,
                    retry_at: None,
                }))
            })();
            match result {
                Ok(f) => self.unindexed_blob_fetches.current = f,
                Err(e) => {
                    self.native_blob_problem(&e);
                    self.retry_native_blob(id);
                    return;
                }
            }
        }
        let Some(mut f) = self.unindexed_blob_fetches.current.take() else {
            return;
        };
        if f.call.is_some() || f.retry_at.is_some_and(|t| self.now() < t) {
            self.unindexed_blob_fetches.current = Some(f);
            return;
        }
        f.retry_at = None;
        match self.store.file(&f.file) {
            Ok(Some(r))
                if r.kind == FileKindV1::UnindexedOversizedMarkdown && r.content == f.content => {}
            Ok(_) => {
                let _ = self.store.attachment_unstage(&f.key);
                return;
            }
            Err(e) => {
                self.native_blob_problem(&e);
                self.retry_native_blob(f.file);
                return;
            }
        }
        match f.reader.need() {
            Some(UnindexedSourceNeed::Blob {
                address,
                max_sealed_bytes,
                ..
            }) => {
                let call = self.queue(LogRequest::GetObject {
                    collection: self.cfg.collection,
                    address,
                    range: Some((0, max_sealed_bytes)),
                });
                self.inflight
                    .insert(call, super::append::Inflight::UnindexedBlob(f.file));
                f.call = Some(call);
                self.unindexed_blob_fetches.current = Some(f);
            }
            _ => {
                self.native_blob_problem(&StoreError::Corrupt(
                    "unexpected native Blob need".into(),
                ));
            }
        }
    }
    pub(crate) fn on_native_blob_reply(&mut self, file: Uuid, call: CallId, reply: LogReply) {
        let Some(mut f) = self.unindexed_blob_fetches.current.take() else {
            return;
        };
        if f.file != file || f.call != Some(call) {
            self.unindexed_blob_fetches.current = Some(f);
            return;
        }
        f.call = None;
        if !self.native_blob_read_ready() {
            let _ = self.store.attachment_unstage(&f.key);
            return;
        }
        match self.store.file(&file) {
            Ok(Some(row))
                if row.kind == FileKindV1::UnindexedOversizedMarkdown
                    && row.content == f.content => {}
            Ok(_) => {
                let _ = self.store.attachment_unstage(&f.key);
                return;
            }
            Err(e) => {
                self.native_blob_problem(&e);
                return;
            }
        }
        let result = match reply {
            Ok(LogResponse::GetObject { bytes, size, .. }) if size == bytes.len() as u64 => {
                let mut sink = Sink {
                    store: &mut self.store,
                    key: f.key,
                    staged: &mut f.staged,
                };
                Some(f.reader.supply(&*self.sealer, &bytes, &mut sink))
            }
            Ok(LogResponse::GetObject { .. }) => {
                Some(Err(StreamError::Corrupt("incomplete native object")))
            }
            _ => None,
        };
        match result {
            None => {
                f.retry_at = Some(
                    self.now().saturating_add(
                        i64::try_from(self.tuning.retry_ms)
                            .unwrap_or(1000)
                            .max(1000),
                    ),
                );
                self.unindexed_blob_fetches.current = Some(f);
            }
            Some(Err(e)) => {
                let _ = self.store.attachment_unstage(&f.key);
                self.native_blob_problem(&StoreError::Io(format!("native Blob: {e:?}")));
                self.retry_native_blob(file);
            }
            Some(Ok(())) if f.reader.need().is_some() => {
                self.unindexed_blob_fetches.current = Some(f)
            }
            Some(Ok(())) => {
                let key = f.key;
                let content = f.content.clone();
                match f.reader.finish() {
                    Ok(proof) => {
                        if proof.content() != &content {
                            return;
                        }
                        if let Err(e) = self.publish_native_blob(file, key, &content) {
                            self.native_blob_problem(&e);
                        }
                    }
                    Err(e) => {
                        let _ = self.store.attachment_unstage(&key);
                        self.native_blob_problem(&StoreError::Io(format!(
                            "native Blob final: {e:?}"
                        )));
                    }
                }
            }
        }
        self.native_blob_step();
    }
    fn publish_native_blob(
        &mut self,
        id: Uuid,
        key: StageKey,
        c: &FileContent,
    ) -> Result<(), StoreError> {
        if !self.native_blob_read_ready() {
            self.store.attachment_unstage(&key)?;
            return Ok(());
        }
        let Some(row) = self
            .store
            .file(&id)?
            .filter(|r| r.kind == FileKindV1::UnindexedOversizedMarkdown && r.content == *c)
        else {
            self.store.attachment_unstage(&key)?;
            return Ok(());
        };
        if self.file_materialization_fenced(id, Some(&row.path))? {
            self.store.attachment_unstage(&key)?;
            return Ok(());
        }
        // Re-hash the actual private staging, not just received buffers.
        let mut hash = WholeFileHasher::default();
        let mut at = 0;
        if self.store.attachment_staged(&key)? != c.size() {
            return Err(StoreError::Corrupt("native staged count".into()));
        }
        while at < c.size() {
            let n = (c.size() - at).min(1048576) as u32;
            let b = self.store.attachment_stage_read(&key, at, n)?;
            if b.is_empty() || b.len() > n as usize {
                return Err(StoreError::Corrupt("native stage read".into()));
            }
            hash.update(&b);
            at += b.len() as u64;
        }
        if hash.finish() != c.plain_hash() {
            return Err(StoreError::Corrupt("native staged hash".into()));
        }
        let shown = self.attachment_shown(&id)?;
        let expect = shown
            .as_ref()
            .filter(|(p, _)| *p == row.path)
            .map_or(Expect::Absent, |(_, h)| Expect::Revision(*h));
        let drift = self
            .store
            .attachment_publish(&key, c.plain_hash(), &row.path, expect)?;
        if drift.is_some() && self.store.disk_revision(&row.path)? != Some(c.plain_hash()) {
            self.store.attachment_unstage(&key)?;
            return Ok(());
        }
        if let Some((old_path, old_rev)) = shown
            && old_path != row.path
        {
            // Remove an old location only after the complete new version exists.
            // A user edit at that old location is never clobbered.
            let _ = self.store.attachment_remove(id, &old_path, old_rev)?;
        }
        self.commit_shown(
            Self::with_local(&row, FileLocal::Materialized),
            &id,
            Some((&row.path, c.plain_hash())),
        )
    }
    fn retry_native_blob(&mut self, id: Uuid) {
        if !self.unindexed_blob_fetches.queue.contains(&id) {
            self.unindexed_blob_fetches.queue.push_back(id);
        }
        self.unindexed_blob_fetches.retry_at = Some(
            self.now().saturating_add(
                i64::try_from(self.tuning.retry_ms)
                    .unwrap_or(1000)
                    .max(1000),
            ),
        );
    }
    fn native_blob_problem(&mut self, e: &StoreError) {
        self.incident(
            mdbn_wire::client::IncidentKind::Integrity,
            Some(mdbn_wire::common::Value::Text(format!(
                "native Blob placement: {e}"
            ))),
        );
    }
}
