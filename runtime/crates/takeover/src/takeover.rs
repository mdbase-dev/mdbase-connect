//! Local takeover (local migration, steps T0–T6): the new daemon takes
//! over a local collection from the old connector **without converting it**. There
//! is no log and no generation 0.
//!
//! The daemon-facing part is the [`Daemon`] trait, which the daemon workstream
//! implements:
//! - its store ID for the collection;
//! - the T5 import;
//! - the T4 roll-forward through its publish path;
//! - holds;
//! - registration.
//!
//! The old daemon's service manager is [`OldService`]. Everything about old state goes
//! through `mdbn-legacy`, which is read-only.
//!
//! **Locks.** From T1 to T6 this process holds the old `daemon.lock` (no old daemon
//! can start) and the folder's `write.lock` (no engine host can write). The old daemon
//! stays disabled afterwards.
//!
//! **Idempotent.** Re-running after a crash redoes from T1. T3 discards a partial
//! evidence copy. T4 skips entries already at their intended revision. T5 replaces the
//! daemon's import. A folder already claimed by this daemon returns
//! [`Outcome::AlreadyTakenOver`].

use std::path::{Path, PathBuf};

use mdbn_legacy::connector::{
    ConnectorState, GrantState, JournalRow, ReceiptImport, RecordId, TombstoneRow,
};
use mdbn_legacy::engine::{self, Settlement};
use mdbn_legacy::lock;
use mdbn_legacy::marker::{self, Marker};

use crate::{Error, Result};

/// The old service manager hook, declared in `mdbn-legacy` and implemented by the
/// daemon (`service::legacy::OldConnectorService`).
pub use mdbn_legacy::OldService;

/// Everything the takeover imports for one collection (T5).
#[derive(Clone, Debug, PartialEq)]
pub struct Import {
    /// The collection ID (the legacy one).
    pub collection: String,
    /// The folder.
    pub root: PathBuf,
    /// Legacy record IDs (`path → id` while the revision still matches).
    pub record_ids: Vec<RecordId>,
    /// Grants, overlays, pause state and the per-grant replay state.
    pub grants: GrantState,
    /// The compatibility layer's `legacy_receipts`: journal identity → how a retry is
    /// answered.
    pub receipts: Vec<(JournalRow, ReceiptImport)>,
    /// Compacted requests: retries answer `mutation_recovery_expired`.
    pub tombstones: Vec<TombstoneRow>,
}

/// What T4 did to one old engine transaction entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Settled {
    /// Rolled forward through the daemon's publish path.
    RolledForward {
        /// Path.
        path: String,
        /// The old engine transaction (commit ID) it completed.
        transaction: String,
    },
    /// Held, with both versions kept.
    Held {
        /// Path.
        path: String,
        /// Why.
        reason: String,
    },
}

/// The new daemon, as the takeover needs it.
pub trait Daemon {
    /// The daemon's store ID for `collection`, stable across re-runs. It goes into
    /// the marker's `replica_id`.
    fn store_id(&mut self, collection: &str) -> String;
    /// T4: publish `bytes` at `path` (or delete it, for `None`) only if the file still
    /// has `if_revision` (or doesn't exist, for `None`). This is a guarded write
    /// through the daemon's own publish protocol, never a plain overwrite.
    fn publish_guarded(
        &mut self,
        root: &Path,
        path: &str,
        if_revision: Option<&str>,
        bytes: Option<&[u8]>,
    ) -> std::result::Result<Published, String>;
    /// T4: hold `path`, keeping the user's bytes and the intended ones.
    fn hold(
        &mut self,
        root: &Path,
        path: &str,
        intended: Option<&[u8]>,
        reason: &str,
    ) -> std::result::Result<(), String>;
    /// T5: replace the daemon's import for this collection.
    fn import(&mut self, import: &Import) -> std::result::Result<(), String>;
    /// After T6: start serving the collection as `local-only`.
    fn register(&mut self, root: &Path, collection: &str) -> std::result::Result<(), String>;
}

/// The takeover's result.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    /// Done.
    TakenOver(Report),
    /// The folder already carries this daemon's claim. Nothing was done.
    AlreadyTakenOver,
    /// Not done, and nothing was changed: the old daemon couldn't be stopped, or the
    /// folder is locked. Report it and retry later; never fence a live daemon.
    Postponed(String),
}

/// Counts and paths only.
#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    /// Where the evidence copy is.
    pub evidence: PathBuf,
    /// T4 actions.
    pub settled: Vec<Settled>,
    /// Record IDs imported.
    pub record_ids: usize,
    /// Grants imported.
    pub grants: usize,
    /// Journal rows imported for the compatibility layer.
    pub receipts: usize,
    /// Rows whose referenced receipt was missing or corrupt (now `outcome_unknown`).
    pub receipts_unreadable: usize,
}

