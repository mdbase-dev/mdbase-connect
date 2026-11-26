//! End-to-end coverage for the scoped local WebSocket replica transport.

#![cfg(unix)]
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use mdbn_local_host::{FolderOptions, open_folder};
use mdbn_replica::api::{ClientApi, SessionAuth};
use mdbn_replica::store::{PendingRow, Store, Tx};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::client::{
    ClientFrame, ClientPush, ClientRequest, ClientResponse, FileChunk, HelloParams, HelloResult,
    OpenUploadParams, OpenUploadResult, PublishState, Receipt, ReceiptState, RecordView,
    UploadChunkParams,
};
use mdbn_wire::common::{B16, B32, Bytes, Text, Version};
use mdbn_wire::hash::sha256;
use mdbn_wire::intent::{
    Create, FileDelete, FileMove, Mutation, Op, OpClock, ResourcePut, Source, Update,
};
use mdbn_wire::schema::Wire;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest, http::header};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

const ORIGIN: &str = "https://tasknotes.example";
const WRITER: &str = "https://writer.example";
const PATH: &str = "/_mdbase/replica";
const LIMIT: Duration = Duration::from_secs(10);

struct Fixture {
    home: PathBuf,
    collection: PathBuf,
    auth_dir: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let home = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("web-replica-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        let collection = home.join("collection");
        let auth_dir = home.join("auth");
        fs::create_dir_all(&collection).unwrap();
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(collection.join("mdbase.yaml"), "spec_version: \"0.3.0\"\n").unwrap();
        Self {
            home,
            collection,
            auth_dir,
        }
    }

    fn command(&self, origin: &str, action: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_mdbase"));
        command
            .env("MDBASE_HOME", self.home.join("unused-managed-profile"))
            .args(["self-host", "--origin", origin, "--collection"])
            .arg(&self.collection)
            .arg("--auth-dir")
            .arg(&self.auth_dir)
            .args(action)
            .stdout(Stdio::piped())
            .kill_on_drop(true);
        command
    }

    async fn serve(&self) -> (Child, String) {
        self.serve_with(&["serve"]).await
    }

