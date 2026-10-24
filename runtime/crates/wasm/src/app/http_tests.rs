//! PUBLIC test fixture keys/tokens only. Not an app custody/session substitute.
use super::http::*;
use mdbn_replica::{
    crypto::sign::verify_digest,
    log::{CallId, EndpointId},
};
use mdbn_wire::{
    cbor::{self, Cbor},
    common::B16,
    schema::Wire,
};
const ENDPOINT: EndpointId = EndpointId(37);
fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
        .collect()
}
fn request(method: &str, id: u64, address: Option<u8>) -> Vec<u8> {
    let mut params = vec![(Cbor::Uint(0), B16([0x22; 16]).to_cbor())];
    if let Some(v) = address {
        params.push((Cbor::Uint(1), Cbor::Bytes(vec![v; 32])));
    }
    if method == "put_object" {
        params.extend([
            (Cbor::Uint(2), Cbor::Uint(2)),
            (Cbor::Uint(3), Cbor::Uint(1_048_577)),
            (Cbor::Uint(4), Cbor::Bytes(vec![0; 32])),
        ]);
    }
    cbor::encode(&Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Uint(0)),
        (Cbor::Uint(1), Cbor::Uint(id)),
        (Cbor::Uint(2), Cbor::Text(method.into())),
        (Cbor::Uint(3), Cbor::Map(params)),
    ]))
    .unwrap()
}
fn envelope(frame: &[u8], token: &str, nonce: u8) -> Vec<u8> {
    cbor::encode(&Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Bytes(frame.to_vec())),
        (Cbor::Uint(1), Cbor::Text(token.into())),
        (Cbor::Uint(2), Cbor::Bytes(vec![nonce; 32])),
    ]))
    .unwrap()
}
fn signer(frame: &[u8]) -> HttpSigner {
    let mut s = HttpSigner::new(&[0x33; 32], B16([0x22; 16]), ENDPOINT, B16([0x44; 16]));
    assert_eq!(s.generation(), 0);
    assert!(s.bind());
    assert!(!s.bind());
    assert!(s.capture(CallId(1), frame));
    s
}
#[test]
fn exact_native_public_ls_http_signature_vector() {
    let frame = request("head", 1, None);
    assert_eq!(
        frame,
        hex("a40000010102646865616403a1005022222222222222222222222222222222")
    );
    let s = signer(&frame);
    let signature = s
        .sign(
            ENDPOINT,
            1,
            CallId(1),
            &envelope(&frame, "public-fixture-token", 0x11),
        )
        .unwrap();
    assert_eq!(
        signature.to_vec(),
        hex(
            "3920af542e0d7ea4bf756f8aed0d7c71c4e84d22812a40a4004528798f3ba46f58f14b7b4562383e8240964aceabb42aadad596cce36c5414f7dfb9fbe529a03"
        )
    );
    assert!(verify_digest(
        &hex("17cb79fb2b4120f2b1ec65e4198d6e08b28e813feb01e4a400839b85e18080ce")
            .try_into()
            .unwrap(),
        &hex("754b42cd0f5ffd33c1a5a25fc6b65bfe3d6dbe6f712ae38561fcfad7421c7bdb")
            .try_into()
            .unwrap(),
        &signature
    ));
}
#[test]
fn refuses_other_endpoint_generation_id_method_or_frame_body() {
    let frame = request("head", 1, None);
    let s = signer(&frame);
    let input = envelope(&frame, "public-fixture-token", 0x11);
    for (endpoint, generation, id) in [(38, 1, 1), (37, 0, 1), (37, 2, 1), (37, 1, 2)] {
        assert!(
            s.sign(EndpointId(endpoint), generation, CallId(id), &input)
                .is_none()
        );
    }
    for f in [
        request("head", 2, None),
        request("subscribe", 1, None),
        request("head", 1, Some(9)),
        request("commit_object", 7, Some(7)),
    ] {
        assert!(
            s.sign(
                ENDPOINT,
                1,
                CallId(1),
                &envelope(&f, "public-fixture-token", 0x11)
            )
            .is_none()
        );
    }
}
#[test]
fn only_associated_put_same_address_commit_is_signable() {
    let frame = request("put_object", 1, Some(7));
    let mut s = signer(&frame);
    let commit = request("commit_object", u64::MAX, Some(7));
    assert!(
        s.sign(
            ENDPOINT,
            1,
            CallId(1),
            &envelope(&commit, "public-fixture-token", 0x11)
        )
        .is_some()
    );
    for f in [
        request("commit_object", u64::MAX, Some(9)),
        request("commit_object", 1, Some(7)),
        request("get_object", 7, Some(7)),
    ] {
        assert!(
            s.sign(
                ENDPOINT,
                1,
                CallId(1),
                &envelope(&f, "public-fixture-token", 0x11)
            )
            .is_none()
        );
    }
    s.forget(CallId(1));
    assert!(
        s.sign(
            ENDPOINT,
            1,
            CallId(1),
            &envelope(&commit, "public-fixture-token", 0x11)
        )
        .is_none()
    );
}
#[test]
fn retirement_destroys_key_and_denies_rebinding_or_old_signatures() {
    let frame = request("head", 1, None);
    let mut s = signer(&frame);
    s.retire();
    assert_eq!(s.generation(), 0);
    assert!(!s.bind());
    assert!(
        s.sign(
            ENDPOINT,
            1,
            CallId(1),
            &envelope(&frame, "public-fixture-token", 0x11)
        )
        .is_none()
    );
}
#[test]
fn rejects_truncated_noncanonical_extra_fields_and_token_nonce_budgets() {
    let frame = request("head", 1, None);
    let s = signer(&frame);
    let valid = envelope(&frame, "public-fixture-token", 0x11);
    for end in 0..valid.len() {
        assert!(s.sign(ENDPOINT, 1, CallId(1), &valid[..end]).is_none());
    }
    let mut extra = valid.clone();
    extra[0] = 0xa4;
    extra.extend([3, 0xf5]);
    let mut wrong_nonce = valid.clone();
    let len = wrong_nonce.len();
    wrong_nonce[len - 33] = 31;
    let mut trailing = valid.clone();
    trailing.push(0);
    let nonminimal = [vec![0xb8, 3], valid[1..].to_vec()].concat();
    for bad in [
        trailing,
        extra,
        wrong_nonce,
        nonminimal,
        envelope(&frame, "", 0),
        envelope(&frame, "private\r\nheader", 0),
        envelope(&frame, &"a".repeat(MAX_TOKEN + 1), 0),
    ] {
        assert!(s.sign(ENDPOINT, 1, CallId(1), &bad).is_none());
    }
}
