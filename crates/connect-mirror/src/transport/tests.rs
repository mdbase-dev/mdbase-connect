use super::*;
use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

#[derive(Clone)]
struct RetryUploadState {
    transfer_id: Uuid,
    object_url: String,
    prepare_attempts: Arc<AtomicUsize>,
    upload_attempts: Arc<AtomicUsize>,
}

async fn open_retry_upload(State(state): State<RetryUploadState>) -> Json<FileTransferSession> {
    Json(FileTransferSession {
        prepared_upload_part: None,
        protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
        message_type: FileTransferSessionKind::FileTransfer,
        transfer_id: state.transfer_id,
        direction: FileTransferDirection::Upload,
        protection: FileTransferProtection::TransportTls,
        strategy: FileTransferStrategy::ObjectMultipart { part_size: 8 },
        total_size: 8,
        expires_at: "2026-08-12T00:00:00Z".to_string(),
        received: Vec::new(),
        uploaded_parts: Vec::new(),
    })
}

async fn retry_upload_status(State(state): State<RetryUploadState>) -> Json<FileTransferStatus> {
    Json(FileTransferStatus {
        protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
        message_type: FileTransferStatusKind::FileTransferStatus,
        transfer_id: state.transfer_id,
        state: FileTransferState::Open,
        received: Vec::new(),
        received_bytes: 0,
        uploaded_parts: Vec::new(),
    })
}

async fn prepare_retry_upload(
    State(state): State<RetryUploadState>,
    Json(request): Json<PrepareFileUploadPartRequest>,
) -> Json<PreparedFilePart> {
    assert_eq!(request.transfer_id, state.transfer_id);
    assert_eq!(request.part_number, 1);
    assert_eq!(request.content_length, 8);
    state.prepare_attempts.fetch_add(1, Ordering::SeqCst);
    Json(PreparedFilePart {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: PreparedFilePartKind::FilePart,
        transfer_id: state.transfer_id,
        part_index: 0,
        offset: 0,
        content_length: 8,
        method: "PUT".to_string(),
        url: state.object_url,
        headers: BTreeMap::new(),
        expires_at: "2026-08-12T00:00:00Z".to_string(),
    })
}

async fn retry_object_put(State(state): State<RetryUploadState>) -> Response {
    if state.upload_attempts.fetch_add(1, Ordering::SeqCst) == 0 {
        StatusCode::FORBIDDEN.into_response()
    } else {
        (StatusCode::OK, [(header::ETAG, "retry-etag")]).into_response()
    }
}

async fn commit_retry_upload(
    State(state): State<RetryUploadState>,
    Json(request): Json<CommitFileUploadRequest>,
) -> Json<CommitFileUploadReceipt> {
    assert_eq!(request.transfer_id, state.transfer_id);
    assert_eq!(request.parts.len(), 1);
    assert_eq!(request.parts[0].part_number, 1);
    assert_eq!(request.parts[0].etag, "retry-etag");
    Json(CommitFileUploadReceipt {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: CommitFileUploadReceiptKind::FileUploadCommitted,
        transfer_id: state.transfer_id,
        file: CollectionFileDescriptor {
            file_id: Uuid::new_v4(),
            path: "asset.bin".to_string(),
            revision: "revision".to_string(),
            content_digest: "sha256:fixture".to_string(),
            size: 8,
            media_type: None,
            media_class: FileMediaClass::Other,
            modified_at: "2026-08-11T00:00:00Z".to_string(),
        },
    })
}

fn upload_status(transfer_id: Uuid) -> FileTransferStatus {
    FileTransferStatus {
        protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
        message_type: FileTransferStatusKind::FileTransferStatus,
        transfer_id,
        state: FileTransferState::Open,
        received: vec![0, 2],
        received_bytes: 6,
        uploaded_parts: vec![
            UploadedFilePart {
                part_number: 1,
                etag: "first".to_string(),
            },
            UploadedFilePart {
                part_number: 3,
                etag: "third".to_string(),
            },
        ],
    }
}

