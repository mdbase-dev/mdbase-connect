#![allow(dead_code, unused_imports)]

//! Expired `prepared` mutations: timer takeover and the maintenance sweep
//! (ADR 0005, decision by Callum, 2026-11-07).

mod support;
#[path = "support/test_postgres.rs"]
mod test_postgres;

use mdbase_connect_hosted_provider::{
    HostedMutationSweep, HostedProvider, RegisterReplica, ReplicaPurpose,
};
use mdbase_connect_protocol::SyncReplicaMode;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use support::{wait_for_query_blocked, FileLifecycleFixture};
use test_postgres::DisposablePostgres;
use uuid::Uuid;

const OPERATIONS: &[&str] = &["create", "put_timer", "cancel_timer", "reconcile_timers"];

async fn application(fixture: &FileLifecycleFixture) -> (Uuid, String) {
    let replica_id = Uuid::now_v7();
    let token = format!("abandon-{}-{}", Uuid::new_v4(), Uuid::new_v4());
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id,
                name: "Abandoned mutation application".to_string(),
                application_setup_evidence: None,
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadWrite,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: OPERATIONS.iter().map(|op| op.to_string()).collect(),
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: vec![2],
                file_capability: None,
                allowed_origin: None,
                proof_public_key: None,
                grant_id: Some(Uuid::new_v4()),
                application_declaration_id: None,
                application_declaration_digest: None,
                token: token.clone(),
                token_ttl_seconds: Some(3600),
            },
        )
        .await
        .unwrap();
    (replica_id, token)
}

/// A journal row left `prepared` by a handler that never finished.
async fn prepared(
    pool: &PgPool,
    collection_id: Uuid,
    replica_id: Uuid,
    operation: &str,
    input: &Value,
    lease_expires_in: &str,
    accepted_ago: &str,
) -> Uuid {
    let request_id = Uuid::now_v7();
    let kind = mdbase_connect_protocol::mutation_operation_identifier(operation, input).unwrap();
    let version =
        mdbase_connect_protocol::operation_input_schema_version(operation, input).unwrap();
    let digest = mdbase_connect_protocol::mutation_fingerprint_bytes(operation, input).unwrap();
    sqlx::query(
        r#"INSERT INTO hosted_provider_mutation_journal
             (replica_id, request_id, operation_kind, input_schema_version, input_digest,
              state, process_epoch, lease_owner, lease_expires_at, fencing_generation,
              prepared_head, accepted_at)
           SELECT $1, $2, $3, $4, $5, 'prepared', $6, $6,
                  now() + $7::interval, 1, head, now() - $8::interval
           FROM hosted_provider_collections WHERE id = $9"#,
    )
    .bind(replica_id)
    .bind(request_id)
    .bind(kind)
    .bind(i32::try_from(version).unwrap())
    .bind(digest.to_vec())
    .bind(Uuid::now_v7())
    .bind(lease_expires_in)
    .bind(accepted_ago)
    .bind(collection_id)
    .execute(pool)
    .await
    .unwrap();
    request_id
}

