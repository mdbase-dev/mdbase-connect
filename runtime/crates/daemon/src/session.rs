//! The replica endpoint: Noise IK sessions over local IPC
//! (`replica-client-api.md` §12.2; framing in the SDK interface note §4).
//!
//! **On the wire**, every record is `u16be(length) ‖ bytes`:
//! 1. **Preamble** (client → daemon, clear): the 64-byte prologue
//!    `"mdbase/v1/client" ‖ collection ‖ grant ‖ target device`. One daemon socket
//!    serves every collection, and Noise does not transmit the prologue, so the
//!    client states it. The daemon uses exactly these bytes as the prologue, so a
//!    tampered preamble only makes the handshake fail.
//! 2. **Message 1** (`e, es, s, ss`): its payload is the `hello` request frame,
//!    and nothing else.
//! 3. **Message 2** (`e, ee, se`): its payload is the `hello` response. A refused
//!    session still gets message 2, carrying the problem, then the daemon closes.
//! 4. **Transport messages**, at most 65,535 bytes each. Their plaintext is one
//!    byte stream of `u32be(length) ‖ mdb-cbor frame` records (≤ 16 MiB each).
//!
//! **Authorization.** A nil grant ID means the hosting app (the desktop, the CLI)
//! and maps to [`Auth::Host`] carrying the client's authenticated static key; the
//! daemon accepts it only when that key is its keychain-derived host key
//! so another process of the same OS user cannot become the host.
//! That is acceptable only here, on an owner-only local endpoint, never through
//! the relay. Any other grant maps to [`Auth::Grant`] with the client's
//! authenticated static key, and the replica checks it against its policy.
//!
//! **Lifetime.** A session ends after [`SESSION_LIFETIME`] (§12.3), whatever its
//! traffic; clients reconnect.
//!
//! The daemon's static key is its device Noise key; clients pin it from
//! `daemon.json`, never from the endpoint.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use mdbn_wire::Wire;
use mdbn_wire::cbor::Cbor;
use mdbn_wire::client::{
    ClientFrame, ClientRequest, ClientResponse, Problem, Recovery, recovery_for,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::noise::{self, MAX_MESSAGE, MAX_PLAINTEXT, Responder, Transport};

/// The prologue's fixed prefix.
pub const PROLOGUE_MAGIC: &[u8; 16] = b"mdbase/v1/client";
/// Prologue length.
pub const PROLOGUE_LEN: usize = 64;
/// Largest frame in a session (§12.2).
pub const MAX_FRAME: usize = 16 << 20;
/// How long a client has to send the preamble and message 1.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Longest a session lives after its handshake (§12.3): 24 hours.
pub const SESSION_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);

/// The parsed prologue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Prologue {
    /// Collection ID.
    pub collection: [u8; 16],
    /// Grant ID; all zero for the hosting app.
    pub grant: [u8; 16],
    /// Target device ID.
    pub target: [u8; 16],
}

impl Prologue {
    /// Parse the 64 preamble bytes.
    pub fn parse(b: &[u8]) -> Option<Prologue> {
        if b.len() != PROLOGUE_LEN || &b[..16] != PROLOGUE_MAGIC {
            return None;
        }
        let mut p = Prologue {
            collection: [0; 16],
            grant: [0; 16],
            target: [0; 16],
        };
        p.collection.copy_from_slice(&b[16..32]);
        p.grant.copy_from_slice(&b[32..48]);
        p.target.copy_from_slice(&b[48..64]);
        Some(p)
    }

    /// Encode.
    pub fn to_bytes(&self) -> [u8; PROLOGUE_LEN] {
        let mut b = [0u8; PROLOGUE_LEN];
        b[..16].copy_from_slice(PROLOGUE_MAGIC);
        b[16..32].copy_from_slice(&self.collection);
        b[32..48].copy_from_slice(&self.grant);
        b[48..64].copy_from_slice(&self.target);
        b
    }
}

