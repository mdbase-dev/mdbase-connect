//! Crypto layer tests: round trips, tamper detection, RFC 9180 vectors, strict
//! Ed25519, rekey/key-grant, recovery key, blobs.

use std::collections::BTreeMap;

use crate::crypto::blob::{
    MAX_PARTS, check_blob, open_part, part_addresses, seal_blob, validate_blob_ref,
};
use crate::crypto::hpke::{self, KemKeyPair};
use crate::crypto::keys::{
    EnrolledKeys, Keyring, Recipient, RekeyOpened, Reveal, SasApprover, SasCommitter,
    StreamPurpose, build_key_grant, build_rekey, idem_key, idem_token, key_commit, open_key_grant,
    open_rekey, sas_code, sas_commit, sas_matches, stream_id, verify_history,
};
use crate::crypto::raw::{aad_from_bytes, signed_digest_from_bytes, verify_item_bytes};
use crate::crypto::recovery::{RECOVERY_NOISE_PK, RecoveryKey, import_recovery_key};
use crate::crypto::seal::{
    SEGMENT_CT, open_item_body, open_with_salt, padme, seal_item_body, seal_with_salt,
};
use crate::crypto::sign::{DeviceSigner, Ed25519Verifier, seal_and_sign, verify_item};
use crate::crypto::{CryptoError, Secret32, TestEntropy};
use mdbn_wire::common::{B16, B32, Bytes};
use mdbn_wire::envelope::{Item, ItemKind, RekeyReason};
use mdbn_wire::schema::Wire;

