//! The private UDP listener. One CONNECT and one bidirectional application stream per connection.

use std::net::{SocketAddr, UdpSocket};
use std::sync::Arc;

use futures_util::StreamExt;
use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};
use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, timeout, timeout_at};
use tokio_util::codec::{FramedRead, LengthDelimitedCodec};
use wtransport::endpoint::IncomingSessionFuture;
use wtransport::{Connection, RecvStream, SendStream, ServerConfig, quinn};

use super::{
    Command, Credentials, IO_TIMEOUT, Input, MAX_CONNECTIONS, PAIR, PATH, PREAUTH_TIMEOUT, Peer,
    run_peer,
};

use super::credentials::calendar::{Leaf, Pins, current_slot};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

pub(super) struct Listener {
    pub(super) endpoint: quinn::Endpoint,
    address: SocketAddr,
    tls: Arc<quinn::ServerConfig>,
    window: Arc<Pins>,
    pub(super) pin: watch::Sender<Option<String>>,
}

impl Listener {
    pub(super) fn bind(socket: UdpSocket, credentials: &Credentials, slot: i64) -> Result<Self> {
        let address = socket.local_addr()?;
        let (leaf, window) = credentials.transport_calendar(address.ip(), slot)?;
        let config = server_config(address, leaf)?;
        let tls = config.quic_config().clone();
        let endpoint = quinn::Endpoint::new(
            config.quic_endpoint_config().clone(),
            Some(tls.clone()),
            socket,
            Arc::new(quinn::TokioRuntime),
        )?;
        let (pin, _) = watch::channel(Some(window.current_pin()));
        Ok(Self {
            endpoint,
            address,
            tls: Arc::new(tls),
            window: Arc::new(window),
            pin,
        })
    }

    pub(super) fn update(&mut self, credentials: &Credentials, invitations: &[String]) {
        if matches!(self.refresh(credentials, current_slot()), Ok(true)) && !invitations.is_empty()
        {
            let endpoint = format!("https://{}", self.address);
            let pin = self.window.current_pin();
            println!("WebTransport endpoint: {endpoint}");
            println!("Certificate SHA-256: {pin}");
            super::setup::show_invitations(invitations, &endpoint, &pin);
        }
    }

    // Never replace or close the endpoint: existing replica sessions retain their connection.
    fn refresh(&mut self, credentials: &Credentials, slot: i64) -> Result<bool> {
        if self.window.first == slot && self.pin.borrow().is_some() {
            return Ok(false);
        }
        let next = credentials
            .transport_calendar(self.address.ip(), slot)
            .and_then(|(leaf, window)| Ok((server_config(self.address, leaf)?, window)));
        match next {
            Ok((config, window)) => {
                self.tls = Arc::new(config.quic_config().clone());
                self.endpoint.set_server_config(Some((*self.tls).clone()));
                self.pin.send_replace(Some(window.current_pin()));
                self.window = Arc::new(window);
                Ok(true)
            }
            Err(error) => {
                if self.pin.send_replace(None).is_some() {
                    eprintln!("WebTransport invitations unavailable: {error}");
                }
                Err(error)
            }
        }
    }

    // Quinn can buffer an Initial across rotation. Explicitly choose the TLS config
    // together with its exact pin window, even for a previously queued Initial.
    pub(super) fn handshake(
        &self,
        incoming: quinn::Incoming,
        slot: i64,
    ) -> Option<(IncomingSessionFuture, Arc<Pins>)> {
        if !super::private_ip(incoming.remote_address().ip())
            || self.window.first != slot
            || self.pin.borrow().is_none()
        {
            incoming.refuse();
            return None;
        }
        if !incoming.remote_address_validated() {
            let _ = incoming.retry();
            return None;
        }
        let connecting = incoming.accept_with(self.tls.clone()).ok()?;
        Some((
            IncomingSessionFuture::with_quic_connecting(connecting),
            self.window.clone(),
        ))
    }
}

fn server_config(address: SocketAddr, leaf: Leaf) -> Result<ServerConfig> {
    // Validate the persisted certificate/key pair fallibly before opening an endpoint.
    let mut tls = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])?
    .with_no_client_auth()
    .with_single_cert(
        vec![CertificateDer::from(leaf.cert)],
        PrivatePkcs8KeyDer::from(leaf.key.to_vec()).into(),
    )?;
    tls.alpn_protocols = vec![wtransport::proto::WEBTRANSPORT_ALPN.to_vec()];
    let mut transport = quinn::TransportConfig::default();
    transport
        .max_concurrent_bidi_streams(2u8.into()) // CONNECT + the application stream
        .max_concurrent_uni_streams(3u8.into()) // HTTP/3 control and QPACK
        .stream_receive_window((256u32 << 10).into())
        .receive_window((1u32 << 20).into())
        .send_window(1 << 20)
        // HTTP/3 WebTransport negotiates datagrams. The application rejects their use.
        .datagram_receive_buffer_size(Some(65536))
        .datagram_send_buffer_size(0);
    let mut config = ServerConfig::builder()
        .with_bind_address(address)
        .with_custom_tls_and_transport(tls, transport)
        .allow_migration(false)
        .build();
    config
        .quic_config_mut()
        .max_incoming(MAX_CONNECTIONS)
        .incoming_buffer_size(65536)
        .incoming_buffer_size_total((MAX_CONNECTIONS * 65536) as u64);
    Ok(config)
}

