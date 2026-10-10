use super::*;
use mdbn_replica::crypto::sign::DeviceSigner;
use mdbn_replica::policy::{PolicyKeyPin, RootPin, key_id};
use mdbn_wire::hash::sha256;

const TARGET: B16 = B16([11; 16]);
const DEVICE: B16 = B16([12; 16]);
const NOW: i64 = 20_000;

struct Fixture {
    root: DeviceSigner,
    cp: DeviceSigner,
    cert: CpCert,
    pins: PolicyPins,
    claims: Vec<Cbor>,
}
impl Fixture {
    fn new() -> Self {
        // Deliberately public deterministic TEST-only seeds.
        let root = DeviceSigner::from_seed(&[37; 32]);
        let cp = DeviceSigner::from_seed(&[38; 32]);
        let mut cert = CpCert {
            policy_pk: B32(cp.public()),
            not_before: 0,
            not_after: i64::MAX,
            root: key_id(&root.public()),
            sig: B64([0; 64]),
        };
        cert.sig = B64(root.sign_digest(&cert.signed_digest().unwrap().0));
        let pins = PolicyPins {
            roots: vec![RootPin {
                root_id: cert.root,
                root_pk: B32(root.public()),
            }],
            policy_keys: vec![PolicyKeyPin {
                key_id: cert.key_id(),
                policy_pk: cert.policy_pk,
                root_id: cert.root,
            }],
        };
        let claims = vec![
            Cbor::Uint(1),
            TARGET.to_cbor(),
            DEVICE.to_cbor(),
            Cbor::Uint(7),
            B16([13; 16]).to_cbor(),
            Cbor::Uint(91),
            Cbor::int(100),
            Cbor::Uint(19),
            Cbor::int(10_000),
            Cbor::int(50_000),
        ];
        Self {
            root,
            cp,
            cert,
            pins,
            claims,
        }
    }
    fn envelope(&self) -> Cbor {
        let claims = cbor::encode(&Cbor::Array(self.claims.clone())).unwrap();
        Cbor::Array(vec![
            Cbor::Uint(1),
            Cbor::Bytes(claims.clone()),
            self.cert.to_cbor(),
            B64(self.cp.sign_digest(&h(DOMAIN, &claims).0)).to_cbor(),
        ])
    }
    fn bytes(&self) -> Vec<u8> {
        cbor::encode(&self.envelope()).unwrap()
    }
    fn signed_cert(&mut self) {
        self.cert.sig = B64(self.root.sign_digest(&self.cert.signed_digest().unwrap().0));
    }
    fn verify(&self, bytes: &[u8], now: i64) -> Result<()> {
        MigrationSourceWitness::decode(bytes)?.verify_for_root(
            &self.pins,
            self.cert.root,
            B32(self.root.public()),
            now,
        )
    }
}

fn envelope_edit(f: &Fixture, edit: impl FnOnce(&mut Vec<Cbor>)) -> Vec<u8> {
    let Cbor::Array(mut a) = f.envelope() else {
        unreachable!()
    };
    edit(&mut a);
    cbor::encode(&Cbor::Array(a)).unwrap()
}

#[test]
fn exact_ten_claims_strict_certificate_and_domain_pass_public_only() {
    let f = Fixture::new();
    let w = MigrationSourceWitness::decode(&f.bytes()).unwrap();
    assert_eq!(w.claims().target, TARGET);
    assert_eq!(w.claims().hosted_device, DEVICE);
    assert_eq!(w.claims().legacy, B16([13; 16]));
    assert_eq!(w.claims().source_head, 91);
    assert_eq!(w.claims().started_at_ms, 100);
    assert_eq!(w.signer_key_id(), f.cert.key_id());
    assert!(w.matches_tuple(TARGET, DEVICE, 7, 19));
    assert!(f.verify(&f.bytes(), NOW).is_ok());
}

