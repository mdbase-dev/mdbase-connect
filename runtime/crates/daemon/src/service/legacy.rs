//! The connector's service, stopped and disabled by the takeover's step T1
//! (desktop service packaging;
//! connector-journal settlement).
//!
//! | OS | registration | stop + disable |
//! |---|---|---|
//! | Linux | user unit `mdbase-connect.service` | `systemctl --user disable --now mdbase-connect.service` |
//! | macOS | LaunchAgent `dev.mdbase.connect` | `launchctl bootout gui/<uid>/dev.mdbase.connect`, then `launchctl disable` |
//! | Windows | scheduled task `"mdbase connect"` | `schtasks /End`, then `schtasks /Change /DISABLE` |
//!
//! Then, if the connector's private runtime copy exists
//! (`<connector state>/runtime/mdbase[.exe]`), `mdbase connect daemon stop` asks the
//! old daemon itself to stop, which also covers a connector that was started by hand.
//!
//! **Safe when absent.** Nothing is run against a registration that isn't there: each
//! manager is queried first, and a missing unit, agent, task or binary is success.
//! The disable is what matters: the old desktop app re-enables its daemon on launch
//! (§3.4), so the takeover driver calls this at every start, and the bridge release
//! (D1) stops re-enabling it.
//!
//! Implements `mdbn_legacy::OldService`, also re-exported as
//! `mdbn_migrate::takeover::OldService`. The existing legacy dependency carries the
//! shared hook; this crate does not depend on the migrator composition crate.
//!
//! Only the three connector names and its state directory are touched; this module
//! never writes under the connector's state directory and never deletes its unit,
//! agent or task, so a rollback (migration rollback) can re-enable it.

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

#[allow(unused_imports)] // Each platform uses one of the three.
use super::{CONNECTOR_LAUNCHD_LABEL, CONNECTOR_SYSTEMD_UNIT, CONNECTOR_TASK_NAME};

/// The connector's command for stopping its daemon (`connect-cli`).
const CONNECTOR_STOP: [&str; 3] = ["connect", "daemon", "stop"];

/// Runs service-manager and connector commands. Injected so each platform's plan can
/// be tested without a service manager.
pub trait Exec {
    /// Run `program` with `args`, no stdin, and return its exit status and output.
    fn run(&mut self, program: &Path, args: &[&str]) -> io::Result<Output>;
}

/// The real thing: `std::process::Command` with no stdin.
#[derive(Debug, Default)]
pub struct System;

impl Exec for System {
    fn run(&mut self, program: &Path, args: &[&str]) -> io::Result<Output> {
        Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .output()
    }
}

/// Where the connector keeps its registrations and its runtime copy. Read once from
/// the environment (`Environment::from_process`) or built by tests.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Environment {
    /// `HOME` (Unix).
    pub home: Option<PathBuf>,
    /// `XDG_CONFIG_HOME` (Linux user units live under it).
    pub xdg_config_home: Option<PathBuf>,
    /// `XDG_DATA_HOME` (the connector's Linux state directory lives under it).
    pub xdg_data_home: Option<PathBuf>,
    /// `LOCALAPPDATA` (Windows).
    pub local_app_data: Option<PathBuf>,
    /// `MDBASE_CONNECT_HOME`: the connector's explicit state directory override.
    pub connect_home: Option<PathBuf>,
    /// Effective uid (the launchd `gui/<uid>` domain).
    pub euid: u32,
}

impl Environment {
    /// The current process's environment.
    pub fn from_process() -> Environment {
        let dir = |key: &str| {
            std::env::var_os(key)
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
        };
        #[cfg(unix)]
        let euid = crate::fsutil::euid();
        #[cfg(not(unix))]
        let euid = 0; // Only the Unix launchd plan consumes the uid.
        Environment {
            home: dir("HOME"),
            xdg_config_home: dir("XDG_CONFIG_HOME"),
            xdg_data_home: dir("XDG_DATA_HOME"),
            local_app_data: dir("LOCALAPPDATA"),
            connect_home: dir("MDBASE_CONNECT_HOME"),
            euid,
        }
    }

