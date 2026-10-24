//! Large objects through the transport (log-service-api §6): a staged upload is
//! answered only by its `commit_object`, a direct GET is verified and answered
//! inline, and expired or failed transfers answer `unavailable` for the replica to
//! retry with a fresh URL.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use mdbn_replica::log::{CallId, LogError, LogErrorCode, LogResponse};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B32, DataMap, Uuid};
use mdbn_wire::log_service::{
    CommitObjectParams, DirectTransfer, GetObjectResult, LsFrame, LsRequest, LsResponse,
    PutObjectResult, PutStatus,
};
use mdbn_wire::schema::Wire;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

use super::{COL, DEV, NONCE, binding, tokens, until};
use crate::logwire::*;

const SIZE: usize = 3 * 1024 * 1024 + 5;

fn object() -> Vec<u8> {
    let mut x = 0x2545_f491_4f6c_dd1du64;
    (0..SIZE)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x as u8
        })
        .collect()
}

fn sha(b: &[u8]) -> B32 {
    mdbn_wire::hash::sha256(b)
}

/// How the object store answers PUT number `n` and GET number `n`.
#[derive(Clone, Copy)]
enum Put {
    /// Drop the first `k` PUTs, then accept.
    DropFirst(usize),
    /// 403 (an expired signature).
    Expired,
}

#[derive(Default)]
struct Store {
    puts: AtomicUsize,
    gets: AtomicUsize,
    stored: Mutex<Option<Vec<u8>>>,
    ranges: Mutex<Vec<String>>,
}

/// A loopback object store: PUT per `put`; GET serves `body`, the first response
/// cut in half, then the requested closed range.
async fn object_store(put: Put, body: Vec<u8>, st: Arc<Store>) -> String {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = l.accept().await else {
                return;
            };
            let (st, body) = (st.clone(), body.clone());
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut tmp = vec![0u8; 1 << 16];
                let end = loop {
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i;
                    }
                    match s.read(&mut tmp).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => buf.extend_from_slice(&tmp[..n]),
                    }
                };
                let head = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
                let header = |name: &str| {
                    head.lines()
                        .find_map(|l| l.strip_prefix(&format!("{name}: ")).map(str::to_owned))
                };
                let len: usize = header("content-length")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                let mut got = buf[end + 4..].to_vec();
                while got.len() < len {
                    match s.read(&mut tmp).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => got.extend_from_slice(&tmp[..n]),
                    }
                }
                let reply = |status: &str, extra: String, declared: usize| {
                    format!(
                        "HTTP/1.1 {status}\r\nconnection: close\r\ncontent-length: {declared}\r\n{extra}\r\n"
                    )
                };
                if head.starts_with("put ") {
                    let n = st.puts.fetch_add(1, Ordering::SeqCst);
                    match put {
                        Put::DropFirst(k) if n < k => {}
                        Put::DropFirst(_) => {
                            *st.stored.lock().unwrap() = Some(got);
                            let _ = s
                                .write_all(reply("200 OK", String::new(), 0).as_bytes())
                                .await;
                        }
                        Put::Expired => {
                            let _ = s
                                .write_all(reply("403 Forbidden", String::new(), 0).as_bytes())
                                .await;
                        }
                    }
                    return;
                }
                let n = st.gets.fetch_add(1, Ordering::SeqCst);
                let ck = base64::engine::general_purpose::STANDARD.encode(sha(&body).0);
                let size = body.len();
                if n == 0 {
                    let h = reply("200 OK", format!("x-amz-checksum-sha256: {ck}\r\n"), size);
                    let _ = s.write_all(h.as_bytes()).await;
                    let _ = s.write_all(&body[..size / 2]).await;
                    return;
                }
                let range = header("range").unwrap_or_default();
                st.ranges.lock().unwrap().push(range.clone());
                let start: usize = range
                    .strip_prefix("bytes=")
                    .and_then(|r| r.split('-').next())
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                let h = reply(
                    "206 Partial Content",
                    format!(
                        "x-amz-checksum-sha256: {ck}\r\ncontent-range: bytes {start}-{}/{size}\r\n",
                        size - 1
                    ),
                    size - start,
                );
                let _ = s.write_all(h.as_bytes()).await;
                let _ = s.write_all(&body[start..]).await;
            });
        }
    });
    format!("http://{addr}/v1/o/c/a?op=x&sig=secret")
}

/// What the log peer saw and how it answers `commit_object`.
#[derive(Default)]
struct Log {
    commits: Mutex<Vec<CommitObjectParams>>,
    commit_ok: Mutex<bool>,
}

