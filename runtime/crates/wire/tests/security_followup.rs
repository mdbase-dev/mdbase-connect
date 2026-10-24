//! Wire additions for security requirements.

use mdbn_wire::common::{B16, B32, B64, Bytes};
use mdbn_wire::entry::HeadWitness;
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::hash::{CHAIN_ZERO, h};
use mdbn_wire::policy::{CpKeyRevoke, RootHandover, client_fingerprint};
use mdbn_wire::snapshot::ctl_chain_next;

fn approval_item() -> Item {
    Item {
        kind: ItemKind::GrantApproval,
        collection: B16([1; 16]),
        seq: Some(5),
        prev: Some(B32([2; 32])),
        epoch: Some(1),
        signer: Some(B16([3; 16])),
        salt: Some(B16([4; 16])),
        idem: None,
        refs: None,
        stream: None,
        body: Bytes(vec![1]),
        sig: Some(B64([5; 64])),
    }
}

#[test]
fn grant_approval_is_a_sealed_control_log_item() {
    let k = ItemKind::GrantApproval;
    assert!(k.is_log_item() && k.is_control() && k.is_sealed());
    assert!(approval_item().check_shape().is_ok());
    let mut bad = approval_item();
    bad.idem = Some(B16([0; 16]));
    assert!(bad.check_shape().is_err(), "no idempotency token");
    let mut bad = approval_item();
    bad.salt = None;
    bad.epoch = None;
    assert!(
        bad.check_shape().is_err(),
        "sealed: epoch and salt required"
    );
    let mut bad = approval_item();
    bad.sig = None;
    assert!(bad.check_shape().is_err(), "signed");
}

#[test]
fn digests_use_their_own_tags() {
    let w = HeadWitness {
        collection: B16([1; 16]),
        device: B16([2; 16]),
        seq: 9,
        chain: B32([3; 32]),
        epoch: 1,
        signed_at: 0,
        sig: B64([0; 64]),
        policy_generation: None,
        catalog_generation: None,
    };
    let mut w2 = w.clone();
    w2.sig = B64([9; 64]);
    assert_eq!(
        w.signed_digest().unwrap(),
        w2.signed_digest().unwrap(),
        "the signature is not signed"
    );

    let r = CpKeyRevoke {
        key_id: B16([7; 16]),
        revoked_from: 5,
        root_sig: B64([0; 64]),
    };
    let mut m = vec![0x82, 0x50];
    m.extend_from_slice(&[7; 16]);
    m.push(0x05);
    assert_eq!(r.signed_digest().unwrap(), h("mdbase/v1/cp-key-revoke", &m));

    let rh = RootHandover {
        new_root: B32([8; 32]),
        owner_device: B16([2; 16]),
        move_id: B16([6; 16]),
        consent: B64([0; 64]),
    };
    let mut m = vec![1u8; 16];
    m.extend_from_slice(&7u64.to_be_bytes());
    m.extend_from_slice(&[8; 32]);
    m.extend_from_slice(&[6; 16]);
    assert_eq!(
        rh.consent_digest(&B16([1; 16]), 7),
        h("mdbase/v1/root-handover", &m)
    );

    let mut m = CHAIN_ZERO.0.to_vec();
    m.extend_from_slice(&3u64.to_be_bytes());
    m.extend_from_slice(&[4; 32]);
    assert_eq!(
        ctl_chain_next(&CHAIN_ZERO, 3, &B32([4; 32])),
        h("mdbase/v1/ctl-chain", &m)
    );

    let fp = client_fingerprint(&B32([0; 32]));
    assert_eq!(fp.len(), 16);
}
