#![allow(dead_code, unused_imports)]

mod support;

use mdbase_connect_hosted_provider::{PrepareAuthorityImport, ProviderAuthorityImportState};
use support::FileLifecycleFixture;
use uuid::Uuid;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL pointing to disposable PostgreSQL"]
async fn historical_abort_and_expiry_both_erase_provider_import_evidence() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let url = url::Url::parse(&database_url).expect("test database URL is valid");
    assert!(
        matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
            && url.path().contains("test"),
        "Historical import tests require a dedicated local test database"
    );
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let account_id: Uuid =
        sqlx::query_scalar("SELECT account_id FROM hosted_provider_collections WHERE id = $1")
            .bind(fixture.collection_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();

    for expires in [false, true] {
        let collection_id = Uuid::new_v4();
        let transfer_id = Uuid::new_v4();
        fixture
            .provider
            .prepare_authority_import(PrepareAuthorityImport {
                transfer_id,
                collection_id,
                account_id,
                display_name: "[test] historical import evidence".to_string(),
                token: format!("test-import-{}-{}", Uuid::new_v4(), Uuid::new_v4()),
                authority_epoch: 2,
                ttl_seconds: 300,
            })
            .await
            .unwrap();
        if expires {
            sqlx::query("UPDATE hosted_provider_authority_imports SET expires_at = now() - interval '1 hour' WHERE id = $1")
                .bind(transfer_id)
                .execute(&fixture.pool)
                .await
                .unwrap();
            assert_eq!(
                fixture
                    .provider
                    .recover_expired_authority_imports()
                    .await
                    .unwrap(),
                1
            );
        } else {
            assert_eq!(
                fixture
                    .provider
                    .abort_authority_import(transfer_id)
                    .await
                    .unwrap()
                    .state,
                ProviderAuthorityImportState::Aborted
            );
        }
        let imports: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM hosted_provider_authority_imports WHERE id = $1",
        )
        .bind(transfer_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
        let collections: i64 =
            sqlx::query_scalar("SELECT count(*) FROM hosted_provider_collections WHERE id = $1")
                .bind(collection_id)
                .fetch_one(&fixture.pool)
                .await
                .unwrap();
        assert_eq!((imports, collections), (0, 0));
        assert_eq!(
            fixture
                .provider
                .abort_authority_import(transfer_id)
                .await
                .unwrap_err()
                .code,
            "authority_import_not_found"
        );
    }
}
