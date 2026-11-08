#![allow(dead_code, unused_imports)]

//! A hosted file control (upload open and commit, move, delete, abort) whose
//! attempt fails is not given a stored error as its final answer, and
//! failures stored that way by earlier releases reopen. The controls run
//! through the HTTP routes, which journal them under the transfer or mutation
//! ID exactly as clients send them.

mod support;
#[path = "support/test_postgres.rs"]
mod test_postgres;

use mdbase_connect_hosted_provider::{app, AppState, DiagnosticSection};
use mdbase_connect_protocol::{
    CommitFileUploadRequest, DeleteFileRequest, DeleteFileRequestKind, MoveFileRequest,
    MoveFileRequestKind, OpenFileUploadRequest, OpenFileUploadRequestKind,
    PrepareFileUploadPartRequest, PrepareFileUploadPartRequestKind, FILE_PROTOCOL_VERSION,
};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use support::{assert_storage_consistent, FileLifecycleFixture};
use test_postgres::DisposablePostgres;
use uuid::Uuid;

/// The provider's namespace for file control journal request IDs
/// (`mutation_journal_files.rs`).
const FILE_CONTROL_REQUEST_NAMESPACE: Uuid =
    Uuid::from_u128(0x3cde_967c_d51b_5f64_9a67_bbd2_f41a_9aa4);

/// The hosted provider's HTTP routes, served on loopback over the fixture.
struct Authority {
    fixture: FileLifecycleFixture,
    base: String,
    http: reqwest::Client,
}

type HttpResult = Result<Value, (u16, String)>;

impl Authority {
    async fn start(database_url: &str) -> Self {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let fixture = FileLifecycleFixture::new(database_url).await;
        let state = AppState::new(fixture.provider.clone(), &"internal-".repeat(5)).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!(
            "http://{}/v1/authorities/{}/files",
            listener.local_addr().unwrap(),
            fixture.collection_id
        );
        tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap() });
        Self {
            fixture,
            base,
            http: reqwest::Client::new(),
        }
    }

    async fn post(&self, path: &str, body: &impl Serialize) -> HttpResult {
        let response = self
            .http
            .post(format!("{}{path}", self.base))
            .bearer_auth(&self.fixture.token)
            .json(body)
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        let body: Value = response.json().await.unwrap();
        if status == 200 {
            Ok(body)
        } else {
            Err((status, body["error"]["code"].as_str().unwrap().to_string()))
        }
    }

    async fn open(&self, request: &OpenFileUploadRequest) -> HttpResult {
        self.post("/uploads", request).await
    }

    async fn commit(&self, transfer_id: Uuid) -> HttpResult {
        self.post(
            &format!("/uploads/{transfer_id}/commit"),
            &FileLifecycleFixture::commit_request(transfer_id),
        )
        .await
    }

    async fn move_file(&self, request: &MoveFileRequest) -> HttpResult {
        self.post(&format!("/{}/move", request.file_id), request)
            .await
    }

    async fn delete_file(&self, request: &DeleteFileRequest) -> HttpResult {
        self.post(&format!("/{}/delete", request.file_id), request)
            .await
    }

    /// Open (journaled), prepare the single part and put the bytes in staging.
    async fn stage(&self, path: &str, bytes: &[u8]) -> Uuid {
        let request = open_request(path, bytes);
        self.open(&request).await.unwrap();
        self.prepare_and_put(request.transfer_id, bytes).await;
        request.transfer_id
    }

    async fn prepare_and_put(&self, transfer_id: Uuid, bytes: &[u8]) {
        let fixture = &self.fixture;
        fixture
            .provider
            .prepare_file_upload_part(
                fixture.collection_id,
                &fixture.token,
                PrepareFileUploadPartRequest {
                    protocol_version: FILE_PROTOCOL_VERSION,
                    message_type: PrepareFileUploadPartRequestKind::PrepareFileUploadPart,
                    transfer_id,
                    part_number: 1,
                    content_length: bytes.len() as u64,
                },
                None,
            )
            .await
            .unwrap();
        fixture
            .blobs
            .put(fixture.staging_key(transfer_id), bytes.to_vec())
            .await;
    }

    /// A whole upload; returns the committed file descriptor.
    async fn upload(&self, path: &str, bytes: &[u8]) -> Value {
        let transfer_id = self.stage(path, bytes).await;
        self.commit(transfer_id).await.unwrap()["file"].clone()
    }
}

