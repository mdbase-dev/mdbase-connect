use std::{net::IpAddr, sync::Arc, time::Duration};

use axum::{http::StatusCode, response::IntoResponse, routing::get, Json, Router};
use clap::{Parser, ValueEnum};
use mdbase_connect_hosted_provider::{
    app, ApiResult, AppState, CollaborationLimits, HostedNotificationConfig, HostedProvider,
    KeyWrappingBackend, KeyWrappingConfig, ProviderCrypto, ProviderLimits, R2BlobStore, R2Config,
    R2InsecureHttpConfig,
};
use tokio::{net::TcpListener, signal};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(name = "mdbase-connect-hosted-provider")]
struct Arguments {
    /// Start an inert health-observable service that never connects to storage.
    /// Used only to pre-provision a blue/green cutover target.
    #[arg(long, env = "MDBASE_CONNECT_CUTOVER_HOLD", default_value_t = false)]
    cutover_hold: bool,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_KEY_WRAPPER",
        value_enum,
        default_value = "local"
    )]
    key_wrapper: KeyWrapperBackend,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_KEY_ENVIRONMENT",
        default_value = "local"
    )]
    key_environment: String,
    #[arg(long, env = "MDBASE_CONNECT_HOSTED_KMS_KEY_ID")]
    kms_key_id: Option<String>,
    #[arg(long, env = "MDBASE_CONNECT_HOSTED_KMS_REGION")]
    kms_region: Option<String>,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_KMS_MAX_ATTEMPTS",
        default_value_t = 3
    )]
    kms_max_attempts: u32,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_KMS_TIMEOUT_SECONDS",
        default_value_t = 5
    )]
    kms_timeout_seconds: u64,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_KEY_CACHE_ENTRIES",
        default_value_t = 1_024
    )]
    key_cache_entries: usize,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_KEY_CACHE_TTL_SECONDS",
        default_value_t = 300
    )]
    key_cache_ttl_seconds: u64,
    #[arg(long, env = "MDBASE_CONNECT_CONTROL_PLANE_URL")]
    control_plane_url: Option<String>,
    #[arg(long, env = "HOST", default_value = "127.0.0.1")]
    host: IpAddr,
    #[arg(long, env = "PORT", default_value_t = 8790)]
    port: u16,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_COLLABORATION_ENABLED",
        default_value_t = false
    )]
    hosted_collaboration_enabled: bool,
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
        env = "MDBASE_CONNECT_HOSTED_COLLAB_MAX_UPDATE_BYTES",
        default_value_t = 262_144
    )]
    collaboration_max_update_bytes: u64,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_COLLAB_MAX_SNAPSHOT_BYTES",
        default_value_t = 4_194_304
    )]
    collaboration_max_snapshot_bytes: u64,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_COLLAB_MAX_DOCUMENT_BYTES",
        default_value_t = 2_097_152
    )]
    collaboration_max_document_bytes: u64,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_COLLAB_MAX_RETAINED_UPDATES",
        default_value_t = 10_000
    )]
    collaboration_max_retained_updates: u64,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_COLLAB_MAX_RETAINED_UPDATE_BYTES",
        default_value_t = 67_108_864
    )]
    collaboration_max_retained_update_bytes: u64,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_COLLAB_TICKET_TTL_SECONDS",
        default_value_t = 30
    )]
    collaboration_ticket_ttl_seconds: u64,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_COLLAB_COMPACTION_THRESHOLD",
        default_value_t = 100
    )]
    collaboration_compaction_threshold: u64,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_MAX_MIRROR_REPLICAS_PER_COLLECTION",
        default_value_t = 100
    )]
    max_mirror_replicas_per_collection: u64,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_MAX_APPLICATION_REPLICAS_PER_COLLECTION",
        default_value_t = 100
    )]
    max_application_replicas_per_collection: u64,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_MAX_FILES_PER_COLLECTION",
        default_value_t = 10_000
    )]
    max_files_per_collection: u64,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_MAX_FILE_BYTES_PER_COLLECTION",
        default_value_t = 5_368_709_120
    )]
    max_file_bytes_per_collection: u64,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_MAX_STORED_FILE_BYTES_PER_COLLECTION",
        default_value_t = 10_737_418_240
    )]
    max_stored_file_bytes_per_collection: u64,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_MAX_FILE_BYTES",
        default_value_t = 1_073_741_824
    )]
    max_bytes_per_file: u64,
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
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_PROJECTION_RECOVERY_INTERVAL_SECONDS",
        default_value_t = 1
    )]
    projection_recovery_interval_seconds: u64,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_PROJECTION_RECOVERY_ROUNDS",
        default_value_t = 100
    )]
    projection_recovery_rounds: u32,
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_NOTIFICATION_INTERVAL_SECONDS",
        default_value_t = 5
    )]
    notification_interval_seconds: u64,
    #[arg(long, env = "MDBASE_CONNECT_R2_ENDPOINT")]
    r2_endpoint: String,
    #[arg(long, env = "MDBASE_CONNECT_R2_BUCKET")]
    r2_bucket: String,
    #[arg(
        long,
        env = "MDBASE_CONNECT_R2_MULTIPART_PART_BYTES",
        default_value_t = 8_388_608
    )]
    r2_multipart_part_bytes: u64,
    #[arg(
        long,
        env = "MDBASE_CONNECT_R2_DOWNLOAD_PART_BYTES",
        default_value_t = 8_388_608
    )]
    r2_download_part_bytes: u64,
    #[arg(
        long,
        env = "MDBASE_CONNECT_R2_PRESIGN_TTL_SECONDS",
        default_value_t = 900
    )]
    r2_presign_ttl_seconds: u64,
    #[arg(
        long,
        env = "MDBASE_CONNECT_ALLOW_INSECURE_R2",
        default_value_t = false
    )]
    allow_insecure_r2: bool,
    #[arg(long, env = "MDBASE_CONNECT_INSECURE_R2_HOSTS", value_delimiter = ',')]
    insecure_r2_hosts: Vec<String>,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
