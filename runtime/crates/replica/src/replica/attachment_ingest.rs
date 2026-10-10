//! Attachment-v1 ingest (`intent.md` §3.9, T6): files the store observed on disk
//! as attachments become uploads (`file_attach`), moves (`file_move`) and
//! deletes (`file_delete`), as `external` writes.
//!
//! ```text
//!  observe ──► Observed::Attachment / a delete at a file's path
//!                │
//!                ▼
//!              queue (one item per path; a newer observation replaces an older one)
//!                │   waits while a pending mutation of the same file or path is
//!                │   unconfirmed, and while another ingest upload runs
//!                ▼
//!   move with the same content ──► file_move (refs reused, nothing uploaded)
//!   create / edit             ──► streamed upload (T4) from Store::attachment_source,
//!                                 checkpoint persisted in device-local meta
//!   delete                    ──► file_delete
//! ```
//!
//! - **One upload at a time**, so at most one source handle is open, whatever
//!   the folder holds.
//! - **The uploader's own file.** The capture commit acknowledges the store's
//!   observation, so the store records that the path holds exactly the uploaded
//!   content (path, size, mtime, SHA-256). When the entry is confirmed,
//!   materialization finds the disk already showing it and adopts it: the
//!   uploading device never fetches its own upload.
//! - **Edits** re-upload the whole file (v1) under the same file ID; the older
//!   version's objects are released by the log as usual.
//! - **Restarts.** The checkpoint is persisted as chunks are stored. The
//!   observation was not acknowledged, so the store reports the file again
//!   after a restart, and the upload resumes from the checkpoint: stored chunks
//!   are re-read and verified, never sealed or sent again.
//! - **Native oversized Markdown:** streams through opaque native preparation and
//!   upload; fresh capture atomically acknowledges the observation. Failed native
//!   captures retain evidence. No ordinary-to-native implicit promotion.

use std::collections::{BTreeMap, VecDeque};

use mdbn_wire::attachment_runtime_v1 as rt;
use mdbn_wire::client::Problem;
use mdbn_wire::common::{Hash, Uuid};
use mdbn_wire::intent::{FileDelete, FileMove, Op};
use mdbn_wire::schema::Wire;

use super::Replica;
use super::attachment_upload::{
    AttachmentUploadCheckpoint, AttachmentUploadParams, AttachmentUploadStatus, Origin,
};
use crate::api::ErrorCode;
use crate::store::{
    AttachmentClass, Observation, ObservationId, Observed, Store, StoreError, Tx, meta_keys,
};

/// Failures remembered per path for [`Replica::attachment_ingest_failure`].
const MAX_FAILURES: usize = 256;
/// Pending rows read per page when checking for an unconfirmed write.
const PAGE: u32 = 256;

#[derive(Debug, Clone, PartialEq)]
enum Want {
    /// Upload (or move) the file now at `path`.
    Put {
        digest: Hash,
        size: u64,
        moved_from: Option<String>,
        native: bool,
    },
    /// A bounded record-source observation at the same native file holder.
    Reverse {
        digest: Hash,
        size: u64,
        moved_from: Option<String>,
    },
    /// The file at `path` is gone.
    Delete,
}

#[derive(Debug, Clone)]
struct Item {
    token: ObservationId,
    path: String,
    base: Option<Hash>,
    want: Want,
    retry_at: Option<i64>,
    /// A move continuation cannot mint a new identity if metadata capture fails.
    native_holder: Option<Uuid>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CaptureKind {
    Ordinary,
    Native,
    Reverse,
}

struct Current {
    mutation: Uuid,
    path: String,
    token: ObservationId,
    persisted: Option<usize>,
    kind: CaptureKind,
}

/// The replica's ingest of attachment files.
#[derive(Default)]
pub(crate) struct Ingests {
    queue: VecDeque<Item>,
    current: Option<Current>,
    busy: bool,
    failed: BTreeMap<String, Problem>,
    /// Oversized Markdown observations held after a source/capture refusal.
    pub(crate) oversized_markdown_held: u64,
    /// Uploads started (fresh or resumed) and moves captured, for tests.
    pub(crate) uploads_started: u64,
    pub(crate) uploads_resumed: u64,
    pub(crate) moves: u64,
}

impl Ingests {
    /// The earliest retry time of a waiting item.
    pub(crate) fn next_wakeup(&self) -> Option<i64> {
        self.queue.iter().filter_map(|i| i.retry_at).min()
    }
}

fn checkpoint_key(path: &str) -> String {
    let k = mdbn_core::paths::path_key(path);
    format!(
        "{}{}",
        meta_keys::ATTACHMENT_INGEST,
        mdbn_wire::hash::sha256(k.as_bytes()).to_hex()
    )
}

fn same_path(a: &str, b: &str) -> bool {
    mdbn_core::paths::path_key(a) == mdbn_core::paths::path_key(b)
}

impl<S: Store> Replica<S> {
    /// Why the last ingest upload of `path` failed, if it did (a newer
    /// observation of the path clears it).
    pub fn attachment_ingest_failure(&self, path: &str) -> Option<Problem> {
        self.attachment_ingest.failed.get(path).cloned()
    }