fn hex(s: &str) -> Vec<u8> {
    let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn arr32(s: &str) -> [u8; 32] {
    hex(s).try_into().unwrap()
}

const COL: B16 = B16([7; 16]);
const KEY: [u8; 32] = [42; 32];

fn header() -> Item {
    Item {
        kind: ItemKind::Entry,
        collection: COL,
        seq: Some(5),
        prev: Some(B32([1; 32])),
        epoch: Some(1),
        signer: Some(B16([2; 16])),
        salt: None,
        idem: Some(B16([3; 16])),
        refs: None,
        stream: None,
        body: Bytes::default(),
        sig: None,
    }
}

/// Bytes that don't compress (a hash stream).
fn noise(n: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(n);
    let mut i = 0u64;
    while out.len() < n {
        out.extend_from_slice(&mdbn_wire::hash::sha256(&i.to_be_bytes()).0);
        i += 1;
    }
    out.truncate(n);
    out
}

#[test]
fn padme_values() {
    for (l, p) in [
        (0, 0),
        (1, 1),
        (2, 2),
        (9, 10),
        (100, 104),
        (1000, 1024),
        (65_545, 67_584),
    ] {
        assert_eq!(padme(l), p, "padme({l})");
    }
    for l in 2..5000u64 {
        let p = padme(l);
        assert!(
            p >= l && p * 100 <= l * 113 + 100,
            "padme({l}) = {p} overhead"
        );
    }
}

#[test]
fn seal_round_trips() {
    let text = "hello world\n".repeat(10_000);
    let cases: Vec<(Vec<u8>, bool)> = vec![
        (vec![], true),
        (b"x".to_vec(), true),
        (text.clone().into_bytes(), true),
        (text.into_bytes(), false),
        (noise(65_536 * 2 + 3), true),
        (noise(65_536 - 9), false),
    ];
    let mut e = TestEntropy::new(1);
    for (plain, compress) in cases {
        let mut item = header();
        seal_item_body(&KEY, &mut item, &plain, compress, &mut e).unwrap();
        assert!(item.salt.is_some());
        assert_eq!(open_item_body(&KEY, &item).unwrap(), plain);
    }
}

#[test]
fn compression_shrinks_text() {
    let text = "the same line again\n".repeat(1000);
    let mut e = TestEntropy::new(1);
    let a = seal_with_salt(&KEY, &[0; 16], b"", text.as_bytes(), true).unwrap();
    let b = seal_with_salt(&KEY, &[0; 16], b"", text.as_bytes(), false).unwrap();
    assert!(a.len() * 10 < b.len());
    let _ = &mut e;
}

#[test]
fn seal_is_deterministic_given_entropy() {
    let run = || {
        let mut e = TestEntropy::new(9);
        let mut item = header();
        seal_item_body(&KEY, &mut item, b"payload", true, &mut e).unwrap();
        item.to_bytes().unwrap()
    };
    assert_eq!(run(), run());
}

#[test]
fn tampering_fails_to_open() {
    let plain = noise(65_536 * 3);
    let mut e = TestEntropy::new(2);
    let mut item = header();
    seal_item_body(&KEY, &mut item, &plain, false, &mut e).unwrap();
    let body = item.body.0.clone();
    assert!(body.len() > 3 * SEGMENT_CT);

    // Header fields are bound by the AAD.
    for f in [
        |i: &mut Item| i.seq = Some(6),
        |i: &mut Item| i.prev = Some(B32([9; 32])),
        |i: &mut Item| i.epoch = Some(2),
        |i: &mut Item| i.kind = ItemKind::Base,
        |i: &mut Item| i.collection = B16([8; 16]),
        |i: &mut Item| i.idem = Some(B16([4; 16])),
        |i: &mut Item| i.refs = Some(vec![B32([5; 32])]),
    ] {
        let mut t = item.clone();
        f(&mut t);
        assert_eq!(open_item_body(&KEY, &t), Err(CryptoError::Open));
    }
    let mut t = item.clone();
    t.salt = Some(B16([0; 16]));
    assert!(open_item_body(&KEY, &t).is_err(), "salt");
    assert!(open_item_body(&[0; 32], &item).is_err(), "wrong key");

    let aad = item.aad().unwrap();
    let salt = item.salt.unwrap().0;
    let opens = |b: &[u8]| open_with_salt(&KEY, &salt, &aad, b);
    assert!(opens(&body).is_ok());
    // A flipped bit.
    let mut b = body.clone();
    b[100] ^= 1;
    assert!(opens(&b).is_err(), "bit flip");
    // Swapped segments.
    let mut b = body.clone();
    let (s0, s1) = b.split_at_mut(SEGMENT_CT);
    s0.swap_with_slice(&mut s1[..SEGMENT_CT]);
    assert!(opens(&b).is_err(), "reordered segments");
    // Truncated: the last segment dropped (the new last lacks the final flag).
    let n = body.len().div_ceil(SEGMENT_CT);
    assert!(
        opens(&body[..(n - 1) * SEGMENT_CT]).is_err(),
        "dropped final segment"
    );
    // Truncated inside a segment, and empty.
    assert!(opens(&body[..body.len() - 1]).is_err(), "short tail");
    assert!(opens(&[]).is_err(), "empty");
    // Extended with a copy of a segment.
    let mut b = body.clone();
    b.extend_from_slice(&body[..SEGMENT_CT]);
    assert!(opens(&b).is_err(), "appended segment");
}

#[test]
fn hpke_rfc9180_a21() {
    let info = hex("4f6465206f6e2061204772656369616e2055726e");
    let eph = KemKeyPair::derive(&hex(
        "909a9b35d3dc4713a5e72a4da274b55d3d3821a37e5d099e74a647db583a904b",
    ));
    assert_eq!(
        eph.pk,
        arr32("1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a")
    );
    assert_eq!(
        eph.secret().expose(),
        &arr32("f4ec9b33b792c372c1d2c2063507b684ef925b8c75a42dbcbf57d63ccd381600")
    );
    let r = KemKeyPair::derive(&hex(
        "1ac01f181fdf9f352797655161c58b75c656a6cc2716dcb66372da835542e1df",
    ));
    assert_eq!(
        r.pk,
        arr32("4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a")
    );
    assert_eq!(
        r.secret().expose(),
        &arr32("8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb")
    );
    let pt = hex("4265617574792069732074727574682c20747275746820626561757479");
    let aad = hex("436f756e742d30");
    let (enc, ct) = hpke::seal_with_ephemeral(&eph, &r.pk, &info, &aad, &pt).unwrap();
    assert_eq!(enc, eph.pk);
    assert_eq!(
        ct,
        hex(
            "1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db
             21993c62ce81883d2dd1b51a28"
        )
    );
    assert_eq!(*hpke::open(&r, &enc, &info, &aad, &ct).unwrap(), pt);
    assert!(hpke::open(&r, &enc, b"other info", &aad, &ct).is_err());
    // A small-order peer key gives an all-zero DH: rejected.
    assert_eq!(
        hpke::seal_with_ephemeral(&eph, &[0; 32], &info, &aad, &pt),
        Err(CryptoError::Key)
    );
}

#[test]
fn ed25519_sign_and_strict_verify() {
    let mut e = TestEntropy::new(3);
    let signer = DeviceSigner::generate(&mut e);
    let (item, _) = seal_and_sign(&KEY, header(), b"p", true, &signer, &mut e).unwrap();
    assert!(verify_item(&signer.public(), &item));
    let mut t = item.clone();
    t.seq = Some(99);
    assert!(!verify_item(&signer.public(), &t), "header covered");
    let mut t = item.clone();
    t.body.0[0] ^= 1;
    assert!(!verify_item(&signer.public(), &t), "ciphertext covered");
    let other = DeviceSigner::generate(&mut e);
    assert!(!verify_item(&other.public(), &item));

    let v = Ed25519Verifier;
    let d = [5u8; 32];
    let sig = signer.sign_digest(&d);
    assert!(v.verify(&signer.public(), &d, &sig));
    // S >= L.
    let mut bad = sig;
    let l = hex("edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010");
    bad[32..].copy_from_slice(&l);
    assert!(!v.verify(&signer.public(), &d, &bad), "S = L");
    // Small-order A (the identity) with a trivially "valid" signature R = identity, S = 0.
    let mut ident = [0u8; 32];
    ident[0] = 1;
    let mut s0 = [0u8; 64];
    s0[..32].copy_from_slice(&ident);
    assert!(!v.verify(&ident, &d, &s0), "small-order A");
    // Non-canonical A: y = p + 1 encodes the same point as y = 1.
    let mut nc = [0xffu8; 32];
    nc[0] = 0xee;
    nc[31] = 0x7f;
    assert!(!v.verify(&nc, &d, &s0), "non-canonical A");
    // Small-order R.
    let mut r_small = sig;
    r_small[..32].copy_from_slice(&ident);
    assert!(!v.verify(&signer.public(), &d, &r_small), "small-order R");
}

fn device(n: u8, e: &mut TestEntropy) -> (B16, KemKeyPair) {
    (B16([n; 16]), KemKeyPair::generate(e))
}

#[test]
fn rekey_and_key_grant() {
    let mut e = TestEntropy::new(4);
    let (a, ka) = device(1, &mut e);
    let (b, kb) = device(2, &mut e);
    let (c, kc) = device(3, &mut e);
    let mut held = Keyring::new();
    held.insert(1, Secret32([11; 32]));
    held.insert(2, Secret32([22; 32]));
    let mut commits = BTreeMap::new();
    commits.insert(1, B32(key_commit(&Secret32([11; 32]), &COL, 1).unwrap()));
    commits.insert(2, B32(key_commit(&Secret32([22; 32]), &COL, 2).unwrap()));
    let recips = [
        Recipient {
            device: b,
            kem_pk: kb.pk,
        },
        Recipient {
            device: a,
            kem_pk: ka.pk,
        },
    ];
    let (p, key) =
        build_rekey(&COL, 2, &held, &recips, RekeyReason::DeviceRevoked, &mut e).unwrap();
    assert_eq!((p.epoch, p.from), (3, 2));
    assert_eq!(
        p.wraps.iter().map(|w| w.device).collect::<Vec<_>>(),
        vec![a, b],
        "sorted"
    );
    assert_eq!(p.wraps[0].ct.0.len(), 48);
    match open_rekey(&p, &COL, &b, &kb).unwrap() {
        RekeyOpened::Keys { key: k, history } => {
            assert_eq!(k, key);
            assert_eq!(history.len(), 2);
            let ok = verify_history(history, &COL, &commits).unwrap();
            assert_eq!(ok[1], (2, Secret32([22; 32])));
        }
        other => panic!("{other:?}"),
    }
    // History keys that don't match their epochs' commitments are refused.
    let RekeyOpened::Keys { history, .. } = open_rekey(&p, &COL, &a, &ka).unwrap() else {
        panic!()
    };
    let mut wrong = commits.clone();
    wrong.insert(1, B32([0; 32]));
    assert_eq!(
        verify_history(history, &COL, &wrong).unwrap_err(),
        CryptoError::KeyInconsistent
    );
    let RekeyOpened::Keys { history, .. } = open_rekey(&p, &COL, &a, &ka).unwrap() else {
        panic!()
    };
    let mut missing = commits.clone();
    missing.remove(&2);
    assert!(
        verify_history(history, &COL, &missing).is_err(),
        "unknown epoch"
    );

    assert!(matches!(
        open_rekey(&p, &COL, &c, &kc).unwrap(),
        RekeyOpened::NotARecipient
    ));
    let mut bad = p.clone();
    bad.commit = B32([0; 32]);
    assert!(matches!(
        open_rekey(&bad, &COL, &a, &ka).unwrap(),
        RekeyOpened::Inconsistent
    ));
    assert!(
        open_rekey(&p, &B16([9; 16]), &a, &ka).is_err(),
        "wrong collection"
    );
    // Epochs beyond u32 are rejected, not truncated.
    assert!(
        build_rekey(
            &COL,
            u64::from(u32::MAX),
            &held,
            &recips,
            RekeyReason::Scheduled,
            &mut e
        )
        .is_err()
    );

    let rc = Recipient {
        device: c,
        kem_pk: kc.pk,
    };
    let g = build_key_grant(&COL, 3, &key, &rc, &mut e).unwrap();
    assert_eq!(open_key_grant(&g, &COL, &kc, &p.commit).unwrap(), key);
    assert!(
        open_key_grant(&g, &COL, &ka, &p.commit).is_err(),
        "wrong recipient key"
    );
    let forged = build_key_grant(&COL, 3, &Secret32([77; 32]), &rc, &mut e).unwrap();
    assert_eq!(
        open_key_grant(&forged, &COL, &kc, &p.commit),
        Err(CryptoError::KeyInconsistent)
    );
}

#[test]
fn keyring_round_trip() {
    let mut k = Keyring::new();
    k.insert(1, Secret32([1; 32]));
    k.insert(3, Secret32([3; 32]));
    let back = Keyring::from_bytes(&k.to_bytes()).unwrap();
    assert_eq!(back.get(3), Some(&Secret32([3; 32])));
    assert_eq!(back.latest().unwrap().0, 3);
}

/// The shared recovery-key vector (`conformance/crypto/recovery-key/`), also checked
/// by the TS Obsidian runtime.
const RECOVERY_VECTOR: &str =
    include_str!("../../../../conformance/crypto/recovery-key/vector-1.json");

fn json_str<'a>(v: &'a serde_json::Value, k: &str) -> &'a str {
    v[k].as_str().unwrap()
}

