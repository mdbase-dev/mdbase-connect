use super::*;
use fs2::FileExt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DaemonTarget {
    InstalledService,
    IsolatedProfile,
}

impl DaemonTarget {
    pub(super) const fn from_overrides(state_dir: bool, endpoint: bool) -> Self {
        if state_dir || endpoint {
            Self::IsolatedProfile
        } else {
            Self::InstalledService
        }
    }

    pub(super) const fn label(self) -> &'static str {
        match self {
            Self::InstalledService => "installed_service",
            Self::IsolatedProfile => "isolated_profile",
        }
    }

    pub(super) fn require_installed_service(self, operation: &str) -> Result<(), CliError> {
        if self == Self::InstalledService {
            Ok(())
        } else {
            Err(CliError::usage(format!(
                "`mdbase connect daemon {operation}` targets only the default installed service; \
                 remove --state-dir and --endpoint, or use `daemon run` for an isolated profile."
            )))
        }
    }
}

pub(super) struct ConnectPaths {
    pub(super) state_dir: PathBuf,
    pub(super) endpoint: String,
    pub(super) target: DaemonTarget,
}

pub(super) fn connect_paths(
    state_dir: Option<PathBuf>,
    endpoint: Option<String>,
) -> Result<ConnectPaths, CliError> {
    let target = DaemonTarget::from_overrides(state_dir.is_some(), endpoint.is_some());
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
    Ok(ConnectPaths {
        state_dir,
        endpoint,
        target,
    })
}

#[cfg(unix)]
pub(super) fn resolve_control_endpoint(endpoint: String) -> Result<String, CliError> {
    std::path::absolute(&endpoint)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| {
            CliError::internal(format!("Could not resolve the control endpoint: {error}"))
        })
}

#[cfg(windows)]
pub(super) fn resolve_control_endpoint(endpoint: String) -> Result<String, CliError> {
    Ok(endpoint)
}

pub(super) async fn execute_daemon_command(
    command: DaemonCommand,
    state_dir: &Path,
    endpoint: &str,
    target: DaemonTarget,
) -> Result<Value, CliError> {
    let executable = std::env::current_exe().map_err(|error| {
        CliError::internal(format!("Could not locate this executable: {error}"))
    })?;
    match command {
        DaemonCommand::Install => {
            target.require_installed_service("install")?;
            let installed = service::installed();
            let running = send(endpoint, ControlRequest::new(ControlCommand::Ping))
                .await
                .is_ok_and(|response| response.ok);
            if installed {
                match service::stop() {
                    Ok(()) if running => wait_until_stopped(state_dir, endpoint).await?,
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
                wait_until_stopped(state_dir, endpoint).await?;
            }
            service::install(&executable, state_dir)
                .map_err(CliError::internal)
                .map(|_| serde_json::json!({"installed": true}))
        }
        DaemonCommand::Uninstall => {
            target.require_installed_service("uninstall")?;
            service::uninstall()
                .map_err(CliError::internal)
                .map(|_| serde_json::json!({"installed": false}))
        }
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
            if target == DaemonTarget::InstalledService && service::installed() {
                service::start().map_err(CliError::internal)?;
            } else {
                service::spawn_detached(&executable, state_dir, endpoint, None)
                    .map_err(CliError::internal)?;
            }
            wait_until_ready(endpoint).await?;
            Ok(serde_json::json!({"started": true}))
        }
        DaemonCommand::Stop => {
            if target == DaemonTarget::InstalledService && service::installed() {
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
            wait_until_stopped(state_dir, endpoint).await?;
            Ok(serde_json::json!({"stopped": true}))
        }
        DaemonCommand::Restart => {
            let loopback_port = current_loopback_port(endpoint).await;
            restart_daemon(state_dir, endpoint, target, loopback_port).await?;
            Ok(serde_json::json!({"restarted": true}))
        }
        DaemonCommand::Status => {
            let installed = target == DaemonTarget::InstalledService && service::installed();
            let response = send(endpoint, ControlRequest::new(ControlCommand::Status)).await;
            Ok(match response {
                Ok(response) if response.ok => serde_json::json!({
                    "target": target.label(),
                    "installed": installed,
                    "running": true,
                    "status": response.result
                }),
                _ => serde_json::json!({
                    "target": target.label(),
                    "installed": installed,
                    "running": false
                }),
            })
        }
        DaemonCommand::Logs { lines, follow } => {
            target.require_installed_service("logs")?;
            service::logs(state_dir, lines, follow).map_err(CliError::internal)?;
            Ok(serde_json::json!({"shown": true}))
        }
        DaemonCommand::Run { .. } => unreachable!("foreground daemon handled before dispatch"),
    }
}

pub(super) async fn doctor(state_dir: &Path, endpoint: &str, target: DaemonTarget) -> Value {
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
            "target": target.label(),
            "endpoint": endpoint,
            "state": daemon,
            "status": status
        },
        "service_installed":
            target == DaemonTarget::InstalledService && service::installed()
    })
}

