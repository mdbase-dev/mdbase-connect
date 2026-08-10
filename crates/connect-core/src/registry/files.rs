use super::*;
use crate::{discover_collection_files, CollectionFileCandidate, PhysicalFileIdentity};
use chrono::{DateTime, SecondsFormat, Utc};
use mdbase::runtime::CollectionSnapshot;
use mdbase_connect_protocol::{CollectionFileDescriptor, FileMediaClass};
use rusqlite::Transaction;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::File;
use std::io::Read;
use std::time::Duration as StdDuration;

const FILE_INVENTORY_MAX_AGE: StdDuration = StdDuration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileInventoryState {
    observed_generation: u64,
    reconciled_generation: u64,
    index_revision: u64,
    reconciled_at_ms: i64,
}

#[derive(Debug, Clone)]
struct IndexedFile {
    descriptor: CollectionFileDescriptor,
    path_key: String,
    physical_identity: Option<PhysicalFileIdentity>,
}

#[derive(Debug)]
struct ObservedFile<'a> {
    candidate: &'a CollectionFileCandidate,
    content_digest: String,
}

#[derive(Debug, Default)]
pub(super) struct FileReconcilePreferences {
    pub(super) ids_by_path: HashMap<String, Uuid>,
    pub(super) revisions_by_path: HashMap<String, String>,
    pub(super) tombstone_revisions_by_file: HashMap<Uuid, String>,
}

impl CollectionRegistry {
    /// Return a ready inventory revision, or start one bounded background warmup.
    /// Cold and watcher-dirty indexes never hold an application/relay request open
    /// while the authority hashes a large binary collection. A merely aged index
    /// remains readable while its integrity metadata is refreshed in the background.
    pub fn prepare_file_index_for_listing(&self, id: Uuid) -> Result<Option<u64>, ConnectError> {
        self.get(id)?;
        let state = self.file_inventory_state(id)?;
        let now = Utc::now().timestamp_millis();
        let max_age_ms = i64::try_from(FILE_INVENTORY_MAX_AGE.as_millis())
            .expect("inventory maximum age fits in i64");
        let ready =
            state.index_revision > 0 && state.observed_generation == state.reconciled_generation;
        if ready {
            if now.saturating_sub(state.reconciled_at_ms) >= max_age_ms {
                // The watcher-backed snapshot is still safe to enumerate. An exact
                // download verifies its digest again before any bytes are released.
                let _ = self.start_file_index_warmup(id);
            }
            return Ok(Some(state.index_revision));
        }
        self.start_file_index_warmup(id)?;
        Ok(None)
    }

    /// Return the durable inventory revision after refreshing a dirty or stale index.
    /// Watcher generations make changes visible promptly; the age bound recovers from
    /// watcher failures without forcing every page to walk and hash the collection.
    pub fn refresh_file_index_if_needed(&self, id: Uuid) -> Result<u64, ConnectError> {
        self.get(id)?;
        let state = self.file_inventory_state(id)?;
        let now = Utc::now().timestamp_millis();
        let max_age_ms = i64::try_from(FILE_INVENTORY_MAX_AGE.as_millis())
            .expect("inventory maximum age fits in i64");
        if state.observed_generation != state.reconciled_generation
            || now.saturating_sub(state.reconciled_at_ms) >= max_age_ms
        {
            self.reconcile_files_reusing_cached_digests(id)?;
        }
        Ok(self.file_inventory_state(id)?.index_revision)
    }

