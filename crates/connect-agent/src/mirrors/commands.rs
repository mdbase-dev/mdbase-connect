use super::*;

impl MirrorManager {
    pub async fn list(&self) -> Result<Vec<MirrorSummary>, ConnectError> {
        let entries = self.entries();
        let mut summaries = Vec::with_capacity(entries.len());
        for entry in entries {
            summaries.push(self.summary(&entry)?);
        }
        summaries.sort_by(|left, right| {
            left.name
                .to_lowercase()
                .cmp(&right.name.to_lowercase())
                .then_with(|| left.replica_id.cmp(&right.replica_id))
        });
        Ok(summaries)
    }

    pub async fn add(&self, params: MirrorAddParams) -> Result<MirrorSummary, ConnectError> {
        validate_selective_sync_policy(&params.selective_sync).map_err(from_mirror)?;
        let cloud = self.cloud()?;
        let selected = PathBuf::from(&params.path);
        fs::create_dir_all(&selected)?;
        let path = fs::canonicalize(&selected)?;
        if !path.is_dir() {
            return Err(mirror_error(
                "invalid_mirror_path",
                "Mirror path must be a directory.",
            ));
        }
        self.ensure_path_available(&path, params.collection_id)?;
        let name = params
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{} mirror", computer_name()));
        if name.chars().count() > 200 {
            return Err(mirror_error(
                "invalid_mirror_name",
                "Mirror name must contain between 1 and 200 characters.",
            ));
        }
        let begin = self
            .public_json::<PairingBegin>(
                Method::POST,
                &format!("{}/v1/mirror-pairing-requests", cloud.server_url()),
                Some(serde_json::json!({
                    "mirror_name": name,
                    "mode": params.mode,
                    "collection_id": params.collection_id
                })),
                None,
            )
            .await?;
        if !valid_pairing_secret(&begin.pairing_secret) {
            return Err(mirror_error(
                "invalid_mirror_enrollment",
                "Connect returned an invalid mirror enrollment credential.",
            ));
        }
        cloud
            .connector_request::<Value>(
                Method::POST,
                &format!(
                    "/v1/connectors/mirror-pairing-requests/{}/approve",
                    begin.pairing_id
                ),
                Some(serde_json::json!({"collection_id": params.collection_id})),
            )
            .await?;
        let exchange = self
            .public_json::<PairingExchange>(
                Method::POST,
                &format!(
                    "{}/v1/mirror-pairing-requests/{}/exchange",
                    cloud.server_url(),
                    begin.pairing_id
                ),
                None,
                Some(&begin.pairing_secret),
            )
            .await?;
        if exchange.status != "paired"
            || exchange.replica.collection_id != params.collection_id
            || exchange.replica.mode != params.mode
            || exchange.replica.name != name
        {
            return Err(mirror_error(
                "invalid_mirror_enrollment",
                "Connect returned mirror details that do not match the request.",
            ));
        }
        let mut entry = MirrorRegistryEntry {
            collection_id: exchange.replica.collection_id,
            replica_id: exchange.replica.id,
            name: exchange.replica.name,
            mode: exchange.replica.mode,
            selective_sync: params.selective_sync,
            path,
            sync_url: exchange.sync_url,
            control_url: cloud.server_url().to_string(),
            enrollment_id: begin.pairing_id,
            access_token_expires_at: exchange.token_expires_at,
            created_at: chrono::Utc::now().to_rfc3339(),
            lifecycle: MirrorLifecycle::Provisioning,
            promotion: None,
        };
        let credentials = MirrorCredentials {
            access_token: exchange.token,
            refresh_token: begin.pairing_secret,
        };
        self.insert_entry(entry.clone())?;
        let provisioned = self
            .finish_provisioning(&mut entry, &credentials)
            .await
            .and_then(|_| self.summary(&entry));
        if let Err(error) = &provisioned {
            tracing::warn!(
                replica_id = %entry.replica_id,
                code = error.code(),
                "rolling back incomplete mirror enrollment"
            );
            if let Err(cleanup_error) = self.revoke_and_remove(&mut entry, false).await {
                tracing::warn!(
                    replica_id = %entry.replica_id,
                    code = cleanup_error.code(),
                    error = %cleanup_error,
                    "incomplete mirror enrollment cleanup will resume"
                );
            }
        }
        provisioned
    }

    pub async fn sync(&self, params: MirrorIdParams) -> Result<MirrorSummary, ConnectError> {
        let entry = self.entry(params.replica_id)?;
        self.require_active(&entry)?;
        if entry.promotion.is_some() {
            return Err(mirror_error(
                "mirror_promotion_in_progress",
                "This mirror is fenced for an authority transfer.",
            ));
        }
        self.sync_entry(entry.clone(), false).await?;
        self.summary(&entry)
    }

