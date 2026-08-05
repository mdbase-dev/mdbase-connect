mod control;
mod daemon;
mod login;
mod output;
mod service;

use control::{control_command, successful_result};
use daemon::{
    connect_paths, current_loopback_port, doctor, execute_daemon_command, restart_daemon, send,
    ConnectPaths, DaemonTarget,
};
use login::login;
use output::{print_result, render_connect_profile, render_data_result, OutputKind};

use clap::{Parser, Subcommand};
use mdbase_command::Command as DataCommand;
use mdbase_connect_core::{
    configure_cloud, default_control_endpoint, default_state_dir, disconnect_cloud,
    CloudConfiguration,
};
use mdbase_connect_daemon::{run as run_daemon, DaemonOptions};
use mdbase_connect_protocol::{
    AccessPauseParams, ActivityListParams, AuthorityTarget, AuthorizationApproveParams,
    AuthorizationIdParams, CollectionAuthorityTransferParams, CollectionCreateParams,
    CollectionIdParams, CollectionOperationParams, CollectionPathParams, ControlCommand,
    ControlRequest, ControlResponse, FileMediaClass, GrantIdParams, GrantUpdateParams,
    HostedCollectionCreateParams, HostedCollectionRenameParams, MirrorAddParams,
    MirrorConfigureSelectiveSyncParams, MirrorIdParams, MirrorResolution, MirrorResolveParams,
    SyncReplicaMode, LOCAL_CONTROL_PROTOCOL_VERSION,
};
use serde_json::Value;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use uuid::Uuid;

#[derive(Debug, Parser)]
#[command(name = "mdbase")]
#[command(about = "One dependable tool for mdbase collections and connections")]
#[command(version)]
struct Args {
    /// Open a collection directly at this filesystem path.
    #[arg(short = 'C', long, global = true, conflicts_with = "collection")]
    root: Option<PathBuf>,

    /// Execute a portable data command through the local Connect daemon.
    #[arg(long, global = true, conflicts_with = "root")]
    collection: Option<Uuid>,

    /// Override the per-user Connect state directory.
    #[arg(long, env = "MDBASE_CONNECT_HOME", global = true)]
    state_dir: Option<PathBuf>,

    /// Override the daemon's Unix socket or Windows named pipe.
    #[arg(long, env = "MDBASE_CONNECT_SOCKET", global = true)]
    endpoint: Option<String>,

    /// Emit the stable machine-readable result.
    #[arg(long, global = true)]
    json: bool,

    /// Pretty-print portable JSON data results.
    #[arg(long, global = true)]
    pretty: bool,

    /// Emit payload-free command timing JSON to stderr.
    #[arg(long, global = true)]
    timings: bool,

    #[command(subcommand)]
    command: RootCommand,
}

#[derive(Debug, Subcommand)]
enum RootCommand {
    /// Show the embedded CLI, engine, and protocol versions.
    Version,

    /// Manage accounts, authorities, mirrors, application access, and the daemon.
    Connect {
        #[command(subcommand)]
        command: ConnectCommand,
    },

    /// Run repeatable, payload-free performance workloads.
    Profile {
        #[command(subcommand)]
        command: ProfileCommand,
    },

    #[command(flatten)]
    Data(DataCommand),
}

#[derive(Debug, Subcommand)]
enum ProfileCommand {
    /// Profile canonical engine operations using a deterministic workload.
    Engine(mdbase_command::profile::Args),

    /// Profile the read-only local Connect authority path.
    Connect(ConnectProfileArgs),
}

#[derive(Debug, clap::Args)]
struct ConnectProfileArgs {
    /// Workload to run.
    #[arg(long, value_enum, default_value_t = ConnectProfileScenario::All)]
    scenario: ConnectProfileScenario,

    /// Number of measured workload iterations.
    #[arg(long, default_value_t = 3)]
    iterations: usize,

    /// Concurrent query requests per batch.
    #[arg(long, default_value_t = 4)]
    concurrency: usize,