    fn start_file_index_warmup(&self, id: Uuid) -> Result<(), ConnectError> {
        let mut warmups = self.file_warmups.lock().map_err(|_| ConnectError::File {
            code: "temporarily_unavailable".to_string(),
            message: "The local file index warmup registry is unavailable.".to_string(),
        })?;
        match warmups.get(&id) {
            Some(FileWarmupState::Running) => return Ok(()),
            Some(FileWarmupState::Failed { code, message }) => {
                let error = ConnectError::File {
                    code: code.clone(),
                    message: message.clone(),
                };
                warmups.remove(&id);
                return Err(error);
            }
            None => {}
        }
        warmups.insert(id, FileWarmupState::Running);
        let registry = self.clone();
        let spawn = std::thread::Builder::new()
            .name(format!("mdbase-file-index-{}", &id.to_string()[..8]))
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    registry.reconcile_files_reusing_cached_digests(id)
                }));
                let next = match result {
                    Ok(Ok(_)) => None,
                    Ok(Err(error)) => Some(FileWarmupState::Failed {
                        code: error.code().to_string(),
                        message: error.to_string(),
                    }),
                    Err(_) => Some(FileWarmupState::Failed {
                        code: "temporarily_unavailable".to_string(),
                        message: "The local file index warmup stopped unexpectedly.".to_string(),
                    }),
                };
                if let Ok(mut warmups) = registry.file_warmups.lock() {
                    if let Some(next) = next {
                        warmups.insert(id, next);
                    } else {
                        warmups.remove(&id);
                    }
                }
            });
        if let Err(error) = spawn {
            warmups.remove(&id);
            return Err(ConnectError::File {
                code: "temporarily_unavailable".to_string(),
                message: format!("The local file index warmup could not start: {error}"),
            });
        }
        Ok(())
    }

    /// Return the current durable revision without refreshing it. Continuation pages
    /// use this to remain on one snapshot even if a watcher has marked the next
    /// generation dirty.
    pub fn file_index_revision(&self, id: Uuid) -> Result<u64, ConnectError> {
        self.get(id)?;
        Ok(self.file_inventory_state(id)?.index_revision)
    }

    /// Mark the durable inventory dirty. This is intentionally cheap enough to run
    /// for every collection watcher event, including record and configuration events.
    pub fn mark_file_inventory_dirty(&self, id: Uuid) -> Result<(), ConnectError> {
        self.get(id)?;
        Self::mark_file_inventory_dirty_in(&self.connection()?, id, 1)?;
        Ok(())
    }

    pub(super) fn mark_file_inventory_dirty_in(
        connection: &Connection,
        id: Uuid,
        generations: u64,
    ) -> Result<(), ConnectError> {
        let generations = i64::try_from(generations).unwrap_or(i64::MAX);
        connection.execute(
            "INSERT INTO collection_file_inventory_state
                (collection_id, observed_generation, reconciled_generation,
                 index_revision, reconciled_at_ms)
             VALUES (?1, ?2, 0, 0, 0)
             ON CONFLICT(collection_id) DO UPDATE SET
                observed_generation = MIN(
                    9223372036854775807,
                    observed_generation + ?2
                )",
            params![id.to_string(), generations],
        )?;
        Ok(())
    }

    /// Read a bounded page directly from the durable index. Filtering for a grant is
    /// deliberately left to the local authorization boundary.
    pub fn indexed_files_page(
        &self,
        id: Uuid,
        after: Option<&str>,
        limit: usize,
    ) -> Result<Vec<CollectionFileDescriptor>, ConnectError> {
        self.get(id)?;
        let connection = self.connection()?;
        let sql = if after.is_some() {
            "SELECT file_id, path, revision, content_digest, size, media_type,
                    media_class, modified_at
             FROM collection_files
             WHERE collection_id = ?1 AND path > ?2
             ORDER BY path LIMIT ?3"
        } else {
            "SELECT file_id, path, revision, content_digest, size, media_type,
                    media_class, modified_at
             FROM collection_files
             WHERE collection_id = ?1
             ORDER BY path LIMIT ?3"
        };
        let mut statement = connection.prepare(sql)?;
        let collection_id = id.to_string();
        let limit = i64::try_from(limit).map_err(|_| ConnectError::File {
            code: "invalid_file_request".to_string(),
            message: "The requested file page is too large.".to_string(),
        })?;
        let mut rows = if let Some(after) = after {
            statement.query(params![collection_id, after, limit])?
        } else {
            statement.query(params![collection_id, rusqlite::types::Null, limit])?
        };
        let mut files = Vec::new();
        while let Some(row) = rows.next()? {
            files.push(descriptor_from_index_row(row)?);
        }
        Ok(files)
    }

    /// Reconcile the authority's logical file namespace with its filesystem.
    ///
    /// The mdbase snapshot remains the source of truth for records and
    /// structural resources. File bytes are hashed from a verified open handle
    /// and only metadata is persisted in the registry.
    pub fn reconcile_files(&self, id: Uuid) -> Result<Vec<CollectionFileDescriptor>, ConnectError> {
        self.reconcile_files_with_digest_reuse(id, false)
    }

    fn reconcile_files_reusing_cached_digests(
        &self,
        id: Uuid,
    ) -> Result<Vec<CollectionFileDescriptor>, ConnectError> {
        self.reconcile_files_with_digest_reuse(id, true)
    }

    fn reconcile_files_with_digest_reuse(
        &self,
        id: Uuid,
        reuse_cached_digests: bool,
    ) -> Result<Vec<CollectionFileDescriptor>, ConnectError> {
        let registered = self.get(id)?;
        if !registered.enabled {
            return Err(ConnectError::AccessDenied(
                "This collection is disabled on its computer.".to_string(),
            ));
        }
        assert_local_authority_folder(Path::new(&registered.path))?;
        let provider = self.provider_for(&registered)?;
        provider.with_collection_read(|collection| {
            crate::LocalSyncStore::for_registry(self).assert_authority_available(id)?;
            let snapshot = collection.snapshot()?;
            self.reconcile_files_loaded_internal(
                &registered,
                collection,
                &snapshot,
                &FileReconcilePreferences::default(),
                reuse_cached_digests,
            )
        })
    }

    pub(super) fn reconcile_files_loaded(
        &self,
        registered: &CollectionSummary,
        collection: &mdbase::Collection,
        snapshot: &CollectionSnapshot,
    ) -> Result<Vec<CollectionFileDescriptor>, ConnectError> {
        self.reconcile_files_loaded_with_preferences(
            registered,
            collection,
            snapshot,
            &FileReconcilePreferences::default(),
        )
    }

    pub(super) fn reconcile_files_loaded_with_preferences(
        &self,
        registered: &CollectionSummary,
        collection: &mdbase::Collection,
        snapshot: &CollectionSnapshot,
        preferences: &FileReconcilePreferences,
    ) -> Result<Vec<CollectionFileDescriptor>, ConnectError> {
        self.reconcile_files_loaded_internal(registered, collection, snapshot, preferences, false)
    }

    pub(super) fn reconcile_files_loaded_reusing_cached_digests(
        &self,
        registered: &CollectionSummary,
        collection: &mdbase::Collection,
        snapshot: &CollectionSnapshot,
    ) -> Result<Vec<CollectionFileDescriptor>, ConnectError> {
        self.reconcile_files_loaded_internal(
            registered,
            collection,
            snapshot,
            &FileReconcilePreferences::default(),
            true,
        )
    }

    fn reconcile_files_loaded_internal(
        &self,
        registered: &CollectionSummary,
        collection: &mdbase::Collection,
        snapshot: &CollectionSnapshot,
        preferences: &FileReconcilePreferences,
        reuse_cached_digests: bool,
    ) -> Result<Vec<CollectionFileDescriptor>, ConnectError> {
        let reconcile_lock = self.file_reconcile_lock(registered.id)?;
        let _reconcile = reconcile_lock.lock().map_err(|_| ConnectError::File {
            code: "file_index_unavailable".to_string(),
            message: "The local file index lock is unavailable.".to_string(),
        })?;
        let observed_generation = self
            .file_inventory_state(registered.id)?
            .observed_generation;
        let managed_paths = snapshot
            .resources
            .iter()
            .map(|resource| resource.path.clone())
            .chain(snapshot.records.iter().map(|record| record.path.clone()))
            .collect::<BTreeSet<_>>();
        let inventory = discover_collection_files(collection, &managed_paths)?;
        let previous = if reuse_cached_digests {
            read_indexed_files(&self.connection()?, registered.id)?
        } else {
            BTreeMap::new()
        };
        let observed = inventory
            .files
            .iter()
            .map(|candidate| {
                Ok(ObservedFile {
                    candidate,
                    content_digest: reusable_content_digest(candidate, &previous)
                        .map(str::to_string)
                        .map_or_else(|| hash_verified_file(candidate), Ok)?,
                })
            })
            .collect::<Result<Vec<_>, ConnectError>>()?;
        self.reconcile_observed_files(registered.id, &observed, preferences, observed_generation)
    }

    pub fn indexed_files(&self, id: Uuid) -> Result<Vec<CollectionFileDescriptor>, ConnectError> {
        let connection = self.connection()?;
        Ok(read_indexed_files(&connection, id)?
            .into_values()
            .map(|file| file.descriptor)
            .collect())
    }

    fn reconcile_observed_files(
        &self,
        collection_id: Uuid,
        observed: &[ObservedFile<'_>],
        preferences: &FileReconcilePreferences,
        observed_generation: u64,
    ) -> Result<Vec<CollectionFileDescriptor>, ConnectError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = read_indexed_files(&transaction, collection_id)?;
        let assignments = assign_file_ids(&previous, observed, &preferences.ids_by_path);
        let mut after = BTreeMap::<Uuid, IndexedFile>::new();

        for (position, file) in observed.iter().enumerate() {
            let file_id = assignments[&position];
            let prior = previous.get(&file_id);
            let unchanged = prior.is_some_and(|prior| {
                prior.descriptor.path == file.candidate.path
                    && prior.descriptor.content_digest == file.content_digest
                    && prior.descriptor.size == file.candidate.size
                    && prior.descriptor.media_type == file.candidate.media_type
                    && prior.descriptor.media_class == file.candidate.media_class
                    && prior.descriptor.modified_at == file.candidate.modified_at
            });
            let revision = if unchanged {
                prior.expect("checked above").descriptor.revision.clone()
            } else {
                preferences
                    .revisions_by_path
                    .get(&file.candidate.path_key)
                    .cloned()
                    .unwrap_or_else(|| format!("file:{}", Uuid::now_v7()))
            };
            after.insert(
                file_id,
                IndexedFile {
                    descriptor: CollectionFileDescriptor {
                        file_id,
                        path: file.candidate.path.clone(),
                        revision,
                        content_digest: file.content_digest.clone(),
                        size: file.candidate.size,
                        media_type: file.candidate.media_type.clone(),
                        media_class: file.candidate.media_class,
                        modified_at: file.candidate.modified_at.clone(),
                    },
                    path_key: file.candidate.path_key.clone(),
                    physical_identity: file.candidate.physical_identity.clone(),
                },
            );
        }

        let sync_head = transaction
            .query_row(
                "SELECT head FROM local_sync_collections WHERE collection_id = ?1",
                [collection_id.to_string()],
                |row| row.get::<_, u64>(0),
            )
            .optional()?;
        if let Some(mut head) = sync_head {
            let ids = previous
                .keys()
                .chain(after.keys())
                .copied()
                .collect::<BTreeSet<_>>();
            for file_id in ids {
                let before = previous.get(&file_id);
                let current = after.get(&file_id);
                if before.map(|value| &value.descriptor) == current.map(|value| &value.descriptor) {
                    continue;
                }
                head = head.checked_add(1).ok_or_else(|| ConnectError::File {
                    code: "sequence_exhausted".to_string(),
                    message: "The collection change sequence is exhausted.".to_string(),
                })?;
                let revision = current
                    .map(|value| value.descriptor.revision.clone())
                    .or_else(|| {
                        preferences
                            .tombstone_revisions_by_file
                            .get(&file_id)
                            .cloned()
                    })
                    .unwrap_or_else(|| format!("file:{}", Uuid::now_v7()));
                transaction.execute(
                    "INSERT INTO collection_file_changes
                       (collection_id, sequence, file_id, before_file, after_file, revision)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        collection_id.to_string(),
                        head,
                        file_id.to_string(),
                        before
                            .map(|value| serde_json::to_string(&value.descriptor))
                            .transpose()?,
                        current
                            .map(|value| serde_json::to_string(&value.descriptor))
                            .transpose()?,
                        revision,
                    ],
                )?;
            }
            let retained_after = head.saturating_sub(crate::local_sync::RETAINED_CHANGES);
            transaction.execute(
                "DELETE FROM local_sync_changes
                 WHERE collection_id = ?1 AND sequence <= ?2",
                params![collection_id.to_string(), retained_after],
            )?;
            transaction.execute(
                "DELETE FROM collection_file_changes
                 WHERE collection_id = ?1 AND sequence <= ?2",
                params![collection_id.to_string(), retained_after],
            )?;
            transaction.execute(
                "UPDATE local_sync_collections
                 SET head = ?2, retained_after = MAX(retained_after, ?3)
                 WHERE collection_id = ?1",
                params![collection_id.to_string(), head, retained_after],
            )?;
        }

        transaction.execute(
            "DELETE FROM collection_files WHERE collection_id = ?1",
            [collection_id.to_string()],
        )?;
        for file in after.values() {
            persist_indexed_file(&transaction, collection_id, file)?;
        }
        let inventory_changed = previous.len() != after.len()
            || previous.iter().any(|(file_id, before)| {
                after
                    .get(file_id)
                    .is_none_or(|current| current.descriptor != before.descriptor)
            });
        transaction.execute(
            "INSERT INTO collection_file_inventory_state
                (collection_id, observed_generation, reconciled_generation,
                 index_revision, reconciled_at_ms)
             VALUES (?1, ?2, ?2, 1, ?3)
             ON CONFLICT(collection_id) DO UPDATE SET
                reconciled_generation = MAX(reconciled_generation, ?2),
                index_revision = CASE
                    WHEN ?4 THEN index_revision + 1
                    ELSE MAX(index_revision, 1)
                END,
                reconciled_at_ms = ?3",
            params![
                collection_id.to_string(),
                observed_generation,
                Utc::now().timestamp_millis(),
                inventory_changed
            ],
        )?;
        transaction.commit()?;
        Ok(after.into_values().map(|file| file.descriptor).collect())
    }

    fn file_inventory_state(&self, id: Uuid) -> Result<FileInventoryState, ConnectError> {
        let connection = self.connection()?;
        connection.execute(
            "INSERT OR IGNORE INTO collection_file_inventory_state (collection_id)
             VALUES (?1)",
            [id.to_string()],
        )?;
        connection
            .query_row(
                "SELECT observed_generation, reconciled_generation, index_revision,
                        reconciled_at_ms
                 FROM collection_file_inventory_state WHERE collection_id = ?1",
                [id.to_string()],
                |row| {
                    Ok(FileInventoryState {
                        observed_generation: row.get(0)?,
                        reconciled_generation: row.get(1)?,
                        index_revision: row.get(2)?,
                        reconciled_at_ms: row.get(3)?,
                    })
                },
            )
            .map_err(ConnectError::from)
    }

    fn file_reconcile_lock(&self, id: Uuid) -> Result<Arc<Mutex<()>>, ConnectError> {
        let mut locks = self
            .file_reconciles
            .lock()
            .map_err(|_| ConnectError::File {
                code: "file_index_unavailable".to_string(),
                message: "The local file index lock registry is unavailable.".to_string(),
            })?;
        Ok(locks
            .entry(id)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone())
    }
}