    pub async fn configure_selective_sync(
        &self,
        params: MirrorConfigureSelectiveSyncParams,
    ) -> Result<MirrorSummary, ConnectError> {
        validate_selective_sync_policy(&params.selective_sync).map_err(from_mirror)?;
        let mut entry = self.entry(params.replica_id)?;
        self.require_active(&entry)?;
        if entry.promotion.is_some() {
            return Err(mirror_error(
                "mirror_promotion_in_progress",
                "Selective sync settings cannot change during an authority transfer.",
            ));
        }
        if entry.selective_sync == params.selective_sync {
            return self.summary(&entry);
        }
        entry.selective_sync = params.selective_sync;
        self.replace_entry(entry.clone())?;
        // The device-local preference is durable even when the authority is
        // temporarily offline. The background reconciler will retry the same
        // projection; the summary exposes any immediate synchronization error.
        let _ = self.sync_entry(entry.clone(), false).await;
        self.summary(&entry)
    }

    pub async fn resolve(
        &self,
        params: MirrorResolveParams,
    ) -> Result<MirrorSummary, ConnectError> {
        let entry = self.entry(params.replica_id)?;
        self.require_active(&entry)?;
        if entry.promotion.is_some() {
            return Err(mirror_error(
                "mirror_promotion_in_progress",
                "Resolve mirror conflicts before beginning an authority transfer.",
            ));
        }
        let _guard = self.begin_operation(entry.replica_id, false)?;
        let mirror = self.mirror(&entry).await?;
        mirror
            .resolve_conflict(params.record_id, params.resolution)
            .await
            .map_err(from_mirror)?;
        drop(_guard);
        self.sync_entry(entry.clone(), false).await?;
        self.summary(&entry)
    }

    pub async fn remove(&self, params: MirrorIdParams) -> Result<Value, ConnectError> {
        let mut entry = self.entry(params.replica_id)?;
        self.revoke_and_remove(&mut entry, false).await?;
        Ok(serde_json::json!({
            "removed": true,
            "path": entry.path
        }))
    }

    pub async fn begin_promotion(&self, params: MirrorIdParams) -> Result<Value, ConnectError> {
        let mut entry = self.entry(params.replica_id)?;
        self.require_active(&entry)?;
        if entry.mode != SyncReplicaMode::ReadWrite {
            return Err(mirror_error(
                "promotion_requires_writable_mirror",
                "Only a two-way full collection mirror can become the local authority.",
            ));
        }
        if let Some(checkpoint) = &entry.promotion {
            return Ok(serde_json::json!({
                "verification_uri": checkpoint.verification_uri,
                "expires_at": checkpoint.expires_at,
                "resumed": true
            }));
        }
        // Promotion is a state transition, not a best-effort sync command.
        // Wait for any background pass, then hold the same operation fence
        // through the final sync and durable promotion checkpoint so another
        // pass cannot race the authority handoff.
        let _guard = self.begin_operation_waiting(entry.replica_id).await?;
        self.sync_entry_exclusive(entry.clone()).await?;
        self.build_mirror(&entry, "promotion-manifest-does-not-use-a-credential")?
            .authority_promotion_manifest()
            .map_err(from_mirror)?;
        let credentials = self.current_credentials(&entry).await?;
        let response = self
            .public_json::<AuthorityTransferResponse>(
                Method::POST,
                &format!(
                    "{}/v1/mirror-pairing-requests/{}/authority-transfers",
                    entry.control_url, entry.enrollment_id
                ),
                Some(serde_json::json!({})),
                Some(&credentials.refresh_token),
            )
            .await?;
        validate_transfer(&response.transfer, &entry, None)?;
        let verification_uri = trusted_control_url(
            &entry.control_url,
            response
                .verification_uri
                .as_deref()
                .unwrap_or(&response.transfer.verification_uri),
        )?;
        let expires_at = response.transfer.expires_at.clone();
        entry.promotion = Some(MirrorPromotionCheckpoint {
            transfer_id: response.transfer.id,
            expires_at: expires_at.clone(),
            verification_uri: verification_uri.clone(),
            phase: MirrorPromotionPhase::Requested,
            final_head: None,
            authority_epoch: None,
            manifest_digest: None,
            identity_was_present: collection_identity(&entry.path)?.is_some(),
            registration_was_present: self
                .registry
                .list()?
                .iter()
                .any(|collection| collection.id == entry.collection_id),
        });
        self.replace_entry(entry.clone())?;
        Ok(serde_json::json!({
            "verification_uri": verification_uri,
            "expires_at": expires_at,
            "resumed": false
        }))
    }