    /// Ingest an attachment observation, or a delete at a path that holds (or
    /// is about to hold) a file. Returns `false` when the observation is not
    /// this module's (a record or resource path).
    pub(crate) fn ingest_attachment(&mut self, o: &Observation) -> Result<bool, StoreError> {
        // Every newer store observation supersedes an uncommitted native job,
        // including shrink-to-record, malformed text, moves and deletion.
        if let Some(c) = self.attachment_ingest.current.take_if(|c| {
            c.kind != CaptureKind::Ordinary && c.token != o.token && same_path(&c.path, &o.path)
        }) {
            self.cancel_native_ingest(c.kind, c.mutation);
            self.commit_unindexed_tx(Tx {
                ack_observations: vec![c.token],
                ..Tx::default()
            })?;
        }
        // Quiet-window rechecks may supersede a move observation without
        // repeating its move hint. Retain only the native lineage hint; the
        // dedicated capture still proves the current holder/descriptor/authority.
        let mut moved_from = o.moved_from.clone().or_else(|| {
            self.attachment_ingest.queue.iter().rev().find_map(|item| {
                if !same_path(&item.path, &o.path) {
                    return None;
                }
                match &item.want {
                    Want::Put {
                        native: true,
                        moved_from,
                        ..
                    }
                    | Want::Reverse { moved_from, .. } => moved_from.clone(),
                    _ => None,
                }
            })
        });
        if moved_from.is_none() {
            moved_from = self.pending_native_move_hint(&o.path)?.map(|hint| hint.0);
        }
        let want = match &o.now {
            Some(Observed::Attachment {
                digest,
                size,
                class,
            }) => {
                let c = &self.catalog;
                let native = *class == AttachmentClass::OversizedMarkdown;
                if c.is_resource_path(&o.path) || (!native && c.is_record_path(&o.path)) {
                    // Not a file path: Markdown over the record cap waits for its
                    // emitter; undecodable text is not a file. The store keeps
                    // the evidence (nothing is acknowledged or dropped).
                    if *class == AttachmentClass::OversizedMarkdown {
                        self.attachment_ingest.oversized_markdown_held += 1;
                    }
                    return Ok(true);
                }
                Want::Put {
                    digest: *digest,
                    size: *size,
                    moved_from: moved_from.clone(),
                    native,
                }
            }
            Some(Observed::Text(text)) => {
                let pending = match moved_from.as_deref() {
                    Some(path) => self.pending_native_move_hint(path)?,
                    None => None,
                };
                let from = match moved_from.as_deref() {
                    Some(path) => self
                        .file_id_at(path)?
                        .or_else(|| pending.as_ref().map(|hint| hint.1)),
                    None => None,
                };
                let at = self.file_id_at(&o.path)?;
                let mut native = pending.is_some();
                for id in from.into_iter().chain(at) {
                    native |= self.store.file(&id)?.is_some_and(|f| f.kind == mdbn_wire::unindexed_markdown::FileKindV1::UnindexedOversizedMarkdown);
                }
                if native {
                    Want::Reverse {
                        digest: mdbn_wire::hash::sha256(text.as_bytes()),
                        size: text.len() as u64,
                        moved_from: moved_from.clone(),
                    }
                } else {
                    return Ok(false);
                }
            }
            None => {
                let tracked = self.file_id_at(&o.path)?.is_some()
                    || self
                        .attachment_ingest
                        .queue
                        .iter()
                        .any(|i| same_path(&i.path, &o.path))
                    || self
                        .attachment_ingest
                        .current
                        .as_ref()
                        .is_some_and(|c| same_path(&c.path, &o.path));
                if !tracked {
                    return Ok(false);
                }
                Want::Delete
            }
        };
        if self.local_only() || self.is_hosted() {
            // Attachments need a synced device log: left unacknowledged.
            return Ok(true);
        }
        self.attachment_ingest.failed.remove(&o.path);
        // A newer observation of the path replaces a queued one.
        let mut acks = Vec::new();
        self.attachment_ingest.queue.retain(|i| {
            let stale = same_path(&i.path, &o.path);
            if stale {
                acks.push(i.token);
            }
            !stale
        });
        if want == Want::Delete {
            // A delete also stops an upload of the path in progress.
            if let Some(c) = self
                .attachment_ingest
                .current
                .take_if(|c| same_path(&c.path, &o.path))
            {
                self.close_attachment_upload(&c.mutation);
                acks.push(c.token);
            }
        }
        if !acks.is_empty() || want == Want::Delete {
            let meta = if want == Want::Delete {
                vec![(checkpoint_key(&o.path), None)]
            } else {
                Vec::new()
            };
            self.store.commit(Tx {
                ack_observations: acks,
                meta,
                ..Tx::default()
            })?;
        }
        self.attachment_ingest.queue.push_back(Item {
            token: o.token,
            path: o.path.clone(),
            base: o.base,
            want,
            retry_at: None,
            native_holder: None,
        });
        Ok(true)
    }

