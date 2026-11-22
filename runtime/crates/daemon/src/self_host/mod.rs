use std::collections::BTreeMap;
use std::future::Future;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use clap::Subcommand;
use futures_util::{SinkExt, StreamExt};
use mdbn_local_host::{FolderOptions, OpenFolder, host::now_ms, open_folder};
use mdbn_replica::QueryExecutionProfile;
use mdbn_replica::api::{SessionAuth, SessionId};
use mdbn_replica::frames::Frames;
use mdbn_wire::common::Uuid;
use tokio::net::{TcpListener, TcpStream};
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot};
use tokio::task::JoinSet;
use tokio::time::{Instant, MissedTickBehavior, interval, timeout, timeout_at};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::{StatusCode, header};
use tokio_tungstenite::tungstenite::protocol::{
    CloseFrame, Message, WebSocketConfig, frame::coding::CloseCode,
};
use tokio_tungstenite::{WebSocketStream, accept_hdr_async_with_config};

mod credentials;
pub(super) mod setup;
mod webtransport;
use credentials::Credentials;

const PATH: &str = "/_mdbase/replica";
const PAIR: &str = "/_mdbase/pair";
const MAX_FRAME: usize = 16 << 20;
const PREFIX_BYTES: usize = 4;
const MAX_MESSAGE: usize = MAX_FRAME + PREFIX_BYTES;
const MAX_CONNECTIONS: usize = 4;
const MAX_OUTBOUND_BYTES: usize = 32 << 20;
const MAX_OUTBOUND_FRAMES: usize = 16;
const MAX_RECEIPT_WAITS: usize = 32;
const IO_TIMEOUT: Duration = Duration::from_secs(5);
// One deadline from accepting a connection to reading its code or credential, so a
// peer cannot hold a connection slot by stalling each handshake stage in turn.
const PREAUTH_TIMEOUT: Duration = Duration::from_secs(10);
const TICK: Duration = Duration::from_millis(100);
const RESCAN: Duration = Duration::from_secs(1);

#[derive(Debug, clap::Args)]
pub(super) struct Args {
    #[arg(long)]
    collection: PathBuf,
    /// Exact HTTPS UI origin. Repeat for serve; select one for pair/list/revoke.
    #[arg(long = "origin", required = true, value_parser = parse_origin)]
    origins: Vec<String>,
    #[arg(long)]
    auth_dir: PathBuf,
    #[command(subcommand)]
    action: Action,
}

#[derive(Debug, Subcommand)]
enum Action {
    /// Run in the foreground. Omitting a previously served origin revokes its browsers.
    Serve {
        #[arg(long, default_value = "127.0.0.1:0", value_parser = parse_listener)]
        listen: SocketAddr,
        /// Serve pinned HTTPS WebTransport on this literal private IP and UDP port.
        #[arg(long, conflicts_with = "listen", value_parser = parse_private_listener)]
        webtransport: Option<SocketAddr>,
    },
    /// Open one three-minute, five-attempt pairing window and print its code.
    Pair { label: String },
    /// List the nonsecret IDs of authorized browsers.
    List,
    /// Revoke one browser, including already connected sessions.
    Revoke { browser_id: String },
}

fn parse_origin(value: &str) -> Result<String, &'static str> {
    let url = reqwest::Url::parse(value).map_err(|_| "expected one canonical web origin")?;
    if url.origin().ascii_serialization() != value || url.scheme() != "https" || value.contains('*')
    {
        return Err("expected a canonical HTTPS origin");
    }
    Ok(value.into())
}

fn parse_listener(value: &str) -> Result<SocketAddr, &'static str> {
    value
        .parse::<SocketAddr>()
        .ok()
        .filter(|addr| addr.ip().is_loopback())
        .ok_or("listener must be a literal loopback socket address")
}

// 100.64.0.0/10: Tailscale and other overlay VPNs, but also carrier-grade NAT.
fn shared_range(ip: IpAddr) -> bool {
    matches!(ip, IpAddr::V4(ip) if ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]))
}

