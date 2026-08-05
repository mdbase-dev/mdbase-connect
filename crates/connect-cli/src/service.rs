use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[cfg(target_os = "macos")]
const LABEL: &str = "dev.mdbase.connect";

pub fn installed() -> bool {
    service_file().is_some_and(|path| path.exists())
}

pub fn install(executable: &Path, state_dir: &Path) -> Result<(), String> {
    let runtime = install_runtime(executable, state_dir)?;
    platform::install(&runtime, state_dir)
}

pub fn uninstall() -> Result<(), String> {
    platform::uninstall()
}

pub fn start() -> Result<(), String> {
    platform::start()
}

pub fn stop() -> Result<(), String> {
    platform::stop()
}

pub fn restart() -> Result<(), String> {
    platform::restart()
}

pub fn logs(state_dir: &Path, lines: usize, follow: bool) -> Result<(), String> {
    if installed() {
        platform::logs(lines.clamp(1, 10_000), follow)
    } else {
        local_logs(state_dir, lines.clamp(1, 10_000), follow)
    }
}

pub fn open_url(url: &str) -> Result<(), String> {
    platform::open_url(url)
}

pub fn spawn_detached(
    executable: &Path,
    state_dir: &Path,
    endpoint: &str,
    loopback_port: Option<u16>,
) -> Result<(), String> {
    let mut command = Command::new(executable);
    std::fs::create_dir_all(state_dir)
        .map_err(|error| format!("Could not create {}: {error}", state_dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(state_dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Could not protect {}: {error}", state_dir.display()))?;
    }
    let log_path = state_dir.join("daemon.log");
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("Could not open {}: {error}", log_path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        log.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Could not protect {}: {error}", log_path.display()))?;
    }
    let error_log = log
        .try_clone()
        .map_err(|error| format!("Could not open {}: {error}", log_path.display()))?;
    command
        .arg("--state-dir")
        .arg(state_dir)
        .arg("--endpoint")
        .arg(endpoint)
        .args(["connect", "daemon", "run"]);
    if let Some(port) = loopback_port {
        command.args(["--loopback-port", &port.to_string()]);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(error_log));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is async-signal-safe and does not access memory shared
        // with other threads. The closure performs no allocation.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not start the Connect daemon: {error}"))
}

fn local_logs(state_dir: &Path, lines: usize, follow: bool) -> Result<(), String> {
    let path = state_dir.join("daemon.log");
    if !path.exists() {
        return Err(format!("No daemon log exists at {}.", path.display()));
    }
    #[cfg(unix)]
    {
        let mut command = Command::new("tail");
        command.arg("-n").arg(lines.to_string());
        if follow {
            command.arg("-f");
        }
        command.arg(path);
        run_checked(&mut command, "read the Connect daemon log")
    }
    #[cfg(windows)]
    {
        let mut command = Command::new("powershell");
        let mut script = format!(
            "Get-Content -LiteralPath '{}' -Tail {}",
            path.display().to_string().replace('\'', "''"),
            lines
        );
        if follow {
            script.push_str(" -Wait");
        }
        command.args(["-NoProfile", "-Command", &script]);
        run_checked(&mut command, "read the Connect daemon log")
    }
}

fn service_file() -> Option<PathBuf> {
    platform::service_file()
}

fn install_runtime(executable: &Path, state_dir: &Path) -> Result<PathBuf, String> {
    let directory = state_dir.join("runtime");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create {}: {error}", directory.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Could not protect {}: {error}", directory.display()))?;
    }
    let extension = if cfg!(windows) { ".exe" } else { "" };
    let destination = directory.join(format!("mdbase{extension}"));
    if executable == destination {
        return Ok(destination);
    }
    let temporary = directory.join(format!("mdbase.tmp-{}", std::process::id()));
    let _ = std::fs::remove_file(&temporary);
    if let Err(error) = std::fs::copy(executable, &temporary) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!(
            "Could not stage the Connect runtime from {} to {}: {error}",
            executable.display(),
            temporary.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(error) =
            std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o700))
        {
            let _ = std::fs::remove_file(&temporary);
            return Err(format!(
                "Could not protect {}: {error}",
                temporary.display()
            ));
        }
    }
    if let Err(error) = activate_runtime_file(&temporary, &destination) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!(
            "Could not activate the Connect runtime at {}: {error}",
            destination.display()
        ));
    }
    Ok(destination)
}

#[cfg(not(windows))]
fn activate_runtime_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(temporary, destination)
}

