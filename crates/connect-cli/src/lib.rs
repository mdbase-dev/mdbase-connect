mod service;

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
    ControlRequest, ControlResponse, GrantIdParams, GrantUpdateParams,
    HostedCollectionCreateParams, HostedCollectionRenameParams, MirrorAddParams, MirrorIdParams,
    MirrorResolution, MirrorResolveParams, SyncReplicaMode, LOCAL_CONTROL_PROTOCOL_VERSION,
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
    },
    Sync {
        replica_id: Uuid,
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
                "encrypted_relay_protocol":
                    mdbase_connect_protocol::ENCRYPTED_RELAY_PROTOCOL_VERSION,
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
                let (_, endpoint) = connect_paths(args.state_dir, args.endpoint)?;
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

fn render_connect_profile(
    report: &mdbase_connect_core::profiling::ProfileReport,
    output: Option<&Path>,
    output_json: bool,
) -> Result<(), CliError> {
    let serialized = serde_json::to_string_pretty(report)
        .map_err(|error| CliError::internal(error.to_string()))?;
    if let Some(output) = output {
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| CliError::internal(error.to_string()))?;
        }
        std::fs::write(output, format!("{serialized}\n"))
            .map_err(|error| CliError::internal(error.to_string()))?;
    }
    if output_json {
        println!("{serialized}");
    } else {
        println!("Connect profile (read-only)");
        println!(
            "{:<26} {:>6} {:>11} {:>11} {:>11}",
            "operation", "runs", "mean", "p95", "max"
        );
        for operation in &report.operations {
            println!(
                "{:<26} {:>6} {:>8.2} ms {:>8.2} ms {:>8.2} ms",
                operation.name,
                operation.iterations,
                operation.mean_ms,
                operation.p95_ms,
                operation.max_ms,
            );
        }
    }
    Ok(())
}

fn render_data_result(value: &Value, pretty: bool, diagnostic: bool) -> Result<(), CliError> {
    let pretty = pretty || std::io::stdout().is_terminal();
    let rendered = if pretty {
        serde_json::to_string_pretty(value)
    } else {
        serde_json::to_string(value)
    }
    .map_err(|error| CliError::internal(error.to_string()))?;
    if diagnostic {
        eprintln!("{rendered}");
    } else {
        println!("{rendered}");
    }
    Ok(())
}

fn connect_paths(
    state_dir: Option<PathBuf>,
    endpoint: Option<String>,
) -> Result<(PathBuf, String), CliError> {
    let state_dir = state_dir
        .map(Ok)
        .unwrap_or_else(default_state_dir)
        .map_err(|error| CliError::internal(error.to_string()))?;
    let state_dir = std::path::absolute(state_dir).map_err(|error| {
        CliError::internal(format!("Could not resolve the state path: {error}"))
    })?;
    let endpoint = endpoint
        .map(resolve_control_endpoint)
        .transpose()?
        .unwrap_or_else(|| default_control_endpoint(&state_dir));
    Ok((state_dir, endpoint))
}

