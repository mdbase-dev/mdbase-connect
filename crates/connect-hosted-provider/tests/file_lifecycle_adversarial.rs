mod support;

use std::sync::Arc;

use mdbase_connect_hosted_provider::{HostedBackupAdmin, HostedProvider};
use sqlx::Executor;
use support::{
    assert_storage_consistent, wait_for_database_condition, wait_for_query_blocked, CopyCheckpoint,
    FileLifecycleFixture,
};
use uuid::Uuid;

/// Runs against a disposable PostgreSQL instance created by
/// `pnpm e2e:files:adversarial`. Keeping the scenarios in one test prevents
/// table-level scheduling controls from interfering with one another, while
/// every scenario still gets an isolated collection and object namespace.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires MDBASE_ADVERSARIAL_DATABASE_URL; run pnpm e2e:files:adversarial"]
async fn adversarial_file_lifecycle_scenarios() {
    let database_url = std::env::var("MDBASE_ADVERSARIAL_DATABASE_URL")
        .expect("MDBASE_ADVERSARIAL_DATABASE_URL is required");

    commit_wins_abort_loses(&database_url).await;
    commit_wins_expiry_loses(&database_url).await;
    abort_wins_against_late_copy(&database_url).await;
    abort_wins_after_copy_is_visible(&database_url).await;
    expiry_wins_against_late_copy(&database_url).await;
    maintenance_wins_against_late_copy(&database_url).await;
    commit_wins_maintenance_loses(&database_url).await;
    maintenance_recovers_abandoned_open_upload(&database_url).await;
    maintenance_retries_object_deletion_after_outage(&database_url).await;
    backup_hold_fences_in_flight_and_future_deletions(&database_url).await;
    duplicate_commit_is_idempotent(&database_url).await;
    duplicate_commit_across_providers_is_idempotent(&database_url).await;
}

async fn backup_hold_fences_in_flight_and_future_deletions(database_url: &str) {
    let fixture = FileLifecycleFixture::new(database_url).await;
    let in_flight_key = format!("v1/blobs/{}/backup-race", fixture.collection_id);
    fixture.blobs.put(&in_flight_key, b"already queued").await;
    enqueue_test_deletion(&fixture, &in_flight_key).await;
    fixture.blobs.arm_delete().await;

    let provider = fixture.provider.clone();
    let deletion = tokio::spawn(async move { provider.delete_pending_blobs(10).await });
    fixture.blobs.wait_for_delete().await;

    let admin = Arc::new(
        HostedBackupAdmin::connect(database_url)
            .await
            .expect("backup admin connects"),
    );
    let acquiring_admin = Arc::clone(&admin);
    let mut acquire = tokio::spawn(async move { acquiring_admin.acquire(600).await });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(150), &mut acquire)
            .await
            .is_err(),
        "hold acquisition waits for an in-flight object deletion"
    );

    fixture.blobs.release_delete().await;
    assert_eq!(
        deletion
            .await
            .expect("deletion task joins")
            .expect("queued deletion succeeds"),
        1
    );
    assert!(!fixture.blobs.contains(&in_flight_key).await);
    let hold = acquire
        .await
        .expect("hold task joins")
        .expect("hold is acquired after deletion finishes");

    let held_key = format!("v1/blobs/{}/held", fixture.collection_id);
    fixture.blobs.put(&held_key, b"must survive the hold").await;
    enqueue_test_deletion(&fixture, &held_key).await;
    assert_eq!(
        fixture
            .provider
            .delete_pending_blobs(10)
            .await
            .expect("maintenance observes the hold"),
        0
    );
    assert!(fixture.blobs.contains(&held_key).await);
    assert_eq!(
        admin.inspect().await.expect("hold inventory").active_holds,
        1
    );
    assert!(
        !admin
            .release(Uuid::now_v7())
            .await
            .expect("unknown release is idempotent")
            .released
    );
    assert!(
        admin
            .release(hold.hold_id)
            .await
            .expect("hold releases")
            .released
    );
    assert_eq!(
        fixture
            .provider
            .delete_pending_blobs(10)
            .await
            .expect("maintenance resumes after release"),
        1
    );
    assert!(!fixture.blobs.contains(&held_key).await);
}

