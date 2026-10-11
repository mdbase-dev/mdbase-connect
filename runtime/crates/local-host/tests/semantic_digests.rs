//! Isolated real native SQLite/Describe qualification; no JS or Markdown-hash oracle.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

use mdbn_wire::client::{PublishState, Receipt, ReceiptState};
use mdbn_wire::hash::sha256;
use mdbn_wire::schema::Wire;
use serde_json::{Value, json};

const MANIFEST: &[u8] = include_bytes!("fixtures/reader-semantic-digests/manifest.json");
const BUNDLE: &[u8] =
    include_bytes!("fixtures/reader-semantic-digests/reader-contracts-bundle.json");
const FULL_BUNDLE: &[u8] = include_bytes!("fixtures/reader-semantic-digests/bundle.json");
static SERIAL: AtomicU64 = AtomicU64::new(0);

struct Case {
    root: PathBuf,
    manifest: PathBuf,
    bundle: PathBuf,
    work: PathBuf,
}

impl Case {
    fn new(manifest: &[u8], bundle: &[u8]) -> Self {
        let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "semantic-digests-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        let manifest_path = root.join("manifest.json");
        let bundle_path = root.join("bundle.json");
        std::fs::write(&manifest_path, manifest).unwrap();
        std::fs::write(&bundle_path, bundle).unwrap();
        Self {
            manifest: manifest_path,
            bundle: bundle_path,
            work: root.join("isolated"),
            root,
        }
    }

    fn run(&self) -> Output {
        Command::new(env!("CARGO_BIN_EXE_native-contract-digests"))
            .arg("--manifest")
            .arg(&self.manifest)
            .arg("--bundle")
            .arg(&self.bundle)
            .arg("--work-root")
            .arg(&self.work)
            .arg("--contract")
            .arg("dev.mdbase.reader.source@1.0.0-beta.1")
            .arg("--contract")
            .arg("dev.mdbase.reader.annotation@1.0.0-beta.1")
            .output()
            .unwrap()
    }

    fn run_all(&self) -> Output {
        Command::new(env!("CARGO_BIN_EXE_native-contract-digests"))
            .arg("--manifest")
            .arg(&self.manifest)
            .arg("--bundle")
            .arg(&self.bundle)
            .arg("--work-root")
            .arg(&self.work)
            .output()
            .unwrap()
    }

