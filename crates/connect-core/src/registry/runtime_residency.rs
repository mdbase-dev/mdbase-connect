use super::*;

const MAX_RESIDENT_COLLECTION_RUNTIMES: usize = 8;

#[cfg(test)]
#[path = "runtime_residency_tests.rs"]
mod tests;

impl CollectionRegistry {
    /// Readiness only: no record payloads, no second filesystem watcher.
    pub fn set_runtime_waker(&self, callback: Arc<dyn Fn() + Send + Sync>) {
        self.runtime_wakeup.set(callback);
    }

    pub(super) fn lock_runtime_lifecycle(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, ()>, ConnectError> {
        self.runtime_lifecycle
            .lock()
            .map_err(|_| ConnectError::CollectionOpen("runtime lifecycle lock poisoned".into()))
    }

    pub(super) fn provider_for(
        &self,
        registered: &CollectionSummary,
    ) -> Result<Arc<FilesystemProvider>, ConnectError> {
        self.executor_for(registered)
            .map(|executor| executor.provider())
    }

    pub(super) fn executor_for(
        &self,
        registered: &CollectionSummary,
    ) -> Result<Arc<CollectionExecutor>, ConnectError> {
        assert_local_authority_folder(Path::new(&registered.path))?;
        let mut executors = self
            .executors
            .lock()
            .map_err(|_| ConnectError::CollectionOpen("executor registry lock poisoned".into()))?;
        if let Some(executor) = executors.get(&registered.id) {
            executor.touch();
            let executor = executor.clone();
            let retired = trim_idle_executors(
                &mut executors,
                MAX_RESIDENT_COLLECTION_RUNTIMES,
                Some(registered.id),
            );
            drop(executors);
            drop(retired); // Joining retired watchers must not hold the map lock.
            return Ok(executor);
        }
        drop(executors);
        let _lifecycle = self.lock_runtime_lifecycle()?;
        // A previous cold opener or a lifecycle operation may have completed
        // while we waited. Never publish from the caller's stale registration.
        let current = self.get(registered.id)?;
        if !current.enabled {
            return Err(ConnectError::AccessDenied(
                "The collection is disabled.".into(),
            ));
        }
        if let Some(executor) = self.resident_executor(current.id)? {
            executor.touch();
            return Ok(executor);
        }
        assert_local_authority_folder(Path::new(&current.path))?;
        let executor = self.open_executor(current.id, Path::new(&current.path))?;
        let mut executors = self
            .executors
            .lock()
            .map_err(|_| ConnectError::CollectionOpen("executor registry lock poisoned".into()))?;
        let retired = trim_idle_executors(
            &mut executors,
            MAX_RESIDENT_COLLECTION_RUNTIMES.saturating_sub(1),
            None,
        );
        executors.insert(registered.id, executor.clone());
        drop(executors);
        drop(retired);
        self.runtime_wakeup.wake();
        Ok(executor)
    }

    pub(super) fn resident_executor(
        &self,
        collection_id: Uuid,
    ) -> Result<Option<Arc<CollectionExecutor>>, ConnectError> {
        let mut executors = self
            .executors
            .lock()
            .map_err(|_| ConnectError::CollectionOpen("executor registry lock poisoned".into()))?;
        let resident = executors.get(&collection_id).cloned();
        let retired = trim_idle_executors(
            &mut executors,
            MAX_RESIDENT_COLLECTION_RUNTIMES,
            resident.as_ref().map(|_| collection_id),
        );
        drop(executors);
        drop(retired);
        Ok(resident)
    }

    pub(super) fn cache_executor(
        &self,
        collection_id: Uuid,
        executor: Arc<CollectionExecutor>,
    ) -> Result<(), ConnectError> {
        let mut executors = self
            .executors
            .lock()
            .map_err(|_| ConnectError::CollectionOpen("executor registry lock poisoned".into()))?;
        let mut retired = trim_idle_executors(
            &mut executors,
            MAX_RESIDENT_COLLECTION_RUNTIMES.saturating_sub(1),
            None,
        );
        retired.extend(executors.insert(collection_id, executor));
        drop(executors);
        drop(retired);
        self.runtime_wakeup.wake();
        Ok(())
    }

    /// Release every resident runtime after bounded background index work drains.
    ///
    /// Daemon shutdown uses this as a lifecycle barrier before collection folders
    /// may be moved or removed on Windows.
    pub fn shutdown_runtimes(&self) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let running = self
                .file_warmups
                .lock()
                .map(|warmups| {
                    warmups
                        .values()
                        .any(|state| matches!(state, FileWarmupState::Running))
                })
                .unwrap_or(false);
            if !running || std::time::Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        // Fence all initialization already in flight before clearing residency.
        // Callers may deliberately reopen after this barrier (e.g. a folder move).
        let _lifecycle = self
            .runtime_lifecycle
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let roots = if let Ok(mut executors) = self.executors.lock() {
            let roots = executors
                .values()
                .map(|executor| executor.provider().root().to_path_buf())
                .collect::<Vec<_>>();
            executors.clear();
            roots
        } else {
            Vec::new()
        };
        #[cfg(windows)]
        for root in roots {
            wait_for_windows_delete_share(&root);
        }
        #[cfg(not(windows))]
        drop(roots);
    }

