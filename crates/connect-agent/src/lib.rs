pub(crate) mod admission;
mod bootstrap;
mod cloud;
mod loopback;
mod mirrors;
mod operation_executor;
mod relay;
mod runtime_notifications;
mod server;
#[cfg(test)]
mod test_support;
mod watcher;

use bootstrap::{bounded_secret_bootstrap, SecretBootstrap};
use cloud::CloudControlClient;
use fs2::FileExt;
use mdbase_connect_core::{default_control_endpoint, default_state_dir, CollectionRegistry};
use mdbase_connect_protocol::crypto::RelayIdentity;
use mdbase_connect_protocol::DEFAULT_LOOPBACK_PORT;
use server::AgentState;
use std::path::PathBuf;
use std::sync::Arc;
use tracing_subscriber::EnvFilter;
use watcher::CollectionWatchService;

pub(crate) fn ensure_tls_crypto_provider() {
    // Respect an embedding application's earlier choice. Otherwise select the
    // one provider used by every mdbase binary and dependency graph.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    }
}

/// Configuration for one foreground Connect daemon process.
///
/// Service managers and embedding shells construct this value without putting
/// credentials in process arguments. Test harnesses may inject a credential
/// through the process environment; normal runs load it from the OS store.
#[derive(Clone, Default)]
pub struct DaemonOptions {
    pub state_dir: Option<PathBuf>,
    pub endpoint: Option<String>,
    pub server_url: Option<String>,
    pub connector_token: Option<String>,
    pub loopback_port: Option<u16>,
    /// In-memory identity injection for embedding shells and hermetic tests.
    /// Normal daemon processes leave this unset and use the OS secret store.
    pub relay_identity: Option<RelayIdentity>,
}

impl DaemonOptions {
    pub fn state_dir(&self) -> Result<PathBuf, mdbase_connect_core::ConnectError> {
        let path = self
            .state_dir
            .clone()
            .map(Ok)
            .unwrap_or_else(default_state_dir)?;
        std::path::absolute(path).map_err(mdbase_connect_core::ConnectError::Io)
    }
}

/// Run the local Connect daemon in the foreground until it receives an
/// operating-system termination signal.
pub async fn run(options: DaemonOptions) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    initialize_tracing();

    let state_dir = options.state_dir()?;
    let _daemon_lease = DaemonLease::acquire(&state_dir)?;
    let endpoint = options
        .endpoint
        .clone()
        .unwrap_or_else(|| default_control_endpoint(&state_dir));
    let secret_bootstrap = bounded_secret_bootstrap(
        state_dir.clone(),
        options.server_url,
        options.connector_token,
        options.relay_identity,
    )?;
    let (server_url, connector_token, relay_identity, credential_store_error) =
        match secret_bootstrap {
            SecretBootstrap::Available {
                server_url,
                connector_token,
                relay_identity,
            } => (server_url, connector_token, relay_identity, None),
            SecretBootstrap::Unavailable(message) => {
                tracing::warn!(
                    error_code = "credential_store_unavailable",
                    %message,
                    "starting local control without cloud or direct access; restart after unlocking the credential store"
                );
                (None, None, RelayIdentity::generate(), Some(message))
            }
        };
    let registry = match CollectionRegistry::open(&state_dir) {
        Ok(registry) => registry,
        Err(error) => {
            tracing::error!(
                target: "mdbase_connect::metrics",
                metric = "registry_open_failure",
                error_code = error.code(),
                "privacy-safe connector metric"
            );
            return Err(error.into());
        }
    };
    let schema_version = registry.schema_version()?;
    let journal = registry.mutation_journal_diagnostics()?;
    tracing::info!(
        target: "mdbase_connect::metrics",
        metric = "mutation_journal_snapshot",
        schema_version,
        state_counts = ?journal.state_counts,
        oldest_unresolved_age_ms = ?journal.oldest_unresolved_age_ms,
        live_leases = journal.live_leases,
        stale_leases = journal.stale_leases,
        tombstones = journal.tombstones,
        "privacy-safe connector metric"
    );
    let cloud = match (server_url.clone(), connector_token.clone()) {
        (Some(server_url), Some(connector_token)) => {
            Some(CloudControlClient::new(server_url, connector_token))
        }
        (None, None) => None,
        _ => {
            return Err(
                "Both server URL and connector credential are required for cloud relay".into(),
            )
        }
    };
    let (runtime_events, runtime_event_rx) = tokio::sync::mpsc::unbounded_channel();
    let watcher =
        CollectionWatchService::start_with_runtime_events(registry.clone(), Some(runtime_events));
    let (runtime_timers, runtime_worker) = runtime_notifications::start(
        &state_dir,
        registry.clone(),
        cloud.clone(),
        runtime_event_rx,
    );
    let state = Arc::new(AgentState::with_identity_and_timers(
        registry.clone(),
        watcher.clone(),
        cloud.clone(),
        relay_identity,
        runtime_timers,
        credential_store_error.clone(),
    ));
    state.set_state_dir(state_dir.clone());
    let mirror_manager = mirrors::MirrorManager::open(
        &state_dir,
        registry.clone(),
        cloud.clone(),
        credential_store_error.clone(),
    )?;
    state.set_mirror_manager(mirror_manager.clone());
    let mirror_worker = mirror_manager.start();
    let relay = match (server_url, connector_token) {
        (Some(server_url), Some(connector_token)) => Some((server_url, connector_token)),
        (None, None) => None,
        _ => unreachable!("cloud arguments were validated above"),
    };
    let initialization_state = state.clone();
    let relay_state = state.clone();
    let initialization_worker = Arc::new(std::sync::Mutex::new(None));
    let initialization_worker_on_listening = initialization_worker.clone();
    tracing::info!(%endpoint, state_dir = %state_dir.display(), "starting local connector daemon");
    let loopback = if credential_store_error.is_none() {
        let loopback = loopback::start(
            options.loopback_port.unwrap_or(DEFAULT_LOOPBACK_PORT),
            state.clone(),
        )
        .await?;
        state.set_loopback_port(loopback.port());
        Some(loopback)
    } else {
        state.set_connection_state(mdbase_connect_protocol::AgentConnectionState::Offline);
        None
    };
    let result = server::serve(&endpoint, state, move || {
        let worker = tokio::spawn(async move {
            match registry.list() {
                Ok(collections) => {
                    watcher.refresh(&collections);
                    match registry.runtime_residency_diagnostics() {
                        Ok(residency) => tracing::info!(
                            target: "mdbase_connect::metrics",
                            metric = "runtime_residency_snapshot",
                            capacity = residency.capacity,
                            resident = residency.resident,
                            active = residency.active,
                            idle = residency.idle,
                            loaded_type_definitions = residency.loaded_type_definitions,
                            active_read_snapshots = residency.active_read_snapshots,
                            retained_read_snapshot_bytes = residency.retained_read_snapshot_bytes,
                            "privacy-safe connector metric"
                        ),
                        Err(error) => tracing::warn!(
                            code = error.code(),
                            %error,
                            "runtime residency diagnostics unavailable"
                        ),
                    }
                }
                Err(error) => tracing::error!(%error, "failed to initialize collection runtimes"),
            }
            initialization_state.mark_initialized();
            if let Some((server_url, connector_token)) = relay {
                relay::run(server_url, connector_token, relay_state).await;
            }
        });
        *initialization_worker_on_listening
            .lock()
            .expect("initialization worker lock poisoned") = Some(worker);
    })
    .await;
    mirror_worker.abort();
    let _ = mirror_worker.await;
    runtime_worker.abort();
    let _ = runtime_worker.await;
    let initialization_worker = {
        initialization_worker
            .lock()
            .expect("initialization worker lock poisoned")
            .take()
    };
    if let Some(worker) = initialization_worker {
        worker.abort();
        let _ = worker.await;
    }
    if let Some(loopback) = loopback {
        loopback.stop().await;
    }
    result?;
    Ok(())
}

