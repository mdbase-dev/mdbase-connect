use std::process::ExitCode;

use clap::{Parser, Subcommand};
use mdbase_connect_hosted_provider::{ApiError, HostedBackupAdmin};
use serde::Serialize;
use uuid::Uuid;

#[derive(Parser)]
#[command(name = "mdbase-hosted-backup-admin")]
#[command(about = "Coordinate a bounded hosted database and object backup hold")]
struct Arguments {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Inspect,
    Acquire {
        #[arg(long, default_value_t = 14_400)]
        ttl_seconds: u64,
    },
    Release {
        #[arg(long)]
        hold_id: Uuid,
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
    let admin = HostedBackupAdmin::connect(&database_url).await?;
    match arguments.command {
        Command::Inspect => Ok(serde_json::to_value(Success {
            ok: true,
            result: admin.inspect().await?,
        })?),
        Command::Acquire { ttl_seconds } => Ok(serde_json::to_value(Success {
            ok: true,
            result: admin.acquire(ttl_seconds).await?,
        })?),
        Command::Release { hold_id } => Ok(serde_json::to_value(Success {
            ok: true,
            result: admin.release(hold_id).await?,
        })?),
    }
}

#[derive(Debug, thiserror::Error)]
enum AdminError {
    #[error("Required environment configuration is missing or invalid: {0}.")]
    Environment(&'static str),
    #[error("{0}")]
    Provider(#[from] ApiError),
    #[error("The backup administration result could not serialize.")]
    Serialization(#[from] serde_json::Error),
}

impl AdminError {
    fn code(&self) -> &str {
        match self {
            Self::Environment(_) => "environment_configuration_error",
            Self::Provider(error) => &error.code,
            Self::Serialization(_) => "serialization_error",
        }
    }
}

fn required_environment(name: &'static str) -> Result<String, AdminError> {
    match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => Ok(value),
        Ok(_) | Err(std::env::VarError::NotPresent) => Err(AdminError::Environment(name)),
        Err(std::env::VarError::NotUnicode(_)) => Err(AdminError::Environment(name)),
    }
}
