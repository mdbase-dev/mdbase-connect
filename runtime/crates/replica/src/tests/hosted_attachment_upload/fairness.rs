//! Native bounded scheduling/expiry regressions; synthetic log, not wire proof.
use super::region_upload::{metadata_call, params, store_chunk, take_verify};
use super::*;
use mdbn_wire::common::B32;

fn named(tag: u8) -> crate::HostedAttachmentTransferParams {
    let mut p = params(3);
    p.mutation = Some(B16([tag; 16]));
    p.transfer = B16([tag; 16]);
    p.path = format!("files/transfer-{tag}.bin");
    p
}
fn boundary(h: &mut Hosted, session: SessionId, id: B16) {
    let mut region = vec![0; 9 << 20];
    region[..3].copy_from_slice(b"abc");
    let span =
        h.r.push_hosted_attachment_region_chunk(session, &id, &mut region, 3)
            .unwrap();
    store_chunk(h, &region, &span);
    h.r.verify_hosted_attachment_region_chunk(session, &id)
        .unwrap();
    let verify = take_verify(h);
    let metadata = metadata_call(h, verify);
    let reply = h.log.call(metadata.request);
    h.r.on_log_reply(metadata.id, reply);
}

#[test]
fn stalled_region_grant_cannot_block_other_grants_owned_upload_capture() {
    let (mut h, _, _) = ready(None);
    let a = h.session(G1);
    let b = h.session(G2);
    let idle =
        h.r.start_hosted_attachment_region_upload(a, named(0xd1))
            .unwrap();
    let id = B16([0xd2; 16]);
    start(&mut h, b, "files/progress.bin", id).unwrap();
    h.pump();
    assert_eq!(
        h.r.known_receipt_for(&id, Some(G2)).unwrap().unwrap().state,
        ReceiptState::Confirmed
    );
    assert!(h.r.known_receipt_for(&id, Some(G1)).unwrap().is_none());
    assert_eq!(
        h.r.hosted_attachment_region_progress(a, &idle)
            .unwrap()
            .committed_chunks,
        0
    );
    assert!(h.r.store.pending_get(&idle).unwrap().is_none());
}

#[test]
fn held_other_grants_owned_reply_cannot_block_region_manifest_verify_capture() {
    let (mut h, _, _) = ready(None);
    let a = h.session(G1);
    let b = h.session(G2);
    let held_id = B16([0xd3; 16]);
    start(&mut h, a, "files/held.bin", held_id).unwrap();
    let held = h.r.take_log_calls();
    assert!(
        held.iter()
            .any(|c| matches!(c.request, LogRequest::PutObject { .. }))
    );
    let id =
        h.r.start_hosted_attachment_region_upload(b, named(0xd4))
            .unwrap();
    boundary(&mut h, b, id);
    h.r.commit_hosted_attachment_region_upload(b, &id).unwrap();
    h.pump();
    assert_eq!(
        h.r.known_receipt_for(&id, Some(G2)).unwrap().unwrap().state,
        ReceiptState::Confirmed
    );
    assert!(h.r.known_receipt_for(&held_id, Some(G1)).unwrap().is_none());
    assert!(h.r.store.pending_get(&held_id).unwrap().is_none());
}

#[test]
fn grant_budget_counts_sessions_and_terminal_slots_until_idle_eviction() {
    struct Unreadable;
    impl crate::replica::AttachmentSource for Unreadable {
        fn len(&self) -> u64 {
            3
        }
        fn read_at(&mut self, _: u64, _: &mut [u8]) -> Result<(), String> {
            Err("unreadable fixture".into())
        }
    }
    let (mut h, _, _) = ready(None);
    let a = h.session(G1);
    let another_session = h.session(G1);
    for (i, session) in [a, another_session].into_iter().enumerate() {
        let id = B16([0xe1 + i as u8; 16]);
        h.r.start_hosted_attachment_upload(
            session,
            format!("files/failed-{i}.bin"),
            id,
            Box::new(Unreadable),
        )
        .unwrap();
        assert!(matches!(
            h.r.attachment_upload_status(&id),
            Some(AttachmentUploadStatus::Failed(_))
        ));
    }
    let error =
        h.r.start_hosted_attachment_region_upload(a, named(0xe3))
            .unwrap_err();
    assert_eq!(
        error.problem().reason.as_deref(),
        Some("hosted_upload_budget")
    );
    // Authentication still precedes the capacity report.
    let error =
        h.r.start_hosted_attachment_region_upload(SessionId(99_999), named(0xe4))
            .unwrap_err();
    assert_ne!(
        error.problem().reason.as_deref(),
        Some("hosted_upload_budget")
    );
    let b = h.session(G2);
    assert!(
        h.r.start_hosted_attachment_region_upload(b, named(0xe5))
            .is_ok()
    );
    let now = h.clock.get();
    assert!(h.r.next_wakeup().unwrap() <= now as i64 + 60_000);
    h.clock.set(now + 60_000);
    h.r.tick();
    assert!(h.r.attachment_upload_status(&B16([0xe1; 16])).is_none());
    assert!(h.r.attachment_upload_status(&B16([0xe2; 16])).is_none());
    assert!(
        h.r.start_hosted_attachment_region_upload(a, named(0xe6))
            .is_ok()
    );
}

