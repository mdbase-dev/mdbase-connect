//! MEASUREMENT fixture for issue 1648 (test tooling, never shipped): an
//! in-memory log service on loopback holding one cloud-copy collection of
//! `--creates` notes (then `--updates` rewrites), and the identity of an
//! enrolled app-runtime device that has never opened it. Serves until killed.
//!
//! ```text
//! replay_fixture --listen 127.0.0.1:7801 --dir <scratch> --creates 1000 --out fixture.json
//! ```
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
    use mdbn_log_server::{AnyService, Gateway};
    use mdbn_log_service::Service;
    use mdbn_log_service::mem::{MemBackend, MemObjects};
    let listen = arg("--listen").unwrap_or_else(|| "127.0.0.1:0".into());
    let dir = PathBuf::from(arg("--dir").expect("--dir"));
    let out = PathBuf::from(arg("--out").expect("--out"));
    let creates: usize = arg("--creates").expect("--creates").parse().unwrap();
    let updates: usize = arg("--updates").map_or(0, |v| v.parse().unwrap());
    let listener = tokio::net::TcpListener::bind(&listen).await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let gateway = Gateway::new(
        AnyService::Mem(Service::new(
            MemBackend::default(),
            MemObjects::default(),
            mdbn_log_server::testkit_config("conformance", &base),
        )),
        false,
    );
    let server = tokio::spawn(mdbn_log_server::serve(gateway, listener));
    scenario::run_replay_fixture(&base, &dir, creates, updates, &out).await;
    server.await.unwrap().unwrap();
}
