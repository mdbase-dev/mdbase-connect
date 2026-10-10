//! Old hosted-mirror state on a device: which mirrors exist, where each one stood, and
//! which local edits it had **not** uploaded.
//!
//! Migration doesn't need mirror state to be safe. Old mirror folders join at the
//! `migration-cutover` position, and their un-uploaded edits are ingested as outside
//! edits (legacy hosted mirror compatibility). This reader serves the **rehearsal
//! oracle** and the migration report: it lists each queued edit, so the oracle can
//! check that every one of them arrives, or is held.
//!
//! **Three formats** (`MC/crates/connect-mirror`, `MC/crates/connect-agent/src/mirrors`,
//! `MC/packages/sync`):
//!
//! | Engine | Where | Pending writes |
//! |---|---|---|
//! | Rust daemon beta.9–38 | `<state>/mirrors.json` v2 + `<state>/mirrors/<replica>/state.json` with no `engine_version` | an explicit `pending[]` queue |
//! | Rust daemon beta.39+ | the same registry; `state.json` with `engine_version: 3`, plus `state.journal.ndjson` | computed: file SHA-256 vs the base `hash` |
//! | TS `mdbase-mirror` CLI | `<base>/mirrors/<digest>/{profile.json, mirror-state.json, mirror-journal.ndjson}` | as Rust v3 |
//!
//! A batch in flight keeps its acknowledged changes only in the journal, so the journal
//! is replayed. Credentials (OS keyring, or the TS `credentials.json`) are **never
//! read**.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::{Error, Result, hex, sha256};

/// Which engine wrote the state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    /// Rust daemon, beta.9–38: explicit `pending[]`.
    RustLegacy,
    /// Rust daemon, beta.39+: engine v3 with a journal.
    RustV3,
    /// The TS `mdbase-mirror` CLI, engine v3.
    TsV3,
}

/// A `mirrors.json` entry (Rust daemon).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistryEntry {
    /// Hosted collection ID.
    pub collection_id: String,
    /// The mirror replica ID (what the server revokes).
    pub replica_id: String,
    /// The mirror folder root.
    pub path: PathBuf,
    /// `read_only` or `read_write`.
    pub mode: String,
    /// `provisioning` / `active` / `revoking` / `removing`.
    pub lifecycle: String,
    /// True if an authority promotion is in progress (the mirror is fenced).
    pub promoting: bool,
}

/// What the mirror last accepted for a record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BaseEntry {
    /// Collection-relative path.
    pub path: String,
    /// Bare lowercase hex SHA-256 of the bytes last accepted locally.
    pub hash: String,
}

/// A mutation the mirror had sent, or was about to send, without a receipt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unreceipted {
    /// The deterministic mutation ID. A server may already have applied it.
    pub mutation_id: String,
    /// The record.
    pub record_id: String,
    /// `put` / `move` / `delete`.
    pub operation: String,
    /// The path, when the mutation carries one.
    pub path: Option<String>,
}

/// One mirror's state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MirrorState {
    /// The engine format.
    pub engine: Engine,
    /// Replica ID.
    pub replica_id: String,
    /// Collection ID, where the state records it (TS profile). Rust state doesn't, so
    /// it comes from the registry.
    pub collection_id: Option<String>,
    /// `read_only` or `read_write`.
    pub mode: String,
    /// The last checkpointed authority sequence.
    pub cursor: u64,
    /// Whether the incremental base is trustworthy (`last_completed_plan` is set, or
    /// legacy state).
    pub base_trusted: bool,
    /// Base records by ID, after replaying any in-flight batch's receipts.
    pub records: BTreeMap<String, BaseEntry>,
    /// Mutations without a receipt: a batch's unfinished actions (v3), or the explicit
    /// queue (legacy).
    pub unreceipted: Vec<Unreceipted>,
}

