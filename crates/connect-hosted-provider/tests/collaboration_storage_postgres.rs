#![allow(clippy::too_many_lines)]

use chrono::{Duration, Utc};
use futures_util::FutureExt;
use sqlx::{postgres::PgConnectOptions, postgres::PgPoolOptions, AssertSqlSafe, PgPool};
use std::{str::FromStr, time::Duration as StdDuration};
use uuid::Uuid;

const DATABASE_ENV: &str = "MDBASE_COLLABORATION_PHASE3_DATABASE_URL";
const PROFILE: &str = "markdown-body-yjs-v13";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a disposable MDBASE_COLLABORATION_PHASE3_DATABASE_URL PostgreSQL database"]
async fn hosted_collaboration_storage_phase3_postgres() {
    let database_url = std::env::var(DATABASE_ENV).expect("database URL is required");
    let admin = PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await
        .unwrap();
    let schema = format!("collaboration_phase3_{}", Uuid::new_v4().simple());
    sqlx::query(AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
        .execute(&admin)
        .await
        .unwrap();

    let result = std::panic::AssertUnwindSafe(run(&database_url, &schema))
        .catch_unwind()
        .await;

    // The pool is closed before dropping the schema, so no connection can keep
    // the schema locked. This is also executed when an assertion panics.
    sqlx::query(AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE")))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
    if let Err(payload) = result {
        std::panic::resume_unwind(payload);
    }
}

async fn run(database_url: &str, schema: &str) {
    let options = PgConnectOptions::from_str(database_url)
        .unwrap()
        .options([("search_path", format!("{schema},public"))]);
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .min_connections(1)
        .acquire_timeout(StdDuration::from_secs(10))
        .connect_with(options)
        .await
        .unwrap();

    // The full chain is intentionally used. SQLx cannot safely run a partial
    // chain and then resume it when later migrations have already changed the
    // same objects. Populated production rows and a repeated startup exercise
    // the upgrade path that matters to deployed providers.
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    let account = Uuid::new_v4();
    let collection = Uuid::new_v4();
    let record = Uuid::new_v4();
    let replica = Uuid::new_v4();
    insert_account(&pool, account, 1 << 20).await;
    insert_collection(&pool, account, collection, 1 << 20).await;
    insert_record(&pool, collection, record).await;
    insert_replica(&pool, collection, replica).await;
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();

    let document = (collection, record, 1_i64);
    let snapshot = vec![1_u8; 11];
    let state_vector = vec![2_u8; 7];
    insert_document(&pool, document, &snapshot, &state_vector, "rev-1").await;
    assert_usage(&pool, account, collection, 18).await;

    let update = vec![3_u8; 13];
    insert_update(&pool, document, replica, 1, &update, Uuid::new_v4()).await;
    assert_usage(&pool, account, collection, 31).await;
    let receipt = vec![4_u8; 5];
    insert_receipt(&pool, document, replica, 1, &receipt, Uuid::new_v4()).await;
    assert_usage(&pool, account, collection, 36).await;
    sqlx::query("UPDATE hosted_provider_collaboration_updates SET update_ciphertext = $1 WHERE collection_id = $2 AND sequence = 1")
        .bind([3_u8; 15].as_slice())
        .bind(collection)
        .execute(&pool)
        .await
        .unwrap();
    assert_usage(&pool, account, collection, 38).await;
    sqlx::query("UPDATE hosted_provider_collaboration_receipts SET receipt_ciphertext = $1 WHERE collection_id = $2 AND sequence = 1")
        .bind([4_u8; 8].as_slice())
        .bind(collection)
        .execute(&pool)
        .await
        .unwrap();
    assert_usage(&pool, account, collection, 41).await;

    // Both quota fences reject atomically: no ciphertext row or aggregate is
    // left partially written when either the collection or account limit trips.
    sqlx::query(
        "UPDATE hosted_provider_collections SET max_collaboration_bytes = collaboration_bytes",
    )
    .execute(&pool)
    .await
    .unwrap();
    let before = counts(&pool, document).await;
    let err = insert_update_result(&pool, document, replica, 2, &[5; 3], Uuid::new_v4()).await;
    assert!(err.is_err());
    assert_eq!(counts(&pool, document).await, before);
    assert_usage(&pool, account, collection, 41).await;

    sqlx::query("UPDATE hosted_provider_collections SET max_collaboration_bytes = 1 << 20")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE hosted_provider_accounts SET max_collaboration_bytes = live_collaboration_bytes",
    )
    .execute(&pool)
    .await
    .unwrap();
    let before = counts(&pool, document).await;
    let err = insert_update_result(&pool, document, replica, 2, &[6; 3], Uuid::new_v4()).await;
    assert!(err.is_err());
    assert_eq!(counts(&pool, document).await, before);
    assert_usage(&pool, account, collection, 41).await;

    // Deletes refresh exact document, collection, and account totals.
    sqlx::query("DELETE FROM hosted_provider_collaboration_receipts WHERE replica_id = $1")
        .bind(replica)
        .execute(&pool)
        .await
        .unwrap();
    assert_usage(&pool, account, collection, 33).await;
    sqlx::query("DELETE FROM hosted_provider_collaboration_updates WHERE replica_id = $1")
        .bind(replica)
        .execute(&pool)
        .await
        .unwrap();
    assert_usage(&pool, account, collection, 18).await;

    // Reconciliation repairs deliberate drift, including the per-document
    // cache, while ordinary writes remain compatible with populated rows.
    sqlx::query("SELECT set_config('mdbase.quota_reconciliation', 'on', false)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE hosted_provider_collaboration_documents SET collaboration_bytes = 9999 WHERE collection_id = $1")
        .bind(collection)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE hosted_provider_collections SET collaboration_bytes = 9999 WHERE id = $1")
        .bind(collection)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE hosted_provider_accounts SET live_collaboration_bytes = 9999 WHERE id = $1",
    )
    .bind(account)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("SELECT hosted_provider_reconcile_collaboration_account($1)")
        .bind(account)
        .execute(&pool)
        .await
        .unwrap();
    assert_usage(&pool, account, collection, 18).await;
    let document_bytes: i64 = sqlx::query_scalar("SELECT collaboration_bytes FROM hosted_provider_collaboration_documents WHERE collection_id = $1")
        .bind(collection)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(document_bytes, 18);
    sqlx::query(
        "UPDATE hosted_provider_accounts SET max_collaboration_bytes = 1 << 20 WHERE id = $1",
    )
    .bind(account)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("SELECT set_config('mdbase.quota_reconciliation', '', false)")
        .execute(&pool)
        .await
        .unwrap();

    test_tickets(&pool, document, replica).await;
    test_replica_cascade(&pool, document, replica).await;
    pool.close().await;
}

