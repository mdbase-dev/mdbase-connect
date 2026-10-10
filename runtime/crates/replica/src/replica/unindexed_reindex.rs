//! Bounded reverse16 preparation; not capture/emission authority.
use super::{AttachmentSource, Replica, UnindexedCaptureTarget};
use crate::{
    api::{ApiResult, ErrorCode},
    store::Store,
};
use mdbn_wire::{
    attachment::FileContent,
    attachment_runtime_v1 as rt,
    common::Text,
    common::{Hash, Uuid},
    unindexed_markdown::{UnindexedMarkdownPayloadV1, UnindexedMarkdownToRecord},
};
use zeroize::Zeroizing;
/// Opaque small-source reverse preparation, separate from the >1MiB predicate.
pub struct PreparedUnindexedReindex {
    id: Uuid,
    path: String,
    prior: FileContent,
    doc: Zeroizing<String>,
    catalog: Hash,
    generation: u64,
}
impl PreparedUnindexedReindex {
    /// Exact source byte count, never larger than the Record source cap.
    pub fn size(&self) -> u64 {
        self.doc.len() as u64
    }
    /// Verified bounded byte identity for trusted observation matching.
    pub(super) fn source_hash(&self) -> Hash {
        mdbn_wire::hash::sha256(self.doc.as_bytes())
    }
    /// Data-only operation. Final capture must freshly recheck this capsule.
    pub fn operation(&self) -> rt::Op {
        rt::Op::UnindexedMarkdownToRecord(UnindexedMarkdownToRecord {
            id: self.id,
            path: self.path.clone(),
            doc: Text::Inline(self.doc.to_string()),
            prior: UnindexedMarkdownPayloadV1 {
                content: self.prior.clone(),
            },
        })
    }
}
impl<S: Store> Replica<S> {
    /// Prepare a <=1MiB UTF8 replacement only for a current native holder.
    /// Does not publish, resolve observations, create a pending row or append.
    pub fn prepare_unindexed_markdown_reindex(
        &self,
        id: Uuid,
        path: String,
        mut source: Box<dyn AttachmentSource>,
    ) -> ApiResult<PreparedUnindexedReindex> {
        self.unindexed_capture_admission(&path)?;
        let UnindexedCaptureTarget::Replace(prior) = self.unindexed_target(id, &path)? else {
            return Err(ErrorCode::Conflict.err_with_reason(
                "unindexed_capture_holder",
                "reverse capture requires the same native holder",
            ));
        };
        let catalog = self.unindexed_catalog_stamp()?;
        let size = source.len();
        if size > mdbn_wire::unindexed_markdown::RECORD_SOURCE_CAP_BYTES {
            return Err(ErrorCode::TooLarge.err_with_reason(
                "unindexed_reindex_source_too_large",
                "reverse source exceeds Record cap",
            ));
        }
        let mut bytes = Zeroizing::new(vec![0; size as usize]);
        if size > 0 {
            source
                .read_at(0, &mut bytes)
                .map_err(|e| ErrorCode::Conflict.err_with_reason("source_changed", e))?;
        }
        if source.len() != size {
            return Err(
                ErrorCode::Conflict.err_with_reason("source_changed", "source length changed")
            );
        }
        let text = std::str::from_utf8(&bytes).map_err(|_| {
            ErrorCode::InvalidRequest
                .err_with_reason("unindexed_source_utf8", "replacement source is not UTF8")
        })?;
        let p = PreparedUnindexedReindex {
            id,
            path,
            prior: prior.content,
            doc: Zeroizing::new(text.to_owned()),
            catalog,
            generation: self.store_generation,
        };
        self.recheck_unindexed_markdown_reindex(&p)?;
        Ok(p)
    }
    /// Data-only bounded Blob sealing for an opaque reverse capsule.
    /// Does not upload, create pending state, append, or confer capture authority.
    /// Final upload/capture must freshly recheck the capsule and complete refs.
    pub fn seal_unindexed_markdown_reindex_source(
        &mut self,
        p: &PreparedUnindexedReindex,
    ) -> ApiResult<(
        mdbn_wire::intent::BlobRef,
        Vec<crate::crypto::blob::SealedPart>,
    )> {
        // Separate <=1MiB predicate, enforced here AND inside key custody.
        if p.size() > mdbn_wire::unindexed_markdown::RECORD_SOURCE_CAP_BYTES {
            return Err(ErrorCode::TooLarge.err_with_reason(
                "unindexed_reindex_source_too_large",
                "reverse source exceeds Record cap",
            ));
        }
        self.recheck_unindexed_markdown_reindex(p)?;
        let source = self
            .sealer
            .seal_bounded_record_source(p.doc.as_bytes(), self.host.entropy.as_mut())
            .map_err(|e| {
                ErrorCode::Conflict
                    .err_with_reason("unindexed_reindex_seal_failed", format!("{e:?}"))
            })?;
        self.recheck_unindexed_markdown_reindex(p)?;
        Ok(source)
    }

    /// Current healthy authority/full-prior/path/catalog/generation recheck.
    pub fn recheck_unindexed_markdown_reindex(
        &self,
        p: &PreparedUnindexedReindex,
    ) -> ApiResult<()> {
        self.unindexed_capture_admission(&p.path)?;
        if p.generation != self.store_generation
            || self.unindexed_catalog_stamp()? != p.catalog
            || self.unindexed_target(p.id, &p.path)?
                != UnindexedCaptureTarget::Replace(
                    mdbn_wire::unindexed_markdown::UnindexedMarkdownPayloadV1 {
                        content: p.prior.clone(),
                    },
                )
        {
            return Err(ErrorCode::Conflict
                .err_with_reason("unindexed_capture_changed", "reverse capture state changed"));
        }
        Ok(())
    }
}