    async fn serve_with(&self, args: &[&str]) -> (Child, String) {
        let mut child = self.command(ORIGIN, args).spawn().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let line = timeout(LIMIT, lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let addr = line.strip_prefix("listening ").unwrap().to_string();
        (child, addr)
    }

    async fn operator(&self, action: &[&str]) -> String {
        self.operator_at(ORIGIN, action).await
    }

    async fn operator_at(&self, origin: &str, action: &[&str]) -> String {
        let output = self.command(origin, action).output().await.unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .unwrap()
            .trim_end()
            .to_owned()
    }

    async fn pair(&self, addr: &str, label: &str) -> String {
        let code = self.operator(&["pair", label]).await;
        assert!(code.len() == 8 && code.bytes().all(|byte| byte.is_ascii_digit()));
        let token = redeem(addr, &code).await.unwrap();
        assert!(
            token.len() == 64
                && token
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        );
        assert_eq!(
            fs::metadata(self.auth_dir.join("credentials.sqlite"))
                .unwrap()
                .permissions()
                .mode()
                & 0o7777,
            0o600
        );
        token
    }

    async fn start(&self) -> (Child, String, String) {
        let (child, addr) = self.serve().await;
        let token = self.pair(&addr, "first").await;
        (child, addr, token)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.home);
    }
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn connect(
    addr: &str,
    path: &str,
    origins: &[&str],
) -> Result<Socket, tokio_tungstenite::tungstenite::Error> {
    let mut request = format!("ws://{addr}{path}").into_client_request().unwrap();
    for origin in origins {
        request
            .headers_mut()
            .append(header::ORIGIN, origin.parse().unwrap());
    }
    timeout(LIMIT, connect_async(request))
        .await
        .unwrap()
        .map(|(socket, _)| socket)
}

fn map(entries: impl IntoIterator<Item = (u64, Cbor)>) -> Cbor {
    Cbor::Map(
        entries
            .into_iter()
            .map(|(key, value)| (Cbor::Uint(key), value))
            .collect(),
    )
}

fn field(value: &Cbor, key: u64) -> &Cbor {
    let Cbor::Map(entries) = value else {
        panic!("expected a map")
    };
    &entries
        .iter()
        .find(|(name, _)| *name == Cbor::Uint(key))
        .unwrap()
        .1
}

fn frame(id: u64, method: &str, params: Cbor) -> Vec<u8> {
    let raw = ClientFrame::Request(ClientRequest {
        id,
        method: method.into(),
        params,
    })
    .to_bytes()
    .unwrap();
    let mut bytes = (raw.len() as u32).to_be_bytes().to_vec();
    bytes.extend(raw);
    bytes
}

fn hello() -> HelloParams {
    HelloParams {
        versions: vec![Version { major: 1, minor: 4 }],
        client_name: "native-web-replica-tests".into(),
        client_version: "0".into(),
        features: Some(
            [
                "presence",
                "validate-page-v1",
                "declared-collection-setup-v1",
                "attachment-v1",
                "attachment-v1.read",
                "file-stream-failure-v1",
                "unknown-feature",
                "bases-discovery-unreadable-v1",
            ]
            .map(str::to_string)
            .to_vec(),
        ),
        timezone: None,
    }
}

async fn receive(socket: &mut Socket) -> ClientFrame {
    let Message::Binary(bytes) = timeout(LIMIT, socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    else {
        panic!("expected binary replica response")
    };
    assert_eq!(
        u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize,
        bytes.len() - 4
    );
    ClientFrame::from_bytes(&bytes[4..]).unwrap()
}

async fn push(socket: &mut Socket, kind: &str) -> ClientPush {
    timeout(LIMIT, async {
        loop {
            if let ClientFrame::Push(push) = receive(socket).await
                && push.kind == kind
            {
                break push;
            }
        }
    })
    .await
    .unwrap()
}

async fn rpc(socket: &mut Socket, id: u64, method: &str, params: Cbor) -> ClientResponse {
    socket
        .send(Message::Binary(frame(id, method, params).into()))
        .await
        .unwrap();
    timeout(LIMIT, async {
        loop {
            if let ClientFrame::Response(result) = receive(socket).await {
                assert_eq!(result.id, id);
                break result;
            }
        }
    })
    .await
    .unwrap()
}

fn result(response: ClientResponse) -> Cbor {
    response
        .result
        .unwrap_or_else(|| panic!("replica refusal: {:?}", response.problem))
}

async fn accepted(addr: &str, token: &str) -> (Socket, HelloResult) {
    accepted_at(addr, ORIGIN, token).await
}

async fn accepted_at(addr: &str, origin: &str, token: &str) -> (Socket, HelloResult) {
    let mut socket = connect(addr, PATH, &[origin]).await.unwrap();
    socket.send(Message::Text(token.into())).await.unwrap();
    assert!(
        timeout(Duration::from_millis(50), socket.next())
            .await
            .is_err()
    );
    let response = result(rpc(&mut socket, 1, "hello", hello().to_cbor()).await);
    (socket, HelloResult::from_cbor(&response).unwrap())
}

async fn closed(socket: &mut Socket) {
    assert!(matches!(
        timeout(LIMIT, socket.next()).await.unwrap(),
        None | Some(Err(_) | Ok(Message::Close(_)))
    ));
}

async fn denied(socket: &mut Socket) {
    assert!(
        matches!(timeout(LIMIT, socket.next()).await.unwrap(), Some(Ok(Message::Close(Some(frame)))) if u16::from(frame.code) == 1008)
    );
}

async fn redeem(addr: &str, code: &str) -> Option<String> {
    redeem_at(addr, ORIGIN, code).await
}

async fn redeem_at(addr: &str, origin: &str, code: &str) -> Option<String> {
    let mut socket = connect(addr, "/_mdbase/pair", &[origin]).await.unwrap();
    socket.send(Message::Text(code.into())).await.unwrap();
    match timeout(LIMIT, socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    {
        Message::Text(token) => {
            assert!(matches!(
                timeout(LIMIT, socket.next()).await.unwrap(),
                Some(Ok(Message::Close(_)))
            ));
            Some(token.to_string())
        }
        Message::Close(Some(frame)) if u16::from(frame.code) == 1008 => None,
        _ => panic!("unexpected pairing response"),
    }
}

fn id(byte: u8) -> B16 {
    let mut raw = [byte; 16];
    raw[6] = 0x70;
    raw[8] = 0x80;
    B16(raw)
}

fn create(record: B16, path: &str) -> Op {
    Op::Create(Create {
        id: record,
        path: Some(path.into()),
        type_name: None,
        frontmatter: None,
        body: Some(Text::Inline("initial text".into())),
        document: None,
    })
}

fn submit(op: Op, mutation: B16) -> Cbor {
    map([(0, vec![op].to_cbor()), (1, mutation.to_cbor())])
}

fn receipt(response: ClientResponse) -> Receipt {
    Vec::<Receipt>::from_cbor(&result(response))
        .unwrap()
        .remove(0)
}

#[tokio::test]
async fn two_origins_share_records_but_not_pairing_grants_or_revocation() {
    let fixture = Fixture::new("two-origins");
    let both = ["--origin", WRITER, "serve"];
    let (mut child, addr) = fixture.serve_with(&both).await;
    assert!(
        !fixture
            .command(ORIGIN, &["--origin", WRITER, "pair", "ambiguous"])
            .output()
            .await
            .unwrap()
            .status
            .success()
    );
    let first = fixture.operator(&["pair", "laptop"]).await;
    let second = fixture.operator_at(WRITER, &["pair", "laptop"]).await;
    assert!(redeem_at(&addr, WRITER, &first).await.is_none());
    assert!(redeem(&addr, &second).await.is_none());
    let first = redeem(&addr, &first).await.unwrap();
    let second = redeem_at(&addr, WRITER, &second).await.unwrap();
    for (origin, wrong) in [(ORIGIN, &second), (WRITER, &first)] {
        let mut socket = connect(&addr, PATH, &[origin]).await.unwrap();
        socket
            .send(Message::Text(wrong.as_str().into()))
            .await
            .unwrap();
        denied(&mut socket).await;
    }
    let (mut notes, _) = accepted(&addr, &first).await;
    let (mut writer, _) = accepted_at(&addr, WRITER, &second).await;
    let record = id(91);
    let mutation = id(92);
    assert_eq!(
        receipt(
            rpc(
                &mut notes,
                2,
                "submit",
                submit(create(record, "shared.md"), mutation)
            )
            .await
        )
        .state,
        ReceiptState::Confirmed
    );
    result(rpc(&mut writer, 2, "get", map([(0, record.to_cbor())])).await);
    assert_eq!(
        rpc(&mut writer, 3, "receipt", map([(0, mutation.to_cbor())]))
            .await
            .problem
            .unwrap()
            .code,
        "not_found"
    );
    let notes_list = fixture.operator(&["list"]).await;
    let writer_list = fixture.operator_at(WRITER, &["list"]).await;
    let notes_id = notes_list.strip_suffix("\tlaptop").unwrap();
    let writer_id = writer_list.strip_suffix("\tlaptop").unwrap();
    assert_eq!((notes_id.len(), writer_id.len()), (32, 32));
    assert_ne!(notes_id, writer_id);
    assert!(
        !fixture
            .command(ORIGIN, &["revoke", writer_id])
            .output()
            .await
            .unwrap()
            .status
            .success()
    );
    fixture.operator_at(WRITER, &["revoke", writer_id]).await;
    denied(&mut writer).await;
    result(rpc(&mut notes, 3, "get", map([(0, record.to_cbor())])).await);
    assert!(!fixture.home.join("unused-managed-profile").exists());
    child.kill().await.unwrap();
}

#[tokio::test]
async fn opt_in_requires_an_exact_origin_and_never_imports_poc_credentials() {
    let fixture = Fixture::new("opt-in");
    let missing = Command::new(env!("CARGO_BIN_EXE_mdbase"))
        .args(["self-host", "--collection"])
        .arg(&fixture.collection)
        .arg("--auth-dir")
        .arg(&fixture.auth_dir)
        .arg("serve")
        .output()
        .await
        .unwrap();
    assert_eq!(missing.status.code(), Some(2));
    assert!(!fixture.auth_dir.exists());
    for origin in ["https://*.example", "https://writer.example/", "null"] {
        let invalid = fixture.command(origin, &["serve"]).output().await.unwrap();
        assert_eq!(invalid.status.code(), Some(2));
    }
    fs::create_dir(&fixture.auth_dir).unwrap();
    fs::set_permissions(&fixture.auth_dir, fs::Permissions::from_mode(0o700)).unwrap();
    let path = fixture.auth_dir.join("credentials.sqlite");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE browser(owner BLOB PRIMARY KEY NOT NULL, digest BLOB UNIQUE NOT NULL, label TEXT UNIQUE NOT NULL);").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    for action in [&["serve"][..], &["pair", "laptop"], &["list"]] {
        let refused = fixture.command(ORIGIN, action).output().await.unwrap();
        assert!(!refused.status.success());
        assert!(
            String::from_utf8(refused.stderr)
                .unwrap()
                .contains("unsupported pairing state")
        );
    }
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE type='table'",
            [],
            |row| row.get::<_, u32>(0)
        )
        .unwrap(),
        1
    );
}