fn descriptor_from_index_row(
    row: &rusqlite::Row<'_>,
) -> Result<CollectionFileDescriptor, ConnectError> {
    let file_id = row.get::<_, String>(0)?;
    let file_id = Uuid::parse_str(&file_id).map_err(|error| ConnectError::File {
        code: "file_index_corrupt".to_string(),
        message: format!("The local file index contains an invalid file ID: {error}"),
    })?;
    let media_class = row.get::<_, String>(6)?;
    Ok(CollectionFileDescriptor {
        file_id,
        path: row.get(1)?,
        revision: row.get(2)?,
        content_digest: row.get(3)?,
        size: row.get(4)?,
        media_type: row.get(5)?,
        media_class: parse_media_class(&media_class)?,
        modified_at: row.get(7)?,
    })
}

fn assign_file_ids(
    previous: &BTreeMap<Uuid, IndexedFile>,
    observed: &[ObservedFile<'_>],
    preferred_ids: &HashMap<String, Uuid>,
) -> BTreeMap<usize, Uuid> {
    let mut assignments = BTreeMap::new();
    let mut available = previous.keys().copied().collect::<BTreeSet<_>>();

    for (position, file) in observed.iter().enumerate() {
        if let Some(file_id) = preferred_ids.get(&file.candidate.path_key) {
            assignments.insert(position, *file_id);
            available.remove(file_id);
        }
    }

    for (position, file) in observed.iter().enumerate() {
        if assignments.contains_key(&position) {
            continue;
        }
        if let Some((file_id, _)) = previous
            .iter()
            .find(|(_, prior)| prior.path_key == file.candidate.path_key)
        {
            assignments.insert(position, *file_id);
            available.remove(file_id);
        }
    }

    assign_unique_matches(
        &mut assignments,
        &mut available,
        previous,
        observed,
        |prior, current| {
            prior.physical_identity.is_some()
                && prior.physical_identity == current.candidate.physical_identity
        },
    );
    assign_unique_matches(
        &mut assignments,
        &mut available,
        previous,
        observed,
        |prior, current| prior.descriptor.content_digest == current.content_digest,
    );

    for position in 0..observed.len() {
        assignments.entry(position).or_insert_with(Uuid::now_v7);
    }
    assignments
}

fn reusable_content_digest<'a>(
    candidate: &CollectionFileCandidate,
    previous: &'a BTreeMap<Uuid, IndexedFile>,
) -> Option<&'a str> {
    previous
        .values()
        .find(|prior| {
            let same_file = prior.path_key == candidate.path_key
                || prior.physical_identity.is_some()
                    && prior.physical_identity == candidate.physical_identity;
            same_file
                && prior.descriptor.size == candidate.size
                && prior.descriptor.modified_at == candidate.modified_at
                && prior.descriptor.media_type == candidate.media_type
                && prior.descriptor.media_class == candidate.media_class
        })
        .map(|prior| prior.descriptor.content_digest.as_str())
}