    /// Snapshot the bounded set of collection runtimes already held in memory.
    pub fn resident_collection_ids(&self) -> Result<Vec<Uuid>, ConnectError> {
        let executors = self
            .executors
            .lock()
            .map_err(|_| ConnectError::CollectionOpen("executor registry lock poisoned".into()))?;
        Ok(executors.keys().copied().collect())
    }

    pub fn runtime_residency_diagnostics(
        &self,
    ) -> Result<RuntimeResidencyDiagnostics, ConnectError> {
        let samples = {
            let executors = self.executors.lock().map_err(|_| {
                ConnectError::CollectionOpen("executor registry lock poisoned".into())
            })?;
            executors
                .values()
                .map(|executor| (Arc::strong_count(executor) > 1, executor.clone()))
                .collect::<Vec<_>>()
        };
        let mut loaded_type_definitions = 0;
        let mut active_read_snapshots = 0;
        let mut retained_read_snapshot_bytes = 0;
        for (_, executor) in &samples {
            let measurements = executor.measurements()?;
            loaded_type_definitions += measurements.loaded_type_definitions;
            active_read_snapshots += measurements.active_read_snapshots;
            retained_read_snapshot_bytes += measurements.retained_read_snapshot_bytes;
        }
        let active = samples.iter().filter(|(active, _)| *active).count();
        Ok(RuntimeResidencyDiagnostics {
            capacity: MAX_RESIDENT_COLLECTION_RUNTIMES,
            resident: samples.len(),
            active,
            idle: samples.len().saturating_sub(active),
            loaded_type_definitions,
            active_read_snapshots,
            retained_read_snapshot_bytes,
        })
    }

    pub(super) fn open_executor(
        &self,
        collection_id: Uuid,
        root: &Path,
    ) -> Result<Arc<CollectionExecutor>, ConnectError> {
        let owner = self.runtime_feed_owner(collection_id)?;
        let coordinated = read_collection_metadata(root)?
            .spec_version
            .starts_with("0.3");
        let executor = Arc::new(CollectionExecutor::open(root, &owner, coordinated)?);
        if coordinated {
            let wakeup = self.runtime_wakeup.clone();
            executor
                .runtime()?
                .set_event_waker(Arc::new(move || wakeup.wake()))?;
        }
        Ok(executor)
    }

    fn runtime_feed_owner(
        &self,
        collection_id: Uuid,
    ) -> Result<mdbase::runtime::ChangeFeedOwnerId, ConnectError> {
        let key = format!("runtime_feed_owner:{collection_id}");
        let generated = mdbase::runtime::ChangeFeedOwnerId::generate();
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)",
            params![key, generated.as_str()],
        )?;
        let stored: String = transaction.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [format!("runtime_feed_owner:{collection_id}")],
            |row| row.get(0),
        )?;
        transaction.commit()?;
        serde_json::from_value(Value::String(stored)).map_err(|error| {
            ConnectError::RegistryCorrupt {
                path: PathBuf::from("connector.sqlite"),
                detail: format!("runtime feed owner is invalid: {error}"),
            }
        })
    }

    pub(super) fn move_runtime_feed_owner(&self, from: Uuid, to: Uuid) -> Result<(), ConnectError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let old_key = format!("runtime_feed_owner:{from}");
        let new_key = format!("runtime_feed_owner:{to}");
        if let Some(owner) = transaction
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                [&old_key],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            transaction.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![new_key, owner],
            )?;
            transaction.execute("DELETE FROM settings WHERE key = ?1", [&old_key])?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub(super) fn delete_runtime_feed_owner(&self, id: Uuid) -> Result<(), ConnectError> {
        self.connection()?.execute(
            "DELETE FROM settings WHERE key = ?1",
            [format!("runtime_feed_owner:{id}")],
        )?;
        Ok(())
    }
}

#[cfg(windows)]
fn wait_for_windows_delete_share(root: &Path) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !windows_tree_is_delete_shared(root) && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[cfg(windows)]
fn windows_tree_is_delete_shared(root: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    let mut pending = vec![root.to_path_buf()];
    while let Some(path) = pending.pop() {
        let handle = std::fs::OpenOptions::new()
            .access_mode(DELETE)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(&path);
        match handle {
            Ok(file) => drop(file),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return false,
        }
        if std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_dir()) {
            let entries = match std::fs::read_dir(&path) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return false,
            };
            for entry in entries {
                let Ok(entry) = entry else { return false };
                pending.push(entry.path());
            }
        }
    }
    true
}

fn trim_idle_executors(
    executors: &mut HashMap<Uuid, Arc<CollectionExecutor>>,
    target: usize,
    keep: Option<Uuid>,
) -> Vec<Arc<CollectionExecutor>> {
    let mut retired = Vec::new();
    while executors.len() > target {
        let candidate = executors
            .iter()
            .filter(|(id, executor)| {
                Some(**id) != keep && Arc::strong_count(executor) == 1 && executor.is_evictable()
            })
            .min_by_key(|(_, executor)| executor.last_used())
            .map(|(id, _)| *id);
        let Some(candidate) = candidate else { break };
        retired.extend(executors.remove(&candidate));
    }
    retired
}