async fn enqueue_test_deletion(fixture: &FileLifecycleFixture, key: &str) {
    sqlx::query(
        r#"INSERT INTO hosted_provider_blob_deletions
             (object_key, byte_length, reason)
           VALUES ($1, 0, 'backup_hold_test')"#,
    )
    .bind(key)
    .execute(&fixture.pool)
    .await
    .expect("test deletion is queued");
}

async fn commit_wins_abort_loses(database_url: &str) {
    let fixture = FileLifecycleFixture::new(database_url).await;
    let transfer_id = fixture
        .stage_upload(
            "races/commit-wins-abort.bin",
            b"commit must retain this object",
        )
        .await;
    let mut blocker = fixture.pool.begin().await.expect("blocker begins");
    blocker
        .execute("LOCK TABLE hosted_provider_file_changes IN ACCESS EXCLUSIVE MODE")
        .await
        .expect("file change table is locked");

    let commit = spawn_commit(&fixture, transfer_id);
    wait_for_query_blocked(&fixture.pool, "INSERT INTO hosted_provider_file_changes").await;
    let abort = spawn_abort(&fixture, transfer_id);
    wait_for_query_blocked(&fixture.pool, "SET state = 'aborted'").await;

    blocker.commit().await.expect("blocker releases");
    commit
        .await
        .expect("commit task joins")
        .expect("commit wins");
    abort
        .await
        .expect("abort task joins")
        .expect("abort is idempotent");
    assert!(
        fixture
            .blobs
            .contains(&fixture.committed_key(transfer_id))
            .await
    );
    assert_storage_consistent(&fixture.pool, &fixture.blobs, fixture.collection_id).await;
}

async fn commit_wins_expiry_loses(database_url: &str) {
    let fixture = FileLifecycleFixture::new(database_url).await;
    let transfer_id = fixture
        .stage_upload(
            "races/commit-wins-expiry.bin",
            b"commit crosses the expiry boundary",
        )
        .await;
    sqlx::query(
        "UPDATE hosted_provider_file_transfers SET expires_at = now() + interval '750 milliseconds' WHERE id = $1",
    )
    .bind(transfer_id)
    .execute(&fixture.pool)
    .await
    .expect("expiry is brought close");
    let mut blocker = fixture.pool.begin().await.expect("blocker begins");
    blocker
        .execute("LOCK TABLE hosted_provider_file_changes IN ACCESS EXCLUSIVE MODE")
        .await
        .expect("file change table is locked");

    let commit = spawn_commit(&fixture, transfer_id);
    wait_for_query_blocked(&fixture.pool, "INSERT INTO hosted_provider_file_changes").await;
    wait_for_database_condition(&fixture.pool, || {
        let pool = fixture.pool.clone();
        async move {
            sqlx::query_scalar::<_, bool>(
                "SELECT expires_at <= now() FROM hosted_provider_file_transfers WHERE id = $1",
            )
            .bind(transfer_id)
            .fetch_one(&pool)
            .await
            .expect("expiry can be observed")
        }
    })
    .await;
    let expiry = spawn_commit(&fixture, transfer_id);
    wait_for_query_blocked(&fixture.pool, "SET state = 'expired'").await;

    blocker.commit().await.expect("blocker releases");
    commit
        .await
        .expect("commit task joins")
        .expect("commit wins");
    let expiry_error = expiry
        .await
        .expect("expiry task joins")
        .expect_err("the stale expiry attempt reports expiry");
    assert_eq!(expiry_error.code, "file_transfer_expired");
    assert!(
        fixture
            .blobs
            .contains(&fixture.committed_key(transfer_id))
            .await
    );
    assert_storage_consistent(&fixture.pool, &fixture.blobs, fixture.collection_id).await;
}

