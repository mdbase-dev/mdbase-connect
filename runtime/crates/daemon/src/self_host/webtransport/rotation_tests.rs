use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use rustls::pki_types::UnixTime;
use rustls::time_provider::TimeProvider;
use wtransport::endpoint::endpoint_side::Client;
use wtransport::tls::Sha256Digest;
use wtransport::tls::client::{ServerHashVerification, build_default_tls_config};
use wtransport::{ClientConfig, Endpoint};

use super::*;
use crate::cli::self_host::credentials::calendar::{SLOT_SECONDS, slot_at};
use crate::testutil::TestDir;

// Both adjacent leaves really pass the pinned TLS verifier during the two-hour overlap.
#[derive(Debug)]
struct AtBoundary(u64);

impl TimeProvider for AtBoundary {
    fn current_time(&self) -> Option<UnixTime> {
        Some(UnixTime::since_unix_epoch(Duration::from_secs(self.0)))
    }
}

fn client(pin: Sha256Digest, seconds: i64) -> Endpoint<Client> {
    let mut tls = build_default_tls_config(
        Arc::new(rustls::RootCertStore::empty()),
        Some(Arc::new(ServerHashVerification::new([pin]))),
    );
    tls.time_provider = Arc::new(AtBoundary(seconds as u64));
    Endpoint::client(
        ClientConfig::builder()
            .with_bind_address("127.0.0.1:0".parse().unwrap())
            .with_custom_tls(tls)
            .build(),
    )
    .unwrap()
}

async fn connect(
    listener: &mut Listener,
    client: &Endpoint<Client>,
    before_accept: impl FnOnce(&mut Listener),
) -> (Connection, Connection, Arc<Pins>) {
    let address = format!("https://{}/_mdbase/replica", listener.address);
    let accept = async {
        let incoming = loop {
            let incoming = listener.endpoint.accept().await.unwrap();
            if incoming.remote_address_validated() {
                break incoming;
            }
            incoming.retry().unwrap();
        };
        before_accept(listener);
        let (attempt, window) = listener.handshake(incoming, listener.window.first).unwrap();
        (attempt.await.unwrap().accept().await.unwrap(), window)
    };
    let ((server, window), client) = timeout(IO_TIMEOUT, async {
        tokio::join!(accept, client.connect(address))
    })
    .await
    .unwrap();
    (server, client.unwrap(), window)
}

#[tokio::test]
async fn boundary_uses_the_preissued_pin_and_preserves_the_active_stream() {
    let home = TestDir::new("quic-rotation");
    std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let credentials = Credentials::open(
        &home.path().join("auth"),
        &home.path().join("collection"),
        Some((mdbn_wire::common::B16([8; 16]), &[])),
    )
    .unwrap();
    let boundary = 1800 * SLOT_SECONDS;
    let before = slot_at(boundary - 1);
    let after = slot_at(boundary);
    assert_eq!(before + 1, after);
    let mut listener = Listener::bind(
        UdpSocket::bind("127.0.0.1:0").unwrap(),
        &credentials,
        before,
    )
    .unwrap();
    let published = listener.pin.subscribe();
    let pins = listener.window.capability("test");
    let mut hashes = pins.split('.').skip(3).map(|pin| {
        Sha256Digest::new(std::array::from_fn(|i| {
            u8::from_str_radix(&pin[i * 2..i * 2 + 2], 16).unwrap()
        }))
    });
    let old_pin = hashes.next().unwrap();
    let new_pin = hashes.next().unwrap();
    let old_client = client(old_pin.clone(), boundary);
    let (old_server, old_connection, old_window) =
        connect(&mut listener, &old_client, |_| {}).await;
    assert_eq!(
        old_connection.peer_identity().unwrap().as_slice()[0].hash(),
        old_pin
    );
    let (mut tx, _) = old_connection.open_bi().await.unwrap().await.unwrap();
    tx.write_all(b"a").await.unwrap();
    let (_, mut rx) = old_server.accept_bi().await.unwrap();
    let mut byte = [0; 1];
    rx.read_exact(&mut byte).await.unwrap();
    assert_eq!(byte, *b"a");
    // Queue the next Initial under the old endpoint configuration and rotate
    // immediately before acceptance. Only the new leaf is trusted by this client.
    let new_client = client(new_pin.clone(), boundary);
    let (_new_server, new_connection, new_window) = connect(&mut listener, &new_client, |server| {
        assert!(server.refresh(&credentials, after).unwrap());
    })
    .await;
    assert_eq!(old_window.first, before);
    assert_eq!(
        published.borrow().as_deref(),
        Some(mdbn_wire::render::hex(new_pin.as_ref()).as_str())
    );
    assert_eq!(new_window.first, after);
    assert_eq!(
        new_connection.peer_identity().unwrap().as_slice()[0].hash(),
        new_pin
    );
    assert!(listener.refresh(&credentials, before).is_err());
    assert!(published.borrow().is_none());
    assert!(listener.refresh(&credentials, after).unwrap());
    assert_eq!(
        published.borrow().as_deref(),
        Some(new_window.current_pin().as_str())
    );
    tx.write_all(b"b").await.unwrap();
    timeout(IO_TIMEOUT, rx.read_exact(&mut byte))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(byte, *b"b");
}
