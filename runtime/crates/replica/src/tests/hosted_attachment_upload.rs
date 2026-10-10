//! Native delegated CREATE qualification; FakeLog is not provider/Noise proof.
use super::*;
use crate::replica::AttachmentUploadStatus;

#[path = "hosted_attachment_upload/fairness.rs"]
mod fairness;
#[path = "hosted_attachment_upload/region_upload.rs"]
mod region_upload;
#[path = "hosted_attachment_upload/session_binding.rs"]
mod session_binding;

struct BytesSource(Vec<u8>);
impl crate::replica::AttachmentSource for BytesSource {
    fn len(&self) -> u64 {
        self.0.len() as u64
    }
    fn read_at(&mut self, offset: u64, output: &mut [u8]) -> Result<(), String> {
        let offset = offset as usize;
        output.copy_from_slice(&self.0[offset..offset + output.len()]);
        Ok(())
    }
}

fn ready(folders: Option<Vec<String>>) -> (Hosted, FakeLogService, TestControlPlane) {
    let (svc, mut cp) = crypto_world();
    crypto_wrap(&svc, OWNER_DEV);
    for grant in [G1, G2] {
        cp.append(
            &svc,
            vec![mdbn_wire::policy::PolicyOp::Grant(
                mdbn_wire::policy::Grant {
                    grant,
                    installation: B16([0x56; 16]),
                    app_id: "app".into(),
                    account: TEST_OWNER,
                    capabilities: vec!["collection.read".into(), "records.create".into()],
                    client_pk: mdbn_wire::common::B32([grant.0[0]; 32]),
                    file_folders: folders.clone(),
                    folder_scoped: folders.as_ref().map(|_| true),
                },
            )],
        );
    }
    let mut h = crypto_open(&svc, MemStore::new());
    h.r.planner = Box::new(crate::plan::CorePlanner);
    h.pump();
    verified(&h);
    (h, svc, cp)
}

fn start(h: &mut Hosted, session: SessionId, path: &str, id: B16) -> crate::api::ApiResult<B16> {
    h.r.start_hosted_attachment_upload(
        session,
        path.into(),
        id,
        Box::new(BytesSource(vec![0x41; 1234])),
    )
}

#[test]
fn delegated_create_carries_grant_and_owner_receipt() {
    let (mut h, _svc, _cp) = ready(None);
    let session = h.session(G1);
    let id = B16([0xb1; 16]);
    start(&mut h, session, "files/new.bin", id).unwrap();
    let mut captured = false;
    for _ in 0..8 {
        let calls = h.r.take_log_calls();
        for call in calls {
            if matches!(call.request, LogRequest::Append(_)) {
                let pending = h.r.store.pending_get(&id).unwrap().unwrap();
                assert_eq!(pending.grant, Some(G1));
                assert_eq!(pending.mutation.on_behalf, Some(G1));
                let mdbn_wire::attachment_runtime_v1::Op::FileAttach(file) =
                    &pending.mutation.ops[0]
                else {
                    panic!("expected FileAttach")
                };
                assert_ne!(
                    file.id, id,
                    "file identity is server-owned, not the caller mutation"
                );
                assert!(file.if_revision.is_none() && file.base.is_none());
                captured = true;
            }
            let reply = h.log.call(call.request);
            h.r.on_log_reply(call.id, reply);
        }
    }
    assert!(captured);
    h.pump();
    let status = h.r.attachment_upload_status(&id).unwrap();
    assert!(
        matches!(status, AttachmentUploadStatus::Captured(_)),
        "{status:?}"
    );
    assert!(h.r.known_receipt_for(&id, Some(G1)).unwrap().is_some());
    assert!(h.r.known_receipt_for(&id, Some(G2)).unwrap().is_none());
    // The ACK barrier may already have removed pending; inspect the signed log.
    let receipt = h.r.known_receipt_for(&id, Some(G1)).unwrap().unwrap();
    assert_eq!(receipt.state, ReceiptState::Confirmed);
}

