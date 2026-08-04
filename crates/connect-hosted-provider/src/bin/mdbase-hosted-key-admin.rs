use std::{process::ExitCode, time::Duration};

use clap::{Parser, Subcommand, ValueEnum};
use mdbase_connect_hosted_provider::{
    HostedKeyAdmin, KeyRewrapOptions, KeyWrapError, KeyWrappingBackend, KeyWrappingConfig,
    ProviderCrypto,
};
use serde::Serialize;

#[derive(Parser)]
#[command(name = "mdbase-hosted-key-admin")]
#[command(
    about = "Inspect and migrate hosted-provider wrapped data keys without exposing key material"
)]
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
    Inspect,
    Rewrap {
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        finalize_key_check: bool,
        #[arg(long, default_value_t = 1_000_000)]
        max_rows: u64,
    },
}

#[derive(Serialize)]
struct Success<T: Serialize> {
    ok: bool,
    result: T,
}

#[derive(Serialize)]
struct Failure<'a> {
    ok: bool,
    error: FailureBody<'a>,
}

#[derive(Serialize)]
struct FailureBody<'a> {
    code: &'a str,
    message: String,
}

#[tokio::main]
async fn main() -> ExitCode {
    match run(Arguments::parse()).await {
        Ok(value) => {
            println!(
                "{}",
                serde_json::to_string(&value).expect("admin result serializes")
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!(
                "{}",
                serde_json::to_string(&Failure {
                    ok: false,
                    error: FailureBody {
                        code: error.code(),
                        message: error.to_string(),
                    },
                })
                .expect("admin error serializes")
            );
            ExitCode::FAILURE
        }
    }
}

async fn run(arguments: Arguments) -> Result<serde_json::Value, AdminError> {
    let database_url = required_environment("DATABASE_URL")?;
    let master_key = optional_environment("MDBASE_CONNECT_HOSTED_PROVIDER_MASTER_KEY")?;
    let environment = arguments.key_environment;
    let runtime = KeyWrappingConfig {
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
    .await?;
    let crypto = ProviderCrypto::with_key_wrapping(runtime, environment)?;
    let admin = HostedKeyAdmin::connect(&database_url, crypto).await?;
    match arguments.command {
        Command::Inspect => Ok(serde_json::to_value(Success {
            ok: true,
            result: admin.inspect().await?,
        })?),
        Command::Rewrap {
            dry_run,
            finalize_key_check,
            max_rows,
        } => Ok(serde_json::to_value(Success {
            ok: true,
            result: admin
                .rewrap(KeyRewrapOptions {
                    dry_run,
                    finalize_key_check,
                    max_rows,
                })
                .await?,
        })?),
    }
}

#[derive(Debug, thiserror::Error)]
enum AdminError {
    #[error("Required environment configuration is missing or invalid: {0}.")]
    Environment(&'static str),
    #[error("{0}")]
    Key(#[from] KeyWrapError),
    #[error("{0}")]
    Provider(#[from] mdbase_connect_hosted_provider::ApiError),
    #[error("The key administration result could not serialize.")]
    Serialization(#[from] serde_json::Error),
}

impl AdminError {
    fn code(&self) -> &str {
        match self {
            Self::Environment(_) => "environment_configuration_error",
            Self::Key(_) => "key_configuration_error",
            Self::Provider(error) => &error.code,
            Self::Serialization(_) => "serialization_error",
        }
    }
}

fn required_environment(name: &'static str) -> Result<String, AdminError> {
    optional_environment(name)?.ok_or(AdminError::Environment(name))
}

fn optional_environment(name: &'static str) -> Result<Option<String>, AdminError> {
    match std::env::var(name) {
        Ok(value) if value.trim().is_empty() => Ok(None),
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => Err(AdminError::Environment(name)),
    }
}