#[tokio::test]
async fn removing_origin_drops_its_grants_and_pairing_window() {
    let fixture = Fixture::new("disabled-origin");
    let both = ["--origin", WRITER, "serve"];
    let (mut child, addr) = fixture.serve_with(&both).await;
    let kept = fixture.pair(&addr, "notes").await;
    let code = fixture.operator_at(WRITER, &["pair", "writer"]).await;
    let token = redeem_at(&addr, WRITER, &code).await.unwrap();
    let pending = fixture.operator_at(WRITER, &["pair", "pending"]).await;
    child.kill().await.unwrap();
    let (mut child, addr) = fixture.serve().await;
    for path in ["/_mdbase/pair", PATH] {
        assert!(connect(&addr, path, &[WRITER]).await.is_err());
    }
    assert!(
        !fixture
            .command(WRITER, &["pair", "disabled"])
            .output()
            .await
            .unwrap()
            .status
            .success()
    );
    child.kill().await.unwrap();
    let (mut child, addr) = fixture.serve_with(&both).await;
    assert!(fixture.operator_at(WRITER, &["list"]).await.is_empty());
    assert!(redeem_at(&addr, WRITER, &pending).await.is_none());
    let mut revoked = connect(&addr, PATH, &[WRITER]).await.unwrap();
    revoked.send(Message::Text(token.into())).await.unwrap();
    denied(&mut revoked).await;
    accepted(&addr, &kept).await;
    child.kill().await.unwrap();
}

