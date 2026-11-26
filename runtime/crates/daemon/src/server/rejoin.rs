//! Preserve a removed cloud replica before a new registration replays the log.

use super::*;
use mdbn_replica::store::meta_keys;
use rusqlite::{Connection, OpenFlags, OptionalExtension};

fn foreign() -> ControlError {
    ControlError::new(
        "conflict",
        "foreign_replica_store",
        "The local sync store belongs to another collection or replica. It was left in place.",
    )
}

fn io(e: impl std::fmt::Display) -> ControlError {
    ControlError::unavailable("rejoin_store_unavailable", e.to_string())
}

// Read committed metadata, including its WAL, without running schema upgrades,
// recovering pending rows, or opening a collection folder.
fn meta<const N: usize>(db: &Connection, key: &str) -> Result<Option<[u8; N]>, ControlError> {
    db.query_row(
        "SELECT substr(v, 1, ?2) FROM st_meta WHERE k = ?1",
        rusqlite::params![key, N + 1],
        |row| row.get::<_, Vec<u8>>(0),
    )
    .optional()
    .map_err(io)?
    .map(|bytes| bytes.try_into().map_err(|_| foreign()))
    .transpose()
}

fn open_index(index: &std::path::Path) -> Result<Connection, ControlError> {
    if !std::fs::symlink_metadata(index).map_err(io)?.is_file() {
        return Err(foreign());
    }
    fsutil::verify_owner_only(index).map_err(io)?;
    Connection::open_with_flags(
        index,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(io)
}

/// A failed old join may have registered a new ID without ever opening its
/// store. A positive mismatch leaves the legacy recovery path available.
pub(super) fn conflicting_replica(
    dir: &std::path::Path,
    entry: &Entry,
) -> Result<bool, ControlError> {
    let index = dir.join("index.sqlite");
    if !index.try_exists().map_err(io)? {
        return Ok(false);
    }
    fsutil::verify_owner_only(dir).map_err(io)?;
    let db = open_index(&index)?;
    let Some(identity) = meta::<32>(&db, meta_keys::IDENTITY)? else {
        return Ok(false);
    };
    Ok(
        crate::attest::uuid_bytes(&entry.id).is_none_or(|c| c != identity[..16])
            || crate::attest::uuid_bytes(&entry.replica_id).is_none_or(|r| r != identity[16..]),
    )
}

impl Daemon {
    /// Called under the lifecycle gate, after the prospective registration and
    /// remote genesis have both been validated, before writing its link.
    pub(super) fn prepare_cloud_rejoin(
        &self,
        link: &crate::sync::SyncConfig,
        removed_replica: Option<&str>,
        recover_removed: bool,
    ) -> Result<(), ControlError> {
        let id = &link.collection_id;
        let dir = self.profile.collection_dir(id);
        match std::fs::symlink_metadata(&dir) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(io(e)),
            Ok(m) if !m.is_dir() => return Err(foreign()),
            Ok(_) => fsutil::verify_owner_only(&dir).map_err(io)?,
        }
        let index = dir.join("index.sqlite");
        match std::fs::symlink_metadata(&index) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // An interrupted first join may leave only its atomic link write.
                for entry in std::fs::read_dir(&dir).map_err(io)? {
                    let entry = entry.map_err(io)?;
                    let name = entry.file_name();
                    if !entry.file_type().map_err(io)?.is_file()
                        || !(name == crate::sync::FILE
                            || name.to_string_lossy().starts_with(".sync.json.tmp-"))
                    {
                        return Err(foreign());
                    }
                }
                return Ok(());
            }
            Err(e) => return Err(io(e)),
            Ok(_) => {}
        }
        let db = open_index(&index)?;
        let collection = crate::attest::uuid_bytes(id).ok_or_else(foreign)?;
        let identity = meta::<32>(&db, meta_keys::IDENTITY)?.ok_or_else(foreign)?;
        if identity[..16] != collection {
            return Err(foreign());
        }
        let replica = secrets::uuid_string(&identity[16..].try_into().expect("16 replica bytes"));
        let genesis = meta::<32>(&db, meta_keys::GENESIS)?;
        if genesis.is_some_and(|g| secrets::hex(&g) != link.genesis_hash) {
            return Err(foreign());
        }
        if let Some(removed) = removed_replica {
            if removed != replica {
                return Err(foreign());
            }
        } else {
            // v0.1.8–v0.1.20 recorded no removal identity.
            // An intact local store references a *random, write-once* generation
            // created in this profile's credential namespace. A foreign replica
            // of the same collection has the same genesis but its own generation.
            let generation =
                meta::<16>(&db, crate::keyring_store::GENERATION_META)?.ok_or_else(foreign)?;
            let key = crate::keyring_store::keyring_name(
                &mdbn_wire::common::B16(collection),
                &generation,
            );
            let old_link = crate::sync::SyncConfig::load(&dir.join(crate::sync::FILE))
                .map_err(|e| io(e.0))?
                .ok_or_else(foreign)?;
            if genesis.is_none()
                || old_link.collection_id != *id
                || old_link.genesis_hash != link.genesis_hash
                || old_link.environment != link.environment
                || old_link.chosen_state != "cloud_copy"
                || !old_link.user_enabled_cloud_copy
                || self.secrets.get(&key).map_err(io)?.is_none()
            {
                return Err(foreign());
            }
            if !recover_removed {
                return Err(ControlError::new(
                    "conflict",
                    "confirm_removed_cloud_copy",
                    format!(
                        "If you removed this cloud copy from this computer, run `mdbase collection join {id} <empty-folder> --recover-removed`. Your old store and files will be kept."
                    ),
                ));
            }
        }
        drop(db);
        let archive = dir.with_file_name(format!("{id}.removed-{replica}"));
        if archive.try_exists().map_err(io)? {
            return Err(io("A preserved copy of this replica already exists."));
        }
        std::fs::rename(&dir, archive).map_err(io)?;
        fsutil::sync_dir(dir.parent().expect("collection directory has a parent")).map_err(io)
    }
}