    /// Advance ingest: finish the running upload, then start the next item
    /// that is ready.
    pub(crate) fn attachment_ingest_step(&mut self) {
        if self.attachment_ingest.busy || self.apply_fault {
            return;
        }
        self.attachment_ingest.busy = true;
        let r = self.ingest_step_inner();
        self.attachment_ingest.busy = false;
        if let Err(e) = r {
            self.incident(
                mdbn_wire::client::IncidentKind::Integrity,
                Some(mdbn_wire::common::Value::Text(format!(
                    "attachment ingest: {e}"
                ))),
            );
        }
    }

    fn ingest_step_inner(&mut self) -> Result<(), StoreError> {
        if !self.finish_current()? {
            return Ok(());
        }
        let now = self.now();
        let mut i = 0;
        while i < self.attachment_ingest.queue.len() {
            let item = &self.attachment_ingest.queue[i];
            let native_waiting = matches!(
                item.want,
                Want::Put { native: true, .. } | Want::Reverse { .. }
            ) && self.unindexed_capture_admission(&item.path).is_err_and(
                |e| e.problem().reason.as_deref() == Some("unindexed_capture_not_ready"),
            );
            if native_waiting
                || item.retry_at.is_some_and(|t| now < t)
                || self.path_unconfirmed(item)?
            {
                i += 1;
                continue;
            }
            let Some(item) = self.attachment_ingest.queue.remove(i) else {
                break;
            };
            self.start_item(item)?;
            if self.attachment_ingest.current.is_some() {
                // One upload at a time; it runs until done.
                return self.persist_checkpoint();
            }
        }
        Ok(())
    }

    /// Settle the running upload. Returns whether another may start.
    fn finish_current(&mut self) -> Result<bool, StoreError> {
        let Some(c) = self.attachment_ingest.current.as_ref() else {
            return Ok(true);
        };
        let (m, path, token) = (c.mutation, c.path.clone(), c.token);
        match c.kind {
            CaptureKind::Native => return self.finish_native_ingest(m, path, token),
            CaptureKind::Reverse => return self.finish_reverse_ingest(m, path, token),
            CaptureKind::Ordinary => {}
        }
        match self.attachment_upload_status(&m) {
            Some(AttachmentUploadStatus::Uploading { .. }) => {
                self.persist_checkpoint()?;
                Ok(false)
            }
            Some(AttachmentUploadStatus::Captured(_) | AttachmentUploadStatus::Held { .. }) => {
                // The capture commit acknowledged the observation and retired
                // the checkpoint; again here for an upload captured before a
                // restart (acknowledging twice is harmless).
                self.close_attachment_upload(&m);
                self.attachment_ingest.current = None;
                self.store.commit(Tx {
                    ack_observations: vec![token],
                    meta: vec![(checkpoint_key(&path), None)],
                    ..Tx::default()
                })?;
                Ok(true)
            }
            Some(AttachmentUploadStatus::Failed(p)) => {
                self.close_attachment_upload(&m);
                self.attachment_ingest.current = None;
                self.ingest_failed(token, &path, p)?;
                Ok(true)
            }
            None => {
                self.attachment_ingest.current = None;
                Ok(true)
            }
        }
    }

