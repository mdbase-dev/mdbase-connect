//! Direct transfers against a scripted loopback HTTP/1.1 object store.

use super::*;
use mdbn_wire::common::DataMap;
use std::sync::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// One request as the store saw it.
#[derive(Clone)]
struct Seen {
    method: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

/// What the store does with request `n` (0-based).
enum Act {
    /// Status, extra headers, body; `content-length` is the body's.
    Reply(u16, Vec<(String, String)>, Vec<u8>),
    /// Status and headers with `content-length: declared`, then only `body`, then close.
    Truncate(u16, Vec<(String, String)>, u64, Vec<u8>),
    /// Close without answering.
    Drop,
}

type Script = Box<dyn Fn(usize, &Seen) -> Act + Send + Sync>;

struct Store {
    url: String,
    seen: Arc<Mutex<Vec<Seen>>>,
}

async fn store(script: Script) -> Store {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    let script = Arc::new(script);
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let log = log.clone();
            let script = script.clone();
            tokio::spawn(async move {
                let Some(req) = read_request(&mut sock).await else {
                    return;
                };
                let n = {
                    let mut l = log.lock().unwrap();
                    l.push(req.clone());
                    l.len() - 1
                };
                let (status, headers, declared, body) = match script(n, &req) {
                    Act::Drop => return,
                    Act::Reply(s, h, b) => (s, h, b.len() as u64, b),
                    Act::Truncate(s, h, d, b) => (s, h, d, b),
                };
                let mut head = format!(
                    "HTTP/1.1 {status} X\r\nconnection: close\r\ncontent-length: {declared}\r\n"
                );
                for (k, v) in headers {
                    head.push_str(&format!("{k}: {v}\r\n"));
                }
                head.push_str("\r\n");
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(&body).await;
                let _ = sock.flush().await;
            });
        }
    });
    Store {
        url: format!("http://{addr}/v1/o/c/a?op=x&sig=secret"),
        seen,
    }
}

async fn read_request(sock: &mut tokio::net::TcpStream) -> Option<Seen> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 65536];
    let end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        let n = sock.read(&mut tmp).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
    };
    let head = String::from_utf8(buf[..end].to_vec()).ok()?;
    let mut lines = head.split("\r\n");
    let method = lines.next()?.split(' ').next()?.to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    let len: usize = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut body = buf[end + 4..].to_vec();
    while body.len() < len {
        let n = sock.read(&mut tmp).await.ok()?;
        if n == 0 {
            return None;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    Some(Seen {
        method,
        headers,
        body,
    })
}

const NOW: i64 = 1_000_000;

fn now() -> i64 {
    NOW
}

fn object(n: usize) -> Vec<u8> {
    let mut x = 0x9e37_79b9_7f4a_7c15u64;
    (0..n)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x as u8
        })
        .collect()
}

fn transfer(url: &str, headers: Vec<(String, String)>) -> DirectTransfer {
    DirectTransfer {
        url: url.into(),
        headers: DataMap(headers),
        expires_at: NOW + 15 * 60 * 1000,
    }
}

fn ck_header(b: &[u8]) -> Vec<(String, String)> {
    vec![(CHECKSUM_HEADER.into(), b64(&sha256(b)))]
}

fn http() -> reqwest::Client {
    client(None).unwrap()
}

const SIZE: usize = 3 * 1024 * 1024 + 17;

#[tokio::test]
async fn upload_sends_exact_bytes_and_integrity_header() {
    let body = object(SIZE);
    let s = store(Box::new(|_, _| Act::Reply(200, vec![], vec![]))).await;
    let dt = transfer(&s.url, ck_header(&body));
    let out = upload(&http(), &dt, &local(), body.clone().into(), now).await;
    assert_eq!(out, UploadOutcome::Uploaded);
    let seen = s.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].method, "PUT");
    assert_eq!(seen[0].body, body);
    assert_eq!(
        seen[0].header("content-length"),
        Some(SIZE.to_string().as_str())
    );
    assert_eq!(
        seen[0].header(CHECKSUM_HEADER),
        Some(b64(&sha256(&body)).as_str())
    );
}

