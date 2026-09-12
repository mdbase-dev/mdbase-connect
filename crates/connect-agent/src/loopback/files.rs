use super::*;
use crate::admission::{AdmissionRequest, WorkClass};
use axum::body::Bytes;
use axum::extract::Path;
use axum::routing::{get, post};
use mdbase_connect_protocol::{
    FileFrame, FILE_FRAME_PREFIX_BYTES, MAX_FILE_CHUNK_BYTES, MAX_FILE_FRAME_HEADER_BYTES,
};

pub(super) const MAX_FILE_REQUEST_BYTES: usize =
    MAX_FILE_CHUNK_BYTES as usize + MAX_FILE_FRAME_HEADER_BYTES + FILE_FRAME_PREFIX_BYTES + 16;

pub(super) fn routes() -> Router<LoopbackState> {
    Router::new()
        .route(
            "/v1/files/upload",
            post(file_upload).options(super::control::preflight),
        )
        .route(
            "/v1/files/download/{grant_id}/{transfer_id}/{chunk_index}",
            get(file_download).options(super::control::preflight),
        )
}

async fn file_upload(
    State(state): State<LoopbackState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response<Body> {
    let request = request_for_authorization(Method::POST, "/v1/files/upload", headers);
    let Ok(origin) = authorize_browser_request(&state, &request, false) else {
        return denied();
    };
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        != Some("application/mdbase-connect-file")
    {
        return cors_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            "File uploads require application/mdbase-connect-file.",
            &origin,
        );
    }
    if body.len() > MAX_FILE_REQUEST_BYTES {
        return cors_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "file_frame_too_large",
            "The encrypted file frame exceeds the transfer limit.",
            &origin,
        );
    }
    let Ok(frame) = FileFrame::decode(&body) else {
        return cors_error(
            StatusCode::BAD_REQUEST,
            "invalid_file_frame",
            "The encrypted file frame is invalid.",
            &origin,
        );
    };
    let execution_deadline = state.agent.remote_policy_execution_deadline(None);
    let Ok(policy_permit) = state.agent.capture_policy_revision() else {
        return cors_error(
            StatusCode::FORBIDDEN,
            "access_denied",
            "The remote policy lease expired.",
            &origin,
        );
    };
    let admission = AdmissionRequest {
        grant_id: frame.header.grant_id,
        collection_id: frame.header.collection_id,
        class: WorkClass::File,
        weight_bytes: body.len(),
    };
    let Ok(permit) = state
        .agent
        .admission()
        .admit_before(
            admission,
            crate::admission::queue_deadline(execution_deadline),
        )
        .await
    else {
        return fenced_response(
            cors_busy("The local connector is busy.", &origin),
            state.agent.clone(),
            policy_permit,
            execution_deadline,
            None,
        );
    };
    if state.agent.admit_policy_revision(&policy_permit).is_err() {
        return abort_transport();
    }
    let agent = state.agent.clone();
    let upload_origin = origin.clone();
    let execution = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        agent.handle_direct_file_upload_frame(&upload_origin, frame)
    });
    let outcome = tokio::time::timeout_at(execution_deadline, execution).await;
    let response = match outcome {
        Ok(Ok(Ok(()))) => cors_response(StatusCode::NO_CONTENT.into_response(), &origin),
        Ok(Ok(Err(_))) => cors_error(
            StatusCode::FORBIDDEN,
            "file_upload_rejected",
            "The local connector rejected this file chunk.",
            &origin,
        ),
        Ok(Err(_)) => cors_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "connector_failed",
            "The local connector could not store this file chunk.",
            &origin,
        ),
        Err(_) => return abort_transport(),
    };
    fenced_response(
        response,
        state.agent.clone(),
        policy_permit,
        execution_deadline,
        None,
    )
}

async fn file_download(
    State(state): State<LoopbackState>,
    Path((grant_id, transfer_id, chunk_index)): Path<(uuid::Uuid, uuid::Uuid, u64)>,
    headers: HeaderMap,
) -> Response<Body> {
    let request = request_for_authorization(Method::GET, "/v1/files/download", headers);
    let Ok(origin) = authorize_browser_request(&state, &request, false) else {
        return denied();
    };
    let execution_deadline = state.agent.remote_policy_execution_deadline(None);
    let Ok(policy_permit) = state.agent.capture_policy_revision() else {
        return cors_error(
            StatusCode::FORBIDDEN,
            "access_denied",
            "The remote policy lease expired.",
            &origin,
        );
    };
    let admission = AdmissionRequest {
        grant_id,
        collection_id: uuid::Uuid::nil(),
        class: WorkClass::File,
        weight_bytes: 1,
    };
    let Ok(permit) = state
        .agent
        .admission()
        .admit_before(
            admission,
            crate::admission::queue_deadline(execution_deadline),
        )
        .await
    else {
        return fenced_response(
            cors_busy("The local connector is busy.", &origin),
            state.agent.clone(),
            policy_permit,
            execution_deadline,
            None,
        );
    };
    if state.agent.admit_policy_revision(&policy_permit).is_err() {
        return abort_transport();
    }
    let agent = state.agent.clone();
    let download_origin = origin.clone();
    let execution = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        agent.direct_file_download_chunk(&download_origin, grant_id, transfer_id, chunk_index)
    });
    let outcome = tokio::time::timeout_at(execution_deadline, execution).await;
    let response = match outcome {
        Ok(Ok(Ok(bytes))) => {
            let mut response = Response::new(Body::from(bytes));
            *response.status_mut() = StatusCode::OK;
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/mdbase-connect-file"),
            );
            cors_response(response, &origin)
        }
        Ok(Ok(Err(_))) => cors_error(
            StatusCode::FORBIDDEN,
            "file_download_rejected",
            "The local connector rejected this file chunk request.",
            &origin,
        ),
        Ok(Err(_)) => cors_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "connector_failed",
            "The local connector could not read this file chunk.",
            &origin,
        ),
        Err(_) => return abort_transport(),
    };
    fenced_response(
        response,
        state.agent.clone(),
        policy_permit,
        execution_deadline,
        None,
    )
}