#[test]
fn delegated_create_pending_empty_effects_reserves_canonical_destination() {
    let (mut h, _svc, _cp) = ready(None);
    let session_a = h.session(G1);
    let session_b = h.session(G2);
    let a = B16([0xba; 16]);
    let b = B16([0xbb; 16]);
    // Genuine uploads, both authorized before either destination is captured.
    start(&mut h, session_a, "files/pending.bin", a).unwrap();
    start(&mut h, session_b, "FILES/PENDING.BIN", b).unwrap();
    let mut held = Vec::new();
    for _ in 0..16 {
        let calls = h.r.take_log_calls();
        if calls.is_empty() {
            break;
        }
        for call in calls {
            if matches!(call.request, LogRequest::Append(_)) {
                held.push(call);
            } else {
                let reply = h.log.call(call.request);
                h.r.on_log_reply(call.id, reply);
            }
        }
    }
    assert_eq!(
        held.len(),
        1,
        "first Append must be held before confirmation"
    );
    let pending = h.r.store.pending_get(&a).unwrap().unwrap();
    assert!(
        pending.effects.is_empty(),
        "exercise genuine FileAttach empty effects"
    );
    assert_eq!(pending.grant, Some(G1));
    let view = crate::plan::StoreView::new(&h.r.store, h.r.catalog.clone());
    let layer = crate::layer::LayerView {
        base: &view,
        layer: &h.r.layer,
    };
    assert!(
        layer
            .at_path_key(&mdbn_core::paths::path_key("files/pending.bin"))
            .is_none(),
        "Layer must not manufacture the pending attachment holder"
    );
    let status = h.r.attachment_upload_status(&b).unwrap();
    let AttachmentUploadStatus::Failed(problem) = status else {
        panic!("second upload captured: {status:?}")
    };
    assert_eq!(
        problem.reason.as_deref(),
        Some("attachment_replace_requires_op18")
    );
    assert!(h.r.store.pending_get(&b).unwrap().is_none());
    assert!(h.r.known_receipt_for(&b, Some(G2)).unwrap().is_none());
    assert_eq!(h.r.store.pending_count().unwrap(), 1);
    // Rebuilding a view with empty effects must retain its path reservation.
    h.r.rebuild_local_view(&std::collections::BTreeSet::new())
        .unwrap();
    let error = start(&mut h, session_b, "files/pending.bin", B16([0xbc; 16])).unwrap_err();
    assert_eq!(
        error.into_problem().reason.as_deref(),
        Some("attachment_replace_requires_op18")
    );
    for call in held {
        let reply = h.log.call(call.request);
        h.r.on_log_reply(call.id, reply);
    }
    h.pump();
    assert_eq!(
        h.r.known_receipt_for(&a, Some(G1)).unwrap().unwrap().state,
        ReceiptState::Confirmed
    );
}

#[test]
fn delegation_requires_current_grant_client_and_folder() {
    let (mut h, _svc, _cp) = ready(Some(vec!["allowed".into()]));
    let session = h.session(G1);
    let error = start(&mut h, session, "outside/new.bin", B16([0xb2; 16])).unwrap_err();
    assert_eq!(error.code(), Some(ErrorCode::Forbidden));
    let host = h.r.hello(SessionAuth::Host, hello()).unwrap().0;
    assert_eq!(
        start(&mut h, host, "allowed/new.bin", B16([0xb3; 16]))
            .unwrap_err()
            .code(),
        Some(ErrorCode::Forbidden)
    );
    let bad = h.r.hello(
        SessionAuth::Grant {
            grant: G1,
            client_pk: [9; 32],
        },
        hello(),
    );
    assert!(bad.is_err());
}

#[test]
fn delegated_create_rechecks_revocation_after_object_await() {
    use mdbn_wire::policy::{GrantRevoke, PolicyOp};
    let (mut h, svc, mut cp) = ready(None);
    let session = h.session(G1);
    let id = B16([0xb4; 16]);
    start(&mut h, session, "files/new.bin", id).unwrap();
    let held = h.r.take_log_calls();
    assert!(
        held.iter()
            .any(|call| matches!(call.request, LogRequest::PutObject { .. }))
    );
    cp.append(&svc, vec![PolicyOp::GrantRevoke(GrantRevoke { grant: G1 })]);
    h.pump();
    for call in held {
        let reply = h.log.call(call.request);
        h.r.on_log_reply(call.id, reply);
    }
    h.pump();
    assert!(matches!(
        h.r.attachment_upload_status(&id),
        Some(AttachmentUploadStatus::Failed(_))
    ));
    assert!(h.r.known_receipt_for(&id, Some(G1)).unwrap().is_none());
}

