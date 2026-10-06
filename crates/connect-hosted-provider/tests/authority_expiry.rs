#![allow(dead_code, unused_imports)]
mod support;
#[path = "support/test_postgres.rs"]
mod test_postgres;

use mdbase_connect_hosted_provider::{
    PrepareAuthorityImport, PrepareAuthorityTransfer, ProviderAuthorityTransferState,
};
use support::FileLifecycleFixture;
use test_postgres::DisposablePostgres;
use uuid::Uuid;

async fn import_input(
    f: &FileLifecycleFixture,
    id: Uuid,
    collection: Uuid,
    ttl: u64,
) -> PrepareAuthorityImport {
    PrepareAuthorityImport {
        transfer_id: id,
        collection_id: collection,
        account_id: sqlx::query_scalar(
            "SELECT account_id FROM hosted_provider_collections WHERE id=$1",
        )
        .bind(f.collection_id)
        .fetch_one(&f.pool)
        .await
        .unwrap(),
        display_name: "[test] expiry".into(),
        token: format!("test-{}-{}", Uuid::new_v4(), Uuid::new_v4()),
        authority_epoch: 2,
        ttl_seconds: ttl,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable PostgreSQL"]
async fn import_expiry_preserves_provider_renewal_but_explicit_cancel_remains_allowed() {
    let database = DisposablePostgres::from_projection_env().await;
    let f = FileLifecycleFixture::new(database.url()).await;
    let id = Uuid::new_v4();
    let collection = Uuid::new_v4();
    let original = f
        .provider
        .prepare_authority_import(import_input(&f, id, collection, 60).await)
        .await
        .unwrap();
    let renewed = f
        .provider
        .prepare_authority_import(import_input(&f, id, collection, 3600).await)
        .await
        .unwrap();
    assert!(renewed.expires_at > original.expires_at);
    assert_eq!(
        f.provider
            .expire_authority_import(id, collection, 2)
            .await
            .unwrap_err()
            .code,
        "authority_import_not_expired"
    );
    let retained: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_authority_imports WHERE id=$1 AND expires_at > now()",
    )
    .bind(id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    let receipts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_authority_import_cancellations WHERE transfer_id=$1",
    )
    .bind(id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!((retained, receipts), (1, 0));
    f.provider
        .reconcile_authority_import_cancellation(id, collection, 2)
        .await
        .unwrap();
    assert_eq!(
        f.provider
            .prepare_authority_import(import_input(&f, id, collection, 300).await)
            .await
            .unwrap_err()
            .code,
        "authority_import_cancelled"
    );
    f.pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable PostgreSQL"]
async fn expired_import_requires_exact_binding_and_acknowledges_a_durable_prepare_fence() {
    let database = DisposablePostgres::from_projection_env().await;
    let f = FileLifecycleFixture::new(database.url()).await;
    for present in [true, false] {
        let id = Uuid::new_v4();
        let collection = Uuid::new_v4();
        if present {
            f.provider
                .prepare_authority_import(import_input(&f, id, collection, 300).await)
                .await
                .unwrap();
            sqlx::query("UPDATE hosted_provider_authority_imports SET expires_at=now()-interval '1 hour' WHERE id=$1")
                .bind(id).execute(&f.pool).await.unwrap();
            assert!(f
                .provider
                .expire_authority_import(id, Uuid::new_v4(), 2)
                .await
                .is_err());
            assert!(f
                .provider
                .expire_authority_import(id, collection, 3)
                .await
                .is_err());
        }
        for _ in 0..2 {
            f.provider
                .expire_authority_import(id, collection, 2)
                .await
                .unwrap();
        }
        assert_eq!(
            f.provider
                .prepare_authority_import(import_input(&f, id, collection, 300).await)
                .await
                .unwrap_err()
                .code,
            "authority_import_cancelled"
        );
    }
    f.pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable PostgreSQL"]
async fn indexing_and_completed_imports_never_expire_or_gain_an_abort_receipt() {
    let database = DisposablePostgres::from_projection_env().await;
    let f = FileLifecycleFixture::new(database.url()).await;
    for state in ["indexing", "completed"] {
        let id = Uuid::new_v4();
        let collection = Uuid::new_v4();
        f.provider
            .prepare_authority_import(import_input(&f, id, collection, 300).await)
            .await
            .unwrap();
        sqlx::query("UPDATE hosted_provider_authority_imports SET state=$2, expires_at=now()-interval '1 hour' WHERE id=$1")
            .bind(id).bind(state).execute(&f.pool).await.unwrap();
        let error = f
            .provider
            .expire_authority_import(id, collection, 2)
            .await
            .unwrap_err();
        assert_eq!(error.code, format!("authority_import_{state}"));
        let receipts: i64 = sqlx::query_scalar("SELECT count(*) FROM hosted_provider_authority_import_cancellations WHERE transfer_id=$1")
            .bind(id).fetch_one(&f.pool).await.unwrap();
        assert_eq!(receipts, 0);
        let retained: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM hosted_provider_authority_imports WHERE id=$1 AND state=$2",
        )
        .bind(id)
        .bind(state)
        .fetch_one(&f.pool)
        .await
        .unwrap();
        assert_eq!(retained, 1);
    }
    f.pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable PostgreSQL"]
async fn transfer_expiry_checks_current_deadline_and_binding_without_restricting_explicit_cancel() {
    let database = DisposablePostgres::from_projection_env().await;
    let f = FileLifecycleFixture::new(database.url()).await;
    let replica_id =
        sqlx::query_scalar("SELECT id FROM hosted_provider_replicas WHERE collection_id=$1")
            .bind(f.collection_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    for expired in [false, true] {
        let id = Uuid::new_v4();
        let prepared = f
            .provider
            .prepare_authority_transfer(
                f.collection_id,
                PrepareAuthorityTransfer {
                    transfer_id: id,
                    replica_id,
                    ttl_seconds: 300,
                },
            )
            .await
            .unwrap();
        assert!(f
            .provider
            .expire_authority_transfer(id, Uuid::new_v4(), prepared.authority_epoch)
            .await
            .is_err());
        assert!(f
            .provider
            .expire_authority_transfer(id, f.collection_id, prepared.authority_epoch + 1)
            .await
            .is_err());
        if expired {
            sqlx::query("UPDATE hosted_provider_authority_transfers SET expires_at=now()-interval '1 hour' WHERE id=$1")
                .bind(id).execute(&f.pool).await.unwrap();
            assert_eq!(
                f.provider
                    .expire_authority_transfer(id, f.collection_id, prepared.authority_epoch)
                    .await
                    .unwrap()
                    .state,
                ProviderAuthorityTransferState::Aborted
            );
        } else {
            assert_eq!(
                f.provider
                    .expire_authority_transfer(id, f.collection_id, prepared.authority_epoch)
                    .await
                    .unwrap_err()
                    .code,
                "authority_transfer_not_expired"
            );
            assert_eq!(
                f.provider.abort_authority_transfer(id).await.unwrap().state,
                ProviderAuthorityTransferState::Aborted
            );
        }
    }
    f.pool.close().await;
}