    /// Stop on a failed item: acknowledge the observation (a later change to
    /// the file is observed afresh), drop its checkpoint, remember why.
    fn ingest_failed(
        &mut self,
        token: ObservationId,
        path: &str,
        p: Problem,
    ) -> Result<(), StoreError> {
        self.store.commit(Tx {
            // A stale generation or certified failed hold commit never
            // acknowledges a save that has not been durably collected.
            ack_observations: if matches!(
                p.reason.as_deref(),
                Some("attachment_hold_changed" | "attachment_hold_commit_aborted")
            ) {
                Vec::new()
            } else {
                vec![token]
            },
            meta: vec![(checkpoint_key(path), None)],
            ..Tx::default()
        })?;
        if p.code == ErrorCode::QuotaExceeded.as_str() {
            self.incident(mdbn_wire::client::IncidentKind::QuotaExceeded, None);
        }
        let f = &mut self.attachment_ingest.failed;
        if f.len() >= MAX_FAILURES
            && let Some(k) = f.keys().next().cloned()
        {
            f.remove(&k);
        }
        f.insert(path.to_owned(), p);
        Ok(())
    }

    /// Native failures retain the store's evidence for a fresh observation or
    /// restart. An uploader status is not durable capture/admission authority.
    fn native_ingest_failed(&mut self, path: &str, problem: Problem) {
        self.attachment_ingest.oversized_markdown_held += 1;
        if self.attachment_ingest.failed.len() >= MAX_FAILURES
            && let Some(k) = self.attachment_ingest.failed.keys().next().cloned()
        {
            self.attachment_ingest.failed.remove(&k);
        }
        self.attachment_ingest.failed.insert(path.into(), problem);
    }

    fn finish_native_ingest(
        &mut self,
        id: Uuid,
        path: String,
        token: ObservationId,
    ) -> Result<bool, StoreError> {
        use super::UnindexedUploadStatus as Status;
        match self.unindexed_markdown_upload_status(&id) {
            Some(Status::Uploading { .. }) => return Ok(false),
            Some(Status::Prepared) => {
                let result = self
                    .take_prepared_unindexed_upload(&id)
                    .and_then(|p| self.capture_observed_unindexed_upload(p, token));
                if let Err(e) = result {
                    self.native_ingest_failed(&path, e.problem().clone());
                }
            }
            Some(Status::Failed(p)) => self.native_ingest_failed(&path, p),
            None => {}
        }
        self.cancel_unindexed_markdown_upload(&id);
        self.attachment_ingest.current = None;
        // Unknown capture persistence already quarantined the instance. Never
        // start another item or retire its evidence in the same drive loop.
        Ok(!self.apply_fault)
    }

    fn cancel_native_ingest(&mut self, kind: CaptureKind, id: Uuid) {
        match kind {
            CaptureKind::Native => self.cancel_unindexed_markdown_upload(&id),
            CaptureKind::Reverse => self.cancel_unindexed_markdown_reindex_upload(&id),
            CaptureKind::Ordinary => {
                self.close_attachment_upload(&id);
            }
        }
    }

    fn finish_reverse_ingest(
        &mut self,
        id: Uuid,
        path: String,
        token: ObservationId,
    ) -> Result<bool, StoreError> {
        use super::UnindexedUploadStatus as Status;
        match self.unindexed_markdown_reindex_upload_status(&id) {
            Some(Status::Uploading { .. }) => return Ok(false),
            Some(Status::Prepared) => {
                if let Err(e) = self
                    .take_prepared_unindexed_reindex_upload(&id)
                    .and_then(|p| self.capture_observed_unindexed_reindex_upload(p, token))
                {
                    self.native_ingest_failed(&path, e.problem().clone());
                }
            }
            Some(Status::Failed(p)) => self.native_ingest_failed(&path, p),
            None => {}
        }
        self.cancel_unindexed_markdown_reindex_upload(&id);
        self.attachment_ingest.current = None;
        Ok(!self.apply_fault)
    }

