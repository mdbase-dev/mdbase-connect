use std::{
    process::ExitCode,
    sync::Arc,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use clap::{Parser, Subcommand, ValueEnum};
use mdbase_connect_hosted_provider::{
    run_hosted_cutover_migrations, ApiError, ApiResult, BlobByteStream, BlobStore, HostedProvider,
    KeyWrappingBackend, KeyWrappingConfig, PresignedPart, ProviderCrypto, ProviderLimits,
    UploadedPart,
};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::{Connection, PgConnection};
use uuid::Uuid;

#[derive(Parser)]
#[command(name = "mdbase-hosted-projection-indexer")]
#[command(about = "Plan, apply, inspect, and verify the hosted semantic projection index")]
struct Arguments {
    #[arg(
        long,
        env = "MDBASE_CONNECT_HOSTED_KEY_WRAPPER",
        value_enum,
        default_value = "local"
    )]
    key_wrapper: KeyWrapperArgument,
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
        default_value_t = 10
    )]
    kms_timeout_seconds: u64,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
#[value(rename_all = "kebab-case")]
enum KeyWrapperArgument {
    Local,
    AwsKms,
}

#[derive(Subcommand)]
enum Command {
    Plan(PageArguments),
    Apply {
        #[command(flatten)]
        page: PageArguments,
        #[arg(long, default_value_t = 1, value_parser = clap::value_parser!(u32).range(1..=1000))]
        batches_per_collection: u32,
    },
    Status(PageArguments),
    Verify(PageArguments),
    /// Migrate, rebuild, and verify the complete active collection inventory.
    /// This is intended for a terminally suspended pre-deploy cutover job.
    Cutover(CutoverArguments),
}

#[derive(clap::Args)]
struct PageArguments {
    #[arg(long)]
    after: Option<Uuid>,
    #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u32).range(1..=1000))]
    limit: u32,
}

#[derive(clap::Args)]
struct CutoverArguments {
    /// Stable operation identity used for the cross-host PostgreSQL cutover lock.
    #[arg(long)]
    owner_token: Uuid,
    #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u32).range(1..=1000))]
    page_limit: u32,
    #[arg(long, default_value_t = 10_000, value_parser = clap::value_parser!(u32).range(1..=100_000))]
    batches_per_collection: u32,
    #[arg(long, default_value_t = 100_000, value_parser = clap::value_parser!(u32).range(1..=1_000_000))]
    max_collections: u32,
    #[arg(long, default_value_t = 1_000_000, value_parser = clap::value_parser!(u64).range(1..=10_000_000))]
    max_batches: u64,
    #[arg(long, default_value_t = 10_000, value_parser = clap::value_parser!(u32).range(1..=100_000))]
    max_pages: u32,
    #[arg(long, default_value_t = 3_600, value_parser = clap::value_parser!(u64).range(1..=86_400))]
    max_seconds: u64,
}

#[derive(Serialize)]
struct Envelope {
    ok: bool,
    command: &'static str,
    run_id: Uuid,
    recorded_at: String,
    result: Value,
}

