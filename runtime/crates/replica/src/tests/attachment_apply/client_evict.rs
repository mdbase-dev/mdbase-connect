//! Local eviction uses the existing conditional attachment disk primitives.
use super::*;
use crate::api::ErrorCode;
use crate::store::Tx;

fn materialized() -> (FakeLogService, Node, Rc<Vec<u8>>) {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let bytes = Rc::new(data(31));
    upload(&mut a, PATH, &bytes);
    let b = b_node(&svc);
    assert_eq!(
        b.r.store().file(&FILE).unwrap().unwrap().local,
        FileLocal::Materialized
    );
    (svc, b, bytes)
}

#[test]
fn client_evict_unlinks_only_local_copy_without_changing_confirmed_file() {
    let (svc, mut b, _) = materialized();
    let before = b.r.store().file(&FILE).unwrap().unwrap();
    let head = svc.head(&COL);
    b.r.evict_file(b.s, FILE).unwrap();
    let after = b.r.store().file(&FILE).unwrap().unwrap();
    assert_eq!(
        after,
        crate::store::FileRow {
            local: FileLocal::Remote,
            ..before
        }
    );
    assert!(b.r.attachment_shown(&FILE).unwrap().is_none());
    assert!(!b.r.store().att_disk().files.contains_key(PATH));
    assert!(b.r.take_log_calls().is_empty());
    assert_eq!(
        svc.head(&COL),
        head,
        "eviction is not a collection mutation"
    );
    b.r.evict_file(b.s, FILE).unwrap();
    assert!(b.r.store().hold(&FILE).unwrap().is_none());
    assert!(b.r.store().tombstone(&FILE).unwrap().is_none());
}

#[test]
fn client_evict_preserves_changed_bytes_and_keeps_marker_for_retry() {
    let (_, mut b, _) = materialized();
    let changed = b"an unsaved external edit";
    b.r.store().att_disk().user_write(PATH, changed);
    for _ in 0..2 {
        let error = b.r.evict_file(b.s, FILE).unwrap_err();
        assert_eq!(error.code(), Some(ErrorCode::Conflict));
        assert_eq!(error.0.reason.as_deref(), Some("file_eviction_drift"));
        assert_eq!(b.r.store().att_disk().files.get(PATH).unwrap(), changed);
        assert!(b.r.attachment_shown(&FILE).unwrap().is_some());
    }
}

#[test]
fn client_evict_refuses_holds_before_touching_disk_or_local_state() {
    let (_, mut b, bytes) = materialized();
    let row = b.r.store().file(&FILE).unwrap().unwrap();
    b.r.store_mut()
        .commit(Tx {
            holds_put: vec![mdbn_wire::client::Hold {
                id: FILE,
                path: PATH.into(),
                reason: mdbn_wire::client::HoldReason::Conflict,
                since: 123,
                base: None,
                mine: mdbn_wire::snapshot::TextOrBlob::Attachment(match &row.content {
                    FileContent::AttachmentV1(c) => c.clone(),
                    _ => panic!("not an attachment"),
                }),
                theirs: None,
                saves: 1,
            }],
            ..Default::default()
        })
        .unwrap();
    let error = b.r.evict_file(b.s, FILE).unwrap_err();
    assert_eq!(
        error.0.reason.as_deref(),
        Some("file_materialization_fenced")
    );
    assert_eq!(b.r.store().file(&FILE).unwrap().unwrap(), row);
    assert_eq!(b.r.store().att_disk().files.get(PATH), Some(bytes.as_ref()));
}

#[test]
fn client_evict_known_aborted_metadata_prevents_unlink() {
    let (_, mut b, bytes) = materialized();
    b.r.store().fail_commits(1);
    assert!(b.r.evict_file(b.s, FILE).is_err());
    assert!(!b.r.requires_reopen());
    assert_eq!(
        b.r.store().file(&FILE).unwrap().unwrap().local,
        FileLocal::Materialized
    );
    assert_eq!(b.r.store().att_disk().files.get(PATH), Some(bytes.as_ref()));
    b.r.evict_file(b.s, FILE).unwrap();
    assert!(!b.r.store().att_disk().files.contains_key(PATH));
}

#[test]
fn client_evict_unknown_metadata_outcome_fences_instance_without_unlink() {
    let (_, mut b, bytes) = materialized();
    b.r.store().fail_unknown_commits(1);
    assert!(b.r.evict_file(b.s, FILE).is_err());
    assert!(b.r.requires_reopen());
    assert_eq!(b.r.store().att_disk().files.get(PATH), Some(bytes.as_ref()));
    assert!(b.r.evict_file(b.s, FILE).is_err());
}

