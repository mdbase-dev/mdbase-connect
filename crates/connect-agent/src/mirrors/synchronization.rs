use super::*;

impl MirrorManager {
    pub(super) fn summary(
        &self,
        entry: &MirrorRegistryEntry,
    ) -> Result<MirrorSummary, ConnectError> {
        let status = self
            .build_mirror(entry, "status-does-not-use-a-credential")?
            .status()
            .map_err(from_mirror)?;
        let mut error = self
            .errors
            .read()
            .expect("mirror error lock poisoned")
            .get(&entry.replica_id)
            .cloned();
        match entry.lifecycle {
            MirrorLifecycle::Provisioning => {
                error = Some("Mirror setup is waiting to resume.".to_string());
            }
            MirrorLifecycle::Revoking => {
                error = Some("Mirror revocation is waiting to resume.".to_string());
            }
            MirrorLifecycle::Removing => {
                error = Some("Mirror removal is waiting for local cleanup.".to_string());
            }
            MirrorLifecycle::Active => {}
        }
        let syncing = self
            .syncing
            .lock()
            .expect("mirror sync lock poisoned")
            .contains(&entry.replica_id);
        Ok(MirrorSummary {
            collection_id: entry.collection_id,
            replica_id: entry.replica_id,
            name: entry.name.clone(),
            mode: entry.mode,
            path: entry.path.to_string_lossy().to_string(),
            state: if error.is_some() {
                MirrorState::Offline
            } else {
                status.state
            },
            pending: status.pending,
            conflicts: status.conflicts,
            local_issues: status.local_issues,
            cursor: status.cursor,
            last_synced_at: status.last_synced_at,
            syncing,
            promotion_pending: entry.promotion.is_some(),
            promotion: entry
                .promotion
                .as_ref()
                .map(|checkpoint| MirrorPromotionSummary {
                    phase: match checkpoint.phase {
                        MirrorPromotionPhase::Requested => "awaiting_approval",
                        MirrorPromotionPhase::Prepared => "verifying",
                        MirrorPromotionPhase::Registered => "activating",
                    }
                    .to_string(),
                }),
            error,
        })
    }

    pub(super) async fn sync_entry(
        &self,
        entry: MirrorRegistryEntry,
        skip_if_busy: bool,
    ) -> Result<(), ConnectError> {
        let _guard = self.begin_operation(entry.replica_id, skip_if_busy)?;
        let result = async {
            let mirror = self.mirror(&entry).await?;
            mirror.sync().await.map_err(from_mirror)
        }
        .await;
        match &result {
            Ok(()) => {
                self.errors
                    .write()
                    .expect("mirror error lock poisoned")
                    .remove(&entry.replica_id);
            }
            Err(error) => {
                self.errors
                    .write()
                    .expect("mirror error lock poisoned")
                    .insert(entry.replica_id, error.to_string());
            }
        }
        result
    }

