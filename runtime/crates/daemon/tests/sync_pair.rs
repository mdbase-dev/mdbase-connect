//! The sync_pair scenario in CI: two desktop runtimes and a hosted-kind runtime
//! converge on one cloud-copy collection through an in-process, in-memory log
//! service (the real `mdbn-log-service` behind the real `mdbn-log-server`
//! transport, pinned to the deterministic `conformance` test control plane, on
//! loopback). Test tooling only.
//!
//! The genesis enrols HOSTED and ESCROW service devices, but only the hosted
//! runtime runs: every desktop key arrives as a HOSTED `key_grant` accepted by
//! the log service (the log once refused it with
//! `Forbidden`/`role`), so A -> B convergence proves that grant path.
#![cfg(unix)]
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::PathBuf;

#[path = "fixtures/sync_pair.rs"]
mod scenario;

fn scratch(tag: &str) -> PathBuf {
    // Under target/, never /tmp.
    let p = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("{tag}{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_desktops_and_hosted_converge_through_the_log_service() {
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
    let server = tokio::spawn(mdbn_log_server::serve(gateway, listener));
    let dir = scratch("sp");
    scenario::run(&base, &dir, 600_000).await;
    server.abort();
    let _ = std::fs::remove_dir_all(&dir);
}