#[tokio::test]
async fn pairing_window_is_single_use_bounded_and_expires() {
    let fixture = Fixture::new("windows");
    let (mut child, addr) = fixture.serve().await;
    assert!(redeem(&addr, "12345678").await.is_none());
    let exhausted = fixture.operator(&["pair", "lost"]).await;
    let wrong = if exhausted == "00000000" {
        "00000001"
    } else {
        "00000000"
    };
    for _ in 0..4 {
        assert!(redeem(&addr, wrong).await.is_none());
    }
    let mut binary = connect(&addr, "/_mdbase/pair", &[ORIGIN]).await.unwrap();
    binary
        .send(Message::Binary(exhausted.as_bytes().to_vec().into()))
        .await
        .unwrap();
    denied(&mut binary).await;
    assert!(redeem(&addr, &exhausted).await.is_none());

    let expired = fixture.operator(&["pair", "expired"]).await;
    let db = rusqlite::Connection::open(fixture.auth_dir.join("credentials.sqlite")).unwrap();
    db.execute("UPDATE pairing SET opened=opened-180001", [])
        .unwrap();
    assert!(redeem(&addr, &expired).await.is_none());
    let fresh = fixture.operator(&["pair", "tablet"]).await;
    let (first, second) = tokio::join!(redeem(&addr, &fresh), redeem(&addr, &fresh));
    assert_ne!(first.is_some(), second.is_some());
    let token = first.or(second).unwrap();
    assert!(redeem(&addr, &fresh).await.is_none());
    let stored: [u8; 32] = db
        .query_row("SELECT digest FROM browser", [], |row| row.get(0))
        .unwrap();
    assert_eq!(stored, sha256(token.as_bytes()).0);
    assert!(
        !fs::read(fixture.auth_dir.join("credentials.sqlite"))
            .unwrap()
            .windows(token.len())
            .any(|window| window == token.as_bytes())
    );
    assert!(fixture.operator(&["list"]).await.ends_with("\ttablet"));
    child.kill().await.unwrap();
}

#[tokio::test]
async fn leaving_before_sending_a_code_does_not_use_an_attempt() {
    let fixture = Fixture::new("silent-pair");
    let (mut child, addr) = fixture.serve().await;
    let code = fixture.operator(&["pair", "kept"]).await;
    // More closed tabs than the window has attempts.
    for _ in 0..6 {
        let mut silent = connect(&addr, "/_mdbase/pair", &[ORIGIN]).await.unwrap();
        silent.close(None).await.unwrap();
        closed(&mut silent).await;
    }
    assert!(redeem(&addr, &code).await.is_some());
    child.kill().await.unwrap();
}

#[tokio::test]
async fn replaced_database_does_not_leave_an_unrevocable_session() {
    let fixture = Fixture::new("replaced");
    let (mut child, addr, first) = fixture.start().await;
    let (mut session, _) = accepted(&addr, &first).await;
    let path = fixture.auth_dir.join("credentials.sqlite");
    let replacement = fixture.auth_dir.join("restored.sqlite");
    fs::copy(&path, &replacement).unwrap();
    fs::rename(replacement, path).unwrap();
    let saved = fixture.operator(&["list"]).await;
    fixture
        .operator(&["revoke", saved.strip_suffix("\tfirst").unwrap()])
        .await;
    assert!(matches!(
        timeout(LIMIT, session.next()).await.unwrap(),
        Some(Ok(Message::Close(None)))
    ));
    child.kill().await.unwrap();
}

#[tokio::test]
async fn unavailable_grant_store_closes_access_without_invalidating_a_remembered_pairing() {
    let fixture = Fixture::new("temporary-grant-outage");
    let (mut child, addr, token) = fixture.start().await;
    let (mut session, _) = accepted(&addr, &token).await;
    let path = fixture.auth_dir.join("credentials.sqlite");
    let hidden = fixture.auth_dir.join("temporarily-unavailable.sqlite");
    fs::rename(&path, &hidden).unwrap();
    assert!(matches!(
        timeout(LIMIT, session.next()).await.unwrap(),
        Some(Ok(Message::Close(None)))
    ));
    let mut reconnect = connect(&addr, PATH, &[ORIGIN]).await.unwrap();
    reconnect
        .send(Message::Text(token.clone().into()))
        .await
        .unwrap();
    assert!(matches!(
        timeout(LIMIT, reconnect.next()).await.unwrap(),
        Some(Ok(Message::Close(None)))
    ));
    fs::rename(hidden, path).unwrap();
    let (_restored, _) = accepted(&addr, &token).await;
    child.kill().await.unwrap();
}

