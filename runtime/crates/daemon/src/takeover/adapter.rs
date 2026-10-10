//! The daemon side of `mdbn_takeover::takeover::Daemon`: the T4 guarded publish and
//! holds, the T5 import into retained evidence, and registration hand-off.
//!
//! Everything it keeps goes under `<state>/legacy/<collection>/`, owner-only:
//! - `evidence/`: the T3 copy of the old state (written by the library);
//! - `import.json`: the T5 import (record IDs, grant/setup rows, journal and receipt
//!   evidence, tombstones) plus the T4 holds and roll-forwards of this run;
//! - `bytes/<sha256>`: content-addressed bytes: the intended version of each held
//!   file, and the previous version of each file a roll-forward replaced or deleted,
//!   so nothing the old system left behind is lost and rollback (§6.1) can restore it.
//!
//! **The guarded publisher is unavailable.** Old daemon/engine locks do not
//! exclude outside editors. Until this adapter can use the hardened native
//! never-clobber protocol, T4 returns a typed refusal and durably HOLDs every
//! proposed create, replacement or deletion. It never touches collection bytes
//! or sibling temporary/crash evidence. The intended bytes/deletion and original
//! engine transaction remain in retained evidence; no roll-forward is claimed.

use std::collections::BTreeMap;
use std::io;
use std::path::{Component, Path, PathBuf};

use base64::Engine as _;
use mdbn_legacy::connector::{JournalRow, ReceiptImport, TombstoneRow};
use mdbn_legacy::revision_of;
use mdbn_takeover::takeover::{Daemon, Import, Published};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::fsutil;

/// A file held at T4.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hold {
    /// Collection-relative path. The user's bytes stay in the folder.
    pub path: String,
    /// Why.
    pub reason: String,
    /// `bytes/<hex>` of the version the old engine intended (`None`: a delete).
    pub intended: Option<String>,
}

/// A file T4 rolled forward.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RolledForward {
    /// Collection-relative path.
    pub path: String,
    /// `bytes/<hex>` of the replaced version (`None`: the file didn't exist).
    pub replaced: Option<String>,
    /// Whether it was a delete.
    pub deleted: bool,
}

/// The daemon, as one takeover run sees it.
pub struct Adapter {
    legacy_dir: PathBuf,
    store_ids: BTreeMap<String, String>,
    collection: String,
    holds: Vec<Hold>,
    rolled: Vec<RolledForward>,
    /// Collections whose v2 marker is in place, in order: the server registers them.
    pub registered: Vec<(String, PathBuf)>,
}

#[cfg(test)]
thread_local! {
    /// Test failpoint: the step at which this thread "crashes" (panics).
    pub static CRASH_AT: std::cell::Cell<Option<&'static str>> =
        const { std::cell::Cell::new(None) };
}

/// Crash here if a test asked for it (no-op outside tests).
pub fn failpoint(_step: &'static str) {
    #[cfg(test)]
    if CRASH_AT.with(|c| c.get()) == Some(_step) {
        panic!("injected crash at {_step}");
    }
}

impl Adapter {
    /// An adapter keeping evidence under `legacy_dir` (`<state>/legacy`), with the
    /// store IDs the driver issued durably before the run.
    pub fn new(legacy_dir: PathBuf, store_ids: BTreeMap<String, String>) -> Adapter {
        Adapter {
            legacy_dir,
            store_ids,
            collection: String::new(),
            holds: Vec::new(),
            rolled: Vec::new(),
            registered: Vec::new(),
        }
    }

    /// Start a collection: T4 results are collected for its import.
    pub fn begin(&mut self, collection: &str) {
        self.collection = collection.to_owned();
        self.holds.clear();
        self.rolled.clear();
    }

    /// `<state>/legacy/<collection>`.
    pub fn collection_dir(legacy_dir: &Path, collection: &str) -> PathBuf {
        legacy_dir.join(collection)
    }

    fn dir(&self) -> PathBuf {
        Self::collection_dir(&self.legacy_dir, &self.collection)
    }

