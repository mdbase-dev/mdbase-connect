//! Only an opaque encrypted-journal reference persists locally, never its payload.
use super::*;
use crate::crypto::chunked_blob::{
    AttachmentContextV1,
    upload_resume::{UploadResumeOwner, UploadResumeRefV1},
};
use crate::store::StoreError;
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::schema::Wire;

fn owner_key(owner: UploadResumeOwner) -> String {
    let fields = match owner {
        UploadResumeOwner::GrantV1(o) => vec![
            Cbor::Uint(1),
            o.grant.to_cbor(),
            o.client_pk.to_cbor(),
            o.account.to_cbor(),
            o.transfer.to_cbor(),
        ],
        UploadResumeOwner::HostV2 {
            device,
            account,
            transfer,
        } => vec![
            Cbor::Uint(2),
            device.to_cbor(),
            account.to_cbor(),
            transfer.to_cbor(),
        ],
    };
    let encoded = cbor::encode(&Cbor::Array(fields)).expect("fixed owner identifiers encode");
    let hash = mdbn_wire::hash::sha256(&encoded);
    let hex: String = hash.0.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}{hex}", meta_keys::CLIENT_UPLOAD_RESUME)
}
// Captured binding uses the same opaque reference codec and exact owner namespace.
// It is staged in Origin.meta, persisted only by the native FileAttach capture Tx.
pub(super) fn capture_reference_meta(
    owner: UploadResumeOwner,
    reference: UploadResumeRefV1,
) -> (String, Option<Vec<u8>>) {
    (
        format!("{}.captured", owner_key(owner)),
        Some(encode(reference)),
    )
}
pub(super) fn has_capture_reference(up: &Upload) -> bool {
    up.origin.meta.iter().any(|(key, _)| {
        key.starts_with(meta_keys::CLIENT_UPLOAD_RESUME) && key.ends_with(".captured")
    })
}
#[cfg(test)]
pub(crate) fn captured_key(owner: UploadResumeOwner) -> String {
    format!("{}.captured", owner_key(owner))
}
fn encode(reference: UploadResumeRefV1) -> Vec<u8> {
    let c = reference.context;
    cbor::encode(&Cbor::Array(vec![
        Cbor::Uint(1),
        c.collection.to_cbor(),
        Cbor::Uint(c.key_epoch),
        c.attachment_id.to_cbor(),
        Cbor::Uint(c.chunk_bytes.into()),
        reference.cipher_hash.to_cbor(),
        Cbor::Uint(reference.sealed_bytes),
    ]))
    .expect("fixed opaque reference encodes")
}
fn decode(bytes: &[u8]) -> Result<UploadResumeRefV1, StoreError> {
    let bad = || StoreError::Corrupt("native upload resume pointer".into());
    if bytes.len() > 256 {
        return Err(bad());
    }
    let value = cbor::decode(bytes).map_err(|_| bad())?;
    let Cbor::Array(a) = value else {
        return Err(bad());
    };
    if a.len() != 7 || a[0] != Cbor::Uint(1) {
        return Err(bad());
    }
    let uint = |index| {
        if let Cbor::Uint(n) = a[index] {
            Ok(n)
        } else {
            Err(bad())
        }
    };
    let reference = UploadResumeRefV1 {
        context: AttachmentContextV1 {
            collection: Uuid::from_cbor(&a[1]).map_err(|_| bad())?,
            key_epoch: uint(2)?,
            attachment_id: mdbn_wire::common::B32::from_cbor(&a[3]).map_err(|_| bad())?,
            chunk_bytes: u32::try_from(uint(4)?).map_err(|_| bad())?,
        },
        cipher_hash: Hash::from_cbor(&a[5]).map_err(|_| bad())?,
        sealed_bytes: uint(6)?,
    };
    if reference.context.chunk_bytes != crate::crypto::chunked_blob::CHUNK_BYTES
        || reference.sealed_bytes == 0
        || reference.sealed_bytes
            > crate::crypto::chunked_blob::upload_resume::max_sealed_bytes(
                reference.context.key_epoch,
            )
            .map_err(|_| bad())? as u64
        || encode(reference) != bytes
    {
        return Err(bad());
    }
    Ok(reference)
}
impl<S: Store> Replica<S> {
    pub(crate) fn client_resume_owner(
        &self,
        session: crate::api::SessionId,
        mutation: Uuid,
    ) -> ApiResult<UploadResumeOwner> {
        let up = self
            .attachment_uploads
            .map
            .get(&mutation)
            .ok_or_else(|| ErrorCode::NotFound.err("no native upload"))?;
        let context = up
            .origin
            .delegated
            .as_ref()
            .ok_or_else(|| ErrorCode::Internal.err("upload has no native CREATE owner"))?;
        self.attachment_create_caller_check(session, context)?;
        let transfer = up
            .hosted
            .as_ref()
            .ok_or_else(|| ErrorCode::Internal.err("upload has no region transfer"))?
            .transfer;
        Ok(context.resume_owner(transfer))
    }
    pub(crate) fn client_resume_reference(
        &self,
        owner: UploadResumeOwner,
    ) -> Result<Option<UploadResumeRefV1>, StoreError> {
        self.store
            .meta(&owner_key(owner))?
            .map(|bytes| decode(&bytes))
            .transpose()
    }
    /// Actual owner-visible native outcome, never manufactured from metadata.
    pub(in crate::replica) fn client_actual_upload_receipt(
        &mut self,
        session: crate::api::SessionId,
        mutation: Uuid,
    ) -> ApiResult<mdbn_wire::client::Receipt> {
        crate::api::ClientApi::receipt(self, session, mutation).map_err(|error| {
            let problem = error.into_problem();
            if problem.code == "not_found" {
                ErrorCode::Unavailable.err_with_reason(
                    "file_upload_outcome_unknown",
                    "the actual captured mutation receipt is unavailable",
                )
            } else {
                problem.into()
            }
        })
    }
    /// The original live native producer can answer a same-session open retry.
    pub(in crate::replica) fn client_live_captured_open(
        &mut self,
        session: crate::api::SessionId,
        mutation: Uuid,
    ) -> Option<ApiResult<mdbn_wire::client::OpenUploadResult>> {
        let up = self.attachment_uploads.map.get(&mutation)?;
        let ctx = up
            .origin
            .delegated
            .as_ref()
            .expect("ClientApi has actual CREATE owner");
        // Terminal failure scrubs HostedRegion; retained captured work must
        // reauthenticate its journal instead of reviving that retired writer.
        let h = up.hosted.as_ref()?;
        let owner = ctx.resume_owner(h.transfer);
        let captured = match self.client_captured_reference(owner) {
            Ok(Some(reference)) => reference,
            Ok(None) => return None,
            Err(error) => return Some(Err(super::super::submit::store_err(error))),
        };
        let result = (|| {
            self.attachment_create_caller_check(session, ctx)?;
            self.attachment_upload_authority_check(
                ctx,
                &up.params.path,
                up.total,
                &up.params.file,
            )?;
            if h.checkpoint != Some(captured) {
                return Err(ErrorCode::Unavailable.err_with_reason(
                    "attachment_resume_unavailable",
                    "captured journal binding changed",
                ));
            }
            let opened = mdbn_wire::client::OpenUploadResult {
                transfer: h.transfer,
                chunk_size: super::super::client_uploads::FRAGMENT,
                received: (0..up.total.div_ceil(super::super::client_uploads::FRAGMENT)).collect(),
                expires_at: h.expires_at_ms as i64,
                file_id: Some(up.params.file),
            };
            Ok(opened)
        })();
        Some(result.and_then(|opened| {
            self.client_actual_upload_receipt(session, mutation)?;
            Ok(opened)
        }))
    }
    pub(crate) fn client_captured_reference(
        &self,
        owner: UploadResumeOwner,
    ) -> Result<Option<UploadResumeRefV1>, StoreError> {
        self.store
            .meta(&format!("{}.captured", owner_key(owner)))?
            .map(|bytes| decode(&bytes))
            .transpose()
    }
    pub(in crate::replica) fn stage_client_capture_reference(
        &mut self,
        session: crate::api::SessionId,
        mutation: Uuid,
        reference: UploadResumeRefV1,
    ) -> ApiResult<()> {
        let owner = self.client_resume_owner(session, mutation)?;
        let binding = capture_reference_meta(owner, reference);
        let up = self
            .attachment_uploads
            .map
            .get_mut(&mutation)
            .expect("owner checked");
        up.origin.meta.retain(|(key, _)| key != &binding.0);
        up.origin.meta.push(binding);
        Ok(())
    }
    pub(crate) fn persist_client_resume_reference(
        &mut self,
        owner: UploadResumeOwner,
        reference: Option<UploadResumeRefV1>,
    ) -> Result<(), StoreError> {
        self.store
            .commit(Tx {
                meta: vec![(owner_key(owner), reference.map(encode))],
                ..Tx::default()
            })
            .map(|_| ())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_wire::common::B16;
    #[test]
    fn pointer_is_strict_bounded_and_both_owner_namespaces_are_distinct() {
        let reference = UploadResumeRefV1 {
            context: AttachmentContextV1 {
                collection: B16([1; 16]),
                key_epoch: 1,
                attachment_id: mdbn_wire::common::B32([2; 32]),
                chunk_bytes: crate::crypto::chunked_blob::CHUNK_BYTES,
            },
            cipher_hash: Hash::from_cbor(&Cbor::Bytes(vec![3; 32])).unwrap(),
            sealed_bytes: 1000,
        };
        let bytes = encode(reference);
        assert!(bytes.len() < 256);
        assert_eq!(decode(&bytes).unwrap(), reference);
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(decode(&trailing).is_err());
        assert!(decode(&vec![0; 257]).is_err());
        let mut zero = reference;
        zero.sealed_bytes = 0;
        assert!(decode(&encode(zero)).is_err());
        let grant = UploadResumeOwner::GrantV1(
            crate::crypto::chunked_blob::upload_resume::UploadResumeOwnerV1 {
                grant: B16([1; 16]),
                client_pk: mdbn_wire::common::B32([2; 32]),
                account: B16([3; 16]),
                transfer: B16([4; 16]),
            },
        );
        let host = UploadResumeOwner::HostV2 {
            device: B16([1; 16]),
            account: B16([3; 16]),
            transfer: B16([4; 16]),
        };
        assert_ne!(owner_key(grant), owner_key(host));
    }
}