/// A local edit the mirror had not uploaded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Queued {
    /// A known record whose file differs from the base.
    Update {
        /// Record ID.
        record_id: String,
        /// Path.
        path: String,
        /// `sha256:<hex>` of the local bytes.
        revision: String,
    },
    /// A file with no base entry.
    Create {
        /// Path.
        path: String,
        /// `sha256:<hex>` of the local bytes.
        revision: String,
    },
    /// A base entry whose file is gone (`read_write` mirrors only upload deletes).
    Delete {
        /// Record ID.
        record_id: String,
        /// Its last path.
        path: String,
    },
}

/// Read `<state_dir>/mirrors.json`. A missing file means no mirrors.
pub fn read_registry(state_dir: &Path) -> Result<Vec<RegistryEntry>> {
    let path = state_dir.join("mirrors.json");
    let Some(v) = read_json_opt(&path)? else {
        return Ok(Vec::new());
    };
    if v.get("version").and_then(Value::as_u64) != Some(2) {
        return Err(Error::format(&path, "mirrors.json version is not 2"));
    }
    let mut out = Vec::new();
    for m in v
        .get("mirrors")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::format(&path, "mirrors is not an array"))?
    {
        let s = |k: &str| {
            m.get(k)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| Error::format(&path, format!("mirror entry without {k}")))
        };
        out.push(RegistryEntry {
            collection_id: s("collection_id")?,
            replica_id: s("replica_id")?,
            path: PathBuf::from(s("path")?),
            mode: s("mode")?,
            lifecycle: s("lifecycle")?,
            promoting: m.get("promotion").is_some_and(|p| !p.is_null()),
        });
    }
    out.sort_by(|a, b| a.replica_id.cmp(&b.replica_id));
    Ok(out)
}

/// Read a Rust daemon mirror's state (`<state_dir>/mirrors/<replica_id>/`).
pub fn read_rust_state(state_dir: &Path, replica_id: &str) -> Result<Option<MirrorState>> {
    if !crate::is_uuid(replica_id) {
        return Err(Error::format(state_dir, "replica id is not a UUID"));
    }
    let dir = state_dir.join("mirrors").join(replica_id);
    let Some(state) = read_json_opt(&dir.join("state.json"))? else {
        return Ok(None);
    };
    let journal = read_journal(&dir.join("state.journal.ndjson"), false)?;
    parse_state(&dir, state, journal, None, false).map(Some)
}

/// Read every TS CLI mirror under `base` (`$MDBASE_CONNECT_MIRROR_STATE_DIR`, or the
/// per-OS default). Directories without a `profile.json` are skipped.
pub fn read_ts_mirrors(base: &Path) -> Result<Vec<MirrorState>> {
    let root = base.join("mirrors");
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(Error::io(&root, e)),
    };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    let mut out = Vec::new();
    for dir in dirs {
        let Some(profile) = read_json_opt(&dir.join("profile.json"))? else {
            continue;
        };
        let collection_id = profile
            .get("collection_id")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let Some(state) = read_json_opt(&dir.join("mirror-state.json"))? else {
            continue;
        };
        let journal = read_journal(&dir.join("mirror-journal.ndjson"), true)?;
        out.push(parse_state(&dir, state, journal, collection_id, true)?);
    }
    Ok(out)
}

