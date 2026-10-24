//! Real protocol cryptography with PUBLIC synthetic test keys. No managed CP,
//! database, live nonce producer or positive SDK/currentness qualification.
use super::*;
use mdbn_log_service::testkit::{ControlPlane, Device, sign_digest};
use mdbn_wire::hash::CHAIN_ZERO;
use mdbn_wire::log_service::LsRequest;
use mdbn_wire::policy::{CState, Genesis, PolicyOp, PolicyPayload};

const NOW: i64 = 1_000_000;
const AUDIENCE: &str = "https://cp.example";
const RUN: &str = "gate4-pitr-lab-20261009-01";
const CHALLENGE: [u8; 32] = [0x45; 32];

struct Fixture {
    cp: ControlPlane,
    collection: B16,
    owner: B16,
    genesis: Vec<u8>,
    body: Vec<u8>,
    token: String,
    nonce: [u8; 32],
    signature: String,
    secret: [u8; 32],
}
impl Fixture {
    fn new() -> Self {
        let cp = ControlPlane::new("public-native-prekey-v2");
        let collection = B16([0x11; 16]);
        let owner = B16([0x22; 16]);
        let genesis = cp.policy_item(
            collection,
            1,
            CHAIN_ZERO,
            vec![PolicyOp::Genesis(Genesis {
                owner,
                root: key_id(&cp.root_pk()),
                state: CState::CloudCopy,
            })],
            NOW - 100,
        );
        let body = LsFrame::Request(LsRequest {
            id: 1,
            method: "create_log".into(),
            params: Cbor::Map(vec![
                (Cbor::Uint(0), Cbor::Bytes(collection.0.to_vec())),
                (Cbor::Uint(1), Cbor::Bytes(genesis.clone())),
            ]),
        })
        .to_bytes()
        .unwrap();
        let token = cp.cp_token(NOW + 200_000);
        let secret = [0x33; 32];
        let nonce = auth::http_nonce(&secret, NOW, [0x44; 8]);
        let digest = auth::http_digest(
            &nonce,
            "/v1/rpc",
            &collection.0,
            &token,
            "create_log",
            &body,
        );
        let signature = mdbn_wire::render::hex(&sign_digest(cp.transport_key(), &digest).0);
        Self {
            cp,
            collection,
            owner,
            genesis,
            body,
            token,
            nonce,
            signature,
            secret,
        }
    }
    fn authenticate(&self, seen: &NonceCache, now: i64) -> Result<Authenticated> {
        let budget = Budget::default();
        let verified = preflight(&self.token, &[self.cp.issuer_pk()], now, &budget)?;
        authenticate(
            HttpProof {
                token: &self.token,
                nonce: &mdbn_wire::render::hex(&self.nonce),
                signature: &self.signature,
                path: "/v1/rpc",
            },
            &self.body,
            VerifyInputs {
                verified: &verified,
                secret: &self.secret,
                seen,
                now,
                collection: self.collection,
                budget,
            },
        )
    }
    fn claims(&self, issued: i64) -> Vec<Cbor> {
        vec![
            Cbor::Uint(2),
            Cbor::Text(AUDIENCE.into()),
            Cbor::Text(RUN.into()),
            Cbor::Text("original-caller-prekey".into()),
            Cbor::Bytes(self.collection.0.to_vec()),
            Cbor::Bytes(self.owner.0.to_vec()),
            Cbor::Bytes(self.cp.root_pk().0.to_vec()),
            Cbor::Bytes(self.cp.issuer_pk().0.to_vec()),
            Cbor::Bytes(self.cp.transport_key().verifying_key().to_bytes().to_vec()),
            Cbor::Bytes(sha256(&self.genesis).0.to_vec()),
            Cbor::Uint(1),
            Cbor::Null,
            Cbor::Null,
            Cbor::Null,
            Cbor::Bytes(CHALLENGE.to_vec()),
            Cbor::Uint(issued as u64),
            Cbor::Uint((issued + 10_000) as u64),
            Cbor::Bytes(self.nonce.to_vec()),
            Cbor::Bytes(
                auth::http_digest(
                    &self.nonce,
                    "/v1/rpc",
                    &self.collection.0,
                    &self.token,
                    "create_log",
                    &self.body,
                )
                .0
                .to_vec(),
            ),
        ]
    }
    fn envelope(&self, claims: Vec<Cbor>, domain: &str) -> Vec<u8> {
        let item = mdbn_wire::envelope::Item::from_bytes(&self.genesis).unwrap();
        let payload = PolicyPayload::from_bytes(&item.body.0).unwrap();
        let raw = cbor::encode(&Cbor::Array(claims)).unwrap();
        let sig = sign_digest(self.cp.transport_key(), &h(domain, &raw));
        cbor::encode(&Cbor::Array(vec![
            Cbor::Uint(2),
            Cbor::Bytes(raw),
            payload.cert.to_cbor(),
            Cbor::Bytes(sig.0.to_vec()),
        ]))
        .unwrap()
    }
}