#[cfg(windows)]
fn activate_runtime_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    let previous = destination.with_extension("previous.exe");
    let _ = std::fs::remove_file(&previous);
    let had_previous = destination.exists();
    if had_previous {
        std::fs::rename(destination, &previous)?;
    }
    if let Err(error) = std::fs::rename(temporary, destination) {
        if had_previous {
            let _ = std::fs::rename(&previous, destination);
        }
        return Err(error);
    }
    let _ = std::fs::remove_file(previous);
    Ok(())
}

fn run_checked(command: &mut Command, action: &str) -> Result<(), String> {
    let status = command
        .status()
        .map_err(|error| format!("Could not {action}: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "Could not {action}: command exited with {}.",
            status.code().unwrap_or(-1)
        ))
    }
}

#[cfg(test)]
mod runtime_tests {
    use super::*;

    #[test]
    fn installed_service_runtime_uses_a_stable_private_path_and_is_replaceable() {
        let root =
            std::env::temp_dir().join(format!("mdbase-runtime-test-{}", uuid::Uuid::new_v4()));
        let source = root.join("source");
        let state = root.join("state");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&source, b"version one").unwrap();

        let installed = install_runtime(&source, &state).unwrap();

        assert_eq!(
            installed,
            state.join(if cfg!(windows) {
                "runtime/mdbase.exe"
            } else {
                "runtime/mdbase"
            })
        );
        assert_eq!(std::fs::read(&installed).unwrap(), b"version one");
        std::fs::write(&source, b"version two").unwrap();
        assert_eq!(install_runtime(&source, &state).unwrap(), installed);
        assert_eq!(std::fs::read(&installed).unwrap(), b"version two");
        assert_eq!(install_runtime(&installed, &state).unwrap(), installed);
        assert_eq!(std::fs::read(&installed).unwrap(), b"version two");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(state.join("runtime"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&installed).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(target_os = "linux")]
fn escape_systemd_argument(value: &Path) -> String {
    let value = value.to_string_lossy();
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
            .replace('\t', "\\t")
            .replace('%', "%%")
    )
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    pub fn service_file() -> Option<PathBuf> {
        directories::BaseDirs::new().map(|dirs| {
            dirs.config_dir()
                .join("systemd/user/mdbase-connect.service")
        })
    }

    pub fn install(executable: &Path, state_dir: &Path) -> Result<(), String> {
        let path = service_file().ok_or("Could not locate the user configuration directory.")?;
        let parent = path
            .parent()
            .ok_or("The systemd user directory is invalid.")?;
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
        let unit = render_unit(executable, state_dir);
        write_atomic(&path, unit.as_bytes())?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
            .map_err(|error| format!("Could not protect {}: {error}", path.display()))?;
        run_checked(
            Command::new("systemctl")
                .args(["--user", "daemon-reload"])
                .stdin(Stdio::null()),
            "reload the per-user service manager",
        )?;
        run_checked(
            Command::new("systemctl")
                .args(["--user", "enable", "--now", "mdbase-connect.service"])
                .stdin(Stdio::null()),
            "enable the Connect daemon",
        )
    }

    pub fn uninstall() -> Result<(), String> {
        let path = service_file().ok_or("Could not locate the user configuration directory.")?;
        if path.exists() {
            run_checked(
                Command::new("systemctl")
                    .args(["--user", "disable", "--now", "mdbase-connect.service"])
                    .stdin(Stdio::null()),
                "disable the Connect daemon",
            )?;
            std::fs::remove_file(&path)
                .map_err(|error| format!("Could not remove {}: {error}", path.display()))?;
            run_checked(
                Command::new("systemctl")
                    .args(["--user", "daemon-reload"])
                    .stdin(Stdio::null()),
                "reload the per-user service manager",
            )?;
        }
        Ok(())
    }

    pub fn start() -> Result<(), String> {
        run_checked(
            Command::new("systemctl")
                .args(["--user", "start", "mdbase-connect.service"])
                .stdin(Stdio::null()),
            "start the Connect daemon",
        )
    }

    pub fn stop() -> Result<(), String> {
        run_checked(
            Command::new("systemctl")
                .args(["--user", "stop", "mdbase-connect.service"])
                .stdin(Stdio::null()),
            "stop the Connect daemon",
        )
    }

    pub fn restart() -> Result<(), String> {
        run_checked(
            Command::new("systemctl")
                .args(["--user", "restart", "mdbase-connect.service"])
                .stdin(Stdio::null()),
            "restart the Connect daemon",
        )
    }

