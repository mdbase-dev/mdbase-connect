//! Actual offline history CLI, PUBLIC SYNTHETIC contexts/assets only.
//! No authenticated production ledger, network, operational signing or publication.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]
use mdbn_replica::crypto::sign::DeviceSigner;
use serde_json::{Value, json};
use sha2::Digest;
use std::path::PathBuf;
use std::process::{Command, Output};

struct Fixture(PathBuf);
impl Fixture {
    fn new(tag: &str) -> Self {
        let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("trust-history-{tag}-{}", std::process::id()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn asset(&self, name: &str, extra_root: bool) -> Value {
        let v: Value = serde_json::from_str(include_str!("fixtures/next-trust.v1.json")).unwrap();
        let mut payload = v["payload"].clone();
        let bytes = if extra_root {
            let pk = DeviceSigner::from_seed(&[0x43; 32]).public();
            payload["roots"].as_array_mut().unwrap().push(json!({"key_id":mdbn_trust::hex(&mdbn_replica::policy::key_id(&pk).0),"public_key":mdbn_trust::hex(&pk)}));
            payload["roots"]
                .as_array_mut()
                .unwrap()
                .sort_by(|a, b| a["key_id"].as_str().cmp(&b["key_id"].as_str()));
            serde_json::to_vec(&ordered(&payload)).unwrap()
        } else {
            v["canonical_utf8"].as_str().unwrap().as_bytes().to_vec()
        };
        std::fs::write(self.0.join(name), &bytes).unwrap();
        json!({"asset":name,"sha256":mdbn_trust::hex(&sha2::Sha256::digest(&bytes)),
            "control_plane_origin":payload["control_plane_origin"],"log_origin":payload["log_origin"],"source":payload["source"]})
    }
    fn ledger(&self) -> Value {
        let current = self.asset("current.json", false);
        json!({"schema":"mdbn-trust/history/1","environment":"lab","current":current.clone(),"history":[current]})
    }
    fn run_bytes(&self, bytes: &[u8], digest: Option<&str>) -> Output {
        let path = self.0.join("ledger.json");
        std::fs::write(&path, bytes).unwrap();
        let expected = digest
            .map(str::to_string)
            .unwrap_or_else(|| mdbn_trust::hex(&sha2::Sha256::digest(bytes)));
        Command::new(env!("CARGO_BIN_EXE_mdbn-trust-history"))
            .arg(path)
            .arg(expected)
            .output()
            .unwrap()
    }
    fn run(&self, ledger: &Value) -> Output {
        self.run_bytes(&serde_json::to_vec(ledger).unwrap(), None)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
fn ordered(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let sorted: std::collections::BTreeMap<_, _> =
                map.iter().map(|(k, v)| (k.clone(), ordered(v))).collect();
            Value::Object(sorted.into_iter().collect())
        }
        Value::Array(array) => Value::Array(array.iter().map(ordered).collect()),
        other => other.clone(),
    }
}
fn refused(output: Output) {
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
}

#[test]
fn malformed_arguments_refuse_before_any_file_io() {
    for args in [
        vec![],
        vec!["absent.json"],
        vec!["absent.json", "0", "extra"],
        vec![
            "-unknown",
            "0000000000000000000000000000000000000000000000000000000000000000",
        ],
        vec!["absent.json", "not-a-digest"],
        vec!["", "0"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_mdbn-trust-history"))
            .args(args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
    }
}
#[test]
fn oversized_asset_refuses_before_hash_or_payload_parse() {
    let fixture = Fixture::new("asset-bound");
    let ledger = fixture.ledger();
    std::fs::write(
        fixture.0.join("current.json"),
        vec![b'x'; mdbn_trust::MAX_BYTES + 1],
    )
    .unwrap();
    let output = fixture.run(&ledger);
    assert!(String::from_utf8_lossy(&output.stderr).contains("byte bound"));
    refused(output);
}
#[test]
fn expired_historical_certificates_still_verify_with_full_crypto_checks() {
    let fixture = Fixture::new("expired-history");
    let mut ledger = fixture.ledger();
    ledger["history"] = json!([fixture.asset("expired-history.json", false)]);
    let vector: Value = serde_json::from_str(include_str!("fixtures/next-trust.v1.json")).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    assert!(
        vector["payload"]["policy_keys"]
            .as_array()
            .unwrap()
            .iter()
            .all(|key| u128::from(key["certificate"]["not_after"].as_u64().unwrap()) < now)
    );
    let output = fixture.run(&ledger);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    // Expiry is not an excuse to bypass historical signature verification.
    let mut payload = vector["payload"].clone();
    payload["policy_keys"][0]["certificate"]["signature"] = json!("0".repeat(128));
    let forged = serde_json::to_vec(&ordered(&payload)).unwrap();
    std::fs::write(fixture.0.join("expired-history.json"), &forged).unwrap();
    ledger["history"][0]["sha256"] = json!(mdbn_trust::hex(&sha2::Sha256::digest(&forged)));
    refused(fixture.run(&ledger));
}
#[test]
fn all_assets_require_portable_normalized_relative_paths_before_io() {
    let fixture = Fixture::new("relative");
    let ledger = fixture.ledger();
    for path in [
        "",
        "/absolute.json",
        "../outside.json",
        "nested/../../outside.json",
        "./current.json",
        "nested//current.json",
        "nested/",
        "C:/absolute.json",
        "C:\\absolute.json",
        "\\\\server\\share\\asset.json",
        "bad\u{0000}path",
    ] {
        for slot in ["current", "history"] {
            let mut changed = ledger.clone();
            // Invalid historical path must refuse before even a missing current is opened.
            if slot == "current" {
                changed["current"]["asset"] = json!(path);
            } else {
                changed["current"]["asset"] = json!("absent.json");
                changed["history"][0]["asset"] = json!(path);
            }
            let output = fixture.run(&changed);
            assert!(String::from_utf8_lossy(&output.stderr).contains("normalized relative"));
            refused(output);
        }
    }
    std::fs::create_dir(fixture.0.join("nested")).unwrap();
    std::fs::copy(
        fixture.0.join("current.json"),
        fixture.0.join("nested/asset.json"),
    )
    .unwrap();
    let mut valid = ledger;
    valid["history"][0]["asset"] = json!("nested/asset.json");
    assert!(fixture.run(&valid).status.success());
}
#[cfg(unix)]
#[test]
fn relative_symlink_escape_refuses_before_reading_asset_bytes() {
    let fixture = Fixture::new("symlink");
    let outside = Fixture::new("outside-public-fixture");
    let mut ledger = fixture.ledger();
    outside.asset("public.json", false);
    std::os::unix::fs::symlink(
        outside.0.join("public.json"),
        fixture.0.join("escaped.json"),
    )
    .unwrap();
    ledger["history"][0]["asset"] = json!("escaped.json");
    let output = fixture.run(&ledger);
    assert!(String::from_utf8_lossy(&output.stderr).contains("escaped ledger directory"));
    refused(output);
}
#[test]
fn valid_history_emits_one_existing_normalized_line() {
    let fixture = Fixture::new("valid");
    let output = fixture.run(&fixture.ledger());
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).unwrap();
    assert_eq!(text.lines().count(), 1);
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap()["schema"],
        "mdbn-trust/normalized/1"
    );
}
#[test]
fn a_valid_older_asset_missing_from_candidate_refuses() {
    let fixture = Fixture::new("older");
    let mut ledger = fixture.ledger();
    let older = fixture.asset("older.json", true);
    ledger["history"].as_array_mut().unwrap().push(older);
    let output = fixture.run(&ledger);
    assert!(String::from_utf8_lossy(&output.stderr).contains("historical root"));
    refused(output);
}
#[test]
fn no_history_or_exhausted_capacity_never_bootstraps_or_truncates() {
    let fixture = Fixture::new("count");
    let mut ledger = fixture.ledger();
    ledger["history"] = json!([]);
    refused(fixture.run(&ledger));
    ledger["history"] = Value::Array(vec![
        ledger["current"].clone();
        mdbn_trust::MAX_HISTORY_ASSETS + 1
    ]);
    refused(fixture.run(&ledger));
}
#[test]
fn ledger_digest_is_checked_before_asset_io() {
    let fixture = Fixture::new("digest");
    let mut ledger = fixture.ledger();
    ledger["current"]["asset"] = json!("absent.json");
    let output = fixture.run_bytes(&serde_json::to_vec(&ledger).unwrap(), Some(&"0".repeat(64)));
    assert!(String::from_utf8_lossy(&output.stderr).contains("differs from authenticated digest"));
    refused(output);
}
#[test]
fn every_history_asset_uses_the_shared_context_verifier() {
    let fixture = Fixture::new("context");
    let ledger = fixture.ledger();
    for (field, value) in [
        ("sha256", "0".repeat(64)),
        (
            "control_plane_origin",
            "https://foreign.example.test".into(),
        ),
        ("log_origin", "https://foreign.example.test".into()),
    ] {
        let mut changed = ledger.clone();
        changed["history"][0][field] = json!(value);
        refused(fixture.run(&changed));
    }
    for (field, value) in [
        ("commit", "b".repeat(40)),
        ("version", "0.0.0-other".into()),
    ] {
        let mut changed = ledger.clone();
        changed["history"][0]["source"][field] = json!(value);
        refused(fixture.run(&changed));
    }
    let mut changed = ledger;
    changed["environment"] = json!("staging");
    refused(fixture.run(&changed));
}
#[test]
fn duplicate_unknown_and_oversized_ledger_refuse_without_output() {
    let fixture = Fixture::new("parse");
    let mut ledger = fixture.ledger();
    ledger["unknown"] = json!(true);
    refused(fixture.run(&ledger));
    let mut bytes = serde_json::to_vec(&fixture.ledger()).unwrap();
    bytes.splice(
        1..1,
        b"\"schema\":\"mdbn-trust/history/1\",".iter().copied(),
    );
    refused(fixture.run_bytes(&bytes, None));
    let output = fixture.run_bytes(&vec![b'x'; 1_048_577], Some(&"0".repeat(64)));
    assert!(String::from_utf8_lossy(&output.stderr).contains("byte bound"));
    refused(output);
}
