//! Synthetic applied-policy fixture, REAL SAS and HPKE, injected host authority.
//! Not Control deployment, native keychain or physical durability acceptance.
use super::*;
use crate::api::SessionAuth;
use crate::approval::{Answer, NewDevice};
use crate::crypto::{
    TestEntropy,
    keys::{self, EnrolledKeys, Keyring, Recipient},
};
use crate::log::EndpointId;
use crate::mem::MemStore;
use crate::policy::{EffectiveGrant, GrantSource, PolicyState};
use crate::seal::KeyringSealer;
use crate::{ClientApi, CorePlanner, DeviceSecrets, Host, ReplicaConfig, Sealer, UtcOnly};
use mdbn_core::host::Clock;
use mdbn_wire::client::{HelloParams, SyncMode};
use mdbn_wire::common::{B16, Version};
use mdbn_wire::envelope::RekeyReason;
use std::{cell::Cell, rc::Rc};

const COL: Uuid = B16([7; 16]);
const ACCOUNT: Uuid = B16([8; 16]);
const ME: Uuid = B16([1; 16]);
const NEW: Uuid = B16([2; 16]);
#[derive(Clone)]
struct ClockRef(Rc<Cell<u64>>);
impl Clock for ClockRef {
    fn now_ms(&self) -> u64 {
        self.0.get()
    }
}
#[derive(Clone)]
struct Source(Rc<Cell<Option<ApprovalAuthorityStamp>>>);
impl GrantSource for Source {
    fn grant(&self, _: &Uuid) -> Option<EffectiveGrant> {
        None
    }
    fn active_account(&self) -> Option<Uuid> {
        self.0.get().map(|s| s.account)
    }
    fn authority_epoch(&self) -> Option<u64> {
        self.0.get().map(|s| s.epoch)
    }
    fn device_noise_pk(&self) -> Option<B32> {
        self.0.get().map(|_| B32(tuple(ME, 10).noise_pk))
    }
}
fn tuple(id: Uuid, seed: u8) -> EnrolledKeys {
    EnrolledKeys {
        device: id,
        sign_pk: DeviceSigner::from_seed(&[seed; 32]).public(),
        kem_pk: KemKeyPair::from_secret(&[seed; 32]).pk,
        noise_pk: KemKeyPair::from_secret(&[seed + 1; 32]).pk,
    }
}
fn device(k: EnrolledKeys, keyed: bool, commit: Option<[u8; 32]>) -> DeviceState {
    DeviceState {
        account: ACCOUNT,
        kind: DeviceKind::Desktop,
        sign_pk: B32(k.sign_pk),
        kem_pk: B32(k.kem_pk),
        noise_pk: B32(k.noise_pk),
        active: true,
        keyed,
        introduced_by: keyed.then_some(ME),
        delivered_by: keyed.then_some(ME),
        local_root: None,
        sas_commit: commit.map(B32),
    }
}
fn fixture() -> (Replica<MemStore>, SessionId, NewDevice, Source, ClockRef) {
    let source = Source(Rc::new(Cell::new(Some(ApprovalAuthorityStamp {
        account: ACCOUNT,
        epoch: 1,
    }))));
    let clock = ClockRef(Rc::new(Cell::new(1_000)));
    let mut rng = TestEntropy::new(90);
    let n = NewDevice::new(COL, tuple(NEW, 20), &mut rng);
    let (rekey, _) = keys::build_rekey(
        &COL,
        0,
        &Keyring::new(),
        &[Recipient {
            device: ME,
            kem_pk: tuple(ME, 10).kem_pk,
        }],
        RekeyReason::Initial,
        &mut rng,
    )
    .unwrap();
    let mut sealer = KeyringSealer::new(COL, ME, &[10; 32], &[10; 32]);
    sealer.accept_rekey(&rekey);
    sealer.set_epoch(1);
    let cfg = ReplicaConfig {
        collection: COL,
        replica_id: B16([3; 16]),
        device_id: ME,
        mode: SyncMode::Synced,
        log_endpoint: EndpointId(1),
        verify: false,
        runtime_version: "test".into(),
        trusted_roots: vec![],
        e2e: true,
        trusted_signers: vec![ME],
        user_enabled_cloud_copy: false,
        chosen_state: Some(CState::E2e),
        expected_genesis: None,
        key_grants_only: false,
        policy_pins: None,
    };
    let mut r = Replica::open_with_grant_source(
        cfg,
        MemStore::new(),
        Box::new(CorePlanner),
        Box::new(sealer),
        Host {
            clock: Box::new(clock.clone()),
            entropy: Box::new(rng),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: [10; 32],
            kem_sk: [10; 32],
        },
        Box::new(source.clone()),
    )
    .unwrap();
    let mut p = PolicyState::new();
    p.cstate = Some(CState::E2e);
    p.epoch = 1;
    p.members.insert(ACCOUNT, Role::Owner);
    p.devices.insert(ME, device(tuple(ME, 10), true, None));
    p.devices
        .insert(NEW, device(tuple(NEW, 20), false, Some(n.commitment())));
    r.policy = p;
    r.sealer.set_epoch(1); // open used the empty store's epoch 0; fixture installs applied policy here.
    r.check_key_trust();
    let (s, _) = r
        .hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "test".into(),
                client_version: "0".into(),
                features: None,
                timezone: None,
            },
        )
        .unwrap();
    (r, s, n, source, clock)
}
fn answer(r: &Replica<MemStore>, n: &mut NewDevice, c: ApprovalChallenge) -> ApprovalReveal {
    let Answer::Reveal { r_n, .. } = n.on_challenge(&r.policy, &ME, &c.r_a.0) else {
        panic!("requester reveal");
    };
    ApprovalReveal {
        challenge: c,
        r_n: B32(r_n),
    }
}

