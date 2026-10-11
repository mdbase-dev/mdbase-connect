//! Adopt in CI: a folder with files becomes a synced collection's generation 0
//! with the record IDs it already had, without rewriting a byte, and a second
//! replica sees the same records and bytes. Private (the adopting device keys
//! itself) and cloud copy (service keying, a second desktop joins), through an
//! in-process, in-memory log service on loopback. Test tooling only.
#![cfg(unix)]
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::PathBuf;

#[path = "fixtures/adopt.rs"]
mod scenario;

fn scratch(tag: &str) -> PathBuf {
    // Under target/, never /tmp.
    let p = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("{tag}{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

async fn log_service() -> (String, tokio::task::JoinHandle<()>) {
    use mdbn_log_server::{AnyService, Gateway};
    use mdbn_log_service::Service;
    use mdbn_log_service::mem::{MemBackend, MemObjects};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let gateway = Gateway::new(
        AnyService::Mem(Service::new(
            MemBackend::default(),
            MemObjects::default(),
            mdbn_log_server::testkit_config("conformance", &base),
        )),
        false,
    );
    let server = tokio::spawn(async move {
        let _ = mdbn_log_server::serve(gateway, listener).await;
    });
    (base, server)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_folder_with_files_is_adopted_privately_and_rejoined() {
    let (log, server) = log_service().await;
    let dir = scratch("adopt-private");
    scenario::run(&log, &dir, 40, true).await;
    server.abort();
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_folder_with_files_is_adopted_as_a_cloud_copy_and_joined() {
    let (log, server) = log_service().await;
    let dir = scratch("adopt-cloud");
    scenario::run(&log, &dir, 40, false).await;
    server.abort();
    let _ = std::fs::remove_dir_all(&dir);
}
