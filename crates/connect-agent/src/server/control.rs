use super::*;

impl AgentState {
    pub(super) async fn execute(&self, request: ControlRequest) -> ControlResponse {
        let id = request.id;
        if request.protocol_version != LOCAL_CONTROL_PROTOCOL_VERSION {
            return ControlResponse::failure(
                id,
                "unsupported_local_protocol",
                format!(
                    "Local control protocol {} is not supported; expected {}.",
                    request.protocol_version, LOCAL_CONTROL_PROTOCOL_VERSION
                ),
            );
        }
        let result = match request.command {
            ControlCommand::Ping => Ok(serde_json::json!({
                "pong": true,
                "ready": self.initialized(),
            })),
            ControlCommand::Status => self.registry.count().map(|registered_collections| {
                serde_json::to_value(AgentStatus {
                    protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
                    binary_version: env!("CARGO_PKG_VERSION").to_string(),
                    state: self
                        .connection_state
                        .read()
                        .expect("connection state lock poisoned")
                        .clone(),
                    registered_collections,
                    paused: self.registry.paused().unwrap_or(true),
                    direct_access_available: self
                        .loopback_port
                        .load(std::sync::atomic::Ordering::Acquire)
                        != 0,
                    loopback_port: match self
                        .loopback_port
                        .load(std::sync::atomic::Ordering::Acquire)
                    {
                        0 => None,
                        port => Some(port),
                    },
                })
                .expect("agent status must serialize")
            }),
            ControlCommand::DaemonShutdown => Ok(serde_json::json!({"stopping": true})),
            ControlCommand::CollectionList => self
                .registry
                .list()
                .and_then(|value| serde_json::to_value(value).map_err(ConnectError::from)),
            ControlCommand::CollectionAdd(params) => {
                let result = self.registry.add(params.path);
                if result.is_ok() {
                    self.refresh_watchers();
                }
                result.and_then(|value| serde_json::to_value(value).map_err(ConnectError::from))
            }
            ControlCommand::CollectionAddCopy(params) => {
                let result = self.registry.add_copy(params.path);
                if result.is_ok() {
                    self.refresh_watchers();
                }
                result.and_then(|value| serde_json::to_value(value).map_err(ConnectError::from))
            }
            ControlCommand::CollectionMakeIndependent(params) => {
                let result = self.registry.make_independent(params.collection_id);
                if result.is_ok() {
                    self.refresh_watchers();
                }
                result.and_then(|value| serde_json::to_value(value).map_err(ConnectError::from))
            }
            ControlCommand::CollectionTakeAuthority(params) => match self.cloud() {
                Ok(cloud) => cloud.take_collection_authority(params.collection_id).await,
                Err(error) => Err(error),
            },
            ControlCommand::CollectionTransferAuthority(params) => match params.target {
                AuthorityTarget::Remote => {
                    self.transfer_authority_to_remote(params.collection_id)
                        .await
                }
            },
            ControlCommand::CollectionCreate(params) => {
                let result = self.registry.create(params.path, params.name.as_deref());
                if result.is_ok() {
                    self.refresh_watchers();
                }
                result.and_then(|value| serde_json::to_value(value).map_err(ConnectError::from))
            }
            ControlCommand::CollectionUpdateMetadata(params) => {
                let result = self.registry.update_metadata(
                    params.collection_id,
                    &params.name,
                    params.description.as_deref(),
                );
                if result.is_ok() {
                    self.watcher.rescan(params.collection_id);
                }
                result.and_then(|value| serde_json::to_value(value).map_err(ConnectError::from))
            }
            ControlCommand::CollectionSetEnabled(params) => {
                let result = self
                    .registry
                    .set_enabled(params.collection_id, params.enabled);
                if result.is_ok() {
                    self.refresh_watchers();
                }
                result.and_then(|value| serde_json::to_value(value).map_err(ConnectError::from))
            }
            ControlCommand::CollectionRemove(params) => {
                let result = self.registry.remove(params.collection_id);
                if result.is_ok() {
                    self.refresh_watchers();
                }
                result.and_then(|value| serde_json::to_value(value).map_err(ConnectError::from))
            }
            ControlCommand::CollectionValidate(params) => {
                self.registry.validate(params.collection_id)
            }
            ControlCommand::CollectionOperation(params) => {
                self.local_operation(params.collection_id, &params.operation, &params.input)
            }
            ControlCommand::AccessSnapshot => self.access_snapshot().await,
            ControlCommand::AccessPause(params) => self
                .registry
                .set_paused(params.paused)
                .map(|_| serde_json::json!({ "paused": params.paused })),
            ControlCommand::AccountRenameComputer(params) => match self.cloud() {
                Ok(cloud) => cloud.rename_computer(&params).await,
                Err(error) => Err(error),
            },
            ControlCommand::AccountConfigure(params) => self.configure_account(params),
            ControlCommand::AccountConfiguration => self.account_configuration(),
            ControlCommand::AccountClear => self.clear_account(),
            ControlCommand::GrantCreate(params) => self.create_grant(&params).await,
            ControlCommand::GrantUpdate(params) => match self.cloud() {
                Ok(cloud) => cloud.update_grant(&params).await,
                Err(error) => Err(error),
            },
            ControlCommand::GrantRevoke(params) => match self.cloud() {
                Ok(cloud) => {
                    let result = cloud.revoke_grant(&params).await;
                    result
                }
                Err(error) => Err(error),
            },
            ControlCommand::AuthorizationApprove(params) => {
                self.approve_authorization(&params).await
            }
            ControlCommand::AuthorizationDeny(params) => match self.cloud() {
                Ok(cloud) => cloud.deny_authorization(&params).await,
                Err(error) => Err(error),
            },
            ControlCommand::ActivityList(params) => self
                .registry
                .list_activity(params.limit)
                .and_then(|value| serde_json::to_value(value).map_err(ConnectError::from)),
            ControlCommand::HostedSnapshot => {
                self.hosted_request(reqwest::Method::GET, "/v1/connectors/hosted-control", None)
                    .await
            }
            ControlCommand::HostedCollectionCreate(params) => {
                match validated_hosted_name(&params.name) {
                    Ok(name) => {
                        self.hosted_request(
                            reqwest::Method::POST,
                            "/v1/connectors/hosted/collections",
                            Some(serde_json::json!({
                                "display_name": name,
                                "template": "mdbase"
                            })),
                        )
                        .await
                    }
                    Err(error) => Err(error),
                }
            }
            ControlCommand::HostedCollectionRename(params) => {
                match validated_hosted_name(&params.name) {
                    Ok(name) => {
                        self.hosted_request(
                            reqwest::Method::PATCH,
                            &format!("/v1/connectors/hosted/collections/{}", params.collection_id),
                            Some(serde_json::json!({ "display_name": name })),
                        )
                        .await
                    }
                    Err(error) => Err(error),
                }
            }
            ControlCommand::HostedCollectionDelete(params) => {
                self.hosted_request(
                    reqwest::Method::DELETE,
                    &format!("/v1/connectors/hosted/collections/{}", params.collection_id),
                    None,
                )
                .await
            }
            ControlCommand::HostedAuthorizationApprove(params) => {
                self.hosted_request(
                    reqwest::Method::POST,
                    &format!(
                        "/v1/connectors/hosted/authorization-requests/{}/approve",
                        params.request_id
                    ),
                    Some(serde_json::json!({
                        "collection_id": params.collection_id,
                        "operations": params.operations
                    })),
                )
                .await
            }
            ControlCommand::HostedGrantUpdate(params) => {
                self.hosted_request(
                    reqwest::Method::PATCH,
                    &format!("/v1/connectors/hosted/grants/{}", params.grant_id),
                    Some(serde_json::json!({ "operations": params.operations })),
                )
                .await
            }
            ControlCommand::HostedGrantRevoke(params) => {
                self.hosted_request(
                    reqwest::Method::DELETE,
                    &format!("/v1/connectors/hosted/grants/{}", params.grant_id),
                    None,
                )
                .await
            }
            ControlCommand::HostedReplicaRevoke(params) => {
                self.hosted_request(
                    reqwest::Method::DELETE,
                    &format!("/v1/connectors/hosted/replicas/{}", params.replica_id),
                    None,
                )
                .await
            }
            ControlCommand::MirrorList => match self.mirror_manager() {
                Ok(mirrors) => mirrors
                    .list()
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(ConnectError::from)),
                Err(error) => Err(error),
            },
            ControlCommand::MirrorAdd(params) => match self.mirror_manager() {
                Ok(mirrors) => mirrors
                    .add(params)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(ConnectError::from)),
                Err(error) => Err(error),
            },
            ControlCommand::MirrorSync(params) => match self.mirror_manager() {
                Ok(mirrors) => mirrors
                    .sync(params)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(ConnectError::from)),
                Err(error) => Err(error),
            },
            ControlCommand::MirrorConfigureSelectiveSync(params) => match self.mirror_manager() {
                Ok(mirrors) => mirrors
                    .configure_selective_sync(params)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(ConnectError::from)),
                Err(error) => Err(error),
            },
            ControlCommand::MirrorRemove(params) => match self.mirror_manager() {
                Ok(mirrors) => mirrors.remove(params).await,
                Err(error) => Err(error),
            },
            ControlCommand::MirrorResolve(params) => match self.mirror_manager() {
                Ok(mirrors) => mirrors
                    .resolve(params)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(ConnectError::from)),
                Err(error) => Err(error),
            },
            ControlCommand::MirrorPromoteBegin(params) => match self.mirror_manager() {
                Ok(mirrors) => mirrors.begin_promotion(params).await,
                Err(error) => Err(error),
            },
            ControlCommand::MirrorPromoteComplete(params) => match self.mirror_manager() {
                Ok(mirrors) => {
                    let result = mirrors.complete_promotion(params).await;
                    if result.is_ok() {
                        self.refresh_watchers();
                    }
                    result
                }
                Err(error) => Err(error),
            },
        };

        match result {
            Ok(result) => ControlResponse::success(id, result),
            Err(error) => ControlResponse::failure(id, error.code(), error.to_string()),
        }
    }
}
