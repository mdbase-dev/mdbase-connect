//! Native region driver correctness only; FakeLog does not qualify hosted wire,
//! provider durability, memory, Noise, restart or SQL ordering.
use super::*;
use crate::HostedAttachmentTransferParams;
use crate::crypto::chunked_blob::upload_resume::UploadResumeOwnerV1;
use crate::log::LogResponse;

pub(super) fn params(size: u64) -> HostedAttachmentTransferParams {
    HostedAttachmentTransferParams {
        transfer: B16([0xc1; 16]),
        path: "files/region.bin".into(),
        size,
        digest: None,
        mutation: Some(B16([0xc2; 16])),
    }
}
pub(super) fn store_chunk(
    h: &mut Hosted,
    region: &[u8],
    span: &crate::crypto::chunked_blob::SealedChunkSpan,
) {
    let reply = h.log.call(LogRequest::PutObject {
        collection: COL,
        address: span.cipher_hash(),
        kind: mdbn_wire::envelope::ItemKind::BlobPart,
        bytes: region[span.range()].to_vec(),
    });
    assert!(matches!(reply, Ok(LogResponse::PutObject { .. })));
}
pub(super) fn take_verify(h: &mut Hosted) -> crate::log::LogCall {
    let mut calls = h.r.take_log_calls();
    let i = calls
        .iter()
        .position(|c| matches!(c.request, LogRequest::HasObjects { .. }))
        .expect("native object verification");
    let call = calls.remove(i);
    for c in calls {
        let reply = h.log.call(c.request);
        h.r.on_log_reply(c.id, reply);
    }
    call
}
pub(super) fn metadata_call(h: &mut Hosted, verify: crate::log::LogCall) -> crate::log::LogCall {
    let reply = h.log.call(verify.request);
    h.r.on_log_reply(verify.id, reply);
    let mut calls = h.r.take_log_calls();
    let i = calls
        .iter()
        .position(|c| matches!(c.request, LogRequest::PutObject { .. }))
        .expect("encrypted resume metadata PUT");
    let call = calls.remove(i);
    if let LogRequest::PutObject { bytes, .. } = &call.request {
        assert!(
            bytes.len() < 64 << 10,
            "native queue must never own the sealed file chunk"
        );
    }
    for c in calls {
        let reply = h.log.call(c.request);
        h.r.on_log_reply(c.id, reply);
    }
    call
}