    pub fn logs(lines: usize, follow: bool) -> Result<(), String> {
        let mut command = Command::new("journalctl");
        command.args([
            "--user-unit",
            "mdbase-connect.service",
            "--lines",
            &lines.to_string(),
            "--no-pager",
        ]);
        if follow {
            command.arg("--follow");
        }
        run_checked(&mut command, "read the Connect daemon logs")
    }

    pub fn open_url(url: &str) -> Result<(), String> {
        run_checked(
            Command::new("xdg-open")
                .arg(url)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null()),
            "open the approval page",
        )
    }

    fn render_unit(executable: &Path, state_dir: &Path) -> String {
        format!(
            "[Unit]\n\
             Description=mdbase connect daemon\n\
             Documentation=https://mdbase.dev\n\
             After=network-online.target\n\
             Wants=network-online.target\n\n\
             [Service]\n\
             Type=simple\n\
             ExecStart={} --state-dir {} connect daemon run\n\
             Restart=on-failure\n\
             RestartSec=2\n\
             TimeoutStopSec=20\n\
             NoNewPrivileges=true\n\
             PrivateTmp=true\n\
             ProtectSystem=full\n\n\
             [Install]\n\
             WantedBy=default.target\n",
            escape_systemd_argument(executable),
            escape_systemd_argument(state_dir)
        )
    }

    fn write_atomic(path: &Path, value: &[u8]) -> Result<(), String> {
        let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
        std::fs::write(&temporary, value)
            .map_err(|error| format!("Could not write {}: {error}", temporary.display()))?;
        std::fs::rename(&temporary, path)
            .map_err(|error| format!("Could not replace {}: {error}", path.display()))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn unit_quotes_executable_and_state_paths() {
            let unit = render_unit(
                Path::new("/opt/mdbase connect/mdbase"),
                Path::new("/home/person/.local/share/mdbase connect"),
            );
            assert!(unit.contains(
                "ExecStart=\"/opt/mdbase connect/mdbase\" --state-dir \"/home/person/.local/share/mdbase connect\" connect daemon run"
            ));
            assert!(unit.contains("NoNewPrivileges=true"));
            assert!(!unit.contains("ProtectHome"));
            assert!(unit.contains("ProtectSystem=full"));
            assert!(!unit.contains("ProtectSystem=strict"));
        }

        #[test]
        fn unit_escapes_directive_and_specifier_characters() {
            let unit = render_unit(
                Path::new("/opt/mdbase%\nconnect"),
                Path::new("/home/person/state%\r"),
            );
            assert!(unit.contains("/opt/mdbase%%\\nconnect"));
            assert!(unit.contains("/home/person/state%%\\r"));
            assert_eq!(unit.matches("ExecStart=").count(), 1);
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    pub fn service_file() -> Option<PathBuf> {
        directories::BaseDirs::new().map(|dirs| {
            dirs.home_dir()
                .join("Library/LaunchAgents")
                .join(format!("{LABEL}.plist"))
        })
    }

    pub fn install(executable: &Path, state_dir: &Path) -> Result<(), String> {
        let path = service_file().ok_or("Could not locate the user LaunchAgents directory.")?;
        let parent = path
            .parent()
            .ok_or("The user LaunchAgents directory is invalid.")?;
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create LaunchAgents: {error}"))?;
        let xml = render_plist(executable, state_dir);
        std::fs::write(&path, xml)
            .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
        let domain = format!("gui/{}", unsafe { libc::geteuid() });
        let _ = bootout();
        run_checked(
            Command::new("launchctl").args(["bootstrap", &domain, path.to_string_lossy().as_ref()]),
            "install the Connect launch agent",
        )
    }

    pub fn uninstall() -> Result<(), String> {
        let path = service_file().ok_or("Could not locate the user LaunchAgents directory.")?;
        if path.exists() {
            let _ = bootout();
            std::fs::remove_file(&path)
                .map_err(|error| format!("Could not remove {}: {error}", path.display()))?;
        }
        Ok(())
    }

    pub fn start() -> Result<(), String> {
        if !loaded() {
            let path = service_file().ok_or("Could not locate the Connect launch agent.")?;
            let domain = format!("gui/{}", unsafe { libc::geteuid() });
            return run_checked(
                Command::new("launchctl").args([
                    "bootstrap",
                    &domain,
                    path.to_string_lossy().as_ref(),
                ]),
                "start the Connect daemon",
            );
        }
        let target = format!("gui/{}/{}", unsafe { libc::geteuid() }, LABEL);
        run_checked(
            Command::new("launchctl").args(["kickstart", &target]),
            "start the Connect daemon",
        )
    }

    pub fn stop() -> Result<(), String> {
        bootout()
    }

    pub fn restart() -> Result<(), String> {
        if loaded() {
            bootout()?;
        }
        start()
    }

    pub fn logs(lines: usize, follow: bool) -> Result<(), String> {
        let mut command = Command::new("log");
        if follow {
            command.args(["stream", "--predicate", "process == \"mdbase\""]);
        } else {
            command.args([
                "show",
                "--last",
                "1h",
                "--style",
                "compact",
                "--predicate",
                "process == \"mdbase\"",
            ]);
        }
        command.env("MDBASE_CONNECT_LOG_LINES", lines.to_string());
        run_checked(&mut command, "read the Connect daemon logs")
    }

    pub fn open_url(url: &str) -> Result<(), String> {
        run_checked(Command::new("open").arg(url), "open the approval page")
    }

    fn loaded() -> bool {
        let target = format!("gui/{}/{}", unsafe { libc::geteuid() }, LABEL);
        Command::new("launchctl")
            .args(["print", &target])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    fn bootout() -> Result<(), String> {
        if !loaded() {
            return Ok(());
        }
        let target = format!("gui/{}/{}", unsafe { libc::geteuid() }, LABEL);
        run_checked(
            Command::new("launchctl").args(["bootout", &target]),
            "stop the Connect daemon",
        )
    }

    fn render_plist(executable: &Path, state_dir: &Path) -> String {
        let escape = |value: &Path| {
            value
                .to_string_lossy()
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
        };
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \
             \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
             <plist version=\"1.0\"><dict>\n\
             <key>Label</key><string>{LABEL}</string>\n\
             <key>ProgramArguments</key><array>\n\
             <string>{}</string><string>--state-dir</string><string>{}</string>\
             <string>connect</string><string>daemon</string><string>run</string>\n\
             </array>\n\
             <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n\
             <key>ProcessType</key><string>Interactive</string>\n\
             </dict></plist>\n",
            escape(executable),
            escape(state_dir)
        )
    }
}

#[cfg(windows)]
mod platform {
    use super::*;

    pub fn service_file() -> Option<PathBuf> {
        directories::BaseDirs::new().map(|dirs| {
            dirs.data_local_dir()
                .join("mdbase/connect/daemon-installed")
        })
    }

    pub fn install(executable: &Path, state_dir: &Path) -> Result<(), String> {
        let action = format!(
            "\"{}\" --state-dir \"{}\" connect daemon run",
            executable.display(),
            state_dir.display()
        );
        run_checked(
            Command::new("schtasks").args([
                "/Create",
                "/F",
                "/SC",
                "ONLOGON",
                "/TN",
                "mdbase connect",
                "/TR",
                &action,
                "/RL",
                "LIMITED",
            ]),
            "install the Connect background task",
        )?;
        let marker = service_file().ok_or("Could not locate local application data.")?;
        let parent = marker
            .parent()
            .ok_or("The Connect service state directory is invalid.")?;
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create service state: {error}"))?;
        std::fs::write(marker, b"1")
            .map_err(|error| format!("Could not save service state: {error}"))?;
        start()
    }

    pub fn uninstall() -> Result<(), String> {
        let _ = run_checked(
            Command::new("schtasks").args(["/Delete", "/F", "/TN", "mdbase connect"]),
            "remove the Connect background task",
        );
        if let Some(marker) = service_file() {
            let _ = std::fs::remove_file(marker);
        }
        Ok(())
    }

    pub fn start() -> Result<(), String> {
        run_checked(
            Command::new("schtasks").args(["/Run", "/TN", "mdbase connect"]),
            "start the Connect daemon",
        )
    }

    pub fn stop() -> Result<(), String> {
        run_checked(
            Command::new("schtasks").args(["/End", "/TN", "mdbase connect"]),
            "stop the Connect daemon",
        )
    }

    pub fn restart() -> Result<(), String> {
        stop()?;
        start()
    }

    pub fn logs(_lines: usize, _follow: bool) -> Result<(), String> {
        Err("Windows daemon logs are available through Event Viewer.".to_string())
    }

    pub fn open_url(url: &str) -> Result<(), String> {
        run_checked(
            Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]),
            "open the approval page",
        )
    }
}
