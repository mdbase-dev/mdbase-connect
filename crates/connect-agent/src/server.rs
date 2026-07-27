use crate::cloud::CloudControlClient;
use crate::mirrors::MirrorManager;
use crate::runtime_notifications::RuntimeTimerHandle;
use crate::watcher::CollectionWatchService;
use mdbase_connect_core::{
    configure_cloud, disconnect_cloud, encrypted_request_fingerprint, load_cloud_configuration,
    CloudConfiguration, CollectionRegistry, ConnectError, EncryptedRequestClaim, LocalReplica,
};
use mdbase_connect_protocol::crypto::{
    parse_counter, validate_envelope, RelayBinding, RelayDirection, RelayIdentity, RelayMetadata,
};
use mdbase_connect_protocol::{
    AgentConnectionState, AgentStatus, ApplicationAccess, ApplicationRequirements, AuthorityTarget,
    AuthorizationCollectionOffer, ContractRequirement, ControlCommand, ControlError,
    ControlRequest, ControlResponse, GrantScope, RelayMessage, SyncReplicaMode,
    CONTROL_PROTOCOL_VERSION, ENCRYPTED_RELAY_PROTOCOL_VERSION, LOCAL_CONTROL_PROTOCOL_VERSION,
};
use std::io;
use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

const MAX_LOCAL_CONTROL_REQUEST_BYTES: u64 = 8 * 1024 * 1024;

pub struct AgentState {
    registry: CollectionRegistry,
    watcher: CollectionWatchService,
    connection_state: std::sync::RwLock<AgentConnectionState>,
    initialized: std::sync::atomic::AtomicBool,
    loopback_port: std::sync::atomic::AtomicU16,
    cloud: Option<CloudControlClient>,
    relay_identity: RelayIdentity,
    runtime_timers: Option<RuntimeTimerHandle>,
    mirrors: std::sync::RwLock<Option<Arc<MirrorManager>>>,
    shutdown: tokio::sync::Notify,
    state_dir: std::sync::RwLock<Option<std::path::PathBuf>>,
    account_configuration_lock: std::sync::Mutex<()>,
}

impl AgentState {
    #[cfg(test)]
    pub fn new(
        registry: CollectionRegistry,
        watcher: CollectionWatchService,
        cloud: Option<CloudControlClient>,
    ) -> Self {
        Self::with_identity(registry, watcher, cloud, RelayIdentity::generate())
    }

    pub fn with_identity(
        registry: CollectionRegistry,
        watcher: CollectionWatchService,
        cloud: Option<CloudControlClient>,
        relay_identity: RelayIdentity,
    ) -> Self {
        Self {
            registry,
            watcher,
            connection_state: std::sync::RwLock::new(AgentConnectionState::LocalOnly),
            initialized: std::sync::atomic::AtomicBool::new(false),
            loopback_port: std::sync::atomic::AtomicU16::new(0),
            cloud,
            relay_identity,
            runtime_timers: None,
            mirrors: std::sync::RwLock::new(None),
            shutdown: tokio::sync::Notify::new(),
            state_dir: std::sync::RwLock::new(None),
            account_configuration_lock: std::sync::Mutex::new(()),
        }
    }

    pub fn with_identity_and_timers(
        registry: CollectionRegistry,
        watcher: CollectionWatchService,
        cloud: Option<CloudControlClient>,
        relay_identity: RelayIdentity,
        runtime_timers: RuntimeTimerHandle,
    ) -> Self {
        let mut state = Self::with_identity(registry, watcher, cloud, relay_identity);
        state.runtime_timers = Some(runtime_timers);
        state
    }

    pub fn relay_public_key(&self) -> String {
        self.relay_identity.public_key()
    }

    pub fn mark_initialized(&self) {
        self.initialized
            .store(true, std::sync::atomic::Ordering::Release);
    }

    pub fn set_loopback_port(&self, port: u16) {
        self.loopback_port
            .store(port, std::sync::atomic::Ordering::Release);
    }

    pub fn set_mirror_manager(&self, mirrors: Arc<MirrorManager>) {
        *self.mirrors.write().expect("mirror manager lock poisoned") = Some(mirrors);
    }

    pub fn set_state_dir(&self, state_dir: std::path::PathBuf) {
        *self
            .state_dir
            .write()
            .expect("state directory lock poisoned") = Some(state_dir);
    }

    fn request_shutdown(&self) {
        self.shutdown.notify_one();
    }

    async fn shutdown_requested(&self) {
        self.shutdown.notified().await;
    }

    fn initialized(&self) -> bool {
        self.initialized.load(std::sync::atomic::Ordering::Acquire)
    }

    fn refresh_watchers(&self) {
        match self.registry.list() {
            Ok(collections) => self.watcher.refresh(&collections),
            Err(error) => tracing::warn!(%error, "failed to refresh collection watchers"),
        }
    }

    pub fn set_connection_state(&self, state: AgentConnectionState) {
        *self
            .connection_state
            .write()
            .expect("connection state lock poisoned") = state;
    }

    pub fn collections(
        &self,
    ) -> Result<Vec<mdbase_connect_protocol::CollectionSummary>, ConnectError> {
        self.registry.list()
    }

    pub fn next_inventory_revision(&self) -> Result<u64, ConnectError> {
        self.registry.next_inventory_revision()
    }

