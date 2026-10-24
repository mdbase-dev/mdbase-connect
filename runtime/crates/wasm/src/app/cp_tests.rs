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