fn assign_unique_matches(
    assignments: &mut BTreeMap<usize, Uuid>,
    available: &mut BTreeSet<Uuid>,
    previous: &BTreeMap<Uuid, IndexedFile>,
    observed: &[ObservedFile<'_>],
    matches: impl Fn(&IndexedFile, &ObservedFile<'_>) -> bool,
) {
    let pending = (0..observed.len())
        .filter(|position| !assignments.contains_key(position))
        .collect::<Vec<_>>();
    for position in pending {
        let candidates = available
            .iter()
            .filter(|file_id| matches(&previous[file_id], &observed[position]))
            .copied()
            .collect::<Vec<_>>();
        let competing = observed
            .iter()
            .enumerate()
            .filter(|(other, current)| {
                !assignments.contains_key(other)
                    && candidates
                        .iter()
                        .any(|file_id| matches(&previous[file_id], current))
            })
            .count();
        if candidates.len() == 1 && competing == 1 {
            assignments.insert(position, candidates[0]);
            available.remove(&candidates[0]);
        }
    }
}

fn hash_verified_file(candidate: &CollectionFileCandidate) -> Result<String, ConnectError> {
    let mut file = File::open(&candidate.absolute_path)?;
    let before = file.metadata()?;
    verify_open_file(candidate, &before)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let after = file.metadata()?;
    verify_open_file(candidate, &after)?;
    let live = fs::symlink_metadata(&candidate.absolute_path)?;
    verify_open_file(candidate, &live)?;
    Ok(format!("sha256:{:x}", digest.finalize()))
}

fn verify_open_file(
    candidate: &CollectionFileCandidate,
    metadata: &fs::Metadata,
) -> Result<(), ConnectError> {
    let stable = metadata.is_file()
        && !metadata.file_type().is_symlink()
        && metadata.len() == candidate.size
        && metadata
            .modified()
            .map_or(candidate.modified_at == "1970-01-01T00:00:00Z", |value| {
                DateTime::<Utc>::from(value).to_rfc3339_opts(SecondsFormat::Nanos, true)
                    == candidate.modified_at
            })
        && physical_identity_matches(metadata, candidate.physical_identity.as_ref());
    if stable {
        return Ok(());
    }
    Err(ConnectError::File {
        code: "file_changed_during_read".to_string(),
        message: format!(
            "Collection file '{}' changed while it was being indexed; retry after writes finish.",
            candidate.path
        ),
    })
}

#[cfg(unix)]
fn physical_identity_matches(
    metadata: &fs::Metadata,
    expected: Option<&PhysicalFileIdentity>,
) -> bool {
    use std::os::unix::fs::MetadataExt;
    expected.is_some_and(|identity| {
        metadata.dev() == identity.device
            && metadata.ino() == identity.file
            && metadata.nlink() == 1
    })
}

#[cfg(not(unix))]
fn physical_identity_matches(
    _metadata: &fs::Metadata,
    _expected: Option<&PhysicalFileIdentity>,
) -> bool {
    true
}

fn read_indexed_files(
    connection: &Connection,
    collection_id: Uuid,
) -> Result<BTreeMap<Uuid, IndexedFile>, ConnectError> {
    let mut statement = connection.prepare(
        "SELECT file_id, path, path_key, revision, content_digest, size,
                media_type, media_class, modified_at, physical_device, physical_file
         FROM collection_files WHERE collection_id = ?1 ORDER BY path_key",
    )?;
    let rows = statement.query_map([collection_id.to_string()], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, u64>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, String>(7)?,
            row.get::<_, String>(8)?,
            row.get::<_, Option<String>>(9)?,
            row.get::<_, Option<String>>(10)?,
        ))
    })?;
    rows.map(|row| {
        let (
            file_id,
            path,
            path_key,
            revision,
            content_digest,
            size,
            media_type,
            media_class,
            modified_at,
            physical_device,
            physical_file,
        ) = row?;
        let file_id = Uuid::parse_str(&file_id).map_err(|error| ConnectError::File {
            code: "file_index_corrupt".to_string(),
            message: format!("The local file index contains an invalid file ID: {error}"),
        })?;
        Ok((
            file_id,
            IndexedFile {
                descriptor: CollectionFileDescriptor {
                    file_id,
                    path,
                    revision,
                    content_digest,
                    size,
                    media_type,
                    media_class: parse_media_class(&media_class)?,
                    modified_at,
                },
                path_key,
                physical_identity: physical_device
                    .zip(physical_file)
                    .map(
                        |(device, file)| -> Result<PhysicalFileIdentity, ConnectError> {
                            Ok(PhysicalFileIdentity {
                                device: device.parse().map_err(|_| ConnectError::File {
                                    code: "file_index_corrupt".to_string(),
                                    message:
                                        "The local file index contains an invalid device identity."
                                            .to_string(),
                                })?,
                                file: file.parse().map_err(|_| ConnectError::File {
                                    code: "file_index_corrupt".to_string(),
                                    message:
                                        "The local file index contains an invalid file identity."
                                            .to_string(),
                                })?,
                            })
                        },
                    )
                    .transpose()?,
            },
        ))
    })
    .collect()
}

