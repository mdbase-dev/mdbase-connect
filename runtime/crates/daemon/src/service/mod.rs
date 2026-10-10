//! `mdbase service`: register the daemon with the OS service manager, so it starts
//! at login and restarts after a failure (packaging note
//! desktop service packaging).
//!
//! | OS | registration | runs |
//! |---|---|---|
//! | Linux | systemd user unit `~/.config/systemd/user/mdbase.service` | at login of the user manager |
//! | macOS | LaunchAgent `~/Library/LaunchAgents/dev.mdbase.daemon.plist` | at login, in the GUI session |
//! | Windows | scheduled task `\mdbase\daemon` | at logon, interactive token, least privilege |
//!
//! **What is registered** is never the binary that ran `install` (a download or a
//! package path), but a private copy at `<state>/runtime/mdbase[.exe]`, so updating or
//! removing the download can't break the service. The copy it replaces is kept as
//! `mdbase.previous[.exe]` for rollback. Packaging owns `<state>/runtime/` and
//! `<state>/updates/`; everything else in `<state>` is the daemon's.
//!
//! **Only the installed profile.** `install`, `uninstall` and `status` refuse an isolated
//! profile (`--state-dir`, `MDBASE_HOME`), as the connector does.
//!
//! **Never the connector's.** Names, paths and the binary copy are disjoint from
//! today's connector (`mdbase-connect.service`, `dev.mdbase.connect`, task
//! `"mdbase connect"`, `<connect state>/runtime/mdbase`). Nothing here writes,
//! stops or disables those; stopping the old connector is the takeover's job
//! (`mdbn_migrate::takeover::OldService`). `status` only reports whether it is
//! registered.
//!
//! Service managers are driven through their CLIs (`systemctl`, `launchctl`,
//! `schtasks`), as the connector does: no new dependencies.

pub mod legacy;
pub mod templates;

use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use clap::Subcommand;
use serde::Serialize;
use serde_json::json;

use crate::client::{self, ClientError};
use crate::control::{ControlError, Method, Readiness};
use crate::paths::{Profile, Target};

/// How long `install`, `start` and `restart` wait for readiness.
pub const READY_TIMEOUT: Duration = Duration::from_secs(30);
/// How long `status` waits for a registered binary's `--version`.
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long `stop` waits for the daemon to release its lock.
const STOP_TIMEOUT: Duration = Duration::from_secs(20);

/// systemd unit name.
pub const SYSTEMD_UNIT: &str = "mdbase.service";
/// launchd label (matches the keychain service, `secrets`).
pub const LAUNCHD_LABEL: &str = "dev.mdbase.daemon";
/// Task Scheduler path.
pub const TASK_NAME: &str = r"\mdbase\daemon";

/// The connector's registrations, reported (never touched) by `status`.
pub const CONNECTOR_SYSTEMD_UNIT: &str = "mdbase-connect.service";
/// The connector's launchd label.
pub const CONNECTOR_LAUNCHD_LABEL: &str = "dev.mdbase.connect";
/// The connector's scheduled task.
pub const CONNECTOR_TASK_NAME: &str = "mdbase connect";

/// `mdbase service …`.
#[derive(Debug, Clone, Copy, Subcommand)]
pub enum ServiceCmd {
    /// Copy this binary into the profile, register it to start at login, and start it.
    Install,
    /// Stop the service and remove its registration. State and collections are untouched.
    Uninstall,
    /// Registration, binary, and whether the daemon is running and ready.
    Status,
    /// Start the registered service and wait until it is ready.
    Start,
    /// Stop the registered service (it starts again at the next login).
    Stop,
    /// Stop, then start, and wait until it is ready.
    Restart,
}