    /// Keep `bytes` under `bytes/<hex>`; returns the hex digest.
    fn keep(&self, bytes: &[u8]) -> io::Result<String> {
        let rev = revision_of(bytes);
        let hex = rev.trim_start_matches("sha256:").to_owned();
        let dir = self.dir().join("bytes");
        fsutil::ensure_private_dir(&self.dir())?;
        fsutil::ensure_private_dir(&dir)?;
        let path = dir.join(&hex);
        if std::fs::read(&path).is_ok_and(|b| revision_of(&b) == rev) {
            return Ok(hex);
        }
        fsutil::write_atomic(&path, bytes)?;
        Ok(hex)
    }
}

/// A collection-relative path from the old engine journal: plain components only.
fn checked(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    if rel.is_empty()
        || !p
            .components()
            .all(|c| matches!(c, Component::Normal(n) if n != ".mdbase"))
    {
        return Err("unsafe path in the old engine journal".into());
    }
    let full = root.join(p);
    // Refuse to follow a symlink anywhere below the root.
    let mut cur = root.to_path_buf();
    for c in p.components() {
        cur.push(c);
        match std::fs::symlink_metadata(&cur) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err("the old engine journal names a symlinked path".into());
            }
            _ => {}
        }
    }
    Ok(full)
}

/// [`checked`], for the driver's tests.
#[cfg(test)]
pub fn checked_for_tests(root: &Path, rel: &str) -> Result<PathBuf, String> {
    checked(root, rel)
}

impl Daemon for Adapter {
    fn store_id(&mut self, collection: &str) -> String {
        // Issued and saved by the driver before take_over; never minted here.
        self.store_ids.get(collection).cloned().unwrap_or_default()
    }

    fn publish_guarded(
        &mut self,
        root: &Path,
        path: &str,
        _if_revision: Option<&str>,
        _bytes: Option<&[u8]>,
    ) -> Result<Published, String> {
        checked(root, path)?;
        // No check-then-rename/delete fallback: the old locks do not fence editors.
        // This typed outcome (not an I/O error) makes the library retain a HOLD.
        failpoint("publish:unavailable");
        Ok(Published::Unavailable)
    }

    fn hold(
        &mut self,
        root: &Path,
        path: &str,
        intended: Option<&[u8]>,
        reason: &str,
    ) -> Result<(), String> {
        checked(root, path)?;
        failpoint("hold");
        let intended = match intended {
            Some(b) => Some(self.keep(b).map_err(|e| format!("keep held bytes: {e}"))?),
            None => None,
        };
        failpoint("hold:after_keep");
        self.holds.retain(|h| h.path != path);
        self.holds.push(Hold {
            path: path.to_owned(),
            reason: reason.to_owned(),
            intended,
        });
        Ok(())
    }

    fn import(&mut self, import: &Import) -> Result<(), String> {
        if import.collection != self.collection {
            return Err("import for a collection this run did not begin".into());
        }
        let doc = Evidence {
            schema_version: 1,
            collection: import.collection.clone(),
            root: import.root.clone(),
            record_ids: import
                .record_ids
                .iter()
                .map(|r| RecordIdRow {
                    record_id: r.record_id.clone(),
                    path: r.path.clone(),
                    revision: r.revision.clone(),
                })
                .collect(),
            grants: json!({
                "grants": import.grants.grants,
                "crypto_state": import.grants.crypto_state,
                "crypto_requests": import.grants.crypto_requests,
                "overlay_enabled": import.grants.overlay_enabled,
                "access_paused": import.grants.access_paused,
                "policy_state": import.grants.policy_state,
            }),
            journal: import
                .receipts
                .iter()
                .map(|(row, r)| journal_json(row, r))
                .collect(),
            tombstones: import.tombstones.iter().map(tombstone_json).collect(),
            holds: self.holds.clone(),
            rolled_forward: self.rolled.clone(),
        };
        failpoint("import:before");
        let dir = self.dir();
        fsutil::ensure_private_dir(&self.legacy_dir).map_err(|e| e.to_string())?;
        fsutil::ensure_private_dir(&dir).map_err(|e| e.to_string())?;
        let mut bytes = serde_json::to_vec_pretty(&doc).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        fsutil::write_atomic(&dir.join("import.json"), &bytes)
            .map_err(|e| format!("write import: {e}"))?;
        failpoint("import:after");
        Ok(())
    }

