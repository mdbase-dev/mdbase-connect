//! Bring an old hosted mirror's collection back on this device after the
//! takeover, so its captured unsent edits ([`super::mirror_import`]) can land.
//!
//! The migration keeps hosted collection IDs (`ids_preserved`), so the old
//! mirror's collection ID names the migrated collection. For each capture whose
//! collection is not registered here, the daemon joins it through the ordinary
//! `collection.join` path: the paired account's authority, Connect's cloud-copy
//! enrolment, the pinned genesis check, and a fresh empty folder. Nothing here
//! adds a credential or a permission: a join Connect refuses (not migrated yet,
//! signed out, offline, not a member) leaves the capture waiting, with the reason
//! in `migrate.status`, and is retried with backoff.
//!
//! **Folder.** The old mirror folder still holds the old copy and is never
//! touched, so the collection joins into the first usable of:
//! - the old mirror path itself, when it is gone or empty;
//! - `<name> (synced)`, `<name> (synced 2)`, ... next to it,
//!
//! where usable means absent or an empty directory (`collection.join` requires
//! an empty folder). The choice is saved in `join.json` before the folder is
//! created, so a retry after a crash reuses the same folder.
//!
//! **Crash safety.** `join.json` records the folder, then the join runs, then
//! `join.json` records `joined`. A crash before the join retries it; a crash
//! after Connect enrolled the device but before registration retries it too
//! (re-enrolling the same device is how `collection.join` retries); a crash after
//! registration is recognised from the registry. Once joined, the collection is
//! never joined again by this module: if the user later removes it, that is
//! respected, and the old folder still holds the edits.
//!
//! **Cutover.** Before the first import into a collection that syncs with the
//! hosted log, the daemon also reads its migration record: a collection that is
//! not cut over yet (`409 not_cut_over`) keeps its edits captured.

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::mirror_import::{self, Capture};
use crate::fsutil;

/// Schema of `join.json`.
pub const SCHEMA_VERSION: u32 = 1;

/// The longest wait between attempts.
pub const MAX_BACKOFF_MS: u64 = 30 * 60 * 1000;

/// The first retry delay.
pub const FIRST_BACKOFF_MS: u64 = 5 * 1000;

/// Where the join stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Not joined yet (waiting, or about to try).
    Pending,
    /// Joined (by this module, or found registered).
    Joined,
}

/// `join.json`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JoinState {
    /// [`SCHEMA_VERSION`].
    pub schema_version: u32,
    /// Pending or joined.
    pub phase: Phase,
    /// The folder chosen for the join (or where it was found registered).
    pub folder: Option<PathBuf>,
    /// Failed attempts since the last success.
    pub attempts: u32,
    /// Why the last attempt did not join (a snake_case reason).
    pub last_error: Option<String>,
    /// When the last attempt ran (ms since the epoch).
    pub last_attempt_ms: Option<u64>,
    /// The migration record confirmed the cutover (checked once).
    #[serde(default)]
    pub cut_over: bool,
}

impl JoinState {
    fn new() -> JoinState {
        JoinState {
            schema_version: SCHEMA_VERSION,
            phase: Phase::Pending,
            folder: None,
            attempts: 0,
            last_error: None,
            last_attempt_ms: None,
            cut_over: false,
        }
    }

    /// Load (a fresh pending state when there is none).
    pub fn load(legacy: &Path, collection: &str) -> io::Result<JoinState> {
        match fsutil::read_optional(&path(legacy, collection)?)? {
            None => Ok(JoinState::new()),
            Some(b) => {
                let s: JoinState = serde_json::from_slice(&b).map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidData, "malformed join.json")
                })?;
                if s.schema_version != SCHEMA_VERSION {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "unsupported join.json",
                    ));
                }
                Ok(s)
            }
        }
    }

    fn save(&self, legacy: &Path, collection: &str) -> io::Result<()> {
        let bytes = serde_json::to_vec_pretty(self).map_err(io::Error::other)?;
        fsutil::write_atomic(&path(legacy, collection)?, &bytes)
    }

    /// When the next attempt is due (ms since the epoch).
    pub fn next_attempt_ms(&self) -> u64 {
        let Some(last) = self.last_attempt_ms else {
            return 0;
        };
        let shift = self.attempts.saturating_sub(1).min(20);
        last.saturating_add((FIRST_BACKOFF_MS << shift).min(MAX_BACKOFF_MS))
    }

    fn failed(&mut self, reason: &str, now_ms: u64) {
        self.attempts = self.attempts.saturating_add(1);
        self.last_error = Some(reason.to_owned());
        self.last_attempt_ms = Some(now_ms);
    }
}

fn path(legacy: &Path, collection: &str) -> io::Result<PathBuf> {
    Ok(mirror_import::dir(legacy, collection)?.join("join.json"))
}

/// A join refusal: a snake_case reason (`collection.join`'s error reason).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refused(pub String);

/// The device's join machinery, as this module uses it.
#[allow(async_fn_in_trait)]
pub trait Joiner {
    /// The root this collection is registered at on this device, if it is.
    async fn registered(&mut self, collection: &str) -> Option<PathBuf>;
    /// Join `collection` into the empty `folder` under `name` (`collection.join`).
    async fn join(&mut self, collection: &str, folder: &Path, name: &str) -> Result<(), Refused>;
}

