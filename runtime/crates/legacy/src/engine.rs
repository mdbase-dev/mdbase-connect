//! mdbase-rs engine transaction journals in a collection folder.
//!
//! Layout: `<root>/.mdbase/transactions/<id>/journal.json`, plus `stage/<i>` (the
//! intended bytes of entry `i`) and `backup/<i>` (its previous bytes)
//! (`RS/src/transactions.rs:106-107`).
//!
//! | `version` | Kind | Phases |
//! |---|---|---|
//! | 1 | shadow / system migration (`RS/src/transactions.rs:246-282`) | prepared, committing, committed |
//! | 2, 3, 4 | runtime (`RS/src/transactions/runtime.rs:59-115`) | prepared, committing, committed, rejected_before_commit, cancelled_before_commit, needs_manual_recovery |
//!
//! [`Transaction::settlement`] reproduces the old engine's recovery decision
//! (`recover_one` and runtime `settle`) **without performing it**. Migration then
//! carries the decision out through the new publish path, or holds the file
//! (local migration, L4).

use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

use crate::{Error, Result, revision_of};

/// A transaction's phase, across all journal versions.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Staged. Files are untouched (runtime), or partly applied if `applied > 0` (v1).
    Prepared,
    /// Being applied. The engine rolls it forward on recovery.
    Committing,
    /// Applied.
    Committed,
    /// Runtime only: rejected before any file changed.
    RejectedBeforeCommit,
    /// Runtime only: cancelled before any file changed.
    CancelledBeforeCommit,
    /// Runtime only: the engine gave up; needs a human.
    NeedsManualRecovery,
}

/// One file change in a transaction.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Entry {
    /// Collection-relative path.
    pub path: String,
    /// The file's revision before (`None`: the file didn't exist).
    pub before_revision: Option<String>,
    /// The intended revision (`None`: delete).
    pub after_revision: Option<String>,
    /// `stage/<i>` when `after_revision` is set.
    pub stage_file: Option<String>,
    /// `backup/<i>` when `before_revision` is set.
    pub backup_file: Option<String>,
}

#[derive(Deserialize)]
struct RawJournal {
    version: u32,
    id: String,
    phase: Phase,
    applied: u64,
    entries: Vec<Entry>,
    #[serde(default)]
    host_claim: Option<String>,
    #[serde(default)]
    resolution_acked: Option<bool>,
    #[serde(default)]
    event_acked: Option<bool>,
}

/// A parsed engine transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transaction {
    /// The transaction directory.
    pub dir: PathBuf,
    /// Journal version (1–4).
    pub version: u32,
    /// Commit ID (32 hex characters; equals the directory name).
    pub id: String,
    /// Phase.
    pub phase: Phase,
    /// Entries applied so far, by the engine's count.
    pub applied: u64,
    /// The file changes, in order.
    pub entries: Vec<Entry>,
    /// Runtime journals: the host claim that links it to a connector
    /// `mutation_journal` row.
    pub host_claim: Option<String>,
    /// Runtime journals: whether the operation result was acknowledged.
    pub resolution_acked: bool,
    /// Runtime journals: whether the change event was acknowledged.
    pub event_acked: bool,
}

/// Where one entry's file is now, relative to the transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EntryState {
    /// The file has the intended revision.
    AtAfter,
    /// The file still has the previous revision.
    AtBefore,
    /// Neither: someone else changed the file. The current revision is attached (`None`
    /// if the file is missing).
    Diverged(Option<String>),
}

/// What the old engine would do with a transaction on recovery, and so what migration
/// does instead.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Settlement {
    /// Nothing to do: final, or never touched any file.
    Nothing,
    /// Roll forward: write the staged bytes (or delete) for these entry indexes, each
    /// guarded by its `before_revision`. Entries already at `after` are skipped.
    RollForward(Vec<usize>),
    /// Roll forward is impossible: these entries match neither revision. The old
    /// engine would stop at manual recovery. Migration holds them.
    Diverged(Vec<usize>),
    /// The engine had already given up (`needs_manual_recovery`). Every entry not at
    /// `after` is held.
    ManualRecovery(Vec<usize>),
}

impl Transaction {
    /// The current state of entry `index`'s file under `root`.
    pub fn entry_state(&self, root: &Path, index: usize) -> Result<EntryState> {
        let entry = &self.entries[index];
        let current = current_revision(root, &entry.path)?;
        Ok(if current == entry.after_revision {
            EntryState::AtAfter
        } else if current == entry.before_revision {
            EntryState::AtBefore
        } else {
            EntryState::Diverged(current)
        })
    }

    /// The staged bytes for entry `index`, verified against its `after_revision`.
    /// `None` for a delete.
    pub fn staged_bytes(&self, index: usize) -> Result<Option<Vec<u8>>> {
        let entry = &self.entries[index];
        let Some(stage) = &entry.stage_file else {
            return Ok(None);
        };
        let path = self.dir.join(stage);
        let bytes = read_regular(&path)?;
        if Some(revision_of(&bytes)) != entry.after_revision {
            return Err(Error::format(
                &path,
                "staged bytes do not match the journal",
            ));
        }
        Ok(Some(bytes))
    }

