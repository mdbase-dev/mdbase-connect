//! The command-line grammar: the global flags and every command and subcommand.

use super::*;

/// The data commands' examples, after the command list.
const DATA_HELP: &str = "\
Records: `read`, `query`, `validate`, `types` and the writes work on the folder
you are in, another with `-C PATH`, or a registered collection with `-c NAME`.
When the daemon serves the folder they go through it; otherwise mdbase opens
the folder itself.

  mdbase query --types task --where 'status == \"open\"' --order-by -due
  mdbase read tasks/review.md --json
  mdbase update tasks/review.md --fields '{\"status\": \"done\"}'
  mdbase rename tasks/review.md done/review.md
  mdbase validate -c notes";

#[derive(Debug, Parser)]
#[command(
    name = "mdbase",
    version = crate::BINARY_VERSION,
    about = "mdbase: your Markdown collections, synced.",
    after_help = DATA_HELP
)]
pub(super) struct Cli {
    /// Use an isolated profile in this directory instead of the installed service
    /// (also `MDBASE_HOME`).
    #[arg(long, global = true, value_name = "DIR")]
    pub(super) state_dir: Option<PathBuf>,
    /// Print machine-readable JSON.
    #[arg(long, global = true)]
    pub(super) json: bool,
    /// Skip this command's own terminal prompt (for apps that confirmed first). The
    /// daemon's on-screen confirmation still applies.
    #[arg(long, global = true)]
    pub(super) yes: bool,
    #[command(subcommand)]
    pub(super) command: Command,
}

