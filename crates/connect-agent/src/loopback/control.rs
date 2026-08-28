use super::*;
use crate::admission::{classify_operation, queue_deadline, AdmissionPermit, AdmissionRequest};
use crate::operation_executor;
use crate::server::OperationExecutionState;
use axum::routing::{get, post};
use mdbase_connect_protocol::{
    RelayMessage, LOOPBACK_PROTOCOL_VERSION, OPERATION_TRANSPORT_PROTOCOL_VERSION,
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
    let execution_deadline = state
        .agent
        .remote_policy_execution_deadline(deadline_unix_ms);
    let Ok(policy_permit) = state.agent.capture_policy_revision() else {
        return cors_error(
            StatusCode::FORBIDDEN,
            "access_denied",
            "The remote policy lease expired.",
            &origin,
        );
    };
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
        .admit_before(admission, queue_deadline(execution_deadline))
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
    tracing::debug!(
        queue_wait_us = permit.queue_wait_us,
        "admitted direct connector operation"
    );
    let cancellation = mdbase::OperationCancellation::new();
    let registration = state.agent.register_remote_operation(&cancellation);
    let worker_cancellation = cancellation.clone();
    let mut cancel_on_drop = CancelOnDrop(Some(cancellation));
    let execution_state = Arc::new(OperationExecutionState::default());
    let worker_execution_state = execution_state.clone();
    let agent = state.agent.clone();
    let operation_origin = origin.clone();
    let execution_policy = policy_permit.clone();
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
    let outcome = tokio::time::timeout_at(execution_deadline, execution).await;
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
    state.agent.unregister_remote_operation(registration);
    match outcome {
        Ok(Ok(Ok(Some(encoded)))) => {
            let mut response = Response::new(Body::from(encoded.body));
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
            fenced_response(
                cors_response(response, &origin),
                state.agent.clone(),
                execution_policy,
                execution_deadline,
                Some(encoded.permit),
            )
        }
        Ok(Ok(Ok(None))) => fenced_response(
            cors_error(
                StatusCode::FORBIDDEN,
                "direct_operation_rejected",
                "The local connector rejected this operation.",
                &origin,
            ),
            state.agent.clone(),
            execution_policy,
            execution_deadline,
            None,
        ),
        Ok(Ok(Err(_))) | Ok(Err(_)) => fenced_response(
            cors_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "connector_failed",
                "The local connector could not complete this operation.",
                &origin,
            ),
            state.agent.clone(),
            execution_policy,
            execution_deadline,
            None,
        ),
        // The one absolute deadline includes publication. Never manufacture a
        // fresh timeout or unknown-outcome body after that boundary.
        Err(_) => {
            let _ = (timed_out_durable_mutation, request_id);
            abort_transport()
        }
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
