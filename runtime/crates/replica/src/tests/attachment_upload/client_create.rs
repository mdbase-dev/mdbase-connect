//! Native CREATE identity/owner on the existing source writer (not wire readiness).
use super::*;
use crate::api::{ClientApi, SessionAuth};
use mdbn_wire::client::HelloParams;
use mdbn_wire::common::Version;
use mdbn_wire::policy::Role;

fn source() -> (Box<dyn AttachmentSource>, Rc<Reads>) {
    let reads = Rc::new(Reads::default());
    (
        Box::new(Source {
            bytes: Rc::new(data(31)),
            reads: reads.clone(),
        }),
        reads,
    )
}
fn hello() -> HelloParams {
    HelloParams {
        versions: vec![Version { major: 1, minor: 0 }],
        client_name: "native-create".into(),
        client_version: "1".into(),
        features: None,
        timezone: None,
    }
}

#[test]
fn host_create_returns_original_native_uuid_and_has_no_fake_on_behalf_grant() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let (body, _) = source();
    let mutation = B16([0x72; 16]);
    let (id, file) =
        a.r.start_attachment_create(a.s, "files/native.bin".into(), Some(mutation), body)
            .unwrap();
    assert_eq!(id, mutation);
    assert!(
        a.r.store().file(&file).unwrap().is_none(),
        "identity exists before confirmed path"
    );
    drive(&mut a, &Rc::default(), &mut |_, _| None);
    assert!(matches!(
        status(&a, &id),
        AttachmentUploadStatus::Captured(_)
    ));
    let (entry, _) = last_entry(&a, &svc);
    assert_eq!(entry.mutation.on_behalf, None);
    let rt::Op::FileAttach(op) = &entry.mutation.ops[0] else {
        panic!("file attach")
    };
    assert_eq!(op.id, file);
    assert_eq!(
        a.r.store().file(&file).unwrap().unwrap().path,
        "files/native.bin"
    );
}

#[test]
fn device_grant_create_preserves_real_owner_and_current_folder_scope() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let mut cp = crate::testkit::TestControlPlane::new(COL);
    let grant = B16([0x75; 16]);
    let pk = [0x74; 32];
    cp.approved_grant(
        &svc,
        grant,
        pk,
        &["collection.read", "records.create"],
        Some(vec!["files".into()]),
        B16([101; 16]),
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
    let (body, reads) = source();
    assert!(
        a.r.start_attachment_create(session, "private/x.bin".into(), None, body)
            .is_err()
    );
    assert_eq!(reads.total.get(), 0);
    let (body, _) = source();
    let (mutation, file) =
        a.r.start_attachment_create(session, "files/granted.bin".into(), None, body)
            .unwrap();
    drive(&mut a, &Rc::default(), &mut |_, _| None);
    assert!(matches!(
        status(&a, &mutation),
        AttachmentUploadStatus::Captured(_)
    ));
    let (entry, _) = last_entry(&a, &svc);
    assert_eq!(entry.mutation.on_behalf, Some(grant));
    let rt::Op::FileAttach(op) = &entry.mutation.ops[0] else {
        panic!("file attach")
    };
    assert_eq!(op.id, file);
}

#[test]
fn viewer_device_and_key_only_profile_never_read_source_or_store_objects() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let device = a.r.cfg.device_id;
    let account = a.r.policy.devices[&device].account;
    let role = a.r.policy.members.insert(account, Role::Viewer).unwrap();
    let (body, reads) = source();
    assert!(
        a.r.start_attachment_create(a.s, "files/no.bin".into(), None, body)
            .is_err()
    );
    assert_eq!(reads.total.get(), 0);
    a.r.policy.members.insert(account, role);
    a.r.cfg.key_grants_only = true;
    let (body, reads) = source();
    assert!(
        a.r.start_attachment_create(a.s, "files/no.bin".into(), None, body)
            .is_err()
    );
    assert_eq!(reads.total.get(), 0);
    assert!(svc.objects(&COL).is_empty());
}

#[test]
fn closed_native_create_session_cannot_capture_after_object_await() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let (body, _) = source();
    let (mutation, _) =
        a.r.start_attachment_create(a.s, "files/closed.bin".into(), None, body)
            .unwrap();
    a.r.close(a.s);
    drive(&mut a, &Rc::default(), &mut |_, _| None);
    assert!(matches!(
        status(&a, &mutation),
        AttachmentUploadStatus::Failed(_)
    ));
    assert_eq!(a.r.store().pending_count().unwrap(), 0);
}

#[test]
fn native_create_cleanup_is_exact_session_owned_not_mutation_only() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let (body, _) = source();
    let (mutation, _) =
        a.r.start_attachment_create(a.s, "files/owner.bin".into(), None, body)
            .unwrap();
    let (other, _) = a.r.hello(SessionAuth::Host, hello()).unwrap();
    assert!(!a.r.close_attachment_upload(&mutation));
    assert!(a.r.close_attachment_create(other, &mutation).is_err());
    assert!(
        a.r.close_hosted_attachment_upload(a.s, &mutation).is_err(),
        "hosted namespace is not a device authority bypass"
    );
    assert!(a.r.close_attachment_create(a.s, &mutation).unwrap());
    assert!(a.r.attachment_upload_status(&mutation).is_none());
}

#[test]
fn native_create_pin_generation_and_epoch_changes_are_terminal() {
    for change_epoch in [false, true] {
        let svc = FakeLogService::new();
        let mut a = attach_node(&svc, 1);
        let (body, _) = source();
        let (mutation, _) =
            a.r.start_attachment_create(a.s, "files/stale.bin".into(), None, body)
                .unwrap();
        if change_epoch {
            a.r.policy.epoch += 1;
        } else {
            a.r.store_generation += 1;
        }
        drive(&mut a, &Rc::default(), &mut |_, _| None);
        assert!(matches!(
            status(&a, &mutation),
            AttachmentUploadStatus::Failed(_)
        ));
        assert_eq!(a.r.store().pending_count().unwrap(), 0);
    }
}