#[test]
fn full_u64_and_signed_i64_are_not_rounded_or_narrowed() {
    let mut f = Fixture::new();
    for i in [3, 5, 7] {
        f.claims[i] = Cbor::Uint(u64::MAX);
    }
    for i in [6, 8, 9] {
        f.claims[i] = Cbor::int(i64::MIN);
    }
    let encoded = cbor::encode(&Cbor::Array(f.claims.clone())).unwrap();
    assert_eq!(encoded.len(), MAX_CLAIMS_BYTES);
    let w = MigrationSourceWitness::decode(&f.bytes()).unwrap();
    assert_eq!(w.claims().epoch, u64::MAX);
    assert_eq!(w.claims().source_head, u64::MAX);
    assert_eq!(w.claims().wake, u64::MAX);
    assert_eq!(w.claims().started_at_ms, i64::MIN);
    assert_eq!(w.claims().issued_at_ms, i64::MIN);
    assert_eq!(w.claims().expires_at_ms, i64::MIN);
    assert!(!w.live_at(i64::MIN));
    f.claims[5] = Cbor::Uint((1 << 53) + 1);
    assert_eq!(
        MigrationSourceWitness::decode(&f.bytes())
            .unwrap()
            .claims()
            .source_head,
        (1 << 53) + 1
    );
}

#[test]
fn tampering_any_signed_claim_cannot_reuse_a_signature() {
    let f = Fixture::new();
    for i in 1..10 {
        let changed = envelope_edit(&f, |a| {
            let Cbor::Bytes(raw) = &a[1] else {
                unreachable!()
            };
            let Cbor::Array(mut claims) = cbor::decode(raw).unwrap() else {
                unreachable!()
            };
            match &mut claims[i] {
                Cbor::Uint(n) => *n += 1,
                Cbor::Bytes(b) => b[0] ^= 1,
                _ => unreachable!(),
            }
            a[1] = Cbor::Bytes(cbor::encode(&Cbor::Array(claims)).unwrap());
        });
        assert!(f.verify(&changed, NOW).is_err(), "claim {i}");
    }
}

#[test]
fn signed_wrong_target_device_epoch_or_wake_still_does_not_match_native_tuple() {
    let f = Fixture::new();
    let w = MigrationSourceWitness::decode(&f.bytes()).unwrap();
    for tuple in [
        (B16([0; 16]), DEVICE, 7, 19),
        (TARGET, B16([0; 16]), 7, 19),
        (TARGET, DEVICE, 8, 19),
        (TARGET, DEVICE, 7, 20),
    ] {
        assert!(!w.matches_tuple(tuple.0, tuple.1, tuple.2, tuple.3));
    }
}

#[test]
fn plain_sha_policy_chain_or_other_domain_are_not_migration_signatures() {
    let f = Fixture::new();
    let raw = cbor::encode(&Cbor::Array(f.claims.clone())).unwrap();
    for digest in [
        sha256(&raw),
        h("mdbase/v1/chain", &raw),
        h("mdbase/v1/cp-cert", &raw),
    ] {
        let bytes = envelope_edit(&f, |a| a[3] = B64(f.cp.sign_digest(&digest.0)).to_cbor());
        assert!(f.verify(&bytes, NOW).is_err());
    }
    let wrong_cp = DeviceSigner::from_seed(&[39; 32]);
    let bytes = envelope_edit(&f, |a| {
        a[3] = B64(wrong_cp.sign_digest(&h(DOMAIN, &raw).0)).to_cbor()
    });
    assert!(f.verify(&bytes, NOW).is_err());
}

#[test]
fn published_root_and_policy_pins_and_exact_current_root_are_all_required() {
    let f = Fixture::new();
    let w = MigrationSourceWitness::decode(&f.bytes()).unwrap();
    let root = f.cert.root;
    let pk = B32(f.root.public());
    let mut pins = f.pins.clone();
    pins.roots.clear();
    assert!(w.verify_for_root(&pins, root, pk, NOW).is_err());
    pins = f.pins.clone();
    pins.policy_keys.clear();
    assert!(w.verify_for_root(&pins, root, pk, NOW).is_err());
    assert!(w.verify_for_root(&f.pins, B16([0; 16]), pk, NOW).is_err());
    assert!(w.verify_for_root(&f.pins, root, B32([0; 32]), NOW).is_err());
    // Genuine root certification is not enough: the new CP key is unpublished.
    let mut unpublished = Fixture::new();
    unpublished.cp = DeviceSigner::from_seed(&[40; 32]);
    unpublished.cert.policy_pk = B32(unpublished.cp.public());
    unpublished.signed_cert();
    assert!(unpublished.verify(&unpublished.bytes(), NOW).is_err());
}