#[tokio::test]
async fn interrupted_put_is_retried_against_the_same_url() {
    let body = object(SIZE);
    let s = store(Box::new(|n, _| match n {
        0 => Act::Drop,
        1 => Act::Reply(503, vec![], vec![]),
        _ => Act::Reply(200, vec![], vec![]),
    }))
    .await;
    let dt = transfer(&s.url, ck_header(&body));
    assert_eq!(
        upload(&http(), &dt, &local(), body.clone().into(), now).await,
        UploadOutcome::Uploaded
    );
    let seen = s.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 3);
    assert!(seen.iter().all(|r| r.body == body));
}

#[tokio::test]
async fn put_that_never_lands_is_unknown_for_commit_to_decide() {
    let body = object(SIZE);
    let s = store(Box::new(|_, _| Act::Drop)).await;
    let dt = transfer(&s.url, ck_header(&body));
    assert_eq!(
        upload(&http(), &dt, &local(), body.into(), now).await,
        UploadOutcome::Unknown
    );
    assert_eq!(s.seen.lock().unwrap().len(), PUT_ATTEMPTS as usize);
}

#[tokio::test]
async fn expired_or_refused_signature_asks_for_a_new_url() {
    let body = object(SIZE);
    let s = store(Box::new(|_, _| Act::Reply(403, vec![], vec![]))).await;
    let dt = transfer(&s.url, ck_header(&body));
    assert_eq!(
        upload(&http(), &dt, &local(), body.clone().into(), now).await,
        UploadOutcome::Expired
    );
    // Already expired: nothing is sent.
    let mut old = transfer(&s.url, ck_header(&body));
    old.expires_at = NOW + 1_000;
    assert_eq!(
        upload(&http(), &old, &local(), body.into(), now).await,
        UploadOutcome::Expired
    );
    assert_eq!(s.seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn bad_request_headers_and_urls_are_refused_before_sending() {
    let body = object(SIZE);
    let s = store(Box::new(|_, _| Act::Reply(200, vec![], vec![]))).await;
    let other = ck_header(&object(10));
    let cases = [
        transfer(&s.url, other),
        transfer(&s.url, vec![("Host".into(), "evil".into())]),
        transfer(&s.url, vec![("content-length".into(), "1".into())]),
        transfer("http://example.com/v1/o/c/a?sig=x", ck_header(&body)),
        transfer(
            &s.url.replace("http://", "http://user:pw@"),
            ck_header(&body),
        ),
        transfer("ftp://127.0.0.1/x", ck_header(&body)),
    ];
    for dt in &cases {
        assert_eq!(
            upload(&http(), dt, &local(), body.clone().into(), now).await,
            UploadOutcome::Refused
        );
    }
    assert!(s.seen.lock().unwrap().is_empty());
    let s4 = store(Box::new(|_, _| Act::Reply(400, vec![], vec![]))).await;
    assert_eq!(
        upload(
            &http(),
            &transfer(&s4.url, ck_header(&body)),
            &local(),
            body.into(),
            now
        )
        .await,
        UploadOutcome::Refused
    );
}

#[tokio::test]
async fn redirects_are_not_followed() {
    let body = object(SIZE);
    let target = store(Box::new(|_, _| Act::Reply(200, vec![], vec![]))).await;
    let loc = target.url.clone();
    let s = store(Box::new(move |_, _| {
        Act::Reply(307, vec![("location".into(), loc.clone())], vec![])
    }))
    .await;
    let dt = transfer(&s.url, ck_header(&body));
    assert_eq!(
        upload(&http(), &dt, &local(), body.into(), now).await,
        UploadOutcome::Refused
    );
    assert!(target.seen.lock().unwrap().is_empty());
}

fn full_headers(b: &[u8]) -> Vec<(String, String)> {
    ck_header(b)
}

#[tokio::test]
async fn download_whole_object() {
    let body = object(SIZE);
    let b = body.clone();
    let s = store(Box::new(move |_, _| {
        Act::Reply(200, full_headers(&b), b.clone())
    }))
    .await;
    let got = download(
        &http(),
        &transfer(&s.url, vec![]),
        &local(),
        SIZE as u64,
        &sha256(&body),
        now,
    )
    .await
    .unwrap();
    assert_eq!(got, body);
    assert_eq!(got.capacity(), SIZE, "one exact buffer");
    let seen = s.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].header("range"), None);
}

