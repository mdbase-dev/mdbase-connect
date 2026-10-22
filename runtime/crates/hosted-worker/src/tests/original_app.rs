//! Engine-owned configured trust/native prefix + exact retained original reads.
//! Real CP signatures, Noise and KeyringSealer key delivery over FakeLog/MemStore.
//! No actual service-binding/PoP/KMS/provider qualification.
use super::*;
mod cpp_claim;
mod history;
use crate::noise_sessions::{NoiseSessions, VerifiedAppCaller};
use crate::original_app::{MAX_ORIGINAL_POLICY_BYTES, OriginalAppPins};
use mdbn_noise::{Initiator, public_key};
use mdbn_replica::crypto::sign::DeviceSigner;
use mdbn_replica::store::{Store, TailRow, Tx};
use mdbn_replica::testkit::SIGNED_CP_SEED;
use mdbn_wire::envelope::Item;
use mdbn_wire::hash::sha256;
use mdbn_wire::policy::{
    DeviceEnrol, Genesis, Grant, GrantRevoke, MemberSet, PolicyOp, PolicyPayload, Role,
};

const APP_GRANT: B16 = B16([0x52; 16]);
const SERVER: [u8; 32] = [7; 32];
const CLIENT: [u8; 32] = [9; 32];

fn caller(server: [u8; 32]) -> VerifiedAppCaller {
    let mut p = b"mdbase/v1/client".to_vec();
    p.extend_from_slice(&COL.0);
    p.extend_from_slice(&APP_GRANT.0);
    p.extend_from_slice(&HOSTED_DEV.0);
    let mut noise = NoiseSessions::default();
    let h = noise.start(&server, &p).unwrap();
    let mut i = Initiator::new(&CLIENT, &public_key(&server), &p);
    noise
        .read1(h, &i.write_message_1(&[1; 32], b"hello").unwrap())
        .unwrap();
    noise.app_caller(h).unwrap()
}

fn fixture() -> (
    FakeLogService,
    TestControlPlane,
    OriginalAppPins,
    VerifiedAppCaller,
) {
    let svc = FakeLogService::new();
    let mut cp = TestControlPlane::signed(COL);
    cp.append(
        &svc,
        vec![
            PolicyOp::Genesis(Genesis {
                owner: TEST_OWNER,
                root: key_id(&signed_root()),
                state: CState::CloudCopy,
            }),
            PolicyOp::MemberSet(MemberSet {
                account: TEST_OWNER,
                role: Role::Owner,
            }),
            PolicyOp::DeviceEnrol(DeviceEnrol {
                device: HOSTED_DEV,
                account: mdbn_replica::policy::SERVICE_ACCOUNT,
                kind: DeviceKind::Hosted,
                sign_pk: B32(DeviceSigner::from_seed(&[7; 32]).public()),
                kem_pk: B32(mdbn_replica::crypto::hpke::KemKeyPair::from_secret(&[8; 32]).pk),
                noise_pk: B32(public_key(&SERVER)),
                sas_commit: None,
                local_root: None,
            }),
            PolicyOp::DeviceEnrol(DeviceEnrol {
                device: ESCROW_DEV,
                account: mdbn_replica::policy::SERVICE_ACCOUNT,
                kind: DeviceKind::Escrow,
                sign_pk: B32(DeviceSigner::from_seed(&[17; 32]).public()),
                kem_pk: B32(mdbn_replica::crypto::hpke::KemKeyPair::from_secret(&[18; 32]).pk),
                noise_pk: B32(public_key(&[17; 32])),
                sas_commit: None,
                local_root: None,
            }),
        ],
    );
    let raw_genesis = svc.items(&COL)[0].clone();
    let genesis = Item::from_bytes(&raw_genesis).unwrap();
    let payload = PolicyPayload::from_bytes(&genesis.body.0).unwrap();
    // Seed an actual hosted-signed, HPKE-wrapped initial key control. This tests
    // observation/custody, not the independent bootstrap scheduling pipeline.
    let mut sealer = mdbn_replica::seal::KeyringSealer::new(COL, HOSTED_DEV, &[7; 32], &[8; 32]);
    let rekey = mdbn_replica::Sealer::build_rekey(
        &mut sealer,
        0,
        &[
            mdbn_replica::crypto::keys::Recipient {
                device: HOSTED_DEV,
                kem_pk: mdbn_replica::crypto::hpke::KemKeyPair::from_secret(&[8; 32]).pk,
            },
            mdbn_replica::crypto::keys::Recipient {
                device: ESCROW_DEV,
                kem_pk: mdbn_replica::crypto::hpke::KemKeyPair::from_secret(&[18; 32]).pk,
            },
        ],
        RekeyReason::Initial,
        &mut mdbn_replica::crypto::TestEntropy::new(19),
    )
    .unwrap();
    let mut key_item = Item {
        kind: ItemKind::Rekey,
        collection: COL,
        seq: Some(2),
        prev: Some(mdbn_wire::hash::chain_hash(&raw_genesis)),
        epoch: None,
        signer: Some(HOSTED_DEV),
        salt: None,
        idem: None,
        refs: None,
        stream: None,
        body: Bytes(rekey.to_bytes().unwrap()),
        sig: None,
    };
    mdbn_replica::Sealer::sign(&sealer, &mut key_item).unwrap();
    svc.push_raw(&COL, key_item.to_bytes().unwrap());
    let peer = caller(SERVER);
    let grant_seq = cp.append(
        &svc,
        vec![PolicyOp::Grant(Grant {
            grant: APP_GRANT,
            installation: B16([0x56; 16]),
            app_id: "synthetic.app".into(),
            account: TEST_OWNER,
            capabilities: vec!["collection.read".into()],
            client_pk: peer.client_pk(),
            file_folders: None,
            folder_scoped: None,
        })],
    );
    let raw_grant = svc.items(&COL).last().unwrap().clone();
    let pins = OriginalAppPins {
        collection: COL,
        owner: TEST_OWNER,
        target_device: HOSTED_DEV,
        grant: APP_GRANT,
        installation: B16([0x56; 16]),
        client_pk: peer.client_pk(),
        root_pk: B32(signed_root()),
        policy_pk: payload.cert.policy_pk,
        genesis_sha256: sha256(&raw_genesis),
        grant_sha256: sha256(&raw_grant),
        grant_seq,
    };
    (svc, cp, pins, peer)
}

