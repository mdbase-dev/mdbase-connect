use super::*;
use axum::body::Body;
use axum::response::Response;
use futures_util::{stream, Stream, StreamExt};
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
            "/v1/authorities/{collection_id}/files/downloads/{transfer_id}/parts/{part_index}",
            get(download_file_part),
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
    let journal_request = request.clone();
    let provider = &state.provider;
    Ok(Json(
        provider
            .run_file_control_mutation(
                collection_id,
                token,
                "open_file_upload",
                request.transfer_id,
                &journal_request,
                || provider.open_file_upload(collection_id, token, request, origin),
            )
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
    let journal_request = request.clone();
    let provider = &state.provider;
    Ok(Json(
        provider
            .run_file_control_mutation(
                collection_id,
                token,
                "commit_file_upload",
                transfer_id,
                &journal_request,
                || provider.commit_file_upload(collection_id, token, request, origin),
            )
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

async fn download_file_part(
    State(state): State<AppState>,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
    Path((collection_id, transfer_id, part_index)): Path<(Uuid, Uuid, u64)>,
) -> ApiResult<Response> {
    let token =
        authorize_file_request(&state, &headers, Method::GET, &uri, collection_id, &[]).await?;
    let origin = request_origin(&headers);
    let download = state
        .provider
        .download_file_part(collection_id, token, transfer_id, part_index, origin)
        .await?;
    Response::builder()
        .header("content-type", "application/octet-stream")
        .header("content-length", download.content_length)
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .body(Body::from_stream(exact_length_stream(
            download.body,
            download.content_length,
        )))
        .map_err(|_| ApiError::internal("Could not build the hosted file response."))
}

fn exact_length_stream(
    body: crate::blob_store::BlobByteStream,
    expected_length: u64,
) -> impl Stream<Item = Result<Bytes, std::io::Error>> {
    stream::try_unfold(
        (body, expected_length),
        |(mut body, remaining)| async move {
            match body.next().await {
                Some(Ok(bytes)) if bytes.is_empty() => Ok(Some((bytes, (body, remaining)))),
                Some(Ok(bytes)) if bytes.len() as u64 <= remaining => {
                    let next_remaining = remaining - bytes.len() as u64;
                    Ok(Some((bytes, (body, next_remaining))))
                }
                Some(Ok(_)) => Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "R2 returned more bytes than the requested file range.",
                )),
                Some(Err(error)) => Err(std::io::Error::other(format!(
                    "R2 file range stream failed: {error}"
                ))),
                None if remaining == 0 => Ok(None),
                None => Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "R2 returned fewer bytes than the requested file range.",
                )),
            }
        },
    )
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
    let request = AbortFileTransferRequest {
        protocol_version: mdbase_connect_protocol::FILE_PROTOCOL_VERSION,
        message_type: AbortFileTransferRequestKind::AbortFileTransfer,
        transfer_id,
    };
    let journal_request = request.clone();
    let provider = &state.provider;
    Ok(Json(
        provider
            .run_file_control_mutation(
                collection_id,
                token,
                "abort_file_transfer",
                transfer_id,
                &journal_request,
                || provider.abort_file_transfer(collection_id, token, request, origin),
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
    let journal_request = request.clone();
    let provider = &state.provider;
    Ok(Json(
        provider
            .run_file_control_mutation(
                collection_id,
                token,
                "move_file",
                request.mutation_id,
                &journal_request,
                || provider.move_file(collection_id, token, request, origin),
            )
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
    let journal_request = request.clone();
    let provider = &state.provider;
    Ok(Json(
        provider
            .run_file_control_mutation(
                collection_id,
                token,
                "delete_file",
                request.mutation_id,
                &journal_request,
                || provider.delete_file(collection_id, token, request, origin),
            )
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    fn byte_stream(bytes: Vec<u8>) -> crate::blob_store::BlobByteStream {
        Box::pin(stream::once(async move { Ok(bytes.into()) }))
    }

    #[tokio::test]
    async fn exact_length_delivery_preserves_bytes() {
        let body = Body::from_stream(exact_length_stream(byte_stream(vec![1, 2, 3]), 3));
        assert_eq!(to_bytes(body, 4).await.unwrap().as_ref(), &[1, 2, 3]);
    }

    #[tokio::test]
    async fn exact_length_delivery_rejects_truncation() {
        let body = Body::from_stream(exact_length_stream(byte_stream(vec![1, 2]), 3));
        assert!(to_bytes(body, 4).await.is_err());
    }

    #[tokio::test]
    async fn exact_length_delivery_rejects_excess_bytes() {
        let body = Body::from_stream(exact_length_stream(byte_stream(vec![1, 2, 3, 4]), 3));
        assert!(to_bytes(body, 5).await.is_err());
    }
}
