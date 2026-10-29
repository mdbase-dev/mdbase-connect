//! ClientApi fetch is admission onto the existing bounded device materializer.
use super::*;
use crate::api::{ErrorCode, SessionId};
use crate::testkit::TestControlPlane;
use mdbn_wire::log_service::SeqItem;
use mdbn_wire::policy::{GrantRevoke, PolicyOp};

fn hello() -> HelloParams {
    HelloParams {
        versions: vec![Version { major: 1, minor: 1 }],
        client_name: "file-fetch-test".into(),
        client_version: "1".into(),
        features: None,
        timezone: None,
    }
}

fn apply_available(n: &mut Node, svc: &FakeLogService) {
    let through = n.r.store().head().unwrap().seq;
    n.r.apply_items(
        svc.items(&COL)
            .into_iter()
            .enumerate()
            .filter(|(i, _)| (*i as u64) >= through)
            .map(|(i, raw)| SeqItem {
                seq: i as u64 + 1,
                item: mdbn_wire::common::Bytes(raw),
            })
            .collect(),
    );
}

#[test]
fn client_fetch_reuses_one_inflight_object_and_does_not_claim_publish() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let mut b = b_node(&svc);
    let bytes = Rc::new(data(CHUNK + 31));
    upload(&mut a, PATH, &bytes);
    apply_available(&mut b, &svc);
    assert_eq!(
        b.r.pending_downloads(),
        1,
        "the in-flight object is unfinished sync work"
    );
    let pending = b.r.take_log_calls();
    assert_eq!(
        pending
            .iter()
            .filter(|c| matches!(c.request, LogRequest::GetObject { .. }))
            .count(),
        1
    );
    assert!(!b.r.store().att_disk().files.contains_key(PATH));

    b.r.fetch_file(b.s, FILE).unwrap();
    b.r.fetch_file(b.s, FILE).unwrap();
    assert!(
        b.r.take_log_calls().is_empty(),
        "no parallel fetch or duplicate object request"
    );
    assert!(
        !b.r.store().att_disk().files.contains_key(PATH),
        "acceptance precedes publish"
    );
    for call in pending {
        let reply = b.log.call(call.request);
        b.r.on_log_reply(call.id, reply);
    }
    drive_b(&mut b, &RefCell::default(), &|_| false);
    assert_eq!(b.r.store().att_disk().files.get(PATH), Some(bytes.as_ref()));
    assert_eq!(
        b.r.store().file(&FILE).unwrap().unwrap().local,
        FileLocal::Materialized
    );
    assert_eq!(
        b.r.pending_downloads(),
        0,
        "published bytes finish the transfer"
    );
    let before = gets(&svc);
    b.r.fetch_file(b.s, FILE).unwrap();
    assert!(b.r.take_log_calls().is_empty());
    assert_eq!(
        gets(&svc),
        before,
        "an already materialized file needs no refetch"
    );
}

#[test]
fn client_fetch_checks_live_read_and_folder_scope_before_storage_support() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1); // No physical attachment disk.
    upload(&mut a, PATH, &Rc::new(data(31)));
    let mut cp = TestControlPlane::new(COL);
    let pk = [0x57; 32];
    let read = B16([0x51; 16]);
    let outside = B16([0x52; 16]);
    let no_read = B16([0x53; 16]);
    for (grant, caps, folders) in [
        (read, vec!["collection.read"], Some(vec!["files".into()])),
        (
            outside,
            vec!["collection.read"],
            Some(vec!["private".into()]),
        ),
        (no_read, vec!["records.create"], None),
    ] {
        cp.approved_grant(&svc, grant, pk, &caps, folders, B16([101; 16]));
    }
    settle(&mut [&mut a]);
    let mut sessions = Vec::new();
    for grant in [read, outside, no_read] {
        sessions.push(
            a.r.hello(
                SessionAuth::Grant {
                    grant,
                    client_pk: pk,
                },
                hello(),
            )
            .unwrap()
            .0,
        );
    }
    assert_eq!(
        a.r.fetch_file(sessions[1], FILE).unwrap_err().code(),
        Some(ErrorCode::NotFound)
    );
    assert_eq!(
        a.r.fetch_file(sessions[2], FILE).unwrap_err().code(),
        Some(ErrorCode::Forbidden)
    );
    let unsupported = a.r.fetch_file(sessions[0], FILE).unwrap_err();
    assert_eq!(unsupported.code(), Some(ErrorCode::Unavailable));
    assert_eq!(
        unsupported.0.reason.as_deref(),
        Some("file_materialization_unsupported")
    );
    assert_eq!(
        a.r.fetch_file(SessionId(u64::MAX), FILE)
            .unwrap_err()
            .code(),
        Some(ErrorCode::Unauthenticated)
    );
    assert!(a.r.take_log_calls().is_empty());

    cp.append(
        &svc,
        vec![PolicyOp::GrantRevoke(GrantRevoke { grant: read })],
    );
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.fetch_file(sessions[0], FILE).unwrap_err().code(),
        Some(ErrorCode::Unauthenticated)
    );
    assert!(a.r.take_log_calls().is_empty());
}

#[test]
fn client_fetch_does_not_bypass_a_local_hold() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let mut b = b_node(&svc);
    let (entry, _) = upload(&mut a, PATH, &Rc::new(data(31)));
    apply_available(&mut b, &svc);
    let pending = b.r.take_log_calls();
    assert_eq!(
        pending
            .iter()
            .filter(|c| matches!(c.request, LogRequest::GetObject { .. }))
            .count(),
        1
    );
    b.r.store_mut()
        .commit(crate::store::Tx {
            holds_put: vec![mdbn_wire::client::Hold {
                id: FILE,
                path: PATH.into(),
                reason: mdbn_wire::client::HoldReason::Conflict,
                since: 123,
                base: None,
                mine: mdbn_wire::snapshot::TextOrBlob::Attachment(content_of(&entry)),
                theirs: None,
                saves: 1,
            }],
            ..Default::default()
        })
        .unwrap();
    let before = b.r.attachment_fetch_status(&FILE);
    let error = b.r.fetch_file(b.s, FILE).unwrap_err();
    assert_eq!(error.code(), Some(ErrorCode::Unavailable));
    assert_eq!(
        error.0.reason.as_deref(),
        Some("file_materialization_fenced")
    );
    assert_eq!(b.r.attachment_fetch_status(&FILE), before);
    assert!(b.r.take_log_calls().is_empty());
    assert!(!b.r.store().att_disk().files.contains_key(PATH));
}

#[test]
fn client_fetch_preserves_terminal_native_failure_without_retry() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let mut b = b_node(&svc);
    let (entry, _) = upload(&mut a, PATH, &Rc::new(data(31)));
    let content = content_of(&entry);
    svc.forget_object(&COL, &content.reference.manifest_cipher_hash);
    drive_b(&mut b, &RefCell::default(), &|_| false);
    let Some(AttachmentFetchStatus::Failed(problem)) = b.r.attachment_fetch_status(&FILE) else {
        panic!("expected terminal native failure");
    };
    let before = gets(&svc);
    assert_eq!(*b.r.fetch_file(b.s, FILE).unwrap_err().0, problem);
    assert!(b.r.take_log_calls().is_empty());
    assert_eq!(gets(&svc), before);
    assert!(!b.r.store().att_disk().files.contains_key(PATH));
}