fn private_ip(ip: IpAddr) -> bool {
    let IpAddr::V4(v4) = ip else { return false };
    v4.is_loopback() || v4.is_private() || shared_range(ip)
}

fn parse_private_listener(value: &str) -> Result<SocketAddr, &'static str> {
    value
        .parse::<SocketAddr>()
        .ok()
        .filter(|addr| private_ip(addr.ip()))
        .ok_or("expected a literal IPv4 loopback, RFC1918 or CGNAT address and port")
}

#[tokio::main(flavor = "current_thread")]
pub(super) async fn run(args: Args) -> Result<(), Box<dyn std::error::Error>> {
    run_with(args, false).await
}

pub(super) async fn run_with(args: Args, guided: bool) -> Result<(), Box<dyn std::error::Error>> {
    let root = args.collection.canonicalize()?;
    let Action::Serve {
        listen,
        webtransport,
    } = args.action
    else {
        let [origin] = args.origins.as_slice() else {
            return Err("select exactly one --origin for this command".into());
        };
        let credentials = Credentials::open(&args.auth_dir, &root, None)?;
        match args.action {
            Action::Pair { label } => println!("{}", credentials.pair(origin, &label)?),
            Action::List => {
                for (id, label) in credentials.list(origin)? {
                    println!("{id}\t{label}");
                }
            }
            Action::Revoke { browser_id } => credentials.revoke(origin, &browser_id)?,
            Action::Serve { .. } => unreachable!(),
        }
        return Ok(());
    };
    let mut terminate = signal(SignalKind::terminate())?;
    // Bind before updating persisted origin grants. A failed bind cannot revoke a browser.
    let socket = if let Some(addr) = webtransport {
        if !private_ip(addr.ip()) {
            return Err("WebTransport requires a private listener address".into());
        }
        Bound::Quic(
            UdpSocket::bind(addr)
                .map_err(|error| format!("cannot listen on {addr} (UDP): {error}"))?,
        )
    } else {
        if !listen.ip().is_loopback() {
            return Err("WebSocket requires a literal loopback listener".into());
        }
        Bound::Tcp(TcpListener::bind(listen).await?)
    };
    let mut folder = open_folder(
        &root,
        &FolderOptions {
            state_dir: None,
            desktop: false,
            timezone: None,
            take_over: false,
            client: ("mdbase self-host".into(), crate::BINARY_VERSION.into()),
        },
    )
    .map_err(|error| crate::data::folder_error(error).message)?;
    folder
        .replica
        .replica()
        .set_query_execution_profile(QueryExecutionProfile::MemoryConstrained);
    let mut credentials = Credentials::open(
        &args.auth_dir,
        &root,
        Some((
            folder.replica.replica_ref().config().collection,
            &args.origins,
        )),
    )?;
    credentials.guided_feedback = guided;
    let credentials = Arc::new(credentials);
    let authority = Arc::clone(&credentials);
    folder
        .replica
        .replica()
        .enable_local_web(move |owner| authority.live(owner))
        .map_err(|_| {
            "this collection is not local-only. Browser pairing serves a collection that does not sync with mdbase."
        })?;
    let (menu_done, menu_closed) = oneshot::channel();
    let listener = match socket {
        Bound::Tcp(listener) => {
            println!("listening {}", listener.local_addr()?);
            Listener::Tcp(listener)
        }
        Bound::Quic(socket) => {
            let socket_addr = socket.local_addr()?;
            let endpoint = format!("https://{socket_addr}");
            let server = webtransport::Listener::bind(
                socket,
                &credentials,
                credentials::calendar::current_slot(),
            )?;
            if guided {
                setup::ready(
                    &credentials,
                    &args.origins,
                    socket_addr,
                    server.pin.subscribe(),
                    menu_done,
                );
            } else {
                let pin = server.pin.borrow();
                let pin = pin.as_deref().expect("new listener has a pin");
                println!("WebTransport endpoint: {endpoint}");
                println!("Certificate SHA-256: {pin}");
                setup::show_invitations(&args.origins, &endpoint, pin);
            }
            Listener::Quic(Box::new(server))
        }
    };
    serve(
        listener,
        args.origins.into(),
        credentials,
        folder,
        guided,
        async {
            tokio::select! {
                _ = menu_closed, if guided => (),
                _ = terminate.recv() => (),
                _ = tokio::signal::ctrl_c() => (),
            }
        },
    )
    .await
}

