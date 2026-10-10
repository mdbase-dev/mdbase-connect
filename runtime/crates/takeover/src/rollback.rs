//! Local rollback (local migration rollback): a taken-over folder goes back to
//! the old connector.
//! - While the v2 marker still fences the old connector, the control plane durably
//!   rotates grant bindings, the new store is archived, and the old daemon prepares
//!   its refreshed bindings. Every step is idempotent for the rollback identity.
//! - Only then is the marker moved aside and the directory synced, before the old
//!   daemon is re-enabled. A crash cannot reopen the old binding's replay window.
//! - No Markdown and no old state file is written.
//!
//! Hosted rollback stays in `mdbn-migrate::rollback`, which re-exports this module.

use std::path::{Path, PathBuf};

use mdbn_legacy::marker::{self, Marker};

use crate::{Error, Result};

/// The new daemon, as rollback needs it.
pub trait NewDaemon {
    /// Stop serving the collection at `root`, and wait until no write is in flight.
    fn stop_serving(&mut self, root: &Path) -> std::result::Result<(), String>;
    /// Paths that are currently held. They're listed in the report; holds keep the
    /// user's bytes in the folder and in the archived store.
    fn held_paths(&mut self, collection: &str) -> Vec<String>;
    /// Durably archive the collection's store, including holds and restoration inputs.
    /// Idempotent for `(collection, rollback_id)`: a retry returns the same archive,
    /// and must not discard evidence when the live store has already been moved.
    fn archive_store(
        &mut self,
        collection: &str,
        rollback_id: &str,
    ) -> std::result::Result<PathBuf, String>;
}

/// The old connector daemon, through its service manager.
pub trait OldDaemon {
    /// Prepare the durably refreshed binding epochs/keys from this rollback's
    /// control-plane rotation, without serving the fenced collection. Idempotent
    /// for `(collection, rollback_id)`; return only when the old daemon will consume
    /// those bindings before serving, including on an independent restart.
    /// An adapter that cannot guarantee this must fail, leaving the fence intact.
    fn prepare_refreshed_bindings(
        &mut self,
        collection: &str,
        rollback_id: &str,
    ) -> std::result::Result<(), String>;
    /// Re-enable autostart and start it. It must consume the prepared refreshed
    /// bindings before serving; a startup failure must not undo that preparation.
    fn enable_and_start(&mut self) -> std::result::Result<(), String>;
}

/// The control plane, for the steps that need the server.
pub trait LocalControl {
    /// Durably rotate each grant's binding epoch and key ID for `collection`
    /// (Connect `docs/encryption.md`), invalidating the old bindings. Idempotent for
    /// `(collection, rollback_id)`, including retries after an unknown response:
    /// persist the result before returning, and do not rotate again on retry.
    fn rotate_grant_bindings(
        &mut self,
        collection: &str,
        rollback_id: &str,
    ) -> std::result::Result<(), String>;
}

/// What a local rollback did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalReport {
    /// Where the marker went (`None` if a previous run had already moved it).
    pub marker_moved_to: Option<PathBuf>,
    /// Where the daemon's store went.
    pub store_archived_to: PathBuf,
    /// Held paths, which need the user's attention.
    pub held: Vec<String>,
}

/// Roll a taken-over local collection back to the old connector (§6.1).
///
/// `replica_id` is the daemon's store ID for this collection: the one written into the
/// marker at T6. A marker naming another replica is refused, because it isn't ours to
/// move. `tag` is the stable rollback identity and names the moved-aside marker
/// (e.g. a UTC timestamp). Persist it before the first call and reuse it on every
/// retry. Never retry with a new tag: rotation and archival deduplicate by it.
pub fn rollback_local(
    root: &Path,
    collection: &str,
    replica_id: &str,
    tag: &str,
    daemon: &mut dyn NewDaemon,
    old: &mut dyn OldDaemon,
    control: &mut dyn LocalControl,
) -> Result<LocalReport> {
    if tag.is_empty() || tag.contains(['/', '\\']) {
        return Err(Error::Invalid("rollback tag must be a plain name".into()));
    }
    daemon
        .stop_serving(root)
        .map_err(|e| Error::Invalid(format!("stop the new daemon: {e}")))?;
    let lock_path = mdbn_legacy::lock::write_lock_path(root);
    let _lock = mdbn_legacy::lock::try_exclusive(&lock_path)
        .map_err(|e| Error::Legacy(e.to_string()))?
        .ok_or_else(|| {
            Error::Invalid("the folder's write.lock is held by another process".into())
        })?;

    let marker_path = root.join(".mdbase").join("connect-role.json");
    let aside = root
        .join(".mdbase")
        .join(format!("connect-role.json.rolled-back-{tag}"));
    let move_marker = match marker::read(root).map_err(|e| Error::Legacy(e.to_string()))? {
        Marker::Claimed {
            collection: c,
            replica_id: r,
        } if c == collection && r == replica_id => {
            if aside
                .try_exists()
                .map_err(|e| Error::Invalid(format!("inspect rollback evidence: {e}")))?
            {
                return Err(Error::Invalid(
                    "moved-aside marker already exists; refusing to overwrite evidence".into(),
                ));
            }
            true
        }
        Marker::Absent if is_ours(&aside, collection, replica_id) => false, // resumed run
        Marker::Absent => {
            return Err(Error::Invalid(
                "no marker and no moved-aside marker of ours: not a folder this daemon took over"
                    .into(),
            ));
        }
        other => {
            return Err(Error::Invalid(format!(
                "the marker is not ours to move: {other:?}"
            )));
        }
    };
    control
        .rotate_grant_bindings(collection, tag)
        .map_err(|e| Error::Invalid(format!("rotate grant bindings: {e}")))?;
    let held = daemon.held_paths(collection);
    let store_archived_to = daemon
        .archive_store(collection, tag)
        .map_err(|e| Error::Invalid(format!("archive the daemon store: {e}")))?;
    old.prepare_refreshed_bindings(collection, tag)
        .map_err(|e| Error::Invalid(format!("prepare old daemon bindings: {e}")))?;
    let marker_moved_to = if move_marker {
        std::fs::rename(&marker_path, &aside)
            .map_err(|e| Error::Invalid(format!("move the marker aside: {e}")))?;
        Some(aside)
    } else {
        None
    };
    // Retry this sync even when resuming after the rename. Unsupported directory
    // durability blocks startup; never silently treat a failed sync as success.
    sync_dir(&root.join(".mdbase"))?;
    old.enable_and_start()
        .map_err(|e| Error::Invalid(format!("start the old daemon: {e}")))?;
    Ok(LocalReport {
        marker_moved_to,
        store_archived_to,
        held,
    })
}

fn is_ours(aside: &Path, collection: &str, replica_id: &str) -> bool {
    std::fs::read(aside).is_ok_and(|b| {
        matches!(marker::parse(&b), Marker::Claimed { collection: c, replica_id: r }
            if c == collection && r == replica_id)
    })
}

fn sync_dir(dir: &Path) -> Result<()> {
    let d = std::fs::File::open(dir)
        .map_err(|e| Error::Invalid(format!("open marker directory for durability: {e}")))?;
    d.sync_all()
        .map_err(|e| Error::Invalid(format!("sync marker directory: {e}")))
}

#[cfg(test)]
mod durability_tests {
    #[test]
    fn directory_sync_errors_are_not_silently_accepted() {
        let absent = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("Cargo.toml")
            .join("not-a-directory");
        assert!(super::sync_dir(&absent).is_err());
    }
}