fn open_request(path: &str, bytes: &[u8]) -> OpenFileUploadRequest {
    OpenFileUploadRequest {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: OpenFileUploadRequestKind::OpenFileUpload,
        transfer_id: Uuid::now_v7(),
        path: path.to_string(),
        size: bytes.len() as u64,
        content_digest: format!("sha256:{:x}", Sha256::digest(bytes)),
        media_type: None,
        if_revision: None,
    }
}

fn move_request(file: &Value, path: &str) -> MoveFileRequest {
    MoveFileRequest {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: MoveFileRequestKind::MoveFile,
        mutation_id: Uuid::now_v7(),
        file_id: file["file_id"].as_str().unwrap().parse().unwrap(),
        if_revision: file["revision"].as_str().unwrap().to_string(),
        from_path: file["path"].as_str().unwrap().to_string(),
        path: path.to_string(),
        update_references: false,
    }
}

fn delete_request(file: &Value) -> DeleteFileRequest {
    DeleteFileRequest {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: DeleteFileRequestKind::DeleteFile,
        mutation_id: Uuid::now_v7(),
        file_id: file["file_id"].as_str().unwrap().parse().unwrap(),
        if_revision: file["revision"].as_str().unwrap().to_string(),
        path: file["path"].as_str().unwrap().to_string(),
    }
}