#[test]
fn delegated_create_rechecks_concurrent_destination_holder() {
    let (mut h, _svc, _cp) = ready(None);
    let session = h.session(G1);
    let id = B16([0xb5; 16]);
    start(&mut h, session, "files/new.bin", id).unwrap();
    let held = h.r.take_log_calls();
    let view = crate::plan::StoreView::new(&h.r.store, h.r.catalog.clone());
    h.r.layer.apply_effect(
        &view,
        &Effect::PutFile {
            id: crate::convert::uuid(&B16([0x77; 16])),
            path: "FILES/NEW.BIN".into(),
            blob: mdbn_core::intent::BlobRef {
                plain_hash: mdbn_core::ids::Hash([8; 32]),
                size: 1,
                blob_id: [9; 32],
                id_epoch: 1,
                part_size: 1,
            },
        },
    );
    for call in held {
        let reply = h.log.call(call.request);
        h.r.on_log_reply(call.id, reply);
    }
    let status = h.r.attachment_upload_status(&id).unwrap();
    let AttachmentUploadStatus::Failed(problem) = status else {
        panic!("{status:?}")
    };
    assert_eq!(
        problem.reason.as_deref(),
        Some("attachment_replace_requires_op18")
    );
    assert!(h.r.known_receipt_for(&id, Some(G1)).unwrap().is_none());
}

#[test]
fn delegated_create_ls_quota_refusal_never_captures() {
    let (mut h, _svc, _cp) = ready(None);
    let session = h.session(G1);
    let id = B16([0xb6; 16]);
    start(&mut h, session, "files/quota.bin", id).unwrap();
    let calls = h.r.take_log_calls();
    let mut put = 0;
    for call in calls {
        let reply = if matches!(call.request, LogRequest::PutObject { .. }) {
            put += 1;
            Err(crate::log::LogError::code(
                crate::log::LogErrorCode::QuotaExceeded,
            ))
        } else {
            h.log.call(call.request)
        };
        h.r.on_log_reply(call.id, reply);
    }
    assert_eq!(put, 1);
    h.pump();
    let status = h.r.attachment_upload_status(&id).unwrap();
    let AttachmentUploadStatus::Failed(problem) = status else {
        panic!("{status:?}")
    };
    assert_eq!(problem.code, "quota_exceeded");
    assert!(h.r.known_receipt_for(&id, Some(G1)).unwrap().is_none());
    assert!(
        !h.r.take_log_calls()
            .iter()
            .any(|c| matches!(c.request, LogRequest::PutObject { .. }))
    );
}

#[test]
fn delegated_create_capture_store_fault_is_terminal() {
    let (mut h, _svc, _cp) = ready(None);
    let session = h.session(G1);
    let id = B16([0xb8; 16]);
    start(&mut h, session, "files/fault.bin", id).unwrap();
    assert!(
        h.r.attachment_upload_checkpoint(&id).is_none(),
        "no device-local checkpoint in DO"
    );
    let mut faulted = false;
    for _ in 0..8 {
        let calls = h.r.take_log_calls();
        for call in calls {
            if matches!(&call.request, LogRequest::HasObjects { addresses, .. } if addresses.len() > 1)
            {
                // HostedCache cannot certify its composite RAM/inner-store
                // transaction from an inner abort, so it fences this as Io.
                h.r.store.inner().fail_commits(1);
                faulted = true;
            }
            let reply = h.log.call(call.request);
            h.r.on_log_reply(call.id, reply);
        }
        if faulted {
            break;
        }
    }
    assert!(faulted);
    assert!(h.r.requires_reopen());
    assert!(h.r.sessions.is_empty());
    assert!(matches!(
        h.r.attachment_upload_status(&id),
        Some(AttachmentUploadStatus::Failed(_))
    ));
    assert!(h.r.take_log_calls().is_empty());
    assert!(h.r.known_receipt_for(&id, Some(G1)).unwrap().is_none());
}

#[test]
fn delegated_create_closed_session_never_finishes_after_await() {
    let (mut h, _svc, _cp) = ready(None);
    let session = h.session(G1);
    let id = B16([0xb7; 16]);
    start(&mut h, session, "files/closed.bin", id).unwrap();
    let calls = h.r.take_log_calls();
    h.r.sessions.remove(&session);
    for call in calls {
        let reply = h.log.call(call.request);
        h.r.on_log_reply(call.id, reply);
    }
    h.pump();
    assert!(matches!(
        h.r.attachment_upload_status(&id),
        Some(AttachmentUploadStatus::Failed(_))
    ));
    assert!(h.r.known_receipt_for(&id, Some(G1)).unwrap().is_none());
}
