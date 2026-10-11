//! Shared native pin authority; transport/production admission is not simulated.
use super::*;
use crate::api::{ErrorCode, Target};
use crate::attachments::{Need, PlainSink};
use crate::file_io::{AttachmentRegion, FileReads};
use mdbn_wire::policy::{CState, DeviceKind, GrantRevoke, PolicyOp, Role};

fn fixture() -> (FakeLogService, Node, Rc<Vec<u8>>) {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let bytes = Rc::new(data(31));
    upload(&mut a, PATH, &bytes);
    (svc, a, bytes)
}

fn hello() -> HelloParams {
    HelloParams {
        versions: vec![Version { major: 1, minor: 1 }],
        client_name: "native-reader".into(),
        client_version: "1".into(),
        features: None,
        timezone: None,
    }
}

#[derive(Default)]
struct Collect(Vec<u8>);
impl PlainSink for Collect {
    fn write(&mut self, offset: u64, bytes: &[u8]) -> Result<(), String> {
        assert_eq!(offset, self.0.len() as u64);
        self.0.extend_from_slice(bytes);
        Ok(())
    }
}

#[test]
fn generic_native_pin_reuses_reader_and_hosted_wrapper_remains_hosted_only() {
    let (svc, mut a, bytes) = fixture();
    assert_eq!(
        a.r.hosted_attachment_read(a.s, Target::Id(FILE), None, None)
            .unwrap_err()
            .code(),
        Some(ErrorCode::Unavailable)
    );
    let mut pin =
        a.r.attachment_read(a.s, Target::Id(FILE), None, None)
            .unwrap();
    let objects: std::collections::BTreeMap<_, _> = svc.objects(&COL).into_iter().collect();
    let mut out = Collect::default();
    while let Some(need) = pin.need() {
        match need {
            Need::Manifest { address } => {
                a.r.attachment_read_manifest(&mut pin, &objects[&address])
                    .unwrap()
            }
            Need::Chunk { index, address, .. } => {
                a.r.attachment_read_chunk(&mut pin, index, &objects[&address], &mut out)
                    .unwrap()
            }
        }
    }
    a.r.attachment_read_finish(pin).unwrap();
    assert_eq!(&out.0, bytes.as_ref());
}

#[test]
fn native_read_eligibility_is_exhaustive_and_viewer_does_not_gain_write() {
    let (_, mut a, _) = fixture();
    let device = a.r.cfg.device_id;
    let account = a.r.policy.devices[&device].account;
    a.r.policy.members.insert(account, Role::Viewer);
    for kind in [
        DeviceKind::Desktop,
        DeviceKind::Mobile,
        DeviceKind::AppRuntime,
        DeviceKind::Cli,
    ] {
        a.r.policy.devices.get_mut(&device).unwrap().kind = kind;
        assert!(a.r.policy.device_can_read(&device));
        assert!(!a.r.policy.device_can_write(&device));
        assert!(
            a.r.attachment_read(a.s, Target::Id(FILE), None, None)
                .is_ok()
        );
    }
    for kind in [DeviceKind::Escrow, DeviceKind::Recovery] {
        a.r.policy.devices.get_mut(&device).unwrap().kind = kind;
        assert!(!a.r.policy.device_can_read(&device));
        assert!(
            a.r.attachment_read(a.s, Target::Id(FILE), None, None)
                .is_err()
        );
    }
    a.r.policy.devices.get_mut(&device).unwrap().kind = DeviceKind::Hosted;
    a.r.policy.cstate = Some(CState::CloudCopy);
    assert!(a.r.policy.device_can_read(&device));
    assert!(
        a.r.attachment_read(a.s, Target::Id(FILE), None, None)
            .is_err(),
        "a hosted identity cannot use a fake device profile"
    );
    a.r.policy.cstate = Some(CState::E2e);
    assert!(!a.r.policy.device_can_read(&device));
}