/// Who the session is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Auth {
    /// The hosting app (nil grant, local IPC only). The daemon additionally
    /// requires `client_pk` to be its host key.
    Host {
        /// The client's authenticated static key.
        client_pk: [u8; 32],
    },
    /// The Obsidian runtime over the authenticated localhost link (§12.4): it
    /// proved the per-start link token inside message 1. The daemon additionally
    /// requires `client_pk` to be the key the user approved on screen for this
    /// collection (kept in the OS keychain), and serves only the
    /// [`crate::server::LINK_ALLOWED`] methods.
    Link {
        /// The client's authenticated static key.
        client_pk: [u8; 32],
    },
    /// A client holding a grant.
    Grant {
        /// Grant ID.
        grant: [u8; 16],
        /// The client's Noise static key, as authenticated by the handshake.
        client_pk: [u8; 32],
    },
}

/// An open session's frame channels, as the replica host sees them.
pub struct SessionChannels {
    /// Frames from the client (requests, and responses to callbacks).
    pub inbound: mpsc::Sender<ClientFrame>,
    /// Frames to the client (responses, pushes, callback requests). The session
    /// ends when this closes.
    pub outbound: mpsc::Receiver<ClientFrame>,
}

/// What [`Handler::open`] decided.
pub struct Opened {
    /// The `hello` response (result or problem).
    pub response: ClientResponse,
    /// The session, if accepted.
    pub session: Option<SessionChannels>,
}

/// A boxed future.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Serves sessions for registered collections.
pub trait Handler: Send + Sync + 'static {
    /// Open a session for `hello`.
    fn open<'a>(
        &'a self,
        prologue: Prologue,
        auth: Auth,
        hello: ClientRequest,
    ) -> BoxFuture<'a, Opened>;
}

/// A `ClientResponse` carrying a problem with one of the 15 codes.
pub fn problem_response(id: u64, code: &str, reason: &str, message: &str) -> ClientResponse {
    ClientResponse {
        id,
        result: None,
        problem: Some(Problem {
            code: code.to_string(),
            recovery: recovery_for(code).unwrap_or(Recovery::ContactSupport),
            message: message.to_string(),
            reason: Some(reason.to_string()),
            details: None,
            retry_after_ms: None,
            issues: None,
            trace_id: None,
        }),
    }
}

/// Session failures (logged, never sent).
#[derive(Debug)]
pub enum SessionError {
    /// I/O.
    Io(std::io::Error),
    /// Bad preamble, handshake or frame.
    Protocol(&'static str),
    /// Noise.
    Noise(noise::NoiseError),
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionError::Io(e) => write!(f, "session I/O: {e}"),
            SessionError::Protocol(m) => write!(f, "session protocol: {m}"),
            SessionError::Noise(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for SessionError {}

impl From<std::io::Error> for SessionError {
    fn from(e: std::io::Error) -> Self {
        SessionError::Io(e)
    }
}

impl From<noise::NoiseError> for SessionError {
    fn from(e: noise::NoiseError) -> Self {
        SessionError::Noise(e)
    }
}

/// Read one `u16be(length) ‖ bytes` record; `None` on a clean end of stream.
pub async fn read_u16_record<R: AsyncRead + Unpin + ?Sized>(
    r: &mut R,
) -> std::io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 2];
    match r.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let mut buf = vec![0u8; u16::from_be_bytes(len) as usize];
    r.read_exact(&mut buf).await?;
    Ok(Some(buf))
}

/// Write one `u16be(length) ‖ bytes` record.
pub async fn write_u16_record<W: AsyncWrite + Unpin + ?Sized>(
    w: &mut W,
    b: &[u8],
) -> std::io::Result<()> {
    let n = u16::try_from(b.len())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "record too large"))?;
    let mut out = Vec::with_capacity(2 + b.len());
    out.extend_from_slice(&n.to_be_bytes());
    out.extend_from_slice(b);
    w.write_all(&out).await?;
    w.flush().await
}

fn encode(frame: &ClientFrame) -> Result<Vec<u8>, SessionError> {
    frame
        .to_bytes()
        .map_err(|_| SessionError::Protocol("frame does not encode"))
}

/// Reassembles `u32be(length) ‖ frame` records from transport plaintext.
#[derive(Default)]
pub struct FrameReader {
    buf: Vec<u8>,
}

impl FrameReader {
    /// Add plaintext; returns every complete frame.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Vec<u8>>, SessionError> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        let mut at = 0;
        loop {
            if self.buf.len() - at < 4 {
                break;
            }
            let n = u32::from_be_bytes(self.buf[at..at + 4].try_into().expect("4 bytes")) as usize;
            if n > MAX_FRAME {
                return Err(SessionError::Protocol("frame too large"));
            }
            if self.buf.len() - at - 4 < n {
                break;
            }
            out.push(self.buf[at + 4..at + 4 + n].to_vec());
            at += 4 + n;
        }
        self.buf.drain(..at);
        Ok(out)
    }
}

