//! Real Noise + Ed25519 signed anchors. No current authority or committed history.
use mdbn_hosted_worker::noise_sessions::{NoiseSessions, VerifiedAppCaller};
use mdbn_hosted_worker::original_app::{
    MAX_ORIGINAL_POLICY_BYTES, OriginalAppPins, OriginalAppRefused, bind_original_app_caller,
};
use mdbn_noise::{Initiator, public_key};
use mdbn_replica::crypto::sign::DeviceSigner;
use mdbn_replica::policy::key_id;
use mdbn_wire::common::{B16, B32, B64, Bytes};
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::hash::{CHAIN_ZERO, chain_hash, sha256};
use mdbn_wire::policy::{CState, CpCert, Genesis, Grant, GrantRevoke, PolicyOp, PolicyPayload};
use mdbn_wire::schema::Wire;

fn id(n: u8) -> B16 {
    B16([n; 16])
}
struct Fixture {
    root: DeviceSigner,
    cp: DeviceSigner,
    caller: VerifiedAppCaller,
    pins: OriginalAppPins,
    genesis: Vec<u8>,
    record: Vec<u8>,
    grant: Grant,
}
impl Fixture {
    fn new() -> Self {
        let root = DeviceSigner::from_seed(&[71; 32]);
        let cp = DeviceSigner::from_seed(&[72; 32]);
        let mut p = b"mdbase/v1/client".to_vec();
        p.extend_from_slice(&id(1).0);
        p.extend_from_slice(&id(2).0);
        p.extend_from_slice(&id(3).0);
        let mut noise = NoiseSessions::default();
        let handle = noise.start(&[7; 32], &p).unwrap();
        let mut client = Initiator::new(&[9; 32], &public_key(&[7; 32]), &p);
        let m1 = client.write_message_1(&[1; 32], b"hello").unwrap();
        noise.read1(handle, &m1).unwrap();
        let caller = noise.app_caller(handle).unwrap();
        let grant = Grant {
            grant: id(2),
            installation: id(5),
            app_id: "synthetic.app".into(),
            account: id(4),
            capabilities: vec!["collection.read".into(), "records.create".into()],
            client_pk: caller.client_pk(),
            file_folders: Some(vec!["notes".into()]),
            folder_scoped: Some(true),
        };
        let pins = OriginalAppPins {
            collection: id(1),
            owner: id(4),
            target_device: id(3),
            grant: id(2),
            installation: id(5),
            client_pk: caller.client_pk(),
            root_pk: B32(root.public()),
            policy_pk: B32(cp.public()),
            genesis_sha256: B32([1; 32]),
            grant_sha256: B32([1; 32]),
            grant_seq: 2,
        };
        let mut f = Self {
            root,
            cp,
            caller,
            pins,
            genesis: Vec::new(),
            record: Vec::new(),
            grant,
        };
        f.genesis = f.policy(1, CHAIN_ZERO, 1, vec![f.genesis_op()]);
        f.record = f.policy(
            2,
            chain_hash(&f.genesis),
            2,
            vec![PolicyOp::Grant(f.grant.clone())],
        );
        f.pins.genesis_sha256 = sha256(&f.genesis);
        f.pins.grant_sha256 = sha256(&f.record);
        f
    }
    fn genesis_op(&self) -> PolicyOp {
        PolicyOp::Genesis(Genesis {
            owner: self.pins.owner,
            root: key_id(&self.root.public()),
            state: CState::CloudCopy,
        })
    }
    fn policy(&self, seq: u64, prev: B32, issued_at: i64, ops: Vec<PolicyOp>) -> Vec<u8> {
        let mut cert = CpCert {
            policy_pk: B32(self.cp.public()),
            not_before: 0,
            not_after: 100,
            root: key_id(&self.root.public()),
            sig: B64([0; 64]),
        };
        cert.sig = B64(self.root.sign_digest(&cert.signed_digest().unwrap().0));
        let payload = PolicyPayload {
            cert,
            issued_at,
            ops,
        };
        let mut item = Item {
            kind: ItemKind::Policy,
            collection: self.pins.collection,
            seq: Some(seq),
            prev: Some(prev),
            epoch: None,
            signer: Some(key_id(&self.cp.public())),
            salt: None,
            idem: None,
            refs: None,
            stream: None,
            body: Bytes(payload.to_bytes().unwrap()),
            sig: None,
        };
        self.cp.sign_item(&mut item).unwrap();
        item.to_bytes().unwrap()
    }
    fn changed(&self, bytes: &[u8], change: impl FnOnce(&mut Item, &mut PolicyPayload)) -> Vec<u8> {
        let mut item = Item::from_bytes(bytes).unwrap();
        let mut payload = PolicyPayload::from_bytes(&item.body.0).unwrap();
        change(&mut item, &mut payload);
        item.body = Bytes(payload.to_bytes().unwrap());
        self.cp.sign_item(&mut item).unwrap();
        item.to_bytes().unwrap()
    }
    fn refuse_record(&self, bytes: &[u8]) {
        let mut pins = self.pins.clone();
        pins.grant_sha256 = sha256(bytes);
        assert_eq!(
            bind_original_app_caller(&self.caller, &pins, &self.genesis, bytes).unwrap_err(),
            OriginalAppRefused
        );
    }
    fn refuse_genesis(&self, bytes: &[u8]) {
        let mut pins = self.pins.clone();
        pins.genesis_sha256 = sha256(bytes);
        assert_eq!(
            bind_original_app_caller(&self.caller, &pins, bytes, &self.record).unwrap_err(),
            OriginalAppRefused
        );
    }
}