    /// The recovery decision, given the folder as it is now.
    pub fn settlement(&self, root: &Path) -> Result<Settlement> {
        let rolls_forward = match (self.version, self.phase) {
            (_, Phase::Committing) => true,
            (1, Phase::Prepared) => self.applied > 0,
            (_, Phase::NeedsManualRecovery) => {
                let mut held = Vec::new();
                for i in 0..self.entries.len() {
                    if self.entry_state(root, i)? != EntryState::AtAfter {
                        held.push(i);
                    }
                }
                return Ok(if held.is_empty() {
                    Settlement::Nothing
                } else {
                    Settlement::ManualRecovery(held)
                });
            }
            _ => false,
        };
        if !rolls_forward {
            return Ok(Settlement::Nothing);
        }
        let (mut apply, mut diverged) = (Vec::new(), Vec::new());
        for i in 0..self.entries.len() {
            match self.entry_state(root, i)? {
                EntryState::AtAfter => {}
                EntryState::AtBefore => apply.push(i),
                EntryState::Diverged(_) => diverged.push(i),
            }
        }
        Ok(if !diverged.is_empty() {
            Settlement::Diverged(diverged)
        } else if apply.is_empty() {
            Settlement::Nothing
        } else {
            Settlement::RollForward(apply)
        })
    }
}

/// Parse every transaction under `<root>/.mdbase/transactions/`, ordered by ID.
/// A folder without that directory has none.
pub fn scan(root: &Path) -> Result<Vec<Transaction>> {
    let dir = root.join(".mdbase").join("transactions");
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(Error::io(&dir, e)),
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| Error::io(&dir, e))?;
        let path = entry.path();
        let ty = entry.file_type().map_err(|e| Error::io(&path, e))?;
        if !ty.is_dir() {
            // The engine ignores stray files here too (temp files, .DS_Store).
            continue;
        }
        out.push(parse(&path)?);
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Parse one transaction directory.
pub fn parse(dir: &Path) -> Result<Transaction> {
    let journal = dir.join("journal.json");
    let bytes = read_regular(&journal)?;
    let raw: RawJournal = serde_json::from_slice(&bytes)
        .map_err(|e| Error::format(&journal, format!("journal: {e}")))?;
    if !(1..=4).contains(&raw.version) {
        return Err(Error::format(
            &journal,
            format!("journal version {} (supported: 1-4)", raw.version),
        ));
    }
    if dir.file_name().and_then(|n| n.to_str()) != Some(raw.id.as_str()) {
        return Err(Error::format(
            &journal,
            "journal id does not match its directory",
        ));
    }
    if raw.version == 1
        && matches!(
            raw.phase,
            Phase::RejectedBeforeCommit | Phase::CancelledBeforeCommit | Phase::NeedsManualRecovery
        )
    {
        return Err(Error::format(&journal, "runtime phase in a v1 journal"));
    }
    if raw.version >= 2 && raw.host_claim.is_none() {
        return Err(Error::format(
            &journal,
            "runtime journal without host_claim",
        ));
    }
    if raw.applied > raw.entries.len() as u64 {
        return Err(Error::format(&journal, "applied exceeds the entry count"));
    }
    for (i, e) in raw.entries.iter().enumerate() {
        if !is_safe_relative(&e.path) {
            return Err(Error::format(&journal, "entry path escapes the collection"));
        }
        let want_stage = e.after_revision.as_ref().map(|_| format!("stage/{i}"));
        let want_backup = e.before_revision.as_ref().map(|_| format!("backup/{i}"));
        if e.stage_file != want_stage || e.backup_file != want_backup {
            return Err(Error::format(
                &journal,
                "payload paths do not match their journal position",
            ));
        }
    }
    Ok(Transaction {
        dir: dir.to_path_buf(),
        version: raw.version,
        id: raw.id,
        phase: raw.phase,
        applied: raw.applied,
        entries: raw.entries,
        host_claim: raw.host_claim,
        resolution_acked: raw.resolution_acked.unwrap_or(false),
        event_acked: raw.event_acked.unwrap_or(false),
    })
}

/// `"sha256:<hex>"` of the file at `rel` under `root`, or `None` if it doesn't exist.
pub fn current_revision(root: &Path, rel: &str) -> Result<Option<String>> {
    if !is_safe_relative(rel) {
        return Err(Error::format(root, "path escapes the collection"));
    }
    let path = root.join(rel);
    match std::fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Error::io(&path, e)),
        Ok(_) => Ok(Some(revision_of(&read_regular(&path)?))),
    }
}

fn read_regular(path: &Path) -> Result<Vec<u8>> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| Error::io(path, e))?;
    if !meta.is_file() {
        return Err(Error::format(path, "not a regular file"));
    }
    std::fs::read(path).map_err(|e| Error::io(path, e))
}

fn is_safe_relative(rel: &str) -> bool {
    let p = Path::new(rel);
    !rel.is_empty()
        && !rel.contains('\\')
        && p.components().all(|c| matches!(c, Component::Normal(_)))
}
