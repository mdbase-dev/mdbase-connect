//! A control-protocol client (the CLI; tests). The desktop app has its own in
//! TypeScript over the same frames.

use std::time::Duration;

use serde_json::Value;

use crate::control::{ControlError, PROTOCOL, Readiness, Request, Response};
use crate::ipc::{self, BoxStream};
use crate::paths::Endpoint;

/// How long one control call may take before the CLI gives up.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// Client failures.
#[derive(Debug)]
pub enum ClientError {
    /// Nothing is listening on the endpoint.
    NotRunning,
    /// Transport failure.
    Io(std::io::Error),
    /// The daemon sent something this client does not understand.
    Protocol(String),
    /// The daemon answered with an error.
    Remote(ControlError),
    /// No answer in time.
    Timeout,
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::NotRunning => f.write_str("the mdbase daemon is not running"),
            ClientError::Io(e) => write!(f, "daemon connection: {e}"),
            ClientError::Protocol(m) => write!(f, "daemon protocol: {m}"),
            ClientError::Remote(e) => write!(f, "{e}"),
            ClientError::Timeout => f.write_str("the daemon did not answer in time"),
        }
    }
}

impl std::error::Error for ClientError {}

/// A connected control client.
pub struct ControlClient {
    stream: BoxStream,
    next_id: u64,
}

impl ControlClient {
    /// Connect; [`ClientError::NotRunning`] if no daemon listens.
    pub async fn connect(endpoint: &Endpoint) -> Result<ControlClient, ClientError> {
        match ipc::connect(endpoint).await {
            Ok(stream) => Ok(ControlClient { stream, next_id: 1 }),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
                ) =>
            {
                Err(ClientError::NotRunning)
            }
            Err(e) => Err(ClientError::Io(e)),
        }
    }

    /// Call a method and wait for its response (pushes received meanwhile are
    /// dropped; use [`ControlClient::next_push`] after `status.subscribe`).
    pub async fn call(&mut self, method: &str, params: Value) -> Result<Value, ClientError> {
        let id = self.next_id;
        self.next_id += 1;
        let req = Request {
            v: PROTOCOL,
            id,
            method: method.to_string(),
            params,
        };
        let bytes = serde_json::to_vec(&req).map_err(|e| ClientError::Protocol(e.to_string()))?;
        let fut = async {
            ipc::write_frame(&mut self.stream, &bytes)
                .await
                .map_err(ClientError::Io)?;
            loop {
                let resp = self.read().await?;
                if resp.id != Some(id) {
                    continue;
                }
                return match (resp.result, resp.error) {
                    (_, Some(e)) => Err(ClientError::Remote(e)),
                    (Some(v), None) => Ok(v),
                    (None, None) => Err(ClientError::Protocol("empty response".into())),
                };
            }
        };
        tokio::time::timeout(CALL_TIMEOUT, fut)
            .await
            .map_err(|_| ClientError::Timeout)?
    }

    /// Authenticate this connection with the control key from `store`, so
    /// privileged methods are allowed.
    pub async fn authenticate(
        &mut self,
        store: &dyn crate::secrets::SecretStore,
    ) -> Result<(), ClientError> {
        let key = crate::secrets::read_control_key(store)
            .map_err(|e| ClientError::Protocol(e.to_string()))?
            .ok_or_else(|| ClientError::Protocol("no control key in the keychain yet".into()))?;
        let v = self
            .call(
                crate::control::Method::AUTH_CHALLENGE,
                serde_json::json!({}),
            )
            .await?;
        let nonce = v
            .get("nonce")
            .and_then(Value::as_str)
            .and_then(|h| crate::secrets::hex_decode(h).ok())
            .ok_or_else(|| ClientError::Protocol("bad challenge".into()))?;
        let proof = crate::secrets::hex(&crate::secrets::control_proof(&key, &nonce));
        self.call(
            crate::control::Method::AUTH_PROVE,
            serde_json::json!({ "proof": proof }),
        )
        .await?;
        Ok(())
    }

    /// The next push frame: `(type, payload)`. `None` when the daemon closed.
    pub async fn next_push(&mut self) -> Result<Option<(String, Value)>, ClientError> {
        loop {
            match self.read_opt().await? {
                None => return Ok(None),
                Some(Response {
                    push: Some(kind),
                    payload,
                    ..
                }) => return Ok(Some((kind, payload.unwrap_or(Value::Null)))),
                Some(_) => continue,
            }
        }
    }

    async fn read(&mut self) -> Result<Response, ClientError> {
        self.read_opt().await?.ok_or_else(|| {
            ClientError::Io(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "the daemon closed the connection",
            ))
        })
    }

    async fn read_opt(&mut self) -> Result<Option<Response>, ClientError> {
        let Some(frame) = ipc::read_frame(&mut self.stream, ipc::MAX_CONTROL_FRAME)
            .await
            .map_err(ClientError::Io)?
        else {
            return Ok(None);
        };
        serde_json::from_slice(&frame)
            .map(Some)
            .map_err(|e| ClientError::Protocol(e.to_string()))
    }
}

/// One `ping`: the daemon's readiness, or why it could not be read.
pub async fn ping(endpoint: &Endpoint) -> Result<Readiness, ClientError> {
    let mut c = ControlClient::connect(endpoint).await?;
    let v = c
        .call(crate::control::Method::PING, serde_json::json!({}))
        .await?;
    serde_json::from_value(v.get("readiness").cloned().unwrap_or(Value::Null))
        .map_err(|e| ClientError::Protocol(format!("readiness: {e}")))
}