async fn replica_id(fixture: &FileLifecycleFixture) -> Uuid {
    sqlx::query_scalar("SELECT id FROM hosted_provider_replicas WHERE collection_id = $1")
        .bind(fixture.collection_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap()
}

/// The journal request ID the provider derives from the public ID.
fn request_id(action: &str, public_id: Uuid) -> Uuid {
    Uuid::new_v5(
        &FILE_CONTROL_REQUEST_NAMESPACE,
        format!("{action}\0{public_id}").as_bytes(),
    )
}

#[derive(Debug)]
struct JournalRow {
    state: String,
    has_final_receipt: bool,
    lease_expired: bool,
}

async fn journal(fixture: &FileLifecycleFixture, action: &str, public_id: Uuid) -> JournalRow {
    let row = sqlx::query(
        r#"SELECT state, final_receipt_ciphertext IS NOT NULL AS has_final,
                  lease_expires_at <= now() AS lease_expired
           FROM hosted_provider_mutation_journal
           WHERE replica_id = $1 AND request_id = $2"#,
    )
    .bind(replica_id(fixture).await)
    .bind(request_id(action, public_id))
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    JournalRow {
        state: row.get("state"),
        has_final_receipt: row.get("has_final"),
        lease_expired: row.get("lease_expired"),
    }
}

fn assert_released(row: &JournalRow) {
    assert_eq!(row.state, "prepared", "{row:?}");
    assert!(!row.has_final_receipt, "{row:?}");
    assert!(row.lease_expired, "{row:?}");
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

/// Make every insert into `table` fail inside its transaction (a 500), or
/// stop doing so.
async fn fail_inserts(fixture: &FileLifecycleFixture, table: &str, fail: bool) {
    let sql = if fail {
        format!(
            r#"CREATE OR REPLACE FUNCTION test_fail_insert() RETURNS trigger AS $$
               BEGIN RAISE EXCEPTION 'test insert failure'; END $$ LANGUAGE plpgsql;
               CREATE TRIGGER test_fail_insert BEFORE INSERT ON {table}
                 FOR EACH ROW EXECUTE FUNCTION test_fail_insert();"#
        )
    } else {
        format!("DROP TRIGGER test_fail_insert ON {table};")
    };
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
        .execute(&fixture.pool)
        .await
        .unwrap();
}

/// A `prepared` file control row exactly as the claim inserts it.
async fn claimed_row(
    fixture: &FileLifecycleFixture,
    action: &str,
    public_id: Uuid,
    request: &impl Serialize,
) {
    let input = serde_json::to_value(request).unwrap();
    let kind = mdbase_connect_protocol::mutation_operation_identifier("file_control", &input)
        .unwrap()
        .to_string();
    let digest =
        mdbase_connect_protocol::mutation_fingerprint_bytes("file_control", &input).unwrap();
    let version =
        mdbase_connect_protocol::operation_input_schema_version("file_control", &input).unwrap();
    sqlx::query(
        r#"INSERT INTO hosted_provider_mutation_journal
             (replica_id, request_id, operation_kind, input_schema_version, input_digest,
              state, process_epoch, lease_owner, lease_expires_at, fencing_generation,
              prepared_head)
           SELECT $1, $2, $3, $4, $5, 'prepared', $6, $7,
                  now() + interval '30 seconds', 1, head
           FROM hosted_provider_collections WHERE id = $8"#,
    )
    .bind(replica_id(fixture).await)
    .bind(request_id(action, public_id))
    .bind(kind)
    .bind(i32::try_from(version).unwrap())
    .bind(digest.to_vec())
    .bind(Uuid::now_v7())
    .bind(Uuid::new_v4())
    .bind(fixture.collection_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
}

/// Close a journal row the way the previous release's
/// `complete_operation_mutation` closed a failed file control: the failure
/// (without details) as the encrypted final receipt.
async fn store_failure_as_previous_release(
    fixture: &FileLifecycleFixture,
    action: &str,
    public_id: Uuid,
    status: u16,
    code: &str,
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
    let plaintext = serde_json::to_vec(&json!({
        "outcome": "failure",
        "status": status,
        "code": code,
        "message": "Stored by an earlier release.",
        "details": Value::Null,
    }))
    .unwrap();
    let replica = replica_id(fixture).await;
    let request = request_id(action, public_id);
    let aad = format!("hosted-provider/mutation-journal/v1/{replica}/{request}");
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
    .bind(replica)
    .bind(request)
    .bind(ciphertext)
    .bind(Sha256::digest(&plaintext).to_vec())
    .execute(&fixture.pool)
    .await
    .unwrap()
    .rows_affected();
    assert_eq!(updated, 1);
}

/// File counters, as the collection and the account record them.
#[derive(Debug, PartialEq, Eq)]
struct Usage {
    file_rows: i64,
    file_count: i64,
    file_bytes: i64,
    stored_file_bytes: i64,
    account_live_file_bytes: i64,
    account_retained_file_bytes: i64,
}

async fn usage(fixture: &FileLifecycleFixture) -> Usage {
    let row = sqlx::query(
        r#"SELECT (SELECT count(*) FROM hosted_provider_files WHERE collection_id = c.id) AS rows,
                  c.file_count, c.file_bytes, c.stored_file_bytes,
                  a.live_file_bytes, a.retained_file_bytes
           FROM hosted_provider_collections c
           JOIN hosted_provider_accounts a ON a.id = c.account_id
           WHERE c.id = $1"#,
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    Usage {
        file_rows: row.get("rows"),
        file_count: row.get("file_count"),
        file_bytes: row.get("file_bytes"),
        stored_file_bytes: row.get("stored_file_bytes"),
        account_live_file_bytes: row.get("live_file_bytes"),
        account_retained_file_bytes: row.get("retained_file_bytes"),
    }
}

/// Every upload transfer of the collection as `(id, state)`.
async fn transfers(fixture: &FileLifecycleFixture) -> Vec<(Uuid, String)> {
    sqlx::query_as(
        r#"SELECT id, state FROM hosted_provider_file_transfers
           WHERE collection_id = $1 AND direction = 'upload' ORDER BY id"#,
    )
    .bind(fixture.collection_id)
    .fetch_all(&fixture.pool)
    .await
    .unwrap()
}

fn diagnostic_count(section: DiagnosticSection<u64>) -> u64 {
    match section {
        DiagnosticSection::Ok { value } => value,
        DiagnosticSection::Unavailable { reason } => panic!("diagnostic unavailable: {reason}"),
    }
}

async fn released_file_controls(fixture: &FileLifecycleFixture) -> u64 {
    diagnostic_count(
        fixture
            .provider
            .hosted_diagnostics()
            .await
            .released_file_control_mutations,
    )
}

/// An error inside a file control's own transaction (here a 500 from the
/// move) releases the lease without a final receipt. Each retry runs again,
/// and once the fault clears the same mutation ID applies exactly once.
#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn transaction_error_releases_the_lease_and_the_retry_applies() {
    let database = DisposablePostgres::from_projection_env().await;
    let authority = Authority::start(database.url()).await;
    let fixture = &authority.fixture;
    let file = authority.upload("files/a.bin", b"moved once").await;
    let request = move_request(&file, "files/b.bin");

    fail_inserts(fixture, "hosted_provider_file_changes", true).await;
    let before = head(fixture).await;
    for _ in 0..2 {
        let error = authority.move_file(&request).await.unwrap_err();
        assert_eq!(error, (500, "provider_internal_error".to_string()));
        assert_released(&journal(fixture, "move_file", request.mutation_id).await);
    }
    assert_eq!(head(fixture).await, before);

    fail_inserts(fixture, "hosted_provider_file_changes", false).await;
    let receipt = authority.move_file(&request).await.unwrap();
    assert_eq!(receipt["file"]["path"], "files/b.bin");
    assert_eq!(head(fixture).await, before + 1);
    let row = journal(fixture, "move_file", request.mutation_id).await;
    assert_eq!(row.state, "completed");
    // The same ID now replays the receipt without moving again.
    assert_eq!(authority.move_file(&request).await.unwrap(), receipt);
    assert_eq!(head(fixture).await, before + 1);
    // And the client moves on to its next control.
    authority
        .delete_file(&delete_request(&receipt["file"]))
        .await
        .unwrap();
}

/// A failed open releases too, and the retry opens exactly one transfer.
#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn a_failed_open_releases_and_the_retry_opens_one_transfer() {
    let database = DisposablePostgres::from_projection_env().await;
    let authority = Authority::start(database.url()).await;
    let fixture = &authority.fixture;
    let bytes = b"opened once";
    let request = open_request("files/open.bin", bytes);

    fail_inserts(fixture, "hosted_provider_file_transfers", true).await;
    assert_eq!(
        authority.open(&request).await.unwrap_err(),
        (500, "provider_internal_error".to_string())
    );
    assert_released(&journal(fixture, "open_file_upload", request.transfer_id).await);
    assert!(transfers(fixture).await.is_empty());

    fail_inserts(fixture, "hosted_provider_file_transfers", false).await;
    let session = authority.open(&request).await.unwrap();
    assert_eq!(session["transfer_id"], request.transfer_id.to_string());
    assert_eq!(
        transfers(fixture).await,
        [(request.transfer_id, "open".to_string())]
    );
    authority.prepare_and_put(request.transfer_id, bytes).await;
    authority.commit(request.transfer_id).await.unwrap();
    assert_eq!(usage(fixture).await.file_rows, 1);
}

/// The required upgrade test: file control rows written exactly as the
/// previous release wrote them for each transient failure class reopen on the
/// next retry and apply once.
#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn transient_failures_stored_by_the_previous_release_reopen() {
    let database = DisposablePostgres::from_projection_env().await;
    let authority = Authority::start(database.url()).await;
    let fixture = &authority.fixture;
    let classes = [
        (429, "account_storage_quota_exceeded"),
        (429, "file_storage_quota_exceeded"),
        (503, "provider_database_timeout"),
        (500, "provider_internal_error"),
        (503, "blob_storage_unavailable"),
        (401, "invalid_replica_token"),
        (404, "hosted_collection_not_found"),
    ];
    for (index, (status, code)) in classes.into_iter().enumerate() {
        let file = authority
            .upload(&format!("files/{index}.bin"), code.as_bytes())
            .await;
        let request = move_request(&file, &format!("moved/{index}.bin"));
        claimed_row(fixture, "move_file", request.mutation_id, &request).await;
        store_failure_as_previous_release(fixture, "move_file", request.mutation_id, status, code)
            .await;
        assert_eq!(
            journal(fixture, "move_file", request.mutation_id)
                .await
                .state,
            "completed"
        );

        let before = head(fixture).await;
        let receipt = authority.move_file(&request).await.unwrap();
        assert_eq!(
            receipt["file"]["path"],
            format!("moved/{index}.bin"),
            "{code}"
        );
        assert_eq!(head(fixture).await, before + 1, "{code}");
        assert_eq!(authority.move_file(&request).await.unwrap(), receipt);
        assert_eq!(head(fixture).await, before + 1, "{code}");
        authority
            .delete_file(&delete_request(&receipt["file"]))
            .await
            .unwrap();
    }
}

/// An earlier release could store an error over a commit that had landed
/// (the COMMIT reported failure). The retry reopens the row and the upload's
/// own record replays the original receipt, with no second effect.
#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn error_stored_over_a_landed_commit_replays_its_receipt() {
    let database = DisposablePostgres::from_projection_env().await;
    let authority = Authority::start(database.url()).await;
    let fixture = &authority.fixture;
    let transfer_id = authority.stage("files/landed.bin", b"landed").await;
    let receipt = authority.commit(transfer_id).await.unwrap();
    let after = (head(fixture).await, usage(fixture).await);
    store_failure_as_previous_release(
        fixture,
        "commit_file_upload",
        transfer_id,
        500,
        "provider_internal_error",
    )
    .await;

    assert_eq!(authority.commit(transfer_id).await.unwrap(), receipt);
    assert_eq!((head(fixture).await, usage(fixture).await), after);
    assert_eq!(
        journal(fixture, "commit_file_upload", transfer_id)
            .await
            .state,
        "completed"
    );
}

