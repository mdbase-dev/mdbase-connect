use super::*;
use axum::routing::{get, post};
use mdbase_connect_protocol::{
    RelayMessage, LOOPBACK_PROTOCOL_VERSION, OPERATION_TRANSPORT_PROTOCOL_VERSION,
};

pub(super) fn routes() -> Router<LoopbackState> {
    Router::new()
        .route("/v1/ready", get(ready).options(preflight))
        .route("/v1/operations", post(operation).options(preflight))
        .route("/v1/files/control", post(file_control).options(preflight))
}

async fn ready(State(state): State<LoopbackState>, request: Request<Body>) -> Response<Body> {
    let Ok(origin) = authorize_browser_request(&state, &request, false) else {
        return denied();
    };
    cors_response(
        Json(json!({
            "service": "mdbase-connect",
            "loopback_protocol_version": LOOPBACK_PROTOCOL_VERSION,
            "operation_transport_protocol_version": OPERATION_TRANSPORT_PROTOCOL_VERSION,
        }))
        .into_response(),
        &origin,
    )
}

pub(super) async fn preflight(
    State(state): State<LoopbackState>,
    request: Request<Body>,
) -> Response<Body> {
    let Ok(origin) = authorize_browser_request(&state, &request, true) else {
        return denied();
    };
    let requested_method = request
        .headers()
        .get(header::ACCESS_CONTROL_REQUEST_METHOD)
        .and_then(|value| value.to_str().ok());
    if !matches!(requested_method, Some("GET" | "POST")) {
        return denied();
    }
    let requested_headers = request
        .headers()
        .get(header::ACCESS_CONTROL_REQUEST_HEADERS)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if requested_headers
        .split(',')
        .map(|value| value.trim().to_ascii_lowercase())
        .any(|value| !value.is_empty() && value != "content-type")
    {
        return denied();
    }
    let mut response = cors_response(StatusCode::NO_CONTENT.into_response(), &origin);
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Content-Type"),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("600"),
    );
    if request
        .headers()
        .get("access-control-request-private-network")
        .is_some_and(|value| value == "true")
    {
        response.headers_mut().insert(
            "access-control-allow-private-network",
            HeaderValue::from_static("true"),
        );
    }
    response
}

async fn operation(
    State(state): State<LoopbackState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response<Body> {
    encrypted_control(state, headers, body, "/v1/operations", None).await
}

async fn file_control(
    State(state): State<LoopbackState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response<Body> {
    encrypted_control(
        state,
        headers,
        body,
        "/v1/files/control",
        Some("file_control"),
    )
    .await
}

async fn encrypted_control(
    state: LoopbackState,
    headers: HeaderMap,
    body: serde_json::Value,
    uri: &'static str,
    expected_operation: Option<&'static str>,
) -> Response<Body> {
    let request = request_for_authorization(Method::POST, uri, headers);
    let Ok(origin) = authorize_browser_request(&state, &request, false) else {
        return denied();
    };
    if serde_json::to_vec(&body).is_ok_and(|encoded| encoded.len() > MAX_REQUEST_BYTES) {
        return cors_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "encrypted_request_too_large",
            "The encrypted control request exceeds the protocol limit.",
            &origin,
        );
    }
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        != Some("application/mdbase-connect+json")
    {
        return cors_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            "Direct operations require application/mdbase-connect+json.",
            &origin,
        );
    }
    let Ok(RelayMessage::EncryptedOperationRequest { envelope }) =
        serde_json::from_value::<RelayMessage>(body)
    else {
        return cors_error(
            StatusCode::UPGRADE_REQUIRED,
            "encryption_required",
            "Direct operations require encrypted protocol 1.",
            &origin,
        );
    };
    if expected_operation.is_some_and(|operation| envelope.operation != operation) {
        return cors_error(
            StatusCode::BAD_REQUEST,
            "invalid_file_control",
            "The file control endpoint only accepts encrypted file control messages.",
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
    let operation_origin = origin.clone();
    let execution = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        agent.handle_direct_encrypted_operation(&operation_origin, envelope)
    });
    match tokio::time::timeout(Duration::from_secs(30), execution).await {
        Ok(Ok(RelayMessage::EncryptedOperationResponse { envelope })) => cors_response(
            Json(json!({
                "ok": true,
                "envelope": RelayMessage::EncryptedOperationResponse { envelope }
            }))
            .into_response(),
            &origin,
        ),
        Ok(Ok(_)) => cors_error(
            StatusCode::FORBIDDEN,
            "direct_operation_rejected",
            "The local connector rejected this operation.",
            &origin,
        ),
        Ok(Err(_)) => cors_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "connector_failed",
            "The local connector could not complete this operation.",
            &origin,
        ),
        Err(_) => cors_error(
            StatusCode::GATEWAY_TIMEOUT,
            "connector_timeout",
            "The local connector did not complete this operation in time.",
            &origin,
        ),
    }
}