#[test]
fn region_boundary_requires_native_chunk_and_encrypted_metadata_storage_before_progress() {
    let (mut h, _, _) = ready(None);
    let session = h.session(G1);
    let mut p = params(65_537);
    p.digest = Some(mdbn_wire::hash::sha256(&vec![0x41; 65_537]));
    let id =
        h.r.start_hosted_attachment_region_upload(session, p.clone())
            .unwrap();
    assert_eq!(
        h.r.hosted_attachment_region_progress(session, &id)
            .unwrap()
            .committed_chunks,
        0
    );
    let mut region = vec![0xbc; 9 << 20];
    region[..65_537].fill(0x41);
    let pointer = region.as_ptr();
    let span =
        h.r.push_hosted_attachment_region_chunk(session, &id, &mut region, 65_537)
            .unwrap();
    assert!(
        h.r.take_log_calls().is_empty(),
        "seal only, no owned file body queued"
    );
    assert_eq!(
        h.r.hosted_attachment_region_progress(session, &id)
            .unwrap()
            .committed_chunks,
        0
    );
    assert!(
        h.r.commit_hosted_attachment_region_upload(session, &id)
            .is_err()
    );
    store_chunk(&mut h, &region, &span);
    h.r.verify_hosted_attachment_region_chunk(session, &id)
        .unwrap();
    let verify = take_verify(&mut h);
    let meta = metadata_call(&mut h, verify);
    assert_eq!(
        h.r.hosted_attachment_region_progress(session, &id)
            .unwrap()
            .committed_chunks,
        0
    );
    assert!(
        h.r.hosted_attachment_region_progress(session, &id)
            .unwrap()
            .checkpoint
            .is_none()
    );
    let LogRequest::PutObject { bytes, .. } = &meta.request else {
        panic!()
    };
    let meta_bytes = bytes.clone();
    h.clock.set(h.clock.get() + 1000); // delayed reply cannot extend sealed expiry
    let reply = h.log.call(meta.request);
    h.r.on_log_reply(meta.id, reply);
    let progress = h.r.hosted_attachment_region_progress(session, &id).unwrap();
    assert_eq!(progress.committed_chunks, 1);
    let r = progress.checkpoint.unwrap();
    region.fill(0xbc);
    region[..meta_bytes.len()].copy_from_slice(&meta_bytes);
    let owner = UploadResumeOwnerV1 {
        grant: G1,
        client_pk: mdbn_wire::common::B32([G1.0[0]; 32]),
        account: TEST_OWNER,
        transfer: p.transfer,
    };
    let auth =
        h.r.sealer
            .open_hosted_upload_resume(&r, owner, &mut region)
            .unwrap();
    assert_eq!(auth.metadata().expires_at_ms, progress.expires_at_ms);
    let native_file = auth.metadata().file;
    assert_ne!(native_file, id);
    assert!(region.iter().all(|b| *b == 0));
    assert_eq!(region.as_ptr(), pointer);
    assert!(h.r.attachment_upload_checkpoint(&id).is_none());
    h.r.commit_hosted_attachment_region_upload(session, &id)
        .unwrap();
    h.pump();
    let receipt = h.r.known_receipt_for(&id, Some(G1)).unwrap().unwrap();
    assert_eq!(receipt.state, ReceiptState::Confirmed);
    assert!(h.r.known_receipt_for(&id, Some(G2)).unwrap().is_none());
}

#[test]
fn uncommitted_staged_chunk_cannot_create_a_resume_checkpoint() {
    let (mut h, _, _) = ready(None);
    let session = h.session(G1);
    let id =
        h.r.start_hosted_attachment_region_upload(session, params(3))
            .unwrap();
    let mut region = vec![0xad; 9 << 20];
    region[..3].copy_from_slice(b"abc");
    h.r.push_hosted_attachment_region_chunk(session, &id, &mut region, 3)
        .unwrap();
    h.r.verify_hosted_attachment_region_chunk(session, &id)
        .unwrap();
    let verify = take_verify(&mut h);
    let reply = h.log.call(verify.request);
    h.r.on_log_reply(verify.id, reply);
    let AttachmentUploadStatus::Failed(problem) = h.r.attachment_upload_status(&id).unwrap() else {
        panic!()
    };
    assert_eq!(
        problem.reason.as_deref(),
        Some("attachment_objects_missing")
    );
    assert!(h.r.hosted_attachment_region_progress(session, &id).is_err());
    assert!(h.r.store.pending_get(&id).unwrap().is_none());
    assert!(h.r.known_receipt_for(&id, Some(G1)).unwrap().is_none());
}

#[test]
fn lost_metadata_reply_never_adopts_possible_storage_or_claims_progress() {
    let (mut h, _, _) = ready(None);
    let session = h.session(G1);
    let id =
        h.r.start_hosted_attachment_region_upload(session, params(3))
            .unwrap();
    let mut region = vec![0xad; 9 << 20];
    region[..3].copy_from_slice(b"abc");
    let span =
        h.r.push_hosted_attachment_region_chunk(session, &id, &mut region, 3)
            .unwrap();
    store_chunk(&mut h, &region, &span);
    h.r.verify_hosted_attachment_region_chunk(session, &id)
        .unwrap();
    let verify = take_verify(&mut h);
    let meta = metadata_call(&mut h, verify);
    assert!(
        matches!(h.log.call(meta.request), Ok(LogResponse::PutObject { .. })),
        "stored but reply lost"
    );
    h.r.on_log_reply(meta.id, Err(LogError::NoResponse));
    let AttachmentUploadStatus::Failed(problem) = h.r.attachment_upload_status(&id).unwrap() else {
        panic!()
    };
    assert_eq!(
        problem.reason.as_deref(),
        Some("hosted_upload_commit_unknown")
    );
    assert!(h.r.hosted_attachment_region_progress(session, &id).is_err());
    assert!(h.r.store.pending_get(&id).unwrap().is_none());
    assert!(h.r.known_receipt_for(&id, Some(G1)).unwrap().is_none());
}