/// 400, 403 and 409 failures were deterministic for that exact request; they
/// stay final and are replayed unchanged, even once the condition behind a
/// stored 409 would no longer hold.
#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn deterministic_stored_failures_stay_final() {
    let database = DisposablePostgres::from_projection_env().await;
    let authority = Authority::start(database.url()).await;
    let fixture = &authority.fixture;
    for (index, (status, code)) in [
        (400, "invalid_file_path"),
        (403, "replica_scope_denied"),
        (409, "path_occupied"),
        (409, "stale_file_revision"),
    ]
    .into_iter()
    .enumerate()
    {
        let file = authority
            .upload(&format!("final/{index}.bin"), code.as_bytes())
            .await;
        let request = move_request(&file, &format!("final/moved-{index}.bin"));
        claimed_row(fixture, "move_file", request.mutation_id, &request).await;
        store_failure_as_previous_release(fixture, "move_file", request.mutation_id, status, code)
            .await;
        let before = head(fixture).await;
        for _ in 0..2 {
            assert_eq!(
                authority.move_file(&request).await.unwrap_err(),
                (status, code.to_string())
            );
        }
        assert_eq!(head(fixture).await, before);
        assert_eq!(
            journal(fixture, "move_file", request.mutation_id)
                .await
                .state,
            "completed"
        );
    }
}