#[test]
fn approval_runtime_persists_consumed_commit_before_code_free_exchange() {
    let (mut r, s, mut n, _, _) = fixture();
    let c = r.start_device_approval(s, NEW).unwrap();
    assert_eq!(r.store.meta(&marker(&c.binding)).unwrap(), Some(vec![1]));
    assert_eq!(r.start_device_approval(s, NEW).unwrap(), c); // identical challenge retry
    assert_eq!(r.take_device_approval_challenges(), vec![c.clone()]);
    assert!(!r.pending_devices(s).unwrap()[0].exchange_ready);
    let reveal = answer(&r, &mut n, c);
    r.receive_device_reveal(s, &reveal).unwrap();
    r.receive_device_reveal(s, &reveal).unwrap(); // exact peer retry is idempotent
    assert!(r.pending_devices(s).unwrap()[0].exchange_ready);
    // Actor's output is only a readiness boolean; requester reveals its own code.
    assert!(r.take_pushes().iter().any(
        |(_, p)| matches!(p, Push::ApprovalReady {device,exchange_ready:true} if *device == NEW)
    ));
}

#[test]
fn approval_runtime_lost_ram_requires_new_logged_commit() {
    let (mut r, s, mut n, _, _) = fixture();
    let old = r.start_device_approval(s, NEW).unwrap();
    // Model process loss while retaining the actual committed store marker.
    r.approval = ApprovalRuntime::new(COL, ME);
    assert_eq!(
        r.start_device_approval(s, NEW)
            .unwrap_err()
            .0
            .reason
            .as_deref(),
        Some("approval_commit_required")
    );
    let fresh = n.fresh(&mut TestEntropy::new(92));
    r.policy.devices.get_mut(&NEW).unwrap().sas_commit = Some(B32(fresh));
    let c = r.start_device_approval(s, NEW).unwrap();
    assert_ne!(c.binding.commitment, old.binding.commitment);
    r.receive_device_reveal(s, &answer(&r, &mut n, c)).unwrap();
}

#[test]
fn approval_runtime_durable_abort_allows_safe_retry_without_claiming_unknown() {
    let (mut r, s, _, _, _) = fixture();
    r.store.fail_commits(1);
    assert_eq!(
        r.start_device_approval(s, NEW).unwrap_err().0.code,
        "unavailable"
    );
    assert!(!r.approval.poisoned);
    assert!(r.take_device_approval_challenges().is_empty());
    r.start_device_approval(s, NEW).unwrap();
}

#[test]
fn approval_runtime_record_progress_preserves_challenge_but_control_aba_cancels() {
    let (mut r, s, _, _, _) = fixture();
    let c = r.start_device_approval(s, NEW).unwrap();
    r.policy.seq += 1;
    r.policy.log_time += 100;
    assert_eq!(r.start_device_approval(s, NEW).unwrap(), c);
    r.policy.ctl_chain = B32([0x88; 32]); // a security control, even if tuple returns to A
    assert!(r.take_device_approval_challenges().is_empty());
    assert!(r.start_device_approval(s, NEW).is_err());
}

#[test]
fn approval_runtime_unknown_save_never_emits_and_poison_stays_closed() {
    for after in [false, true] {
        let (mut r, s, _, _, _) = fixture();
        let actual_head = r.head;
        let actual_head_known = r.head_known;
        r.pushes.push((
            s,
            Push::FileChunk(mdbn_wire::client::FileChunk {
                stream: 1,
                offset: 0,
                bytes: mdbn_wire::common::Bytes(b"PUBLIC SYNTHETIC BODY".to_vec()),
                last: true,
            }),
        ));
        if after {
            r.store.fail_after_commit(1);
        } else {
            r.store.fail_unknown_commits(1);
        }
        assert_eq!(
            r.start_device_approval(s, NEW).unwrap_err().0.code,
            "outcome_unknown"
        );
        assert!(r.approval.poisoned);
        assert!(r.requires_reopen());
        assert_eq!(r.head, actual_head);
        assert_eq!(r.head_known, actual_head_known); // Metadata failure is not a new log-head observation.
        assert!(r.calls.is_empty());
        assert!(r.inflight.is_empty());
        assert!(r.sessions.is_empty());
        assert!(r.take_device_approval_challenges().is_empty());
        assert!(r.start_device_approval(s, NEW).is_err());
        assert!(r.pending_devices(s).is_err());
        assert!(r.describe(s).is_err());
        let outbound = r.take_pushes();
        assert!(outbound.iter().all(|(_, p)| matches!(p, Push::Closed(_))));
        assert!(
            outbound
                .iter()
                .any(|(id, p)| *id == s && matches!(p, Push::Closed(_)))
        );
    }
}

