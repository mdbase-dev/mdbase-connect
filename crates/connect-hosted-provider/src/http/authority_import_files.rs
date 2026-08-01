use super::*;
use mdbase_connect_protocol::{
    CommitFileUploadReceipt, CommitFileUploadRequest, FileTransferSession,
    OpenAuthorityImportFileUploadRequest, PrepareFileUploadPartRequest, PreparedFilePart,
};

pub(super) async fn open_authority_import_file_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(import_id): Path<Uuid>,
    Json(request): Json<OpenAuthorityImportFileUploadRequest>,
) -> ApiResult<Json<FileTransferSession>> {
    Ok(Json(
        state
            .provider
            .open_authority_import_file_upload(import_id, bearer(&headers)?, request)
            .await?,
    ))
}

pub(super) async fn prepare_authority_import_file_part(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((import_id, transfer_id)): Path<(Uuid, Uuid)>,
    Json(request): Json<PrepareFileUploadPartRequest>,
) -> ApiResult<Json<PreparedFilePart>> {
    if request.transfer_id != transfer_id {
        return Err(ApiError::bad_request(
            "file_transfer_mismatch",
            "Transfer path and body differ.",
        ));
    }
    Ok(Json(
        state
            .provider
            .prepare_authority_import_file_part(import_id, bearer(&headers)?, request)
            .await?,
    ))
}

pub(super) async fn commit_authority_import_file_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((import_id, transfer_id)): Path<(Uuid, Uuid)>,
    Json(request): Json<CommitFileUploadRequest>,
) -> ApiResult<Json<CommitFileUploadReceipt>> {
    if request.transfer_id != transfer_id {
        return Err(ApiError::bad_request(
            "file_transfer_mismatch",
            "Transfer path and body differ.",
        ));
    }
    Ok(Json(
        state
            .provider
            .commit_authority_import_file_upload(import_id, bearer(&headers)?, request)
            .await?,
    ))
}
