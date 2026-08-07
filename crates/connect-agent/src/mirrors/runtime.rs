use super::*;

impl MirrorManager {
    pub fn open(
        state_dir: &Path,
        registry: CollectionRegistry,
        cloud: Option<CloudControlClient>,
        credential_store_error: Option<String>,
    ) -> Result<Arc<Self>, ConnectError> {
        crate::ensure_tls_crypto_provider();
        let entries = read_registry(&state_dir.join("mirrors.json"))?;
        let lock_root = default_lock_root(state_dir);
        fs::create_dir_all(&lock_root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&lock_root, fs::Permissions::from_mode(0o700))?;
        }
        Ok(Arc::new(Self {
            state_dir: state_dir.to_path_buf(),
            lock_root,
            registry,
            cloud,
            client: Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|error| ConnectError::Cloud(error.to_string()))?,
            secrets: SystemSecretStore::new(state_dir),
            credential_store_error,
            entries: RwLock::new(entries),
            syncing: StdMutex::new(HashSet::new()),
            operation_finished: Notify::new(),
            errors: RwLock::new(HashMap::new()),
        }))
    }

    pub fn start(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let manager = self.clone();
        tokio::spawn(async move {
            manager.recover_provisioning().await;
            manager.recover_removals().await;
            let mut interval = tokio::time::interval(SYNC_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut workers = JoinSet::new();
            let mut retries = HashMap::<Uuid, BackgroundRetry>::new();
            let mut blocked = HashSet::<Uuid>::new();
            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        let entries = manager.entries();
                        let actionable = entries
                            .iter()
                            .filter(|entry| {
                                (entry.lifecycle == MirrorLifecycle::Active
                                    && entry.promotion.is_none())
                                    || matches!(
                                        entry.lifecycle,
                                        MirrorLifecycle::Revoking | MirrorLifecycle::Removing
                                    )
                            })
                            .map(|entry| entry.replica_id)
                            .collect::<HashSet<_>>();
                        retries.retain(|replica_id, _| actionable.contains(replica_id));
                        blocked.retain(|replica_id| actionable.contains(replica_id));
                        let now = Instant::now();
                        for entry in entries.into_iter().filter(|entry| {
                            actionable.contains(&entry.replica_id)
                                && !blocked.contains(&entry.replica_id)
                                && retries
                                    .get(&entry.replica_id)
                                    .is_none_or(|retry| retry.at <= now)
                        }) {
                            let manager = manager.clone();
                            workers.spawn(async move {
                                let replica_id = entry.replica_id;
                                let result = if entry.lifecycle == MirrorLifecycle::Active {
                                    manager.sync_entry(entry, true).await
                                } else {
                                    let mut entry = entry;
                                    manager.revoke_and_remove(&mut entry, true).await
                                };
                                (replica_id, result)
                            });
                        }
                    }
                    completed = workers.join_next(), if !workers.is_empty() => {
                        match completed {
                            Some(Ok((replica_id, Ok(())))) => {
                                retries.remove(&replica_id);
                                blocked.remove(&replica_id);
                            }
                            Some(Ok((_, Err(error)))) if error.code() == "mirror_sync_skipped" => {}
                            Some(Ok((replica_id, Err(error)))) if terminal_background_error(&error) => {
                                retries.remove(&replica_id);
                                blocked.insert(replica_id);
                                tracing::warn!(
                                    replica_id = %replica_id,
                                    code = error.code(),
                                    error = %error,
                                    "hosted mirror background sync requires operator action"
                                );
                            }
                            Some(Ok((replica_id, Err(error)))) => {
                                let retry = retries.entry(replica_id).or_default();
                                retry.failures = retry.failures.saturating_add(1);
                                let delay = background_retry_delay(replica_id, retry.failures);
                                retry.at = Instant::now() + delay;
                                tracing::warn!(
                                    replica_id = %replica_id,
                                    code = error.code(),
                                    retry_in_seconds = delay.as_secs_f64(),
                                    error = %error,
                                    "hosted mirror background sync failed"
                                );
                            }
                            Some(Err(error)) => {
                                tracing::error!(
                                    error = %error,
                                    "hosted mirror background worker failed"
                                );
                            }
                            None => {}
                        }
                    }
                }
            }
        })
    }
}