#[test]
fn genuine_noise_and_signed_grant_preserve_all_original_fields_without_permission_conversion() {
    let f = Fixture::new();
    let bound = bind_original_app_caller(&f.caller, &f.pins, &f.genesis, &f.record).unwrap();
    assert_eq!(bound.caller().collection(), f.pins.collection);
    assert_eq!(bound.caller().grant(), f.grant.grant);
    assert_eq!(bound.caller().client_pk(), f.grant.client_pk);
    assert_eq!(bound.owner(), f.grant.account);
    assert_eq!(bound.root(), key_id(&f.root.public()));
    assert_eq!(bound.policy_key_id(), key_id(&f.cp.public()));
    assert_eq!(bound.genesis_sha256(), f.pins.genesis_sha256);
    assert_eq!(bound.grant_sha256(), f.pins.grant_sha256);
    assert_eq!(bound.grant_seq(), 2);
    assert_eq!(bound.signed_grant(), &f.grant);
    assert_eq!(format!("{bound:?}"), "OriginalAppCaller { .. }");
    let mut copied = bound.signed_grant().clone();
    copied.client_pk = B32([0; 32]);
    copied.capabilities.clear();
    assert_eq!(
        bound.signed_grant(),
        &f.grant,
        "public data copy cannot replace opaque proof"
    );
}

#[test]
fn changed_or_nil_admission_declarations_never_match_actual_noise_and_originals() {
    let f = Fixture::new();
    let edits: Vec<fn(&mut OriginalAppPins)> = vec![
        |p| p.collection = id(0),
        |p| p.owner = id(0),
        |p| p.target_device = id(0),
        |p| p.grant = id(0),
        |p| p.installation = id(0),
        |p| p.client_pk = B32([0; 32]),
        |p| p.root_pk = B32([0; 32]),
        |p| p.policy_pk = B32([0; 32]),
        |p| p.genesis_sha256 = B32([0; 32]),
        |p| p.grant_sha256 = B32([0; 32]),
        |p| p.grant_seq = 0,
        |p| p.collection = id(6),
        |p| p.owner = id(6),
        |p| p.target_device = id(6),
        |p| p.grant = id(6),
        |p| p.installation = id(6),
        |p| p.client_pk = B32(public_key(&[10; 32])),
        |p| p.root_pk = B32(DeviceSigner::from_seed(&[73; 32]).public()),
        |p| p.policy_pk = B32(DeviceSigner::from_seed(&[74; 32]).public()),
        |p| p.grant_seq = 3,
    ];
    for change in edits {
        let mut pins = f.pins.clone();
        change(&mut pins);
        assert!(bind_original_app_caller(&f.caller, &pins, &f.genesis, &f.record).is_err());
    }
}

