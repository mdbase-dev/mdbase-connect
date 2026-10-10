//! A log-service client over the wire: one WebSocket per collection, concurrent
//! requests correlated by ID, pushes on a channel.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use mdbn_log_service::auth::{hello_digest, http_digest, request_collection};
use mdbn_log_service::model::unhex;
use mdbn_log_service::testkit::{ControlPlane, Device, sign_digest};
use mdbn_log_service::{Code, ServiceError};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B32, Uuid, Version};
use mdbn_wire::log_service::{LsFrame, LsHelloParams, LsPush, LsRequest, LsResponse};
use mdbn_wire::schema::Wire;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

/// Who connects.
#[derive(Clone, Copy)]
pub enum Cred<'a> {
    /// A device (token from the control plane, bound to its key).
    Device(&'a Device),
    /// The control plane itself.
    ControlPlane,
    /// A device token, but the possession proof signed by another key.
    BadPossession(&'a Device, &'a Device),
    /// An expired device token.
    Expired(&'a Device),
    /// A device token scoped to one collection (claim 5).
    Scoped(&'a Device, Uuid),
}

/// Wall-clock milliseconds.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

type Pending = Arc<Mutex<BTreeMap<u64, oneshot::Sender<LsResponse>>>>;

/// A connected, authenticated client.
pub struct Client {
    out: mpsc::UnboundedSender<Message>,
    pending: Pending,
    pushes: tokio::sync::Mutex<mpsc::UnboundedReceiver<LsPush>>,
    next: AtomicU64,
    /// Request timeout.
    pub timeout: Duration,
}

fn transport(m: impl std::fmt::Display) -> ServiceError {
    ServiceError::new(Code::Unavailable).msg(format!("transport: {m}"))
}

impl Client {
    /// Connect to `{ws_base}/v1/ws?c=<collection>` and say `hello`.
    pub async fn connect(
        ws_base: &str,
        collection: &Uuid,
        cred: Cred<'_>,
        cp: &ControlPlane,
    ) -> Result<Client, ServiceError> {
        let url = format!("{ws_base}/v1/ws?c={}", collection.to_uuid_string());
        let (ws, resp) = tokio_tungstenite::connect_async(url)
            .await
            .map_err(transport)?;
        let nonce: [u8; 32] = resp
            .headers()
            .get("x-mdbase-nonce")
            .and_then(|v| v.to_str().ok())
            .and_then(unhex)
            .and_then(|v| v.try_into().ok())
            .ok_or_else(|| transport("no nonce in upgrade response"))?;
        let (mut sink, mut stream) = ws.split();
        let (out, mut out_rx) = mpsc::unbounded_channel::<Message>();
        tokio::spawn(async move {
            while let Some(m) = out_rx.recv().await {
                if sink.send(m).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });
        let pending: Pending = Arc::new(Mutex::new(BTreeMap::new()));
        let (push_tx, push_rx) = mpsc::unbounded_channel();
        let p = pending.clone();
        tokio::spawn(async move {
            while let Some(Ok(m)) = stream.next().await {
                let b = match m {
                    Message::Binary(b) => b,
                    Message::Close(_) => break,
                    _ => continue,
                };
                match LsFrame::from_bytes(&b) {
                    Ok(LsFrame::Response(r)) => {
                        if let Some(tx) = p.lock().unwrap().remove(&r.id) {
                            let _ = tx.send(r);
                        }
                    }
                    Ok(LsFrame::Push(push)) => {
                        let _ = push_tx.send(push);
                    }
                    _ => {}
                }
            }
            p.lock().unwrap().clear();
        });
        let c = Client {
            out,
            pending,
            pushes: tokio::sync::Mutex::new(push_rx),
            next: AtomicU64::new(1),
            timeout: Duration::from_secs(30),
        };
        let exp = now_ms() + 15 * 60 * 1000;
        let (token, device, sig) = match cred {
            Cred::Device(d) => {
                let t = cp.device_token(d, exp);
                let s = d.hello_sig(&nonce, &t);
                (t, Some(d.id), s)
            }
            Cred::ControlPlane => {
                let t = cp.cp_token(exp);
                let s = sign_digest(cp.transport_key(), &hello_digest(&nonce, &t));
                (t, None, s)
            }
            Cred::BadPossession(d, other) => {
                let t = cp.device_token(d, exp);
                let s = other.hello_sig(&nonce, &t);
                (t, Some(d.id), s)
            }
            Cred::Scoped(d, c) => {
                let t = cp.device_token_for(d, exp, Some(c));
                let s = d.hello_sig(&nonce, &t);
                (t, Some(d.id), s)
            }
            Cred::Expired(d) => {
                let t = cp.device_token(d, now_ms() - 1000);
                let s = d.hello_sig(&nonce, &t);
                (t, Some(d.id), s)
            }
        };
        c.call(
            "hello",
            LsHelloParams {
                version: Version { major: 1, minor: 0 },
                token,
                device,
                sig,
            }
            .to_cbor(),
        )
        .await?;
        Ok(c)
    }

    /// One request.
    pub async fn call(&self, method: &str, params: Cbor) -> Result<Cbor, ServiceError> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let frame = LsFrame::Request(LsRequest {
            id,
            method: method.to_string(),
            params,
        })
        .to_bytes()
        .map_err(transport)?;
        self.out
            .send(Message::Binary(frame.into()))
            .map_err(|_| transport("closed"))?;
        let r = tokio::time::timeout(self.timeout, rx)
            .await
            .map_err(|_| {
                self.pending.lock().unwrap().remove(&id);
                transport("timeout")
            })?
            .map_err(|_| transport("connection lost"))?;
        match (r.result, r.error) {
            (_, Some(e)) => Err(ServiceError::from_wire(&e)),
            (Some(v), None) => Ok(v),
            (None, None) => Err(transport("empty response")),
        }
    }

    /// Typed call.
    pub async fn call_t<P: Wire, R: Wire>(&self, method: &str, p: &P) -> Result<R, ServiceError> {
        let v = self.call(method, p.to_cbor()).await?;
        R::from_cbor(&v).map_err(|e| transport(format!("bad result: {e}")))
    }

    /// The next push, or `None` after `wait`.
    pub async fn push(&self, wait: Duration) -> Option<LsPush> {
        let mut rx = self.pushes.lock().await;
        tokio::time::timeout(wait, rx.recv()).await.ok().flatten()
    }

    /// Drain pushes already received.
    pub async fn drain(&self) -> Vec<LsPush> {
        let mut rx = self.pushes.lock().await;
        let mut v = Vec::new();
        while let Ok(p) = rx.try_recv() {
            v.push(p);
        }
        v
    }

    /// Close the socket.
    pub fn close(&self) {
        let _ = self.out.send(Message::Close(None));
    }
}

/// A random UUID (v4 layout).
pub fn random_uuid() -> Uuid {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("entropy");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    mdbn_wire::common::B16(b)
}

/// A field of a result map.
pub fn field(c: &Cbor, k: u64) -> Option<&Cbor> {
    match c {
        Cbor::Map(m) => m
            .iter()
            .find(|(kk, _)| *kk == Cbor::Uint(k))
            .map(|(_, v)| v),
        _ => None,
    }
}

/// Build a params map.
pub fn map(entries: Vec<(u64, Cbor)>) -> Cbor {
    Cbor::Map(
        entries
            .into_iter()
            .map(|(k, v)| (Cbor::Uint(k), v))
            .collect(),
    )
}

/// Plain-HTTPS unary call (§2): fetch a nonce, sign, POST the request frame.
pub async fn http_call(
    http: &reqwest::Client,
    http_base: &str,
    d: &Device,
    cp: &ControlPlane,
    method: &str,
    params: Cbor,
) -> Result<Cbor, ServiceError> {
    http_call_as(http, http_base, Cred::Device(d), cp, method, params).await
}

/// Authenticated CP HTTPS path; registry operations are not WebSocket methods.
pub(crate) async fn cp_http_call(
    http: &reqwest::Client,
    http_base: &str,
    cp: &ControlPlane,
    method: &str,
    params: Cbor,
) -> Result<Cbor, ServiceError> {
    http_call_as(http, http_base, Cred::ControlPlane, cp, method, params).await
}

async fn http_call_as(
    http: &reqwest::Client,
    http_base: &str,
    cred: Cred<'_>,
    cp: &ControlPlane,
    method: &str,
    params: Cbor,
) -> Result<Cbor, ServiceError> {
    let nonce_hex = http
        .get(format!("{http_base}/v1/nonce"))
        .send()
        .await
        .map_err(transport)?
        .text()
        .await
        .map_err(transport)?;
    let nonce: [u8; 32] = unhex(nonce_hex.trim())
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| transport("nonce"))?;
    let body = LsFrame::Request(LsRequest {
        id: 1,
        method: method.into(),
        params,
    })
    .to_bytes()
    .map_err(transport)?;
    let expires = now_ms() + 600_000;
    let (token, sig) = match cred {
        Cred::Device(d) => {
            let token = cp.device_token(d, expires);
            let sig = d.http_sig(&nonce, "/v1/rpc", &token, method, &body);
            (token, sig)
        }
        Cred::ControlPlane => {
            let token = cp.cp_token(expires);
            let digest = http_digest(
                &nonce,
                "/v1/rpc",
                &request_collection(&body),
                &token,
                method,
                &body,
            );
            let sig = sign_digest(cp.transport_key(), &digest);
            (token, sig)
        }
        _ => return Err(transport("unsupported HTTP credential fixture")),
    };
    let resp = http
        .post(format!("{http_base}/v1/rpc"))
        .header("authorization", format!("Bearer {token}"))
        .header("x-mdbase-nonce", nonce_hex.trim())
        .header("x-mdbase-sig", mdbn_wire::render::hex(&sig.0))
        .header("content-type", "application/vnd.mdbase.v1+cbor")
        .body(body)
        .send()
        .await
        .map_err(transport)?
        .bytes()
        .await
        .map_err(transport)?;
    match LsFrame::from_bytes(&resp) {
        Ok(LsFrame::Response(r)) => match (r.result, r.error) {
            (_, Some(e)) => Err(ServiceError::from_wire(&e)),
            (Some(v), None) => Ok(v),
            _ => Err(transport("empty")),
        },
        _ => Err(transport("bad response")),
    }
}

/// Hex helper for 32-byte values.
pub fn b32_hex(b: &B32) -> String {
    b.to_hex()
}
