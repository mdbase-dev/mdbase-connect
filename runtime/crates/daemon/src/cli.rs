//! The `mdbase` command line.
//!
//! Commands are requests to the daemon, never independent state owners (the
//! connector's rule, `cli-daemon.md`). Output is calm and human by default;
//! `--json` prints the result object (or `{"error": {...}}`) on stdout, so scripts
//! and the desktop can rely on it. Diagnostics go to stderr.
//!
//! Exit codes: 0 success; 1 the daemon reported an error; 2 usage; 3 the daemon is
//! not running (or not ready, for commands that need it); 4 a daemon is already
//! running (`daemon run`).

use std::io::{BufRead, IsTerminal, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use clap::{Parser, Subcommand, ValueEnum};
use serde_json::{Value, json};

use crate::client::{self, ClientError, ControlClient};
use crate::control::{Check, CollectionStatus, ControlError, DaemonStatus, Method, PendingDevice};
use crate::paths::Profile;
use crate::registry::SyncMode;
use crate::server::{self, RunError};

/// How long `daemon start` waits for readiness.
pub const START_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Parser)]
#[command(
    name = "mdbase",
    version = crate::BINARY_VERSION,
    about = "mdbase: your Markdown collections, synced."
)]
struct Cli {
    /// Use an isolated profile in this directory instead of the installed service
    /// (also `MDBASE_HOME`).
    #[arg(long, global = true, value_name = "DIR")]
    state_dir: Option<PathBuf>,
    /// Print machine-readable JSON.
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Daemon and collection overview.
    Status,
    /// Manage the background daemon.
    #[command(subcommand)]
    Daemon(DaemonCmd),
    /// Register, list and remove collections.
    #[command(subcommand)]
    Collection(CollectionCmd),
    /// Files held instead of overwritten, waiting for you to resolve them.
    Holds {
        /// Collection ID, ID prefix or name.
        collection: String,
    },
    /// Resolve a held file: keep mine, take theirs, keep both or delete.
    Resolve {
        /// Collection ID, ID prefix or name.
        collection: String,
        /// Record or file ID (from `holds`).
        id: String,
        /// `keep_mine`, `take_theirs`, `keep_both` or `delete`.
        how: String,
    },
    /// Unresolved field conflicts.
    Conflicts {
        /// Collection ID, ID prefix or name.
        collection: String,
    },
    /// Turn sync on or off (moves the collection's log).
    #[command(subcommand)]
    Sync(SyncCmd),
    /// Approve new devices for an end-to-end synced collection.
    #[command(subcommand)]
    Device(DeviceCmd),
    /// Recovery keys for end-to-end synced collections.
    #[command(subcommand)]
    Recovery(RecoveryCmd),
    /// Your private collections' account key: an encryption password and a
    /// recovery key, so your other devices can unlock without this one.
    #[command(subcommand)]
    Private(PrivateCmd),
    /// Check the daemon, keychain, state directory and collections.
    Doctor,
    /// Show the daemon log.
    Logs {
        /// Lines from the end.
        #[arg(short = 'n', long, default_value_t = 200)]
        lines: usize,
        /// Keep printing new lines.
        #[arg(short, long)]
        follow: bool,
    },
    /// Apps that can use your local collections through this computer.
    #[command(subcommand)]
    Access(AccessCmd),
    /// Sign this computer in to your mdbase account (or out).
    #[command(subcommand)]
    Account(AccountCmd),
    /// Take over the collections today's mdbase Connect serves on this computer.
    #[command(subcommand)]
    Migrate(MigrateCmd),
    /// Device settings.
    Settings {
        /// Require approval on this computer before a new app can use a local
        /// collection (`on` or `off`).
        #[arg(long, value_name = "on|off")]
        require_approval: Option<OnOff>,
    },
    /// Show the app-access tray for this profile; review uses the daemon's dialog.
    /// Does not install or start the daemon.
    Companion,
    /// Paths of this profile.
    Paths,
    /// Start at login through the OS service manager (systemd, launchd, Task Scheduler).
    #[command(subcommand)]
    Service(crate::service::ServiceCmd),
}

#[derive(Debug, Subcommand)]
enum DaemonCmd {
    /// Run in the foreground (service managers, tests, debugging).
    Run,
    /// Start in the background and wait until it is ready.
    Start,
    /// Stop gracefully.
    Stop,
    /// Readiness and version.
    Status,
}