#[tokio::main]
async fn main() -> ExitCode {
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .ok();
    match run(Arguments::parse()).await {
        Ok(output) => {
            println!(
                "{}",
                serde_json::to_string(&output).expect("indexer result serializes")
            );
            if output.ok {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(error) => {
            eprintln!(
                "{}",
                json!({
                    "ok": false,
                    "error": {"code": error.code, "message": error.message}
                })
            );
            ExitCode::FAILURE
        }
    }
}

async fn run(arguments: Arguments) -> ApiResult<Envelope> {
    let started = Instant::now();
    let cutover_budget = match &arguments.command {
        Command::Cutover(arguments) => Some(Duration::from_secs(arguments.max_seconds)),
        _ => None,
    };
    let run_id = Uuid::now_v7();
    let recorded_at = chrono::Utc::now().to_rfc3339();
    let database_url = required_environment("DATABASE_URL")?;
    let master_key = optional_environment("MDBASE_CONNECT_HOSTED_PROVIDER_MASTER_KEY")?;
    let environment = arguments.key_environment;
    let key_wrapping_future = KeyWrappingConfig {
        backend: match arguments.key_wrapper {
            KeyWrapperArgument::Local => KeyWrappingBackend::Local,
            KeyWrapperArgument::AwsKms => KeyWrappingBackend::AwsKms,
        },
        environment: environment.clone(),
        legacy_master_key: master_key,
        kms_key_id: arguments.kms_key_id,
        kms_region: arguments.kms_region,
        kms_max_attempts: arguments.kms_max_attempts,
        kms_timeout: Duration::from_secs(arguments.kms_timeout_seconds),
        cache_entries: 0,
        cache_ttl: Duration::ZERO,
    }
    .build();
    let key_wrapping = match cutover_budget {
        Some(budget) => {
            match tokio::time::timeout(remaining_cutover_time(started, budget), key_wrapping_future)
                .await
            {
                Ok(Ok(key_wrapping)) => key_wrapping,
                Ok(Err(error)) => {
                    return Ok(cutover_startup_failure(
                        run_id,
                        recorded_at,
                        "projection_cutover_key_configuration_failed",
                        "key_configuration",
                        Some(error.to_string()),
                    ));
                }
                Err(_) => {
                    return Ok(cutover_startup_failure(
                        run_id,
                        recorded_at,
                        "projection_cutover_time_budget_exceeded",
                        "key_configuration",
                        None,
                    ));
                }
            }
        }
        None => key_wrapping_future.await.map_err(|error| {
            ApiError::internal(format!(
                "Projection indexer key configuration failed: {error}"
            ))
        })?,
    };
    let crypto = ProviderCrypto::with_key_wrapping(key_wrapping, environment).map_err(|error| {
        ApiError::internal(format!("Projection indexer crypto failed: {error}"))
    })?;
    let mut cutover_lock = None;
    if let Command::Cutover(cutover) = &arguments.command {
        let lock_result = tokio::time::timeout(
            remaining_cutover_time(started, Duration::from_secs(cutover.max_seconds)),
            acquire_cutover_lock(&database_url, cutover.owner_token),
        )
        .await;
        cutover_lock = match lock_result {
            Ok(Ok(Some(lock))) => Some(lock),
            Ok(Ok(None)) => {
                return Ok(cutover_startup_failure(
                    run_id,
                    recorded_at,
                    "projection_cutover_lock_unavailable",
                    "global_lock",
                    None,
                ));
            }
            Ok(Err(error)) => {
                return Ok(cutover_startup_failure(
                    run_id,
                    recorded_at,
                    "projection_cutover_lock_failed",
                    "global_lock",
                    Some(error.message),
                ));
            }
            Err(_) => {
                return Ok(cutover_startup_failure(
                    run_id,
                    recorded_at,
                    "projection_cutover_time_budget_exceeded",
                    "global_lock",
                    None,
                ));
            }
        };
    }
    if let (Some(budget), Some(lock)) = (cutover_budget, cutover_lock.as_mut()) {
        let migration_result = tokio::time::timeout(
            remaining_cutover_time(started, budget),
            run_hosted_cutover_migrations(
                &mut lock.connection,
                remaining_cutover_time(started, budget),
            ),
        )
        .await;
        match migration_result {
            Ok(Ok(())) => {
                let owner_lease = Duration::from_secs(
                    arguments
                        .command
                        .cutover_max_seconds()
                        .unwrap_or(0)
                        .saturating_add(3_600)
                        .clamp(600, 86_400),
                );
                match claim_cutover_owner(
                    &mut lock.connection,
                    arguments
                        .command
                        .cutover_owner_token()
                        .expect("cutover token"),
                    owner_lease,
                )
                .await
                {
                    Ok(true) => {}
                    Ok(false) => {
                        return Ok(cutover_startup_failure(
                            run_id,
                            recorded_at,
                            "projection_cutover_owner_unavailable",
                            "durable_owner",
                            None,
                        ));
                    }
                    Err(error) => {
                        return Ok(cutover_startup_failure(
                            run_id,
                            recorded_at,
                            "projection_cutover_owner_failed",
                            "durable_owner",
                            Some(error.message),
                        ));
                    }
                }
            }
            Ok(Err(error)) => {
                return Ok(cutover_startup_failure(
                    run_id,
                    recorded_at,
                    "projection_cutover_migration_failed",
                    "migration",
                    Some(error),
                ));
            }
            Err(_) => {
                if let Some(lock) = cutover_lock.take() {
                    close_cutover_session(&database_url, lock).await;
                }
                return Ok(cutover_startup_failure(
                    run_id,
                    recorded_at,
                    "projection_cutover_time_budget_exceeded",
                    "migration",
                    None,
                ));
            }
        }
    }
    let cutover_connection = cutover_budget.is_some();
    let provider_future = async {
        if cutover_connection {
            HostedProvider::connect_pre_migrated(
                &database_url,
                crypto,
                ProviderLimits::default(),
                Arc::new(ProjectionOnlyBlobStore),
                None,
                remaining_cutover_time(
                    started,
                    cutover_budget.expect("cutover connection has a budget"),
                ),
            )
            .await
        } else {
            HostedProvider::connect(
                &database_url,
                crypto,
                ProviderLimits::default(),
                Arc::new(ProjectionOnlyBlobStore),
                None,
            )
            .await
        }
    };
    let provider = match cutover_budget {
        Some(budget) => {
            match tokio::time::timeout(remaining_cutover_time(started, budget), provider_future)
                .await
            {
                Ok(Ok(provider)) => provider,
                Ok(Err(error)) => {
                    return Ok(cutover_startup_failure(
                        run_id,
                        recorded_at,
                        "projection_cutover_migration_failed",
                        "migration",
                        Some(error.message),
                    ));
                }
                Err(_) => {
                    return Ok(cutover_startup_failure(
                        run_id,
                        recorded_at,
                        "projection_cutover_time_budget_exceeded",
                        "migration",
                        None,
                    ));
                }
            }
        }
        None => provider_future.await?,
    };
    let (ok, command, result) = match arguments.command {
        Command::Plan(page) => {
            let plan = provider
                .projection_index_plan(page.after, page.limit)
                .await?;
            let ok = plan.migration_ledger_valid && plan.schema_valid;
            (
                ok,
                "plan",
                serde_json::to_value(plan).map_err(serialization_error)?,
            )
        }
        Command::Status(page) => {
            let plan = provider
                .projection_index_plan(page.after, page.limit)
                .await?;
            let mut statuses = Vec::with_capacity(plan.collections.len());
            for entry in &plan.collections {
                statuses.push(provider.projection_status(entry.collection_id).await?);
            }
            let ok = plan.migration_ledger_valid && plan.schema_valid;
            (
                ok,
                "status",
                json!({
                    "migration_ledger_valid": plan.migration_ledger_valid,
                    "schema_valid": plan.schema_valid,
                    "next_after": plan.next_after,
                    "collections": statuses,
                }),
            )
        }
        Command::Apply {
            page,
            batches_per_collection,
        } => {
            let plan = provider
                .projection_index_plan(page.after, page.limit)
                .await?;
            if !plan.migration_ledger_valid || !plan.schema_valid {
                return Err(ApiError::conflict(
                    "projection_index_schema_invalid",
                    "Projection indexing requires the exact reviewed migration ledger and schema.",
                ));
            }
            let mut applied = Vec::with_capacity(plan.collections.len());
            for entry in &plan.collections {
                let mut status = provider
                    .request_projection_indexing(
                        entry.collection_id,
                        entry.head,
                        entry.resource_revision.clone(),
                    )
                    .await?;
                let mut batches_advanced = 0_u32;
                while !status.ready && batches_advanced < batches_per_collection {
                    let Some(generation) = status.building_generation.as_ref() else {
                        break;
                    };
                    provider
                        .advance_projection_generation(
                            entry.collection_id,
                            generation.generation_id,
                        )
                        .await?;
                    batches_advanced += 1;
                    status = provider.projection_status(entry.collection_id).await?;
                }
                applied.push(json!({
                    "collection_id": entry.collection_id,
                    "batches_advanced": batches_advanced,
                    "projection": status,
                }));
            }
            (
                true,
                "apply",
                json!({"next_after": plan.next_after, "collections": applied}),
            )
        }
        Command::Verify(page) => {
            let plan = provider
                .projection_index_plan(page.after, page.limit)
                .await?;
            let mut verifications = Vec::with_capacity(plan.collections.len());
            for entry in &plan.collections {
                verifications.push(
                    provider
                        .verify_projection_index(entry.collection_id)
                        .await?,
                );
            }
            let page_verified = verifications.iter().all(|result| result.verified);
            let ok = plan.migration_ledger_valid && plan.schema_valid && page_verified;
            (
                ok,
                "verify",
                json!({
                    "migration_ledger_valid": plan.migration_ledger_valid,
                    "schema_valid": plan.schema_valid,
                    "page_verified": page_verified,
                    "complete_inventory": plan.next_after.is_none(),
                    "next_after": plan.next_after,
                    "collections": verifications,
                }),
            )
        }
        Command::Cutover(cutover) => {
            let remaining =
                remaining_cutover_time(started, Duration::from_secs(cutover.max_seconds));
            let cutover_result = {
                let lock = cutover_lock.as_mut().ok_or_else(|| {
                    ApiError::internal("Projection cutover global lock was not retained.")
                })?;
                tokio::time::timeout(
                    remaining,
                    run_cutover(&provider, &mut lock.connection, started, cutover),
                )
                .await
            };
            match cutover_result {
                Ok(result) => {
                    let (ok, result) = result?;
                    (ok, "cutover", result)
                }
                Err(_) => {
                    provider.close_cutover_database_lanes().await;
                    if let Some(lock) = cutover_lock.take() {
                        close_cutover_session(&database_url, lock).await;
                    }
                    return Ok(cutover_startup_failure(
                        run_id,
                        recorded_at,
                        "projection_cutover_time_budget_exceeded",
                        "projection_execution",
                        None,
                    ));
                }
            }
        }
    };
    Ok(Envelope {
        ok,
        command,
        run_id,
        recorded_at,
        result,
    })
}

fn remaining_cutover_time(started: Instant, budget: Duration) -> Duration {
    budget.saturating_sub(started.elapsed())
}

fn cutover_startup_failure(
    run_id: Uuid,
    recorded_at: String,
    outcome: &'static str,
    phase: &'static str,
    failure: Option<String>,
) -> Envelope {
    Envelope {
        ok: false,
        command: "cutover",
        run_id,
        recorded_at,
        result: json!({
            "outcome": outcome,
            "phase": phase,
            "complete_inventory": false,
            "pages_visited": 0,
            "collections_verified": 0,
            "batches_advanced": 0,
            "next_after": null,
            "failure": failure,
        }),
    }
}

async fn acquire_cutover_lock(
    database_url: &str,
    owner_token: Uuid,
) -> ApiResult<Option<CutoverLock>> {
    let mut connection = PgConnection::connect(database_url).await?;
    let application_name = format!("mdbase-candidate-b-cutover/{owner_token}");
    sqlx::query("SELECT set_config('application_name', $1, false)")
        .bind(&application_name)
        .execute(&mut connection)
        .await?;
    let acquired: bool = sqlx::query_scalar(
        "SELECT pg_try_advisory_lock(hashtextextended('mdbase-candidate-b-cutover-v1', 0))",
    )
    .fetch_one(&mut connection)
    .await?;
    if !acquired {
        return Ok(None);
    }
    let backend_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut connection)
        .await?;
    Ok(Some(CutoverLock {
        connection,
        backend_pid,
        application_name,
    }))
}

struct CutoverLock {
    connection: PgConnection,
    backend_pid: i32,
    application_name: String,
}

impl Command {
    fn cutover_owner_token(&self) -> Option<Uuid> {
        match self {
            Self::Cutover(arguments) => Some(arguments.owner_token),
            _ => None,
        }
    }

    fn cutover_max_seconds(&self) -> Option<u64> {
        match self {
            Self::Cutover(arguments) => Some(arguments.max_seconds),
            _ => None,
        }
    }
}

async fn claim_cutover_owner(
    connection: &mut PgConnection,
    owner_token: Uuid,
    lease: Duration,
) -> ApiResult<bool> {
    sqlx::query("BEGIN").execute(&mut *connection).await?;
    let result = async {
        sqlx::query(
            "SELECT pg_advisory_xact_lock(hashtextextended('mdbase-hosted-query-admission-v1', 0))",
        )
        .execute(&mut *connection)
        .await?;
        let updated = sqlx::query(
            r#"UPDATE hosted_provider_runtime_control
               SET query_admission_suspended = true,
                   suspension_reason = 'controlled_provider_cutover',
                   admission_fence_token = $1,
                   admission_fence_kind = 'cutover',
                   admission_lease_expires_at = NULL,
                   admission_owner_expires_at =
                     clock_timestamp() + make_interval(secs => $2),
                   updated_at = now()
               WHERE singleton = true
                 AND (
                   admission_fence_token IS NULL
                   OR (
                     admission_fence_token = $1
                     AND admission_fence_kind = 'cutover'
                   )
                   OR (
                     admission_fence_kind = 'cutover'
                     AND admission_owner_expires_at <= clock_timestamp()
                     AND (
                       query_admission_suspended
                       OR admission_lease_expires_at <= clock_timestamp()
                     )
                   )
                 )"#,
        )
        .bind(owner_token)
        .bind(i64::try_from(lease.as_secs()).unwrap_or(i64::MAX))
        .execute(&mut *connection)
        .await?;
        Ok::<bool, ApiError>(updated.rows_affected() == 1)
    }
    .await;
    match result {
        Ok(owned) => {
            sqlx::query("COMMIT").execute(&mut *connection).await?;
            Ok(owned)
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(error)
        }
    }
}

async fn close_cutover_session(database_url: &str, lock: CutoverLock) {
    let backend_pid = lock.backend_pid;
    let application_name = lock.application_name;
    let _ = tokio::time::timeout(Duration::from_secs(5), lock.connection.close()).await;
    let Ok(Ok(mut observer)) =
        tokio::time::timeout(Duration::from_secs(5), PgConnection::connect(database_url)).await
    else {
        return;
    };
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        let _terminated: Result<Option<bool>, sqlx::Error> = sqlx::query_scalar(
            r#"SELECT pg_terminate_backend(pid)
               FROM pg_stat_activity
               WHERE pid = $1
                 AND application_name = $2"#,
        )
        .bind(backend_pid)
        .bind(application_name)
        .fetch_optional(&mut observer)
        .await;
    })
    .await;
}

