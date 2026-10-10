//! Cloud-only observer tests with actual Ed25519/HPKE/commitment handling.
//! FakeLog is trusted test transport, not actual service-binding/PoP/KMS execution.
use super::*;
use crate::crypto::{hpke::KemKeyPair, sign::DeviceSigner};
use crate::{
    HostedAdmission, HostedAdmissionDenial as D, HostedBootstrapAdmission as B,
    HostedKeyOperationDenial as K,
};
use mdbn_wire::client::SyncMode;
use mdbn_wire::common::B32;
use mdbn_wire::policy::{DeviceEnrol, Genesis, MemberSet, PolicyOp, Role};

#[path = "hosted_membership.rs"]
mod membership;

fn enrol(device: B16, account: B16, kind: DeviceKind, sign: [u8; 32], kem: [u8; 32]) -> PolicyOp {
    PolicyOp::DeviceEnrol(DeviceEnrol {
        device,
        account,
        kind,
        sign_pk: B32(DeviceSigner::from_seed(&sign).public()),
        kem_pk: B32(KemKeyPair::from_secret(&kem).pk),
        noise_pk: B32([device.0[0]; 32]),
        sas_commit: None,
        local_root: None,
    })
}

fn service_world() -> (FakeLogService, TestControlPlane) {
    let svc = FakeLogService::new();
    let mut cp = TestControlPlane::signed(COL);
    cp.append(
        &svc,
        vec![
            PolicyOp::Genesis(Genesis {
                owner: TEST_OWNER,
                root: crate::policy::key_id(&crate::testkit::signed_root()),
                state: CState::CloudCopy,
            }),
            PolicyOp::MemberSet(MemberSet {
                account: TEST_OWNER,
                role: Role::Owner,
            }),
            enrol(
                HOSTED_DEV,
                crate::policy::SERVICE_ACCOUNT,
                DeviceKind::Hosted,
                HOST_SIGN,
                HOST_KEM,
            ),
            enrol(
                ESCROW_DEV,
                crate::policy::SERVICE_ACCOUNT,
                DeviceKind::Escrow,
                ESCROW_SIGN,
                ESCROW_KEM,
            ),
        ],
    );
    (svc, cp)
}

