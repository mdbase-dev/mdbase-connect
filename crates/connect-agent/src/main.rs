mod cloud;
mod loopback;
mod relay;
mod runtime_notifications;
mod server;
mod watcher;

use clap::Parser;
use cloud::CloudControlClient;
use mdbase_connect_core::{default_control_endpoint, default_state_dir, CollectionRegistry};
use mdbase_connect_protocol::crypto::RelayIdentity;
use mdbase_connect_protocol::DEFAULT_LOOPBACK_PORT;
use server::AgentState;
use std::path::PathBuf;
use std::sync::Arc;
use tracing_subscriber::EnvFilter;
use watcher::CollectionWatchService;

#[derive(Debug, Parser)]
#[command(name = "mdbase-connect-agent")]
#[command(about = "Local mdbase connect agent")]
struct Args {
    /// Override the per-user connector state directory.
    #[arg(long, env = "MDBASE_CONNECT_HOME")]
    state_dir: Option<PathBuf>,

    /// Override the Unix socket path or Windows named pipe.
    #[arg(long, env = "MDBASE_CONNECT_SOCKET")]
    endpoint: Option<String>,

    /// Hosted or self-hosted mdbase connect server URL.
    #[arg(long, env = "MDBASE_CONNECT_SERVER_URL")]
    server_url: Option<String>,

    /// One-time connector credential created in the user portal.
    #[arg(long, env = "MDBASE_CONNECT_CONNECTOR_TOKEN")]
    connector_token: Option<String>,

    /// Browser-facing direct collection API port, bound only to loopback.
    #[arg(long, env = "MDBASE_CONNECT_LOOPBACK_PORT", default_value_t = DEFAULT_LOOPBACK_PORT)]
    loopback_port: u16,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .compact()
        .init();

    let args = Args::parse();
    let state_dir = args.state_dir.map(Ok).unwrap_or_else(default_state_dir)?;
    let endpoint = args
        .endpoint
        .unwrap_or_else(|| default_control_endpoint(&state_dir));
    let registry = CollectionRegistry::open(&state_dir)?;
    let relay_identity = RelayIdentity::load_or_create(&state_dir)?;
    let cloud = match (args.server_url.clone(), args.connector_token.clone()) {
        (Some(server_url), Some(connector_token)) => {
            Some(CloudControlClient::new(server_url, connector_token))
        }
        (None, None) => None,
        _ => {
            return Err(
                "Both --server-url and --connector-token are required for cloud relay".into(),
            )
        }
    };
    let (runtime_events, runtime_event_rx) = tokio::sync::mpsc::unbounded_channel();
    let watcher =
        CollectionWatchService::start_with_runtime_events(registry.clone(), Some(runtime_events));
    let _runtime_notifications = runtime_notifications::start(
        &state_dir,
        registry.clone(),
        cloud.clone(),
        runtime_event_rx,
    );
    let state = Arc::new(AgentState::with_identity(
        registry.clone(),
        watcher.clone(),
        cloud,
        relay_identity,
    ));
    let relay = match (args.server_url, args.connector_token) {
        (Some(server_url), Some(connector_token)) => Some((server_url, connector_token)),
        (None, None) => None,
        _ => unreachable!("cloud arguments were validated above"),
    };
    let initialization_state = state.clone();
    let relay_state = state.clone();
    tracing::info!(%endpoint, state_dir = %state_dir.display(), "starting local connector agent");
    let loopback = loopback::start(args.loopback_port, state.clone()).await?;
    state.set_loopback_port(loopback.port());
    let result = server::serve(&endpoint, state, move || {
        let (initialized, initialization_complete) = tokio::sync::oneshot::channel();
        tokio::task::spawn_blocking(move || {
            match registry.list() {
                Ok(collections) => watcher.refresh(&collections),
                Err(error) => tracing::error!(%error, "failed to initialize collection watchers"),
            }
            initialization_state.mark_initialized();
            let _ = initialized.send(());
        });
        if let Some((server_url, connector_token)) = relay {
            tokio::spawn(async move {
                let _ = initialization_complete.await;
                relay::run(server_url, connector_token, relay_state).await;
            });
        }
    })
    .await;
    loopback.stop();
    result?;
    Ok(())
}