async fn cutover_lock_owned(connection: &mut PgConnection, owner_token: Uuid) -> ApiResult<bool> {
    let application_name = format!("mdbase-candidate-b-cutover/{owner_token}");
    sqlx::query_scalar(
        r#"WITH lock_key AS (
             SELECT hashtextextended('mdbase-candidate-b-cutover-v1', 0) AS value
           )
           SELECT current_setting('application_name') = $1
             AND EXISTS (
               SELECT 1
               FROM pg_locks, lock_key
               WHERE locktype = 'advisory'
                 AND pid = pg_backend_pid()
                 AND granted
                 AND classid = (((lock_key.value >> 32) & 4294967295)::bigint)::oid
                 AND objid = ((lock_key.value & 4294967295)::bigint)::oid
                 AND objsubid = 1
             )
             AND EXISTS (
               SELECT 1
               FROM hosted_provider_runtime_control
               WHERE singleton = true
                 AND query_admission_suspended = true
                 AND admission_fence_token = $2
                 AND admission_fence_kind = 'cutover'
                 AND admission_owner_expires_at > clock_timestamp()
             )"#,
    )
    .bind(application_name)
    .bind(owner_token)
    .fetch_one(connection)
    .await
    .map_err(Into::into)
}

async fn run_cutover(
    provider: &HostedProvider,
    cutover_lock: &mut PgConnection,
    started: Instant,
    arguments: CutoverArguments,
) -> ApiResult<(bool, Value)> {
    let deadline = Duration::from_secs(arguments.max_seconds);
    let mut after = None;
    let mut pages_visited = 0_u32;
    let mut collections_verified = 0_u32;
    let mut batches_advanced = 0_u64;

    loop {
        if !cutover_lock_owned(cutover_lock, arguments.owner_token).await? {
            return Ok((
                false,
                cutover_outcome(
                    "projection_cutover_lock_lost",
                    false,
                    pages_visited,
                    collections_verified,
                    batches_advanced,
                    after,
                    None,
                    &[],
                ),
            ));
        }
        if started.elapsed() >= deadline {
            return Ok((
                false,
                cutover_outcome(
                    "projection_cutover_time_budget_exceeded",
                    false,
                    pages_visited,
                    collections_verified,
                    batches_advanced,
                    after,
                    None,
                    &[],
                ),
            ));
        }
        if pages_visited >= arguments.max_pages {
            return Ok((
                false,
                cutover_outcome(
                    "projection_cutover_page_budget_exceeded",
                    false,
                    pages_visited,
                    collections_verified,
                    batches_advanced,
                    after,
                    None,
                    &[],
                ),
            ));
        }
        provider
            .configure_cutover_statement_timeout(remaining_cutover_time(started, deadline))
            .await?;
        let plan = provider
            .projection_index_plan(after, arguments.page_limit)
            .await?;
        pages_visited += 1;
        if !plan.migration_ledger_valid || !plan.schema_valid {
            return Ok((
                false,
                json!({
                    "outcome": "projection_cutover_schema_invalid",
                    "migration_ledger_valid": plan.migration_ledger_valid,
                    "schema_valid": plan.schema_valid,
                    "complete_inventory": false,
                    "pages_visited": pages_visited,
                    "collections_verified": collections_verified,
                    "batches_advanced": batches_advanced,
                    "next_after": after,
                }),
            ));
        }

        for entry in &plan.collections {
            if collections_verified >= arguments.max_collections {
                return Ok((
                    false,
                    cutover_outcome(
                        "projection_cutover_collection_budget_exceeded",
                        false,
                        pages_visited,
                        collections_verified,
                        batches_advanced,
                        after,
                        Some(entry.collection_id),
                        &[],
                    ),
                ));
            }
            provider
                .configure_cutover_statement_timeout(remaining_cutover_time(started, deadline))
                .await?;
            let mut status = provider
                .request_projection_indexing(
                    entry.collection_id,
                    entry.head,
                    entry.resource_revision.clone(),
                )
                .await?;
            let mut collection_batches = 0_u32;
            while !status.ready {
                if !cutover_lock_owned(cutover_lock, arguments.owner_token).await? {
                    return Ok((
                        false,
                        cutover_outcome(
                            "projection_cutover_lock_lost",
                            false,
                            pages_visited,
                            collections_verified,
                            batches_advanced,
                            after,
                            Some(entry.collection_id),
                            &[],
                        ),
                    ));
                }
                if started.elapsed() >= deadline {
                    return Ok((
                        false,
                        cutover_outcome(
                            "projection_cutover_time_budget_exceeded",
                            false,
                            pages_visited,
                            collections_verified,
                            batches_advanced,
                            after,
                            Some(entry.collection_id),
                            &[],
                        ),
                    ));
                }
                if collection_batches >= arguments.batches_per_collection
                    || batches_advanced >= arguments.max_batches
                {
                    return Ok((
                        false,
                        cutover_outcome(
                            "projection_cutover_batch_budget_exceeded",
                            false,
                            pages_visited,
                            collections_verified,
                            batches_advanced,
                            after,
                            Some(entry.collection_id),
                            &[],
                        ),
                    ));
                }
                let Some(generation) = status.building_generation.as_ref() else {
                    let failures = status
                        .latest_terminal_error_code
                        .clone()
                        .into_iter()
                        .collect::<Vec<_>>();
                    return Ok((
                        false,
                        cutover_outcome(
                            "projection_cutover_generation_unavailable",
                            false,
                            pages_visited,
                            collections_verified,
                            batches_advanced,
                            after,
                            Some(entry.collection_id),
                            &failures,
                        ),
                    ));
                };
                provider
                    .configure_cutover_statement_timeout(remaining_cutover_time(started, deadline))
                    .await?;
                provider
                    .advance_projection_generation(entry.collection_id, generation.generation_id)
                    .await?;
                collection_batches += 1;
                batches_advanced += 1;
                status = provider.projection_status(entry.collection_id).await?;
            }

            provider
                .configure_cutover_statement_timeout(remaining_cutover_time(started, deadline))
                .await?;
            let verification = provider
                .verify_projection_index(entry.collection_id)
                .await?;
            if !verification.verified {
                return Ok((
                    false,
                    cutover_outcome(
                        "projection_cutover_verification_failed",
                        false,
                        pages_visited,
                        collections_verified,
                        batches_advanced,
                        after,
                        Some(entry.collection_id),
                        &verification.failures,
                    ),
                ));
            }
            collections_verified += 1;
        }

        let Some(next_after) = plan.next_after else {
            return Ok((
                true,
                cutover_outcome(
                    "complete",
                    true,
                    pages_visited,
                    collections_verified,
                    batches_advanced,
                    None,
                    None,
                    &[],
                ),
            ));
        };
        after = Some(next_after);
    }
}