#[test]
fn record_caps_empty_missing_malformed_and_exact_hashes_refuse() {
    let f = Fixture::new();
    let huge = vec![0; MAX_ORIGINAL_POLICY_BYTES + 1];
    for (g, r) in [
        (&[][..], f.record.as_slice()),
        (f.genesis.as_slice(), &[][..]),
        (huge.as_slice(), f.record.as_slice()),
        (f.genesis.as_slice(), huge.as_slice()),
    ] {
        assert!(bind_original_app_caller(&f.caller, &f.pins, g, r).is_err());
    }
    for bytes in [b"not-policy".as_slice(), &[0xff][..]] {
        f.refuse_record(bytes);
        f.refuse_genesis(bytes);
    }
    let mut pins = f.pins.clone();
    pins.grant_sha256.0[0] ^= 1;
    assert!(bind_original_app_caller(&f.caller, &pins, &f.genesis, &f.record).is_err());
    pins = f.pins.clone();
    pins.genesis_sha256.0[0] ^= 1;
    assert!(bind_original_app_caller(&f.caller, &pins, &f.genesis, &f.record).is_err());
}

#[test]
fn even_resigned_grant_tuple_changes_duplicate_or_non_grant_ops_refuse() {
    let f = Fixture::new();
    let edits: Vec<fn(&mut Grant)> = vec![
        |g| g.grant = id(6),
        |g| g.installation = id(6),
        |g| g.account = id(6),
        |g| g.client_pk = B32(public_key(&[10; 32])),
    ];
    for change in edits {
        let mut grant = f.grant.clone();
        change(&mut grant);
        f.refuse_record(&f.policy(2, chain_hash(&f.genesis), 2, vec![PolicyOp::Grant(grant)]));
    }
    f.refuse_record(&f.policy(
        2,
        chain_hash(&f.genesis),
        2,
        vec![
            PolicyOp::Grant(f.grant.clone()),
            PolicyOp::Grant(f.grant.clone()),
        ],
    ));
    f.refuse_record(&f.policy(
        2,
        chain_hash(&f.genesis),
        2,
        vec![PolicyOp::GrantRevoke(GrantRevoke {
            grant: f.grant.grant,
        })],
    ));
    f.refuse_record(&f.policy(2, chain_hash(&f.genesis), 2, Vec::new()));
    f.refuse_record(&f.policy(
        2,
        chain_hash(&f.genesis),
        2,
        vec![PolicyOp::Grant(f.grant.clone()); 65],
    ));
}

#[test]
fn policy_positions_kinds_collection_and_adjacent_chain_cannot_shift() {
    let f = Fixture::new();
    for change in [
        (|i: &mut Item, _: &mut PolicyPayload| i.seq = Some(3))
            as fn(&mut Item, &mut PolicyPayload),
        |i, _| i.collection = id(6),
        |i, _| i.kind = ItemKind::Rekey,
        |i, _| i.prev = Some(B32([8; 32])),
        |_, p| p.issued_at = 0,
        |_, p| {
            p.ops.push(PolicyOp::Genesis(Genesis {
                owner: id(4),
                root: id(7),
                state: CState::CloudCopy,
            }))
        },
    ] {
        f.refuse_record(&f.changed(&f.record, change));
    }
}