pub(super) async fn connection(
    attempt: IncomingSessionFuture,
    window: Arc<Pins>,
    origins: Arc<[String]>,
    credentials: Arc<Credentials>,
    commands: mpsc::Sender<Command>,
) {
    let deadline = Instant::now() + PREAUTH_TIMEOUT;
    let Ok(Ok(request)) = timeout_at(deadline, attempt).await else {
        return;
    };
    let Some(origin) = origins
        .iter()
        .find(|origin| Some(origin.as_str()) == request.origin())
    else {
        let _ = timeout_at(deadline, request.forbidden()).await;
        return;
    };
    let pairing = match request.path() {
        PAIR => true,
        PATH => false,
        _ => {
            let _ = timeout_at(deadline, request.not_found()).await;
            return;
        }
    };
    let Ok(Ok(conn)) = timeout_at(deadline, request.accept()).await else {
        return;
    };
    let serve_stream = async {
        let Ok(Ok((tx, rx))) = timeout_at(deadline, conn.accept_bi()).await else {
            close(&conn, 0, b"").await;
            return;
        };
        let stream = Stream {
            conn: conn.clone(),
            window,
            tx,
            rx: FramedRead::new(rx, LengthDelimitedCodec::new()),
        };
        run_peer(
            Peer::WebTransport(stream),
            origin,
            pairing,
            deadline,
            &credentials,
            commands,
        )
        .await;
    };
    tokio::select! {
        () = serve_stream => (),
        Ok(_) = conn.accept_uni() => close(&conn, 1002, b"unexpected unidirectional stream").await,
        Ok(_) = conn.receive_datagram() => close(&conn, 1002, b"unexpected datagram").await,
    }
}

async fn close(conn: &Connection, code: u32, reason: &[u8]) {
    conn.close_session(code, reason);
    // Keep ownership until the driver has delivered the capsule, even on denial.
    let _ = timeout(IO_TIMEOUT, conn.closed()).await;
}

pub(super) struct Stream {
    pub(super) window: Arc<Pins>,
    conn: Connection,
    tx: SendStream,
    rx: FramedRead<RecvStream, LengthDelimitedCodec>,
}

impl Stream {
    pub(super) async fn read(&mut self, max: usize) -> Input {
        self.rx.decoder_mut().set_max_frame_length(max);
        match self.rx.next().await {
            Some(Ok(message)) => Input::Data(message.freeze()),
            // The codec reports a length prefix above `max` as invalid data.
            Some(Err(error)) if error.kind() == std::io::ErrorKind::InvalidData => Input::Invalid,
            Some(Err(_)) | None => Input::Closed,
        }
    }

    pub(super) async fn write(&mut self, message: &[u8]) -> bool {
        self.tx
            .write_all(&(message.len() as u32).to_be_bytes())
            .await
            .is_ok()
            && self.tx.write_all(message).await.is_ok()
    }

    pub(super) async fn finish_pair(&mut self) {
        if matches!(timeout(IO_TIMEOUT, self.tx.finish()).await, Ok(Ok(()))) {
            match timeout(IO_TIMEOUT, self.conn.accept_bi()).await {
                Ok(Err(_)) => return,
                Ok(Ok(_)) => return close(&self.conn, 1002, b"unexpected pairing stream").await,
                Err(_) => (),
            }
        }
        close(&self.conn, 0, b"").await;
    }

    pub(super) async fn close(&mut self, denied: bool) {
        if denied {
            close(&self.conn, 1008, b"not authorized").await;
        } else {
            let _ = timeout(IO_TIMEOUT, self.tx.finish()).await;
            close(&self.conn, 0, b"").await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::parse_private_listener;

    #[test]
    fn exact_private_ipv4_addresses_only() {
        for host in [
            "127.0.0.1",
            "127.255.255.254",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.1",
            "100.64.0.1",
            "100.127.255.254",
        ] {
            assert!(
                parse_private_listener(&format!("{host}:0")).is_ok(),
                "{host}"
            );
        }
        for host in [
            "0.0.0.0",
            "8.8.8.8",
            "169.254.1.1",
            "172.15.255.255",
            "172.32.0.0",
            "100.63.255.255",
            "100.128.0.0",
            "localhost",
            "[::1]",
            "[::ffff:127.0.0.1]",
            "[fd00::1]",
            "224.0.0.1",
            "255.255.255.255",
        ] {
            assert!(
                parse_private_listener(&format!("{host}:4433")).is_err(),
                "{host}"
            );
        }
    }
}

#[cfg(test)]
mod rotation_tests;
