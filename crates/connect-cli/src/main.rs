use clap::{Parser, Subcommand};
use mdbase_connect_core::{default_control_endpoint, default_state_dir};
use mdbase_connect_protocol::{
    AccessPauseParams, ActivityListParams, AuthorizationApproveParams, AuthorizationIdParams,
    CollectionCreateParams, CollectionIdParams, CollectionOperationParams, CollectionPathParams,
    ControlCommand, ControlRequest, ControlResponse, GrantIdParams, GrantUpdateParams,
};
use serde_json::Value;
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use uuid::Uuid;

#[derive(Debug, Parser)]
#[command(name = "mdbase-connect")]
#[command(about = "Manage the local mdbase connect agent")]
struct Args {
    #[arg(long, env = "MDBASE_CONNECT_HOME")]
    state_dir: Option<PathBuf>,

    #[arg(long, env = "MDBASE_CONNECT_SOCKET")]
    endpoint: Option<String>,

    #[arg(long)]
    compact: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Status,
    Ping,
    #[command(subcommand)]
    Collection(CollectionCommand),
    Operation {
        collection_id: Uuid,
        operation: String,
        #[arg(long, default_value = "{}")]
        input: String,
    },
    #[command(subcommand)]
    Access(AccessCommand),
    Activity {
        #[arg(long, default_value_t = 100)]
        limit: usize,
    },
}

#[derive(Debug, Subcommand)]
enum AccessCommand {
    Snapshot,
    Pause {
        #[arg(action = clap::ArgAction::Set)]
        paused: bool,
    },
    Approve {
        request_id: Uuid,
        collection_id: Uuid,
        #[arg(long, value_delimiter = ',')]
        operations: Vec<String>,
    },
    Deny {
        request_id: Uuid,
    },
    Update {
        grant_id: Uuid,
        #[arg(long, value_delimiter = ',')]
        operations: Vec<String>,
    },
    Revoke {
        grant_id: Uuid,
    },
}

#[derive(Debug, Subcommand)]
enum CollectionCommand {
    List,
    Add {
        path: PathBuf,
    },
    AddCopy {
        path: PathBuf,
    },
    Create {
        path: PathBuf,
        #[arg(long)]
        name: Option<String>,
    },
    Remove {
        collection_id: Uuid,
    },
    Validate {
        collection_id: Uuid,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let state_dir = args.state_dir.map(Ok).unwrap_or_else(default_state_dir)?;
    let endpoint = args
        .endpoint
        .unwrap_or_else(|| default_control_endpoint(&state_dir));
    let command = match args.command {
        Command::Status => ControlCommand::Status,
        Command::Ping => ControlCommand::Ping,
        Command::Collection(CollectionCommand::List) => ControlCommand::CollectionList,
        Command::Collection(CollectionCommand::Add { path }) => {
            ControlCommand::CollectionAdd(CollectionPathParams {
                path: path.to_string_lossy().to_string(),
            })
        }
        Command::Collection(CollectionCommand::AddCopy { path }) => {
            ControlCommand::CollectionAddCopy(CollectionPathParams {
                path: path.to_string_lossy().to_string(),
            })
        }
        Command::Collection(CollectionCommand::Create { path, name }) => {
            ControlCommand::CollectionCreate(CollectionCreateParams {
                path: path.to_string_lossy().to_string(),
                name,
            })
        }
        Command::Collection(CollectionCommand::Remove { collection_id }) => {
            ControlCommand::CollectionRemove(CollectionIdParams { collection_id })
        }
        Command::Collection(CollectionCommand::Validate { collection_id }) => {
            ControlCommand::CollectionValidate(CollectionIdParams { collection_id })
        }
        Command::Operation {
            collection_id,
            operation,
            input,
        } => ControlCommand::CollectionOperation(CollectionOperationParams {
            collection_id,
            operation,
            input: serde_json::from_str::<Value>(&input)?,
        }),
        Command::Access(AccessCommand::Snapshot) => ControlCommand::AccessSnapshot,
        Command::Access(AccessCommand::Pause { paused }) => {
            ControlCommand::AccessPause(AccessPauseParams { paused })
        }
        Command::Access(AccessCommand::Approve {
            request_id,
            collection_id,
            operations,
        }) => ControlCommand::AuthorizationApprove(AuthorizationApproveParams {
            request_id,
            collection_id,
            operations,
        }),
        Command::Access(AccessCommand::Deny { request_id }) => {
            ControlCommand::AuthorizationDeny(AuthorizationIdParams { request_id })
        }
        Command::Access(AccessCommand::Update {
            grant_id,
            operations,
        }) => ControlCommand::GrantUpdate(GrantUpdateParams {
            grant_id,
            operations,
        }),
        Command::Access(AccessCommand::Revoke { grant_id }) => {
            ControlCommand::GrantRevoke(GrantIdParams { grant_id })
        }
        Command::Activity { limit } => ControlCommand::ActivityList(ActivityListParams { limit }),
    };

    let response = send(&endpoint, ControlRequest::new(command)).await?;
    let output = if args.compact {
        serde_json::to_string(&response)?
    } else {
        serde_json::to_string_pretty(&response)?
    };
    println!("{output}");
    if response.ok {
        Ok(())
    } else {
        std::process::exit(1)
    }
}

async fn exchange<S>(
    stream: S,
    request: ControlRequest,
) -> Result<ControlResponse, Box<dyn std::error::Error>>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (reader, mut writer) = tokio::io::split(stream);
    let mut encoded = serde_json::to_vec(&request)?;
    encoded.push(b'\n');
    writer.write_all(&encoded).await?;
    let mut lines = BufReader::new(reader).lines();
    let line = lines
        .next_line()
        .await?
        .ok_or("agent closed without a response")?;
    Ok(serde_json::from_str(&line)?)
}

#[cfg(unix)]
async fn send(
    endpoint: &str,
    request: ControlRequest,
) -> Result<ControlResponse, Box<dyn std::error::Error>> {
    let stream = tokio::net::UnixStream::connect(endpoint)
        .await
        .map_err(|error| {
            format!("Could not connect to mdbase connect agent at {endpoint}: {error}")
        })?;
    exchange(stream, request).await
}

#[cfg(windows)]
async fn send(
    endpoint: &str,
    request: ControlRequest,
) -> Result<ControlResponse, Box<dyn std::error::Error>> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let stream = ClientOptions::new().open(endpoint).map_err(|error| {
        format!("Could not connect to mdbase connect agent at {endpoint}: {error}")
    })?;
    exchange(stream, request).await
}
