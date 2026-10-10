//! Policy evaluation tests: one block per rule.

use super::*;
use mdbn_wire::common::{B64, Bytes, Text};
use mdbn_wire::entry::{EntryPayload, Status};
use mdbn_wire::envelope::{KeyWrap, SealedBox};
use mdbn_wire::intent::{
    BlobRef, ConflictMode, Create, FileDelete, FilePut, Mutation, OpClock, ResourcePut, Update,
};
use mdbn_wire::policy::{
    CollectionState, CpKeyRevoke, DeviceEnrol, DeviceRevoke, Freeze, Genesis, Grant, GrantRevoke,
    MemberRemove, MemberSet, MigrationCutover,
};

/// Fake verifier: a signature is `digest ‖ pk`.
struct Fake;
impl SigVerifier for Fake {
    fn verify(&self, pk: &[u8; 32], digest: &[u8; 32], sig: &[u8; 64]) -> bool {
        sig[..32] == digest[..] && sig[32..] == pk[..]
    }
}
fn sign(pk: &[u8; 32], digest: &[u8; 32]) -> B64 {
    let mut s = [0u8; 64];
    s[..32].copy_from_slice(digest);
    s[32..].copy_from_slice(pk);
    B64(s)
}

const ROOT: [u8; 32] = [1; 32];
const CH: B32 = B32([0x55; 32]);
const CP: [u8; 32] = [2; 32];
const COL: Uuid = B16([9; 16]);
const OWNER: Uuid = B16([0xA0; 16]);
const EDITOR: Uuid = B16([0xA1; 16]);
const VIEWER: Uuid = B16([0xA2; 16]);

fn dev(n: u8) -> Uuid {
    B16([n; 16])
}
fn dpk(n: u8) -> B32 {
    B32([n; 32])
}

fn env() -> Env<'static> {
    Env {
        verifier: &Fake,
        trusted_roots: &[ROOT],
        policy_pins: None,
    }
}

fn cert(not_before: i64, not_after: i64, pk: [u8; 32]) -> CpCert {
    let mut c = CpCert {
        policy_pk: B32(pk),
        not_before,
        not_after,
        root: key_id(&ROOT),
        sig: B64([0; 64]),
    };
    c.sig = sign(&ROOT, &c.signed_digest().unwrap().0);
    c
}

fn signed(mut item: Item, pk: &[u8; 32]) -> Item {
    item.sig = None;
    item.sig = Some(sign(pk, &item.signed_digest().unwrap().0));
    item
}

fn base_item(kind: ItemKind, seq: u64, signer: B16, body: Vec<u8>) -> Item {
    Item {
        kind,
        collection: COL,
        seq: Some(seq),
        prev: Some(B32([0; 32])),
        epoch: None,
        signer: Some(signer),
        salt: None,
        idem: None,
        refs: None,
        stream: None,
        body: Bytes(body),
        sig: None,
    }
}

fn policy_with(seq: u64, issued_at: i64, c: CpCert, ops: Vec<PolicyOp>) -> Item {
    let pk = c.policy_pk.0;
    let p = PolicyPayload {
        cert: c.clone(),
        issued_at,
        ops,
    };
    signed(
        base_item(ItemKind::Policy, seq, c.key_id(), p.to_bytes().unwrap()),
        &pk,
    )
}

fn policy(seq: u64, ops: Vec<PolicyOp>) -> Item {
    policy_with(seq, i64::try_from(seq).unwrap(), cert(0, 1000, CP), ops)
}

fn enrol(n: u8, account: Uuid, kind: DeviceKind) -> PolicyOp {
    PolicyOp::DeviceEnrol(DeviceEnrol {
        device: dev(n),
        account,
        kind,
        sign_pk: dpk(n),
        kem_pk: dpk(n),
        noise_pk: dpk(n),
        sas_commit: None,
        local_root: None,
    })
}

fn wraps(devs: &[u8]) -> Vec<KeyWrap> {
    devs.iter()
        .map(|n| KeyWrap {
            device: dev(*n),
            enc: B32([0; 32]),
            ct: Bytes(vec![0; 48]),
        })
        .collect()
}

fn rekey(seq: u64, signer: u8, from: u64, reason: RekeyReason, to: &[u8]) -> Item {
    let p = RekeyPayload {
        epoch: from + 1,
        from,
        commit: B32([0; 32]),
        wraps: wraps(to),
        history: SealedBox {
            salt: B16([0; 16]),
            ct: Bytes(vec![]),
        },
        reason,
    };
    signed(
        base_item(ItemKind::Rekey, seq, dev(signer), p.to_bytes().unwrap()),
        &dpk(signer).0,
    )
}

fn key_grant(seq: u64, signer: u8, to: u8, epoch: u64) -> Item {
    let p = KeyGrantPayload {
        recipient: dev(to),
        epoch,
        wrap: wraps(&[to]).remove(0),
    };
    signed(
        base_item(ItemKind::KeyGrant, seq, dev(signer), p.to_bytes().unwrap()),
        &dpk(signer).0,
    )
}

fn entry_item(seq: u64, signer: u8, epoch: u64) -> Item {
    let mut i = base_item(ItemKind::Entry, seq, dev(signer), vec![1, 2, 3]);
    i.epoch = Some(epoch);
    i.salt = Some(B16([0; 16]));
    i.idem = Some(B16([seq as u8; 16]));
    signed(i, &dpk(signer).0)
}

fn base_content_item(seq: u64, signer: u8, epoch: u64) -> Item {
    let mut i = base_item(ItemKind::Base, seq, dev(signer), vec![1]);
    i.epoch = Some(epoch);
    i.salt = Some(B16([0; 16]));
    i.refs = Some(vec![B32([7; 32])]);
    signed(i, &dpk(signer).0)
}

/// Genesis (owner), editor and viewer members, devices 10 (owner), 11 (editor),
/// 12 (viewer), then the initial rekey by 10 keying 10, 11, 12. Epoch 1 at seq 2.
fn setup(state: CState) -> PolicyState {
    let mut s = PolicyState::new();
    let mut ops = vec![
        PolicyOp::Genesis(Genesis {
            owner: OWNER,
            root: key_id(&ROOT),
            state,
        }),
        PolicyOp::MemberSet(MemberSet {
            account: OWNER,
            role: Role::Owner,
        }),
        PolicyOp::MemberSet(MemberSet {
            account: EDITOR,
            role: Role::Editor,
        }),
        PolicyOp::MemberSet(MemberSet {
            account: VIEWER,
            role: Role::Viewer,
        }),
        enrol(10, OWNER, DeviceKind::Desktop),
        enrol(11, EDITOR, DeviceKind::Mobile),
        enrol(12, VIEWER, DeviceKind::Desktop),
    ];
    let mut keyed = vec![10, 11, 12];
    if state == CState::CloudCopy {
        ops.push(enrol(20, SERVICE_ACCOUNT, DeviceKind::Escrow));
        ops.push(enrol(21, SERVICE_ACCOUNT, DeviceKind::Hosted));
        keyed.extend([20, 21]);
    }
    s.apply_control(1, &CH, &policy(1, ops), &env()).unwrap();
    s.apply_control(
        2,
        &CH,
        &rekey(2, 10, 0, RekeyReason::Initial, &keyed),
        &env(),
    )
    .unwrap();
    assert_eq!(s.epoch, 1);
    s
}

fn ctx_none() -> (impl Fn(&str) -> String, impl Fn(&Uuid) -> Option<String>) {
    (|p: &str| p.to_lowercase(), |_: &Uuid| None)
}

fn payload(on_behalf: Option<Uuid>, ops: Vec<Op>, sem_major: u64) -> EntryPayload {
    EntryPayload {
        resurrect: None,
        sem: mdbn_wire::common::Version {
            major: sem_major,
            minor: 0,
        },
        mutation: Mutation {
            id: B16([1; 16]),
            origin: B16([2; 16]),
            base_seq: 0,
            clock: OpClock {
                instant: 5,
                tz: "UTC".into(),
                local_date: "1970-01-01".into(),
            },
            seed: B32([0; 32]),
            source: Source::Api,
            ops,
            on_behalf,
            conflict_mode: Some(ConflictMode::Record),
            validated_at: None,
            room: None,
        },
        status: Status::Applied,
        effects: vec![],
        conflicts: None,
        aliases: None,
        texts: None,
    }
}

fn create_op() -> Op {
    Op::Create(Create {
        id: B16([3; 16]),
        path: Some("a.md".into()),
        type_name: None,
        frontmatter: None,
        body: Some(Text::from("x")),
        document: None,
    })
}

#[test]
fn genesis_must_be_first_and_trusted() {
    let mut s = PolicyState::new();
    let r = s.apply_control(
        1,
        &CH,
        &policy(1, vec![enrol(10, OWNER, DeviceKind::Desktop)]),
        &env(),
    );
    assert_eq!(r.unwrap_err().rule(), "genesis");
    assert_eq!(s.seq, 1, "a void item still occupies its position");
    assert_eq!(s.voids, 1);
    let mut s = PolicyState::new();
    let untrusted = PolicyOp::Genesis(Genesis {
        owner: OWNER,
        root: key_id(&[5; 32]),
        state: CState::E2e,
    });
    assert!(
        s.apply_control(1, &CH, &policy(1, vec![untrusted]), &env())
            .is_err()
    );
    let mut s = setup(CState::E2e);
    let again = PolicyOp::Genesis(Genesis {
        owner: OWNER,
        root: key_id(&ROOT),
        state: CState::E2e,
    });
    assert!(
        s.apply_control(3, &CH, &policy(3, vec![again]), &env())
            .is_err()
    );
}

#[test]
fn entries_need_keyed_editor_devices_and_current_epoch() {
    let s = setup(CState::E2e);
    assert!(s.check_entry_header(&entry_item(3, 10, 1), &env()).is_ok());
    assert!(s.check_entry_header(&entry_item(3, 11, 1), &env()).is_ok());
    assert_eq!(
        s.check_entry_header(&entry_item(3, 12, 1), &env())
            .unwrap_err()
            .rule(),
        "V1",
        "viewer"
    );
    assert_eq!(
        s.check_entry_header(&entry_item(3, 10, 2), &env())
            .unwrap_err()
            .rule(),
        "V2",
        "wrong epoch"
    );
    let mut bad = entry_item(3, 10, 1);
    bad.sig = Some(sign(&dpk(11).0, &bad.signed_digest().unwrap().0));
    assert_eq!(
        s.check_entry_header(&bad, &env()).unwrap_err().rule(),
        "V1",
        "signature by another key"
    );
    // Not yet keyed: enrolled after the initial rekey.
    let mut s = s;
    s.apply_control(
        3,
        &CH,
        &policy(3, vec![enrol(13, EDITOR, DeviceKind::Cli)]),
        &env(),
    )
    .unwrap();
    assert_eq!(
        s.check_entry_header(&entry_item(4, 13, 1), &env())
            .unwrap_err()
            .rule(),
        "V1"
    );
    s.apply_control(4, &CH, &key_grant(4, 11, 13, 1), &env())
        .unwrap();
    assert!(s.check_entry_header(&entry_item(5, 13, 1), &env()).is_ok());
}

#[test]
fn revocation_requires_rekey_and_voids_content_until_then() {
    for revoke in [
        PolicyOp::DeviceRevoke(DeviceRevoke { device: dev(11) }),
        PolicyOp::MemberRemove(MemberRemove { account: EDITOR }),
    ] {
        let mut s = setup(CState::E2e);
        s.apply_control(3, &CH, &policy(3, vec![revoke]), &env())
            .unwrap();
        assert!(s.rekey_required);
        // Correctly signed content by a still-valid device is void (V2).
        assert_eq!(
            s.check_entry_header(&entry_item(4, 10, 1), &env())
                .unwrap_err()
                .rule(),
            "V2"
        );
        assert_eq!(
            s.check_base_header(&base_content_item(4, 10, 1), &env())
                .unwrap_err()
                .rule(),
            "V2"
        );
        // Revoked device's items are void (V1).
        assert_eq!(
            s.check_entry_header(&entry_item(4, 11, 1), &env())
                .unwrap_err()
                .rule(),
            "V1"
        );
        // A rekey that still wraps for the revoked device is void.
        assert!(
            s.apply_control(
                4,
                &CH,
                &rekey(4, 10, 1, RekeyReason::DeviceRevoked, &[10, 11, 12]),
                &env()
            )
            .is_err()
        );
        // One that misses a keyed device is void.
        assert!(
            s.apply_control(
                5,
                &CH,
                &rekey(5, 10, 1, RekeyReason::DeviceRevoked, &[10]),
                &env()
            )
            .is_err()
        );
        // The revoked device can't rekey.
        assert!(
            s.apply_control(
                6,
                &CH,
                &rekey(6, 11, 1, RekeyReason::DeviceRevoked, &[10, 12]),
                &env()
            )
            .is_err()
        );
        // Exactly the keyed active devices: valid, clears rekey-required.
        s.apply_control(
            7,
            &CH,
            &rekey(7, 12, 1, RekeyReason::DeviceRevoked, &[10, 12]),
            &env(),
        )
        .unwrap();
        assert!(!s.rekey_required);
        assert_eq!(s.epoch, 2);
        assert!(s.check_entry_header(&entry_item(8, 10, 2), &env()).is_ok());
        assert_eq!(
            s.check_entry_header(&entry_item(8, 10, 1), &env())
                .unwrap_err()
                .rule(),
            "V2",
            "old epoch"
        );
    }
}

