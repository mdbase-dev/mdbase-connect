use crate::cloud::CloudControlClient;
use crate::mirrors::MirrorManager;
use crate::runtime_notifications::RuntimeTimerHandle;
use crate::watcher::CollectionWatchService;
use mdbase_connect_core::{
    configure_cloud, disconnect_cloud, encrypted_request_fingerprint, load_cloud_configuration,
    CloudConfiguration, CollectionRegistry, ConnectError, EncryptedReplayClass,
    EncryptedRequestClaim, LocalReplica, MutationClaim, MutationClaimRequest, MutationJournalState,
    MutationLease,
};
use mdbase_connect_protocol::crypto::{
    parse_counter, validate_envelope, RelayBinding, RelayDirection, RelayIdentity, RelayKeys,
    RelayMetadata,
};
use mdbase_connect_protocol::{
    mutation_fingerprint, mutation_operation_identifier, operation_input_schema_version,
    AgentConnectionState, AgentStatus, ApplicationAccess, AuthorityTarget,
    AuthorizationCollectionOffer, AuthorizationCollectionTypes, ConnectOperationOutcome,
    ConnectProblem, ContractSetupChoice, ControlCommand, ControlError, ControlRequest,
    ControlResponse, RelayMessage, SyncReplicaMode, CONTROL_PROTOCOL_VERSION,
    LOCAL_CONTROL_PROTOCOL_VERSION,
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
    credential_store_error: Option<String>,
    relay_identity: RelayIdentity,
    runtime_timers: Option<RuntimeTimerHandle>,
    mirrors: std::sync::RwLock<Option<Arc<MirrorManager>>>,
    shutdown: tokio::sync::Notify,
    state_dir: std::sync::RwLock<Option<std::path::PathBuf>>,
    account_configuration_lock: std::sync::Mutex<()>,
    admission: crate::admission::AdmissionScheduler,
}

mod account;
mod authorization;
mod control;
mod files;
mod metrics;
mod operation_responses;
mod operations;
mod scoped_operations;
mod setup_binding;

impl AgentState {
    pub(crate) fn take_direct_protocol_usage(
        &self,
    ) -> Vec<mdbase_connect_protocol::ProtocolUsageEntry> {
        metrics::take_direct_protocol_usage()
    }

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
            credential_store_error: None,
            relay_identity,
            runtime_timers: None,
            mirrors: std::sync::RwLock::new(None),
            shutdown: tokio::sync::Notify::new(),
            state_dir: std::sync::RwLock::new(None),
            account_configuration_lock: std::sync::Mutex::new(()),
            admission: crate::admission::AdmissionScheduler::default(),
        }
    }

    pub fn with_identity_and_timers(
        registry: CollectionRegistry,
        watcher: CollectionWatchService,
        cloud: Option<CloudControlClient>,
        relay_identity: RelayIdentity,
        runtime_timers: RuntimeTimerHandle,
        credential_store_error: Option<String>,
    ) -> Self {
        let mut state = Self::with_identity(registry, watcher, cloud, relay_identity);
        state.runtime_timers = Some(runtime_timers);
        state.credential_store_error = credential_store_error;
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

    pub(super) fn credential_store_unavailable(&self) -> Option<ConnectError> {
        self.credential_store_error
            .as_ref()
            .map(|message| ConnectError::CredentialStore(message.clone()))
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
            && (self.registry.list_grants().is_ok_and(|grants| {
                grants
                    .iter()
                    .any(|grant| grant.application_origin == origin && grant.encryption.is_some())
            }) || self.registry.replay_origin_allowed(origin).unwrap_or(false))
    }

    pub(crate) fn admission(&self) -> &crate::admission::AdmissionScheduler {
        &self.admission
    }
}

fn requirements_can_be_provisioned(
    requirements: &mdbase_connect_protocol::ApplicationRequirements,
    provisions: &mdbase_connect_protocol::ApplicationProvisions,
    available: &[mdbase_connect_protocol::CollectionContractDescriptor],
) -> bool {
    requirements.contracts.iter().all(|required| {
        available.iter().any(|contract| {
            contract.id == required.id
                && contract.version == required.version
                && contract.digest == required.digest
        }) || provisions
            .type_packs
            .iter()
            .any(|provision| provision.provides.contains(required))
    })
}

fn approval_type_candidate(
    mut descriptor: mdbase_connect_protocol::CollectionTypeDescriptor,
) -> Option<mdbase_connect_protocol::CollectionTypeDescriptor> {
    descriptor.revision.as_ref()?;
    descriptor.path = None;
    descriptor.definition = None;
    descriptor.collection = None;
    descriptor.lifecycle = None;
    descriptor.extensions.clear();
    Some(descriptor)
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

fn encrypted_rejection(protocol_version: u32, request_id: uuid::Uuid) -> RelayMessage {
    RelayMessage::EncryptedOperationRejected {
        protocol_version,
        request_id,
        problem: ConnectProblem::new(
            "encrypted_relay_rejected",
            "Encrypted relay request was rejected.",
        )
        .with_operation_outcome(ConnectOperationOutcome::Rejected),
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
    let mut shutdown_after_response = false;
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
            Ok(request) => {
                shutdown_after_response = matches!(
                    &request.command,
                    ControlCommand::DaemonShutdown
                        | ControlCommand::AccountConfigure(_)
                        | ControlCommand::AccountClear
                );
                state.execute(request).await
            }
            Err(error) => ControlResponse::failure(
                uuid::Uuid::nil(),
                "invalid_request",
                format!("Invalid control request: {error}"),
            ),
        }
    };
    let mut encoded = serde_json::to_vec(&response).map_err(io::Error::other)?;
    encoded.push(b'\n');
    let delivery = async {
        writer.write_all(&encoded).await?;
        writer.shutdown().await
    }
    .await;
    if shutdown_after_response && response.ok {
        state.request_shutdown();
    }
    delivery
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
mod tests;

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