async fn insert_account(pool: &PgPool, id: Uuid, max_collaboration: i64) {
    sqlx::query("INSERT INTO hosted_provider_accounts (id, entitlement_revision, max_live_storage_bytes, max_retained_file_bytes, max_document_bytes, max_single_file_bytes, max_mirror_replicas_per_collection, max_application_replicas_per_collection, max_collections, max_files_per_collection, max_collaboration_bytes) VALUES ($1, 1, 1048576, 1048576, 1048576, 1048576, 10, 10, 10, 10, $2)")
        .bind(id).bind(max_collaboration).execute(pool).await.unwrap();
}

async fn insert_collection(pool: &PgPool, account: Uuid, id: Uuid, max_collaboration: i64) {
    sqlx::query("INSERT INTO hosted_provider_collections (id, account_id, template, display_name, timezone, spec_version, resource_revision, wrapped_data_key, resources_ciphertext, max_records, max_content_bytes, max_document_bytes, max_mirror_replicas, max_application_replicas, max_collaboration_bytes) VALUES ($1, $2, 'test', 'test', 'UTC', '1', 'r1', $3, $4, 10, 1048576, 1048576, 10, 10, $5)")
        .bind(id).bind(account).bind([0_u8; 32].as_slice()).bind([1_u8; 1].as_slice()).bind(max_collaboration).execute(pool).await.unwrap();
}

async fn insert_record(pool: &PgPool, collection: Uuid, record: Uuid) {
    sqlx::query("INSERT INTO hosted_provider_records (collection_id, record_id, path_token, revision, content_bytes, payload_ciphertext, sequence) VALUES ($1, $2, $3, 'r1', 1, $4, 1)")
        .bind(collection).bind(record).bind([9_u8; 16].as_slice()).bind([8_u8; 1].as_slice()).execute(pool).await.unwrap();
}