enum Command {
    Hello {
        owner: Uuid,
        frame: Bytes,
        channel: mpsc::Sender<Outbound>,
        reply: oneshot::Sender<Option<SessionId>>,
    },
    Frame {
        session: SessionId,
        frame: Bytes,
    },
}

struct Outbound {
    frame: Vec<u8>,
    _budget: OwnedSemaphorePermit,
}

struct Driver {
    folder: OpenFolder,
    frames: Frames,
    clients: BTreeMap<SessionId, (Uuid, mpsc::Sender<Outbound>)>,
    credentials: Arc<Credentials>,
    budget: Arc<Semaphore>,
}

impl Driver {
    fn close(&mut self, session: SessionId) {
        self.clients.remove(&session);
        self.frames.close(self.folder.replica.replica(), session);
    }

    fn send(&self, channel: &mpsc::Sender<Outbound>, bytes: Vec<u8>) -> bool {
        let size = bytes.len();
        if size == 0 || size > MAX_FRAME {
            return false;
        }
        let Ok(budget) = self
            .budget
            .clone()
            .try_acquire_many_owned((size + PREFIX_BYTES) as u32)
        else {
            return false;
        };
        let mut frame = Vec::with_capacity(PREFIX_BYTES + size);
        frame.extend_from_slice(&(size as u32).to_be_bytes());
        frame.extend_from_slice(&bytes);
        channel
            .try_send(Outbound {
                frame,
                _budget: budget,
            })
            .is_ok()
    }

    fn drain(&mut self) {
        for (session, bytes) in self.frames.take_outgoing() {
            if let Some((owner, channel)) = self.clients.get(&session)
                && (!self.credentials.live(*owner) || !self.send(channel, bytes))
            {
                self.close(session);
            }
        }
        for session in self.frames.take_closed() {
            self.close(session);
        }
        let disconnected: Vec<_> = self
            .clients
            .iter()
            .filter_map(|(session, (owner, channel))| {
                (channel.is_closed() || !self.credentials.live(*owner)).then_some(*session)
            })
            .collect();
        for session in disconnected {
            self.close(session);
        }
    }

    fn dispatch(&mut self, command: Command) {
        match command {
            Command::Hello {
                owner,
                frame,
                channel,
                reply,
            } => {
                if channel.is_closed() || !self.credentials.live(owner) {
                    return;
                }
                let hello = self.frames.hello(
                    self.folder.replica.replica(),
                    SessionAuth::LocalWeb(owner),
                    &frame,
                );
                let sent = self.send(&channel, hello.response);
                if sent && reply.send(hello.session).is_ok() {
                    if let Some(session) = hello.session {
                        self.clients.insert(session, (owner, channel));
                    }
                } else if let Some(session) = hello.session {
                    self.close(session);
                }
            }
            Command::Frame { session, frame } => {
                if self.clients.get(&session).is_none_or(|(owner, channel)| {
                    channel.is_closed() || !self.credentials.live(*owner)
                }) || self.frames.receipt_waits(session) >= MAX_RECEIPT_WAITS
                {
                    self.close(session);
                } else {
                    self.frames
                        .on_frame(self.folder.replica.replica(), session, &frame);
                }
            }
        }
        self.drain();
    }