    fn start_reverse_ingest(&mut self, item: Item) -> Result<(), StoreError> {
        let Want::Reverse {
            digest,
            size,
            moved_from,
        } = &item.want
        else {
            unreachable!()
        };
        let (digest, size, moved_from) = (*digest, *size, moved_from.clone());
        if let Some(from) = moved_from {
            return self.start_native_move(item, from);
        }
        let Some(id) = self.file_id_at(&item.path)? else {
            self.native_ingest_failed(
                &item.path,
                ErrorCode::Conflict.problem_with_reason(
                    "unindexed_capture_changed",
                    "native reverse holder changed",
                ),
            );
            return Ok(());
        };
        if self.store.hold(&id)?.is_some() {
            self.native_ingest_failed(
                &item.path,
                ErrorCode::Unavailable.problem_with_reason(
                    "native_record_held",
                    "resolve the hold before native reverse",
                ),
            );
            return Ok(());
        }
        let Some(source) = self.store.attachment_source(&item.path, size)? else {
            self.native_ingest_failed(
                &item.path,
                ErrorCode::Unavailable.problem_with_reason(
                    "native_source_unavailable",
                    "reverse source remains held",
                ),
            );
            return Ok(());
        };
        let proof = match self.prepare_unindexed_markdown_reindex(id, item.path.clone(), source) {
            Ok(p) if p.source_hash() == digest && p.size() == size => p,
            Ok(_) => {
                self.native_ingest_failed(
                    &item.path,
                    ErrorCode::Conflict.problem_with_reason(
                        "source_changed",
                        "reverse observation source changed",
                    ),
                );
                return Ok(());
            }
            Err(e) => {
                self.native_ingest_failed(&item.path, e.problem().clone());
                return Ok(());
            }
        };
        match self.start_unindexed_markdown_reindex_upload(proof) {
            Ok(mutation) => {
                self.attachment_ingest.current = Some(Current {
                    mutation,
                    path: item.path,
                    token: item.token,
                    persisted: None,
                    kind: CaptureKind::Reverse,
                })
            }
            Err(e) => self.native_ingest_failed(&item.path, e.problem().clone()),
        }
        Ok(())
    }

    fn start_native_ingest(&mut self, item: Item) -> Result<(), StoreError> {
        use mdbn_wire::unindexed_markdown::FileKindV1;
        let Want::Put {
            digest,
            size,
            moved_from,
            ..
        } = &item.want
        else {
            unreachable!()
        };
        let (digest, size, moved_from) = (*digest, *size, moved_from.clone());
        if let Some(from) = moved_from {
            return self.start_native_move(item, from);
        }
        let key = mdbn_core::paths::path_key(&item.path);
        let file = self.store.file_at(&key)?;
        if let Some(id) = file {
            let row = self
                .store
                .file(&id)?
                .ok_or_else(|| StoreError::Corrupt("file path without holder".into()))?;
            if row.kind != FileKindV1::UnindexedOversizedMarkdown {
                self.native_ingest_failed(
                    &item.path,
                    ErrorCode::Unavailable.problem_with_reason(
                        "ordinary_kind_transition_requires_capture",
                        "ordinary files are never implicitly native",
                    ),
                );
                return Ok(());
            }
        }
        let id = file
            .or(self.store.record_at(&key)?)
            .unwrap_or_else(|| self.mint_v7());
        if self.store.hold(&id)?.is_some() {
            self.native_ingest_failed(
                &item.path,
                ErrorCode::Unavailable.problem_with_reason(
                    "native_record_held",
                    "resolve the record hold before native conversion",
                ),
            );
            return Ok(());
        }
        let Some(source) = self.store.attachment_source(&item.path, size)? else {
            self.native_ingest_failed(
                &item.path,
                ErrorCode::Unavailable.problem_with_reason(
                    "native_source_unavailable",
                    "native observation source remains held",
                ),
            );
            return Ok(());
        };
        let proof = match self.prepare_unindexed_markdown_capture(id, item.path.clone(), source) {
            Ok(p) => p,
            Err(e) => {
                self.native_ingest_failed(&item.path, e.problem().clone());
                return Ok(());
            }
        };
        if proof.size() != size || proof.plain_hash() != digest {
            // Old evidence must not name newly read bytes. Retain it and let
            // the store offer current evidence; no upload/capture/ack occurred.
            self.native_ingest_failed(
                &item.path,
                ErrorCode::Conflict
                    .problem_with_reason("source_changed", "native observed bytes changed"),
            );
            return Ok(());
        }
        if file.is_some() && self.content_hash(&id)? == Some(digest) {
            return self.commit_unindexed_tx(Tx {
                ack_observations: vec![item.token],
                ..Tx::default()
            });
        }
        match self.start_unindexed_markdown_upload(proof) {
            Ok(mutation) => {
                self.attachment_ingest.current = Some(Current {
                    mutation,
                    path: item.path,
                    token: item.token,
                    persisted: None,
                    kind: CaptureKind::Native,
                })
            }
            Err(e) => self.native_ingest_failed(&item.path, e.problem().clone()),
        }
        Ok(())
    }

