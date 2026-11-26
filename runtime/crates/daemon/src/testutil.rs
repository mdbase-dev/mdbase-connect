//! Test helpers. Scratch directories live under the workspace `target/`, never
//! `/tmp` (AGENTS.md).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static NEXT: AtomicU32 = AtomicU32::new(0);

/// A fresh directory under `target/t/`, removed on drop.
pub struct TestDir(PathBuf);

impl TestDir {
    /// Create `target/t/<tag>-<pid>-<n>`. Kept short: Unix socket paths are
    /// limited to about 100 bytes.
    pub fn new(tag: &str) -> TestDir {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let p = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/t")
            .join(format!("{tag}-{}-{n}", std::process::id()));
        let p = std::path::absolute(&p).unwrap();
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        TestDir(p)
    }

    /// The path.
    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(crate) async fn json_request(
    listener: &tokio::net::TcpListener,
) -> (tokio::net::TcpStream, String, serde_json::Value) {
    use tokio::io::AsyncReadExt;
    let (mut socket, _) = listener.accept().await.unwrap();
    let mut bytes = Vec::new();
    let end = loop {
        let mut chunk = [0; 1024];
        let read = socket.read(&mut chunk).await.unwrap();
        assert!(read > 0);
        bytes.extend_from_slice(&chunk[..read]);
        assert!(bytes.len() <= 8192);
        if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
            break end + 4;
        }
    };
    let headers = String::from_utf8(bytes[..end].to_vec()).unwrap();
    let length: usize = headers
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length: ")
                .map(|value| value.parse().unwrap())
        })
        .unwrap_or(0);
    assert!(length + end <= 8192);
    while bytes.len() < end + length {
        let mut chunk = [0; 1024];
        let read = socket.read(&mut chunk).await.unwrap();
        assert!(read > 0);
        bytes.extend_from_slice(&chunk[..read]);
    }
    let path = headers
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .to_owned();
    let body = if length == 0 {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes[end..end + length]).unwrap()
    };
    (socket, path, body)
}

pub(crate) async fn json_reply(mut socket: tokio::net::TcpStream, value: serde_json::Value) {
    use tokio::io::AsyncWriteExt;
    let body = serde_json::to_string(&value).unwrap();
    socket
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .as_bytes(),
        )
        .await
        .unwrap();
}