#[test]
fn cryptographic_tampering_updated_hashes_cert_window_signer_and_weak_pins_refuse() {
    let f = Fixture::new();
    let mut item = Item::from_bytes(&f.record).unwrap();
    item.sig.as_mut().unwrap().0[0] ^= 1;
    f.refuse_record(&item.to_bytes().unwrap());
    for change in [
        (|_: &mut Item, p: &mut PolicyPayload| p.cert.sig.0[0] ^= 1)
            as fn(&mut Item, &mut PolicyPayload),
        |_, p| p.cert.root = id(9),
        |_, p| p.cert.policy_pk = B32(fixed_other_pk()),
        |_, p| p.issued_at = 101,
        |_, p| p.issued_at = -1,
    ] {
        f.refuse_record(&f.changed(&f.record, change));
    }
    let mut wrong = Item::from_bytes(&f.record).unwrap();
    wrong.signer = Some(id(9));
    f.cp.sign_item(&mut wrong).unwrap();
    f.refuse_record(&wrong.to_bytes().unwrap());
    let mut weak = [0; 32];
    weak[0] = 1;
    for field in [true, false] {
        let mut pins = f.pins.clone();
        if field {
            pins.root_pk = B32(weak);
        } else {
            pins.policy_pk = B32(weak);
        }
        assert!(bind_original_app_caller(&f.caller, &pins, &f.genesis, &f.record).is_err());
    }
}
fn fixed_other_pk() -> [u8; 32] {
    DeviceSigner::from_seed(&[73; 32]).public()
}

#[test]
fn genesis_original_owner_root_state_shape_and_uniqueness_are_mandatory() {
    let f = Fixture::new();
    for change in [
        (|i: &mut Item, _: &mut PolicyPayload| i.prev = Some(B32([8; 32])))
            as fn(&mut Item, &mut PolicyPayload),
        |i, _| i.seq = Some(2),
        |i, _| i.collection = id(6),
        |_, p| p.ops.push(p.ops[0].clone()),
        |_, p| p.ops = vec![PolicyOp::GrantRevoke(GrantRevoke { grant: id(2) })],
        |_, p| {
            if let PolicyOp::Genesis(g) = &mut p.ops[0] {
                g.owner = id(6);
            }
        },
        |_, p| {
            if let PolicyOp::Genesis(g) = &mut p.ops[0] {
                g.root = id(6);
            }
        },
        |_, p| {
            if let PolicyOp::Genesis(g) = &mut p.ops[0] {
                g.state = CState::E2e;
            }
        },
    ] {
        f.refuse_genesis(&f.changed(&f.genesis, change));
    }
}

#[test]
fn same_genesis_and_later_admitted_positions_are_explicit_not_full_history_proof() {
    let f = Fixture::new();
    let same = f.policy(
        1,
        CHAIN_ZERO,
        1,
        vec![f.genesis_op(), PolicyOp::Grant(f.grant.clone())],
    );
    let mut pins = f.pins.clone();
    pins.genesis_sha256 = sha256(&same);
    pins.grant_sha256 = sha256(&same);
    pins.grant_seq = 1;
    assert!(bind_original_app_caller(&f.caller, &pins, &same, &same).is_ok());
    let mut alternate = f.grant.clone();
    alternate.app_id = "synthetic.other".into();
    let other = f.policy(
        1,
        CHAIN_ZERO,
        1,
        vec![f.genesis_op(), PolicyOp::Grant(alternate)],
    );
    pins.grant_sha256 = sha256(&other);
    assert!(bind_original_app_caller(&f.caller, &pins, &same, &other).is_err());
    let later = f.policy(5, B32([8; 32]), 2, vec![PolicyOp::Grant(f.grant.clone())]);
    pins = f.pins.clone();
    pins.grant_sha256 = sha256(&later);
    pins.grant_seq = 5;
    let bound = bind_original_app_caller(&f.caller, &pins, &f.genesis, &later).unwrap();
    assert_eq!(
        bound.grant_seq(),
        5,
        "later anchor verifies tuple/signatures, not its preceding history"
    );
}