#[test]
fn member_remove_revokes_devices_and_grants() {
    let mut s = setup(CState::E2e);
    s.apply_control(
        3,
        &CH,
        &policy(3, vec![grant(50, EDITOR, &[capability::CREATE], None)]),
        &env(),
    )
    .unwrap();
    s.apply_control(
        4,
        &CH,
        &policy(
            4,
            vec![PolicyOp::MemberRemove(MemberRemove { account: EDITOR })],
        ),
        &env(),
    )
    .unwrap();
    assert!(!s.devices[&dev(11)].active);
    assert!(!s.grants[&B16([50; 16])].active);
    assert!(!s.grant_allows(&B16([50; 16]), capability::CREATE));
    // The only owner cannot be removed or demoted.
    assert!(
        s.apply_control(
            5,
            &CH,
            &policy(
                5,
                vec![PolicyOp::MemberRemove(MemberRemove { account: OWNER })]
            ),
            &env()
        )
        .is_err()
    );
    let demote = PolicyOp::MemberSet(MemberSet {
        account: OWNER,
        role: Role::Editor,
    });
    assert!(
        s.apply_control(6, &CH, &policy(6, vec![demote]), &env())
            .is_err()
    );
}

fn grant(n: u8, account: Uuid, caps: &[&str], folders: Option<Vec<String>>) -> PolicyOp {
    PolicyOp::Grant(Grant {
        grant: B16([n; 16]),
        installation: B16([n + 1; 16]),
        app_id: "app".into(),
        account,
        capabilities: caps.iter().map(|c| c.to_string()).collect(),
        client_pk: B32([n; 32]),
        file_folders: folders,
        folder_scoped: None,
    })
}

#[test]
fn sem_ratchet() {
    let mut s = setup(CState::E2e);
    let (pk, fp) = ctx_none();
    let ctx = OpContext {
        path_key: &pk,
        file_path: &fp,
    };
    s.note_entry(3, 2, 100);
    assert_eq!(
        s.check_entry_payload_by(&payload(None, vec![create_op()], 1), &ctx)
            .unwrap_err()
            .rule(),
        "V5"
    );
    assert!(
        s.check_entry_payload_by(&payload(None, vec![create_op()], 2), &ctx)
            .is_ok()
    );
    s.note_entry(4, 2, 50);
    assert_eq!(s.log_time, 100, "log_time never goes backwards");
    let raise = PolicyOp::CollectionState(CollectionState {
        state: CState::E2e,
        compress: Some(false),
        min_sem_major: Some(3),
    });
    s.apply_control(5, &CH, &policy(5, vec![raise]), &env())
        .unwrap();
    assert_eq!(s.sem_ratchet, 3);
    assert!(!s.compress);
}

#[test]
fn cp_cert_rules() {
    let s0 = setup(CState::E2e);
    let freeze = || {
        vec![PolicyOp::Freeze(Freeze {
            frozen: true,
            reason: None,
        })]
    };
    // Expired / not yet valid.
    let mut s = s0.clone();
    assert!(
        s.apply_control(
            3,
            &CH,
            &policy_with(3, 2000, cert(0, 1000, CP), freeze()),
            &env()
        )
        .is_err()
    );
    // Backdated behind a newer item.
    let mut s = s0.clone();
    // An item with no ops does not decode (ops is `[+ policy-op]`): void.
    assert_eq!(
        s.apply_control(
            3,
            &CH,
            &policy_with(3, 500, cert(0, 1000, CP), vec![]),
            &env()
        )
        .unwrap_err()
        .rule(),
        "V4"
    );
    s.apply_control(
        4,
        &CH,
        &policy_with(4, 500, cert(0, 1000, CP), freeze()),
        &env(),
    )
    .unwrap();
    assert!(
        s.apply_control(
            5,
            &CH,
            &policy_with(5, 499, cert(0, 1000, CP), freeze()),
            &env()
        )
        .is_err()
    );
    // A certificate not signed by the root.
    let mut s = s0.clone();
    let mut c = cert(0, 1000, CP);
    c.sig = sign(&[3; 32], &c.signed_digest().unwrap().0);
    assert!(
        s.apply_control(3, &CH, &policy_with(3, 3, c, freeze()), &env())
            .is_err()
    );
    // Revoked policy key: items issued at or after revoked_from are void.
    let mut s = s0.clone();
    let kid = key_id(&[4; 32]);
    let msg = cbor::encode(&Cbor::Array(vec![kid.to_cbor(), Cbor::int(10)])).unwrap();
    let rs = sign(&ROOT, &h("mdbase/v1/cp-key-revoke", &msg).0);
    s.apply_control(
        3,
        &CH,
        &policy(
            3,
            vec![PolicyOp::CpKeyRevoke(CpKeyRevoke {
                key_id: kid,
                revoked_from: 10,
                root_sig: rs,
            })],
        ),
        &env(),
    )
    .unwrap();
    assert!(
        s.apply_control(
            4,
            &CH,
            &policy_with(4, 9, cert(0, 1000, [4; 32]), freeze()),
            &env()
        )
        .is_ok()
    );
    assert!(
        s.apply_control(
            5,
            &CH,
            &policy_with(5, 10, cert(0, 1000, [4; 32]), freeze()),
            &env()
        )
        .is_err()
    );
    // Forged cp-key-revoke.
    let mut s = s0.clone();
    let bad = PolicyOp::CpKeyRevoke(CpKeyRevoke {
        key_id: kid,
        revoked_from: 10,
        root_sig: B64([0; 64]),
    });
    assert!(
        s.apply_control(3, &CH, &policy(3, vec![bad]), &env())
            .is_err()
    );
    // One invalid op voids the whole item atomically.
    let mut s = s0.clone();
    let before = s.clone();
    let ops = vec![
        PolicyOp::Freeze(Freeze {
            frozen: true,
            reason: None,
        }),
        PolicyOp::DeviceRevoke(DeviceRevoke { device: dev(99) }),
    ];
    assert!(s.apply_control(3, &CH, &policy(3, ops), &env()).is_err());
    assert!(!s.frozen);
    assert_eq!(s.devices, before.devices);
}

#[test]
fn frozen_blocks_content() {
    let mut s = setup(CState::E2e);
    s.apply_control(
        3,
        &CH,
        &policy(
            3,
            vec![PolicyOp::Freeze(Freeze {
                frozen: true,
                reason: None,
            })],
        ),
        &env(),
    )
    .unwrap();
    assert_eq!(
        s.check_entry_header(&entry_item(4, 10, 1), &env())
            .unwrap_err()
            .rule(),
        "frozen"
    );
    let cut = PolicyOp::MigrationCutover(MigrationCutover {
        legacy_collection: B16([1; 16]),
        revoked: vec![],
        cutover_at: 0,
    });
    s.apply_control(
        4,
        &CH,
        &policy(
            4,
            vec![
                cut.clone(),
                PolicyOp::Freeze(Freeze {
                    frozen: false,
                    reason: None,
                }),
            ],
        ),
        &env(),
    )
    .unwrap();
    assert!(s.check_entry_header(&entry_item(5, 10, 1), &env()).is_ok());
    assert!(
        s.apply_control(5, &CH, &policy(5, vec![cut]), &env())
            .is_err(),
        "cutover at most once"
    );
}

#[test]
fn cloud_copy_rules() {
    let mut s = setup(CState::CloudCopy);
    assert!(s.devices[&dev(20)].keyed);
    // Hosted writes in cloud copy; escrow never writes.
    assert!(s.check_entry_header(&entry_item(3, 21, 1), &env()).is_ok());
    assert_eq!(
        s.check_entry_header(&entry_item(3, 20, 1), &env())
            .unwrap_err()
            .rule(),
        "V1"
    );
    // Escrow keys new member devices automatically.
    s.apply_control(
        3,
        &CH,
        &policy(3, vec![enrol(13, EDITOR, DeviceKind::Mobile)]),
        &env(),
    )
    .unwrap();
    s.apply_control(4, &CH, &key_grant(4, 20, 13, 1), &env())
        .unwrap();
    assert!(s.devices[&dev(13)].keyed);
    // Rekey recipients include escrow and hosted while active.
    assert_eq!(
        s.rekey_recipients(),
        [10, 11, 12, 13, 20, 21].map(dev).into_iter().collect()
    );
    // Switching to e2e with escrow/hosted still active is void.
    let to_e2e = PolicyOp::CollectionState(CollectionState {
        state: CState::E2e,
        compress: None,
        min_sem_major: None,
    });
    assert!(
        s.apply_control(5, &CH, &policy(5, vec![to_e2e.clone()]), &env())
            .is_err()
    );
    // Cloud copy off: revoke both in the same item -> e2e, rekey-required.
    let off = vec![
        PolicyOp::DeviceRevoke(DeviceRevoke { device: dev(21) }),
        PolicyOp::DeviceRevoke(DeviceRevoke { device: dev(20) }),
        to_e2e,
    ];
    s.apply_control(6, &CH, &policy(6, off), &env()).unwrap();
    assert!(s.rekey_required);
    assert_eq!(
        s.check_entry_header(&entry_item(7, 10, 1), &env())
            .unwrap_err()
            .rule(),
        "V2"
    );
    // Escrow is gone: in e2e it may not grant keys any more.
    s.apply_control(
        7,
        &CH,
        &policy(7, vec![enrol(14, EDITOR, DeviceKind::Mobile)]),
        &env(),
    )
    .unwrap();
    assert!(
        s.apply_control(8, &CH, &key_grant(8, 20, 14, 1), &env())
            .is_err()
    );
    s.apply_control(
        9,
        &CH,
        &rekey(9, 10, 1, RekeyReason::CloudCopyOff, &[10, 11, 12, 13]),
        &env(),
    )
    .unwrap();
    assert!(!s.rekey_required);
    // In e2e, an escrow-kind device is not an editor and can't key devices.
    assert!(
        s.apply_control(10, &CH, &key_grant(10, 21, 14, 2), &env())
            .is_err()
    );
    // Switching to cloud copy needs an active escrow.
    let to_cc = PolicyOp::CollectionState(CollectionState {
        state: CState::CloudCopy,
        compress: None,
        min_sem_major: None,
    });
    assert!(
        s.apply_control(11, &CH, &policy(11, vec![to_cc]), &env())
            .is_err()
    );
}

#[test]
fn initial_rekey_rules() {
    let genesis = |state| {
        let mut s = PolicyState::new();
        let mut ops = vec![
            PolicyOp::Genesis(Genesis {
                owner: OWNER,
                root: key_id(&ROOT),
                state,
            }),
            PolicyOp::MemberSet(MemberSet {
                account: OWNER,
                role: Role::Owner,
            }),
            PolicyOp::MemberSet(MemberSet {
                account: VIEWER,
                role: Role::Viewer,
            }),
            enrol(10, OWNER, DeviceKind::Desktop),
            enrol(12, VIEWER, DeviceKind::Desktop),
        ];
        if state == CState::CloudCopy {
            ops.push(enrol(20, SERVICE_ACCOUNT, DeviceKind::Escrow));
            ops.push(enrol(21, SERVICE_ACCOUNT, DeviceKind::Hosted));
        }
        s.apply_control(1, &CH, &policy(1, ops), &env()).unwrap();
        s
    };
    let e = env();
    // A viewer device can't do the initial rekey; it must include the signer.
    assert!(
        genesis(CState::E2e)
            .apply_control(
                2,
                &CH,
                &rekey(2, 12, 0, RekeyReason::Initial, &[10, 12]),
                &e
            )
            .is_err()
    );
    assert!(
        genesis(CState::E2e)
            .apply_control(2, &CH, &rekey(2, 10, 0, RekeyReason::Initial, &[12]), &e)
            .is_err()
    );
    assert!(
        genesis(CState::E2e)
            .apply_control(2, &CH, &rekey(2, 10, 0, RekeyReason::Scheduled, &[10]), &e)
            .is_err()
    );
    // Leaving devices out is allowed initially; they are keyed later.
    let mut s = genesis(CState::E2e);
    s.apply_control(2, &CH, &rekey(2, 10, 0, RekeyReason::Initial, &[10]), &e)
        .unwrap();
    assert!(!s.devices[&dev(12)].keyed);
    // A second "initial" is void (from must equal the current epoch).
    assert!(
        s.apply_control(3, &CH, &rekey(3, 10, 0, RekeyReason::Initial, &[10]), &e)
            .is_err()
    );
    // Cloud copy: the initial epoch must reach the escrow and hosted.
    for to in [&[10][..], &[10, 20], &[10, 21]] {
        assert!(
            genesis(CState::CloudCopy)
                .apply_control(2, &CH, &rekey(2, 10, 0, RekeyReason::Initial, to), &e)
                .is_err()
        );
    }
    genesis(CState::CloudCopy)
        .apply_control(
            2,
            &CH,
            &rekey(2, 10, 0, RekeyReason::Initial, &[10, 20, 21]),
            &e,
        )
        .unwrap();
    // Hosted may be the first keyed replica; the escrow may not sign an initial.
    assert!(
        genesis(CState::CloudCopy)
            .apply_control(
                2,
                &CH,
                &rekey(2, 20, 0, RekeyReason::Initial, &[20, 21]),
                &e
            )
            .is_err()
    );
    let mut s = genesis(CState::CloudCopy);
    s.apply_control(
        2,
        &CH,
        &rekey(2, 21, 0, RekeyReason::Initial, &[21, 20]),
        &e,
    )
    .unwrap();
    assert_eq!(s.epoch, 1);
    // Duplicate wraps for one device are void.
    let mut s = genesis(CState::E2e);
    assert!(
        s.apply_control(
            2,
            &CH,
            &rekey(2, 10, 0, RekeyReason::Initial, &[10, 10]),
            &e
        )
        .is_err()
    );
}

