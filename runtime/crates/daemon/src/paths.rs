//! Where the daemon keeps its state and listens.
//!
//! A **profile** is one state directory with its endpoints. There is one default
//! profile per OS user (the installed service). `--state-dir` or `MDBASE_HOME`
//! selects an **isolated profile** instead: tests, LAB and debugging. An isolated
//! profile never controls the default service, and vice versa.
//!
//! | | state directory | control endpoint | replica endpoint |
//! |---|---|---|---|
//! | Linux | `~/.local/state/mdbase` | `$XDG_RUNTIME_DIR/mdbase/control.sock` | `$XDG_RUNTIME_DIR/mdbase/replica.sock` |
//! | macOS | `~/Library/Application Support/mdbase` | `<state>/control.sock` | `<state>/replica.sock` |
//! | Windows | `%LOCALAPPDATA%\mdbase\state` | `\\.\pipe\mdbase-control-<SID>` | `\\.\pipe\mdbase-replica-<SID>` |
//! | isolated | the given directory | `<state>/run/control.sock`, or a pipe suffixed with a hash of the directory | likewise |
//!
//! The replica endpoints follow `replica-client-api.md` §12.2. Without
//! `XDG_RUNTIME_DIR`, Linux uses `<state>/run`. The Linux state directory ignores
//! `XDG_STATE_HOME` on purpose: every client (the SDK, Obsidian, the desktop) must
//! find `daemon.json` at one fixed place, whatever environment it was started in.
//!
//! The daemon's identity (`daemon.json`) is always in the state
//! directory: `~/.local/state/mdbase/daemon.json`,
//! `~/Library/Application Support/mdbase/daemon.json`,
//! `%LOCALAPPDATA%\mdbase\state\daemon.json`, or `<dir>/daemon.json` for an
//! isolated profile. None of these collide with today's
//! connector (`ProjectDirs("dev", "mdbase", "connect")`, `agent.sock`), so the
//! old daemon and the new one can run side by side during migration.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Environment variable selecting an isolated profile.
pub const ENV_HOME: &str = "MDBASE_HOME";

/// Which daemon a command targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Target {
    /// The default per-user profile (the installed service).
    InstalledService,
    /// A profile chosen with `--state-dir` or `MDBASE_HOME`.
    IsolatedProfile,
}

/// A local endpoint: a Unix domain socket path or a Windows named pipe name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "path")]
pub enum Endpoint {
    /// Unix domain socket.
    Unix(PathBuf),
    /// Windows named pipe (`\\.\pipe\...`).
    Pipe(String),
}

impl std::fmt::Display for Endpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Endpoint::Unix(p) => write!(f, "{}", p.display()),
            Endpoint::Pipe(n) => f.write_str(n),
        }
    }
}

/// A resolved profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    /// Installed service or isolated profile.
    pub target: Target,
    /// Owner-only state directory.
    pub state_dir: PathBuf,
    /// The control endpoint (CLI and desktop).
    pub control: Endpoint,
    /// The replica client API endpoint (apps).
    pub replica: Endpoint,
}

/// Why a profile could not be resolved.
#[derive(Debug)]
pub struct PathError(pub String);

impl std::fmt::Display for PathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PathError {}

impl Profile {
    /// Resolve the profile: an explicit `--state-dir`, else `MDBASE_HOME`, else the
    /// default for this user.
    pub fn resolve(state_dir: Option<&Path>) -> Result<Profile, PathError> {
        let explicit = state_dir.map(Path::to_path_buf).or_else(|| {
            std::env::var_os(ENV_HOME)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        });
        match explicit {
            Some(dir) => Profile::isolated(&absolute(&dir)?),
            None => Profile::installed(),
        }
    }

    /// An isolated profile rooted at `dir` (absolute).
    pub fn isolated(dir: &Path) -> Result<Profile, PathError> {
        let state_dir = dir.to_path_buf();
        let (control, replica) = if cfg!(windows) {
            let suffix = profile_hash(&state_dir);
            let sid = user_sid()?;
            (
                Endpoint::Pipe(format!(r"\\.\pipe\mdbase-control-{sid}-{suffix}")),
                Endpoint::Pipe(format!(r"\\.\pipe\mdbase-replica-{sid}-{suffix}")),
            )
        } else {
            let run = state_dir.join("run");
            (
                Endpoint::Unix(run.join("control.sock")),
                Endpoint::Unix(run.join("replica.sock")),
            )
        };
        Ok(Profile {
            target: Target::IsolatedProfile,
            state_dir,
            control,
            replica,
        })
    }

    /// The default profile for this OS user.
    pub fn installed() -> Result<Profile, PathError> {
        let (state_dir, control, replica) = default_locations()?;
        Ok(Profile {
            target: Target::InstalledService,
            state_dir,
            control,
            replica,
        })
    }

    /// The single-instance lock file.
    pub fn lock_file(&self) -> PathBuf {
        self.state_dir.join("daemon.lock")
    }

    /// The collection registry.
    pub fn registry_file(&self) -> PathBuf {
        self.state_dir.join("collections.json")
    }

    /// The daemon identity file (`daemon.json`): the device ID and public keys,
    /// including the Noise key local clients pin. It lives in the
    /// owner-only state directory, never beside the socket or derived from the pipe
    /// name, and clients verify ownership and permissions before trusting it
    /// ([`crate::secrets::read_daemon_identity`]).
    pub fn identity_file(&self) -> PathBuf {
        self.state_dir.join("daemon.json")
    }

    /// Non-secret account state ([`crate::cloud::CloudConfig`]).
    pub fn cloud_file(&self) -> PathBuf {
        self.state_dir.join("cloud.json")
    }