    fn report(&self) -> Value {
        let output = self.run();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
}

impl Drop for Case {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

fn encoded(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}

fn changed_bundle(change: impl FnOnce(&mut Value)) -> Vec<u8> {
    let mut value: Value = serde_json::from_slice(BUNDLE).unwrap();
    change(&mut value);
    encoded(&value)
}

fn refused(case: &Case, reason: &str) {
    let output = case.run();
    assert!(!output.status.success());
    assert!(
        output.stdout.is_empty(),
        "refusals must not publish partial pins"
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains(reason),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn assert_native_bootstrap(case: &Case, report: &Value, sources: &BTreeMap<&str, &str>) {
    let cbor = report["bootstrap"]["receiptCbor"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| u8::try_from(v.as_u64().unwrap()).unwrap())
        .collect::<Vec<_>>();
    let receipt = Receipt::from_cbor(&mdbn_wire::cbor::decode(&cbor).unwrap()).unwrap();
    assert_eq!(report["bootstrap"]["mutationId"], receipt.mutation.to_hex());
    assert_eq!(report["bootstrap"]["resourceCount"], sources.len());
    assert_eq!(receipt.state, ReceiptState::Confirmed);
    assert_eq!(receipt.published, Some(PublishState::Published));
    assert!(receipt.problem.is_none());
    assert!(receipt.conflicts.as_ref().is_none_or(|c| c.is_empty()));
    assert_eq!(mdbn_wire::cbor::encode(&receipt.to_cbor()).unwrap(), cbor);
    for (path, source) in sources {
        assert_eq!(
            std::fs::read(case.work.join(path)).unwrap(),
            source.as_bytes()
        );
    }
}

#[test]
fn reader_beta1_native_compile_describe_and_exact_provenance() {
    let case = Case::new(MANIFEST, BUNDLE);
    let report = case.report();
    assert_eq!(
        report["qualification"],
        "native-parser-compiled-schema-sqlite-describe-only"
    );
    assert_eq!(report["completeManifestContractSelection"], false);
    assert_eq!(report["selectionScope"], "manifest-declared-subset");
    assert_eq!(report["contracts"].as_array().unwrap().len(), 2);
    assert_eq!(
        report["provenance"]["manifestSha256"],
        sha256(MANIFEST).to_hex()
    );
    assert_eq!(
        report["provenance"]["schemaBundleSha256"],
        sha256(BUNDLE).to_hex()
    );
    let executable = std::fs::read(env!("CARGO_BIN_EXE_native-contract-digests")).unwrap();
    assert_eq!(
        report["provenance"]["nativeExecutableSha256"],
        sha256(&executable).to_hex()
    );
    assert_eq!(
        report["provenance"]["producerSourceSha256"],
        sha256(include_bytes!("../src/bin/native-contract-digests.rs")).to_hex()
    );

    let bundle: Value = serde_json::from_slice(BUNDLE).unwrap();
    let sources = bundle["resources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["path"].as_str().unwrap(), r["document"].as_str().unwrap()))
        .collect::<BTreeMap<_, _>>();
    assert_native_bootstrap(&case, &report, &sources);
    assert_eq!(
        report["provenance"]["resources"].as_array().unwrap().len(),
        sources.len()
    );
    for row in report["provenance"]["resources"].as_array().unwrap() {
        let path = row["path"].as_str().unwrap();
        assert_eq!(row["sha256"], sha256(sources[path].as_bytes()).to_hex());
    }
    for id in ["dev.mdbase.reader.source", "dev.mdbase.reader.annotation"] {
        let row = report["contracts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == id)
            .unwrap();
        assert_eq!(row["version"], "1.0.0-beta.1");
        assert_eq!(row["contractType"], "record");
        let path = row["path"].as_str().unwrap();
        // Independent native load of the exact input compiles its JSON Schema;
        // the emitted value must be Describe's same native semantic wire.Hash.
        let native = mdbn_core::contracts::load_contract(path, sources[path], &sources).unwrap();
        assert_eq!(
            row["digest"],
            mdbn_wire::common::B32(native.digest.0).to_hex()
        );
        assert_eq!(row["digestBytes"], json!(native.digest.0));
        assert_ne!(row["digest"], sha256(sources[path].as_bytes()).to_hex());
        assert!(!row["implementedBy"].as_array().unwrap().is_empty());
    }
    // Captured evidence has no simulated records, sessions, JS-computed digest,
    // WASM artifact or production qualification. Only actual native tuples.
    println!(
        "READER_NATIVE_SEMANTIC_DIGEST_REPORT={}",
        serde_json::to_string(&report).unwrap()
    );
}

#[test]
fn full_bundle_native_batch_qualifies_all_manifest_contracts() {
    let case = Case::new(MANIFEST, FULL_BUNDLE);
    let output = case.run_all();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["completeManifestContractSelection"], true);
    assert_eq!(report["selectionScope"], "all-manifest-contracts");
    assert_eq!(report["contracts"].as_array().unwrap().len(), 3);
    assert_eq!(
        report["provenance"]["manifestSha256"],
        sha256(MANIFEST).to_hex()
    );
    assert_eq!(
        report["provenance"]["schemaBundleSha256"],
        sha256(FULL_BUNDLE).to_hex()
    );
    assert_eq!(
        report["provenance"]["nativeExecutableSha256"],
        sha256(&std::fs::read(env!("CARGO_BIN_EXE_native-contract-digests")).unwrap()).to_hex()
    );
    assert_eq!(
        report["provenance"]["producerSourceSha256"],
        sha256(include_bytes!("../src/bin/native-contract-digests.rs")).to_hex()
    );
    let bundle: Value = serde_json::from_slice(FULL_BUNDLE).unwrap();
    let sources = bundle["resources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["path"].as_str().unwrap(), r["document"].as_str().unwrap()))
        .collect::<BTreeMap<_, _>>();
    assert_native_bootstrap(&case, &report, &sources);
    assert_eq!(sources.len(), 8);
    assert_eq!(
        report["provenance"]["resources"].as_array().unwrap().len(),
        8
    );
    for row in report["provenance"]["resources"].as_array().unwrap() {
        let path = row["path"].as_str().unwrap();
        assert_eq!(row["sha256"], sha256(sources[path].as_bytes()).to_hex());
        assert_eq!(row["bytes"], sources[path].len());
    }
    for row in report["contracts"].as_array().unwrap() {
        let path = row["path"].as_str().unwrap();
        let native = mdbn_core::contracts::load_contract(path, sources[path], &sources).unwrap();
        assert_eq!(
            row["digest"],
            mdbn_wire::common::B32(native.digest.0).to_hex()
        );
        assert_eq!(row["digestBytes"], json!(native.digest.0));
        assert!(!row["implementedBy"].as_array().unwrap().is_empty());
    }
    let view = report["contracts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == "mdbase.view")
        .unwrap();
    assert_eq!(view["version"], "1.0.0");
    assert_eq!(view["path"], "_contracts/mdbase.view/1.0.0.md");
    println!(
        "READER_FULL_NATIVE_SEMANTIC_DIGEST_REPORT={}",
        serde_json::to_string(&report).unwrap()
    );
}

#[test]
fn incomplete_bundle_default_selection_still_refuses() {
    let case = Case::new(MANIFEST, BUNDLE);
    let output = case.run_all();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("complete exact manifest contract selection")
    );
}

#[test]
fn disk_only_resource_bootstrap_now_matches_existing_parser_support() {
    use mdbn_local_host::{
        HostLock, Identity, LocalReplica, OsEntropy, ReplicaOptions, StoreOptions, SystemClock,
        open_store,
    };
    use mdbn_replica::api::ClientApi;

    let case = Case::new(MANIFEST, FULL_BUNDLE);
    let bundle: Value = serde_json::from_slice(FULL_BUNDLE).unwrap();
    let sources = bundle["resources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["path"].as_str().unwrap(), r["document"].as_str().unwrap()))
        .collect::<BTreeMap<_, _>>();
    let catalog = mdbn_core::types::Catalog::load(sources.iter().map(|(p, d)| (*p, *d)));
    assert!(catalog.is_valid());
    assert!(catalog.issues().is_empty());
    assert_eq!(catalog.contracts().len(), 3);
    let incomplete = mdbn_core::types::Catalog::load(
        sources
            .iter()
            .filter(|(p, _)| **p != "schemas/mdbase.view/1.0.0.schema.json")
            .map(|(p, d)| (*p, *d)),
    );
    assert!(
        incomplete
            .issues()
            .iter()
            .any(|i| i.code == "schema_ref_unresolved")
    );

    std::fs::create_dir(&case.work).unwrap();
    for (path, document) in &sources {
        let target = case.work.join(path);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(target, document).unwrap();
    }
    let options = StoreOptions::default();
    let lock = HostLock::try_acquire(&case.work, &options.private_dir, None).unwrap();
    let state = options.state_dir(&case.work);
    std::fs::create_dir_all(&state).unwrap();
    let identity =
        Identity::load_or_create(&state.join("identity.json"), 1, &mut OsEntropy).unwrap();
    let store = open_store(&case.work, &options, Box::new(SystemClock)).unwrap();
    let mut local = LocalReplica::open(store, &identity, ReplicaOptions::default()).unwrap();
    local.rescan().unwrap();
    assert!(local.settle(2000).unwrap());
    let session = local.session();
    let describe = local.replica().describe(session).unwrap();
    assert_eq!(describe.contracts.len(), 3);
    let resource = local
        .replica()
        .get_resource(session, "_contracts/mdbase.view/1.0.0.md".into())
        .unwrap();
    assert!(resource.confirmed);
    assert_eq!(resource.text, sources["_contracts/mdbase.view/1.0.0.md"]);
    for (path, document) in sources {
        assert_eq!(
            std::fs::read(case.work.join(path)).unwrap(),
            document.as_bytes()
        );
    }
    println!(
        "NATIVE_DISK_BOOTSTRAP_FIXED=full8-parser-valid/3-contracts; disk-ingest/3-contracts; confirmed-view-resource; exact-input-files-retained"
    );
    drop(local.close());
    drop(lock);
}

#[test]
fn missing_external_schema_refuses_before_native_bootstrap() {
    let mut bundle: Value = serde_json::from_slice(FULL_BUNDLE).unwrap();
    bundle["resources"]
        .as_array_mut()
        .unwrap()
        .retain(|r| r["path"] != "schemas/mdbase.view/1.0.0.schema.json");
    let case = Case::new(MANIFEST, &encoded(&bundle));
    refused(&case, "schema_ref_unresolved");
    assert!(!case.work.exists());
}

#[test]
fn arbitrary_nonresource_cannot_enter_the_native_batch() {
    let changed = changed_bundle(|b| {
        b["resources"].as_array_mut().unwrap().push(json!({
            "path": "ordinary.json", "document": "{}"
        }));
    });
    let case = Case::new(MANIFEST, &changed);
    refused(&case, "native resource batch");
    assert!(
        !case.work.join("mdbase.yaml").exists(),
        "invalid batch has no partial resource publish"
    );
}

#[test]
fn undeclared_selection_cannot_borrow_another_manifest_identity() {
    let case = Case::new(MANIFEST, BUNDLE);
    let output = Command::new(env!("CARGO_BIN_EXE_native-contract-digests"))
        .arg("--manifest")
        .arg(&case.manifest)
        .arg("--bundle")
        .arg(&case.bundle)
        .arg("--work-root")
        .arg(&case.work)
        .arg("--contract")
        .arg("other.contract@1.0.0")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("not declared by the manifest"));
    assert!(!case.work.exists());
}

#[test]
fn resource_count_and_bundle_envelope_refuse_before_stage() {
    let changed = changed_bundle(|b| {
        b["resources"] = json!(
            (0..65)
                .map(|i| json!({"path":format!("_contracts/{i}.md"),"document":""}))
                .collect::<Vec<_>>()
        );
    });
    let case = Case::new(MANIFEST, &changed);
    refused(&case, "resource count");
    assert!(!case.work.exists());
    let changed = changed_bundle(|b| b["unrecognized"] = json!(true));
    let case = Case::new(MANIFEST, &changed);
    refused(&case, "unknown field");
    assert!(!case.work.exists());
    let case = Case::new(MANIFEST, br#"{"schema":"mdbn-native-schema-bundle/1","schema":"mdbn-native-schema-bundle/1","resources":[]}"#);
    refused(&case, "duplicate field");
    assert!(!case.work.exists());
}

#[test]
fn definition_body_changes_input_provenance_not_semantic_pin() {
    let changed = changed_bundle(|bundle| {
        for row in bundle["resources"].as_array_mut().unwrap() {
            if row["path"].as_str().unwrap().starts_with("_contracts/") {
                row["document"] = json!(format!(
                    "{}\nAdditional documentation.\n",
                    row["document"].as_str().unwrap()
                ));
            }
        }
    });
    let original = Case::new(MANIFEST, BUNDLE).report();
    let fresh = Case::new(MANIFEST, &changed).report();
    assert_eq!(original["contracts"], fresh["contracts"]);
    assert_ne!(
        original["provenance"]["schemaBundleSha256"],
        fresh["provenance"]["schemaBundleSha256"]
    );
    assert_ne!(
        original["provenance"]["resources"],
        fresh["provenance"]["resources"]
    );
}

#[test]
fn missing_manifest_contract_refuses_whole_report() {
    let changed = changed_bundle(|bundle| {
        bundle["resources"]
            .as_array_mut()
            .unwrap()
            .retain(|r| r["path"] != "_contracts/dev.mdbase.reader.annotation.md");
    });
    refused(&Case::new(MANIFEST, &changed), "native catalog diagnostics");
}

#[test]
fn invalid_native_schema_refuses_whole_report() {
    let changed = changed_bundle(|bundle| {
        let row = bundle["resources"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|r| r["path"] == "_contracts/dev.mdbase.reader.source.md")
            .unwrap();
        row["document"] = json!(row["document"].as_str().unwrap().replacen(
            "type: object",
            "type: imaginary",
            1
        ));
    });
    refused(&Case::new(MANIFEST, &changed), "native catalog diagnostics");
}

#[test]
fn existing_work_folder_is_not_adopted_or_modified() {
    let case = Case::new(MANIFEST, BUNDLE);
    std::fs::create_dir(&case.work).unwrap();
    let sentinel = case.work.join("keep.txt");
    std::fs::write(&sentinel, b"original").unwrap();
    refused(&case, "exists");
    assert_eq!(std::fs::read(&sentinel).unwrap(), b"original");
    assert_eq!(std::fs::read_dir(&case.work).unwrap().count(), 1);
}

#[test]
fn selection_paths_duplicates_and_resource_budgets_refuse_before_stage() {
    for path in [
        "../foreign.md",
        "/absolute.md",
        ".mdbase/identity.json",
        "_contracts/../foreign.md",
        "C:\\foreign.md",
        "C:/foreign.md",
        "a//b",
        "a/./b",
        "a\nb",
    ] {
        let changed = changed_bundle(|b| b["resources"][0]["path"] = json!(path));
        let case = Case::new(MANIFEST, &changed);
        refused(&case, "resource path");
        assert!(!case.work.exists());
    }
    let changed = changed_bundle(|b| {
        let rows = b["resources"].as_array_mut().unwrap();
        rows.push(rows[0].clone());
    });
    let case = Case::new(MANIFEST, &changed);
    refused(&case, "duplicate resource path");
    assert!(!case.work.exists());

    let changed =
        changed_bundle(|b| b["resources"][0]["document"] = json!("x".repeat(1024 * 1024 + 1)));
    let case = Case::new(MANIFEST, &changed);
    refused(&case, "document budget");
    assert!(!case.work.exists());

    let mut manifest: Value = serde_json::from_slice(MANIFEST).unwrap();
    let duplicate = manifest["requirements"]["contracts"][0].clone();
    manifest["requirements"]["contracts"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    let case = Case::new(&encoded(&manifest), BUNDLE);
    refused(&case, "duplicate manifest contract identity");
    assert!(!case.work.exists());
}