    /// The connector's state directory: `MDBASE_CONNECT_HOME`, else what its
    /// `ProjectDirs::from("dev", "mdbase", "connect").data_local_dir()` resolves to.
    pub fn connector_state_dir(&self) -> Option<PathBuf> {
        if let Some(explicit) = &self.connect_home {
            return Some(explicit.clone());
        }
        if cfg!(target_os = "macos") {
            self.home.as_ref().map(|h| {
                h.join("Library")
                    .join("Application Support")
                    .join("dev.mdbase.connect")
            })
        } else if cfg!(windows) {
            self.local_app_data
                .as_ref()
                .map(|l| l.join("mdbase").join("connect").join("data"))
        } else {
            self.xdg_data_home
                .clone()
                .or_else(|| self.home.as_ref().map(|h| h.join(".local").join("share")))
                .map(|d| d.join("connect"))
        }
    }

    /// The connector's private runtime copy, if it is installed.
    pub fn connector_binary(&self) -> Option<PathBuf> {
        let name = if cfg!(windows) {
            "mdbase.exe"
        } else {
            "mdbase"
        };
        self.connector_state_dir()
            .map(|s| s.join("runtime").join(name))
            .filter(|p| p.is_file())
    }

    /// Linux: the connector's user unit file.
    pub fn connector_unit(&self) -> Option<PathBuf> {
        self.xdg_config_home
            .clone()
            .or_else(|| self.home.as_ref().map(|h| h.join(".config")))
            .map(|c| c.join("systemd").join("user").join(CONNECTOR_SYSTEMD_UNIT))
    }

    /// macOS: the connector's LaunchAgent plist.
    pub fn connector_plist(&self) -> Option<PathBuf> {
        self.home.as_ref().map(|h| {
            h.join("Library")
                .join("LaunchAgents")
                .join(format!("{CONNECTOR_LAUNCHD_LABEL}.plist"))
        })
    }

    /// macOS: the connector's launchd service target.
    pub fn connector_launchd_target(&self) -> String {
        format!("gui/{}/{CONNECTOR_LAUNCHD_LABEL}", self.euid)
    }
}

/// The old connector daemon's service manager, for the takeover (T1).
pub struct OldConnectorService {
    exec: Box<dyn Exec>,
    env: Environment,
}

impl std::fmt::Debug for OldConnectorService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OldConnectorService")
            .field("env", &self.env)
            .finish_non_exhaustive()
    }
}

impl mdbn_legacy::OldService for OldConnectorService {
    fn stop_and_disable(&mut self) -> Result<(), String> {
        OldConnectorService::stop_and_disable(self)
    }
}

impl Default for OldConnectorService {
    fn default() -> Self {
        Self::new()
    }
}

impl OldConnectorService {
    /// The real service managers and this process's environment.
    pub fn new() -> OldConnectorService {
        Self::with(Box::new(System), Environment::from_process())
    }

    /// A specific runner and environment (tests, or a driver that records commands).
    pub fn with(exec: Box<dyn Exec>, env: Environment) -> OldConnectorService {
        OldConnectorService { exec, env }
    }

    /// Stop the old daemon and disable its autostart. Safe to call when it isn't
    /// registered or running. Same signature as
    /// `mdbn_migrate::takeover::OldService::stop_and_disable`.
    pub fn stop_and_disable(&mut self) -> Result<(), String> {
        let registered = self.disable_registration()?;
        self.stop_by_connector(registered)
    }

