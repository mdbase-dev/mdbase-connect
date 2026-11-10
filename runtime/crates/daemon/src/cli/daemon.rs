//! The daemon process: running it and the companion, starting, stopping and its log.

use super::*;

pub(super) fn run_companion(profile: Profile, json_output: bool) -> ExitCode {
    let out = Output {
        json: json_output,
        yes: false,
    };
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

pub(super) fn run_daemon(profile: Profile) -> ExitCode {
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
    let result = rt.block_on(server::run(profile, None));
    // Dropping a runtime waits, without limit, for blocking work still running (a
    // hung DNS lookup, a service-manager command). The sockets are gone by now: a
    // process that lingers only blocks app updates and service reinstalls.
    if finish_runtime(rt, EXIT_DEADLINE) {
        tracing::warn!(
            deadline_s = EXIT_DEADLINE.as_secs(),
            "blocking work was still running at exit; exiting anyway"
        );
    }
    match result {
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

/// How long a stopped daemon waits for leftover blocking work before exiting.
const EXIT_DEADLINE: Duration = Duration::from_secs(5);

/// Shut `rt` down, waiting at most `deadline` for blocking tasks. True when it
/// had to stop waiting (work was abandoned, not finished).
fn finish_runtime(rt: tokio::runtime::Runtime, deadline: Duration) -> bool {
    let started = std::time::Instant::now();
    rt.shutdown_timeout(deadline);
    started.elapsed() >= deadline
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

pub(super) async fn daemon_start(profile: &Profile, out: &Output) -> Result<ExitCode, ClientError> {
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

pub(super) async fn daemon_stop(profile: &Profile, out: &Output) -> Result<ExitCode, ClientError> {
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

pub(super) async fn logs(
    profile: &Profile,
    lines: usize,
    follow: bool,
) -> Result<ExitCode, ClientError> {
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

#[cfg(test)]
mod exit_tests {
    use super::*;

    #[test]
    fn stuck_blocking_work_cannot_keep_a_stopped_daemon_alive() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        rt.spawn_blocking(move || {
            // Stands in for a hung DNS lookup or service-manager command.
            let _ = rx.recv_timeout(Duration::from_secs(60));
        });
        let started = std::time::Instant::now();
        assert!(finish_runtime(rt, Duration::from_millis(200)));
        assert!(started.elapsed() < Duration::from_secs(5));
        drop(tx);
    }
}
