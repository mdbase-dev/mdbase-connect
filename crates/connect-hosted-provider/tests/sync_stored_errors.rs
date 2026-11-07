#![allow(dead_code, unused_imports)]

//! A sync mutation whose transaction fails is not given a stored error as its
//! final answer, and failures stored that way by earlier releases reopen.

mod support;
#[path = "support/test_postgres.rs"]
mod test_postgres;

use mdbase_connect_hosted_provider::{ApiError, DiagnosticSection};
use mdbase_connect_protocol::{SyncMutation, SyncMutationOperation, SyncMutationReceipt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use support::FileLifecycleFixture;
use test_postgres::DisposablePostgres;
use uuid::Uuid;

async fn mirror(fixture: &FileLifecycleFixture) -> (Uuid, u64) {
    let row = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1 AND purpose = 'mirror'",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    (
        row.get("id"),
        u64::try_from(row.get::<i64, _>("scope_epoch")).unwrap(),
    )
}

async fn create(fixture: &FileLifecycleFixture, path: &str) -> SyncMutation {
    let (replica_id, scope_epoch) = mirror(fixture).await;
    SyncMutation {
        mutation_id: Uuid::now_v7(),
        replica_id,
        scope_epoch,
        operation: SyncMutationOperation::Put,
        record_id: Uuid::now_v7(),
        base_revision: None,
        path: Some(path.to_string()),
        document: Some(format!(
            "---\ntitle: {path}\n---\nA note large enough to count.\n"
        )),
        created_at: chrono::Utc::now().to_rfc3339(),
        causal_predecessor: None,
    }
}

/// The next edit a client makes once the blocked mutation has gone through.
fn edit(previous: &SyncMutation, revision: &str) -> SyncMutation {
    SyncMutation {
        mutation_id: Uuid::now_v7(),
        base_revision: Some(revision.to_string()),
        document: Some("---\ntitle: edited\n---\nEdited after recovery.\n".to_string()),
        created_at: chrono::Utc::now().to_rfc3339(),
        ..previous.clone()
    }
}

async fn mutate(
    fixture: &FileLifecycleFixture,
    mutation: &SyncMutation,
) -> Result<SyncMutationReceipt, ApiError> {
    fixture
        .provider
        .mutate(
            fixture.collection_id,
            &fixture.token,
            mutation.clone(),
            None,
        )
        .await
}

fn applied_revision(receipt: &SyncMutationReceipt) -> String {
    match receipt {
        SyncMutationReceipt::Applied {
            record: Some(record),
            ..
        } => record.revision.clone(),
        other => panic!("expected an applied receipt, got {other:?}"),
    }
}

struct JournalRow {
    state: String,
    evidence_kind: Option<String>,
    has_final_receipt: bool,
    lease_expired: bool,
}

async fn journal(pool: &PgPool, mutation: &SyncMutation) -> JournalRow {
    let row = sqlx::query(
        r#"SELECT state, evidence_kind, final_receipt_ciphertext IS NOT NULL AS has_final,
                  lease_expires_at <= now() AS lease_expired
           FROM hosted_provider_mutation_journal
           WHERE replica_id = $1 AND request_id = $2"#,
    )
    .bind(mutation.replica_id)
    .bind(mutation.mutation_id)
    .fetch_one(pool)
    .await
    .unwrap();
    JournalRow {
        state: row.get("state"),
        evidence_kind: row.get("evidence_kind"),
        has_final_receipt: row.get("has_final"),
        lease_expired: row.get("lease_expired"),
    }
}