/// A log peer: put_object → upload to `put_url`; get_object → direct GET of `body`.
async fn log_peer(put_url: String, body: Vec<u8>, log: Arc<Log>) -> String {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        let (tcp, _) = l.accept().await.unwrap();
        #[allow(clippy::result_large_err)] // tungstenite's callback signature
        let add_nonce = |_: &Request, mut r: Response| {
            r.headers_mut().insert(
                "x-mdbase-nonce",
                crate::secrets::hex(&NONCE).parse().unwrap(),
            );
            Ok(r)
        };
        let ws = tokio_tungstenite::accept_hdr_async(tcp, add_nonce)
            .await
            .unwrap();
        let (mut tx, mut rx) = ws.split();
        let frame = |id, result: Cbor| {
            Message::Binary(
                LsFrame::Response(LsResponse {
                    id,
                    result: Some(result),
                    error: None,
                })
                .to_bytes()
                .unwrap()
                .into(),
            )
        };
        let dt = |url: &str, headers: Vec<(String, String)>| DirectTransfer {
            url: url.into(),
            headers: DataMap(headers),
            expires_at: super::now_ms() + 15 * 60_000,
        };
        while let Some(Ok(Message::Binary(b))) = rx.next().await {
            let Ok(LsFrame::Request(r)) = LsFrame::from_bytes(&b) else {
                continue;
            };
            let result = match r.method.as_str() {
                "hello" => Cbor::Map(vec![]),
                "put_object" => {
                    let p = mdbn_wire::log_service::PutObjectParams::from_cbor(&r.params).unwrap();
                    assert!(p.bytes.is_none(), "large objects never ride inline");
                    let h = base64::engine::general_purpose::STANDARD.encode(p.checksum.0);
                    PutObjectResult {
                        status: PutStatus::Upload,
                        direct: Some(dt(&put_url, vec![("x-amz-checksum-sha256".into(), h)])),
                    }
                    .to_cbor()
                }
                "commit_object" => {
                    log.commits
                        .lock()
                        .unwrap()
                        .push(CommitObjectParams::from_cbor(&r.params).unwrap());
                    Cbor::Map(vec![(
                        Cbor::Uint(0),
                        Cbor::Bool(*log.commit_ok.lock().unwrap()),
                    )])
                }
                "get_object" => GetObjectResult {
                    bytes: None,
                    direct: Some(dt(&put_url, vec![])),
                    size: body.len() as u64,
                    checksum: sha(&body),
                }
                .to_cbor(),
                _ => continue,
            };
            tx.send(frame(r.id, result)).await.unwrap();
        }
    });
    format!("http://{addr}")
}

type Replies = Arc<Mutex<Vec<(u64, String, Vec<u8>)>>>;

fn reply_sink() -> (Box<dyn Fn(Event) + Send>, super::Seen, Replies) {
    let seen = super::recording();
    let replies: Replies = Arc::default();
    let (s, r) = (seen.clone(), replies.clone());
    let f = move |e: Event| {
        let tag = match e {
            Event::Proof { reply, .. } => {
                let _ = reply.send(Some([0u8; 64]));
                "proof".to_string()
            }
            Event::Up { generation, reply } => {
                let (session, scope) = binding(generation);
                *s.binding.lock().unwrap() = Some((session.clone(), scope));
                let _ = reply.send(Some(session));
                "up".into()
            }
            Event::Reply {
                id, method, bytes, ..
            } => {
                r.lock().unwrap().push((id, method.clone(), bytes));
                format!("reply {id} {method}")
            }
            Event::Down(_) => "down".into(),
            Event::Lost { id, .. } => format!("lost {id}"),
            Event::Offline { id, .. } => format!("offline {id}"),
            Event::Push(..) => "push".into(),
        };
        s.lock().unwrap().push(tag);
    };
    (Box::new(f), seen, replies)
}

fn call(id: u64, seen: &super::Seen, request: mdbn_replica::log::LogRequest) -> Outbound {
    let (session, scope) = seen.binding.lock().unwrap().clone().unwrap();
    let call = mdbn_replica::log::LogCall {
        id: CallId(id),
        endpoint: mdbn_replica::log::EndpointId(1),
        request,
    };
    let frame = mdbn_replica::log_codec::request(&call).unwrap();
    let object = match call.request {
        mdbn_replica::log::LogRequest::PutObject {
            collection,
            address,
            bytes,
            ..
        } => Some(SealedObject {
            collection,
            address,
            bytes: bytes.into(),
        }),
        _ => None,
    };
    Outbound {
        id,
        method: call_method(&frame),
        frame,
        object,
        scope,
        session,
    }
}

fn call_method(frame: &[u8]) -> String {
    match LsFrame::from_bytes(frame).unwrap() {
        LsFrame::Request(LsRequest { method, .. }) => method,
        _ => unreachable!(),
    }
}

fn collection() -> Uuid {
    COL
}

