use super::*;

impl AgentState {
    pub(super) fn cloud(&self) -> Result<&CloudControlClient, ConnectError> {
        self.cloud.as_ref().ok_or_else(|| {
            ConnectError::Cloud("Connect this computer to a portal first.".to_string())
        })
    }

    pub(super) fn mirror_manager(&self) -> Result<Arc<MirrorManager>, ConnectError> {
        self.mirrors
            .read()
            .expect("mirror manager lock poisoned")
            .clone()
            .ok_or_else(|| ConnectError::Mirror {
                code: "mirror_service_unavailable".to_string(),
                message: "Hosted mirror service is unavailable.".to_string(),
            })
    }

    pub(super) fn configure_account(
        &self,
        params: mdbase_connect_protocol::AccountConfigureParams,
    ) -> Result<serde_json::Value, ConnectError> {
        let _guard = self
            .account_configuration_lock
            .lock()
            .expect("account configuration lock poisoned");
        let state_dir = self.state_dir()?;
        let configuration = CloudConfiguration::new(&params.server_url)?;
        configure_cloud(&state_dir, &configuration, &params.connector_token)?;
        Ok(serde_json::json!({
            "configured": true,
            "server_url": configuration.server_url,
            "restart_required": true
        }))
    }

    pub(super) fn account_configuration(&self) -> Result<serde_json::Value, ConnectError> {
        if let Some(cloud) = &self.cloud {
            return Ok(serde_json::json!({
                "configured": true,
                "server_url": cloud.server_url()
            }));
        }
        let configuration = load_cloud_configuration(&self.state_dir()?)?;
        Ok(match configuration {
            Some(configuration) => serde_json::json!({
                "configured": true,
                "server_url": configuration.server_url
            }),
            None => serde_json::json!({
                "configured": false,
                "server_url": null
            }),
        })
    }

    pub(super) fn clear_account(&self) -> Result<serde_json::Value, ConnectError> {
        let _guard = self
            .account_configuration_lock
            .lock()
            .expect("account configuration lock poisoned");
        let state_dir = self.state_dir()?;
        disconnect_cloud(&state_dir)?;
        Ok(serde_json::json!({
            "configured": false,
            "restart_required": true
        }))
    }

    pub(super) fn state_dir(&self) -> Result<std::path::PathBuf, ConnectError> {
        self.state_dir
            .read()
            .expect("state directory lock poisoned")
            .clone()
            .ok_or_else(|| {
                ConnectError::Settings("Daemon state directory is unavailable.".to_string())
            })
    }

    pub(super) async fn hosted_request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, ConnectError> {
        self.cloud()?.connector_request(method, path, body).await
    }