    pub(super) fn begin_operation(
        &self,
        replica_id: Uuid,
        skip_if_busy: bool,
    ) -> Result<MirrorOperationGuard<'_>, ConnectError> {
        let mut syncing = self.syncing.lock().expect("mirror sync lock poisoned");
        if !syncing.insert(replica_id) {
            return Err(mirror_error(
                if skip_if_busy {
                    "mirror_sync_skipped"
                } else {
                    "mirror_busy"
                },
                "This mirror is already synchronizing.",
            ));
        }
        Ok(MirrorOperationGuard {
            replica_id,
            syncing: &self.syncing,
        })
    }

    pub(super) async fn mirror(
        &self,
        entry: &MirrorRegistryEntry,
    ) -> Result<DirectoryMirror, ConnectError> {
        let credentials = self.current_credentials(entry).await?;
        self.build_mirror(entry, &credentials.access_token)
    }

    pub(super) fn build_mirror(
        &self,
        entry: &MirrorRegistryEntry,
        access_token: &str,
    ) -> Result<DirectoryMirror, ConnectError> {
        self.validate_mirror_root(entry)?;
        let transport =
            HttpSyncTransport::new(&entry.sync_url, access_token).map_err(from_mirror)?;
        DirectoryMirror::new(
            &entry.path,
            self.replica_state_dir(entry.replica_id).join("state.json"),
            mirror_lock_path(&self.lock_root, &entry.path),
            entry.replica_id,
            entry.mode,
            Arc::new(transport),
        )
        .map_err(from_mirror)
    }

    pub(super) async fn current_credentials(
        &self,
        entry: &MirrorRegistryEntry,
    ) -> Result<MirrorCredentials, ConnectError> {
        let credentials = self.credentials(entry.replica_id)?;
        let expiry =
            chrono::DateTime::parse_from_rfc3339(&entry.access_token_expires_at).map_err(|_| {
                mirror_error(
                    "invalid_mirror_credentials",
                    "Mirror credential expiry is invalid.",
                )
            })?;
        if expiry.timestamp() - chrono::Utc::now().timestamp() >= TOKEN_RENEWAL_WINDOW_SECONDS {
            return Ok(credentials);
        }
        let renewed = self
            .public_json::<PairingExchange>(
                Method::POST,
                &format!(
                    "{}/v1/mirror-pairing-requests/{}/renew",
                    entry.control_url, entry.enrollment_id
                ),
                None,
                Some(&credentials.refresh_token),
            )
            .await?;
        if renewed.replica.id != entry.replica_id
            || renewed.replica.collection_id != entry.collection_id
            || renewed.replica.mode != entry.mode
        {
            return Err(mirror_error(
                "invalid_mirror_renewal",
                "Connect renewed credentials for a different mirror.",
            ));
        }
        let updated = MirrorCredentials {
            access_token: renewed.token,
            refresh_token: credentials.refresh_token,
        };
        self.secrets
            .set_mirror_credentials(entry.replica_id, &serde_json::to_string(&updated)?)?;
        self.update_expiry(entry.replica_id, renewed.token_expires_at)?;
        Ok(updated)
    }

    pub(super) fn credentials(&self, replica_id: Uuid) -> Result<MirrorCredentials, ConnectError> {
        let value = self
            .secrets
            .mirror_credentials(replica_id)?
            .ok_or_else(|| {
                mirror_error(
                    "mirror_credentials_missing",
                    "Mirror credentials are missing from the operating-system credential store.",
                )
            })?;
        serde_json::from_str(&value).map_err(|_| {
            mirror_error(
                "invalid_mirror_credentials",
                "Mirror credentials are corrupt.",
            )
        })
    }

    pub(super) async fn finish_provisioning(
        &self,
        entry: &mut MirrorRegistryEntry,
        credentials: &MirrorCredentials,
    ) -> Result<(), ConnectError> {
        self.validate_mirror_root(entry)?;
        mark_mirror(&entry.path, entry.collection_id).map_err(from_mirror)?;
        self.secrets
            .set_mirror_credentials(entry.replica_id, &serde_json::to_string(credentials)?)?;
        self.sync_entry(entry.clone(), false).await?;
        entry.lifecycle = MirrorLifecycle::Active;
        self.replace_entry(entry.clone())
    }

    pub(super) async fn recover_provisioning(&self) {
        let entries = self.entries();
        for mut entry in entries
            .into_iter()
            .filter(|entry| entry.lifecycle == MirrorLifecycle::Provisioning)
        {
            let recovered = self.credentials(entry.replica_id).and_then(|credentials| {
                mark_mirror(&entry.path, entry.collection_id).map_err(from_mirror)?;
                Ok(credentials)
            });
            match recovered {
                Ok(credentials) => {
                    if self
                        .finish_provisioning(&mut entry, &credentials)
                        .await
                        .is_ok()
                    {
                        continue;
                    }
                }
                Err(error) => tracing::warn!(
                    replica_id = %entry.replica_id,
                    code = error.code(),
                    "incomplete mirror enrollment cannot resume"
                ),
            }
            if let Err(error) = self.revoke_and_remove(&mut entry, false).await {
                tracing::warn!(
                    replica_id = %entry.replica_id,
                    code = error.code(),
                    %error,
                    "incomplete mirror enrollment cleanup will be retried"
                );
            }
        }
    }

    pub(super) async fn recover_removals(&self) {
        for mut entry in self.entries().into_iter().filter(|entry| {
            matches!(
                entry.lifecycle,
                MirrorLifecycle::Revoking | MirrorLifecycle::Removing
            )
        }) {
            if let Err(error) = self.revoke_and_remove(&mut entry, true).await {
                tracing::warn!(
                    replica_id = %entry.replica_id,
                    code = error.code(),
                    %error,
                    "incomplete mirror removal will be retried"
                );
            }
        }
    }

    pub(super) async fn revoke_and_remove(
        &self,
        entry: &mut MirrorRegistryEntry,
        skip_if_busy: bool,
    ) -> Result<(), ConnectError> {
        let _guard = self.begin_operation(entry.replica_id, skip_if_busy)?;
        if !matches!(
            entry.lifecycle,
            MirrorLifecycle::Revoking | MirrorLifecycle::Removing
        ) {
            entry.lifecycle = MirrorLifecycle::Revoking;
            self.replace_entry(entry.clone())?;
        }
        if entry.lifecycle == MirrorLifecycle::Revoking {
            self.revoke_remote(entry.replica_id).await?;
            entry.lifecycle = MirrorLifecycle::Removing;
            self.replace_entry(entry.clone())?;
        }
        self.finish_removal(entry)
    }

    pub(super) fn finish_removal(&self, entry: &MirrorRegistryEntry) -> Result<(), ConnectError> {
        self.validate_mirror_root_if_present(entry)?;
        clear_mirror_marker(&entry.path, entry.collection_id).map_err(from_mirror)?;
        match fs::remove_dir_all(self.replica_state_dir(entry.replica_id)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(ConnectError::Io(error)),
        }
        self.secrets.clear_mirror_credentials(entry.replica_id)?;
        self.remove_entry(entry.replica_id)?;
        self.errors
            .write()
            .expect("mirror error lock poisoned")
            .remove(&entry.replica_id);
        Ok(())
    }

    pub(super) async fn revoke_remote(&self, replica_id: Uuid) -> Result<(), ConnectError> {
        self.cloud()?.revoke_hosted_replica(replica_id).await
    }
}