#[allow(clippy::too_many_arguments)]
fn cutover_outcome(
    outcome: &'static str,
    complete_inventory: bool,
    pages_visited: u32,
    collections_verified: u32,
    batches_advanced: u64,
    next_after: Option<Uuid>,
    blocked_collection_id: Option<Uuid>,
    failures: &[String],
) -> Value {
    json!({
        "outcome": outcome,
        "complete_inventory": complete_inventory,
        "pages_visited": pages_visited,
        "collections_verified": collections_verified,
        "batches_advanced": batches_advanced,
        "next_after": next_after,
        "blocked_collection_id": blocked_collection_id,
        "failures": failures,
    })
}

fn required_environment(name: &'static str) -> ApiResult<String> {
    optional_environment(name)?.ok_or_else(|| {
        ApiError::internal(format!(
            "Required projection indexer environment configuration is missing: {name}."
        ))
    })
}

fn optional_environment(name: &'static str) -> ApiResult<Option<String>> {
    match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
        Ok(_) | Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => Err(ApiError::internal(format!(
            "Projection indexer environment configuration is invalid: {name}."
        ))),
    }
}

fn serialization_error(error: serde_json::Error) -> ApiError {
    ApiError::internal(format!(
        "Projection indexer result could not serialize: {error}"
    ))
}

