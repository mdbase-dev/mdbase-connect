//! One native region writer: real attachment crypto, synthetic policy/LS fixtures.
use super::*;
use crate::HostedAttachmentTransferParams;
use crate::api::{ClientApi, SessionAuth};
use crate::crypto::chunked_blob::upload_resume::{UploadResumeOwner, UploadResumeRefV1};
use crate::log::LogResponse;
use mdbn_wire::client::HelloParams;
use mdbn_wire::common::Version;

fn params() -> HostedAttachmentTransferParams {
    HostedAttachmentTransferParams {
        transfer: B16([0x79; 16]),
        path: "files/native-region.bin".into(),
        size: 31,
        digest: Some(mdbn_wire::hash::sha256(&[0x41; 31])),
        mutation: Some(B16([0x78; 16])),
        replace: None,
    }
}
fn hello() -> HelloParams {
    HelloParams {
        versions: vec![Version { major: 1, minor: 1 }],
        client_name: "region".into(),
        client_version: "1".into(),
        features: None,
        timezone: None,
    }
}
fn stage(
    a: &mut Node,
    session: crate::api::SessionId,
    mutation: Uuid,
) -> (UploadResumeRefV1, Vec<u8>, Vec<u8>) {
    let mut region = vec![0xcd; 9 << 20];
    region[..31].fill(0x41);
    let span =
        a.r.push_attachment_region_chunk(session, &mutation, &mut region, 31)
            .unwrap();
    assert_eq!(
        a.r.attachment_region_progress(session, &mutation)
            .unwrap()
            .committed_chunks,
        0
    );
    assert!(
        a.r.commit_attachment_region_upload(session, &mutation)
            .is_err()
    );
    let chunk = region[span.range()].to_vec();
    let reply = a.log.call(LogRequest::PutObject {
        collection: COL,
        address: span.cipher_hash(),
        kind: mdbn_wire::envelope::ItemKind::BlobPart,
        bytes: chunk.clone(),
    });
    assert!(matches!(reply, Ok(LogResponse::PutObject { .. })));
    a.r.verify_attachment_region_chunk(session, &mutation)
        .unwrap();
    let mut metadata = None;
    drive(a, &Rc::default(), &mut |request, _| {
        if let LogRequest::PutObject { bytes, .. } = request {
            assert!(
                bytes.len() < 64 << 10,
                "no file body copied into native metadata queue"
            );
            metadata = Some(bytes.clone());
        }
        None
    });
    let progress = a.r.attachment_region_progress(session, &mutation).unwrap();
    assert_eq!(progress.committed_chunks, 1);
    (progress.checkpoint.unwrap(), metadata.unwrap(), chunk)
}

fn open_params(size: u64) -> mdbn_wire::client::OpenUploadParams {
    let p = params();
    mdbn_wire::client::OpenUploadParams {
        transfer: p.transfer,
        path: p.path,
        size,
        digest: None,
        file_id: None,
        if_revision: None,
        mutation_id: p.mutation,
    }
}

fn open_client(
    a: &mut Node,
    session: crate::api::SessionId,
    size: u64,
) -> mdbn_wire::client::OpenUploadResult {
    assert_eq!(
        a.r.open_upload(session, open_params(size))
            .unwrap_err()
            .into_problem()
            .reason
            .as_deref(),
        Some("file_upload_pending")
    );
    drive(a, &Rc::default(), &mut |_, _| None);
    a.r.open_upload(session, open_params(size)).unwrap()
}