#[test]
fn actual_http_auth_and_original_binder_are_required() {
    let f = Fixture::new();
    let auth = f.authenticate(&NonceCache::default(), NOW).unwrap();
    let envelope = f.envelope(f.claims(NOW), DOMAIN);
    let original = auth
        .admission(&envelope, &[f.cp.root_pk()], AUDIENCE, RUN, &CHALLENGE)
        .unwrap();
    assert_eq!(original.collection(), f.collection);
    assert_eq!(original.owner(), f.owner);
    assert_eq!(original.genesis_sha256(), sha256(&f.genesis));
}

#[test]
fn begin_v2_is_five_fields_and_at_most_113_bytes() {
    let f = Fixture::new();
    let auth = f.authenticate(&NonceCache::default(), NOW).unwrap();
    assert!(auth.begin_data(0, CHALLENGE).is_err());
    assert!(auth.begin_data(MAX_SAFE + 1, CHALLENGE).is_err());
    let bytes = auth.begin_data(MAX_SAFE, CHALLENGE).unwrap();
    assert_eq!(bytes.len(), 113);
    let Cbor::Array(values) = cbor::decode(&bytes).unwrap() else {
        panic!("array")
    };
    assert_eq!(values.len(), 5);
    assert_eq!(values[0], Cbor::Uint(2));
    assert_eq!(values[3], Cbor::Bytes(f.nonce.to_vec()));
}

#[test]
fn v1_outer_claims_and_domain_never_satisfy_v2() {
    for change in 0..3 {
        let f = Fixture::new();
        let auth = f.authenticate(&NonceCache::default(), NOW).unwrap();
        let mut claims = f.claims(NOW);
        let mut domain = DOMAIN;
        if change == 0 {
            claims[0] = Cbor::Uint(1)
        }
        if change == 1 {
            domain = "mdbase/v1/prekey-original-admission"
        }
        let mut bytes = f.envelope(claims, domain);
        if change == 2 {
            bytes[1] = 1
        }
        assert!(
            auth.admission(&bytes, &[f.cp.root_pk()], AUDIENCE, RUN, &CHALLENGE)
                .is_err()
        );
    }
}

#[test]
fn signed_wrong_pins_nonce_digest_challenge_and_nullable_device_fields_refuse() {
    for index in [4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 17, 18] {
        let f = Fixture::new();
        let auth = f.authenticate(&NonceCache::default(), NOW).unwrap();
        let mut claims = f.claims(NOW);
        match &mut claims[index] {
            Cbor::Bytes(bytes) => bytes[0] ^= 1,
            value => *value = Cbor::Uint(1),
        }
        let bytes = f.envelope(claims, DOMAIN);
        assert!(
            auth.admission(&bytes, &[f.cp.root_pk()], AUDIENCE, RUN, &CHALLENGE)
                .is_err(),
            "index{index}"
        );
    }
}

