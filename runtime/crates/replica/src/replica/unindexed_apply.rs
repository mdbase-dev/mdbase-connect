//! Actor-held bounded source authentication before T6b metadata/confirmation.
//! At most one encrypted object in flight; no plaintext staging/publication here.
use super::{Replica, UnindexedSourceError, UnindexedSourceNeed, UnindexedSourceReader};
use crate::{
    attachments::{Need, PlainSink, StreamError},
    log::{CallId, LogReply, LogRequest, LogResponse},
    store::{Head, MetaPut, Store},
};
use mdbn_wire::{attachment::FileContent, attachment_runtime_v1 as rt, common::Hash};
use std::collections::{BTreeSet, VecDeque};

#[derive(Default)]
pub(crate) struct Sources {
    job: Option<Job>,
}
struct Job {
    head: Head,
    predecessor: Head,
    generation: u64,
    refs: Option<BTreeSet<Hash>>,
    invalid_refs: bool,
    queue: VecDeque<FileContent>,
    current: Option<(FileContent, UnindexedSourceReader)>,
    call: Option<CallId>,
    retry_at: Option<i64>,
    inventory: Vec<MetaPut>,
    cache: super::unindexed_cache::Cache,
    ready: Option<Result<bool, StreamError>>,
}
/// Complete proof decision; invalid UTF8 is deterministic only after full SHA/count.
pub(crate) enum Check {
    Pending,
    Ready(Vec<MetaPut>),
    InvalidUtf8,
    InvalidRefs,
    Failed(StreamError),
    StoreFailed(crate::store::StoreError),
}
struct Discard;
impl PlainSink for Discard {
    fn write(&mut self, _: u64, _: &[u8]) -> Result<(), String> {
        Ok(())
    }
}
impl Sources {
    pub(crate) fn pending(&self) -> bool {
        self.job.as_ref().is_some_and(|j| j.ready.is_none())
    }
    pub(crate) fn next_wakeup(&self) -> Option<i64> {
        self.job.as_ref()?.retry_at
    }
}
pub(crate) fn contains_native(p: &rt::EntryPayload) -> bool {
    p.mutation.ops.iter().any(|o| {
        matches!(
            o,
            rt::Op::UnindexedMarkdownPut(_)
                | rt::Op::RecordToUnindexedMarkdown(_)
                | rt::Op::UnindexedMarkdownToRecord(_)
        )
    }) || p.effects.iter().any(|e| {
        matches!(
            e,
            rt::Effect::PutUnindexedMarkdown(_) | rt::Effect::ReindexUnindexedMarkdown(_)
        )
    }) || p.conflicts.iter().flatten().any(|c| {
        [Some(&c.kept), Some(&c.lost), c.base.as_ref()]
            .into_iter()
            .flatten()
            .any(|v| matches!(v, rt::ConflictValue::UnindexedMarkdown(_)))
    })
}
fn descriptors(p: &rt::EntryPayload) -> VecDeque<FileContent> {
    let mut out = VecDeque::new();
    let mut add = |c: &FileContent| {
        if !out.contains(c) {
            out.push_back(c.clone());
        }
    };
    for op in &p.mutation.ops {
        match op {
            rt::Op::UnindexedMarkdownPut(f) => add(&f.payload.content),
            rt::Op::RecordToUnindexedMarkdown(f) if p.resurrect.is_none() => {
                add(&f.payload.content)
            }
            _ => {}
        }
    }
    for e in &p.effects {
        if let rt::Effect::PutUnindexedMarkdown(f) = e {
            add(&f.payload.content);
        }
    }
    for c in p.conflicts.iter().flatten() {
        for v in [Some(&c.kept), Some(&c.lost), c.base.as_ref()]
            .into_iter()
            .flatten()
        {
            if let rt::ConflictValue::UnindexedMarkdown(f) = v {
                add(&f.content);
            }
        }
    }
    out
}
fn refs_cover(refs: Option<&BTreeSet<Hash>>, addresses: &[Hash]) -> bool {
    addresses.is_empty() || refs.is_some_and(|refs| addresses.iter().all(|a| refs.contains(a)))
}
impl<S: Store> Replica<S> {
    pub(crate) fn unindexed_source_check(
        &mut self,
        head: Head,
        p: &rt::EntryPayload,
        refs: Option<&[Hash]>,
    ) -> Check {
        let refs = refs.map(|refs| refs.iter().copied().collect::<BTreeSet<_>>());
        let replace = self.unindexed_sources.job.as_ref().is_none_or(|j| {
            j.head != head
                || j.predecessor != self.head
                || j.generation != self.store_generation
                || j.refs != refs
        });
        if replace {
            let raw = match self.store.meta(super::unindexed_cache::KEY) {
                Ok(v) => v,
                Err(e) => return Check::StoreFailed(e),
            };
            let mut cache = super::unindexed_cache::Cache::load(raw.as_deref());
            let mut queue = VecDeque::new();
            for c in descriptors(p) {
                // Byte proofs do not establish the signed entry's complete refs closure.
                // Validate closure before even considering a cached plaintext proof.
                let addresses = match &c {
                    FileContent::Blob(b) => match self.sealer.blob_part_addresses(b) {
                        Some(addresses) => Some(addresses),
                        None => return Check::Failed(StreamError::NoKey),
                    },
                    FileContent::AttachmentV1(a) => {
                        if !refs_cover(refs.as_ref(), &[a.reference.manifest_cipher_hash]) {
                            return Check::InvalidRefs;
                        }
                        match self.attachment_inventory(&a.reference.manifest_cipher_hash) {
                            Ok(addresses) => addresses,
                            Err(e) => return Check::StoreFailed(e),
                        }
                    }
                    _ => return Check::Failed(StreamError::Protocol("native source profile")),
                };
                if let Some(addresses) = addresses {
                    if !refs_cover(refs.as_ref(), &addresses) {
                        return Check::InvalidRefs;
                    }
                    if cache.hit(&c) {
                        continue;
                    }
                }
                // An attachment without inventory must authenticate its manifest, even
                // with a byte-proof hit, to establish every required chunk address.
                queue.push_back(c);
            }
            self.unindexed_sources.job = Some(Job {
                head,
                predecessor: self.head,
                generation: self.store_generation,
                refs,
                invalid_refs: false,
                queue,
                cache,
                current: None,
                call: None,
                retry_at: None,
                inventory: Vec::new(),
                ready: None,
            });
        }
        self.unindexed_source_step();
        let Some(j) = self.unindexed_sources.job.as_ref() else {
            return Check::Pending;
        };
        if j.invalid_refs {
            return Check::InvalidRefs;
        }
        match &j.ready {
            None => Check::Pending,
            Some(Ok(false)) => {
                let mut meta = j.inventory.clone();
                meta.push(j.cache.metadata());
                Check::Ready(meta)
            }
            Some(Ok(true)) => Check::InvalidUtf8,
            Some(Err(e)) => {
                let e = e.clone();
                // A key wait can retry from byte0 after the normal key-wait probe.
                if e == StreamError::NoKey {
                    self.unindexed_sources.job = None;
                }
                Check::Failed(e)
            }
        }
    }
    pub(crate) fn unindexed_source_retry(&mut self, head: Head, p: &rt::EntryPayload) {
        let retry = self.now().saturating_add(
            i64::try_from(self.tuning.retry_ms)
                .unwrap_or(1000)
                .max(1000),
        );
        if let Some(j) = self
            .unindexed_sources
            .job
            .as_mut()
            .filter(|j| j.head == head)
        {
            j.queue = descriptors(p);
            j.current = None;
            j.inventory.clear();
            j.ready = None;
            j.retry_at = Some(retry);
        }
    }
    pub(crate) fn unindexed_source_step(&mut self) {
        if self.local_only() {
            self.unindexed_sources.job = None;
            return;
        }
        // Verified fallback replays the service history, including native entries
        // that require full-source authentication before confirmation. Other
        // repair phases still prohibit reads; no capture/output is enabled.
        if self.apply_fault
            || self.install.is_some()
            || (self.repairing() && !self.rolling_back())
            || self.hosted_blocked()
        {
            return;
        }
        let Some(mut job) = self.unindexed_sources.job.take() else {
            return;
        };
        if job.ready.is_some() || job.call.is_some() || job.retry_at.is_some_and(|t| self.now() < t)
        {
            self.unindexed_sources.job = Some(job);
            return;
        }
        if job.head.seq != self.head.seq + 1
            || job.predecessor != self.head
            || job.generation != self.store_generation
        {
            // Never reuse a proof against another durable predecessor/lifecycle.
            return;
        }
        job.retry_at = None;
        if job.current.is_none() {
            if let Some(content) = job.queue.pop_front() {
                match UnindexedSourceReader::new(
                    &*self.sealer,
                    content.clone(),
                    self.cfg.collection,
                ) {
                    Ok(r) => job.current = Some((content, r)),
                    Err(e) => job.ready = Some(Err(e)),
                }
            } else {
                job.ready = Some(Ok(false));
            }
        }
        if let Some((_, r)) = &job.current {
            if let Some(need) = r.need() {
                let (address, limit) = match need {
                    UnindexedSourceNeed::Blob {
                        address,
                        max_sealed_bytes,
                        ..
                    } => (address, max_sealed_bytes),
                    UnindexedSourceNeed::Attachment(Need::Manifest { address }) => {
                        (address, crate::attachments::MAX_SEALED_MANIFEST)
                    }
                    UnindexedSourceNeed::Attachment(Need::Chunk {
                        address,
                        sealed_bytes,
                        ..
                    }) => (address, sealed_bytes),
                };
                // A bounded transport request is not a plaintext-range proof:
                // supply below requires the entire sealed object, then full SHA/count.
                let call = self.queue(LogRequest::GetObject {
                    collection: self.cfg.collection,
                    address,
                    range: Some((0, limit)),
                });
                self.inflight
                    .insert(call, super::append::Inflight::UnindexedSource(job.head));
                job.call = Some(call);
            } else {
                job.ready = Some(Err(StreamError::Protocol(
                    "source reader unexpectedly complete",
                )));
            }
        }
        self.unindexed_sources.job = Some(job);
    }
    pub(crate) fn on_unindexed_source_reply(&mut self, head: Head, id: CallId, reply: LogReply) {
        let Some(mut job) = self.unindexed_sources.job.take() else {
            return;
        };
        if job.head != head
            || job.call != Some(id)
            || job.predecessor != self.head
            || job.generation != self.store_generation
        {
            self.unindexed_sources.job = Some(job);
            return;
        }
        job.call = None;
        let result = match reply {
            Ok(LogResponse::GetObject { bytes, size, .. }) if size == bytes.len() as u64 => {
                let Some((content, r)) = job.current.as_mut() else {
                    return;
                };
                let need = r.need();
                let result = r.supply(&*self.sealer, &bytes, &mut Discard);
                if result.is_ok()
                    && matches!(
                        need,
                        Some(UnindexedSourceNeed::Attachment(Need::Manifest { .. }))
                    )
                    && let FileContent::AttachmentV1(a) = content
                {
                    let (d, e) = super::attachment_fetch::descriptor(a);
                    match self.sealer.open_attachment_manifest(
                        &d,
                        e,
                        &bytes,
                        crate::crypto::chunked_blob::AttachmentLimits::default(),
                    ) {
                        Ok(m) => {
                            let addresses = m
                                .manifest()
                                .chunks
                                .iter()
                                .map(|c| c.cipher_hash)
                                .collect::<Vec<_>>();
                            if !refs_cover(job.refs.as_ref(), &addresses) {
                                job.invalid_refs = true;
                                job.ready = Some(Err(StreamError::Protocol("native source refs")));
                            } else {
                                job.inventory
                                    .push(super::attachment_inventory::inventory_meta(
                                        d.manifest_cipher_hash,
                                        &m.manifest().chunks,
                                    ));
                            }
                        }
                        Err(crate::seal::OpenError::NoKey) => {
                            job.ready = Some(Err(StreamError::NoKey))
                        }
                        Err(crate::seal::OpenError::Aead) => {
                            job.ready = Some(Err(StreamError::Corrupt("source inventory")))
                        }
                    }
                }
                Some(result)
            }
            Ok(LogResponse::GetObject { .. }) => {
                Some(Err(StreamError::Corrupt("incomplete sealed source object")))
            }
            // Missing objects/offline are retriable and never confirm a prefix.
            _ => None,
        };
        match result {
            Some(Err(e)) => job.ready = Some(Err(e)),
            None => {
                job.retry_at = Some(
                    self.now()
                        .saturating_add(i64::try_from(self.tuning.retry_ms).unwrap_or(1000)),
                )
            }
            Some(Ok(())) => {
                if job.ready.is_none()
                    && job
                        .current
                        .as_ref()
                        .is_some_and(|(_, r)| r.need().is_none())
                {
                    if let Some((_, reader)) = job.current.take() {
                        match reader.finish() {
                            Ok(proof) => job.cache.verified(&proof),
                            Err(UnindexedSourceError::InvalidUtf8) => job.ready = Some(Ok(true)),
                            Err(UnindexedSourceError::Read(e)) => job.ready = Some(Err(e)),
                        }
                    }
                    if job.current.is_none() && job.queue.is_empty() && job.ready.is_none() {
                        job.ready = Some(Ok(false));
                    }
                }
            }
        }
        let ready = job.ready.is_some();
        self.unindexed_sources.job = Some(job);
        if ready {
            self.request_read();
        } else {
            self.unindexed_source_step();
        }
    }
}
#[cfg(test)]
mod refs_tests {
    use super::*;
    #[test]
    fn complete_declared_set_is_required_and_empty_closure_is_valid() {
        let a = mdbn_wire::common::B32([1; 32]);
        let b = mdbn_wire::common::B32([2; 32]);
        assert!(refs_cover(None, &[]));
        assert!(!refs_cover(None, &[a]));
        assert!(!refs_cover(Some(&BTreeSet::from([a])), &[a, b]));
        assert!(refs_cover(Some(&BTreeSet::from([a, b])), &[a, b]));
    }
}
