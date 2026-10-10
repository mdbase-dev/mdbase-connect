//! Complete private streaming native source authentication before snapshot swap.
use super::{Replica, UnindexedSourceError, UnindexedSourceNeed, UnindexedSourceReader};
use crate::{
    attachments::{Need, PlainSink, StreamError},
    log::{CallId, LogReply, LogRequest, LogResponse},
    store::{Head, MetaPut, Store},
};
use mdbn_wire::{attachment::FileContent, attachment_runtime_v1::ManifestPayload, common::Hash};
use std::collections::{BTreeSet, VecDeque};
#[derive(Default)]
pub(crate) struct Auth {
    job: Option<Job>,
    delay: Option<i64>,
}
struct Job {
    target: Head,
    digest: Hash,
    predecessor: Head,
    generation: u64,
    control: Hash,
    queue: VecDeque<FileContent>,
    current: Option<(FileContent, UnindexedSourceReader)>,
    call: Option<CallId>,
    retry_at: Option<i64>,
    refs: BTreeSet<Hash>,
    meta: Vec<MetaPut>,
    cache: super::unindexed_cache::Cache,
    ready: Option<Result<(), StreamError>>,
}
pub(crate) enum Check {
    Pending,
    Ready(Vec<MetaPut>),
    Failed(StreamError),
    StoreFailed(crate::store::StoreError),
}
struct Discard;
impl PlainSink for Discard {
    fn write(&mut self, _: u64, _: &[u8]) -> Result<(), String> {
        Ok(())
    }
}
impl Auth {
    pub(crate) fn next_wakeup(&self) -> Option<i64> {
        self.delay
            .or_else(|| self.job.as_ref().and_then(|j| j.retry_at))
    }
}
impl<S: Store> Replica<S> {
    pub(crate) fn native_install_check(&mut self, m: &ManifestPayload) -> Check {
        if self
            .install_native_auth
            .delay
            .is_some_and(|t| self.now() < t)
        {
            return Check::Pending;
        }
        self.install_native_auth.delay = None;
        let target = Head {
            seq: m.seq,
            chain: m.chain,
        };
        if self.install_native_auth.job.as_ref().is_some_and(|j| {
            j.target != target
                || j.digest != m.state_digest
                || j.predecessor != self.head
                || j.generation != self.store_generation
                || j.control != self.policy.ctl_chain
                || self.install_refs.as_ref() != Some(&j.refs)
        }) {
            return Check::Failed(StreamError::Protocol("snapshot source context changed"));
        }
        if self.install_native_auth.job.is_none() {
            let raw = match self.store.meta(super::unindexed_cache::KEY) {
                Ok(r) => r,
                Err(e) => return Check::StoreFailed(e),
            };
            self.install_native_auth.job = Some(Job {
                target,
                digest: m.state_digest,
                predecessor: self.head,
                generation: self.store_generation,
                control: self.policy.ctl_chain,
                queue: self.install_native_roots.descriptors().cloned().collect(),
                current: None,
                call: None,
                retry_at: None,
                refs: self.install_refs.clone().unwrap_or_default(),
                meta: Vec::new(),
                cache: super::unindexed_cache::Cache::load(raw.as_deref()),
                ready: None,
            });
        }
        self.native_install_step();
        let Some(j) = &self.install_native_auth.job else {
            return Check::Pending;
        };
        match &j.ready {
            None => Check::Pending,
            Some(Ok(())) => {
                let mut meta = j.meta.clone();
                if self.install_native_roots.descriptors().next().is_some() {
                    meta.push(j.cache.metadata())
                }
                Check::Ready(meta)
            }
            Some(Err(e)) => Check::Failed(e.clone()),
        }
    }
    pub(crate) fn native_install_wait_key(&mut self) {
        let t = self.now().saturating_add(
            i64::try_from(self.tuning.retry_ms)
                .unwrap_or(1000)
                .max(1000),
        );
        self.install_native_auth = Auth {
            job: None,
            delay: Some(t),
        };
        self.install_retry = true;
    }
    pub(crate) fn native_install_step(&mut self) {
        if self.apply_fault || self.install.is_none() {
            return;
        }
        let Some(mut j) = self.install_native_auth.job.take() else {
            return;
        };
        if j.ready.is_some() || j.call.is_some() || j.retry_at.is_some_and(|t| self.now() < t) {
            self.install_native_auth.job = Some(j);
            return;
        }
        j.retry_at = None;
        if j.predecessor != self.head
            || j.generation != self.store_generation
            || j.control != self.policy.ctl_chain
        {
            j.ready = Some(Err(StreamError::Protocol(
                "snapshot source context changed",
            )));
        }
        if j.ready.is_none() && j.current.is_none() {
            if let Some(c) = j.queue.pop_front() {
                let addresses = match &c {
                    FileContent::Blob(b) => self.sealer.blob_part_addresses(b),
                    FileContent::AttachmentV1(a) => Some(vec![a.reference.manifest_cipher_hash]),
                    _ => Some(Vec::new()),
                };
                match addresses {
                    Some(a) if !a.is_empty() && a.iter().all(|h| j.refs.contains(h)) => {
                        match UnindexedSourceReader::new(
                            &*self.sealer,
                            c.clone(),
                            self.cfg.collection,
                        ) {
                            Ok(r) => j.current = Some((c, r)),
                            Err(e) => j.ready = Some(Err(e)),
                        }
                    }
                    Some(_) => {
                        j.ready = Some(Err(StreamError::Corrupt(
                            "snapshot native closure missing from refs",
                        )))
                    }
                    None => j.ready = Some(Err(StreamError::NoKey)),
                }
            } else {
                j.ready = Some(Ok(()));
            }
        }
        if j.ready.is_none()
            && let Some((_, r)) = &j.current
        {
            if let Some(need) = r.need() {
                let (address, max) = match need {
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
                if !j.refs.contains(&address) {
                    j.ready = Some(Err(StreamError::Corrupt(
                        "snapshot native object not rooted",
                    )))
                } else {
                    let id = self.queue(LogRequest::GetObject {
                        collection: self.cfg.collection,
                        address,
                        range: Some((0, max)),
                    });
                    self.inflight
                        .insert(id, super::append::Inflight::InstallNative);
                    j.call = Some(id);
                }
            } else {
                j.ready = Some(Err(StreamError::Protocol(
                    "snapshot source reader unexpectedly complete",
                )));
            }
        }
        self.install_native_auth.job = Some(j);
    }
    pub(crate) fn on_native_install_reply(&mut self, id: CallId, reply: LogReply) {
        let Some(mut j) = self.install_native_auth.job.take() else {
            return;
        };
        if j.call != Some(id) {
            self.install_native_auth.job = Some(j);
            return;
        }
        j.call = None;
        if self.install.is_none()
            || j.predecessor != self.head
            || j.generation != self.store_generation
            || j.control != self.policy.ctl_chain
        {
            j.ready = Some(Err(StreamError::Protocol(
                "snapshot source context changed",
            )));
            self.install_native_auth.job = Some(j);
            self.install_retry = true;
            return;
        }
        let result = match reply {
            Ok(LogResponse::GetObject { bytes, size, .. }) if size == bytes.len() as u64 => {
                let Some((c, r)) = j.current.as_mut() else {
                    return;
                };
                let need = r.need();
                let result = r.supply(&*self.sealer, &bytes, &mut Discard);
                if result.is_ok()
                    && matches!(
                        need,
                        Some(UnindexedSourceNeed::Attachment(Need::Manifest { .. }))
                    )
                    && let FileContent::AttachmentV1(a) = c
                {
                    let (d, e) = super::attachment_fetch::descriptor(a);
                    match self.sealer.open_attachment_manifest(
                        &d,
                        e,
                        &bytes,
                        crate::crypto::chunked_blob::AttachmentLimits::default(),
                    ) {
                        Ok(m) => {
                            if m.manifest()
                                .chunks
                                .iter()
                                .any(|c| !j.refs.contains(&c.cipher_hash))
                            {
                                j.ready = Some(Err(StreamError::Corrupt(
                                    "snapshot attachment closure incomplete",
                                )));
                            } else {
                                j.meta.push(super::attachment_inventory::inventory_meta(
                                    d.manifest_cipher_hash,
                                    &m.manifest().chunks,
                                ));
                            }
                        }
                        Err(crate::seal::OpenError::NoKey) => {
                            j.ready = Some(Err(StreamError::NoKey))
                        }
                        Err(_) => {
                            j.ready = Some(Err(StreamError::Corrupt("snapshot source manifest")))
                        }
                    }
                }
                Some(result)
            }
            Ok(LogResponse::GetObject { .. }) => Some(Err(StreamError::Corrupt(
                "incomplete snapshot native object",
            ))),
            _ => None,
        };
        match result {
            Some(Err(e)) => j.ready = Some(Err(e)),
            None => {
                j.retry_at = Some(
                    self.now().saturating_add(
                        i64::try_from(self.tuning.retry_ms)
                            .unwrap_or(1000)
                            .max(1000),
                    ),
                )
            }
            Some(Ok(())) => {
                if j.ready.is_none()
                    && j.current.as_ref().is_some_and(|(_, r)| r.need().is_none())
                    && let Some((_, r)) = j.current.take()
                {
                    match r.finish() {
                        Ok(p) => j.cache.verified(&p),
                        Err(UnindexedSourceError::InvalidUtf8) => {
                            j.ready = Some(Err(StreamError::Corrupt(
                                "snapshot native source invalid UTF8",
                            )))
                        }
                        Err(UnindexedSourceError::Read(e)) => j.ready = Some(Err(e)),
                    }
                }
            }
        }
        self.install_native_auth.job = Some(j);
        self.install_retry = true;
    }
}
