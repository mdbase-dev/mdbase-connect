//! Actual filesystem/SQLite/replica resource dependency bootstrap.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]
use mdbn_local_host::{
    HostLock, Identity, LocalReplica, OsEntropy, ReplicaOptions, StoreOptions, SystemClock,
    open_store,
};
use mdbn_replica::api::ClientApi;
use mdbn_wire::hash::sha256;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const FULL: &[u8] = include_bytes!("fixtures/reader-semantic-digests/bundle.json");
const SCHEMA: &str = "schemas/mdbase.view/1.0.0.schema.json";
static SERIAL: AtomicU64 = AtomicU64::new(0);
struct Folder(PathBuf);
impl Folder {
    fn new() -> Self {
        let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "resource-bootstrap-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn write(&self, path: &str, document: &str) {
        let target = self.0.join(path);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(target, document).unwrap();
    }
}
impl Drop for Folder {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
fn sources() -> Vec<(String, String)> {
    let v: Value = serde_json::from_slice(FULL).unwrap();
    v["resources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["path"].as_str().unwrap().to_owned(),
                r["document"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}
fn open(root: &Path) -> (HostLock, LocalReplica) {
    let options = StoreOptions::default();
    let lock = HostLock::try_acquire(root, &options.private_dir, None).unwrap();
    let state = options.state_dir(root);
    std::fs::create_dir_all(&state).unwrap();
    let identity =
        Identity::load_or_create(&state.join("identity.json"), 1, &mut OsEntropy).unwrap();
    let store = open_store(root, &options, Box::new(SystemClock)).unwrap();
    (
        lock,
        LocalReplica::open(store, &identity, ReplicaOptions::default()).unwrap(),
    )
}
fn assert_full(local: &mut LocalReplica, root: &Path, docs: &[(String, String)]) {
    let session = local.session();
    let describe = local.replica().describe(session).unwrap();
    assert_eq!(describe.contracts.len(), 3, "{describe:?}");
    assert!(describe.issues.is_empty());
    let catalog =
        mdbn_core::types::Catalog::load(docs.iter().map(|(p, d)| (p.as_str(), d.as_str())));
    for contract in describe.contracts {
        let c = catalog
            .contracts()
            .iter()
            .find(|c| c.id == contract.id && c.version.to_string() == contract.version)
            .unwrap();
        assert_eq!(contract.digest.0, c.digest.0);
        assert!(!contract.implemented_by.is_empty());
    }
    for (path, doc) in docs {
        let resource = local.replica().get_resource(session, path.clone()).unwrap();
        assert!(resource.confirmed);
        assert_eq!(resource.text, *doc);
        assert_eq!(resource.revision, sha256(doc.as_bytes()));
        assert_eq!(std::fs::read(root.join(path)).unwrap(), doc.as_bytes());
    }
}
#[test]
fn full_eight_resource_disk_bootstrap_matches_native_compiler() {
    let folder = Folder::new();
    let docs = sources();
    for (path, doc) in &docs {
        folder.write(path, doc);
    }
    let (lock, mut local) = open(&folder.0);
    local.rescan().unwrap();
    assert!(local.settle(2000).unwrap());
    assert_full(&mut local, &folder.0, &docs);
    drop(local.close());
    drop(lock);
}
#[test]
fn malformed_dependency_is_retained_until_the_actual_file_is_repaired() {
    let folder = Folder::new();
    let docs = sources();
    for (path, doc) in &docs {
        folder.write(path, doc);
    }
    folder.write(SCHEMA, "{\"type\":\"not-a-schema-type\"}");
    let (lock, mut local) = open(&folder.0);
    local.rescan().unwrap();
    assert!(local.settle(2000).unwrap());
    let session = local.session();
    assert!(
        local
            .replica()
            .describe(session)
            .unwrap()
            .contracts
            .is_empty()
    );
    assert_eq!(
        std::fs::read_to_string(folder.0.join(SCHEMA)).unwrap(),
        "{\"type\":\"not-a-schema-type\"}"
    );
    let schema = docs.iter().find(|(p, _)| p == SCHEMA).unwrap();
    folder.write(&schema.0, &schema.1);
    local.rescan().unwrap();
    assert!(local.settle(2000).unwrap());
    assert_full(&mut local, &folder.0, &docs);
    drop(local.close());
    drop(lock);
}

#[test]
fn oversized_operation_set_defers_without_partial_resource_ack() {
    let folder = Folder::new();
    folder.write("mdbase.yaml", "spec_version: '0.3.0'\n");
    for index in 0..64 {
        folder.write(&format!("_types/type{index:02}.md"), &format!("---\nkind: mdbase.type\nname: type{index:02}\nschema:\n  dialect: json-schema-2020-12\n  value: {{type: object}}\n---\n"));
    }
    let (lock, mut local) = open(&folder.0);
    local.rescan().unwrap();
    assert!(local.settle(2000).unwrap());
    let session = local.session();
    assert!(local.replica().describe(session).unwrap().types.is_empty());
    assert!(
        local
            .replica()
            .get_resource(session, "mdbase.yaml".into())
            .is_err()
    );
    std::fs::remove_file(folder.0.join("_types/type63.md")).unwrap();
    local.rescan().unwrap();
    assert!(local.settle(2000).unwrap());
    assert_eq!(local.replica().describe(session).unwrap().types.len(), 63);
    assert!(
        local
            .replica()
            .get_resource(session, "mdbase.yaml".into())
            .unwrap()
            .confirmed
    );
    drop(local.close());
    drop(lock);
}

#[test]
fn staggered_schema_arrival_retains_original_definition_evidence() {
    let folder = Folder::new();
    let docs = sources();
    for (path, doc) in &docs {
        if path != SCHEMA {
            folder.write(path, doc);
        }
    }
    let (lock, mut local) = open(&folder.0);
    local.rescan().unwrap();
    assert!(local.settle(2000).unwrap());
    let session = local.session();
    assert!(
        local
            .replica()
            .describe(session)
            .unwrap()
            .contracts
            .is_empty()
    );
    for (path, doc) in &docs {
        if path != SCHEMA {
            assert_eq!(std::fs::read(folder.0.join(path)).unwrap(), doc.as_bytes());
        }
    }
    let schema = docs.iter().find(|(p, _)| p == SCHEMA).unwrap();
    folder.write(&schema.0, &schema.1);
    local.rescan().unwrap();
    assert!(local.settle(2000).unwrap());
    assert_full(&mut local, &folder.0, &docs);
    drop(local.close());
    drop(lock);
}
