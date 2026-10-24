//! `cargo xtask arch`: crate boundaries and the portability rules clippy cannot
//! express.
//!
//! Checks, all from `cargo metadata` plus a token scan of sources:
//! 1. **Dependency direction.** Every workspace crate is listed in [`RULES`] with
//!    the internal crates it may depend on (any dependency kind), plus one exact
//!    native-to-conformance dev-only test edge. A new crate without a rule fails
//!    until someone decides where it sits.
//! 2. **Portable dependency trees.** The portable crates, resolved for
//!    `wasm32-unknown-unknown`, must not pull in any crate in [`BANNED_PORTABLE`].
//! 3. **Lint inheritance.** Every crate uses `[lints] workspace = true`.
//! 4. **Source scan** of portable and deterministic library crates: no I/O module
//!    paths, no banned identifiers (hash containers, clocks, OS entropy), and no
//!    opting out of the clippy bans.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::{Result, cargo_metadata, repo_root};

mod hosted_service;

/// Which crate may depend on which. Keep in sync with the crate map in README.md.
pub const RULES: &[(&str, &[&str])] = &[
    ("mdbn-core", &[]),
    ("mdbn-noise", &[]),
    ("mdbn-wire", &["mdbn-core"]),
    ("mdbn-replica", &["mdbn-core", "mdbn-wire"]),
    (
        "mdbn-store-file",
        &["mdbn-core", "mdbn-wire", "mdbn-replica"],
    ),
    ("mdbn-platform-native", &["mdbn-core", "mdbn-store-file"]),
    ("mdbn-store-pg", &["mdbn-core", "mdbn-wire", "mdbn-replica"]),
    // Blind: if it cannot interpret records, it cannot leak them.
    ("mdbn-log-service", &["mdbn-wire"]),
    // Native host of the log service (gateway, Postgres backend): as blind as it.
    ("mdbn-log-server", &["mdbn-wire", "mdbn-log-service"]),
    // Offline native verifier: no network/provider/backend composition.
    ("mdbn-backup-verify", &["mdbn-wire", "mdbn-log-service"]),
    // The log service conformance suite and D2 benchmarks, over the wire.
    (
        "mdbn-log-conformance",
        &["mdbn-wire", "mdbn-log-service", "mdbn-log-server"],
    ),
    (
        "mdbn-wasm",
        &["mdbn-core", "mdbn-wire", "mdbn-replica", "mdbn-store-file"],
    ),
    // The hosted replica's engine for the Cloudflare Worker (a composition point),
    // and the sole WASM consumer of host cryptography (Noise responder sessions).
    (
        "mdbn-hosted-worker",
        &[
            "mdbn-core",
            "mdbn-wire",
            "mdbn-replica",
            "mdbn-store-file",
            "mdbn-noise",
            // Metadata-only legacy import preflight.
            "mdbn-migrate-portable",
        ],
    ),
    (
        "mdbn-sim",
        &[
            "mdbn-core",
            "mdbn-wire",
            "mdbn-replica",
            "mdbn-store-file",
            "mdbn-log-service",
            "mdbn-noise",
        ],
    ),
    (
        "mdbn-bench",
        &[
            "mdbn-core",
            "mdbn-wire",
            "mdbn-replica",
            "mdbn-store-file",
            "mdbn-platform-native",
            "mdbn-store-pg",
            "mdbn-log-service",
            "mdbn-sim",
            // The native local journey through the public library (perf).
            "mdbase",
            "mdbn-local-host",
        ],
    ),
    ("mdbn-conformance", &["mdbn-core", "mdbn-wasm"]),
    // Environment trust assets: the one verifier of the release trust payload and
    // its normalized policy pins, for the daemon and the app build step.
    ("mdbn-trust", &["mdbn-wire", "mdbn-replica"]),
    // mdbase-core.wasm: the pure helpers (digests, JSON Schema, catalog, packs)
    // for the npm `mdbase` package. Ships inside that package only.
    ("mdbase-wasm", &["mdbn-core"]),
    // Old-format readers for migration: no internal deps, so they cannot
    // normalise old data through new semantics (legacy semantics boundary).
    ("mdbn-legacy", &[]),
    // Pure conversion rules of a legacy import (path preflight/renames, IDs, the
    // oversized-document rule): portable, shared by the native migrator and the
    // hosted Worker import. Not linked into
    // runtime.wasm (size budget); the Worker export lands with crates/hosted-worker.
    // The hosted import's spill runs on store-file's portable SQL index ABI (the
    // DO's SQLite in the Worker), so the Worker needs no migration SQL adapter.
    (
        "mdbn-migrate-portable",
        &["mdbn-core", "mdbn-wire", "mdbn-store-file"],
    ),
    // The local takeover and rollback: the daemon implements its traits
    // and drives it, so it is split from the migrator, which nothing depends on.
    // Read-only old state goes through mdbn-legacy.
    ("mdbn-takeover", &["mdbn-legacy"]),
    // The migrator: a composition point like mdbn-bench; nothing depends on it
    // (legacy semantics boundary).
    (
        "mdbn-migrate",
        &[
            "mdbn-migrate-portable",
            "mdbn-legacy",
            "mdbn-takeover",
            "mdbn-core",
            "mdbn-wire",
            "mdbn-replica",
            "mdbn-store-file",
            "mdbn-platform-native",
            "mdbn-store-pg",
        ],
    ),
    // The shared native composition of a collection folder (store, host lock,
    // identity, local-only drive loop) for the `mdbase` crate and the daemon.
    (
        "mdbn-local-host",
        &[
            "mdbn-core",
            "mdbn-wire",
            "mdbn-replica",
            "mdbn-store-file",
            "mdbn-platform-native",
        ],
    ),
    // The public library facade over the local composition (docs/library/README.md).
    (
        "mdbase",
        &[
            "mdbn-core",
            "mdbn-wire",
            "mdbn-replica",
            "mdbn-store-file",
            "mdbn-platform-native",
            "mdbn-local-host",
        ],
    ),
    // The Node.js addon behind `mdbase/node`: a thin JSON shell over `mdbase`.
    ("mdbase-node", &["mdbase"]),
    // Composition point: wires the file store to replicas, hosts the embedded log.
    (
        "mdbn-daemon",
        &[
            "mdbn-core",
            "mdbn-wire",
            "mdbn-replica",
            "mdbn-store-file",
            "mdbn-platform-native",
            "mdbn-log-service",
            // Local takeover from the old connector (local migration).
            "mdbn-legacy",
            // The takeover driver implements mdbn-takeover's traits.
            "mdbn-takeover",
            // Shared pure production crypto; no admission or OS entropy.
            "mdbn-noise",
            // Environment trust pins (the release trust asset verifier).
            "mdbn-trust",
            // The shared native composition of a collection folder (store, host
            // lock, host services) under the collection runtime.
            "mdbn-local-host",
        ],
    ),
    ("xtask", &[]),
];