    /// Durable account epoch/publication fence.
    pub fn account_file(&self) -> PathBuf {
        self.state_dir.join("account.json")
    }

    /// Store IDs issued to the takeover ([`crate::registry::StoreIds`]).
    pub fn store_ids_file(&self) -> PathBuf {
        self.state_dir.join("store-ids.json")
    }

    /// The localhost link file for the Obsidian runtime ([`crate::link`]).
    pub fn local_link_file(&self) -> PathBuf {
        self.state_dir.join("local-link.json")
    }

    /// The local access list ([`crate::access`]).
    pub fn access_file(&self) -> PathBuf {
        self.state_dir.join("access.json")
    }

    /// The log directory.
    pub fn log_dir(&self) -> PathBuf {
        self.state_dir.join("logs")
    }

    /// The daemon's log file.
    pub fn log_file(&self) -> PathBuf {
        self.log_dir().join("daemon.log")
    }

    /// Per-collection private state (index, journal, record IDs).
    pub fn collection_dir(&self, collection: &str) -> PathBuf {
        self.state_dir.join("collections").join(collection)
    }

    /// The keychain namespace for this profile's secrets: the installed service
    /// uses `default`; an isolated profile uses a hash of its directory, so tests
    /// never touch the user's real device identity.
    pub fn secret_namespace(&self) -> String {
        match self.target {
            Target::InstalledService => "default".to_string(),
            Target::IsolatedProfile => profile_hash(&self.state_dir),
        }
    }
}

fn absolute(p: &Path) -> Result<PathBuf, PathError> {
    std::path::absolute(p).map_err(|e| PathError(format!("cannot resolve {}: {e}", p.display())))
}

/// First 12 hex digits of SHA-256 of the state directory path.
fn profile_hash(dir: &Path) -> String {
    let digest = Sha256::digest(dir.to_string_lossy().as_bytes());
    digest[..6].iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(target_os = "linux")]
fn default_locations() -> Result<(PathBuf, Endpoint, Endpoint), PathError> {
    let home = home()?;
    let state = home.join(".local").join("state").join("mdbase");
    let run = env_dir("XDG_RUNTIME_DIR")
        .map(|r| r.join("mdbase"))
        .unwrap_or_else(|| state.join("run"));
    Ok((
        state,
        Endpoint::Unix(run.join("control.sock")),
        Endpoint::Unix(run.join("replica.sock")),
    ))
}

#[cfg(target_os = "macos")]
fn default_locations() -> Result<(PathBuf, Endpoint, Endpoint), PathError> {
    let state = home()?
        .join("Library")
        .join("Application Support")
        .join("mdbase");
    Ok((
        state.clone(),
        Endpoint::Unix(state.join("control.sock")),
        Endpoint::Unix(state.join("replica.sock")),
    ))
}

#[cfg(windows)]
fn default_locations() -> Result<(PathBuf, Endpoint, Endpoint), PathError> {
    let base =
        env_dir("LOCALAPPDATA").ok_or_else(|| PathError("LOCALAPPDATA is not set".to_string()))?;
    let sid = user_sid()?;
    Ok((
        base.join("mdbase").join("state"),
        Endpoint::Pipe(format!(r"\\.\pipe\mdbase-control-{sid}")),
        Endpoint::Pipe(format!(r"\\.\pipe\mdbase-replica-{sid}")),
    ))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn default_locations() -> Result<(PathBuf, Endpoint, Endpoint), PathError> {
    let state = home()?.join(".mdbase");
    Ok((
        state.clone(),
        Endpoint::Unix(state.join("run").join("control.sock")),
        Endpoint::Unix(state.join("run").join("replica.sock")),
    ))
}

#[cfg(unix)]
fn home() -> Result<PathBuf, PathError> {
    env_dir("HOME").ok_or_else(|| PathError("HOME is not set".to_string()))
}

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

/// The current user's SID as a string (`S-1-5-21-...`).
#[cfg(windows)]
pub fn user_sid() -> Result<String, PathError> {
    crate::ipc::windows::current_user_sid().map_err(|e| PathError(format!("user SID: {e}")))
}

/// Not used on Unix.
#[cfg(not(windows))]
pub fn user_sid() -> Result<String, PathError> {
    Err(PathError("user SIDs exist only on Windows".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn isolated_profile_keeps_everything_under_its_directory() {
        let p = Profile::isolated(Path::new("/srv/x")).unwrap();
        assert_eq!(p.target, Target::IsolatedProfile);
        assert_eq!(p.control, Endpoint::Unix("/srv/x/run/control.sock".into()));
        assert_eq!(p.replica, Endpoint::Unix("/srv/x/run/replica.sock".into()));
        assert_eq!(p.registry_file(), PathBuf::from("/srv/x/collections.json"));
        assert_ne!(p.secret_namespace(), "default");
        assert_eq!(p.secret_namespace().len(), 12);
    }

    #[test]
    fn identity_file_is_never_derived_from_an_endpoint() {
        // the identity lives in the owner-only state directory, never in
        // the pipe namespace or beside a socket.
        let p = Profile::installed().unwrap();
        let ident = p.identity_file();
        assert!(ident.starts_with(&p.state_dir));
        assert!(!ident.to_string_lossy().starts_with(r"\\.\pipe"));
    }

    #[test]
    fn profile_hash_is_stable() {
        assert_eq!(profile_hash(Path::new("/a")), profile_hash(Path::new("/a")));
        assert_ne!(profile_hash(Path::new("/a")), profile_hash(Path::new("/b")));
    }
}