#[test]
fn recovery_key_shared_vector() {
    let v: serde_json::Value = serde_json::from_str(RECOVERY_VECTOR).unwrap();
    let secret: [u8; 32] = arr32(json_str(&v, "secret"));
    let col = B16(hex(&json_str(&v, "collection").replace('-', ""))
        .try_into()
        .unwrap());
    let r = RecoveryKey::from_bytes(secret);
    assert_eq!(r.to_text().as_str(), json_str(&v, "text"));
    assert_eq!(RecoveryKey::from_text(json_str(&v, "text")).unwrap(), r);
    for alt in v["also_parses"].as_array().unwrap() {
        assert_eq!(
            RecoveryKey::from_text(alt.as_str().unwrap()).unwrap(),
            r,
            "{alt}"
        );
    }
    for bad in v["rejects"].as_array().unwrap() {
        assert!(
            RecoveryKey::from_text(bad.as_str().unwrap()).is_err(),
            "{bad}"
        );
    }
    let k = r.derive(&col);
    assert_eq!(k.signer.public(), arr32(json_str(&v, "sign_pk")));
    assert_eq!(k.kem.pk, arr32(json_str(&v, "kem_pk")));
    assert_eq!(
        k.device.0.to_vec(),
        hex(&json_str(&v, "device").replace('-', ""))
    );
}