#[value(rename_all = "kebab-case")]
enum KeyWrapperBackend {
    Local,
    AwsKms,
}

struct RuntimeSecrets {
    database_url: String,
    internal_token: String,
    master_key: Option<String>,
    r2_access_key_id: String,
    r2_secret_access_key: String,
    r2_session_token: Option<String>,
}

impl RuntimeSecrets {
    fn from_environment() -> Result<Self, std::io::Error> {
        Ok(Self {
            database_url: required_environment("DATABASE_URL")?,
            internal_token: required_environment("MDBASE_CONNECT_HOSTED_PROVIDER_INTERNAL_TOKEN")?,
            master_key: optional_environment("MDBASE_CONNECT_HOSTED_PROVIDER_MASTER_KEY")?,
            r2_access_key_id: required_environment("MDBASE_CONNECT_R2_ACCESS_KEY_ID")?,
            r2_secret_access_key: required_environment("MDBASE_CONNECT_R2_SECRET_ACCESS_KEY")?,
            r2_session_token: optional_environment("MDBASE_CONNECT_R2_SESSION_TOKEN")?,
        })
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .expect("the TLS crypto provider must be installed before starting the hosted provider");
    let arguments = Arguments::parse();
    let collaboration_limits = CollaborationLimits {
        max_update_bytes: arguments.collaboration_max_update_bytes,
        max_snapshot_bytes: arguments.collaboration_max_snapshot_bytes,
        max_document_bytes: arguments.collaboration_max_document_bytes,
        max_retained_updates: arguments.collaboration_max_retained_updates,
        max_retained_update_bytes: arguments.collaboration_max_retained_update_bytes,
        ticket_ttl_seconds: arguments.collaboration_ticket_ttl_seconds,
        compaction_threshold: arguments.collaboration_compaction_threshold,
    }
    .validate()
    .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidInput, message))?;
    if arguments.maintenance_interval_seconds == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "hosted maintenance interval must be greater than zero",
        )
        .into());
    }
    if arguments.projection_recovery_interval_seconds == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "projection recovery interval must be greater than zero",
        )
        .into());
    }
    if arguments.projection_recovery_rounds == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "projection recovery rounds must be greater than zero",
        )
        .into());
    }
    if arguments.notification_interval_seconds == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "hosted notification interval must be greater than zero",
        )
        .into());
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();
    if arguments.cutover_hold {
        return serve_cutover_hold(arguments.host, arguments.port).await;
    }
    let mut secrets = RuntimeSecrets::from_environment()?;

    let crypto = provider_crypto(&arguments, secrets.master_key.take()).await?;
    let limits = ProviderLimits {
        hosted_collaboration_enabled: arguments.hosted_collaboration_enabled,
        max_records_per_collection: arguments.max_records_per_collection,
        max_bytes_per_collection: arguments.max_bytes_per_collection,
        max_bytes_per_document: arguments.max_bytes_per_document,
        max_mirror_replicas_per_collection: arguments.max_mirror_replicas_per_collection,
        max_application_replicas_per_collection: arguments.max_application_replicas_per_collection,
        max_files_per_collection: arguments.max_files_per_collection,
        max_file_bytes_per_collection: arguments.max_file_bytes_per_collection,
        max_stored_file_bytes_per_collection: arguments.max_stored_file_bytes_per_collection,
        max_bytes_per_file: arguments.max_bytes_per_file,
        max_collaboration_bytes_per_collection: ProviderLimits::default()
            .max_collaboration_bytes_per_collection,
        max_collaboration_bytes_per_account: ProviderLimits::default()
            .max_collaboration_bytes_per_account,
        collaboration: collaboration_limits,
    };
    let notification_config =
        arguments
            .control_plane_url
            .map(|control_plane_url| HostedNotificationConfig {
                control_plane_url,
                internal_token: secrets.internal_token.clone(),
            });
    let r2_config = if arguments.allow_insecure_r2 {
        R2Config::new_insecure_http(R2InsecureHttpConfig {
            endpoint: arguments.r2_endpoint,
            bucket: arguments.r2_bucket,
            access_key_id: secrets.r2_access_key_id,
            secret_access_key: secrets.r2_secret_access_key,
            multipart_part_bytes: arguments.r2_multipart_part_bytes,
            download_part_bytes: arguments.r2_download_part_bytes,
            presign_ttl: Duration::from_secs(arguments.r2_presign_ttl_seconds),
            insecure_http_hosts: arguments.insecure_r2_hosts,
        })?
    } else {
        R2Config::new(
            arguments.r2_endpoint,
            arguments.r2_bucket,
            secrets.r2_access_key_id,
            secrets.r2_secret_access_key,
            arguments.r2_multipart_part_bytes,
            arguments.r2_download_part_bytes,
            Duration::from_secs(arguments.r2_presign_ttl_seconds),
        )?
    }
    .with_session_token(secrets.r2_session_token)?;
    let blob_store = Arc::new(R2BlobStore::new(r2_config));
    let provider = HostedProvider::connect(
        &secrets.database_url,
        crypto,
        limits,
        blob_store,
        notification_config,
    )
    .await?;
    let startup_recovery = advance_projection_recovery(&provider, 4).await?;
    if startup_recovery.advanced > 0 {
        tracing::info!(
            recovered_generations = startup_recovery.advanced,
            recovery_complete = startup_recovery.quiet,
            "advanced hosted semantic projection rebuilds before readiness"
        );
    }
    let state = AppState::new(provider.clone(), &secrets.internal_token)?;
    // Fail-closed wake listener startup: when collaboration is enabled the
    // PostgreSQL LISTEN subscription must come up or the provider refuses to
    // serve. Disabled mode starts nothing.
    state.start_collaboration_wake_runtime().await?;
    let maintenance = tokio::spawn(maintain_history(
        provider.clone(),
        arguments.retain_changes,
        Duration::from_secs(arguments.maintenance_interval_seconds),
    ));
    let projection_recovery = tokio::spawn(maintain_projections(
        provider.clone(),
        Duration::from_secs(arguments.projection_recovery_interval_seconds),
        arguments.projection_recovery_rounds,
    ));
    let notification_recovery = tokio::spawn(maintain_notifications(
        provider,
        Duration::from_secs(arguments.notification_interval_seconds),
    ));
    let listener = TcpListener::bind((arguments.host, arguments.port)).await?;
    let address = listener.local_addr()?;
    println!("HOSTED_PROVIDER_LISTENING=http://{address}");
    tracing::info!(%address, "hosted provider listening");

    let result = axum::serve(listener, app(state.clone()))
        .with_graceful_shutdown(collaboration_drain_shutdown(state.clone()))
        .await;
    // Also cover listener/server failures that return without the signal
    // future completing. Do not grant a second budget after a signal-driven
    // drain already exhausted its end-to-end deadline.
    let server_failed_before_drain = state.collaboration_sessions_accepting();
    state.begin_collaboration_session_drain();
    let final_drain_budget = if server_failed_before_drain {
        Duration::from_secs(10)
    } else {
        Duration::ZERO
    };
    if !state
        .finish_collaboration_session_drain(final_drain_budget)
        .await
    {
        tracing::warn!("collaboration sessions did not drain after server exit");
    }
    if !state
        .stop_collaboration_wake_runtime(Duration::from_secs(10))
        .await
    {
        tracing::warn!("collaboration wake listener did not stop within its shutdown budget");
    }
    maintenance.abort();
    let _ = maintenance.await;
    projection_recovery.abort();
    let _ = projection_recovery.await;
    notification_recovery.abort();
    let _ = notification_recovery.await;
    result?;
    Ok(())
}