#[test]
fn invalid_certificate_signature_or_noncovering_window_refuses() {
    for (before, after) in [(10_001, i64::MAX), (0, 49_999), (60_000, 0)] {
        let mut f = Fixture::new();
        f.cert.not_before = before;
        f.cert.not_after = after;
        f.signed_cert();
        assert!(f.verify(&f.bytes(), NOW).is_err());
    }
    let mut f = Fixture::new();
    f.cert.sig = B64([0; 64]);
    assert!(f.verify(&f.bytes(), NOW).is_err());
}

#[test]
fn strict_ed25519_rejects_malformed_or_small_order_signatures_and_keys() {
    let f = Fixture::new();
    for sig in [[0; 64], [255; 64], {
        let mut s = [0; 64];
        s[0] = 1;
        s
    }] {
        let bytes = envelope_edit(&f, |a| a[3] = B64(sig).to_cbor());
        assert!(f.verify(&bytes, NOW).is_err());
    }
    let mut weak = Fixture::new();
    weak.cert.policy_pk = B32([0; 32]);
    weak.pins.policy_keys[0].policy_pk = weak.cert.policy_pk;
    weak.pins.policy_keys[0].key_id = weak.cert.key_id();
    weak.signed_cert();
    assert!(weak.verify(&weak.bytes(), NOW).is_err());
}

#[test]
fn ttl_clock_and_checked_overflow_refuse_at_exact_boundaries() {
    let f = Fixture::new();
    assert!(f.verify(&f.bytes(), 10_000).is_ok());
    assert!(f.verify(&f.bytes(), 49_999).is_ok());
    assert!(f.verify(&f.bytes(), 9_999).is_err());
    assert!(f.verify(&f.bytes(), 50_000).is_err());
    for (issued, expires) in [
        (10_000, 10_000),
        (10_000, 9_999),
        (10_000, 910_001),
        (i64::MIN, i64::MAX),
    ] {
        let mut f = Fixture::new();
        f.claims[8] = Cbor::int(issued);
        f.claims[9] = Cbor::int(expires);
        assert!(f.verify(&f.bytes(), NOW).is_err());
    }
    let mut f = Fixture::new();
    f.claims[9] = Cbor::int(910_000);
    assert!(f.verify(&f.bytes(), NOW).is_ok());
}

#[test]
fn exact_shape_rejects_eleven_claims_versions_unknown_cert_fields_or_lengths() {
    let f = Fixture::new();
    for bytes in [
        envelope_edit(&f, |a| a.push(Cbor::Null)),
        envelope_edit(&f, |a| a[0] = Cbor::Uint(2)),
        envelope_edit(&f, |a| a[3] = Cbor::Bytes(vec![0; 63])),
        envelope_edit(&f, |a| {
            if let Cbor::Map(m) = &mut a[2] {
                m.push((Cbor::Uint(5), Cbor::Null));
            }
        }),
    ] {
        assert!(MigrationSourceWitness::decode(&bytes).is_err());
    }
    for edit in [0, 1, 2, 3] {
        let mut f = Fixture::new();
        match edit {
            0 => f.claims.push(Cbor::Null),
            1 => f.claims[0] = Cbor::Uint(2),
            2 => f.claims[1] = Cbor::Bytes(vec![0; 15]),
            3 => f.claims[3] = Cbor::int(-1),
            _ => unreachable!(),
        }
        assert!(MigrationSourceWitness::decode(&f.bytes()).is_err());
    }
}

#[test]
fn signed_time_does_not_accept_float_text_or_unsigned_over_i64_max() {
    for value in [
        Cbor::Float(10_000.0),
        Cbor::Text("10000".into()),
        Cbor::Uint(u64::MAX),
    ] {
        let mut f = Fixture::new();
        f.claims[8] = value;
        assert!(MigrationSourceWitness::decode(&f.bytes()).is_err());
    }
}