struct AppHosted {
    e: Engine<MemStore>,
    log: FakeLog,
    clock: Rc<Cell<u64>>,
}
fn open(svc: &FakeLogService) -> AppHosted {
    open_with_entropy(svc, 2)
}
fn open_with_entropy(svc: &FakeLogService, seed: u8) -> AppHosted {
    let clock = Rc::new(Cell::new(1_700_000_000_000));
    let host = Host {
        clock: Box::new(TestClock(clock.clone())),
        entropy: Box::new(mdbn_replica::crypto::TestEntropy::new(seed)),
        zones: Box::new(UtcOnly),
    };
    let mut e = Engine::open(config(svc), MemStore::new(), host, HostedProfile::default()).unwrap();
    assert!(e.bind_log(COL));
    AppHosted {
        e,
        log: svc.client(HOSTED_DEV),
        clock,
    }
}
impl AppHosted {
    fn pump(&mut self, lose_appends: bool) {
        for _ in 0..16 {
            self.e.tick(i64::try_from(self.clock.get()).unwrap());
            for _ in 0..50 {
                let mut moved = false;
                for p in self.log.poll_pushes() {
                    moved = true;
                    let _ = self.e.on_log_push(p);
                }
                for c in self.e.take_log_calls() {
                    moved = true;
                    let append = matches!(c.request, LogRequest::Append(_));
                    let reply = if lose_appends && append {
                        Err(LogError::NoResponse)
                    } else {
                        self.log.call(c.request)
                    };
                    let _ = self.e.on_log_reply(c.id, reply);
                }
                if !moved {
                    break;
                }
            }
        }
    }
}

fn declarations(p: &OriginalAppPins) -> Vec<u8> {
    cbor::encode(&Cbor::Array(vec![
        p.collection.to_cbor(),
        p.owner.to_cbor(),
        p.target_device.to_cbor(),
        p.grant.to_cbor(),
        p.installation.to_cbor(),
        p.client_pk.to_cbor(),
        p.root_pk.to_cbor(),
        p.policy_pk.to_cbor(),
        p.genesis_sha256.to_cbor(),
        p.grant_sha256.to_cbor(),
        Cbor::Uint(p.grant_seq),
    ]))
    .unwrap()
}