#[test]
fn client_api_open_exposes_native_uuid_before_input_and_chunk_uses_native_ls() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let session = a.s;
    let opened = open_client(&mut a, session, 31);
    assert_eq!(opened.chunk_size, 1 << 20);
    assert!(opened.received.is_empty());
    assert!(
        a.r.store()
            .file(&opened.file_id.unwrap())
            .unwrap()
            .is_none()
    );
    assert!(a.r.take_log_calls().is_empty());
    assert_eq!(
        a.r.upload_chunk(
            session,
            mdbn_wire::client::UploadChunkParams {
                transfer: opened.transfer,
                index: 0,
                bytes: mdbn_wire::common::Bytes(vec![0x41; 31])
            }
        )
        .unwrap(),
        31
    );
    drive(&mut a, &Rc::default(), &mut |_, _| None);
    let mutation = params().mutation.unwrap();
    a.r.commit_attachment_region_upload(session, &mutation)
        .unwrap();
    drive(&mut a, &Rc::default(), &mut |_, _| None);
    let (entry, _) = last_entry(&a, &svc);
    let rt::Op::FileAttach(op) = &entry.mutation.ops[0] else {
        panic!("attachment")
    };
    assert_eq!(Some(op.id), opened.file_id);
    assert_eq!(op.mtime, Some(entry.mutation.clock.instant));
    let view =
        a.r.get_file(session, crate::api::Target::Id(op.id))
            .unwrap();
    assert_eq!(view.mtime, op.mtime);
    assert_eq!(a.r.store().file(&op.id).unwrap().unwrap().mtime, op.mtime);
    a.r.abort_upload(session, opened.transfer).unwrap();
    assert!(a.r.test_attachment_read_region().held_lease().is_none());
    assert_eq!(
        a.r.store().pending_count().unwrap(),
        0,
        "captured mutation was confirmed, not withdrawn"
    );
}

#[test]
fn native_capture_mtime_survives_move_snapshot_and_fresh_replica_replay() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let session = a.s;
    let opened = open_client(&mut a, session, 0);
    let mut actual = None;
    for _ in 0..8 {
        match a.r.commit_upload(session, opened.transfer) {
            Ok(receipt) => {
                actual = Some(receipt);
                break;
            }
            Err(error) => assert_eq!(
                error.into_problem().reason.as_deref(),
                Some("file_upload_pending")
            ),
        }
        drive(&mut a, &Rc::default(), &mut |_, _| None);
    }
    assert_eq!(actual.unwrap().mutation, params().mutation.unwrap());
    drive(&mut a, &Rc::default(), &mut |_, _| None);
    let (entry, _) = last_entry(&a, &svc);
    let file = opened.file_id.unwrap();
    let captured = Some(entry.mutation.clock.instant);
    let before = a.r.get_file(session, crate::api::Target::Id(file)).unwrap();
    assert_eq!(before.mtime, captured);
    a.r.abort_upload(session, opened.transfer).unwrap();
    a.clock.set(a.clock.get() + 1_234);
    a.r.submit(
        session,
        mdbn_wire::client::SubmitParams {
            ops: vec![mdbn_wire::intent::Op::FileMove(
                mdbn_wire::intent::FileMove {
                    id: file,
                    from: before.path.clone(),
                    update_refs: false,
                    to: "files/native-renamed.bin".into(),
                    if_revision: Some(before.digest),
                },
            )],
            mutation_id: Some(B16([0x77; 16])),
            conflict_mode: None,
            timezone: None,
            allow_partial: None,
            mutation_ids: None,
            dry_run: None,
            include: None,
            wait: None,
        },
    )
    .unwrap();
    drive(&mut a, &Rc::default(), &mut |_, _| None);
    let moved = a.r.get_file(session, crate::api::Target::Id(file)).unwrap();
    assert_eq!(moved.path, "files/native-renamed.bin");
    assert_eq!(moved.mtime, captured);
    assert!(moved.confirmed_seq > before.confirmed_seq);
    a.r.build_snapshot_now().unwrap();
    drive(&mut a, &Rc::default(), &mut |_, _| None);
    assert!(a.r.stats.snapshots_built > 0);
    svc.compact(&COL, a.r.head().seq);
    let mut fresh = attach_node(&svc, 2);
    let replayed = fresh
        .r
        .get_file(fresh.s, crate::api::Target::Id(file))
        .unwrap();
    assert_eq!(replayed.mtime, captured);
    assert_eq!(replayed.path, moved.path);
    assert_eq!(replayed.digest, moved.digest);
    assert!(
        fresh.r.stats.snapshots_installed > 0,
        "exercise actual snapshot install, not only log replay"
    );
}