    fn start_native_move(&mut self, mut item: Item, from: String) -> Result<(), StoreError> {
        let holder = self.file_id_at(&from)?;
        if let Some(id) = holder {
            let row = self
                .store
                .file(&id)?
                .ok_or_else(|| StoreError::Corrupt("native move holder missing".into()))?;
            match self.capture_native_move(id, &row.path, &item.path) {
                Ok(()) => {
                    self.attachment_ingest.moves += 1;
                    item.native_holder = Some(id);
                }
                Err(e) => {
                    self.native_ingest_failed(&item.path, e.problem().clone());
                    return Ok(());
                }
            }
        } else {
            // A cold reopen may reoffer the old move hint after its metadata
            // entry confirmed. Only the existing native target can continue;
            // never mint a replacement identity from that hint.
            let native = match self.file_id_at(&item.path)? {
                Some(id) => self.store.file(&id)?.is_some_and(|f| {
                    f.kind == mdbn_wire::unindexed_markdown::FileKindV1::UnindexedOversizedMarkdown
                }),
                None => false,
            };
            if !native {
                self.native_ingest_failed(
                    &item.path,
                    ErrorCode::Conflict.problem_with_reason(
                        "native_move_changed",
                        "native move holder disappeared",
                    ),
                );
                return Ok(());
            }
        }
        match &mut item.want {
            Want::Put { moved_from, .. } | Want::Reverse { moved_from, .. } => *moved_from = None,
            Want::Delete => unreachable!(),
        }
        self.attachment_ingest.queue.push_front(item);
        Ok(())
    }

    fn persist_checkpoint(&mut self) -> Result<(), StoreError> {
        let Some(c) = self.attachment_ingest.current.as_ref() else {
            return Ok(());
        };
        if c.kind != CaptureKind::Ordinary {
            return Ok(());
        }
        let Some(cp) = self.attachment_upload_checkpoint(&c.mutation) else {
            return Ok(());
        };
        if c.persisted == Some(cp.chunk_count()) {
            return Ok(());
        }
        let key = checkpoint_key(&c.path);
        self.store.commit(Tx {
            meta: vec![(key, Some(cp.to_bytes()))],
            ..Tx::default()
        })?;
        if let Some(c) = self.attachment_ingest.current.as_mut() {
            c.persisted = Some(cp.chunk_count());
        }
        Ok(())
    }

    /// The confirmed file at `path`, if any.
    fn file_id_at(&self, path: &str) -> Result<Option<Uuid>, StoreError> {
        self.store.file_at(&mdbn_core::paths::path_key(path))
    }