pub(super) fn committed_checkpoint(
    h: &mut Hosted,
    session: SessionId,
    id: B16,
    region: &[u8],
    span: &crate::crypto::chunked_blob::SealedChunkSpan,
) -> (
    crate::crypto::chunked_blob::upload_resume::UploadResumeRefV1,
    Vec<u8>,
) {
    store_chunk(h, region, span);
    h.r.verify_hosted_attachment_region_chunk(session, &id)
        .unwrap();
    let verify = take_verify(h);
    let meta = metadata_call(h, verify);
    let LogRequest::PutObject { bytes, .. } = &meta.request else {
        panic!()
    };
    let bytes = bytes.clone();
    let reply = h.log.call(meta.request);
    h.r.on_log_reply(meta.id, reply);
    (
        h.r.hosted_attachment_region_progress(session, &id)
            .unwrap()
            .checkpoint
            .unwrap(),
        bytes,
    )
}

#[test]
fn fresh_native_wake_rehashes_committed_prefix_and_captures_same_native_file() {
    use sha2::{Digest, Sha256};
    let (mut h, svc, _) = ready(None);
    let session = h.session(G1);
    let first = vec![0x41; 8 << 20];
    let tail = b"xyz";
    let mut digest = Sha256::new();
    digest.update(&first);
    digest.update(tail);
    let mut p = params(first.len() as u64 + tail.len() as u64);
    p.digest = Some(mdbn_wire::common::B32(digest.finalize().into()));
    let id =
        h.r.start_hosted_attachment_region_upload(session, p.clone())
            .unwrap();
    let mut region = vec![0xbc; 9 << 20];
    let pointer = region.as_ptr();
    region[..first.len()].copy_from_slice(&first);
    let span =
        h.r.push_hosted_attachment_region_chunk(session, &id, &mut region, first.len())
            .unwrap();
    let chunk = region[span.range()].to_vec();
    let (reference, meta) = committed_checkpoint(&mut h, session, id, &region, &span);
    let owner = UploadResumeOwnerV1 {
        grant: G1,
        client_pk: mdbn_wire::common::B32([G1.0[0]; 32]),
        account: TEST_OWNER,
        transfer: p.transfer,
    };
    region[..meta.len()].copy_from_slice(&meta);
    let old_file =
        h.r.sealer
            .open_hosted_upload_resume(&reference, owner, &mut region)
            .unwrap()
            .metadata()
            .file;
    drop(h); // no native session/context/hasher survives
    let mut fresh = crypto_open(&svc, MemStore::new());
    fresh.r.planner = Box::new(crate::plan::CorePlanner);
    fresh.pump();
    verified(&fresh);
    let session = fresh.session(G1);
    region[..meta.len()].copy_from_slice(&meta);
    assert_eq!(
        fresh
            .r
            .resume_hosted_attachment_region_upload(session, p.clone(), reference, &mut region)
            .unwrap(),
        id
    );
    assert!(region.iter().all(|b| *b == 0));
    assert_eq!(
        fresh.r.hosted_attachment_rehash_need(session, &id).unwrap(),
        Some((0, span.cipher_hash(), chunk.len() as u64))
    );
    region[..3].copy_from_slice(tail);
    assert!(
        fresh
            .r
            .push_hosted_attachment_region_chunk(session, &id, &mut region, 3)
            .is_err(),
        "must rehash before accepting suffix"
    );
    assert!(region.iter().all(|b| *b == 0));
    region[..chunk.len()].copy_from_slice(&chunk);
    fresh
        .r
        .supply_hosted_attachment_rehash(session, &id, 0, &mut region)
        .unwrap();
    assert!(region.iter().all(|b| *b == 0));
    assert_eq!(region.as_ptr(), pointer);
    assert!(
        fresh
            .r
            .hosted_attachment_rehash_need(session, &id)
            .unwrap()
            .is_none()
    );
    region[..3].copy_from_slice(tail);
    let tail_span = fresh
        .r
        .push_hosted_attachment_region_chunk(session, &id, &mut region, 3)
        .unwrap();
    let (ref2, meta2) = committed_checkpoint(&mut fresh, session, id, &region, &tail_span);
    assert_eq!(
        fresh
            .r
            .hosted_attachment_region_progress(session, &id)
            .unwrap()
            .committed_chunks,
        2
    );
    region[..meta2.len()].copy_from_slice(&meta2);
    let auth = fresh
        .r
        .sealer
        .open_hosted_upload_resume(&ref2, owner, &mut region)
        .unwrap();
    assert_eq!(auth.metadata().file, old_file);
    fresh
        .r
        .commit_hosted_attachment_region_upload(session, &id)
        .unwrap();
    fresh.pump();
    assert_eq!(
        fresh
            .r
            .known_receipt_for(&id, Some(G1))
            .unwrap()
            .unwrap()
            .state,
        ReceiptState::Confirmed
    );
    assert!(fresh.r.known_receipt_for(&id, Some(G2)).unwrap().is_none());
}