#[test]
fn strict_arity_certificate_unknown_fields_and_trailing_bytes_refuse() {
    for change in 0..5 {
        let f = Fixture::new();
        let auth = f.authenticate(&NonceCache::default(), NOW).unwrap();
        let mut claims = f.claims(NOW);
        if change == 0 {
            claims.pop();
        }
        if change == 1 {
            claims.push(Cbor::Null);
        }
        let mut bytes = f.envelope(claims, DOMAIN);
        if change == 2 {
            bytes.push(0);
        }
        if change == 3 {
            let Cbor::Array(mut outer) = cbor::decode(&bytes).unwrap() else {
                panic!("outer")
            };
            let Cbor::Map(cert) = &mut outer[2] else {
                panic!("cert")
            };
            cert.push((Cbor::Uint(5), Cbor::Null));
            bytes = cbor::encode(&Cbor::Array(outer)).unwrap();
        }
        if change == 4 {
            bytes = vec![0; ENVELOPE_CAP + 1];
        }
        assert!(
            auth.admission(&bytes, &[f.cp.root_pk()], AUDIENCE, RUN, &CHALLENGE)
                .is_err()
        );
    }
}

#[test]
fn cp_failure_never_resets_ram_first_use_and_final_check_does_not_consume() {
    let f = Fixture::new();
    let seen = NonceCache::default();
    let auth = f.authenticate(&seen, NOW).unwrap();
    assert!(
        auth.admission(&[0], &[f.cp.root_pk()], AUDIENCE, RUN, &CHALLENGE)
            .is_err()
    );
    assert!(f.authenticate(&seen, NOW).is_err());
    assert!(auth.fresh_at(NOW).is_ok());
    assert!(auth.fresh_at(NOW + 60_000).is_ok());
    assert!(auth.fresh_at(NOW + 60_001).is_err());
    assert!(auth.fresh_at(NOW - 5000).is_ok());
    assert!(auth.fresh_at(NOW - 5001).is_err());
    assert!(f.authenticate(&seen, NOW).is_err());
}

#[test]
fn actual_verifier_has_the_same_inclusive_time_boundaries() {
    for (now, accepted) in [
        (NOW + 60_000, true),
        (NOW + 60_001, false),
        (NOW - 5000, true),
        (NOW - 5001, false),
    ] {
        let f = Fixture::new();
        assert_eq!(
            f.authenticate(&NonceCache::default(), now).is_ok(),
            accepted
        );
    }
}

#[test]
fn http_verb_or_changed_exact_body_cannot_replace_the_rpc_transcript() {
    for change in 0..2 {
        let mut f = Fixture::new();
        if change == 0 {
            let digest = auth::http_digest(
                &f.nonce,
                "/v1/rpc",
                &f.collection.0,
                &f.token,
                "POST",
                &f.body,
            );
            f.signature = mdbn_wire::render::hex(&sign_digest(f.cp.transport_key(), &digest).0);
        } else {
            let mut frame = LsFrame::from_bytes(&f.body).unwrap();
            let LsFrame::Request(request) = &mut frame else {
                panic!("request")
            };
            request.id = 2;
            f.body = frame.to_bytes().unwrap();
        }
        assert!(f.authenticate(&NonceCache::default(), NOW).is_err());
    }
}

#[test]
fn independent_root_and_actual_issuer_are_not_inferred_from_cp_pins() {
    let f = Fixture::new();
    let other = ControlPlane::new("public-other");
    assert!(preflight(&f.token, &[other.issuer_pk()], NOW, &Budget::default()).is_err());
    assert!(preflight(&f.token, &[f.cp.root_pk()], NOW, &Budget::default()).is_err());
    assert!(
        preflight(
            &f.token,
            &[other.issuer_pk(), f.cp.issuer_pk()],
            NOW,
            &Budget::default()
        )
        .is_ok()
    );
    let auth = f.authenticate(&NonceCache::default(), NOW).unwrap();
    assert!(
        auth.admission(
            &f.envelope(f.claims(NOW), DOMAIN),
            &[other.root_pk()],
            AUDIENCE,
            RUN,
            &CHALLENGE
        )
        .is_err()
    );
}