#[test]
fn recovery_key() {
    let mut e = TestEntropy::new(5);
    let r = RecoveryKey::generate(&mut e);
    let text = r.to_text();
    assert!(text.starts_with("MDB1-"));
    assert_eq!(text.chars().filter(|c| *c != '-').count(), 4 + 55);
    assert_eq!(RecoveryKey::from_text(&text).unwrap(), r);
    assert_eq!(
        RecoveryKey::from_text(&text.to_lowercase()).unwrap(),
        r,
        "case-insensitive"
    );
    let mut typo: Vec<char> = text.chars().collect();
    typo[10] = if typo[10] == 'A' { 'B' } else { 'A' };
    let typo: String = typo.into_iter().collect();
    assert_eq!(RecoveryKey::from_text(&typo), Err(CryptoError::Encoding));
    assert!(RecoveryKey::from_text("MDB1-ABC").is_err());

    // Per-collection keys: one paper key gives unlinkable devices per collection.
    let keys = import_recovery_key(&text, &COL).unwrap();
    let other = r.derive(&B16([8; 16]));
    assert_ne!(keys.signer.public(), other.signer.public());
    assert_ne!(keys.kem.pk, other.kem.pk);
    assert_ne!(keys.device, other.device);
    let again = r.derive(&COL);
    let ok = |d: &B16, s: &[u8; 32], k: &[u8; 32], n: &[u8; 32]| keys.matches_enrolment(d, s, k, n);
    assert!(ok(
        &again.device,
        &again.signer.public(),
        &again.kem.pk,
        &RECOVERY_NOISE_PK
    ));
    assert!(
        !ok(
            &again.device,
            &again.signer.public(),
            &[1; 32],
            &RECOVERY_NOISE_PK
        ),
        "substituted kem_pk"
    );
    assert!(
        !ok(
            &B16([1; 16]),
            &again.signer.public(),
            &again.kem.pk,
            &RECOVERY_NOISE_PK
        ),
        "other ID"
    );
    assert!(
        !ok(
            &again.device,
            &again.signer.public(),
            &again.kem.pk,
            &[1; 32]
        ),
        "non-zero noise_pk"
    );

    // The derived device opens a rekey wrapped for it.
    let (p, key) = build_rekey(
        &COL,
        0,
        &Keyring::new(),
        &[Recipient {
            device: keys.device,
            kem_pk: keys.kem.pk,
        }],
        RekeyReason::Initial,
        &mut e,
    )
    .unwrap();
    match open_rekey(&p, &COL, &keys.device, &keys.kem).unwrap() {
        RekeyOpened::Keys { key: k, .. } => assert_eq!(k, key),
        other => panic!("{other:?}"),
    }
}