#[test]
fn client_evict_never_unlinks_another_confirmed_namespace_owner() {
    let (_, mut b, bytes) = materialized();
    // Model the apply-to-disk window: A moved, B owns A's old shown path.
    let mut a = b.r.store().file(&FILE).unwrap().unwrap();
    let mut other = a.clone();
    other.id = B16([0x5b; 16]);
    a.path = "files/moved.bin".into();
    a.path_key = mdbn_core::paths::path_key(&a.path);
    a.local = FileLocal::Remote;
    b.r.store_mut()
        .commit(Tx {
            files_put: vec![a, other.clone()],
            ..Default::default()
        })
        .unwrap();
    b.r.evict_file(b.s, FILE).unwrap();
    assert_eq!(b.r.store().att_disk().files.get(PATH), Some(bytes.as_ref()));
    assert_eq!(b.r.store().file(&other.id).unwrap().unwrap(), other);
    assert!(b.r.attachment_shown(&FILE).unwrap().is_none());
}

#[test]
fn client_evict_cancels_inflight_fetch_and_ignores_late_object_reply() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let mut b = b_node(&svc);
    upload(&mut a, PATH, &Rc::new(data(31)));
    let through = b.r.store().head().unwrap().seq;
    b.r.apply_items(
        svc.items(&COL)
            .into_iter()
            .enumerate()
            .filter(|(i, _)| *i as u64 >= through)
            .map(|(i, raw)| mdbn_wire::log_service::SeqItem {
                seq: i as u64 + 1,
                item: mdbn_wire::common::Bytes(raw),
            })
            .collect(),
    );
    let pending = b.r.take_log_calls();
    assert_eq!(
        pending
            .iter()
            .filter(|c| matches!(c.request, LogRequest::GetObject { .. }))
            .count(),
        1
    );
    b.r.evict_file(b.s, FILE).unwrap();
    for call in pending {
        let reply = b.log.call(call.request);
        b.r.on_log_reply(call.id, reply);
    }
    assert_eq!(
        b.r.store().file(&FILE).unwrap().unwrap().local,
        FileLocal::Remote
    );
    assert!(!b.r.store().att_disk().files.contains_key(PATH));
    assert!(b.r.take_log_calls().is_empty());
    assert!(b.r.attachment_fetch_status(&FILE).is_none());
}

#[test]
fn retained_marker_after_unlink_is_not_proof_of_materialization() {
    let (_, mut b, _) = materialized();
    let mut row = b.r.store().file(&FILE).unwrap().unwrap();
    let revision = row.content.plain_hash();
    row.local = FileLocal::Remote;
    b.r.store_mut()
        .commit(Tx {
            files_put: vec![row],
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        b.r.store_mut()
            .attachment_remove(FILE, PATH, revision)
            .unwrap(),
        None
    );
    assert!(b.r.attachment_shown(&FILE).unwrap().is_some());
    // Crash/reopen reconciliation under default all may refetch, but may not
    // promote an absent file just because its old marker survived.
    b.r.reconcile_attachments().unwrap();
    assert_ne!(
        b.r.store().file(&FILE).unwrap().unwrap().local,
        FileLocal::Materialized
    );
    assert!(!b.r.store().att_disk().files.contains_key(PATH));
    assert!(matches!(
        b.r.attachment_fetch_status(&FILE),
        Some(AttachmentFetchStatus::Fetching { .. })
    ));
}

#[test]
fn client_evict_requires_host_and_a_materializing_store() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    upload(&mut a, PATH, &Rc::new(data(31)));
    let error = a.r.evict_file(a.s, FILE).unwrap_err();
    assert_eq!(
        error.0.reason.as_deref(),
        Some("file_materialization_unsupported")
    );
    let mut cp = crate::testkit::TestControlPlane::new(COL);
    let grant = B16([0x55; 16]);
    let pk = [0x57; 32];
    cp.approved_grant(
        &svc,
        grant,
        pk,
        &[
            "collection.read",
            "records.create",
            "records.edit",
            "records.delete",
            "views.manage",
            "definitions.manage",
            "background.schedule",
            "offline.replica",
        ],
        None,
        B16([101; 16]),
    );
    settle(&mut [&mut a]);
    let (app, _) =
        a.r.hello(
            SessionAuth::Grant {
                grant,
                client_pk: pk,
            },
            HelloParams {
                versions: vec![Version { major: 1, minor: 1 }],
                client_name: "evict".into(),
                client_version: "1".into(),
                features: None,
                timezone: None,
            },
        )
        .unwrap();
    assert_eq!(
        a.r.evict_file(app, FILE).unwrap_err().code(),
        Some(ErrorCode::Forbidden)
    );
}