#[test]
fn approval_runtime_context_changes_cancel_before_output_or_late_reveal() {
    for case in 0..10 {
        let (mut r, s, mut n, source, clock) = fixture();
        let c = r.start_device_approval(s, NEW).unwrap();
        let reveal = answer(&r, &mut n, c);
        match case {
            0 => source.0.set(None),
            1 => source.0.set(Some(ApprovalAuthorityStamp {
                account: ACCOUNT,
                epoch: 2,
            })), // A->B->A
            2 => r.policy.devices.get_mut(&NEW).unwrap().noise_pk = B32([0x55; 32]),
            3 => r.policy.devices.get_mut(&NEW).unwrap().sas_commit = Some(B32([0x11; 32])),
            4 => r.policy.epoch = 2,
            5 => {
                r.policy.members.insert(ACCOUNT, Role::Viewer);
            }
            6 => r.policy.cstate = Some(CState::CloudCopy),
            7 => clock.0.set(121_000),
            8 => clock.0.set(999),
            9 => r.close(s),
            _ => unreachable!(),
        }
        assert!(
            r.take_device_approval_challenges().is_empty(),
            "case {case}"
        );
        assert!(r.receive_device_reveal(s, &reveal).is_err(), "case {case}");
        assert!(r.approval.exchanges.is_empty(), "case {case}");
    }
}

#[test]
fn approval_runtime_invalid_reveals_exhaust_without_reset_or_ready() {
    let (mut r, s, mut n, _, _) = fixture();
    let c = r.start_device_approval(s, NEW).unwrap();
    let valid = answer(&r, &mut n, c.clone());
    r.receive_device_reveal(s, &valid).unwrap();
    let bad = ApprovalReveal {
        challenge: c,
        r_n: B32([0x22; 32]),
    };
    for _ in 0..3 {
        assert!(r.receive_device_reveal(s, &bad).is_err());
    }
    assert!(r.receive_device_reveal(s, &valid).is_err());
    assert!(r.start_device_approval(s, NEW).is_err());
    assert!(!r.pending_devices(s).unwrap()[0].exchange_ready);
    assert!(!r.take_pushes().iter().any(|(_, p)| matches!(
        p,
        Push::ApprovalReady {
            exchange_ready: true,
            ..
        }
    )));
}

#[test]
fn approval_runtime_initial_wrong_own_noise_custody_denies() {
    let (mut r, s, _, _, _) = fixture();
    r.policy.devices.get_mut(&ME).unwrap().noise_pk = B32([0x33; 32]);
    assert!(r.start_device_approval(s, NEW).is_err());
    assert!(r.take_device_approval_challenges().is_empty());
}

#[test]
fn approval_runtime_missing_source_and_app_session_deny() {
    let (mut r, s, _, _, _) = fixture();
    r.grant_source = None;
    assert!(r.start_device_approval(s, NEW).is_err());
    let (mut r, s, _, _, _) = fixture();
    r.sessions.get_mut(&s).unwrap().auth = SessionAuth::Grant {
        grant: B16([4; 16]),
        client_pk: [5; 32],
    };
    assert!(r.start_device_approval(s, NEW).is_err());
    assert!(r.pending_devices(s).is_err());
    assert!(r.take_device_approval_challenges().is_empty());
}

#[test]
fn approval_runtime_queued_ready_is_fenced_at_push_drain() {
    let (mut r, s, mut n, source, _) = fixture();
    let c = r.start_device_approval(s, NEW).unwrap();
    let reveal = answer(&r, &mut n, c);
    r.receive_device_reveal(s, &reveal).unwrap();
    source.0.set(Some(ApprovalAuthorityStamp {
        account: ACCOUNT,
        epoch: 2,
    }));
    assert!(!r.take_pushes().iter().any(|(_, p)| matches!(
        p,
        Push::ApprovalReady {
            exchange_ready: true,
            ..
        }
    )));
}

#[test]
fn approval_peer_actual_signed_metadata_roundtrips_and_reaches_guarded_ingress() {
    let (mut r, s, mut n, _, _) = fixture();
    let challenge = r.start_device_approval(s, NEW).unwrap();
    let signed = r.sign_device_approval_challenge(s, &challenge).unwrap();
    assert!(signed.verify_for_policy(COL, &r.policy));
    assert!(!signed.verify_for_policy(B16([0x44; 16]), &r.policy));
    let bytes = signed.to_bytes().unwrap();
    assert!(bytes.len() <= super::super::MAX_APPROVAL_PEER_BYTES);
    assert_eq!(
        super::super::ApprovalPeerEnvelope::from_bytes(&bytes).unwrap(),
        signed
    );
    let reveal = answer(&r, &mut n, challenge);
    // Synthetic key holder; native requester persistence hook is a separate slice.
    let signed = super::super::ApprovalPeerMessage::Reveal(reveal)
        .sign(&DeviceSigner::from_seed(&[20; 32]))
        .unwrap();
    r.receive_device_approval_peer(s, &signed).unwrap();
    r.receive_device_approval_peer(s, &signed).unwrap();
    assert!(r.pending_devices(s).unwrap()[0].exchange_ready);
}