#[test]
fn upload_progress_is_exact_bounded_and_resume_safe() {
    let transfer_id = Uuid::new_v4();
    let valid = upload_status(transfer_id);
    let (received, uploaded) =
        validate_upload_progress(valid.clone(), transfer_id, 10, 4, true).unwrap();
    assert_eq!(received, HashSet::from([0, 2]));
    assert_eq!(uploaded.keys().copied().collect::<Vec<_>>(), vec![0, 2]);

    let invalid = [
        FileTransferStatus {
            received_bytes: 7,
            ..valid.clone()
        },
        FileTransferStatus {
            state: FileTransferState::Aborted,
            ..valid.clone()
        },
        FileTransferStatus {
            state: FileTransferState::Committed,
            ..valid.clone()
        },
        FileTransferStatus {
            uploaded_parts: vec![UploadedFilePart {
                part_number: 0,
                etag: "zero".to_string(),
            }],
            ..valid.clone()
        },
        FileTransferStatus {
            uploaded_parts: vec![
                UploadedFilePart {
                    part_number: 3,
                    etag: "third".to_string(),
                },
                UploadedFilePart {
                    part_number: 1,
                    etag: "first".to_string(),
                },
            ],
            ..valid.clone()
        },
        FileTransferStatus {
            uploaded_parts: vec![
                UploadedFilePart {
                    part_number: 1,
                    etag: "first".to_string(),
                },
                UploadedFilePart {
                    part_number: 3,
                    etag: "x".repeat(256),
                },
            ],
            ..valid.clone()
        },
    ];
    for status in invalid {
        assert_eq!(
            validate_upload_progress(status, transfer_id, 10, 4, true)
                .unwrap_err()
                .code,
            "invalid_sync_response"
        );
    }
    assert_eq!(
        validate_upload_progress(valid.clone(), transfer_id, 10, 0, true)
            .unwrap_err()
            .code,
        "invalid_sync_response"
    );
    assert_eq!(
        validate_upload_progress(valid, transfer_id, 10, 4, false)
            .unwrap_err()
            .code,
        "invalid_sync_response"
    );
}

#[test]
fn object_upload_retry_policy_is_bounded_to_transient_statuses() {
    for status in [403, 408, 425, 429, 500, 503] {
        assert!(retryable_object_upload_status(
            reqwest::StatusCode::from_u16(status).unwrap()
        ));
    }
    for status in [400, 401, 404, 409, 422] {
        assert!(!retryable_object_upload_status(
            reqwest::StatusCode::from_u16(status).unwrap()
        ));
    }
}

#[tokio::test]
async fn object_upload_retry_prepares_a_fresh_url_and_commits_once() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let authority_id = Uuid::new_v4();
    let transfer_id = Uuid::new_v4();
    let state = RetryUploadState {
        transfer_id,
        object_url: format!("http://{address}/object"),
        prepare_attempts: Arc::new(AtomicUsize::new(0)),
        upload_attempts: Arc::new(AtomicUsize::new(0)),
    };
    let file_root = format!("/v1/authorities/{authority_id}/files");
    let app = Router::new()
        .route(&format!("{file_root}/uploads"), post(open_retry_upload))
        .route(
            &format!("{file_root}/transfers/{transfer_id}"),
            get(retry_upload_status),
        )
        .route(
            &format!("{file_root}/uploads/{transfer_id}/parts"),
            post(prepare_retry_upload),
        )
        .route(
            &format!("{file_root}/uploads/{transfer_id}/commit"),
            post(commit_retry_upload),
        )
        .route("/object", put(retry_object_put))
        .with_state(state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let source = tempfile::NamedTempFile::new().unwrap();
    fs::write(source.path(), b"12345678").unwrap();
    let transport = HttpSyncTransport::new(
        &format!("http://{address}/v1/authorities/{authority_id}/sync"),
        "token",
    )
    .unwrap();
    let request = OpenFileUploadRequest {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: OpenFileUploadRequestKind::OpenFileUpload,
        transfer_id,
        path: "asset.bin".to_string(),
        size: 8,
        content_digest: "sha256:fixture".to_string(),
        media_type: None,
        if_revision: None,
    };

    let receipt = transport
        .upload_file_transfer(&request, source.path())
        .await
        .unwrap();

    assert_eq!(receipt.transfer_id, transfer_id);
    assert_eq!(state.prepare_attempts.load(Ordering::SeqCst), 2);
    assert_eq!(state.upload_attempts.load(Ordering::SeqCst), 2);
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}