async fn serve_cutover_hold(host: IpAddr, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let router = Router::new()
        .route("/health", get(cutover_hold_health))
        .route("/ready", get(cutover_hold_health))
        .fallback(cutover_hold_unavailable);
    let listener = TcpListener::bind((host, port)).await?;
    let address = listener.local_addr()?;
    println!("HOSTED_PROVIDER_CUTOVER_HOLD=http://{address}");
    tracing::warn!(%address, "hosted provider is serving the inert cutover hold");
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn cutover_hold_health() -> Json<serde_json::Value> {
    Json(serde_json::json!({"status": "ok", "mode": "cutover_hold"}))
}

async fn cutover_hold_unavailable() -> impl IntoResponse {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({
            "error": {
                "code": "hosted_provider_cutover_hold",
                "message": "Hosted provider admission is closed for a controlled cutover."
            }
        })),
    )
}

async fn provider_crypto(
    arguments: &Arguments,
    legacy_master_key: Option<String>,
) -> Result<ProviderCrypto, Box<dyn std::error::Error>> {
    let environment = arguments.key_environment.clone();
    let runtime = KeyWrappingConfig {
        backend: match arguments.key_wrapper {
            KeyWrapperBackend::Local => KeyWrappingBackend::Local,
            KeyWrapperBackend::AwsKms => KeyWrappingBackend::AwsKms,
        },
        environment: environment.clone(),
        legacy_master_key,
        kms_key_id: arguments.kms_key_id.clone(),
        kms_region: arguments.kms_region.clone(),
        kms_max_attempts: arguments.kms_max_attempts,
        kms_timeout: Duration::from_secs(arguments.kms_timeout_seconds),
        cache_entries: arguments.key_cache_entries,
        cache_ttl: Duration::from_secs(arguments.key_cache_ttl_seconds),
    }
    .build()
    .await?;
    Ok(ProviderCrypto::with_key_wrapping(runtime, environment)?)
}