#[derive(Debug, Subcommand)]
enum CollectionCmd {
    /// List registered collections.
    List,
    /// Register a folder as a local collection.
    Add {
        /// Folder.
        path: PathBuf,
        /// Display name (default: the folder name).
        #[arg(long)]
        name: Option<String>,
    },
    /// Join your account's cloud copy into an empty folder on this computer.
    Join {
        /// The collection's ID (from another of your devices or the web).
        collection: String,
        /// An empty folder.
        path: PathBuf,
        /// Display name (default: the folder name).
        #[arg(long)]
        name: Option<String>,
    },
    /// Unregister a collection. Its files are never touched.
    Remove {
        /// Collection ID, ID prefix or name.
        collection: String,
    },
    /// Stop serving a collection until resumed.
    Pause {
        /// Collection ID, ID prefix or name.
        collection: String,
    },
    /// Serve a paused collection again.
    Resume {
        /// Collection ID, ID prefix or name.
        collection: String,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum SyncKind {
    /// Synced, with a copy web apps and agents can use while your devices are off.
    Synced,
    /// Synced end-to-end encrypted: mdbase cannot read it; web apps work only
    /// while one of your devices is online.
    E2e,
}

#[derive(Debug, Subcommand)]
enum SyncCmd {
    /// Move the log to mdbase's hosted log service.
    Enable {
        /// Collection ID, ID prefix or name.
        collection: String,
        /// `synced` (default) or `e2e`.
        #[arg(long, value_enum, default_value = "synced")]
        mode: SyncKind,
    },
    /// Move the log back to this device (local only).
    Disable {
        /// Collection ID, ID prefix or name.
        collection: String,
    },
}

#[derive(Debug, Subcommand)]
enum MigrateCmd {
    /// Takeover progress per collection (works with the daemon stopped).
    Status,
    /// Explicitly run or resume takeover (automatic runs wait for the account's batch flip).
    Start {
        /// Proceed past old hosted mirror folders once their upload queues are
        /// empty; they stop syncing until they join the migrated collection.
        #[arg(long)]
        stop_mirrors: bool,
    },
}

#[derive(Debug, Subcommand)]
enum AccountCmd {
    /// Sign in: approve this computer in your browser.
    SignIn {
        /// Server: only this build's environment (production builds:
        /// https://connect.mdbase.dev; LAB builds: https://connect-lab.mdbase.dev),
        /// which is also the default.
        #[arg(long)]
        server: Option<String>,
    },
    /// Sign out: apps stop reaching your local collections through this computer.
    SignOut,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum OnOff {
    On,
    Off,
}

#[derive(Debug, Subcommand)]
enum AccessCmd {
    /// List apps and their state.
    List {
        /// Only this collection (ID, ID prefix or name).
        collection: Option<String>,
    },
    /// Stop an app from using a local collection through this computer.
    Revoke {
        /// Grant ID.
        grant: String,
    },
    /// Approve an app that is waiting (when approval is required).
    Approve {
        /// Grant ID.
        grant: String,
    },
    /// Decline an app that is waiting.
    Deny {
        /// Grant ID.
        grant: String,
    },
    /// Mark a new-access notice as seen.
    Ack {
        /// Grant ID.
        grant: String,
    },
}

#[derive(Debug, Subcommand)]
enum DeviceCmd {
    /// Devices waiting for approval, with their six-digit codes.
    Pending {
        /// Collection ID, ID prefix or name.
        collection: String,
    },
    /// Approve a device after checking its code matches the one on its screen.
    Approve {
        /// Collection ID, ID prefix or name.
        collection: String,
        /// Device ID.
        device: String,
        /// The six-digit code shown on the new device.
        #[arg(long)]
        code: String,
    },
    /// Do not approve a device.
    Reject {
        /// Collection ID, ID prefix or name.
        collection: String,
        /// Device ID.
        device: String,
    },
}

#[derive(Debug, Subcommand)]
enum PrivateCmd {
    /// Whether the account key is set up, and this device unlocked.
    Status,
    /// Set an encryption password; prints a recovery key once.
    Setup,
    /// Unlock this device with the encryption password (or `--recovery-key`).
    Unlock {
        /// Read the recovery key instead of the password.
        #[arg(long)]
        recovery_key: bool,
    },
    /// Change the encryption password.
    Password {
        /// Prove it with the recovery key (a forgotten password).
        #[arg(long)]
        recovery_key: bool,
    },
    /// Strict mode: no account key held by the server; new devices only by
    /// approval from an existing device.
    Strict,
}

#[derive(Debug, Subcommand)]
enum RecoveryCmd {
    /// Create a recovery key. It is shown once; write it down.
    Create {
        /// Collection ID, ID prefix or name.
        collection: String,
    },
    /// Restore access with a recovery key, read from stdin (never an argument).
    Import {
        /// Collection ID, ID prefix or name.
        collection: String,
    },
}

/// Entry point for the `mdbase` binary.
pub fn main() -> ExitCode {
    let cli = Cli::parse();
    let profile = match Profile::resolve(cli.state_dir.as_deref()) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::from(2);
        }
    };
    if let Command::Daemon(DaemonCmd::Run) = cli.command {
        return run_daemon(profile);
    }
    // AppKit and the Windows tray/message pump stay on the process main thread.
    // The companion owns its worker runtime, separate from the ordinary CLI loop.
    if let Command::Companion = cli.command {
        return run_companion(profile, cli.json);
    }
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::from(1);
        }
    };
    let out = Output { json: cli.json };
    rt.block_on(dispatch(cli.command, &profile, &out))
}

fn run_companion(profile: Profile, json_output: bool) -> ExitCode {
    let out = Output { json: json_output };
    if json_output {
        out.value(&json!({"error": ControlError::unavailable("companion_requires_ui", "companion is an interactive tray; omit --json")}));
        return ExitCode::from(2);
    }
    match crate::desktop::run(profile) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::from(1)
        }
    }
}

fn run_daemon(profile: Profile) -> ExitCode {
    if let Err(e) = crate::fsutil::ensure_private_dir(&profile.log_dir()) {
        eprintln!("error: log directory: {e}");
        return ExitCode::from(1);
    }
    init_logging(&profile);
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::from(1);
        }
    };
    match rt.block_on(server::run(profile, None)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(RunError::AlreadyRunning) => {
            eprintln!("error: a daemon is already running for this profile");
            ExitCode::from(4)
        }
        Err(e) => {
            tracing::error!(error = %e, "daemon failed");
            eprintln!("error: {e}");
            ExitCode::from(1)
        }
    }
}

const LOG_ROTATE_BYTES: u64 = 10 * 1024 * 1024;