/// Takeover options.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Options {
    /// T4: roll old engine transactions that were mid-commit forward through the daemon's
    /// guarded publish. This is the one Markdown write migration makes and is enabled
    /// in [`Options::PRODUCTION`].
    ///
    /// The guard always applies: a file the user changed meanwhile is held, with both
    /// versions kept, never overwritten. With this off (the `Default`, for tests and
    /// diagnostics), every such file is held instead.
    pub roll_forward: bool,
}

impl Options {
    /// The production takeover: roll forward, with the guard.
    pub const PRODUCTION: Options = Options { roll_forward: true };
}

/// The hold reason for a mid-commit transaction when roll-forward is off.
pub const ROLL_FORWARD_DISABLED: &str =
    "old engine transaction was mid-commit; roll-forward is disabled for this run";

/// The hold reason when the file changed between the check and the guarded publish.
pub const CHANGED_DURING_ROLL_FORWARD: &str =
    "file changed while the old engine transaction was being rolled forward";

/// The hold reason when the adapter has no never-clobber publisher.
pub const GUARDED_PUBLISH_UNAVAILABLE: &str =
    "old engine transaction was mid-commit; guarded publisher is unavailable";

/// What a guarded publish did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Published {
    /// Written (or deleted).
    Done,
    /// Refused: the file no longer had `if_revision`. Nothing was written.
    Changed,
    /// Refused without effects: no never-clobber publisher is available.
    /// The caller must durably HOLD the intended bytes or deletion, not retry
    /// through a plain overwrite or turn this into a fabricated success.
    Unavailable,
}

/// The marker's informational text (T6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Claim<'a> {
    /// RFC 3339 time of the claim.
    pub claimed_at: &'a str,
    /// The message old connectors show (takeover marker contract).
    pub notice: &'a str,
}