    /// Optionally write the JSON report to a file.
    #[arg(long)]
    output: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
enum ConnectProfileScenario {
    Query,
    Views,
    Editor,
    Concurrent,
    All,
}

impl From<ConnectProfileScenario> for mdbase_connect_core::profiling::ProfileScenario {
    fn from(scenario: ConnectProfileScenario) -> Self {
        match scenario {
            ConnectProfileScenario::Query => Self::Query,
            ConnectProfileScenario::Views => Self::Views,
            ConnectProfileScenario::Editor => Self::Editor,
            ConnectProfileScenario::Concurrent => Self::Concurrent,
            ConnectProfileScenario::All => Self::All,
        }
    }
}

#[derive(Debug, Subcommand)]
enum ConnectCommand {
    /// Show the local daemon and connection state.
    Status,

    /// Connect this computer to an mdbase account in the browser.
    Login {
        #[arg(long, default_value = "https://connect.mdbase.dev")]
        server: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        no_open: bool,
    },

    /// Disconnect this computer from its mdbase account.
    Logout,

    /// Show the connected account and computer.
    Whoami,

    /// Manage collections hosted by mdbase.
    #[command(subcommand)]
    Hosted(HostedCommand),

    /// Manage the durable per-user Connect daemon.
    #[command(subcommand)]
    Daemon(DaemonCommand),

    /// Manage computer-owned collections.
    #[command(subcommand, visible_alias = "collections")]
    Collection(CollectionCommand),

    /// Materialize and synchronize hosted collections.
    #[command(subcommand, visible_alias = "mirrors")]
    Mirror(MirrorCommand),

    /// Execute a canonical mdbase operation through the local authority.
    Operation {
        collection_id: Uuid,
        operation: String,
        #[arg(long, default_value = "{}")]
        input: String,
    },

    /// Manage application access.
    #[command(subcommand)]
    Access(AccessCommand),

    /// Show recent privacy-minimal connector activity.
    Activity {
        #[arg(long, default_value_t = 100)]
        limit: usize,
    },

    /// Check the local installation and daemon.
    Doctor,

    #[command(hide = true)]
    Paths,

    #[command(hide = true)]
    Ping,
}

#[derive(Debug, Subcommand)]
enum DaemonCommand {
    /// Run the daemon in the foreground.
    Run {
        /// Hosted or self-hosted Connect server URL.
        #[arg(long, env = "MDBASE_CONNECT_SERVER_URL")]
        server_url: Option<String>,

        /// Browser-facing loopback API port.
        #[arg(
            long,
            env = "MDBASE_CONNECT_LOOPBACK_PORT",
            default_value_t = mdbase_connect_protocol::DEFAULT_LOOPBACK_PORT
        )]
        loopback_port: u16,
    },

    /// Install and enable the per-user daemon.
    Install,

    /// Remove the per-user daemon registration without deleting data.
    Uninstall,

    /// Start the daemon, using its installed service when available.
    Start,

    /// Stop the installed per-user daemon.
    Stop,

    /// Restart the installed per-user daemon.
    Restart,

    /// Show whether the daemon is installed and reachable.
    Status,

    /// Show recent daemon logs.
    Logs {
        #[arg(long, default_value_t = 100)]
        lines: usize,
        #[arg(long)]
        follow: bool,
    },
}

#[derive(Debug, Subcommand)]
enum AccessCommand {
    List,
    Pause,
    Resume,
    Approve {
        request_id: Uuid,
        collection_id: Uuid,
        #[arg(long, value_delimiter = ',', required = true)]
        operations: Vec<String>,
    },
    Deny {
        request_id: Uuid,
    },
    Update {
        grant_id: Uuid,
        #[arg(long, value_delimiter = ',', required = true)]
        operations: Vec<String>,
    },
    Revoke {
        grant_id: Uuid,
    },
}