#[test]
fn client_api_fragments_are_bounded_retried_and_out_of_order_within_one_window() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let session = a.s;
    let opened = open_client(&mut a, session, 2 << 20);
    let fragment = |index, byte| mdbn_wire::client::UploadChunkParams {
        transfer: opened.transfer,
        index,
        bytes: mdbn_wire::common::Bytes(vec![byte; 1 << 20]),
    };
    assert_eq!(a.r.upload_chunk(session, fragment(1, 2)).unwrap(), 1 << 20);
    assert_eq!(a.r.upload_chunk(session, fragment(1, 2)).unwrap(), 1 << 20);
    assert!(a.r.upload_chunk(session, fragment(1, 3)).is_err());
    assert!(
        a.r.take_log_calls().is_empty(),
        "partial window is never staged"
    );
    assert_eq!(a.r.upload_chunk(session, fragment(0, 1)).unwrap(), 2 << 20);
    assert_eq!(
        a.r.take_log_calls().len(),
        1,
        "only one bounded cipher object is staged"
    );
    a.r.close(session);
    assert!(a.r.test_attachment_read_region().held_lease().is_none());
    assert_eq!(a.r.store().pending_count().unwrap(), 0);
}

#[test]
fn client_api_partial_plaintext_lease_is_released_on_current_authority_loss() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let session = a.s;
    let opened = open_client(&mut a, session, 2 << 20);
    a.r.upload_chunk(
        session,
        mdbn_wire::client::UploadChunkParams {
            transfer: opened.transfer,
            index: 0,
            bytes: mdbn_wire::common::Bytes(vec![0x41; 1 << 20]),
        },
    )
    .unwrap();
    let lease = a.r.test_attachment_read_region().held_lease().unwrap();
    let account = a.r.policy.devices[&a.r.cfg.device_id].account;
    a.r.policy
        .members
        .insert(account, mdbn_wire::policy::Role::Viewer);
    a.r.client_file_read_step();
    assert!(!a.r.test_attachment_read_region().owns(lease));
    assert!(a.r.take_log_calls().is_empty());
    assert_eq!(a.r.store().pending_count().unwrap(), 0);
}

#[test]
fn native_ls_region_put_requires_probe_and_known_journal_before_progress() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let session = a.s;
    let (mutation, file) =
        a.r.start_attachment_region_upload(session, params())
            .unwrap();
    let mut region = vec![0xcd; 9 << 20];
    region[..31].fill(0x41);
    let span =
        a.r.push_attachment_region_chunk(session, &mutation, &mut region, 31)
            .unwrap();
    a.r.put_attachment_region_chunk(session, &mutation, &mut region, span)
        .unwrap();
    assert!(region.iter().all(|b| *b == 0));
    assert_eq!(
        a.r.attachment_region_progress(session, &mutation)
            .unwrap()
            .committed_chunks,
        0
    );
    assert!(
        a.r.commit_attachment_region_upload(session, &mutation)
            .is_err()
    );
    let mut requests = Vec::new();
    drive(&mut a, &Rc::default(), &mut |request, _| {
        requests.push(request.clone());
        None
    });
    assert!(matches!(
        requests.first(),
        Some(LogRequest::PutObject { .. })
    ));
    assert!(matches!(
        requests.get(1),
        Some(LogRequest::HasObjects { .. })
    ));
    assert!(matches!(
        requests.get(2),
        Some(LogRequest::PutObject { .. })
    ));
    assert_eq!(
        a.r.attachment_region_progress(session, &mutation)
            .unwrap()
            .committed_chunks,
        1
    );
    a.r.commit_attachment_region_upload(session, &mutation)
        .unwrap();
    drive(&mut a, &Rc::default(), &mut |_, _| None);
    let (entry, _) = last_entry(&a, &svc);
    let rt::Op::FileAttach(op) = &entry.mutation.ops[0] else {
        panic!("attachment")
    };
    assert_eq!(op.id, file);
}

