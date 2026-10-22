//! Files held when the old connector was taken over, resolved like replica
//! holds (`collection.holds` / `collection.resolve_hold`).
//!
//! A takeover hold leaves the user's version in the folder; the version the old
//! engine meant to write (or its delete) is kept in `<legacy>/<id>/bytes/<hex>`.
//! `import.json` stays as evidence; resolved paths are listed in
//! `<legacy>/<id>/resolved.json`, and the record's hold count is what is left.
//!
//! A resolution that writes is recorded in `<legacy>/<id>/resolving.json` before it
//! is submitted, with its mutation ID: a hold is marked resolved only once that
//! mutation is confirmed. Pending or unknown outcomes leave the hold open, and a
//! retry reuses the same mutation ID, so the replica answers with the original
//! receipt instead of applying it twice.
//!
//! `collection` must be a canonical collection ID (lower-case, hyphenated UUID);
//! anything else is refused before a path is built from it.

use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::adapter::{Adapter, Evidence};
use super::record::{CollectionState, Record};
use crate::fsutil;

/// Hold IDs of takeover holds start with this (never a UUID).
pub const ID_PREFIX: &str = "takeover-";

/// The stable `HoldSummary.reason` of a takeover hold.
pub const REASON: &str = "taken_over";

/// One open takeover hold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Held {
    /// `takeover-<32 hex>`, from the path.
    pub id: String,
    /// Collection-relative path.
    pub path: String,
    /// The takeover's own reason (free text, as recorded in the import).
    pub cause: String,
    /// The old engine's intended version: bytes, or `None` for a delete.
    pub intended: Option<Vec<u8>>,
    /// When the takeover recorded it (ms; the import's time).
    pub since: i64,
    /// An unsent edit from an old hosted mirror (`mirror_import`), rather than an
    /// interrupted local write: the folder has the current version, `intended` is
    /// the edit that never uploaded.
    pub unsent: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Resolved {
    schema_version: u32,
    paths: BTreeSet<String>,
}

/// Whether `s` is a canonical collection ID: the exact lower-case, hyphenated
/// UUID spelling, not nil. Checked on bytes, before any path is built from it.
pub fn is_collection_id(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(at, &c)| {
            if matches!(at, 8 | 13 | 18 | 23) {
                c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
            }
        })
        && b.iter().any(|&c| c != b'0' && c != b'-')
}

/// The takeover directory of `collection`, refusing a non-canonical ID.
fn dir_of(legacy: &Path, collection: &str) -> io::Result<PathBuf> {
    if !is_collection_id(collection) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a canonical collection ID",
        ));
    }
    Ok(Adapter::collection_dir(legacy, collection))
}

fn resolved_path(legacy: &Path, collection: &str) -> io::Result<PathBuf> {
    Ok(dir_of(legacy, collection)?.join("resolved.json"))
}

fn load_resolved(legacy: &Path, collection: &str) -> io::Result<Resolved> {
    match fsutil::read_optional(&resolved_path(legacy, collection)?)? {
        None => Ok(Resolved::default()),
        Some(b) => serde_json::from_slice(&b)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "malformed resolved holds")),
    }
}

/// The hold ID of `path`.
pub fn hold_id(path: &str) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, path.as_bytes());
    format!("{ID_PREFIX}{}", &crate::secrets::hex(digest.as_ref())[..32])
}

/// The open takeover holds of `collection`, in evidence order.
pub fn open(legacy: &Path, collection: &str) -> io::Result<Vec<Held>> {
    let dir = dir_of(legacy, collection)?;
    let resolved = load_resolved(legacy, collection)?;
    let since_of = |file: &Path| {
        std::fs::metadata(file)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as i64)
    };
    let mut out = Vec::new();
    let unsent = super::mirror_import::holds(legacy, collection)?;
    if !unsent.is_empty() {
        let since = since_of(&dir.join("mirror").join("capture.json"));
        for (path, cause, bytes) in unsent {
            if resolved.paths.contains(&path) {
                continue;
            }
            out.push(Held {
                id: hold_id(&path),
                path,
                cause,
                intended: Some(bytes),
                since,
                unsent: true,
            });
        }
    }
    let Some(ev) = Evidence::load(legacy, collection)? else {
        return Ok(out);
    };
    let since = since_of(&dir.join("import.json"));
    for h in ev.holds {
        if resolved.paths.contains(&h.path) {
            continue;
        }
        let intended = match &h.intended {
            None => None,
            Some(hex) => Some(intended_bytes(&dir, hex)?),
        };
        out.push(Held {
            id: hold_id(&h.path),
            path: h.path,
            cause: h.reason,
            intended,
            since,
            unsent: false,
        });
    }
    Ok(out)
}

/// The kept bytes named `hex`, checked against their name.
fn intended_bytes(dir: &Path, hex: &str) -> io::Result<Vec<u8>> {
    let bad = || io::Error::new(io::ErrorKind::InvalidData, "kept version does not match");
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(bad());
    }
    let bytes = std::fs::read(dir.join("bytes").join(hex))?;
    if mdbn_legacy::revision_of(&bytes) != format!("sha256:{hex}") {
        return Err(bad());
    }
    Ok(bytes)
}