#[test]
fn collection_budget_is_bounded_across_distinct_grants_before_crypto_work() {
    let (mut h, svc, mut cp) = ready(None);
    let grants: Vec<_> = (0x70..0x78).map(|tag| B16([tag; 16])).collect();
    cp.append(
        &svc,
        grants
            .iter()
            .map(|grant| {
                mdbn_wire::policy::PolicyOp::Grant(mdbn_wire::policy::Grant {
                    grant: *grant,
                    installation: B16([0x56; 16]),
                    app_id: "app".into(),
                    account: TEST_OWNER,
                    capabilities: vec!["collection.read".into(), "records.create".into()],
                    client_pk: B32([grant.0[0]; 32]),
                    file_folders: None,
                    folder_scoped: None,
                })
            })
            .collect(),
    );
    h.pump();
    let mut tag = 0x20;
    for grant in grants {
        let session = h.session(grant);
        for _ in 0..2 {
            h.r.start_hosted_attachment_region_upload(session, named(tag))
                .unwrap();
            tag += 1;
        }
    }
    let a = h.session(G1);
    let error =
        h.r.start_hosted_attachment_region_upload(a, named(0x40))
            .unwrap_err();
    assert_eq!(
        error.problem().reason.as_deref(),
        Some("hosted_upload_budget")
    );
    assert!(
        h.r.take_log_calls()
            .iter()
            .all(|c| !matches!(c.request, LogRequest::PutObject { .. }))
    );
    assert_eq!(h.r.store.pending_count().unwrap(), 0);
}

#[test]
fn original_expiry_never_slides_at_chunk_boundary_or_readonly_probe() {
    let (mut h, _, _) = ready(None);
    let a = h.session(G1);
    let id =
        h.r.start_hosted_attachment_region_upload(a, named(0xe7))
            .unwrap();
    let initial =
        h.r.hosted_attachment_region_progress(a, &id)
            .unwrap()
            .expires_at_ms;
    let now = h.clock.get();
    h.clock.set(now + 10_000);
    boundary(&mut h, a, id);
    assert_eq!(
        h.r.hosted_attachment_region_progress(a, &id)
            .unwrap()
            .expires_at_ms,
        initial
    );
    // Status/recheck calls do not renew idle ownership.
    h.clock.set(now + 69_999);
    assert!(h.r.recheck_hosted_attachment_upload(a, &id).is_ok());
    h.clock.set(now + 70_000);
    assert_eq!(
        h.r.recheck_hosted_attachment_upload(a, &id)
            .unwrap_err()
            .problem()
            .reason
            .as_deref(),
        Some("attachment_upload_idle")
    );
    assert!(h.r.take_log_calls().is_empty());
    assert!(h.r.attachment_upload_status(&id).is_none());
}

#[test]
fn queued_expired_owned_put_is_retired_before_legacy_send_even_during_fault() {
    let (mut h, _, _) = ready(None);
    let a = h.session(G1);
    let id = B16([0xe8; 16]);
    start(&mut h, a, "files/late.bin", id).unwrap();
    h.clock.set(h.clock.get() + 60_000);
    h.r.apply_fault = true;
    h.r.tick();
    assert!(
        h.r.take_log_calls()
            .iter()
            .all(|c| !matches!(c.request, LogRequest::PutObject { .. }))
    );
    assert!(h.r.attachment_upload_status(&id).is_none());
    assert!(h.r.store.pending_get(&id).unwrap().is_none());
    assert!(h.r.known_receipt_for(&id, Some(G1)).unwrap().is_none());
}

#[test]
fn idle_authenticated_reply_is_retired_before_decoder_and_cannot_restore_progress() {
    let (mut h, _, _) = ready(None);
    let a = h.session(G1);
    let id =
        h.r.start_hosted_attachment_region_upload(a, named(0xe9))
            .unwrap();
    let mut region = vec![0; 9 << 20];
    region[..3].copy_from_slice(b"abc");
    let span =
        h.r.push_hosted_attachment_region_chunk(a, &id, &mut region, 3)
            .unwrap();
    store_chunk(&mut h, &region, &span);
    h.r.verify_hosted_attachment_region_chunk(a, &id).unwrap();
    let log_session =
        h.r.bind_authenticated_log(crate::log::EndpointId(1), COL)
            .unwrap();
    let scoped = h.r.take_authenticated_log_calls(&log_session).unwrap();
    let (_, scope) = scoped
        .into_iter()
        .find(|(call, _)| matches!(call.request, LogRequest::HasObjects { .. }))
        .unwrap();
    h.clock.set(h.clock.get() + 60_000);
    let result = h.r.on_authenticated_log_reply(scope, |_, _| {
        panic!("expired native upload must not decode a late reply")
    });
    assert_eq!(result, Err(crate::replica::LogSessionError::Stale));
    assert!(h.r.hosted_attachment_region_progress(a, &id).is_err());
    assert!(h.r.store.pending_get(&id).unwrap().is_none());
    assert!(h.r.known_receipt_for(&id, Some(G1)).unwrap().is_none());
}