#[test]
fn native_ls_region_staging_refuses_tamper_and_foreign_session_then_wipes() {
    for foreign in [false, true] {
        let svc = FakeLogService::new();
        let mut a = attach_node(&svc, 1);
        let session = a.s;
        let (mutation, _) =
            a.r.start_attachment_region_upload(session, params())
                .unwrap();
        let mut region = vec![0xcd; 9 << 20];
        region[..31].fill(0x41);
        let span =
            a.r.push_attachment_region_chunk(session, &mutation, &mut region, 31)
                .unwrap();
        let caller = if foreign {
            a.r.hello(SessionAuth::Host, hello()).unwrap().0
        } else {
            region[span.range().start] ^= 1;
            session
        };
        assert!(
            a.r.put_attachment_region_chunk(caller, &mutation, &mut region, span)
                .is_err()
        );
        assert!(region.iter().all(|b| *b == 0));
        assert!(a.r.take_log_calls().is_empty());
        assert_eq!(
            a.r.attachment_region_progress(session, &mutation)
                .unwrap()
                .committed_chunks,
            0
        );
    }
}

#[test]
fn host_region_exposes_original_uuid_before_input_and_commits_without_fake_grant() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let session = a.s;
    let p = params();
    let (mutation, file) =
        a.r.start_attachment_region_upload(session, p.clone())
            .unwrap();
    assert!(a.r.take_log_calls().is_empty());
    assert!(a.r.store().file(&file).unwrap().is_none());
    let (reference, mut metadata, _) = stage(&mut a, session, mutation);
    let owner = UploadResumeOwner::HostV2 {
        device: a.r.cfg.device_id,
        account: a.r.policy.devices[&a.r.cfg.device_id].account,
        transfer: p.transfer,
    };
    let auth =
        a.r.sealer
            .open_hosted_upload_resume(&reference, owner, &mut metadata)
            .unwrap();
    assert_eq!(auth.metadata().file, file);
    assert_eq!(auth.metadata().owner, owner);
    assert!(metadata.iter().all(|b| *b == 0));
    a.r.commit_attachment_region_upload(session, &mutation)
        .unwrap();
    drive(&mut a, &Rc::default(), &mut |_, _| None);
    assert!(matches!(
        status(&a, &mutation),
        AttachmentUploadStatus::Captured(_)
    ));
    let (entry, _) = last_entry(&a, &svc);
    assert_eq!(entry.mutation.on_behalf, None);
    let rt::Op::FileAttach(op) = &entry.mutation.ops[0] else {
        panic!("attachment")
    };
    assert_eq!(op.id, file);
}

#[test]
fn host_region_cold_resume_authenticates_prefix_and_reuses_original_native_uuid() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let session = a.s;
    let (mutation, file) =
        a.r.start_attachment_region_upload(session, params())
            .unwrap();
    let (reference, metadata, mut chunk) = stage(&mut a, session, mutation);
    let store = a.r.into_store();
    let mut cold = attach_node_with(&svc, 1, store);
    let session = cold.s;
    let mut supplied = metadata;
    let (resumed, original) = cold
        .r
        .resume_attachment_region_upload(session, params(), reference, &mut supplied)
        .unwrap();
    assert_eq!((resumed, original), (mutation, file));
    assert!(supplied.iter().all(|b| *b == 0));
    assert!(
        cold.r
            .commit_attachment_region_upload(session, &mutation)
            .is_err()
    );
    assert!(
        cold.r
            .attachment_rehash_need(session, &mutation)
            .unwrap()
            .is_some()
    );
    cold.r
        .supply_attachment_rehash(session, &mutation, 0, &mut chunk)
        .unwrap();
    assert!(chunk.iter().all(|b| *b == 0));
    assert!(
        cold.r
            .attachment_rehash_need(session, &mutation)
            .unwrap()
            .is_none()
    );
    cold.r
        .commit_attachment_region_upload(session, &mutation)
        .unwrap();
    drive(&mut cold, &Rc::default(), &mut |_, _| None);
    assert!(matches!(
        status(&cold, &mutation),
        AttachmentUploadStatus::Captured(_)
    ));
    assert!(cold.r.store().file(&file).unwrap().is_some());
}