    pub fn origin_allowed(&self, origin: &str) -> bool {
        !origin.is_empty()
            && self.registry.list_grants().is_ok_and(|grants| {
                grants
                    .iter()
                    .any(|grant| grant.application_origin == origin && grant.encryption.is_some())
            })
    }

    fn scoped_operation(
        &self,
        transport: &'static str,
        collection_id: uuid::Uuid,
        operation: &str,
        input: &serde_json::Value,
        grant: &mdbase_connect_protocol::GrantSummary,
    ) -> Result<serde_json::Value, ConnectError> {
        let started = Instant::now();
        let synchronize_us = std::cell::Cell::new(0_u64);
        if matches!(
            operation,
            "list_timers" | "put_timer" | "cancel_timer" | "reconcile_timers"
        ) {
            let result = self
                .runtime_timers
                .as_ref()
                .ok_or_else(|| {
                    ConnectError::TimerRuntime("The timer authority is unavailable.".to_string())
                })
                .and_then(|timers| {
                    timers
                        .operation(collection_id, grant.clone(), operation, input.clone())
                        .map_err(|error| {
                            if error.internal {
                                ConnectError::TimerRuntime(error.message)
                            } else {
                                ConnectError::InvalidTimer(error.message)
                            }
                        })
                });
            profile_operation(transport, operation, started, 0, &result);
            return result;
        }
        if operation == "sync" {
            let mode = if grant.operations.iter().any(|operation| {
                matches!(
                    operation.as_str(),
                    "create" | "update" | "delete" | "rename"
                )
            }) {
                SyncReplicaMode::ReadWrite
            } else {
                SyncReplicaMode::ReadOnly
            };
            let result = self.registry.sync_operation_synchronized(
                collection_id,
                input,
                LocalReplica {
                    id: grant.id,
                    name: grant.application_name.clone(),
                    mode,
                    allowed_types: Default::default(),
                },
                &grant.scope,
                |invalidation| {
                    let synchronize_started = Instant::now();
                    self.watcher.synchronize(collection_id, invalidation);
                    synchronize_us.set(elapsed_us(synchronize_started));
                },
            );
            profile_operation(transport, operation, started, synchronize_us.get(), &result);
            return result;
        }
        let result = self.registry.scoped_operation_synchronized(
            collection_id,
            operation,
            input,
            &grant.scope,
            |invalidation| {
                let synchronize_started = Instant::now();
                self.watcher.synchronize(collection_id, invalidation);
                synchronize_us.set(elapsed_us(synchronize_started));
            },
        );
        profile_operation(transport, operation, started, synchronize_us.get(), &result);
        result
    }

    fn local_operation(
        &self,
        collection_id: uuid::Uuid,
        operation: &str,
        input: &serde_json::Value,
    ) -> Result<serde_json::Value, ConnectError> {
        let started = Instant::now();
        let synchronize_us = std::cell::Cell::new(0_u64);
        let result =
            self.registry
                .operation_synchronized(collection_id, operation, input, |invalidation| {
                    let synchronize_started = Instant::now();
                    self.watcher.synchronize(collection_id, invalidation);
                    synchronize_us.set(elapsed_us(synchronize_started));
                });
        profile_operation("control", operation, started, synchronize_us.get(), &result);
        result
    }

    pub fn handle_direct_encrypted_operation(
        &self,
        origin: &str,
        envelope: mdbase_connect_protocol::EncryptedRelayEnvelope,
    ) -> RelayMessage {
        let origin_matches = self
            .registry
            .grant_context(envelope.grant_id)
            .ok()
            .flatten()
            .is_some_and(|grant| grant.application_origin == origin);
        if !origin_matches {
            return encrypted_rejection(envelope.request_id);
        }
        self.handle_encrypted_operation(envelope)
    }