fn parse_state(
    dir: &Path,
    state: Value,
    journal: Vec<Value>,
    collection_id: Option<String>,
    ts: bool,
) -> Result<MirrorState> {
    let fmt = |d: &str| Error::format(dir, d.to_owned());
    let engine_version = state
        .get("engine_version")
        .map(|value| {
            value
                .as_u64()
                .ok_or_else(|| fmt("engine_version is not an unsigned integer"))
        })
        .transpose()?;
    let engine = match (ts, engine_version) {
        (true, Some(3)) => Engine::TsV3,
        (false, Some(3)) => Engine::RustV3,
        (false, None) => Engine::RustLegacy,
        _ => return Err(fmt("unsupported mirror engine_version")),
    };
    let replica_id = state
        .get("replica_id")
        .and_then(Value::as_str)
        .ok_or_else(|| fmt("state without replica_id"))?
        .to_owned();
    let mut records = BTreeMap::new();
    for (id, e) in state
        .get("records")
        .and_then(Value::as_object)
        .ok_or_else(|| fmt("state without records"))?
    {
        records.insert(
            id.clone(),
            base_entry(e).ok_or_else(|| fmt("bad record entry"))?,
        );
    }
    let mut unreceipted = Vec::new();
    if engine == Engine::RustLegacy {
        for p in array_field(&state, "pending", dir)?.into_iter().flatten() {
            let m = p
                .get("mutation")
                .ok_or_else(|| fmt("pending without mutation"))?;
            unreceipted.push(mutation(m).ok_or_else(|| fmt("bad pending mutation"))?);
        }
    } else if let Some(batch) = state.get("batch").filter(|b| !b.is_null()) {
        if !batch.is_object() {
            return Err(fmt("batch is not an object"));
        }
        let plan = batch
            .pointer("/plan/fingerprint")
            .and_then(Value::as_str)
            .ok_or_else(|| fmt("batch without plan fingerprint"))?;
        let actions = batch
            .pointer("/plan/actions")
            .and_then(Value::as_array)
            .ok_or_else(|| fmt("plan without actions array"))?
            .iter()
            .map(|action| {
                action
                    .get("action_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| fmt("plan action without action_id"))
            })
            .collect::<Result<Vec<_>>>()?;
        let mut next_action = batch
            .get("next_action")
            .and_then(Value::as_u64)
            .and_then(|next| usize::try_from(next).ok())
            .filter(|next| *next <= actions.len())
            .ok_or_else(|| fmt("invalid next_action"))?;
        // Replay the original engines' next-action boundary, not an unordered
        // set of receipts. Rust rejects foreign/duplicate/out-of-order events;
        // TS ignores foreign plans, prior receipts and receipts after completion.
        let mut receipted: BTreeSet<String> = array_field(batch, "receipts", dir)?
            .ok_or_else(|| fmt("batch without receipts"))?
            .iter()
            .map(|r| {
                r.get("action_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .ok_or_else(|| fmt("receipt without action_id"))
            })
            .collect::<Result<_>>()?;
        for event in &journal {
            let event_plan = event
                .get("plan_fingerprint")
                .and_then(Value::as_str)
                .ok_or_else(|| fmt("journal event without plan fingerprint"))?;
            if event_plan != plan {
                if ts {
                    continue;
                }
                return Err(fmt("journal belongs to another plan"));
            }
            let kind = event
                .get(if ts { "type" } else { "event" })
                .and_then(Value::as_str);
            match kind {
                Some("receipt") => {}
                Some("phase") => continue,
                Some("effects_complete") if ts => continue,
                _ => return Err(fmt("unsupported journal event")),
            }
            let action = event
                .pointer("/receipt/action_id")
                .and_then(Value::as_str)
                .ok_or_else(|| fmt("receipt without action_id"))?;
            match actions.get(next_action) {
                Some(expected) if *expected == action => {}
                Some(_) if ts && receipted.contains(action) => continue,
                None if ts => continue,
                _ => return Err(fmt("journal receipt is out of sequence")),
            }
            next_action += 1;
            receipted.insert(action.to_owned());
            let delta = event
                .get("delta")
                .ok_or_else(|| fmt("receipt without delta"))?;
            if !delta.is_object() {
                return Err(fmt("receipt delta is not an object"));
            }
            if ts {
                for (id, v) in object_field(delta, "records", dir)?.into_iter().flatten() {
                    if v.is_null() {
                        records.remove(id);
                    } else {
                        let entry = base_entry(v).ok_or_else(|| fmt("bad record delta"))?;
                        records.insert(id.clone(), entry);
                    }
                }
            } else {
                let id = delta
                    .get("state_identity")
                    .and_then(Value::as_str)
                    .ok_or_else(|| fmt("delta without state_identity"))?;
                match delta.pointer("/record/operation").and_then(Value::as_str) {
                    Some("put") => {
                        let e = delta
                            .pointer("/record/value")
                            .and_then(base_entry)
                            .ok_or_else(|| fmt("bad record delta"))?;
                        records.insert(id.to_owned(), e);
                    }
                    Some("remove") => {
                        records.remove(id);
                    }
                    Some("unchanged") => {}
                    _ => return Err(fmt("unsupported record delta operation")),
                }
            }
        }
        let payloads = batch
            .get("payloads")
            .filter(|value| value.is_object())
            .ok_or_else(|| fmt("batch without payloads object"))?;
        let mutations = object_field(payloads, "mutations", dir)?;
        for (action_id, m) in mutations.into_iter().flatten() {
            if !receipted.contains(action_id) {
                unreceipted.push(mutation(m).ok_or_else(|| fmt("bad batch mutation"))?);
            }
        }
    }
    unreceipted.sort_by(|a, b| a.mutation_id.cmp(&b.mutation_id));
    Ok(MirrorState {
        engine,
        replica_id,
        collection_id,
        mode: match state.get("mode") {
            None => "read_write",
            Some(value) => value
                .as_str()
                .filter(|mode| matches!(*mode, "read_only" | "read_write"))
                .ok_or_else(|| fmt("unsupported mirror mode"))?,
        }
        .to_owned(),
        cursor: state
            .get("cursor")
            .map(|value| {
                value
                    .as_u64()
                    .ok_or_else(|| fmt("cursor is not an unsigned integer"))
            })
            .transpose()?
            .unwrap_or(0),
        base_trusted: engine == Engine::RustLegacy
            || state
                .get("last_completed_plan")
                .is_some_and(|v| !v.is_null()),
        records,
        unreceipted,
    })
}

// Absence retains legacy defaults; malformed present fields must never turn into an
// empty queue/base. Diagnostics name only schema fields, not their document values.
fn array_field<'a>(v: &'a Value, key: &str, dir: &Path) -> Result<Option<&'a Vec<Value>>> {
    v.get(key)
        .map(|value| {
            value
                .as_array()
                .ok_or_else(|| Error::format(dir, format!("{key} is not an array")))
        })
        .transpose()
}