#[test]
fn original_app_query_declaration_codec_is_fixed_bounded_and_not_a_caller_constructor() {
    let (_, _, pins, _) = fixture();
    let encoded = declarations(&pins);
    let decoded = OriginalAppPins::decode_query_declarations(&encoded).unwrap();
    assert_eq!(declarations(&decoded), encoded);
    assert!(encoded.len() <= crate::original_app::MAX_APP_QUERY_DECLARATION_BYTES);
    let Cbor::Array(v) = cbor::decode(&encoded).unwrap() else {
        panic!()
    };
    let mut maximum = v.clone();
    maximum[10] = Cbor::Uint(u64::MAX);
    assert_eq!(
        OriginalAppPins::decode_query_declarations(&cbor::encode(&Cbor::Array(maximum)).unwrap())
            .unwrap()
            .grant_seq,
        u64::MAX
    );
    let mut bad = vec![Cbor::Null, Cbor::Array(v[..10].to_vec())];
    let mut extra = v.clone();
    extra.push(Cbor::Null);
    bad.push(Cbor::Array(extra));
    for (i, value) in [
        (0, Cbor::Bytes(vec![1; 15])),
        (5, Cbor::Bytes(vec![1; 31])),
        (10, Cbor::Uint(0)),
        (10, Cbor::int(-1)),
        (10, Cbor::Text("3".into())),
    ] {
        let mut changed = v.clone();
        changed[i] = value;
        bad.push(Cbor::Array(changed));
    }
    for value in bad {
        assert!(
            OriginalAppPins::decode_query_declarations(&cbor::encode(&value).unwrap()).is_err()
        );
    }
    for bytes in [
        vec![],
        vec![0xff],
        vec![0; crate::original_app::MAX_APP_QUERY_DECLARATION_BYTES + 1],
    ] {
        assert!(OriginalAppPins::decode_query_declarations(&bytes).is_err());
    }
    let mut trailing = encoded;
    trailing.push(0);
    assert!(OriginalAppPins::decode_query_declarations(&trailing).is_err());
}

#[test]
fn engine_original_app_reads_actual_tail_after_native_context_and_keeps_it_read_only() {
    let (svc, _, pins, peer) = fixture();
    let mut h = open(&svc);
    assert!(
        h.e.original_app_caller(&peer, &pins).is_err(),
        "cold native context"
    );
    assert!(h.e.original_app_query(&peer, &declarations(&pins)).is_err());
    h.pump(false);
    assert!(
        matches!(h.e.admission(), mdbn_replica::HostedAdmission::Verified(_)),
        "native admission: {:?}; sync: {:?}",
        h.e.admission(),
        h.e.replica().sync_status()
    );
    let before = h.e.replica().store().tail(0, 100).unwrap();
    let head = h.e.replica().head();
    let observed = h.e.original_app_caller(&peer, &pins).unwrap();
    assert_eq!(observed.original().caller().grant(), APP_GRANT);
    assert_eq!(observed.original().genesis_sha256(), pins.genesis_sha256);
    assert_eq!(observed.native().collection(), COL);
    assert_eq!(observed.native().device(), HOSTED_DEV);
    assert_eq!(observed.native().noise_pk(), peer.responder_pk());
    assert_eq!(observed.native().wake_instance(), h.e.wake_instance());
    assert_eq!(observed.native().applied_head(), head);
    assert_eq!(format!("{observed:?}"), "ObservedOriginalAppCaller { .. }");
    let query = h.e.original_app_query(&peer, &declarations(&pins)).unwrap();
    assert_eq!(
        cbor::decode(&query).unwrap(),
        Cbor::Array(vec![
            COL.to_cbor(),
            APP_GRANT.to_cbor(),
            peer.client_pk().to_cbor(),
            pins.genesis_sha256.to_cbor(),
            mdbn_replica::policy::key_id(&pins.policy_pk.0).to_cbor()
        ])
    );
    assert_eq!(h.e.replica().head(), head);
    assert_eq!(h.e.replica().store().tail(0, 100).unwrap(), before);
}

#[test]
fn engine_original_app_wrong_responder_target_collection_root_policy_and_position_refuse() {
    let (svc, _, pins, peer) = fixture();
    let mut h = open(&svc);
    h.pump(false);
    let other = caller([8; 32]);
    assert_eq!(other.client_pk(), peer.client_pk());
    assert_ne!(other.responder_pk(), peer.responder_pk());
    assert!(
        h.e.original_app_caller(&other, &pins).is_err(),
        "real peer but wrong service Noise custody"
    );
    assert!(
        h.e.original_app_query(&other, &declarations(&pins))
            .is_err()
    );
    let edits: Vec<fn(&mut OriginalAppPins)> = vec![
        |p| p.owner = B16([9; 16]),
        |p| p.grant = B16([9; 16]),
        |p| p.installation = B16([9; 16]),
        |p| p.client_pk = B32([9; 32]),
        |p| p.genesis_sha256 = B32([9; 32]),
        |p| p.grant_sha256 = B32([9; 32]),
        |p| p.collection = B16([9; 16]),
        |p| p.target_device = OWNER_DEV,
        |p| p.root_pk = B32(DeviceSigner::from_seed(&[1; 32]).public()),
        |p| p.policy_pk = B32(DeviceSigner::from_seed(&[2; 32]).public()),
        |p| p.grant_seq = 0,
        |p| p.grant_seq = u64::MAX,
    ];
    for edit in edits {
        let mut changed = pins.clone();
        edit(&mut changed);
        assert!(h.e.original_app_caller(&peer, &changed).is_err());
        assert!(
            h.e.original_app_query(&peer, &declarations(&changed))
                .is_err()
        );
    }
}