/// Test-only crates: the only ones allowed to depend on `mdbn-sim`, whose seeded
/// entropy must never reach a shipped binary.
pub const TEST_ONLY: &[&str] = &["mdbn-sim", "mdbn-bench", "mdbn-conformance", "xtask"];

/// Crates that ship in `runtime.wasm` (or would): portable and deterministic.
pub const PORTABLE: &[&str] = &[
    "mdbn-core",
    "mdbn-wire",
    "mdbn-replica",
    "mdbn-store-file",
    "mdbn-migrate-portable",
    "mdbn-wasm",
    "mdbase-wasm",
];

/// Additional crates whose *library* must still be deterministic.
pub const DETERMINISTIC_LIBS: &[&str] = &["mdbn-sim", "mdbn-noise"];

/// Host cryptography is forbidden to SDK/portable runtime composition roots,
/// including transitive dev/build edges. The hosted Worker is the sole WASM
/// exception: caller CSPRNG, RAM-only sessions, close/re-handshake on DO wake.
pub const HOST_CRYPTO_LIBS: &[&str] = &["mdbn-noise"];

/// WASM host roots (the Worker consumer adds its own RULES edge).
pub const WASM_ROOTS: &[&str] = &["mdbn-log-service", "mdbn-hosted-worker"];

/// Crates portable crates may not depend on, even transitively (wasm32 resolution).
pub const BANNED_PORTABLE: &[(&str, &str)] = &[
    (
        "getrandom",
        "entropy comes from the injected mdbn_core::host::Entropy",
    ),
    (
        "rand",
        "use a seeded generator from injected entropy, not rand's OS defaults",
    ),
    ("libc", "no libc in portable crates"),
    (
        "regex",
        "regex-lite is the decided flavour on every platform",
    ),
    ("rusqlite", "the index is behind IndexStorage"),
    ("libsqlite3-sys", "the index is behind IndexStorage"),
    (
        "tokio",
        "the replica is synchronous; hosts own async runtimes",
    ),
    (
        "chrono",
        "replace with a small civil-date module; never the clock feature",
    ),
    (
        "wasm-bindgen",
        "raw ABI only; host capabilities are explicit imports",
    ),
    (
        "js-sys",
        "raw ABI only; host capabilities are explicit imports",
    ),
];

/// Identifiers banned anywhere in portable/deterministic library sources.
const BANNED_IDENTS: &[(&str, &str)] = &[
    (
        "HashMap",
        "iteration order is not deterministic; use BTreeMap",
    ),
    (
        "HashSet",
        "iteration order is not deterministic; use BTreeSet",
    ),
    ("RandomState", "seeded from OS entropy"),
    ("Instant", "use the injected Clock"),
    ("SystemTime", "use the injected Clock"),
    ("UNIX_EPOCH", "use the injected Clock"),
    ("thread_rng", "use the injected Entropy"),
    ("OsRng", "use the injected Entropy"),
    ("getrandom", "use the injected Entropy"),
    ("from_entropy", "use the injected Entropy"),
    (
        "thread_local",
        "no per-thread state; the replica is single-threaded by design",
    ),
];