/// What `service status` reports.
#[derive(Debug, Clone, Serialize)]
pub struct ServiceStatus {
    /// `systemd`, `launchd` or `task_scheduler`.
    pub manager: &'static str,
    /// The unit name, label or task path.
    pub name: String,
    /// The unit or plist file (none for a task).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub definition: Option<PathBuf>,
    /// `absent`, `installed`, or `stale` (it runs a binary other than this profile's
    /// runtime copy, or one that no longer exists).
    pub registration: &'static str,
    /// The binary the registration runs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary: Option<PathBuf>,
    /// That binary's `--version`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary_version: Option<String>,
    /// Starts at login.
    pub enabled: bool,
    /// The daemon's readiness, if one answers on this profile's endpoint.
    pub readiness: Option<Readiness>,
    /// Whether today's connector is still registered on this machine (read-only check).
    pub connector_registered: bool,
}

/// An error from a service operation.
#[derive(Debug)]
pub enum ServiceError {
    /// The command does not apply to an isolated profile.
    IsolatedProfile,
    /// No registration to act on.
    NotInstalled,
    /// A service-manager command failed.
    Manager(String),
    /// The daemon did not become ready (or report this version) in time.
    NotReady(String),
    /// Talking to the daemon failed.
    Client(ClientError),
    /// A file operation failed.
    Io(io::Error),
}

impl From<io::Error> for ServiceError {
    fn from(e: io::Error) -> Self {
        ServiceError::Io(e)
    }
}

impl From<ClientError> for ServiceError {
    fn from(e: ClientError) -> Self {
        ServiceError::Client(e)
    }
}

impl ServiceError {
    /// The exit code and the error object (the CLI's conventions: 1 error, 2 usage,
    /// 3 the daemon is not running or not ready).
    pub fn to_control(&self) -> (u8, ControlError) {
        match self {
            ServiceError::IsolatedProfile => (
                2,
                ControlError::invalid(
                    "isolated_profile",
                    "`mdbase service` manages the installed profile only; drop --state-dir / MDBASE_HOME",
                ),
            ),
            ServiceError::NotInstalled => (
                1,
                ControlError::new(
                    "not_found",
                    "service_not_installed",
                    "the service is not installed; run `mdbase service install`",
                ),
            ),
            ServiceError::Manager(m) => (
                1,
                ControlError::unavailable("service_manager_failed", m.clone()),
            ),
            ServiceError::NotReady(m) => (3, ControlError::unavailable("not_ready", m.clone())),
            ServiceError::Client(e) => (
                1,
                ControlError::unavailable("daemon_unreachable", e.to_string()),
            ),
            ServiceError::Io(e) => (1, ControlError::internal(e.to_string())),
        }
    }
}

/// Run `mdbase service <cmd>`, printing as the rest of the CLI does.
pub async fn run(cmd: ServiceCmd, profile: &Profile, json: bool) -> ExitCode {
    match execute(cmd, profile).await {
        Ok(status) => {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&status).unwrap_or_default()
                );
            } else {
                print_status(&status);
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            let (code, err) = e.to_control();
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&json!({ "error": err })).unwrap_or_default()
                );
            } else {
                eprintln!("error: {}", err.message);
                if let Some(r) = &err.reason {
                    eprintln!("       ({}: {r})", err.code);
                }
            }
            ExitCode::from(code)
        }
    }
}

async fn execute(cmd: ServiceCmd, profile: &Profile) -> Result<ServiceStatus, ServiceError> {
    if profile.target != Target::InstalledService {
        return Err(ServiceError::IsolatedProfile);
    }
    let os = platform::Manager::new()?;
    match cmd {
        ServiceCmd::Status => {}
        ServiceCmd::Install => {
            stop_daemon(profile, &os).await?;
            let exe = install_runtime(profile)?;
            os.register(&exe)?;
            os.start()?;
            wait_ready(profile, crate::BINARY_VERSION).await?;
        }
        ServiceCmd::Uninstall => {
            if os.query()?.is_some() {
                stop_daemon(profile, &os).await?;
                os.unregister()?;
            }
        }
        ServiceCmd::Start => {
            let version = registered_version(profile, &os)?;
            os.start()?;
            wait_ready(profile, &version).await?;
        }
        ServiceCmd::Stop => {
            require_installed(&os)?;
            stop_daemon(profile, &os).await?;
        }
        ServiceCmd::Restart => {
            let version = registered_version(profile, &os)?;
            stop_daemon(profile, &os).await?;
            os.start()?;
            wait_ready(profile, &version).await?;
        }
    }
    status(profile, &os).await
}

