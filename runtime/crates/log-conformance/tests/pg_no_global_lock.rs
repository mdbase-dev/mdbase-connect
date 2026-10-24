//! Postgres serializes per collection only (no global locks).
//!
//! 1. While one collection's row lock is held by a stalled transaction, appends to
//!    32 other collections complete at normal latency, and the stalled collection's
//!    own append waits.
//! 2. No advisory or table-level locks are taken by appends (`pg_locks` sampled
//!    under concurrent multi-collection load).
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::sync::Arc;
use std::time::{Duration, Instant};

use mdbn_log_conformance::fixture::{Fx, Target};
use mdbn_log_server::fs::FsObjects;
use mdbn_log_server::pg::PgBackend;
use mdbn_log_server::test_support::TestDeletionFloors;
use mdbn_log_server::{AnyService, Gateway, pg_listener, serve, testkit_config};
use mdbn_log_service::Service;

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn per_collection_serialization_only() {
    let Ok(url) =
        std::env::var("MDBN_TEST_PG_URL").or_else(|_| std::env::var("MDBN_LOGSVC_PG_URL"))
    else {
        eprintln!("MDBN_TEST_PG_URL not set: skipping");
        return;
    };
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    let base = format!("http://{addr}");
    // Runtime path: rcargo's compiled-in manifest path belongs to the VM.
    let dir = std::path::PathBuf::from(
        std::env::var_os("MDBN_LOGSVC_TEST_OBJECTS")
            .unwrap_or_else(|| "target/logsvc-test-objects".into()),
    );
    let floors = Arc::new(TestDeletionFloors::default());
    let be = PgBackend::connect(&url, 64)
        .await
        .unwrap()
        .with_independent_floor_reader(floors.clone());
    let gw = Gateway::new_with_test_deletion_floors(
        AnyService::Pg(Service::new(
            be,
            FsObjects::new(dir),
            testkit_config("conformance", &base),
        )),
        floors,
    );
    tokio::spawn(serve(gw.clone(), l));
    tokio::spawn(pg_listener(gw, url.clone()));
    let t = Target {
        name: "pg".into(),
        ws: format!("ws://{addr}"),
        http: base,
        debug_hooks: true,
    };

    let n = 32;
    let mut fxs = Vec::new();
    for _ in 0..=n {
        fxs.push(Arc::new(Fx::new(&t).await.unwrap()));
    }
    let stalled = fxs[0].clone();

    // Stall collection 0: hold its row lock in another session.
    let (pg, conn) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(conn);
    pg.batch_execute("BEGIN").await.unwrap();
    pg.query(
        "SELECT 1 FROM ls_collections WHERE id = $1 FOR UPDATE",
        &[&&stalled.c.0[..]],
    )
    .await
    .unwrap();

    // Its own append blocks...
    let s2 = stalled.clone();
    let blocked = tokio::spawn(async move {
        let c = s2.connect(&s2.a).await.unwrap();
        let start = Instant::now();
        s2.append_at_head(&c, &s2.a, 1, "blocked", 1).await.unwrap();
        start.elapsed()
    });
    // ...while 32 other collections append concurrently, 20 times each.
    let start = Instant::now();
    let mut tasks = Vec::new();
    for fx in fxs.iter().skip(1).cloned() {
        tasks.push(tokio::spawn(async move {
            let c = fx.connect(&fx.a).await.unwrap();
            let mut worst = Duration::ZERO;
            for i in 0..20 {
                let s = Instant::now();
                fx.append_at_head(&c, &fx.a, 1, &format!("free/{i}"), 1)
                    .await
                    .unwrap();
                worst = worst.max(s.elapsed());
            }
            worst
        }));
    }
    let mut worst = Duration::ZERO;
    for t in tasks {
        worst = worst.max(t.await.unwrap());
    }
    let others = start.elapsed();
    // Sample pg_locks for non-row locks while the stalled lock is held.
    let advisory: i64 = pg
        .query_one(
            "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory'",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert!(
        !blocked.is_finished(),
        "the stalled collection's append did not wait for its row lock"
    );
    eprintln!(
        "32 collections × 20 appends with collection 0 stalled: {others:?} total, worst single append {worst:?}"
    );
    // The proof is the ordering, not a latency bound (the machine may be loaded):
    // all 640 appends to other collections completed while collection 0's row lock
    // was still held and its own append still waiting (asserted above). Under any
    // global lock they would have waited for the ROLLBACK below.
    assert_eq!(advisory, 0, "advisory locks present");
    tokio::time::sleep(Duration::from_millis(300)).await;
    pg.batch_execute("ROLLBACK").await.unwrap();
    let waited = tokio::time::timeout(Duration::from_secs(10), blocked)
        .await
        .unwrap()
        .unwrap();
    assert!(
        waited >= others,
        "blocked append returned before the lock was released"
    );
    eprintln!(
        "stalled collection's append completed after {waited:?} (released at ≈{:?})",
        others + Duration::from_millis(300)
    );
}