#[test]
fn admission_signer_is_not_the_original_transport_or_token_issuer() {
    let f = Fixture::new();
    let auth = f.authenticate(&NonceCache::default(), NOW).unwrap();
    // PUBLIC deterministic test keys only: current admission signer can differ
    // from the independently authenticated historical CP transport key.
    let root = mdbn_log_service::testkit::key(b"public-native-prekey-v2/root");
    let signer = mdbn_log_service::testkit::key(b"public-admission-only-signer");
    let mut cert = CpCert {
        policy_pk: B32(signer.verifying_key().to_bytes()),
        not_before: 0,
        not_after: NOW + 100_000,
        root: key_id(&f.cp.root_pk()),
        sig: mdbn_wire::common::B64([0; 64]),
    };
    cert.sig = sign_digest(&root, &cert.signed_digest().unwrap());
    let claims = cbor::encode(&Cbor::Array(f.claims(NOW))).unwrap();
    let signature = sign_digest(&signer, &h(DOMAIN, &claims));
    let bytes = cbor::encode(&Cbor::Array(vec![
        Cbor::Uint(2),
        Cbor::Bytes(claims),
        cert.to_cbor(),
        Cbor::Bytes(signature.0.to_vec()),
    ]))
    .unwrap();
    assert!(
        auth.admission(&bytes, &[f.cp.root_pk()], AUDIENCE, RUN, &CHALLENGE)
            .is_ok()
    );
}

#[test]
fn unsafe_auth_clock_and_expired_token_fail_without_first_use_reset() {
    let f = Fixture::new();
    for now in [-1, i64::MAX] {
        assert!(preflight(&f.token, &[f.cp.issuer_pk()], now, &Budget::default()).is_err());
    }
    // Obtain the entire opaque context from an actual shorter-lived signed token,
    // never synthesize its fields or reinitialize its replay cache for freshness.
    let mut short = Fixture::new();
    short.token = short.cp.cp_token(NOW + 1);
    let digest = auth::http_digest(
        &short.nonce,
        "/v1/rpc",
        &short.collection.0,
        &short.token,
        "create_log",
        &short.body,
    );
    short.signature = mdbn_wire::render::hex(&sign_digest(short.cp.transport_key(), &digest).0);
    let seen = NonceCache::default();
    let auth = short.authenticate(&seen, NOW).unwrap();
    assert!(auth.fresh_at(NOW).is_ok());
    assert!(auth.fresh_at(NOW + 1).is_err());
    assert!(short.authenticate(&seen, NOW).is_err());
}

#[test]
fn signed_device_token_is_not_a_cp_caller() {
    let mut f = Fixture::new();
    let device = Device::new("public-device", f.owner);
    f.token = f.cp.device_token(&device, NOW + 200_000);
    f.signature = mdbn_wire::render::hex(
        &device
            .http_sig(&f.nonce, "/v1/rpc", &f.token, "create_log", &f.body)
            .0,
    );
    assert!(f.authenticate(&NonceCache::default(), NOW).is_err());
}

#[test]
fn admission_lifetime_and_unsafe_nonce_timestamp_refuse() {
    let f = Fixture::new();
    let auth = f.authenticate(&NonceCache::default(), NOW).unwrap();
    for expires in [NOW, NOW + 10_001] {
        let mut claims = f.claims(NOW);
        claims[16] = Cbor::Uint(expires as u64);
        assert!(
            auth.admission(
                &f.envelope(claims, DOMAIN),
                &[f.cp.root_pk()],
                AUDIENCE,
                RUN,
                &CHALLENGE
            )
            .is_err()
        );
    }
    let mut nonce = f.nonce;
    nonce[..8].copy_from_slice(&(MAX_SAFE + 1).to_be_bytes());
    assert!(nonce_time(&nonce).is_err());
}