    fn register(&mut self, root: &Path, collection: &str) -> Result<(), String> {
        // Registration needs the async server and a signed-in account; the driver
        // hands these to it after the run (and retries at every start).
        failpoint("register");
        if !self.registered.iter().any(|(c, _)| c == collection) {
            self.registered
                .push((collection.to_owned(), root.to_path_buf()));
        }
        Ok(())
    }
}

/// `<state>/legacy/<collection>/import.json`: retained T5 evidence (schema 1). This
/// is evidence and an ID-hint source for a later adopt, never active v2 authorization.
#[derive(Debug, Serialize, Deserialize)]
pub struct Evidence {
    /// Always 1.
    pub schema_version: u32,
    /// The legacy collection ID (kept).
    pub collection: String,
    /// The folder.
    pub root: PathBuf,
    /// The connector's record IDs (`path → id` while the revision matches).
    pub record_ids: Vec<RecordIdRow>,
    /// Grants, overlays, pause and replay state, as raw old rows.
    pub grants: Value,
    /// Journal identities with their receipt evidence.
    pub journal: Vec<Value>,
    /// Compacted terminal mutations.
    pub tombstones: Vec<Value>,
    /// T4 holds.
    pub holds: Vec<Hold>,
    /// T4 roll-forwards.
    pub rolled_forward: Vec<RolledForward>,
}

/// A record ID row.
#[derive(Debug, Serialize, Deserialize)]
pub struct RecordIdRow {
    /// Record ID.
    pub record_id: String,
    /// Path when last reconciled.
    pub path: String,
    /// Its revision then.
    pub revision: String,
}

impl Evidence {
    /// Load a collection's retained import, if any.
    pub fn load(legacy_dir: &Path, collection: &str) -> io::Result<Option<Evidence>> {
        let path = Adapter::collection_dir(legacy_dir, collection).join("import.json");
        match fsutil::read_optional(&path)? {
            None => Ok(None),
            Some(b) => serde_json::from_slice(&b)
                .map(Some)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "malformed import")),
        }
    }
}

fn state_name(s: mdbn_legacy::connector::JournalState) -> &'static str {
    use mdbn_legacy::connector::JournalState as S;
    match s {
        S::Claimed => "claimed",
        S::Prepared => "prepared",
        S::Applied => "applied",
        S::Completed => "completed",
        S::Acknowledged => "acknowledged",
        S::Abandoned => "abandoned",
        S::OutcomeUnknown => "outcome_unknown",
    }
}

fn journal_json(row: &JournalRow, r: &ReceiptImport) -> Value {
    let (kind, bytes) = match r {
        ReceiptImport::Receipt(b) => (
            "receipt",
            Some(base64::engine::general_purpose::STANDARD.encode(b)),
        ),
        ReceiptImport::NotSent => ("not_sent", None),
        ReceiptImport::OutcomeUnknown => ("outcome_unknown", None),
    };
    json!({
        "application_installation_id": row.application_installation_id,
        "grant_id": row.grant_id,
        "request_id": row.request_id,
        "operation_kind": row.operation_kind,
        "input_schema_version": row.input_schema_version,
        "input_digest": row.input_digest,
        "state": state_name(row.state),
        "prepared_data": row.prepared_data,
        "after_evidence": row.after_evidence,
        "result_metadata": row.result_metadata,
        "final_receipt": row.final_receipt,
        "receipt_digest": row.receipt_digest,
        "accepted_at_ms": row.accepted_at_ms,
        "completed_at_ms": row.completed_at_ms,
        "receipt": kind,
        "receipt_bytes": bytes,
    })
}

fn tombstone_json(t: &TombstoneRow) -> Value {
    json!({
        "application_installation_id": t.application_installation_id,
        "grant_id": t.grant_id,
        "request_id": t.request_id,
        "input_digest": t.input_digest,
        "terminal_state": state_name(t.terminal_state),
        "expires_at_ms": t.expires_at_ms,
    })
}