#[test]
fn sync_transport_derives_the_file_endpoint_from_one_valid_authority() {
    let authority_id = Uuid::new_v4();
    let transport = HttpSyncTransport::new(
        &format!("https://connect.example/v1/authorities/{authority_id}/sync"),
        "token",
    )
    .unwrap();
    assert_eq!(
        transport.files_url,
        format!("https://connect.example/v1/authorities/{authority_id}/files")
    );
    for invalid in [
        format!("http://connect.example/v1/authorities/{authority_id}/sync"),
        format!("https://other.example/v1/authorities/{authority_id}/files"),
        format!("https://connect.example/v1/authorities/{authority_id}/sync?next=evil"),
    ] {
        assert_eq!(
            HttpSyncTransport::new(&invalid, "token")
                .err()
                .unwrap()
                .code,
            "invalid_sync_url"
        );
    }
}

#[tokio::test]
async fn stalled_authority_request_returns_a_typed_transport_timeout() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (_socket, _) = listener.accept().await.unwrap();
        std::future::pending::<()>().await;
    });
    let authority_id = Uuid::new_v4();
    let transport = HttpSyncTransport::new_with_timeouts(
        &format!("http://{address}/v1/authorities/{authority_id}/sync"),
        "token",
        Duration::from_secs(1),
        Duration::from_millis(50),
    )
    .unwrap();

    let error = tokio::time::timeout(Duration::from_secs(2), transport.open_session())
        .await
        .expect("the transport must enforce its own shorter timeout")
        .unwrap_err();
    assert_eq!(error.code, "mirror_transport_timeout");
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn refusals_carry_their_status_and_only_abandoned_transfers_are_aborted() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let authority_id = Uuid::new_v4();
    let transfer_id = Uuid::new_v4();
    // 0: an outage, 1: a stale revision, then an open that finds its transfer closed.
    let stage = Arc::new(AtomicUsize::new(0));
    let open_stage = stage.clone();
    let aborts = Arc::new(AtomicUsize::new(0));
    let abort_count = aborts.clone();
    let file_root = format!("/v1/authorities/{authority_id}/files");
    let app = Router::new()
        .route(
            &format!("{file_root}/uploads"),
            post(move || {
                let stage = open_stage.load(Ordering::SeqCst);
                async move {
                    let refusal = match stage {
                        0 => Some((StatusCode::SERVICE_UNAVAILABLE, "provider_unavailable")),
                        1 => Some((StatusCode::CONFLICT, "stale_file_revision")),
                        _ => None,
                    };
                    if let Some((status, code)) = refusal {
                        return (
                            status,
                            Json(serde_json::json!({
                                "error": { "code": code, "message": "Refused." }
                            })),
                        )
                            .into_response();
                    }
                    open_retry_upload(State(RetryUploadState {
                        transfer_id,
                        object_url: String::new(),
                        prepare_attempts: Arc::default(),
                        upload_attempts: Arc::default(),
                    }))
                    .await
                    .into_response()
                }
            }),
        )
        .route(
            &format!("{file_root}/transfers/{transfer_id}"),
            get(move || async move {
                Json(FileTransferStatus {
                    state: FileTransferState::Aborted,
                    received: Vec::new(),
                    received_bytes: 0,
                    uploaded_parts: Vec::new(),
                    ..upload_status(transfer_id)
                })
            })
            .delete(move || {
                abort_count.fetch_add(1, Ordering::SeqCst);
                async move { StatusCode::NOT_FOUND }
            }),
        );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let source = tempfile::NamedTempFile::new().unwrap();
    fs::write(source.path(), b"12345678").unwrap();
    let transport = HttpSyncTransport::new(
        &format!("http://{address}/v1/authorities/{authority_id}/sync"),
        "token",
    )
    .unwrap();
    let request = OpenFileUploadRequest {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: OpenFileUploadRequestKind::OpenFileUpload,
        transfer_id,
        path: "asset.bin".to_string(),
        size: 8,
        content_digest: "sha256:fixture".to_string(),
        media_type: None,
        if_revision: None,
    };

    let outage = transport
        .upload_file(&request, source.path())
        .await
        .unwrap_err();
    assert_eq!(
        (outage.code.as_str(), outage.status),
        ("provider_unavailable", Some(503))
    );
    assert_eq!(aborts.load(Ordering::SeqCst), 0, "a retry resumes it");
    stage.store(1, Ordering::SeqCst);
    let refused = transport
        .upload_file(&request, source.path())
        .await
        .unwrap_err();
    assert_eq!(
        (refused.code.as_str(), refused.status),
        ("stale_file_revision", Some(409))
    );
    assert_eq!(aborts.load(Ordering::SeqCst), 1, "a re-plan abandons it");
    stage.store(2, Ordering::SeqCst);
    let closed = transport
        .upload_file(&request, source.path())
        .await
        .unwrap_err();
    assert_eq!(
        (closed.code.as_str(), closed.status),
        ("file_transfer_expired", Some(409))
    );
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}

