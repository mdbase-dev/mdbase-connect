#![allow(dead_code, unused_imports)]

//! What a client retrying an upload is told: the status of a swept or aborted
//! multipart upload, and a commit refused for quota before any object copy.

mod support;
#[path = "support/test_postgres.rs"]
mod test_postgres;

use axum::http::StatusCode;
use mdbase_connect_hosted_provider::{ApiError, ApiResult};
use mdbase_connect_protocol::{
    CommitFileUploadReceipt, FileTransferSession, FileTransferState, OpenFileUploadRequest,
    OpenFileUploadRequestKind, FILE_PROTOCOL_VERSION,
};
use sha2::{Digest, Sha256};
use support::FileLifecycleFixture;
use test_postgres::DisposablePostgres;
use uuid::Uuid;

/// Large enough for a multipart upload.
const MULTIPART_SIZE: u64 = 6 * 1024 * 1024;

fn multipart_request(transfer_id: Uuid) -> OpenFileUploadRequest {
    OpenFileUploadRequest {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: OpenFileUploadRequestKind::OpenFileUpload,
        transfer_id,
        path: "large.bin".to_string(),
        size: MULTIPART_SIZE,
        content_digest: format!("sha256:{:x}", Sha256::digest(b"large")),
        media_type: None,
        if_revision: None,
    }
}

async fn open(
    fixture: &FileLifecycleFixture,
    request: OpenFileUploadRequest,
) -> ApiResult<FileTransferSession> {
    fixture
        .provider
        .open_file_upload(fixture.collection_id, &fixture.token, request, None)
        .await
}

async fn status(fixture: &FileLifecycleFixture, transfer_id: Uuid) -> FileTransferState {
    let status = fixture
        .provider
        .file_transfer_status(fixture.collection_id, &fixture.token, transfer_id, None)
        .await
        .expect("transfer status is reported");
    assert!(status.received.is_empty());
    assert_eq!(status.received_bytes, 0);
    assert!(status.uploaded_parts.is_empty());
    status.state
}

async fn commit(
    fixture: &FileLifecycleFixture,
    transfer_id: Uuid,
) -> ApiResult<CommitFileUploadReceipt> {
    fixture
        .provider
        .commit_file_upload(
            fixture.collection_id,
            &fixture.token,
            FileLifecycleFixture::commit_request(transfer_id),
            None,
        )
        .await
}

fn assert_quota(error: ApiError, code: &str) {
    assert_eq!(error.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(error.code, code);
}

/// Leaves the account `headroom` bytes of live storage, or lifts the limit.
async fn account_headroom(fixture: &FileLifecycleFixture, headroom: Option<i64>) {
    sqlx::query(
        r#"UPDATE hosted_provider_accounts
           SET max_live_storage_bytes = CASE WHEN $2::bigint IS NULL
             THEN 1024 * 1024 * 1024
             ELSE greatest(1, live_content_bytes + live_file_bytes + $2) END
           WHERE id = (SELECT account_id FROM hosted_provider_collections WHERE id = $1)"#,
    )
    .bind(fixture.collection_id)
    .bind(headroom)
    .execute(&fixture.pool)
    .await
    .unwrap();
}

/// Leaves the collection `headroom` bytes of current file storage.
async fn collection_headroom(fixture: &FileLifecycleFixture, headroom: i64) {
    sqlx::query(
        "UPDATE hosted_provider_collections SET max_file_bytes = greatest(1, file_bytes + $2) WHERE id = $1",
    )
    .bind(fixture.collection_id)
    .bind(headroom)
    .execute(&fixture.pool)
    .await
    .unwrap();
}

async fn copies_and_verifies(fixture: &FileLifecycleFixture) -> (usize, usize) {
    (
        fixture.blobs.calls("copy").await,
        fixture.blobs.calls("verify").await,
    )
}

/// The sweeper aborts an expired multipart upload in R2, which then refuses
/// to list its parts. Status and open replay still answer, so the client
/// learns the transfer expired instead of retrying a 503 forever.
#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn swept_multipart_upload_reports_expiry() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let transfer_id = Uuid::now_v7();
    open(&fixture, multipart_request(transfer_id))
        .await
        .expect("multipart upload opens");
    sqlx::query(
        "UPDATE hosted_provider_file_transfers SET expires_at = now() - interval '1 minute' WHERE id = $1",
    )
    .bind(transfer_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(
        fixture
            .provider
            .recover_expired_file_transfers(10)
            .await
            .unwrap(),
        1
    );

    assert_eq!(
        status(&fixture, transfer_id).await,
        FileTransferState::Expired
    );
    let replay = open(&fixture, multipart_request(transfer_id))
        .await
        .expect("open replay answers");
    assert!(replay.received.is_empty());
    assert!(replay.uploaded_parts.is_empty());
    let error = commit(&fixture, transfer_id).await.unwrap_err();
    assert_eq!(error.code, "file_transfer_expired");
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn aborted_multipart_upload_reports_abort() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let transfer_id = Uuid::now_v7();
    open(&fixture, multipart_request(transfer_id))
        .await
        .expect("multipart upload opens");
    let aborted = fixture
        .provider
        .abort_file_transfer(
            fixture.collection_id,
            &fixture.token,
            FileLifecycleFixture::abort_request(transfer_id),
            None,
        )
        .await
        .expect("abort reports the transfer");
    assert_eq!(aborted.state, FileTransferState::Aborted);
    assert_eq!(
        status(&fixture, transfer_id).await,
        FileTransferState::Aborted
    );
    let error = commit(&fixture, transfer_id).await.unwrap_err();
    assert_eq!(error.status, StatusCode::CONFLICT);
    assert_eq!(error.code, "file_transfer_not_open");
}

/// Retries against a full collection neither copy nor re-hash the file, and
/// the same transfer commits once space is freed.
#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn full_collection_refuses_commit_before_copying() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let transfer_id = fixture.stage_upload("full.bin", &[1; 100]).await;
    collection_headroom(&fixture, 99).await;

    for _ in 0..2 {
        assert_quota(
            commit(&fixture, transfer_id).await.unwrap_err(),
            "file_storage_quota_exceeded",
        );
    }
    assert_eq!(copies_and_verifies(&fixture).await, (0, 0));

    collection_headroom(&fixture, 100).await;
    let receipt = commit(&fixture, transfer_id).await.expect("upload commits");
    assert_eq!(receipt.file.size, 100);
    assert_eq!(copies_and_verifies(&fixture).await, (1, 1));
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn full_account_refuses_commit_before_copying() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let transfer_id = fixture.stage_upload("full.bin", &[1; 100]).await;
    account_headroom(&fixture, Some(99)).await;

    for _ in 0..2 {
        assert_quota(
            commit(&fixture, transfer_id).await.unwrap_err(),
            "account_storage_quota_exceeded",
        );
    }
    assert_eq!(copies_and_verifies(&fixture).await, (0, 0));

    account_headroom(&fixture, None).await;
    let receipt = commit(&fixture, transfer_id).await.expect("upload commits");
    assert_eq!(receipt.file.size, 100);
    assert_eq!(copies_and_verifies(&fixture).await, (1, 1));
}