    pub fn handle_relay_message(&self, message: RelayMessage) -> Option<RelayMessage> {
        match message {
            RelayMessage::PolicySnapshot { grants, .. } => {
                if let Err(error) = self.registry.replace_grants(&grants) {
                    tracing::error!(%error, "failed to apply relay policy snapshot");
                } else {
                    tracing::debug!(grants = grants.len(), "relay policy snapshot applied");
                }
                None
            }
            RelayMessage::AuthorizationOfferRequest {
                request_id,
                authorization_id: _,
                ..
            } => {
                let paused = self.registry.paused().unwrap_or(true);
                let collections = if paused {
                    Vec::new()
                } else {
                    self.registry
                        .list()
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|collection| collection.enabled)
                        .filter_map(|collection| {
                            let description = self.registry.describe(collection.id).ok()?;
                            Some(AuthorizationCollectionOffer {
                                collection_id: collection.id,
                                display_name: description.display_name,
                                spec_version: description.spec_version,
                                contracts: contract_requirements(&description.contracts),
                            })
                        })
                        .collect()
                };
                Some(RelayMessage::AuthorizationOfferResponse {
                    protocol_version: CONTROL_PROTOCOL_VERSION,
                    request_id,
                    paused,
                    collections,
                })
            }
            RelayMessage::AuthorizationActivationRequest {
                request_id,
                collection_id,
                requirements,
                provisions,
                grant,
                ..
            } => {
                let result = (|| {
                    if self.registry.paused()? {
                        return Err(ConnectError::AccessDenied(
                            "Remote access is paused on this computer.".to_string(),
                        ));
                    }
                    if grant.collection_id != collection_id {
                        return Err(ConnectError::AccessDenied(
                            "The proposed grant names a different collection.".to_string(),
                        ));
                    }
                    if !scope_matches_requirements(&grant.scope, &requirements) {
                        return Err(ConnectError::AccessDenied(
                            "The proposed grant scope does not match the application request."
                                .to_string(),
                        ));
                    }
                    let registered = self.registry.get(collection_id)?;
                    if !registered.enabled {
                        return Err(ConnectError::AccessDenied(
                            "This collection is disabled on its computer.".to_string(),
                        ));
                    }
                    let before = self.registry.describe(collection_id)?;
                    if let Some(operation) = grant
                        .operations
                        .iter()
                        .find(|operation| !before.operations.contains(operation))
                    {
                        return Err(ConnectError::AccessDenied(format!(
                            "{} does not support the requested {operation} operation.",
                            before.display_name
                        )));
                    }
                    let contracts = self.registry.provision_types(
                        collection_id,
                        &requirements,
                        &provisions.types,
                    )?;
                    self.watcher.rescan(collection_id);
                    self.registry.upsert_grant(&grant)?;
                    Ok(contracts)
                })();
                Some(match result {
                    Ok(contracts) => RelayMessage::AuthorizationActivationResponse {
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        request_id,
                        ok: true,
                        contracts,
                        error: None,
                    },
                    Err(error) => RelayMessage::AuthorizationActivationResponse {
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        request_id,
                        ok: false,
                        contracts: Vec::new(),
                        error: Some(ControlError {
                            code: error.code().to_string(),
                            message: error.to_string(),
                            details: None,
                        }),
                    },
                })
            }
            RelayMessage::OperationRequest {
                request_id,
                grant_id,
                collection_id,
                application_id,
                operation,
                input,
                ..
            } => {
                let context = self.registry.grant_context(grant_id).ok().flatten();
                let application_name = context
                    .as_ref()
                    .map(|grant| grant.application_name.as_str())
                    .unwrap_or("Unknown application");
                let collection_name = context
                    .as_ref()
                    .map(|grant| grant.collection_name.as_str())
                    .unwrap_or("Unknown collection");
                if context
                    .as_ref()
                    .is_some_and(|grant| grant.encryption.is_some())
                {
                    return Some(RelayMessage::OperationResponse {
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        request_id,
                        ok: false,
                        result: None,
                        error: Some(ControlError {
                            code: "encryption_required".to_string(),
                            message: "This grant requires encrypted relay protocol 1.".to_string(),
                            details: None,
                        }),
                    });
                }
                if self.registry.paused().unwrap_or(true) {
                    let _ = self.registry.record_activity(
                        application_id,
                        application_name,
                        collection_id,
                        collection_name,
                        &operation,
                        "denied",
                        Some("Remote access is paused"),
                    );
                    return Some(RelayMessage::OperationResponse {
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        request_id,
                        ok: false,
                        result: None,
                        error: Some(ControlError {
                            code: "access_paused".to_string(),
                            message: "Remote access is paused on this computer.".to_string(),
                            details: None,
                        }),
                    });
                }
                let authorized = context.as_ref().is_some_and(|grant| {
                    grant.application_id == application_id
                        && grant.collection_id == collection_id
                        && grant.operations.iter().any(|allowed| allowed == &operation)
                });
                let result = if authorized {
                    self.scoped_operation(
                        "relay",
                        collection_id,
                        &operation,
                        &input,
                        context.as_ref().expect("authorized grant must exist"),
                    )
                } else {
                    let _ = self.registry.record_activity(
                        application_id,
                        application_name,
                        collection_id,
                        collection_name,
                        &operation,
                        "denied",
                        Some("Local grant did not allow this operation"),
                    );
                    return Some(RelayMessage::OperationResponse {
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        request_id,
                        ok: false,
                        result: None,
                        error: Some(ControlError {
                            code: "access_denied".to_string(),
                            message: "The local connector policy does not allow this request."
                                .to_string(),
                            details: None,
                        }),
                    });
                };
                let (outcome, detail) = match &result {
                    Ok(_) => ("succeeded", None),
                    Err(error) => ("failed", Some(error.to_string())),
                };
                let _ = self.registry.record_activity(
                    application_id,
                    application_name,
                    collection_id,
                    collection_name,
                    &operation,
                    outcome,
                    detail.as_deref(),
                );
                Some(match result {
                    Ok(result) => RelayMessage::OperationResponse {
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        request_id,
                        ok: true,
                        result: Some(result),
                        error: None,
                    },
                    Err(error) => RelayMessage::OperationResponse {
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        request_id,
                        ok: false,
                        result: None,
                        error: Some(ControlError {
                            code: error.code().to_string(),
                            message: error.to_string(),
                            details: None,
                        }),
                    },
                })
            }
            RelayMessage::EncryptedOperationRequest { envelope } => {
                Some(self.handle_encrypted_operation(envelope))
            }
            RelayMessage::OperationResponse { .. }
            | RelayMessage::AuthorizationOfferResponse { .. }
            | RelayMessage::AuthorizationActivationResponse { .. }
            | RelayMessage::EncryptedOperationResponse { .. }
            | RelayMessage::EncryptedOperationRejected { .. } => None,
        }
    }

    fn handle_encrypted_operation(
        &self,
        envelope: mdbase_connect_protocol::EncryptedRelayEnvelope,
    ) -> RelayMessage {
        let rejected = || encrypted_rejection(envelope.request_id);
        let Some(context) = self
            .registry
            .grant_context(envelope.grant_id)
            .ok()
            .flatten()
        else {
            return rejected();
        };
        let Some(encryption) = context.encryption.as_ref() else {
            return rejected();
        };
        let binding = RelayBinding::from_grant(context.id, context.application_id, encryption);
        if validate_envelope(&envelope, &binding).is_err()
            || context.collection_id != envelope.collection_id
            || !context
                .operations
                .iter()
                .any(|allowed| allowed == &envelope.operation)
        {
            return rejected();
        }
        let metadata = RelayMetadata {
            binding: &binding,
            request_id: envelope.request_id,
            operation: &envelope.operation,
            counter: &envelope.counter,
        };
        let Ok(keys) = self
            .relay_identity
            .derive(&encryption.application_public_key, &binding)
        else {
            return rejected();
        };

        // Authenticate before touching durable replay state. JSON is decoded only after the
        // counter and request ID have been accepted atomically.
        let Ok(plaintext) =
            keys.decrypt_bytes(RelayDirection::Request, metadata, &envelope.ciphertext)
        else {
            return rejected();
        };
        let Ok(counter) = parse_counter(&envelope.counter) else {
            return rejected();
        };
        let Ok(input) = serde_json::from_slice::<serde_json::Value>(&plaintext) else {
            return rejected();
        };
        let Ok(fingerprint) = encrypted_request_fingerprint(&envelope) else {
            return rejected();
        };
        match self.registry.claim_encrypted_request(
            context.id,
            &encryption.key_id,
            counter,
            envelope.request_id,
            &fingerprint,
        ) {
            Ok(EncryptedRequestClaim::Fresh) => {}
            Ok(EncryptedRequestClaim::Completed(response)) => {
                return serde_json::from_str(&response).map_or_else(
                    |_| rejected(),
                    |envelope| RelayMessage::EncryptedOperationResponse { envelope },
                );
            }
            Ok(EncryptedRequestClaim::InProgress) => {
                for _ in 0..1_000 {
                    std::thread::sleep(std::time::Duration::from_millis(25));
                    match self.registry.encrypted_request_response(
                        context.id,
                        &encryption.key_id,
                        envelope.request_id,
                        &fingerprint,
                    ) {
                        Ok(Some(response)) => {
                            return serde_json::from_str(&response).map_or_else(
                                |_| rejected(),
                                |envelope| RelayMessage::EncryptedOperationResponse { envelope },
                            );
                        }
                        Ok(None) => {}
                        Err(_) => return rejected(),
                    }
                }
                return rejected();
            }
            Err(_) => return rejected(),
        }

        let paused = self.registry.paused().unwrap_or(true);
        let result = if paused {
            Err(ConnectError::AccessDenied(
                "Remote access is paused on this computer.".to_string(),
            ))
        } else {
            self.scoped_operation(
                "encrypted",
                context.collection_id,
                &envelope.operation,
                &input,
                &context,
            )
        };
        let (outcome, detail) = match &result {
            Ok(_) => ("succeeded", None),
            Err(error) if paused => ("denied", Some(error.to_string())),
            Err(error) => ("failed", Some(error.to_string())),
        };
        let _ = self.registry.record_activity(
            context.application_id,
            &context.application_name,
            context.collection_id,
            &context.collection_name,
            &envelope.operation,
            outcome,
            detail.as_deref(),
        );
        let body = match result {
            Ok(result) => serde_json::json!({ "ok": true, "result": result }),
            Err(error) => serde_json::json!({
                "ok": false,
                "error": {
                    "code": if paused { "access_paused" } else { error.code() },
                    "message": error.to_string()
                }
            }),
        };
        let Ok(ciphertext) = keys.encrypt_json(RelayDirection::Response, metadata, &body) else {
            return rejected();
        };
        let response_envelope = metadata.envelope(ciphertext);
        let Ok(serialized_response) = serde_json::to_string(&response_envelope) else {
            return rejected();
        };
        if self
            .registry
            .complete_encrypted_request(
                context.id,
                &encryption.key_id,
                envelope.request_id,
                &fingerprint,
                &serialized_response,
            )
            .is_err()
        {
            return rejected();
        }
        RelayMessage::EncryptedOperationResponse {
            envelope: response_envelope,
        }
    }

    async fn execute(&self, request: ControlRequest) -> ControlResponse {
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
            ControlCommand::DaemonShutdown => {
                self.request_shutdown();
                Ok(serde_json::json!({"stopping": true}))
            }
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
                    if result.is_ok() {
                        if let Ok(snapshot) = cloud.snapshot().await {
                            let _ = self.registry.replace_grant_summaries(&snapshot.grants);
                        }
                    }
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

    fn cloud(&self) -> Result<&CloudControlClient, ConnectError> {
        self.cloud.as_ref().ok_or_else(|| {
            ConnectError::Cloud("Connect this computer to a portal first.".to_string())
        })
    }

    fn mirror_manager(&self) -> Result<Arc<MirrorManager>, ConnectError> {
        self.mirrors
            .read()
            .expect("mirror manager lock poisoned")
            .clone()
            .ok_or_else(|| ConnectError::Mirror {
                code: "mirror_service_unavailable".to_string(),
                message: "Hosted mirror service is unavailable.".to_string(),
            })
    }

    fn configure_account(
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
        self.request_shutdown();
        Ok(serde_json::json!({
            "configured": true,
            "server_url": configuration.server_url,
            "restart_required": true
        }))
    }

    fn account_configuration(&self) -> Result<serde_json::Value, ConnectError> {
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

    fn clear_account(&self) -> Result<serde_json::Value, ConnectError> {
        let _guard = self
            .account_configuration_lock
            .lock()
            .expect("account configuration lock poisoned");
        let state_dir = self.state_dir()?;
        disconnect_cloud(&state_dir)?;
        self.request_shutdown();
        Ok(serde_json::json!({
            "configured": false,
            "restart_required": true
        }))
    }

    fn state_dir(&self) -> Result<std::path::PathBuf, ConnectError> {
        self.state_dir
            .read()
            .expect("state directory lock poisoned")
            .clone()
            .ok_or_else(|| {
                ConnectError::Settings("Daemon state directory is unavailable.".to_string())
            })
    }

    async fn hosted_request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, ConnectError> {
        self.cloud()?.connector_request(method, path, body).await
    }

    async fn transfer_authority_to_remote(
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
            if let Err(error) = cloud.upload_authority_snapshot(&capability, &staged).await {
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
                if let Err(error) = cloud.upload_authority_snapshot(&capability, &fenced).await {
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

    async fn cancel_fenced_transfer(
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

    async fn approve_authorization(
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
                &pending.requirements,
                &pending.provisions,
            )
            .await?;
        cloud.approve_authorization(params, &contracts).await
    }

    async fn create_grant(
        &self,
        params: &mdbase_connect_protocol::GrantCreateParams,
    ) -> Result<serde_json::Value, ConnectError> {
        let cloud = self.cloud()?;
        let application = cloud.application(params.application_id).await?;
        let contracts = self
            .ensure_application_types(
                params.collection_id,
                &application.requirements,
                &application.provisions,
            )
            .await?;
        cloud.create_grant(params, &contracts).await
    }

    async fn ensure_application_types(
        &self,
        collection_id: uuid::Uuid,
        requirements: &mdbase_connect_protocol::ApplicationRequirements,
        provisions: &mdbase_connect_protocol::ApplicationProvisions,
    ) -> Result<Vec<mdbase_connect_protocol::ContractRequirement>, ConnectError> {
        let registered = self.registry.get(collection_id)?;
        if !registered.enabled {
            return Err(ConnectError::AccessDenied(
                "This collection is disabled on its computer.".to_string(),
            ));
        }
        let contracts =
            self.registry
                .provision_types(collection_id, requirements, &provisions.types)?;
        self.watcher.rescan(collection_id);
        let mut collection = self.registry.get(collection_id)?;
        collection.contracts = contracts;
        Ok(collection.contracts)
    }

    async fn access_snapshot(&self) -> Result<serde_json::Value, ConnectError> {
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
            Ok(snapshot) => {
                self.registry.replace_grant_summaries(&snapshot.grants)?;
                snapshot
            }
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
        }
        serde_json::to_value(snapshot).map_err(ConnectError::from)
    }
}

fn contract_requirements(
    contracts: &[mdbase_connect_protocol::CollectionContractDescriptor],
) -> Vec<ContractRequirement> {
    let mut contracts = contracts
        .iter()
        .map(|contract| ContractRequirement {
            id: contract.id.clone(),
            version: contract.version,
        })
        .collect::<Vec<_>>();
    contracts.sort_by(|left, right| {
        left.id
            .cmp(&right.id)
            .then_with(|| left.version.cmp(&right.version))
    });
    contracts.dedup();
    contracts
}

fn scope_matches_requirements(scope: &GrantScope, requirements: &ApplicationRequirements) -> bool {
    let expected_access = requirements.access.unwrap_or(ApplicationAccess::Contract);
    let mut actual_contracts = scope.contracts.clone();
    let mut expected_contracts = if expected_access == ApplicationAccess::FullCollection {
        Vec::new()
    } else {
        requirements.contracts.clone()
    };
    actual_contracts.sort_by(|left, right| {
        left.id
            .cmp(&right.id)
            .then_with(|| left.version.cmp(&right.version))
    });
    expected_contracts.sort_by(|left, right| {
        left.id
            .cmp(&right.id)
            .then_with(|| left.version.cmp(&right.version))
    });
    actual_contracts.dedup();
    expected_contracts.dedup();
    scope.access == expected_access && actual_contracts == expected_contracts
}

fn requirements_can_be_provisioned(
    requirements: &mdbase_connect_protocol::ApplicationRequirements,
    provisions: &mdbase_connect_protocol::ApplicationProvisions,
    available: &[mdbase_connect_protocol::ContractRequirement],
) -> bool {
    requirements.contracts.iter().all(|required| {
        available.contains(required)
            || provisions
                .types
                .iter()
                .any(|provision| provision.provides.contains(required))
    })
}

fn validated_hosted_name(value: &str) -> Result<String, ConnectError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 200 {
        return Err(ConnectError::InvalidInput(
            "Collection name must contain between 1 and 200 characters.".to_string(),
        ));
    }
    Ok(value.to_string())
}

fn profile_operation(
    transport: &str,
    operation: &str,
    started: Instant,
    synchronize_us: u64,
    result: &Result<serde_json::Value, ConnectError>,
) {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    let enabled = ENABLED.get_or_init(|| {
        std::env::var("MDBASE_CONNECT_PROFILE")
            .is_ok_and(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
    });
    if !enabled {
        return;
    }
    let total_us = elapsed_us(started);
    let execute_us = total_us.saturating_sub(synchronize_us);
    let error_code = result.as_ref().err().map(ConnectError::code);
    tracing::info!(
        target: "mdbase_connect::profile",
        transport,
        operation,
        execute_us,
        synchronize_us,
        total_us,
        ok = result.is_ok(),
        error_code,
        "collection operation profile"
    );
}

fn elapsed_us(started: Instant) -> u64 {
    started.elapsed().as_micros().min(u128::from(u64::MAX)) as u64
}

fn encrypted_rejection(request_id: uuid::Uuid) -> RelayMessage {
    RelayMessage::EncryptedOperationRejected {
        protocol_version: ENCRYPTED_RELAY_PROTOCOL_VERSION,
        request_id,
        error: ControlError {
            code: "encrypted_relay_rejected".to_string(),
            message: "Encrypted relay request was rejected.".to_string(),
            details: None,
        },
    }
}

async fn handle_stream<S>(stream: S, state: Arc<AgentState>) -> io::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (reader, mut writer) = tokio::io::split(stream);
    let mut reader = BufReader::new(reader.take(MAX_LOCAL_CONTROL_REQUEST_BYTES + 1));
    let mut encoded_request = Vec::new();
    let read = reader.read_until(b'\n', &mut encoded_request).await?;
    if read == 0 {
        return Ok(());
    }
    let response = if encoded_request.len() as u64 > MAX_LOCAL_CONTROL_REQUEST_BYTES
        || encoded_request.last() != Some(&b'\n')
    {
        ControlResponse::failure(
            uuid::Uuid::nil(),
            "control_request_too_large",
            "Local control requests must be newline-terminated and no larger than 8 MiB.",
        )
    } else {
        encoded_request.pop();
        match serde_json::from_slice::<ControlRequest>(&encoded_request) {
            Ok(request) => state.execute(request).await,
            Err(error) => ControlResponse::failure(
                uuid::Uuid::nil(),
                "invalid_request",
                format!("Invalid control request: {error}"),
            ),
        }
    };
    let mut encoded = serde_json::to_vec(&response).map_err(io::Error::other)?;
    encoded.push(b'\n');
    writer.write_all(&encoded).await?;
    Ok(())
}

#[cfg(unix)]
pub async fn serve(
    endpoint: &str,
    state: Arc<AgentState>,
    on_listening: impl FnOnce(),
) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    use std::path::Path;
    use tokio::net::UnixListener;

    let socket_path = Path::new(endpoint);
    match std::fs::symlink_metadata(socket_path) {
        Ok(metadata) => {
            if !metadata.file_type().is_socket() {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "the local control endpoint exists and is not a Unix socket",
                ));
            }
            if metadata.uid() != unsafe { libc::geteuid() } {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "the local control socket belongs to another operating-system user",
                ));
            }
            match tokio::net::UnixStream::connect(socket_path).await {
                Ok(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::AddrInUse,
                        "another mdbase connect daemon is already running",
                    ))
                }
                Err(_) => std::fs::remove_file(socket_path)?,
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let listener = UnixListener::bind(socket_path)?;
    if let Err(error) =
        std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o600))
    {
        drop(listener);
        let _ = std::fs::remove_file(socket_path);
        return Err(error);
    }
    on_listening();

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let state = state.clone();
                tokio::spawn(async move {
                    if let Err(error) = handle_stream(stream, state).await {
                        tracing::debug!(%error, "local control connection closed");
                    }
                });
            }
            _ = tokio::signal::ctrl_c() => {
                tracing::info!("stopping local connector daemon");
                drop(listener);
                let _ = std::fs::remove_file(socket_path);
                return Ok(());
            }
            _ = state.shutdown_requested() => {
                tracing::info!("stopping local connector daemon after a control request");
                drop(listener);
                let _ = std::fs::remove_file(socket_path);
                return Ok(());
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use mdbase_connect_core::CollectionRegistry;
    use mdbase_connect_protocol::crypto::{RelayDirection, RelayMetadata};
    use mdbase_connect_protocol::{
        ApplicationAccess, ApplicationProvisions, ApplicationRequirements, GrantEncryption,
        GrantPolicy, GrantScope, RELAY_ENCRYPTION_SUITE,
    };
    use std::fs;
    use tokio::net::UnixStream;
    use tokio::sync::oneshot;
    use uuid::Uuid;

    #[tokio::test]
    async fn listening_callback_runs_after_the_control_socket_is_reachable() {
        let test_root = std::env::temp_dir().join(format!(
            "mdbase-connect-listening-test-{}",
            uuid::Uuid::new_v4()
        ));
        let endpoint = test_root.join("agent.sock");
        let registry = CollectionRegistry::open(&test_root).unwrap();
        let watcher = CollectionWatchService::start(registry.clone());
        let state = Arc::new(AgentState::new(registry, watcher, None));
        let starting_ping = state
            .execute(ControlRequest::new(ControlCommand::Ping))
            .await;
        assert_eq!(starting_ping.result.unwrap()["ready"], false);
        let (ready, listening) = oneshot::channel();
        let endpoint_for_server = endpoint.to_string_lossy().into_owned();
        let server_state = state.clone();
        let server = tokio::spawn(async move {
            serve(&endpoint_for_server, server_state, move || {
                let _ = ready.send(());
            })
            .await
        });

        listening.await.expect("listening callback");
        UnixStream::connect(&endpoint)
            .await
            .expect("control socket must accept connections after the callback");
        state.mark_initialized();
        let ready_ping = state
            .execute(ControlRequest::new(ControlCommand::Ping))
            .await;
        assert_eq!(ready_ping.result.unwrap()["ready"], true);

        server.abort();
        let _ = server.await;
        fs::remove_dir_all(test_root).unwrap();
    }

    #[tokio::test]
    async fn local_control_refuses_to_replace_a_non_socket_endpoint() {
        let test_root = std::env::temp_dir().join(format!(
            "mdbase-connect-endpoint-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&test_root).unwrap();
        let endpoint = test_root.join("important.txt");
        fs::write(&endpoint, "keep me").unwrap();
        let registry = CollectionRegistry::open(test_root.join("state")).unwrap();
        let watcher = CollectionWatchService::start(registry.clone());
        let state = Arc::new(AgentState::new(registry, watcher, None));

        let error = serve(endpoint.to_str().unwrap(), state, || {})
            .await
            .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(&endpoint).unwrap(), "keep me");
        fs::remove_dir_all(test_root).unwrap();
    }

    #[tokio::test]
    async fn rejects_an_unsupported_local_control_protocol() {
        let test_root = std::env::temp_dir().join(format!(
            "mdbase-connect-protocol-test-{}",
            uuid::Uuid::new_v4()
        ));
        let registry = CollectionRegistry::open(&test_root).unwrap();
        let watcher = CollectionWatchService::start(registry.clone());
        let state = AgentState::new(registry, watcher, None);
        let mut request = ControlRequest::new(ControlCommand::Ping);
        request.protocol_version = LOCAL_CONTROL_PROTOCOL_VERSION + 1;

        let response = state.execute(request).await;

        assert!(!response.ok);
        assert_eq!(response.protocol_version, LOCAL_CONTROL_PROTOCOL_VERSION);
        assert_eq!(
            response.error.expect("protocol error").code,
            "unsupported_local_protocol"
        );
        fs::remove_dir_all(test_root).unwrap();
    }

    #[tokio::test]
    async fn status_reports_the_running_binary_version_for_upgrade_health_checks() {
        let test_root = std::env::temp_dir().join(format!(
            "mdbase-connect-version-test-{}",
            uuid::Uuid::new_v4()
        ));
        let registry = CollectionRegistry::open(&test_root).unwrap();
        let watcher = CollectionWatchService::start(registry.clone());
        let state = AgentState::new(registry, watcher, None);

        let response = state
            .execute(ControlRequest::new(ControlCommand::Status))
            .await;

        assert!(response.ok);
        assert_eq!(
            response.result.expect("status result")["binary_version"],
            env!("CARGO_PKG_VERSION")
        );
        fs::remove_dir_all(test_root).unwrap();
    }

    #[tokio::test]
    async fn bounds_local_control_request_memory() {
        let test_root = std::env::temp_dir().join(format!(
            "mdbase-connect-request-limit-test-{}",
            uuid::Uuid::new_v4()
        ));
        let registry = CollectionRegistry::open(&test_root).unwrap();
        let watcher = CollectionWatchService::start(registry.clone());
        let state = Arc::new(AgentState::new(registry, watcher, None));
        let capacity = (MAX_LOCAL_CONTROL_REQUEST_BYTES + 1) as usize;
        let (mut client, server) = tokio::io::duplex(capacity);
        let handler = tokio::spawn(handle_stream(server, state));

        client.write_all(&vec![b'x'; capacity]).await.unwrap();
        let mut response = String::new();
        BufReader::new(client)
            .read_line(&mut response)
            .await
            .unwrap();
        let response: ControlResponse = serde_json::from_str(&response).unwrap();

        assert!(!response.ok);
        assert_eq!(
            response.error.expect("size error").code,
            "control_request_too_large"
        );
        handler.await.unwrap().unwrap();
        fs::remove_dir_all(test_root).unwrap();
    }

    #[test]
    fn live_authorization_is_acknowledged_only_after_the_grant_is_stored() {
        let test_root = std::env::temp_dir().join(format!(
            "mdbase-connect-authorization-test-{}",
            uuid::Uuid::new_v4()
        ));
        let registry = CollectionRegistry::open(test_root.join("state")).unwrap();
        let collection = registry
            .create(test_root.join("collection"), Some("Live notes"))
            .unwrap();
        let watcher = CollectionWatchService::start(registry.clone());
        let state = AgentState::new(registry.clone(), watcher, None);
        let authorization_id = Uuid::new_v4();
        let offer_request_id = Uuid::new_v4();
        let offer = state
            .handle_relay_message(RelayMessage::AuthorizationOfferRequest {
                protocol_version: CONTROL_PROTOCOL_VERSION,
                request_id: offer_request_id,
                authorization_id,
            })
            .unwrap();
        let RelayMessage::AuthorizationOfferResponse {
            request_id,
            paused,
            collections,
            ..
        } = offer
        else {
            panic!("expected authorization offer")
        };
        assert_eq!(request_id, offer_request_id);
        assert!(!paused);
        assert_eq!(collections.len(), 1);
        assert_eq!(collections[0].collection_id, collection.id);

        let grant = GrantPolicy {
            id: Uuid::new_v4(),
            application_id: Uuid::new_v4(),
            collection_id: collection.id,
            operations: vec!["describe".to_string()],
            scope: GrantScope::full_collection(),
            application_name: "Live application".to_string(),
            application_distribution: "web".to_string(),
            application_homepage: "https://example.test".to_string(),
            application_project_url: None,
            application_origin: "https://example.test".to_string(),
            application_icon: None,
            collection_name: collection.display_name,
            notification_criteria: Vec::new(),
            created_at: "2026-07-26T00:00:00Z".to_string(),
            encryption: None,
        };
        let activation = state
            .handle_relay_message(RelayMessage::AuthorizationActivationRequest {
                protocol_version: CONTROL_PROTOCOL_VERSION,
                request_id: Uuid::new_v4(),
                authorization_id,
                collection_id: collection.id,
                requirements: ApplicationRequirements {
                    contracts: Vec::new(),
                    access: Some(ApplicationAccess::FullCollection),
                },
                provisions: ApplicationProvisions::default(),
                grant: Box::new(grant.clone()),
            })
            .unwrap();
        assert!(matches!(
            activation,
            RelayMessage::AuthorizationActivationResponse {
                ok: true,
                error: None,
                ..
            }
        ));
        assert_eq!(registry.list_grants().unwrap()[0].id, grant.id);
        fs::remove_dir_all(test_root).unwrap();
    }

    #[test]
    fn encrypted_operations_round_trip_and_replays_return_the_durable_receipt() {
        let test_root = std::env::temp_dir().join(format!(
            "mdbase-connect-encryption-test-{}",
            uuid::Uuid::new_v4()
        ));
        let state_dir = test_root.join("state");
        let collection_dir = test_root.join("collection");
        let registry = CollectionRegistry::open(&state_dir).unwrap();
        let collection = registry
            .create(&collection_dir, Some("Encrypted notes"))
            .unwrap();
        let watcher = CollectionWatchService::start(registry.clone());
        let connector_identity = RelayIdentity::generate();
        let application_identity = RelayIdentity::generate();
        let connector_id = Uuid::new_v4();
        let application_id = Uuid::new_v4();
        let grant_id = Uuid::new_v4();
        let encryption = GrantEncryption {
            protocol_version: ENCRYPTED_RELAY_PROTOCOL_VERSION,
            suite: RELAY_ENCRYPTION_SUITE.to_string(),
            key_id: "enc_round_trip".to_string(),
            scope_epoch: 1,
            connector_id,
            collection_id: collection.id,
            application_public_key: application_identity.public_key(),
            connector_public_key: connector_identity.public_key(),
        };
        registry
            .replace_grants(&[GrantPolicy {
                id: grant_id,
                application_id,
                collection_id: collection.id,
                operations: vec!["describe".to_string()],
                scope: GrantScope::full_collection(),
                application_name: "Encrypted application".to_string(),
                application_distribution: "web".to_string(),
                application_homepage: "https://example.test".to_string(),
                application_project_url: None,
                application_origin: "https://example.test".to_string(),
                application_icon: None,
                collection_name: "Encrypted notes".to_string(),
                notification_criteria: Vec::new(),
                created_at: "2026-07-21T00:00:00Z".to_string(),
                encryption: Some(encryption.clone()),
            }])
            .unwrap();
        let state = AgentState::with_identity(registry, watcher, None, connector_identity);
        let binding = RelayBinding::from_grant(grant_id, application_id, &encryption);
        let keys = application_identity
            .derive(&encryption.connector_public_key, &binding)
            .unwrap();
        let metadata = RelayMetadata {
            binding: &binding,
            request_id: Uuid::new_v4(),
            operation: "describe",
            counter: "1",
        };
        let ciphertext = keys
            .encrypt_json(RelayDirection::Request, metadata, &serde_json::json!({}))
            .unwrap();
        let request = RelayMessage::EncryptedOperationRequest {
            envelope: metadata.envelope(ciphertext),
        };
        let response = state.handle_relay_message(request.clone()).unwrap();
        let RelayMessage::EncryptedOperationResponse { envelope } = response else {
            panic!("expected encrypted response")
        };
        let body: serde_json::Value = keys
            .decrypt_json(RelayDirection::Response, metadata, &envelope.ciphertext)
            .unwrap();
        assert_eq!(body["ok"], true);
        assert_eq!(body["result"]["display_name"], "Encrypted notes");

        let replay = state.handle_relay_message(request).unwrap();
        let RelayMessage::EncryptedOperationResponse {
            envelope: replay_envelope,
        } = replay
        else {
            panic!("expected cached encrypted response")
        };
        assert_eq!(replay_envelope, envelope);
        fs::remove_dir_all(test_root).unwrap();
    }
}

#[cfg(windows)]
pub async fn serve(
    endpoint: &str,
    state: Arc<AgentState>,
    on_listening: impl FnOnce(),
) -> io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;

    let mut on_listening = Some(on_listening);
    loop {
        let server = ServerOptions::new()
            .reject_remote_clients(true)
            .create(endpoint)?;
        if let Some(on_listening) = on_listening.take() {
            on_listening();
        }
        tokio::select! {
            connected = server.connect() => {
                connected?;
                let state = state.clone();
                tokio::spawn(async move {
                    if let Err(error) = handle_stream(server, state).await {
                        tracing::debug!(%error, "local control connection closed");
                    }
                });
            }
            _ = tokio::signal::ctrl_c() => {
                tracing::info!("stopping local connector daemon");
                return Ok(());
            }
            _ = state.shutdown_requested() => {
                tracing::info!("stopping local connector daemon after a control request");
                return Ok(());
            }
        }
    }
}