/// A resumable multipart authority that fails one upload stage once.
#[derive(Clone, Default)]
struct ResumableUpload {
    object_url: String,
    failing: Arc<Mutex<Option<&'static str>>>,
    received: Arc<Mutex<BTreeMap<u64, String>>>,
    prepares: Arc<AtomicUsize>,
    puts: Arc<AtomicUsize>,
    commits: Arc<AtomicUsize>,
    aborts: Arc<AtomicUsize>,
}

const RESUMABLE_TRANSFER: Uuid = Uuid::from_u128(0x0194_0000_0000_7000_8000_0000_0000_0005);

impl ResumableUpload {
    fn fails(&self, stage: &str) -> bool {
        let mut failing = self.failing.lock().unwrap();
        let fails = *failing == Some(stage);
        if fails {
            *failing = None;
        }
        fails
    }

    fn outage(&self, stage: &str) -> Option<Response> {
        self.fails(stage).then(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({
                    "error": { "code": "provider_unavailable", "message": "Down." }
                })),
            )
                .into_response()
        })
    }
}

async fn resumable_open() -> Json<FileTransferSession> {
    Json(FileTransferSession {
        transfer_id: RESUMABLE_TRANSFER,
        strategy: FileTransferStrategy::ObjectMultipart { part_size: 3 },
        ..open_retry_upload(State(RetryUploadState {
            transfer_id: RESUMABLE_TRANSFER,
            object_url: String::new(),
            prepare_attempts: Arc::default(),
            upload_attempts: Arc::default(),
        }))
        .await
        .0
    })
}

async fn resumable_status(State(state): State<ResumableUpload>) -> Response {
    if let Some(outage) = state.outage("status") {
        return outage;
    }
    let received: BTreeMap<u64, String> = state.received.lock().unwrap().clone();
    Json(FileTransferStatus {
        protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
        message_type: FileTransferStatusKind::FileTransferStatus,
        transfer_id: RESUMABLE_TRANSFER,
        state: FileTransferState::Open,
        received: received.keys().copied().collect(),
        received_bytes: received.keys().map(|index| 3_u64.min(8 - index * 3)).sum(),
        uploaded_parts: received
            .iter()
            .map(|(index, etag)| UploadedFilePart {
                part_number: u16::try_from(index + 1).unwrap(),
                etag: etag.clone(),
            })
            .collect(),
    })
    .into_response()
}

async fn resumable_abort(State(state): State<ResumableUpload>) -> StatusCode {
    state.aborts.fetch_add(1, Ordering::SeqCst);
    StatusCode::NO_CONTENT
}

async fn resumable_prepare(
    State(state): State<ResumableUpload>,
    Json(request): Json<PrepareFileUploadPartRequest>,
) -> Response {
    state.prepares.fetch_add(1, Ordering::SeqCst);
    if let Some(outage) = state.outage("prepare") {
        return outage;
    }
    let index = u64::from(request.part_number - 1);
    Json(PreparedFilePart {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: PreparedFilePartKind::FilePart,
        transfer_id: RESUMABLE_TRANSFER,
        part_index: index,
        offset: index * 3,
        content_length: request.content_length,
        method: "PUT".to_string(),
        url: format!("{}/{index}", state.object_url),
        headers: BTreeMap::new(),
        expires_at: "2026-08-12T00:00:00Z".to_string(),
    })
    .into_response()
}