/// Seal one frame as `u32be ‖ frame` across as many transport messages as needed.
pub fn seal_frame(t: &mut Transport, frame: &[u8]) -> Result<Vec<Vec<u8>>, SessionError> {
    let n = u32::try_from(frame.len()).map_err(|_| SessionError::Protocol("frame too large"))?;
    let mut plain = Vec::with_capacity(4 + frame.len());
    plain.extend_from_slice(&n.to_be_bytes());
    plain.extend_from_slice(frame);
    plain
        .chunks(MAX_PLAINTEXT)
        .map(|c| t.seal(c).map_err(SessionError::from))
        .collect()
}

/// Where a session's Noise messages come from and go to.
pub trait Carrier: Send {
    /// The next Noise message; `None` when the peer closed.
    fn recv(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, SessionError>>;
    /// Send one Noise message.
    fn send<'a>(&'a mut self, msg: &'a [u8]) -> BoxFuture<'a, Result<(), SessionError>>;
    /// Close our side.
    fn close(&mut self) -> BoxFuture<'_, ()>;
}

/// Where a session came in, which decides what a nil grant means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// The owner-only local IPC endpoint: a nil grant is the hosting app.
    LocalIpc,
    /// A relay pipe is never Host. A nil grant is refused.
    RelayPipe,
    /// The localhost link (§12.4): message 1 carries `{0: token, 1: hello-params}`;
    /// the token must equal this daemon start's link token. Always a nil grant.
    LocalLink {
        /// The per-start link token.
        token: [u8; 32],
    },
}

