use std::{net::IpAddr, time::Duration};

use clap::Parser;
use mdbase_connect_hosted_provider::{
    app, AppState, HostedProvider, ProviderCrypto, ProviderLimits,
};
use tokio::{net::TcpListener, signal};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(name = "mdbase-connect-hosted-provider")]
struct Arguments {
    #[arg(long, env = "DATABASE_URL")]
    database_url: String,
    #[arg(long, env = "MDBASE_CONNECT_HOSTED_PROVIDER_INTERNAL_TOKEN")]
    internal_token: String,
    #[arg(long, env = "MDBASE_CONNECT_HOSTED_PROVIDER_MASTER_KEY")]
    master_key: String,
    #[arg(long, env = "MDBASE_CONNECT_HOSTED_PROVIDER_ALLOWED_ORIGINS")]
    allowed_origins: String,
    #[arg(long, env = "HOST", default_value = "127.0.0.1")]
    host: IpAddr,
    #[arg(long, env = "PORT", default_value_t = 8790)]
    port: u16,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_MAX_RECORDS_PER_COLLECTION",
        default_value_t = 100_000
    )]
    max_records_per_collection: u64,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_MAX_BYTES_PER_COLLECTION",
        default_value_t = 1_073_741_824
    )]
    max_bytes_per_collection: u64,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_MAX_BYTES_PER_DOCUMENT",
        default_value_t = 2_097_152
    )]
    max_bytes_per_document: u64,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_MAX_REPLICAS_PER_COLLECTION",
        default_value_t = 100
    )]
    max_replicas_per_collection: u64,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_RETAIN_CHANGES",
        default_value_t = 100_000
    )]
    retain_changes: u64,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_MAINTENANCE_INTERVAL_SECONDS",
        default_value_t = 300
    )]
    maintenance_interval_seconds: u64,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments = Arguments::parse();
    if arguments.maintenance_interval_seconds == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "hosted maintenance interval must be greater than zero",
        )
        .into());
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let crypto = ProviderCrypto::from_base64(&arguments.master_key)?;
    let limits = ProviderLimits {
        max_records_per_collection: arguments.max_records_per_collection,
        max_bytes_per_collection: arguments.max_bytes_per_collection,
        max_bytes_per_document: arguments.max_bytes_per_document,
        max_replicas_per_collection: arguments.max_replicas_per_collection,
    };
    let provider = HostedProvider::connect(&arguments.database_url, crypto, limits).await?;
    let allowed_origins = arguments
        .allowed_origins
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let state = AppState::new(provider.clone(), &arguments.internal_token, allowed_origins)?;
    let maintenance = tokio::spawn(maintain_history(
        provider,
        arguments.retain_changes,
        Duration::from_secs(arguments.maintenance_interval_seconds),
    ));
    let listener = TcpListener::bind((arguments.host, arguments.port)).await?;
    let address = listener.local_addr()?;
    println!("HOSTED_PROVIDER_LISTENING=http://{address}");
    tracing::info!(%address, "hosted provider listening");

    let result = axum::serve(listener, app(state))
        .with_graceful_shutdown(shutdown_signal())
        .await;
    maintenance.abort();
    let _ = maintenance.await;
    result?;
    Ok(())
}

async fn maintain_history(provider: HostedProvider, retain_changes: u64, period: Duration) {
    let mut interval = tokio::time::interval(period);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        match provider.compact_stale_history(retain_changes).await {
            Ok(0) => {}
            Ok(collections) => {
                tracing::info!(collections, retain_changes, "compacted hosted history")
            }
            Err(error) => tracing::error!(%error, "hosted history maintenance failed"),
        }
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("SIGTERM handler can be installed");
        tokio::select! {
            _ = signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = signal::ctrl_c().await;
    tracing::info!("shutdown requested");
    tokio::time::sleep(Duration::from_millis(10)).await;
}