    /// Whether a pending (unconfirmed) mutation writes the item's path or its
    /// file: the item waits for it, so it sees the file's confirmed ID, path and
    /// content (pending attachment content is not layered locally).
    fn path_unconfirmed(&self, item: &Item) -> Result<bool, StoreError> {
        let mut paths = vec![item.path.as_str()];
        if let Want::Put {
            moved_from: Some(f),
            ..
        }
        | Want::Reverse {
            moved_from: Some(f),
            ..
        } = &item.want
        {
            paths.push(f);
        }
        let mut ids = Vec::new();
        for p in &paths {
            ids.extend(self.file_id_at(p)?);
            ids.extend(self.store.record_at(&mdbn_core::paths::path_key(p))?);
        }
        let hit = |path: &str| paths.iter().any(|p| same_path(p, path));
        let mut after = None;
        loop {
            let page = self.store.pending(after, PAGE)?;
            for row in &page {
                for op in &row.mutation.ops {
                    let found = match op {
                        rt::Op::FileAttach(f) => hit(&f.path) || ids.contains(&f.id),
                        rt::Op::UnindexedMarkdownPut(f) => hit(&f.path) || ids.contains(&f.id),
                        rt::Op::RecordToUnindexedMarkdown(f) => hit(&f.path) || ids.contains(&f.id),
                        rt::Op::UnindexedMarkdownToRecord(f) => hit(&f.path) || ids.contains(&f.id),
                        rt::Op::Legacy(Op::FileMove(m)) => {
                            hit(&m.from) || hit(&m.to) || ids.contains(&m.id)
                        }
                        rt::Op::Legacy(Op::FileDelete(d)) => ids.contains(&d.id),
                        rt::Op::Legacy(Op::FilePut(f)) => hit(&f.path) || ids.contains(&f.id),
                        rt::Op::Legacy(Op::Create(c)) => {
                            c.path.as_deref().is_some_and(hit) || ids.contains(&c.id)
                        }
                        rt::Op::Legacy(Op::Document(d)) => {
                            d.new
                                .as_ref()
                                .into_iter()
                                .chain(d.base.as_ref())
                                .any(|v| hit(&v.path))
                                || ids.contains(&d.id)
                        }
                        rt::Op::Legacy(Op::Update(u)) => ids.contains(&u.id),
                        rt::Op::Legacy(Op::Delete(d)) => ids.contains(&d.id),
                        rt::Op::Legacy(Op::Rename(r)) => {
                            hit(&r.from) || hit(&r.to) || ids.contains(&r.id)
                        }
                        _ => false,
                    };
                    if found {
                        return Ok(true);
                    }
                }
            }
            if page.len() < PAGE as usize {
                return Ok(false);
            }
            after = page.last().map(|r| r.order);
        }
    }

    fn content_hash(&self, id: &Uuid) -> Result<Option<Hash>, StoreError> {
        Ok(self.store.file(id)?.map(|r| r.content.plain_hash()))
    }

