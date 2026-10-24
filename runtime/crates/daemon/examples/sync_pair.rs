//! Two daemon runtimes and a hosted-kind runtime converging on one cloud-copy
//! collection through a real log service (test tooling, never shipped).
//!
//! ```text
//! logsvc --listen 127.0.0.1:7700 --testkit-cp conformance --insecure-test-keys &
//! sync_pair --log http://127.0.0.1:7700 --dir <scratch>
//! ```
//!
//! The log service pins the deterministic `conformance` test control plane, so the
//! genesis and the device tokens here are test-only; loopback only. Hosted is played
//! by a third runtime whose policy kind is `hosted`: the same replica code as the
//! hosted Worker's engine. It is the first keyed replica, and as the first keyed
//! replica it wraps the epoch to the two desktops.
//!
//! Checks: both desktops keyed by hosted; a write on A appears on B and back;
//! edits made while B is stopped converge after it restarts; concurrent edits of one
//! file converge to the same confirmed records on every replica (compared by digest),
//! with the conflict recorded; a binary attachment dropped on A is uploaded,
//! fetched and placed byte-identical on B, then renamed and deleted there. On disk, the losing device's edit is held, not
//! overwritten, so the two folders differ there by design.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::PathBuf;

#[path = "../tests/fixtures/sync_pair.rs"]
mod scenario;

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "warn".into()))
        .init();
    let log = arg("--log").unwrap_or_else(|| "http://127.0.0.1:7700".into());
    let dir = PathBuf::from(arg("--dir").expect("--dir"));
    let attach_bytes = arg("--attach-bytes")
        .map(|v| v.parse().expect("--attach-bytes"))
        .unwrap_or(600_000);
    scenario::run(&log, &dir, attach_bytes).await;
}