fn object_field<'a>(
    v: &'a Value,
    key: &str,
    dir: &Path,
) -> Result<Option<&'a serde_json::Map<String, Value>>> {
    v.get(key)
        .map(|value| {
            value
                .as_object()
                .ok_or_else(|| Error::format(dir, format!("{key} is not an object")))
        })
        .transpose()
}

fn base_entry(v: &Value) -> Option<BaseEntry> {
    Some(BaseEntry {
        path: v.get("path")?.as_str()?.to_owned(),
        hash: v.get("hash")?.as_str()?.to_owned(),
    })
}

fn mutation(m: &Value) -> Option<Unreceipted> {
    let path = m
        .get("path")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            // Legacy mutations carried the path inside `input`.
            m.pointer("/input/path")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    Some(Unreceipted {
        mutation_id: m.get("mutation_id")?.as_str()?.to_owned(),
        record_id: m.get("record_id")?.as_str()?.to_owned(),
        operation: m.get("operation")?.as_str()?.to_owned(),
        path,
    })
}

/// The local edits the mirror had not uploaded, computed as the v3 engine does: Markdown
/// and `.base` files under `root` (skipping `.git`, `.mdbase`, `node_modules` and temp
/// files) against the base. A file at a new path whose bytes equal exactly one base
/// entry's is a move, and is reported as an update at the new path.
pub fn queued_writes(state: &MirrorState, root: &Path) -> Result<Vec<Queued>> {
    let mut local = BTreeMap::new();
    scan(root, root, &mut local)?;
    let by_path: BTreeMap<&str, (&String, &BaseEntry)> = state
        .records
        .iter()
        .map(|(id, e)| (e.path.as_str(), (id, e)))
        .collect();
    let mut by_hash: BTreeMap<&str, Vec<&String>> = BTreeMap::new();
    for (id, e) in &state.records {
        by_hash.entry(e.hash.as_str()).or_default().push(id);
    }
    let mut seen: BTreeSet<&String> = BTreeSet::new();
    let mut out = Vec::new();
    for (path, digest) in &local {
        let revision = format!("sha256:{digest}");
        if let Some((id, base)) = by_path.get(path.as_str()) {
            seen.insert(id);
            if base.hash != *digest {
                out.push(Queued::Update {
                    record_id: (*id).clone(),
                    path: path.clone(),
                    revision,
                });
            }
            continue;
        }
        match by_hash.get(digest.as_str()).map(Vec::as_slice) {
            Some([id]) if !local.contains_key(&state.records[*id].path) => {
                seen.insert(id);
                out.push(Queued::Update {
                    record_id: (*id).clone(),
                    path: path.clone(),
                    revision,
                });
            }
            _ => out.push(Queued::Create {
                path: path.clone(),
                revision,
            }),
        }
    }
    if state.mode == "read_write" {
        for (id, base) in &state.records {
            if !seen.contains(id) && !local.contains_key(&base.path) {
                out.push(Queued::Delete {
                    record_id: id.clone(),
                    path: base.path.clone(),
                });
            }
        }
    }
    Ok(out)
}