fn required_environment(name: &'static str) -> Result<String, std::io::Error> {
    optional_environment(name)?.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("required environment variable {name} is missing or empty"),
        )
    })
}

fn optional_environment(name: &'static str) -> Result<Option<String>, std::io::Error> {
    match std::env::var(name) {
        Ok(value) if value.trim().is_empty() => Ok(None),
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("environment variable {name} is not valid Unicode"),
        )),
    }
}

async fn maintain_history(provider: HostedProvider, retain_changes: u64, period: Duration) {
    let mut interval = tokio::time::interval(period);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        provider.log_operation_mutation_metrics().await;
        match provider.compact_stale_history(retain_changes).await {
            Ok(0) => {}
            Ok(collections) => {
                tracing::info!(collections, retain_changes, "compacted hosted history")
            }
            Err(error) => tracing::error!(%error, "hosted history maintenance failed"),
        }
        match provider.recover_expired_authority_transfers().await {
            Ok(0) => {}
            Ok(transfers) => {
                tracing::warn!(
                    transfers,
                    "restored hosted authority after expired transfers"
                )
            }
            Err(error) => tracing::error!(%error, "authority transfer recovery failed"),
        }
        match provider.recover_expired_authority_imports().await {
            Ok(0) => {}
            Ok(imports) => tracing::warn!(imports, "removed expired authority imports"),
            Err(error) => tracing::error!(%error, "authority import recovery failed"),
        }
        match provider.recover_expired_file_transfers(500).await {
            Ok(0) => {}
            Ok(transfers) => tracing::warn!(transfers, "expired abandoned file transfers"),
            Err(error) => tracing::error!(%error, "file transfer recovery failed"),
        }
        match provider.delete_pending_blobs(500).await {
            Ok(0) => {}
            Ok(blobs) => tracing::info!(blobs, "deleted deferred hosted file objects"),
            Err(error) => tracing::error!(%error, "deferred hosted file deletion failed"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ProjectionRecoveryCycle {
    advanced: usize,
    quiet: bool,
}

async fn advance_projection_recovery(
    provider: &HostedProvider,
    max_rounds: u32,
) -> ApiResult<ProjectionRecoveryCycle> {
    let mut advanced = 0_usize;
    for _ in 0..max_rounds.max(1) {
        let current = provider.recover_projection_generations(20).await?;
        advanced = advanced.saturating_add(current);
        if current == 0 {
            return Ok(ProjectionRecoveryCycle {
                advanced,
                quiet: true,
            });
        }
        tokio::task::yield_now().await;
    }
    Ok(ProjectionRecoveryCycle {
        advanced,
        quiet: false,
    })
}

async fn maintain_projections(provider: HostedProvider, period: Duration, max_rounds: u32) {
    let mut interval = tokio::time::interval(period);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        match advance_projection_recovery(&provider, max_rounds).await {
            Ok(ProjectionRecoveryCycle { advanced: 0, .. }) => {}
            Ok(outcome) => tracing::info!(
                generations = outcome.advanced,
                recovery_complete = outcome.quiet,
                "advanced hosted semantic projection rebuilds"
            ),
            Err(error) => tracing::error!(%error, "semantic projection recovery failed"),
        }
    }
}

async fn maintain_notifications(provider: HostedProvider, period: Duration) {
    let mut interval = tokio::time::interval(period);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        if let Err(error) = provider.recover_notifications(1_000).await {
            tracing::warn!(
                error_code = %error.code,
                "hosted notification recovery deferred"
            );
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
}

/// The single shutdown signal drives collaboration drain before the Axum wait
/// finishes: new tickets/upgrades/updates are rejected, already-started update
/// batches finish, sockets receive close 1001, and every socket exits (bounded)
/// while `axum::serve` waits on this future. Wake runtime and maintenance tasks
/// are stopped afterwards in `main`.
async fn collaboration_drain_shutdown(state: AppState) {
    shutdown_signal().await;
    state.begin_collaboration_session_drain();
    if !state
        .finish_collaboration_session_drain(Duration::from_secs(10))
        .await
    {
        tracing::warn!("collaboration sessions did not drain within the shutdown budget");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cutover_hold_exposes_only_health_and_fail_closed_payloads() {
        assert_eq!(cutover_hold_health().await.0["mode"], "cutover_hold");
        assert_eq!(
            cutover_hold_unavailable().await.into_response().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
}