#[tokio::test]
async fn interrupted_download_resumes_with_one_closed_range() {
    let body = object(SIZE);
    let b = body.clone();
    let half = SIZE / 2 + 3;
    let s = store(Box::new(move |n, req| {
        let size = b.len();
        match n {
            0 => Act::Truncate(200, full_headers(&b), size as u64, b[..half].to_vec()),
            _ => {
                let want = format!("bytes={half}-{}", size - 1);
                assert_eq!(req.header("range"), Some(want.as_str()));
                let mut h = full_headers(&b);
                h.push((
                    "content-range".into(),
                    format!("bytes {half}-{}/{size}", size - 1),
                ));
                Act::Reply(206, h, b[half..].to_vec())
            }
        }
    }))
    .await;
    let got = download(
        &http(),
        &transfer(&s.url, vec![]),
        &local(),
        SIZE as u64,
        &sha256(&body),
        now,
    )
    .await
    .unwrap();
    assert_eq!(got, body);
    let seen = s.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 2);
    assert_eq!(
        seen[1].headers.iter().filter(|(k, _)| k == "range").count(),
        1
    );
}

async fn download_err(script: Script, body: &[u8]) -> DownloadError {
    let s = store(script).await;
    download(
        &http(),
        &transfer(&s.url, vec![]),
        &local(),
        body.len() as u64,
        &sha256(body),
        now,
    )
    .await
    .unwrap_err()
}

#[tokio::test]
async fn download_refuses_fallbacks_and_mismatches() {
    let body = object(SIZE);
    let half = SIZE / 2;
    // A whole body in answer to a resume: no silent fallback.
    let b = body.clone();
    let e = download_err(
        Box::new(move |n, _| match n {
            0 => Act::Truncate(200, vec![], b.len() as u64, b[..half].to_vec()),
            _ => Act::Reply(200, vec![], b.clone()),
        }),
        &body,
    )
    .await;
    assert_eq!(e, DownloadError::Integrity);
    // A resume whose Content-Range is not the requested span.
    let b = body.clone();
    let e = download_err(
        Box::new(move |n, _| match n {
            0 => Act::Truncate(200, vec![], b.len() as u64, b[..half].to_vec()),
            _ => Act::Reply(
                206,
                vec![(
                    "content-range".into(),
                    format!("bytes {}-{}/{}", half - 1, b.len() - 2, b.len()),
                )],
                b[half..].to_vec(),
            ),
        }),
        &body,
    )
    .await;
    assert_eq!(e, DownloadError::Integrity);
    // Corrupt bytes.
    let mut bad = body.clone();
    bad[5] ^= 1;
    let e = download_err(
        Box::new(move |_, _| Act::Reply(200, vec![], bad.clone())),
        &body,
    )
    .await;
    assert_eq!(e, DownloadError::Integrity);
    // An integrity header for another object.
    let b = body.clone();
    let e = download_err(
        Box::new(move |_, _| Act::Reply(200, ck_header(&b[1..]), b.clone())),
        &body,
    )
    .await;
    assert_eq!(e, DownloadError::Integrity);
    // Wrong length.
    let b = body.clone();
    let e = download_err(
        Box::new(move |_, _| Act::Reply(200, vec![], b[1..].to_vec())),
        &body,
    )
    .await;
    assert_eq!(e, DownloadError::Integrity);
    // 416.
    let e = download_err(Box::new(|_, _| Act::Reply(416, vec![], vec![])), &body).await;
    assert_eq!(e, DownloadError::Integrity);
}

