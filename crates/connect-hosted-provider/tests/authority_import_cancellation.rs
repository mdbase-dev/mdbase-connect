#![allow(dead_code, unused_imports)]
mod support;
use mdbase_connect_hosted_provider::PrepareAuthorityImport;
use support::FileLifecycleFixture;
use uuid::Uuid;

async fn fixture() -> FileLifecycleFixture {
    let url = std::env::var("MDBASE_PROJECTION_DATABASE_URL").unwrap();
    let parsed = url::Url::parse(&url).unwrap();
    assert!(
        matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
            && parsed.path().contains("test")
    );
    FileLifecycleFixture::new(&url).await
}

async fn input(
    f: &FileLifecycleFixture,
    transfer_id: Uuid,
    collection_id: Uuid,
) -> PrepareAuthorityImport {
    PrepareAuthorityImport {
        transfer_id,
        collection_id,
        account_id: sqlx::query_scalar(
            "SELECT account_id FROM hosted_provider_collections WHERE id=$1",
        )
        .bind(f.collection_id)
        .fetch_one(&f.pool)
        .await
        .unwrap(),
        display_name: "[test] cancellation".into(),
        token: format!("test-{}-{}", Uuid::new_v4(), Uuid::new_v4()),
        authority_epoch: 2,
        ttl_seconds: 300,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable PostgreSQL"]
async fn absent_and_retained_imports_gain_durable_non_resurrection_fences() {
    let f = fixture().await;
    for retained in [false, true] {
        let id = Uuid::new_v4();
        let collection = Uuid::new_v4();
        if retained {
            f.provider
                .prepare_authority_import(input(&f, id, collection).await)
                .await
                .unwrap();
        }
        for _ in 0..2 {
            f.provider
                .reconcile_authority_import_cancellation(id, collection, 2)
                .await
                .unwrap();
        }
        assert_eq!(
            f.provider
                .prepare_authority_import(input(&f, id, collection).await)
                .await
                .unwrap_err()
                .code,
            "authority_import_cancelled"
        );
        assert_eq!(
            f.provider
                .complete_authority_import(id, "digest", "revision")
                .await
                .unwrap_err()
                .code,
            "authority_import_not_found"
        );
        let remaining: i64 =
            sqlx::query_scalar("SELECT count(*) FROM hosted_provider_collections WHERE id=$1")
                .bind(collection)
                .fetch_one(&f.pool)
                .await
                .unwrap();
        assert_eq!(remaining, 0);
        // A pre-upgrade writer bypassing the new Rust check is fenced too.
        let legacy = sqlx::query("INSERT INTO hosted_provider_authority_imports (id, collection_id, token_hash, next_authority_epoch, expires_at) VALUES ($1,$2,$3,2,now()+interval '1 hour')")
            .bind(id).bind(f.collection_id).bind(id.as_bytes().to_vec()).execute(&f.pool).await.unwrap_err();
        assert_eq!(
            legacy.as_database_error().unwrap().code().as_deref(),
            Some("23514")
        );
        assert!(f
            .provider
            .reconcile_authority_import_cancellation(id, Uuid::new_v4(), 2)
            .await
            .is_err());
        assert!(f
            .provider
            .reconcile_authority_import_cancellation(id, collection, 3)
            .await
            .is_err());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable PostgreSQL"]
async fn activation_and_identity_conflicts_never_issue_cancellation() {
    let f = fixture().await;
    assert!(f
        .provider
        .reconcile_authority_import_cancellation(Uuid::new_v4(), f.collection_id, 2)
        .await
        .is_err());
    for state in ["indexing", "completed"] {
        let id = Uuid::new_v4();
        let collection = Uuid::new_v4();
        f.provider
            .prepare_authority_import(input(&f, id, collection).await)
            .await
            .unwrap();
        assert!(f
            .provider
            .reconcile_authority_import_cancellation(id, Uuid::new_v4(), 2)
            .await
            .is_err());
        sqlx::query("UPDATE hosted_provider_authority_imports SET state=$2 WHERE id=$1")
            .bind(id)
            .bind(state)
            .execute(&f.pool)
            .await
            .unwrap();
        assert!(f
            .provider
            .reconcile_authority_import_cancellation(id, collection, 2)
            .await
            .is_err());
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM hosted_provider_authority_import_cancellations WHERE transfer_id=$1").bind(id).fetch_one(&f.pool).await.unwrap();
        assert_eq!(count, 0);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable PostgreSQL"]
async fn retries_recheck_current_authority_and_exact_prior_epoch() {
    let f = fixture().await;
    let id = Uuid::new_v4();
    sqlx::query("UPDATE hosted_provider_collections SET state='transferred' WHERE id=$1")
        .bind(f.collection_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(f
        .provider
        .reconcile_authority_import_cancellation(id, f.collection_id, 3)
        .await
        .is_err());
    f.provider
        .reconcile_authority_import_cancellation(id, f.collection_id, 2)
        .await
        .unwrap();
    sqlx::query("UPDATE hosted_provider_collections SET state='active' WHERE id=$1")
        .bind(f.collection_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(f
        .provider
        .reconcile_authority_import_cancellation(id, f.collection_id, 2)
        .await
        .is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable PostgreSQL"]
async fn cancellation_waits_for_and_refuses_a_concurrent_indexing_transition() {
    let f = fixture().await;
    let id = Uuid::new_v4();
    let collection = Uuid::new_v4();
    f.provider
        .prepare_authority_import(input(&f, id, collection).await)
        .await
        .unwrap();
    let mut activation = f.pool.begin().await.unwrap();
    sqlx::query("UPDATE hosted_provider_authority_imports SET state='indexing' WHERE id=$1")
        .bind(id)
        .execute(&mut *activation)
        .await
        .unwrap();
    let provider = f.provider.clone();
    let cancelling = tokio::spawn(async move {
        provider
            .reconcile_authority_import_cancellation(id, collection, 2)
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    assert!(!cancelling.is_finished());
    activation.commit().await.unwrap();
    assert_eq!(
        cancelling.await.unwrap().unwrap_err().code,
        "authority_import_indexing"
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_authority_import_cancellations WHERE transfer_id=$1",
    )
    .bind(id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable PostgreSQL"]
async fn internal_http_cancellation_requires_credentials_and_returns_exact_binding() {
    let f = fixture().await;
    let id = Uuid::new_v4();
    let collection = Uuid::new_v4();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let token = "test-internal-cancellation-token-".repeat(2);
    let state = mdbase_connect_hosted_provider::AppState::new(f.provider.clone(), &token).unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, mdbase_connect_hosted_provider::app(state))
            .await
            .unwrap();
    });
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let client = reqwest::Client::new();
    let url = format!("http://{address}/internal/v1/authority-imports/{id}/reconcile-cancellation");
    let body = serde_json::json!({"collection_id": collection, "authority_epoch": 2});
    assert_eq!(
        client.post(&url).json(&body).send().await.unwrap().status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_authority_import_cancellations WHERE transfer_id=$1",
    )
    .bind(id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(count, 0);
    let response = client
        .post(&url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap(),
        serde_json::json!({"transfer_id": id, "collection_id": collection, "authority_epoch": 2, "cancelled": true})
    );
    server.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable PostgreSQL"]
async fn concurrent_prepare_cannot_recreate_a_cancelled_import() {
    let f = fixture().await;
    let id = Uuid::new_v4();
    let collection = Uuid::new_v4();
    let prepare = input(&f, id, collection).await;
    let (cancelled, prepared) = tokio::join!(
        f.provider
            .reconcile_authority_import_cancellation(id, collection, 2),
        f.provider.prepare_authority_import(prepare),
    );
    cancelled.unwrap();
    if let Err(error) = prepared {
        assert_eq!(error.code, "authority_import_cancelled");
    }
    assert_eq!(
        f.provider
            .prepare_authority_import(input(&f, id, collection).await)
            .await
            .unwrap_err()
            .code,
        "authority_import_cancelled"
    );
}