    pub(super) async fn transfer_authority_to_remote(
        &self,
        collection_id: uuid::Uuid,
    ) -> Result<serde_json::Value, ConnectError> {
        let cloud = self.cloud()?;
        let begun = cloud.begin_remote_authority_transfer(collection_id).await?;
        let transfer_id = begun.transfer.id;
        if begun.transfer.state == "completed" {
            self.registry.retire_authority(
                collection_id,
                transfer_id,
                begun.transfer.authority_epoch,
            )?;
            self.refresh_watchers();
            return serde_json::to_value(begun.transfer).map_err(Into::into);
        }
        let (manifest_digest, source_revision, source_head) = if begun.transfer.state
            == "activating"
        {
            // Activation may already have reached the provider. Cancellation
            // is unsafe from this state, so rebuild the durable fenced snapshot
            // and resume the exact idempotent commit reserved by the server.
            let _ = self.registry.fence_authority(collection_id, transfer_id)?;
            (
                begun.transfer.manifest_digest.clone().ok_or_else(|| {
                    ConnectError::Cloud(
                        "Activating authority transfer has no manifest digest.".to_string(),
                    )
                })?,
                begun.transfer.source_revision.clone().ok_or_else(|| {
                    ConnectError::Cloud(
                        "Activating authority transfer has no source revision.".to_string(),
                    )
                })?,
                begun.transfer.final_head.ok_or_else(|| {
                    ConnectError::Cloud(
                        "Activating authority transfer has no source head.".to_string(),
                    )
                })?,
            )
        } else {
            let capability = begun.import.ok_or_else(|| {
                ConnectError::Cloud(
                    "The remote authority did not issue an import capability.".to_string(),
                )
            })?;
            let staged = match self.registry.authority_snapshot(collection_id) {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    let _ = cloud.cancel_remote_authority_transfer(transfer_id).await;
                    return Err(error);
                }
            };
            let collection_root = std::path::PathBuf::from(self.registry.get(collection_id)?.path);
            if let Err(error) = cloud
                .upload_authority_snapshot(&capability, &staged, &collection_root)
                .await
            {
                let _ = cloud.cancel_remote_authority_transfer(transfer_id).await;
                return Err(error);
            }
            let fenced = match self.registry.fence_authority(collection_id, transfer_id) {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    let _ = cloud.cancel_remote_authority_transfer(transfer_id).await;
                    return Err(error);
                }
            };
            if fenced.source_revision != staged.source_revision
                || fenced.manifest_digest != staged.manifest_digest
                || fenced.source_head != staged.source_head
            {
                if let Err(error) = cloud
                    .upload_authority_snapshot(&capability, &fenced, &collection_root)
                    .await
                {
                    return self
                        .cancel_fenced_transfer(cloud, collection_id, transfer_id, error)
                        .await;
                }
            }
            (
                fenced.manifest_digest,
                fenced.source_revision,
                fenced.source_head,
            )
        };
        let mut completed = None;
        let mut last_error = None;
        for attempt in 0..3 {
            match cloud
                .complete_remote_authority_transfer(
                    transfer_id,
                    &manifest_digest,
                    &source_revision,
                    source_head,
                )
                .await
            {
                Ok(result) => {
                    completed = Some(result);
                    break;
                }
                Err(error) => {
                    last_error = Some(error);
                    if attempt < 2 {
                        // A lost completion response is outcome-uncertain.
                        // Retry the idempotent CAS, but never reopen the source
                        // automatically after attempting activation.
                        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    }
                }
            }
        }
        let completed = completed.ok_or_else(|| {
            ConnectError::Cloud(format!(
                "Authority activation is outcome-uncertain and the local source remains fenced. Retry the transfer command: {}",
                last_error.expect("a failed activation attempt records its error")
            ))
        })?;
        if completed.status != "completed"
            || completed.collection_id != collection_id
            || completed.authority_epoch != begun.transfer.authority_epoch
        {
            return Err(ConnectError::Cloud(
                "Remote authority activation returned an inconsistent result; the local source remains fenced."
                    .to_string(),
            ));
        }
        self.registry
            .retire_authority(collection_id, transfer_id, completed.authority_epoch)?;
        self.refresh_watchers();
        serde_json::to_value(completed).map_err(Into::into)
    }

    pub(super) async fn cancel_fenced_transfer(
        &self,
        cloud: &CloudControlClient,
        collection_id: uuid::Uuid,
        transfer_id: uuid::Uuid,
        cause: ConnectError,
    ) -> Result<serde_json::Value, ConnectError> {
        match cloud.cancel_remote_authority_transfer(transfer_id).await {
            Ok(()) => {
                self.registry.resume_authority(collection_id, transfer_id)?;
                Err(cause)
            }
            Err(cancel_error) => Err(ConnectError::Cloud(format!(
                "Authority import failed and cancellation could not be confirmed. The local source remains fenced: {cause}; cancellation: {cancel_error}"
            ))),
        }
    }

    pub(super) async fn approve_authorization(
        &self,
        params: &mdbase_connect_protocol::AuthorizationApproveParams,
    ) -> Result<serde_json::Value, ConnectError> {
        let cloud = self.cloud()?;
        let snapshot = cloud.snapshot().await?;
        let pending = snapshot
            .pending_authorizations
            .iter()
            .find(|pending| pending.id == params.request_id)
            .ok_or_else(|| {
                ConnectError::Cloud("The authorization request is no longer available.".to_string())
            })?;
        let description = self.registry.describe(params.collection_id)?;
        if let Some(operation) = params
            .operations
            .iter()
            .find(|operation| !description.operations.contains(operation))
        {
            return Err(ConnectError::AccessDenied(format!(
                "{} does not support the requested {operation} operation.",
                description.display_name
            )));
        }
        let contracts = self
            .ensure_application_types(
                params.collection_id,
                &pending.application_family_identity,
                &pending.application_manifest_digest,
                &pending.requirements,
                &pending.provisions,
                &params.contract_setups,
            )
            .await?;
        cloud.approve_authorization(params, &contracts).await
    }

    pub(super) async fn create_grant(
        &self,
        params: &mdbase_connect_protocol::GrantCreateParams,
    ) -> Result<serde_json::Value, ConnectError> {
        let cloud = self.cloud()?;
        let application = cloud.application(params.application_id).await?;
        let contracts = self
            .ensure_application_types(
                params.collection_id,
                &application.family_identity,
                &application.manifest_digest,
                &application.requirements,
                &application.provisions,
                &[],
            )
            .await?;
        cloud.create_grant(params, &contracts).await
    }

    pub(super) async fn ensure_application_types(
        &self,
        collection_id: uuid::Uuid,
        application_family_identity: &str,
        application_manifest_digest: &str,
        requirements: &mdbase_connect_protocol::ApplicationRequirements,
        provisions: &mdbase_connect_protocol::ApplicationProvisions,
        contract_setups: &[ContractSetupChoice],
    ) -> Result<Vec<mdbase_connect_protocol::CollectionContractDescriptor>, ConnectError> {
        let registered = self.registry.get(collection_id)?;
        if !registered.enabled {
            return Err(ConnectError::AccessDenied(
                "This collection is disabled on its computer.".to_string(),
            ));
        }
        let setup = self.registry.provision_application_setup(
            collection_id,
            declaration_id_from_family_identity(application_family_identity)?,
            &engine_declaration_digest(application_manifest_digest)?,
            requirements,
            provisions,
            contract_setups,
        )?;
        self.watcher.rescan(collection_id);
        let mut collection = self.registry.get(collection_id)?;
        collection.contracts = setup.contracts;
        Ok(collection.contracts)
    }

    pub(super) async fn access_snapshot(&self) -> Result<serde_json::Value, ConnectError> {
        let Some(cloud) = &self.cloud else {
            return serde_json::to_value(mdbase_connect_protocol::AccessSnapshot {
                configured: false,
                online: false,
                account: None,
                grants: self.registry.list_grants()?,
                pending_authorizations: Vec::new(),
                authority_conflicts: Vec::new(),
            })
            .map_err(ConnectError::from);
        };
        let mut snapshot = match cloud.snapshot().await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                tracing::debug!(%error, "cloud control snapshot unavailable; using local cache");
                mdbase_connect_protocol::AccessSnapshot {
                    configured: true,
                    online: false,
                    account: None,
                    grants: self.registry.list_grants()?,
                    pending_authorizations: Vec::new(),
                    authority_conflicts: Vec::new(),
                }
            }
        };
        let collections = self.registry.list()?;
        for pending in &mut snapshot.pending_authorizations {
            pending.compatible_collection_ids = collections
                .iter()
                .filter(|collection| collection.enabled)
                .filter_map(|collection| {
                    let supports_operations =
                        self.registry
                            .describe(collection.id)
                            .is_ok_and(|description| {
                                pending
                                    .requested_operations
                                    .iter()
                                    .all(|operation| description.operations.contains(operation))
                            });
                    supports_operations
                        .then(|| {
                            self.registry
                                .is_compatible(collection.id, &pending.requirements)
                        })
                        .transpose()
                        .ok()
                        .flatten()
                        .filter(|compatible| *compatible)
                        .map(|_| collection.id)
                })
                .collect();
            pending.provisionable_collection_ids = collections
                .iter()
                .filter(|collection| collection.enabled)
                .filter(|collection| !pending.compatible_collection_ids.contains(&collection.id))
                .filter(|collection| {
                    self.registry
                        .describe(collection.id)
                        .is_ok_and(|description| {
                            description
                                .operations
                                .iter()
                                .any(|operation| operation == "create_type")
                                && pending
                                    .requested_operations
                                    .iter()
                                    .all(|operation| description.operations.contains(operation))
                        })
                })
                .filter(|collection| {
                    requirements_can_be_provisioned(
                        &pending.requirements,
                        &pending.provisions,
                        &collection.contracts,
                    )
                })
                .map(|collection| collection.id)
                .collect();
            pending.collection_types = pending
                .provisionable_collection_ids
                .iter()
                .filter_map(|collection_id| {
                    let description = self.registry.describe(*collection_id).ok()?;
                    Some(AuthorizationCollectionTypes {
                        collection_id: *collection_id,
                        types: description
                            .types
                            .into_iter()
                            .filter_map(approval_type_candidate)
                            .collect(),
                    })
                })
                .collect();
        }
        serde_json::to_value(snapshot).map_err(ConnectError::from)
    }
}

pub(super) fn declaration_id_from_family_identity(
    family_identity: &str,
) -> Result<&str, ConnectError> {
    family_identity
        .strip_prefix("bundle:")
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            ConnectError::InvalidInput(
                "The registered application has no valid declaration identity.".to_string(),
            )
        })
}

pub(super) fn engine_declaration_digest(manifest_digest: &str) -> Result<String, ConnectError> {
    if manifest_digest.len() != 64
        || !manifest_digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(ConnectError::InvalidInput(
            "The registered application manifest digest is invalid.".to_string(),
        ));
    }
    Ok(format!("sha256:{manifest_digest}"))
}
