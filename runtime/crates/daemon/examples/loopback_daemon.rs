//! `mdbase daemon run` that may sign in to a loopback control plane (test tooling,
//! never shipped). `pnpm e2e` (`scripts/next-e2e.mjs`) runs it against a local
//! control plane and drives it with the real `mdbase` CLI.
//!
//! ```text
//! loopback_daemon <state-dir>
//! ```
//!
//! Shipped builds sign in only to their embedded control plane; the loopback hook
//! exists only in debug builds and only in process, so this is the same
//! `server::run` as `mdbase daemon run` with that one hook turned on.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::PathBuf;

use mdbn_daemon::paths::Profile;

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "warn".into()))
        .with_writer(std::io::stderr)
        .init();
    let state = PathBuf::from(std::env::args().nth(1).expect("usage: loopback_daemon <state-dir>"));
    mdbn_daemon::trust::allow_loopback_control_plane_for_tests();
    let profile = Profile::resolve(Some(&state)).expect("profile");
    mdbn_daemon::server::run(profile, None).await.expect("daemon");
}