/// The refusals mirrors act on keep their status and code. They are errors,
/// not stored receipts: the row is released, and a retry with the same ID
/// re-derives the same refusal from durable state while its cause holds.
#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn refusals_mirrors_act_on_keep_their_answer() {
    let database = DisposablePostgres::from_projection_env().await;
    let authority = Authority::start(database.url()).await;
    let fixture = &authority.fixture;

    // `stale_file_revision`: a base revision for a file that does not exist.
    let mut stale = open_request("refused/stale.bin", b"stale");
    stale.if_revision = Some("file:not-current".to_string());
    // `file_too_large`: over the collection's per-file limit.
    let mut too_large = open_request("refused/large.bin", b"large");
    too_large.size = 251 * 1024 * 1024;
    for (request, status, code) in [
        (&stale, 409, "stale_file_revision"),
        (&too_large, 429, "file_too_large"),
    ] {
        for _ in 0..2 {
            assert_eq!(
                authority.open(request).await.unwrap_err(),
                (status, code.to_string())
            );
            assert_released(&journal(fixture, "open_file_upload", request.transfer_id).await);
        }
    }

    // `path_occupied`: the destination belongs to another file.
    let first = authority.upload("refused/first.bin", b"first").await;
    authority.upload("refused/second.bin", b"second").await;
    let occupied = move_request(&first, "refused/second.bin");
    for _ in 0..2 {
        assert_eq!(
            authority.move_file(&occupied).await.unwrap_err(),
            (409, "path_occupied".to_string())
        );
        assert_released(&journal(fixture, "move_file", occupied.mutation_id).await);
    }

    // `file_transfer_expired`: the upload's own record is durably expired.
    let expired = authority.stage("refused/expired.bin", b"expired").await;
    sqlx::query(
        "UPDATE hosted_provider_file_transfers SET expires_at = now() - interval '1 second' WHERE id = $1",
    )
    .bind(expired)
    .execute(&fixture.pool)
    .await
    .unwrap();
    for _ in 0..2 {
        assert_eq!(
            authority.commit(expired).await.unwrap_err(),
            (409, "file_transfer_expired".to_string())
        );
        assert_released(&journal(fixture, "commit_file_upload", expired).await);
    }

    // `file_storage_quota_exceeded`: the collection's file quota.
    sqlx::query("UPDATE hosted_provider_collections SET max_files = file_count WHERE id = $1")
        .bind(fixture.collection_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    let full = authority.stage("refused/full.bin", b"full").await;
    for _ in 0..2 {
        assert_eq!(
            authority.commit(full).await.unwrap_err(),
            (429, "file_storage_quota_exceeded".to_string())
        );
        assert_released(&journal(fixture, "commit_file_upload", full).await);
    }
    assert_eq!(released_file_controls(fixture).await, 5);
    assert_eq!(usage(fixture).await.file_rows, 2);
}

