use std::{process::ExitCode, sync::Arc, time::Duration};

use async_trait::async_trait;
use clap::{Parser, Subcommand, ValueEnum};
use mdbase_connect_hosted_provider::{
    ApiError, ApiResult, BlobByteStream, BlobStore, HostedProvider, KeyWrappingBackend,
    KeyWrappingConfig, PresignedPart, ProviderCrypto, ProviderLimits, UploadedPart,
};
use serde::Serialize;
use serde_json::{json, Value};
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
}

#[derive(clap::Args)]
struct PageArguments {
    #[arg(long)]
    after: Option<Uuid>,
    #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u32).range(1..=1000))]
    limit: u32,
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
    let database_url = required_environment("DATABASE_URL")?;
    let master_key = optional_environment("MDBASE_CONNECT_HOSTED_PROVIDER_MASTER_KEY")?;
    let environment = arguments.key_environment;
    let key_wrapping = KeyWrappingConfig {
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
    .build()
    .await
    .map_err(|error| {
        ApiError::internal(format!(
            "Projection indexer key configuration failed: {error}"
        ))
    })?;
    let crypto = ProviderCrypto::with_key_wrapping(key_wrapping, environment).map_err(|error| {
        ApiError::internal(format!("Projection indexer crypto failed: {error}"))
    })?;
    let provider = HostedProvider::connect(
        &database_url,
        crypto,
        ProviderLimits::default(),
        Arc::new(ProjectionOnlyBlobStore),
        None,
    )
    .await?;
    let run_id = Uuid::now_v7();
    let recorded_at = chrono::Utc::now().to_rfc3339();
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
    };
    Ok(Envelope {
        ok,
        command,
        run_id,
        recorded_at,
        result,
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
