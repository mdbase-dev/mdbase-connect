#![allow(dead_code, unused_imports)]
#[path = "support/setup_evidence.rs"]
mod fixture;
mod support;
#[path = "support/test_postgres.rs"]
mod test_postgres;

use mdbase_connect_hosted_provider::RegisterReplica;
use serde_json::Value;
use support::FileLifecycleFixture;
use test_postgres::DisposablePostgres;

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn fresh_v2_setup_route_applies_declared_setup_without_issuing_a_replica() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let (evidence, _, mut exact, _) = fixture::setup_evidence_revisions(fixture.collection_id);
    // The setup engine fixture is projected; the fresh HTTP route receives the
    // complete declaration requirements, including the explicit semantic version.
    exact["requirements"] = evidence["application_declaration"]["requirements"].clone();
    let before: i64 =
        sqlx::query_scalar("SELECT head FROM hosted_provider_collections WHERE id=$1")
            .bind(fixture.collection_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let token = "internal-fresh-issuance-test-token-".repeat(2);
    let state =
        mdbase_connect_hosted_provider::AppState::new(fixture.provider.clone(), &token).unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, mdbase_connect_hosted_provider::app(state))
            .await
            .unwrap();
    });
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let response = reqwest::Client::new()
        .post(format!(
            "http://{address}/internal/v1/collections/{}/fresh-application-setup-v2",
            fixture.collection_id
        ))
        .bearer_auth(token)
        .json(&exact)
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body: Value = response.json().await.unwrap();
    server.abort();
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert!(body["setup_assessment"].is_object(), "{body}");
    assert!(body["provision_receipt"].is_object(), "{body}");
    let after: i64 = sqlx::query_scalar("SELECT head FROM hosted_provider_collections WHERE id=$1")
        .bind(fixture.collection_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert!(
        after > before,
        "fresh setup must commit its declared effect"
    );
    let applications: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_replicas WHERE collection_id=$1 AND purpose='application'",
    ).bind(fixture.collection_id).fetch_one(&fixture.pool).await.unwrap();
    assert_eq!(
        applications, 0,
        "setup alone does not issue application authority"
    );
}