fn init_logging(profile: &Profile) {
    use tracing_subscriber::fmt::writer::MakeWriterExt;
    let path = profile.log_file();
    if std::fs::metadata(&path)
        .map(|m| m.len() > LOG_ROTATE_BYTES)
        .unwrap_or(false)
    {
        let _ = std::fs::rename(&path, path.with_extension("log.1"));
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path);
    let filter = tracing_subscriber::EnvFilter::try_from_env("MDBASE_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let builder = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(false);
    match file {
        Ok(f) => {
            let _ = builder
                .with_writer(std::sync::Mutex::new(f).and(std::io::stderr))
                .try_init();
        }
        Err(_) => {
            let _ = builder.with_writer(std::io::stderr).try_init();
        }
    }
}

struct Output {
    json: bool,
}

impl Output {
    fn value(&self, v: &Value) {
        println!("{}", serde_json::to_string_pretty(v).unwrap_or_default());
    }

    fn error(&self, e: &ClientError) -> ExitCode {
        let (code, obj) = match e {
            ClientError::NotRunning => (
                3,
                ControlError::unavailable(
                    "daemon_not_running",
                    "the mdbase daemon is not running; start it with `mdbase daemon start`",
                ),
            ),
            ClientError::Remote(err) => (
                if err.reason.as_deref() == Some("not_ready") {
                    3
                } else {
                    1
                },
                err.clone(),
            ),
            other => (
                1,
                ControlError::unavailable("daemon_unreachable", other.to_string()),
            ),
        };
        if self.json {
            self.value(&json!({ "error": obj }));
        } else {
            eprintln!("error: {}", obj.message);
            if let Some(r) = &obj.reason {
                eprintln!("       ({}: {r})", obj.code);
            }
        }
        ExitCode::from(code)
    }
}

async fn call(profile: &Profile, method: &str, params: Value) -> Result<Value, ClientError> {
    let mut c = ControlClient::connect(&profile.control).await?;
    if crate::control::PRIVILEGED.contains(&method) {
        let store = crate::secrets::store_for(&profile.secret_namespace(), &profile.state_dir);
        c.authenticate(store.as_ref()).await?;
    }
    c.call(method, params).await
}

/// Resolve a collection argument: exact ID, unique ID prefix, or exact name.
async fn resolve(profile: &Profile, arg: &str) -> Result<String, ClientError> {
    let list = call(profile, Method::COLLECTION_LIST, json!({})).await?;
    let list: Vec<CollectionStatus> =
        serde_json::from_value(list).map_err(|e| ClientError::Protocol(e.to_string()))?;
    if list.iter().any(|c| c.id == arg) {
        return Ok(arg.to_string());
    }
    let matches: Vec<&CollectionStatus> = list
        .iter()
        .filter(|c| c.name == arg || (arg.len() >= 4 && c.id.starts_with(arg)))
        .collect();
    match matches.as_slice() {
        [one] => Ok(one.id.clone()),
        [] => Err(ClientError::Remote(ControlError::not_found(format!(
            "no registered collection matches {arg:?}"
        )))),
        _ => Err(ClientError::Remote(ControlError::invalid(
            "ambiguous_collection",
            format!("{arg:?} matches several collections; use the ID"),
        ))),
    }
}

async fn dispatch(cmd: Command, profile: &Profile, out: &Output) -> ExitCode {
    let result = run_command(cmd, profile, out).await;
    match result {
        Ok(code) => code,
        Err(e) => out.error(&e),
    }
}

async fn run_command(
    cmd: Command,
    profile: &Profile,
    out: &Output,
) -> Result<ExitCode, ClientError> {
    match cmd {
        Command::Daemon(DaemonCmd::Run) | Command::Companion => {
            unreachable!("handled before the runtime starts")
        }
        Command::Daemon(DaemonCmd::Start) => daemon_start(profile, out).await,
        Command::Daemon(DaemonCmd::Stop) => daemon_stop(profile, out).await,
        Command::Daemon(DaemonCmd::Status) => {
            let r = client::ping(&profile.control).await?;
            if out.json {
                out.value(&json!({ "readiness": r, "target": profile.target }));
            } else if r.ready {
                println!("ready (version {}, {:?})", r.binary_version, profile.target);
            } else {
                println!(
                    "not ready: {} (version {})",
                    r.safe_reason
                        .and_then(|s| serde_json::to_value(s).ok())
                        .and_then(|v| v.as_str().map(str::to_string))
                        .unwrap_or_else(|| "unknown".into()),
                    r.binary_version
                );
            }
            Ok(if r.ready {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(3)
            })
        }
        Command::Status => {
            let v = call(profile, Method::STATUS, json!({})).await?;
            if out.json {
                out.value(&v);
            } else {
                let s: DaemonStatus =
                    serde_json::from_value(v).map_err(|e| ClientError::Protocol(e.to_string()))?;
                print_status(&s);
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Collection(CollectionCmd::List) => {
            let v = call(profile, Method::COLLECTION_LIST, json!({})).await?;
            if out.json {
                out.value(&v);
            } else {
                let list: Vec<CollectionStatus> =
                    serde_json::from_value(v).map_err(|e| ClientError::Protocol(e.to_string()))?;
                if list.is_empty() {
                    println!("No collections. Add one with `mdbase collection add <folder>`.");
                }
                for c in &list {
                    print_collection(c);
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Collection(CollectionCmd::Add { path, name }) => {
            let path = std::path::absolute(&path).map_err(ClientError::Io)?;
            let v = call(
                profile,
                Method::COLLECTION_ADD,
                json!({ "path": path, "name": name }),
            )
            .await?;
            if out.json {
                out.value(&v);
            } else {
                let c: CollectionStatus =
                    serde_json::from_value(v).map_err(|e| ClientError::Protocol(e.to_string()))?;
                println!("Registered {} ({}).", c.name, c.id);
                print_collection(&c);
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Collection(CollectionCmd::Join {
            collection,
            path,
            name,
        }) => {
            let path = std::path::absolute(&path).map_err(ClientError::Io)?;
            let v = call(
                profile,
                Method::COLLECTION_JOIN,
                json!({ "collection": collection, "path": path, "name": name }),
            )
            .await?;
            if out.json {
                out.value(&v);
            } else {
                let c: CollectionStatus =
                    serde_json::from_value(v).map_err(|e| ClientError::Protocol(e.to_string()))?;
                println!(
                    "Joined {} ({}). Its files arrive once this computer is keyed.",
                    c.name, c.id
                );
                print_collection(&c);
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Collection(CollectionCmd::Remove { collection }) => {
            let id = resolve(profile, &collection).await?;
            let v = call(
                profile,
                Method::COLLECTION_REMOVE,
                json!({ "collection": id }),
            )
            .await?;
            if out.json {
                out.value(&v);
            } else {
                println!("Unregistered {id}. Its files were not touched.");
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Collection(CollectionCmd::Pause { collection }) => {
            simple(
                profile,
                out,
                Method::COLLECTION_PAUSE,
                &collection,
                json!({}),
            )
            .await
        }
        Command::Collection(CollectionCmd::Resume { collection }) => {
            simple(
                profile,
                out,
                Method::COLLECTION_RESUME,
                &collection,
                json!({}),
            )
            .await
        }
        Command::Holds { collection } => {
            simple(
                profile,
                out,
                Method::COLLECTION_HOLDS,
                &collection,
                json!({}),
            )
            .await
        }
        Command::Resolve {
            collection,
            id,
            how,
        } => {
            simple(
                profile,
                out,
                Method::COLLECTION_RESOLVE_HOLD,
                &collection,
                json!({ "id": id, "how": how }),
            )
            .await
        }
        Command::Conflicts { collection } => {
            simple(
                profile,
                out,
                Method::COLLECTION_CONFLICTS,
                &collection,
                json!({}),
            )
            .await
        }
        Command::Sync(SyncCmd::Enable { collection, mode }) => {
            let mode = match mode {
                SyncKind::Synced => SyncMode::Synced,
                SyncKind::E2e => SyncMode::SyncedE2e,
            };
            simple(
                profile,
                out,
                Method::SYNC_ENABLE,
                &collection,
                json!({ "mode": mode }),
            )
            .await
        }
        Command::Sync(SyncCmd::Disable { collection }) => {
            simple(profile, out, Method::SYNC_DISABLE, &collection, json!({})).await
        }
        Command::Device(DeviceCmd::Pending { collection }) => {
            let id = resolve(profile, &collection).await?;
            let v = call(profile, Method::DEVICE_PENDING, json!({ "collection": id })).await?;
            if out.json {
                out.value(&v);
            } else {
                let list: Vec<PendingDevice> =
                    serde_json::from_value(v).map_err(|e| ClientError::Protocol(e.to_string()))?;
                if list.is_empty() {
                    println!("No devices are waiting for approval.");
                }
                for d in list {
                    println!(
                        "{}  {}  code {} {}",
                        d.device,
                        d.kind,
                        &d.code[..3.min(d.code.len())],
                        &d.code[3.min(d.code.len())..]
                    );
                }
                println!(
                    "Approve a device only if the same code is shown on its screen:\n  \
                     mdbase device approve {collection} <device> --code <six digits>"
                );
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Device(DeviceCmd::Approve {
            collection,
            device,
            code,
        }) => {
            let code: String = code.chars().filter(|c| !c.is_whitespace()).collect();
            simple(
                profile,
                out,
                Method::DEVICE_APPROVE,
                &collection,
                json!({ "device": device, "code": code }),
            )
            .await
        }
        Command::Device(DeviceCmd::Reject { collection, device }) => {
            simple(
                profile,
                out,
                Method::DEVICE_REJECT,
                &collection,
                json!({ "device": device }),
            )
            .await
        }
        Command::Recovery(RecoveryCmd::Create { collection }) => {
            let id = resolve(profile, &collection).await?;
            let v = call(
                profile,
                Method::RECOVERY_CREATE,
                json!({ "collection": id }),
            )
            .await?;
            if out.json {
                out.value(&v);
            } else {
                let key = v.get("recovery_key").and_then(Value::as_str).unwrap_or("");
                println!(
                    "Recovery key (shown once; store it somewhere safe and offline):\n\n  {key}\n"
                );
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Recovery(RecoveryCmd::Import { collection }) => {
            if std::io::stdin().is_terminal() {
                eprintln!("Type or paste the recovery key, then press Enter:");
            }
            let mut key = String::new();
            std::io::stdin()
                .read_line(&mut key)
                .map_err(ClientError::Io)?;
            let key = key.trim().to_string();
            simple(
                profile,
                out,
                Method::RECOVERY_IMPORT,
                &collection,
                json!({ "recovery_key": key }),
            )
            .await
        }
        Command::Private(cmd) => private(profile, out, cmd).await,
        Command::Doctor => {
            let v = call(profile, Method::DOCTOR, json!({})).await;
            let v = match v {
                Ok(v) => v,
                Err(ClientError::NotRunning) => serde_json::to_value(vec![Check {
                    id: "daemon".into(),
                    status: "fail".into(),
                    detail: format!("nothing is listening on {}", profile.control),
                    action: Some("Start it with `mdbase daemon start`.".into()),
                }])
                .unwrap_or_default(),
                Err(e) => return Err(e),
            };
            let mut checks: Vec<Check> =
                serde_json::from_value(v).map_err(|e| ClientError::Protocol(e.to_string()))?;
            if !checks.iter().any(|c| c.id == "daemon") {
                checks.push(replica_endpoint_check(profile).await);
            }
            let v = serde_json::to_value(&checks).unwrap_or_default();
            if out.json {
                out.value(&v);
            } else {
                for c in &checks {
                    println!("[{:>4}] {}: {}", c.status, c.id, c.detail);
                    if let Some(a) = &c.action {
                        println!("       → {a}");
                    }
                }
            }
            Ok(if checks.iter().any(|c| c.status == "fail") {
                ExitCode::from(1)
            } else {
                ExitCode::SUCCESS
            })
        }
        Command::Logs { lines, follow } => logs(profile, lines, follow).await,
        Command::Access(cmd) => access_command(profile, out, cmd).await,
        Command::Account(AccountCmd::SignIn { server }) => {
            let v = call(
                profile,
                Method::ACCOUNT_SIGN_IN,
                json!({ "server_url": server, "name": hostname() }),
            )
            .await?;
            let uri = v
                .get("verification_uri")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if out.json {
                out.value(&v);
                return Ok(ExitCode::SUCCESS);
            }
            println!("Approve this computer in your browser:\n\n  {uri}\n");
            open_browser(&uri);
            let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
            loop {
                tokio::time::sleep(Duration::from_secs(2)).await;
                let s: DaemonStatus =
                    serde_json::from_value(call(profile, Method::STATUS, json!({})).await?)
                        .map_err(|e| ClientError::Protocol(e.to_string()))?;
                if s.account.signed_in && s.account.pairing.is_none() {
                    println!("Signed in.");
                    return Ok(ExitCode::SUCCESS);
                }
                if let Some(e) = s.account.last_error.filter(|_| s.account.pairing.is_none()) {
                    return Err(ClientError::Remote(ControlError::unavailable(
                        "sign_in_failed",
                        e,
                    )));
                }
                if tokio::time::Instant::now() > deadline {
                    return Err(ClientError::Timeout);
                }
            }
        }
        Command::Account(AccountCmd::SignOut) => {
            let v = call(profile, Method::ACCOUNT_SIGN_OUT, json!({})).await?;
            if out.json {
                out.value(&v);
            } else {
                println!(
                    "Signed out. Apps can no longer reach your local collections through this computer."
                );
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Settings { require_approval } => {
            let v = match require_approval {
                None => call(profile, Method::SETTINGS_GET, json!({})).await?,
                Some(o) => {
                    let on = matches!(o, OnOff::On);
                    if !on && !confirm("Let new apps use local collections without asking first?") {
                        return Ok(ExitCode::from(1));
                    }
                    call(
                        profile,
                        Method::SETTINGS_SET,
                        json!({ "require_grant_approval": on }),
                    )
                    .await?
                }
            };
            if out.json {
                out.value(&v);
            } else {
                let on = v
                    .get("require_grant_approval")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                println!(
                    "New apps for local collections: {}",
                    if on {
                        "wait for your approval here"
                    } else {
                        "allowed, and you are notified"
                    }
                );
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Service(cmd) => Ok(crate::service::run(cmd, profile, out.json).await),
        Command::Migrate(MigrateCmd::Status) => {
            let v = match call(profile, Method::MIGRATE_STATUS, json!({})).await {
                Ok(v) => v,
                Err(ClientError::NotRunning) => {
                    let path =
                        crate::takeover::Paths::new(&profile.state_dir, profile.store_ids_file())
                            .record;
                    let record = crate::takeover::record::Record::load(&path).map_err(|e| {
                        ClientError::Remote(ControlError::internal(format!("takeover record: {e}")))
                    })?;
                    let waiting = record.is_none()
                        && crate::takeover::old_state_dir(profile)
                            .is_some_and(|p| p.join("connector.sqlite").is_file());
                    json!({ "record": record, "daemon": "not_running", "waiting_for_migration_batch": waiting,
                        "held_interrupted_writes": record.as_ref().map(|r| r.held_interrupted_writes()).unwrap_or(0) })
                }
                Err(e) => return Err(e),
            };
            migrate_print(out, &v);
            Ok(ExitCode::SUCCESS)
        }
        Command::Migrate(MigrateCmd::Start { stop_mirrors }) => {
            let v = call(
                profile,
                Method::MIGRATE_START,
                json!({ "stop_mirrors": stop_mirrors }),
            )
            .await?;
            migrate_print(out, &v);
            Ok(ExitCode::SUCCESS)
        }
        Command::Paths => {
            let v = serde_json::to_value(profile).unwrap_or_default();
            if out.json {
                out.value(&v);
            } else {
                println!("target:    {:?}", profile.target);
                println!("state dir: {}", profile.state_dir.display());
                println!("control:   {}", profile.control);
                println!("replica:   {}", profile.replica);
                println!("log:       {}", profile.log_file().display());
            }
            Ok(ExitCode::SUCCESS)
        }
    }
}

fn migrate_print(out: &Output, v: &Value) {
    if out.json {
        out.value(v);
        return;
    }
    let waiting = v
        .get("waiting_for_migration_batch")
        .and_then(Value::as_bool)
        == Some(true);
    if waiting {
        println!(
            "Waiting for migration batch: automatic takeover needs Connect's permission after the account flips."
        );
    }
    let Some(r) = v.get("record").filter(|r| !r.is_null()) else {
        if !waiting {
            println!("No takeover: no old mdbase Connect state was found for this profile.");
        }
        return;
    };
    if let Some(retirement) = v.get("retirement").filter(|r| !r.is_null()) {
        if retirement["retired"] == true {
            println!("Legacy connector retirement confirmed.");
        } else {
            println!(
                "Legacy connector retirement pending ({}).",
                retirement["reason"].as_str().unwrap_or("not_confirmed")
            );
        }
    }
    println!(
        "takeover: {}",
        r.get("state").and_then(Value::as_str).unwrap_or("?")
    );
    if let Some(held) = v.get("held_interrupted_writes").and_then(Value::as_u64)
        && held > 0
    {
        println!(
            "Interrupted legacy write/delete intents held: {held}. See retained takeover evidence."
        );
    }
    if v.get("revived").and_then(Value::as_bool) == Some(true) {
        println!("warning: the old mdbase Connect daemon is running again (old_connector_revived)");
    }
    if let Some(cs) = r.get("collections").and_then(Value::as_object) {
        for (id, c) in cs {
            let field = |k: &str| c.get(k).and_then(Value::as_u64).unwrap_or(0);
            println!(
                "  {id}  {}{}  rolled forward {}, held {}, {}",
                c.get("state").and_then(Value::as_str).unwrap_or("?"),
                c.get("reason")
                    .and_then(Value::as_str)
                    .map(|r| format!(" ({r})"))
                    .unwrap_or_default(),
                field("rolled_forward"),
                field("holds"),
                if c.get("registered").and_then(Value::as_bool) == Some(true) {
                    "registered"
                } else {
                    "not registered"
                }
            );
        }
    }
}

async fn simple(
    profile: &Profile,
    out: &Output,
    method: &str,
    collection: &str,
    mut extra: Value,
) -> Result<ExitCode, ClientError> {
    let id = resolve(profile, collection).await?;
    if let Value::Object(m) = &mut extra {
        m.insert("collection".into(), Value::String(id));
    }
    let v = call(profile, method, extra).await?;
    if out.json {
        out.value(&v);
    } else if let Ok(c) = serde_json::from_value::<CollectionStatus>(v.clone()) {
        print_collection(&c);
    } else {
        println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
    }
    Ok(ExitCode::SUCCESS)
}

async fn daemon_start(profile: &Profile, out: &Output) -> Result<ExitCode, ClientError> {
    if let Ok(r) = client::ping(&profile.control).await {
        if out.json {
            out.value(&json!({ "readiness": r, "started": false }));
        } else {
            println!("Already running (version {}).", r.binary_version);
        }
        return Ok(ExitCode::SUCCESS);
    }
    let exe = std::env::current_exe().map_err(ClientError::Io)?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("daemon").arg("run");
    if profile.target == crate::paths::Target::IsolatedProfile {
        cmd.arg("--state-dir").arg(&profile.state_dir);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    detach(&mut cmd);
    let mut child = cmd.spawn().map_err(ClientError::Io)?;
    let deadline = tokio::time::Instant::now() + START_TIMEOUT;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            // Exit code 4: another daemon won the race; it is fine if it is ready.
            if status.code() != Some(4) {
                return Err(ClientError::Remote(ControlError::unavailable(
                    "start_failed",
                    format!(
                        "the daemon exited ({status}); see `mdbase logs` ({})",
                        profile.log_file().display()
                    ),
                )));
            }
        }
        match client::ping(&profile.control).await {
            Ok(r) if r.ready => {
                if out.json {
                    out.value(&json!({ "readiness": r, "started": true }));
                } else {
                    println!("Started (version {}).", r.binary_version);
                }
                return Ok(ExitCode::SUCCESS);
            }
            Ok(r)
                if r.safe_reason.is_some()
                    && r.safe_reason != Some(crate::control::NotReady::Starting) =>
            {
                return Err(ClientError::Remote(ControlError::unavailable(
                    "not_ready",
                    "the daemon started but is not ready; run `mdbase doctor`",
                )));
            }
            _ => {}
        }
        if tokio::time::Instant::now() > deadline {
            return Err(ClientError::Timeout);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[cfg(unix)]
fn detach(cmd: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

#[cfg(windows)]
fn detach(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

async fn daemon_stop(profile: &Profile, out: &Output) -> Result<ExitCode, ClientError> {
    match call(profile, Method::SHUTDOWN, json!({})).await {
        Ok(_) => {}
        Err(ClientError::NotRunning) => {
            if out.json {
                out.value(&json!({ "stopped": false }));
            } else {
                println!("Not running.");
            }
            return Ok(ExitCode::SUCCESS);
        }
        Err(e) => return Err(e),
    }
    let deadline = tokio::time::Instant::now() + server::SHUTDOWN_GRACE + Duration::from_secs(5);
    while crate::instance::InstanceLock::is_held(&profile.lock_file()).unwrap_or(false) {
        if tokio::time::Instant::now() > deadline {
            return Err(ClientError::Timeout);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if out.json {
        out.value(&json!({ "stopped": true }));
    } else {
        println!("Stopped.");
    }
    Ok(ExitCode::SUCCESS)
}

async fn logs(profile: &Profile, lines: usize, follow: bool) -> Result<ExitCode, ClientError> {
    let path = profile.log_file();
    let text = std::fs::read_to_string(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ClientError::Remote(ControlError::not_found(format!(
                "no log at {} yet",
                path.display()
            )))
        } else {
            ClientError::Io(e)
        }
    })?;
    let all: Vec<&str> = text.lines().collect();
    for l in &all[all.len().saturating_sub(lines)..] {
        println!("{l}");
    }
    if follow {
        follow_file(&path, text.len() as u64).await?;
    }
    Ok(ExitCode::SUCCESS)
}

async fn follow_file(path: &Path, mut pos: u64) -> Result<(), ClientError> {
    use std::io::{Seek, SeekFrom};
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let mut f = std::fs::File::open(path).map_err(ClientError::Io)?;
        let len = f.metadata().map_err(ClientError::Io)?.len();
        if len < pos {
            pos = 0; // rotated
        }
        if len > pos {
            f.seek(SeekFrom::Start(pos)).map_err(ClientError::Io)?;
            let mut buf = String::new();
            f.read_to_string(&mut buf).map_err(ClientError::Io)?;
            print!("{buf}");
            pos = len;
        }
    }
}

fn print_status(s: &DaemonStatus) {
    let r = &s.readiness;
    if r.ready {
        println!(
            "Daemon: ready (version {}, pid {})",
            r.binary_version, s.pid
        );
    } else {
        println!(
            "Daemon: not ready: {:?} (version {}, pid {})",
            r.safe_reason, r.binary_version, s.pid
        );
    }
    if let Some(d) = &s.device {
        println!("Device: {}", d.device_id);
    }
    if let Some(u) = &s.account.pairing {
        println!("Sign-in waiting for approval: {u}");
    }
    if let Some(e) = &s.account.last_error {
        println!("Account problem: {e}");
    }
    println!(
        "Account: {}",
        if s.account.signed_in {
            if s.account.online {
                "signed in"
            } else {
                "signed in, offline"
            }
        } else {
            "not signed in"
        }
    );
    if s.collections.is_empty() {
        println!("No collections.");
    }
    for c in &s.collections {
        print_collection(c);
    }
}

fn print_collection(c: &CollectionStatus) {
    let mode = match c.mode {
        SyncMode::Local => "local only",
        SyncMode::Synced => "synced",
        SyncMode::SyncedE2e => "synced, end-to-end encrypted",
    };
    let state = serde_json::to_value(c.state)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    let reason = c
        .reason
        .as_deref()
        .map(|r| format!(" ({r})"))
        .unwrap_or_default();
    println!("  {}  {}", c.id, c.name);
    println!("      {}  [{mode}]  {state}{reason}", c.root.display());
    if let Some(s) = &c.sync {
        println!(
            "      confirmed through {}, {} pending, {} held, {} conflicts, {}",
            s.confirmed_through, s.pending, s.holds, s.unresolved, s.connection
        );
    }
    for n in &c.notices {
        println!("      ! {}", n.message);
    }
}

/// Ask on the terminal; `false` when stdin is not a terminal.
fn confirm(question: &str) -> bool {
    if !std::io::stdin().is_terminal() {
        eprintln!("{question} Refusing without a terminal to confirm on.");
        return false;
    }
    eprint!("{question} [y/N] ");
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).is_ok() && matches!(line.trim(), "y" | "Y" | "yes")
}

async fn access_command(
    profile: &Profile,
    out: &Output,
    cmd: AccessCmd,
) -> Result<ExitCode, ClientError> {
    use crate::access::{AccessEntry, AccessState};
    let print = |e: &AccessEntry| {
        let state = match e.state {
            AccessState::Active if !e.acknowledged => "active (new)",
            AccessState::Active => "active",
            AccessState::PendingApproval => "waiting for approval",
            AccessState::Denied => "declined",
            AccessState::RevokedLocally => "revoked on this computer",
        };
        println!("  {}  {}  [{state}]", e.grant.grant, e.grant.app_name);
        println!(
            "      collection {}  {}  key {}",
            e.grant.collection,
            e.grant.capabilities.join(", "),
            e.grant.fingerprint()
        );
    };
    let (method, grant) = match cmd {
        AccessCmd::List { collection } => {
            let c = match collection {
                Some(c) => Some(resolve(profile, &c).await?),
                None => None,
            };
            let v = call(profile, Method::ACCESS_LIST, json!({ "collection": c })).await?;
            if out.json {
                out.value(&v);
            } else {
                let list: Vec<AccessEntry> =
                    serde_json::from_value(v).map_err(|e| ClientError::Protocol(e.to_string()))?;
                if list.is_empty() {
                    println!("No apps use your local collections through this computer.");
                }
                list.iter().for_each(print);
            }
            return Ok(ExitCode::SUCCESS);
        }
        AccessCmd::Revoke { grant } => (Method::ACCESS_REVOKE, grant),
        AccessCmd::Approve { grant } => {
            if !confirm("Approve this app? Check that its key matches the one the app showed you.")
            {
                return Ok(ExitCode::from(1));
            }
            (Method::ACCESS_APPROVE, grant)
        }
        AccessCmd::Deny { grant } => (Method::ACCESS_DENY, grant),
        AccessCmd::Ack { grant } => (Method::ACCESS_ACK, grant),
    };
    let v = call(profile, method, json!({ "grant": grant })).await?;
    if out.json {
        out.value(&v);
    } else {
        let e: AccessEntry =
            serde_json::from_value(v).map_err(|e| ClientError::Protocol(e.to_string()))?;
        print(&e);
    }
    Ok(ExitCode::SUCCESS)
}

/// Handshake with the replica endpoint as the hosting app, using the Noise key
/// pinned from `daemon.json` for a collection that cannot exist. A
/// healthy endpoint completes the handshake and answers `unknown_collection`.
async fn replica_endpoint_check(profile: &Profile) -> Check {
    use crate::session::{ClientSession, Prologue, request};
    let check = |status: &str, detail: String, action: Option<&str>| Check {
        id: "replica_endpoint".into(),
        status: status.into(),
        detail,
        action: action.map(str::to_string),
    };
    let ident =
        match crate::secrets::read_daemon_identity(&profile.state_dir, &profile.identity_file()) {
            Ok(i) => i,
            Err(e) => {
                return check(
                    "fail",
                    e.to_string(),
                    Some("Check the state directory's owner and permissions."),
                );
            }
        };
    let decode = |h: &str| crate::secrets::hex_decode(h).ok();
    let (Some(pk), Some(dev)) = (
        decode(&ident.noise_pk).and_then(|v| <[u8; 32]>::try_from(v).ok()),
        decode(&ident.device.replace('-', "")).and_then(|v| <[u8; 16]>::try_from(v).ok()),
    ) else {
        return check("fail", "daemon.json is malformed".into(), None);
    };
    let Ok(client_sk) = crate::noise::ephemeral() else {
        return check("fail", "no OS entropy".into(), None);
    };
    let prologue = Prologue {
        collection: [0xff; 16],
        grant: [0; 16],
        target: dev,
    };
    let attempt = async {
        let s = crate::ipc::connect(&profile.replica)
            .await
            .map_err(|e| e.to_string())?;
        let (_, hello) = ClientSession::connect(
            s,
            &client_sk,
            &pk,
            prologue,
            request(0, "hello", mdbn_wire::cbor::Cbor::Null),
        )
        .await
        .map_err(|e| e.to_string())?;
        Ok::<_, String>(hello)
    };
    match tokio::time::timeout(Duration::from_secs(10), attempt).await {
        // The probe has no host key, so the daemon refuses it once the
        // handshake has succeeded; an older daemon answers unknown_collection.
        Ok(Ok(h))
            if matches!(
                h.problem.as_ref().and_then(|p| p.reason.as_deref()),
                Some("host_key_required" | "unknown_collection")
            ) =>
        {
            check(
                "ok",
                format!("Noise handshake with {} succeeded", profile.replica),
                None,
            )
        }
        Ok(Ok(h)) => check(
            "warn",
            format!(
                "handshake succeeded; unexpected answer {:?}",
                h.problem.map(|p| p.reason)
            ),
            None,
        ),
        Ok(Err(e)) => check(
            "fail",
            format!("{}: {e}", profile.replica),
            Some("Restart the daemon; if it persists, see `mdbase logs`."),
        ),
        Err(_) => check("fail", "the replica endpoint did not answer".into(), None),
    }
}

fn hostname() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .ok()
        .filter(|h| !h.is_empty() && h.len() <= 80)
        .map(|h| format!("mdbase on {h}"))
        .unwrap_or_else(|| "mdbase on this computer".into())
}

/// Best effort; the URL is printed either way.
fn open_browser(uri: &str) {
    if !uri.starts_with("https://") && !uri.starts_with("http://") {
        return;
    }
    let cmd = if cfg!(target_os = "macos") {
        Some(("open", vec![uri]))
    } else if cfg!(windows) {
        Some(("rundll32", vec!["url.dll,FileProtocolHandler", uri]))
    } else {
        Some(("xdg-open", vec![uri]))
    };
    if let Some((bin, args)) = cmd {
        let _ = std::process::Command::new(bin)
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
}

/// A secret from the terminal (hidden) or, when stdin is not a terminal, one line of
/// stdin. Never an argument.
fn read_secret(prompt: &str) -> Result<zeroize::Zeroizing<String>, ClientError> {
    // Bounded before anything else sees it (AK1 passwords are at most 1024 bytes
    // after NFKC; recovery keys 64 characters).
    const MAX: usize = 4096;
    let secret = if std::io::stdin().is_terminal() {
        rpassword::prompt_password(prompt)
            .map(zeroize::Zeroizing::new)
            .map_err(ClientError::Io)?
    } else {
        let mut raw = zeroize::Zeroizing::new(Vec::new());
        std::io::stdin()
            .lock()
            .take(MAX as u64 + 1)
            .read_until(b'\n', &mut raw)
            .map_err(ClientError::Io)?;
        let line = std::str::from_utf8(&raw)
            .map_err(|_| ClientError::Protocol("the secret is not UTF-8".into()))?;
        zeroize::Zeroizing::new(line.trim_end_matches(['\r', '\n']).to_string())
    };
    if secret.len() > MAX {
        return Err(ClientError::Protocol("the secret is too long".into()));
    }
    Ok(secret)
}

/// A new password, entered twice on a terminal.
fn new_password() -> Result<zeroize::Zeroizing<String>, ClientError> {
    let a = read_secret("Encryption password (12+ characters): ")?;
    mdbn_replica::crypto::account_key::check_password(&a)
        .map_err(|e| ClientError::Protocol(e.to_string()))?;
    if std::io::stdin().is_terminal() {
        let b = read_secret("Repeat it: ")?;
        if *a != *b {
            return Err(ClientError::Protocol("the passwords do not match".into()));
        }
    }
    Ok(a)
}

async fn private(
    profile: &Profile,
    out: &Output,
    cmd: PrivateCmd,
) -> Result<ExitCode, ClientError> {
    let v = match cmd {
        PrivateCmd::Status => call(profile, Method::PRIVATE_STATUS, json!({})).await?,
        PrivateCmd::Setup => {
            let pw = new_password()?;
            let v = call(
                profile,
                Method::PRIVATE_SETUP,
                json!({ "password": pw.as_str() }),
            )
            .await?;
            if !out.json {
                let key = v.get("recovery_key").and_then(Value::as_str).unwrap_or("");
                println!(
                    "Account key set up. Your recovery key (shown once; store it safely):\n\n  {key}\n\n\
                     A weak encryption password can be guessed if the server's copy leaks."
                );
                print_private_collections(&v);
                return Ok(ExitCode::SUCCESS);
            }
            v
        }
        PrivateCmd::Unlock { recovery_key } => {
            let params = if recovery_key {
                json!({ "recovery_key": read_secret("Recovery key: ")?.as_str() })
            } else {
                json!({ "password": read_secret("Encryption password: ")?.as_str() })
            };
            call(profile, Method::PRIVATE_UNLOCK, params).await?
        }
        PrivateCmd::Password { recovery_key } => {
            let key = if recovery_key {
                Some(read_secret("Recovery key: ")?)
            } else {
                None
            };
            let pw = new_password()?;
            let mut params = json!({ "password": pw.as_str() });
            if let Some(k) = &key {
                params["recovery_key"] = json!(k.as_str());
            }
            call(profile, Method::PRIVATE_PASSWORD, params).await?
        }
        PrivateCmd::Strict => call(profile, Method::PRIVATE_STRICT, json!({})).await?,
    };
    if out.json {
        out.value(&v);
    } else {
        println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
    }
    Ok(ExitCode::SUCCESS)
}

fn print_private_collections(v: &Value) {
    for c in v
        .get("collections")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        println!("  {}", c);
    }
}

#[cfg(test)]
mod companion_tests {
    use super::*;
    #[test]
    fn companion_selects_a_profile_without_service_or_generic_rpc_arguments() {
        let cli =
            Cli::try_parse_from(["mdbase", "--state-dir", "fixture-profile", "companion"]).unwrap();
        assert!(matches!(cli.command, Command::Companion));
        assert_eq!(cli.state_dir, Some(PathBuf::from("fixture-profile")));
        assert!(Cli::try_parse_from(["mdbase", "companion", "confirm.answer", "yes"]).is_err());
        assert!(Cli::try_parse_from(["mdbase", "companion", "--start"]).is_err());
    }
    #[test]
    fn companion_json_rejection_happens_before_any_gui_or_runtime() {
        let profile = Profile::isolated(
            &std::env::current_dir()
                .unwrap()
                .join("target/companion-json-unused"),
        )
        .unwrap();
        assert_eq!(run_companion(profile, true), ExitCode::from(2));
    }
}
