//! The public synthetic vector validates; deviations from authenticated context,
//! canonical form and certificates are refused.

use super::*;
use sha2::Digest;

const VECTOR: &str = include_str!("../tests/fixtures/next-trust.v1.json");

fn vector() -> (Vec<u8>, Context, u64) {
    let v: serde_json::Value = serde_json::from_str(VECTOR).unwrap();
    let bytes = v["canonical_utf8"].as_str().unwrap().as_bytes().to_vec();
    let p = &v["payload"];
    let ctx = Context {
        sha256: hex_exact(v["sha256"].as_str().unwrap(), "sha").unwrap(),
        environment: p["environment"].as_str().unwrap().into(),
        control_plane_origin: p["control_plane_origin"].as_str().unwrap().into(),
        log_origin: p["log_origin"].as_str().unwrap().into(),
        source: Source {
            repository: p["source"]["repository"].as_str().unwrap().into(),
            commit: p["source"]["commit"].as_str().unwrap().into(),
            version: p["source"]["version"].as_str().unwrap().into(),
        },
    };
    (bytes, ctx, p["issued_at"].as_u64().unwrap())
}

/// Re-hash edited bytes so only the edit is under test.
fn rehash(bytes: &[u8], ctx: &Context) -> Context {
    Context {
        sha256: sha2::Sha256::digest(bytes).into(),
        ..ctx.clone()
    }
}

#[test]
fn the_public_vector_validates_into_replica_pins() {
    let (bytes, ctx, issued) = vector();
    let t = verify(&bytes, &ctx, issued).unwrap();
    assert_eq!(t.environment, "lab");
    assert_eq!(t.cp_origin, "https://cp.example.test");
    assert_eq!(t.log_origin, "https://log.example.test");
    assert_eq!(t.roots.len(), 1);
    assert_eq!(t.policy_pins.policy_keys.len(), 1);
    assert_eq!(t.policy_pins.validate(), Ok(()));
    assert_eq!(
        hex(&t.policy_pins.policy_keys[0].key_id.0),
        "e37abcd79efd08db94518a903952ffe9"
    );
}

/// The normalized pins round-trip exactly, and only canonical, valid encodings
/// decode.
#[test]
fn normalized_pins_round_trip_and_refuse_anything_else() {
    let (bytes, ctx, issued) = vector();
    let trust = verify(&bytes, &ctx, issued).unwrap();
    let enc = policy_pins_cbor(&trust.policy_pins).unwrap();
    assert_eq!(policy_pins_from_cbor(&enc).unwrap(), trust.policy_pins);
    // [[[root_id, root_pk]], [[key_id, policy_pk, root_id]]]
    assert_eq!(&enc[..3], &[0x82, 0x81, 0x82]);
    for bad in [
        vec![],
        vec![0x80],
        enc[..enc.len() - 1].to_vec(),
        [enc.clone(), vec![0x00]].concat(),
        // Empty root or key lists.
        vec![0x82, 0x80, 0x80],
        vec![0u8; MAX_PINS_BYTES + 1],
    ] {
        assert!(policy_pins_from_cbor(&bad).is_err(), "{bad:?}");
    }
    // A key certified by an unpinned root is refused even if well-formed.
    let mut p = trust.policy_pins.clone();
    p.policy_keys[0].root_id = B16([0xee; 16]);
    assert!(policy_pins_cbor(&p).is_err());
}

#[test]
fn public_vector_normalized_json_is_canonical_and_complete() {
    let (bytes, ctx, issued) = vector();
    let trust = verify(&bytes, &ctx, issued).unwrap();
    let out = normalized_json(&trust, &ctx).unwrap();
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(serde_json::to_string(&v).unwrap(), out, "canonical");
    assert_eq!(v["schema"], "mdbn-trust/normalized/1");
    assert_eq!(v["asset_sha256"], hex(&ctx.sha256));
    assert_eq!(v["environment"], "lab");
    let pins = hex_decode(v["policy_pins_cbor_hex"].as_str().unwrap());
    assert_eq!(policy_pins_from_cbor(&pins).unwrap(), trust.policy_pins);
}

fn hex_decode(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

#[test]
fn the_authenticated_context_must_match() {
    let (bytes, ctx, issued) = vector();
    let mut wrong = ctx.clone();
    wrong.sha256[0] ^= 1;
    assert!(verify(&bytes, &wrong, issued).is_err(), "digest");
    for edit in [
        Context {
            environment: "staging".into(),
            ..ctx.clone()
        },
        Context {
            control_plane_origin: "https://cp.other.test".into(),
            ..ctx.clone()
        },
        Context {
            log_origin: "https://log.other.test".into(),
            ..ctx.clone()
        },
        Context {
            source: Source {
                commit: "b".repeat(40),
                ..ctx.source.clone()
            },
            ..ctx.clone()
        },
    ] {
        assert!(verify(&bytes, &edit, issued).is_err(), "{edit:?}");
    }
    assert!(
        verify(&bytes, &ctx, issued - 1).is_err(),
        "issued in the future"
    );
}

#[test]
fn non_canonical_or_tampered_bytes_are_refused() {
    let (bytes, ctx, issued) = vector();
    let text = String::from_utf8(bytes.clone()).unwrap();
    let pretty =
        serde_json::to_vec_pretty(&serde_json::from_str::<serde_json::Value>(&text).unwrap())
            .unwrap();
    let dup = text.replacen(
        "{\"control_plane_origin\"",
        "{\"schema_version\":1,\"control_plane_origin\"",
        1,
    );
    let unknown = text.replacen("\"schema_version\":1", "\"schema_version\":1,\"zz\":1", 1);
    let sig = {
        let i = text.find("\"signature\":\"").unwrap() + 13;
        let mut b = text.clone().into_bytes();
        b[i] = if b[i] == b'0' { b'1' } else { b'0' };
        String::from_utf8(b).unwrap()
    };
    let key_id = text.replacen(
        "e37abcd79efd08db94518a903952ffe9",
        "e37abcd79efd08db94518a903952ffe8",
        1,
    );
    let http = text.replace("https://log.example.test", "http://log.example.test");
    for edited in [
        pretty,
        dup.into_bytes(),
        unknown.into_bytes(),
        sig.into_bytes(),
        key_id.into_bytes(),
    ] {
        let c = rehash(&edited, &ctx);
        assert!(verify(&edited, &c, issued).is_err());
    }
    let mut c = rehash(http.as_bytes(), &ctx);
    c.log_origin = "http://log.example.test".into();
    assert!(
        verify(http.as_bytes(), &c, issued).is_err(),
        "http is never pinned"
    );
}