#[test]
fn base_rules() {
    let mut s = setup(CState::E2e);
    let b = base_content_item(3, 10, 1);
    assert!(s.check_base_header(&b, &env()).is_ok());
    assert!(s.check_base_payload(&b, &B32([7; 32])).is_ok());
    assert!(s.check_base_payload(&b, &B32([8; 32])).is_err());
    assert!(
        s.check_base_header(&base_content_item(3, 12, 1), &env())
            .is_err(),
        "viewer"
    );
    s.note_entry(3, 1, 0);
    assert_eq!(
        s.check_base_header(&base_content_item(4, 10, 1), &env())
            .unwrap_err()
            .rule(),
        "base"
    );
}

#[test]
fn enrol_rules() {
    let mut s = setup(CState::E2e);
    assert!(
        s.apply_control(
            3,
            &CH,
            &policy(3, vec![enrol(10, OWNER, DeviceKind::Desktop)]),
            &env()
        )
        .is_err(),
        "reused ID"
    );
    assert!(
        s.apply_control(
            4,
            &CH,
            &policy(4, vec![enrol(30, B16([0xEE; 16]), DeviceKind::Desktop)]),
            &env()
        )
        .is_err(),
        "non-member"
    );
    assert!(
        s.apply_control(
            5,
            &CH,
            &policy(5, vec![enrol(31, OWNER, DeviceKind::Escrow)]),
            &env()
        )
        .is_err(),
        "escrow needs the service account"
    );
    s.apply_control(
        6,
        &CH,
        &policy(
            6,
            vec![PolicyOp::DeviceRevoke(DeviceRevoke { device: dev(12) })],
        ),
        &env(),
    )
    .unwrap();
    assert!(
        s.apply_control(
            7,
            &CH,
            &policy(7, vec![enrol(12, VIEWER, DeviceKind::Desktop)]),
            &env()
        )
        .is_err(),
        "a revoked ID is never re-enrolled"
    );
    assert!(
        s.apply_control(
            8,
            &CH,
            &policy(
                8,
                vec![PolicyOp::DeviceRevoke(DeviceRevoke { device: dev(12) })]
            ),
            &env()
        )
        .is_err(),
        "already revoked"
    );
}

fn approve(
    s: &mut PolicyState,
    seq: u64,
    signer: u8,
    grant_n: u8,
    caps: &[&str],
    folders: Option<Vec<String>>,
) -> Verdict {
    let item = ga_item(seq, signer, s.epoch, signer);
    let a = GrantApprovalPayload {
        grant: B16([grant_n; 16]),
        client_pk: B32([grant_n; 32]),
        capabilities: caps.iter().map(|c| c.to_string()).collect(),
        file_folders: folders,
    };
    s.apply_grant_approval(seq, &CH, &item, Ok(&a), &env())
}

/// A sealed `grant_approval` item (the body is opaque here), signed with
/// `sign_as`'s key.
fn ga_item(seq: u64, signer: u8, epoch: u64, sign_as: u8) -> Item {
    let mut i = base_item(ItemKind::GrantApproval, seq, dev(signer), vec![9]);
    i.epoch = Some(epoch);
    i.salt = Some(B16([0; 16]));
    signed(i, &dpk(sign_as).0)
}

fn fput(p: &str, id: u8) -> Op {
    Op::FilePut(FilePut {
        id: B16([id; 16]),
        path: p.into(),
        blob: BlobRef {
            plain_hash: B32([0; 32]),
            size: 0,
            blob_id: B32([0; 32]),
            id_epoch: 1,
            part_size: 1,
        },
        if_revision: None,
        base: None,
    })
}

#[test]
fn e2e_grants_need_a_device_approval() {
    let mut s = setup(CState::E2e);
    let g = B16([50; 16]);
    let (pk, fp) = ctx_none();
    let ctx = OpContext {
        path_key: &pk,
        file_path: &fp,
    };
    // Folders in clear are void in e2e.
    assert!(
        s.apply_control(
            3,
            &CH,
            &policy(
                3,
                vec![grant(
                    50,
                    EDITOR,
                    &[capability::CREATE],
                    Some(vec!["img".into()])
                )]
            ),
            &env()
        )
        .is_err()
    );
    s.apply_control(
        4,
        &CH,
        &policy(
            4,
            vec![grant(
                50,
                EDITOR,
                &[capability::CREATE, capability::READ],
                None,
            )],
        ),
        &env(),
    )
    .unwrap();
    // The CP-authored grant alone authorizes nothing.
    assert!(s.effective_grant(&g).is_none());
    assert!(s.grant_for_client(&g, &[50; 32]).is_none());
    assert!(!s.grant_allows(&g, capability::READ));
    assert_eq!(
        s.check_entry_payload_by(&payload(Some(g), vec![create_op()], 1), &ctx)
            .unwrap_err()
            .rule(),
        "V6"
    );
    // Approval by a device of another member, a wrong client_pk, a superset, or a
    // viewer device of another account: void.
    assert!(
        approve(&mut s, 5, 10, 50, &[capability::CREATE], None).is_err(),
        "owner device, editor's grant"
    );
    let bad_pk = GrantApprovalPayload {
        grant: g,
        client_pk: B32([51; 32]),
        capabilities: vec![capability::CREATE.into()],
        file_folders: None,
    };
    let h11 = ga_item(6, 11, 1, 11);
    assert!(
        s.apply_grant_approval(6, &CH, &h11, Ok(&bad_pk), &env())
            .is_err()
    );
    assert!(
        approve(&mut s, 7, 11, 50, &[capability::DELETE], None).is_err(),
        "not a subset"
    );
    let forged = ga_item(8, 11, 1, 10);
    let ok = GrantApprovalPayload {
        grant: g,
        client_pk: B32([50; 32]),
        capabilities: vec![capability::CREATE.into()],
        file_folders: None,
    };
    assert_eq!(
        s.apply_grant_approval(8, &CH, &forged, Ok(&ok), &env())
            .unwrap_err()
            .rule(),
        "V1"
    );
    let stale = ga_item(9, 11, 2, 11);
    assert_eq!(
        s.apply_grant_approval(9, &CH, &stale, Ok(&ok), &env())
            .unwrap_err()
            .rule(),
        "V2"
    );
    // Valid approval narrowing to create, scoped to img/.
    approve(
        &mut s,
        10,
        11,
        50,
        &[capability::CREATE],
        Some(vec!["img".into()]),
    )
    .unwrap();
    assert!(s.grant_allows(&g, capability::CREATE));
    assert!(
        !s.grant_allows(&g, capability::READ),
        "approval narrowed it"
    );
    assert!(s.grant_for_client(&g, &[50; 32]).is_some());
    assert!(s.grant_for_client(&g, &[51; 32]).is_none());
    assert!(
        approve(
            &mut s,
            11,
            11,
            50,
            &[capability::CREATE, capability::READ],
            None
        )
        .is_err(),
        "first approval wins"
    );
    assert!(
        s.check_entry_payload_by(&payload(Some(g), vec![create_op()], 1), &ctx)
            .is_ok()
    );
    // Folder scope from the approval: inside ok; outside, or a prefix without a boundary, void.
    assert!(
        s.check_entry_payload_by(&payload(Some(g), vec![fput("IMG/a.png", 4)], 1), &ctx)
            .is_ok()
    );
    assert!(
        s.check_entry_payload_by(&payload(Some(g), vec![fput("docs/a.png", 4)], 1), &ctx)
            .is_err()
    );
    assert!(
        s.check_entry_payload_by(&payload(Some(g), vec![fput("imgs/a.png", 4)], 1), &ctx)
            .is_err()
    );
    // Revoked grant: void.
    s.apply_control(
        12,
        &CH,
        &policy(12, vec![PolicyOp::GrantRevoke(GrantRevoke { grant: g })]),
        &env(),
    )
    .unwrap();
    assert_eq!(
        s.check_entry_payload_by(&payload(Some(g), vec![create_op()], 1), &ctx)
            .unwrap_err()
            .rule(),
        "V6"
    );
    // Rekey-required blocks approvals (V2).
    let mut s = setup(CState::E2e);
    s.apply_control(
        3,
        &CH,
        &policy(3, vec![grant(50, EDITOR, &[capability::CREATE], None)]),
        &env(),
    )
    .unwrap();
    s.apply_control(
        4,
        &CH,
        &policy(
            4,
            vec![PolicyOp::DeviceRevoke(DeviceRevoke { device: dev(12) })],
        ),
        &env(),
    )
    .unwrap();
    assert_eq!(
        approve(&mut s, 5, 11, 50, &[capability::CREATE], None)
            .unwrap_err()
            .rule(),
        "V2"
    );
}

#[test]
fn cloud_copy_grants_use_the_grant_op() {
    let mut s = setup(CState::CloudCopy);
    let g = B16([50; 16]);
    s.apply_control(
        3,
        &CH,
        &policy(
            3,
            vec![grant(
                50,
                EDITOR,
                &[capability::CREATE],
                Some(vec!["img".into()]),
            )],
        ),
        &env(),
    )
    .unwrap();
    let (pk, _) = ctx_none();
    assert!(s.grant_allows(&g, capability::CREATE));
    // Replacing a file whose current path is outside the scope is void, even when
    // the new path is inside.
    let fp_outside = |_: &Uuid| Some("docs/x.png".to_string());
    let ctx = OpContext {
        path_key: &pk,
        file_path: &fp_outside,
    };
    let r = s.check_entry_payload_by(&payload(Some(g), vec![fput("img/x.png", 4)], 1), &ctx);
    assert!(r.is_err(), "{r:?}");
    let upd = Op::Update(Update {
        id: B16([3; 16]),
        patch: None,
        unset: None,
        add: None,
        remove: None,
        body: Some(Text::from("y")),
        body_edits: None,
        body_base: None,
        body_base_text: None,
        base: None,
        if_revision: None,
    });
    let fp = |_: &Uuid| None;
    let ctx = OpContext {
        path_key: &pk,
        file_path: &fp,
    };
    assert!(
        s.check_entry_payload_by(&payload(Some(g), vec![upd], 1), &ctx)
            .is_err(),
        "lacks edit"
    );
    let del = Op::FileDelete(FileDelete {
        id: B16([4; 16]),
        if_revision: None,
        base: None,
    });
    assert!(
        s.check_entry_payload_by(&payload(Some(g), vec![del], 1), &ctx)
            .is_err(),
        "lacks delete"
    );
    let res = Op::ResourcePut(ResourcePut {
        path: "mdbase.yaml".into(),
        doc: Text::from("a: 1"),
        base_revision: None,
        must_not_exist: None,
    });
    assert!(
        s.check_entry_payload_by(&payload(Some(g), vec![res], 1), &ctx)
            .is_err(),
        "lacks definitions.manage"
    );
    // Member demoted to viewer: write capabilities stop; viewers grant read only.
    s.apply_control(
        4,
        &CH,
        &policy(
            4,
            vec![PolicyOp::MemberSet(MemberSet {
                account: EDITOR,
                role: Role::Viewer,
            })],
        ),
        &env(),
    )
    .unwrap();
    assert!(!s.grant_allows(&g, capability::CREATE));
    assert!(
        s.apply_control(
            5,
            &CH,
            &policy(5, vec![grant(60, VIEWER, &[capability::CREATE], None)]),
            &env()
        )
        .is_err()
    );
    assert!(
        s.apply_control(
            6,
            &CH,
            &policy(6, vec![grant(60, VIEWER, &[capability::READ], None)]),
            &env()
        )
        .is_ok()
    );
}