async fn head(fixture: &FileLifecycleFixture) -> i64 {
    sqlx::query_scalar("SELECT head FROM hosted_provider_collections WHERE id = $1")
        .bind(fixture.collection_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap()
}

/// Make the account storage trigger refuse any growth, or lift that limit.
async fn account_storage_full(fixture: &FileLifecycleFixture, full: bool) {
    sqlx::query(
        r#"UPDATE hosted_provider_accounts
           SET max_live_storage_bytes = CASE WHEN $2
             THEN greatest(1, live_content_bytes + live_file_bytes)
             ELSE 1024 * 1024 * 1024 END
           WHERE id = (SELECT account_id FROM hosted_provider_collections WHERE id = $1)"#,
    )
    .bind(fixture.collection_id)
    .bind(full)
    .execute(&fixture.pool)
    .await
    .unwrap();
}

/// A `prepared` row exactly as the sync claim inserts it.
async fn claimed_row(fixture: &FileLifecycleFixture, mutation: &SyncMutation) {
    let input = json!({ "action": "mutate", "mutation": mutation });
    let digest = mdbase_connect_protocol::mutation_fingerprint_bytes("sync", &input).unwrap();
    let version = mdbase_connect_protocol::operation_input_schema_version("sync", &input).unwrap();
    let process = Uuid::now_v7();
    sqlx::query(
        r#"INSERT INTO hosted_provider_mutation_journal
             (replica_id, request_id, operation_kind, input_schema_version, input_digest,
              state, process_epoch, lease_owner, lease_expires_at, fencing_generation,
              prepared_head)
           SELECT $1, $2, 'sync:mutate', $3, $4, 'prepared', $5, $6,
                  now() + interval '30 seconds', 1, head
           FROM hosted_provider_collections WHERE id = $7"#,
    )
    .bind(mutation.replica_id)
    .bind(mutation.mutation_id)
    .bind(i32::try_from(version).unwrap())
    .bind(digest.to_vec())
    .bind(process)
    .bind(Uuid::new_v4())
    .bind(fixture.collection_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
}

/// Close a journal row the way the previous release's
/// `complete_operation_mutation` closed a failed sync mutation: the failure
/// (without details) as the encrypted final receipt, leaving evidence as it was.
async fn store_failure_as_previous_release(
    fixture: &FileLifecycleFixture,
    mutation: &SyncMutation,
    status: u16,
    code: &str,
    message: &str,
) {
    let wrapped: Vec<u8> = sqlx::query_scalar(
        "SELECT wrapped_data_key FROM hosted_provider_collections WHERE id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let data_key = fixture
        .crypto
        .unwrap_data_key(&wrapped, fixture.collection_id)
        .await
        .unwrap();
    // `StoredMutationReceipt::Failure` serialized by serde: tag, then fields
    // in declaration order.
    let plaintext = serde_json::to_vec(&json!({
        "outcome": "failure",
        "status": status,
        "code": code,
        "message": message,
        "details": Value::Null,
    }))
    .unwrap();
    let aad = format!(
        "hosted-provider/mutation-journal/v1/{}/{}",
        mutation.replica_id, mutation.mutation_id
    );
    let ciphertext = fixture
        .crypto
        .encrypt_bytes(&data_key, &plaintext, aad.as_bytes())
        .unwrap();
    let updated = sqlx::query(
        r#"UPDATE hosted_provider_mutation_journal
           SET state = 'completed', final_receipt_ciphertext = $3,
               receipt_digest = $4, completed_at = now(), updated_at = now(),
               lease_expires_at = now()
           WHERE replica_id = $1 AND request_id = $2
             AND state IN ('claimed', 'prepared', 'applied', 'completed')"#,
    )
    .bind(mutation.replica_id)
    .bind(mutation.mutation_id)
    .bind(ciphertext)
    .bind(Sha256::digest(&plaintext).to_vec())
    .execute(&fixture.pool)
    .await
    .unwrap()
    .rows_affected();
    assert_eq!(updated, 1);
}

async fn stored_sync_failures(fixture: &FileLifecycleFixture) -> u64 {
    match fixture
        .provider
        .hosted_diagnostics()
        .await
        .stored_sync_failures
    {
        DiagnosticSection::Ok { value } => value,
        DiagnosticSection::Unavailable { reason } => panic!("diagnostic unavailable: {reason}"),
    }
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn transaction_error_releases_the_lease_and_the_retry_applies() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let mutation = create(&fixture, "quota.md").await;

    account_storage_full(&fixture, true).await;
    for _ in 0..2 {
        // Each attempt runs again: the quota error is neither stored nor
        // hidden behind a live lease.
        let error = mutate(&fixture, &mutation).await.unwrap_err();
        assert_eq!(error.status.as_u16(), 429);
        assert_eq!(error.code, "account_storage_quota_exceeded");
        let row = journal(&fixture.pool, &mutation).await;
        assert_eq!(row.state, "prepared");
        assert!(!row.has_final_receipt);
        assert!(row.lease_expired);
    }
    assert_eq!(stored_sync_failures(&fixture).await, 0);

    account_storage_full(&fixture, false).await;
    let receipt = mutate(&fixture, &mutation).await.unwrap();
    let revision = applied_revision(&receipt);
    let row = journal(&fixture.pool, &mutation).await;
    assert_eq!(row.state, "completed");
    assert_eq!(row.evidence_kind.as_deref(), Some("public_result"));
    // The same ID now replays the applied receipt.
    assert_eq!(
        serde_json::to_value(mutate(&fixture, &mutation).await.unwrap()).unwrap(),
        serde_json::to_value(&receipt).unwrap()
    );
    // And the client moves on to its next edit.
    applied_revision(&mutate(&fixture, &edit(&mutation, &revision)).await.unwrap());
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn commit_error_releases_the_lease_and_the_retry_applies() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let mutation = create(&fixture, "commit.md").await;
    // A deferred constraint trigger fails the transaction at COMMIT, after
    // every statement (including the applied evidence) has succeeded.
    sqlx::raw_sql(
        r#"CREATE FUNCTION test_fail_commit() RETURNS trigger AS $$
           BEGIN RAISE EXCEPTION 'test commit failure'; END $$ LANGUAGE plpgsql;
           CREATE CONSTRAINT TRIGGER test_fail_commit
             AFTER INSERT ON hosted_provider_changes
             DEFERRABLE INITIALLY DEFERRED
             FOR EACH ROW EXECUTE FUNCTION test_fail_commit();"#,
    )
    .execute(&fixture.pool)
    .await
    .unwrap();
    let before = head(&fixture).await;

    let error = mutate(&fixture, &mutation).await.unwrap_err();
    assert_eq!(error.status.as_u16(), 500);
    let row = journal(&fixture.pool, &mutation).await;
    assert_eq!(row.state, "prepared");
    assert_eq!(row.evidence_kind, None);
    assert!(!row.has_final_receipt);
    assert!(row.lease_expired);
    assert_eq!(head(&fixture).await, before);

    sqlx::raw_sql("DROP TRIGGER test_fail_commit ON hosted_provider_changes")
        .execute(&fixture.pool)
        .await
        .unwrap();
    let revision = applied_revision(&mutate(&fixture, &mutation).await.unwrap());
    assert_eq!(head(&fixture).await, before + 1);
    applied_revision(&mutate(&fixture, &edit(&mutation, &revision)).await.unwrap());
}

/// The required upgrade test: rows written exactly as the previous release
/// wrote them for each transient failure class reopen on the next retry.
#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn transient_failures_stored_by_the_previous_release_reopen() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let classes = [
        (
            429,
            "account_storage_quota_exceeded",
            "The change would exceed the account's hosted storage limit.",
        ),
        (
            503,
            "provider_database_timeout",
            "The hosted provider database is busy. Retry the request.",
        ),
        (
            500,
            "provider_internal_error",
            "The hosted provider could not access its authoritative store.",
        ),
        (401, "invalid_replica_token", "Replica token is invalid."),
        (
            404,
            "hosted_collection_not_found",
            "Hosted collection not found.",
        ),
    ];
    for (index, (status, code, message)) in classes.into_iter().enumerate() {
        let mutation = create(&fixture, &format!("stored-{index}.md")).await;
        claimed_row(&fixture, &mutation).await;
        store_failure_as_previous_release(&fixture, &mutation, status, code, message).await;
        let row = journal(&fixture.pool, &mutation).await;
        assert_eq!((row.state.as_str(), row.evidence_kind), ("completed", None));
        assert_eq!(stored_sync_failures(&fixture).await, 1, "{code}");

        let before = head(&fixture).await;
        let receipt = mutate(&fixture, &mutation).await.unwrap();
        let revision = applied_revision(&receipt);
        assert_eq!(head(&fixture).await, before + 1, "{code}");
        assert_eq!(stored_sync_failures(&fixture).await, 0, "{code}");
        let row = journal(&fixture.pool, &mutation).await;
        assert_eq!(row.state, "completed");
        assert_eq!(row.evidence_kind.as_deref(), Some("public_result"));
        applied_revision(&mutate(&fixture, &edit(&mutation, &revision)).await.unwrap());
    }
}

/// A stored quota failure reopens even while the account is still full: the
/// retry gets a live 429 that is not stored, and the mutation applies once
/// space is freed.
#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn stored_quota_failure_waits_for_space_then_applies() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let mutation = create(&fixture, "full.md").await;
    claimed_row(&fixture, &mutation).await;
    store_failure_as_previous_release(
        &fixture,
        &mutation,
        429,
        "account_storage_quota_exceeded",
        "The change would exceed the account's hosted storage limit.",
    )
    .await;

    account_storage_full(&fixture, true).await;
    let error = mutate(&fixture, &mutation).await.unwrap_err();
    assert_eq!(error.code, "account_storage_quota_exceeded");
    let row = journal(&fixture.pool, &mutation).await;
    assert_eq!(row.state, "prepared");
    assert!(row.lease_expired);
    assert_eq!(stored_sync_failures(&fixture).await, 0);

    account_storage_full(&fixture, false).await;
    applied_revision(&mutate(&fixture, &mutation).await.unwrap());
}