#[test]
fn device_grant_region_preserves_current_folder_scope_and_real_receipt_owner() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let grant = B16([0x76; 16]);
    let pk = [0x77; 32];
    let mut cp = crate::testkit::TestControlPlane::new(COL);
    cp.approved_grant(
        &svc,
        grant,
        pk,
        &["collection.read", "records.create"],
        Some(vec!["files".into()]),
        B16([104; 16]),
    );
    settle(&mut [&mut a]);
    let (session, _) =
        a.r.hello(
            SessionAuth::Grant {
                grant,
                client_pk: pk,
            },
            hello(),
        )
        .unwrap();
    let mut denied = params();
    denied.path = "private/x.bin".into();
    assert!(a.r.start_attachment_region_upload(session, denied).is_err());
    let (mutation, file) =
        a.r.start_attachment_region_upload(session, params())
            .unwrap();
    stage(&mut a, session, mutation);
    a.r.commit_attachment_region_upload(session, &mutation)
        .unwrap();
    drive(&mut a, &Rc::default(), &mut |_, _| None);
    let (entry, _) = last_entry(&a, &svc);
    assert_eq!(entry.mutation.on_behalf, Some(grant));
    let rt::Op::FileAttach(op) = &entry.mutation.ops[0] else {
        panic!("attachment")
    };
    assert_eq!(op.id, file);
}

#[test]
fn native_region_rechecks_epoch_store_generation_and_viewer_before_seal() {
    for fence in 0..3 {
        let svc = FakeLogService::new();
        let mut a = attach_node(&svc, 1);
        let session = a.s;
        let (mutation, _) =
            a.r.start_attachment_region_upload(session, params())
                .unwrap();
        match fence {
            0 => a.r.policy.epoch += 1,
            1 => a.r.store_generation += 1,
            _ => {
                let account = a.r.policy.devices[&a.r.cfg.device_id].account;
                a.r.policy
                    .members
                    .insert(account, mdbn_wire::policy::Role::Viewer);
            }
        }
        let mut region = vec![0xcd; 9 << 20];
        assert!(
            a.r.push_attachment_region_chunk(session, &mutation, &mut region, 31)
                .is_err()
        );
        assert!(region.iter().all(|b| *b == 0));
        assert!(svc.objects(&COL).is_empty());
        assert_eq!(a.r.store().pending_count().unwrap(), 0);
    }
}

#[test]
fn native_region_viewer_loss_after_object_await_cannot_certify_journal_or_capture() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let session = a.s;
    let (mutation, _) =
        a.r.start_attachment_region_upload(session, params())
            .unwrap();
    let mut region = vec![0xcd; 9 << 20];
    region[..31].fill(0x41);
    let span =
        a.r.push_attachment_region_chunk(session, &mutation, &mut region, 31)
            .unwrap();
    let reply = a.log.call(LogRequest::PutObject {
        collection: COL,
        address: span.cipher_hash(),
        kind: mdbn_wire::envelope::ItemKind::BlobPart,
        bytes: region[span.range()].to_vec(),
    });
    assert!(matches!(reply, Ok(LogResponse::PutObject { .. })));
    a.r.verify_attachment_region_chunk(session, &mutation)
        .unwrap();
    let account = a.r.policy.devices[&a.r.cfg.device_id].account;
    a.r.policy
        .members
        .insert(account, mdbn_wire::policy::Role::Viewer);
    drive(&mut a, &Rc::default(), &mut |_, _| None);
    assert!(matches!(
        status(&a, &mutation),
        AttachmentUploadStatus::Failed(_)
    ));
    assert_eq!(a.r.store().pending_count().unwrap(), 0);
    assert!(
        a.r.commit_attachment_region_upload(session, &mutation)
            .is_err()
    );
}