#[test]
fn unknown_variants_stall_and_change_nothing() {
    let mut s = setup(CState::E2e);
    let before = s.clone();
    // A policy item whose second op has an unknown discriminator (99).
    let c = cert(0, 1000, CP);
    let known = PolicyOp::DeviceRevoke(DeviceRevoke { device: dev(11) }).to_cbor();
    let unknown = Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Uint(99)),
        (Cbor::Uint(1), Cbor::Uint(1)),
    ]);
    let body = Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Uint(1)),
        (Cbor::Uint(1), c.to_cbor()),
        (Cbor::Uint(2), Cbor::Uint(3)),
        (Cbor::Uint(3), Cbor::Array(vec![known, unknown])),
    ]);
    let item = signed(
        base_item(
            ItemKind::Policy,
            3,
            c.key_id(),
            cbor::encode(&body).unwrap(),
        ),
        &CP,
    );
    let r = s.apply_control(3, &B32([3; 32]), &item, &env());
    assert!(r.unwrap_err().is_stall());
    assert_eq!(
        s, before,
        "a stall applies nothing: not the revoke, not the position, not ctl"
    );
    // An unknown payload fmt stalls too; malformed bytes are void (V4).
    let mut body2 = body.clone();
    if let Cbor::Map(m) = &mut body2 {
        m[0].1 = Cbor::Uint(2);
    }
    let item2 = signed(
        base_item(
            ItemKind::Policy,
            3,
            c.key_id(),
            cbor::encode(&body2).unwrap(),
        ),
        &CP,
    );
    assert!(
        s.apply_control(3, &CH, &item2, &env())
            .unwrap_err()
            .is_stall()
    );
    let junk = signed(base_item(ItemKind::Policy, 3, c.key_id(), vec![0xff]), &CP);
    assert_eq!(
        s.apply_control(3, &CH, &junk, &env()).unwrap_err().rule(),
        "V4"
    );
    assert_eq!(s.seq, 3);
    // Same for an unknown device kind (kind 7, which no wire version defines yet).
    let mut s = setup(CState::E2e);
    let mut enrol_c = enrol(30, OWNER, DeviceKind::Desktop).to_cbor();
    if let Cbor::Map(m) = &mut enrol_c {
        for (k, v) in m.iter_mut() {
            if *k == Cbor::Uint(3) {
                *v = Cbor::Uint(7);
            }
        }
    }
    let body = Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Uint(1)),
        (Cbor::Uint(1), c.to_cbor()),
        (Cbor::Uint(2), Cbor::Uint(3)),
        (Cbor::Uint(3), Cbor::Array(vec![enrol_c])),
    ]);
    let item = signed(
        base_item(
            ItemKind::Policy,
            3,
            c.key_id(),
            cbor::encode(&body).unwrap(),
        ),
        &CP,
    );
    assert!(
        s.apply_control(3, &CH, &item, &env())
            .unwrap_err()
            .is_stall()
    );
    // A grant approval whose payload has an unknown variant stalls.
    let h = ga_item(3, 11, 1, 11);
    let before = s.clone();
    let r = s.apply_grant_approval(
        3,
        &CH,
        &h,
        Err(SchemaError::UnknownFormat { ty: "x", fmt: 2 }),
        &env(),
    );
    assert!(r.unwrap_err().is_stall());
    assert_eq!(s, before);
}

#[test]
fn service_devices_and_accounts() {
    // Escrow/hosted can't be enrolled while the collection stays e2e.
    let mut s = setup(CState::E2e);
    assert_eq!(
        s.apply_control(
            3,
            &CH,
            &policy(3, vec![enrol(20, SERVICE_ACCOUNT, DeviceKind::Escrow)]),
            &env()
        )
        .unwrap_err()
        .rule(),
        "device-enrol"
    );
    // ...but can in the same item that turns cloud copy on (an alert event follows).
    let ev = s
        .apply_control(
            4,
            &CH,
            &policy(
                4,
                vec![
                    enrol(20, SERVICE_ACCOUNT, DeviceKind::Escrow),
                    PolicyOp::CollectionState(CollectionState {
                        state: CState::CloudCopy,
                        compress: None,
                        min_sem_major: None,
                    }),
                ],
            ),
            &env(),
        )
        .unwrap();
    assert_eq!(
        ev,
        vec![PolicyEvent::CollectionStateChanged {
            from: Some(CState::E2e),
            to: CState::CloudCopy
        }]
    );
    // The service account is never a member; all-zero noise keys are refused.
    assert!(
        s.apply_control(
            5,
            &CH,
            &policy(
                5,
                vec![PolicyOp::MemberSet(MemberSet {
                    account: SERVICE_ACCOUNT,
                    role: Role::Editor
                })]
            ),
            &env()
        )
        .is_err()
    );
    let mut zero = enrol(31, OWNER, DeviceKind::Desktop);
    if let PolicyOp::DeviceEnrol(e) = &mut zero {
        e.noise_pk = B32([0; 32]);
    }
    assert!(
        s.apply_control(6, &CH, &policy(6, vec![zero]), &env())
            .is_err()
    );
    // Two genesis ops at position 1 are void.
    let mut s = PolicyState::new();
    let g = PolicyOp::Genesis(Genesis {
        owner: OWNER,
        root: key_id(&ROOT),
        state: CState::E2e,
    });
    assert!(
        s.apply_control(1, &CH, &policy(1, vec![g.clone(), g]), &env())
            .is_err()
    );
}

#[test]
fn cp_key_revoke_is_not_retroactive_and_reports_positions() {
    let mut s = setup(CState::E2e);
    let k4 = [4u8; 32];
    let freeze = |f| {
        vec![PolicyOp::Freeze(Freeze {
            frozen: f,
            reason: None,
        })]
    };
    s.apply_control(
        3,
        &CH,
        &policy_with(3, 20, cert(0, 1000, k4), freeze(true)),
        &env(),
    )
    .unwrap();
    s.apply_control(
        4,
        &CH,
        &policy_with(4, 30, cert(0, 1000, k4), freeze(false)),
        &env(),
    )
    .unwrap();
    let kid = key_id(&k4);
    let msg = cbor::encode(&Cbor::Array(vec![kid.to_cbor(), Cbor::int(25)])).unwrap();
    let rs = sign(&ROOT, &h("mdbase/v1/cp-key-revoke", &msg).0);
    let ev = s
        .apply_control(
            5,
            &CH,
            &policy_with(
                5,
                40,
                cert(0, 1000, CP),
                vec![PolicyOp::CpKeyRevoke(CpKeyRevoke {
                    key_id: kid,
                    revoked_from: 25,
                    root_sig: rs,
                })],
            ),
            &env(),
        )
        .unwrap();
    assert_eq!(
        ev,
        vec![PolicyEvent::PolicyKeyCompromised {
            key_id: kid,
            positions: vec![4]
        }]
    );
    assert!(!s.frozen, "earlier verdicts stand");
    // The old tag no longer verifies.
    let mut s = setup(CState::E2e);
    let old = sign(&ROOT, &h("mdbase/v1/cp-cert", &msg).0);
    assert!(
        s.apply_control(
            3,
            &CH,
            &policy(
                3,
                vec![PolicyOp::CpKeyRevoke(CpKeyRevoke {
                    key_id: kid,
                    revoked_from: 25,
                    root_sig: old
                })]
            ),
            &env()
        )
        .is_err()
    );
}

#[test]
fn encoding_round_trips() {
    let mut s = setup(CState::E2e);
    s.apply_control(
        3,
        &CH,
        &policy(
            3,
            vec![grant(
                50,
                EDITOR,
                &[capability::CREATE, capability::READ],
                None,
            )],
        ),
        &env(),
    )
    .unwrap();
    approve(
        &mut s,
        4,
        11,
        50,
        &[capability::READ],
        Some(vec!["a".into()]),
    )
    .unwrap();
    s.note_entry(5, 1, -5);
    s.note_void(6, Some(&B32([6; 32])));
    s.note_base(7, &B32([7; 32]));
    let b = s.to_bytes().unwrap();
    let back = PolicyState::from_bytes(&b).unwrap();
    assert_eq!(back, s);
    assert_eq!(back.to_bytes().unwrap(), b, "canonical");
}

#[test]
fn control_chain_covers_every_control_item_with_its_position() {
    let s0 = setup(CState::E2e);
    let mut a = s0.clone();
    let mut b = s0.clone();
    let c3 = B32([3; 32]);
    a.apply_control(
        3,
        &c3,
        &policy(
            3,
            vec![PolicyOp::Freeze(Freeze {
                frozen: true,
                reason: None,
            })],
        ),
        &env(),
    )
    .unwrap();
    // A void control item at the same position and chain gives the same ctl.
    let _ = b.apply_control(
        3,
        &c3,
        &policy(
            3,
            vec![PolicyOp::DeviceRevoke(DeviceRevoke { device: dev(99) })],
        ),
        &env(),
    );
    assert_eq!(a.ctl_chain, b.ctl_chain);
    let mut m = s0.ctl_chain.0.to_vec();
    m.extend_from_slice(&3u64.to_be_bytes());
    m.extend_from_slice(&c3.0);
    assert_eq!(a.ctl_chain, h("mdbase/v1/ctl-chain", &m));
    // base and grant approvals count; entries don't.
    let before = a.ctl_chain;
    a.note_entry(4, 1, 0);
    a.note_void(5, None);
    assert_eq!(a.ctl_chain, before);
    a.note_base(6, &B32([6; 32]));
    assert_ne!(a.ctl_chain, before);
    // An omitted control item changes the accumulator.
    let mut c = s0.clone();
    c.apply_control(
        4,
        &c3,
        &policy(
            4,
            vec![PolicyOp::Freeze(Freeze {
                frozen: true,
                reason: None,
            })],
        ),
        &env(),
    )
    .unwrap();
    assert_ne!(c.ctl_chain, b.ctl_chain, "same item at another position");
}

#[test]
fn key_trust_follows_the_delivery_chain_to_a_trusted_device() {
    let none = BTreeSet::new();
    // A CP-enrolled device under the owner account wins the initial rekey.
    let mut s = PolicyState::new();
    let ops = vec![
        PolicyOp::Genesis(Genesis {
            owner: OWNER,
            root: key_id(&ROOT),
            state: CState::E2e,
        }),
        PolicyOp::MemberSet(MemberSet {
            account: OWNER,
            role: Role::Owner,
        }),
        enrol(10, OWNER, DeviceKind::Desktop),
        enrol(66, OWNER, DeviceKind::Desktop),
    ];
    s.apply_control(1, &CH, &policy(1, ops), &env()).unwrap();
    s.apply_control(
        2,
        &CH,
        &rekey(2, 66, 0, RekeyReason::Initial, &[66, 10]),
        &env(),
    )
    .unwrap();
    assert_eq!(
        s.key_trust(&dev(10), &none, false),
        KeyTrust::Untrusted {
            delivered_by: Some(dev(66))
        }
    );
    assert_eq!(
        s.key_trust(&dev(10), &[dev(66)].into_iter().collect(), false),
        KeyTrust::Trusted,
        "after SAS approval"
    );
    assert_eq!(s.key_trust(&dev(77), &none, false), KeyTrust::NotKeyed);
    // Normal flow: 10 keys itself, 11 and 12 join via SAS with 10.
    let mut s = setup(CState::E2e);
    assert_eq!(s.key_trust(&dev(10), &none, false), KeyTrust::Trusted);
    let t10: BTreeSet<Uuid> = [dev(10)].into_iter().collect();
    assert_eq!(s.key_trust(&dev(11), &t10, false), KeyTrust::Trusted);
    // A later rekey by 11 is trusted by 10 (11 was introduced by 10) and by 12.
    s.apply_control(
        3,
        &CH,
        &policy(
            3,
            vec![PolicyOp::DeviceRevoke(DeviceRevoke { device: dev(12) })],
        ),
        &env(),
    )
    .unwrap();
    s.apply_control(
        4,
        &CH,
        &rekey(4, 11, 1, RekeyReason::DeviceRevoked, &[10, 11]),
        &env(),
    )
    .unwrap();
    assert_eq!(s.key_trust(&dev(10), &none, false), KeyTrust::Trusted);
}

#[test]
fn cloud_copy_trust_needs_the_users_own_choice() {
    // The CP enrols an escrow, flips cstate to cloud copy, and wins the
    // initial rekey with its own device. The log's cstate is not enough.
    let mut s = PolicyState::new();
    let ops = vec![
        PolicyOp::Genesis(Genesis {
            owner: OWNER,
            root: key_id(&ROOT),
            state: CState::E2e,
        }),
        PolicyOp::MemberSet(MemberSet {
            account: OWNER,
            role: Role::Owner,
        }),
        enrol(10, OWNER, DeviceKind::Desktop),
        enrol(20, SERVICE_ACCOUNT, DeviceKind::Escrow),
        enrol(21, SERVICE_ACCOUNT, DeviceKind::Hosted),
        PolicyOp::CollectionState(CollectionState {
            state: CState::CloudCopy,
            compress: None,
            min_sem_major: None,
        }),
    ];
    s.apply_control(1, &CH, &policy(1, ops), &env()).unwrap();
    // A service (hosted) wins the initial rekey under the CP-chosen cloud copy.
    s.apply_control(
        2,
        &CH,
        &rekey(2, 21, 0, RekeyReason::Initial, &[21, 20, 10]),
        &env(),
    )
    .unwrap();
    let none = BTreeSet::new();
    assert!(matches!(
        s.key_trust(&dev(10), &none, false),
        KeyTrust::Untrusted { .. }
    ));
    assert_eq!(
        s.key_trust(&dev(10), &none, true),
        KeyTrust::Trusted,
        "this user turned cloud copy on here"
    );
}

#[test]
fn receipts_are_scoped_per_grant() {
    let mut s = setup(CState::E2e);
    s.apply_control(
        3,
        &CH,
        &policy(3, vec![grant(50, EDITOR, &[capability::EDIT], None)]),
        &env(),
    )
    .unwrap();
    s.apply_control(
        4,
        &CH,
        &policy(
            4,
            vec![grant(
                60,
                EDITOR,
                &[capability::EDIT, capability::READ],
                None,
            )],
        ),
        &env(),
    )
    .unwrap();
    approve(&mut s, 5, 11, 50, &[capability::EDIT], None).unwrap();
    approve(
        &mut s,
        6,
        11,
        60,
        &[capability::EDIT, capability::READ],
        None,
    )
    .unwrap();
    let (g50, g60) = (B16([50; 16]), B16([60; 16]));
    assert_eq!(s.receipt_scope(None, Some(&g50)), ReceiptScope::Full);
    assert_eq!(
        s.receipt_scope(Some(&g50), Some(&g50)),
        ReceiptScope::StateOnly,
        "write-only grant"
    );
    assert_eq!(s.receipt_scope(Some(&g60), Some(&g60)), ReceiptScope::Full);
    assert_eq!(
        s.receipt_scope(Some(&g60), Some(&g50)),
        ReceiptScope::Hidden
    );
    assert_eq!(
        s.receipt_scope(Some(&g60), None),
        ReceiptScope::Hidden,
        "host mutations"
    );
}