fn initialize_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .compact()
        .try_init();
}

struct DaemonLease {
    file: std::fs::File,
}

impl DaemonLease {
    fn acquire(
        state_dir: &std::path::Path,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        std::fs::create_dir_all(state_dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(state_dir, std::fs::Permissions::from_mode(0o700))?;
        }
        let path = state_dir.join("daemon.lock");
        let file = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&path)?;
        file.try_lock_exclusive()
            .map_err(|_| "another mdbase connect daemon is already running")?;
        Ok(Self { file })
    }
}

impl Drop for DaemonLease {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use mdbase_connect_protocol::{ControlCommand, ControlRequest, ControlResponse};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[tokio::test]
    async fn one_daemon_owns_the_state_and_shutdown_is_graceful() {
        let temporary = tempfile::tempdir().unwrap();
        let state_dir = temporary.path().join("state");
        let endpoint = temporary.path().join("agent.sock");
        let options = DaemonOptions {
            state_dir: Some(state_dir),
            endpoint: Some(endpoint.to_string_lossy().to_string()),
            loopback_port: Some(0),
            relay_identity: Some(RelayIdentity::generate()),
            ..DaemonOptions::default()
        };
        let mut running = tokio::spawn(run(options.clone()));
        let listening = async {
            loop {
                if tokio::net::UnixStream::connect(&endpoint).await.is_ok() {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        };
        tokio::select! {
            result = &mut running => panic!("daemon exited before creating its control socket: {result:?}"),
            result = tokio::time::timeout(std::time::Duration::from_secs(10), listening) => {
                result.expect("daemon never created its control socket");
            }
        };

        let duplicate = run(options).await.unwrap_err();
        assert!(duplicate
            .to_string()
            .contains("another mdbase connect daemon"));

        let mut stream = tokio::net::UnixStream::connect(&endpoint).await.unwrap();
        let request = ControlRequest::new(ControlCommand::DaemonShutdown);
        stream
            .write_all(format!("{}\n", serde_json::to_string(&request).unwrap()).as_bytes())
            .await
            .unwrap();
        let mut response = String::new();
        BufReader::new(stream)
            .read_line(&mut response)
            .await
            .unwrap();
        let response: ControlResponse = serde_json::from_str(&response).unwrap();
        assert!(response.ok);
        tokio::time::timeout(std::time::Duration::from_secs(5), running)
            .await
            .expect("daemon did not stop")
            .unwrap()
            .unwrap();
        assert!(!endpoint.exists());
    }
}