pub(super) fn create_private_state_dir(state_dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(state_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(state_dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

pub(super) async fn restart_daemon(
    state_dir: &Path,
    endpoint: &str,
    target: DaemonTarget,
    loopback_port: Option<u16>,
) -> Result<(), CliError> {
    if target == DaemonTarget::InstalledService && service::installed() {
        service::restart().map_err(CliError::internal)?;
    } else {
        let _ = send(
            endpoint,
            ControlRequest::new(ControlCommand::DaemonShutdown),
        )
        .await;
        wait_until_stopped(state_dir, endpoint).await?;
        let executable = std::env::current_exe().map_err(|error| {
            CliError::internal(format!("Could not locate this executable: {error}"))
        })?;
        service::spawn_detached(&executable, state_dir, endpoint, loopback_port)
            .map_err(CliError::internal)?;
    }
    wait_until_ready(endpoint).await
}

pub(super) async fn current_loopback_port(endpoint: &str) -> Option<u16> {
    let response = send(endpoint, ControlRequest::new(ControlCommand::Status))
        .await
        .ok()?;
    if !response.ok {
        return None;
    }
    response
        .result?
        .get("loopback_port")?
        .as_u64()
        .and_then(|port| u16::try_from(port).ok())
}

pub(super) async fn wait_until_stopped(state_dir: &Path, endpoint: &str) -> Result<(), CliError> {
    for _ in 0..100 {
        if send(endpoint, ControlRequest::new(ControlCommand::Ping))
            .await
            .is_err()
            && daemon_lease_released(state_dir)
        {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Err(CliError::unavailable(
        "The Connect daemon did not stop within five seconds.",
    ))
}

fn daemon_lease_released(state_dir: &Path) -> bool {
    let path = state_dir.join("daemon.lock");
    let file = match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return true,
        Err(_) => return false,
    };
    if file.try_lock_exclusive().is_err() {
        return false;
    }
    let _ = file.unlock();
    true
}

pub(super) async fn wait_until_ready(endpoint: &str) -> Result<(), CliError> {
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

pub(super) async fn exchange<S>(
    stream: S,
    request: ControlRequest,
) -> Result<ControlResponse, CliError>
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
pub(super) async fn send(
    endpoint: &str,
    request: ControlRequest,
) -> Result<ControlResponse, CliError> {
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
pub(super) async fn send(
    endpoint: &str,
    request: ControlRequest,
) -> Result<ControlResponse, CliError> {
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

pub(super) fn control_request_timeout(command: &ControlCommand) -> std::time::Duration {
    let seconds = match command {
        ControlCommand::MirrorAdd(_)
        | ControlCommand::MirrorInspect(_)
        | ControlCommand::MirrorApply(_)
        | ControlCommand::MirrorConfigureSelectiveSync(_)
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
    fn shutdown_waits_for_the_daemon_lease_after_the_socket_disappears() {
        let temporary = tempfile::tempdir().unwrap();
        assert!(daemon_lease_released(temporary.path()));

        let lease = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(temporary.path().join("daemon.lock"))
            .unwrap();
        lease.try_lock_exclusive().unwrap();
        assert!(!daemon_lease_released(temporary.path()));
        lease.unlock().unwrap();
        assert!(daemon_lease_released(temporary.path()));
    }
}