#[tokio::test]
async fn browser_custody_and_revocation_survive_restart() {
    let fixture = Fixture::new("custody");
    let (mut child, addr, first) = fixture.start().await;
    let second = fixture.pair(&addr, "tablet").await;
    assert!(first != second);
    let (mut writer, _) = accepted(&addr, &first).await;
    let (mut rival, _) = accepted(&addr, &second).await;
    let mutation = id(41);
    let record = id(42);
    let written = receipt(
        rpc(
            &mut writer,
            2,
            "submit",
            submit(create(record, "original.md"), mutation),
        )
        .await,
    );
    assert_eq!(written.state, ReceiptState::Confirmed);
    result(rpc(&mut writer, 3, "receipt", map([(0, mutation.to_cbor())])).await);
    rival
        .send(Message::Binary(frame(1, "get_status", map([])).into()))
        .await
        .unwrap();
    loop {
        match receive(&mut rival).await {
            ClientFrame::Response(response) => {
                result(response);
                break;
            }
            ClientFrame::Push(push) => assert_ne!(push.kind, "receipt"),
            _ => panic!("unexpected client frame"),
        }
    }
    for (request, method) in [(2, "receipt"), (3, "await")] {
        let refusal = rpc(&mut rival, request, method, map([(0, mutation.to_cbor())])).await;
        assert_eq!(refusal.problem.unwrap().code, "not_found");
    }
    let collision = rpc(
        &mut rival,
        4,
        "submit",
        submit(create(id(43), "collision.md"), mutation),
    )
    .await;
    assert_eq!(
        collision.problem.unwrap().reason.as_deref(),
        Some("mutation_id_in_use")
    );
    assert!(!fixture.collection.join("collision.md").exists());
    let foreign_origin = fixture
        .command("https://another.example", &["pair", "bad"])
        .output()
        .await
        .unwrap();
    assert!(!foreign_origin.status.success());
    let mut other_collection = Fixture::new("other-collection");
    other_collection.auth_dir = fixture.auth_dir.clone();
    let mismatched = other_collection
        .command(ORIGIN, &["serve"])
        .output()
        .await
        .unwrap();
    assert!(!mismatched.status.success());
    let saved = fixture.operator(&["list"]).await;
    let lost = saved
        .lines()
        .find_map(|line| line.strip_suffix("\tfirst"))
        .unwrap();
    fixture.operator(&["revoke", lost]).await;
    denied(&mut writer).await;
    assert_eq!(
        receipt(
            rpc(
                &mut rival,
                5,
                "submit",
                submit(create(id(44), "survivor.md"), id(45))
            )
            .await
        )
        .state,
        ReceiptState::Confirmed
    );
    child.kill().await.unwrap();
    let (mut child, addr) = fixture.serve().await;
    let mut refused = connect(&addr, PATH, &[ORIGIN]).await.unwrap();
    refused.send(Message::Text(first.into())).await.unwrap();
    denied(&mut refused).await;
    let (mut survivor, _) = accepted(&addr, &second).await;
    assert_eq!(
        Receipt::from_cbor(&result(
            rpc(&mut survivor, 3, "receipt", map([(0, id(45).to_cbor())])).await
        ))
        .unwrap()
        .state,
        ReceiptState::Confirmed
    );
    result(rpc(&mut survivor, 2, "get", map([(0, record.to_cbor())])).await);
    assert!(fixture.operator(&["list"]).await.ends_with("\ttablet"));
    child.kill().await.unwrap();
}

#[tokio::test]
async fn handshake_and_bearer_are_exact_and_revocable() {
    let fixture = Fixture::new("handshake");
    let invalid = fixture
        .command("http://localhost", &["serve"])
        .output()
        .await
        .unwrap();
    assert!(!invalid.status.success());
    let invalid = fixture
        .command(ORIGIN, &["serve", "--listen", "0.0.0.0:0"])
        .output()
        .await
        .unwrap();
    assert!(!invalid.status.success());
    let (mut child, addr, token) = fixture.start().await;
    for (path, origins) in [
        (PATH, vec![]),
        (PATH, vec!["https://other.example"]),
        (PATH, vec![ORIGIN, ORIGIN]),
        ("/_mdbase/replica?token=bad", vec![ORIGIN]),
        ("/_mdbase/replica/", vec![ORIGIN]),
        ("/_mdbase/pair", vec!["https://other.example"]),
        ("/_mdbase/pair", vec![ORIGIN, ORIGIN]),
        ("/_mdbase/pair?code=bad", vec![ORIGIN]),
        ("/_mdbase/pair/", vec![ORIGIN]),
    ] {
        assert!(connect(&addr, path, &origins).await.is_err());
    }
    let mut wrong = connect(&addr, PATH, &[ORIGIN]).await.unwrap();
    wrong
        .send(Message::Text("0".repeat(64).into()))
        .await
        .unwrap();
    denied(&mut wrong).await;
    let mut early = connect(&addr, PATH, &[ORIGIN]).await.unwrap();
    early
        .send(Message::Binary(frame(1, "hello", hello().to_cbor()).into()))
        .await
        .unwrap();
    denied(&mut early).await;

    let mut coalesced = connect(&addr, PATH, &[ORIGIN]).await.unwrap();
    coalesced
        .send(Message::Text(token.clone().into()))
        .await
        .unwrap();
    let mut invalid = frame(1, "hello", hello().to_cbor());
    invalid.extend(frame(2, "get_status", map([])));
    coalesced
        .send(Message::Binary(invalid.into()))
        .await
        .unwrap();
    closed(&mut coalesced).await;

    let (mut valid, _) = accepted(&addr, &token).await;
    let mut malformed = frame(2, "get_status", map([]));
    malformed[3] ^= 1;
    valid.send(Message::Binary(malformed.into())).await.unwrap();
    closed(&mut valid).await;

    let (mut socket, _) = accepted(&addr, &token).await;
    let list = fixture.operator(&["list"]).await;
    let (owner, label) = list.split_once('\t').unwrap();
    assert_eq!(label, "first");
    fixture.operator(&["revoke", owner]).await;
    let _ = socket
        .send(Message::Binary(
            frame(2, "submit", submit(create(id(1), "revoked.md"), id(2))).into(),
        ))
        .await;
    denied(&mut socket).await;
    child.kill().await.unwrap();
    assert!(!fixture.collection.join("revoked.md").exists());
}

