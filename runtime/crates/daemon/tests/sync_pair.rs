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
    scenario::run_modes(&base, &dir.join("modes")).await;
    server.abort();
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_second_computer_opens_a_private_collection_after_one_allow() {
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
    let dir = scratch("pp");
    scenario::run_private_approval(&base, &dir).await;
    server.abort();
    let _ = std::fs::remove_dir_all(&dir);
}

/// Forward loopback connections from `listener` to `upstream`, at most `rate`
/// bytes per second in each direction of each connection: a slow link.
async fn throttle(listener: tokio::net::TcpListener, upstream: std::net::SocketAddr, rate: f64) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    async fn pipe(
        mut from: tokio::net::tcp::OwnedReadHalf,
        mut to: tokio::net::tcp::OwnedWriteHalf,
        rate: f64,
    ) {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            let n = match from.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            tokio::time::sleep(std::time::Duration::from_secs_f64(n as f64 / rate)).await;
            if to.write_all(&buf[..n]).await.is_err() {
                break;
            }
        }
        let _ = to.shutdown().await;
    }
    while let Ok((client, _)) = listener.accept().await {
        let Ok(server) = tokio::net::TcpStream::connect(upstream).await else {
            continue;
        };
        let _ = (client.set_nodelay(true), server.set_nodelay(true));
        let (cr, cw) = client.into_split();
        let (sr, sw) = server.into_split();
        tokio::spawn(pipe(cr, sw, rate));
        tokio::spawn(pipe(sr, cw, rate));
    }
}

/// #1122: no `ready` while a large file is still crossing between computers.
/// Every byte, including the staged transfer URLs (`public_base`), goes through
/// a throttled proxy so the transfer is observably in flight on both sides.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ready_is_never_reported_while_a_large_transfer_is_in_flight() {
    use mdbn_log_server::{AnyService, Gateway};
    use mdbn_log_service::Service;
    use mdbn_log_service::mem::{MemBackend, MemObjects};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = listener.local_addr().unwrap();
    let front = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", front.local_addr().unwrap());
    let gateway = Gateway::new(
        AnyService::Mem(Service::new(
            MemBackend::default(),
            MemObjects::default(),
            mdbn_log_server::testkit_config("conformance", &base),
        )),
        false,
    );
    let server = tokio::spawn(mdbn_log_server::serve(gateway, listener));
    let proxy = tokio::spawn(throttle(front, upstream, 2.0 * 1024.0 * 1024.0));
    let dir = scratch("rt");
    scenario::run_ready_waits_for_transfers(&base, &dir, 6 * 1024 * 1024).await;
    proxy.abort();
    server.abort();
    let _ = std::fs::remove_dir_all(&dir);
}