#[test]
fn approval_peer_rejects_body_tampering_wrong_origin_and_embedded_key_adoption() {
    let (mut r, s, mut n, _, _) = fixture();
    let challenge = r.start_device_approval(s, NEW).unwrap();
    let reveal = answer(&r, &mut n, challenge);
    let signed = super::super::ApprovalPeerMessage::Reveal(reveal.clone())
        .sign(&DeviceSigner::from_seed(&[20; 32]))
        .unwrap();
    for case in 0..6 {
        let mut bad = signed.clone();
        let super::super::ApprovalPeerMessage::Reveal(ref mut r) = bad.message else {
            panic!("reveal");
        };
        match case {
            0 => r.challenge.r_a.0[0] ^= 1,
            1 => r.r_n.0[0] ^= 1,
            2 => r.challenge.expires_at_ms += 1,
            3 => r.challenge.binding.epoch += 1,
            4 => r.challenge.binding.commitment.0[0] ^= 1,
            5 => r.challenge.binding.requester.noise_pk.0[0] ^= 1,
            _ => unreachable!(),
        }
        assert!(!bad.verify_signature(), "case {case}");
    }
    assert!(
        super::super::ApprovalPeerMessage::Reveal(reveal.clone())
            .sign(&DeviceSigner::from_seed(&[21; 32]))
            .is_err()
    );
    let mut substitution = reveal;
    substitution.challenge.binding.requester.sign_pk =
        B32(DeviceSigner::from_seed(&[21; 32]).public());
    let forged = super::super::ApprovalPeerMessage::Reveal(substitution)
        .sign(&DeviceSigner::from_seed(&[21; 32]))
        .unwrap();
    assert!(forged.verify_signature()); // proves only ATTACKER-supplied key
    assert!(!forged.verify_for_policy(COL, &r.policy));
    assert!(r.receive_device_approval_peer(s, &forged).is_err());
}

#[test]
fn approval_peer_decoder_bounds_closed_maps_and_rejects_noncanonical_version() {
    let (mut r, s, _, _, _) = fixture();
    let c = r.start_device_approval(s, NEW).unwrap();
    let signed = r.sign_device_approval_challenge(s, &c).unwrap();
    let bytes = signed.to_bytes().unwrap();
    let mut cbor = mdbn_wire::cbor::decode(&bytes).unwrap();
    let mdbn_wire::cbor::Cbor::Map(ref mut envelope) = cbor else {
        panic!("map");
    };
    envelope.push((
        mdbn_wire::cbor::Cbor::Uint(2),
        mdbn_wire::cbor::Cbor::Bool(true),
    ));
    let unknown = mdbn_wire::cbor::encode(&cbor).unwrap();
    assert!(super::super::ApprovalPeerEnvelope::from_bytes(&unknown).is_err());
    // Envelope/body prefix a2 00 a5 00 01; replace shortest version with 18 01.
    assert_eq!(&bytes[..5], &[0xa2, 0, 0xa5, 0, 1]);
    let mut noncanonical = bytes[..4].to_vec();
    noncanonical.extend_from_slice(&[0x18, 1]);
    noncanonical.extend_from_slice(&bytes[5..]);
    assert!(super::super::ApprovalPeerEnvelope::from_bytes(&noncanonical).is_err());
    assert_eq!(
        super::super::ApprovalPeerEnvelope::from_bytes(&vec![0; 2049]),
        Err(crate::crypto::CryptoError::TooLarge)
    );
}

#[test]
fn approval_peer_signing_and_ingress_recheck_source_epoch() {
    let (mut r, s, mut n, source, _) = fixture();
    let c = r.start_device_approval(s, NEW).unwrap();
    let reveal = answer(&r, &mut n, c.clone());
    let signed = super::super::ApprovalPeerMessage::Reveal(reveal)
        .sign(&DeviceSigner::from_seed(&[20; 32]))
        .unwrap();
    source.0.set(Some(ApprovalAuthorityStamp {
        account: ACCOUNT,
        epoch: 2,
    }));
    assert!(r.sign_device_approval_challenge(s, &c).is_err());
    assert!(r.receive_device_approval_peer(s, &signed).is_err());
}