fn uuid(s: &str) -> B16 {
    B16(hex(&s.replace('-', "")).try_into().unwrap())
}

/// Keys from `sasProtocol.test.ts` vectors.
fn sas_parties() -> (B16, EnrolledKeys, EnrolledKeys) {
    let col = uuid("0f8e3c3a-7d2b-4c55-9d7e-0b6f3d2a1c11");
    let a = EnrolledKeys {
        device: uuid("11111111-2222-4333-8444-555555555555"),
        sign_pk: [0xa1; 32],
        kem_pk: [0; 32],
        noise_pk: [0; 32],
    };
    let n = EnrolledKeys {
        device: uuid("4b1d2e3f-5a6b-4c7d-8e9f-a0b1c2d3e4f5"),
        sign_pk: [0xb1; 32],
        kem_pk: [0xb2; 32],
        noise_pk: [0xb3; 32],
    };
    (col, a, n)
}

const SAS_VECTOR: &str = include_str!("../../../../conformance/crypto/sas/vector-1.json");

#[test]
fn sas_matches_ts_vectors() {
    let v: serde_json::Value = serde_json::from_str(SAS_VECTOR).unwrap();
    let (col, a, n) = sas_parties();
    assert_eq!(col, uuid(json_str(&v, "collection")));
    assert_eq!(n.device, uuid(json_str(&v["new_device"], "device")));
    assert_eq!(a.device, uuid(json_str(&v["approver"], "device")));
    let r_a = arr32(json_str(&v, "r_a"));
    let r_n = arr32(json_str(&v, "r_n"));
    assert_eq!(
        sas_commit(&col, &n, &r_n).to_vec(),
        hex(json_str(&v, "sas_commit"))
    );
    assert_eq!(sas_code(&col, &a, &n, &r_a, &r_n), json_str(&v, "code"));
}