    pub async fn complete_promotion(&self, params: MirrorIdParams) -> Result<Value, ConnectError> {
        let mut entry = self.entry(params.replica_id)?;
        let _guard = self.begin_operation(entry.replica_id, false)?;
        let mut checkpoint = entry.promotion.clone().ok_or_else(|| {
            mirror_error(
                "promotion_not_started",
                "Begin and approve this authority transfer first.",
            )
        })?;
        if entry.lifecycle == MirrorLifecycle::Removing {
            let authority_epoch = checkpoint.authority_epoch.ok_or_else(|| {
                mirror_error(
                    "invalid_authority_transfer",
                    "Completed authority transfer has no epoch.",
                )
            })?;
            self.finish_removal(&entry)?;
            return Ok(serde_json::json!({
                "collection_id": entry.collection_id,
                "authority_epoch": authority_epoch,
                "path": entry.path
            }));
        }
        self.require_active(&entry)?;
        let credentials = if checkpoint.phase == MirrorPromotionPhase::Registered {
            self.credentials(entry.replica_id)?
        } else {
            self.current_credentials(&entry).await?
        };

        if checkpoint.phase == MirrorPromotionPhase::Requested {
            let prepared = match self
                .wait_for_prepared_transfer(&entry, &checkpoint, &credentials.refresh_token)
                .await
            {
                Ok(prepared) => prepared,
                Err(error) if error.code() == "authority_transfer_expired" => {
                    entry.promotion = None;
                    self.replace_entry(entry)?;
                    return Err(error);
                }
                Err(error) => return Err(error),
            };
            checkpoint.phase = MirrorPromotionPhase::Prepared;
            checkpoint.final_head = prepared.final_head;
            checkpoint.authority_epoch = prepared.authority_epoch;
            checkpoint.manifest_digest = prepared.manifest_digest;
            entry.promotion = Some(checkpoint.clone());
            self.replace_entry(entry.clone())?;
        }

        if checkpoint.phase == MirrorPromotionPhase::Prepared {
            let mirror = self.build_mirror(&entry, &credentials.access_token)?;
            mirror.sync().await.map_err(from_mirror)?;
            let manifest = mirror.authority_promotion_manifest().map_err(from_mirror)?;
            if Some(manifest.cursor) != checkpoint.final_head
                || Some(manifest.digest.as_str()) != checkpoint.manifest_digest.as_deref()
            {
                return Err(mirror_error(
                    "promotion_manifest_mismatch",
                    "The local folder does not exactly match the fenced hosted authority.",
                ));
            }
            let activated = self
                .registry
                .activate_mirror_authority(&entry.path, entry.collection_id);
            if let Err(error) = activated {
                if let Err(rollback_error) = self.registry.rollback_mirror_authority(
                    &entry.path,
                    entry.collection_id,
                    checkpoint.identity_was_present,
                    checkpoint.registration_was_present,
                ) {
                    return Err(mirror_error(
                        "promotion_rollback_failed",
                        &format!(
                            "Authority activation failed ({error}) and local rollback needs repair: {rollback_error}"
                        ),
                    ));
                }
                let _ = self
                    .cancel_promotion(&entry, checkpoint.transfer_id, &credentials.refresh_token)
                    .await;
                entry.promotion = None;
                let _ = self.replace_entry(entry.clone());
                return Err(error);
            }
            if let Err(error) = self.registry.validate(entry.collection_id) {
                if let Err(rollback_error) = self.registry.rollback_mirror_authority(
                    &entry.path,
                    entry.collection_id,
                    checkpoint.identity_was_present,
                    checkpoint.registration_was_present,
                ) {
                    return Err(mirror_error(
                        "promotion_rollback_failed",
                        &format!(
                            "Promoted collection validation failed ({error}) and local rollback needs repair: {rollback_error}"
                        ),
                    ));
                }
                let _ = self
                    .cancel_promotion(&entry, checkpoint.transfer_id, &credentials.refresh_token)
                    .await;
                entry.promotion = None;
                let _ = self.replace_entry(entry.clone());
                return Err(error);
            }
            checkpoint.phase = MirrorPromotionPhase::Registered;
            entry.promotion = Some(checkpoint.clone());
            self.replace_entry(entry.clone())?;
        }

        let completed = self
            .wait_for_completed_transfer(&entry, &checkpoint, &credentials.refresh_token)
            .await;
        let completed = match completed {
            Ok(completed) => completed,
            Err(error) if error.code() == "authority_transfer_expired" => {
                self.registry.rollback_mirror_authority(
                    &entry.path,
                    entry.collection_id,
                    checkpoint.identity_was_present,
                    checkpoint.registration_was_present,
                )?;
                entry.promotion = None;
                self.replace_entry(entry)?;
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        let authority_epoch = checkpoint.authority_epoch.ok_or_else(|| {
            mirror_error(
                "invalid_authority_transfer",
                "Prepared authority transfer has no epoch.",
            )
        })?;
        if completed.status != "completed"
            || completed.collection_id != Some(entry.collection_id)
            || completed.authority_epoch != Some(authority_epoch)
        {
            return Err(mirror_error(
                "invalid_authority_transfer",
                "Completed authority transfer does not match this mirror.",
            ));
        }
        entry.lifecycle = MirrorLifecycle::Removing;
        self.replace_entry(entry.clone())?;
        self.finish_removal(&entry)?;
        Ok(serde_json::json!({
            "collection_id": entry.collection_id,
            "authority_epoch": authority_epoch,
            "path": entry.path
        }))
    }
}