fn put(body: &[u8]) -> mdbn_replica::log::LogRequest {
    mdbn_replica::log::LogRequest::PutObject {
        collection: collection(),
        address: B32([0xab; 32]),
        kind: mdbn_wire::envelope::ItemKind::BlobPart,
        bytes: body.to_vec(),
    }
}

fn decoded(replies: &Replies, id: u64) -> mdbn_replica::log::LogReply {
    let r = replies.lock().unwrap();
    let (_, method, bytes) = r.iter().find(|(i, _, _)| *i == id).unwrap();
    mdbn_replica::log_codec::reply(CallId(id), method, bytes).unwrap()
}

async fn link(url: String) -> (Link, super::Seen, Replies) {
    let (events, seen, replies) = reply_sink();
    let link = Link::spawn(LinkConfig::new(url, COL, Some(DEV)), tokens(), events).unwrap();
    until(&seen, "up").await;
    (link, seen, replies)
}

#[tokio::test(flavor = "multi_thread")]
async fn interrupted_put_is_retried_then_committed_before_the_reply() {
    let body = object();
    let st = Arc::new(Store::default());
    let put_url = object_store(Put::DropFirst(1), body.clone(), st.clone()).await;
    let log = Arc::new(Log::default());
    *log.commit_ok.lock().unwrap() = true;
    let (link, seen, replies) = link(log_peer(put_url, body.clone(), log.clone()).await).await;
    assert!(link.send(call(7, &seen, put(&body))));
    until(&seen, "reply 7 put_object").await;
    assert_eq!(
        decoded(&replies, 7),
        Ok(LogResponse::PutObject { existed: false })
    );
    assert_eq!(
        st.puts.load(Ordering::SeqCst),
        2,
        "one interrupted, one retried"
    );
    assert_eq!(st.stored.lock().unwrap().as_deref(), Some(&body[..]));
    let commits = log.commits.lock().unwrap();
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].collection, collection());
    assert_eq!(commits[0].address, B32([0xab; 32]));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_commit_that_finds_nothing_staged_asks_the_replica_to_retry() {
    let body = object();
    let st = Arc::new(Store::default());
    // Every PUT is lost in transit: the outcome is unknown, so commit decides.
    let put_url = object_store(Put::DropFirst(usize::MAX), body.clone(), st.clone()).await;
    let log = Arc::new(Log::default());
    let (link, seen, replies) = link(log_peer(put_url, body.clone(), log.clone()).await).await;
    assert!(link.send(call(8, &seen, put(&body))));
    until(&seen, "reply 8 put_object").await;
    assert!(matches!(
        decoded(&replies, 8),
        Err(LogError::Service {
            code: LogErrorCode::Unavailable,
            ..
        })
    ));
    assert_eq!(log.commits.lock().unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_expired_upload_url_is_unavailable_and_never_committed() {
    let body = object();
    let st = Arc::new(Store::default());
    let put_url = object_store(Put::Expired, body.clone(), st.clone()).await;
    let log = Arc::new(Log::default());
    *log.commit_ok.lock().unwrap() = true;
    let (link, seen, replies) = link(log_peer(put_url, body.clone(), log.clone()).await).await;
    assert!(link.send(call(9, &seen, put(&body))));
    until(&seen, "reply 9 put_object").await;
    match decoded(&replies, 9) {
        Err(LogError::Service { code, reason, .. }) => {
            assert_eq!(code, LogErrorCode::Unavailable);
            assert_eq!(reason.as_deref(), Some("direct_expired"));
        }
        other => panic!("{other:?}"),
    }
    assert!(log.commits.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_direct_get_resumes_and_is_answered_inline_after_verification() {
    let body = object();
    let st = Arc::new(Store::default());
    let url = object_store(Put::DropFirst(0), body.clone(), st.clone()).await;
    let log = Arc::new(Log::default());
    let (link, seen, replies) = link(log_peer(url, body.clone(), log).await).await;
    let get = mdbn_replica::log::LogRequest::GetObject {
        collection: collection(),
        address: B32([0xab; 32]),
        range: None,
    };
    assert!(link.send(call(10, &seen, get)));
    until(&seen, "reply 10 get_object").await;
    match decoded(&replies, 10) {
        Ok(LogResponse::GetObject {
            bytes,
            size,
            checksum,
        }) => {
            assert_eq!(bytes, body);
            assert_eq!(size, SIZE as u64);
            assert_eq!(checksum, sha(&body));
        }
        other => panic!("{:?}", other.map(|_| ())),
    }
    assert_eq!(st.gets.load(Ordering::SeqCst), 2);
    assert_eq!(
        st.ranges.lock().unwrap().as_slice(),
        [format!("bytes={}-{}", SIZE / 2, SIZE - 1)]
    );
}