/// The previous release could store an error over an `applied` row when the
/// commit reported failure after it had landed. The retry replays the applied
/// receipt from its evidence and does not apply the mutation twice.
#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn error_stored_over_an_applied_row_replays_the_applied_receipt() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let mutation = create(&fixture, "landed.md").await;
    let receipt = mutate(&fixture, &mutation).await.unwrap();
    let revision = applied_revision(&receipt);
    let after = head(&fixture).await;
    store_failure_as_previous_release(
        &fixture,
        &mutation,
        500,
        "provider_internal_error",
        "The hosted provider could not access its authoritative store.",
    )
    .await;
    assert_eq!(
        journal(&fixture.pool, &mutation)
            .await
            .evidence_kind
            .as_deref(),
        Some("public_result")
    );

    let replayed = mutate(&fixture, &mutation).await.unwrap();
    assert_eq!(
        serde_json::to_value(&replayed).unwrap(),
        serde_json::to_value(&receipt).unwrap()
    );
    assert_eq!(head(&fixture).await, after);
    assert_eq!(journal(&fixture.pool, &mutation).await.state, "completed");
    applied_revision(&mutate(&fixture, &edit(&mutation, &revision)).await.unwrap());
}

/// 400 and 403 failures were deterministic for that exact mutation; they stay
/// final and are replayed unchanged.
#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn deterministic_stored_failures_stay_final() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    for (index, (status, code)) in [(400, "invalid_mutation"), (403, "replica_scope_denied")]
        .into_iter()
        .enumerate()
    {
        let mutation = create(&fixture, &format!("final-{index}.md")).await;
        claimed_row(&fixture, &mutation).await;
        store_failure_as_previous_release(&fixture, &mutation, status, code, "Refused.").await;
        let before = head(&fixture).await;
        let error = mutate(&fixture, &mutation).await.unwrap_err();
        assert_eq!((error.status.as_u16(), error.code.as_str()), (status, code));
        assert_eq!(head(&fixture).await, before);
        assert_eq!(journal(&fixture.pool, &mutation).await.state, "completed");
    }
}

