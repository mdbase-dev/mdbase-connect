//! Real crypto and engine lifecycle for a collection born Private. No service
//! bootstrap/replacement key may stand in for an owner's existing-epoch grant.
use super::*;
use mdbn_replica::{
    Sealer,
    crypto::{hpke::KemKeyPair, keys::Recipient, sign::DeviceSigner},
    seal::KeyringSealer,
};
use mdbn_wire::{
    envelope::Item,
    policy::{CollectionState, DeviceEnrol, DeviceRevoke, PolicyOp},
};
fn append(svc: &FakeLogService, sealer: &KeyringSealer, kind: ItemKind, body: Vec<u8>) {
    let (seq, chain) = svc.head(&COL);
    let mut item = Item {
        kind,
        collection: COL,
        seq: Some(seq + 1),
        prev: Some(chain),
        epoch: None,
        signer: Some(OWNER_DEV),
        salt: None,
        idem: None,
        refs: None,
        stream: None,
        body: Bytes(body),
        sig: None,
    };
    sealer.sign(&mut item).unwrap();
    svc.push_raw(&COL, item.to_bytes().unwrap());
}
#[test]
fn private_genesis_cloud_handover_and_revocation_use_the_original_epoch() {
    let svc = FakeLogService::new();
    let mut cp = TestControlPlane::signed(COL);
    cp.genesis_with_keys(&svc, CState::E2e, OWNER_DEV, &[31; 32], &[32; 32]);
    let mut owner = KeyringSealer::new(COL, OWNER_DEV, &[31; 32], &[32; 32]);
    let initial = owner
        .build_rekey(
            0,
            &[Recipient {
                device: OWNER_DEV,
                kem_pk: KemKeyPair::from_secret(&[32; 32]).pk,
            }],
            RekeyReason::Initial,
            &mut mdbn_replica::crypto::TestEntropy::new(31),
        )
        .unwrap();
    append(&svc, &owner, ItemKind::Rekey, initial.to_bytes().unwrap());
    owner.accept_rekey(&initial);
    owner.set_epoch(1);
    let mut ops = Vec::new();
    for (device, kind, sign, kem) in [
        (HOSTED_DEV, DeviceKind::Hosted, 7, 8),
        (ESCROW_DEV, DeviceKind::Escrow, 17, 18),
    ] {
        ops.push(PolicyOp::DeviceEnrol(DeviceEnrol {
            device,
            account: mdbn_replica::policy::SERVICE_ACCOUNT,
            kind,
            sign_pk: B32(DeviceSigner::from_seed(&[sign; 32]).public()),
            kem_pk: B32(KemKeyPair::from_secret(&[kem; 32]).pk),
            noise_pk: B32([sign; 32]),
            sas_commit: None,
            local_root: None,
        }));
    }
    ops.push(PolicyOp::CollectionState(CollectionState {
        state: CState::CloudCopy,
        compress: None,
        min_sem_major: None,
    }));
    cp.append(&svc, ops);
    let clock = Rc::new(Cell::new(1_700_000_000_000));
    let mut engine = Engine::open_with(
        config(&svc),
        MemStore::new(),
        Box::new(KeyringSealer::new(COL, HOSTED_DEV, &[7; 32], &[8; 32])),
        Host {
            clock: Box::new(TestClock(clock.clone())),
            entropy: Box::new(mdbn_replica::crypto::TestEntropy::new(7)),
            zones: Box::new(UtcOnly),
        },
        HostedProfile::default(),
    )
    .unwrap();
    assert!(engine.bind_log(COL));
    let mut hosted = Hosted {
        e: engine,
        log: svc.client(HOSTED_DEV),
        clock,
    };
    let head = svc.head(&COL);
    hosted.pump(false);
    assert_eq!(
        svc.head(&COL),
        head,
        "never bootstrap a replacement epoch for Private history"
    );
    assert!(
        hosted.e.mode_service_ready().is_none(),
        "enrolment is not key readiness"
    );
    for (device, kem) in [(HOSTED_DEV, 8), (ESCROW_DEV, 18)] {
        let grant = owner
            .build_key_grant(
                1,
                &Recipient {
                    device,
                    kem_pk: KemKeyPair::from_secret(&[kem; 32]).pk,
                },
                &mut mdbn_replica::crypto::TestEntropy::new(kem),
            )
            .unwrap();
        append(&svc, &owner, ItemKind::KeyGrant, grant.to_bytes().unwrap());
    }
    let mut public = mdbn_replica::policy::PolicyState::new();
    for (index, raw) in svc.items(&COL).iter().enumerate() {
        let item = Item::from_bytes(raw).unwrap();
        assert!(
            public
                .apply_control(
                    index as u64 + 1,
                    &mdbn_wire::hash::chain_hash(raw),
                    &item,
                    &mdbn_replica::policy::Env {
                        verifier: &mdbn_replica::crypto::sign::Ed25519Verifier,
                        trusted_roots: &[signed_root()],
                        policy_pins: None
                    }
                )
                .is_ok(),
            "invalid public item {}",
            index + 1
        );
    }
    assert_eq!(public.epoch, 1);
    assert!(public.devices[&HOSTED_DEV].keyed);
    assert!(hosted.e.request_log_head());
    hosted.pump_pushless();
    assert_eq!(
        hosted.e.mode_service_ready(),
        Some((HOSTED_DEV, 1)),
        "actual native existing-epoch/history custody: {:?}",
        hosted.e.admission()
    );
    let cloud_items = svc.items(&COL);
    cp.append(
        &svc,
        vec![
            PolicyOp::DeviceRevoke(DeviceRevoke { device: HOSTED_DEV }),
            PolicyOp::DeviceRevoke(DeviceRevoke { device: ESCROW_DEV }),
            PolicyOp::CollectionState(CollectionState {
                state: CState::E2e,
                compress: None,
                min_sem_major: None,
            }),
        ],
    );
    let fixture = format!(
        r#"{{"publicFixedTestValuesOnly":true,"config":"{}","collection":"{}","device":"{}","cloud":{:?},"private":{:?}}}"#,
        mdbn_wire::render::hex(&cbor::encode(&config_value(&svc)).unwrap()),
        COL.to_uuid_string(),
        HOSTED_DEV.to_uuid_string(),
        cloud_items
            .iter()
            .map(|b| mdbn_wire::render::hex(b))
            .collect::<Vec<_>>(),
        svc.items(&COL)
            .iter()
            .map(|b| mdbn_wire::render::hex(b))
            .collect::<Vec<_>>()
    );
    println!("MODE_WORKER_FIXTURE={fixture}");
    assert!(hosted.e.request_log_head());
    hosted.pump_pushless();
    assert!(
        hosted.e.mode_service_ready().is_none(),
        "revoked services cannot claim current readiness"
    );
}
