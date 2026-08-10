use crate::server::AgentState;
use futures_util::{SinkExt, StreamExt};
use mdbase_connect_protocol::{
    AgentConnectionState, ConnectContractSupport, ConnectOperationOutcome, ConnectProblem,
    RelayFileFrame, RelayFileKind, RelayMessage, CONTROL_PROTOCOL_VERSION,
    PROTOCOL_USAGE_REPORT_CAPABILITY, RELAY_CAPABILITIES, RELAY_HANDSHAKE_TIMEOUT_SECONDS,
    RELAY_REQUIRED_CAPABILITIES,
};
use reqwest::Client;
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use url::Url;

pub async fn run(server_url: String, connector_token: String, state: Arc<AgentState>) {
    crate::ensure_tls_crypto_provider();
    let client = Client::new();
    let mut retry_delay = 1u64;
    loop {
        state.set_connection_state(AgentConnectionState::Connecting);
        let result = connect_once(&client, &server_url, &connector_token, state.clone()).await;
        state.set_connection_state(AgentConnectionState::Offline);
        if let Err(error) = result {
            tracing::warn!(%error, retry_seconds = retry_delay, "cloud relay disconnected");
        }
        tokio::time::sleep(Duration::from_secs(retry_delay)).await;
        retry_delay = (retry_delay * 2).min(30);
    }
}

