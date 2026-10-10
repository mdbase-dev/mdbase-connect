//! IDs identify native work; only its authenticated owner session may act.
use super::region_upload::{committed_checkpoint, params};
use super::*;
fn owner_mismatch<T>(result: crate::api::ApiResult<T>) {
    let Err(error) = result else {
        panic!("other session acted on native upload");
    };
    assert_eq!(
        error.into_problem().reason.as_deref(),
        Some("attachment_upload_owner_mismatch")
    );
}
#[test]
fn region_calls_refuse_other_grant_and_other_session_without_owner_state_advance() {
    let (mut h, _, _) = ready(None);
    let owner = h.session(G1);
    let other_grant = h.session(G2);
    let same_grant_other_session = h.session(G1);
    let id =
        h.r.start_hosted_attachment_region_upload(owner, params(3))
            .unwrap();
    let mut region = vec![0xaa; 9 << 20];
    for caller in [other_grant, same_grant_other_session] {
        owner_mismatch(h.r.recheck_hosted_attachment_upload(caller, &id));
        owner_mismatch(h.r.hosted_attachment_region_progress(caller, &id));
        owner_mismatch(h.r.hosted_attachment_rehash_need(caller, &id));
        owner_mismatch(h.r.verify_hosted_attachment_region_chunk(caller, &id));
        owner_mismatch(h.r.commit_hosted_attachment_region_upload(caller, &id));
        owner_mismatch(h.r.close_hosted_attachment_upload(caller, &id));
        region.fill(0xaa);
        owner_mismatch(h.r.push_hosted_attachment_region_chunk(caller, &id, &mut region, 3));
        assert!(region.iter().all(|b| *b == 0));
        region.fill(0xbb);
        owner_mismatch(h.r.supply_hosted_attachment_rehash(caller, &id, 0, &mut region));
        assert!(region.iter().all(|b| *b == 0));
        let progress = h.r.hosted_attachment_region_progress(owner, &id).unwrap();
        assert_eq!(progress.committed_chunks, 0);
        assert!(progress.checkpoint.is_none());
        assert!(matches!(
            h.r.attachment_upload_status(&id),
            Some(AttachmentUploadStatus::Uploading {
                stored: 0,
                total: 2
            })
        ));
        assert!(h.r.take_log_calls().is_empty());
        assert!(h.r.store.pending_get(&id).unwrap().is_none());
        assert!(h.r.known_receipt_for(&id, Some(G1)).unwrap().is_none());
    }
    assert!(
        !h.r.close_attachment_upload(&id),
        "legacy ID-only close must refuse delegation"
    );
    region[..3].copy_from_slice(b"abc");
    let span =
        h.r.push_hosted_attachment_region_chunk(owner, &id, &mut region, 3)
            .unwrap();
    committed_checkpoint(&mut h, owner, id, &region, &span);
    h.r.commit_hosted_attachment_region_upload(owner, &id)
        .unwrap();
    h.pump();
    assert_eq!(
        h.r.known_receipt_for(&id, Some(G1)).unwrap().unwrap().state,
        ReceiptState::Confirmed
    );
    assert!(h.r.known_receipt_for(&id, Some(G2)).unwrap().is_none());
    assert!(h.r.close_hosted_attachment_upload(owner, &id).unwrap());
    assert!(!h.r.close_hosted_attachment_upload(owner, &id).unwrap());
}
#[test]
fn refreshed_same_grant_cannot_adopt_live_resume_or_close_the_new_native_session() {
    let (mut h, _, _) = ready(None);
    let old = h.session(G1);
    let id =
        h.r.start_hosted_attachment_region_upload(old, params(3))
            .unwrap();
    let mut region = vec![0xbb; 9 << 20];
    region[..3].copy_from_slice(b"abc");
    let span =
        h.r.push_hosted_attachment_region_chunk(old, &id, &mut region, 3)
            .unwrap();
    let (reference, metadata) = committed_checkpoint(&mut h, old, id, &region, &span);
    assert!(h.r.close_hosted_attachment_upload(old, &id).unwrap());
    let new = h.session(G1);
    region[..metadata.len()].copy_from_slice(&metadata);
    h.r.resume_hosted_attachment_region_upload(new, params(3), reference, &mut region)
        .unwrap();
    owner_mismatch(h.r.hosted_attachment_region_progress(old, &id));
    owner_mismatch(h.r.hosted_attachment_rehash_need(old, &id));
    owner_mismatch(h.r.close_hosted_attachment_upload(old, &id));
    region.fill(0xbb);
    owner_mismatch(h.r.supply_hosted_attachment_rehash(old, &id, 0, &mut region));
    assert!(region.iter().all(|b| *b == 0));
    assert!(
        h.r.hosted_attachment_rehash_need(new, &id)
            .unwrap()
            .is_some()
    );
    assert_eq!(
        h.r.hosted_attachment_region_progress(new, &id)
            .unwrap()
            .committed_chunks,
        1
    );
    assert!(h.r.close_hosted_attachment_upload(new, &id).unwrap());
}
#[test]
fn caller_identity_drift_and_expired_owner_cleanup_cannot_capture_or_adopt() {
    let (mut h, _, _) = ready(None);
    let owner = h.session(G1);
    let id =
        h.r.start_hosted_attachment_region_upload(owner, params(3))
            .unwrap();
    let expiry =
        h.r.hosted_attachment_region_progress(owner, &id)
            .unwrap()
            .expires_at_ms;
    h.r.sessions.get_mut(&owner).unwrap().auth = SessionAuth::Grant {
        grant: G2,
        client_pk: [G2.0[0]; 32],
    };
    owner_mismatch(h.r.recheck_hosted_attachment_upload(owner, &id));
    owner_mismatch(h.r.close_hosted_attachment_upload(owner, &id));
    h.r.sessions.get_mut(&owner).unwrap().auth = SessionAuth::Grant {
        grant: G1,
        client_pk: [G1.0[0]; 32],
    };
    h.clock.set(expiry);
    assert!(h.r.recheck_hosted_attachment_upload(owner, &id).is_err());
    // Authenticated owner may forget its expired/failed native work; no capture.
    assert!(h.r.close_hosted_attachment_upload(owner, &id).unwrap());
    assert!(h.r.store.pending_get(&id).unwrap().is_none());
    assert!(h.r.known_receipt_for(&id, Some(G1)).unwrap().is_none());
}
#[test]
fn owned_source_delegation_recheck_and_close_also_require_original_session() {
    let (mut h, _, _) = ready(None);
    let owner = h.session(G1);
    let other = h.session(G2);
    let id = B16([0xd1; 16]);
    start(&mut h, owner, "files/source.bin", id).unwrap();
    owner_mismatch(h.r.recheck_hosted_attachment_upload(other, &id));
    owner_mismatch(h.r.close_hosted_attachment_upload(other, &id));
    assert!(!h.r.close_attachment_upload(&id));
    assert!(h.r.recheck_hosted_attachment_upload(owner, &id).is_ok());
    assert!(h.r.close_hosted_attachment_upload(owner, &id).unwrap());
}
