//! Invited-account key delivery through signed policy and real HPKE/history replay.
//! FakeLog transports bytes; this does not exercise deployed service custody.
use super::*;
use crate::KeyWaitReason;
use crate::seal::KeyringSealer;
use mdbn_wire::envelope::{Item, KeyGrantPayload};
use mdbn_wire::policy::MemberRemove;

#[test]
fn invited_member_reads_history_with_original_offline_and_removal_stops_grants() {
    const MEMBER: B16 = B16([103; 16]);
    const DEVICE: B16 = B16([104; 16]);
    const SIGN: [u8; 32] = [0x41; 32];
    const KEM: [u8; 32] = [0x42; 32];
    let (svc, mut cp) = service_world();
    cp.append(
        &svc,
        vec![enrol(
            OWNER_DEV,
            TEST_OWNER,
            DeviceKind::AppRuntime,
            OWNER_SIGN,
            OWNER_KEM,
        )],
    );
    let mut hosted = crypto_open(&svc, MemStore::new());
    hosted.pump();
    let clock = Rc::new(Cell::new(1_700_000_000_000));
    let template = hosted.r.cfg.clone();
    let open_app = |device, sign: [u8; 32], kem: [u8; 32]| {
        let mut cfg = template.clone();
        cfg.device_id = device;
        cfg.replica_id = device;
        cfg.trusted_signers.clear();
        Replica::open(
            cfg,
            MemStore::new(),
            Box::new(CreatePlanner),
            Box::new(KeyringSealer::new(COL, device, &sign, &kem)),
            Host {
                clock: Box::new(TestClock(clock.clone())),
                entropy: Box::new(crate::crypto::TestEntropy::new(device.0[0])),
                zones: Box::new(UtcOnly),
            },
            DeviceSecrets {
                sign_sk: sign,
                kem_sk: kem,
            },
        )
        .unwrap()
    };
    let drive = |replica: &mut Replica<MemStore>, log: &mut FakeLog| {
        for _ in 0..10 {
            pump(replica, log, 100);
            replica.tick();
        }
    };
    let mut original = open_app(OWNER_DEV, OWNER_SIGN, OWNER_KEM);
    let mut original_log = svc.client(OWNER_DEV);
    drive(&mut original, &mut original_log);
    let session = original.hello(SessionAuth::Host, hello()).unwrap().0;
    original
        .submit(session, create(1, "before-invitation.md", None))
        .unwrap();
    drive(&mut original, &mut original_log);
    let historical = original.store().record(&mid(1)).unwrap().unwrap();
    let content_position = original.head().seq;
    drop(original);
    drop(original_log);

    cp.append(
        &svc,
        vec![PolicyOp::MemberSet(MemberSet {
            account: MEMBER,
            role: Role::Editor,
        })],
    );
    let enrolled = cp.append(
        &svc,
        vec![enrol(DEVICE, MEMBER, DeviceKind::AppRuntime, SIGN, KEM)],
    );
    let mut member = open_app(DEVICE, SIGN, KEM);
    let mut member_log = svc.client(DEVICE);
    drive(&mut member, &mut member_log);
    assert_eq!(member.head().seq, content_position - 1);
    assert_eq!(
        member.key_wait_reason(),
        Some(KeyWaitReason::NoGrant { through: enrolled })
    );
    assert!(member.store().record(&mid(1)).unwrap().is_none());

    hosted.pump();
    let recipient = hosted.r.verified_hosted_key_recipient(DEVICE).unwrap();
    assert_eq!(recipient.account(), MEMBER);
    assert_eq!(recipient.kem_pk().0, KemKeyPair::from_secret(&KEM).pk);
    assert_eq!(
        hosted.r.policy.devices[&DEVICE].delivered_by,
        Some(HOSTED_DEV)
    );
    clock.set(clock.get() + 60_000);
    drive(&mut member, &mut member_log);
    assert_eq!(
        member.store().record(&mid(1)).unwrap().unwrap().doc,
        historical.doc
    );
    assert!(member.key_wait_reason().is_none());
    assert!(!member.key_untrusted);
    assert_eq!(member.head(), hosted.r.head());
    assert_eq!(member.stats.voided, 0);

    let removed = cp.append(
        &svc,
        vec![PolicyOp::MemberRemove(MemberRemove { account: MEMBER })],
    );
    hosted.pump();
    assert!(!hosted.r.policy.members.contains_key(&MEMBER));
    assert!(!hosted.r.policy.devices[&DEVICE].active);
    assert!(hosted.r.verified_hosted_key_recipient(DEVICE).is_err());
    for bytes in svc.items(&COL).into_iter().skip(removed as usize) {
        let item = Item::from_bytes(&bytes).unwrap();
        if item.kind == ItemKind::KeyGrant {
            assert_ne!(
                KeyGrantPayload::from_bytes(&item.body.0).unwrap().recipient,
                DEVICE,
                "a removed member receives no future grant"
            );
        }
    }
    assert_eq!(hosted.r.stats.voided, 0);
}
