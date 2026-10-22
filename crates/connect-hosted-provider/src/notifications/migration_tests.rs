//! Admission primitive tests on owned disposable PostgreSQL, never LAB.
#[allow(dead_code, unused_imports)]
#[path = "../../tests/support/mod.rs"]
mod support;
use crate::test_postgres;

use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use support::FileLifecycleFixture;
use test_postgres::DisposablePostgres;

fn invocation(collection: Uuid) -> ActionInvocation {
    serde_json::from_value(json!({
        "kind":"mdbase.action.invocation", "profile_version":"0.1",
        "invocation_id":"original-fixture-invocation", "attempt_id":"fixture-attempt",
        "request_id":"fixture-request", "contract":{"id":"notify", "version":"1", "digest":"fixture"},
        "caller":runtime_identity(collection), "provider":runtime_identity(collection),
        "provider_declaration_digest":"fixture", "handler_id":"notify",
        "admitted_at":"2026-10-11T00:00:00Z",
        "input":{"grant_id":Uuid::new_v4(),"criterion_id":"criterion","cursor":"1"}
    })).unwrap()
}

async fn run_projection(f: &FileLifecycleFixture) {
    // Physical projection only; the runtime initializer is deliberately absent.
    sqlx::raw_sql(r#"
        CREATE TABLE mdbase_runtime_schema (singleton boolean PRIMARY KEY CHECK(singleton), version integer);
        INSERT INTO mdbase_runtime_schema VALUES(TRUE,2);
        CREATE TABLE mdbase_runtime_runs (
          namespace text, id text, revision bigint, status text,
          executor text, workflow text, trigger_id text, created_at timestamptz,
          not_before timestamptz, lease_token text, lease_worker text, lease_expires_at timestamptz,
          record_json jsonb, PRIMARY KEY(namespace,id));
        CREATE TABLE mdbase_runtime_timers (
          namespace text,id text,generation bigint,status text,fire_at timestamptz,
          lease_token text,lease_worker text,lease_expires_at timestamptz, PRIMARY KEY(namespace,id));
        CREATE TABLE mdbase_runtime_events (namespace text,cursor bigint,PRIMARY KEY(namespace,cursor));
    "#).execute(&f.pool).await.unwrap();
    sqlx::query(r#"INSERT INTO mdbase_runtime_runs
      (namespace,id,revision,status,executor,workflow,trigger_id,created_at,not_before,
       lease_token,lease_worker,lease_expires_at,record_json)
      VALUES($1,'run',1,'running','notify','workflow','trigger',now(),now(),
       'opaque-fixture-lease','fixture-worker',now()+interval '1 minute',$2)"#)
      .bind(format!("connect-hosted:{}:notifications",f.collection_id))
      .bind(json!({"active_attempt":0,"attempts":[{"invocation_id":"original-fixture-invocation","status":"dispatching"}]}))
      .execute(&f.pool).await.unwrap();
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn held_http_guard_kill_and_late_attempt_remain_blocking_without_post_fence_push() {
    let db = DisposablePostgres::from_projection_env().await;
    let f = FileLifecycleFixture::new(db.url()).await;
    run_projection(&f).await;
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let count = Arc::new(AtomicUsize::new(0));
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let (n, e, r) = (count.clone(), entered.clone(), release.clone());
    let router = axum::Router::new().route(
        "/internal/v1/hosted/notification-signals",
        axum::routing::post(move || {
            let (n, e, r) = (n.clone(), e.clone(), r.clone());
            async move {
                n.fetch_add(1, Ordering::SeqCst);
                e.notify_one();
                r.notified().await;
                axum::http::StatusCode::OK
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let runtime = HostedNotificationRuntime::new(
        f.pool.clone(),
        HostedNotificationConfig {
            control_plane_url: endpoint.clone(),
            internal_token: "isolated-fixture-only-".repeat(2),
        },
    )
    .unwrap();
    let provider = HostedSignalProvider {
        pool: f.pool.clone(),
        collection_id: f.collection_id,
        client: runtime.client.clone(),
        control_plane_url: endpoint,
        internal_token: "isolated-fixture-only-".repeat(2),
    };
    let mut guard = runtime
        .lock_active_collection(f.collection_id)
        .await
        .unwrap()
        .unwrap();
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *guard)
        .await
        .unwrap();
    let (p, i) = (provider.clone(), invocation(f.collection_id));
    let dispatch = tokio::spawn(async move { p.dispatch(i).await });
    tokio::time::timeout(Duration::from_secs(3), entered.notified())
        .await
        .unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
    let (p, id) = (f.provider.clone(), f.collection_id);
    let fence = tokio::spawn(async move {
        p.set_legacy_migration_state(id, "migrating", None, false, &[])
            .await
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!fence.is_finished());
    let killed: bool = sqlx::query_scalar("SELECT pg_terminate_backend($1)")
        .bind(pid)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert!(killed);
    assert!(guard.commit().await.is_err());
    let refused = tokio::time::timeout(Duration::from_secs(3), fence)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(refused.code, "legacy_notifications_not_drained");
    let state: String =
        sqlx::query_scalar("SELECT state FROM hosted_provider_collections WHERE id=$1")
            .bind(id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(state, "active");
    release.notify_one();
    dispatch.await.unwrap().unwrap();
    // A response or expiry does NOT manufacture genuine runtime settlement.
    sqlx::query("UPDATE mdbase_runtime_runs SET lease_expires_at=now()-interval '1 second'")
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(provider.dispatch(invocation(id)).await.is_err());
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(
        f.provider
            .set_legacy_migration_state(id, "migrating", None, false, &[])
            .await
            .unwrap_err()
            .code,
        "legacy_notifications_not_drained"
    );
    // Test-only state/attempt fault injection checks a late existing attempt
    // cannot push after fencing; the occupied run remains a drain blocker.
    sqlx::query("UPDATE hosted_provider_collections SET state='migrating' WHERE id=$1")
        .bind(id)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE mdbase_runtime_runs SET lease_expires_at=now()+interval '1 minute'")
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        provider.dispatch(invocation(id)).await.unwrap_err().message,
        "skipped_non_active"
    );
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert!(
        f.provider
            .legacy_migration_drain(id)
            .await
            .unwrap()
            .unresolved
            > 0
    );
    f.provider
        .set_legacy_migration_state(id, "active", None, false, &[])
        .await
        .unwrap();
    server.abort();
    f.pool.close().await;
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn expired_unknown_terminal_leases_and_fired_undelivered_refuse_the_fence() {
    let db = DisposablePostgres::from_projection_env().await;
    let f = FileLifecycleFixture::new(db.url()).await;
    run_projection(&f).await;
    let id = f.collection_id;
    sqlx::query("UPDATE mdbase_runtime_runs SET lease_expires_at=now()-interval '1 day'")
        .execute(&f.pool)
        .await
        .unwrap();
    for status in [
        "queued",
        "waiting",
        "running",
        "indeterminate",
        "failed",
        "succeeded",
        "cancelled",
    ] {
        sqlx::query("UPDATE mdbase_runtime_runs SET status=$1")
            .bind(status)
            .execute(&f.pool)
            .await
            .unwrap();
        let drain = f.provider.legacy_migration_drain(id).await.unwrap();
        assert!(drain.unresolved > 0 && drain.in_flight > 0);
        assert_eq!(
            f.provider
                .set_legacy_migration_state(id, "migrating", None, false, &[])
                .await
                .unwrap_err()
                .code,
            "legacy_notifications_not_drained"
        );
        let state: String =
            sqlx::query_scalar("SELECT state FROM hosted_provider_collections WHERE id=$1")
                .bind(id)
                .fetch_one(&f.pool)
                .await
                .unwrap();
        assert_eq!(state, "active");
    }
    // Runtime firing admits its run atomically; a fired timer's unfinished
    // delivery must block even with no timer lease and no run lease remaining.
    sqlx::query("UPDATE mdbase_runtime_runs SET status='queued', lease_token=NULL,lease_worker=NULL,lease_expires_at=NULL")
        .execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO mdbase_runtime_timers(namespace,id,generation,status,fire_at) VALUES($1,'fired',1,'fired',now())")
        .bind(format!("connect-hosted:{id}:notifications")).execute(&f.pool).await.unwrap();
    assert_eq!(
        f.provider
            .set_legacy_migration_state(id, "migrating", None, false, &[])
            .await
            .unwrap_err()
            .code,
        "legacy_notifications_not_drained"
    );
    f.pool.close().await;
}

fn invocation_with(collection: Uuid, invocation_id: &str) -> ActionInvocation {
    let mut value = serde_json::to_value(invocation(collection)).unwrap();
    value["invocation_id"] = json!(invocation_id);
    serde_json::from_value(value).unwrap()
}

/// A control-plane stand-in that counts every effect POST it receives.
async fn counting_signal_provider(
    f: &FileLifecycleFixture,
) -> (
    HostedSignalProvider,
    Arc<AtomicUsize>,
    tokio::task::JoinHandle<()>,
) {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let count = Arc::new(AtomicUsize::new(0));
    let n = count.clone();
    let router = axum::Router::new().route(
        "/internal/v1/hosted/notification-signals",
        axum::routing::post(move || {
            let n = n.clone();
            async move {
                n.fetch_add(1, Ordering::SeqCst);
                axum::http::StatusCode::OK
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let provider = HostedSignalProvider {
        pool: f.pool.clone(),
        collection_id: f.collection_id,
        client: reqwest::Client::new(),
        control_plane_url: endpoint,
        internal_token: "isolated-fixture-only-".repeat(2),
    };
    (provider, count, server)
}

async fn refused_without_effect(
    provider: &HostedSignalProvider,
    count: &AtomicUsize,
    invocation_id: &str,
) {
    let before = count.load(Ordering::SeqCst);
    let error = provider
        .dispatch(invocation_with(provider.collection_id, invocation_id))
        .await
        .unwrap_err();
    assert_eq!(
        error.outcome,
        DispatchOutcome::NotApplied,
        "{invocation_id}"
    );
    assert_eq!(count.load(Ordering::SeqCst), before, "{invocation_id}");
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn admission_refuses_forged_stale_and_cross_collection_invocations_without_effect() {
    let db = DisposablePostgres::from_projection_env().await;
    let f = FileLifecycleFixture::new(db.url()).await;
    run_projection(&f).await;
    let namespace = format!("connect-hosted:{}:notifications", f.collection_id);
    let (provider, count, server) = counting_signal_provider(&f).await;

    // An invocation identity the runtime never persisted is not admitted.
    refused_without_effect(&provider, &count, "forged-invocation").await;

    // A dispatching attempt persisted under ANOTHER collection's namespace
    // cannot be admitted through this collection's provider.
    let other = format!("connect-hosted:{}:notifications", Uuid::new_v4());
    sqlx::query(
        r#"INSERT INTO mdbase_runtime_runs
          (namespace,id,revision,status,executor,workflow,trigger_id,created_at,not_before,
           lease_token,lease_worker,lease_expires_at,record_json)
          VALUES($1,'run',1,'running','notify','workflow','trigger',now(),now(),
           'other-lease','other-worker',now()+interval '1 minute',$2)"#,
    )
    .bind(&other)
    .bind(json!({"active_attempt":0,"attempts":[{"invocation_id":"cross-collection","status":"dispatching"}]}))
    .execute(&f.pool)
    .await
    .unwrap();
    refused_without_effect(&provider, &count, "cross-collection").await;

    // A superseded attempt cannot speak for the active one.
    sqlx::query("UPDATE mdbase_runtime_runs SET record_json=$2 WHERE namespace=$1")
        .bind(&namespace)
        .bind(json!({"active_attempt":1,"attempts":[
            {"invocation_id":"original-fixture-invocation","status":"dispatching"},
            {"invocation_id":"newer-invocation","status":"dispatching"}]}))
        .execute(&f.pool)
        .await
        .unwrap();
    refused_without_effect(&provider, &count, "original-fixture-invocation").await;

    // A settled attempt is not replayed.
    sqlx::query("UPDATE mdbase_runtime_runs SET record_json=$2 WHERE namespace=$1")
        .bind(&namespace)
        .bind(json!({"active_attempt":0,"attempts":[
            {"invocation_id":"original-fixture-invocation","status":"succeeded"}]}))
        .execute(&f.pool)
        .await
        .unwrap();
    refused_without_effect(&provider, &count, "original-fixture-invocation").await;

    // A dispatching attempt whose run lost its lease, or is no longer
    // running, is not admitted either.
    sqlx::query(
        "UPDATE mdbase_runtime_runs SET record_json=$2, lease_token=NULL WHERE namespace=$1",
    )
    .bind(&namespace)
    .bind(json!({"active_attempt":0,"attempts":[
            {"invocation_id":"original-fixture-invocation","status":"dispatching"}]}))
    .execute(&f.pool)
    .await
    .unwrap();
    refused_without_effect(&provider, &count, "original-fixture-invocation").await;
    sqlx::query("UPDATE mdbase_runtime_runs SET lease_token='restored', status='waiting' WHERE namespace=$1")
        .bind(&namespace)
        .execute(&f.pool)
        .await
        .unwrap();
    refused_without_effect(&provider, &count, "original-fixture-invocation").await;

    // Positive control: the genuine current attempt is admitted exactly once.
    sqlx::query("UPDATE mdbase_runtime_runs SET status='running' WHERE namespace=$1")
        .bind(&namespace)
        .execute(&f.pool)
        .await
        .unwrap();
    provider
        .dispatch(invocation_with(
            f.collection_id,
            "original-fixture-invocation",
        ))
        .await
        .unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
    server.abort();
    f.pool.close().await;
}

async fn collection_state(f: &FileLifecycleFixture) -> String {
    sqlx::query_scalar("SELECT state FROM hosted_provider_collections WHERE id=$1")
        .bind(f.collection_id)
        .fetch_one(&f.pool)
        .await
        .unwrap()
}

async fn fence_error(f: &FileLifecycleFixture) -> String {
    f.provider
        .set_legacy_migration_state(f.collection_id, "migrating", None, false, &[])
        .await
        .unwrap_err()
        .code
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn unsupported_schema_and_unsettled_outbox_fail_closed_then_fenced_timers_refuse() {
    let db = DisposablePostgres::from_projection_env().await;
    let f = FileLifecycleFixture::new(db.url()).await;
    run_projection(&f).await;
    let id = f.collection_id;
    // Settle the fixture run so only the condition under test can block.
    sqlx::query("UPDATE mdbase_runtime_runs SET status='succeeded', lease_token=NULL, lease_worker=NULL, lease_expires_at=NULL")
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        f.provider
            .legacy_migration_drain(id)
            .await
            .unwrap()
            .unresolved,
        0
    );

    // A runtime schema version this fence was not written for is never
    // treated as "nothing pending".
    for version in [1, 3] {
        sqlx::query("UPDATE mdbase_runtime_schema SET version=$1")
            .bind(version)
            .execute(&f.pool)
            .await
            .unwrap();
        assert_eq!(
            f.provider
                .legacy_migration_drain(id)
                .await
                .unwrap_err()
                .code,
            "legacy_notification_schema_unavailable"
        );
        assert_eq!(
            fence_error(&f).await,
            "legacy_notification_schema_unavailable"
        );
        assert_eq!(collection_state(&f).await, "active");
    }
    sqlx::query("UPDATE mdbase_runtime_schema SET version=2")
        .execute(&f.pool)
        .await
        .unwrap();

    // Unprocessed outbox work, or a processed row still holding a lease,
    // blocks the fence and leaves the collection active.
    sqlx::query(
        "INSERT INTO hosted_provider_runtime_outbox(collection_id, sequence, event_type, payload)
         VALUES($1, 1, 'document.changed', '{}'::jsonb)",
    )
    .bind(id)
    .execute(&f.pool)
    .await
    .unwrap();
    assert!(
        f.provider
            .legacy_migration_drain(id)
            .await
            .unwrap()
            .unresolved
            > 0
    );
    assert_eq!(fence_error(&f).await, "legacy_notifications_not_drained");
    assert_eq!(collection_state(&f).await, "active");
    sqlx::query(
        "UPDATE hosted_provider_runtime_outbox
         SET processed_at=now(), lease_token=gen_random_uuid(), leased_until=now()-interval '1 day'
         WHERE collection_id=$1",
    )
    .bind(id)
    .execute(&f.pool)
    .await
    .unwrap();
    assert_eq!(fence_error(&f).await, "legacy_notifications_not_drained");
    assert_eq!(collection_state(&f).await, "active");

    // Once genuinely settled the fence engages.
    sqlx::query(
        "UPDATE hosted_provider_runtime_outbox SET lease_token=NULL, leased_until=NULL
         WHERE collection_id=$1",
    )
    .bind(id)
    .execute(&f.pool)
    .await
    .unwrap();
    f.provider
        .set_legacy_migration_state(id, "migrating", None, false, &[])
        .await
        .unwrap();
    assert_eq!(collection_state(&f).await, "migrating");

    // A fenced collection refuses timer operations before any grant lookup,
    // so the refusal is identical for known and unknown grants.
    let runtime = HostedNotificationRuntime::new(
        f.pool.clone(),
        HostedNotificationConfig {
            control_plane_url: "http://127.0.0.1:9".to_string(),
            internal_token: "isolated-fixture-only-".repeat(2),
        },
    )
    .unwrap();
    for operation in [
        "list_timers",
        "put_timer",
        "cancel_timer",
        "reconcile_timers",
    ] {
        let error = runtime
            .timer_operation(id, Uuid::new_v4(), operation, json!({}))
            .await
            .unwrap_err();
        assert_eq!(error.code, "collection_migrating", "{operation}");
    }
    assert!(runtime.lock_active_collection(id).await.unwrap().is_none());
    f.pool.close().await;
}
