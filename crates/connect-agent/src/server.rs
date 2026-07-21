use crate::cloud::CloudControlClient;
use crate::watcher::CollectionWatchService;
use mdbase_connect_core::{CollectionRegistry, ConnectError};
use mdbase_connect_protocol::crypto::{
    parse_counter, validate_envelope, RelayBinding, RelayDirection, RelayIdentity, RelayMetadata,
};
use mdbase_connect_protocol::{
    AgentConnectionState, AgentStatus, ControlCommand, ControlError, ControlRequest,
    ControlResponse, RelayMessage, CONTROL_PROTOCOL_VERSION, ENCRYPTED_RELAY_PROTOCOL_VERSION,
};
use std::io;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub struct AgentState {
    registry: CollectionRegistry,
    watcher: CollectionWatchService,
    connection_state: std::sync::RwLock<AgentConnectionState>,
    initialized: std::sync::atomic::AtomicBool,
    cloud: Option<CloudControlClient>,
    relay_identity: RelayIdentity,
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
            cloud,
            relay_identity,
        }
    }

    pub fn relay_public_key(&self) -> String {
        self.relay_identity.public_key()
    }

    pub fn mark_initialized(&self) {
        self.initialized
            .store(true, std::sync::atomic::Ordering::Release);
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
                            message: "This grant requires encrypted relay protocol 3.".to_string(),
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
                    self.registry.scoped_operation(
                        collection_id,
                        &operation,
                        &input,
                        &context.as_ref().expect("authorized grant must exist").scope,
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
                if result.is_ok() && is_mutation(&operation) {
                    self.watcher.rescan(collection_id);
                }
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
            | RelayMessage::EncryptedOperationResponse { .. }
            | RelayMessage::EncryptedOperationRejected { .. } => None,
        }
    }

    fn handle_encrypted_operation(
        &self,
        envelope: mdbase_connect_protocol::EncryptedRelayEnvelope,
    ) -> RelayMessage {
        let rejected = || RelayMessage::EncryptedOperationRejected {
            protocol_version: ENCRYPTED_RELAY_PROTOCOL_VERSION,
            request_id: envelope.request_id,
            error: ControlError {
                code: "encrypted_relay_rejected".to_string(),
                message: "Encrypted relay request was rejected.".to_string(),
                details: None,
            },
        };
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
        if self
            .registry
            .accept_encrypted_request(context.id, &encryption.key_id, counter, envelope.request_id)
            .is_err()
        {
            return rejected();
        }
        let Ok(input) = serde_json::from_slice::<serde_json::Value>(&plaintext) else {
            return rejected();
        };

        let paused = self.registry.paused().unwrap_or(true);
        let result = if paused {
            Err(ConnectError::AccessDenied(
                "Remote access is paused on this computer.".to_string(),
            ))
        } else {
            self.registry.scoped_operation(
                context.collection_id,
                &envelope.operation,
                &input,
                &context.scope,
            )
        };
        if result.is_ok() && is_mutation(&envelope.operation) {
            self.watcher.rescan(context.collection_id);
        }
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
        RelayMessage::EncryptedOperationResponse {
            envelope: metadata.envelope(ciphertext),
        }
    }

    async fn execute(&self, request: ControlRequest) -> ControlResponse {
        let id = request.id;
        let result = match request.command {
            ControlCommand::Ping => Ok(serde_json::json!({
                "pong": true,
                "ready": self.initialized(),
            })),
            ControlCommand::Status => self.registry.count().map(|registered_collections| {
                serde_json::to_value(AgentStatus {
                    protocol_version: CONTROL_PROTOCOL_VERSION,
                    state: self
                        .connection_state
                        .read()
                        .expect("connection state lock poisoned")
                        .clone(),
                    registered_collections,
                    paused: self.registry.paused().unwrap_or(true),
                })
                .expect("agent status must serialize")
            }),
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
                let result =
                    self.registry
                        .operation(params.collection_id, &params.operation, &params.input);
                if result.is_ok() && is_mutation(&params.operation) {
                    self.watcher.rescan(params.collection_id);
                }
                result
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
            ControlCommand::ApplicationDiscover(params) => match self.cloud() {
                Ok(cloud) => cloud.discover(&params).await,
                Err(error) => Err(error),
            },
            ControlCommand::GrantCreate(params) => match self.cloud() {
                Ok(cloud) => cloud.create_grant(&params).await,
                Err(error) => Err(error),
            },
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
        if !self
            .registry
            .is_compatible(params.collection_id, &pending.requirements)?
        {
            return Err(ConnectError::AccessDenied(
                "This collection does not provide the contracts required by the application."
                    .to_string(),
            ));
        }
        cloud.approve_authorization(params).await
    }

    async fn access_snapshot(&self) -> Result<serde_json::Value, ConnectError> {
        let Some(cloud) = &self.cloud else {
            return serde_json::to_value(mdbase_connect_protocol::AccessSnapshot {
                configured: false,
                online: false,
                account: None,
                grants: self.registry.list_grants()?,
                pending_authorizations: Vec::new(),
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
                }
            }
        };
        let collections = self.registry.list()?;
        for pending in &mut snapshot.pending_authorizations {
            pending.compatible_collection_ids = collections
                .iter()
                .filter(|collection| collection.enabled)
                .filter_map(|collection| {
                    self.registry
                        .is_compatible(collection.id, &pending.requirements)
                        .ok()
                        .filter(|compatible| *compatible)
                        .map(|_| collection.id)
                })
                .collect();
        }
        serde_json::to_value(snapshot).map_err(ConnectError::from)
    }
}