#[test]
fn sas_commit_then_reveal_once() {
    let mut e = TestEntropy::new(7);
    let (col, a, n) = sas_parties();
    let mut joiner = SasCommitter::new(&col, &n, &mut e);
    let logged = joiner.commitment();
    assert!(joiner.check_logged(&logged));
    assert!(!joiner.check_logged(&[0; 32]), "substituted commitment");
    let mut approver = SasApprover::new(logged);
    let r_a = approver.challenge(&mut e).unwrap();
    let Reveal::Reveal { r_n, code, state } = joiner.reveal(&col, &a, &n, &r_a) else {
        panic!()
    };
    assert_eq!(state.len(), 33);
    assert_eq!(state[32], 1, "persisted as revealed");
    assert_eq!(
        approver.on_reveal(&col, &a, &n, &r_n).as_deref(),
        Some(code.as_str())
    );
    assert!(sas_matches(
        &code,
        &format!(" {}-{} ", &code[..3], &code[3..])
    ));
    // Reveal at most once, also across a restart.
    assert_eq!(
        joiner.reveal(&col, &a, &n, &[9; 32]),
        Reveal::AlreadyRevealed
    );
    let restored = SasCommitter::restore(&col, &n, &state).unwrap();
    assert!(restored.is_revealed());
    assert_eq!(restored.commitment(), logged);
    let mut restored = restored;
    assert_eq!(
        restored.reveal(&col, &a, &n, &[9; 32]),
        Reveal::AlreadyRevealed
    );
    // A wrong r_N is refused, and three failures exhaust the commitment.
    let mut ap = SasApprover::new(logged);
    for _ in 0..3 {
        ap.challenge(&mut e).unwrap();
        assert!(ap.on_reveal(&col, &a, &n, &[2; 32]).is_none());
    }
    assert!(ap.exhausted());
    assert!(ap.challenge(&mut e).is_none());
}

#[test]
fn keyed_identifiers() {
    let k1 = Secret32([1; 32]);
    let ki = idem_key(&k1, &COL);
    let t = idem_token(&ki, &B16([3; 16]));
    assert_eq!(t, idem_token(&idem_key(&k1, &COL), &B16([3; 16])), "stable");
    assert_ne!(t, idem_token(&ki, &B16([4; 16])));
    assert_ne!(
        idem_key(&k1, &B16([8; 16])).expose(),
        ki.expose(),
        "collection-bound"
    );
    let r = B16([5; 16]);
    let ids = [
        StreamPurpose::Presence,
        StreamPurpose::Room,
        StreamPurpose::HeadWitness,
    ]
    .map(|p| stream_id(&k1, &COL, p, &r));
    assert!(ids[0] != ids[1] && ids[1] != ids[2] && ids[0] != ids[2]);
    assert_ne!(
        ids[0],
        stream_id(&Secret32([2; 32]), &COL, StreamPurpose::Presence, &r),
        "changes with the epoch"
    );
}

const MIB: u64 = 1 << 20;

#[test]
fn blobs() {
    let mut e = TestEntropy::new(6);
    let key = Secret32([9; 32]);
    let plain = noise(2 * MIB as usize + 20);
    let (r, parts) = seal_blob(&key, 1, &COL, &plain, MIB, false, &mut e).unwrap();
    assert_eq!(parts.len(), 3);
    let mut back = Vec::new();
    for (i, p) in parts.iter().enumerate() {
        back.extend(open_part(&key, &COL, &r, i as u64, &p.bytes).unwrap());
    }
    assert!(check_blob(&r, &back));
    assert!(!check_blob(&r, &back[..back.len() - 1]));
    // A part opened at the wrong index has the wrong length.
    assert!(open_part(&key, &COL, &r, 2, &parts[0].bytes).is_err());
    assert!(
        open_part(&key, &COL, &r, 3, &parts[0].bytes).is_err(),
        "no such part"
    );
    // Same content, same epoch key: same blob ID and addresses (dedup).
    let (r2, parts2) = seal_blob(&key, 1, &COL, &plain, MIB, true, &mut e).unwrap();
    assert_eq!(r2.blob_id, r.blob_id);
    assert_eq!(parts2[1].address, parts[1].address);
    assert_ne!(parts2[1].bytes, parts[1].bytes, "fresh salts");
    let (r3, _) = seal_blob(
        &Secret32([10; 32]),
        2,
        &COL,
        &plain[..10],
        MIB,
        true,
        &mut e,
    )
    .unwrap();
    assert_ne!(r3.blob_id, r.blob_id);
    let (re, pe) = seal_blob(&key, 1, &COL, &[], MIB, true, &mut e).unwrap();
    assert_eq!(pe.len(), 1, "the empty blob has one empty part");
    assert!(check_blob(
        &re,
        &open_part(&key, &COL, &re, 0, &pe[0].bytes).unwrap()
    ));
}

