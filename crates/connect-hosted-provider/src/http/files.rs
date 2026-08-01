use super::*;
use mdbase_connect_protocol::{
    CommitFileUploadReceipt, CommitFileUploadRequest, FileTransferSession,
    PrepareFileUploadPartRequest, PreparedFilePart,
};
use serde::de::DeserializeOwned;

pub(super) fn file_routes() -> Router<AppState> {
    Router::new()
        .route("/v1/authorities/{collection_id}/files", get(list_files))
        .route(
            "/v1/authorities/{collection_id}/files/{file_id}/move",
            post(move_file),
        )
        .route(
            "/v1/authorities/{collection_id}/files/{file_id}/delete",
            post(delete_file),
        )
        .route(
            "/v1/authorities/{collection_id}/files/uploads",
            post(open_file_upload),
        )
        .route(
            "/v1/authorities/{collection_id}/files/uploads/{transfer_id}/parts",
            post(prepare_file_upload_part),
        )
        .route(
            "/v1/authorities/{collection_id}/files/uploads/{transfer_id}/commit",
            post(commit_file_upload),
        )
        .route(
            "/v1/authorities/{collection_id}/files/downloads",
            post(open_file_download),
        )
        .route(
            "/v1/authorities/{collection_id}/files/downloads/{transfer_id}/parts",
            post(prepare_file_download_part),
        )
        .route(
            "/v1/authorities/{collection_id}/files/transfers/{transfer_id}",
            get(file_transfer_status).delete(abort_file_transfer),
        )
        .route_layer(middleware::from_fn(require_bearer_request))
}

async fn list_files(
    State(state): State<AppState>,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
    Path(collection_id): Path<Uuid>,
    Query(query): Query<FilesQuery>,
) -> ApiResult<Json<ListFilesPage>> {
    let token = bearer(&headers)?;
    let origin = request_origin(&headers);
    let proof = request_proof(&headers, Method::GET, &uri, &[])?;
    state
        .provider
        .authorize_request(collection_id, token, origin, proof.as_ref())
        .await?;
    Ok(Json(
        state
            .provider
            .list_files(
                collection_id,
                token,
                ListFilesRequest {
                    protocol_version: query.protocol_version,
                    message_type: ListFilesRequestKind::ListFiles,
                    folder: query.folder,
                    after: query.after,
                    limit: query.limit,
                },
                origin,
            )
            .await?,
    ))
}

async fn open_file_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
    Path(collection_id): Path<Uuid>,
    body: Bytes,
) -> ApiResult<Json<FileTransferSession>> {
    let token =
        authorize_file_request(&state, &headers, Method::POST, &uri, collection_id, &body).await?;
    let origin = request_origin(&headers);
    let request = file_json::<OpenFileUploadRequest>(&body)?;
    Ok(Json(
        state
            .provider
            .open_file_upload(collection_id, token, request, origin)
            .await?,
    ))
}

async fn prepare_file_upload_part(
    State(state): State<AppState>,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
    Path((collection_id, transfer_id)): Path<(Uuid, Uuid)>,
    body: Bytes,
) -> ApiResult<Json<PreparedFilePart>> {
    let token =
        authorize_file_request(&state, &headers, Method::POST, &uri, collection_id, &body).await?;
    let origin = request_origin(&headers);
    let request = file_json::<PrepareFileUploadPartRequest>(&body)?;
    require_matching_transfer(transfer_id, request.transfer_id)?;
    Ok(Json(
        state
            .provider
            .prepare_file_upload_part(collection_id, token, request, origin)
            .await?,
    ))
}

async fn commit_file_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
    Path((collection_id, transfer_id)): Path<(Uuid, Uuid)>,
    body: Bytes,
) -> ApiResult<Json<CommitFileUploadReceipt>> {
    let token =
        authorize_file_request(&state, &headers, Method::POST, &uri, collection_id, &body).await?;
    let origin = request_origin(&headers);
    let request = file_json::<CommitFileUploadRequest>(&body)?;
    require_matching_transfer(transfer_id, request.transfer_id)?;
    Ok(Json(
        state
            .provider
            .commit_file_upload(collection_id, token, request, origin)
            .await?,
    ))
}

async fn open_file_download(
    State(state): State<AppState>,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
    Path(collection_id): Path<Uuid>,
    body: Bytes,
) -> ApiResult<Json<FileTransferSession>> {
    let token =
        authorize_file_request(&state, &headers, Method::POST, &uri, collection_id, &body).await?;
    let origin = request_origin(&headers);
    let request = file_json::<OpenFileDownloadRequest>(&body)?;
    Ok(Json(
        state
            .provider
            .open_file_download(collection_id, token, request, origin)
            .await?,
    ))
}