    /// A probe: whether the manager command succeeded. A service manager that isn't
    /// installed at all (the program is not found) means nothing is registered with
    /// it, so that reads as `false`; other launch failures are errors.
    fn manager(&mut self, program: &str, args: &[&str]) -> Result<bool, String> {
        match self.exec.run(Path::new(program), args) {
            Ok(out) => Ok(out.status.success()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(format!("{program}: {e}")),
        }
    }

    fn manager_or_fail(&mut self, program: &str, args: &[&str], what: &str) -> Result<(), String> {
        let out = self
            .exec
            .run(Path::new(program), args)
            .map_err(|e| format!("could not {what}: {program}: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!(
                "could not {what}: `{program} {}` failed ({}): {}",
                args.join(" "),
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    }

    /// Stop and disable through the OS service manager. `Ok(true)` when the
    /// connector was registered (and is now disabled), `Ok(false)` when it isn't.
    #[cfg(target_os = "linux")]
    fn disable_registration(&mut self) -> Result<bool, String> {
        // A unit file is the normal sign; `is-enabled`/`is-active` also catch a unit
        // installed elsewhere (a package) or still running after its file was removed.
        let unit_file = self.env.connector_unit().is_some_and(|p| p.exists());
        let known = unit_file
            || self.manager(
                "systemctl",
                &["--user", "is-enabled", CONNECTOR_SYSTEMD_UNIT],
            )?
            || self.manager(
                "systemctl",
                &["--user", "is-active", CONNECTOR_SYSTEMD_UNIT],
            )?;
        if !known {
            return Ok(false);
        }
        self.manager_or_fail(
            "systemctl",
            &["--user", "disable", "--now", CONNECTOR_SYSTEMD_UNIT],
            "stop and disable the connector's user unit",
        )?;
        Ok(true)
    }

    #[cfg(target_os = "macos")]
    fn disable_registration(&mut self) -> Result<bool, String> {
        let target = self.env.connector_launchd_target();
        let loaded = self.manager("launchctl", &["print", &target])?;
        let plist = self.env.connector_plist().is_some_and(|p| p.exists());
        if !loaded && !plist {
            return Ok(false);
        }
        if loaded {
            self.manager_or_fail(
                "launchctl",
                &["bootout", &target],
                "stop the connector's launch agent",
            )?;
        }
        // Persisted in launchd's override database: a later `bootstrap` of the plist
        // (the old app on launch) is refused until `enable`.
        self.manager_or_fail(
            "launchctl",
            &["disable", &target],
            "disable the connector's launch agent",
        )?;
        Ok(true)
    }

    #[cfg(windows)]
    fn disable_registration(&mut self) -> Result<bool, String> {
        if !self.manager("schtasks", &["/Query", "/TN", CONNECTOR_TASK_NAME])? {
            return Ok(false);
        }
        // `/End` fails when the task isn't running; that is fine.
        let _ = self.manager("schtasks", &["/End", "/TN", CONNECTOR_TASK_NAME])?;
        self.manager_or_fail(
            "schtasks",
            &["/Change", "/TN", CONNECTOR_TASK_NAME, "/DISABLE"],
            "disable the connector's scheduled task",
        )?;
        Ok(true)
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    fn disable_registration(&mut self) -> Result<bool, String> {
        Ok(false)
    }

    /// Ask the connector's own binary to stop its daemon. Covers a daemon started by
    /// hand, and is the only means when no registration was found. When the manager
    /// already stopped it, a failure here (nothing left to stop) is not an error.
    fn stop_by_connector(&mut self, registered: bool) -> Result<(), String> {
        let Some(binary) = self.env.connector_binary() else {
            return Ok(());
        };
        let out = self
            .exec
            .run(&binary, &CONNECTOR_STOP)
            .map_err(|e| format!("could not run {}: {e}", binary.display()))?;
        if out.status.success() || registered {
            Ok(())
        } else {
            Err(format!(
                "`{} connect daemon stop` failed ({}): {}",
                binary.display(),
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Records every command; answers from a table keyed by "program arg0 arg1…".
    #[derive(Default)]
    struct Recorder {
        ok: HashMap<String, bool>,
        /// Programs that are not installed: running them is `NotFound`.
        missing: Vec<String>,
        calls: Vec<String>,
    }

    fn key(program: &Path, args: &[&str]) -> String {
        let program = program
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        std::iter::once(program)
            .chain(args.iter().map(|a| a.to_string()))
            .collect::<Vec<_>>()
            .join(" ")
    }

    impl Exec for Recorder {
        fn run(&mut self, program: &Path, args: &[&str]) -> io::Result<Output> {
            let k = key(program, args);
            let ok = self.ok.get(&k).copied().unwrap_or(false);
            self.calls.push(k);
            if self.missing.iter().any(|m| Path::new(m) == program) {
                return Err(io::Error::new(io::ErrorKind::NotFound, "not installed"));
            }
            // A real process is the only portable way to make an `ExitStatus`.
            let cmd = if cfg!(windows) {
                ("cmd", if ok { "/C exit 0" } else { "/C exit 1" })
            } else {
                ("sh", if ok { "-c true" } else { "-c false" })
            };
            Command::new(cmd.0)
                .args(cmd.1.split(' '))
                .stdin(Stdio::null())
                .output()
        }
    }

    struct Fixture {
        _dir: crate::testutil::TestDir,
        env: Environment,
    }

    fn fixture(tag: &str) -> Fixture {
        let dir = crate::testutil::TestDir::new(tag);
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let env = Environment {
            home: Some(home.clone()),
            xdg_config_home: None,
            xdg_data_home: None,
            local_app_data: Some(home.join("AppData").join("Local")),
            connect_home: Some(dir.path().join("connect-state")),
            euid: 501,
        };
        Fixture { _dir: dir, env }
    }

    impl Fixture {
        fn install_binary(&self) -> PathBuf {
            let path = self.env.connector_binary_path();
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, b"").unwrap();
            path
        }
    }

    impl Environment {
        fn connector_binary_path(&self) -> PathBuf {
            let name = if cfg!(windows) {
                "mdbase.exe"
            } else {
                "mdbase"
            };
            self.connector_state_dir()
                .unwrap()
                .join("runtime")
                .join(name)
        }
    }

    /// Run with a recorder and return (result, calls).
    fn run(env: Environment, ok: &[&str]) -> (Result<(), String>, Vec<String>) {
        run_with(env, ok, &[])
    }

    /// As `run`, with `missing` programs that are not installed.
    fn run_with(
        env: Environment,
        ok: &[&str],
        missing: &[&str],
    ) -> (Result<(), String>, Vec<String>) {
        let recorder = Recorder {
            ok: ok.iter().map(|k| (k.to_string(), true)).collect(),
            missing: missing.iter().map(|m| m.to_string()).collect(),
            calls: Vec::new(),
        };
        let shared = std::rc::Rc::new(std::cell::RefCell::new(recorder));
        struct Via(std::rc::Rc<std::cell::RefCell<Recorder>>);
        impl Exec for Via {
            fn run(&mut self, program: &Path, args: &[&str]) -> io::Result<Output> {
                self.0.borrow_mut().run(program, args)
            }
        }
        let mut service = OldConnectorService::with(Box::new(Via(shared.clone())), env);
        let hook: &mut dyn mdbn_legacy::OldService = &mut service;
        let result = hook.stop_and_disable();
        let recorded = shared.borrow().calls.clone();
        (result, recorded)
    }

    #[test]
    fn absent_connector_is_a_no_op() {
        let f = fixture("legacy-absent");
        let (result, calls) = run(f.env.clone(), &[]);
        assert_eq!(result, Ok(()));
        // Only read-only queries ran: nothing was stopped, disabled or executed.
        assert!(
            calls.iter().all(|c| c.contains(" is-enabled ")
                || c.contains(" is-active ")
                || c.starts_with("launchctl print ")
                || c.starts_with("schtasks /Query ")),
            "{calls:?}"
        );
    }

    /// The platform's service manager, as this module probes it.
    const MANAGER: &str = if cfg!(target_os = "macos") {
        "launchctl"
    } else if cfg!(windows) {
        "schtasks"
    } else {
        "systemctl"
    };

    #[test]
    fn missing_service_manager_reads_as_not_registered() {
        // No manager installed, no connector binary: nothing to do, not a T1 failure.
        let f = fixture("legacy-no-manager");
        let (result, calls) = run_with(f.env.clone(), &[], &[MANAGER]);
        assert_eq!(result, Ok(()));
        assert!(calls.iter().all(|c| c.starts_with(MANAGER)), "{calls:?}");
        // With a connector binary present, the stop still goes through it.
        let binary = f.install_binary();
        let stop = format!(
            "{} connect daemon stop",
            binary.file_name().unwrap().to_string_lossy()
        );
        let (result, calls) = run_with(f.env.clone(), &[&stop], &[MANAGER]);
        assert_eq!(result, Ok(()));
        assert_eq!(calls.last().map(String::as_str), Some(stop.as_str()));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn missing_manager_with_a_registered_unit_is_an_error() {
        // The unit file says it is registered; a disable that cannot run must fail T1.
        let f = fixture("legacy-no-manager-unit");
        let unit = f.env.connector_unit().unwrap();
        std::fs::create_dir_all(unit.parent().unwrap()).unwrap();
        std::fs::write(&unit, "[Unit]\n").unwrap();
        let (result, calls) = run_with(f.env.clone(), &[], &["systemctl"]);
        assert!(result.unwrap_err().contains("disable"));
        assert!(calls.last().unwrap().contains("disable --now"), "{calls:?}");
    }

    #[test]
    fn state_dir_follows_the_connector_layout() {
        let mut env = fixture("legacy-layout").env;
        assert_eq!(env.connector_state_dir(), env.connect_home.clone());
        env.connect_home = None;
        let home = env.home.clone().unwrap();
        let expected = if cfg!(target_os = "macos") {
            home.join("Library/Application Support/dev.mdbase.connect")
        } else if cfg!(windows) {
            home.join("AppData")
                .join("Local")
                .join("mdbase")
                .join("connect")
                .join("data")
        } else {
            home.join(".local/share/connect")
        };
        assert_eq!(env.connector_state_dir(), Some(expected));
        assert_eq!(
            env.connector_launchd_target(),
            format!("gui/501/{CONNECTOR_LAUNCHD_LABEL}")
        );
    }

    #[test]
    fn unregistered_connector_with_a_binary_is_stopped_through_it() {
        let f = fixture("legacy-binary");
        let binary = f.install_binary();
        let stop = format!(
            "{} connect daemon stop",
            binary.file_name().unwrap().to_string_lossy()
        );
        let (result, calls) = run(f.env.clone(), &[&stop]);
        assert_eq!(result, Ok(()));
        assert_eq!(calls.last().map(String::as_str), Some(stop.as_str()));
        // And its failure is reported when it was the only means.
        let (result, _) = run(f.env.clone(), &[]);
        assert!(result.is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn registered_unit_is_disabled_now_and_the_binary_stop_failure_is_tolerated() {
        let f = fixture("legacy-systemd");
        let unit = f.env.connector_unit().unwrap();
        std::fs::create_dir_all(unit.parent().unwrap()).unwrap();
        std::fs::write(&unit, "[Unit]\n").unwrap();
        f.install_binary();
        let disable = format!("systemctl --user disable --now {CONNECTOR_SYSTEMD_UNIT}");
        let (result, calls) = run(f.env.clone(), &[&disable]);
        assert_eq!(result, Ok(()));
        assert!(calls.contains(&disable), "{calls:?}");
        assert!(
            calls
                .last()
                .unwrap()
                .ends_with("mdbase connect daemon stop")
        );
        // The manager refusing is an error.
        let (result, _) = run(f.env.clone(), &[]);
        assert!(result.unwrap_err().contains("disable"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn active_unit_without_a_unit_file_is_still_disabled() {
        let f = fixture("legacy-systemd-active");
        let active = format!("systemctl --user is-active {CONNECTOR_SYSTEMD_UNIT}");
        let disable = format!("systemctl --user disable --now {CONNECTOR_SYSTEMD_UNIT}");
        let (result, calls) = run(f.env.clone(), &[&active, &disable]);
        assert_eq!(result, Ok(()));
        assert_eq!(calls.last().map(String::as_str), Some(disable.as_str()));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn loaded_agent_is_booted_out_then_disabled() {
        let f = fixture("legacy-launchd");
        let target = f.env.connector_launchd_target();
        let print = format!("launchctl print {target}");
        let bootout = format!("launchctl bootout {target}");
        let disable = format!("launchctl disable {target}");
        let (result, calls) = run(f.env.clone(), &[&print, &bootout, &disable]);
        assert_eq!(result, Ok(()));
        assert_eq!(calls, vec![print, bootout, disable]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn unloaded_plist_is_disabled_without_bootout() {
        let f = fixture("legacy-launchd-plist");
        let plist = f.env.connector_plist().unwrap();
        std::fs::create_dir_all(plist.parent().unwrap()).unwrap();
        std::fs::write(&plist, "<plist/>").unwrap();
        let target = f.env.connector_launchd_target();
        let disable = format!("launchctl disable {target}");
        let (result, calls) = run(f.env.clone(), &[&disable]);
        assert_eq!(result, Ok(()));
        assert!(!calls.iter().any(|c| c.starts_with("launchctl bootout")));
        assert_eq!(calls.last().map(String::as_str), Some(disable.as_str()));
    }

    #[cfg(windows)]
    #[test]
    fn registered_task_is_ended_and_disabled() {
        let f = fixture("legacy-schtasks");
        let query = format!("schtasks /Query /TN {CONNECTOR_TASK_NAME}");
        let change = format!("schtasks /Change /TN {CONNECTOR_TASK_NAME} /DISABLE");
        let (result, calls) = run(f.env.clone(), &[&query, &change]);
        assert_eq!(result, Ok(()));
        assert_eq!(
            calls,
            vec![
                query,
                format!("schtasks /End /TN {CONNECTOR_TASK_NAME}"),
                change
            ]
        );
    }
}