#[tokio::test]
async fn local_web_uses_native_record_bases_and_change_frames() {
    let fixture = Fixture::new("records");
    let bases_contract = fixture.collection.join("_contracts/obsidian.base");
    fs::create_dir_all(&bases_contract).unwrap();
    fs::write(
        bases_contract.join("1.0.0.md"),
        include_str!("../../../conformance/spec/_contracts/obsidian.base/1.0.0.md"),
    )
    .unwrap();
    let (mut child, addr, token) = fixture.start().await;
    let (mut socket, hello) = accepted(&addr, &token).await;
    assert!(hello.grant.grant.is_none());
    assert_eq!(hello.grant.capabilities.len(), 4);
    assert_eq!(hello.features, ["bases-discovery-unreadable-v1"]);
    let admin = rpc(&mut socket, 2, "app_collection_setup_v1", map([]))
        .await
        .problem
        .unwrap();
    assert_eq!(admin.reason.as_deref(), Some("local_web_scope"));
    let resource = Op::ResourcePut(ResourcePut {
        path: "mdbase.yaml".into(),
        doc: Text::Inline("spec_version: \"0.3.0\"\nname: denied\n".into()),
        base_revision: None,
        must_not_exist: None,
    });
    let denied = rpc(&mut socket, 3, "submit", submit(resource, id(3)))
        .await
        .problem
        .unwrap();
    assert_eq!(denied.reason.as_deref(), Some("local_web_scope"));
    let oversized = rpc(
        &mut socket,
        30,
        "submit",
        map([
            (
                0,
                vec![create(id(3), "oversized.md"); mdbn_core::plan::MAX_OPS as usize + 1]
                    .to_cbor(),
            ),
            (4, Cbor::Bool(true)),
        ]),
    )
    .await
    .problem
    .unwrap();
    assert_eq!(oversized.reason.as_deref(), Some("operation_limit"));
    assert!(!fixture.collection.join("oversized.md").exists());
    let bases = cbor::encode(&map([
        (0, Cbor::Uint(1)),
        (1, Cbor::Text("UTC".into())),
        (2, Cbor::Uint(128)),
        (3, Cbor::Null),
    ]))
    .unwrap();
    assert!(matches!(
        result(
            rpc(
                &mut socket,
                4,
                "app_bases_list_views_v1",
                map([(0, Cbor::Bytes(bases))])
            )
            .await
        ),
        Cbor::Bytes(_)
    ));
    let contract = rpc(
        &mut socket,
        5,
        "get_contract_v1",
        map([
            (0, Cbor::Uint(1)),
            (1, id(10).to_cbor()),
            (2, Cbor::Text("missing".into())),
            (3, Cbor::Text("1.0.0".into())),
        ]),
    )
    .await;
    assert_ne!(
        contract.problem.unwrap().reason.as_deref(),
        Some("local_web_scope")
    );
    result(rpc(&mut socket, 6, "list_pending", map([])).await);

    let record = id(10);
    let written = receipt(
        rpc(
            &mut socket,
            7,
            "submit",
            submit(create(record, "task.md"), id(11)),
        )
        .await,
    );
    assert_eq!(
        written.state,
        ReceiptState::Confirmed,
        "{:?}",
        written.problem
    );
    assert!(
        fs::read_to_string(fixture.collection.join("task.md"))
            .unwrap()
            .contains("initial text")
    );
    let first = RecordView::from_cbor(&result(
        rpc(&mut socket, 8, "get", map([(0, record.to_cbor())])).await,
    ))
    .unwrap();
    result(rpc(&mut socket, 9, "changes", map([(2, Cbor::Bool(true))])).await);
    fs::write(fixture.collection.join("task.md"), "external change\n").unwrap();
    timeout(LIMIT, async {
        loop {
            let change = push(&mut socket, "changes").await;
            if format!("{:?}", change.payload).contains("task.md") {
                break;
            }
        }
    })
    .await
    .unwrap();
    let updated = RecordView::from_cbor(&result(
        rpc(&mut socket, 10, "get", map([(0, record.to_cbor())])).await,
    ))
    .unwrap();
    assert_ne!(updated.revision, first.revision);
    let update = Op::Update(Update {
        id: record,
        patch: None,
        unset: None,
        add: None,
        remove: None,
        body: Some(Text::Inline("stale write".into())),
        body_edits: None,
        body_base: None,
        body_base_text: None,
        base: None,
        if_revision: Some(first.revision),
        update_refs: None,
    });
    let refused = receipt(rpc(&mut socket, 11, "submit", submit(update, id(12))).await);
    assert_eq!(refused.problem.unwrap().reason.as_deref(), Some("revision"));
    assert_eq!(
        fs::read_to_string(fixture.collection.join("task.md")).unwrap(),
        "external change\n"
    );
    child.kill().await.unwrap();
}

