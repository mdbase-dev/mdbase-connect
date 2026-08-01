use crate::server::AgentState;
use futures_util::{SinkExt, StreamExt};
use mdbase_connect_protocol::{
    AgentConnectionState, RelayFileFrame, RelayMessage, CONTROL_PROTOCOL_VERSION,
    RELAY_CAPABILITIES, RELAY_HANDSHAKE_TIMEOUT_SECONDS, RELAY_REQUIRED_CAPABILITIES,
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
    match serde_json::from_str::<RelayMessage>(welcome.as_ref())? {
        RelayMessage::RelayWelcome {
            protocol_version,
            capabilities,
            ..
        } if protocol_version == CONTROL_PROTOCOL_VERSION
            && RELAY_REQUIRED_CAPABILITIES
                .iter()
                .all(|required| capabilities.iter().any(|value| value == required)) => {}
        RelayMessage::RelayIncompatible { message, .. } => return Err(message.into()),
        _ => return Err("relay returned an incompatible handshake response".into()),
    }
    let (mut writer, mut reader) = socket.split();
    let (responses, mut response_rx) = tokio::sync::mpsc::channel::<RelayMessage>(64);
    let (file_responses, mut file_response_rx) = tokio::sync::mpsc::channel::<RelayFileFrame>(8);
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
                            // Apply policy in receive order so every subsequently
                            // accepted operation sees the latest local grant state.
                            if let Some(response) = state.handle_relay_message(relay_message) {
                                writer.send(Message::Text(
                                    serde_json::to_string(&response)?.into()
                                )).await?;
                            }
                        } else {
                            let state_for_operation = state.clone();
                            let responses = responses.clone();
                            let operation_slots = operation_slots.clone();
                            tokio::spawn(async move {
                                let Ok(_permit) = operation_slots.acquire_owned().await else {
                                    return;
                                };
                                match tokio::task::spawn_blocking(move || {
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
                        // Acquire before spawning so the websocket itself provides bounded
                        // backpressure instead of retaining an unbounded queue of file frames.
                        let permit = file_slots.clone().acquire_owned().await?;
                        let state_for_file = state.clone();
                        let file_responses = file_responses.clone();
                        tokio::spawn(async move {
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
}