struct RequesterSource(Source);
impl GrantSource for RequesterSource {
    fn grant(&self, _: &Uuid) -> Option<EffectiveGrant> {
        None
    }
    fn active_account(&self) -> Option<Uuid> {
        self.0.active_account()
    }
    fn authority_epoch(&self) -> Option<u64> {
        self.0.authority_epoch()
    }
    fn device_noise_pk(&self) -> Option<B32> {
        self.0
            .active_account()
            .map(|_| B32(tuple(NEW, 20).noise_pk))
    }
}
#[derive(Default)]
struct RequesterJournal {
    blob: Option<zeroize::Zeroizing<Vec<u8>>>,
    fail_after: bool,
    changed: Option<Source>,
    writes: usize,
}
impl super::super::ApprovalSecretJournal for RequesterJournal {
    fn load(
        &mut self,
    ) -> Result<Option<zeroize::Zeroizing<Vec<u8>>>, super::super::ApprovalPersistenceError> {
        Ok(self.blob.clone())
    }
    fn save(&mut self, state: &[u8]) -> Result<(), super::super::ApprovalPersistenceError> {
        self.blob = Some(zeroize::Zeroizing::new(state.to_vec()));
        self.writes += 1;
        if let Some(s) = &self.changed {
            s.0.set(Some(ApprovalAuthorityStamp {
                account: ACCOUNT,
                epoch: 99,
            }));
        }
        if self.fail_after {
            Err(super::super::ApprovalPersistenceError)
        } else {
            Ok(())
        }
    }
}
fn requester_fixture() -> (Replica<MemStore>, SessionId, Source) {
    let (mut r, s, _, source, _) = fixture();
    r.cfg.device_id = NEW;
    r.secrets = DeviceSecrets {
        sign_sk: [20; 32],
        kem_sk: [20; 32],
    };
    r.sealer = Box::new(KeyringSealer::new(COL, NEW, &[20; 32], &[20; 32]));
    r.key_untrusted = false;
    r.grant_source = Some(Box::new(RequesterSource(source.clone())));
    (r, s, source)
}
fn requester_challenge(r: &Replica<MemStore>, commit: B32) -> super::super::ApprovalPeerEnvelope {
    super::super::ApprovalPeerMessage::Challenge(ApprovalChallenge {
        binding: ApprovalBinding {
            collection: COL,
            epoch: 1,
            approver: ApprovalDevice::from_policy(ME, &r.policy.devices[&ME]),
            requester: ApprovalDevice::from_policy(NEW, &r.policy.devices[&NEW]),
            commitment: commit,
        },
        r_a: B32([42; 32]),
        expires_at_ms: 121000,
    })
    .sign(&DeviceSigner::from_seed(&[10; 32]))
    .unwrap()
}
#[test]
fn requester_hook_saves_commit_then_whole_selected_peer_before_real_signed_reveal() {
    let (mut r, s, _) = requester_fixture();
    let mut journal = RequesterJournal::default();
    let commit = r
        .request_device_approval_commitment(s, &mut journal)
        .unwrap();
    assert_eq!(journal.writes, 1);
    r.policy.devices.get_mut(&NEW).unwrap().sas_commit = Some(commit); // synthetic ACTUAL applied renewal
    let peer = requester_challenge(&r, commit);
    let output = r
        .receive_device_approval_challenge(s, &peer, &mut journal)
        .unwrap();
    assert_eq!(journal.writes, 2);
    assert_eq!(output.code.len(), 6);
    assert!(output.envelope.verify_for_policy(COL, &r.policy));
    // Real SAS equality uses the existing primitive via the reveal payload.
    let super::super::ApprovalPeerMessage::Reveal(reveal) = &output.envelope.message else {
        panic!("reveal");
    };
    assert_eq!(
        crate::crypto::keys::sas_code(
            &COL,
            &tuple(ME, 10),
            &tuple(NEW, 20),
            &peer.message.challenge().r_a.0,
            &reveal.r_n.0
        ),
        *output.code
    );
    assert!(!format!("{output:?}").contains(output.code.as_str()));
    assert_eq!(
        r.restore_requester_approval_peer(s, &mut journal)
            .unwrap()
            .unwrap()
            .device,
        ME
    );
    assert!(
        r.receive_device_approval_challenge(s, &peer, &mut journal)
            .is_err()
    );
    let (mut reopened, s2, _) = requester_fixture();
    reopened.policy = r.policy.clone();
    assert_eq!(
        reopened
            .restore_requester_approval_peer(s2, &mut journal)
            .unwrap()
            .unwrap(),
        peer.message.challenge().binding.approver
    );
}
#[test]
fn requester_hook_unknown_save_never_returns_reveal_and_poison_denies() {
    let (mut r, s, _) = requester_fixture();
    let mut j = RequesterJournal::default();
    let c = r.request_device_approval_commitment(s, &mut j).unwrap();
    r.policy.devices.get_mut(&NEW).unwrap().sas_commit = Some(c);
    let peer = requester_challenge(&r, c);
    j.fail_after = true;
    assert_eq!(
        r.receive_device_approval_challenge(s, &peer, &mut j)
            .unwrap_err()
            .code(),
        Some(ErrorCode::OutcomeUnknown)
    );
    assert!(r.approval.poisoned);
    assert!(r.restore_requester_approval_peer(s, &mut j).is_err());
    let (mut reopened, s2, _) = requester_fixture();
    reopened.policy = r.policy.clone();
    assert!(
        reopened
            .restore_requester_approval_peer(s2, &mut j)
            .unwrap()
            .is_some()
    );
}
#[test]
fn requester_hook_rejects_stale_commitment_control_aba_and_source_epoch_after_save() {
    let (mut r, s, source) = requester_fixture();
    let mut j = RequesterJournal::default();
    let c = r.request_device_approval_commitment(s, &mut j).unwrap();
    let peer = requester_challenge(&r, c);
    assert!(
        r.receive_device_approval_challenge(s, &peer, &mut j)
            .is_err()
    ); // latest logged commit still old
    r.policy.devices.get_mut(&NEW).unwrap().sas_commit = Some(c);
    j.changed = Some(source.clone());
    assert!(
        r.receive_device_approval_challenge(s, &peer, &mut j)
            .is_err()
    ); // change DURING persistence
    assert!(r.restore_requester_approval_peer(s, &mut j).is_err()); // epoch99 never rolled back
    let (mut r, s, _) = requester_fixture();
    let mut j = RequesterJournal::default();
    let c = r.request_device_approval_commitment(s, &mut j).unwrap();
    r.policy.devices.get_mut(&NEW).unwrap().sas_commit = Some(c);
    let peer = requester_challenge(&r, c);
    r.receive_device_approval_challenge(s, &peer, &mut j)
        .unwrap();
    r.policy.ctl_chain = B32([55; 32]); // security control witness change
    assert!(r.restore_requester_approval_peer(s, &mut j).is_err());
    r.policy.ctl_chain = B32([0; 32]);
    r.policy.devices.get_mut(&NEW).unwrap().sas_commit = Some(B32([88; 32]));
    assert!(r.restore_requester_approval_peer(s, &mut j).is_err());
}