#[tokio::test]
async fn local_web_attachment_publication_streaming_and_cas() {
    let fixture = Fixture::new("attachments");
    let (mut child, addr, token) = fixture.start().await;
    let (mut socket, _) = accepted(&addr, &token).await;
    let transfer = id(20);
    let mut body = vec![5; (1 << 20) + 3];
    body[(1 << 20)..].copy_from_slice(b"end");
    let upload = OpenUploadParams {
        transfer,
        path: "tiny.bin".into(),
        size: body.len() as u64,
        digest: Some(sha256(&body)),
        file_id: None,
        if_revision: None,
        mutation_id: Some(id(21)),
    };
    let result_open = OpenUploadResult::from_cbor(&result(
        rpc(&mut socket, 2, "open_upload", upload.to_cbor()).await,
    ))
    .unwrap();
    let file = result_open.file_id.unwrap();
    assert_eq!(result_open.transfer, transfer);
    let (mut other, _) = accepted(&addr, &fixture.pair(&addr, "second").await).await;
    assert!(
        rpc(
            &mut other,
            2,
            "commit_upload",
            map([(0, transfer.to_cbor())])
        )
        .await
        .problem
        .is_some()
    );
    assert!(
        rpc(
            &mut socket,
            3,
            "commit_upload",
            map([(0, transfer.to_cbor())])
        )
        .await
        .problem
        .is_some()
    );
    result(rpc(&mut other, 3, "open_upload", upload.to_cbor()).await);
    result(
        rpc(
            &mut other,
            4,
            "abort_upload",
            map([(0, transfer.to_cbor())]),
        )
        .await,
    );
    for (request, index) in [(4, 1), (5, 0)] {
        let start = index * result_open.chunk_size as usize;
        let end = (start + result_open.chunk_size as usize).min(body.len());
        result(
            rpc(
                &mut socket,
                request,
                "upload_chunk",
                UploadChunkParams {
                    transfer,
                    index: index as u64,
                    bytes: Bytes(body[start..end].to_vec()),
                }
                .to_cbor(),
            )
            .await,
        );
    }
    let committed = Receipt::from_cbor(&result(
        rpc(
            &mut socket,
            6,
            "commit_upload",
            map([(0, transfer.to_cbor())]),
        )
        .await,
    ))
    .unwrap();
    assert_eq!(
        committed.state,
        ReceiptState::Confirmed,
        "{:?}",
        committed.problem
    );
    assert_eq!(committed.published, Some(PublishState::Published));
    assert_eq!(fs::read(fixture.collection.join("tiny.bin")).unwrap(), body);

    let read = result(
        rpc(
            &mut socket,
            7,
            "read_file",
            map([(0, file.to_cbor()), (2, sha256(&body).to_cbor())]),
        )
        .await,
    );
    let chunk = FileChunk::from_cbor(&push(&mut socket, "file_chunk").await.payload).unwrap();
    assert!(chunk.last);
    assert_eq!(field(&read, 0), &Cbor::Uint(chunk.stream));
    assert_eq!(chunk.bytes.0, body);
    result(
        rpc(
            &mut socket,
            8,
            "ack_chunks",
            map([
                (0, Cbor::Uint(chunk.stream)),
                (1, Cbor::Uint(body.len() as u64)),
            ]),
        )
        .await,
    );

    let replace = OpenUploadParams {
        transfer: id(22),
        size: 0,
        digest: Some(sha256(b"")),
        file_id: Some(file),
        if_revision: Some(sha256(&body)),
        mutation_id: Some(id(23)),
        ..upload.clone()
    };
    assert_eq!(
        OpenUploadResult::from_cbor(&result(
            rpc(&mut socket, 9, "open_upload", replace.to_cbor()).await
        ))
        .unwrap()
        .file_id,
        Some(file)
    );
    let empty = Receipt::from_cbor(&result(
        rpc(
            &mut socket,
            10,
            "commit_upload",
            map([(0, replace.transfer.to_cbor())]),
        )
        .await,
    ))
    .unwrap();
    assert_eq!(empty.state, ReceiptState::Confirmed);
    assert_eq!(fs::read(fixture.collection.join("tiny.bin")).unwrap(), b"");
    let stale = rpc(
        &mut socket,
        11,
        "open_upload",
        OpenUploadParams {
            transfer: id(24),
            ..replace
        }
        .to_cbor(),
    )
    .await
    .problem
    .unwrap();
    assert_eq!(stale.reason.as_deref(), Some("revision_mismatch"));
    let stale = rpc(
        &mut socket,
        12,
        "read_file",
        map([(0, file.to_cbor()), (2, sha256(&body).to_cbor())]),
    )
    .await
    .problem
    .unwrap();
    assert_eq!(stale.reason.as_deref(), Some("revision_mismatch"));
    let oversized = rpc(
        &mut socket,
        13,
        "open_upload",
        OpenUploadParams {
            size: (4 << 20) + 1,
            ..upload
        }
        .to_cbor(),
    )
    .await
    .problem
    .unwrap();
    assert_eq!(oversized.reason.as_deref(), Some("local_attachment_limit"));

    let rename = Op::FileMove(FileMove {
        id: file,
        from: "tiny.bin".into(),
        to: "moved.bin".into(),
        update_refs: false,
        if_revision: Some(sha256(b"")),
    });
    assert_eq!(
        receipt(rpc(&mut socket, 14, "submit", submit(rename, id(25))).await).state,
        ReceiptState::Confirmed
    );
    assert!(!fixture.collection.join("tiny.bin").exists());
    assert!(fixture.collection.join("moved.bin").exists());
    let delete = Op::FileDelete(FileDelete {
        id: file,
        if_revision: Some(sha256(b"")),
        base: None,
    });
    assert_eq!(
        receipt(rpc(&mut socket, 15, "submit", submit(delete, id(26))).await).state,
        ReceiptState::Confirmed
    );
    assert!(!fixture.collection.join("moved.bin").exists());
    child.kill().await.unwrap();
}