fn scan(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) -> Result<()> {
    let entries = std::fs::read_dir(dir).map_err(|e| Error::io(dir, e))?;
    for entry in entries {
        let entry = entry.map_err(|e| Error::io(dir, e))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let ty = entry.file_type().map_err(|e| Error::io(&path, e))?;
        if ty.is_dir() {
            if !matches!(name.as_str(), ".git" | ".mdbase" | "node_modules") {
                scan(root, &path, out)?;
            }
            continue;
        }
        let temp = name.starts_with(".tmp")
            || name.ends_with(".tmp")
            || name.contains(".mdbase-sync-stage-");
        if !ty.is_file() || temp || !(name.ends_with(".md") || name.ends_with(".base")) {
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .map_err(|_| Error::format(&path, "outside the mirror root"))?
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let bytes = std::fs::read(&path).map_err(|e| Error::io(&path, e))?;
        out.insert(rel, hex(&sha256(&bytes)));
    }
    Ok(())
}

fn read_json_opt(path: &Path) -> Result<Option<Value>> {
    match std::fs::read(path) {
        Ok(b) => serde_json::from_slice(&b)
            .map(Some)
            .map_err(|e| Error::format(path, json_detail(&e))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Error::io(path, e)),
    }
}

/// Rust replays only newline-terminated events. TS also accepts a valid final
/// unterminated event, but ignores an invalid unterminated tail. A corrupt complete
/// line is an error in both engines, even when it is the last event.
fn read_journal(path: &Path, ts: bool) -> Result<Vec<Value>> {
    let bytes = match std::fs::read(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(Error::io(path, e)),
    };
    let mut out = Vec::new();
    for (i, line) in bytes.split_inclusive(|byte| *byte == b'\n').enumerate() {
        let complete = line.ends_with(b"\n");
        if !complete && !ts {
            break;
        }
        if line == b"\n" {
            continue;
        }
        match serde_json::from_slice(line) {
            Ok(v) => out.push(v),
            Err(_) if !complete => break,
            Err(e) => {
                return Err(Error::format(
                    path,
                    format!("journal line {}: {}", i + 1, json_detail(&e)),
                ));
            }
        }
    }
    Ok(out)
}

/// Category and position only: mirror state holds document text, and `serde_json`'s
/// message can quote it.
fn json_detail(e: &serde_json::Error) -> String {
    format!(
        "{:?} error at line {} column {}",
        e.classify(),
        e.line(),
        e.column()
    )
}
