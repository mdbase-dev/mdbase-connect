//! Files held when the old connector was taken over, resolved like replica
//! holds (`collection.holds` / `collection.resolve_hold`).
//!
//! A takeover hold leaves the user's version in the folder; the version the old
//! engine meant to write (or its delete) is kept in `<legacy>/<id>/bytes/<hex>`.
//! `import.json` stays as evidence; resolved paths are listed in
//! `<legacy>/<id>/resolved.json`, and the record's hold count is what is left.

use std::collections::BTreeSet;
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
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Resolved {
    schema_version: u32,
    paths: BTreeSet<String>,
}

fn resolved_path(legacy: &Path, collection: &str) -> PathBuf {
    Adapter::collection_dir(legacy, collection).join("resolved.json")
}

fn load_resolved(legacy: &Path, collection: &str) -> io::Result<Resolved> {
    match fsutil::read_optional(&resolved_path(legacy, collection))? {
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
    let Some(ev) = Evidence::load(legacy, collection)? else {
        return Ok(Vec::new());
    };
    let resolved = load_resolved(legacy, collection)?;
    let dir = Adapter::collection_dir(legacy, collection);
    let since = std::fs::metadata(dir.join("import.json"))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64);
    let mut out = Vec::new();
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
    fsutil::write_atomic(&resolved_path(legacy, collection), &bytes)?;
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