struct ProjectionOnlyBlobStore;

fn blob_access_forbidden() -> ApiError {
    ApiError::internal("Projection indexing attempted to access hosted file storage.")
}

#[async_trait]
impl BlobStore for ProjectionOnlyBlobStore {
    fn upload_part_size(&self) -> u64 {
        5 * 1024 * 1024
    }
    fn download_part_size(&self) -> u64 {
        1024 * 1024
    }
    async fn ready(&self) -> ApiResult<()> {
        Err(blob_access_forbidden())
    }
    async fn create_multipart(&self, _: &str) -> ApiResult<String> {
        Err(blob_access_forbidden())
    }
    async fn presign_put(&self, _: &str, _: u64) -> ApiResult<PresignedPart> {
        Err(blob_access_forbidden())
    }
    async fn presign_part(&self, _: &str, _: &str, _: i32, _: u64) -> ApiResult<PresignedPart> {
        Err(blob_access_forbidden())
    }
    async fn complete_multipart(&self, _: &str, _: &str, _: &[UploadedPart]) -> ApiResult<()> {
        Err(blob_access_forbidden())
    }
    async fn list_multipart_parts(&self, _: &str, _: &str) -> ApiResult<Vec<UploadedPart>> {
        Err(blob_access_forbidden())
    }
    async fn abort_multipart(&self, _: &str, _: &str) -> ApiResult<()> {
        Err(blob_access_forbidden())
    }
    async fn object_exists(&self, _: &str) -> ApiResult<bool> {
        Err(blob_access_forbidden())
    }
    async fn copy(&self, _: &str, _: &str) -> ApiResult<()> {
        Err(blob_access_forbidden())
    }
    async fn verify_object(&self, _: &str, _: u64, _: &str) -> ApiResult<()> {
        Err(blob_access_forbidden())
    }
    async fn read_range(&self, _: &str, _: u64, _: u64) -> ApiResult<BlobByteStream> {
        Err(blob_access_forbidden())
    }
    async fn delete(&self, _: &str) -> ApiResult<()> {
        Err(blob_access_forbidden())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cutover_requires_an_explicit_owner_token() {
        let missing = Arguments::try_parse_from([
            "mdbase-hosted-projection-indexer",
            "cutover",
            "--max-seconds",
            "30",
        ]);
        assert!(missing.is_err());

        let parsed = Arguments::try_parse_from([
            "mdbase-hosted-projection-indexer",
            "cutover",
            "--owner-token",
            "99999999-9999-4999-8999-999999999999",
            "--max-seconds",
            "30",
        ])
        .unwrap();
        let Command::Cutover(cutover) = parsed.command else {
            panic!("cutover command was not parsed");
        };
        assert_eq!(
            cutover.owner_token,
            Uuid::parse_str("99999999-9999-4999-8999-999999999999").unwrap()
        );
    }

    #[test]
    fn startup_budget_failures_are_typed_cutover_results() {
        let envelope = cutover_startup_failure(
            Uuid::nil(),
            "2026-08-17T00:00:00Z".to_string(),
            "projection_cutover_time_budget_exceeded",
            "migration",
            None,
        );
        assert!(!envelope.ok);
        assert_eq!(envelope.command, "cutover");
        assert_eq!(
            envelope.result["outcome"],
            "projection_cutover_time_budget_exceeded"
        );
        assert_eq!(envelope.result["phase"], "migration");
        assert_eq!(envelope.result["complete_inventory"], false);
    }
}