/// Item 5: a multi-step upload whose commit fails is resumed, not restarted.
/// The commit fails twice (the account storage limit, refused before any
/// copy, then a 500 inside its transaction), releasing its lease each time;
/// the third attempt with the
/// same transfer ID publishes one object, counts the bytes once and leaves no
/// transfer or attempt object behind.
#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn a_half_done_upload_resumes_the_same_transfer_after_released_commits() {
    let database = DisposablePostgres::from_projection_env().await;
    let authority = Authority::start(database.url()).await;
    let fixture = &authority.fixture;
    let bytes = b"one object, counted once";
    let size = bytes.len() as i64;
    let transfer_id = authority.stage("files/half-done.bin", bytes).await;
    let empty = usage(fixture).await;

    account_storage_full(fixture, true).await;
    assert_eq!(
        authority.commit(transfer_id).await.unwrap_err(),
        (429, "account_storage_quota_exceeded".to_string())
    );
    assert_released(&journal(fixture, "commit_file_upload", transfer_id).await);
    // Refused before any attempt was started or copied.
    let initial_key = fixture.attempt_key(transfer_id).await;
    assert_eq!(initial_key, fixture.committed_key(transfer_id));
    assert_eq!(fixture.blobs.calls("copy").await, 0);
    account_storage_full(fixture, false).await;

    fail_inserts(fixture, "hosted_provider_file_versions", true).await;
    assert_eq!(
        authority.commit(transfer_id).await.unwrap_err(),
        (500, "provider_internal_error".to_string())
    );
    assert_released(&journal(fixture, "commit_file_upload", transfer_id).await);
    let second_attempt = fixture.attempt_key(transfer_id).await;
    assert_ne!(second_attempt, initial_key);
    fail_inserts(fixture, "hosted_provider_file_versions", false).await;
    // Nothing was published or counted by the failed attempts, and the
    // upload is still the one open transfer, mid-commit.
    assert_eq!(usage(fixture).await, empty);
    assert_eq!(
        transfers(fixture).await,
        [(transfer_id, "completing".to_string())]
    );

    let receipt = authority.commit(transfer_id).await.unwrap();
    assert_eq!(receipt["transfer_id"], transfer_id.to_string());
    let published = fixture.attempt_key(transfer_id).await;
    assert_ne!(published, second_attempt);
    let counted = Usage {
        file_rows: 1,
        file_count: 1,
        file_bytes: size,
        stored_file_bytes: size,
        account_live_file_bytes: size,
        account_retained_file_bytes: size,
    };
    assert_eq!(usage(fixture).await, counted);
    assert_eq!(
        transfers(fixture).await,
        [(transfer_id, "committed".to_string())]
    );
    // The same ID replays the receipt and changes nothing.
    assert_eq!(authority.commit(transfer_id).await.unwrap(), receipt);
    assert_eq!(usage(fixture).await, counted);

    // Superseded attempts and staging were queued for deletion; once the
    // queue drains, the only object left is the published one.
    fixture.provider.delete_pending_blobs(100).await.unwrap();
    assert!(!fixture.blobs.contains(&initial_key).await);
    assert!(!fixture.blobs.contains(&second_attempt).await);
    assert!(
        !fixture
            .blobs
            .contains(&fixture.staging_key(transfer_id))
            .await
    );
    assert!(fixture.blobs.contains(&published).await);
    assert_storage_consistent(&fixture.pool, &fixture.blobs, fixture.collection_id).await;
}

async fn hold_lease(fixture: &FileLifecycleFixture, action: &str, public_id: Uuid) {
    sqlx::query(
        "UPDATE hosted_provider_mutation_journal SET lease_expires_at = now() + interval '1 hour' WHERE request_id = $1",
    )
    .bind(request_id(action, public_id))
    .execute(&fixture.pool)
    .await
    .unwrap();
}