async fn abort_wins_against_late_copy(database_url: &str) {
    let fixture = FileLifecycleFixture::new(database_url).await;
    let transfer_id = fixture
        .stage_upload("races/abort-wins.bin", b"a late copy must be compensated")
        .await;
    fixture.blobs.arm_copy(CopyCheckpoint::BeforePublish).await;
    let commit = spawn_commit(&fixture, transfer_id);
    fixture.blobs.wait_for_copy().await;

    fixture
        .provider
        .abort_file_transfer(
            fixture.collection_id,
            &fixture.token,
            FileLifecycleFixture::abort_request(transfer_id),
            None,
        )
        .await
        .expect("abort wins");
    fixture.blobs.release_copy().await;
    commit
        .await
        .expect("commit task joins")
        .expect_err("late commit observes cancellation");
    assert_terminal_objects_absent(&fixture, transfer_id).await;
}

async fn expiry_wins_against_late_copy(database_url: &str) {
    let fixture = FileLifecycleFixture::new(database_url).await;
    let transfer_id = fixture
        .stage_upload(
            "races/expiry-wins.bin",
            b"expiry must compensate a late copy",
        )
        .await;
    fixture.blobs.arm_copy(CopyCheckpoint::BeforePublish).await;
    let commit = spawn_commit(&fixture, transfer_id);
    fixture.blobs.wait_for_copy().await;
    sqlx::query("UPDATE hosted_provider_file_transfers SET expires_at = now() - interval '1 second' WHERE id = $1")
        .bind(transfer_id)
        .execute(&fixture.pool)
        .await
        .expect("transfer expires");

    let expiry_error = fixture
        .provider
        .commit_file_upload(
            fixture.collection_id,
            &fixture.token,
            FileLifecycleFixture::commit_request(transfer_id),
            None,
        )
        .await
        .expect_err("expiry wins");
    assert_eq!(expiry_error.code, "file_transfer_expired");
    fixture.blobs.release_copy().await;
    commit
        .await
        .expect("commit task joins")
        .expect_err("late commit observes expiry");
    assert_terminal_objects_absent(&fixture, transfer_id).await;
}

async fn abort_wins_after_copy_is_visible(database_url: &str) {
    let fixture = FileLifecycleFixture::new(database_url).await;
    let transfer_id = fixture
        .stage_upload(
            "races/abort-after-publish.bin",
            b"cleanup races with a visible destination",
        )
        .await;
    fixture.blobs.arm_copy(CopyCheckpoint::AfterPublish).await;
    let commit = spawn_commit(&fixture, transfer_id);
    fixture.blobs.wait_for_copy().await;
    assert!(
        fixture
            .blobs
            .contains(&fixture.committed_key(transfer_id))
            .await
    );

    fixture
        .provider
        .abort_file_transfer(
            fixture.collection_id,
            &fixture.token,
            FileLifecycleFixture::abort_request(transfer_id),
            None,
        )
        .await
        .expect("abort wins");
    fixture.blobs.release_copy().await;
    commit
        .await
        .expect("commit task joins")
        .expect_err("commit observes deleted destination");
    assert_terminal_objects_absent(&fixture, transfer_id).await;
}

async fn maintenance_wins_against_late_copy(database_url: &str) {
    let fixture = FileLifecycleFixture::new(database_url).await;
    let transfer_id = fixture
        .stage_upload(
            "races/maintenance-wins.bin",
            b"maintenance compensates a copy that publishes late",
        )
        .await;
    fixture.blobs.arm_copy(CopyCheckpoint::BeforePublish).await;
    let commit = spawn_commit(&fixture, transfer_id);
    fixture.blobs.wait_for_copy().await;
    expire_transfer(&fixture, transfer_id).await;

    assert_eq!(
        fixture
            .provider
            .recover_expired_file_transfers(10)
            .await
            .expect("maintenance succeeds"),
        1
    );
    fixture.blobs.release_copy().await;
    commit
        .await
        .expect("commit task joins")
        .expect_err("late commit observes maintenance expiry");
    assert_terminal_objects_absent(&fixture, transfer_id).await;
}