async fn prepare_file_download_part(
    State(state): State<AppState>,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
    Path((collection_id, transfer_id)): Path<(Uuid, Uuid)>,
    body: Bytes,
) -> ApiResult<Json<PreparedFilePart>> {
    let token =
        authorize_file_request(&state, &headers, Method::POST, &uri, collection_id, &body).await?;
    let origin = request_origin(&headers);
    let request = file_json::<PrepareFileDownloadPartRequest>(&body)?;
    require_matching_transfer(transfer_id, request.transfer_id)?;
    Ok(Json(
        state
            .provider
            .prepare_file_download_part(collection_id, token, request, origin)
            .await?,
    ))
}

async fn file_transfer_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
    Path((collection_id, transfer_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<FileTransferStatus>> {
    let token = bearer(&headers)?;
    let origin = request_origin(&headers);
    let proof = request_proof(&headers, Method::GET, &uri, &[])?;
    state
        .provider
        .authorize_request(collection_id, token, origin, proof.as_ref())
        .await?;
    Ok(Json(
        state
            .provider
            .file_transfer_status(collection_id, token, transfer_id, origin)
            .await?,
    ))
}

async fn abort_file_transfer(
    State(state): State<AppState>,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
    Path((collection_id, transfer_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<FileTransferStatus>> {
    let token = bearer(&headers)?;
    let origin = request_origin(&headers);
    let proof = request_proof(&headers, Method::DELETE, &uri, &[])?;
    state
        .provider
        .authorize_request(collection_id, token, origin, proof.as_ref())
        .await?;
    Ok(Json(
        state
            .provider
            .abort_file_transfer(
                collection_id,
                token,
                AbortFileTransferRequest {
                    protocol_version: mdbase_connect_protocol::FILE_PROTOCOL_VERSION,
                    message_type: AbortFileTransferRequestKind::AbortFileTransfer,
                    transfer_id,
                },
                origin,
            )
            .await?,
    ))
}

async fn move_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
    Path((collection_id, file_id)): Path<(Uuid, Uuid)>,
    body: Bytes,
) -> ApiResult<Json<MoveFileReceipt>> {
    let token =
        authorize_file_request(&state, &headers, Method::POST, &uri, collection_id, &body).await?;
    let origin = request_origin(&headers);
    let request = file_json::<MoveFileRequest>(&body)?;
    require_matching_file(file_id, request.file_id)?;
    Ok(Json(
        state
            .provider
            .move_file(collection_id, token, request, origin)
            .await?,
    ))
}

async fn delete_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
    Path((collection_id, file_id)): Path<(Uuid, Uuid)>,
    body: Bytes,
) -> ApiResult<Json<DeleteFileReceipt>> {
    let token =
        authorize_file_request(&state, &headers, Method::POST, &uri, collection_id, &body).await?;
    let origin = request_origin(&headers);
    let request = file_json::<DeleteFileRequest>(&body)?;
    require_matching_file(file_id, request.file_id)?;
    Ok(Json(
        state
            .provider
            .delete_file(collection_id, token, request, origin)
            .await?,
    ))
}

async fn authorize_file_request<'a>(
    state: &AppState,
    headers: &'a HeaderMap,
    method: Method,
    uri: &Uri,
    collection_id: Uuid,
    body: &[u8],
) -> ApiResult<&'a str> {
    let token = bearer(headers)?;
    let origin = request_origin(headers);
    let proof = request_proof(headers, method, uri, body)?;
    state
        .provider
        .authorize_request(collection_id, token, origin, proof.as_ref())
        .await?;
    Ok(token)
}

fn require_matching_file(path: Uuid, body: Uuid) -> ApiResult<()> {
    if path == body {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "file_id_mismatch",
            "The file ID does not match the request path.",
        ))
    }
}

fn file_json<T: DeserializeOwned>(body: &[u8]) -> ApiResult<T> {
    serde_json::from_slice(body)
        .map_err(|_| ApiError::bad_request("invalid_json", "The file request body is invalid."))
}

fn require_matching_transfer(path: Uuid, body: Uuid) -> ApiResult<()> {
    if path == body {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "file_transfer_mismatch",
            "The file transfer ID does not match the request path.",
        ))
    }
}