#[test]
fn cloud_copy_without_a_keyed_escrow_still_needs_approval() {
    // The CP enrols an escrow and flips cstate to cloud copy, but no user
    // device ever keyed the escrow. Its own grant must stay ineffective.
    let mut s = setup(CState::E2e);
    let to_cc = vec![
        enrol(20, SERVICE_ACCOUNT, DeviceKind::Escrow),
        PolicyOp::CollectionState(CollectionState {
            state: CState::CloudCopy,
            compress: None,
            min_sem_major: None,
        }),
    ];
    s.apply_control(3, &CH, &policy(3, to_cc), &env()).unwrap();
    assert!(!s.devices[&dev(20)].keyed);
    assert!(s.grant_approval_required());
    s.apply_control(
        4,
        &CH,
        &policy(4, vec![grant(50, EDITOR, &[capability::READ], None)]),
        &env(),
    )
    .unwrap();
    let g = B16([50; 16]);
    assert!(s.effective_grant(&g).is_none());
    assert!(s.grant_for_client(&g, &[50; 32]).is_none());
    assert!(!s.grant_allows(&g, capability::READ));
    // Clear folders are still refused while approval is required.
    assert!(
        s.apply_control(
            5,
            &CH,
            &policy(
                5,
                vec![grant(
                    51,
                    EDITOR,
                    &[capability::READ],
                    Some(vec!["a".into()])
                )]
            ),
            &env()
        )
        .is_err()
    );
    // Once a user device keys the escrow, cloud-copy grants need no approval.
    s.apply_control(6, &CH, &key_grant(6, 10, 20, 1), &env())
        .unwrap();
    assert!(!s.grant_approval_required());
    assert!(s.grant_allows(&g, capability::READ));
}

fn recovery_enrol(n: u8, account: Uuid) -> PolicyOp {
    PolicyOp::DeviceEnrol(DeviceEnrol {
        device: dev(n),
        account,
        kind: DeviceKind::Recovery,
        sign_pk: dpk(n),
        kem_pk: dpk(n),
        noise_pk: B32([0; 32]),
        sas_commit: None,
        local_root: None,
    })
}

/// AK1 (private-account-key.md §4): a member account's recovery device keys only
/// that account's own active user devices, only in e2e.
#[test]
fn account_key_grants_only_to_its_own_accounts_user_devices_in_e2e() {
    let mut s = setup(CState::E2e);
    s.apply_control(
        3,
        &CH,
        &policy(
            3,
            vec![
                recovery_enrol(40, OWNER),
                recovery_enrol(41, EDITOR),
                recovery_enrol(42, VIEWER),
                enrol(13, OWNER, DeviceKind::Mobile),
                enrol(14, EDITOR, DeviceKind::Desktop),
                enrol(15, VIEWER, DeviceKind::Cli),
            ],
        ),
        &env(),
    )
    .unwrap();
    // Unkeyed recovery devices grant nothing.
    assert!(
        s.apply_control(4, &CH, &key_grant(4, 41, 14, 1), &env())
            .is_err()
    );
    for (seq, rec) in [(5, 40), (6, 41), (7, 42)] {
        s.apply_control(seq, &CH, &key_grant(seq, 10, rec, 1), &env())
            .unwrap();
    }
    // Cross-account: refused, the owner's included.
    assert!(
        s.apply_control(8, &CH, &key_grant(8, 40, 14, 1), &env())
            .is_err()
    );
    assert!(
        s.apply_control(9, &CH, &key_grant(9, 41, 13, 1), &env())
            .is_err()
    );
    // Never to a recovery (or service) device, even its own account's.
    assert!(
        s.apply_control(10, &CH, &key_grant(10, 41, 42, 1), &env())
            .is_err()
    );
    // Same account, any member role: allowed.
    s.apply_control(11, &CH, &key_grant(11, 41, 14, 1), &env())
        .unwrap();
    // A viewer account's recovery device keys its own devices too (reading needs
    // the key; the recipient is always the same account).
    s.apply_control(12, &CH, &key_grant(12, 42, 15, 1), &env())
        .unwrap();
    s.apply_control(13, &CH, &key_grant(13, 40, 13, 1), &env())
        .unwrap();
    assert!(s.devices[&dev(14)].keyed);
    assert_eq!(s.devices[&dev(14)].delivered_by, Some(dev(41)));
    // A revoked recovery device grants nothing (strict mode).
    s.apply_control(
        14,
        &CH,
        &policy(
            14,
            vec![PolicyOp::DeviceRevoke(DeviceRevoke { device: dev(41) })],
        ),
        &env(),
    )
    .unwrap();
    s.apply_control(
        15,
        &CH,
        &policy(15, vec![enrol(16, EDITOR, DeviceKind::Mobile)]),
        &env(),
    )
    .unwrap();
    assert!(
        s.apply_control(16, &CH, &key_grant(16, 41, 16, 1), &env())
            .is_err()
    );
}

