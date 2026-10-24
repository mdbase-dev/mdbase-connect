//! LAB test tooling (not shipped): a control-plane-signed policy item enrolling one
//! more desktop of the fixture owner in a `lab_fixture` collection, signed with the
//! same public test control plane (`SIGNED_CP_SEED`, `signed_root`). Prints the item
//! (hex) for `e2e/lab.mjs enrol` to append at the given position.
//!
//! `lab_enrol <collection-byte> <seq> <prev-hex> <device-byte> <issued-at-ms>`
//!
//! The new device's keys are public test values derived from its byte (sign seed
//! `[b; 32]`, KEM secret `[b ^ 0xff; 32]`).
#![allow(clippy::disallowed_methods)]

use mdbn_replica::crypto::hpke::KemKeyPair;
use mdbn_replica::crypto::sign::DeviceSigner;
use mdbn_replica::policy::key_id;
use mdbn_replica::testkit::{SIGNED_CP_SEED, SIGNED_ROOT_SEED, TEST_OWNER, signed_root};
use mdbn_wire::common::{B16, B32, B64, Bytes};
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::policy::{CpCert, DeviceEnrol, DeviceKind, PolicyOp, PolicyPayload};
use mdbn_wire::schema::Wire;

fn byte(s: &str) -> u8 {
    u8::from_str_radix(s, 16).expect("hex byte")
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    assert_eq!(
        a.len(),
        6,
        "lab_enrol <collection-byte> <seq> <prev-hex> <device-byte> <issued-at-ms>"
    );
    let collection = B16([byte(&a[1]); 16]);
    let seq: u64 = a[2].parse().expect("seq");
    let prev: [u8; 32] = (0..32)
        .map(|i| u8::from_str_radix(&a[3][i * 2..i * 2 + 2], 16).expect("prev"))
        .collect::<Vec<_>>()
        .try_into()
        .expect("prev");
    let d = byte(&a[4]);
    let issued_at: i64 = a[5].parse().expect("issued_at");
    let policy = DeviceSigner::from_seed(&SIGNED_CP_SEED);
    let mut cert = CpCert {
        policy_pk: B32(policy.public()),
        not_before: 0,
        not_after: i64::MAX,
        root: key_id(&signed_root()),
        sig: B64([0; 64]),
    };
    cert.sig =
        B64(DeviceSigner::from_seed(&SIGNED_ROOT_SEED)
            .sign_digest(&cert.signed_digest().unwrap().0));
    let op = PolicyOp::DeviceEnrol(DeviceEnrol {
        device: B16([d; 16]),
        account: TEST_OWNER,
        kind: DeviceKind::Desktop,
        sign_pk: B32(DeviceSigner::from_seed(&[d; 32]).public()),
        kem_pk: B32(KemKeyPair::from_secret(&[d ^ 0xff; 32]).pk),
        noise_pk: B32([9; 32]),
        sas_commit: None,
        local_root: None,
    });
    let payload = PolicyPayload {
        cert,
        issued_at,
        ops: vec![op],
    };
    let mut item = Item {
        kind: ItemKind::Policy,
        collection,
        seq: Some(seq),
        prev: Some(B32(prev)),
        epoch: None,
        signer: Some(key_id(&policy.public())),
        salt: None,
        idem: None,
        refs: None,
        stream: None,
        body: Bytes(payload.to_bytes().unwrap()),
        sig: None,
    };
    policy.sign_item(&mut item).unwrap();
    let b = item.to_bytes().unwrap();
    println!(
        "{}",
        b.iter().map(|x| format!("{x:02x}")).collect::<String>()
    );
}
