//! Actual build CLI qualification on PUBLIC SYNTHETIC fixtures only.
//! No network, operational signing, credentials or production assets.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use sha2::Digest;

struct Fixture(PathBuf);
impl Fixture {
    fn new(tag: &str) -> Self {
        let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("trust-cli-{tag}-{}", std::process::id()));
        std::fs::create_dir(&path).unwrap(); // exclusive: never deletes another fixture
        Self(path)
    }
    fn write(&self, bytes: &[u8]) -> PathBuf {
        let path = self.0.join("asset.json");
        std::fs::write(&path, bytes).unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn vector() -> Vec<u8> {
    let value: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/next-trust.v1.json")).unwrap();
    value["canonical_utf8"]
        .as_str()
        .unwrap()
        .as_bytes()
        .to_vec()
}

fn args(path: &Path, bytes: &[u8]) -> Vec<String> {
    [
        "verify".into(),
        "--asset".into(),
        path.display().to_string(),
        "--sha256".into(),
        mdbn_trust::hex(&sha2::Sha256::digest(bytes)),
        "--environment".into(),
        "lab".into(),
        "--cp-origin".into(),
        "https://cp.example.test".into(),
        "--log-origin".into(),
        "https://log.example.test".into(),
        "--source-commit".into(),
        "a".repeat(40),
        "--source-version".into(),
        "0.0.0-synthetic".into(),
        "--now-ms".into(),
        "10000".into(),
    ]
    .into()
}

fn run(args: &[String]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_mdbn-trust"))
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn valid_synthetic_asset_emits_one_normalized_line() {
    let fixture = Fixture::new("valid");
    let bytes = vector();
    let output = run(&args(&fixture.write(&bytes), &bytes));
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).unwrap();
    assert_eq!(text.lines().count(), 1);
    let normalized: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(normalized["schema"], "mdbn-trust/normalized/1");
}

#[test]
fn every_duplicate_flag_refuses_before_asset_io() {
    let fixture = Fixture::new("duplicate-flags");
    let bytes = vector();
    // Deliberately nonexistent: usage must fail before file IO, not read-error1.
    let input = args(&fixture.0.join("absent.json"), &bytes);
    for pair in input[1..].chunks_exact(2) {
        for second in [pair[1].clone(), "different".into()] {
            let mut duplicated = input.clone();
            duplicated.extend([pair[0].clone(), second]);
            let output = run(&duplicated);
            assert_eq!(output.status.code(), Some(2), "flag {}", pair[0]);
            assert!(output.stdout.is_empty());
        }
    }
}

#[test]
fn oversized_asset_refuses_before_json_or_hash_validation() {
    let fixture = Fixture::new("oversized");
    let bytes = vec![b'x'; mdbn_trust::MAX_BYTES * 16];
    let output = run(&args(&fixture.write(&bytes), &bytes));
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("exceeds byte bound"));
}

#[test]
fn duplicate_json_field_with_matching_digest_is_refused() {
    let fixture = Fixture::new("duplicate-json");
    let text = String::from_utf8(vector()).unwrap();
    let bytes = text
        .replace(
            "\"schema_version\":1",
            "\"schema_version\":1,\"schema_version\":1",
        )
        .into_bytes();
    assert_ne!(bytes, text.as_bytes());
    let output = run(&args(&fixture.write(&bytes), &bytes));
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
}