#[test]
fn device_region_scope_and_hosted_namespace_refusals_wipe_without_progress() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let session = a.s;
    assert!(
        a.r.start_hosted_attachment_region_upload(session, params())
            .is_err()
    );
    let (mutation, _) =
        a.r.start_attachment_region_upload(session, params())
            .unwrap();
    let mut region = vec![0xcd; 9 << 20];
    assert!(
        a.r.push_hosted_attachment_region_chunk(session, &mutation, &mut region, 31)
            .is_err()
    );
    assert!(region.iter().all(|b| *b == 0));
    let (other, _) = a.r.hello(SessionAuth::Host, hello()).unwrap();
    region.fill(0xcd);
    assert!(
        a.r.push_attachment_region_chunk(other, &mutation, &mut region, 31)
            .is_err()
    );
    assert!(region.iter().all(|b| *b == 0));
    assert_eq!(
        a.r.attachment_region_progress(session, &mutation)
            .unwrap()
            .committed_chunks,
        0
    );
    a.r.close(session);
    region.fill(0xcd);
    assert!(
        a.r.push_attachment_region_chunk(session, &mutation, &mut region, 31)
            .is_err()
    );
    assert!(region.iter().all(|b| *b == 0));
    assert_eq!(a.r.store().pending_count().unwrap(), 0);
}

fn commit_client(a: &mut Node, session: crate::api::SessionId, transfer: Uuid) {
    for _ in 0..8 {
        match a.r.commit_upload(session, transfer) {
            Ok(_) => break,
            Err(error) => assert_eq!(
                error.into_problem().reason.as_deref(),
                Some("file_upload_pending")
            ),
        }
        drive(a, &Rc::default(), &mut |_, _| None);
    }
    drive(a, &Rc::default(), &mut |_, _| None);
    a.r.abort_upload(session, transfer).unwrap();
}