/// The diagnostic counts only current-format sync rows closed by a stored
/// error, and adds a section that sorts between `storage` and
/// `unfinished_mutations`, which the operator tooling expects to stay last.
#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn stored_sync_failure_diagnostic_counts_only_stored_errors() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    assert_eq!(stored_sync_failures(&fixture).await, 0);

    // Counted: a stored error.
    let stored = create(&fixture, "counted.md").await;
    claimed_row(&fixture, &stored).await;
    store_failure_as_previous_release(&fixture, &stored, 503, "provider_database_timeout", "Busy.")
        .await;
    // Not counted: an applied mutation, a still-prepared one, and the same
    // row shape under another kind or as a migrated legacy receipt.
    applied_revision(
        &mutate(&fixture, &create(&fixture, "applied.md").await)
            .await
            .unwrap(),
    );
    claimed_row(&fixture, &create(&fixture, "open.md").await).await;
    let (replica_id, _) = mirror(&fixture).await;
    for (kind, fingerprint) in [("create", 1), ("sync:mutate", 0)] {
        sqlx::query(
            r#"INSERT INTO hosted_provider_mutation_journal
                 (replica_id, request_id, operation_kind, fingerprint_schema_version,
                  input_schema_version, input_digest, state, process_epoch, lease_owner,
                  lease_expires_at, fencing_generation, final_receipt_ciphertext,
                  receipt_digest, completed_at)
               VALUES ($1, $2, $3, $4, 1, $5, 'completed', $6, $6, now(), 1,
                       '\x00', '\x00', now())"#,
        )
        .bind(replica_id)
        .bind(Uuid::now_v7())
        .bind(kind)
        .bind(fingerprint)
        .bind(vec![9_u8; 32])
        .bind(Uuid::now_v7())
        .execute(&fixture.pool)
        .await
        .unwrap();
    }
    assert_eq!(stored_sync_failures(&fixture).await, 1);

    // The HTTP handler serializes through `json!`, which sorts keys.
    let serialized =
        json!({ "diagnostics": fixture.provider.hosted_diagnostics().await }).to_string();
    let section = r#""stored_sync_failures":{"state":"ok","value":1}"#;
    let at = serialized.find(section).expect("section present");
    assert!(serialized.find(r#""storage":"#).unwrap() < at);
    assert!(at < serialized.find(r#""unfinished_mutations":"#).unwrap());
    assert!(!serialized.contains(&stored.mutation_id.to_string()));
    assert!(!serialized.contains(&replica_id.to_string()));
}

/// Keep an owner's lease live for the rest of the test.
async fn hold_lease(fixture: &FileLifecycleFixture, mutation: &SyncMutation) {
    sqlx::query(
        "UPDATE hosted_provider_mutation_journal SET lease_expires_at = now() + interval '1 hour' WHERE request_id = $1",
    )
    .bind(mutation.mutation_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
}

fn diagnostics_section(diagnostics: &Value, section: &str) -> Value {
    assert_eq!(diagnostics[section]["state"], "ok", "{section}");
    diagnostics[section]["value"].clone()
}

/// Released sync mutations leave the unfinished, stale and expired-lease
/// counts and the unfinished breakdown, and are reported as their own count.
/// A sync mutation whose owner still holds its lease is still unfinished.
#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn released_sync_mutations_are_counted_apart_from_unfinished_work() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let released = create(&fixture, "released.md").await;
    account_storage_full(&fixture, true).await;
    mutate(&fixture, &released).await.unwrap_err();
    account_storage_full(&fixture, false).await;
    let live = create(&fixture, "live.md").await;
    claimed_row(&fixture, &live).await;
    hold_lease(&fixture, &live).await;
    // Both are days old, well past the 120-second stale threshold.
    sqlx::query(
        r#"UPDATE hosted_provider_mutation_journal
           SET accepted_at = now() - interval '3 days',
               updated_at = now() - interval '3 days'
           WHERE operation_kind = 'sync:mutate'"#,
    )
    .execute(&fixture.pool)
    .await
    .unwrap();

    let diagnostics = serde_json::to_value(fixture.provider.hosted_diagnostics().await).unwrap();
    assert_eq!(
        diagnostics_section(&diagnostics, "released_sync_mutations"),
        1
    );
    let journal = &diagnostics_section(&diagnostics, "lifecycle_work")["mutation_journal"];
    assert_eq!(journal["unfinished"], 1, "{journal}");
    assert_eq!(journal["stale"], 1, "{journal}");
    assert_eq!(journal["expired_leases"], 0, "{journal}");
    let breakdown = diagnostics_section(&diagnostics, "unfinished_mutations");
    assert_eq!(
        breakdown,
        json!([{ "age_band": "1d_to_7d", "count": 1, "evidence_kind": "none",
                 "operation_kind": "sync:mutate", "state": "prepared" }])
    );

    // Once the live owner's lease lapses without a receipt, that row is
    // released too.
    sqlx::query(
        "UPDATE hosted_provider_mutation_journal SET lease_expires_at = now() WHERE request_id = $1",
    )
    .bind(live.mutation_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let diagnostics = json!({ "diagnostics": fixture.provider.hosted_diagnostics().await });
    let sections = &diagnostics["diagnostics"];
    assert_eq!(diagnostics_section(sections, "released_sync_mutations"), 2);
    let journal = &diagnostics_section(sections, "lifecycle_work")["mutation_journal"];
    assert_eq!(
        (
            &journal["unfinished"],
            &journal["stale"],
            &journal["expired_leases"]
        ),
        (&json!(0), &json!(0), &json!(0))
    );
    assert_eq!(
        diagnostics_section(sections, "unfinished_mutations"),
        json!([])
    );

    // A single count that sorts between `recent_resource_changes` and
    // `schema_version`, leaving the sections the operator tooling matches on
    // where they were. `json!` sorts keys, as the HTTP handler does.
    let serialized = diagnostics.to_string();
    let section = r#""released_sync_mutations":{"state":"ok","value":2}"#;
    let at = serialized.find(section).expect("section present");
    assert!(serialized.find(r#""recent_resource_changes":"#).unwrap() < at);
    assert!(at < serialized.find(r#""schema_version":"#).unwrap());
    assert!(serialized
        .contains(r#""stored_sync_failures":{"state":"ok","value":0},"unfinished_mutations":"#));
    assert!(!serialized.contains(&released.mutation_id.to_string()));
}

/// Make the final receipt write fail after the mutation's own transaction
/// has committed, or stop doing so.
async fn fail_completion(fixture: &FileLifecycleFixture, fail: bool) {
    let sql = if fail {
        r#"CREATE FUNCTION test_fail_completion() RETURNS trigger AS $$
           BEGIN RAISE EXCEPTION 'test completion failure'; END $$ LANGUAGE plpgsql;
           CREATE TRIGGER test_fail_completion
             BEFORE UPDATE ON hosted_provider_mutation_journal
             FOR EACH ROW WHEN (OLD.state = 'applied' AND NEW.state = 'completed')
             EXECUTE FUNCTION test_fail_completion();"#
    } else {
        "DROP TRIGGER test_fail_completion ON hosted_provider_mutation_journal;
         DROP FUNCTION test_fail_completion();"
    };
    sqlx::raw_sql(sql).execute(&fixture.pool).await.unwrap();
}

/// Six weeks later: compaction deletes a released sync row once it is 30
/// days old, and the same mutation ID resent afterwards claims a fresh row
/// and applies exactly once. Rows the rule must keep survive it: one whose
/// owner holds a live lease, and one whose transaction committed (it carries
/// evidence, so it is never released).
#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn compaction_deletes_old_released_rows_and_a_later_retry_applies_once() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let released = create(&fixture, "asleep.md").await;
    account_storage_full(&fixture, true).await;
    mutate(&fixture, &released).await.unwrap_err();
    account_storage_full(&fixture, false).await;
    let live = create(&fixture, "live.md").await;
    claimed_row(&fixture, &live).await;
    hold_lease(&fixture, &live).await;
    // Committed, then the final receipt failed: `applied` with evidence.
    let committed = create(&fixture, "committed.md").await;
    fail_completion(&fixture, true).await;
    mutate(&fixture, &committed).await.unwrap_err();
    fail_completion(&fixture, false).await;
    sqlx::query(
        "UPDATE hosted_provider_mutation_journal SET lease_expires_at = now() WHERE request_id = $1",
    )
    .bind(committed.mutation_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let row = journal(&fixture.pool, &committed).await;
    assert_eq!(
        (row.state.as_str(), row.evidence_kind.as_deref()),
        ("applied", Some("public_result"))
    );
    let exists = |mutation: SyncMutation| {
        let pool = fixture.pool.clone();
        async move {
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS (SELECT 1 FROM hosted_provider_mutation_journal WHERE request_id = $1)",
            )
            .bind(mutation.mutation_id)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    let age = |days: i32| {
        let pool = fixture.pool.clone();
        async move {
            sqlx::query(
                r#"UPDATE hosted_provider_mutation_journal
                   SET accepted_at = now() - make_interval(days => $1),
                       updated_at = now() - make_interval(days => $1)
                   WHERE operation_kind = 'sync:mutate'"#,
            )
            .bind(days)
            .execute(&pool)
            .await
            .unwrap();
        }
    };

    age(29).await;
    assert_eq!(
        fixture
            .provider
            .compact_operation_mutations()
            .await
            .unwrap(),
        0
    );
    assert!(exists(released.clone()).await);

    age(42).await;
    assert_eq!(
        fixture
            .provider
            .compact_operation_mutations()
            .await
            .unwrap(),
        1
    );
    assert!(!exists(released.clone()).await);
    assert!(exists(live.clone()).await);
    assert!(exists(committed.clone()).await);

    // The laptop wakes and resends the same mutation with the same input.
    let before = head(&fixture).await;
    let receipt = mutate(&fixture, &released).await.unwrap();
    let revision = applied_revision(&receipt);
    assert_eq!(head(&fixture).await, before + 1);
    let changes = || {
        let pool = fixture.pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM hosted_provider_changes WHERE collection_id = $1 AND record_id = $2",
            )
            .bind(fixture.collection_id)
            .bind(released.record_id)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    assert_eq!(changes().await, 1);
    assert_eq!(
        serde_json::to_value(mutate(&fixture, &released).await.unwrap()).unwrap(),
        serde_json::to_value(&receipt).unwrap()
    );
    assert_eq!(head(&fixture).await, before + 1);
    assert_eq!(changes().await, 1);
    applied_revision(&mutate(&fixture, &edit(&released, &revision)).await.unwrap());

    // The committed one replays its effect rather than running again.
    let before = head(&fixture).await;
    applied_revision(&mutate(&fixture, &committed).await.unwrap());
    assert_eq!(head(&fixture).await, before);
}
