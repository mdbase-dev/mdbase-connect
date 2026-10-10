//! T6b bounded source proof and frozen capture target. Preparation is not emission:
//! the ordinary upload API still rejects record paths, and apply remains gated.
use super::{AttachmentSource, Replica};
use crate::{
    Store,
    api::{ApiResult, ErrorCode},
    crypto::chunked_blob::{AttachmentLimits, CHUNK_BYTES},
};
use mdbn_wire::{
    attachment::FileContent,
    attachment_runtime_v1 as rt,
    common::{B32, Hash, Uuid},
    hash::sha256,
    unindexed_markdown::{
        FileKindV1, RECORD_SOURCE_CAP_BYTES, RecordToUnindexedMarkdown, UnindexedMarkdownPayloadV1,
        UnindexedMarkdownPut,
    },
};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

/// Exact source holder captured before reading or uploading any object.
#[derive(Debug, Clone, PartialEq)]
pub enum UnindexedCaptureTarget {
    /// ID and path must both be absent; no retained lifecycle holder is reused.
    Create,
    /// Replace only the same unindexed kind/path under full-descriptor CAS.
    Replace(UnindexedMarkdownPayloadV1),
    /// Atomically transition the same live record ID/path under source CAS.
    Record(Hash),
}

/// Opaque preparation for a trusted device capture. Cannot be constructed from
/// client-declared metadata; complete UTF8 and every source range were verified.
pub struct PreparedUnindexedCapture {
    id: Uuid,
    path: String,
    target: UnindexedCaptureTarget,
    catalog: Hash,
    generation: u64,
    source: VerifiedSource,
}
impl PreparedUnindexedCapture {
    /// Exact complete source hash, not a host-declared revision.
    pub fn plain_hash(&self) -> Hash {
        self.source.hash
    }
    /// Exact verified full-source byte count.
    pub fn size(&self) -> u64 {
        self.source.total
    }
    /// Captured holder; full descriptor equality is mandatory at capture.
    pub fn target(&self) -> &UnindexedCaptureTarget {
        &self.target
    }
    /// Positional reads remain bound to the proven source, including retries.
    pub fn source_mut(&mut self) -> &mut dyn AttachmentSource {
        &mut self.source
    }
    /// Convert a writer's authenticated content to an operation only after its
    /// signed whole hash and length agree. This does not capture or append it.
    pub fn operation(&self, content: FileContent) -> ApiResult<rt::Op> {
        if content.size() != self.size() || content.plain_hash() != self.plain_hash() {
            return Err(ErrorCode::Conflict.err_with_reason(
                "source_changed",
                "signed descriptor does not bind the verified source",
            ));
        }
        let payload = UnindexedMarkdownPayloadV1 { content };
        Ok(match &self.target {
            UnindexedCaptureTarget::Create => rt::Op::UnindexedMarkdownPut(UnindexedMarkdownPut {
                id: self.id,
                path: self.path.clone(),
                payload,
                expected: None,
            }),
            UnindexedCaptureTarget::Replace(expected) => {
                rt::Op::UnindexedMarkdownPut(UnindexedMarkdownPut {
                    id: self.id,
                    path: self.path.clone(),
                    payload,
                    expected: Some(expected.clone()),
                })
            }
            UnindexedCaptureTarget::Record(prior_revision) => {
                rt::Op::RecordToUnindexedMarkdown(RecordToUnindexedMarkdown {
                    id: self.id,
                    path: self.path.clone(),
                    payload,
                    prior_revision: *prior_revision,
                })
            }
        })
    }
}

/// One hash per <=8MiB range (at most128), never the complete plaintext.
struct VerifiedSource {
    inner: Box<dyn AttachmentSource>,
    total: u64,
    hash: Hash,
    ranges: Vec<Hash>,
}
impl AttachmentSource for VerifiedSource {
    fn len(&self) -> u64 {
        self.total
    }
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<(), String> {
        let chunk = u64::from(CHUNK_BYTES);
        if self.inner.len() != self.total
            || offset >= self.total
            || !offset.is_multiple_of(chunk)
            || buf.len() as u64 != chunk.min(self.total - offset)
        {
            return Err("source length or range changed".into());
        }
        self.inner.read_at(offset, buf)?;
        let i = usize::try_from(offset / chunk).map_err(|_| "source range")?;
        if self.ranges.get(i) != Some(&sha256(buf)) {
            return Err("source bytes changed".into());
        }
        Ok(())
    }
}