/// Take over `collection` from the connector state in `state_dir` (T0–T6).
///
/// `evidence_dir` is under the new daemon's state (`<daemon-state>/legacy/<collection>`).
/// `claim` goes into the marker.
pub fn take_over(
    state_dir: &Path,
    collection: &str,
    evidence_dir: &Path,
    claim: Claim<'_>,
    options: Options,
    old: &mut dyn OldService,
    daemon: &mut dyn Daemon,
) -> Result<Outcome> {
    let legacy = |e: mdbn_legacy::Error| Error::Legacy(e.to_string());
    let ext = |what: &'static str| move |e: String| Error::Invalid(format!("{what}: {e}"));

    // T0: find it.
    let state = ConnectorState::open(state_dir).map_err(legacy)?;
    let entry = state
        .collections()
        .map_err(legacy)?
        .into_iter()
        .find(|c| c.id == collection)
        .ok_or_else(|| Error::Invalid(format!("collection {collection} is not registered")))?;
    if entry.authority_state.as_deref() == Some("retired") {
        return Err(Error::Invalid(
            "collection is retired in the old registry".into(),
        ));
    }
    let root = entry.path.clone();
    let store_id = daemon.store_id(collection);
    match marker::read(&root).map_err(legacy)? {
        Marker::Absent => {}
        Marker::Claimed {
            collection: c,
            replica_id: r,
        } if c == collection && r == store_id => {
            // Resume a crash after claiming but before durability or registration.
            sync_marker_dir(&root.join(".mdbase"))?;
            daemon
                .register(&root, collection)
                .map_err(ext("register"))?;
            return Ok(Outcome::AlreadyTakenOver);
        }
        other => {
            return Err(Error::Invalid(format!(
                "folder is not a local-authority collection: {other:?}"
            )));
        }
    }
    drop(state);

    // T1: stop the old daemon and hold its lock.
    old.stop_and_disable().map_err(ext("stop the old daemon"))?;
    let Some(_daemon_lock) =
        lock::try_exclusive(&lock::daemon_lock_path(state_dir)).map_err(legacy)?
    else {
        return Ok(Outcome::Postponed(
            "the old daemon is still running (daemon.lock is held)".into(),
        ));
    };
    // T2: hold the folder.
    let Some(_write_lock) = lock::try_exclusive(&lock::write_lock_path(&root)).map_err(legacy)?
    else {
        return Ok(Outcome::Postponed(
            "the folder's write.lock is held by another process".into(),
        ));
    };

    // T3: evidence copy. Later steps read only the copy.
    let _ = std::fs::remove_dir_all(evidence_dir);
    let db_dir = evidence_dir.join("state");
    let state = ConnectorState::open(state_dir).map_err(legacy)?;
    state.backup_to(&db_dir).map_err(legacy)?;
    let journal = state.journal().map_err(legacy)?;
    let store = state.receipt_store();
    for row in &journal {
        for reference in [row.final_receipt.clone(), row.response_receipt()]
            .into_iter()
            .flatten()
        {
            if let Ok(mdbn_legacy::receipts::ReceiptValue::Stored { digest, .. }) =
                mdbn_legacy::receipts::ReceiptValue::parse(&reference)
            {
                let src = store.path_of(&digest);
                let dst = mdbn_legacy::receipts::ReceiptStore::new(&db_dir).path_of(&digest);
                if src.is_file() {
                    copy_file(&src, &dst)?;
                }
            }
        }
    }
    drop(state);
    let txn_src = root.join(".mdbase").join("transactions");
    let txn_dst = evidence_dir
        .join("folder")
        .join(".mdbase")
        .join("transactions");
    if txn_src.is_dir() {
        copy_tree(&txn_src, &txn_dst)?;
    }

    // T4: settle old engine transactions, from the copy, against the live folder.
    let mut settled = Vec::new();
    for txn in engine::scan(&evidence_dir.join("folder")).map_err(legacy)? {
        match txn.settlement(&root).map_err(legacy)? {
            Settlement::Nothing => {}
            Settlement::RollForward(entries) if !options.roll_forward => {
                for i in entries {
                    let e = &txn.entries[i];
                    let intended = txn.staged_bytes(i).map_err(legacy)?;
                    daemon
                        .hold(&root, &e.path, intended.as_deref(), ROLL_FORWARD_DISABLED)
                        .map_err(ext("hold"))?;
                    settled.push(Settled::Held {
                        path: e.path.clone(),
                        reason: ROLL_FORWARD_DISABLED.into(),
                    });
                }
            }
            Settlement::RollForward(entries) => {
                for i in entries {
                    let e = &txn.entries[i];
                    let bytes = txn.staged_bytes(i).map_err(legacy)?;
                    let outcome = daemon
                        .publish_guarded(
                            &root,
                            &e.path,
                            e.before_revision.as_deref(),
                            bytes.as_deref(),
                        )
                        .map_err(ext("roll forward"))?;
                    match outcome {
                        Published::Done => settled.push(Settled::RolledForward {
                            path: e.path.clone(),
                            transaction: txn.id.clone(),
                        }),
                        Published::Changed | Published::Unavailable => {
                            let reason = match outcome {
                                Published::Unavailable => GUARDED_PUBLISH_UNAVAILABLE,
                                _ => CHANGED_DURING_ROLL_FORWARD,
                            };
                            daemon
                                .hold(&root, &e.path, bytes.as_deref(), reason)
                                .map_err(ext("hold"))?;
                            settled.push(Settled::Held {
                                path: e.path.clone(),
                                reason: reason.into(),
                            });
                        }
                    }
                }
            }
            Settlement::Diverged(entries) | Settlement::ManualRecovery(entries) => {
                let reason = if txn.phase == engine::Phase::NeedsManualRecovery {
                    "old engine needed manual recovery"
                } else {
                    "file matches neither the old or the intended revision"
                };
                for i in entries {
                    let e = &txn.entries[i];
                    let intended = txn.staged_bytes(i).map_err(legacy)?;
                    daemon
                        .hold(&root, &e.path, intended.as_deref(), reason)
                        .map_err(ext("hold"))?;
                    settled.push(Settled::Held {
                        path: e.path.clone(),
                        reason: reason.into(),
                    });
                }
            }
        }
    }

    // T5: import into the daemon, from the copy.
    let copy = ConnectorState::open(&db_dir).map_err(legacy)?;
    let mut receipts = Vec::new();
    let mut unreadable = 0;
    for row in copy.journal().map_err(legacy)? {
        let (import, err) = copy.receipt_import(&row);
        unreadable += usize::from(err.is_some());
        receipts.push((row, import));
    }
    let import = Import {
        collection: collection.to_owned(),
        root: root.clone(),
        record_ids: copy.record_ids(collection).map_err(legacy)?,
        grants: copy.grant_state(collection).map_err(legacy)?,
        receipts,
        tombstones: copy.tombstones().map_err(legacy)?,
    };
    daemon.import(&import).map_err(ext("import"))?;

    // T6: the v2 marker, last.
    write_v2_marker(&root, collection, &store_id, claim.claimed_at, claim.notice)?;
    drop(_write_lock);
    drop(_daemon_lock);
    daemon
        .register(&root, collection)
        .map_err(ext("register"))?;

    Ok(Outcome::TakenOver(Report {
        evidence: evidence_dir.to_path_buf(),
        settled,
        record_ids: import.record_ids.len(),
        grants: import.grants.grants.len(),
        receipts: import.receipts.len(),
        receipts_unreadable: unreadable,
    }))
}