/// What one [`step`] did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    /// Registered here (joined now, or found registered).
    Registered(PathBuf),
    /// Joined earlier and since removed by the user: left alone.
    Removed,
    /// Not joined; retried at `next_attempt_ms`.
    Waiting {
        /// Why.
        reason: String,
        /// When the next attempt is due.
        next_attempt_ms: u64,
    },
}

fn usable(p: &Path) -> io::Result<bool> {
    match std::fs::symlink_metadata(p) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(e) => Err(e),
        Ok(m) if !m.is_dir() => Ok(false),
        Ok(_) => Ok(std::fs::read_dir(p)?.next().is_none()),
    }
}

/// The collection's display name: the old mirror folder's name.
pub fn name(c: &Capture) -> String {
    c.mirror_root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| c.collection_id.clone())
}

/// The first usable join folder for `c` (see the module docs).
pub fn choose_folder(c: &Capture) -> io::Result<PathBuf> {
    if usable(&c.mirror_root)? {
        return Ok(c.mirror_root.clone());
    }
    let name = name(c);
    let parent = c
        .mirror_root
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| c.mirror_root.clone());
    for n in 1..1000u32 {
        let candidate = if n == 1 {
            parent.join(format!("{name} (synced)"))
        } else {
            parent.join(format!("{name} (synced {n})"))
        };
        if usable(&candidate)? {
            return Ok(candidate);
        }
    }
    Err(io::Error::other("no free folder for the join"))
}

/// One join attempt for a captured collection, when due. `now_ms` is the clock.
pub async fn step(
    legacy: &Path,
    collection: &str,
    joiner: &mut impl Joiner,
    now_ms: u64,
) -> io::Result<Step> {
    let c = Capture::load(legacy, collection)?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no capture"))?;
    let mut s = JoinState::load(legacy, collection)?;
    if let Some(root) = joiner.registered(collection).await {
        if s.phase != Phase::Joined || s.folder.as_deref() != Some(root.as_path()) {
            s.phase = Phase::Joined;
            s.folder = Some(root.clone());
            s.attempts = 0;
            s.last_error = None;
            s.save(legacy, collection)?;
        }
        return Ok(Step::Registered(root));
    }
    if s.phase == Phase::Joined {
        return Ok(Step::Removed);
    }
    if now_ms < s.next_attempt_ms() {
        return Ok(Step::Waiting {
            reason: s.last_error.clone().unwrap_or_else(|| "retrying".into()),
            next_attempt_ms: s.next_attempt_ms(),
        });
    }
    // The folder: the saved one while still usable, else a new choice, saved
    // before it is created.
    let folder = match &s.folder {
        Some(f) if usable(f)? => f.clone(),
        _ => {
            let f = choose_folder(&c)?;
            s.folder = Some(f.clone());
            s.save(legacy, collection)?;
            f
        }
    };
    super::adapter::failpoint("mirror_join_folder");
    std::fs::create_dir_all(&folder)?;
    match joiner.join(collection, &folder, &name(&c)).await {
        Ok(()) => {}
        Err(Refused(reason)) if reason == "already_registered" => {}
        Err(Refused(reason)) => {
            if reason == "folder_not_empty" {
                s.folder = None; // something arrived in it: choose again
            }
            s.failed(&reason, now_ms);
            s.save(legacy, collection)?;
            return Ok(Step::Waiting {
                reason,
                next_attempt_ms: s.next_attempt_ms(),
            });
        }
    }
    super::adapter::failpoint("mirror_join_registered");
    let root = joiner.registered(collection).await.unwrap_or(folder);
    s.phase = Phase::Joined;
    s.folder = Some(root.clone());
    s.attempts = 0;
    s.last_error = None;
    s.last_attempt_ms = Some(now_ms);
    s.save(legacy, collection)?;
    Ok(Step::Registered(root))
}

/// Record that the migration record confirmed the cutover.
pub fn confirm_cut_over(legacy: &Path, collection: &str) -> io::Result<()> {
    let mut s = JoinState::load(legacy, collection)?;
    if !s.cut_over {
        s.cut_over = true;
        s.last_error = None;
        s.attempts = 0;
        s.save(legacy, collection)?;
    }
    Ok(())
}

/// Record a cutover check that did not confirm (retried with backoff).
pub fn cut_over_pending(
    legacy: &Path,
    collection: &str,
    reason: &str,
    now_ms: u64,
) -> io::Result<u64> {
    let mut s = JoinState::load(legacy, collection)?;
    s.failed(reason, now_ms);
    s.save(legacy, collection)?;
    Ok(s.next_attempt_ms())
}

/// The join part of `migrate.status.mirror_imports[id]`.
pub fn status(legacy: &Path, collection: &str) -> io::Result<serde_json::Value> {
    let s = JoinState::load(legacy, collection)?;
    Ok(serde_json::json!({
        "state": match s.phase {
            Phase::Pending => "waiting",
            Phase::Joined => "joined",
        },
        "folder": s.folder,
        "reason": s.last_error,
        "attempts": s.attempts,
        "cut_over": s.cut_over,
        "next_attempt_ms": (s.last_attempt_ms.is_some()).then(|| s.next_attempt_ms()),
    }))
}

#[cfg(test)]
#[path = "mirror_join_tests.rs"]
mod tests;
