//! Offline semantic pins from the actual native SQLite/replica Describe producer.
//! Only a newly created isolated folder is used; never opens a user's collection.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use mdbn_local_host::{
    Descriptor, HostKind, HostLock, Identity, LocalReplica, OsEntropy, ReplicaOptions,
    StoreOptions, SystemClock, open_store,
};
use mdbn_replica::api::ClientApi;
use mdbn_wire::client::{PublishState, ReceiptState, SubmitParams};
use mdbn_wire::common::{B16, Text};
use mdbn_wire::hash::sha256;
use mdbn_wire::intent::{Op, ResourcePut};
use mdbn_wire::schema::Wire;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const MANIFEST_BYTES: usize = 1024 * 1024;
const BUNDLE_BYTES: usize = 8 * 1024 * 1024;
const DOCUMENT_BYTES: usize = 1024 * 1024;
const EXECUTABLE_BYTES: usize = 256 * 1024 * 1024;
const RESOURCE_COUNT: usize = 64;
const OUTPUT_BYTES: usize = 1024 * 1024;
const PRODUCER: &[u8] = include_bytes!("native-contract-digests.rs");

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Bundle {
    schema: String,
    resources: Vec<Resource>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Resource {
    path: String,
    document: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    path: String,
    bytes: usize,
    sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContractPin {
    id: String,
    version: String,
    contract_type: String,
    path: String,
    /// Exact Describe wire.Hash, not the definition document's byte hash.
    digest: String,
    digest_bytes: [u8; 32],
    implemented_by: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Provenance {
    manifest_sha256: String,
    schema_bundle_sha256: String,
    native_executable_sha256: String,
    producer_source_sha256: String,
    resources: Vec<Source>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeBootstrap {
    mutation_id: String,
    resource_count: usize,
    /// Exact native receipt, encoded by the existing wire codec.
    receipt_cbor: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    schema: &'static str,
    qualification: &'static str,
    digest_encoding: &'static str,
    manifest_id: String,
    complete_manifest_contract_selection: bool,
    selection_scope: &'static str,
    spec_version: String,
    semantics: [u64; 2],
    contracts: Vec<ContractPin>,
    bootstrap: NativeBootstrap,
    provenance: Provenance,
}

fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>> {
    if !fs::symlink_metadata(path)?.file_type().is_file() {
        return Err("input must be a regular, non-symlink file".into());
    }
    let mut bytes = Vec::new();
    File::open(path)?
        .take(u64::try_from(limit)? + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err("input exceeds its byte budget".into());
    }
    Ok(bytes)
}

fn json_bounds(value: &Value, depth: usize, nodes: &mut usize) -> Result<()> {
    *nodes += 1;
    if depth > 32 || *nodes > 65536 {
        return Err("JSON exceeds its depth/node budget".into());
    }
    match value {
        Value::Array(items) => {
            for item in items {
                json_bounds(item, depth + 1, nodes)?;
            }
        }
        Value::Object(items) => {
            for item in items.values() {
                json_bounds(item, depth + 1, nodes)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn manifest_requirements(bytes: &[u8]) -> Result<(String, BTreeSet<(String, String)>)> {
    let manifest: Value = serde_json::from_slice(bytes)?;
    json_bounds(&manifest, 0, &mut 0)?;
    if manifest.get("manifest_version").and_then(Value::as_u64) != Some(1) {
        return Err("manifest_version must be 1".into());
    }
    let id = manifest
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 1024)
        .ok_or("manifest id missing or too long")?;
    let contracts = manifest
        .pointer("/requirements/contracts")
        .and_then(Value::as_array)
        .ok_or("manifest requirements.contracts must be a list")?;
    if contracts.is_empty() || contracts.len() > RESOURCE_COUNT {
        return Err("manifest contract selection must contain 1..64 entries".into());
    }
    let mut wanted = BTreeSet::new();
    for contract in contracts {
        let text = |key| {
            contract
                .get(key)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty() && s.len() <= 1024)
                .ok_or("invalid manifest contract identity")
        };
        if !wanted.insert((text("id")?.to_owned(), text("version")?.to_owned())) {
            return Err("duplicate manifest contract identity".into());
        }
    }
    Ok((id.to_owned(), wanted))
}

fn resources(bytes: &[u8]) -> Result<BTreeMap<String, String>> {
    let value: Value = serde_json::from_slice(bytes)?;
    json_bounds(&value, 0, &mut 0)?;
    let bundle: Bundle = serde_json::from_slice(bytes)?;
    if bundle.schema != "mdbn-native-schema-bundle/1"
        || bundle.resources.is_empty()
        || bundle.resources.len() > RESOURCE_COUNT
    {
        return Err("invalid schema bundle or resource count".into());
    }
    let mut out = BTreeMap::new();
    for resource in bundle.resources {
        let path = Path::new(&resource.path);
        if resource.path.is_empty()
            || resource.path.len() > 4096
            || resource.path.contains(['\\', ':'])
            || resource.path.chars().any(char::is_control)
            || resource.path.starts_with('/')
            || resource.path.ends_with('/')
            || resource
                .path
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == ".." || p == ".mdbase")
            || path
                .components()
                .any(|p| !matches!(p, Component::Normal(_)))
        {
            return Err(
                "resource path must be a portable relative path outside native private state"
                    .into(),
            );
        }
        if resource.document.len() > DOCUMENT_BYTES {
            return Err("resource exceeds its document budget".into());
        }
        if out.insert(resource.path, resource.document).is_some() {
            return Err("duplicate resource path".into());
        }
    }
    if !out.contains_key("mdbase.yaml") {
        return Err("bundle must contain its exact mdbase.yaml; no synthesized config".into());
    }
    Ok(out)
}

fn produce(
    manifest: &[u8],
    bundle: &[u8],
    root: &Path,
    executable: &[u8],
    selected: &BTreeSet<(String, String)>,
) -> Result<Report> {
    let (manifest_id, declared) = manifest_requirements(manifest)?;
    if !selected.is_subset(&declared) {
        return Err("selected contract is not declared by the manifest".into());
    }
    let wanted = if selected.is_empty() {
        declared.clone()
    } else {
        selected.clone()
    };
    let complete_manifest_contract_selection = wanted == declared;
    let sources = resources(bundle)?;
    // Native compiler over exact input sources: reject definitions the file
    // ingestor would otherwise refuse. This is not a hand-constructed catalog
    // and never supplies the output oracle; final pins come from Describe.
    let catalog =
        mdbn_core::types::Catalog::load(sources.iter().map(|(p, s)| (p.as_str(), s.as_str())));
    if !catalog.is_valid() || !catalog.issues().is_empty() {
        let codes = catalog
            .issues()
            .iter()
            .map(|i| i.code.to_string())
            .collect::<Vec<_>>()
            .join(",");
        return Err(format!("native catalog diagnostics: {codes}").into());
    }
    // No files precede the engine's atomic resource batch. Disk-only ingestion
    // submits resources individually and cannot bootstrap external-schema refs.
    // create_dir, not create_dir_all: never adopt an existing collection.
    fs::create_dir(root)?;
    let options = StoreOptions::default();
    let lock = HostLock::try_acquire(
        root,
        &options.private_dir,
        Some(Descriptor::new(
            HostKind::Library,
            mdbn_local_host::host::now_ms(),
        )),
    )?;
    let state = options.state_dir(root);
    fs::create_dir_all(&state)?;
    let identity = Identity::load_or_create(
        &state.join("identity.json"),
        mdbn_local_host::host::now_ms(),
        &mut OsEntropy,
    )?;
    let store = open_store(root, &options, Box::new(SystemClock))?;
    let mut local = LocalReplica::open(store, &identity, ReplicaOptions::default())?;
    let session = local.session();
    // Capture one original MID; never retry or replace an ambiguous attempt.
    let mutation_id = B16(mdbn_local_host::host::uuid_v7(
        mdbn_local_host::host::now_ms(),
        &mut OsEntropy,
    ));
    let accepted = local
        .replica()
        .submit(
            session,
            SubmitParams {
                ops: sources
                    .iter()
                    .map(|(path, document)| {
                        Op::ResourcePut(ResourcePut {
                            path: path.clone(),
                            doc: Text::Inline(document.clone()),
                            base_revision: None,
                            must_not_exist: Some(true),
                        })
                    })
                    .collect(),
                mutation_id: Some(mutation_id),
                conflict_mode: None,
                timezone: None,
                allow_partial: Some(false),
                mutation_ids: None,
                dry_run: Some(false),
                include: None,
                wait: None,
            },
        )
        .map_err(|e| format!("native resource batch refused: {}", e.problem().code))?;
    if accepted.len() != 1 || accepted[0].mutation != mutation_id {
        return Err("native resource batch did not retain the original mutation identity".into());
    }
    if !local.settle(2000)? {
        return Err("native resource batch did not settle within its budget".into());
    }
    let receipt = local
        .replica()
        .receipt(session, mutation_id)
        .map_err(|e| format!("native bootstrap receipt refused: {}", e.problem().code))?;
    if receipt.mutation != mutation_id
        || receipt.state != ReceiptState::Confirmed
        || receipt.published != Some(PublishState::Published)
        || receipt.problem.is_some()
        || receipt.conflicts.as_ref().is_some_and(|c| !c.is_empty())
    {
        return Err(
            "native resource batch lacks a confirmed published conflict-free receipt".into(),
        );
    }
    let bootstrap = NativeBootstrap {
        mutation_id: receipt.mutation.to_hex(),
        resource_count: sources.len(),
        receipt_cbor: mdbn_wire::cbor::encode(&receipt.to_cbor())?,
    };
    let describe = local
        .replica()
        .describe(session)
        .map_err(|e| format!("native Describe refused: {}", e.problem().code))?;
    if !describe.issues.is_empty() {
        let codes = describe
            .issues
            .iter()
            .map(|i| i.code.as_str())
            .collect::<Vec<_>>()
            .join(",");
        return Err(format!("native catalog diagnostics: {codes}").into());
    }
    let mut provenance = Vec::new();
    for (path, document) in &sources {
        let actual = local
            .replica()
            .get_resource(session, path.clone())
            .map_err(|e| format!("native resource readback refused at {path}: {} (Describe spec={}, contracts={})", e.problem().code, describe.spec_version, describe.contracts.len()))?;
        if actual.path != *path
            || actual.text != *document
            || !actual.confirmed
            || actual.revision != sha256(document.as_bytes())
        {
            return Err(
                "native resource readback does not match the complete confirmed input".into(),
            );
        }
        if read_bounded(&root.join(path), DOCUMENT_BYTES)? != document.as_bytes() {
            return Err("native published resource does not match the complete exact input".into());
        }
        provenance.push(Source {
            path: path.clone(),
            bytes: document.len(),
            sha256: actual.revision.to_hex(),
        });
    }
    let contracts = describe
        .contracts
        .into_iter()
        .filter(|c| wanted.contains(&(c.id.clone(), c.version.clone())))
        .map(|c| ContractPin {
            id: c.id,
            version: c.version,
            contract_type: c.contract_type,
            path: c.path,
            digest: c.digest.to_hex(),
            digest_bytes: c.digest.0,
            implemented_by: c.implemented_by,
        })
        .collect::<Vec<_>>();
    let actual = contracts
        .iter()
        .map(|c| (c.id.clone(), c.version.clone()))
        .collect::<BTreeSet<_>>();
    if actual != wanted || contracts.len() != wanted.len() {
        return Err(
            "native Describe did not return the complete exact manifest contract selection".into(),
        );
    }
    let sem = local.hello().sem;
    drop(local.close());
    drop(lock);
    Ok(Report {
        schema: "mdbn-native-contract-digests/1",
        qualification: "native-parser-compiled-schema-sqlite-describe-only",
        digest_encoding: "wire.Hash: lowercase hex32 plus exact 32-byte array",
        manifest_id,
        complete_manifest_contract_selection,
        selection_scope: if complete_manifest_contract_selection {
            "all-manifest-contracts"
        } else {
            "manifest-declared-subset"
        },
        spec_version: describe.spec_version,
        semantics: [sem.major, sem.minor],
        contracts,
        bootstrap,
        provenance: Provenance {
            manifest_sha256: sha256(manifest).to_hex(),
            schema_bundle_sha256: sha256(bundle).to_hex(),
            native_executable_sha256: sha256(executable).to_hex(),
            producer_source_sha256: sha256(PRODUCER).to_hex(),
            resources: provenance,
        },
    })
}

fn run() -> Result<()> {
    let mut arguments = std::env::args_os().skip(1);
    let mut paths = BTreeMap::new();
    let mut selected = BTreeSet::new();
    while let Some(flag) = arguments.next() {
        let flag = flag.into_string().map_err(|_| "invalid argument")?;
        if flag == "--contract" {
            let value = arguments
                .next()
                .ok_or("--contract requires ID@VERSION")?
                .into_string()
                .map_err(|_| "invalid contract argument")?;
            let (id, version) = value
                .rsplit_once('@')
                .ok_or("--contract requires ID@VERSION")?;
            if selected.len() >= RESOURCE_COUNT
                || !selected.insert((id.to_owned(), version.to_owned()))
            {
                return Err("duplicate or excessive contract selection".into());
            }
        } else {
            if !["--manifest", "--bundle", "--work-root"].contains(&flag.as_str()) {
                return Err("usage: native-contract-digests --manifest FILE --bundle FILE --work-root NEW_DIRECTORY [--contract ID@VERSION ...]".into());
            }
            let value = PathBuf::from(arguments.next().ok_or("argument needs a path")?);
            if paths.insert(flag, value).is_some() {
                return Err("duplicate argument".into());
            }
        }
    }
    let manifest = read_bounded(
        paths.get("--manifest").ok_or("--manifest required")?,
        MANIFEST_BYTES,
    )?;
    let bundle = read_bounded(
        paths.get("--bundle").ok_or("--bundle required")?,
        BUNDLE_BYTES,
    )?;
    let executable = read_bounded(&std::env::current_exe()?, EXECUTABLE_BYTES)?;
    let report = produce(
        &manifest,
        &bundle,
        paths.get("--work-root").ok_or("--work-root required")?,
        &executable,
        &selected,
    )?;
    let encoded = serde_json::to_vec(&report)?;
    if encoded.len() > OUTPUT_BYTES {
        return Err("output exceeds its byte budget".into());
    }
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    out.write_all(&encoded)?;
    out.write_all(b"\n")?;
    Ok(())
}

fn main() -> std::process::ExitCode {
    match run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("native-contract-digests: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}