fn require_installed(os: &platform::Manager) -> Result<(), ServiceError> {
    match os.query()? {
        Some(_) => Ok(()),
        None => Err(ServiceError::NotInstalled),
    }
}

/// Resolve the installed runtime's version, not the invoking bundle's version.
/// An old bridge bundle must be able to start a newer self-updated installation.
fn registered_version(profile: &Profile, os: &platform::Manager) -> Result<String, ServiceError> {
    let reg = os.query()?.ok_or(ServiceError::NotInstalled)?;
    let expected = runtime_binary(profile);
    let binary = reg
        .binary
        .filter(|b| same_file(b, &expected) && b.is_file())
        .ok_or_else(|| {
            ServiceError::Manager(
                "the service registration is stale; run mdbase service install".into(),
            )
        })?;
    binary_version(&binary).ok_or_else(|| {
        ServiceError::Manager("the installed runtime did not report its version".into())
    })
}

/// The registered copy of the binary.
pub fn runtime_binary(profile: &Profile) -> PathBuf {
    profile.state_dir.join("runtime").join(exe_name("mdbase"))
}

/// The copy kept for rollback.
pub fn previous_binary(profile: &Profile) -> PathBuf {
    profile
        .state_dir
        .join("runtime")
        .join(exe_name("mdbase.previous"))
}

fn exe_name(stem: &str) -> String {
    format!("{stem}{}", std::env::consts::EXE_SUFFIX)
}

/// Copy the running executable to `<state>/runtime/mdbase` atomically, keeping the
/// one it replaces as `mdbase.previous`. The daemon must already be stopped.
/// Returns the registered path.
pub fn install_runtime(profile: &Profile) -> Result<PathBuf, ServiceError> {
    let current = std::env::current_exe()?;
    install_binary(profile, &current)
}

/// [`install_runtime`] for a given source binary.
pub fn install_binary(profile: &Profile, source: &Path) -> Result<PathBuf, ServiceError> {
    crate::fsutil::ensure_private_dir(&profile.state_dir)?;
    let dir = profile.state_dir.join("runtime");
    crate::fsutil::ensure_private_dir(&dir)?;
    let target = runtime_binary(profile);
    // Already running from the registered copy: nothing to copy.
    if let (Ok(a), Ok(b)) = (source.canonicalize(), target.canonicalize())
        && a == b
    {
        return Ok(target);
    }
    let staged = dir.join(exe_name(".mdbase.new"));
    let _ = std::fs::remove_file(&staged);
    copy_durably(source, &staged)?;
    if std::fs::symlink_metadata(&target).is_ok() {
        let previous = previous_binary(profile);
        let _ = std::fs::remove_file(&previous);
        // On Windows a running image can be renamed, though not overwritten.
        std::fs::rename(&target, &previous)?;
    }
    if let Err(e) = std::fs::rename(&staged, &target) {
        let _ = std::fs::remove_file(&staged);
        return Err(e.into());
    }
    crate::fsutil::sync_dir(&dir)?;
    Ok(target)
}

fn copy_durably(source: &Path, dest: &Path) -> io::Result<()> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o700);
    }
    let mut out = opts.open(dest)?;
    let mut input = std::fs::File::open(source)?;
    io::copy(&mut input, &mut out)?;
    out.sync_all()
}