#[test]
fn hostile_blob_refs_are_refused_before_allocating() {
    let key = Secret32([9; 32]);
    let k_cid = crate::crypto::blob::content_key(&key, &COL);
    let mut r = mdbn_wire::intent::BlobRef {
        plain_hash: B32([0; 32]),
        size: 1 << 50,
        blob_id: B32([1; 32]),
        id_epoch: 1,
        part_size: 1,
    };
    assert!(validate_blob_ref(&r).is_err(), "part_size 1");
    assert!(part_addresses(&k_cid, &r).is_err());
    r.part_size = 32 * MIB;
    assert!(validate_blob_ref(&r).is_err(), "part_size over 16 MiB");
    r.part_size = 8 * MIB;
    assert!(validate_blob_ref(&r).is_err(), "too many parts");
    r.size = MAX_PARTS * 8 * MIB;
    assert!(validate_blob_ref(&r).is_ok());
    assert_eq!(part_addresses(&k_cid, &r).unwrap().len() as u64, MAX_PARTS);
    r.size += 1;
    assert!(validate_blob_ref(&r).is_err(), "one byte past the part cap");
    // A sealed part much larger than its declared length is refused before opening.
    r.size = 10;
    r.part_size = MIB;
    assert_eq!(
        open_part(&key, &COL, &r, 0, &vec![0u8; 4 * MIB as usize]),
        Err(CryptoError::TooLarge)
    );
}

#[test]
fn received_bytes_cover_unknown_fields() {
    use mdbn_wire::cbor::{self, Cbor};
    let mut e = TestEntropy::new(8);
    let signer = DeviceSigner::generate(&mut e);
    let (item, fin) = seal_and_sign(&KEY, header(), b"p", false, &signer, &mut e).unwrap();
    // Known items: received-bytes and struct computations agree.
    assert_eq!(aad_from_bytes(&fin.bytes).unwrap(), item.aad().unwrap());
    assert_eq!(
        signed_digest_from_bytes(&fin.bytes).unwrap(),
        item.signed_digest().unwrap().0
    );
    assert!(verify_item_bytes(&signer.public(), &fin.bytes));

    // A newer writer adds key 13 and signs over it.
    let mut c = item.to_cbor();
    let Cbor::Map(m) = &mut c else { panic!() };
    m.retain(|(k, _)| *k != Cbor::Uint(12));
    m.push((Cbor::Uint(13), Cbor::Text("future".into())));
    let unsigned = cbor::encode(&c).unwrap();
    let d = mdbn_wire::hash::h("mdbase/v1/item-sig", &unsigned).0;
    let sig = signer.sign_digest(&d);
    let Cbor::Map(m) = &mut c else { panic!() };
    let at = m.iter().position(|(k, _)| *k == Cbor::Uint(13)).unwrap();
    m.insert(at, (Cbor::Uint(12), Cbor::Bytes(sig.to_vec())));
    let raw = cbor::encode(&c).unwrap();
    assert!(
        verify_item_bytes(&signer.public(), &raw),
        "received bytes verify"
    );
    let decoded = Item::from_bytes(&raw).unwrap();
    assert!(
        !verify_item(&signer.public(), &decoded),
        "a re-encoding would void it"
    );
    // Truncated or non-map input is refused, never panics.
    assert!(aad_from_bytes(&raw[..raw.len() - 3]).is_err());
    assert!(aad_from_bytes(&[0x81, 0x00]).is_err());
}