/// `std` modules banned in portable/deterministic library sources.
const BANNED_STD_MODULES: &[&str] = &["fs", "env", "net", "process", "thread"];

// Declared dev-only dependency for the real SQLite/Core differential test.
// Keep normal/build/unknown kinds out; do not widen the production RULES lists.
fn conformance_test_edge(from: &str, to: &str, kind: &Value) -> bool {
    let dev = kind.as_str() == Some("dev");
    (from == "mdbn-platform-native" && to == "mdbn-conformance" && dev)
        // Declared dev-only: the daemon's sync_pair CI test hosts the real log
        // service in process. Never a normal edge.
        || (from == "mdbn-daemon" && to == "mdbn-log-server" && dev)
}

pub fn run() -> Result<()> {
    let root = repo_root();
    let meta = cargo_metadata(&[])?;
    let mut errors = Vec::new();
    let members = workspace_members(&meta);
    let rules: BTreeMap<&str, BTreeSet<&str>> = RULES
        .iter()
        .map(|(k, v)| (*k, v.iter().copied().collect()))
        .collect();

    // 1. Dependency direction.
    for (name, pkg) in &members {
        let Some(allowed) = rules.get(name.as_str()) else {
            errors.push(format!(
                "{name}: no dependency rule; add it to RULES in xtask/src/arch.rs"
            ));
            continue;
        };
        for dep in pkg["dependencies"].as_array().into_iter().flatten() {
            let dep_name = dep["name"].as_str().unwrap_or("");
            if members.contains_key(dep_name)
                && !allowed.contains(dep_name)
                && !conformance_test_edge(name, dep_name, &dep["kind"])
            {
                let kind = dep["kind"].as_str().unwrap_or("normal");
                errors.push(format!(
                    "{name} may not depend on {dep_name} ({kind}); allowed: {allowed:?}"
                ));
            }
        }
    }
    for name in rules.keys() {
        if !members.contains_key(*name) {
            errors.push(format!(
                "RULES lists {name}, which is not a workspace member"
            ));
        }
    }

    // 1a. The daemon's dev-only log-server edge never reaches the shipped binary:
    // nothing in the daemon's normal (non-dev) closure is the log server.
    if let Some((_, path)) = normal_closure(&meta, "mdbn-daemon")
        .into_iter()
        .find(|(d, _)| d == "mdbn-log-server")
    {
        errors.push(format!(
            "mdbn-daemon ships the log server through a normal dependency: {path}"
        ));
    }

    // 1b. Nothing shipped depends on the simulator, even transitively.
    for name in members.keys() {
        if TEST_ONLY.contains(&name.as_str()) {
            continue;
        }
        if let Some((_, path)) = normal_closure(&meta, name)
            .into_iter()
            .find(|(d, _)| d == "mdbn-sim")
        {
            errors.push(format!(
                "{name} depends on mdbn-sim ({path}): seeded test entropy must never ship"
            ));
        }
    }

    // 1c. Nothing shipped enables guarded testing features, directly or through
    // another crate (replica test entropy/PlainSealer; Noise secret-key export).
    for name in members.keys() {
        if TEST_ONLY.contains(&name.as_str()) {
            continue;
        }
        errors.extend(testing_feature_violations(&meta, name));
    }

    // 1d. Escrow-only migration sealing cannot be enabled by client/CLI builds.
    errors.extend(hosted_service::violations(&meta));

    // 1e. Only the hosted Worker may consume host cryptography in WASM. Check
    // the host union too: target-specific/dev/build edges cannot evade this boundary.
    for krate in PORTABLE.iter().chain(WASM_ROOTS) {
        errors.extend(host_crypto_violations(&meta, krate));
        errors.extend(offline_verifier_violations(&meta, krate));
    }

    // 2. Portable dependency trees, resolved for wasm32.
    let wasm_meta = cargo_metadata(&["--filter-platform", "wasm32-unknown-unknown"])?;
    for krate in PORTABLE.iter().chain(WASM_ROOTS) {
        errors.extend(host_crypto_violations(&wasm_meta, krate));
        errors.extend(offline_verifier_violations(&wasm_meta, krate));
    }
    for krate in PORTABLE {
        for (dep, path) in normal_closure(&wasm_meta, krate) {
            if let Some((_, why)) = BANNED_PORTABLE.iter().find(|(b, _)| *b == dep) {
                errors.push(format!("{krate} pulls in {dep} via {path}: {why}"));
            }
        }
    }

    // 3. Lint inheritance.
    for (name, pkg) in &members {
        let manifest = PathBuf::from(pkg["manifest_path"].as_str().unwrap_or(""));
        let text = fs::read_to_string(&manifest).unwrap_or_default();
        if !inherits_workspace_lints(&text) {
            errors.push(format!(
                "{name}: Cargo.toml must have `[lints]\\nworkspace = true`"
            ));
        }
    }

    // 4. Source scan.
    for (name, pkg) in &members {
        let portable = PORTABLE.contains(&name.as_str());
        if !portable && !DETERMINISTIC_LIBS.contains(&name.as_str()) {
            continue;
        }
        let dir = PathBuf::from(pkg["manifest_path"].as_str().unwrap_or(""))
            .parent()
            .map(|p| p.join("src"))
            .unwrap_or_default();
        let mut files = Vec::new();
        rust_files(&dir, &mut files);
        for file in files {
            // Binaries of deterministic (non-portable) crates may do I/O.
            if !portable
                && (file.ends_with("main.rs") || file.components().any(|c| c.as_os_str() == "bin"))
            {
                continue;
            }
            let src = fs::read_to_string(&file).unwrap_or_default();
            let rel = file
                .strip_prefix(&root)
                .unwrap_or(&file)
                .display()
                .to_string();
            for (line, msg) in scan_source(&src) {
                errors.push(format!("{rel}:{line}: {msg}"));
            }
        }
    }

    if errors.is_empty() {
        println!(
            "arch: ok ({} crates; portable: {})",
            members.len(),
            PORTABLE.join(", ")
        );
        Ok(())
    } else {
        for e in &errors {
            eprintln!("arch: {e}");
        }
        Err(format!("{} architecture violation(s)", errors.len()))
    }
}