/// Mark `paths` resolved and set the record's count to what is left (the
/// collection becomes `Complete` at zero). The caller holds the takeover gate.
/// Returns the holds left.
pub fn resolve(
    record_path: &Path,
    legacy: &Path,
    collection: &str,
    paths: &[String],
) -> io::Result<u64> {
    let mut resolved = load_resolved(legacy, collection)?;
    resolved.schema_version = 1;
    resolved.paths.extend(paths.iter().cloned());
    let bytes = serde_json::to_vec_pretty(&resolved).map_err(io::Error::other)?;
    fsutil::write_atomic(&resolved_path(legacy, collection)?, &bytes)?;
    // A resolved hold has no resolution left in flight.
    let mut resolving = load_resolving(legacy, collection)?;
    if paths.iter().any(|p| resolving.holds.contains_key(p)) {
        for p in paths {
            resolving.holds.remove(p);
        }
        save_resolving(legacy, collection, &resolving)?;
    }
    let left = open(legacy, collection)?.len() as u64;
    if let Some(mut record) = Record::load(record_path)?
        && let Some(c) = record.collections.get_mut(collection)
        && c.holds != left
    {
        c.holds = left;
        if left == 0 && c.state == CollectionState::Held {
            c.state = CollectionState::Complete;
        }
        record.save(record_path)?;
    }
    Ok(left)
}

/// A resolution in flight: its action and the identity it was submitted with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resolution {
    /// The requested action (`take_theirs`, `keep_both`).
    pub how: String,
    /// The mutation ID every submission of this resolution uses.
    pub mutation: [u8; 16],
    /// The record ID a created record uses (keep both, or take the other for a
    /// file the replica does not have).
    pub record: [u8; 16],
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Resolving {
    schema_version: u32,
    holds: BTreeMap<String, Resolution>,
}

fn resolving_path(legacy: &Path, collection: &str) -> io::Result<PathBuf> {
    Ok(dir_of(legacy, collection)?.join("resolving.json"))
}

fn load_resolving(legacy: &Path, collection: &str) -> io::Result<Resolving> {
    match fsutil::read_optional(&resolving_path(legacy, collection)?)? {
        None => Ok(Resolving::default()),
        Some(b) => serde_json::from_slice(&b).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "malformed resolutions in flight",
            )
        }),
    }
}

fn save_resolving(legacy: &Path, collection: &str, r: &Resolving) -> io::Result<()> {
    let r = Resolving {
        schema_version: 1,
        holds: r.holds.clone(),
    };
    let bytes = serde_json::to_vec_pretty(&r).map_err(io::Error::other)?;
    fsutil::write_atomic(&resolving_path(legacy, collection)?, &bytes)
}

/// The resolution of `path` in flight, if any.
pub fn resolving(legacy: &Path, collection: &str, path: &str) -> io::Result<Option<Resolution>> {
    Ok(load_resolving(legacy, collection)?.holds.remove(path))
}

/// Start (or continue) resolving `path` with `how`, durably before anything is
/// submitted. A resolution already in flight keeps its identity; asking for a
/// different action while one is in flight is refused (`Ok(Err(existing))`).
pub fn begin(
    legacy: &Path,
    collection: &str,
    path: &str,
    how: &str,
    fresh: impl FnOnce() -> ([u8; 16], [u8; 16]),
) -> io::Result<Result<Resolution, Resolution>> {
    let mut all = load_resolving(legacy, collection)?;
    if let Some(r) = all.holds.get(path) {
        return Ok(if r.how == how {
            Ok(r.clone())
        } else {
            Err(r.clone())
        });
    }
    let (mutation, record) = fresh();
    let r = Resolution {
        how: how.into(),
        mutation,
        record,
    };
    all.holds.insert(path.into(), r.clone());
    save_resolving(legacy, collection, &all)?;
    Ok(Ok(r))
}

/// How a submitted resolution ended, as its receipt says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Applied and confirmed: the only outcome that resolves a hold.
    Confirmed,
    /// Accepted locally, not yet confirmed.
    Pending,
    /// The replica cannot yet say whether it applied.
    Unknown,
    /// Refused: nothing was applied.
    Rejected,
}

/// Settle a resolution of `path` by its outcome. Only `Confirmed` resolves the
/// hold. `Pending` and `Unknown` leave it open with its identity, to be retried
/// or read back. `Rejected` is final: the hold stays open and the identity is
/// dropped, so the user can choose again. Returns whether the hold resolved.
pub fn settle(
    record_path: &Path,
    legacy: &Path,
    collection: &str,
    path: &str,
    outcome: Outcome,
) -> io::Result<bool> {
    match outcome {
        Outcome::Confirmed => {
            resolve(record_path, legacy, collection, &[path.to_string()])?;
            Ok(true)
        }
        Outcome::Pending | Outcome::Unknown => Ok(false),
        Outcome::Rejected => {
            let mut all = load_resolving(legacy, collection)?;
            if all.holds.remove(path).is_some() {
                save_resolving(legacy, collection, &all)?;
            }
            Ok(false)
        }
    }
}

/// The resolutions in flight for `collection`, by path.
pub fn in_flight(legacy: &Path, collection: &str) -> io::Result<Vec<(String, Resolution)>> {
    Ok(load_resolving(legacy, collection)?
        .holds
        .into_iter()
        .collect())
}

/// Where "keep both" may put the old engine's version, in order:
/// `<stem> (old version).<ext>`, then `<stem> (old version 2).<ext>`...
pub fn keep_both_paths(path: &str) -> Vec<String> {
    let (dir, name) = path.rsplit_once('/').map_or(("", path), |(d, n)| (d, n));
    let (stem, ext) = name.rsplit_once('.').map_or((name, ""), |(s, e)| (s, e));
    (1..=50)
        .map(|n| {
            let suffix = if n == 1 {
                " (old version)".to_string()
            } else {
                format!(" (old version {n})")
            };
            let file = if ext.is_empty() {
                format!("{stem}{suffix}")
            } else {
                format!("{stem}{suffix}.{ext}")
            };
            if dir.is_empty() {
                file
            } else {
                format!("{dir}/{file}")
            }
        })
        .collect()
}
