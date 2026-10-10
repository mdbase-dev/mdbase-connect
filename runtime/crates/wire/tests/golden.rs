//! Golden byte fixtures in `conformance/wire/` (docs/contracts/00-overview.md §8).
//!
//! For every positive fixture: the typed value encodes to the checked-in
//! `<case>.cbor`, the bytes pass the profile validator, decode→encode reproduces
//! them, and the `.diag` / `.json` renderings match. Every `<case>.bad.cbor` is
//! rejected. Regenerate with `MDBN_BLESS_WIRE=1 cargo test -p mdbn-wire --test golden`.
//!
//! Integration tests are not portable code: they read and write fixture files.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use mdbn_wire::cbor;
use mdbn_wire::common::B16;
use mdbn_wire::envelope::{Item, item_chain_hash};
use mdbn_wire::fixtures::{all, negative, unknown_key_cases};
use mdbn_wire::policy::{PolicyOp, PolicyPayload};
use mdbn_wire::render::{annotated, hex, json};
use mdbn_wire::schema::Wire;

fn root() -> PathBuf {
    std::env::var_os("MDBN_REPO_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .join("conformance/wire")
}

fn bless() -> bool {
    std::env::var_os("MDBN_BLESS_WIRE").is_some()
}

/// Write (bless) or compare one file; returns a mismatch description.
fn check(path: &Path, want: &[u8], problems: &mut Vec<String>) {
    if bless() {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, want).unwrap();
        return;
    }
    match fs::read(path) {
        Ok(have) if have == want => {}
        Ok(_) => problems.push(format!(
            "{} differs (re-bless if the change is intended)",
            path.display()
        )),
        Err(_) => problems.push(format!(
            "{} is missing (run with MDBN_BLESS_WIRE=1)",
            path.display()
        )),
    }
}

/// Collection and position for the `root-handover` consent digest vectors.
const DIGEST_COLLECTION: [u8; 16] = [
    0x4c, 0x18, 0xaf, 0x2e, 0xb0, 0x4a, 0x4b, 0x77, 0xb8, 0x3e, 0x49, 0x3c, 0x36, 0x95, 0x96, 0x2e,
];
const DIGEST_SEQ: u64 = 7;

/// The digests signers produce for a policy payload: the certificate, and each
/// `cp-key-revoke` and `root-handover` op (the latter at collection 4c18af2e…, seq 7).
/// Other implementations (Connect's TS signer) pin to these.
fn policy_digests(bytes: &[u8]) -> String {
    let p = PolicyPayload::from_bytes(bytes).expect("policy fixture decodes");
    let mut out = format!(
        "cert_signed_digest: {}\n",
        p.cert.signed_digest().unwrap().to_hex()
    );
    for (i, op) in p.ops.iter().enumerate() {
        match op {
            PolicyOp::CpKeyRevoke(r) => out.push_str(&format!(
                "op{i} cp_key_revoke_digest: {}\n",
                r.signed_digest().unwrap().to_hex()
            )),
            PolicyOp::RootHandover(r) => out.push_str(&format!(
                "op{i} root_handover_consent_digest (seq {DIGEST_SEQ}): {}\n",
                r.consent_digest(&B16(DIGEST_COLLECTION), DIGEST_SEQ)
                    .to_hex()
            )),
            _ => {}
        }
    }
    out
}

fn item_hashes(bytes: &[u8]) -> String {
    let item = Item::from_bytes(bytes).expect("item fixture decodes");
    item.check_shape()
        .expect("item fixture has the right shape for its kind");
    format!(
        "aad: {}\nsigned_digest: {}\nchain_hash: {}\n",
        hex(&item.aad().unwrap()),
        item.signed_digest().unwrap().to_hex(),
        item_chain_hash(bytes).to_hex()
    )
}