#[derive(Debug, Subcommand)]
enum HostedCommand {
    List,
    Create {
        name: String,
    },
    Rename {
        collection_id: Uuid,
        name: String,
    },
    Delete {
        collection_id: Uuid,
        #[arg(long)]
        yes: bool,
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
    TransferAuthority {
        collection_id: Uuid,
        #[arg(long, value_enum, default_value_t = CliAuthorityTarget::Remote)]
        target: CliAuthorityTarget,
    },
}

#[derive(Debug, Subcommand)]
enum MirrorCommand {
    List,
    Add {
        collection_id: Uuid,
        path: PathBuf,
        #[arg(long)]
        name: Option<String>,
        #[arg(long, conflicts_with = "two_way")]
        read_only: bool,
        #[arg(long)]
        two_way: bool,
        /// Non-Markdown file classes to keep on this computer (comma-separated).
        #[arg(long, value_enum, value_delimiter = ',')]
        files: Vec<CliFileClass>,
        /// Visible collection folder to leave online-only. Repeat for multiple folders.
        #[arg(long = "exclude-folder")]
        excluded_folders: Vec<String>,
    },
    Sync {
        replica_id: Uuid,
    },
    Configure {
        replica_id: Uuid,
        /// Non-Markdown file classes to keep on this computer (comma-separated).
        #[arg(long, value_enum, value_delimiter = ',')]
        files: Vec<CliFileClass>,
        /// Visible collection folder to leave online-only. Repeat for multiple folders.
        #[arg(long = "exclude-folder")]
        excluded_folders: Vec<String>,
    },
    Resolve {
        replica_id: Uuid,
        record_id: Uuid,
        #[arg(long, value_enum)]
        r#use: CliMirrorResolution,
    },
    Promote {
        replica_id: Uuid,
        #[arg(long)]
        no_open: bool,
    },
    Remove {
        replica_id: Uuid,
        /// Confirm remote replica revocation and retain the local Markdown.
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
enum CliMirrorResolution {
    Local,
    Hosted,
}

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
enum CliFileClass {
    Images,
    Audio,
    Videos,
    Pdfs,
    Other,
}

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
enum CliAuthorityTarget {
    Remote,
}

#[tokio::main]
pub async fn run() -> i32 {
    let raw_arguments = std::env::args_os().collect::<Vec<_>>();
    let requested_json = raw_arguments
        .iter()
        .any(|argument| argument == std::ffi::OsStr::new("--json"));
    let args = match Args::try_parse_from(raw_arguments) {
        Ok(args) => args,
        Err(error)
            if matches!(
                error.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            ) =>
        {
            let _ = error.print();
            return 0;
        }
        Err(error) => {
            if requested_json {
                eprintln!(
                    "{}",
                    serde_json::json!({
                        "error": {
                            "code": "invalid_arguments",
                            "message": error.to_string()
                        }
                    })
                );
            } else {
                let _ = error.print();
            }
            return error.exit_code();
        }
    };
    let json = args.json;
    let timing = args.timings.then(|| timing_context(&args));
    let started = std::time::Instant::now();
    let exit_code = match execute(args).await {
        Ok(exit_code) => exit_code,
        Err(error) => {
            if json {
                eprintln!(
                    "{}",
                    serde_json::to_string(&serde_json::json!({
                        "error": {
                            "code": error.code,
                            "message": error.message
                        }
                    }))
                    .unwrap_or_else(|_| {
                        "{\"error\":{\"code\":\"serialization_failed\",\"message\":\"Could not encode the CLI error.\"}}"
                            .to_string()
                    })
                );
            } else {
                eprintln!("error[{}]: {}", error.code, error.message);
            }
            error.exit_code
        }
    };
    if let Some((command, target)) = timing {
        eprintln!(
            "{}",
            serde_json::json!({
                "profile": {
                    "command": command,
                    "target": target,
                    "total_us": started.elapsed().as_micros(),
                    "success": exit_code == 0,
                }
            })
        );
    }
    exit_code
}

fn timing_context(args: &Args) -> (&'static str, &'static str) {
    match &args.command {
        RootCommand::Data(command) => (
            command.name(),
            if args.collection.is_some() {
                "connect"
            } else {
                "direct"
            },
        ),
        RootCommand::Version => ("version", "local"),
        RootCommand::Connect { .. } => ("connect", "control"),
        RootCommand::Profile {
            command: ProfileCommand::Engine(_),
        } => ("profile_engine", "profile"),
        RootCommand::Profile {
            command: ProfileCommand::Connect(_),
        } => ("profile_connect", "profile"),
    }
}

#[derive(Debug)]
struct CliError {
    code: String,
    message: String,
    exit_code: i32,
}

impl CliError {
    fn usage(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_input".to_string(),
            message: message.into(),
            exit_code: 2,
        }
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            code: "daemon_unavailable".to_string(),
            message: message.into(),
            exit_code: 3,
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            code: "internal_error".to_string(),
            message: message.into(),
            exit_code: 1,
        }
    }
}

async fn execute(args: Args) -> Result<i32, CliError> {
    match args.command {
        RootCommand::Version => {
            let value = serde_json::json!({
                "cli": env!("CARGO_PKG_VERSION"),
                "engine": mdbase_command::engine_version(),
                "command_adapter": mdbase_command::VERSION,
                "local_control_protocol": LOCAL_CONTROL_PROTOCOL_VERSION,
                "sync_protocol": mdbase_connect_protocol::SYNC_PROTOCOL_VERSION,
                "operation_transport_protocol":
                    mdbase_connect_protocol::OPERATION_TRANSPORT_PROTOCOL_VERSION,
            });
            if args.json {
                println!("{value}");
            } else {
                println!("mdbase {}", env!("CARGO_PKG_VERSION"));
                println!("engine {}", mdbase_command::engine_version());
                println!("local control protocol {LOCAL_CONTROL_PROTOCOL_VERSION}");
            }
            Ok(0)
        }
        RootCommand::Data(command) => {
            let command = match command {
                DataCommand::Watch { debounce_ms, count } if args.collection.is_none() => {
                    let root = args.root.unwrap_or_else(|| {
                        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
                    });
                    mdbase_command::run_watch(&root, debounce_ms, count)
                        .map_err(CliError::internal)?;
                    return Ok(0);
                }
                command => command,
            };
            if let Some(collection_id) = args.collection {
                let invocation = match mdbase_command::into_portable(command) {
                    Ok(invocation) => invocation,
                    Err(result) => {
                        render_data_result(&result.value, args.pretty, result.diagnostic)?;
                        return Ok(result.exit_code);
                    }
                };
                let endpoint = connect_paths(args.state_dir, args.endpoint)?.endpoint;
                let value = successful_result(
                    send(
                        &endpoint,
                        ControlRequest::new(ControlCommand::CollectionOperation(
                            CollectionOperationParams {
                                collection_id,
                                operation: invocation.operation.to_string(),
                                input: invocation.input,
                            },
                        )),
                    )
                    .await?,
                )?;
                let exit_code = mdbase_command::portable_exit_code(&value);
                render_data_result(&value, args.pretty, exit_code != 0)?;
                Ok(exit_code)
            } else {
                let root = args.root.unwrap_or_else(|| {
                    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
                });
                let result = mdbase_command::execute_direct(&root, command);
                render_data_result(
                    &result.value,
                    args.pretty,
                    result.diagnostic || result.exit_code != 0,
                )?;
                Ok(result.exit_code)
            }
        }
        RootCommand::Profile {
            command: ProfileCommand::Engine(profile),
        } => {
            mdbase_command::profile::run(profile, args.root.as_deref(), args.json)
                .map_err(CliError::internal)?;
            Ok(0)
        }
        RootCommand::Profile {
            command: ProfileCommand::Connect(profile),
        } => {
            let root = args
                .root
                .as_deref()
                .ok_or_else(|| CliError::usage("mdbase profile connect requires --root PATH"))?;
            let ConnectProfileArgs {
                scenario,
                iterations,
                concurrency,
                output,
            } = profile;
            let report = mdbase_connect_core::profiling::run(
                mdbase_connect_core::profiling::ProfileOptions {
                    scenario: scenario.into(),
                    iterations,
                    concurrency,
                },
                root,
            )
            .map_err(CliError::internal)?;
            render_connect_profile(&report, output.as_deref(), args.json)?;
            Ok(0)
        }
        RootCommand::Connect { command } => {
            execute_connect(command, args.state_dir, args.endpoint, args.json).await?;
            Ok(0)
        }
    }
}

async fn execute_connect(
    command: ConnectCommand,
    state_dir: Option<PathBuf>,
    endpoint: Option<String>,
    json: bool,
) -> Result<(), CliError> {
    let ConnectPaths {
        state_dir,
        endpoint,
        target,
    } = connect_paths(state_dir, endpoint)?;

    match command {
        ConnectCommand::Paths => {
            print_result(
                json,
                OutputKind::Generic,
                &serde_json::json!({
                    "state_dir": state_dir,
                    "endpoint": endpoint,
                    "target": target.label()
                }),
            )?;
            Ok(())
        }
        ConnectCommand::Daemon(DaemonCommand::Run {
            server_url,
            loopback_port,
        }) => run_daemon(DaemonOptions {
            state_dir: Some(state_dir),
            endpoint: Some(endpoint),
            server_url,
            connector_token: (std::env::var("MDBASE_CONNECT_ENV").as_deref() == Ok("test"))
                .then(|| std::env::var("MDBASE_CONNECT_CONNECTOR_TOKEN").ok())
                .flatten(),
            loopback_port: Some(loopback_port),
        })
        .await
        .map_err(|error| CliError::internal(error.to_string())),
        ConnectCommand::Daemon(command) => {
            let value = execute_daemon_command(command, &state_dir, &endpoint, target).await?;
            print_result(json, OutputKind::Daemon, &value)?;
            Ok(())
        }
        ConnectCommand::Login {
            server,
            name,
            no_open,
        } => {
            let value = login(
                &state_dir,
                &endpoint,
                target,
                &server,
                name.as_deref(),
                no_open,
            )
            .await?;
            print_result(json, OutputKind::Account, &value)?;
            Ok(())
        }
        ConnectCommand::Logout => {
            let loopback_port = current_loopback_port(&endpoint).await;
            let response = send(&endpoint, ControlRequest::new(ControlCommand::AccountClear)).await;
            if !response.is_ok_and(|response| response.ok) {
                disconnect_cloud(&state_dir)
                    .map_err(|error| CliError::internal(error.to_string()))?;
            }
            restart_daemon(&state_dir, &endpoint, target, loopback_port).await?;
            print_result(
                json,
                OutputKind::Account,
                &serde_json::json!({"configured": false}),
            )?;
            Ok(())
        }
        ConnectCommand::Mirror(MirrorCommand::Promote {
            replica_id,
            no_open,
        }) => {
            let begun = successful_result(
                send(
                    &endpoint,
                    ControlRequest::new(ControlCommand::MirrorPromoteBegin(MirrorIdParams {
                        replica_id,
                    })),
                )
                .await?,
            )?;
            let verification = begun["verification_uri"].as_str().ok_or_else(|| {
                CliError::internal("The daemon returned no authority approval address.")
            })?;
            eprintln!("Approve the authority transfer in your browser:\n{verification}");
            if !no_open {
                service::open_url(verification).map_err(CliError::internal)?;
            }
            let completed = successful_result(
                send(
                    &endpoint,
                    ControlRequest::new(ControlCommand::MirrorPromoteComplete(MirrorIdParams {
                        replica_id,
                    })),
                )
                .await?,
            )?;
            print_result(json, OutputKind::Generic, &completed)?;
            Ok(())
        }
        ConnectCommand::Doctor => {
            let value = doctor(&state_dir, &endpoint, target).await;
            print_result(json, OutputKind::Doctor, &value)?;
            if value["healthy"] == Value::Bool(true) {
                Ok(())
            } else {
                Err(CliError::unavailable(
                    "The Connect daemon is not ready; run `mdbase connect daemon status`.",
                ))
            }
        }
        command => {
            let (control, output) = control_command(command)?;
            let result = successful_result(send(&endpoint, ControlRequest::new(control)).await?)?;
            print_result(json, output, &result)
        }
    }
}

#[cfg(test)]
mod tests;