/// The retained-storage limit refuses even a shrinking replacement, which
/// the live-storage limit lets through.
#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn retained_storage_refuses_commit_before_copying() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let original = commit(&fixture, fixture.stage_upload("a.bin", &[1; 1000]).await)
        .await
        .expect("original commits");
    let shrink = fixture
        .stage_replace("a.bin", &[2; 500], &original.file.revision)
        .await;
    sqlx::query(
        r#"UPDATE hosted_provider_accounts
           SET max_retained_file_bytes = retained_file_bytes + 499,
               max_live_storage_bytes = least(max_live_storage_bytes, retained_file_bytes + 499)
           WHERE id = (SELECT account_id FROM hosted_provider_collections WHERE id = $1)"#,
    )
    .bind(fixture.collection_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let before = copies_and_verifies(&fixture).await;

    assert_quota(
        commit(&fixture, shrink).await.unwrap_err(),
        "account_retained_storage_quota_exceeded",
    );
    assert_eq!(copies_and_verifies(&fixture).await, before);
}

/// A collection at its file count refuses another file before copying.
#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn file_count_limit_refuses_commit_before_copying() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    commit(&fixture, fixture.stage_upload("a.bin", &[1; 10]).await)
        .await
        .expect("first file commits");
    let transfer_id = fixture.stage_upload("b.bin", &[2; 10]).await;
    sqlx::query("UPDATE hosted_provider_collections SET max_files = file_count WHERE id = $1")
        .bind(fixture.collection_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    let before = copies_and_verifies(&fixture).await;

    assert_quota(
        commit(&fixture, transfer_id).await.unwrap_err(),
        "file_storage_quota_exceeded",
    );
    assert_eq!(copies_and_verifies(&fixture).await, before);
}

/// Commits that fit, including a replacement that shrinks a file on a full
/// account and additions that exactly fill the remaining space.
#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn commits_that_fit_a_full_account_are_not_refused() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let original = commit(&fixture, fixture.stage_upload("a.bin", &[1; 1000]).await)
        .await
        .expect("original commits");

    account_headroom(&fixture, Some(0)).await;
    let shrink = fixture
        .stage_replace("a.bin", &[2; 500], &original.file.revision)
        .await;
    commit(&fixture, shrink)
        .await
        .expect("a shrinking replacement commits on a full account");

    account_headroom(&fixture, Some(100)).await;
    commit(&fixture, fixture.stage_upload("b.bin", &[3; 100]).await)
        .await
        .expect("an addition exactly filling the account commits");

    account_headroom(&fixture, None).await;
    collection_headroom(&fixture, 100).await;
    commit(&fixture, fixture.stage_upload("c.bin", &[4; 100]).await)
        .await
        .expect("an addition exactly filling the collection commits");
}

/// A stale upload is refused as stale even when the account is also full.
#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn stale_upload_on_a_full_account_stays_stale() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let original = commit(&fixture, fixture.stage_upload("a.bin", &[1; 100]).await)
        .await
        .expect("original commits");
    let first = fixture
        .stage_replace("a.bin", &[2; 100], &original.file.revision)
        .await;
    let stale = fixture
        .stage_replace("a.bin", &[3; 1000], &original.file.revision)
        .await;
    commit(&fixture, first)
        .await
        .expect("first replacement commits");

    account_headroom(&fixture, Some(0)).await;
    let error = commit(&fixture, stale).await.unwrap_err();
    assert_eq!(error.code, "stale_file_revision");
}