    fn tick(&mut self) -> Result<(), mdbn_replica::StoreError> {
        self.folder.replica.observe()?;
        let replica = self.folder.replica.replica();
        self.frames
            .tick(replica, now_ms().min(i64::MAX as u64) as i64);
        self.frames.pump(replica);
        self.drain();
        Ok(())
    }
}

enum Bound {
    Tcp(TcpListener),
    Quic(UdpSocket),
}

enum Listener {
    Tcp(TcpListener),
    Quic(Box<webtransport::Listener>),
}

enum Incoming {
    Tcp(TcpStream),
    Quic(
        wtransport::endpoint::IncomingSessionFuture,
        Arc<credentials::calendar::Pins>,
    ),
}

impl Listener {
    async fn accept(
        &mut self,
        credentials: &Credentials,
        invitations: &[String],
    ) -> std::io::Result<Option<Incoming>> {
        match self {
            Self::Tcp(listener) => match listener.accept().await {
                Ok((stream, _)) => Ok(stream
                    .peer_addr()
                    .is_ok_and(|peer| peer.ip().is_loopback())
                    .then_some(Incoming::Tcp(stream))),
                // A peer that resets before accept or a descriptor shortage affects
                // that connection only. Keep serving the browsers already paired.
                Err(_) => {
                    tokio::time::sleep(TICK).await;
                    Ok(None)
                }
            },
            Self::Quic(listener) => {
                let incoming = listener
                    .endpoint
                    .accept()
                    .await
                    .ok_or_else(|| std::io::Error::other("WebTransport listener closed"))?;
                if listener.pin.borrow().is_some() {
                    listener.update(credentials, invitations);
                }
                Ok(listener
                    .handshake(incoming, credentials::calendar::current_slot())
                    .map(|(attempt, window)| Incoming::Quic(attempt, window)))
            }
        }
    }
}

async fn serve(
    mut listener: Listener,
    origins: Arc<[String]>,
    credentials: Arc<Credentials>,
    folder: OpenFolder,
    guided: bool,
    shutdown: impl Future<Output = ()>,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut driver = Driver {
        folder,
        credentials: credentials.clone(),
        frames: Frames::new(),
        clients: BTreeMap::new(),
        budget: Arc::new(Semaphore::new(MAX_OUTBOUND_BYTES)),
    };
    let mut peers = JoinSet::new();
    let (send, mut receive) = mpsc::channel(2);
    let mut ticks = interval(TICK);
    let mut rescans = interval(RESCAN);
    ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
    rescans.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let invitations = if guided { &[] } else { &*origins };
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            accepted = listener.accept(&credentials, invitations), if peers.len() < MAX_CONNECTIONS => {
                match accepted? {
                    Some(Incoming::Tcp(socket)) => {
                        peers.spawn(connection(socket, origins.clone(), credentials.clone(), send.clone()));
                    }
                    Some(Incoming::Quic(handshake, window)) => {
                        peers.spawn(webtransport::connection(handshake, window, origins.clone(), credentials.clone(), send.clone()));
                    }
                    None => (),

                }
            }
            Some(_) = peers.join_next(), if !peers.is_empty() => driver.drain(),
            Some(command) = receive.recv() => {
                driver.dispatch(command);
            }
            _ = rescans.tick() => {
                driver.folder.replica.replica().store_mut().request_rescan();
                if let Listener::Quic(server) = &mut listener {
                    server.update(&credentials, invitations);
                }
            }
            _ = ticks.tick() => {
                driver.tick().map_err(|error| format!("cannot read the collection: {error}"))?;
            }
            _ = &mut shutdown => break,
        }
    }
    peers.shutdown().await;
    Ok(())
}