#[test]
fn approval_runtime_debug_redacts_peer_nonces() {
    let (mut r, s, mut n, _, _) = fixture();
    let c = r.start_device_approval(s, NEW).unwrap();
    let reveal = answer(&r, &mut n, c.clone());
    let debug = format!("{c:?} {reveal:?}");
    assert!(!debug.contains(&format!("{:?}", c.r_a)));
    assert!(!debug.contains(&format!("{:?}", reveal.r_n)));
}

/// Append calls queued so far (the open-time head fetch is not one).
fn appends(r: &mut Replica<MemStore>) -> Vec<mdbn_wire::log_service::AppendParams> {
    use crate::log::{LogPort, LogRequest};
    r.take_log_calls()
        .into_iter()
        .filter_map(|c| match c.request {
            LogRequest::Append(p) => Some(p),
            _ => None,
        })
        .collect()
}

fn answer_with_code(
    r: &Replica<MemStore>,
    n: &mut NewDevice,
    c: ApprovalChallenge,
) -> (ApprovalReveal, String) {
    let Answer::Reveal { r_n, code, .. } = n.on_challenge(&r.policy, &ME, &c.r_a.0) else {
        panic!("requester reveal");
    };
    (
        ApprovalReveal {
            challenge: c,
            r_n: B32(r_n),
        },
        code,
    )
}

#[test]
fn approver_code_is_six_digits_only() {
    assert!(ApproverCode::parse("123456").is_some());
    assert!(ApproverCode::parse("123 456").is_some());
    assert!(ApproverCode::parse("123-456").is_some());
    assert!(ApproverCode::parse("12345").is_none());
    assert!(ApproverCode::parse("1234567").is_none());
    assert!(ApproverCode::parse("12345a").is_none());
    assert!(ApproverCode::parse("").is_none());
    assert_eq!(
        format!("{:?}", ApproverCode::parse("123456").unwrap()),
        "ApproverCode(..)"
    );
}

#[test]
fn confirmed_code_queues_a_signed_key_grant_for_the_append_turn_only() {
    use mdbn_wire::envelope::{Item, ItemKind};
    let (mut r, s, mut n, _, _) = fixture();
    let c = r.start_device_approval(s, NEW).unwrap();
    let (reveal, code) = answer_with_code(&r, &mut n, c);
    r.receive_device_reveal(s, &reveal).unwrap();
    let typed = ApproverCode::parse(&code).unwrap();
    let (intent, d) = r.submit_device_approval(s, NEW, &typed).unwrap();
    assert_eq!(d, ApprovalDisposition::Queued);
    assert_eq!(r.device_approval_disposition(s, intent).unwrap(), d);
    // Confirmation itself appends nothing; the exchange is consumed.
    assert!(appends(&mut r).is_empty());
    assert!(!r.pending_devices(s).unwrap()[0].exchange_ready);
    assert_eq!(
        r.start_device_approval(s, NEW)
            .unwrap_err()
            .0
            .reason
            .as_deref(),
        Some("approval_commit_required")
    );
    // The control turn signs it at the current head and sends it alone.
    assert!(r.send_private_key_grant_if_needed());
    assert_eq!(
        r.device_approval_disposition(s, intent).unwrap(),
        ApprovalDisposition::Sent
    );
    let calls = appends(&mut r);
    assert_eq!(calls.len(), 1);
    let params = &calls[0];
    assert_eq!(params.items.len(), 1);
    assert_eq!(params.expect_seq, r.head.seq + 1);
    let item = Item::from_bytes(&params.items[0].0).unwrap();
    assert_eq!(item.kind, ItemKind::KeyGrant);
    assert_eq!(item.signer, Some(ME));
    assert!(item.sig.is_some());
    let kg = KeyGrantPayload::from_bytes(&item.body.0).unwrap();
    assert_eq!((kg.recipient, kg.epoch), (NEW, 1));
    // Only the applied item keys the device: the apply hook resolves the intent.
    assert!(!r.send_private_key_grant_if_needed(), "one batch at a time");
    r.note_private_key_grant_applied(Some(B16([9; 16])), NEW, 7); // not ours
    assert_eq!(
        r.device_approval_disposition(s, intent).unwrap(),
        ApprovalDisposition::Sent
    );
    r.note_private_key_grant_applied(Some(ME), NEW, 7);
    assert_eq!(
        r.device_approval_disposition(s, intent).unwrap(),
        ApprovalDisposition::Applied { seq: 7 }
    );
    assert!(!r.send_private_key_grant_if_needed());
}