async fn commit_wins_maintenance_loses(database_url: &str) {
    let fixture = FileLifecycleFixture::new(database_url).await;
    let transfer_id = fixture
        .stage_upload(
            "races/commit-wins-maintenance.bin",
            b"maintenance skips a finalization holding the transfer row",
        )
        .await;
    sqlx::query(
        "UPDATE hosted_provider_file_transfers SET expires_at = now() + interval '750 milliseconds' WHERE id = $1",
    )
    .bind(transfer_id)
    .execute(&fixture.pool)
    .await
    .expect("expiry is brought close");
    let mut blocker = fixture.pool.begin().await.expect("blocker begins");
    blocker
        .execute("LOCK TABLE hosted_provider_file_changes IN ACCESS EXCLUSIVE MODE")
        .await
        .expect("file change table is locked");
    let commit = spawn_commit(&fixture, transfer_id);
    wait_for_query_blocked(&fixture.pool, "INSERT INTO hosted_provider_file_changes").await;
    wait_until_expired(&fixture, transfer_id).await;

    assert_eq!(
        fixture
            .provider
            .recover_expired_file_transfers(10)
            .await
            .expect("maintenance succeeds"),
        0,
        "SKIP LOCKED leaves in-flight finalization to its owner"
    );
    blocker.commit().await.expect("blocker releases");
    commit
        .await
        .expect("commit task joins")
        .expect("commit wins");
    assert_storage_consistent(&fixture.pool, &fixture.blobs, fixture.collection_id).await;
}

async fn maintenance_recovers_abandoned_open_upload(database_url: &str) {
    let fixture = FileLifecycleFixture::new(database_url).await;
    let transfer_id = fixture
        .stage_upload(
            "races/abandoned-open.bin",
            b"an abandoned staging object is reclaimed",
        )
        .await;
    expire_transfer(&fixture, transfer_id).await;

    assert_eq!(
        fixture
            .provider
            .recover_expired_file_transfers(1)
            .await
            .expect("maintenance succeeds"),
        1
    );
    assert_terminal_objects_absent(&fixture, transfer_id).await;
    let state: String =
        sqlx::query_scalar("SELECT state FROM hosted_provider_file_transfers WHERE id = $1")
            .bind(transfer_id)
            .fetch_one(&fixture.pool)
            .await
            .expect("transfer state can be read");
    assert_eq!(state, "expired");
}

async fn maintenance_retries_object_deletion_after_outage(database_url: &str) {
    let fixture = FileLifecycleFixture::new(database_url).await;
    let transfer_id = fixture
        .stage_upload(
            "races/deletion-outage.bin",
            b"durable deletion intent survives an object-store outage",
        )
        .await;
    expire_transfer(&fixture, transfer_id).await;
    fixture.blobs.fail_next_delete().await;

    assert_eq!(
        fixture
            .provider
            .recover_expired_file_transfers(1)
            .await
            .expect("maintenance persists cleanup despite the object-store failure"),
        1
    );
    let queued: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_blob_deletions WHERE reason = 'file_transfer_cleanup'",
    )
    .fetch_one(&fixture.pool)
    .await
    .expect("durable deletion intent can be read");
    assert!(queued > 0, "failed deletion remains durably queued");

    fixture
        .provider
        .delete_pending_blobs(10)
        .await
        .expect("a later maintenance pass drains the queue");
    assert_terminal_objects_absent(&fixture, transfer_id).await;
}

async fn duplicate_commit_is_idempotent(database_url: &str) {
    let fixture = FileLifecycleFixture::new(database_url).await;
    let transfer_id = fixture
        .stage_upload("races/duplicate-commit.bin", b"one logical commit")
        .await;
    let first = spawn_commit(&fixture, transfer_id);
    let second = spawn_commit(&fixture, transfer_id);
    let first = first
        .await
        .expect("first task joins")
        .expect("first succeeds");
    let second = second
        .await
        .expect("second task joins")
        .expect("second succeeds");
    assert_eq!(
        first, second,
        "duplicate commits return the durable receipt"
    );
    assert_storage_consistent(&fixture.pool, &fixture.blobs, fixture.collection_id).await;
}