#[allow(clippy::result_large_err)]
fn upgrade<'a>(request: &Request, allowed: &'a [String]) -> Result<&'a str, ErrorResponse> {
    let uri = request.uri();
    let mut origins = request.headers().get_all(header::ORIGIN).iter();
    if uri.scheme().is_none()
        && uri.authority().is_none()
        && matches!(
            uri.path_and_query().map(|part| part.as_str()),
            Some(PATH | PAIR)
        )
        && let Some(header) = origins.next()
        && origins.next().is_none()
        && let Some(origin) = allowed
            .iter()
            .find(|origin| header.as_bytes() == origin.as_bytes())
    {
        return Ok(origin);
    }
    let mut reject = ErrorResponse::new(None);
    *reject.status_mut() = StatusCode::FORBIDDEN;
    Err(reject)
}

/// One inbound message. `Invalid` is a complete message of the wrong kind or size;
/// `Closed` means the peer sent nothing more.
enum Input {
    Data(Bytes),
    Invalid,
    Closed,
}

async fn next_data(socket: &mut WebSocketStream<TcpStream>) -> Option<Message> {
    loop {
        match socket.next().await?.ok()? {
            data @ (Message::Binary(_) | Message::Text(_)) => return Some(data),
            Message::Close(_) => return None,
            _ => (),
        }
    }
}

async fn connection(
    socket: TcpStream,
    origins: Arc<[String]>,
    credentials: Arc<Credentials>,
    commands: mpsc::Sender<Command>,
) {
    let config = WebSocketConfig::default()
        .max_frame_size(Some(MAX_MESSAGE))
        .max_message_size(Some(MAX_MESSAGE))
        .max_write_buffer_size(MAX_MESSAGE + 4096);
    let deadline = Instant::now() + PREAUTH_TIMEOUT;
    let mut admission = None;
    #[allow(clippy::result_large_err)]
    let check_origin = |request: &Request, response: Response| {
        admission = Some((upgrade(request, &origins)?, request.uri().path() == PAIR));
        Ok(response)
    };
    let Ok(Ok(socket)) = timeout_at(
        deadline,
        accept_hdr_async_with_config(socket, check_origin, Some(config)),
    )
    .await
    else {
        return;
    };
    let (origin, pairing) = admission.expect("successful upgrade validated the origin");
    run_peer(
        Peer::WebSocket(Box::new(socket)),
        origin,
        pairing,
        deadline,
        &credentials,
        commands,
    )
    .await;
}

// FramedRead retains partial prefixes and payloads when outbound traffic wins select!.
enum Peer {
    WebSocket(Box<WebSocketStream<TcpStream>>),
    WebTransport(webtransport::Stream),
}

impl Peer {
    async fn read(&mut self, text: bool, max: usize) -> Input {
        match self {
            Self::WebSocket(socket) => match next_data(socket).await {
                Some(Message::Text(msg)) if text && msg.len() <= max => Input::Data(msg.into()),
                Some(Message::Binary(msg)) if !text && msg.len() <= max => Input::Data(msg),
                Some(_) => Input::Invalid,
                None => Input::Closed,
            },
            Self::WebTransport(stream) => stream.read(max).await,
        }
    }

    async fn read_frame(&mut self) -> Option<Bytes> {
        let Input::Data(message) = self.read(false, MAX_MESSAGE).await else {
            return None;
        };
        let (prefix, payload) = message.split_first_chunk::<PREFIX_BYTES>()?;
        let length = u32::from_be_bytes(*prefix) as usize;
        (length != 0 && length == payload.len()).then(|| message.slice(PREFIX_BYTES..))
    }

    async fn write(&mut self, message: Message) -> bool {
        timeout(IO_TIMEOUT, async {
            match self {
                Self::WebSocket(socket) => socket.send(message).await.is_ok(),
                Self::WebTransport(stream) => stream.write(&message.into_data()).await,
            }
        })
        .await
        .unwrap_or(false)
    }

    async fn send_data(
        &mut self,
        outbound: Outbound,
        credentials: &Credentials,
        owner: Uuid,
    ) -> bool {
        credentials.live(owner) && self.write(Message::Binary(outbound.frame.into())).await
    }

