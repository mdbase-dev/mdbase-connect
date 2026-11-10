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
use crate::control::{
    AddCollection, Check, CollectionStatus, ConflictSummary, ControlError, DaemonStatus,
    HoldSummary, Method, PendingDevice,
};
use crate::paths::Profile;
use crate::registry::SyncMode;
use crate::server::{self, RunError};

#[cfg(test)]
#[path = "cli_delete_tests.rs"]
mod collection_delete_tests;

mod access;
mod args;
mod commands;
mod daemon;
mod output;
mod private_commands;
mod requests;
mod system;

use access::*;
use args::*;
use commands::*;
use daemon::*;
use output::*;
use private_commands::*;
use requests::*;
use system::*;

pub(crate) use requests::{collections, pick};

/// How long `daemon start` waits for readiness.
pub const START_TIMEOUT: Duration = Duration::from_secs(20);

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
    let out = Output {
        json: cli.json,
        yes: cli.yes,
    };
    rt.block_on(dispatch(cli.command, &profile, &out))
}