/// Drive actual genesis/control/head processing, but hold outbound append calls so
/// pre-key eligibility can be observed BEFORE any key control is logged/applied.
/// No fault is invented and the production append pipeline/state is unchanged.
pub(super) fn prekey(h: &mut Hosted) -> Vec<crate::log::LogCall> {
    let mut held = Vec::new();
    for _ in 0..32 {
        h.r.tick();
        let calls = h.r.take_log_calls();
        if calls.is_empty() {
            return held;
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
    panic!("pre-key control/head processing did not settle");
}

fn eligible(h: &Hosted) -> crate::VerifiedHostedBootstrap {
    match h.r.verified_hosted_bootstrap() {
        B::Eligible(evidence) => *evidence,
        other => panic!("expected pre-key eligibility, got {other:?}"),
    }
}

fn desktop_reads_current_key(svc: &FakeLogService, h: &Hosted) {
    let mut cfg = h.r.cfg.clone();
    cfg.device_id = OWNER_DEV;
    let clock = Rc::new(Cell::new(1_700_000_000_000));
    let mut desktop = Replica::open(
        cfg,
        MemStore::new(),
        Box::new(CreatePlanner),
        Box::new(crate::seal::KeyringSealer::new(
            COL,
            OWNER_DEV,
            &OWNER_SIGN,
            &OWNER_KEM,
        )),
        Host {
            clock: Box::new(TestClock(clock)),
            entropy: Box::new(crate::crypto::TestEntropy::new(93)),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: OWNER_SIGN,
            kem_sk: OWNER_KEM,
        },
    )
    .unwrap();
    let mut log = svc.client(OWNER_DEV);
    for _ in 0..64 {
        desktop.tick();
        let calls = desktop.take_log_calls();
        if calls.is_empty() {
            break;
        }
        for call in calls {
            let reply = log.call(call.request);
            desktop.on_log_reply(call.id, reply);
        }
    }
    assert_eq!(
        desktop.sealer.current_epoch(),
        Some(1),
        "the approved desktop actually unwraps/commitment-checks the key"
    );
    assert_eq!(
        desktop.policy.devices[&OWNER_DEV].delivered_by,
        Some(HOSTED_DEV)
    );
}

#[test]
fn verified_observer_cloud_real_hosted_first_and_approved_join_without_owner_online() {
    let (svc, mut cp) = service_world();
    let mut h = crypto_open(&svc, MemStore::new());
    let held = prekey(&mut h);
    assert_eq!(held.len(), 1);
    assert_eq!(h.r.policy.devices.len(), 2, "no user device at genesis");
    eligible(&h);
    assert_eq!(
        h.r.verified_hosted_admission(),
        HostedAdmission::Deny(D::KeyUnavailable)
    );
    for call in held {
        let reply = h.log.call(call.request);
        h.r.on_log_reply(call.id, reply);
    }
    h.pump();
    assert_eq!(verified(&h).key_delivery_device(), HOSTED_DEV);
    assert_eq!(verified(&h).key_delivery_seq(), 2);
    cp.append(
        &svc,
        vec![enrol(
            OWNER_DEV,
            TEST_OWNER,
            DeviceKind::Desktop,
            OWNER_SIGN,
            OWNER_KEM,
        )],
    );
    h.pump();
    let proof = h.r.verified_hosted_key_recipient(OWNER_DEV).unwrap();
    assert_eq!(proof.kem_pk().0, KemKeyPair::from_secret(&OWNER_KEM).pk);
    assert_eq!(
        h.r.policy.devices[&OWNER_DEV].delivered_by,
        Some(HOSTED_DEV)
    );
    desktop_reads_current_key(&svc, &h);
}

#[test]
fn verified_observer_cloud_real_join_before_initial_does_not_require_owner_online() {
    let (svc, mut cp) = service_world();
    cp.append(
        &svc,
        vec![enrol(
            OWNER_DEV,
            TEST_OWNER,
            DeviceKind::Desktop,
            OWNER_SIGN,
            OWNER_KEM,
        )],
    );
    let mut h = crypto_open(&svc, MemStore::new());
    let held = prekey(&mut h);
    assert_eq!(held.len(), 1);
    eligible(&h);
    assert_eq!(h.r.policy.epoch, 0);
    for call in held {
        let reply = h.log.call(call.request);
        h.r.on_log_reply(call.id, reply);
    }
    h.pump();
    assert_eq!(verified(&h).key_delivery_device(), HOSTED_DEV);
    assert_eq!(
        h.r.policy.devices[&OWNER_DEV].delivered_by,
        Some(HOSTED_DEV)
    );
    desktop_reads_current_key(&svc, &h);
}

#[test]
fn verified_observer_cloud_prekey_is_distinct_from_serving_and_current_after_closed() {
    let (svc, _) = service_world();
    let mut h = crypto_open(&svc, MemStore::new());
    assert_eq!(h.r.verified_hosted_bootstrap(), B::Deny(D::HeadUnproven));
    let _held = prekey(&mut h);
    let before = eligible(&h);
    assert_eq!(before.device(), HOSTED_DEV);
    assert_eq!(before.applied_head().seq, 1);
    assert_eq!(h.r.sealer.current_epoch(), None);
    assert_eq!(
        h.r.verified_hosted_admission(),
        HostedAdmission::Deny(D::KeyUnavailable)
    );
    h.r.on_log_push(crate::log::LogPush::Closed {
        collection: COL,
        reason: "forbidden".into(),
    });
    assert_eq!(h.r.verified_hosted_bootstrap(), B::Deny(D::HeadUnproven));
    h.r.tick();
    assert_eq!(h.r.verified_hosted_bootstrap(), B::Deny(D::HeadUnproven));
    let _held = prekey(&mut h);
    assert!(eligible(&h).generation() > before.generation());
    assert_eq!(
        h.r.verified_hosted_admission(),
        HostedAdmission::Deny(D::KeyUnavailable)
    );
}

#[test]
fn verified_observer_cloud_prekey_rejects_wrong_mode_identity_origin_and_fault() {
    let (svc, _) = service_world();
    let mut h = crypto_open(&svc, MemStore::new());
    let _held = prekey(&mut h);
    eligible(&h);
    h.r.cfg.mode = SyncMode::LocalOnly;
    assert_eq!(h.r.verified_hosted_bootstrap(), B::Deny(D::NotHosted));
    h.r.cfg.mode = SyncMode::Synced;
    h.r.policy.cstate = Some(CState::E2e);
    // The producer withdraws its current-head fact as soon as mode ceases to be cloud.
    assert_eq!(h.r.verified_hosted_bootstrap(), B::Deny(D::HeadUnproven));
    h.r.policy.cstate = Some(CState::CloudCopy);
    let kem = h.r.policy.devices[&HOSTED_DEV].kem_pk;
    h.r.policy.devices.get_mut(&HOSTED_DEV).unwrap().kem_pk = B32([0x99; 32]);
    assert_eq!(
        h.r.verified_hosted_bootstrap(),
        B::Deny(D::IdentityMismatch)
    );
    h.r.policy.devices.get_mut(&HOSTED_DEV).unwrap().kem_pk = kem;
    eligible(&h);
    h.r.hosted_origin_unproven();
    assert_eq!(
        h.r.verified_hosted_bootstrap(),
        B::Deny(D::PolicyOriginUnproven)
    );
    h.r.apply_fault = true;
    assert_eq!(
        h.r.verified_hosted_bootstrap(),
        B::Deny(D::CacheUnavailable)
    );
}

#[test]
fn verified_observer_cloud_recipient_is_exact_current_enrollment_not_caller_approval() {
    use mdbn_wire::policy::DeviceRevoke;
    let (svc, mut cp) = crypto_world();
    crypto_wrap(&svc, OWNER_DEV);
    let mut h = crypto_open(&svc, MemStore::new());
    h.pump();
    let proof = h.r.verified_hosted_key_recipient(OWNER_DEV).unwrap();
    assert_eq!(proof.recipient(), OWNER_DEV);
    assert_eq!(proof.account(), TEST_OWNER);
    assert_eq!(
        proof.sign_pk().0,
        DeviceSigner::from_seed(&OWNER_SIGN).public()
    );
    assert_eq!(proof.kem_pk().0, KemKeyPair::from_secret(&OWNER_KEM).pk);
    assert_eq!(proof.sender().epoch(), 1);
    for recipient in [B16([0xff; 16]), HOSTED_DEV, ESCROW_DEV] {
        assert_eq!(
            h.r.verified_hosted_key_recipient(recipient),
            Err(K::RecipientUnproven)
        );
    }
    // Actual control revocation after obtaining evidence: an old proof is not a
    // permit, and observing at the next operation boundary must fail closed.
    cp.append(
        &svc,
        vec![PolicyOp::DeviceRevoke(DeviceRevoke { device: OWNER_DEV })],
    );
    h.pump();
    assert!(h.r.verified_hosted_key_recipient(OWNER_DEV).is_err());
    assert!(!h.r.policy.devices[&OWNER_DEV].active);
}

/// Match the DO pumpLog lifecycle: transport replies drive work; no tick between
/// each reply. A timer and a fresh authenticated binding bound each poll.
fn bound_pump_without_extra_ticks(
    h: &mut Hosted,
    session: &crate::replica::AuthenticatedLogSession,
) {
    for _ in 0..128 {
        let calls = h.r.take_authenticated_log_calls(session).unwrap();
        if calls.is_empty() {
            return;
        }
        for (call, scope) in calls {
            let reply = h.log.call(call.request);
            h.r.on_authenticated_log_reply(scope, |_, _| reply).unwrap();
        }
    }
    panic!("authenticated service poll did not settle");
}

#[test]
fn hosted_timer_poll_grants_new_enrolment_after_warm_wake() {
    let (svc, mut cp) = service_world();
    let store = MemStore::new();
    let data = store.data();
    let mut h = crypto_open(&svc, store);
    let session = h.r.bind_authenticated_log(h.r.endpoint, COL).unwrap();
    bound_pump_without_extra_ticks(&mut h, &session);
    assert_eq!(h.r.sealer.current_epoch(), Some(1));
    assert!(h.r.policy.devices[&HOSTED_DEV].keyed);
    drop(h);
    cp.append(
        &svc,
        vec![enrol(
            OWNER_DEV,
            TEST_OWNER,
            DeviceKind::Desktop,
            OWNER_SIGN,
            OWNER_KEM,
        )],
    );
    let mut h = crypto_open(&svc, MemStore::shared(data));
    let session = h.r.bind_authenticated_log(h.r.endpoint, COL).unwrap();
    bound_pump_without_extra_ticks(&mut h, &session);
    assert!(h.r.policy.devices[&HOSTED_DEV].keyed);
    assert_eq!(
        h.r.policy.devices[&OWNER_DEV].delivered_by,
        Some(HOSTED_DEV)
    );
    desktop_reads_current_key(&svc, &h);
}

#[test]
fn hosted_gen0_revocation_inspection_binds_signed_control_and_full_current_proof() {
    use mdbn_wire::cbor::{Cbor, encode};
    use mdbn_wire::common::B64;
    use mdbn_wire::policy::CpKeyRevoke;
    let (svc, mut cp) = service_world();
    let mut h = crypto_open(&svc, MemStore::new());
    h.pump();
    let before = verified(&h);
    let key = crate::policy::key_id(&[0x47; 32]);
    // Unknown keys are not authorized by a false inspection result.
    assert_eq!(h.r.hosted_gen0_cp_key_revoked(&before, key), Some(false));
    let encoded = encode(&Cbor::Array(vec![key.to_cbor(), Cbor::int(0)])).unwrap();
    let digest = mdbn_wire::hash::h("mdbase/v1/cp-key-revoke", &encoded);
    let root_sig =
        B64(DeviceSigner::from_seed(&crate::testkit::SIGNED_ROOT_SEED).sign_digest(&digest.0));
    cp.append(
        &svc,
        vec![PolicyOp::CpKeyRevoke(CpKeyRevoke {
            key_id: key,
            revoked_from: 0,
            root_sig,
        })],
    );
    h.pump();
    let current = verified(&h);
    assert_ne!(current, before);
    assert_eq!(h.r.hosted_gen0_cp_key_revoked(&before, key), None);
    assert_eq!(h.r.hosted_gen0_cp_key_revoked(&current, key), Some(true));
    assert_eq!(
        verified(&h),
        current,
        "inspection changes no admission state"
    );
}

#[test]
fn hosted_gen0_revocation_inspection_refuses_foreign_wake_generation_and_closed() {
    let (svc, _) = service_world();
    let store = MemStore::new();
    let data = store.data();
    let mut h = crypto_open(&svc, store);
    h.pump();
    let before = verified(&h);
    let key = B16([0x48; 16]);
    let mut foreign = crypto_open(&svc, MemStore::new());
    foreign.pump();
    assert_eq!(foreign.r.hosted_gen0_cp_key_revoked(&before, key), None);
    assert_eq!(
        foreign
            .r
            .hosted_gen0_cp_key_revoked(&verified(&foreign), key),
        Some(false)
    );
    h.r.on_log_push(crate::log::LogPush::Closed {
        collection: COL,
        reason: "forbidden".into(),
    });
    assert_eq!(h.r.hosted_gen0_cp_key_revoked(&before, key), None);
    h.pump();
    let renewed = verified(&h);
    assert_ne!(renewed.generation(), before.generation());
    assert_eq!(h.r.hosted_gen0_cp_key_revoked(&before, key), None);
    assert_eq!(h.r.hosted_gen0_cp_key_revoked(&renewed, key), Some(false));
    let cfg = h.r.cfg.clone();
    let clock = h.clock.clone();
    drop(h);
    // crypto_open resets TestEntropy to seed 91. Use another deterministic
    // stream for a genuinely fresh wake, without changing private proof fields.
    let r = Replica::open_hosted(
        cfg,
        MemStore::shared(data),
        Box::new(CreatePlanner),
        Box::new(crate::seal::KeyringSealer::new(
            COL, HOSTED_DEV, &HOST_SIGN, &HOST_KEM,
        )),
        Host {
            clock: Box::new(TestClock(clock.clone())),
            entropy: Box::new(crate::crypto::TestEntropy::new(192)),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: HOST_SIGN,
            kem_sk: HOST_KEM,
        },
        HostedProfile::default(),
    )
    .unwrap();
    let mut reopened = Hosted {
        r,
        log: svc.client(HOSTED_DEV),
        clock,
    };
    reopened.pump();
    let fresh = verified(&reopened);
    assert_ne!(fresh.wake_instance(), renewed.wake_instance());
    assert_eq!(reopened.r.hosted_gen0_cp_key_revoked(&renewed, key), None);
    assert_eq!(
        reopened.r.hosted_gen0_cp_key_revoked(&fresh, key),
        Some(false)
    );
}

#[test]
fn receipt_fanout_hosted_collision_only_original_submitter_gets_transient_rejection() {
    use crate::api::Push;
    let (svc, mut cp) = service_world();
    cp.append(
        &svc,
        vec![enrol(
            OWNER_DEV,
            TEST_OWNER,
            DeviceKind::Desktop,
            OWNER_SIGN,
            OWNER_KEM,
        )],
    );
    let mut original = crypto_open(&svc, MemStore::new());
    original.pump();
    verified(&original);
    for grant in [G1, G2] {
        cp.approved_grant(
            &svc,
            grant,
            [grant.0[0]; 32],
            &["collection.read", "records.create"],
            None,
            OWNER_DEV,
        );
    }
    original.pump();
    let origin = original.session(G1);
    let same_grant = original.session(G1);
    let rival_session = original.session(G2);
    let host = original.r.hello(SessionAuth::Host, hello()).unwrap().0;
    original.r.take_pushes();
    let mutation = mid(0x7e);
    let ticket = original
        .r
        .submit_logged(origin, create(0x71, "original.md", Some(mutation)))
        .unwrap();
    assert_eq!(
        original
            .r
            .store
            .pending_get(&mutation)
            .unwrap()
            .unwrap()
            .grant,
        Some(G1)
    );
    // A genuinely distinct wake/custody instance logs G2's rival first. No
    // payload rewrite, manufactured proof or PlainSealer admission is used.
    let mut cfg = original.r.cfg.clone();
    cfg.replica_id = B16([0x6a; 16]);
    let clock = original.clock.clone();
    let r = Replica::open_hosted(
        cfg,
        MemStore::new(),
        Box::new(CreatePlanner),
        Box::new(crate::seal::KeyringSealer::new(
            COL, HOSTED_DEV, &HOST_SIGN, &HOST_KEM,
        )),
        Host {
            clock: Box::new(TestClock(clock.clone())),
            entropy: Box::new(crate::crypto::TestEntropy::new(194)),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: HOST_SIGN,
            kem_sk: HOST_KEM,
        },
        HostedProfile::default(),
    )
    .unwrap();
    let mut rival = Hosted {
        r,
        log: svc.client(HOSTED_DEV),
        clock,
    };
    rival.pump();
    assert_ne!(
        verified(&original).wake_instance(),
        verified(&rival).wake_instance()
    );
    let rival_submitter = rival.session(G2);
    let rival_ticket = rival
        .r
        .submit_logged(rival_submitter, create(0x72, "rival.md", Some(mutation)))
        .unwrap();
    rival.pump();
    assert_eq!(rival.ack(rival_ticket).state, ReceiptState::Confirmed);
    let (rival_head, rival_chain) = svc.head(&COL);
    // Drive only actual read/subscription replies to the original. Holding
    // append/lookup calls proves the pending foreign-grant APPLY branch runs,
    // rather than the already-correct nonpersisted drop-pending exception.
    original.r.on_log_push(crate::log::LogPush::Head {
        collection: COL,
        head: rival_head,
        head_chain: rival_chain,
    });
    let mut held = Vec::new();
    for _ in 0..64 {
        original.r.tick();
        for call in original.r.take_log_calls() {
            if matches!(
                call.request,
                LogRequest::Read(_) | LogRequest::Subscribe { .. }
            ) {
                let reply = original.log.call(call.request);
                original.r.on_log_reply(call.id, reply);
            } else {
                held.push(call);
            }
        }
        if original.r.head.seq >= rival_head
            && original.r.store.pending_get(&mutation).unwrap().is_none()
        {
            break;
        }
    }
    assert!(original.r.head.seq >= rival_head);
    assert!(original.r.store.pending_get(&mutation).unwrap().is_none());
    let persisted = original.r.store.local_receipt(&mutation).unwrap().unwrap();
    assert_eq!(persisted.grant, Some(G2));
    assert_eq!(persisted.state, ReceiptState::Confirmed);
    let rejected = original.ack(ticket);
    assert_eq!(rejected.state, ReceiptState::Rejected);
    assert_eq!(
        rejected.problem.and_then(|p| p.reason).as_deref(),
        Some("mutation_id_in_use")
    );
    assert_eq!(rejected.seq, None);
    let targets: Vec<_> = original.r.take_pushes().into_iter().filter_map(|(session, push)| {
        matches!(push, Push::Receipt(receipt) if receipt.mutation == mutation && receipt.state == ReceiptState::Rejected).then_some(session)
    }).collect();
    assert_eq!(
        targets,
        vec![origin],
        "transient rejection belongs only to the original connection, not stored rival ownership"
    );
    assert!(!targets.contains(&same_grant));
    assert!(!targets.contains(&rival_session));
    assert!(!targets.contains(&host));
    assert_eq!(
        original.r.receipt(rival_session, mutation).unwrap().state,
        ReceiptState::Confirmed
    );
    assert_eq!(
        original.r.receipt(origin, mutation).unwrap_err().code(),
        Some(ErrorCode::NotFound)
    );
    assert_eq!(
        svc.head(&COL).0,
        rival_head,
        "original mutation never appended"
    );
    drop(held);
}

#[test]
fn hosted_gen0_revocation_inspection_refuses_prekey_and_faulted_state() {
    let (svc, _) = service_world();
    let mut healthy = crypto_open(&svc, MemStore::new());
    healthy.pump();
    let expected = verified(&healthy);
    let key = B16([0x49; 16]);
    let (pre_svc, _) = service_world();
    let mut pre = crypto_open(&pre_svc, MemStore::new());
    let _held = prekey(&mut pre);
    eligible(&pre);
    assert_eq!(pre.r.sealer.current_epoch(), None);
    assert_eq!(pre.r.hosted_gen0_cp_key_revoked(&expected, key), None);
    healthy.r.apply_fault = true;
    assert_eq!(
        healthy.r.verified_hosted_admission(),
        HostedAdmission::Deny(D::CacheUnavailable)
    );
    assert_eq!(healthy.r.hosted_gen0_cp_key_revoked(&expected, key), None);
}

#[test]
fn hosted_gen0_custody_one_slot_stale_and_foreign_handles_preserve_successor() {
    use crate::replica::gen0::HostedGen0Error as E;
    let (svc, _) = service_world();
    let mut h = crypto_open(&svc, MemStore::new());
    h.pump();
    let proof = verified(&h);
    let first = h.r.hosted_gen0_begin(&proof, 0, false, false).unwrap();
    assert_eq!(
        h.r.hosted_gen0_begin(&proof, 0, false, false).err(),
        Some(E::Busy)
    );
    h.r.hosted_gen0_abort(&proof, &first).unwrap();
    let next = h.r.hosted_gen0_begin(&proof, 0, false, false).unwrap();
    assert_eq!(h.r.hosted_gen0_abort(&proof, &first), Err(E::Handle));
    let mut foreign = crypto_open(&svc, MemStore::new());
    foreign.pump();
    let foreign_proof = verified(&foreign);
    let foreign_handle = foreign
        .r
        .hosted_gen0_begin(&foreign_proof, 0, false, false)
        .unwrap();
    assert_eq!(
        h.r.hosted_gen0_abort(&proof, &foreign_handle),
        Err(E::Handle)
    );
    // Both identities refused before consuming the matching new slot.
    h.r.hosted_gen0_resources(&proof, &next, vec![]).unwrap();
    h.r.hosted_gen0_abort(&proof, &next).unwrap();
    foreign
        .r
        .hosted_gen0_abort(&foreign_proof, &foreign_handle)
        .unwrap();
    assert_eq!(verified(&h), proof);
    assert!(h.r.take_log_calls().is_empty());
}

#[test]
fn hosted_gen0_custody_closed_full_proof_drift_poisons_matching_writer() {
    use crate::replica::gen0::HostedGen0Error as E;
    let (svc, _) = service_world();
    let mut h = crypto_open(&svc, MemStore::new());
    h.pump();
    let before = verified(&h);
    let handle = h.r.hosted_gen0_begin(&before, 0, false, false).unwrap();
    h.r.on_log_push(crate::log::LogPush::Closed {
        collection: COL,
        reason: "forbidden".into(),
    });
    assert_eq!(
        h.r.hosted_gen0_resources(&before, &handle, vec![]).err(),
        Some(E::Denied)
    );
    h.pump();
    let fresh = verified(&h);
    assert_ne!(before, fresh);
    let next = h.r.hosted_gen0_begin(&fresh, 0, false, false).unwrap();
    assert_eq!(h.r.hosted_gen0_abort(&fresh, &handle), Err(E::Handle));
    h.r.hosted_gen0_abort(&fresh, &next).unwrap();
}

#[test]
fn hosted_gen0_custody_owned_reserved_capacity_refuses_and_poisons() {
    use crate::replica::gen0::HostedGen0Error as E;
    let (svc, _) = service_world();
    let mut h = crypto_open(&svc, MemStore::new());
    h.pump();
    let proof = verified(&h);
    let handle = h.r.hosted_gen0_begin(&proof, 0, false, false).unwrap();
    let oversized: Vec<(String, String)> = Vec::with_capacity(3000);
    assert_eq!(
        h.r.hosted_gen0_resources(&proof, &handle, oversized).err(),
        Some(E::Budget)
    );
    assert_eq!(h.r.hosted_gen0_abort(&proof, &handle), Err(E::Handle));
    let next = h.r.hosted_gen0_begin(&proof, 0, false, false).unwrap();
    let mut doc = String::with_capacity(65537);
    doc.push('x');
    assert_eq!(
        h.r.hosted_gen0_resources(&proof, &next, vec![("mdbase.yaml".into(), doc)])
            .err(),
        Some(E::Budget)
    );
    assert_eq!(verified(&h), proof);
    assert!(h.r.take_log_calls().is_empty());
    let next = h.r.hosted_gen0_begin(&proof, 0, false, false).unwrap();
    h.r.hosted_gen0_abort(&proof, &next).unwrap();
}

#[test]
fn hosted_gen0_custody_order_failure_and_retained_ref_reservation_refuse() {
    use crate::replica::gen0::{Gen0Error, HostedGen0Error as E};
    let (svc, _) = service_world();
    let mut h = crypto_open(&svc, MemStore::new());
    h.pump();
    let proof = verified(&h);
    // Even empty announced sections count before reserving a writer.
    assert_eq!(
        h.r.hosted_gen0_begin(&proof, 8, true, true).err(),
        Some(E::Budget)
    );
    let handle = h.r.hosted_gen0_begin(&proof, 0, false, false).unwrap();
    assert!(matches!(
        h.r.hosted_gen0_bucket(&proof, &handle, 0, vec![], vec![], &[]),
        Err(E::Writer(Gen0Error::Order(_)))
    ));
    assert_eq!(h.r.hosted_gen0_abort(&proof, &handle), Err(E::Handle));
    let next = h.r.hosted_gen0_begin(&proof, 0, false, false).unwrap();
    h.r.hosted_gen0_resources(&proof, &next, vec![]).unwrap();
    let refs = vec![B32([0x71; 32]); 1024];
    assert_eq!(
        h.r.hosted_gen0_bucket(&proof, &next, 0, vec![], vec![], &refs)
            .err(),
        Some(E::Budget)
    );
    assert_eq!(h.r.hosted_gen0_abort(&proof, &next), Err(E::Handle));
    assert_eq!(verified(&h), proof);
    assert!(h.r.take_log_calls().is_empty());
}

#[test]
fn hosted_gen0_custody_real_crypto_resources_bucket_finish_consumes_slot() {
    use crate::replica::gen0::{Gen0Record, HostedGen0Error as E};
    use mdbn_wire::intent::FileInclusion;
    let (svc, _) = service_world();
    let mut h = crypto_open(&svc, MemStore::new());
    h.pump();
    let proof = verified(&h);
    let handle = h.r.hosted_gen0_begin(&proof, 0, true, true).unwrap();
    let resources =
        h.r.hosted_gen0_resources(
            &proof,
            &handle,
            vec![("mdbase.yaml".into(), "version: 1\n".into())],
        )
        .unwrap();
    let bucket =
        h.r.hosted_gen0_bucket(
            &proof,
            &handle,
            0,
            vec![Gen0Record {
                id: B16([0x72; 16]),
                path: "notes/one.md".into(),
                doc: "# Native fixture\n".into(),
            }],
            vec![],
            &[],
        )
        .unwrap();
    let (finish, manifest) =
        h.r.hosted_gen0_finish(
            &proof,
            &handle,
            B32([0x74; 32]),
            FileInclusion {
                include: vec![],
                exclude: None,
                max_size: None,
            },
        )
        .unwrap();
    assert!(!resources.is_empty());
    assert!(bucket.len() <= 7);
    assert_eq!(finish.len(), 5);
    assert!(
        resources
            .iter()
            .chain(&bucket)
            .chain(&finish)
            .all(|o| !o.bytes.is_empty())
    );
    assert!(manifest.ref_indices.is_empty());
    assert!(!manifest.manifest.bytes.is_empty());
    assert!(manifest.base_refs.len() <= 1025);
    assert_eq!(h.r.hosted_gen0_abort(&proof, &handle), Err(E::Handle));
    assert_eq!(verified(&h), proof);
    assert!(h.r.take_log_calls().is_empty());
    let next = h.r.hosted_gen0_begin(&proof, 0, false, false).unwrap();
    h.r.hosted_gen0_abort(&proof, &next).unwrap();
}