async fn insert_replica(pool: &PgPool, collection: Uuid, id: Uuid) {
    sqlx::query("INSERT INTO hosted_provider_replicas (id, collection_id, name, mode, token_hash) VALUES ($1, $2, 'test', 'read_write', $3)")
        .bind(id).bind(collection).bind([7_u8; 32].as_slice()).execute(pool).await.unwrap();
}

async fn insert_document(
    pool: &PgPool,
    key: (Uuid, Uuid, i64),
    snapshot: &[u8],
    state: &[u8],
    revision: &str,
) {
    sqlx::query("INSERT INTO hosted_provider_collaboration_documents (collection_id, record_id, collaboration_epoch, profile, snapshot_ciphertext, state_vector_ciphertext, materialized_revision) VALUES ($1, $2, $3, $4, $5, $6, $7)")
        .bind(key.0).bind(key.1).bind(key.2).bind(PROFILE).bind(snapshot).bind(state).bind(revision).execute(pool).await.unwrap();
}

async fn insert_update(
    pool: &PgPool,
    key: (Uuid, Uuid, i64),
    replica: Uuid,
    sequence: i64,
    ciphertext: &[u8],
    mutation: Uuid,
) {
    insert_update_result(pool, key, replica, sequence, ciphertext, mutation)
        .await
        .unwrap();
}

async fn insert_update_result(
    pool: &PgPool,
    key: (Uuid, Uuid, i64),
    replica: Uuid,
    sequence: i64,
    ciphertext: &[u8],
    mutation: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO hosted_provider_collaboration_updates (collection_id, record_id, collaboration_epoch, profile, sequence, update_ciphertext, update_digest, replica_id, client_mutation_id, materialized_revision) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'r')")
        .bind(key.0).bind(key.1).bind(key.2).bind(PROFILE).bind(sequence).bind(ciphertext).bind([sequence as u8; 32].as_slice()).bind(replica).bind(mutation).execute(pool).await.map(|_| ())
}

async fn insert_receipt(
    pool: &PgPool,
    key: (Uuid, Uuid, i64),
    replica: Uuid,
    sequence: i64,
    ciphertext: &[u8],
    mutation: Uuid,
) {
    sqlx::query("INSERT INTO hosted_provider_collaboration_receipts (collection_id, record_id, collaboration_epoch, profile, replica_id, client_mutation_id, mutation_digest, receipt_ciphertext, sequence) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)")
        .bind(key.0).bind(key.1).bind(key.2).bind(PROFILE).bind(replica).bind(mutation).bind([6_u8; 32].as_slice()).bind(ciphertext).bind(sequence).execute(pool).await.unwrap();
}

async fn counts(pool: &PgPool, key: (Uuid, Uuid, i64)) -> (i64, i64, i64) {
    sqlx::query_as("SELECT (SELECT count(*) FROM hosted_provider_collaboration_documents WHERE collection_id=$1 AND record_id=$2 AND collaboration_epoch=$3), (SELECT count(*) FROM hosted_provider_collaboration_updates WHERE collection_id=$1 AND record_id=$2 AND collaboration_epoch=$3), (SELECT count(*) FROM hosted_provider_collaboration_receipts WHERE collection_id=$1 AND record_id=$2 AND collaboration_epoch=$3)")
        .bind(key.0).bind(key.1).bind(key.2).fetch_one(pool).await.unwrap()
}

async fn assert_usage(pool: &PgPool, account: Uuid, collection: Uuid, expected: i64) {
    let (doc, collection_bytes, account_bytes): (i64, i64, i64) = sqlx::query_as("SELECT d.collaboration_bytes, c.collaboration_bytes, a.live_collaboration_bytes FROM hosted_provider_collaboration_documents d JOIN hosted_provider_collections c ON c.id=d.collection_id JOIN hosted_provider_accounts a ON a.id=c.account_id WHERE d.collection_id=$1")
        .bind(collection).fetch_one(pool).await.unwrap();
    assert!(doc == 0 || doc == expected);
    assert_eq!((collection_bytes, account_bytes), (expected, expected));
    let _: Uuid = sqlx::query_scalar("SELECT id FROM hosted_provider_accounts WHERE id=$1")
        .bind(account)
        .fetch_one(pool)
        .await
        .unwrap();
}