async fn connect_once(
    client: &Client,
    server_url: &str,
    connector_token: &str,
    state: Arc<AgentState>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    sync_collections(client, server_url, connector_token, &state).await?;
    let websocket_url = websocket_url(server_url)?;
    let mut request = websocket_url.as_str().into_client_request()?;
    request.headers_mut().insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {connector_token}"))?,
    );
    let (mut socket, _) = connect_async(request).await?;
    socket
        .send(Message::Text(
            serde_json::to_string(&RelayMessage::RelayHello {
                protocol_version: CONTROL_PROTOCOL_VERSION,
                connector_version: env!("CARGO_PKG_VERSION").to_string(),
                capabilities: RELAY_CAPABILITIES
                    .iter()
                    .map(|capability| (*capability).to_string())
                    .collect(),
                contract_support: ConnectContractSupport::default(),
            })?
            .into(),
        ))
        .await?;
    let welcome = tokio::time::timeout(
        Duration::from_secs(RELAY_HANDSHAKE_TIMEOUT_SECONDS),
        socket.next(),
    )
    .await
    .map_err(|_| "relay handshake timed out")?
    .ok_or("relay closed during handshake")??;
    let Message::Text(welcome) = welcome else {
        return Err("relay returned a non-text handshake response".into());
    };
    let usage_reporting = match serde_json::from_str::<RelayMessage>(welcome.as_ref())? {
        RelayMessage::RelayWelcome {
            protocol_version,
            capabilities,
            contract_support,
            ..
        } if protocol_version == CONTROL_PROTOCOL_VERSION
            && contract_support.supports_current()
            && RELAY_REQUIRED_CAPABILITIES
                .iter()
                .all(|required| capabilities.iter().any(|value| value == required)) =>
        {
            capabilities
                .iter()
                .any(|value| value == PROTOCOL_USAGE_REPORT_CAPABILITY)
        }
        RelayMessage::RelayIncompatible { message, .. } => return Err(message.into()),
        _ => return Err("relay returned an incompatible handshake response".into()),
    };
    let (mut writer, mut reader) = socket.split();
    let (responses, mut response_rx) = tokio::sync::mpsc::channel::<RelayMessage>(64);
    let (file_responses, mut file_response_rx) = tokio::sync::mpsc::channel::<RelayFileFrame>(8);
    let (policy_jobs, mut policy_job_rx) = tokio::sync::mpsc::channel::<(u64, RelayMessage)>(8);
    let (policy_applied, policy_applied_rx) = tokio::sync::watch::channel((0_u64, true));
    let policy_state = state.clone();
    let policy_responses = responses.clone();
    tokio::spawn(async move {
        while let Some((generation, message)) = policy_job_rx.recv().await {
            let state = policy_state.clone();
            let mut usable = false;
            match tokio::task::spawn_blocking(move || state.handle_relay_message(message)).await {
                Ok(Some(response)) => {
                    usable = matches!(&response, RelayMessage::PolicyApplied { ok: true, .. });
                    let _ = policy_responses.send(response).await;
                }
                Ok(None) => {}
                Err(error) => tracing::warn!(%error, generation, "relay policy task failed"),
            }
            policy_applied.send_replace((generation, usable));
        }
    });
    let mut received_policy_generation = 0_u64;
    let operation_slots = Arc::new(tokio::sync::Semaphore::new(16));
    let file_slots = Arc::new(tokio::sync::Semaphore::new(8));
    state.set_connection_state(AgentConnectionState::Connected);
    tracing::info!(server = server_url, "connected to cloud relay");
    let mut sync_interval = tokio::time::interval(Duration::from_secs(15));

    loop {
        tokio::select! {
            message = reader.next() => {
                let Some(message) = message else { return Err("relay closed the connection".into()); };
                match message? {
                    Message::Text(text) => {
                        let relay_message: RelayMessage = serde_json::from_str(text.as_ref())?;
                        if matches!(&relay_message, RelayMessage::PolicySnapshot { .. }) {
                            // A dedicated single consumer preserves snapshot order without
                            // blocking websocket pings or reads on SQLite. Every subsequent
                            // operation captures this generation and waits for its commit.
                            received_policy_generation = received_policy_generation
                                .checked_add(1)
                                .ok_or("relay policy generation overflow")?;
                            policy_jobs
                                .try_send((received_policy_generation, relay_message))
                                .map_err(|_| "relay policy queue is full")?;
                        } else {
                            let state_for_operation = state.clone();
                            let responses = responses.clone();
                            let policy_applied = policy_applied_rx.clone();
                            let required_policy_generation = received_policy_generation;
                            let Ok(permit) = operation_slots.clone().try_acquire_owned() else {
                                if let Some(response) = relay_operation_rejection(
                                    &relay_message,
                                    "The connector is processing its bounded operation queue.",
                                ) {
                                    let _ = responses.try_send(response);
                                }
                                continue;
                            };
                            tokio::spawn(async move {
                                if !wait_for_policy(policy_applied, required_policy_generation).await.unwrap_or(false) {
                                    if let Some(response) = relay_operation_rejection(
                                        &relay_message,
                                        "The connector could not install the required policy snapshot.",
                                    ) {
                                        let _ = responses.send(response).await;
                                    }
                                    return;
                                }
                                match tokio::task::spawn_blocking(move || {
                                    let _permit = permit;
                                    state_for_operation.handle_relay_message(relay_message)
                                }).await {
                                    Ok(Some(response)) => {
                                        let _ = responses.send(response).await;
                                    }
                                    Ok(None) => {}
                                    Err(error) => tracing::warn!(%error, "relay operation task failed"),
                                }
                            });
                        }
                    }
                    Message::Binary(bytes) => {
                        let request = match RelayFileFrame::decode(&bytes) {
                            Ok(request) => request,
                            Err(error) => {
                                tracing::warn!(%error, "relay sent an invalid binary file message");
                                continue;
                            }
                        };
                        let Ok(permit) = file_slots.clone().try_acquire_owned() else {
                            let _ = file_responses.try_send(rejected_file_frame(&request));
                            continue;
                        };
                        let state_for_file = state.clone();
                        let file_responses = file_responses.clone();
                        let policy_applied = policy_applied_rx.clone();
                        let required_policy_generation = received_policy_generation;
                        tokio::spawn(async move {
                            if !wait_for_policy(policy_applied, required_policy_generation).await.unwrap_or(false) {
                                let _ = file_responses.send(rejected_file_frame(&request)).await;
                                return;
                            }
                            let response = tokio::task::spawn_blocking(move || {
                                let _permit = permit;
                                state_for_file.handle_relay_file_frame(request)
                            }).await;
                            match response {
                                Ok(response) => {
                                    let _ = file_responses.send(response).await;
                                }
                                Err(error) => tracing::warn!(%error, "relay file task failed"),
                            }
                        });
                    }
                    Message::Ping(payload) => writer.send(Message::Pong(payload)).await?,
                    Message::Close(_) => return Err("relay closed the connection".into()),
                    _ => {}
                }
            }
            response = response_rx.recv() => {
                let Some(response) = response else {
                    return Err("relay response channel closed".into());
                };
                writer.send(Message::Text(serde_json::to_string(&response)?.into())).await?;
            }
            response = file_response_rx.recv() => {
                let Some(response) = response else {
                    return Err("relay file response channel closed".into());
                };
                writer.send(Message::Binary(response.encode()?.into())).await?;
            }
            _ = sync_interval.tick() => {
                if usage_reporting {
                    let entries = state.take_direct_protocol_usage();
                    if !entries.is_empty() {
                        writer.send(Message::Text(serde_json::to_string(
                            &RelayMessage::ProtocolUsageReport {
                                protocol_version: CONTROL_PROTOCOL_VERSION,
                                entries,
                            }
                        )?.into())).await?;
                    }
                }
                let client = client.clone();
                let server_url = server_url.to_string();
                let connector_token = connector_token.to_string();
                let state = state.clone();
                tokio::spawn(async move {
                    if let Err(error) = sync_collections(
                        &client,
                        &server_url,
                        &connector_token,
                        &state,
                    ).await {
                        tracing::warn!(%error, "collection sync failed");
                    }
                });
            }
        }
    }
}