#[test]
fn golden_fixtures() {
    let dir = root();
    let mut problems = Vec::new();
    let mut seen = BTreeSet::new();
    for f in all() {
        assert!(
            seen.insert((f.format, f.name)),
            "duplicate fixture {}/{}",
            f.format,
            f.name
        );
        let ctx = format!("{}/{}", f.format, f.name);
        cbor::validate(&f.bytes).unwrap_or_else(|e| panic!("{ctx}: not mdb-cbor/1: {e}"));
        let again = (f.roundtrip)(&f.bytes).unwrap_or_else(|e| panic!("{ctx}: decode failed: {e}"));
        assert_eq!(
            again, f.bytes,
            "{ctx}: decode then encode changed the bytes"
        );
        let file = |ext: &str| dir.join(f.format).join(format!("{}.{ext}", f.name));
        check(&file("cbor"), &f.bytes, &mut problems);
        check(&file("diag"), annotated(&f.ann).as_bytes(), &mut problems);
        check(&file("json"), json(&f.ann).as_bytes(), &mut problems);
        if f.format == "item" {
            check(
                &file("hashes.txt"),
                item_hashes(&f.bytes).as_bytes(),
                &mut problems,
            );
        }
        if f.format == "policy" {
            check(
                &file("digests.txt"),
                policy_digests(&f.bytes).as_bytes(),
                &mut problems,
            );
        }
    }
    for b in negative() {
        let ctx = format!("{}/{}", b.format, b.name);
        assert!(
            (b.decode)(&b.bytes).is_err(),
            "{ctx}: must be rejected ({})",
            b.why
        );
        let file = |ext: &str| dir.join(b.format).join(format!("{}.bad.{ext}", b.name));
        check(&file("cbor"), &b.bytes, &mut problems);
        check(
            &file("txt"),
            format!("{}\n", b.why).as_bytes(),
            &mut problems,
        );
    }
    assert!(
        problems.is_empty(),
        "fixture problems:\n{}",
        problems.join("\n")
    );
}

#[test]
fn every_checked_in_file_has_a_generator() {
    if bless() {
        return;
    }
    let mut expected = BTreeSet::new();
    for f in all() {
        for ext in ["cbor", "diag", "json"] {
            expected.insert(format!("{}/{}.{ext}", f.format, f.name));
        }
        if f.format == "item" {
            expected.insert(format!("{}/{}.hashes.txt", f.format, f.name));
        }
        if f.format == "policy" {
            expected.insert(format!("{}/{}.digests.txt", f.format, f.name));
        }
    }
    for b in negative() {
        expected.insert(format!("{}/{}.bad.cbor", b.format, b.name));
        expected.insert(format!("{}/{}.bad.txt", b.format, b.name));
    }
    let dir = root();
    for fmt in fs::read_dir(&dir).unwrap() {
        let fmt = fmt.unwrap().path();
        if !fmt.is_dir() {
            continue;
        }
        for file in fs::read_dir(&fmt).unwrap() {
            let file = file.unwrap().path();
            let rel = file
                .strip_prefix(&dir)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            assert!(
                expected.contains(&rel),
                "stale fixture {rel}: no generator produces it"
            );
        }
    }
}

#[test]
fn unknown_struct_keys_are_ignored() {
    for (name, bytes, rt) in unknown_key_cases() {
        cbor::validate(&bytes).unwrap();
        let again =
            rt(&bytes).unwrap_or_else(|e| panic!("{name}: unknown key must be ignored: {e}"));
        assert!(
            again.len() < bytes.len(),
            "{name}: re-encoding drops the unknown key"
        );
    }
}

#[test]
fn reencoding_any_fixture_value_is_stable() {
    // Encoding is a pure function of the value: twice gives the same bytes.
    for f in all() {
        let once = (f.roundtrip)(&f.bytes).unwrap();
        let twice = (f.roundtrip)(&once).unwrap();
        assert_eq!(once, twice, "{}/{}", f.format, f.name);
    }
}