/// A `u16be`-framed byte stream (local IPC).
pub struct StreamCarrier<S> {
    rd: tokio::io::ReadHalf<S>,
    wr: tokio::io::WriteHalf<S>,
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send> StreamCarrier<S> {
    /// Wrap a stream.
    pub fn new(stream: S) -> Self {
        let (rd, wr) = tokio::io::split(stream);
        StreamCarrier { rd, wr }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send> Carrier for StreamCarrier<S> {
    fn recv(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, SessionError>> {
        Box::pin(async move { Ok(read_u16_record(&mut self.rd).await?) })
    }
    fn send<'a>(&'a mut self, msg: &'a [u8]) -> BoxFuture<'a, Result<(), SessionError>> {
        Box::pin(async move { Ok(write_u16_record(&mut self.wr, msg).await?) })
    }
    fn close(&mut self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let _ = self.wr.shutdown().await;
        })
    }
}

/// Serve one local IPC connection: read the prologue preamble, then
/// [`serve_session`].
pub async fn serve<S, H>(
    stream: S,
    noise_secret: &[u8; 32],
    device_id: [u8; 16],
    handler: &H,
) -> Result<(), SessionError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
    H: Handler + ?Sized,
{
    let mut carrier = StreamCarrier::new(stream);
    let prologue_bytes = tokio::time::timeout(HANDSHAKE_TIMEOUT, carrier.recv())
        .await
        .map_err(|_| SessionError::Protocol("handshake timed out"))??
        .ok_or(SessionError::Protocol("closed during handshake"))?;
    serve_session(
        &mut carrier,
        &prologue_bytes,
        Origin::LocalIpc,
        noise_secret,
        device_id,
        handler,
    )
    .await
}

/// Serve one Noise session on `carrier` with a known prologue: handshake (hello
/// only in message 1), then frames until either side closes.
pub async fn serve_session<C, H>(
    carrier: &mut C,
    prologue_bytes: &[u8],
    origin: Origin,
    noise_secret: &[u8; 32],
    device_id: [u8; 16],
    handler: &H,
) -> Result<(), SessionError>
where
    C: Carrier + ?Sized,
    H: Handler + ?Sized,
{
    let prologue = Prologue::parse(prologue_bytes).ok_or(SessionError::Protocol("bad preamble"))?;
    if origin == Origin::RelayPipe && prologue.grant == [0u8; 16] {
        return Err(SessionError::Protocol("nil grant on a relay pipe"));
    }
    if matches!(origin, Origin::LocalLink { .. }) && prologue.grant != [0u8; 16] {
        return Err(SessionError::Protocol(
            "the localhost link is a hosting session",
        ));
    }
    let m1 = tokio::time::timeout(HANDSHAKE_TIMEOUT, carrier.recv())
        .await
        .map_err(|_| SessionError::Protocol("handshake timed out"))??
        .ok_or(SessionError::Protocol("closed during handshake"))?;
    let mut responder = Responder::new(noise_secret, prologue_bytes);
    let (payload, client_pk) = responder.read_message_1(&m1)?;

    let hello = if let Origin::LocalLink { token } = origin {
        link_hello(&payload, &token)?
    } else {
        match ClientFrame::from_bytes(&payload) {
            Ok(ClientFrame::Request(r)) if r.method == "hello" => Ok(r),
            Ok(ClientFrame::Request(r)) => Err(problem_response(
                r.id,
                "invalid_request",
                "hello_required",
                "the first message must carry only hello",
            )),
            _ => Err(problem_response(
                0,
                "invalid_request",
                "hello_required",
                "the first message must carry hello",
            )),
        }
    };
    let opened = match hello {
        Err(resp) => Opened {
            response: resp,
            session: None,
        },
        // A local-only collection may name the zero device on the link (§12.4).
        Ok(req)
            if prologue.target != device_id
                && !(matches!(origin, Origin::LocalLink { .. })
                    && prologue.target == [0u8; 16]) =>
        {
            Opened {
                response: problem_response(
                    req.id,
                    "not_found",
                    "wrong_target",
                    "this daemon is a different device",
                ),
                session: None,
            }
        }
        Ok(req) => {
            let auth = if let Origin::LocalLink { .. } = origin {
                Auth::Link { client_pk }
            } else if prologue.grant == [0u8; 16] {
                debug_assert_eq!(origin, Origin::LocalIpc);
                Auth::Host { client_pk }
            } else {
                Auth::Grant {
                    grant: prologue.grant,
                    client_pk,
                }
            };
            handler.open(prologue, auth, req).await
        }
    };

    let e = noise::ephemeral()?;
    let (m2, mut transport) =
        responder.write_message_2(&e, &encode(&ClientFrame::Response(opened.response))?)?;
    carrier.send(&m2).await?;
    let Some(SessionChannels {
        inbound,
        mut outbound,
    }) = opened.session
    else {
        carrier.close().await;
        return Ok(());
    };

    let mut reader = FrameReader::default();
    let lifetime = tokio::time::sleep(SESSION_LIFETIME);
    tokio::pin!(lifetime);
    loop {
        tokio::select! {
            _ = &mut lifetime => {
                // §12.3: the session ends after 24 hours; the client reconnects.
                break;
            }
            msg = carrier.recv() => {
                let Some(msg) = msg? else { break };
                if msg.len() > MAX_MESSAGE {
                    return Err(SessionError::Protocol("message too large"));
                }
                let plain = transport.open(&msg)?;
                for f in reader.push(&plain)? {
                    let frame = ClientFrame::from_bytes(&f).map_err(|_| SessionError::Protocol("bad frame"))?;
                    if inbound.send(frame).await.is_err() {
                        return Ok(());
                    }
                }
            }
            out = outbound.recv() => {
                let Some(frame) = out else { break };
                for m in seal_frame(&mut transport, &encode(&frame)?)? {
                    carrier.send(&m).await?;
                }
            }
        }
    }
    carrier.close().await;
    Ok(())
}

/// A client session (the CLI, tests): preamble, handshake, then frames.
pub struct ClientSession<S> {
    stream: S,
    transport: Transport,
    reader: FrameReader,
    pending: std::collections::VecDeque<ClientFrame>,
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send> ClientSession<S> {
    /// Connect: send the preamble and `hello`, return the session and the `hello`
    /// response (which may carry a problem; the daemon then closes).
    pub async fn connect(
        mut stream: S,
        client_secret: &[u8; 32],
        daemon_noise_pk: &[u8; 32],
        prologue: Prologue,
        hello: ClientRequest,
    ) -> Result<(ClientSession<S>, ClientResponse), SessionError> {
        let pb = prologue.to_bytes();
        write_u16_record(&mut stream, &pb).await?;
        let mut ini = noise::Initiator::new(client_secret, daemon_noise_pk, &pb);
        let e = noise::ephemeral()?;
        let m1 = ini.write_message_1(&e, &encode(&ClientFrame::Request(hello))?)?;
        write_u16_record(&mut stream, &m1).await?;
        let m2 = read_u16_record(&mut stream)
            .await?
            .ok_or(SessionError::Protocol("closed before message 2"))?;
        let (payload, transport) = ini.read_message_2(&m2)?;
        let resp = match ClientFrame::from_bytes(&payload) {
            Ok(ClientFrame::Response(r)) => r,
            _ => return Err(SessionError::Protocol("message 2 is not a response")),
        };
        Ok((
            ClientSession {
                stream,
                transport,
                reader: FrameReader::default(),
                pending: Default::default(),
            },
            resp,
        ))
    }

    /// Send a frame.
    pub async fn send(&mut self, frame: &ClientFrame) -> Result<(), SessionError> {
        for m in seal_frame(&mut self.transport, &encode(frame)?)? {
            write_u16_record(&mut self.stream, &m).await?;
        }
        Ok(())
    }

    /// Receive the next frame; `None` when the daemon closed.
    pub async fn recv(&mut self) -> Result<Option<ClientFrame>, SessionError> {
        loop {
            if let Some(f) = self.pending.pop_front() {
                return Ok(Some(f));
            }
            let Some(m) = read_u16_record(&mut self.stream).await? else {
                return Ok(None);
            };
            let plain = self.transport.open(&m)?;
            for f in self.reader.push(&plain)? {
                self.pending.push_back(
                    ClientFrame::from_bytes(&f).map_err(|_| SessionError::Protocol("bad frame"))?,
                );
            }
        }
    }
}

/// A request frame with `params`.
pub fn request(id: u64, method: &str, params: Cbor) -> ClientRequest {
    ClientRequest {
        id,
        method: method.to_string(),
        params,
    }
}

/// Message 1 on the localhost link: `{0: bstr token, 1: hello-params}`. A wrong
/// token ends the session without message 2 (the plugin then keeps hosting).
fn link_hello(
    payload: &[u8],
    token: &[u8; 32],
) -> Result<Result<ClientRequest, ClientResponse>, SessionError> {
    let c = mdbn_wire::cbor::decode(payload).map_err(|_| SessionError::Protocol("link payload"))?;
    let Cbor::Map(m) = c else {
        return Err(SessionError::Protocol("link payload"));
    };
    let get = |k: u64| {
        m.iter()
            .find(|(key, _)| *key == Cbor::Uint(k))
            .map(|(_, v)| v.clone())
    };
    let Some(Cbor::Bytes(got)) = get(0) else {
        return Err(SessionError::Protocol("link token missing"));
    };
    let same = got.len() == 32 && got.iter().zip(token).fold(0u8, |a, (x, y)| a | (x ^ y)) == 0;
    if !same {
        return Err(SessionError::Protocol("wrong link token"));
    }
    Ok(Ok(request(0, "hello", get(1).unwrap_or(Cbor::Null))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_reader_reassembles_across_chunks() {
        let mut r = FrameReader::default();
        let mut stream = Vec::new();
        for f in [&b"abc"[..], &b""[..], &vec![7u8; 70_000][..]] {
            stream.extend_from_slice(&(f.len() as u32).to_be_bytes());
            stream.extend_from_slice(f);
        }
        let mut got = Vec::new();
        for c in stream.chunks(1000) {
            got.extend(r.push(c).unwrap());
        }
        assert_eq!(got.len(), 3);
        assert_eq!(got[0], b"abc");
        assert!(got[1].is_empty());
        assert_eq!(got[2].len(), 70_000);
        let mut big = FrameReader::default();
        assert!(big.push(&((MAX_FRAME as u32) + 1).to_be_bytes()).is_err());
    }

    struct Echo;

    impl Handler for Echo {
        fn open<'a>(
            &'a self,
            p: Prologue,
            auth: Auth,
            hello: ClientRequest,
        ) -> BoxFuture<'a, Opened> {
            Box::pin(async move {
                if p.collection == [9; 16] {
                    return Opened {
                        response: problem_response(
                            hello.id,
                            "not_found",
                            "unknown_collection",
                            "no",
                        ),
                        session: None,
                    };
                }
                assert!(matches!(auth, Auth::Grant { grant, .. } if grant == [5; 16]));
                let (in_tx, mut in_rx) = mpsc::channel::<ClientFrame>(8);
                let (out_tx, out_rx) = mpsc::channel::<ClientFrame>(8);
                tokio::spawn(async move {
                    while let Some(ClientFrame::Request(r)) = in_rx.recv().await {
                        let resp = ClientResponse {
                            id: r.id,
                            result: Some(r.params),
                            problem: None,
                        };
                        if out_tx.send(ClientFrame::Response(resp)).await.is_err() {
                            break;
                        }
                    }
                });
                Opened {
                    response: ClientResponse {
                        id: hello.id,
                        result: Some(Cbor::Text("hi".into())),
                        problem: None,
                    },
                    session: Some(SessionChannels {
                        inbound: in_tx,
                        outbound: out_rx,
                    }),
                }
            })
        }
    }

    async fn connect(
        collection: [u8; 16],
        target: [u8; 16],
    ) -> (ClientSession<tokio::io::DuplexStream>, ClientResponse) {
        let server_sk = [11u8; 32];
        let (a, b) = tokio::io::duplex(1 << 16);
        tokio::spawn(async move {
            let _ = serve(b, &server_sk, [4; 16], &Echo).await;
        });
        let p = Prologue {
            collection,
            grant: [5; 16],
            target,
        };
        ClientSession::connect(
            a,
            &[12u8; 32],
            &noise::public_key(&server_sk),
            p,
            request(0, "hello", Cbor::Null),
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn session_carries_large_frames_both_ways() {
        let (mut c, hello) = connect([1; 16], [4; 16]).await;
        assert_eq!(hello.result, Some(Cbor::Text("hi".into())));
        let big = Cbor::Bytes(vec![0xab; 200_000]);
        c.send(&ClientFrame::Request(request(1, "echo", big.clone())))
            .await
            .unwrap();
        match c.recv().await.unwrap() {
            Some(ClientFrame::Response(r)) => assert_eq!((r.id, r.result), (1, Some(big))),
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn refusals_complete_message_2_then_close() {
        let (mut c, hello) = connect([9; 16], [4; 16]).await;
        assert_eq!(
            hello.problem.unwrap().reason.as_deref(),
            Some("unknown_collection")
        );
        assert!(c.recv().await.unwrap().is_none());
        let (_, hello) = connect([1; 16], [6; 16]).await;
        assert_eq!(
            hello.problem.unwrap().reason.as_deref(),
            Some("wrong_target")
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_session_ends_after_its_lifetime() {
        let (mut c, hello) = connect([1; 16], [4; 16]).await;
        assert_eq!(hello.result, Some(Cbor::Text("hi".into())));
        // Just short of the lifetime the session still answers.
        tokio::time::advance(SESSION_LIFETIME - Duration::from_secs(1)).await;
        c.send(&ClientFrame::Request(request(1, "echo", Cbor::Null)))
            .await
            .unwrap();
        assert!(matches!(
            c.recv().await.unwrap(),
            Some(ClientFrame::Response(r)) if r.id == 1
        ));
        // Past it, the daemon closes (the paused clock advances when idle).
        assert!(c.recv().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_wrong_daemon_key_fails_the_handshake() {
        let (a, b) = tokio::io::duplex(1 << 16);
        tokio::spawn(async move {
            let _ = serve(b, &[11u8; 32], [4; 16], &Echo).await;
        });
        let p = Prologue {
            collection: [1; 16],
            grant: [5; 16],
            target: [4; 16],
        };
        let r = ClientSession::connect(
            a,
            &[12u8; 32],
            &noise::public_key(&[13u8; 32]),
            p,
            request(0, "hello", Cbor::Null),
        )
        .await;
        assert!(r.is_err());
    }

    #[test]
    fn prologue_round_trips() {
        let p = Prologue {
            collection: [1; 16],
            grant: [0; 16],
            target: [3; 16],
        };
        assert_eq!(Prologue::parse(&p.to_bytes()), Some(p));
        let mut bad = p.to_bytes();
        bad[0] = b'x';
        assert_eq!(Prologue::parse(&bad), None);
        assert_eq!(Prologue::parse(&bad[..63]), None);
    }
}