#[derive(Debug, Subcommand)]
pub(super) enum ConflictCmd {
    /// Accept the merge result; clear its conflicts without changing files.
    Dismiss {
        /// Record or file ID, or a unique ID prefix (from `conflicts`).
        id: String,
        /// Collection ID, prefix or name; optional with one registered collection.
        collection: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
pub(super) enum Command {
    /// Daemon and collection overview.
    Status,
    /// Manage the background daemon.
    #[command(subcommand)]
    Daemon(DaemonCmd),
    /// Register folders and manage local and synced collections.
    #[command(subcommand)]
    Collection(CollectionCmd),
    /// What changed on this computer recently (collections, app access, account).
    Activity {
        /// How many entries, newest first.
        #[arg(long, default_value_t = 20)]
        limit: u64,
    },
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
    /// Changes mdbase merged where one side's value was kept over the other's.
    Conflicts {
        /// Collection ID, ID prefix or name (for listing).
        collection: Option<String>,
        #[command(subcommand)]
        command: Option<ConflictCmd>,
    },
    /// Turn sync on or off (moves the collection's log).
    #[command(subcommand)]
    Sync(SyncCmd),
    /// Let another computer of yours open a private collection.
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
    /// Records: reads, queries, validation, types and writes.
    #[command(flatten)]
    Data(crate::data::DataCmd),
}

#[derive(Debug, Subcommand)]
pub(super) enum DaemonCmd {
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
pub(super) enum CollectionCmd {
    /// List registered collections.
    List,
    /// Register a folder as a local collection.
    Add {
        /// Folder.
        path: PathBuf,
        /// Display name (default: the folder name).
        #[arg(long)]
        name: Option<String>,
        /// Remove an `x-mdbase-connect` identity from the folder's mdbase.yaml that
        /// no mdbase Connect on this computer manages (a copied or removed folder).
        #[arg(long)]
        remove_legacy_identity: bool,
    },
    /// Join one of your account's collections into an empty folder on this computer.
    Join {
        /// The collection's ID (from another of your devices or the web).
        collection: String,
        /// An empty folder (hidden entries such as `.obsidian` may stay).
        path: PathBuf,
        /// Display name (default: the folder name).
        #[arg(long)]
        name: Option<String>,
        /// A private (end-to-end) collection: this computer shows a code to
        /// approve from another of your devices (`mdbase device approve`).
        #[arg(long)]
        private: bool,
    },
    /// Unregister a local folder. Does not delete the synced collection or files.
    Remove {
        /// Collection ID, ID prefix or name.
        collection: String,
    },
    /// Permanently delete a synced collection from your account. Local files and
    /// registration are kept; use `remove` separately to unregister the folder.
    Delete {
        /// Registered name, ID prefix, or full synced collection ID.
        collection: String,
        /// Type the collection's current shared name to confirm deletion.
        #[arg(long, value_name = "NAME")]
        confirm: String,
    },
    /// Rename a collection or change its description. Files are untouched.
    Update {
        /// Collection ID, ID prefix or name.
        collection: String,
        /// New display name.
        #[arg(long)]
        name: Option<String>,
        /// New description (an empty string clears it).
        #[arg(long)]
        description: Option<String>,
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
pub(super) enum SyncKind {
    /// End-to-end encrypted: mdbase cannot read it; web apps work only while one
    /// of your devices is online.
    #[value(alias = "e2e")]
    Private,
    /// With a cloud copy web apps and agents can use while your devices are off.
    #[value(alias = "synced")]
    CloudCopy,
}

#[derive(Debug, Subcommand)]
pub(super) enum SyncCmd {
    /// Move the log to mdbase's hosted log service.
    Enable {
        /// Collection ID, ID prefix or name.
        collection: String,
        /// `private` or `cloud-copy`. Default: `cloud-copy`, or `private` for a
        /// collection taken over from today's connector.
        #[arg(long, value_enum)]
        mode: Option<SyncKind>,
        /// Turn sync on although files are still held from the takeover, keeping
        /// this computer's version of each (review them first with `mdbase holds`).
        #[arg(long)]
        accept_takeover_holds: bool,
    },
    /// Switch an already synced collection; explicit source consent is required.
    Mode {
        /// Collection ID, ID prefix or name.
        collection: String,
        #[arg(value_enum)]
        mode: SyncKind,
        /// Advance existing local consent without asking to create new consent.
        #[arg(long)]
        resume: bool,
        /// Cancel only if no switch policy can have been published.
        #[arg(long, conflicts_with = "resume")]
        cancel: bool,
    },
    /// Current collection-mode request and progress.
    ModeStatus { collection: String },
    /// Show which files the collection syncs, or replace that choice with `--set`
    /// for every device. Files already synced stay where they are.
    Files {
        /// Collection ID, ID prefix or name.
        collection: String,
        /// Replace the policy; options left out mean everything syncs.
        #[arg(long)]
        set: bool,
        /// File types that sync: image, audio, video, pdf, other; empty for notes
        /// only. Default: all.
        #[arg(long, value_delimiter = ',', requires = "set")]
        types: Option<Vec<String>>,
        /// A folder to leave out (repeatable).
        #[arg(long, requires = "set")]
        exclude: Vec<String>,
        /// Leave out files larger than this many bytes.
        #[arg(long, requires = "set")]
        max_size: Option<u64>,
    },
    /// Move the log back to this device (local only).
    Disable {
        /// Collection ID, ID prefix or name.
        collection: String,
    },
}

#[derive(Debug, Subcommand)]
pub(super) enum MigrateCmd {
    /// Takeover progress per collection (works with the daemon stopped).
    Status,
    /// Explicitly run or resume takeover once Connect allows it for this account.
    Start {
        /// Proceed past old hosted mirror folders once their upload queues are
        /// empty; they stop syncing until they join the migrated collection.
        #[arg(long)]
        stop_mirrors: bool,
    },
}

#[derive(Debug, Subcommand)]
pub(super) enum AccountCmd {
    /// Sign in: approve this computer in your browser.
    SignIn {
        /// Server: only this build's environment (production builds:
        /// https://connect.mdbase.dev; staging builds:
        /// https://connect-staging.mdbase.dev; LAB builds:
        /// https://connect-lab.mdbase.dev), which is also the default.
        #[arg(long)]
        server: Option<String>,
    },
    /// Sign out: apps stop reaching your local collections through this computer.
    SignOut,
    /// Rename this computer in your account.
    Rename {
        /// New name (1 to 100 characters).
        name: String,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub(super) enum OnOff {
    On,
    Off,
}

#[derive(Debug, Subcommand)]
pub(super) enum AccessCmd {
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
pub(super) enum DeviceCmd {
    /// Other computers waiting to open a private collection here.
    Pending {
        /// Only this collection (ID, ID prefix or name).
        collection: Option<String>,
    },
    /// Let a waiting computer open the collection after visually checking its code.
    Approve {
        /// Device ID, or a unique prefix, from `mdbase device pending`.
        device: String,
        /// Only this collection (ID, ID prefix or name).
        collection: Option<String>,
        /// Internal desktop bridge: the code already shown at the Allow decision.
        #[arg(long, hide = true)]
        checked_code: Option<String>,
    },
    /// Do not let a waiting computer open the collection.
    #[command(alias = "reject")]
    Deny {
        /// Device ID, or a unique prefix, from `mdbase device pending`.
        device: String,
        /// Only this collection (ID, ID prefix or name).
        collection: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
pub(super) enum PrivateCmd {
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
pub(super) enum RecoveryCmd {
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

#[cfg(test)]
mod takeover_cli_tests {
    use super::*;

    #[test]
    fn sync_parses_enable_and_disable() {
        assert!(Cli::try_parse_from(["mdbase", "sync", "enable", "Notes"]).is_ok());
        assert!(Cli::try_parse_from(["mdbase", "sync", "disable", "Notes"]).is_ok());
    }

    #[test]
    fn conflicts_list_and_dismiss_syntax() {
        assert!(matches!(
            Cli::try_parse_from(["mdbase", "conflicts", "Notes"]).unwrap().command,
            Command::Conflicts { collection: Some(c), command: None } if c == "Notes"
        ));
        for args in [
            vec!["mdbase", "conflicts", "dismiss", "9090"],
            vec!["mdbase", "conflicts", "dismiss", "9090", "Notes"],
        ] {
            assert!(matches!(
                Cli::try_parse_from(args).unwrap().command,
                Command::Conflicts { command: Some(ConflictCmd::Dismiss { id, .. }), .. } if id == "9090"
            ));
        }
        assert!(Cli::try_parse_from(["mdbase", "conflicts", "dismiss"]).is_err());
    }

    #[test]
    fn migrate_start_has_no_rollout_override() {
        assert!(Cli::try_parse_from(["mdbase", "migrate", "start"]).is_ok());
        assert!(Cli::try_parse_from(["mdbase", "migrate", "start", "--ignore-rollout"]).is_err());
    }
}