#[test]
fn engine_original_app_retained_missing_shifted_changed_or_oversized_records_never_fall_back() {
    let (svc, _, pins, peer) = fixture();
    for mode in 0..4 {
        let mut h = open(&svc);
        h.pump(false);
        assert!(h.e.original_app_caller(&peer, &pins).is_ok());
        let tx = match mode {
            0 => Tx {
                tail_drop_below: Some(2),
                ..Tx::default()
            },
            1 => Tx {
                tail_drop_above: Some(pins.grant_seq - 1),
                ..Tx::default()
            },
            2 => Tx {
                tail_put: vec![TailRow {
                    seq: pins.grant_seq,
                    item: vec![0],
                    applied_at: 0,
                }],
                ..Tx::default()
            },
            _ => Tx {
                tail_put: vec![TailRow {
                    seq: pins.grant_seq,
                    item: vec![0; MAX_ORIGINAL_POLICY_BYTES + 1],
                    applied_at: 0,
                }],
                ..Tx::default()
            },
        };
        h.e.replica_mut().store_mut().commit(tx).unwrap();
        assert!(
            h.e.grant_authorized(&APP_GRANT, &peer.client_pk().0),
            "current grant projection cannot replace raw records"
        );
        assert!(h.e.original_app_caller(&peer, &pins).is_err());
        assert!(h.e.original_app_query(&peer, &declarations(&pins)).is_err());
    }
}

#[test]
fn engine_original_app_matches_frozen_genesis_even_if_replacement_is_signed_and_pins_updated() {
    let (svc, _, pins, peer) = fixture();
    let mut h = open(&svc);
    h.pump(false);
    let mut item = Item::from_bytes(&svc.items(&COL)[0]).unwrap();
    let mut payload = PolicyPayload::from_bytes(&item.body.0).unwrap();
    payload.issued_at += 1;
    item.body = Bytes(payload.to_bytes().unwrap());
    DeviceSigner::from_seed(&SIGNED_CP_SEED)
        .sign_item(&mut item)
        .unwrap();
    let replacement = item.to_bytes().unwrap();
    let mut changed = pins.clone();
    changed.genesis_sha256 = sha256(&replacement);
    h.e.replica_mut()
        .store_mut()
        .commit(Tx {
            tail_put: vec![TailRow {
                seq: 1,
                item: replacement,
                applied_at: 0,
            }],
            ..Tx::default()
        })
        .unwrap();
    assert!(
        h.e.original_app_caller(&peer, &changed).is_err(),
        "actual frozen expected_genesis cannot be overridden by pins"
    );
    assert!(
        h.e.original_app_query(&peer, &declarations(&changed))
            .is_err()
    );
}

#[test]
fn engine_original_app_revocation_retired_log_or_new_wake_cannot_use_old_observation_as_lease() {
    let (svc, mut cp, pins, peer) = fixture();
    let mut h = open(&svc);
    h.pump(false);
    let observed = h.e.original_app_caller(&peer, &pins).unwrap();
    cp.append(
        &svc,
        vec![PolicyOp::GrantRevoke(GrantRevoke { grant: APP_GRANT })],
    );
    h.pump(false);
    assert!(!h.e.grant_authorized(&APP_GRANT, &peer.client_pk().0));
    assert!(h.e.original_app_caller(&peer, &pins).is_err());
    assert!(h.e.original_app_query(&peer, &declarations(&pins)).is_err());
    assert_eq!(
        observed.original().signed_grant().grant,
        APP_GRANT,
        "clone is historical only"
    );

    let (svc, _, pins, peer) = fixture();
    let mut h = open(&svc);
    h.pump(false);
    assert!(h.e.original_app_caller(&peer, &pins).is_ok());
    h.e.retire_log();
    assert!(h.e.original_app_caller(&peer, &pins).is_err());
    assert!(h.e.original_app_query(&peer, &declarations(&pins)).is_err());
    let fresh = open_with_entropy(&svc, 3);
    assert_ne!(fresh.e.wake_instance(), observed.native().wake_instance());
    assert!(fresh.e.original_app_caller(&peer, &pins).is_err());
    assert!(
        fresh
            .e
            .original_app_query(&peer, &declarations(&pins))
            .is_err()
    );
}
