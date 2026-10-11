//! Isolated physical schema2 projection; no runtime initializer or LAB service.
#[allow(dead_code, unused_imports)]
mod support;
#[path = "support/test_postgres.rs"]
mod test_postgres;

use mdbase_connect_hosted_provider::{app, AppState};
use serde_json::Value;
use support::FileLifecycleFixture;
use test_postgres::DisposablePostgres;

async fn projection(f: &FileLifecycleFixture) {
    sqlx::raw_sql(r#"
        CREATE TABLE mdbase_runtime_schema (singleton boolean PRIMARY KEY CHECK (singleton), version integer);
        INSERT INTO mdbase_runtime_schema VALUES (TRUE, 2);
        CREATE TABLE mdbase_runtime_timers (
          namespace text, id text, generation bigint, status text, fire_at timestamptz,
          lease_token text, lease_worker text, lease_expires_at timestamptz,
          PRIMARY KEY(namespace, id));
        CREATE TABLE mdbase_runtime_runs (
          namespace text, id text, revision bigint, status text,
          executor text, workflow text, trigger_id text, created_at timestamptz,
          not_before timestamptz, lease_token text, lease_worker text, lease_expires_at timestamptz,
          PRIMARY KEY(namespace, id));
        CREATE TABLE mdbase_runtime_events (namespace text, cursor bigint, PRIMARY KEY(namespace, cursor));
    "#).execute(&f.pool).await.unwrap();
}

async fn read(client: &reqwest::Client, url: &str, token: &str) -> (String, Value) {
    let response = client.get(url).bearer_auth(token).send().await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let etag = response.headers()["etag"].to_str().unwrap().to_owned();
    let hex = etag
        .strip_prefix("\"mdbase-legacy-notifications-v1:")
        .and_then(|s| s.strip_suffix('"'))
        .unwrap();
    assert_eq!(hex.len(), 64);
    assert!(hex
        .bytes()
        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
    let body: Value = response.json().await.unwrap();
    assert!(body.get("notification_watermark").is_none());
    (etag, body)
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn complete_watermark_detects_opaque_lease_replacement_insert_delete_and_unchanged() {
    let db = DisposablePostgres::from_projection_env().await;
    let f = FileLifecycleFixture::new(db.url()).await;
    projection(&f).await;
    let namespace = format!("connect-hosted:{}:notifications", f.collection_id);
    // Beyond the removed 4096-row aggregate cap; every row remains included.
    sqlx::query(
        r#"INSERT INTO mdbase_runtime_timers (namespace,id,generation,status,fire_at)
        SELECT $1, 't.' || n::text, n, 'scheduled', '2030-01-01T00:00:00Z'::timestamptz
        FROM generate_series(1, 5002) n"#,
    )
    .bind(&namespace)
    .execute(&f.pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO mdbase_runtime_runs
        (namespace,id,revision,status,executor,workflow,trigger_id,created_at,not_before)
        VALUES ($1,'run',1,'succeeded','notify','workflow','trigger',now(),now())"#,
    )
    .bind(&namespace)
    .execute(&f.pool)
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let token = "isolated-watermark-fixture-only-".repeat(2);
    let state = AppState::new(f.provider.clone(), &token).unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap() });
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let client = reqwest::Client::new();
    let url = format!(
        "http://{address}/internal/v1/collections/{}/legacy-migration",
        f.collection_id
    );
    assert_eq!(
        client.get(&url).send().await.unwrap().status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    let original = read(&client, &url, &token).await;
    assert_eq!(read(&client, &url, &token).await, original);
    for table in ["mdbase_runtime_timers", "mdbase_runtime_runs"] {
        // Table names are an audited two-literal allowlist; values remain bound.
        let id = if table == "mdbase_runtime_timers" {
            "t.5002"
        } else {
            "run"
        };
        let sql = sqlx::AssertSqlSafe(format!("UPDATE {table} SET lease_token=$3, lease_worker='fixture', lease_expires_at='2031-01-01T00:00:00Z' WHERE namespace=$1 AND id=$2"));
        sqlx::query(sql)
            .bind(&namespace)
            .bind(id)
            .bind("opaque-fixture-a")
            .execute(&f.pool)
            .await
            .unwrap();
        let before = read(&client, &url, &token).await;
        assert_eq!(read(&client, &url, &token).await, before);
        let sql = sqlx::AssertSqlSafe(format!(
            "UPDATE {table} SET lease_token=$3 WHERE namespace=$1 AND id=$2"
        ));
        sqlx::query(sql)
            .bind(&namespace)
            .bind(id)
            .bind("opaque-fixture-b")
            .execute(&f.pool)
            .await
            .unwrap();
        let after = read(&client, &url, &token).await;
        assert_ne!(before.0, after.0); // xmin changes, token presence/expiry do not.
        assert_eq!(before.1, after.1); // Original response body unchanged.
    }
    let before = read(&client, &url, &token).await.0;
    sqlx::query("INSERT INTO mdbase_runtime_timers (namespace,id,generation,status,fire_at) VALUES ($1,'inserted',1,'scheduled',now())")
        .bind(&namespace).execute(&f.pool).await.unwrap();
    let inserted = read(&client, &url, &token).await.0;
    assert_ne!(before, inserted);
    sqlx::query("DELETE FROM mdbase_runtime_timers WHERE namespace=$1 AND id='inserted'")
        .bind(&namespace)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(read(&client, &url, &token).await.0, before);
    sqlx::query("INSERT INTO mdbase_runtime_events VALUES ($1, 7)")
        .bind(&namespace)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_ne!(read(&client, &url, &token).await.0, before);
    sqlx::query("UPDATE mdbase_runtime_schema SET version=3 WHERE singleton=TRUE")
        .execute(&f.pool)
        .await
        .unwrap();
    let response = client.get(&url).bearer_auth(&token).send().await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::CONFLICT);
    assert!(!response.headers().contains_key("etag"));
    server.abort();
    f.pool.close().await;
}