async fn resumable_put(
    State(state): State<ResumableUpload>,
    axum::extract::Path(index): axum::extract::Path<u64>,
) -> Response {
    state.puts.fetch_add(1, Ordering::SeqCst);
    // Object storage refuses outright: no retry, and no status from the authority.
    if state.fails("put") {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let etag = format!("etag-{index}");
    let mut received = state.received.lock().unwrap();
    assert!(
        received.insert(index, etag.clone()).is_none(),
        "part {index} uploaded twice"
    );
    (StatusCode::OK, [(header::ETAG, etag)]).into_response()
}

async fn resumable_commit(
    State(state): State<ResumableUpload>,
    Json(request): Json<CommitFileUploadRequest>,
) -> Response {
    state.commits.fetch_add(1, Ordering::SeqCst);
    if let Some(outage) = state.outage("commit") {
        return outage;
    }
    assert_eq!(request.parts.len(), 3);
    Json(CommitFileUploadReceipt {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: CommitFileUploadReceiptKind::FileUploadCommitted,
        transfer_id: RESUMABLE_TRANSFER,
        file: CollectionFileDescriptor {
            file_id: Uuid::new_v4(),
            path: "asset.bin".to_string(),
            revision: "revision".to_string(),
            content_digest: "sha256:fixture".to_string(),
            size: 8,
            media_type: None,
            media_class: FileMediaClass::Other,
            modified_at: "2026-08-11T00:00:00Z".to_string(),
        },
    })
    .into_response()
}

#[tokio::test]
async fn upload_failures_at_every_stage_keep_the_transfer_for_a_same_id_resume() {
    for stage in ["status", "prepare", "put", "commit"] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let authority_id = Uuid::new_v4();
        let state = ResumableUpload {
            object_url: format!("http://{address}/object"),
            failing: Arc::new(Mutex::new(Some(stage))),
            ..ResumableUpload::default()
        };
        let file_root = format!("/v1/authorities/{authority_id}/files");
        let app = Router::new()
            .route(&format!("{file_root}/uploads"), post(resumable_open))
            .route(
                &format!("{file_root}/transfers/{RESUMABLE_TRANSFER}"),
                get(resumable_status).delete(resumable_abort),
            )
            .route(
                &format!("{file_root}/uploads/{RESUMABLE_TRANSFER}/parts"),
                post(resumable_prepare),
            )
            .route(
                &format!("{file_root}/uploads/{RESUMABLE_TRANSFER}/commit"),
                post(resumable_commit),
            )
            .route("/object/{index}", put(resumable_put))
            .with_state(state.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let source = tempfile::NamedTempFile::new().unwrap();
        fs::write(source.path(), b"12345678").unwrap();
        let transport = HttpSyncTransport::new(
            &format!("http://{address}/v1/authorities/{authority_id}/sync"),
            "token",
        )
        .unwrap();
        let request = OpenFileUploadRequest {
            protocol_version: FILE_PROTOCOL_VERSION,
            message_type: OpenFileUploadRequestKind::OpenFileUpload,
            transfer_id: RESUMABLE_TRANSFER,
            path: "asset.bin".to_string(),
            size: 8,
            content_digest: "sha256:fixture".to_string(),
            media_type: None,
            if_revision: None,
        };

        let error = transport
            .upload_file(&request, source.path())
            .await
            .unwrap_err();
        // The executor counts only a definite refusal, so this leaves the count.
        assert!(!definite_refusal(&error), "{stage}: {error:?}");
        assert_eq!(state.aborts.load(Ordering::SeqCst), 0, "{stage}");
        let before = (
            state.prepares.load(Ordering::SeqCst),
            state.puts.load(Ordering::SeqCst),
        );
        let receipt = transport
            .upload_file(&request, source.path())
            .await
            .unwrap();
        assert_eq!(receipt.transfer_id, RESUMABLE_TRANSFER);
        assert_eq!(state.received.lock().unwrap().len(), 3, "{stage}");
        assert_eq!(state.aborts.load(Ordering::SeqCst), 0, "{stage}");
        assert_eq!(state.commits.load(Ordering::SeqCst), 1 + usize::from(stage == "commit"));
        if stage == "commit" {
            // Every part is already in: the retry re-runs only the commit.
            assert_eq!(
                (
                    state.prepares.load(Ordering::SeqCst),
                    state.puts.load(Ordering::SeqCst)
                ),
                before
            );
        }
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
    }
}