/// Incremental UTF8 validation. Only an incomplete <=3-byte suffix crosses a
/// range boundary; no normalization, BOM stripping or source rewriting.
#[derive(Default)]
pub(super) struct Utf8 {
    suffix: Vec<u8>,
}
impl Utf8 {
    pub(super) fn push(&mut self, mut bytes: &[u8]) -> Result<(), ()> {
        if !self.suffix.is_empty() {
            loop {
                let Some((&b, rest)) = bytes.split_first() else {
                    return Ok(());
                };
                self.suffix.push(b);
                bytes = rest;
                match std::str::from_utf8(&self.suffix) {
                    Ok(_) => {
                        self.suffix.clear();
                        break;
                    }
                    Err(e) if e.error_len().is_some() || self.suffix.len() >= 4 => return Err(()),
                    Err(_) => {}
                }
            }
        }
        match std::str::from_utf8(bytes) {
            Ok(_) => Ok(()),
            Err(e) if e.error_len().is_none() => {
                self.suffix.extend_from_slice(&bytes[e.valid_up_to()..]);
                if self.suffix.len() > 3 {
                    Err(())
                } else {
                    Ok(())
                }
            }
            Err(_) => Err(()),
        }
    }
    pub(super) fn finish(&self) -> Result<(), ()> {
        if self.suffix.is_empty() {
            Ok(())
        } else {
            Err(())
        }
    }
}

fn verify(mut source: Box<dyn AttachmentSource>) -> ApiResult<VerifiedSource> {
    let total = source.len();
    if total <= RECORD_SOURCE_CAP_BYTES || total > AttachmentLimits::default().max_file_bytes {
        return Err(ErrorCode::InvalidRequest.err_with_reason(
            "unindexed_source_size",
            "unindexed source must exceed1MiB and fit the attachment cap",
        ));
    }
    let mut full = Sha256::new();
    let mut ranges = Vec::new();
    let mut utf8 = Utf8::default();
    let mut offset = 0;
    while offset < total {
        let len = u64::from(CHUNK_BYTES).min(total - offset);
        let mut bytes = Zeroizing::new(vec![
            0;
            usize::try_from(len).map_err(|_| {
                ErrorCode::TooLarge.err("source range")
            })?
        ]);
        if source.len() != total {
            return Err(
                ErrorCode::Conflict.err_with_reason("source_changed", "source length changed")
            );
        }
        source
            .read_at(offset, &mut bytes)
            .map_err(|e| ErrorCode::Conflict.err_with_reason("source_changed", e))?;
        utf8.push(&bytes).map_err(|()| {
            ErrorCode::InvalidRequest
                .err_with_reason("unindexed_source_utf8", "source is not valid UTF8")
        })?;
        full.update(&bytes);
        ranges.push(sha256(&bytes));
        offset += len;
    }
    utf8.finish().map_err(|()| {
        ErrorCode::InvalidRequest
            .err_with_reason("unindexed_source_utf8", "source ends in incomplete UTF8")
    })?;
    if source.len() != total {
        return Err(ErrorCode::Conflict.err_with_reason("source_changed", "source length changed"));
    }
    Ok(VerifiedSource {
        inner: source,
        total,
        hash: B32(full.finalize().into()),
        ranges,
    })
}

