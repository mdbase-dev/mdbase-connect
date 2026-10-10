//! Bounded authenticated Blob-backed record snapshot source, never holder authority.
use super::Replica;
use crate::{
    attachments::StreamError,
    file_source::{FileSourceReader, SourceNeed},
    log::{CallId, LogReply, LogRequest, LogResponse},
    store::{Head, Store},
};
use mdbn_wire::{
    attachment::FileContent,
    attachment_runtime_v1::ManifestPayload,
    common::{Hash, Uuid},
    intent::BlobRef,
};
use std::collections::{BTreeSet, VecDeque};
#[derive(Default)]
pub(crate) struct Sources {
    queue: VecDeque<Row>,
    job: Option<Job>,
    context: Option<Context>,
    error: Option<StreamError>,
    delay: Option<i64>,
}
pub(crate) struct Row {
    pub(crate) id: Uuid,
    pub(crate) path: String,
    pub(crate) blob: BlobRef,
    pub(crate) modified_seq: u64,
}
struct Job {
    row: Row,
    reader: FileSourceReader,
    call: Option<CallId>,
    retry_at: Option<i64>,
}
struct Context {
    target: Head,
    digest: Hash,
    predecessor: Head,
    generation: u64,
    control: Hash,
    refs: BTreeSet<Hash>,
}
pub(crate) enum Check {
    Pending,
    Ready,
    Failed(StreamError),
}
impl Sources {
    pub(crate) fn add(&mut self, row: Row) {
        self.queue.push_back(row);
    }
    pub(crate) fn next_wakeup(&self) -> Option<i64> {
        self.delay
            .or_else(|| self.job.as_ref().and_then(|j| j.retry_at))
    }
}
impl<S: Store> Replica<S> {
    pub(crate) fn snapshot_text_check(&mut self, m: &ManifestPayload) -> Check {
        if self
            .install_text_sources
            .delay
            .is_some_and(|t| self.now() < t)
        {
            return Check::Pending;
        }
        self.install_text_sources.delay = None;
        let target = Head {
            seq: m.seq,
            chain: m.chain,
        };
        if self.install_text_sources.context.as_ref().is_some_and(|c| {
            c.target != target
                || c.digest != m.state_digest
                || c.predecessor != self.head
                || c.generation != self.store_generation
                || c.control != self.policy.ctl_chain
                || self.install_refs.as_ref() != Some(&c.refs)
        }) {
            return Check::Failed(StreamError::Protocol("snapshot text context changed"));
        }
        if self.install_text_sources.context.is_none() {
            self.install_text_sources.context = Some(Context {
                target,
                digest: m.state_digest,
                predecessor: self.head,
                generation: self.store_generation,
                control: self.policy.ctl_chain,
                refs: self.install_refs.clone().unwrap_or_default(),
            });
        }
        self.snapshot_text_step();
        if let Some(e) = &self.install_text_sources.error {
            Check::Failed(e.clone())
        } else if self.install_text_sources.job.is_none()
            && self.install_text_sources.queue.is_empty()
        {
            Check::Ready
        } else {
            Check::Pending
        }
    }
    pub(crate) fn snapshot_text_wait_key(&mut self) {
        if let Some(j) = self.install_text_sources.job.take() {
            self.install_text_sources.queue.push_front(j.row);
        }
        self.install_text_sources.error = None;
        self.install_text_sources.delay = Some(
            self.now().saturating_add(
                i64::try_from(self.tuning.retry_ms)
                    .unwrap_or(1000)
                    .max(1000),
            ),
        );
        self.install_retry = true;
    }
    pub(crate) fn snapshot_text_step(&mut self) {
        if self.apply_fault || self.install.is_none() || self.install_text_sources.error.is_some() {
            return;
        }
        if self.install_text_sources.job.is_none() {
            if let Some(row) = self.install_text_sources.queue.pop_front() {
                let ok = crate::crypto::blob::validate_blob_ref(&row.blob).is_ok()
                    && row.blob.size <= 1048576
                    && row.blob.id_epoch >= 1
                    && row.blob.id_epoch <= self.install_epoch;
                if !ok {
                    self.install_text_sources.error =
                        Some(StreamError::Corrupt("snapshot text descriptor bounds"));
                    return;
                }
                let Some(addresses) = self.sealer.blob_part_addresses(&row.blob) else {
                    self.install_text_sources.queue.push_front(row);
                    self.install_text_sources.error = Some(StreamError::NoKey);
                    return;
                };
                if addresses.is_empty()
                    || addresses
                        .iter()
                        .any(|h| !self.install_refs.as_ref().is_some_and(|r| r.contains(h)))
                {
                    self.install_text_sources.error =
                        Some(StreamError::Corrupt("snapshot text closure incomplete"));
                    return;
                }
                match FileSourceReader::new(
                    &*self.sealer,
                    FileContent::Blob(row.blob.clone()),
                    1048576,
                ) {
                    Ok(reader) => {
                        self.install_text_sources.job = Some(Job {
                            row,
                            reader,
                            call: None,
                            retry_at: None,
                        })
                    }
                    Err(e) => {
                        self.install_text_sources.queue.push_front(row);
                        self.install_text_sources.error = Some(e);
                    }
                }
            } else {
                return;
            }
        }
        let Some(mut j) = self.install_text_sources.job.take() else {
            return;
        };
        if j.call.is_some() || j.retry_at.is_some_and(|t| self.now() < t) {
            self.install_text_sources.job = Some(j);
            return;
        }
        j.retry_at = None;
        match j.reader.need() {
            Ok(Some(SourceNeed::BlobPart {
                address, max_bytes, ..
            })) => {
                let id = self.queue(LogRequest::GetObject {
                    collection: self.cfg.collection,
                    address,
                    range: Some((0, max_bytes)),
                });
                self.inflight
                    .insert(id, super::append::Inflight::InstallText);
                j.call = Some(id);
            }
            _ => {
                self.install_text_sources.error =
                    Some(StreamError::Protocol("snapshot text reader need"))
            }
        };
        self.install_text_sources.job = Some(j);
    }
    pub(crate) fn on_snapshot_text_reply(&mut self, id: CallId, reply: LogReply) {
        let Some(mut j) = self.install_text_sources.job.take() else {
            return;
        };
        if j.call != Some(id) {
            self.install_text_sources.job = Some(j);
            return;
        }
        j.call = None;
        if self.install.is_none()
            || self.install_text_sources.context.as_ref().is_none_or(|c| {
                c.predecessor != self.head
                    || c.generation != self.store_generation
                    || c.control != self.policy.ctl_chain
                    || self.install_refs.as_ref() != Some(&c.refs)
            })
        {
            self.install_text_sources.error =
                Some(StreamError::Protocol("snapshot text context changed"));
            self.install_retry = true;
            return;
        }
        let result = match reply {
            Ok(LogResponse::GetObject { bytes, size, .. }) if size == bytes.len() as u64 => {
                match j.reader.need() {
                    Ok(Some(need)) => Some(j.reader.supply(&*self.sealer, need, &bytes)),
                    _ => Some(Err(StreamError::Protocol("snapshot text reader need"))),
                }
            }
            Ok(LogResponse::GetObject { .. }) => {
                Some(Err(StreamError::Corrupt("incomplete snapshot text object")))
            }
            _ => None,
        };
        match result {
            None => {
                j.retry_at = Some(
                    self.now().saturating_add(
                        i64::try_from(self.tuning.retry_ms)
                            .unwrap_or(1000)
                            .max(1000),
                    ),
                )
            }
            Some(Err(e)) => self.install_text_sources.error = Some(e),
            Some(Ok(())) => {
                if matches!(j.reader.need(), Ok(None)) {
                    match j.reader.finish() {
                        Ok(proof) => match std::str::from_utf8(proof.bytes()) {
                            Ok(doc) => {
                                if let Err(e) = self.stage_snapshot_text(
                                    j.row.id,
                                    j.row.path,
                                    j.row.modified_seq,
                                    doc,
                                ) {
                                    self.install_text_sources.error = Some(StreamError::Sink(e));
                                }
                            }
                            Err(_) => {
                                self.install_text_sources.error =
                                    Some(StreamError::Corrupt("snapshot text invalid UTF8"))
                            }
                        },
                        Err(e) => self.install_text_sources.error = Some(e),
                    }
                    self.install_retry = true;
                    return;
                }
            }
        }
        self.install_text_sources.job = Some(j);
        self.install_retry = true;
    }
}