#[test]
fn wrong_code_refuses_consumes_the_exchange_and_keeps_the_budget() {
    let (mut r, s, mut n, _, _) = fixture();
    let c = r.start_device_approval(s, NEW).unwrap();
    let (reveal, code) = answer_with_code(&r, &mut n, c);
    r.receive_device_reveal(s, &reveal).unwrap();
    let mut wrong: Vec<u8> = code.into_bytes();
    wrong[0] = if wrong[0] == b'9' { b'0' } else { wrong[0] + 1 };
    let wrong = ApproverCode::parse(std::str::from_utf8(&wrong).unwrap()).unwrap();
    let (intent, d) = r.submit_device_approval(s, NEW, &wrong).unwrap();
    assert_eq!(
        d,
        ApprovalDisposition::Refused(ApprovalRefusal::CodeMismatch)
    );
    assert_eq!(r.device_approval_disposition(s, intent).unwrap(), d);
    assert!(!r.send_private_key_grant_if_needed());
    assert!(!r.pending_devices(s).unwrap()[0].exchange_ready);
    // No retry on the same commitment: the marker stays and the exchange is gone.
    assert_eq!(
        r.start_device_approval(s, NEW)
            .unwrap_err()
            .0
            .reason
            .as_deref(),
        Some("approval_commit_required")
    );
    // A second confirmation against the consumed exchange is not ready/denied.
    assert!(r.submit_device_approval(s, NEW, &wrong).is_err());
}

#[test]
fn confirmation_without_a_reveal_or_from_an_app_session_is_refused() {
    let (mut r, s, _, _, _) = fixture();
    r.start_device_approval(s, NEW).unwrap();
    let typed = ApproverCode::parse("123456").unwrap();
    assert_eq!(
        r.submit_device_approval(s, NEW, &typed)
            .unwrap_err()
            .0
            .reason
            .as_deref(),
        Some("approval_not_ready")
    );
    assert!(r.device_approval_disposition(s, ApprovalIntent(1)).is_err());
}

#[test]
fn a_queued_grant_is_refused_when_context_moves_or_the_device_gets_keyed() {
    for keyed in [false, true] {
        let (mut r, s, mut n, _, _) = fixture();
        let c = r.start_device_approval(s, NEW).unwrap();
        let (reveal, code) = answer_with_code(&r, &mut n, c);
        r.receive_device_reveal(s, &reveal).unwrap();
        let (intent, _) = r
            .submit_device_approval(s, NEW, &ApproverCode::parse(&code).unwrap())
            .unwrap();
        if keyed {
            r.policy.devices.get_mut(&NEW).unwrap().keyed = true;
        } else {
            r.policy.ctl_chain = B32([0x88; 32]);
        }
        assert!(!r.send_private_key_grant_if_needed());
        assert!(
            appends(&mut r).is_empty(),
            "nothing sent on stale authority"
        );
        let expect = if keyed {
            ApprovalRefusal::Superseded
        } else {
            ApprovalRefusal::ContextChanged
        };
        assert_eq!(
            r.device_approval_disposition(s, intent).unwrap(),
            ApprovalDisposition::Refused(expect)
        );
        assert!(!r.send_private_key_grant_if_needed());
    }
}

#[test]
fn a_grant_the_log_keeps_dropping_is_refused_after_three_sends() {
    let (mut r, s, mut n, _, _) = fixture();
    let c = r.start_device_approval(s, NEW).unwrap();
    let (reveal, code) = answer_with_code(&r, &mut n, c);
    r.receive_device_reveal(s, &reveal).unwrap();
    let (intent, _) = r
        .submit_device_approval(s, NEW, &ApproverCode::parse(&code).unwrap())
        .unwrap();
    for _ in 0..3 {
        assert!(r.send_private_key_grant_if_needed());
        assert_eq!(appends(&mut r).len(), 1);
        // The append machinery dropped the batch (head moved / duplicate).
        r.append = crate::replica::append::AppendState::Idle;
        assert_eq!(
            r.device_approval_disposition(s, intent).unwrap(),
            ApprovalDisposition::Sent
        );
    }
    assert!(!r.send_private_key_grant_if_needed());
    assert!(appends(&mut r).is_empty());
    assert_eq!(
        r.device_approval_disposition(s, intent).unwrap(),
        ApprovalDisposition::Refused(ApprovalRefusal::NotAppended)
    );
    assert!(!r.send_private_key_grant_if_needed());
}

/// Queue and send one real signed grant; return its intent and log bytes.
fn sent_grant(
    r: &mut Replica<MemStore>,
    s: SessionId,
    n: &mut NewDevice,
) -> (ApprovalIntent, mdbn_wire::common::Bytes) {
    let c = r.start_device_approval(s, NEW).unwrap();
    let (reveal, code) = answer_with_code(r, n, c);
    r.receive_device_reveal(s, &reveal).unwrap();
    let (intent, _) = r
        .submit_device_approval(s, NEW, &ApproverCode::parse(&code).unwrap())
        .unwrap();
    assert!(r.send_private_key_grant_if_needed());
    let calls = appends(r);
    (intent, calls[0].items[0].clone())
}