async fn execute_connect(
    command: ConnectCommand,
    state_dir: Option<PathBuf>,
    endpoint: Option<String>,
    json: bool,
) -> Result<(), CliError> {
    let (state_dir, endpoint) = connect_paths(state_dir, endpoint)?;

    match command {
        ConnectCommand::Paths => {
            print_result(
                json,
                OutputKind::Generic,
                &serde_json::json!({
                    "state_dir": state_dir,
                    "endpoint": endpoint
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
            let value = execute_daemon_command(command, &state_dir, &endpoint).await?;
            print_result(json, OutputKind::Daemon, &value)?;
            Ok(())
        }
        ConnectCommand::Login {
            server,
            name,
            no_open,
        } => {
            let value = login(&state_dir, &endpoint, &server, name.as_deref(), no_open).await?;
            print_result(json, OutputKind::Account, &value)?;
            Ok(())
        }
        ConnectCommand::Logout => {
            let response = send(&endpoint, ControlRequest::new(ControlCommand::AccountClear)).await;
            if !response.is_ok_and(|response| response.ok) {
                disconnect_cloud(&state_dir)
                    .map_err(|error| CliError::internal(error.to_string()))?;
            }
            restart_daemon(&state_dir, &endpoint).await?;
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
            let value = doctor(&state_dir, &endpoint).await;
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

#[cfg(unix)]
fn resolve_control_endpoint(endpoint: String) -> Result<String, CliError> {
    std::path::absolute(&endpoint)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| {
            CliError::internal(format!("Could not resolve the control endpoint: {error}"))
        })
}

#[cfg(windows)]
fn resolve_control_endpoint(endpoint: String) -> Result<String, CliError> {
    Ok(endpoint)
}

fn control_command(command: ConnectCommand) -> Result<(ControlCommand, OutputKind), CliError> {
    let pair = match command {
        ConnectCommand::Status => (ControlCommand::Status, OutputKind::Status),
        ConnectCommand::Whoami => (ControlCommand::AccessSnapshot, OutputKind::Account),
        ConnectCommand::Ping => (ControlCommand::Ping, OutputKind::Generic),
        ConnectCommand::Collection(CollectionCommand::List) => {
            (ControlCommand::CollectionList, OutputKind::Collections)
        }
        ConnectCommand::Collection(CollectionCommand::Add { path }) => (
            ControlCommand::CollectionAdd(CollectionPathParams {
                path: path_string(path)?,
            }),
            OutputKind::Collection,
        ),
        ConnectCommand::Collection(CollectionCommand::AddCopy { path }) => (
            ControlCommand::CollectionAddCopy(CollectionPathParams {
                path: path_string(path)?,
            }),
            OutputKind::Collection,
        ),
        ConnectCommand::Collection(CollectionCommand::Create { path, name }) => (
            ControlCommand::CollectionCreate(CollectionCreateParams {
                path: path_string(path)?,
                name,
            }),
            OutputKind::Collection,
        ),
        ConnectCommand::Collection(CollectionCommand::Remove { collection_id }) => (
            ControlCommand::CollectionRemove(CollectionIdParams { collection_id }),
            OutputKind::Generic,
        ),
        ConnectCommand::Collection(CollectionCommand::Validate { collection_id }) => (
            ControlCommand::CollectionValidate(CollectionIdParams { collection_id }),
            OutputKind::Generic,
        ),
        ConnectCommand::Collection(CollectionCommand::TransferAuthority {
            collection_id,
            target,
        }) => (
            ControlCommand::CollectionTransferAuthority(CollectionAuthorityTransferParams {
                collection_id,
                target: match target {
                    CliAuthorityTarget::Remote => AuthorityTarget::Remote,
                },
            }),
            OutputKind::Generic,
        ),
        ConnectCommand::Mirror(MirrorCommand::List) => {
            (ControlCommand::MirrorList, OutputKind::Mirrors)
        }
        ConnectCommand::Mirror(MirrorCommand::Add {
            collection_id,
            path,
            name,
            read_only,
            two_way: _,
        }) => (
            ControlCommand::MirrorAdd(MirrorAddParams {
                collection_id,
                path: path_string(path)?,
                mode: if read_only {
                    SyncReplicaMode::ReadOnly
                } else {
                    SyncReplicaMode::ReadWrite
                },
                name,
            }),
            OutputKind::Mirror,
        ),
        ConnectCommand::Mirror(MirrorCommand::Sync { replica_id }) => (
            ControlCommand::MirrorSync(MirrorIdParams { replica_id }),
            OutputKind::Mirror,
        ),
        ConnectCommand::Mirror(MirrorCommand::Resolve {
            replica_id,
            record_id,
            r#use,
        }) => (
            ControlCommand::MirrorResolve(MirrorResolveParams {
                replica_id,
                record_id,
                resolution: match r#use {
                    CliMirrorResolution::Local => MirrorResolution::Local,
                    CliMirrorResolution::Hosted => MirrorResolution::Remote,
                },
            }),
            OutputKind::Mirror,
        ),
        ConnectCommand::Mirror(MirrorCommand::Remove { replica_id, yes }) => {
            if !yes {
                return Err(CliError::usage(
                    "Mirror removal revokes its remote replica. Re-run with --yes to confirm.",
                ));
            }
            (
                ControlCommand::MirrorRemove(MirrorIdParams { replica_id }),
                OutputKind::Generic,
            )
        }
        ConnectCommand::Mirror(MirrorCommand::Promote { .. }) => {
            unreachable!("authority promotion is an interactive CLI flow")
        }
        ConnectCommand::Hosted(HostedCommand::List) => {
            (ControlCommand::HostedSnapshot, OutputKind::Generic)
        }
        ConnectCommand::Hosted(HostedCommand::Create { name }) => (
            ControlCommand::HostedCollectionCreate(HostedCollectionCreateParams { name }),
            OutputKind::Generic,
        ),
        ConnectCommand::Hosted(HostedCommand::Rename {
            collection_id,
            name,
        }) => (
            ControlCommand::HostedCollectionRename(HostedCollectionRenameParams {
                collection_id,
                name,
            }),
            OutputKind::Generic,
        ),
        ConnectCommand::Hosted(HostedCommand::Delete { collection_id, yes }) => {
            if !yes {
                return Err(CliError::usage(
                    "Hosted collection deletion is permanent. Re-run with --yes to confirm.",
                ));
            }
            (
                ControlCommand::HostedCollectionDelete(CollectionIdParams { collection_id }),
                OutputKind::Generic,
            )
        }
        ConnectCommand::Operation {
            collection_id,
            operation,
            input,
        } => (
            ControlCommand::CollectionOperation(CollectionOperationParams {
                collection_id,
                operation,
                input: serde_json::from_str::<Value>(&input).map_err(|error| {
                    CliError::usage(format!("--input is not valid JSON: {error}"))
                })?,
            }),
            OutputKind::Generic,
        ),
        ConnectCommand::Access(AccessCommand::List) => {
            (ControlCommand::AccessSnapshot, OutputKind::Access)
        }
        ConnectCommand::Access(AccessCommand::Pause) => (
            ControlCommand::AccessPause(AccessPauseParams { paused: true }),
            OutputKind::Generic,
        ),
        ConnectCommand::Access(AccessCommand::Resume) => (
            ControlCommand::AccessPause(AccessPauseParams { paused: false }),
            OutputKind::Generic,
        ),
        ConnectCommand::Access(AccessCommand::Approve {
            request_id,
            collection_id,
            operations,
        }) => (
            ControlCommand::AuthorizationApprove(AuthorizationApproveParams {
                request_id,
                collection_id,
                operations,
            }),
            OutputKind::Generic,
        ),
        ConnectCommand::Access(AccessCommand::Deny { request_id }) => (
            ControlCommand::AuthorizationDeny(AuthorizationIdParams { request_id }),
            OutputKind::Generic,
        ),
        ConnectCommand::Access(AccessCommand::Update {
            grant_id,
            operations,
        }) => (
            ControlCommand::GrantUpdate(GrantUpdateParams {
                grant_id,
                operations,
            }),
            OutputKind::Generic,
        ),
        ConnectCommand::Access(AccessCommand::Revoke { grant_id }) => (
            ControlCommand::GrantRevoke(GrantIdParams { grant_id }),
            OutputKind::Generic,
        ),
        ConnectCommand::Activity { limit } => (
            ControlCommand::ActivityList(ActivityListParams {
                limit: limit.clamp(1, 500),
            }),
            OutputKind::Activity,
        ),
        ConnectCommand::Daemon(_)
        | ConnectCommand::Doctor
        | ConnectCommand::Login { .. }
        | ConnectCommand::Logout
        | ConnectCommand::Paths => {
            unreachable!("handled before control dispatch")
        }
    };
    Ok(pair)
}

fn path_string(path: PathBuf) -> Result<String, CliError> {
    path.into_os_string()
        .into_string()
        .map_err(|_| CliError::usage("Collection paths must be valid UTF-8."))
}

fn successful_result(response: ControlResponse) -> Result<Value, CliError> {
    if response.protocol_version != LOCAL_CONTROL_PROTOCOL_VERSION {
        return Err(CliError::internal(format!(
            "The daemon uses unsupported local protocol {}; expected {}.",
            response.protocol_version, LOCAL_CONTROL_PROTOCOL_VERSION
        )));
    }
    if response.ok {
        return Ok(response.result.unwrap_or(Value::Null));
    }
    let error = response
        .error
        .unwrap_or(mdbase_connect_protocol::ControlError {
            code: "request_failed".to_string(),
            message: "The Connect daemon rejected the request.".to_string(),
            details: None,
        });
    Err(CliError {
        code: error.code,
        message: error.message,
        exit_code: 1,
    })
}

async fn execute_daemon_command(
    command: DaemonCommand,
    state_dir: &Path,
    endpoint: &str,
) -> Result<Value, CliError> {
    let executable = std::env::current_exe().map_err(|error| {
        CliError::internal(format!("Could not locate this executable: {error}"))
    })?;
    match command {
        DaemonCommand::Install => {
            let installed = service::installed();
            let running = send(endpoint, ControlRequest::new(ControlCommand::Ping))
                .await
                .is_ok_and(|response| response.ok);
            if installed {
                match service::stop() {
                    Ok(()) if running => wait_until_stopped(endpoint).await?,
                    Ok(()) => {}
                    Err(error) if running => return Err(CliError::internal(error)),
                    Err(_) => {}
                }
            } else if running {
                let response = send(
                    endpoint,
                    ControlRequest::new(ControlCommand::DaemonShutdown),
                )
                .await?;
                if !response.ok {
                    return Err(CliError::internal(
                        response
                            .error
                            .map(|error| error.message)
                            .unwrap_or_else(|| "The daemon refused to stop.".to_string()),
                    ));
                }
                wait_until_stopped(endpoint).await?;
            }
            service::install(&executable, state_dir)
                .map_err(CliError::internal)
                .map(|_| serde_json::json!({"installed": true}))
        }
        DaemonCommand::Uninstall => service::uninstall()
            .map_err(CliError::internal)
            .map(|_| serde_json::json!({"installed": false})),
        DaemonCommand::Start => {
            if send(endpoint, ControlRequest::new(ControlCommand::Ping))
                .await
                .is_ok_and(|response| response.ok)
            {
                return Ok(serde_json::json!({
                    "started": false,
                    "already_running": true
                }));
            }
            if service::installed() {
                service::start().map_err(CliError::internal)?;
            } else {
                service::spawn_detached(&executable, state_dir, endpoint)
                    .map_err(CliError::internal)?;
            }
            wait_until_ready(endpoint).await?;
            Ok(serde_json::json!({"started": true}))
        }
        DaemonCommand::Stop => {
            if service::installed() {
                service::stop().map_err(CliError::internal)?;
            } else {
                let response = send(
                    endpoint,
                    ControlRequest::new(ControlCommand::DaemonShutdown),
                )
                .await?;
                if !response.ok {
                    return Err(CliError::internal(
                        response
                            .error
                            .map(|error| error.message)
                            .unwrap_or_else(|| "The daemon refused to stop.".to_string()),
                    ));
                }
            }
            wait_until_stopped(endpoint).await?;
            Ok(serde_json::json!({"stopped": true}))
        }
        DaemonCommand::Restart => {
            restart_daemon(state_dir, endpoint).await?;
            Ok(serde_json::json!({"restarted": true}))
        }
        DaemonCommand::Status => {
            let installed = service::installed();
            let response = send(endpoint, ControlRequest::new(ControlCommand::Status)).await;
            Ok(match response {
                Ok(response) if response.ok => serde_json::json!({
                    "installed": installed,
                    "running": true,
                    "status": response.result
                }),
                _ => serde_json::json!({
                    "installed": installed,
                    "running": false
                }),
            })
        }
        DaemonCommand::Logs { lines, follow } => {
            service::logs(state_dir, lines, follow).map_err(CliError::internal)?;
            Ok(serde_json::json!({"shown": true}))
        }
        DaemonCommand::Run { .. } => unreachable!("foreground daemon handled before dispatch"),
    }
}

async fn doctor(state_dir: &Path, endpoint: &str) -> Value {
    let existed = state_dir.exists();
    let state_directory = match create_private_state_dir(state_dir) {
        Ok(()) if existed => "available",
        Ok(()) => "created",
        Err(_) => "unavailable",
    };
    let response = send(endpoint, ControlRequest::new(ControlCommand::Status)).await;
    let (daemon, status) = match response {
        Ok(response) if response.ok => ("ready", response.result),
        _ => ("unavailable", None),
    };
    serde_json::json!({
        "healthy": state_directory != "unavailable" && daemon == "ready",
        "state_directory": {
            "path": state_dir,
            "state": state_directory
        },
        "daemon": {
            "endpoint": endpoint,
            "state": daemon,
            "status": status
        },
        "service_installed": service::installed()
    })
}

fn create_private_state_dir(state_dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(state_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(state_dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
enum OutputKind {
    Status,
    Daemon,
    Doctor,
    Collections,
    Collection,
    Access,
    Activity,
    Account,
    Mirrors,
    Mirror,
    Generic,
}

fn print_result(json: bool, kind: OutputKind, value: &Value) -> Result<(), CliError> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(value)
                .map_err(|error| CliError::internal(error.to_string()))?
        );
        return Ok(());
    }
    println!("{}", render_human(kind, value));
    Ok(())
}

fn render_human(kind: OutputKind, value: &Value) -> String {
    match kind {
        OutputKind::Status => {
            let state = value["state"]
                .as_str()
                .unwrap_or("unknown")
                .replace('_', " ");
            let collections = value["registered_collections"].as_u64().unwrap_or(0);
            let paused = value["paused"].as_bool().unwrap_or(false);
            format!(
                "{}\nCollections: {}\nAccess: {}",
                sentence_case(&state),
                collections,
                if paused { "paused" } else { "available" }
            )
        }
        OutputKind::Daemon => {
            if value["running"] == Value::Bool(true) {
                "Daemon is running.".to_string()
            } else if value["installed"] == Value::Bool(true) {
                "Daemon is installed but not running.".to_string()
            } else if value["installed"] == Value::Bool(false) {
                "Daemon is not installed.".to_string()
            } else if value["shown"] == Value::Bool(true) {
                String::new()
            } else {
                value
                    .as_object()
                    .and_then(|object| object.keys().next())
                    .map(|key| format!("Daemon {}.", key.replace('_', " ")))
                    .unwrap_or_else(|| "Done.".to_string())
            }
        }
        OutputKind::Doctor => {
            let healthy = value["healthy"].as_bool().unwrap_or(false);
            let state = value["state_directory"]["state"]
                .as_str()
                .unwrap_or("unknown");
            let daemon = value["daemon"]["state"].as_str().unwrap_or("unknown");
            format!(
                "{}\nState directory: {}\nDaemon: {}",
                if healthy {
                    "Connect is healthy."
                } else {
                    "Connect needs attention."
                },
                state,
                daemon
            )
        }
        OutputKind::Collections => render_rows(
            value.as_array().map(Vec::as_slice).unwrap_or(&[]),
            &["NAME", "STATE", "ID", "PATH"],
            |item| {
                vec![
                    text(item, "display_name"),
                    if item["enabled"].as_bool().unwrap_or(false) {
                        "available".to_string()
                    } else {
                        "paused".to_string()
                    },
                    text(item, "id"),
                    text(item, "path"),
                ]
            },
            "No computer-owned collections.",
        ),
        OutputKind::Collection => {
            format!(
                "{}\n{}\n{}",
                text(value, "display_name"),
                text(value, "id"),
                text(value, "path")
            )
        }
        OutputKind::Access => {
            let requests = value["pending_authorizations"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let grants = value["grants"].as_array().map(Vec::as_slice).unwrap_or(&[]);
            format!(
                "Pending requests: {}\nActive grants: {}",
                requests.len(),
                grants.len()
            )
        }
        OutputKind::Activity => render_rows(
            value.as_array().map(Vec::as_slice).unwrap_or(&[]),
            &["TIME", "ACTION", "OUTCOME"],
            |item| {
                vec![
                    text(item, "occurred_at"),
                    text(item, "action"),
                    text(item, "outcome"),
                ]
            },
            "No recent activity.",
        ),
        OutputKind::Account => {
            if value["configured"] == Value::Bool(false) {
                return "This computer is not connected to an account.".to_string();
            }
            let account = value.get("account").unwrap_or(value);
            let user = account["user_name"].as_str().unwrap_or("Connected");
            let email = account["user_email"].as_str().unwrap_or("");
            let computer = account["connector_name"].as_str().unwrap_or("");
            [user, email, computer]
                .into_iter()
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        }
        OutputKind::Mirrors => render_rows(
            value.as_array().map(Vec::as_slice).unwrap_or(&[]),
            &["NAME", "STATE", "MODE", "ID", "PATH"],
            |item| {
                vec![
                    text(item, "name"),
                    text(item, "state").replace('_', " "),
                    text(item, "mode").replace('_', " "),
                    text(item, "replica_id"),
                    text(item, "path"),
                ]
            },
            "No hosted collection mirrors.",
        ),
        OutputKind::Mirror => {
            let error = value["error"].as_str();
            format!(
                "{}\n{}\n{}\n{}{}",
                text(value, "name"),
                text(value, "state").replace('_', " "),
                text(value, "path"),
                text(value, "replica_id"),
                error.map(|error| format!("\n{error}")).unwrap_or_default()
            )
        }
        OutputKind::Generic => {
            if value.is_null() || value == &serde_json::json!({}) {
                "Done.".to_string()
            } else {
                serde_json::to_string_pretty(value).unwrap_or_else(|_| "Done.".to_string())
            }
        }
    }
}

fn text(value: &Value, field: &str) -> String {
    value[field]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value[field].to_string().trim_matches('"').to_string())
}

fn sentence_case(value: &str) -> String {
    let mut characters = value.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
        None => String::new(),
    }
}

fn render_rows(
    values: &[Value],
    headings: &[&str],
    row: impl Fn(&Value) -> Vec<String>,
    empty: &str,
) -> String {
    if values.is_empty() {
        return empty.to_string();
    }
    let rows = values.iter().map(row).collect::<Vec<_>>();
    let mut widths = headings
        .iter()
        .map(|heading| heading.len())
        .collect::<Vec<_>>();
    for values in &rows {
        for (index, value) in values.iter().enumerate() {
            widths[index] = widths[index].max(value.chars().count());
        }
    }
    let format_row = |values: &[String]| {
        values
            .iter()
            .enumerate()
            .map(|(index, value)| format!("{value:<width$}", width = widths[index]))
            .collect::<Vec<_>>()
            .join("  ")
            .trim_end()
            .to_string()
    };
    let heading_values = headings
        .iter()
        .map(|heading| heading.to_string())
        .collect::<Vec<_>>();
    std::iter::once(format_row(&heading_values))
        .chain(rows.iter().map(|values| format_row(values)))
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Debug, serde::Deserialize)]
struct PairingBegin {
    pairing_id: Uuid,
    pairing_secret: String,
    verification_uri: String,
    expires_in: u64,
}

#[derive(Debug, serde::Deserialize)]
struct PairingExchange {
    status: String,
    token: Option<String>,
    connector: Option<Value>,
    error: Option<PairingError>,
}

#[derive(Debug, serde::Deserialize)]
struct PairingError {
    message: Option<String>,
}

async fn login(
    state_dir: &Path,
    endpoint: &str,
    server: &str,
    requested_name: Option<&str>,
    no_open: bool,
) -> Result<Value, CliError> {
    let configuration =
        CloudConfiguration::new(server).map_err(|error| CliError::usage(error.to_string()))?;
    let connector_name = requested_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(default_computer_name);
    if connector_name.chars().count() > 100 {
        return Err(CliError::usage(
            "Computer name must be between 1 and 100 characters.",
        ));
    }
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/v1/pairing-requests", configuration.server_url))
        .json(&serde_json::json!({"connector_name": connector_name}))
        .send()
        .await
        .map_err(|error| {
            CliError::unavailable(format!("Could not reach the Connect server: {error}"))
        })?;
    let status = response.status();
    let value = response.json::<Value>().await.map_err(|error| {
        CliError::internal(format!(
            "Connect returned an invalid pairing response: {error}"
        ))
    })?;
    if !status.is_success() {
        return Err(CliError {
            code: value
                .pointer("/error/code")
                .and_then(Value::as_str)
                .unwrap_or("pairing_failed")
                .to_string(),
            message: value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("Computer pairing could not begin.")
                .to_string(),
            exit_code: 1,
        });
    }
    let pairing = serde_json::from_value::<PairingBegin>(value).map_err(|error| {
        CliError::internal(format!("Connect returned invalid pairing details: {error}"))
    })?;
    if pairing.expires_in == 0
        || pairing.expires_in > 86_400
        || !valid_secret(&pairing.pairing_secret, "pair_")
    {
        return Err(CliError::internal(
            "Connect returned unsafe pairing details.",
        ));
    }
    let verification = url::Url::parse(&pairing.verification_uri)
        .map_err(|_| CliError::internal("Connect returned an invalid verification address."))?;
    let expected = url::Url::parse(&configuration.server_url)
        .map_err(|_| CliError::internal("Configured Connect server is invalid."))?;
    if verification.origin() != expected.origin()
        || !verification.username().is_empty()
        || verification.password().is_some()
    {
        return Err(CliError::internal(
            "Connect returned a verification address on another origin.",
        ));
    }
    eprintln!("Approve this computer in your browser:\n{verification}");
    if !no_open {
        service::open_url(verification.as_str()).map_err(CliError::internal)?;
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(pairing.expires_in);
    loop {
        if std::time::Instant::now() >= deadline {
            return Err(CliError {
                code: "pairing_expired".to_string(),
                message: "Computer approval expired before it was completed.".to_string(),
                exit_code: 1,
            });
        }
        let response = client
            .post(format!(
                "{}/v1/pairing-requests/{}/exchange",
                configuration.server_url, pairing.pairing_id
            ))
            .bearer_auth(&pairing.pairing_secret)
            .send()
            .await;
        match response {
            Ok(response) if response.status().as_u16() == 202 => {}
            Ok(response) => {
                let status = response.status();
                let exchange = response.json::<PairingExchange>().await.map_err(|error| {
                    CliError::internal(format!(
                        "Connect returned an invalid pairing result: {error}"
                    ))
                })?;
                if !status.is_success() {
                    return Err(CliError {
                        code: "pairing_failed".to_string(),
                        message: exchange
                            .error
                            .and_then(|error| error.message)
                            .unwrap_or_else(|| {
                                format!("Computer pairing failed with HTTP {status}.")
                            }),
                        exit_code: 1,
                    });
                }
                if exchange.status != "paired" {
                    return Err(CliError::internal(
                        "Connect returned an invalid pairing state.",
                    ));
                }
                let token = exchange.token.ok_or_else(|| {
                    CliError::internal("Connect returned no connector credential.")
                })?;
                let configured = send(
                    endpoint,
                    ControlRequest::new(ControlCommand::AccountConfigure(
                        mdbase_connect_protocol::AccountConfigureParams {
                            server_url: configuration.server_url.clone(),
                            connector_token: token.clone(),
                        },
                    )),
                )
                .await
                .is_ok_and(|response| response.ok);
                if !configured {
                    configure_cloud(state_dir, &configuration, &token)
                        .map_err(|error| CliError::internal(error.to_string()))?;
                }
                restart_daemon(state_dir, endpoint).await?;
                return Ok(serde_json::json!({
                    "configured": true,
                    "server_url": configuration.server_url,
                    "account": exchange.connector
                }));
            }
            Err(_) => {}
        }
        tokio::time::sleep(std::time::Duration::from_millis(1_500)).await;
    }
}

async fn restart_daemon(state_dir: &Path, endpoint: &str) -> Result<(), CliError> {
    if service::installed() {
        service::restart().map_err(CliError::internal)?;
    } else {
        let _ = send(
            endpoint,
            ControlRequest::new(ControlCommand::DaemonShutdown),
        )
        .await;
        wait_until_stopped(endpoint).await?;
        let executable = std::env::current_exe().map_err(|error| {
            CliError::internal(format!("Could not locate this executable: {error}"))
        })?;
        service::spawn_detached(&executable, state_dir, endpoint).map_err(CliError::internal)?;
    }
    wait_until_ready(endpoint).await
}

async fn wait_until_stopped(endpoint: &str) -> Result<(), CliError> {
    for _ in 0..100 {
        if send(endpoint, ControlRequest::new(ControlCommand::Ping))
            .await
            .is_err()
        {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Err(CliError::unavailable(
        "The Connect daemon did not stop within five seconds.",
    ))
}

async fn wait_until_ready(endpoint: &str) -> Result<(), CliError> {
    for _ in 0..200 {
        if send(endpoint, ControlRequest::new(ControlCommand::Ping))
            .await
            .is_ok_and(|response| {
                response.ok
                    && response
                        .result
                        .as_ref()
                        .and_then(|value| value["ready"].as_bool())
                        .unwrap_or(false)
            })
        {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Err(CliError::unavailable(
        "The Connect daemon did not become ready.",
    ))
}

fn default_computer_name() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "This computer".to_string())
        .chars()
        .take(100)
        .collect()
}

fn valid_secret(secret: &str, prefix: &str) -> bool {
    secret.starts_with(prefix) && secret.len() >= 24 && !secret.chars().any(char::is_whitespace)
}

async fn exchange<S>(stream: S, request: ControlRequest) -> Result<ControlResponse, CliError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (reader, mut writer) = tokio::io::split(stream);
    let request_id = request.id;
    let mut encoded =
        serde_json::to_vec(&request).map_err(|error| CliError::internal(error.to_string()))?;
    encoded.push(b'\n');
    writer
        .write_all(&encoded)
        .await
        .map_err(|error| CliError::unavailable(error.to_string()))?;
    const MAX_LOCAL_CONTROL_RESPONSE_BYTES: u64 = 32 * 1024 * 1024;
    let mut reader = BufReader::new(reader.take(MAX_LOCAL_CONTROL_RESPONSE_BYTES + 1));
    let mut line = Vec::new();
    let read = reader
        .read_until(b'\n', &mut line)
        .await
        .map_err(|error| CliError::unavailable(error.to_string()))?;
    if read == 0 {
        return Err(CliError::unavailable(
            "The daemon closed without a response.",
        ));
    }
    if line.len() as u64 > MAX_LOCAL_CONTROL_RESPONSE_BYTES || line.last() != Some(&b'\n') {
        return Err(CliError::internal(
            "The daemon returned an oversized or incomplete response.",
        ));
    }
    line.pop();
    let response: ControlResponse = serde_json::from_slice(&line).map_err(|error| {
        CliError::internal(format!("The daemon returned an invalid response: {error}"))
    })?;
    if response.id != request_id {
        return Err(CliError::internal(
            "The daemon returned a response for a different request.",
        ));
    }
    if response.protocol_version != LOCAL_CONTROL_PROTOCOL_VERSION {
        return Err(CliError::internal(format!(
            "The daemon uses unsupported local protocol {}; expected {}.",
            response.protocol_version, LOCAL_CONTROL_PROTOCOL_VERSION
        )));
    }
    Ok(response)
}

#[cfg(unix)]
async fn send(endpoint: &str, request: ControlRequest) -> Result<ControlResponse, CliError> {
    let timeout = control_request_timeout(&request.command);
    tokio::time::timeout(timeout, async {
        let stream = tokio::net::UnixStream::connect(endpoint)
            .await
            .map_err(|error| {
                CliError::unavailable(format!(
                    "Could not connect to the Connect daemon at {endpoint}: {error}"
                ))
            })?;
        exchange(stream, request).await
    })
    .await
    .map_err(|_| CliError::unavailable("The Connect daemon request timed out."))?
}

#[cfg(windows)]
async fn send(endpoint: &str, request: ControlRequest) -> Result<ControlResponse, CliError> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let timeout = control_request_timeout(&request.command);
    tokio::time::timeout(timeout, async {
        let stream = ClientOptions::new().open(endpoint).map_err(|error| {
            CliError::unavailable(format!(
                "Could not connect to the Connect daemon at {endpoint}: {error}"
            ))
        })?;
        exchange(stream, request).await
    })
    .await
    .map_err(|_| CliError::unavailable("The Connect daemon request timed out."))?
}

fn control_request_timeout(command: &ControlCommand) -> std::time::Duration {
    let seconds = match command {
        ControlCommand::MirrorAdd(_)
        | ControlCommand::MirrorSync(_)
        | ControlCommand::MirrorResolve(_)
        | ControlCommand::MirrorPromoteComplete(_)
        | ControlCommand::CollectionTransferAuthority(_) => 15 * 60,
        ControlCommand::CollectionOperation(_) => 2 * 60,
        _ => 30,
    };
    std::time::Duration::from_secs(seconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_keeps_data_and_connect_namespaces_unambiguous() {
        let direct =
            Args::try_parse_from(["mdbase", "--root", "/data/notes", "read", "note.md"]).unwrap();
        assert!(matches!(
            direct.command,
            RootCommand::Data(DataCommand::Read { .. })
        ));

        let control =
            Args::try_parse_from(["mdbase", "--json", "connect", "daemon", "status"]).unwrap();
        assert!(matches!(
            control.command,
            RootCommand::Connect {
                command: ConnectCommand::Daemon(DaemonCommand::Status)
            }
        ));
    }

    #[test]
    fn parser_rejects_ambiguous_data_targets() {
        let error = Args::try_parse_from([
            "mdbase",
            "--root",
            "/data/notes",
            "--collection",
            "01900000-0000-7000-8000-000000000000",
            "read",
            "note.md",
        ])
        .unwrap_err();
        assert_eq!(error.kind(), clap::error::ErrorKind::ArgumentConflict);
    }

    #[test]
    fn human_status_is_quiet_and_explicit() {
        let value = serde_json::json!({
            "state": "connected",
            "registered_collections": 2,
            "paused": false
        });
        assert_eq!(
            render_human(OutputKind::Status, &value),
            "Connected\nCollections: 2\nAccess: available"
        );
    }

    #[test]
    fn collection_table_has_stable_columns() {
        let value = serde_json::json!([{
            "display_name": "Notes",
            "enabled": true,
            "id": "01900000-0000-7000-8000-000000000000",
            "path": "/data/notes"
        }]);
        let rendered = render_human(OutputKind::Collections, &value);
        assert!(rendered.starts_with("NAME"));
        assert!(rendered.contains("Notes"));
        assert!(rendered.contains("available"));
        assert!(!rendered.contains('{'));
    }

    #[test]
    fn invalid_operation_json_is_a_usage_error() {
        let result = control_command(ConnectCommand::Operation {
            collection_id: Uuid::nil(),
            operation: "query".to_string(),
            input: "{".to_string(),
        });
        let error = result.unwrap_err();
        assert_eq!(error.code, "invalid_input");
        assert_eq!(error.exit_code, 2);
    }
}