/// Write the takeover v2 marker atomically without replacing an existing claim:
/// exclusive owner-only temp file, `fsync`, hard-link create, directory `fsync`.
/// Unsupported hard-link/directory durability blocks takeover. It has
/// **no `collection_id` key**, so old readers fail closed and an old
/// `mirror remove` can't delete it.
///
/// The file workstream owns the marker long-term (writer and watcher). This is the
/// same format, here until that lands.
pub fn write_v2_marker(
    root: &Path,
    collection: &str,
    replica_id: &str,
    claimed_at: &str,
    notice: &str,
) -> Result<()> {
    use std::io::Write;
    let dir = root.join(".mdbase");
    let meta = std::fs::symlink_metadata(&dir);
    match meta {
        Ok(m) if !m.is_dir() => {
            return Err(Error::Invalid(".mdbase is not a directory".into()));
        }
        Err(_) => std::fs::create_dir_all(&dir)
            .map_err(|e| Error::Invalid(format!("create .mdbase: {e}")))?,
        Ok(_) => {}
    }
    let body = serde_json::json!({
        "version": 2,
        "role": "replica",
        "collection": collection,
        "replica_id": replica_id,
        "runtime": "mdbase-next",
        "claimed_at": claimed_at,
        "notice": notice,
    });
    let bytes =
        serde_json::to_vec_pretty(&body).map_err(|e| Error::Invalid(format!("marker: {e}")))?;
    if !matches!(marker::parse(&bytes), Marker::Claimed { .. }) {
        return Err(Error::Invalid(
            "marker would not parse as a v2 claim".into(),
        ));
    }
    let (tmp, mut file) = create_marker_temp(&dir)?;
    let publish = (|| {
        file.write_all(&bytes)
            .and_then(|()| file.write_all(b"\n"))
            .and_then(|()| file.sync_all())
            .map_err(|e| Error::Invalid(format!("marker write: {e}")))?;
        // Unlike rename, hard-link creation atomically refuses any existing target,
        // including a symlink or a claim written since T0. Never replace evidence.
        std::fs::hard_link(&tmp, dir.join("connect-role.json"))
            .map_err(|e| Error::Invalid(format!("marker no-replace publish: {e}")))?;
        sync_marker_dir(&dir)
    })();
    drop(file);
    // Only this call's exclusively-created temp is ours to remove. A leftover temp
    // after a crash cannot prevent a retry: subsequent calls choose a fresh name.
    let cleanup =
        std::fs::remove_file(&tmp).map_err(|e| Error::Invalid(format!("marker temp cleanup: {e}")));
    publish?;
    cleanup?;
    sync_marker_dir(&dir)
}

fn create_marker_temp(dir: &Path) -> Result<(PathBuf, std::fs::File)> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    for _ in 0..1024 {
        let tmp = dir.join(format!(
            ".connect-role.{}-{}.tmp",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&tmp) {
            Ok(file) => return Ok((tmp, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(Error::Invalid(format!("marker temp: {e}"))),
        }
    }
    Err(Error::Invalid("marker temp names exhausted".into()))
}

fn sync_marker_dir(dir: &Path) -> Result<()> {
    std::fs::File::open(dir)
        .and_then(|d| d.sync_all())
        .map_err(|e| Error::Invalid(format!("marker directory durability: {e}")))
}

fn copy_file(src: &Path, dst: &Path) -> Result<()> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| Error::Invalid(format!("evidence dir: {e}")))?;
    }
    std::fs::copy(src, dst).map_err(|e| Error::Invalid(format!("evidence copy: {e}")))?;
    Ok(())
}

fn copy_tree(src: &Path, dst: &Path) -> Result<()> {
    std::fs::create_dir_all(dst).map_err(|e| Error::Invalid(format!("evidence dir: {e}")))?;
    let entries =
        std::fs::read_dir(src).map_err(|e| Error::Invalid(format!("evidence read: {e}")))?;
    for entry in entries {
        let entry = entry.map_err(|e| Error::Invalid(format!("evidence read: {e}")))?;
        let ty = entry
            .file_type()
            .map_err(|e| Error::Invalid(format!("evidence read: {e}")))?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_tree(&entry.path(), &to)?;
        } else if ty.is_file() {
            copy_file(&entry.path(), &to)?;
        }
    }
    Ok(())
}