#[test]
fn malformed_nested_or_huge_declared_lengths_refuse_without_container_decode() {
    for bytes in [
        vec![0; MAX_WITNESS_BYTES + 1],
        vec![0x9b, 255, 255, 255, 255, 255, 255, 255, 255],
        vec![0x84, 1, 0x5b, 255, 255, 255, 255, 255, 255, 255, 255],
    ] {
        assert!(MigrationSourceWitness::decode(&bytes).is_err());
    }
    let f = Fixture::new();
    let bytes = envelope_edit(&f, |a| a[1] = Cbor::Bytes(vec![0x8a, 1, 0x8a, 0x8a, 0x8a]));
    assert!(MigrationSourceWitness::decode(&bytes).is_err());
    // Noncanonical integer head in epoch and outer-array head.
    let bytes = envelope_edit(&f, |a| {
        let Cbor::Bytes(raw) = &mut a[1] else {
            unreachable!()
        };
        raw.splice(36..37, [0x18, 7]);
    });
    assert!(MigrationSourceWitness::decode(&bytes).is_err());
    let mut bytes = f.bytes();
    bytes.splice(0..1, [0x98, 4]);
    assert!(MigrationSourceWitness::decode(&bytes).is_err());
}

#[test]
fn independent_connect_codec_vector_matches_native_domain_certificate_and_max_wake() {
    // Copied verbatim from an independent PUBLIC synthetic fixture, not generated
    // with this decoder or its test encoder. No native/provider integration.
    let json = include_str!("fixtures/migration-source-witness-v1.json");
    let field = |name: &str| {
        let prefix = format!("\"{name}\": \"");
        let tail = json.split_once(&prefix).unwrap().1;
        tail.split_once('"').unwrap().0
    };
    let unhex = |s: &str| {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect::<Vec<_>>()
    };
    let root = DeviceSigner::from_seed(&[0x31; 32]);
    let cp = DeviceSigner::from_seed(&[0x32; 32]);
    assert_eq!(root.public().as_slice(), unhex(field("rootPublicKeyHex")));
    assert_eq!(cp.public().as_slice(), unhex(field("policyPublicKeyHex")));
    let raw = unhex(field("witnessHex"));
    let w = MigrationSourceWitness::decode(&raw).unwrap();
    let root_id = key_id(&root.public());
    let pins = PolicyPins {
        roots: vec![RootPin {
            root_id,
            root_pk: B32(root.public()),
        }],
        policy_keys: vec![PolicyKeyPin {
            key_id: key_id(&cp.public()),
            policy_pk: B32(cp.public()),
            root_id,
        }],
    };
    assert_eq!(w.digest.0.as_slice(), unhex(field("digestHex")));
    assert_eq!(w.cert.to_bytes().unwrap(), unhex(field("certificateHex")));
    assert_eq!(w.signature.0.as_slice(), unhex(field("signatureHex")));
    assert_eq!(h(DOMAIN, &unhex(field("claimsHex"))), w.digest);
    assert_eq!(w.claims().wake, u64::MAX);
    assert_eq!(w.claims().epoch, 2);
    assert_eq!(w.claims().source_head, 42);
    assert_eq!(w.claims().started_at_ms, 1_791_099_999_000);
    let now = field("verifyAtMs").parse::<i64>().unwrap();
    assert!(
        w.verify_for_root(&pins, root_id, B32(root.public()), now)
            .is_ok()
    );
    assert!(
        w.verify_for_root(&pins, root_id, B32(root.public()), w.claims().expires_at_ms)
            .is_err()
    );
}

#[test]
fn every_truncated_prefix_and_trailing_input_refuses() {
    let f = Fixture::new();
    let bytes = f.bytes();
    for n in 0..bytes.len() {
        assert!(
            MigrationSourceWitness::decode(&bytes[..n]).is_err(),
            "prefix {n}"
        );
    }
    let mut bytes = bytes;
    bytes.push(0);
    assert!(MigrationSourceWitness::decode(&bytes).is_err());
}
