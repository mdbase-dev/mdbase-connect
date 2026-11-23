use super::*;
use wtransport::endpoint::{ConnectOptions, endpoint_side};
use wtransport::error::{ConnectingError, ConnectionError};
use wtransport::tls::Sha256Digest;
use wtransport::{ClientConfig, Connection, Endpoint, RecvStream, SendStream, VarInt};

const PAIR: &str = "/_mdbase/pair";

struct Server {
    child: Child,
    endpoint: String,
    pin: Sha256Digest,
}

async fn start(fixture: &Fixture) -> Server {
    let mut child = fixture
        .command(
            ORIGIN,
            &["--origin", WRITER, "serve", "--webtransport", "127.0.0.1:0"],
        )
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let addr = timeout(LIMIT, lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let endpoint = addr
        .strip_prefix("WebTransport endpoint: ")
        .unwrap()
        .to_owned();
    let addr: std::net::SocketAddr = endpoint.strip_prefix("https://").unwrap().parse().unwrap();
    assert!(addr.ip().is_loopback() && addr.port() != 0);
    let digest = lines.next_line().await.unwrap().unwrap();
    let digest = digest.strip_prefix("Certificate SHA-256: ").unwrap();
    assert_eq!(digest.len(), 64);
    assert!(
        digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    let pin = Sha256Digest::new(std::array::from_fn(|i| {
        u8::from_str_radix(&digest[i * 2..i * 2 + 2], 16).unwrap()
    }));
    for _ in 0..2 {
        assert!(
            lines
                .next_line()
                .await
                .unwrap()
                .unwrap()
                .starts_with("App invitation: ")
        );
    }
    Server {
        child,
        endpoint,
        pin,
    }
}

fn client(pin: Sha256Digest) -> Endpoint<endpoint_side::Client> {
    Endpoint::client(
        ClientConfig::builder()
            .with_bind_address("127.0.0.1:0".parse().unwrap())
            .with_server_certificate_hashes([pin])
            .build(),
    )
    .unwrap()
}

async fn connect_at(
    client: &Endpoint<endpoint_side::Client>,
    endpoint: &str,
    path: &str,
    origin: Option<&str>,
) -> Result<Connection, ConnectingError> {
    let mut req = ConnectOptions::builder(format!("{endpoint}{path}"));
    if let Some(origin) = origin {
        req = req.add_header("origin", origin);
    }
    timeout(LIMIT, client.connect(req.build())).await.unwrap()
}

async fn open(conn: &Connection) -> (SendStream, RecvStream) {
    timeout(LIMIT, async {
        conn.open_bi().await.unwrap().await.unwrap()
    })
    .await
    .unwrap()
}

fn outer(message: &[u8]) -> Vec<u8> {
    let mut bytes = (message.len() as u32).to_be_bytes().to_vec();
    bytes.extend_from_slice(message);
    bytes
}

async fn read(rx: &mut RecvStream) -> Vec<u8> {
    timeout(LIMIT, async {
        let mut len = [0; 4];
        rx.read_exact(&mut len).await.unwrap();
        let len = u32::from_be_bytes(len);
        assert!(len <= (16 << 20) + 4);
        let mut message = vec![0; len as usize];
        rx.read_exact(&mut message).await.unwrap();
        message
    })
    .await
    .unwrap()
}

async fn closed_with(conn: &Connection, code: u32) {
    let err = timeout(LIMIT, conn.accept_bi()).await.unwrap().unwrap_err();
    let ConnectionError::ApplicationClosed(close) = err else {
        panic!("expected session close, got {err:?}");
    };
    assert_eq!(close.code(), VarInt::from_u32(code));
    // The application code must have arrived in a session capsule, separately from QUIC termination.
    match timeout(LIMIT, conn.closed()).await.unwrap() {
        ConnectionError::LocallyClosed => (),
        ConnectionError::ApplicationClosed(close) => {
            assert_eq!(close.code(), VarInt::from_u32(0x100))
        }
        err => panic!("unexpected QUIC close: {err:?}"),
    }
}

fn pairing_bearer(response: &[u8], pin: &Sha256Digest) -> Vec<u8> {
    assert!(response.len() < 2300 && response.is_ascii());
    let parts: Vec<_> = std::str::from_utf8(response).unwrap().split('.').collect();
    assert_eq!(parts.len(), 35);
    assert_eq!(parts[0], "WTP1");
    let first = parts[2].parse::<i64>().unwrap();
    assert_eq!(parts[2], first.to_string());
    assert_eq!(
        first,
        time::OffsetDateTime::now_utc()
            .unix_timestamp()
            .div_euclid(1036800)
    );
    assert!(parts[1..].iter().enumerate().all(|(i, p)| {
        i == 1
            || (p.len() == 64
                && p.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    }));
    assert_eq!(
        parts[3..]
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        32
    );
    assert_eq!(parts[3], mdbn_wire::render::hex(pin.as_ref()));
    parts[1].as_bytes().to_vec()
}

#[tokio::test]
async fn pinned_pairing_origin_and_live_replica() {
    let fixture = Fixture::new("pinned");
    let mut server = start(&fixture).await;
    let client = client(server.pin.clone());
    let code = fixture.operator(&["pair", "tablet"]).await;
    for (path, origin) in [
        (PAIR, None),
        (PAIR, Some("https://tasknotes.example.evil")),
        ("/_mdbase/pair?x", Some(ORIGIN)),
        ("/_mdbase/replica/", Some(ORIGIN)),
    ] {
        assert!(matches!(
            connect_at(&client, &server.endpoint, path, origin).await,
            Err(ConnectingError::SessionRejected)
        ));
    }
    let conn = connect_at(&client, &server.endpoint, PAIR, Some(ORIGIN))
        .await
        .unwrap();
    let (mut tx, mut rx) = open(&conn).await;
    let message = outer(code.as_bytes());
    tx.write_all(&message[..2]).await.unwrap();
    tx.write_all(&message[2..]).await.unwrap();
    let capability = read(&mut rx).await;
    let token = pairing_bearer(&capability, &server.pin);
    assert_eq!(
        timeout(LIMIT, rx.read(&mut [0])).await.unwrap().unwrap(),
        None
    );
    assert!(
        timeout(Duration::from_millis(100), conn.accept_bi())
            .await
            .is_err()
    );
    conn.close_session(0, b"");

    for (path, origin, msg) in [
        (PAIR, ORIGIN, message),
        (PATH, WRITER, outer(&token)),
        (PATH, ORIGIN, outer(&capability)),
        (PATH, ORIGIN, u32::MAX.to_be_bytes().to_vec()),
    ] {
        let conn = connect_at(&client, &server.endpoint, path, Some(origin))
            .await
            .unwrap();
        let (mut tx, _rx) = open(&conn).await;
        tx.write_all(&msg).await.unwrap();
        closed_with(&conn, 1008).await;
    }

    let conn = connect_at(&client, &server.endpoint, PATH, Some(ORIGIN))
        .await
        .unwrap();
    let (mut tx, mut rx) = open(&conn).await;
    let hello = frame(1, "hello", hello().to_cbor());
    let mut joined = outer(&token);
    joined.extend(outer(&hello));
    tx.write_all(&joined).await.unwrap();
    let reply = read(&mut rx).await;
    assert_eq!(
        u32::from_be_bytes(reply[..4].try_into().unwrap()) as usize,
        reply.len() - 4
    );
    let ClientFrame::Response(response) = ClientFrame::from_bytes(&reply[4..]).unwrap() else {
        panic!("expected hello")
    };
    HelloResult::from_cbor(&result(response)).unwrap();
    let request = outer(&frame(
        2,
        "submit",
        submit(create(id(71), "private.md"), id(72)),
    ));
    for chunk in request.chunks(7) {
        tx.write_all(chunk).await.unwrap();
    }
    timeout(LIMIT, async {
        loop {
            let reply = read(&mut rx).await;
            if let ClientFrame::Response(response) = ClientFrame::from_bytes(&reply[4..]).unwrap() {
                assert_eq!(response.id, 2);
                assert_eq!(receipt(response).state, ReceiptState::Confirmed);
                break;
            }
        }
    })
    .await
    .unwrap();
    // Losing access to the store suspends the grant. A confirmed revocation
    // below uses a different close code so clients can discard just that grant.
    let path = fixture.auth_dir.join("credentials.sqlite");
    let hidden = fixture.auth_dir.join("unavailable.sqlite");
    fs::rename(&path, &hidden).unwrap();
    closed_with(&conn, 0).await;
    let unavailable = connect_at(&client, &server.endpoint, PATH, Some(ORIGIN))
        .await
        .unwrap();
    let (mut tx, _rx) = open(&unavailable).await;
    tx.write_all(&outer(&token)).await.unwrap();
    closed_with(&unavailable, 0).await;
    fs::rename(hidden, path).unwrap();
    let conn = connect_at(&client, &server.endpoint, PATH, Some(ORIGIN))
        .await
        .unwrap();
    let (mut tx, mut rx) = open(&conn).await;
    tx.write_all(&joined).await.unwrap();
    let reply = read(&mut rx).await;
    let ClientFrame::Response(response) = ClientFrame::from_bytes(&reply[4..]).unwrap() else {
        panic!("expected restored session hello");
    };
    HelloResult::from_cbor(&result(response)).unwrap();
    let browser = fixture.operator(&["list"]).await;
    fixture
        .operator(&["revoke", browser.strip_suffix("\ttablet").unwrap()])
        .await;
    closed_with(&conn, 1008).await;
    assert!(!fixture.home.join("unused-managed-profile").exists());
    server.child.kill().await.unwrap();
}

#[tokio::test]
async fn restart_uses_persisted_leaf_and_rejects_an_untrusted_pin() {
    let fixture = Fixture::new("pin-rotation");
    let mut first = start(&fixture).await;
    let original = first.pin;
    first.child.kill().await.unwrap();
    let mut second = start(&fixture).await;
    assert_eq!(original, second.pin);
    let current = client(original.clone());
    let wrong = client(Sha256Digest::new([0; 32]));
    assert!(matches!(
        connect_at(&wrong, &second.endpoint, PAIR, Some(ORIGIN)).await,
        Err(ConnectingError::ConnectionError(_))
    ));
    let conn = connect_at(&current, &second.endpoint, PATH, Some(ORIGIN))
        .await
        .unwrap();
    let chain = conn.peer_identity().unwrap();
    let leaf = &chain.as_slice()[0];
    assert_eq!(leaf.hash(), original);
    let (_, cert) = x509_parser::parse_x509_certificate(leaf.der()).unwrap();
    assert_eq!(
        cert.validity().not_after.to_datetime() - cert.validity().not_before.to_datetime(),
        time::Duration::days(12) + time::Duration::hours(2)
    );
    assert_eq!(
        cert.signature_algorithm.algorithm.to_id_string(),
        "1.2.840.10045.4.3.2"
    ); // ecdsa-with-SHA256
    assert_eq!(cert.subject(), cert.issuer());
    second.child.kill().await.unwrap();
}

#[tokio::test]
async fn stream_limits_and_unused_sessions_release_the_listener() {
    let fixture = Fixture::new("bounded-quic");
    let mut server = start(&fixture).await;
    let client = client(server.pin.clone());
    for _ in 0..5 {
        let conn = connect_at(&client, &server.endpoint, PATH, Some(ORIGIN))
            .await
            .unwrap();
        conn.send_datagram(b"unused").unwrap();
        closed_with(&conn, 1002).await;
    }
    let empty = connect_at(&client, &server.endpoint, PAIR, Some(ORIGIN))
        .await
        .unwrap();
    // CONNECT is the only required stream. Leaving a session unused consumes no pairing attempt.
    let code = fixture.operator(&["pair", "unused"]).await;
    closed_with(&empty, 0).await;
    // Nor does a stream that ends before a code arrives, however often it happens.
    for _ in 0..6 {
        let silent = connect_at(&client, &server.endpoint, PAIR, Some(ORIGIN))
            .await
            .unwrap();
        let (mut tx, _rx) = open(&silent).await;
        tx.finish().await.unwrap();
        closed_with(&silent, 0).await;
    }
    let conn = connect_at(&client, &server.endpoint, PAIR, Some(ORIGIN))
        .await
        .unwrap();
    let (mut tx, mut rx) = open(&conn).await;
    assert!(
        timeout(Duration::from_millis(100), conn.open_bi())
            .await
            .is_err()
    );
    tx.write_all(&outer(code.as_bytes())).await.unwrap();
    pairing_bearer(&read(&mut rx).await, &server.pin);
    closed_with(&conn, 0).await;
    let output = fixture
        .command(
            ORIGIN,
            &[
                "serve",
                "--listen",
                "127.0.0.1:0",
                "--webtransport",
                "127.0.0.1:0",
            ],
        )
        .output()
        .await
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    server.child.kill().await.unwrap();
}
