//! Real crypto and engine lifecycle for a collection born Private. No service
//! bootstrap/replacement key may stand in for an owner's existing-epoch grant.
use super::*;
use mdbn_replica::{
    Sealer,
    crypto::{hpke::KemKeyPair, keys::Recipient, sign::DeviceSigner},
    seal::KeyringSealer,
};
use mdbn_wire::attachment_runtime_v1 as rt;
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
fn encrypted_history_entry(svc: &FakeLogService, owner: &mut KeyringSealer, epoch: u64) {
    let (seq, chain) = svc.head(&COL);
    let payload = rt::EntryPayload {
        sem: Version { major: 1, minor: 0 },
        mutation: rt::Mutation {
            id: B16([epoch as u8; 16]),
            origin: OWNER_DEV,
            base_seq: seq,
            clock: mdbn_wire::intent::OpClock {
                instant: 1_700_000_000_000,
                tz: "UTC".into(),
                local_date: "2023-11-14".into(),
            },
            seed: B32([epoch as u8; 32]),
            source: mdbn_wire::intent::Source::Api,
            ops: vec![rt::Op::Legacy(Op::Create(Create {
                id: B16([epoch as u8; 16]),
                path: Some(format!("history-{epoch}.md")),
                type_name: None,
                frontmatter: None,
                body: None,
                document: Some(Text::Inline(format!("history epoch {epoch}\n"))),
            }))],
            on_behalf: None,
            conflict_mode: None,
            validated_at: None,
            room: None,
        },
        status: mdbn_wire::entry::Status::Applied,
        effects: vec![rt::Effect::Legacy(mdbn_wire::entry::Effect::PutRecord(
            mdbn_wire::entry::PutRecord {
                id: B16([epoch as u8; 16]),
                path: format!("history-{epoch}.md"),
                doc: Text::Inline(format!("history epoch {epoch}\n")),
            },
        ))],
        conflicts: None,
        aliases: None,
        texts: None,
        resurrect: None,
    };
    let mut item = Item {
        kind: ItemKind::Entry,
        collection: COL,
        seq: Some(seq + 1),
        prev: Some(chain),
        epoch: Some(epoch),
        signer: Some(OWNER_DEV),
        salt: Some(B16([epoch as u8; 16])),
        idem: Some(B16([epoch as u8; 16])),
        refs: None,
        stream: None,
        body: Bytes(payload.to_bytes().unwrap()),
        sig: None,
    };
    owner
        .seal(
            &mut item,
            &payload.to_bytes().unwrap(),
            false,
            &mut mdbn_replica::crypto::TestEntropy::new(epoch as u8),
        )
        .unwrap();
    svc.push_raw(&COL, item.to_bytes().unwrap());
}
#[test]
fn born_cloud_private_return_cold_service_observes_owner_history() {
    let svc = FakeLogService::new();
    let mut cp = TestControlPlane::signed(COL);
    cp.genesis_with_keys(&svc, CState::CloudCopy, OWNER_DEV, &[31; 32], &[32; 32]);
    let old_hosted = B16([201; 16]);
    let old_escrow = B16([202; 16]);
    let enrol = |device, kind, sign: u8, kem: u8| {
        PolicyOp::DeviceEnrol(DeviceEnrol {
            device,
            account: mdbn_replica::policy::SERVICE_ACCOUNT,
            kind,
            sign_pk: B32(DeviceSigner::from_seed(&[sign; 32]).public()),
            kem_pk: B32(KemKeyPair::from_secret(&[kem; 32]).pk),
            noise_pk: B32([sign; 32]),
            sas_commit: None,
            local_root: None,
        })
    };
    cp.append(
        &svc,
        vec![
            enrol(old_hosted, DeviceKind::Hosted, 201, 201),
            enrol(old_escrow, DeviceKind::Escrow, 202, 202),
        ],
    );
    let mut initial_service = KeyringSealer::new(COL, old_hosted, &[201; 32], &[201; 32]);
    let initial = initial_service
        .build_rekey(
            0,
            &[
                Recipient {
                    device: OWNER_DEV,
                    kem_pk: KemKeyPair::from_secret(&[32; 32]).pk,
                },
                Recipient {
                    device: old_hosted,
                    kem_pk: KemKeyPair::from_secret(&[201; 32]).pk,
                },
                Recipient {
                    device: old_escrow,
                    kem_pk: KemKeyPair::from_secret(&[202; 32]).pk,
                },
            ],
            RekeyReason::Initial,
            &mut mdbn_replica::crypto::TestEntropy::new(201),
        )
        .unwrap();
    let (seq, chain) = svc.head(&COL);
    let mut item = Item {
        kind: ItemKind::Rekey,
        collection: COL,
        seq: Some(seq + 1),
        prev: Some(chain),
        epoch: None,
        signer: Some(old_hosted),
        salt: None,
        idem: None,
        refs: None,
        stream: None,
        body: Bytes(initial.to_bytes().unwrap()),
        sig: None,
    };
    initial_service.sign(&mut item).unwrap();
    svc.push_raw(&COL, item.to_bytes().unwrap());
    let mut owner = KeyringSealer::new(COL, OWNER_DEV, &[31; 32], &[32; 32]);
    owner.accept_rekey(&initial);
    owner.set_epoch(1);
    encrypted_history_entry(&svc, &mut owner, 1);
    cp.append(
        &svc,
        vec![
            PolicyOp::DeviceRevoke(DeviceRevoke { device: old_hosted }),
            PolicyOp::DeviceRevoke(DeviceRevoke { device: old_escrow }),
            PolicyOp::CollectionState(CollectionState {
                state: CState::E2e,
                compress: None,
                min_sem_major: None,
            }),
        ],
    );
    let private = owner
        .build_rekey(
            1,
            &[Recipient {
                device: OWNER_DEV,
                kem_pk: KemKeyPair::from_secret(&[32; 32]).pk,
            }],
            RekeyReason::CloudCopyOff,
            &mut mdbn_replica::crypto::TestEntropy::new(31),
        )
        .unwrap();
    append(&svc, &owner, ItemKind::Rekey, private.to_bytes().unwrap());
    owner.accept_rekey(&private);
    owner.set_epoch(2);
    encrypted_history_entry(&svc, &mut owner, 2);
    cp.append(
        &svc,
        vec![
            enrol(HOSTED_DEV, DeviceKind::Hosted, 7, 8),
            enrol(ESCROW_DEV, DeviceKind::Escrow, 17, 18),
            PolicyOp::CollectionState(CollectionState {
                state: CState::CloudCopy,
                compress: None,
                min_sem_major: None,
            }),
        ],
    );
    let unkeyed_items = svc.items(&COL);
    for (device, kem) in [(HOSTED_DEV, 8), (ESCROW_DEV, 18)] {
        let grant = owner
            .build_key_grant(
                2,
                &Recipient {
                    device,
                    kem_pk: KemKeyPair::from_secret(&[kem; 32]).pk,
                },
                &mut mdbn_replica::crypto::TestEntropy::new(kem),
            )
            .unwrap();
        append(&svc, &owner, ItemKind::KeyGrant, grant.to_bytes().unwrap());
    }
    let clock = Rc::new(Cell::new(1_700_000_000_000));
    let mut service_config = config(&svc);
    service_config.cfg.trusted_signers.clear(); // Actual role Workers have no HOSTED_SIGNERS override.
    let engine = Engine::open_with(
        service_config,
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
    let mut hosted = Hosted {
        e: engine,
        log: svc.client(HOSTED_DEV),
        clock,
    };
    assert!(hosted.e.bind_log(COL));
    hosted.pump(false);
    assert_eq!(
        hosted.e.mode_service_ready(),
        Some((HOSTED_DEV, 2)),
        "born-Cloud history replay must not poison fresh service admission: {:?}, {:?}, {:?}",
        hosted.e.admission(),
        hosted.e.replica().sync_status(),
        hosted.e.replica().key_wait_reason()
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
    let mut exported_config = config_value(&svc);
    if let Cbor::Map(fields) = &mut exported_config {
        fields
            .iter_mut()
            .find(|(key, _)| *key == Cbor::Uint(4))
            .unwrap()
            .1 = Cbor::Array(vec![]);
    }
    let fixture = format!(
        r#"{{"publicFixedTestValuesOnly":true,"epoch":2,"config":"{}","collection":"{}","device":"{}","unkeyed":{:?},"cloud":{:?},"private":{:?}}}"#,
        mdbn_wire::render::hex(&cbor::encode(&exported_config).unwrap()),
        COL.to_uuid_string(),
        HOSTED_DEV.to_uuid_string(),
        unkeyed_items
            .iter()
            .map(|b| mdbn_wire::render::hex(b))
            .collect::<Vec<_>>(),
        cloud_items
            .iter()
            .map(|b| mdbn_wire::render::hex(b))
            .collect::<Vec<_>>(),
        svc.items(&COL)
            .iter()
            .map(|b| mdbn_wire::render::hex(b))
            .collect::<Vec<_>>(),
    );
    println!("MODE_WORKER_FIXTURE={fixture}");
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
    let unkeyed_items = svc.items(&COL);
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
        r#"{{"publicFixedTestValuesOnly":true,"config":"{}","collection":"{}","device":"{}","unkeyed":{:?},"cloud":{:?},"private":{:?}}}"#,
        mdbn_wire::render::hex(&cbor::encode(&config_value(&svc)).unwrap()),
        COL.to_uuid_string(),
        HOSTED_DEV.to_uuid_string(),
        unkeyed_items
            .iter()
            .map(|b| mdbn_wire::render::hex(b))
            .collect::<Vec<_>>(),
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