/// The REAL signed key_grant goes through the apply loop. Applied is published
/// only after the commit that persists the evaluated policy succeeds: a
/// certified abort or an unknown outcome leaves it Sent (the policy is rolled
/// back / the store fenced); a landed commit resolves it.
#[test]
fn applied_is_published_only_after_the_durable_control_commit() {
    use mdbn_wire::log_service::SeqItem;
    for outcome in ["abort", "unknown", "landed-unknown", "landed"] {
        let (mut r, s, mut n, _, _) = fixture();
        let (intent, bytes) = sent_grant(&mut r, s, &mut n);
        let seq = r.head.seq + 1;
        match outcome {
            "abort" => r.store().fail_commits(1),
            "unknown" => r.store().fail_unknown_commits(1),
            // The commit lands, then the store reports an error: the outcome
            // is unknown to the replica, which fences; nothing is Applied.
            "landed-unknown" => r.store().fail_after_commit(1),
            _ => {}
        }
        r.apply_items(vec![SeqItem { seq, item: bytes }]);
        // Read the recorded disposition directly: a failed apply fences the API.
        let d = r.approval.dispositions[&intent];
        if outcome == "landed-unknown" {
            assert_eq!(d, ApprovalDisposition::Sent, "{outcome}: never Applied");
            assert!(r.approval.staged_applied.is_empty(), "{outcome}");
        } else if outcome == "landed" {
            assert_eq!(r.head.seq, seq, "applied");
            assert_eq!(d, ApprovalDisposition::Applied { seq }, "{outcome}");
            assert!(r.policy.devices[&NEW].keyed);
        } else {
            assert_ne!(r.head.seq, seq, "{outcome}: not durably applied");
            assert_eq!(d, ApprovalDisposition::Sent, "{outcome}: never Applied");
            assert!(r.approval.pending_grant.is_some(), "{outcome}");
            assert!(r.approval.staged_applied.is_empty(), "{outcome}");
        }
    }
}

/// Puts a replica into one unhealthy log state.
type MakeUnhealthy = fn(&mut Replica<MemStore>);

/// Each unhealthy log state, applied to a replica, and how to undo it.
fn unhealthy_states() -> Vec<(&'static str, MakeUnhealthy)> {
    vec![
        ("log regression window", |r| r.regressed_at = Some(1)),
        ("latched revocation (lost control)", |r| {
            r.latch.devices.insert(B16([0xee; 16]));
        }),
        ("lost-tail repair", |r| {
            r.testing_start_repair(0);
            r.regressed_at = None;
            assert!(r.repair.is_some());
        }),
    ]
}
fn heal(r: &mut Replica<MemStore>) {
    r.regressed_at = None;
    r.latch.devices.clear();
    r.repair = None;
}

/// The approver, the queued-grant send and the requester all refuse while the
/// applied log state is unhealthy, and recover after.
#[test]
fn approval_refuses_regressed_repair_and_lost_control_states() {
    for (what, make) in unhealthy_states() {
        // Approver: no new exchange.
        let (mut r, s, _, _, _) = fixture();
        make(&mut r);
        assert!(r.start_device_approval(s, NEW).is_err(), "approver: {what}");
        heal(&mut r);
        assert!(
            r.start_device_approval(s, NEW).is_ok(),
            "approver healed: {what}"
        );

        // A confirmed, queued grant is not signed or sent.
        let (mut r, s, mut n, _, _) = fixture();
        let c = r.start_device_approval(s, NEW).unwrap();
        let (reveal, code) = answer_with_code(&r, &mut n, c);
        r.receive_device_reveal(s, &reveal).unwrap();
        r.submit_device_approval(s, NEW, &ApproverCode::parse(&code).unwrap())
            .unwrap();
        make(&mut r);
        assert!(!r.send_private_key_grant_if_needed(), "send: {what}");
        assert!(appends(&mut r).is_empty(), "send: {what}");

        // Requester: no commitment.
        let (mut r, s, _) = requester_fixture();
        make(&mut r);
        let mut journal = RequesterJournal::default();
        assert!(
            r.request_device_approval_commitment(s, &mut journal)
                .is_err(),
            "requester: {what}"
        );
        assert_eq!(journal.writes, 0, "requester: {what}");
    }
}

/// Authority incarnation 0 is never a source, for the approver as for the
/// requester.
#[test]
fn approver_refuses_authority_incarnation_zero() {
    let (mut r, s, _, source, _) = fixture();
    source.0.set(Some(ApprovalAuthorityStamp {
        account: ACCOUNT,
        epoch: 0,
    }));
    assert!(r.start_device_approval(s, NEW).is_err());
}

/// Snapshot read-ahead accepts the grant into policy (metadata-only commit, no
/// applied prefix): the intent is never Applied there and the pending grant is
/// retained until the applied state resolves it.
#[test]
fn snapshot_read_ahead_never_publishes_applied() {
    let (mut r, s, mut n, _, _) = fixture();
    let (intent, bytes) = sent_grant(&mut r, s, &mut n);
    let seq = r.head.seq + 1;
    r.evaluate_control_bytes(seq, &bytes.0).unwrap();
    assert!(r.policy.devices[&NEW].keyed, "read ahead into policy");
    assert_eq!(r.approval.dispositions[&intent], ApprovalDisposition::Sent);
    assert!(r.approval.pending_grant.is_some());
    assert!(r.approval.staged_applied.is_empty());
    // A failed read-ahead commit is likewise never Applied.
    let (mut r, s, mut n, _, _) = fixture();
    let (intent, bytes) = sent_grant(&mut r, s, &mut n);
    let seq = r.head.seq + 1;
    r.store().fail_commits(1);
    assert!(r.evaluate_control_bytes(seq, &bytes.0).is_err());
    assert_eq!(r.approval.dispositions[&intent], ApprovalDisposition::Sent);
    assert!(r.approval.staged_applied.is_empty());
}