async fn journal_state(pool: &PgPool, replica_id: Uuid, request_id: Uuid) -> String {
    sqlx::query_scalar(
        "SELECT state FROM hosted_provider_mutation_journal WHERE replica_id = $1 AND request_id = $2",
    )
    .bind(replica_id)
    .bind(request_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn set_collection_state(pool: &PgPool, collection_id: Uuid, state: &str) {
    sqlx::query(
        "UPDATE hosted_provider_collections SET state = $2, \
         legacy_retain_until = CASE WHEN $2 = 'migrated' THEN now() + interval '90 days' END \
         WHERE id = $1",
    )
    .bind(collection_id)
    .bind(state)
    .execute(pool)
    .await
    .unwrap();
}

async fn replay_error(
    provider: &HostedProvider,
    collection_id: Uuid,
    token: &str,
    operation: &str,
    request_id: Uuid,
    input: &Value,
) -> mdbase_connect_hosted_provider::ApiError {
    provider
        .operation(
            collection_id,
            token,
            operation,
            request_id,
            input.clone(),
            None,
        )
        .await
        .unwrap_err()
}

fn create_input(path: &str) -> Value {
    json!({ "path": path, "frontmatter": {"title": "Draft"}, "body": "Draft.\n" })
}

fn put_timer_input() -> Value {
    json!({
        "namespace": "reminders",
        "criterion_id": "due",
        "timer": { "id": "task-1", "fire_at": "2030-01-01T00:00:00Z" },
    })
}

fn reconcile_timers_input() -> Value {
    json!({
        "namespace": "reminders",
        "criterion_id": "due",
        "timers": [{ "id": "task-1", "fire_at": "2030-01-01T00:00:00Z" }],
    })
}

fn assert_abandoned(
    error: &mdbase_connect_hosted_provider::ApiError,
    request_id: Uuid,
    application: &str,
) {
    assert_eq!(error.code, "mutation_abandoned", "{error:?}");
    assert_eq!(error.status.as_u16(), 409);
    let details = error.details.as_ref().unwrap();
    assert_eq!(details["request_id"], request_id.to_string());
    assert_eq!(details["application"], application);
}

const COUNTS: &[&str] = &[
    "abandoned_not_applied",
    "abandoned_unverified",
    "skipped_migrating",
    "skipped_other_inactive",
    "skipped_unprovable_kind",
    "failed_key_unwrap",
    "errors",
];

fn counts(sweep: HostedMutationSweep) -> Value {
    serde_json::to_value(sweep).unwrap()
}

/// The full counts object: the named counts, every other count zero.
fn expected(nonzero: &[(&str, u64)]) -> Value {
    let map = COUNTS
        .iter()
        .map(|name| {
            let value = nonzero
                .iter()
                .find(|(key, _)| key == name)
                .map_or(0, |(_, n)| *n);
            ((*name).to_string(), json!(value))
        })
        .collect::<serde_json::Map<_, _>>();
    Value::Object(map)
}

async fn sweep(provider: &HostedProvider) -> HostedMutationSweep {
    provider
        .sweep_abandoned_operation_mutations(100)
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn expired_unguarded_timer_requests_are_abandoned_on_takeover_without_running() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let (replica_id, token) = application(&fixture).await;
    // This provider has no timer runtime, so any re-run of the stale input
    // would end in `notifications_unavailable`. A `mutation_abandoned` answer
    // proves the takeover never reached the timer store, so a newer timer
    // change made since cannot be overwritten by the old input.
    let unguarded = [
        ("put_timer", put_timer_input()),
        ("reconcile_timers", reconcile_timers_input()),
        (
            "cancel_timer",
            json!({ "namespace": "reminders", "id": "task-1" }),
        ),
    ];
    for (operation, input) in unguarded {
        let request_id = prepared(
            &fixture.pool,
            fixture.collection_id,
            replica_id,
            operation,
            &input,
            "-1 minute",
            "1 minute",
        )
        .await;
        let error = replay_error(
            &fixture.provider,
            fixture.collection_id,
            &token,
            operation,
            request_id,
            &input,
        )
        .await;
        assert_abandoned(&error, request_id, "unverified");
        assert_eq!(
            journal_state(&fixture.pool, replica_id, request_id).await,
            "abandoned",
            "{operation}"
        );
        // The abandoned receipt is final and replays exactly.
        let replay = replay_error(
            &fixture.provider,
            fixture.collection_id,
            &token,
            operation,
            request_id,
            &input,
        )
        .await;
        assert_abandoned(&replay, request_id, "unverified");
        assert_eq!(replay.message, error.message);
    }

    // A generation-guarded cancel cannot remove a newer timer: it is still
    // taken over and re-run as before.
    let input = json!({ "namespace": "reminders", "id": "task-1", "generation": 3 });
    let request_id = prepared(
        &fixture.pool,
        fixture.collection_id,
        replica_id,
        "cancel_timer",
        &input,
        "-1 minute",
        "1 minute",
    )
    .await;
    let error = replay_error(
        &fixture.provider,
        fixture.collection_id,
        &token,
        "cancel_timer",
        request_id,
        &input,
    )
    .await;
    assert_eq!(error.code, "notifications_unavailable", "{error:?}");
    assert_eq!(
        journal_state(&fixture.pool, replica_id, request_id).await,
        "completed"
    );
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn sweep_abandons_only_expired_old_prepared_rows_with_final_receipts() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let (replica_id, token) = application(&fixture).await;
    let pool = &fixture.pool;
    let collection = fixture.collection_id;

    let create = create_input("drafts/abandoned.md");
    let old_create = prepared(
        pool,
        collection,
        replica_id,
        "create",
        &create,
        "-1 minute",
        "2 days",
    )
    .await;
    let timer = put_timer_input();
    let old_timer = prepared(
        pool,
        collection,
        replica_id,
        "put_timer",
        &timer,
        "-1 minute",
        "2 days",
    )
    .await;
    // Not swept: a live lease, and a row younger than a day.
    let live = prepared(
        pool,
        collection,
        replica_id,
        "create",
        &create_input("drafts/live.md"),
        "1 minute",
        "2 days",
    )
    .await;
    let young = prepared(
        pool,
        collection,
        replica_id,
        "create",
        &create_input("drafts/young.md"),
        "-1 minute",
        "23 hours",
    )
    .await;
    // Not provable from the journal alone.
    let cancel = json!({ "namespace": "reminders", "id": "task-1" });
    let old_cancel = prepared(
        pool,
        collection,
        replica_id,
        "cancel_timer",
        &cancel,
        "-1 minute",
        "2 days",
    )
    .await;
    let delete_file = json!({ "type": "delete_file", "path": "files/a.bin" });
    let old_file = prepared(
        pool,
        collection,
        replica_id,
        "file_control",
        &delete_file,
        "-1 minute",
        "2 days",
    )
    .await;

    // A create whose record exists contradicts `prepared` and is left alone.
    let created_input = create_input("drafts/created.md");
    let created = Uuid::now_v7();
    fixture
        .provider
        .operation(collection, &token, "create", created, created_input, None)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE hosted_provider_mutation_journal SET state = 'prepared', \
         final_receipt_ciphertext = NULL, receipt_digest = NULL, completed_at = NULL, \
         evidence_ciphertext = NULL, evidence_kind = NULL, \
         lease_expires_at = now() - interval '1 minute', accepted_at = now() - interval '2 days' \
         WHERE replica_id = $1 AND request_id = $2",
    )
    .bind(replica_id)
    .bind(created)
    .execute(pool)
    .await
    .unwrap();

    assert_eq!(
        counts(sweep(&fixture.provider).await),
        expected(&[
            ("abandoned_not_applied", 1),
            ("abandoned_unverified", 1),
            ("skipped_unprovable_kind", 3)
        ])
    );
    for (request_id, state) in [
        (old_create, "abandoned"),
        (old_timer, "abandoned"),
        (live, "prepared"),
        (young, "prepared"),
        (old_cancel, "prepared"),
        (old_file, "prepared"),
        (created, "prepared"),
    ] {
        assert_eq!(journal_state(pool, replica_id, request_id).await, state);
    }

    // Recovery of the swept requests gets the final abandoned receipt.
    let error = replay_error(
        &fixture.provider,
        collection,
        &token,
        "create",
        old_create,
        &create,
    )
    .await;
    assert_abandoned(&error, old_create, "not_applied");
    let error = replay_error(
        &fixture.provider,
        collection,
        &token,
        "put_timer",
        old_timer,
        &timer,
    )
    .await;
    assert_abandoned(&error, old_timer, "unverified");
    let record: Option<Uuid> = sqlx::query_scalar(
        "SELECT record_id FROM hosted_provider_records WHERE collection_id = $1 AND record_id = $2",
    )
    .bind(collection)
    .bind(old_create)
    .fetch_optional(pool)
    .await
    .unwrap();
    assert_eq!(record, None, "an abandoned create never ran");

    // A second tick changes nothing.
    assert_eq!(
        counts(sweep(&fixture.provider).await),
        expected(&[("skipped_unprovable_kind", 3)])
    );
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn sweep_skips_migrating_and_inactive_collections_and_waits_for_a_move_to_migrating() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let (replica_id, _) = application(&fixture).await;
    let pool = &fixture.pool;
    let collection = fixture.collection_id;
    let request_id = prepared(
        pool,
        collection,
        replica_id,
        "create",
        &create_input("drafts/held.md"),
        "-1 minute",
        "2 days",
    )
    .await;

    set_collection_state(pool, collection, "migrating").await;
    assert_eq!(
        counts(sweep(&fixture.provider).await),
        expected(&[("skipped_migrating", 1)])
    );
    set_collection_state(pool, collection, "indexing").await;
    assert_eq!(
        counts(sweep(&fixture.provider).await),
        expected(&[("skipped_other_inactive", 1)])
    );
    set_collection_state(pool, collection, "active").await;

    // A migration fence that holds the collection row first: the sweep waits
    // on its FOR SHARE lock, then sees `migrating` and leaves the row alone.
    let mut fence = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM hosted_provider_collections WHERE id = $1 FOR UPDATE")
        .bind(collection)
        .fetch_one(&mut *fence)
        .await
        .unwrap();
    sqlx::query("UPDATE hosted_provider_collections SET state = 'migrating' WHERE id = $1")
        .bind(collection)
        .execute(&mut *fence)
        .await
        .unwrap();
    let provider = fixture.provider.clone();
    let sweeping = tokio::spawn(async move { sweep(&provider).await });
    wait_for_query_blocked(pool, "FOR SHARE").await;
    assert!(!sweeping.is_finished());
    fence.commit().await.unwrap();
    assert_eq!(
        counts(sweeping.await.unwrap()),
        expected(&[("skipped_migrating", 1)])
    );
    assert_eq!(
        journal_state(pool, replica_id, request_id).await,
        "prepared"
    );
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn sweep_closes_expired_rows_of_migrated_collections() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let (replica_id, _) = application(&fixture).await;
    let pool = &fixture.pool;
    let request_id = prepared(
        pool,
        fixture.collection_id,
        replica_id,
        "create",
        &create_input("drafts/migrated.md"),
        "-1 minute",
        "2 days",
    )
    .await;
    set_collection_state(pool, fixture.collection_id, "migrated").await;
    assert_eq!(
        counts(sweep(&fixture.provider).await),
        expected(&[("abandoned_not_applied", 1)])
    );
    let row = sqlx::query(
        "SELECT state, final_receipt_ciphertext IS NOT NULL AS receipt, fencing_generation \
         FROM hosted_provider_mutation_journal WHERE replica_id = $1 AND request_id = $2",
    )
    .bind(replica_id)
    .bind(request_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(row.get::<String, _>("state"), "abandoned");
    assert!(row.get::<bool, _>("receipt"));
    assert_eq!(
        row.get::<i64, _>("fencing_generation"),
        2,
        "the sweep fenced the old owner"
    );
}

/// The physical notification runtime tables the drain reads (as in
/// `legacy_migration.rs`), with no runtime behind them.
async fn notification_projection(pool: &PgPool) {
    sqlx::raw_sql(
        r#"
        CREATE TABLE IF NOT EXISTS mdbase_runtime_schema (singleton boolean PRIMARY KEY CHECK(singleton), version integer);
        INSERT INTO mdbase_runtime_schema VALUES(TRUE,2) ON CONFLICT DO NOTHING;
        CREATE TABLE IF NOT EXISTS mdbase_runtime_timers (
            namespace text, id text, generation bigint, status text, fire_at timestamptz,
            lease_token text, lease_worker text, lease_expires_at timestamptz, PRIMARY KEY(namespace,id));
        CREATE TABLE IF NOT EXISTS mdbase_runtime_runs (
            namespace text, id text, revision bigint, status text, executor text,
            workflow text, trigger_id text, created_at timestamptz, not_before timestamptz,
            lease_token text, lease_worker text, lease_expires_at timestamptz, record_json jsonb,
            PRIMARY KEY(namespace,id));
        CREATE TABLE IF NOT EXISTS mdbase_runtime_events (namespace text, cursor bigint, PRIMARY KEY(namespace,cursor));
        "#,
    )
    .execute(pool)
    .await
    .unwrap();
}

/// Rollback path: a sweep of a `migrated` collection changes its `unresolved`
/// count, but a later `migrated -> migrating` keeps `retain_until`, which the
/// control plane's original-archive recheck refuses on its own; and the sweep
/// never runs while the collection is `migrating`.
#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn sweep_after_cutover_cannot_match_the_original_migrating_source() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let (replica_id, _) = application(&fixture).await;
    notification_projection(&fixture.pool).await;
    let provider = &fixture.provider;
    let id = fixture.collection_id;
    prepared(
        &fixture.pool,
        id,
        replica_id,
        "create",
        &create_input("drafts/cutover.md"),
        "-1 minute",
        "2 days",
    )
    .await;
    provider
        .set_legacy_migration_state(id, "migrating", None, false, &[])
        .await
        .unwrap();
    let original = provider.legacy_migration_drain(id).await.unwrap();
    assert_eq!(original.unresolved, 1);
    assert_eq!(original.retain_until, None);
    assert_eq!(
        counts(sweep(provider).await),
        expected(&[("skipped_migrating", 1)])
    );
    provider
        .set_legacy_migration_state(
            id,
            "migrated",
            Some(chrono::Utc::now() + chrono::Duration::days(120)),
            false,
            &[],
        )
        .await
        .unwrap();
    assert_eq!(
        counts(sweep(provider).await),
        expected(&[("abandoned_not_applied", 1)])
    );
    provider
        .set_legacy_migration_state(id, "migrating", None, false, &[])
        .await
        .unwrap();
    let rolled_back = provider.legacy_migration_drain(id).await.unwrap();
    assert_eq!(rolled_back.state, "migrating");
    assert_eq!(rolled_back.migration_id, original.migration_id);
    assert_eq!(rolled_back.unresolved, 0);
    assert!(
        rolled_back.retain_until.is_some(),
        "a rolled-back cutover keeps retain_until, so it never equals the original source"
    );
}