/// Stop the daemon of this profile: through the service manager if registered (so
/// it isn't restarted), otherwise with a control `shutdown`; then wait for its lock.
async fn stop_daemon(profile: &Profile, os: &platform::Manager) -> Result<(), ServiceError> {
    if os.query()?.is_some() {
        os.stop()?;
    }
    match client::ControlClient::connect(&profile.control).await {
        Ok(mut c) => match c.call(Method::SHUTDOWN, json!({})).await {
            Ok(_) | Err(ClientError::NotRunning) => {}
            // It may close the connection as it stops.
            Err(ClientError::Io(_)) => {}
            Err(e) => return Err(e.into()),
        },
        Err(ClientError::NotRunning) => {}
        Err(e) => return Err(e.into()),
    }
    let deadline = tokio::time::Instant::now() + STOP_TIMEOUT;
    while crate::instance::InstanceLock::is_held(&profile.lock_file()).unwrap_or(false) {
        if tokio::time::Instant::now() > deadline {
            return Err(ServiceError::NotReady(
                "the daemon did not stop in time; see `mdbase logs`".into(),
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(())
}

/// Wait until the daemon is ready **and** reports the expected runtime version.
/// Install expects this binary; start/restart expect the already installed copy.
async fn wait_ready(profile: &Profile, expected_version: &str) -> Result<Readiness, ServiceError> {
    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
    let mut last;
    loop {
        match client::ping(&profile.control).await {
            Ok(r) if readiness_matches(&r, expected_version) => return Ok(r),
            Ok(r) => {
                last = format!(
                    "ready={} version={} reason={:?}",
                    r.ready, r.binary_version, r.safe_reason
                )
            }
            Err(e) => last = e.to_string(),
        }
        if tokio::time::Instant::now() > deadline {
            return Err(ServiceError::NotReady(format!(
                "the service did not become ready as version {} ({last}); see `mdbase logs` ({})",
                expected_version,
                profile.log_file().display()
            )));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn readiness_matches(readiness: &Readiness, version: &str) -> bool {
    readiness.ready
        && readiness.binary_version == version
        && readiness.control_protocol == crate::control::PROTOCOL
        && readiness.schema_version == crate::control::READINESS_SCHEMA
}

async fn status(profile: &Profile, os: &platform::Manager) -> Result<ServiceStatus, ServiceError> {
    let reg = os.query()?;
    let expected = runtime_binary(profile);
    let (registration, binary, enabled) = match reg {
        None => ("absent", None, false),
        Some(r) => {
            let fresh = r
                .binary
                .as_ref()
                .is_some_and(|b| same_file(b, &expected) && b.exists());
            (
                if fresh { "installed" } else { "stale" },
                r.binary,
                r.enabled,
            )
        }
    };
    let binary_version = binary.as_deref().and_then(binary_version);
    let readiness = client::ping(&profile.control).await.ok();
    Ok(ServiceStatus {
        manager: platform::MANAGER,
        name: os.name(),
        definition: os.definition(),
        registration,
        binary,
        binary_version,
        enabled,
        readiness,
        connector_registered: os.connector_registered(),
    })
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// `<binary> --version` → the version (`mdbase 1.2.3` → `1.2.3`).
fn binary_version(binary: &Path) -> Option<String> {
    use std::io::Read;
    let mut child = std::process::Command::new(binary)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    // A wedged or hostile binary must not hang `status`: kill it after the deadline.
    let deadline = std::time::Instant::now() + VERSION_PROBE_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    if !status.success() {
        return None;
    }
    // `--version` prints one short line; read at most 4 KiB of it.
    let mut out = Vec::new();
    child.stdout.take()?.take(4096).read_to_end(&mut out).ok()?;
    String::from_utf8_lossy(&out)
        .split_whitespace()
        .last()
        .map(str::to_string)
}

fn print_status(s: &ServiceStatus) {
    println!("service:   {} ({})", s.name, s.manager);
    if let Some(d) = &s.definition {
        println!("file:      {}", d.display());
    }
    println!(
        "state:     {}{}",
        s.registration,
        if s.registration == "absent" {
            String::new()
        } else if s.enabled {
            ", starts at login".to_string()
        } else {
            ", disabled".to_string()
        }
    );
    if let Some(b) = &s.binary {
        println!(
            "binary:    {} ({})",
            b.display(),
            s.binary_version.as_deref().unwrap_or("version unknown")
        );
    }
    match &s.readiness {
        Some(r) if r.ready => println!("daemon:    ready (version {})", r.binary_version),
        Some(r) => println!(
            "daemon:    not ready ({:?}, version {})",
            r.safe_reason, r.binary_version
        ),
        None => println!("daemon:    not running"),
    }
    if s.connector_registered {
        println!("note:      today's mdbase Connect service is also registered; it is left alone");
    }
}

/// A registration as the service manager reports it.
#[derive(Debug, Clone)]
pub struct Registration {
    /// The binary it runs, if it could be read.
    pub binary: Option<PathBuf>,
    /// Starts at login.
    pub enabled: bool,
}

/// Run a service-manager command; its stdout on success.
#[allow(dead_code)] // Not every platform uses it.
fn run_manager(program: &str, args: &[&str]) -> Result<String, ServiceError> {
    let out = std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| ServiceError::Manager(format!("{program}: {e}")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(ServiceError::Manager(format!(
            "`{program} {}` failed ({}): {}",
            args.join(" "),
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        )))
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;

    pub const MANAGER: &str = "systemd";

    pub struct Manager {
        unit_dir: PathBuf,
    }

    impl Manager {
        pub fn new() -> Result<Manager, ServiceError> {
            let config = std::env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
                .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
                .ok_or_else(|| ServiceError::Manager("HOME is not set".into()))?;
            Ok(Manager {
                unit_dir: config.join("systemd").join("user"),
            })
        }

        pub fn name(&self) -> String {
            SYSTEMD_UNIT.to_string()
        }

        pub fn definition(&self) -> Option<PathBuf> {
            Some(self.unit_dir.join(SYSTEMD_UNIT))
        }

        pub fn query(&self) -> Result<Option<Registration>, ServiceError> {
            let Some(unit) = crate::fsutil::read_optional(&self.unit_dir.join(SYSTEMD_UNIT))?
            else {
                return Ok(None);
            };
            let binary =
                templates::systemd_exec_binary(&String::from_utf8_lossy(&unit)).map(PathBuf::from);
            // `is-enabled` exits non-zero for "disabled"; only its answer matters.
            let enabled = std::process::Command::new("systemctl")
                .args(["--user", "is-enabled", SYSTEMD_UNIT])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "enabled")
                .unwrap_or(false);
            Ok(Some(Registration { binary, enabled }))
        }

        pub fn register(&self, exe: &Path) -> Result<(), ServiceError> {
            std::fs::create_dir_all(&self.unit_dir)?;
            crate::fsutil::write_atomic(
                &self.unit_dir.join(SYSTEMD_UNIT),
                templates::systemd_unit(exe).as_bytes(),
            )?;
            run_manager("systemctl", &["--user", "daemon-reload"])?;
            run_manager("systemctl", &["--user", "enable", SYSTEMD_UNIT])?;
            Ok(())
        }

        pub fn start(&self) -> Result<(), ServiceError> {
            run_manager("systemctl", &["--user", "start", SYSTEMD_UNIT]).map(drop)
        }

        pub fn stop(&self) -> Result<(), ServiceError> {
            run_manager("systemctl", &["--user", "stop", SYSTEMD_UNIT]).map(drop)
        }

        pub fn unregister(&self) -> Result<(), ServiceError> {
            // Disable even if stop already happened; ignore "not loaded".
            let _ = run_manager("systemctl", &["--user", "disable", SYSTEMD_UNIT]);
            match std::fs::remove_file(self.unit_dir.join(SYSTEMD_UNIT)) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
            run_manager("systemctl", &["--user", "daemon-reload"]).map(drop)
        }

        pub fn connector_registered(&self) -> bool {
            self.unit_dir.join(CONNECTOR_SYSTEMD_UNIT).exists()
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    pub const MANAGER: &str = "launchd";

    pub struct Manager {
        agents: PathBuf,
        domain: String,
    }

    impl Manager {
        pub fn new() -> Result<Manager, ServiceError> {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
                .ok_or_else(|| ServiceError::Manager("HOME is not set".into()))?;
            Ok(Manager {
                agents: home.join("Library").join("LaunchAgents"),
                domain: format!("gui/{}", crate::fsutil::euid()),
            })
        }

        fn plist(&self) -> PathBuf {
            self.agents.join(format!("{LAUNCHD_LABEL}.plist"))
        }

        fn target(&self) -> String {
            format!("{}/{LAUNCHD_LABEL}", self.domain)
        }

        pub fn name(&self) -> String {
            LAUNCHD_LABEL.to_string()
        }

        pub fn definition(&self) -> Option<PathBuf> {
            Some(self.plist())
        }

        pub fn query(&self) -> Result<Option<Registration>, ServiceError> {
            let Some(plist) = crate::fsutil::read_optional(&self.plist())? else {
                return Ok(None);
            };
            let binary =
                templates::launchd_binary(&String::from_utf8_lossy(&plist)).map(PathBuf::from);
            let disabled = std::process::Command::new("launchctl")
                .args(["print-disabled", &self.domain])
                .output()
                .map(|o| {
                    String::from_utf8_lossy(&o.stdout).lines().any(|l| {
                        l.contains(&format!("\"{LAUNCHD_LABEL}\"")) && l.contains("disabled")
                    })
                })
                .unwrap_or(false);
            Ok(Some(Registration {
                binary,
                enabled: !disabled,
            }))
        }

        pub fn register(&self, exe: &Path) -> Result<(), ServiceError> {
            std::fs::create_dir_all(&self.agents)?;
            // Unload a previous definition; absent is fine.
            let _ = run_manager("launchctl", &["bootout", &self.target()]);
            crate::fsutil::write_atomic(
                &self.plist(),
                templates::launchd_plist(LAUNCHD_LABEL, exe).as_bytes(),
            )?;
            run_manager("launchctl", &["enable", &self.target()])?;
            Ok(())
        }

        pub fn start(&self) -> Result<(), ServiceError> {
            // Load it if not loaded (RunAtLoad starts it), else kick it.
            let plist = self.plist();
            let plist = plist.to_string_lossy();
            if run_manager("launchctl", &["print", &self.target()]).is_err() {
                run_manager("launchctl", &["bootstrap", &self.domain, &plist])?;
            }
            run_manager("launchctl", &["kickstart", &self.target()]).map(drop)
        }

        pub fn stop(&self) -> Result<(), ServiceError> {
            // KeepAlive restarts only after a failure; the control `shutdown` that
            // follows exits 0, so it stays stopped. Nothing to do here.
            Ok(())
        }

        pub fn unregister(&self) -> Result<(), ServiceError> {
            let _ = run_manager("launchctl", &["bootout", &self.target()]);
            match std::fs::remove_file(self.plist()) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e.into()),
            }
        }

        pub fn connector_registered(&self) -> bool {
            self.agents
                .join(format!("{CONNECTOR_LAUNCHD_LABEL}.plist"))
                .exists()
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::*;

    pub const MANAGER: &str = "task_scheduler";

    pub struct Manager {
        sid: String,
        scratch: PathBuf,
    }

    impl Manager {
        pub fn new() -> Result<Manager, ServiceError> {
            let sid = crate::paths::user_sid().map_err(|e| ServiceError::Manager(e.to_string()))?;
            let profile = Profile::installed().map_err(|e| ServiceError::Manager(e.to_string()))?;
            Ok(Manager {
                sid,
                scratch: profile.state_dir.join("runtime"),
            })
        }

        pub fn name(&self) -> String {
            TASK_NAME.to_string()
        }

        pub fn definition(&self) -> Option<PathBuf> {
            None
        }

        pub fn query(&self) -> Result<Option<Registration>, ServiceError> {
            let out = std::process::Command::new("schtasks")
                .args(["/Query", "/TN", TASK_NAME, "/XML", "ONE"])
                .stdin(std::process::Stdio::null())
                .output()
                .map_err(|e| ServiceError::Manager(format!("schtasks: {e}")))?;
            if !out.status.success() {
                // Not found (the message is localized; any failure reads as absent).
                return Ok(None);
            }
            let xml = decode_console(&out.stdout);
            Ok(Some(match templates::task_command_and_enabled(&xml) {
                Some((cmd, enabled)) => Registration {
                    binary: Some(PathBuf::from(cmd)),
                    enabled,
                },
                None => Registration {
                    binary: None,
                    enabled: false,
                },
            }))
        }

        pub fn register(&self, exe: &Path) -> Result<(), ServiceError> {
            crate::fsutil::ensure_private_dir(&self.scratch)?;
            let file = self.scratch.join("task.xml");
            crate::fsutil::write_atomic(
                &file,
                &templates::utf16le_with_bom(&templates::task_xml(&self.sid, exe)),
            )?;
            let path = file.to_string_lossy().into_owned();
            let result = run_manager(
                "schtasks",
                &["/Create", "/F", "/TN", TASK_NAME, "/XML", &path],
            );
            let _ = std::fs::remove_file(&file);
            result.map(drop)
        }

        pub fn start(&self) -> Result<(), ServiceError> {
            run_manager("schtasks", &["/Run", "/TN", TASK_NAME]).map(drop)
        }

        pub fn stop(&self) -> Result<(), ServiceError> {
            // The control `shutdown` that follows stops it gracefully; `/End` would
            // terminate it. Restart-on-failure doesn't fire for a clean exit.
            Ok(())
        }

        pub fn unregister(&self) -> Result<(), ServiceError> {
            let _ = run_manager("schtasks", &["/End", "/TN", TASK_NAME]);
            run_manager("schtasks", &["/Delete", "/F", "/TN", TASK_NAME]).map(drop)
        }

        pub fn connector_registered(&self) -> bool {
            std::process::Command::new("schtasks")
                .args(["/Query", "/TN", CONNECTOR_TASK_NAME])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        }
    }

    /// `schtasks /XML` output: UTF-16 with a BOM when redirected on some builds,
    /// otherwise the console code page (ASCII-compatible for the fields we read).
    fn decode_console(bytes: &[u8]) -> String {
        if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
            let units: Vec<u16> = rest
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            String::from_utf16_lossy(&units)
        } else {
            String::from_utf8_lossy(bytes).into_owned()
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod platform {
    use super::*;

    pub const MANAGER: &str = "none";

    pub struct Manager;

    impl Manager {
        pub fn new() -> Result<Manager, ServiceError> {
            Err(ServiceError::Manager(
                "no supported service manager on this OS".into(),
            ))
        }
        pub fn name(&self) -> String {
            String::new()
        }
        pub fn definition(&self) -> Option<PathBuf> {
            None
        }
        pub fn query(&self) -> Result<Option<Registration>, ServiceError> {
            Ok(None)
        }
        pub fn register(&self, _: &Path) -> Result<(), ServiceError> {
            Ok(())
        }
        pub fn start(&self) -> Result<(), ServiceError> {
            Ok(())
        }
        pub fn stop(&self) -> Result<(), ServiceError> {
            Ok(())
        }
        pub fn unregister(&self) -> Result<(), ServiceError> {
            Ok(())
        }
        pub fn connector_registered(&self) -> bool {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_readiness_checks_installed_version_not_invoking_bundle() {
        let mut readiness = Readiness {
            schema_version: crate::control::READINESS_SCHEMA,
            control_protocol: crate::control::PROTOCOL,
            ready: true,
            binary_version: "0.2.0-beta.2".into(),
            safe_reason: None,
        };
        assert!(readiness_matches(&readiness, "0.2.0-beta.2"));
        assert!(!readiness_matches(&readiness, "0.2.0-beta.1"));
        readiness.control_protocol += 1;
        assert!(!readiness_matches(&readiness, "0.2.0-beta.2"));
        readiness.control_protocol = crate::control::PROTOCOL;
        readiness.ready = false;
        assert!(!readiness_matches(&readiness, "0.2.0-beta.2"));
    }

    fn isolated(dir: &Path) -> Profile {
        Profile::isolated(dir).expect("profile")
    }

    #[test]
    fn install_binary_copies_privately_and_keeps_the_previous_copy() {
        let tmp = crate::testutil::TestDir::new("service-runtime");
        let profile = isolated(&tmp.path().join("state"));
        let src1 = tmp.path().join("one");
        let src2 = tmp.path().join("two");
        std::fs::write(&src1, b"first").unwrap();
        std::fs::write(&src2, b"second").unwrap();

        let target = install_binary(&profile, &src1).expect("install 1");
        assert_eq!(target, runtime_binary(&profile));
        assert_eq!(std::fs::read(&target).unwrap(), b"first");
        assert!(!previous_binary(&profile).exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&target).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
            let dir = std::fs::metadata(target.parent().unwrap()).unwrap();
            assert_eq!(dir.permissions().mode() & 0o777, 0o700);
        }

        install_binary(&profile, &src2).expect("install 2");
        assert_eq!(std::fs::read(&target).unwrap(), b"second");
        assert_eq!(std::fs::read(previous_binary(&profile)).unwrap(), b"first");

        // Installing from the registered copy itself is a no-op.
        install_binary(&profile, &target).expect("install self");
        assert_eq!(std::fs::read(&target).unwrap(), b"second");
        assert_eq!(std::fs::read(previous_binary(&profile)).unwrap(), b"first");
        // No staging file is left behind.
        let names: Vec<_> = std::fs::read_dir(target.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 2, "{names:?}");
    }

    #[tokio::test]
    async fn every_command_refuses_an_isolated_profile() {
        let tmp = crate::testutil::TestDir::new("service-isolated");
        let profile = isolated(&tmp.path().join("state"));
        for cmd in [
            ServiceCmd::Install,
            ServiceCmd::Uninstall,
            ServiceCmd::Status,
            ServiceCmd::Start,
            ServiceCmd::Stop,
            ServiceCmd::Restart,
        ] {
            let err = execute(cmd, &profile).await.expect_err("refused");
            assert!(matches!(err, ServiceError::IsolatedProfile), "{cmd:?}");
            assert_eq!(err.to_control().0, 2);
        }
        // Nothing was created.
        assert!(!tmp.path().join("state").join("runtime").exists());
    }

    #[cfg(unix)]
    #[test]
    fn version_probe_reads_the_version_and_gives_up_on_a_hung_binary() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = crate::testutil::TestDir::new("service-probe");
        let ok = tmp.path().join("ok");
        std::fs::write(&ok, "#!/bin/sh\necho 'mdbase 1.2.3-next.4'\n").unwrap();
        let hung = tmp.path().join("hung");
        std::fs::write(&hung, "#!/bin/sh\nexec sleep 60\n").unwrap();
        for p in [&ok, &hung] {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        assert_eq!(binary_version(&ok).as_deref(), Some("1.2.3-next.4"));
        let started = std::time::Instant::now();
        assert_eq!(binary_version(&hung), None);
        assert!(started.elapsed() < VERSION_PROBE_TIMEOUT + Duration::from_secs(2));
        assert_eq!(binary_version(&tmp.path().join("missing")), None);
    }

    #[test]
    fn names_never_collide_with_the_connector() {
        assert_ne!(SYSTEMD_UNIT, CONNECTOR_SYSTEMD_UNIT);
        assert_ne!(LAUNCHD_LABEL, CONNECTOR_LAUNCHD_LABEL);
        assert_ne!(TASK_NAME.trim_start_matches('\\'), CONNECTOR_TASK_NAME);
    }
}