    fn start_item(&mut self, item: Item) -> Result<(), StoreError> {
        if let Some(id) = item.native_holder
            && self.file_id_at(&item.path)? != Some(id)
        {
            self.native_ingest_failed(
                &item.path,
                ErrorCode::Conflict.problem_with_reason(
                    "native_move_changed",
                    "move continuation lost its authoritative identity",
                ),
            );
            return Ok(());
        }
        let (digest, size, moved_from) = match &item.want {
            Want::Delete => return self.ingest_delete(item),
            Want::Reverse { .. } => return self.start_reverse_ingest(item),
            Want::Put {
                digest,
                size,
                moved_from,
                native,
            } => {
                if *native {
                    return self.start_native_ingest(item);
                }
                (*digest, *size, moved_from.clone())
            }
        };
        let held = self.store.holds()?.into_iter().find(|h| {
            same_path(&h.path, &item.path)
                || moved_from.as_ref().is_some_and(|p| same_path(&h.path, p))
        });
        if held.is_some() && moved_from.is_some() {
            // A hold is not permission to emit a metadata move. Preserve the
            // observation/bytes for explicit resolution; never ACK it here.
            return Ok(());
        }
        if let Some(from) = moved_from
            && let Some(id) = self.file_id_at(&from)?
        {
            let old = self.content_hash(&id)?;
            let op = Op::FileMove(FileMove {
                id,
                from,
                to: item.path.clone(),
                update_refs: false,
                if_revision: None,
            });
            self.attachment_ingest.moves += 1;
            if old == Some(digest) {
                // A metadata-only move: the descriptor and its refs are reused.
                return self.capture_external_ops(vec![op], vec![item.token]);
            }
            // Moved and edited: move first, then re-upload once the move is
            // confirmed (the item waits for it).
            self.capture_external_ops(vec![op], Vec::new())?;
            self.attachment_ingest.queue.push_front(Item {
                base: old,
                want: Want::Put {
                    digest,
                    size,
                    moved_from: None,
                    native: false,
                },
                ..item
            });
            return Ok(());
        }
        let current = match held.as_ref().map(|h| h.id).or(self.file_id_at(&item.path)?) {
            Some(id) => Some((id, self.content_hash(&id)?)),
            None => None,
        };
        if let Some((_, Some(h))) = current
            && held.is_none()
            && h == digest
        {
            // The disk shows the file's content already (an echo, a touch).
            return self.ack_one(item.token);
        }
        let Some(source) = self.store.attachment_source(&item.path, size)? else {
            // Gone or changed since observed: a newer observation follows.
            return self.ack_one(item.token);
        };
        let file = match current {
            Some((id, _)) => id,
            None => self.mint_v7(),
        };
        let key = checkpoint_key(&item.path);
        let origin = Origin {
            delegated: None,
            external: true,
            held: held
                .as_ref()
                .map(|h| h.to_bytes().map(|b| mdbn_wire::hash::sha256(&b)))
                .transpose()
                .map_err(|e| StoreError::Corrupt(format!("hold stamp: {e}")))?,
            base: current.and(item.base),
            acks: vec![item.token],
            meta: vec![(key.clone(), None)],
        };
        let checkpoint = self
            .store
            .meta(&key)?
            .and_then(|b| AttachmentUploadCheckpoint::from_bytes(&b).ok())
            .filter(|c| {
                let (f, p, total) = c.target();
                f == file && same_path(p, &item.path) && total == size
            });
        let started = match checkpoint {
            Some(cp) => {
                self.attachment_ingest.uploads_resumed += 1;
                self.resume_upload_with(cp, source, origin)
            }
            None => {
                self.attachment_ingest.uploads_started += 1;
                self.start_upload_with(
                    AttachmentUploadParams {
                        file,
                        path: item.path.clone(),
                        if_revision: None,
                        mutation: None,
                    },
                    source,
                    origin,
                )
            }
        };
        match started {
            Ok(mutation) => {
                self.attachment_ingest.current = Some(Current {
                    mutation,
                    path: item.path,
                    token: item.token,
                    persisted: None,
                    kind: CaptureKind::Ordinary,
                });
                Ok(())
            }
            Err(e) => {
                let p = e.into_problem();
                if p.code == ErrorCode::Unavailable.as_str() {
                    // No current write key yet: try again later.
                    let at = self
                        .now()
                        .saturating_add(i64::try_from(self.tuning.retry_ms).unwrap_or(0));
                    self.attachment_ingest.queue.push_back(Item {
                        retry_at: Some(at),
                        ..item
                    });
                    return Ok(());
                }
                self.ingest_failed(item.token, &item.path, p)
            }
        }
    }

    fn ingest_delete(&mut self, item: Item) -> Result<(), StoreError> {
        if self
            .store
            .holds()?
            .iter()
            .any(|h| same_path(&h.path, &item.path))
        {
            // Do not turn a held-path deletion into a propagating FileDelete or
            // an invented empty attachment descriptor. Evidence stays observed.
            return Ok(());
        }
        let Some(id) = self.file_id_at(&item.path)? else {
            return self.ack_one(item.token);
        };
        self.capture_external_ops(
            vec![Op::FileDelete(FileDelete {
                id,
                if_revision: None,
                base: item.base,
            })],
            vec![item.token],
        )
    }

    fn ack_one(&mut self, token: ObservationId) -> Result<(), StoreError> {
        self.store.commit(Tx {
            ack_observations: vec![token],
            ..Tx::default()
        })?;
        Ok(())
    }

    fn capture_external_ops(
        &mut self,
        ops: Vec<Op>,
        tokens: Vec<ObservationId>,
    ) -> Result<(), StoreError> {
        let m = self.capture(ops, mdbn_wire::intent::Source::External);
        self.capture_and_queue(m, tokens)
    }
}