#[tokio::test]
async fn download_status_mapping() {
    let body = object(SIZE);
    let e = download_err(Box::new(|_, _| Act::Reply(403, vec![], vec![])), &body).await;
    assert_eq!(e, DownloadError::Expired);
    let e = download_err(Box::new(|_, _| Act::Reply(404, vec![], vec![])), &body).await;
    assert_eq!(e, DownloadError::NotFound);
    let e = download_err(Box::new(|_, _| Act::Drop), &body).await;
    assert_eq!(e, DownloadError::Unavailable);
    // A stalled source that never delivers is bounded too.
    let b = body.clone();
    let e = download_err(
        Box::new(move |_, _| Act::Truncate(200, vec![], b.len() as u64, vec![])),
        &body,
    )
    .await;
    assert_eq!(e, DownloadError::Unavailable);
    // Over the object ceiling: refused before any request.
    let s = store(Box::new(|_, _| Act::Reply(200, vec![], vec![]))).await;
    let e = download(
        &http(),
        &transfer(&s.url, vec![]),
        &local(),
        MAX_DIRECT_OBJECT + 1,
        &B32([0; 32]),
        now,
    )
    .await
    .unwrap_err();
    assert_eq!(e, DownloadError::Integrity);
    assert!(s.seen.lock().unwrap().is_empty());
}

#[test]
fn urls_are_checked_without_echoing_them() {
    let log = DirectPin::from_log_url("wss://log.example/v1/ls").unwrap();
    assert!(check_url("https://log.example/v1/o/x?sig=1", &log).is_ok());
    assert!(check_url("https://LOG.example:443/v1/o/x", &log).is_ok());
    assert!(check_url("http://127.0.0.1:9/x", &local()).is_ok());
    assert!(check_url("http://[::1]:9/x", &local()).is_ok());
    assert!(check_url("http://localhost:9/x", &local()).is_ok());
    for bad in [
        "http://example.com/x?sig=secret",
        "https://u:secret@example.com/x",
        "ftp://127.0.0.1/x",
        "not a url secret",
    ] {
        for pin in [&log, &local()] {
            let e = check_url(bad, pin).unwrap_err();
            assert!(!e.contains("secret"));
        }
    }
}

/// A log service (untrusted under E2E) cannot point direct transfers at
/// another host, port or scheme, nor at loopback, LAN, link-local or other
/// non-global addresses; a local log may use loopback only.
#[test]
fn direct_urls_are_pinned_to_the_log_origin() {
    let log = DirectPin::from_log_url("wss://log.example/v1/ls").unwrap();
    for bad in [
        "https://r2.example/x?sig=secret",
        "https://log.example:8443/x?sig=secret",
        "http://log.example/x?sig=secret",
        "https://log.example.evil.test/x?sig=secret",
        "https://127.0.0.1/x?sig=secret",
        "https://localhost/x?sig=secret",
        "https://10.0.0.5/x?sig=secret",
        "https://192.168.1.10/x?sig=secret",
        "https://172.16.0.1/x?sig=secret",
        "https://169.254.169.254/latest/meta-data?sig=secret",
        "https://100.64.0.1/x?sig=secret",
        "https://0.0.0.0/x?sig=secret",
        "https://[::1]/x?sig=secret",
        "https://[fd00::1]/x?sig=secret",
        "https://[fe80::1]/x?sig=secret",
        "https://[::ffff:10.0.0.1]/x?sig=secret",
    ] {
        let e = check_url(bad, &log).unwrap_err();
        assert!(!e.contains("secret"), "{bad}");
    }
    // A public log origin that is an IP literal still gets its own origin only.
    let ip_log = DirectPin::from_log_url("wss://203.0.114.7:7443/v1").unwrap();
    assert!(check_url("https://203.0.114.7:7443/v1/o/x", &ip_log).is_ok());
    assert!(check_url("https://203.0.114.8:7443/v1/o/x", &ip_log).is_err());
    // A local log: loopback only.
    for bad in [
        "http://10.0.0.5:9/x",
        "https://example.com/x",
        "http://169.254.169.254/x",
    ] {
        assert!(check_url(bad, &local()).is_err(), "{bad}");
    }
    // The pin itself: plain http only to loopback.
    assert!(DirectPin::from_log_url("ws://log.example/v1").is_err());
    assert!(DirectPin::from_log_url("ftp://log.example/v1").is_err());
}

fn local() -> DirectPin {
    DirectPin::from_log_url("ws://127.0.0.1:1/v1").unwrap()
}