#[test]
fn dormant_local_capture_is_rejected_on_ordinary_host_reopen() {
    let fixture = Fixture::new("reopen");
    let options = FolderOptions {
        state_dir: None,
        desktop: false,
        timezone: None,
        take_over: false,
        client: ("native-web-replica-tests".into(), "0".into()),
    };
    let mutation = id(31);
    let owner = id(32);
    let mut folder = open_folder(&fixture.collection, &options).unwrap();
    assert!(
        folder
            .replica
            .replica()
            .hello(SessionAuth::LocalWeb(owner), hello())
            .is_err()
    );
    let replica_id = folder.replica.replica_ref().config().replica_id;
    folder
        .replica
        .replica()
        .store_mut()
        .commit(Tx {
            pending_put: vec![PendingRow {
                order: 1,
                mutation: Mutation {
                    id: mutation,
                    origin: replica_id,
                    base_seq: 0,
                    clock: OpClock {
                        instant: 1,
                        tz: "UTC".into(),
                        local_date: "1970-01-01".into(),
                    },
                    seed: B32([3; 32]),
                    source: Source::Api,
                    ops: vec![create(id(33), "dormant.md")],
                    on_behalf: None,
                    conflict_mode: None,
                    validated_at: None,
                    room: None,
                }
                .into(),
                effects: Vec::new(),
                touches: Vec::new(),
                grant: Some(owner),
                uploads: Vec::new(),
                refs: Vec::new(),
            }],
            ..Tx::default()
        })
        .unwrap();
    let replica = folder.replica.replica();
    let other = id(34);
    replica
        .enable_local_web(move |subject| subject == owner || subject == other)
        .unwrap();
    let (mine, mine_hello) = replica
        .hello(SessionAuth::LocalWeb(owner), hello())
        .unwrap();
    let (theirs, their_hello) = replica
        .hello(SessionAuth::LocalWeb(other), hello())
        .unwrap();
    assert_eq!(mine_hello.status.pending, 1);
    assert_eq!(their_hello.status.pending, 0);
    assert_eq!(replica.status(mine).unwrap().oldest_pending, Some(1));
    assert_eq!(replica.status(theirs).unwrap().oldest_pending, None);
    assert_eq!(
        replica.list_pending(mine, None).unwrap().pending[0]
            .receipt
            .mutation,
        mutation
    );
    assert!(
        replica
            .list_pending(theirs, None)
            .unwrap()
            .pending
            .is_empty()
    );
    assert_eq!(
        replica.receipt(mine, mutation).unwrap().state,
        ReceiptState::Pending
    );
    assert_eq!(
        replica
            .receipt(theirs, mutation)
            .unwrap_err()
            .problem()
            .code,
        "not_found"
    );
    drop(folder);
    let reopened = open_folder(&fixture.collection, &options).unwrap();
    let store = reopened.replica.replica_ref().store();
    assert!(store.pending_get(&mutation).unwrap().is_none());
    let refused = store.local_receipt(&mutation).unwrap().unwrap();
    assert_eq!(refused.state, ReceiptState::Rejected);
    assert_eq!(refused.grant, Some(owner));
    assert_eq!(
        refused.problem.unwrap().reason.as_deref(),
        Some("local_web_revoked")
    );
    assert!(!fixture.collection.join("dormant.md").exists());
}

#[path = "web_replica/webtransport.rs"]
mod private_transport;
