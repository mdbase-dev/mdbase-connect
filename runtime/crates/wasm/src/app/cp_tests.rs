//! Independent Node/OpenSSL public fixture for the actual CP token transcript.
use super::http::HttpSigner;
use mdbn_replica::log::EndpointId;
use mdbn_wire::common::B16;
fn signer() -> HttpSigner {
    HttpSigner::new(
        &[0x33; 32],
        B16([0x22; 16]),
        EndpointId(37),
        B16([0x44; 16]),
    )
}
fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&s[at..at + 2], 16).unwrap())
        .collect()
}
#[test]
fn fixed_cp_token_domain_matches_independent_node_openssl_vector_before_log_bind() {
    let mut s = signer();
    assert!(s.sign_cp_log_token(&[0x11; 32]).is_none());
    assert!(s.bind_connector(B16([0x66; 16])));
    assert_eq!(s.generation(), 0);
    let sig = s.sign_cp_log_token(&[0x11; 32]).unwrap();
    assert_eq!(
        sig.to_vec(),
        hex(
            "d3f3dcafc39e2eab9c488b8677d75ebffb09805832ca3c520d3c137171af0cad315ab24a5b0aa869521efa026999a0bc75d068f4b7599d82c51d025ee25de407"
        )
    );
    assert!(mdbn_replica::crypto::sign::verify_digest(
        &hex("17cb79fb2b4120f2b1ec65e4198d6e08b28e813feb01e4a400839b85e18080ce")
            .try_into()
            .unwrap(),
        &hex("66e43cab124619dbf1f6d19fd472e7f93e2bd9ec064e5f2151f8297d5dbd3e3d")
            .try_into()
            .unwrap(),
        &sig
    ));
    assert!(s.bind());
    assert_eq!(s.sign_cp_log_token(&[0x11; 32]).unwrap(), sig);
}
#[test]
fn connector_binding_is_once_non_nil_before_log_and_cleared_on_retirement() {
    let mut s = signer();
    assert!(!s.bind_connector(B16([0; 16])));
    assert!(s.bind_connector(B16([0x66; 16])));
    assert!(!s.bind_connector(B16([0x66; 16])));
    assert!(!s.bind_connector(B16([0x77; 16])));
    for size in [0, 31, 33, 16_384] {
        assert!(s.sign_cp_log_token(&vec![0x11; size]).is_none());
    }
    s.retire();
    assert!(!s.bind_connector(B16([0x66; 16])));
    assert!(s.sign_cp_log_token(&[0x11; 32]).is_none());
    let mut late = signer();
    assert!(late.bind());
    assert!(!late.bind_connector(B16([0x66; 16])));
}
fn fetch_input(challenge: [u8; 32], account: [u8; 16]) -> Vec<u8> {
    use mdbn_wire::cbor::{self, Cbor};
    cbor::encode(&Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Bytes(challenge.to_vec())),
        (Cbor::Uint(1), Cbor::Bytes(account.to_vec())),
    ]))
    .unwrap()
}
#[test]
fn account_key_fetch_signs_only_the_servers_fetch_digest_of_the_pinned_identity() {
    use mdbn_replica::crypto::{
        proof::{AccountProof, account_proof_digest},
        sign::{DeviceSigner, verify_digest},
    };
    let mut s = signer();
    let input = fetch_input([0x11; 32], [0x55; 16]);
    assert!(s.sign_account_key_fetch(&input).is_none(), "unbound");
    assert!(s.bind_connector(B16([0x66; 16])));
    let sig = s.sign_account_key_fetch(&input).unwrap();
    let pk = DeviceSigner::from_seed(&[0x33; 32]).public();
    // What `accountKeyFetchDigest` computes on the server for this request.
    let digest = |challenge: [u8; 32], connector: u8, device: u8, account: u8| {
        account_proof_digest(
            AccountProof::Fetch,
            &challenge,
            &B16([connector; 16]),
            &B16([device; 16]),
            &B16([account; 16]),
            vec![],
        )
    };
    assert!(verify_digest(
        &pk,
        &digest([0x11; 32], 0x66, 0x44, 0x55).0,
        &sig
    ));
    // Bound to the challenge, the pinned connector and device, and the account.
    for other in [
        digest([0x12; 32], 0x66, 0x44, 0x55),
        digest([0x11; 32], 0x67, 0x44, 0x55),
        digest([0x11; 32], 0x66, 0x45, 0x55),
        digest([0x11; 32], 0x66, 0x44, 0x56),
        // The collection is not part of this proof.
        digest([0x11; 32], 0x66, 0x44, 0x22),
    ] {
        assert!(!verify_digest(&pk, &other.0, &sig));
    }
    // No other account-key purpose, and not the log-token proof.
    for kind in [
        AccountProof::Put,
        AccountProof::Strict,
        AccountProof::StrictReport,
    ] {
        let other = account_proof_digest(
            kind,
            &[0x11; 32],
            &B16([0x66; 16]),
            &B16([0x44; 16]),
            &B16([0x55; 16]),
            vec![],
        );
        assert!(!verify_digest(&pk, &other.0, &sig));
    }
    assert_ne!(sig, s.sign_cp_log_token(&[0x11; 32]).unwrap());
    let other_account = s
        .sign_account_key_fetch(&fetch_input([0x11; 32], [0x56; 16]))
        .unwrap();
    let other_challenge = s
        .sign_account_key_fetch(&fetch_input([0x12; 32], [0x55; 16]))
        .unwrap();
    assert_ne!(other_account, sig);
    assert_ne!(other_challenge, sig);
    assert_ne!(other_account, other_challenge);
    // Available before and after the log binds, like the log-token proof.
    assert!(s.bind());
    assert_eq!(s.sign_account_key_fetch(&input).unwrap(), sig);
    s.retire();
    assert!(s.sign_account_key_fetch(&input).is_none(), "retired");
}
#[test]
fn account_key_fetch_refuses_everything_but_the_exact_canonical_input() {
    use mdbn_wire::cbor::{self, Cbor};
    let mut s = signer();
    assert!(s.bind_connector(B16([0x66; 16])));
    let good = fetch_input([0x11; 32], [0x55; 16]);
    assert_eq!(good.len(), 54);
    assert!(s.sign_account_key_fetch(&good).is_some());
    let map = |fields: Vec<(Cbor, Cbor)>| cbor::encode(&Cbor::Map(fields)).unwrap();
    let ch = || Cbor::Bytes(vec![0x11; 32]);
    let acc = || Cbor::Bytes(vec![0x55; 16]);
    let mut trailing = good.clone();
    trailing.push(0);
    // The same two fields, account first: not the canonical key order.
    let mut unsorted = vec![0xa2, 0x01, 0x50];
    unsorted.extend([0x55; 16]);
    unsorted.extend([0x00, 0x58, 0x20]);
    unsorted.extend([0x11; 32]);
    assert_eq!(unsorted.len(), good.len());
    for bad in [
        Vec::new(),
        vec![0x11; 32],
        vec![0x11; 54],
        good[..53].to_vec(),
        trailing,
        fetch_input([0x11; 32], [0; 16]),
        map(vec![(Cbor::Uint(0), ch())]),
        unsorted,
        map(vec![(Cbor::Uint(0), acc()), (Cbor::Uint(1), ch())]),
        map(vec![(Cbor::Uint(0), ch()), (Cbor::Uint(2), acc())]),
        map(vec![
            (Cbor::Uint(0), ch()),
            (Cbor::Uint(1), acc()),
            (Cbor::Uint(2), Cbor::Bytes(vec![0x22; 16])),
        ]),
        // A caller-supplied digest, connector or device is not an input.
        map(vec![(Cbor::Uint(0), Cbor::Bytes(vec![0x11; 50]))]),
        cbor::encode(&Cbor::Array(vec![ch(), acc()])).unwrap(),
    ] {
        assert!(s.sign_account_key_fetch(&bad).is_none(), "{bad:02x?}");
    }
}