/// Released file controls are counted as their own section, apart from the
/// unfinished, stale and expired-lease counts and the unfinished breakdown. A
/// file control whose handler still holds its lease is still unfinished, and
/// completed controls are counted nowhere.
#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn released_file_controls_are_counted_apart_from_unfinished_work() {
    let database = DisposablePostgres::from_projection_env().await;
    let authority = Authority::start(database.url()).await;
    let fixture = &authority.fixture;
    let file = authority.upload("files/counted.bin", b"counted").await;
    let released = open_request("files/released.bin", b"released");
    fail_inserts(fixture, "hosted_provider_file_transfers", true).await;
    authority.open(&released).await.unwrap_err();
    fail_inserts(fixture, "hosted_provider_file_transfers", false).await;
    let live = move_request(&file, "files/live.bin");
    claimed_row(fixture, "move_file", live.mutation_id, &live).await;
    hold_lease(fixture, "move_file", live.mutation_id).await;
    sqlx::query(
        r#"UPDATE hosted_provider_mutation_journal
           SET accepted_at = now() - interval '3 days',
               updated_at = now() - interval '3 days'
           WHERE operation_kind LIKE 'file\_control:%'"#,
    )
    .execute(&fixture.pool)
    .await
    .unwrap();

    let diagnostics = json!({ "diagnostics": fixture.provider.hosted_diagnostics().await });
    let sections = &diagnostics["diagnostics"];
    let value = |section: &str| {
        assert_eq!(sections[section]["state"], "ok", "{section}");
        sections[section]["value"].clone()
    };
    assert_eq!(value("released_file_control_mutations"), 1);
    assert_eq!(value("released_sync_mutations"), 0);
    assert_eq!(value("stored_sync_failures"), 0);
    let journal = &value("lifecycle_work")["mutation_journal"];
    assert_eq!(
        (
            &journal["unfinished"],
            &journal["stale"],
            &journal["expired_leases"]
        ),
        (&json!(1), &json!(1), &json!(0)),
        "{journal}"
    );
    assert_eq!(
        value("unfinished_mutations"),
        json!([{ "age_band": "1d_to_7d", "count": 1, "evidence_kind": "none",
                 "operation_kind": "file_control:move_file", "state": "prepared" }])
    );

    // A sibling of `released_sync_mutations` that sorts before it, so the
    // sections the operator tooling matches on keep their neighbours.
    // `json!` sorts keys, as the HTTP handler does.
    let serialized = diagnostics.to_string();
    let at = serialized
        .find(r#""released_file_control_mutations":{"state":"ok","value":1},"released_sync_mutations":{"state":"ok","value":0},"schema_version":"#)
        .expect("section present between its neighbours");
    assert!(serialized.find(r#""recent_resource_changes":"#).unwrap() < at);
    assert!(serialized
        .contains(r#""stored_sync_failures":{"state":"ok","value":0},"unfinished_mutations":"#));
    assert!(!serialized.contains(&released.transfer_id.to_string()));
}

/// Six weeks later: compaction deletes a released file control once it is 30
/// days old, and the same transfer ID resent afterwards claims a fresh row
/// and commits exactly once. Rows the rule must keep survive it: one whose
/// handler holds a live lease, and completed ones.
#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn compaction_deletes_old_released_file_controls_and_a_later_retry_applies_once() {
    let database = DisposablePostgres::from_projection_env().await;
    let authority = Authority::start(database.url()).await;
    let fixture = &authority.fixture;
    let file = authority.upload("files/kept.bin", b"kept").await;
    let bytes = b"asleep for six weeks";
    let transfer_id = authority.stage("files/asleep.bin", bytes).await;
    account_storage_full(fixture, true).await;
    authority.commit(transfer_id).await.unwrap_err();
    account_storage_full(fixture, false).await;
    let live = move_request(&file, "files/live.bin");
    claimed_row(fixture, "move_file", live.mutation_id, &live).await;
    hold_lease(fixture, "move_file", live.mutation_id).await;
    let rows = || async {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM hosted_provider_mutation_journal")
            .fetch_one(&fixture.pool)
            .await
            .unwrap()
    };
    let age = |days: i32| async move {
        sqlx::query(
            r#"UPDATE hosted_provider_mutation_journal
               SET accepted_at = now() - make_interval(days => $1),
                   updated_at = now() - make_interval(days => $1)
               WHERE operation_kind LIKE 'file\_control:%'"#,
        )
        .bind(days)
        .execute(&fixture.pool)
        .await
        .unwrap();
    };
    let exists = || async {
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (SELECT 1 FROM hosted_provider_mutation_journal WHERE request_id = $1)",
        )
        .bind(request_id("commit_file_upload", transfer_id))
        .fetch_one(&fixture.pool)
        .await
        .unwrap()
    };
    let total = rows().await;

    age(29).await;
    assert_eq!(
        fixture
            .provider
            .compact_operation_mutations()
            .await
            .unwrap(),
        0
    );
    assert!(exists().await);
    age(42).await;
    assert_eq!(
        fixture
            .provider
            .compact_operation_mutations()
            .await
            .unwrap(),
        1
    );
    assert!(!exists().await);
    assert_eq!(rows().await, total - 1);
    assert_eq!(released_file_controls(fixture).await, 0);

    // The laptop wakes and resends the same commit.
    let before = usage(fixture).await;
    let receipt = authority.commit(transfer_id).await.unwrap();
    let size = bytes.len() as i64;
    let after = usage(fixture).await;
    assert_eq!(after.file_rows, before.file_rows + 1);
    assert_eq!(after.file_bytes, before.file_bytes + size);
    assert_eq!(after.stored_file_bytes, before.stored_file_bytes + size);
    assert_eq!(
        after.account_live_file_bytes,
        before.account_live_file_bytes + size
    );
    assert_eq!(authority.commit(transfer_id).await.unwrap(), receipt);
    assert_eq!(usage(fixture).await, after);
    fixture.provider.delete_pending_blobs(100).await.unwrap();
    assert_storage_consistent(&fixture.pool, &fixture.blobs, fixture.collection_id).await;
}

/// A failed attempt releases only its own lease. If another owner has taken
/// the row over while the attempt was running, the stale owner's release
/// matches nothing and the new owner keeps its lease.
#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn a_stale_owner_releases_nothing() {
    let database = DisposablePostgres::from_projection_env().await;
    let authority = std::sync::Arc::new(Authority::start(database.url()).await);
    let fixture = &authority.fixture;
    let file = authority.upload("files/fenced.bin", b"fenced").await;
    let request = move_request(&file, "files/fenced-moved.bin");
    // Hold the attempt mid-transaction, then fail it.
    sqlx::raw_sql(
        r#"CREATE FUNCTION test_hold_then_fail() RETURNS trigger AS $$
           BEGIN
             PERFORM pg_advisory_xact_lock(4242);
             RAISE EXCEPTION 'test failure after takeover';
           END $$ LANGUAGE plpgsql;
           CREATE TRIGGER test_hold_then_fail BEFORE INSERT ON hosted_provider_file_changes
             FOR EACH ROW EXECUTE FUNCTION test_hold_then_fail();"#,
    )
    .execute(&fixture.pool)
    .await
    .unwrap();
    let mut gate = fixture.pool.acquire().await.unwrap();
    sqlx::query("SELECT pg_advisory_lock(4242)")
        .execute(&mut *gate)
        .await
        .unwrap();
    let attempt = {
        let authority = authority.clone();
        let request = request.clone();
        tokio::spawn(async move { authority.move_file(&request).await })
    };
    support::wait_for_query_blocked(&fixture.pool, "INSERT INTO hosted_provider_file_changes")
        .await;

    // Another handler takes the row over.
    let new_owner = Uuid::new_v4();
    let generation: i64 = sqlx::query_scalar(
        r#"UPDATE hosted_provider_mutation_journal
           SET lease_owner = $2, fencing_generation = fencing_generation + 1,
               lease_expires_at = now() + interval '1 hour', updated_at = now()
           WHERE request_id = $1
           RETURNING fencing_generation"#,
    )
    .bind(request_id("move_file", request.mutation_id))
    .bind(new_owner)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    sqlx::query("SELECT pg_advisory_unlock(4242)")
        .execute(&mut *gate)
        .await
        .unwrap();
    assert_eq!(attempt.await.unwrap().unwrap_err().0, 500);

    let row = sqlx::query(
        r#"SELECT state, lease_owner, fencing_generation, lease_expires_at > now() AS held
           FROM hosted_provider_mutation_journal WHERE request_id = $1"#,
    )
    .bind(request_id("move_file", request.mutation_id))
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(row.get::<String, _>("state"), "prepared");
    assert_eq!(row.get::<Uuid, _>("lease_owner"), new_owner);
    assert_eq!(row.get::<i64, _>("fencing_generation"), generation);
    assert!(row.get::<bool, _>("held"));
    assert_eq!(
        authority.move_file(&request).await.unwrap_err(),
        (409, "pending_mutation_unresolved".to_string())
    );
}
