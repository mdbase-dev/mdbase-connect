//! Actor-held <=1MiB Blob text hydration for critical reverse16 only.
use super::Replica;
use crate::{
    attachments::StreamError,
    file_source::{FileSourceReader, SourceNeed},
    log::{CallId, LogReply, LogRequest, LogResponse},
    store::{Head, Store},
};
use mdbn_wire::{
    attachment::FileContent,
    attachment_runtime_v1 as rt,
    common::{Hash, Text},
    entry::{TextDef, TextDefForm},
    intent::BlobRef,
};
use zeroize::Zeroizing;
#[derive(Default)]
pub(crate) struct Sources {
    job: Option<Job>,
}
struct Job {
    head: Head,
    predecessor: Head,
    generation: u64,
    descriptor: BlobRef,
    reader: Option<FileSourceReader>,
    call: Option<CallId>,
    retry_at: Option<i64>,
    ready: Option<Result<Option<Zeroizing<String>>, StreamError>>,
}
pub(crate) enum Check {
    Legacy,
    Pending,
    Ready(Vec<Option<String>>),
    InvalidUtf8,
    InvalidShape,
    Failed(StreamError),
}
impl Sources {
    pub(crate) fn pending(&self) -> bool {
        self.job.as_ref().is_some_and(|j| j.ready.is_none())
    }
    pub(crate) fn next_wakeup(&self) -> Option<i64> {
        self.job.as_ref()?.retry_at
    }
}
fn blob(p: &rt::EntryPayload) -> Result<Option<BlobRef>, ()> {
    let texts = p.texts.as_deref().unwrap_or_default();
    if !texts
        .iter()
        .any(|t| matches!(t, TextDef::Form(TextDefForm::Blob(_))))
    {
        return Ok(None);
    }
    let [rt::Op::UnindexedMarkdownToRecord(op)] = p.mutation.ops.as_slice() else {
        return Err(());
    };
    let [TextDef::Form(TextDefForm::Blob(t))] = texts else {
        return Err(());
    };
    if op.doc != Text::Index(0) || t.blob.size > 1048576 {
        return Err(());
    }
    Ok(Some(t.blob.clone()))
}
impl<S: Store> Replica<S> {
    pub(crate) fn reverse_text_check(
        &mut self,
        head: Head,
        p: &rt::EntryPayload,
        refs: Option<&[Hash]>,
    ) -> Check {
        let d = match blob(p) {
            Ok(None) => return Check::Legacy,
            Err(()) => return Check::InvalidShape,
            Ok(Some(d)) => d,
        };
        if d.id_epoch > self.policy.epoch || crate::crypto::blob::validate_blob_ref(&d).is_err() {
            return Check::InvalidShape;
        }
        let addresses = match self.sealer.blob_part_addresses(&d) {
            Some(a) => a,
            None => return Check::Failed(StreamError::NoKey),
        };
        if addresses.is_empty()
            || !addresses
                .iter()
                .all(|a| refs.is_some_and(|r| r.contains(a)))
        {
            return Check::InvalidShape;
        }
        if self.reverse_text_sources.job.as_ref().is_none_or(|j| {
            j.head != head
                || j.predecessor != self.head
                || j.generation != self.store_generation
                || j.descriptor != d
        }) {
            let reader =
                match FileSourceReader::new(&*self.sealer, FileContent::Blob(d.clone()), 1048576) {
                    Ok(r) => r,
                    Err(e) => return Check::Failed(e),
                };
            self.reverse_text_sources.job = Some(Job {
                head,
                predecessor: self.head,
                generation: self.store_generation,
                descriptor: d,
                reader: Some(reader),
                call: None,
                retry_at: None,
                ready: None,
            });
        }
        self.reverse_text_step();
        let Some(j) = self.reverse_text_sources.job.as_ref() else {
            return Check::Pending;
        };
        match &j.ready {
            None => Check::Pending,
            Some(Ok(Some(s))) => Check::Ready(vec![Some(s.to_string())]),
            Some(Ok(None)) => Check::InvalidUtf8,
            Some(Err(e)) => {
                let e = e.clone();
                if e == StreamError::NoKey {
                    self.reverse_text_sources.job = None;
                }
                Check::Failed(e)
            }
        }
    }
    pub(crate) fn reverse_text_retry(&mut self, head: Head) {
        let retry = self.now().saturating_add(
            i64::try_from(self.tuning.retry_ms)
                .unwrap_or(1000)
                .max(1000),
        );
        if let Some(j) = self
            .reverse_text_sources
            .job
            .as_mut()
            .filter(|j| j.head == head)
        {
            j.reader = None;
            j.call = None;
            j.ready = None;
            j.retry_at = Some(retry);
        }
    }
    pub(crate) fn reverse_text_step(&mut self) {
        if self.local_only()
            || self.apply_fault
            || self.install.is_some()
            || (self.repairing() && !self.rolling_back())
            || self.hosted_blocked()
        {
            return;
        }
        let Some(mut j) = self.reverse_text_sources.job.take() else {
            return;
        };
        if j.head.seq != self.head.seq + 1
            || j.predecessor != self.head
            || j.generation != self.store_generation
        {
            return;
        }
        if j.ready.is_some() || j.call.is_some() || j.retry_at.is_some_and(|t| self.now() < t) {
            self.reverse_text_sources.job = Some(j);
            return;
        }
        j.retry_at = None;
        if j.reader.is_none() {
            match FileSourceReader::new(
                &*self.sealer,
                FileContent::Blob(j.descriptor.clone()),
                1048576,
            ) {
                Ok(r) => j.reader = Some(r),
                Err(e) => j.ready = Some(Err(e)),
            }
        }
        if let Some(r) = &j.reader {
            match r.need() {
                Ok(Some(SourceNeed::BlobPart {
                    address, max_bytes, ..
                })) => {
                    let call = self.queue(LogRequest::GetObject {
                        collection: self.cfg.collection,
                        address,
                        range: Some((0, max_bytes)),
                    });
                    self.inflight
                        .insert(call, super::append::Inflight::UnindexedReverseText(j.head));
                    j.call = Some(call);
                }
                Ok(_) => j.ready = Some(Err(StreamError::Protocol("reverse text source kind"))),
                Err(e) => j.ready = Some(Err(e)),
            }
        }
        self.reverse_text_sources.job = Some(j);
    }
    pub(crate) fn on_reverse_text_reply(&mut self, head: Head, id: CallId, reply: LogReply) {
        let Some(mut j) = self.reverse_text_sources.job.take() else {
            return;
        };
        if j.head != head
            || j.call != Some(id)
            || j.predecessor != self.head
            || j.generation != self.store_generation
        {
            self.reverse_text_sources.job = Some(j);
            return;
        }
        j.call = None;
        let result = match reply {
            Ok(LogResponse::GetObject { bytes, size, .. }) if size == bytes.len() as u64 => {
                let Some(r) = j.reader.as_mut() else { return };
                match r.need() {
                    Ok(Some(need)) => Some(r.supply(&*self.sealer, need, &bytes)),
                    _ => Some(Err(StreamError::Protocol("reverse text reader need"))),
                }
            }
            Ok(LogResponse::GetObject { .. }) => {
                Some(Err(StreamError::Corrupt("incomplete reverse text object")))
            }
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
                if j.reader
                    .as_ref()
                    .is_some_and(|r| matches!(r.need(), Ok(None)))
                {
                    let r = j.reader.take().expect("checked reader");
                    j.ready = Some(r.finish().map(|proof| {
                        std::str::from_utf8(proof.bytes())
                            .ok()
                            .map(|s| Zeroizing::new(s.to_owned()))
                    }));
                }
            }
        }
        let ready = j.ready.is_some();
        self.reverse_text_sources.job = Some(j);
        if ready {
            self.request_read();
        } else {
            self.reverse_text_step();
        }
    }
}