#[test]
fn native_pin_rechecks_device_keyed_active_membership_and_key_only_profile() {
    let (_, mut a, _) = fixture();
    let pin =
        a.r.attachment_read(a.s, Target::Id(FILE), None, None)
            .unwrap();
    let device = a.r.cfg.device_id;
    let account = a.r.policy.devices[&device].account;
    a.r.policy.devices.get_mut(&device).unwrap().keyed = false;
    assert!(a.r.attachment_read_check(&pin).is_err());
    a.r.policy.devices.get_mut(&device).unwrap().keyed = true;
    a.r.policy.devices.get_mut(&device).unwrap().active = false;
    assert!(a.r.attachment_read_check(&pin).is_err());
    a.r.policy.devices.get_mut(&device).unwrap().active = true;
    let role = a.r.policy.members.remove(&account).unwrap();
    assert!(a.r.attachment_read_check(&pin).is_err());
    a.r.policy.members.insert(account, role);
    a.r.cfg.key_grants_only = true;
    assert!(a.r.attachment_read_check(&pin).is_err());
}

#[test]
fn native_pin_rechecks_grant_folder_and_revocation_before_cipher_input() {
    let (svc, mut a, _) = fixture();
    let mut cp = crate::testkit::TestControlPlane::new(COL);
    let grant = B16([0x55; 16]);
    let pk = [0x57; 32];
    cp.approved_grant(
        &svc,
        grant,
        pk,
        &["collection.read"],
        Some(vec!["files".into()]),
        B16([101; 16]),
    );
    settle(&mut [&mut a]);
    let (app, _) =
        a.r.hello(
            SessionAuth::Grant {
                grant,
                client_pk: pk,
            },
            hello(),
        )
        .unwrap();
    let mut pin =
        a.r.attachment_read(app, Target::Id(FILE), None, None)
            .unwrap();
    let original =
        a.r.policy
            .grants
            .get_mut(&grant)
            .unwrap()
            .approved_folders
            .replace(vec!["private".into()]);
    assert_eq!(
        a.r.attachment_read_check(&pin).unwrap_err().code(),
        Some(ErrorCode::NotFound)
    );
    a.r.policy.grants.get_mut(&grant).unwrap().approved_folders = original;
    cp.append(&svc, vec![PolicyOp::GrantRevoke(GrantRevoke { grant })]);
    settle(&mut [&mut a]);
    assert!(
        a.r.attachment_read_manifest(&mut pin, b"untrusted ciphertext")
            .is_err()
    );
}

#[test]
fn native_pin_store_lifetime_session_range_and_revision_are_bound() {
    let (_, mut a, _) = fixture();
    for range in [Some((u64::MAX, 1)), Some((32, 0)), Some((30, 2))] {
        assert_eq!(
            a.r.attachment_read(a.s, Target::Id(FILE), range, None)
                .unwrap_err()
                .code(),
            Some(ErrorCode::InvalidRequest)
        );
    }
    assert_eq!(
        a.r.attachment_read(a.s, Target::Id(FILE), None, Some(B32([1; 32])))
            .unwrap_err()
            .code(),
        Some(ErrorCode::Conflict)
    );
    let pin =
        a.r.attachment_read(a.s, Target::Id(FILE), None, None)
            .unwrap();
    a.r.store_generation += 1;
    assert_eq!(
        a.r.attachment_read_check(&pin)
            .unwrap_err()
            .0
            .reason
            .as_deref(),
        Some("attachment_read_lifetime")
    );
    let pin =
        a.r.attachment_read(a.s, Target::Id(FILE), None, None)
            .unwrap();
    a.r.close(a.s);
    assert_eq!(
        a.r.attachment_read_check(&pin).unwrap_err().code(),
        Some(ErrorCode::Unauthenticated)
    );
}

#[test]
fn shared_wire_driver_can_pin_a_device_and_reject_revoked_cipher_ticket() {
    let (_, mut a, _) = fixture();
    let mut reads = FileReads::new(0);
    let mut region = AttachmentRegion::new();
    reads
        .start(&mut a.r, a.s, Target::Id(FILE), None, None, &mut region)
        .unwrap();
    let object = reads.object(&a.r, &region).unwrap().unwrap();
    assert!(reads.allowed(&a.r, object.ticket, &region));
    let device = a.r.cfg.device_id;
    a.r.policy.devices.get_mut(&device).unwrap().active = false;
    assert!(!reads.allowed(&a.r, object.ticket, &region));
    assert!(!reads.reserve(&a.r, object.ticket, 1, &mut region));
    assert_eq!(reads.poll(&a.r, &mut region).unwrap_err(), a.s);
    reads.close(a.s, &mut region);
    assert!(region.held_lease().is_none());
}