    async fn close(&mut self, denied: bool) {
        match self {
            Self::WebSocket(socket) => {
                let frame = denied.then(|| CloseFrame {
                    code: CloseCode::Policy,
                    reason: "not authorized".into(),
                });
                let _ = timeout(IO_TIMEOUT, socket.as_mut().close(frame)).await;
            }
            Self::WebTransport(stream) => stream.close(denied).await,
        }
    }
}

enum SessionError {
    Denied,
    Unavailable,
}

async fn run_peer(
    mut peer: Peer,
    origin: &str,
    pairing: bool,
    deadline: Instant,
    credentials: &Credentials,
    commands: mpsc::Sender<Command>,
) {
    let result = session(&mut peer, origin, pairing, deadline, credentials, commands).await;
    if pairing
        && result.is_ok()
        && let Peer::WebTransport(stream) = &mut peer
    {
        stream.finish_pair().await;
    } else {
        peer.close(matches!(result, Err(SessionError::Denied)))
            .await;
    }
}

async fn session(
    peer: &mut Peer,
    origin: &str,
    pairing: bool,
    deadline: Instant,
    credentials: &Credentials,
    commands: mpsc::Sender<Command>,
) -> Result<(), SessionError> {
    let max = if pairing { 8 } else { 64 };
    // A peer that leaves or stalls before sending anything has not tried a code:
    // it must not consume one of the pairing window's attempts. A malformed
    // message is an attempt, and is refused like any wrong code or credential.
    let candidate = match timeout_at(deadline, peer.read(true, max)).await {
        Ok(Input::Data(candidate)) => candidate,
        Ok(Input::Invalid) => Bytes::new(),
        Ok(Input::Closed) | Err(_) => return Err(SessionError::Unavailable),
    };
    if pairing {
        let window = match peer {
            Peer::WebTransport(stream) => Some(stream.window.as_ref()),
            Peer::WebSocket(_) => None,
        };
        let token = credentials
            .redeem(origin, &candidate, window)
            .map_err(|_| SessionError::Unavailable)?
            .ok_or(SessionError::Denied)?;
        let response = match window {
            Some(pins) => pins.capability(&token),
            None => token,
        };
        return peer
            .write(Message::Text(response.into()))
            .await
            .then_some(())
            .ok_or(SessionError::Unavailable);
    }
    let owner = credentials
        .authenticate(origin, &candidate)
        .map_err(|_| SessionError::Unavailable)?
        .ok_or(SessionError::Denied)?;
    drop(candidate);
    replica_session(peer, credentials, owner, commands).await;
    credentials
        .browser_exists(owner)
        .map_err(|_| SessionError::Unavailable)?
        .then_some(())
        .ok_or(SessionError::Denied)
}

async fn replica_session(
    peer: &mut Peer,
    credentials: &Credentials,
    owner: Uuid,
    commands: mpsc::Sender<Command>,
) {
    let Ok(Some(hello_frame)) = timeout(IO_TIMEOUT, peer.read_frame()).await else {
        return;
    };
    let (channel, mut outgoing) = mpsc::channel(MAX_OUTBOUND_FRAMES);
    let (reply, session) = oneshot::channel();
    if commands
        .send(Command::Hello {
            owner,
            frame: hello_frame,
            channel,
            reply,
        })
        .await
        .is_err()
    {
        return;
    }
    let Ok(session) = session.await else {
        return;
    };
    let Some(first) = outgoing.recv().await else {
        return;
    };
    if !peer.send_data(first, credentials, owner).await {
        return;
    }
    let Some(session) = session else {
        return;
    };
    loop {
        tokio::select! {
            input = peer.read_frame() => {
                let Some(frame) = input else { break; };
                if commands.send(Command::Frame { session, frame }).await.is_err() { break; }
            }
            output = outgoing.recv() => {
                let Some(output) = output else { break; };
                if !peer.send_data(output, credentials, owner).await { break; }
            }
        }
    }
}