#[test]
fn client_open_upload_replaces_a_live_file_under_revision_cas() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let session = a.s;
    let opened = open_client(&mut a, session, 31);
    a.r.upload_chunk(
        session,
        mdbn_wire::client::UploadChunkParams {
            transfer: opened.transfer,
            index: 0,
            bytes: mdbn_wire::common::Bytes(vec![0x41; 31]),
        },
    )
    .unwrap();
    commit_client(&mut a, session, opened.transfer);
    let file = opened.file_id.unwrap();
    let before = a.r.get_file(session, crate::api::Target::Id(file)).unwrap();

    let replace = |if_revision| mdbn_wire::client::OpenUploadParams {
        transfer: B16([0x7c; 16]),
        mutation_id: Some(B16([0x7d; 16])),
        size: 5,
        file_id: Some(file),
        if_revision,
        ..open_params(5)
    };
    let open = |a: &mut Node, p: mdbn_wire::client::OpenUploadParams| {
        for _ in 0..4 {
            match a.r.open_upload(session, p.clone()) {
                Err(e) if e.problem().reason.as_deref() == Some("file_upload_pending") => {
                    drive(a, &Rc::default(), &mut |_, _| None);
                }
                other => return other,
            }
        }
        a.r.open_upload(session, p)
    };
    let reason = |a: &mut Node, p| open(a, p).unwrap_err().into_problem().reason;
    assert_eq!(
        reason(&mut a, replace(None)).as_deref(),
        Some("attachment_replace_requires_revision")
    );
    let stale = mdbn_wire::hash::sha256(b"stale");
    assert_eq!(
        reason(&mut a, replace(Some(stale))).as_deref(),
        Some("revision")
    );
    // A create-only grant cannot replace.
    let mut cp = crate::testkit::TestControlPlane::new(COL);
    let (grant, pk) = (B16([0x75; 16]), [0x74; 32]);
    cp.approved_grant(
        &svc,
        grant,
        pk,
        &["collection.read", "records.create"],
        None,
        B16([101; 16]),
    );
    settle(&mut [&mut a]);
    let (create_only, _) =
        a.r.hello(
            SessionAuth::Grant {
                grant,
                client_pk: pk,
            },
            hello(),
        )
        .unwrap();
    assert_eq!(
        a.r.open_upload(create_only, replace(Some(before.digest)))
            .unwrap_err()
            .into_problem()
            .code,
        "forbidden"
    );
    let mut moved = replace(Some(before.digest));
    moved.path = "files/elsewhere.bin".into();
    assert_eq!(
        reason(&mut a, moved).as_deref(),
        Some("attachment_replace_target_changed")
    );

    let reopened = open(&mut a, replace(Some(before.digest))).unwrap();
    assert_eq!(reopened.file_id, Some(file));
    a.r.upload_chunk(
        session,
        mdbn_wire::client::UploadChunkParams {
            transfer: reopened.transfer,
            index: 0,
            bytes: mdbn_wire::common::Bytes(b"fresh".to_vec()),
        },
    )
    .unwrap();
    commit_client(&mut a, session, reopened.transfer);
    let (entry, _) = last_entry(&a, &svc);
    let rt::Op::FileAttach(op) = &entry.mutation.ops[0] else {
        panic!("attachment")
    };
    assert_eq!(op.id, file);
    assert_eq!(op.if_revision, Some(before.digest));
    let after = a.r.get_file(session, crate::api::Target::Id(file)).unwrap();
    assert_eq!(after.path, before.path);
    assert_eq!(after.digest, mdbn_wire::hash::sha256(b"fresh"));
    // The old revision no longer opens a (new) replacement.
    let again = mdbn_wire::client::OpenUploadParams {
        transfer: B16([0x7e; 16]),
        mutation_id: Some(B16([0x7f; 16])),
        ..replace(Some(before.digest))
    };
    assert_eq!(reason(&mut a, again).as_deref(), Some("revision"));
}

#[test]
fn replacement_refuses_a_target_changed_after_open() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let session = a.s;
    let opened = open_client(&mut a, session, 31);
    a.r.upload_chunk(
        session,
        mdbn_wire::client::UploadChunkParams {
            transfer: opened.transfer,
            index: 0,
            bytes: mdbn_wire::common::Bytes(vec![0x41; 31]),
        },
    )
    .unwrap();
    commit_client(&mut a, session, opened.transfer);
    let file = opened.file_id.unwrap();
    let before = a.r.get_file(session, crate::api::Target::Id(file)).unwrap();
    let replace = mdbn_wire::client::OpenUploadParams {
        transfer: B16([0x7c; 16]),
        mutation_id: Some(B16([0x7d; 16])),
        file_id: Some(file),
        if_revision: Some(before.digest),
        ..open_params(5)
    };
    let mut reopened = None;
    for _ in 0..4 {
        match a.r.open_upload(session, replace.clone()) {
            Ok(r) => {
                reopened = Some(r);
                break;
            }
            Err(_) => drive(&mut a, &Rc::default(), &mut |_, _| None),
        }
    }
    let reopened = reopened.unwrap();
    a.r.upload_chunk(
        session,
        mdbn_wire::client::UploadChunkParams {
            transfer: reopened.transfer,
            index: 0,
            bytes: mdbn_wire::common::Bytes(b"fresh".to_vec()),
        },
    )
    .unwrap();
    // The target is deleted after open: pending first, then confirmed gone.
    a.r.submit(
        session,
        mdbn_wire::client::SubmitParams {
            ops: vec![mdbn_wire::intent::Op::FileDelete(
                mdbn_wire::intent::FileDelete {
                    id: file,
                    if_revision: Some(before.digest),
                    base: None,
                },
            )],
            mutation_id: Some(B16([0x6d; 16])),
            conflict_mode: None,
            timezone: None,
            allow_partial: None,
            mutation_ids: None,
            dry_run: None,
            include: None,
            wait: None,
        },
    )
    .unwrap();
    let mut reasons = Vec::new();
    for _ in 0..8 {
        match a.r.commit_upload(session, reopened.transfer) {
            Ok(receipt) => panic!("replaced a changed target: {receipt:?}"),
            Err(e) => {
                let reason = e.into_problem().reason;
                if reason.as_deref() != Some("file_upload_pending") {
                    reasons.push(reason);
                    break;
                }
            }
        }
        drive(&mut a, &Rc::default(), &mut |_, _| None);
    }
    assert_eq!(
        reasons,
        vec![Some("attachment_replace_pending".to_string())]
    );
    drive(&mut a, &Rc::default(), &mut |_, _| None);
    // Confirmed delete: the replacement never landed.
    assert!(a.r.store().file(&file).unwrap().is_none());
}

