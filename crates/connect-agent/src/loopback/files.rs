use super::*;
use axum::body::Bytes;
use axum::extract::Path;
use axum::routing::{get, post};
use mdbase_connect_protocol::{
    FILE_FRAME_PREFIX_BYTES, MAX_FILE_CHUNK_BYTES, MAX_FILE_FRAME_HEADER_BYTES,
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
    let Some(permit) = operation_permit(&state).await else {
        return cors_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "connector_busy",
            "The local connector is busy.",
            &origin,
        );
    };
    let agent = state.agent.clone();
    let upload_origin = origin.clone();
    let execution = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        agent.handle_direct_file_upload(&upload_origin, &body)
    });
    match tokio::time::timeout(Duration::from_secs(30), execution).await {
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
        Err(_) => cors_error(
            StatusCode::GATEWAY_TIMEOUT,
            "connector_timeout",
            "The local connector did not store this file chunk in time.",
            &origin,
        ),
    }
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
    let Some(permit) = operation_permit(&state).await else {
        return cors_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "connector_busy",
            "The local connector is busy.",
            &origin,
        );
    };
    let agent = state.agent.clone();
    let download_origin = origin.clone();
    let execution = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        agent.direct_file_download_chunk(&download_origin, grant_id, transfer_id, chunk_index)
    });
    match tokio::time::timeout(Duration::from_secs(30), execution).await {
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
        Err(_) => cors_error(
            StatusCode::GATEWAY_TIMEOUT,
            "connector_timeout",
            "The local connector did not read this file chunk in time.",
            &origin,
        ),
    }
}
