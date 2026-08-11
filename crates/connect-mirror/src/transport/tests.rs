use super::*;
use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Clone)]
struct RetryUploadState {
    transfer_id: Uuid,
    object_url: String,
    prepare_attempts: Arc<AtomicUsize>,
    upload_attempts: Arc<AtomicUsize>,
}

async fn open_retry_upload(State(state): State<RetryUploadState>) -> Json<FileTransferSession> {
    Json(FileTransferSession {
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