#[test]
fn encrypted_resume_refused_for_other_subject_or_changed_immutable_request_and_wipes() {
    let (mut h, svc, _) = ready(None);
    let session = h.session(G1);
    let p = params(3);
    let id =
        h.r.start_hosted_attachment_region_upload(session, p.clone())
            .unwrap();
    let mut region = vec![0xbb; 9 << 20];
    region[..3].copy_from_slice(b"abc");
    let span =
        h.r.push_hosted_attachment_region_chunk(session, &id, &mut region, 3)
            .unwrap();
    let (reference, meta) = committed_checkpoint(&mut h, session, id, &region, &span);
    drop(h);
    let mut fresh = crypto_open(&svc, MemStore::new());
    fresh.r.planner = Box::new(crate::plan::CorePlanner);
    fresh.pump();
    let wrong = fresh.session(G2);
    region[..meta.len()].copy_from_slice(&meta);
    assert!(
        fresh
            .r
            .resume_hosted_attachment_region_upload(wrong, p.clone(), reference, &mut region)
            .is_err()
    );
    assert!(region.iter().all(|b| *b == 0));
    let right = fresh.session(G1);
    let mut changed = p.clone();
    changed.path = "files/elsewhere.bin".into();
    region[..meta.len()].copy_from_slice(&meta);
    assert!(
        fresh
            .r
            .resume_hosted_attachment_region_upload(right, changed, reference, &mut region)
            .is_err()
    );
    assert!(region.iter().all(|b| *b == 0));
    let mut changed = p;
    changed.digest = Some(mdbn_wire::common::B32([9; 32]));
    region[..meta.len()].copy_from_slice(&meta);
    assert!(
        fresh
            .r
            .resume_hosted_attachment_region_upload(right, changed, reference, &mut region)
            .is_err()
    );
    assert!(region.iter().all(|b| *b == 0));
    assert!(fresh.r.known_receipt_for(&id, Some(G1)).unwrap().is_none());
}

