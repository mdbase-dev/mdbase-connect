//! The conformance suite against the in-memory reference (always), Postgres
//! (`MDBN_TEST_PG_URL`), and any running service (`MDBN_LOGSVC_URL`, e.g. a
//! `wrangler dev` Durable Object Worker; add `MDBN_LOGSVC_HOOKS=1` if it exposes
//! `/debug/*`).
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::PathBuf;

use mdbn_log_conformance::Target;
use mdbn_log_conformance::fixture::CP_LABEL;
use mdbn_log_conformance::suite::{report, run};
use mdbn_log_server::fs::FsObjects;
use mdbn_log_server::pg::PgBackend;
use mdbn_log_server::test_support::TestDeletionFloors;
use mdbn_log_server::{AnyService, Gateway, pg_listener, serve, testkit_config};
use mdbn_log_service::Service;
use mdbn_log_service::mem::{MemBackend, MemObjects};

async fn spawn(
    floors: std::sync::Arc<TestDeletionFloors>,
    svc: impl FnOnce(String) -> AnyService,
) -> (Target, std::sync::Arc<Gateway>) {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    let base = format!("http://{addr}");
    let gw = Gateway::new_with_test_deletion_floors(svc(base.clone()), floors);
    tokio::spawn(serve(gw.clone(), l));
    (
        Target {
            name: String::new(),
            ws: format!("ws://{addr}"),
            http: base,
            debug_hooks: true,
        },
        gw,
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn memory_backend() {
    let floors = std::sync::Arc::new(TestDeletionFloors::default());
    let (mut t, _) = spawn(floors, |base| {
        AnyService::Mem(Service::new(
            MemBackend::default(),
            MemObjects::default(),
            testkit_config(CP_LABEL, &base),
        ))
    })
    .await;
    t.name = "memory".into();
    let filter = std::env::var("MDBN_LOGSVC_FILTER").ok();
    assert!(report(&t, &run(&t, filter.as_deref()).await));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn postgres_backend() {
    let Ok(url) =
        std::env::var("MDBN_TEST_PG_URL").or_else(|_| std::env::var("MDBN_LOGSVC_PG_URL"))
    else {
        eprintln!("MDBN_TEST_PG_URL not set: skipping the Postgres run");
        return;
    };
    let floors = std::sync::Arc::new(TestDeletionFloors::default());
    let be = PgBackend::connect(&url, 32)
        .await
        .expect("postgres")
        .with_independent_floor_reader(floors.clone());
    // Pulled test binaries must not use the remote builder's embedded source path.
    let dir = std::env::var_os("MDBN_LOGSVC_TEST_OBJECTS")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target/logsvc-test-objects"));
    let (mut t, gw) = spawn(floors, |base| {
        AnyService::Pg(Service::new(
            be,
            FsObjects::new(dir),
            testkit_config(CP_LABEL, &base),
        ))
    })
    .await;
    tokio::spawn(pg_listener(gw, url));
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    t.name = "postgres".into();
    let filter = std::env::var("MDBN_LOGSVC_FILTER").ok();
    assert!(report(&t, &run(&t, filter.as_deref()).await));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn external_service() {
    let Ok(url) = std::env::var("MDBN_LOGSVC_URL") else {
        eprintln!("MDBN_LOGSVC_URL not set: skipping the external run");
        return;
    };
    let ws = url.replacen("http", "ws", 1);
    let t = Target {
        name: url.clone(),
        ws,
        http: url,
        debug_hooks: std::env::var("MDBN_LOGSVC_HOOKS").is_ok(),
    };
    let filter = std::env::var("MDBN_LOGSVC_FILTER").ok();
    assert!(report(&t, &run(&t, filter.as_deref()).await));
}