fn workspace_members(meta: &Value) -> BTreeMap<String, Value> {
    let ids: BTreeSet<&str> = meta["workspace_members"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    meta["packages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["id"].as_str().is_some_and(|id| ids.contains(id)))
        .map(|p| (p["name"].as_str().unwrap_or("").to_owned(), p.clone()))
        .collect()
}

/// Transitive normal (non-dev, non-build) dependencies of `krate`, as
/// `(crate name, path from krate)`.
fn normal_closure(meta: &Value, krate: &str) -> Vec<(String, String)> {
    dependency_closure(meta, krate, true)
}

fn offline_verifier_violations(meta: &Value, krate: &str) -> Vec<String> {
    if !PORTABLE.contains(&krate) && !WASM_ROOTS.contains(&krate) {
        return Vec::new();
    }
    dependency_closure(meta, krate, false)
        .into_iter()
        .filter(|(name, _)| name == "mdbn-backup-verify")
        .map(|(_, path)| format!("{krate} reaches native-only offline verifier ({path})"))
        .collect()
}

fn host_crypto_violations(meta: &Value, krate: &str) -> Vec<String> {
    if krate == "mdbn-hosted-worker" || (!PORTABLE.contains(&krate) && !WASM_ROOTS.contains(&krate))
    {
        return Vec::new();
    }
    dependency_closure(meta, krate, false).into_iter()
        .filter(|(name, _)| HOST_CRYPTO_LIBS.contains(&name.as_str()))
        .map(|(_, path)| format!("{krate} reaches host cryptography ({path}): only the hosted Worker may consume it in WASM"))
        .collect()
}

fn dependency_closure(meta: &Value, krate: &str, normal_only: bool) -> Vec<(String, String)> {
    let name_of: BTreeMap<&str, &str> = meta["packages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| Some((p["id"].as_str()?, p["name"].as_str()?)))
        .collect();
    let nodes: BTreeMap<&str, &Value> = meta["resolve"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|n| Some((n["id"].as_str()?, n)))
        .collect();
    let Some(start) = name_of
        .iter()
        .find(|(id, n)| **n == krate && nodes.contains_key(**id))
        .map(|(id, _)| *id)
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen = BTreeSet::from([start]);
    let mut stack = vec![(start, krate.to_owned())];
    while let Some((id, path)) = stack.pop() {
        for dep in nodes[id]["deps"].as_array().into_iter().flatten() {
            let normal = dep["dep_kinds"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|k| k["kind"].is_null());
            let Some(dep_id) = dep["pkg"].as_str() else {
                continue;
            };
            if (normal_only && !normal) || !seen.insert(dep_id) {
                continue;
            }
            let dep_name = name_of.get(dep_id).copied().unwrap_or(dep_id);
            let dep_path = format!("{path} -> {dep_name}");
            out.push((dep_name.to_owned(), dep_path.clone()));
            stack.push((dep_id, dep_path));
        }
    }
    out
}

/// Test-only features that must never reach a shipped build.
const GUARDED: &[(&str, &str)] = &[("mdbn-replica", "testing"), ("mdbn-noise", "testing")];

/// Ways a shipped crate enables any guarded test-only feature.
fn testing_feature_violations(meta: &Value, krate: &str) -> Vec<String> {
    GUARDED
        .iter()
        .flat_map(|&(guarded, feature)| guarded_feature_violations(meta, krate, guarded, feature))
        .collect()
}

/// Dependency requests, requested/default forwarding features, and the guarded
/// producer's own defaults. The existing normal-closure checks remain intact.
fn guarded_feature_violations(
    meta: &Value,
    krate: &str,
    guarded: &str,
    feature: &str,
) -> Vec<String> {
    let forward = format!("{guarded}/{feature}");
    let pkgs: BTreeMap<&str, &Value> = meta["packages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| Some((p["name"].as_str()?, p)))
        .collect();
    let mut chain: Vec<(String, String)> = vec![(krate.to_owned(), krate.to_owned())];
    chain.extend(normal_closure(meta, krate));
    let in_closure: BTreeSet<&str> = chain.iter().map(|(n, _)| n.as_str()).collect();
    // Features of each crate that forward the guarded feature (one level).
    let forwarding = |name: &str| -> BTreeSet<String> {
        pkgs.get(name)
            .and_then(|p| p["features"].as_object())
            .map(|f| {
                f.iter()
                    .filter(|(_, v)| {
                        v.as_array()
                            .into_iter()
                            .flatten()
                            .any(|x| x.as_str() == Some(forward.as_str()))
                    })
                    .map(|(k, _)| k.clone())
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut out = Vec::new();
    for (name, path) in &chain {
        let Some(p) = pkgs.get(name.as_str()) else {
            continue;
        };
        // A forwarding feature on by default.
        let fwd = forwarding(name);
        let defaults: BTreeSet<String> = p["features"]["default"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|x| x.as_str().map(str::to_owned))
            .collect();
        if name == guarded && defaults.contains(feature) {
            out.push(format!(
                "{krate} enables {forward} through {name}'s guarded default ({path})"
            ));
        }
        if name != guarded && fwd.iter().any(|f| defaults.contains(f)) {
            out.push(format!(
                "{krate} enables {forward} through {name}'s default features ({path})"
            ));
        }
        for dep in p["dependencies"].as_array().into_iter().flatten() {
            if !dep["kind"].is_null() {
                continue; // dev and build dependencies don't ship
            }
            let dep_name = dep["name"].as_str().unwrap_or("");
            if !in_closure.contains(dep_name) {
                continue;
            }
            let requested: Vec<&str> = dep["features"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            if dep_name == guarded && requested.contains(&feature) {
                out.push(format!(
                    "{krate} enables {forward} via {path} (declared by {name})"
                ));
            }
            let dep_fwd = forwarding(dep_name);
            if dep_name != guarded && requested.iter().any(|r| dep_fwd.contains(*r)) {
                out.push(format!(
                    "{krate} enables {forward} via {path} ({name} requests a forwarding feature of {dep_name})"
                ));
            }
        }
    }
    out
}

fn inherits_workspace_lints(manifest: &str) -> bool {
    let mut in_lints = false;
    for line in manifest.lines().map(str::trim) {
        if line.starts_with('[') {
            in_lints = line == "[lints]";
        } else if in_lints && line.replace(' ', "") == "workspace=true" {
            return true;
        }
    }
    false
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

#[derive(Debug, PartialEq)]
enum Tok {
    Ident(String),
    PathSep,
    Open,
    Close,
    Comma,
    Other,
}

/// Tokenise Rust source roughly: identifiers and the punctuation the scan needs,
/// with comments and string/char literals removed. Returns `(line, token)`.
fn tokens(src: &str) -> Vec<(usize, Tok)> {
    let b = src.as_bytes();
    let mut out = Vec::new();
    let (mut i, mut line) = (0, 1);
    while i < b.len() {
        let c = b[i];
        match c {
            b'\n' => {
                line += 1;
                i += 1;
            }
            b'/' if b.get(i + 1) == Some(&b'/') => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                let mut depth = 0;
                while i < b.len() {
                    if b[i] == b'/' && b.get(i + 1) == Some(&b'*') {
                        depth += 1;
                        i += 2;
                    } else if b[i] == b'*' && b.get(i + 1) == Some(&b'/') {
                        depth -= 1;
                        i += 2;
                        if depth == 0 {
                            break;
                        }
                    } else {
                        line += usize::from(b[i] == b'\n');
                        i += 1;
                    }
                }
            }
            b'r' if matches!(b.get(i + 1), Some(b'"') | Some(b'#')) && {
                let mut j = i + 1;
                while b.get(j) == Some(&b'#') {
                    j += 1;
                }
                b.get(j) == Some(&b'"')
            } =>
            {
                let mut j = i + 1;
                let mut hashes = 0;
                while b[j] == b'#' {
                    hashes += 1;
                    j += 1;
                }
                j += 1;
                loop {
                    if j >= b.len() {
                        break;
                    }
                    if b[j] == b'"'
                        && b[j + 1..]
                            .iter()
                            .take(hashes)
                            .filter(|&&h| h == b'#')
                            .count()
                            == hashes
                    {
                        j += 1 + hashes;
                        break;
                    }
                    line += usize::from(b[j] == b'\n');
                    j += 1;
                }
                i = j;
            }
            b'"' => {
                i += 1;
                while i < b.len() && b[i] != b'"' {
                    if b[i] == b'\\' {
                        i += 1;
                    }
                    line += usize::from(b.get(i) == Some(&b'\n'));
                    i += 1;
                }
                i += 1;
            }
            b'\'' => {
                // A char literal ('x', 'é', '\n', '\'', '\u{..}') or a lifetime ('a).
                if b.get(i + 1) == Some(&b'\\') {
                    let mut j = i + 3;
                    while j < b.len() && b[j] != b'\'' {
                        j += 1;
                    }
                    i = j + 1;
                } else if let Some(n) = b[i + 1..].iter().take(5).position(|&x| x == b'\'')
                    && (n == 1 || !b[i + 1].is_ascii())
                {
                    i += n + 2;
                } else {
                    i += 1;
                }
            }
            b':' if b.get(i + 1) == Some(&b':') => {
                out.push((line, Tok::PathSep));
                i += 2;
            }
            b'{' => {
                out.push((line, Tok::Open));
                i += 1;
            }
            b'}' => {
                out.push((line, Tok::Close));
                i += 1;
            }
            b',' => {
                out.push((line, Tok::Comma));
                i += 1;
            }
            _ if c == b'_' || c.is_ascii_alphabetic() => {
                let s = i;
                while i < b.len() && (b[i] == b'_' || b[i].is_ascii_alphanumeric()) {
                    i += 1;
                }
                out.push((line, Tok::Ident(src[s..i].to_owned())));
            }
            _ => {
                if !c.is_ascii_whitespace() {
                    out.push((line, Tok::Other));
                }
                i += 1;
            }
        }
    }
    out
}

/// Violations in one source file, as `(line, message)`.
fn scan_source(src: &str) -> Vec<(usize, String)> {
    let toks = tokens(src);
    let mut out = Vec::new();
    let ident = |k: usize| match toks.get(k) {
        Some((_, Tok::Ident(s))) => Some(s.as_str()),
        _ => None,
    };
    for (k, (line, tok)) in toks.iter().enumerate() {
        let Tok::Ident(name) = tok else { continue };
        if let Some((_, why)) = BANNED_IDENTS.iter().find(|(b, _)| b == name) {
            out.push((*line, format!("`{name}` is banned here: {why}")));
        }
        if name == "clippy"
            && toks.get(k + 1).is_some_and(|t| t.1 == Tok::PathSep)
            && ident(k + 2).is_some_and(|n| n.starts_with("disallowed_"))
        {
            out.push((
                *line,
                "portable crates may not opt out of the clippy disallowed_* bans".into(),
            ));
        }
        if name == "std" && toks.get(k + 1).is_some_and(|t| t.1 == Tok::PathSep) {
            match toks.get(k + 2).map(|t| &t.1) {
                Some(Tok::Ident(m)) if BANNED_STD_MODULES.contains(&m.as_str()) => {
                    out.push((*line, format!("`std::{m}` is banned in portable code")));
                }
                Some(Tok::Open) => {
                    // `use std::{a, fs, b::c}`: check the first segment of each item.
                    let mut depth = 0;
                    let mut prev: Option<&Tok> = None;
                    for (l, t) in &toks[k + 2..] {
                        match t {
                            Tok::Open => depth += 1,
                            Tok::Close => {
                                depth -= 1;
                                if depth == 0 {
                                    break;
                                }
                            }
                            Tok::Ident(m)
                                if depth == 1
                                    && matches!(prev, Some(Tok::Open | Tok::Comma))
                                    && BANNED_STD_MODULES.contains(&m.as_str()) =>
                            {
                                out.push((*l, format!("`std::{m}` is banned in portable code")));
                            }
                            _ => {}
                        }
                        prev = Some(t);
                    }
                }
                _ => {}
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offline_verifier_cannot_enter_wasm_roots_via_any_dependency_kind() {
        for kind in [Value::Null, Value::from("dev"), Value::from("build")] {
            let meta = serde_json::json!({
                "packages": [
                    {"id": "r", "name": "mdbn-hosted-worker"},
                    {"id": "m", "name": "middle"},
                    {"id": "v", "name": "mdbn-backup-verify"}
                ],
                "resolve": {"nodes": [
                    {"id": "r", "deps": [{"pkg": "m", "dep_kinds": [{"kind": kind}]}]},
                    {"id": "m", "deps": [{"pkg": "v", "dep_kinds": [{"kind": null}]}]},
                    {"id": "v", "deps": []}
                ]}
            });
            assert_eq!(
                offline_verifier_violations(&meta, "mdbn-hosted-worker").len(),
                1
            );
            assert!(offline_verifier_violations(&meta, "mdbn-backup-verify").is_empty());
            let mut clean = meta;
            clean["resolve"]["nodes"][0]["deps"] = serde_json::json!([]);
            assert!(offline_verifier_violations(&clean, "mdbn-hosted-worker").is_empty());
        }
    }

    fn msgs(src: &str) -> Vec<usize> {
        scan_source(src).into_iter().map(|(l, _)| l).collect()
    }

    #[test]
    fn scan_finds_banned_paths_and_idents() {
        assert_eq!(
            msgs("use std::fs;\nfn f() { std::env::var(\"x\"); }"),
            vec![1, 2]
        );
        assert_eq!(
            msgs("use std::{\n    collections::BTreeMap,\n    fs,\n};"),
            vec![3]
        );
        assert_eq!(
            msgs("use std::{fmt, io::{self, Write}};"),
            Vec::<usize>::new()
        );
        assert_eq!(msgs("let m: HashMap<u8, u8>;"), vec![1]);
        assert_eq!(msgs("#![allow(clippy::disallowed_methods)]"), vec![1]);
        assert_eq!(msgs("use std::time::Duration;"), Vec::<usize>::new());
        assert_eq!(msgs("let i = std::time::Instant::now();"), vec![1]);
    }

    #[test]
    fn scan_ignores_comments_and_strings() {
        assert!(msgs("// std::fs and HashMap\n/// docs: std::env\n/* Instant */").is_empty());
        assert!(
            msgs("let s = \"std::fs HashMap\"; let r = r#\"Instant\"#; let c = '\"';").is_empty()
        );
        assert!(msgs("fn f<'a>(x: &'a str) -> char { 'x' }").is_empty());
    }

    #[test]
    fn lint_inheritance() {
        assert!(inherits_workspace_lints(
            "[package]\n[lints]\nworkspace = true\n"
        ));
        assert!(!inherits_workspace_lints(
            "[lints.clippy]\nworkspace = true\n"
        ));
    }

    fn fake_meta(sim_like: &str, features_on_dep: &str, default_fwd: bool) -> Value {
        let fwd = if default_fwd { r#"["fwd"]"# } else { "[]" };
        let text = format!(
            r#"{{
  "workspace_members": ["d", "s", "r", "m"],
  "packages": [
    {{"id": "d", "name": "mdbn-daemon", "features": {{}}, "dependencies": [
        {{"name": "mdbn-mid", "kind": null, "features": []}}]}},
    {{"id": "s", "name": "{sim_like}", "features": {{}}, "dependencies": [
        {{"name": "mdbn-replica", "kind": null, "features": ["testing"]}}]}},
    {{"id": "m", "name": "mdbn-mid", "features": {{"fwd": ["mdbn-replica/testing"], "default": {fwd}}}, "dependencies": [
        {{"name": "mdbn-replica", "kind": null, "features": [{features_on_dep}]}}]}},
    {{"id": "r", "name": "mdbn-replica", "features": {{"testing": []}}, "dependencies": []}}
  ],
  "resolve": {{"nodes": [
    {{"id": "d", "deps": [{{"pkg": "m", "dep_kinds": [{{"kind": null}}]}}]}},
    {{"id": "s", "deps": [{{"pkg": "r", "dep_kinds": [{{"kind": null}}]}}]}},
    {{"id": "m", "deps": [{{"pkg": "r", "dep_kinds": [{{"kind": null}}]}}]}},
    {{"id": "r", "deps": []}}
  ]}}
}}"#
        );
        serde_json::from_str(&text).unwrap()
    }

    #[test]
    fn testing_feature_rule_fires() {
        // Clean: only the (test-only) sim asks for it.
        assert!(
            testing_feature_violations(&fake_meta("mdbn-sim", "", false), "mdbn-daemon").is_empty()
        );
        // A shipped crate's dependency requests it transitively.
        let v = testing_feature_violations(
            &fake_meta("mdbn-sim", r#""testing""#, false),
            "mdbn-daemon",
        );
        assert_eq!(v.len(), 1, "{v:?}");
        // Through a default feature that forwards it.
        let v = testing_feature_violations(&fake_meta("mdbn-sim", "", true), "mdbn-daemon");
        assert_eq!(v.len(), 1, "{v:?}");
        // The real workspace is clean.
        if let Ok(meta) = cargo_metadata(&[]) {
            for (name, _) in workspace_members(&meta) {
                if !TEST_ONLY.contains(&name.as_str()) {
                    assert!(
                        testing_feature_violations(&meta, &name).is_empty(),
                        "{name}"
                    );
                }
            }
        }
    }

    fn noise_meta(features_on_dep: &str, default_fwd: bool) -> Value {
        let text =
            serde_json::to_string(&fake_meta("mdbn-sim", features_on_dep, default_fwd)).unwrap();
        serde_json::from_str(&text.replace("mdbn-replica", "mdbn-noise")).unwrap()
    }

    #[test]
    fn noise_testing_guard_rejects_direct_transitive_and_forwarded_requests() {
        let clean = noise_meta("", false);
        assert!(testing_feature_violations(&clean, "mdbn-daemon").is_empty());
        assert!(testing_feature_violations(&clean, "mdbn-noise").is_empty());
        let v = testing_feature_violations(&noise_meta(r#""testing""#, false), "mdbn-daemon");
        assert_eq!(v.len(), 1, "{v:?}");
        let v = testing_feature_violations(&noise_meta("", true), "mdbn-daemon");
        assert_eq!(v.len(), 1, "{v:?}");
        let mut requested = clean.clone();
        requested["packages"][0]["dependencies"][0]["features"] = serde_json::json!(["fwd"]);
        let v = testing_feature_violations(&requested, "mdbn-daemon");
        assert_eq!(v.len(), 1, "{v:?}");
        let mut direct = clean;
        direct["packages"][0]["dependencies"] = serde_json::json!([
            {"name": "mdbn-noise", "kind": null, "features": ["testing"]}
        ]);
        direct["resolve"]["nodes"][0]["deps"] = serde_json::json!([
            {"pkg": "r", "dep_kinds": [{"kind": null}]}
        ]);
        let v = testing_feature_violations(&direct, "mdbn-daemon");
        assert_eq!(v.len(), 1, "{v:?}");
    }

    #[test]
    fn guarded_producer_default_testing_is_rejected_for_itself_and_consumers() {
        for guarded in ["mdbn-replica", "mdbn-noise"] {
            let mut meta = if guarded == "mdbn-noise" {
                noise_meta("", false)
            } else {
                fake_meta("mdbn-sim", "", false)
            };
            meta["packages"][3]["features"]["default"] = serde_json::json!(["testing"]);
            for root in [guarded, "mdbn-daemon"] {
                let v = testing_feature_violations(&meta, root);
                assert_eq!(v.len(), 1, "{root}: {v:?}");
            }
        }
    }

    #[test]
    fn host_crypto_boundary_rejects_sdk_edges_and_allows_only_worker_in_wasm() {
        for kind in [
            Value::Null,
            Value::String("dev".into()),
            Value::String("build".into()),
        ] {
            let mut meta = fake_meta("mdbn-sim", "", false);
            // d -> m -> native; all three dependency kinds are forbidden.
            meta["packages"][2]["name"] = Value::String("mdbn-wire".into());
            meta["packages"][3]["name"] = Value::String("mdbn-noise".into());
            meta["resolve"]["nodes"][2]["deps"][0]["dep_kinds"][0]["kind"] = kind;
            for root in PORTABLE.iter().chain(WASM_ROOTS) {
                meta["packages"][0]["name"] = Value::String((*root).into());
                let expected = usize::from(*root != "mdbn-hosted-worker");
                assert_eq!(
                    host_crypto_violations(&meta, root).len(),
                    expected,
                    "{root}"
                );
            }
            // Direct portable edge, plus native roots actually reaching Noise.
            assert_eq!(host_crypto_violations(&meta, "mdbn-wire").len(), 1);
            meta["packages"][0]["name"] = Value::String("mdbn-daemon".into());
            assert!(host_crypto_violations(&meta, "mdbn-daemon").is_empty());
            assert!(host_crypto_violations(&meta, "mdbn-sim").is_empty());
        }
        assert!(DETERMINISTIC_LIBS.contains(&"mdbn-noise"));
        assert!(!PORTABLE.contains(&"mdbn-noise"));
        assert!(WASM_ROOTS.contains(&"mdbn-log-service"));
    }

    #[test]
    fn conformance_edge_requires_exact_declared_native_dev_dependency() {
        let native = "mdbn-platform-native";
        let conformance = "mdbn-conformance";
        assert!(conformance_test_edge(
            native,
            conformance,
            &Value::String("dev".into())
        ));
        for kind in [
            Value::Null,
            Value::String("normal".into()),
            Value::String("build".into()),
            Value::String("unknown".into()),
            Value::Bool(true),
            Value::Number(1.into()),
        ] {
            assert!(
                !conformance_test_edge(native, conformance, &kind),
                "{kind:?}"
            );
        }
        for from in [
            "mdbn-core",
            "mdbn-wire",
            "mdbn-store-file",
            "mdbn-daemon",
            "unknown",
        ] {
            assert!(!conformance_test_edge(
                from,
                conformance,
                &Value::String("dev".into())
            ));
        }
        for to in [
            "mdbn-core",
            "mdbn-wire",
            "mdbn-noise",
            "mdbn-sim",
            "unknown",
        ] {
            assert!(!conformance_test_edge(
                native,
                to,
                &Value::String("dev".into())
            ));
        }
        // The daemon's sync_pair CI edge: dev only, to the log server only.
        let dev = Value::String("dev".into());
        assert!(conformance_test_edge(
            "mdbn-daemon",
            "mdbn-log-server",
            &dev
        ));
        for kind in [
            Value::Null,
            Value::String("normal".into()),
            Value::String("build".into()),
        ] {
            assert!(!conformance_test_edge(
                "mdbn-daemon",
                "mdbn-log-server",
                &kind
            ));
        }
        assert!(!conformance_test_edge(
            "mdbn-daemon",
            "mdbn-log-conformance",
            &dev
        ));
        assert!(!conformance_test_edge(
            "mdbn-local-host",
            "mdbn-log-server",
            &dev
        ));
        let daemon_rules = RULES
            .iter()
            .find(|(name, _)| *name == "mdbn-daemon")
            .unwrap()
            .1;
        assert!(!daemon_rules.contains(&"mdbn-log-server"));
        let native_rules = RULES.iter().find(|(name, _)| *name == native).unwrap().1;
        assert_eq!(native_rules, &["mdbn-core", "mdbn-store-file"]);
        assert!(!native_rules.contains(&conformance));
    }

    #[test]
    fn every_rule_names_internal_crates_only() {
        let names: BTreeSet<&str> = RULES.iter().map(|(k, _)| *k).collect();
        for (k, deps) in RULES {
            for d in *deps {
                assert!(names.contains(d), "{k} -> {d}");
                assert_ne!(k, d);
            }
        }
    }
}