#[test]
fn metadata_await_revocation_fences_progress_and_capture() {
    use mdbn_wire::policy::{GrantRevoke, PolicyOp};
    let (mut h, svc, mut cp) = ready(None);
    let session = h.session(G1);
    let id =
        h.r.start_hosted_attachment_region_upload(session, params(3))
            .unwrap();
    let mut region = vec![0xbc; 9 << 20];
    region[..3].copy_from_slice(b"abc");
    let span =
        h.r.push_hosted_attachment_region_chunk(session, &id, &mut region, 3)
            .unwrap();
    store_chunk(&mut h, &region, &span);
    h.r.verify_hosted_attachment_region_chunk(session, &id)
        .unwrap();
    let verify = take_verify(&mut h);
    let meta = metadata_call(&mut h, verify);
    cp.append(&svc, vec![PolicyOp::GrantRevoke(GrantRevoke { grant: G1 })]);
    h.pump();
    let reply = h.log.call(meta.request);
    h.r.on_log_reply(meta.id, reply);
    h.pump();
    assert!(matches!(
        h.r.attachment_upload_status(&id),
        Some(AttachmentUploadStatus::Failed(_))
    ));
    assert!(h.r.hosted_attachment_region_progress(session, &id).is_err());
    assert!(h.r.store.pending_get(&id).unwrap().is_none());
    assert!(h.r.known_receipt_for(&id, Some(G1)).unwrap().is_none());
}

#[test]
fn encrypted_metadata_quota_refusal_is_not_masked_by_later_scope_loss() {
    let (mut h, _, _) = ready(None);
    let session = h.session(G1);
    let id =
        h.r.start_hosted_attachment_region_upload(session, params(3))
            .unwrap();
    let mut region = vec![0xbc; 9 << 20];
    region[..3].copy_from_slice(b"abc");
    let span =
        h.r.push_hosted_attachment_region_chunk(session, &id, &mut region, 3)
            .unwrap();
    store_chunk(&mut h, &region, &span);
    h.r.verify_hosted_attachment_region_chunk(session, &id)
        .unwrap();
    let verify = take_verify(&mut h);
    let meta = metadata_call(&mut h, verify);
    h.r.policy.frozen = true;
    h.r.on_log_reply(
        meta.id,
        Err(LogError::code(crate::log::LogErrorCode::QuotaExceeded)),
    );
    let AttachmentUploadStatus::Failed(problem) = h.r.attachment_upload_status(&id).unwrap() else {
        panic!()
    };
    assert_eq!(problem.code, ErrorCode::QuotaExceeded.as_str());
    assert!(h.r.store.pending_get(&id).unwrap().is_none());
    assert!(h.r.known_receipt_for(&id, Some(G1)).unwrap().is_none());
}

#[test]
fn native_expiry_recheck_precedes_region_seal_and_wipes_on_refusal() {
    let (mut h, _, _) = ready(None);
    let session = h.session(G1);
    let id =
        h.r.start_hosted_attachment_region_upload(session, params(3))
            .unwrap();
    let expiry =
        h.r.hosted_attachment_region_progress(session, &id)
            .unwrap()
            .expires_at_ms;
    h.clock.set(expiry);
    assert!(h.r.recheck_hosted_attachment_upload(session, &id).is_err());
    let mut region = vec![0xad; 9 << 20];
    region[..3].copy_from_slice(b"abc");
    assert!(
        h.r.push_hosted_attachment_region_chunk(session, &id, &mut region, 3)
            .is_err()
    );
    assert!(region.iter().all(|b| *b == 0));
    assert!(h.r.take_log_calls().is_empty());
    assert!(h.r.known_receipt_for(&id, Some(G1)).unwrap().is_none());
}

#[test]
fn current_epoch_loss_before_sealing_wipes_full_lent_region_without_advancing() {
    let (mut h, _, _) = ready(None);
    let session = h.session(G1);
    let id =
        h.r.start_hosted_attachment_region_upload(session, params(3))
            .unwrap();
    let mut region = vec![0xad; 9 << 20];
    region[..3].copy_from_slice(b"abc");
    h.r.policy.epoch += 1;
    assert!(
        h.r.push_hosted_attachment_region_chunk(session, &id, &mut region, 3)
            .is_err()
    );
    assert!(region.iter().all(|b| *b == 0));
    assert!(h.r.take_log_calls().is_empty());
    assert!(h.r.known_receipt_for(&id, Some(G1)).unwrap().is_none());
}