impl<S: Store> Replica<S> {
    pub(super) fn unindexed_capture_admission(&self, path: &str) -> ApiResult<()> {
        self.unindexed_admission(path, false)
    }
    /// Only the verified lost-tail requeue owns this exception: the retained
    /// 24-hour notification is not an active repair. All current key, authority,
    /// health and path gates still apply, and fresh capture stays unchanged.
    pub(super) fn unindexed_resurrect_admission(
        &self,
        mutation: &Uuid,
        path: &str,
    ) -> ApiResult<()> {
        if !self.resurrected.contains_key(mutation) {
            return Err(ErrorCode::Unavailable.err("native move is not verified recovery"));
        }
        self.unindexed_admission(path, true)
    }
    fn unindexed_admission(&self, path: &str, verified_recovery: bool) -> ApiResult<()> {
        if self.is_hosted() || self.local_only() {
            return Err(ErrorCode::UpgradeRequired.err_with_reason(
                "unindexed_capture_unsupported",
                "capture requires a synced editor device",
            ));
        }
        if !self.policy.device_can_write(&self.cfg.device_id) {
            return Err(ErrorCode::Forbidden.err("device cannot write"));
        }
        if self.key_untrusted
            || self.lost_control_pending()
            || (self.regressed_at.is_some() && !verified_recovery)
            || self.policy.frozen
            || self.policy.rekey_required
            || self.sealer.current_epoch() != Some(self.policy.epoch)
            || self.stalled.is_some()
            || self.repair.is_some()
            || self.install.is_some()
            || self.apply_fault
            || self.apply_blocked.is_some()
            || !self.caught_up
        {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "unindexed_capture_not_ready",
                "capture requires healthy current keyed state",
            ));
        }
        if mdbn_core::paths::check_path(path).is_err()
            || !self.catalog.is_record_path(path)
            || self.catalog.is_resource_path(path)
            || self.catalog.is_excluded(path)
        {
            return Err(ErrorCode::InvalidRequest.err_with_reason(
                "unindexed_capture_path",
                "capture requires a current record-extension path",
            ));
        }
        Ok(())
    }
    pub(super) fn unindexed_catalog_stamp(&self) -> ApiResult<Hash> {
        let mut resources = self.store.resources().map_err(super::submit::store_err)?;
        resources.sort();
        let mut h = Sha256::new();
        h.update(b"mdbase/v1/unindexed-capture-catalog");
        for (path, doc) in resources {
            h.update((path.len() as u64).to_be_bytes());
            h.update(path.as_bytes());
            h.update((doc.len() as u64).to_be_bytes());
            h.update(doc.as_bytes());
        }
        Ok(B32(h.finalize().into()))
    }
    pub(super) fn unindexed_target(
        &self,
        id: Uuid,
        path: &str,
    ) -> ApiResult<UnindexedCaptureTarget> {
        let err = || {
            ErrorCode::Conflict.err_with_reason(
                "unindexed_capture_holder",
                "capture holder, kind, path or full descriptor changed",
            )
        };
        let store_err = super::submit::store_err;
        let pk = mdbn_core::paths::path_key(path);
        let touches = [crate::plan::id_key(&id), format!("p:{pk}")];
        if self.pending_keys.values().any(|keys| {
            touches.iter().any(|k| keys.contains(k))
                || keys.iter().any(|k| k.starts_with("r:") || k == "s:")
        }) {
            return Err(err());
        }
        if self.store.tombstone(&id).map_err(store_err)?.is_some() {
            return Err(err());
        }
        let record = self.store.record(&id).map_err(store_err)?;
        let file = self.store.file(&id).map_err(store_err)?;
        match (record, file) {
            (Some(r), None)
                if r.path == path
                    && self.store.record_at(&pk).map_err(store_err)? == Some(id)
                    && self.store.file_at(&pk).map_err(store_err)?.is_none() =>
            {
                Ok(UnindexedCaptureTarget::Record(r.revision))
            }
            (None, Some(f))
                if f.path == path
                    && f.kind == FileKindV1::UnindexedOversizedMarkdown
                    && self.store.file_at(&pk).map_err(store_err)? == Some(id)
                    && self.store.record_at(&pk).map_err(store_err)?.is_none() =>
            {
                Ok(UnindexedCaptureTarget::Replace(
                    UnindexedMarkdownPayloadV1 { content: f.content },
                ))
            }
            (None, None)
                if self.store.record_at(&pk).map_err(store_err)?.is_none()
                    && self.store.file_at(&pk).map_err(store_err)?.is_none()
                    && self.store.tombstones_at(&pk).map_err(store_err)?.is_empty()
                    && self.store.alias(&pk).map_err(store_err)?.is_none() =>
            {
                Ok(UnindexedCaptureTarget::Create)
            }
            (None, Some(f)) if f.path == path && f.kind == FileKindV1::Ordinary => {
                Err(ErrorCode::UpgradeRequired.err_with_reason(
                    "ordinary_to_unindexed_unsupported",
                    "ordinary file remains ordinary; this kind transition is not supported",
                ))
            }
            _ => Err(err()),
        }
    }
    /// Explicit trusted import/capture preparation. Ordinary record requests are
    /// never redirected here. No object upload, pending row or observation ACK.
    pub fn prepare_unindexed_markdown_capture(
        &self,
        id: Uuid,
        path: String,
        source: Box<dyn AttachmentSource>,
    ) -> ApiResult<PreparedUnindexedCapture> {
        self.unindexed_capture_admission(&path)?;
        let target = self.unindexed_target(id, &path)?;
        let catalog = self.unindexed_catalog_stamp()?;
        let source = verify(source)?;
        let prepared = PreparedUnindexedCapture {
            id,
            path,
            target,
            catalog,
            generation: self.store_generation,
            source,
        };
        self.recheck_unindexed_markdown_capture(&prepared)?;
        Ok(prepared)
    }
    /// Recheck the frozen target/catalog/authority after awaits and before capture.
    pub fn recheck_unindexed_markdown_capture(
        &self,
        p: &PreparedUnindexedCapture,
    ) -> ApiResult<()> {
        self.unindexed_capture_admission(&p.path)?;
        if p.generation != self.store_generation
            || self.unindexed_catalog_stamp()? != p.catalog
            || self.unindexed_target(p.id, &p.path)? != p.target
        {
            return Err(ErrorCode::Conflict
                .err_with_reason("unindexed_capture_changed", "capture state changed"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc};
    struct Source(Rc<RefCell<Vec<u8>>>);
    impl AttachmentSource for Source {
        fn len(&self) -> u64 {
            self.0.borrow().len() as u64
        }
        fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<(), String> {
            let bytes = self.0.borrow();
            let start = offset as usize;
            buf.copy_from_slice(bytes.get(start..start + buf.len()).ok_or("range")?);
            Ok(())
        }
    }
    #[test]
    fn utf8_checks_every_boundary_without_rewriting_or_truncation() {
        for text in ["\u{feff}a\r\n🦀é中", "", "a"] {
            for split in 0..=text.len() {
                let mut u = Utf8::default();
                u.push(&text.as_bytes()[..split]).unwrap();
                u.push(&text.as_bytes()[split..]).unwrap();
                u.finish().unwrap();
            }
        }
        for bytes in [
            &[0xc0, 0x80][..],
            &[0xed, 0xa0, 0x80],
            &[0xf4, 0x90, 0x80, 0x80],
            &[0xe2, 0x82],
            &[0xff],
        ] {
            for split in 0..=bytes.len() {
                let mut u = Utf8::default();
                assert!(
                    u.push(&bytes[..split])
                        .and_then(|()| u.push(&bytes[split..]))
                        .and_then(|()| u.finish())
                        .is_err()
                );
            }
        }
    }
    #[test]
    fn proof_binds_complete_ranges_and_detects_same_length_edits_on_retry() {
        let mut bytes = vec![b'a'; CHUNK_BYTES as usize + 5];
        bytes[CHUNK_BYTES as usize - 1..CHUNK_BYTES as usize + 3].copy_from_slice("🦀".as_bytes());
        let bytes = Rc::new(RefCell::new(bytes));
        let expected = sha256(&bytes.borrow());
        let mut source = verify(Box::new(Source(bytes.clone()))).unwrap();
        assert_eq!(source.hash, expected);
        assert_eq!(source.ranges.len(), 2);
        let mut range = vec![0; CHUNK_BYTES as usize];
        source.read_at(0, &mut range).unwrap();
        bytes.borrow_mut()[17] = b'b';
        assert!(source.read_at(0, &mut range).is_err());
        assert!(source.read_at(1, &mut range).is_err());
    }
    #[test]
    fn exactly_cap_and_invalid_utf8_never_become_this_kind() {
        for mut bytes in [
            vec![b'a'; RECORD_SOURCE_CAP_BYTES as usize],
            vec![b'a'; RECORD_SOURCE_CAP_BYTES as usize + 1],
        ] {
            if bytes.len() > RECORD_SOURCE_CAP_BYTES as usize {
                *bytes.last_mut().unwrap() = 0xff;
            }
            assert!(verify(Box::new(Source(Rc::new(RefCell::new(bytes))))).is_err());
        }
    }
}
