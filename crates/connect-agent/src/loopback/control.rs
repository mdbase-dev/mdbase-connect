use super::*;
use crate::admission::{
    classify_operation, execution_timeout, queue_deadline, AdmissionPermit, AdmissionRequest,
};
use crate::operation_executor;
use crate::server::OperationExecutionState;
use axum::routing::{get, post};
use mdbase_connect_protocol::{
    ConnectOperationOutcome, ConnectProblem, RelayMessage, LOOPBACK_PROTOCOL_VERSION,
    OPERATION_TRANSPORT_PROTOCOL_VERSION,
};

#[derive(serde::Serialize)]
struct DirectOperationSuccess {
    ok: bool,
    envelope: RelayMessage,
}

struct EncodedDirectOperationSuccess {
    body: Vec<u8>,
    permit: AdmissionPermit,
}

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
    let deadline_unix_ms = envelope.deadline_unix_ms;
    let admission = AdmissionRequest {
        grant_id: envelope.grant_id,
        collection_id: envelope.collection_id,
        class: classify_operation(&envelope.operation, None),
        weight_bytes: envelope.ciphertext.len(),
    };
    let request_id = envelope.request_id;
    let class = admission.class;
    let Ok(permit) = state
        .agent
        .admission()
        .admit_before(admission, queue_deadline(deadline_unix_ms))
        .await
    else {
        return cors_busy("The local connector is busy.", &origin);
    };
    tracing::debug!(
        queue_wait_us = permit.queue_wait_us,
        "admitted direct connector operation"
    );
    let cancellation = mdbase::OperationCancellation::new();
    let worker_cancellation = cancellation.clone();
    let mut cancel_on_drop = CancelOnDrop(Some(cancellation));
    let execution_state = Arc::new(OperationExecutionState::default());
    let worker_execution_state = execution_state.clone();
    let agent = state.agent.clone();
    let operation_origin = origin.clone();
    let execution = operation_executor::spawn_blocking(class, move || {
        let response = agent.handle_direct_encrypted_operation_cancellable(
            &operation_origin,
            envelope,
            &worker_cancellation,
            &worker_execution_state,
        );
        match response {
            response @ RelayMessage::EncryptedOperationResponse { .. } => {
                serde_json::to_vec(&DirectOperationSuccess {
                    ok: true,
                    envelope: response,
                })
                .map(|body| Some(EncodedDirectOperationSuccess { body, permit }))
            }
            _ => Ok(None),
        }
    });
    let outcome = tokio::time::timeout(execution_timeout(deadline_unix_ms), execution).await;
    let timed_out_durable_mutation = if outcome.is_err() {
        let durable_mutation = execution_state.begin_timeout();
        if let Some(cancellation) = cancel_on_drop.0.take() {
            cancellation.cancel();
        }
        durable_mutation
    } else {
        cancel_on_drop.0 = None;
        false
    };
    match outcome {
        Ok(Ok(Ok(Some(encoded)))) => {
            let content_length = encoded.body.len();
            let stream = futures_util::stream::unfold(
                (
                    axum::body::Bytes::from(encoded.body),
                    encoded.permit,
                ),
                |(mut body, permit)| async move {
                    if body.is_empty() {
                        return None;
                    }
                    let chunk = body.split_to(body.len().min(64 * 1024));
                    Some((
                        Ok::<_, std::convert::Infallible>(chunk),
                        (body, permit),
                    ))
                },
            );
            let mut response = Response::new(Body::from_stream(stream));
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
            if let Ok(length) = HeaderValue::from_str(&content_length.to_string()) {
                response.headers_mut().insert(header::CONTENT_LENGTH, length);
            }
            cors_response(response, &origin)
        }
        Ok(Ok(Ok(None))) => cors_error(
            StatusCode::FORBIDDEN,
            "direct_operation_rejected",
            "The local connector rejected this operation.",
            &origin,
        ),
        Ok(Ok(Err(_))) | Ok(Err(_)) => cors_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "connector_failed",
            "The local connector could not complete this operation.",
            &origin,
        ),
        Err(_) if timed_out_durable_mutation => cors_problem(
            StatusCode::CONFLICT,
            ConnectProblem::new(
                "operation_outcome_unknown",
                "The durable mutation may have completed after its caller's deadline expired. Retry the exact same request to recover its result.",
            )
            .with_details(serde_json::json!({ "request_id": request_id }))
            .with_operation_outcome(ConnectOperationOutcome::Unknown),
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

struct CancelOnDrop(Option<mdbase::OperationCancellation>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(cancellation) = self.0.take() {
            cancellation.cancel();
        }
    }
}