fn is_mutation(operation: &str) -> bool {
    matches!(operation, "create" | "update" | "delete" | "rename")
}

async fn handle_stream<S>(stream: S, state: Arc<AgentState>) -> io::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (reader, mut writer) = tokio::io::split(stream);
    let mut lines = BufReader::new(reader).lines();
    while let Some(line) = lines.next_line().await? {
        let response = match serde_json::from_str::<ControlRequest>(&line) {
            Ok(request) => state.execute(request).await,
            Err(error) => ControlResponse::failure(
                uuid::Uuid::nil(),
                "invalid_request",
                format!("Invalid control request: {error}"),
            ),
        };
        let mut encoded = serde_json::to_vec(&response).map_err(io::Error::other)?;
        encoded.push(b'\n');
        writer.write_all(&encoded).await?;
    }
    Ok(())
}

#[cfg(unix)]
pub async fn serve(
    endpoint: &str,
    state: Arc<AgentState>,
    on_listening: impl FnOnce(),
) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use tokio::net::UnixListener;

    let socket_path = Path::new(endpoint);
    if socket_path.exists() {
        match tokio::net::UnixStream::connect(socket_path).await {
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    "another mdbase connect agent is already running",
                ))
            }
            Err(_) => std::fs::remove_file(socket_path)?,
        }
    }
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let listener = UnixListener::bind(socket_path)?;
    std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o600))?;
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
                tracing::info!("stopping local connector agent");
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
        GrantEncryption, GrantPolicy, GrantScope, RELAY_ENCRYPTION_SUITE,
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

    #[test]
    fn encrypted_operations_round_trip_and_replays_fail_closed() {
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
                scope: GrantScope::default(),
                application_name: "Encrypted application".to_string(),
                application_homepage: "https://example.test".to_string(),
                application_icon: None,
                collection_name: "Encrypted notes".to_string(),
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

        assert!(matches!(
            state.handle_relay_message(request),
            Some(RelayMessage::EncryptedOperationRejected { .. })
        ));
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
        let server = ServerOptions::new().create(endpoint)?;
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
                tracing::info!("stopping local connector agent");
                return Ok(());
            }
        }
    }
}
