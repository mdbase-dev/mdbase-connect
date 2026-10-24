//! The localhost link to the Obsidian runtime (`replica-client-api.md` §12.4).
//!
//! - **Listener:** `ws://127.0.0.1:<port>/v1/plugin`, loopback only, on a fresh port
//!   per daemon start.
//! - **Link file:** `<state>/local-link.json` = `{"port": n, "token": "<64 hex>"}`,
//!   0600 in the owner-only state directory, with a fresh 32-byte token per start.
//!   Removed at shutdown.
//! - **Before the upgrade:** the path must be `/v1/plugin`, `Origin` must be
//!   exactly `app://obsidian.md`, and `Host` must be this loopback port. A failure is
//!   a plain 403 and no upgrade.
//! - **Session:** the first WebSocket message is the 64-byte prologue (grant must be
//!   zero), then Noise IK with one Noise message per binary WebSocket message.
//!   Message 1's encrypted payload is `{0: token, 1: hello-params}`, and the token is
//!   compared in constant time. A wrong token ends the connection without message
//!   2. The token only proves local file access: the session is served only for a
//!   collection the user linked to the client's static key on this computer's
//!   screen (kept in the keychain), and only the
//!   [`crate::server::LINK_ALLOWED`] methods.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use zeroize::Zeroizing;

use crate::secrets::DeviceIdentity;
use crate::session::{BoxFuture, Carrier, Handler, Origin, SessionError, serve_session};

/// The only origin the link accepts.
pub const OBSIDIAN_ORIGIN: &str = "app://obsidian.md";
/// The path.
pub const PATH: &str = "/v1/plugin";

/// A running link listener.
pub struct Link {
    /// The bound port.
    pub port: u16,
    file: PathBuf,
    task: tokio::task::JoinHandle<()>,
}

impl Link {
    /// Bind loopback, write the link file, and serve until dropped/stopped.
    pub async fn start<H: Handler>(
        file: PathBuf,
        identity: Arc<DeviceIdentity>,
        handler: Arc<H>,
    ) -> std::io::Result<Link> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let mut token = Zeroizing::new([0u8; 32]);
        getrandom::fill(&mut token[..]).map_err(|e| std::io::Error::other(e.to_string()))?;
        let body = format!(
            "{{\"port\":{port},\"token\":\"{}\"}}\n",
            crate::secrets::hex(&token[..])
        );
        crate::fsutil::write_atomic(&file, body.as_bytes())?;
        let token = *token;
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, peer)) = listener.accept().await else {
                    continue;
                };
                let (id, h) = (identity.clone(), handler.clone());
                tokio::spawn(async move {
                    if let Err(e) = serve_conn(stream, peer, port, token, id, h).await {
                        tracing::debug!(error = %e, "localhost link connection ended");
                    }
                });
            }
        });
        Ok(Link { port, file, task })
    }

    /// Stop serving and remove the link file.
    pub fn stop(self) {
        self.task.abort();
        let _ = std::fs::remove_file(&self.file);
    }
}

/// The pre-upgrade checks: path, `Origin`, `Host`.
pub fn check_upgrade(req: &Request, port: u16) -> Result<(), &'static str> {
    if req.uri().path() != PATH {
        return Err("path");
    }
    let header = |n: &str| req.headers().get(n).and_then(|v| v.to_str().ok());
    if header("origin") != Some(OBSIDIAN_ORIGIN) {
        return Err("origin");
    }
    let host_ok = header("host")
        .is_some_and(|h| h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"));
    if !host_ok {
        return Err("host");
    }
    Ok(())
}

#[allow(clippy::result_large_err)] // tungstenite's callback signature
async fn serve_conn<H: Handler>(
    stream: TcpStream,
    peer: SocketAddr,
    port: u16,
    token: [u8; 32],
    identity: Arc<DeviceIdentity>,
    handler: Arc<H>,
) -> Result<(), SessionError> {
    if !peer.ip().is_loopback() {
        return Err(SessionError::Protocol("not loopback"));
    }
    let ws = tokio_tungstenite::accept_hdr_async(stream, |req: &Request, resp: Response| {
        match check_upgrade(req, port) {
            Ok(()) => Ok(resp),
            Err(_) => {
                let mut r = ErrorResponse::new(None);
                *r.status_mut() = StatusCode::FORBIDDEN;
                Err(r)
            }
        }
    })
    .await
    .map_err(|_| SessionError::Protocol("upgrade refused"))?;
    let mut carrier = WsCarrier { ws };
    let prologue = tokio::time::timeout(crate::session::HANDSHAKE_TIMEOUT, carrier.recv())
        .await
        .map_err(|_| SessionError::Protocol("handshake timed out"))??
        .ok_or(SessionError::Protocol("closed during handshake"))?;
    serve_session(
        &mut carrier,
        &prologue,
        Origin::LocalLink { token },
        identity.noise_secret(),
        identity.device_id,
        handler.as_ref(),
    )
    .await
}

/// One Noise message per binary WebSocket message.
pub struct WsCarrier<S> {
    ws: WebSocketStream<S>,
}

impl<S> WsCarrier<S> {
    /// Wrap an accepted WebSocket.
    pub fn new(ws: WebSocketStream<S>) -> Self {
        WsCarrier { ws }
    }
}

impl<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> Carrier for WsCarrier<S> {
    fn recv(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, SessionError>> {
        Box::pin(async move {
            loop {
                match self.ws.next().await {
                    None | Some(Ok(Message::Close(_))) => return Ok(None),
                    Some(Ok(Message::Binary(b))) => return Ok(Some(b.to_vec())),
                    Some(Ok(Message::Text(_))) => return Err(SessionError::Protocol("text frame")),
                    Some(Ok(_)) => continue,
                    Some(Err(_)) => return Ok(None),
                }
            }
        })
    }

    fn send<'a>(&'a mut self, msg: &'a [u8]) -> BoxFuture<'a, Result<(), SessionError>> {
        Box::pin(async move {
            self.ws
                .send(Message::binary(msg.to_vec()))
                .await
                .map_err(|_| SessionError::Protocol("socket closed"))
        })
    }

    fn close(&mut self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let _ = self.ws.close(None).await;
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(path: &str, origin: Option<&str>, host: &str) -> Request {
        let mut b = Request::builder().uri(path).header("host", host);
        if let Some(o) = origin {
            b = b.header("origin", o);
        }
        b.body(()).unwrap()
    }

    #[test]
    fn upgrades_are_checked() {
        assert!(check_upgrade(&req(PATH, Some(OBSIDIAN_ORIGIN), "127.0.0.1:9"), 9).is_ok());
        assert_eq!(
            check_upgrade(&req(PATH, None, "127.0.0.1:9"), 9),
            Err("origin")
        );
        assert_eq!(
            check_upgrade(&req(PATH, Some("https://evil.example"), "127.0.0.1:9"), 9),
            Err("origin")
        );
        assert_eq!(
            check_upgrade(&req(PATH, Some(OBSIDIAN_ORIGIN), "evil.example:9"), 9),
            Err("host")
        );
        assert_eq!(
            check_upgrade(&req("/x", Some(OBSIDIAN_ORIGIN), "127.0.0.1:9"), 9),
            Err("path")
        );
    }
}