#[test]
fn replacement_is_fenced_by_a_grant_revoked_mid_upload() {
    use mdbn_wire::policy::{GrantRevoke, PolicyOp};
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let owner = a.s;
    let opened = open_client(&mut a, owner, 31);
    a.r.upload_chunk(
        owner,
        mdbn_wire::client::UploadChunkParams {
            transfer: opened.transfer,
            index: 0,
            bytes: mdbn_wire::common::Bytes(vec![0x41; 31]),
        },
    )
    .unwrap();
    commit_client(&mut a, owner, opened.transfer);
    let file = opened.file_id.unwrap();
    let before = a.r.get_file(owner, crate::api::Target::Id(file)).unwrap();
    let mut cp = crate::testkit::TestControlPlane::new(COL);
    let (grant, pk) = (B16([0x76; 16]), [0x73; 32]);
    cp.approved_grant(
        &svc,
        grant,
        pk,
        &["collection.read", "records.edit"],
        None,
        B16([102; 16]),
    );
    settle(&mut [&mut a]);
    let (editor, _) =
        a.r.hello(
            SessionAuth::Grant {
                grant,
                client_pk: pk,
            },
            hello(),
        )
        .unwrap();
    let replace = mdbn_wire::client::OpenUploadParams {
        transfer: B16([0x7c; 16]),
        mutation_id: Some(B16([0x7d; 16])),
        file_id: Some(file),
        if_revision: Some(before.digest),
        ..open_params(5)
    };
    let mut reopened = None;
    for _ in 0..4 {
        match a.r.open_upload(editor, replace.clone()) {
            Ok(r) => {
                reopened = Some(r);
                break;
            }
            Err(_) => drive(&mut a, &Rc::default(), &mut |_, _| None),
        }
    }
    let reopened = reopened.unwrap();
    a.r.upload_chunk(
        editor,
        mdbn_wire::client::UploadChunkParams {
            transfer: reopened.transfer,
            index: 0,
            bytes: mdbn_wire::common::Bytes(b"fresh".to_vec()),
        },
    )
    .unwrap();
    cp.append(&svc, vec![PolicyOp::GrantRevoke(GrantRevoke { grant })]);
    settle(&mut [&mut a]);
    for _ in 0..8 {
        match a.r.commit_upload(editor, reopened.transfer) {
            Ok(receipt) => panic!("revoked grant replaced the file: {receipt:?}"),
            Err(e) if e.problem().reason.as_deref() == Some("file_upload_pending") => {
                drive(&mut a, &Rc::default(), &mut |_, _| None);
            }
            Err(_) => break,
        }
    }
    drive(&mut a, &Rc::default(), &mut |_, _| None);
    let after = a.r.get_file(owner, crate::api::Target::Id(file)).unwrap();
    assert_eq!(after.digest, before.digest);
}