async fn test_tickets(pool: &PgPool, key: (Uuid, Uuid, i64), replica: Uuid) {
    let hash = [5_u8; 32];
    let created = Utc::now();
    let expires = created + Duration::minutes(10);
    sqlx::query("INSERT INTO hosted_provider_collaboration_tickets (ticket_hash, replica_id, collection_id, record_id, collaboration_epoch, profile, mode, allowed_origin, scope_epoch, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'read_write', 'https://example.invalid', 1, $7, $8)")
        .bind(hash.as_slice()).bind(replica).bind(key.0).bind(key.1).bind(key.2).bind(PROFILE).bind(expires).bind(created).execute(pool).await.unwrap();
    let err = sqlx::query(
        "UPDATE hosted_provider_collaboration_tickets SET mode='read_only' WHERE ticket_hash=$1",
    )
    .bind(hash.as_slice())
    .execute(pool)
    .await
    .unwrap_err();
    assert!(err
        .to_string()
        .contains("collaboration_ticket_not_single_use_or_expired"));
    sqlx::query(
        "UPDATE hosted_provider_collaboration_tickets SET consumed_at=now() WHERE ticket_hash=$1",
    )
    .bind(hash.as_slice())
    .execute(pool)
    .await
    .unwrap();
    assert!(sqlx::query(
        "UPDATE hosted_provider_collaboration_tickets SET consumed_at=now() WHERE ticket_hash=$1"
    )
    .bind(hash.as_slice())
    .execute(pool)
    .await
    .is_err());
    // The composite replica and room foreign keys reject a ticket bound to a
    // different room, while the check constraint rejects non-32-byte hashes.
    assert!(sqlx::query("INSERT INTO hosted_provider_collaboration_tickets (ticket_hash, replica_id, collection_id, record_id, collaboration_epoch, profile, mode, allowed_origin, scope_epoch, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'read_only', 'x', 1, now() + interval '1 minute', now())").bind([8_u8; 32].as_slice()).bind(replica).bind(key.0).bind(Uuid::new_v4()).bind(key.2).bind(PROFILE).execute(pool).await.is_err());
    assert!(sqlx::query("INSERT INTO hosted_provider_collaboration_tickets (ticket_hash, replica_id, collection_id, record_id, collaboration_epoch, profile, mode, allowed_origin, scope_epoch, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'read_only', 'x', 1, now() - interval '1 second', now() - interval '2 seconds')").bind([8_u8; 31].as_slice()).bind(replica).bind(key.0).bind(key.1).bind(key.2).bind(PROFILE).execute(pool).await.is_err());
    let expired = [9_u8; 32];
    sqlx::query("INSERT INTO hosted_provider_collaboration_tickets (ticket_hash, replica_id, collection_id, record_id, collaboration_epoch, profile, mode, allowed_origin, scope_epoch, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'read_only', 'x', 1, now() - interval '1 second', now() - interval '2 seconds')").bind(expired.as_slice()).bind(replica).bind(key.0).bind(key.1).bind(key.2).bind(PROFILE).execute(pool).await.unwrap();
    assert!(sqlx::query(
        "UPDATE hosted_provider_collaboration_tickets SET consumed_at=now() WHERE ticket_hash=$1"
    )
    .bind(expired.as_slice())
    .execute(pool)
    .await
    .is_err());
}

async fn test_replica_cascade(pool: &PgPool, key: (Uuid, Uuid, i64), replica: Uuid) {
    insert_update(pool, key, replica, 3, &[3; 2], Uuid::new_v4()).await;
    insert_receipt(pool, key, replica, 3, &[4; 2], Uuid::new_v4()).await;
    sqlx::query("DELETE FROM hosted_provider_replicas WHERE id=$1")
        .bind(replica)
        .execute(pool)
        .await
        .unwrap();
    let provenance: Option<Uuid> = sqlx::query_scalar(
        "SELECT replica_id FROM hosted_provider_collaboration_updates WHERE sequence=3",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    assert!(provenance.is_none());
    let receipts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_collaboration_receipts WHERE sequence=3",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    let tickets: i64 =
        sqlx::query_scalar("SELECT count(*) FROM hosted_provider_collaboration_tickets")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!((receipts, tickets), (0, 0));
    let documents: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_collaboration_documents WHERE collection_id=$1",
    )
    .bind(key.0)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(documents, 1);
}