fn relay_operation_rejection(request: &RelayMessage, message: &str) -> Option<RelayMessage> {
    let problem = || {
        ConnectProblem::new("connector_busy", message)
            .with_operation_outcome(ConnectOperationOutcome::Rejected)
    };
    match request {
        RelayMessage::OperationRequest { request_id, .. } => {
            let protocol_version = match request {
                RelayMessage::OperationRequest {
                    protocol_version, ..
                } => *protocol_version,
                _ => unreachable!(),
            };
            Some(RelayMessage::OperationResponse {
                protocol_version,
                request_id: *request_id,
                ok: false,
                result: None,
                problem: Some(problem()),
            })
        }
        RelayMessage::EncryptedOperationRequest { envelope } => {
            Some(RelayMessage::EncryptedOperationRejected {
                protocol_version: envelope.protocol_version,
                request_id: envelope.request_id,
                problem: problem(),
            })
        }
        _ => None,
    }
}

fn rejected_file_frame(request: &RelayFileFrame) -> RelayFileFrame {
    RelayFileFrame {
        kind: RelayFileKind::Rejected,
        header: mdbase_connect_protocol::RelayFileHeader {
            message_type: RelayFileKind::Rejected,
            ..request.header.clone()
        },
        payload: Vec::new(),
    }
}

async fn wait_for_policy(
    mut applied: tokio::sync::watch::Receiver<(u64, bool)>,
    required_generation: u64,
) -> Result<bool, tokio::sync::watch::error::RecvError> {
    while applied.borrow_and_update().0 < required_generation {
        applied.changed().await?;
    }
    let (generation, usable) = *applied.borrow_and_update();
    Ok(generation == required_generation && usable)
}

async fn sync_collections(
    client: &Client,
    server_url: &str,
    connector_token: &str,
    state: &AgentState,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let collections = state.collections()?;
    let inventory_revision = state.next_inventory_revision()?;
    let payload = serde_json::json!({
        "relay_public_key": state.relay_public_key(),
        "inventory_revision": inventory_revision,
        "collections": collections.into_iter().map(|collection| serde_json::json!({
            "id": collection.id,
            "display_name": collection.display_name,
            "spec_version": collection.spec_version,
            "enabled": collection.enabled,
            "contracts": collection.contracts
        })).collect::<Vec<_>>()
    });
    let response = client
        .post(format!(
            "{}/v1/connectors/sync",
            server_url.trim_end_matches('/')
        ))
        .bearer_auth(connector_token)
        .json(&payload)
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(format!("collection sync failed with HTTP {}", response.status()).into());
    }
    Ok(())
}

fn websocket_url(server_url: &str) -> Result<Url, Box<dyn std::error::Error + Send + Sync>> {
    let mut url = Url::parse(server_url)?;
    match url.scheme() {
        "http" => url
            .set_scheme("ws")
            .map_err(|_| "invalid HTTP server URL")?,
        "https" => url
            .set_scheme("wss")
            .map_err(|_| "invalid HTTPS server URL")?,
        _ => return Err("server URL must use HTTP or HTTPS".into()),
    }
    url.set_path("/v1/relay");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_http_server_to_websocket_relay() {
        assert_eq!(
            websocket_url("https://connect.example/base")
                .unwrap()
                .as_str(),
            "wss://connect.example/v1/relay"
        );
    }

    #[tokio::test]
    async fn policy_barrier_orders_generations_and_fails_closed() {
        let (sender, receiver) = tokio::sync::watch::channel((0_u64, true));
        let waiting = tokio::spawn(wait_for_policy(receiver.clone(), 2));
        sender.send_replace((1, true));
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        sender.send_replace((2, true));
        assert!(waiting.await.unwrap().unwrap());

        let failed = tokio::spawn(wait_for_policy(receiver, 3));
        sender.send_replace((3, false));
        assert!(!failed.await.unwrap().unwrap());
    }

    #[test]
    fn overload_rejections_preserve_request_identity() {
        let request_id = uuid::Uuid::new_v4();
        let request = RelayMessage::OperationRequest {
            protocol_version: mdbase_connect_protocol::OPERATION_TRANSPORT_PROTOCOL_VERSION,
            request_id,
            grant_id: uuid::Uuid::new_v4(),
            collection_id: uuid::Uuid::new_v4(),
            application_id: uuid::Uuid::new_v4(),
            operation: "read".to_string(),
            input: serde_json::json!({}),
        };
        assert!(matches!(
            relay_operation_rejection(&request, "busy"),
            Some(RelayMessage::OperationResponse {
                request_id: returned,
                problem: Some(problem),
                ..
            }) if returned == request_id && problem.code == "connector_busy"
        ));
    }
}