fn persist_indexed_file(
    transaction: &Transaction<'_>,
    collection_id: Uuid,
    file: &IndexedFile,
) -> Result<(), ConnectError> {
    transaction.execute(
        "INSERT INTO collection_files
           (collection_id, file_id, path, path_key, revision, content_digest, size,
            media_type, media_class, modified_at, physical_device, physical_file)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            collection_id.to_string(),
            file.descriptor.file_id.to_string(),
            file.descriptor.path,
            file.path_key,
            file.descriptor.revision,
            file.descriptor.content_digest,
            file.descriptor.size,
            file.descriptor.media_type,
            media_class_name(file.descriptor.media_class),
            file.descriptor.modified_at,
            file.physical_identity
                .as_ref()
                .map(|identity| identity.device.to_string()),
            file.physical_identity
                .as_ref()
                .map(|identity| identity.file.to_string()),
        ],
    )?;
    Ok(())
}

fn media_class_name(media_class: FileMediaClass) -> &'static str {
    match media_class {
        FileMediaClass::Image => "image",
        FileMediaClass::Audio => "audio",
        FileMediaClass::Video => "video",
        FileMediaClass::Pdf => "pdf",
        FileMediaClass::Other => "other",
    }
}

fn parse_media_class(value: &str) -> Result<FileMediaClass, ConnectError> {
    match value {
        "image" => Ok(FileMediaClass::Image),
        "audio" => Ok(FileMediaClass::Audio),
        "video" => Ok(FileMediaClass::Video),
        "pdf" => Ok(FileMediaClass::Pdf),
        "other" => Ok(FileMediaClass::Other),
        _ => Err(ConnectError::File {
            code: "file_index_corrupt".to_string(),
            message: "The local file index contains an invalid media class.".to_string(),
        }),
    }
}

#[cfg(test)]
mod tests;