/// Recovery devices never key anything in cloud copy (escrow and hosted do).
#[test]
fn account_key_grants_are_void_in_cloud_copy() {
    let mut s = setup(CState::CloudCopy);
    s.apply_control(
        3,
        &CH,
        &policy(
            3,
            vec![
                recovery_enrol(40, OWNER),
                enrol(13, OWNER, DeviceKind::Mobile),
            ],
        ),
        &env(),
    )
    .unwrap();
    s.apply_control(4, &CH, &key_grant(4, 10, 40, 1), &env())
        .unwrap();
    match s.apply_control(5, &CH, &key_grant(5, 40, 13, 1), &env()) {
        Err(Rejected::Void(v)) => assert_eq!(v.detail, "recovery devices grant keys only in e2e"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn recovery_devices_grant_keys_and_receive_rekeys_only() {
    let mut s = setup(CState::E2e);
    // A recovery device must have an all-zero noise key, and is a member's device.
    let mut bad = recovery_enrol(40, OWNER);
    if let PolicyOp::DeviceEnrol(e) = &mut bad {
        e.noise_pk = dpk(40);
    }
    assert!(
        s.apply_control(3, &CH, &policy(3, vec![bad]), &env())
            .is_err()
    );
    assert!(
        s.apply_control(
            4,
            &CH,
            &policy(4, vec![recovery_enrol(40, SERVICE_ACCOUNT)]),
            &env()
        )
        .is_err()
    );
    s.apply_control(
        5,
        &CH,
        &policy(
            5,
            vec![recovery_enrol(40, OWNER), recovery_enrol(41, EDITOR)],
        ),
        &env(),
    )
    .unwrap();
    s.apply_control(6, &CH, &key_grant(6, 10, 40, 1), &env())
        .unwrap();
    s.apply_control(7, &CH, &key_grant(7, 10, 41, 1), &env())
        .unwrap();
    // Never writes content or approves grants.
    assert!(!s.device_can_write(&dev(40)));
    assert_eq!(
        s.check_entry_header(&entry_item(8, 40, 1), &env())
            .unwrap_err()
            .rule(),
        "V1"
    );
    assert!(
        s.check_base_header(&base_content_item(8, 40, 1), &env())
            .is_err()
    );
    // The owner's recovery device may key a new device; an editor's may not.
    s.apply_control(
        8,
        &CH,
        &policy(8, vec![enrol(13, OWNER, DeviceKind::Mobile)]),
        &env(),
    )
    .unwrap();
    assert!(
        s.apply_control(9, &CH, &key_grant(9, 41, 13, 1), &env())
            .is_err()
    );
    s.apply_control(10, &CH, &key_grant(10, 40, 13, 1), &env())
        .unwrap();
    // It never signs a rekey (AK1); the device it keyed rekeys after a recovery.
    s.apply_control(
        11,
        &CH,
        &policy(
            11,
            vec![PolicyOp::DeviceRevoke(DeviceRevoke { device: dev(10) })],
        ),
        &env(),
    )
    .unwrap();
    assert!(
        s.apply_control(
            12,
            &CH,
            &rekey(12, 40, 1, RekeyReason::Recovery, &[11, 12, 13, 40, 41]),
            &env(),
        )
        .is_err()
    );
    s.apply_control(
        13,
        &CH,
        &rekey(13, 13, 1, RekeyReason::Recovery, &[11, 12, 13, 40, 41]),
        &env(),
    )
    .unwrap();
    assert!(!s.rekey_required);
    // It can't do the initial rekey.
    let mut s = PolicyState::new();
    let ops = vec![
        PolicyOp::Genesis(Genesis {
            owner: OWNER,
            root: key_id(&ROOT),
            state: CState::E2e,
        }),
        PolicyOp::MemberSet(MemberSet {
            account: OWNER,
            role: Role::Owner,
        }),
        recovery_enrol(40, OWNER),
    ];
    s.apply_control(1, &CH, &policy(1, ops), &env()).unwrap();
    assert!(
        s.apply_control(
            2,
            &CH,
            &rekey(2, 40, 0, RekeyReason::Initial, &[40]),
            &env()
        )
        .is_err()
    );
}

#[test]
fn root_handover_needs_owner_consent_and_an_allowed_target() {
    use mdbn_wire::policy::RootHandover;
    const LOCAL: [u8; 32] = [7; 32];
    let base = || {
        let mut s = setup(CState::E2e);
        let mut e = enrol(14, OWNER, DeviceKind::Desktop);
        if let PolicyOp::DeviceEnrol(d) = &mut e {
            d.local_root = Some(B32(LOCAL));
        }
        s.apply_control(3, &CH, &policy(3, vec![e]), &env())
            .unwrap();
        s.apply_control(4, &CH, &key_grant(4, 10, 14, 1), &env())
            .unwrap();
        s
    };
    let handover = |seq: u64, new_root: [u8; 32], owner: u8, signer_key: u8| {
        let mut rh = RootHandover {
            new_root: B32(new_root),
            owner_device: dev(owner),
            move_id: B16([3; 16]),
            consent: B64([0; 64]),
        };
        rh.consent = sign(&dpk(signer_key).0, &rh.consent_digest(&COL, seq).0);
        PolicyOp::RootHandover(rh)
    };
    // No owner consent (signed by another key), a non-owner device, a disallowed target: void.
    assert!(
        base()
            .apply_control(5, &CH, &policy(5, vec![handover(5, LOCAL, 14, 10)]), &env())
            .is_err()
    );
    assert!(
        base()
            .apply_control(5, &CH, &policy(5, vec![handover(5, LOCAL, 11, 11)]), &env())
            .is_err()
    );
    assert!(
        base()
            .apply_control(
                5,
                &CH,
                &policy(5, vec![handover(5, [8; 32], 14, 14)]),
                &env()
            )
            .is_err()
    );
    // Consent bound to the position.
    assert!(
        base()
            .apply_control(6, &CH, &policy(6, vec![handover(5, LOCAL, 14, 14)]), &env())
            .is_err()
    );
    // Valid: to the device's local root. The log is now device-located, so grants
    // need an approval whatever cstate says, and later items sign under the new root.
    let mut s = base();
    s.apply_control(5, &CH, &policy(5, vec![handover(5, LOCAL, 14, 14)]), &env())
        .unwrap();
    assert!(s.device_located());
    assert!(s.grant_approval_required());
    let local_cert = {
        let mut c = CpCert {
            policy_pk: B32(LOCAL),
            not_before: 0,
            not_after: 1000,
            root: key_id(&LOCAL),
            sig: B64([0; 64]),
        };
        c.sig = sign(&LOCAL, &c.signed_digest().unwrap().0);
        c
    };
    let freeze = vec![PolicyOp::Freeze(Freeze {
        frozen: true,
        reason: None,
    })];
    assert!(
        s.apply_control(
            6,
            &CH,
            &policy_with(6, 6, cert(0, 1000, CP), freeze.clone()),
            &env()
        )
        .is_err(),
        "old root no longer in force"
    );
    s.apply_control(7, &CH, &policy_with(7, 7, local_cert, freeze), &env())
        .unwrap();
    assert!(s.frozen);
    // A cp-key-revoke signed by the original CP root stays valid after the handover.
    let kid = key_id(&CP);
    let msg = cbor::encode(&Cbor::Array(vec![kid.to_cbor(), Cbor::int(0)])).unwrap();
    let rs = sign(&ROOT, &h("mdbase/v1/cp-key-revoke", &msg).0);
    let mut lc = CpCert {
        policy_pk: B32(LOCAL),
        not_before: 0,
        not_after: 1000,
        root: key_id(&LOCAL),
        sig: B64([0; 64]),
    };
    lc.sig = sign(&LOCAL, &lc.signed_digest().unwrap().0);
    s.apply_control(
        8,
        &CH,
        &policy_with(
            8,
            8,
            lc,
            vec![PolicyOp::CpKeyRevoke(CpKeyRevoke {
                key_id: kid,
                revoked_from: 0,
                root_sig: rs,
            })],
        ),
        &env(),
    )
    .unwrap();
}

#[test]
fn approval_request_replaces_the_commitment() {
    use mdbn_wire::policy::ApprovalRequest;
    let mut s = setup(CState::E2e);
    s.apply_control(
        3,
        &CH,
        &policy(3, vec![enrol(30, OWNER, DeviceKind::Desktop)]),
        &env(),
    )
    .unwrap();
    assert_eq!(s.devices[&dev(30)].sas_commit, None);
    let req = |d: u8, c: u8| {
        PolicyOp::ApprovalRequest(ApprovalRequest {
            device: dev(d),
            sas_commit: B32([c; 32]),
        })
    };
    s.apply_control(4, &CH, &policy(4, vec![req(30, 7)]), &env())
        .unwrap();
    assert_eq!(s.devices[&dev(30)].sas_commit, Some(B32([7; 32])));
    // A keyed device needs no approval: void.
    assert!(
        s.apply_control(5, &CH, &policy(5, vec![req(10, 8)]), &env())
            .is_err()
    );
    // Survives the persisted encoding.
    let back = PolicyState::from_bytes(&s.to_bytes().unwrap()).unwrap();
    assert_eq!(back.devices[&dev(30)].sas_commit, Some(B32([7; 32])));
}

impl PolicyState {
    /// V6 as written by the editor's own device (dev 11).
    fn check_entry_payload_by(&self, p: &EntryPayload, ctx: &OpContext<'_>) -> Verdict {
        self.check_entry_payload(p, &dev(11), ctx)
    }
}

/// An `on_behalf` entry is valid only from a device of the grant's account,
/// or from the hosted replica in `cloud-copy`.
#[test]
fn on_behalf_is_bound_to_the_grant_account() {
    let (pk, fp) = ctx_none();
    let ctx = OpContext {
        path_key: &pk,
        file_path: &fp,
    };
    let mut s = setup(CState::CloudCopy);
    let g = B16([50; 16]);
    s.apply_control(
        3,
        &CH,
        &policy(3, vec![grant(50, EDITOR, &[capability::CREATE], None)]),
        &env(),
    )
    .unwrap();
    let p = payload(Some(g), vec![create_op()], 1);
    assert!(
        s.check_entry_payload(&p, &dev(11), &ctx).is_ok(),
        "the grant owner's device"
    );
    assert_eq!(
        s.check_entry_payload(&p, &dev(10), &ctx)
            .unwrap_err()
            .rule(),
        "V6",
        "another member's device"
    );
    assert!(
        s.check_entry_payload(&p, &dev(21), &ctx).is_ok(),
        "hosted in cloud copy"
    );
    assert_eq!(
        s.check_entry_payload(&p, &dev(20), &ctx)
            .unwrap_err()
            .rule(),
        "V6",
        "the escrow is not the hosted replica"
    );
    assert_eq!(
        s.check_entry_payload(&p, &dev(99), &ctx)
            .unwrap_err()
            .rule(),
        "V6",
        "unknown device"
    );
    // A revoked device of the grant's account: void.
    s.apply_control(
        4,
        &CH,
        &policy(4, vec![enrol(13, EDITOR, DeviceKind::Desktop)]),
        &env(),
    )
    .unwrap();
    assert!(s.check_entry_payload(&p, &dev(13), &ctx).is_ok());
    let mut revoked = s.clone();
    revoked
        .apply_control(
            5,
            &CH,
            &policy(
                5,
                vec![PolicyOp::DeviceRevoke(DeviceRevoke { device: dev(13) })],
            ),
            &env(),
        )
        .unwrap();
    assert_eq!(
        revoked
            .check_entry_payload(&p, &dev(13), &ctx)
            .unwrap_err()
            .rule(),
        "V6",
        "a revoked device of the grant's account"
    );
    // The same hosted device once the collection is private: void.
    let mut private = s.clone();
    private.cstate = Some(CState::E2e);
    assert_eq!(
        private
            .check_entry_payload(&p, &dev(21), &ctx)
            .unwrap_err()
            .rule(),
        "V6",
        "hosted in a private collection"
    );
    // Entries without on_behalf are unaffected.
    assert!(
        s.check_entry_payload(&payload(None, vec![create_op()], 1), &dev(10), &ctx)
            .is_ok()
    );
}

#[test]
fn on_behalf_signer_contract_vector() {
    let vector: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../conformance/policy/on-behalf-signer.json"
    ))
    .unwrap();
    let account_a = B16([0xA3; 16]);
    let account = |name: &str| match name {
        "A" => account_a,
        "B" => EDITOR,
        "service" => SERVICE_ACCOUNT,
        _ => panic!("unknown fixture account: {name}"),
    };
    let device = |name: &str| match name {
        "a1" => 14,
        "b1" => 11,
        "b2" => 13,
        "hosted" => 21,
        "escrow" => 20,
        "unknown" => 99,
        _ => panic!("unknown fixture device: {name}"),
    };
    assert_eq!(
        vector["members"],
        serde_json::json!({"A":"editor", "B":"editor"})
    );
    assert_eq!(vector["grant"]["account"], "B");
    assert_eq!(
        vector["grant"]["capabilities"],
        serde_json::json!([capability::CREATE])
    );
    let mut cloud = setup(CState::CloudCopy);
    cloud
        .apply_control(
            3,
            &CH,
            &policy(
                3,
                vec![
                    PolicyOp::MemberSet(MemberSet {
                        account: account_a,
                        role: Role::Editor,
                    }),
                    enrol(14, account_a, DeviceKind::Desktop),
                    enrol(13, EDITOR, DeviceKind::Desktop),
                    grant(50, EDITOR, &[capability::CREATE], None),
                ],
            ),
            &env(),
        )
        .unwrap();
    cloud
        .apply_control(4, &CH, &key_grant(4, 10, 14, 1), &env())
        .unwrap();
    cloud
        .apply_control(
            5,
            &CH,
            &policy(
                5,
                vec![PolicyOp::DeviceRevoke(DeviceRevoke { device: dev(13) })],
            ),
            &env(),
        )
        .unwrap();
    cloud
        .apply_control(
            6,
            &CH,
            &rekey(
                6,
                10,
                1,
                RekeyReason::DeviceRevoked,
                &[10, 11, 12, 14, 20, 21],
            ),
            &env(),
        )
        .unwrap();
    let devices = vector["devices"].as_object().unwrap();
    assert_eq!(devices.len(), 5);
    for (name, definition) in devices {
        let d = &cloud.devices[&dev(device(name))];
        assert_eq!(d.account, account(definition["account"].as_str().unwrap()));
        let kind = match definition["kind"].as_str().unwrap() {
            "desktop" => DeviceKind::Desktop,
            "mobile" => DeviceKind::Mobile,
            "hosted" => DeviceKind::Hosted,
            "escrow" => DeviceKind::Escrow,
            other => panic!("unknown fixture device kind: {other}"),
        };
        assert_eq!(d.kind, kind);
        assert_eq!(d.active, !definition["revoked"].as_bool().unwrap_or(false));
    }
    // Isolate the payload predicate, including a formerly hosted signer in e2e.
    // This is not a valid state-transition/header fixture. Approval must still
    // be real so that a V6 refusal cannot be caused by a missing effective grant.
    let mut private = cloud.clone();
    private.cstate = Some(CState::E2e);
    approve(&mut private, 7, 11, 50, &[capability::CREATE], None).unwrap();
    let g = B16([50; 16]);
    assert!(private.grant_approval_required());
    assert!(private.grant_allows(&g, capability::CREATE));
    assert!(cloud.grant_allows(&g, capability::CREATE));
    let (pk, fp) = ctx_none();
    let ctx = OpContext {
        path_key: &pk,
        file_path: &fp,
    };
    let cases = vector["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 9);
    assert_eq!(vector["void_rule"], "V6");
    for case in cases {
        let state = match case["state"].as_str().unwrap() {
            "e2e" => &private,
            "cloud-copy" => &cloud,
            other => panic!("unknown fixture state: {other}"),
        };
        let on_behalf = case["on_behalf"].as_bool().unwrap().then_some(g);
        let p = payload(on_behalf, vec![create_op()], 1);
        let result =
            state.check_entry_payload(&p, &dev(device(case["signer"].as_str().unwrap())), &ctx);
        if case["valid"].as_bool().unwrap() {
            assert!(result.is_ok(), "{case}: {result:?}");
        } else {
            assert_eq!(result.unwrap_err().rule(), "V6", "{case}");
        }
    }
}

/// A service-created cloud copy: genesis enrols only the escrow
/// (20) and hosted (21) for the owner account; no user device. Not yet keyed.
fn service_created() -> PolicyState {
    let mut s = PolicyState::new();
    s.apply_control(
        1,
        &CH,
        &policy(
            1,
            vec![
                PolicyOp::Genesis(Genesis {
                    owner: OWNER,
                    root: key_id(&ROOT),
                    state: CState::CloudCopy,
                }),
                PolicyOp::MemberSet(MemberSet {
                    account: OWNER,
                    role: Role::Owner,
                }),
                enrol(20, SERVICE_ACCOUNT, DeviceKind::Escrow),
                enrol(21, SERVICE_ACCOUNT, DeviceKind::Hosted),
            ],
        ),
        &env(),
    )
    .unwrap();
    s
}

fn hosted_key_grant(seq: u64, to: u8, wrap_for: u8, epoch: u64) -> Item {
    let p = KeyGrantPayload {
        recipient: dev(to),
        epoch,
        wrap: wraps(&[wrap_for]).remove(0),
    };
    signed(
        base_item(ItemKind::KeyGrant, seq, dev(21), p.to_bytes().unwrap()),
        &dpk(21).0,
    )
}

#[test]
fn hosted_is_a_service_created_cloud_copys_first_member() {
    let e = env();
    // The initial rekey by hosted must include hosted itself and the escrow.
    assert!(
        service_created()
            .apply_control(2, &CH, &rekey(2, 21, 0, RekeyReason::Initial, &[21]), &e)
            .is_err()
    );
    assert!(
        service_created()
            .apply_control(2, &CH, &rekey(2, 21, 0, RekeyReason::Initial, &[20]), &e)
            .is_err()
    );
    let mut s = service_created();
    s.apply_control(
        2,
        &CH,
        &rekey(2, 21, 0, RekeyReason::Initial, &[21, 20]),
        &e,
    )
    .unwrap();
    assert_eq!(s.epoch, 1);
    assert!(s.devices[&dev(21)].keyed && s.devices[&dev(20)].keyed);
    // Escrow is keyed by a service, so grants follow the grant op (cloud copy).
    assert!(!s.grant_approval_required());
}

#[test]
fn hosted_keys_control_approved_account_devices_in_cloud_copy() {
    let e = env();
    let mut s = service_created();
    s.apply_control(
        2,
        &CH,
        &rekey(2, 21, 0, RekeyReason::Initial, &[21, 20]),
        &e,
    )
    .unwrap();
    s.apply_control(
        3,
        &CH,
        &policy(
            3,
            vec![
                PolicyOp::MemberSet(MemberSet {
                    account: EDITOR,
                    role: Role::Editor,
                }),
                enrol(30, OWNER, DeviceKind::Desktop),
                enrol(31, EDITOR, DeviceKind::Mobile),
            ],
        ),
        &e,
    )
    .unwrap();
    // Unapproved (never enrolled) device: void.
    assert!(
        s.apply_control(4, &CH, &hosted_key_grant(4, 40, 40, 1), &e)
            .is_err()
    );
    // Wrong recipient: the wrap is for another device; a service device.
    assert!(
        s.apply_control(4, &CH, &hosted_key_grant(4, 30, 31, 1), &e)
            .is_err()
    );
    assert!(
        s.apply_control(4, &CH, &hosted_key_grant(4, 20, 20, 1), &e)
            .is_err()
    );
    // Stale epoch.
    assert!(
        s.apply_control(4, &CH, &hosted_key_grant(4, 30, 30, 0), &e)
            .is_err()
    );
    assert!(
        s.apply_control(4, &CH, &hosted_key_grant(4, 30, 30, 2), &e)
            .is_err()
    );
    // The approved account device: keyed, delivered by hosted.
    s.apply_control(4, &CH, &hosted_key_grant(4, 30, 30, 1), &e)
        .unwrap();
    assert!(s.devices[&dev(30)].keyed);
    assert_eq!(s.devices[&dev(30)].delivered_by, Some(dev(21)));
    // Escrow may key one too (hosted unavailable).
    s.apply_control(5, &CH, &key_grant(5, 20, 31, 1), &e)
        .unwrap();
    assert!(s.devices[&dev(31)].keyed);
    // A revoked device is no longer a recipient; after a rekey the old epoch is stale.
    s.apply_control(
        6,
        &CH,
        &policy(
            6,
            vec![
                enrol(32, OWNER, DeviceKind::Desktop),
                PolicyOp::DeviceRevoke(DeviceRevoke { device: dev(32) }),
            ],
        ),
        &e,
    )
    .unwrap();
    assert!(
        s.apply_control(7, &CH, &hosted_key_grant(7, 32, 32, 1), &e)
            .is_err()
    );
    s.apply_control(
        7,
        &CH,
        &rekey(7, 21, 1, RekeyReason::DeviceRevoked, &[20, 21, 30, 31]),
        &e,
    )
    .unwrap();
    s.apply_control(
        8,
        &CH,
        &policy(8, vec![enrol(33, OWNER, DeviceKind::Desktop)]),
        &e,
    )
    .unwrap();
    assert!(
        s.apply_control(9, &CH, &hosted_key_grant(9, 33, 33, 1), &e)
            .is_err()
    );
    s.apply_control(9, &CH, &hosted_key_grant(9, 33, 33, 2), &e)
        .unwrap();
}

/// Private (e2e) collections stay strict: none of the service keying exists there.
#[test]
fn private_collections_reject_every_service_keying_path() {
    let e = env();
    // No service device can even be enrolled in e2e.
    let mut s = PolicyState::new();
    assert!(
        s.apply_control(
            1,
            &CH,
            &policy(
                1,
                vec![
                    PolicyOp::Genesis(Genesis {
                        owner: OWNER,
                        root: key_id(&ROOT),
                        state: CState::E2e,
                    }),
                    PolicyOp::MemberSet(MemberSet {
                        account: OWNER,
                        role: Role::Owner,
                    }),
                    enrol(21, SERVICE_ACCOUNT, DeviceKind::Hosted),
                ],
            ),
            &e,
        )
        .is_err()
    );
    // The rules themselves are gated on the mode, not only on enrolment: with the
    // state forced to e2e, hosted may neither do the initial rekey nor grant keys,
    // and escrow may not grant keys.
    let mut s = service_created();
    s.cstate = Some(CState::E2e);
    assert!(
        s.apply_control(
            2,
            &CH,
            &rekey(2, 21, 0, RekeyReason::Initial, &[21, 20]),
            &e
        )
        .is_err()
    );
    let mut s = service_created();
    s.apply_control(
        2,
        &CH,
        &rekey(2, 21, 0, RekeyReason::Initial, &[21, 20]),
        &e,
    )
    .unwrap();
    s.apply_control(
        3,
        &CH,
        &policy(3, vec![enrol(30, OWNER, DeviceKind::Desktop)]),
        &e,
    )
    .unwrap();
    s.cstate = Some(CState::E2e);
    assert!(
        s.apply_control(4, &CH, &hosted_key_grant(4, 30, 30, 1), &e)
            .is_err()
    );
    assert!(
        s.apply_control(4, &CH, &key_grant(4, 20, 30, 1), &e)
            .is_err()
    );
    assert!(!s.devices[&dev(30)].keyed);
    // Cloud copy turned off: hosted and escrow are revoked and can key nothing.
    let mut s = setup(CState::CloudCopy);
    s.apply_control(
        3,
        &CH,
        &policy(
            3,
            vec![
                PolicyOp::DeviceRevoke(DeviceRevoke { device: dev(21) }),
                PolicyOp::DeviceRevoke(DeviceRevoke { device: dev(20) }),
                PolicyOp::CollectionState(CollectionState {
                    state: CState::E2e,
                    compress: None,
                    min_sem_major: None,
                }),
                enrol(14, EDITOR, DeviceKind::Mobile),
            ],
        ),
        &e,
    )
    .unwrap();
    assert!(
        s.apply_control(4, &CH, &key_grant(4, 21, 14, 1), &e)
            .is_err()
    );
}

/// Every key control in e2e excludes services, whether
/// signer or recipient, initial or not; service grants in cloud copy are scoped to
/// approved account devices for escrow too; a hosted `base` is a cloud-copy
/// hosted import only.
#[test]
fn private_mode_excludes_services_from_every_key_control_and_service_scopes() {
    let e = env();
    // Cloud copy, keyed by the owner's desktop: 10 (owner), 11, 12, 20 (escrow), 21 (hosted).
    let mut s = setup(CState::CloudCopy);
    // Forced e2e with service rows still present (history is kept): a keyed hosted
    // or escrow signer, or a service recipient, voids any rekey and any grant.
    let mut p = s.clone();
    p.cstate = Some(CState::E2e);
    let p = p;
    for item in [
        rekey(3, 21, 1, RekeyReason::Scheduled, &[10, 11, 12, 20, 21]),
        rekey(3, 20, 1, RekeyReason::Scheduled, &[10, 11, 12, 20, 21]),
        rekey(3, 10, 1, RekeyReason::Scheduled, &[10, 11, 12, 20, 21]),
    ] {
        assert!(p.clone().apply_control(3, &CH, &item, &e).is_err());
    }
    let mut q = s.clone();
    q.cstate = Some(CState::E2e);
    q.devices.get_mut(&dev(21)).unwrap().keyed = false;
    assert!(
        q.apply_control(3, &CH, &key_grant(3, 10, 21, 1), &e)
            .is_err(),
        "an editor may not key hosted in e2e"
    );
    // Cloud copy: escrow grants only to an approved account device, like hosted.
    s.devices.get_mut(&dev(21)).unwrap().keyed = false;
    assert!(
        s.clone()
            .apply_control(3, &CH, &key_grant(3, 20, 21, 1), &e)
            .is_err()
    );
    // An owner desktop may still key hosted in cloud copy (private -> cloud copy).
    s.apply_control(3, &CH, &key_grant(3, 10, 21, 1), &e)
        .unwrap();
    // Base: hosted signs only a hosted import, in cloud copy.
    let hosted_base = base_content_item(4, 21, 1);
    assert!(s.check_base_header(&hosted_base, &e).is_ok());
    assert!(
        s.check_base_source(&hosted_base, mdbn_wire::snapshot::BaseSource::HostedImport)
            .is_ok()
    );
    assert!(
        s.check_base_source(&hosted_base, mdbn_wire::snapshot::BaseSource::Folder)
            .is_err()
    );
    let mut t = s.clone();
    t.cstate = Some(CState::E2e);
    assert!(t.check_base_header(&hosted_base, &e).is_err());
    assert!(
        t.check_base_source(&hosted_base, mdbn_wire::snapshot::BaseSource::HostedImport)
            .is_err()
    );
}
fn pins(root: [u8; 32], key: [u8; 32], key_root: [u8; 32]) -> PolicyPins {
    PolicyPins {
        roots: vec![RootPin {
            root_id: key_id(&root),
            root_pk: B32(root),
        }],
        policy_keys: vec![PolicyKeyPin {
            key_id: key_id(&key),
            policy_pk: B32(key),
            root_id: key_id(&key_root),
        }],
    }
}

fn genesis_item() -> Item {
    policy(
        1,
        vec![
            PolicyOp::Genesis(Genesis {
                owner: OWNER,
                root: key_id(&ROOT),
                state: CState::E2e,
            }),
            PolicyOp::MemberSet(MemberSet {
                account: OWNER,
                role: Role::Owner,
            }),
        ],
    )
}

/// With published pins, a policy item is valid only when its certificate is by the
/// pinned root for a pinned policy key; anything else is void, at genesis and after.
#[test]
fn policy_pins_admit_only_published_keys() {
    let with = |p: &PolicyPins, item: &Item, s: &mut PolicyState, seq: u64| {
        let e = Env {
            verifier: &Fake,
            trusted_roots: &[ROOT],
            policy_pins: Some(p),
        };
        s.apply_control(seq, &CH, item, &e)
    };
    let good = pins(ROOT, CP, ROOT);
    let mut s = PolicyState::new();
    with(&good, &genesis_item(), &mut s, 1).unwrap();
    with(
        &good,
        &policy(2, vec![enrol(10, OWNER, DeviceKind::Desktop)]),
        &mut s,
        2,
    )
    .unwrap();
    // A later item under another (root-certified) policy key: void.
    let other = policy_with(
        3,
        3,
        cert(0, 1000, [3; 32]),
        vec![enrol(11, OWNER, DeviceKind::Desktop)],
    );
    assert_eq!(
        with(&good, &other, &mut s, 3).unwrap_err().rule(),
        "cp-cert"
    );
    assert!(s.consistent_with(&good));
    // The same key pinned only under another root: not this store's attribution
    // even with this store's root still pinned.
    let mut moved = good.clone();
    moved.roots.push(RootPin {
        root_id: key_id(&[7; 32]),
        root_pk: B32([7; 32]),
    });
    moved.policy_keys[0].root_id = key_id(&[7; 32]);
    assert!(!s.consistent_with(&moved));
    // A handover with attribution recorded: consistent exactly when every
    // (key, certifying root) pair is published.
    let mut handed = s.clone();
    handed.cp_roots.insert(B32([7; 32]));
    let mut both = good.clone();
    both.roots.push(RootPin {
        root_id: key_id(&[7; 32]),
        root_pk: B32([7; 32]),
    });
    assert!(handed.consistent_with(&both), "attributed via the witness");
    assert!(
        !handed.consistent_with(&good),
        "a root in force that is not pinned"
    );
    // Local-root round trip: the same key K was also certified by a
    // local root L (R1 -> L -> R1). K is pinned only under R1, so the (K, L) pair
    // in the witness is unpublished: refused.
    let mut local = s.clone();
    local
        .cert_roots
        .as_mut()
        .unwrap()
        .insert((key_id(&CP), key_id(&[8; 32])));
    assert!(!local.consistent_with(&good));
    // A state persisted before the witness existed is unproven: refused.
    let mut legacy = s.clone();
    legacy.cert_roots = None;
    assert!(!legacy.consistent_with(&good));
    let round = PolicyState::from_bytes(&s.to_bytes().unwrap()).unwrap();
    assert_eq!(round, s, "the witness persists");

    for bad in [
        pins(ROOT, [3; 32], ROOT),  // the signing key is not pinned
        pins([5; 32], CP, [5; 32]), // another root
        pins(ROOT, CP, [5; 32]),    // the key pinned under another root
        PolicyPins {
            roots: vec![RootPin {
                root_id: key_id(&ROOT),
                root_pk: B32([6; 32]),
            }],
            ..pins(ROOT, CP, ROOT)
        }, // the root ID with another key
    ] {
        let mut s = PolicyState::new();
        assert_eq!(
            with(&bad, &genesis_item(), &mut s, 1).unwrap_err().rule(),
            "cp-cert",
            "{bad:?}"
        );
        assert!(s.root.is_none() && s.voids == 1, "void: nothing applied");
    }
    // Without pins, today's behaviour.
    let mut s = PolicyState::new();
    s.apply_control(1, &CH, &other_genesis_with([3; 32]), &env())
        .unwrap();
    assert!(
        !s.consistent_with(&good),
        "built under an unpinned policy key"
    );
    assert!(
        PolicyState::new().consistent_with(&good),
        "an empty store is consistent"
    );
}

/// A pinned replica follows a legitimate root handover to the
/// owner device's local root (checked under the pinned root) and still reopens;
/// the local root certifies its own keys, which are not published pins.
#[test]
fn policy_pins_follow_a_root_handover_to_a_local_root() {
    use mdbn_wire::policy::RootHandover;
    const LOCAL: [u8; 32] = [7; 32];
    let good = pins(ROOT, CP, ROOT);
    let pinned = Env {
        verifier: &Fake,
        trusted_roots: &[ROOT],
        policy_pins: Some(&good),
    };
    let mut s = setup(CState::E2e);
    assert!(s.consistent_with(&good));
    let mut e = enrol(14, OWNER, DeviceKind::Desktop);
    if let PolicyOp::DeviceEnrol(d) = &mut e {
        d.local_root = Some(B32(LOCAL));
    }
    s.apply_control(3, &CH, &policy(3, vec![e]), &pinned)
        .unwrap();
    s.apply_control(4, &CH, &key_grant(4, 10, 14, 1), &pinned)
        .unwrap();
    let mut rh = RootHandover {
        new_root: B32(LOCAL),
        owner_device: dev(14),
        move_id: B16([3; 16]),
        consent: B64([0; 64]),
    };
    rh.consent = sign(&dpk(14).0, &rh.consent_digest(&COL, 5).0);
    s.apply_control(
        5,
        &CH,
        &policy(5, vec![PolicyOp::RootHandover(rh)]),
        &pinned,
    )
    .unwrap();
    assert!(s.device_located());
    let handed_over = s.clone();
    let local_cert = |key: [u8; 32]| {
        let mut c = CpCert {
            policy_pk: B32(key),
            not_before: 0,
            not_after: 1000,
            root: key_id(&LOCAL),
            sig: B64([0; 64]),
        };
        c.sig = sign(&LOCAL, &c.signed_digest().unwrap().0);
        c
    };
    let freeze = |frozen| {
        vec![PolicyOp::Freeze(Freeze {
            frozen,
            reason: None,
        })]
    };
    s.apply_control(
        6,
        &CH,
        &policy_with(6, 6, local_cert(LOCAL), freeze(true)),
        &pinned,
    )
    .unwrap();
    assert!(s.frozen, "an item under the local root applies under pins");
    assert!(
        s.consistent_with(&good),
        "the handed-over state reopens under the pins"
    );
    let round = PolicyState::from_bytes(&s.to_bytes().unwrap()).unwrap();
    assert!(round.consistent_with(&good));
    // The control plane's key no longer signs; its pin does not bring it back.
    assert!(
        s.apply_control(
            7,
            &CH,
            &policy_with(7, 7, cert(0, 1000, CP), freeze(false)),
            &pinned
        )
        .is_err()
    );
    // A root that is no enrolled device's local root still needs a pin.
    let mut forged = s.clone();
    forged.root_pk = Some(B32([8; 32]));
    forged.root = Some(key_id(&[8; 32]));
    assert!(!forged.consistent_with(&good));
    // The local key under another root ID (a persisted state whose ID and key
    // disagree) is not the local root in force.
    let mut wrong_id = s.clone();
    wrong_id.root = Some(key_id(&[8; 32]));
    assert!(!wrong_id.consistent_with(&good));
    // Same, right after the handover (history holds only pinned CP certificates).
    let mut fresh = handed_over;
    assert!(fresh.consistent_with(&good));
    fresh.root = Some(key_id(&ROOT));
    assert!(!fresh.consistent_with(&good));
    // A control-plane root that is not pinned: refused even with a device whose
    // local root it is not.
    let mut cp_unpinned = s.clone();
    cp_unpinned.root_pk = Some(B32([6; 32]));
    cp_unpinned.root = Some(key_id(&[6; 32]));
    cp_unpinned.cp_roots.insert(B32([6; 32]));
    assert!(!cp_unpinned.consistent_with(&good));
    // A REAL later handover back to the pinned control-plane root
    // (owner consent, applied under the local root). The local root is no longer
    // in force, so items under it are void from now on, but the items it
    // certified while in force stay attributed: the state still reopens under the
    // pins (it used to be refused on every warm reopen).
    let mut back = s.clone();
    let mut rh = RootHandover {
        new_root: B32(ROOT),
        owner_device: dev(14),
        move_id: B16([4; 16]),
        consent: B64([0; 64]),
    };
    rh.consent = sign(&dpk(14).0, &rh.consent_digest(&COL, 7).0);
    back.apply_control(
        7,
        &CH,
        &policy_with(7, 7, local_cert(LOCAL), vec![PolicyOp::RootHandover(rh)]),
        &pinned,
    )
    .unwrap();
    assert_eq!(back.root, Some(key_id(&ROOT)));
    assert!(!back.device_located());
    assert!(
        back.consistent_with(&good),
        "R -> L -> R: the warm reopen accepts the verified local history"
    );
    let round = PolicyState::from_bytes(&back.to_bytes().unwrap()).unwrap();
    assert!(round.consistent_with(&good));
    assert!(
        back.clone()
            .apply_control(
                8,
                &CH,
                &policy_with(8, 8, local_cert(LOCAL), freeze(false)),
                &pinned
            )
            .is_err(),
        "the local root certifies nothing once a pinned root is in force"
    );
    // The pinned control plane signs again.
    back.apply_control(
        8,
        &CH,
        &policy_with(8, 8, cert(0, 1000, CP), freeze(false)),
        &pinned,
    )
    .unwrap();
    assert!(!back.frozen);
    assert!(back.consistent_with(&good));
    // The handover is recorded (persisted), and only it attributes.
    assert_eq!(
        back.handover_roots,
        BTreeSet::from([key_id(&LOCAL)]),
        "the verified handover root"
    );
    // A root that is an ENROLLED device's local_root but was
    // never handed over to attributes nothing.
    let mut enrolled_only = back.clone();
    let mut e = enrol(15, OWNER, DeviceKind::Desktop);
    if let PolicyOp::DeviceEnrol(d) = &mut e {
        d.local_root = Some(B32([5; 32]));
    }
    enrolled_only
        .apply_control(
            9,
            &CH,
            &policy_with(9, 9, cert(0, 1000, CP), vec![e]),
            &pinned,
        )
        .unwrap();
    assert!(enrolled_only.consistent_with(&good));
    enrolled_only
        .cert_roots
        .as_mut()
        .unwrap()
        .insert((key_id(&[5; 32]), key_id(&[5; 32])));
    assert!(
        !enrolled_only.consistent_with(&good),
        "enrolment of a local root is not a handover"
    );
    // A format-2 state (no handover roots recorded) after R -> L -> R is still
    // refused warm; a cold rebuild replays the handover and records it.
    let mut v2_state = back.clone();
    v2_state.handover_roots.clear();
    assert!(!v2_state.consistent_with(&good));
    // Still refused: a pair certified by a root that is no enrolled device's
    // local root (never handed over to), and a root in force that is unpinned.
    let mut forged_pair = back.clone();
    forged_pair
        .cert_roots
        .as_mut()
        .unwrap()
        .insert((key_id(&[9; 32]), key_id(&[8; 32])));
    assert!(!forged_pair.consistent_with(&good));
    let mut unpinned = back.clone();
    unpinned.root_pk = Some(B32([6; 32]));
    unpinned.root = Some(key_id(&[6; 32]));
    assert!(!unpinned.consistent_with(&good));
}

/// In a cloud copy, an owner-account device the
/// control plane enrolled (its sign key, its local root) and escrow keyed must
/// not hand the log to its local root (pins would no longer apply); an owner
/// device keyed by a user's device still may. E2E is unaffected (no service
/// devices there).
#[test]
fn cloud_copy_local_handover_needs_a_user_vouched_owner_device() {
    use mdbn_wire::policy::RootHandover;
    const LOCAL: [u8; 32] = [7; 32];
    let good = pins(ROOT, CP, ROOT);
    let pinned = Env {
        verifier: &Fake,
        trusted_roots: &[ROOT],
        policy_pins: Some(&good),
    };
    let handover = |s: &mut PolicyState, seq: u64, owner: u8| {
        let mut rh = RootHandover {
            new_root: B32(LOCAL),
            owner_device: dev(owner),
            move_id: B16([3; 16]),
            consent: B64([0; 64]),
        };
        rh.consent = sign(&dpk(owner).0, &rh.consent_digest(&COL, seq).0);
        s.apply_control(
            seq,
            &CH,
            &policy(seq, vec![PolicyOp::RootHandover(rh)]),
            &pinned,
        )
    };
    let with_local = |n: u8| {
        let mut e = enrol(n, OWNER, DeviceKind::Desktop);
        if let PolicyOp::DeviceEnrol(d) = &mut e {
            d.local_root = Some(B32(LOCAL));
        }
        e
    };
    // The attack: CP enrols owner device 14 with its local root; escrow 20 keys it.
    let mut s = setup(CState::CloudCopy);
    s.apply_control(3, &CH, &policy(3, vec![with_local(14)]), &pinned)
        .unwrap();
    s.apply_control(4, &CH, &key_grant(4, 20, 14, 1), &pinned)
        .unwrap();
    let e = handover(&mut s, 5, 14).unwrap_err();
    assert_eq!(e.rule(), "root-handover");
    assert_eq!(
        s.root,
        Some(key_id(&ROOT)),
        "the pinned root stays in force"
    );
    assert!(!s.device_located());
    // Keyed by a device keyed by escrow: still through a service device.
    let mut s = setup(CState::CloudCopy);
    s.apply_control(
        3,
        &CH,
        &policy(
            3,
            vec![enrol(13, OWNER, DeviceKind::Desktop), with_local(14)],
        ),
        &pinned,
    )
    .unwrap();
    s.apply_control(4, &CH, &key_grant(4, 20, 13, 1), &pinned)
        .unwrap();
    s.apply_control(5, &CH, &key_grant(5, 13, 14, 1), &pinned)
        .unwrap();
    assert!(handover(&mut s, 6, 14).is_err());
    // An owner device the user's own device (10) keyed may.
    let mut s = setup(CState::CloudCopy);
    s.apply_control(3, &CH, &policy(3, vec![with_local(14)]), &pinned)
        .unwrap();
    s.apply_control(4, &CH, &key_grant(4, 10, 14, 1), &pinned)
        .unwrap();
    let user_vouched = s.clone();
    handover(&mut s, 5, 14).unwrap();
    assert!(s.device_located());
    // Fail closed on an unprovable chain: a missing link ...
    let mut missing = user_vouched.clone();
    missing.devices.get_mut(&dev(14)).unwrap().introduced_by = None;
    assert!(
        handover(&mut missing, 5, 14).is_err(),
        "missing introduced_by"
    );
    // ... a link to an unknown device ...
    let mut unknown = user_vouched.clone();
    unknown.devices.get_mut(&dev(14)).unwrap().introduced_by = Some(dev(99));
    assert!(handover(&mut unknown, 5, 14).is_err(), "unknown introducer");
    // ... and a cycle that never reaches a self-introduced device.
    let mut cycle = user_vouched.clone();
    cycle.devices.get_mut(&dev(14)).unwrap().introduced_by = Some(dev(10));
    cycle.devices.get_mut(&dev(10)).unwrap().introduced_by = Some(dev(14));
    assert!(handover(&mut cycle, 5, 14).is_err(), "introducer cycle");
    // The creator's own chain (self-introduced by the initial rekey) is the proof.
    assert_eq!(
        user_vouched.devices[&dev(10)].introduced_by,
        Some(dev(10)),
        "the creator is self-introduced"
    );
}

fn other_genesis_with(key: [u8; 32]) -> Item {
    let g = genesis_item();
    let p = PolicyPayload::from_bytes(&g.body.0).unwrap();
    policy_with(1, 1, cert(0, 1000, key), p.ops)
}

/// Pins are well-formed: derived IDs, strong keys, certified by a pinned root.
#[test]
fn policy_pins_validate_keys_and_ids() {
    use crate::crypto::sign::DeviceSigner;
    let root = DeviceSigner::from_seed(&[0x11; 32]).public();
    let key = DeviceSigner::from_seed(&[0x22; 32]).public();
    assert_eq!(pins(root, key, root).validate(), Ok(()));
    let mut identity = [0u8; 32];
    identity[0] = 1; // the identity point: small order
    let mut non_canonical = [0xffu8; 32];
    non_canonical[31] = 0x7f; // y >= p
    let cases = [
        pins(identity, key, identity),
        pins(root, identity, root),
        pins(non_canonical, key, non_canonical),
        pins(root, key, key),
        PolicyPins {
            roots: vec![],
            ..pins(root, key, root)
        },
        PolicyPins {
            policy_keys: vec![],
            ..pins(root, key, root)
        },
        PolicyPins {
            roots: vec![RootPin {
                root_id: key_id(&key),
                root_pk: B32(root),
            }],
            ..pins(root, key, root)
        },
        {
            let mut p = pins(root, key, root);
            p.policy_keys.push(p.policy_keys[0].clone());
            p
        },
    ];
    for p in cases {
        assert!(p.validate().is_err(), "{p:?}");
    }
}

/// The persisted policy state is format 2 (with the cert-root witness). Format 1
/// still reads, as unproven, and is rewritten as format 2; a reader that predates
/// format 2 refuses it as an unknown format; unknown shapes are refused.
#[test]
fn policy_state_format_2_upgrades_format_1_and_old_readers_refuse() {
    use mdbn_wire::cbor::{decode, encode};
    let s = setup(CState::E2e);
    assert!(s.seq > 0 && s.cert_roots.as_ref().is_some_and(|w| !w.is_empty()));
    let v3 = s.to_bytes().unwrap();
    let Cbor::Array(a3) = decode(&v3).unwrap() else {
        panic!("array")
    };
    assert_eq!((a3.len(), &a3[0]), (26, &Cbor::Uint(POLICY_STATE_FORMAT)));
    assert_eq!(POLICY_STATE_FORMAT, 3);
    // Format 2 (25 elements, no handover roots): read with none recorded.
    let mut a2 = a3.clone();
    a2[0] = Cbor::Uint(2);
    a2.truncate(25);
    let v2 = encode(&Cbor::Array(a2.clone())).unwrap();
    assert_eq!(PolicyState::from_bytes(&v2).unwrap(), s);
    assert_eq!(
        PolicyState::from_bytes(&v2).unwrap().to_bytes().unwrap(),
        v3
    );

    // The reader before format 2 accepted exactly `[1, ..24 elements]`.
    let old_reader_accepts = |b: &[u8]| matches!(decode(b), Ok(Cbor::Array(a)) if a.len() == 24 && a[0] == Cbor::Uint(1));
    assert!(!old_reader_accepts(&v2), "an old reader refuses format 2");

    // Format 1 (24 elements): read as unproven, everything else intact.
    let mut a1 = a2.clone();
    a1[0] = Cbor::Uint(1);
    a1.truncate(24);
    let v1 = encode(&Cbor::Array(a1)).unwrap();
    assert!(old_reader_accepts(&v1));
    let up = PolicyState::from_bytes(&v1).unwrap();
    assert_eq!(up.cert_roots, None, "format 1 has no witness: unproven");
    assert_eq!(
        PolicyState {
            cert_roots: s.cert_roots.clone(),
            ..up.clone()
        },
        s
    );
    let pinned = pins(ROOT, CP, ROOT);
    assert!(s.consistent_with(&pinned));
    assert!(
        !up.consistent_with(&pinned),
        "unproven: a pinned reopen refuses"
    );
    // Rewritten as the current format, the witness stays unproven (null), never invented.
    let rewritten = up.to_bytes().unwrap();
    let Cbor::Array(r) = decode(&rewritten).unwrap() else {
        panic!("array")
    };
    assert_eq!(
        (r.len(), &r[0], &r[24]),
        (26, &Cbor::Uint(POLICY_STATE_FORMAT), &Cbor::Null)
    );
    assert_eq!(PolicyState::from_bytes(&rewritten).unwrap(), up);

    // Pre-release stores: format 1 with the witness appended. Read as format 2.
    let mut lab = a2.clone();
    lab[0] = Cbor::Uint(1);
    let lab = PolicyState::from_bytes(&encode(&Cbor::Array(lab)).unwrap()).unwrap();
    assert_eq!(lab, s);
    assert_eq!(lab.to_bytes().unwrap(), v3);

    // Unknown shapes are refused.
    for (format, len) in [
        (2u64, 24usize),
        (3, 25),
        (0, 24),
        (1, 26),
        (2, 26),
        (3, 27),
        (4, 26),
    ] {
        let mut a = a2.clone();
        a[0] = Cbor::Uint(format);
        a.resize(len, Cbor::Null);
        assert!(
            PolicyState::from_bytes(&encode(&Cbor::Array(a)).unwrap()).is_err(),
            "format {format} with {len} elements"
        );
    }
}