async fn duplicate_commit_across_providers_is_idempotent(database_url: &str) {
    let fixture = FileLifecycleFixture::new(database_url).await;
    let transfer_id = fixture
        .stage_upload(
            "races/multi-provider-commit.bin",
            b"providers coordinate through durable state",
        )
        .await;
    let other = fixture.another_provider(database_url).await;
    let first = spawn_commit(&fixture, transfer_id);
    let second = spawn_provider_commit(
        other,
        fixture.collection_id,
        fixture.token.clone(),
        transfer_id,
    );
    let first = first
        .await
        .expect("first provider task joins")
        .expect("first provider succeeds");
    let second = second
        .await
        .expect("second provider task joins")
        .expect("second provider succeeds");
    assert_eq!(first, second, "providers return the same durable receipt");
    assert_storage_consistent(&fixture.pool, &fixture.blobs, fixture.collection_id).await;
}

fn spawn_commit(
    fixture: &FileLifecycleFixture,
    transfer_id: Uuid,
) -> tokio::task::JoinHandle<
    mdbase_connect_hosted_provider::ApiResult<mdbase_connect_protocol::CommitFileUploadReceipt>,
> {
    let provider = fixture.provider.clone();
    let collection_id = fixture.collection_id;
    let token = fixture.token.clone();
    tokio::spawn(async move {
        provider
            .commit_file_upload(
                collection_id,
                &token,
                FileLifecycleFixture::commit_request(transfer_id),
                None,
            )
            .await
    })
}

fn spawn_provider_commit(
    provider: HostedProvider,
    collection_id: Uuid,
    token: String,
    transfer_id: Uuid,
) -> tokio::task::JoinHandle<
    mdbase_connect_hosted_provider::ApiResult<mdbase_connect_protocol::CommitFileUploadReceipt>,
> {
    tokio::spawn(async move {
        provider
            .commit_file_upload(
                collection_id,
                &token,
                FileLifecycleFixture::commit_request(transfer_id),
                None,
            )
            .await
    })
}

fn spawn_abort(
    fixture: &FileLifecycleFixture,
    transfer_id: Uuid,
) -> tokio::task::JoinHandle<
    mdbase_connect_hosted_provider::ApiResult<mdbase_connect_protocol::FileTransferStatus>,
> {
    let provider = fixture.provider.clone();
    let collection_id = fixture.collection_id;
    let token = fixture.token.clone();
    tokio::spawn(async move {
        provider
            .abort_file_transfer(
                collection_id,
                &token,
                FileLifecycleFixture::abort_request(transfer_id),
                None,
            )
            .await
    })
}

async fn assert_terminal_objects_absent(fixture: &FileLifecycleFixture, transfer_id: Uuid) {
    assert!(
        !fixture
            .blobs
            .contains(&fixture.staging_key(transfer_id))
            .await
    );
    assert!(
        !fixture
            .blobs
            .contains(&fixture.committed_key(transfer_id))
            .await
    );
    assert_storage_consistent(&fixture.pool, &fixture.blobs, fixture.collection_id).await;
}

async fn expire_transfer(fixture: &FileLifecycleFixture, transfer_id: Uuid) {
    sqlx::query(
        "UPDATE hosted_provider_file_transfers SET expires_at = now() - interval '1 second' WHERE id = $1",
    )
    .bind(transfer_id)
    .execute(&fixture.pool)
    .await
    .expect("transfer expires");
}

async fn wait_until_expired(fixture: &FileLifecycleFixture, transfer_id: Uuid) {
    wait_for_database_condition(&fixture.pool, || {
        let pool = fixture.pool.clone();
        async move {
            sqlx::query_scalar::<_, bool>(
                "SELECT expires_at <= now() FROM hosted_provider_file_transfers WHERE id = $1",
            )
            .bind(transfer_id)
            .fetch_one(&pool)
            .await
            .expect("expiry can be observed")
        }
    })
    .await;
}
