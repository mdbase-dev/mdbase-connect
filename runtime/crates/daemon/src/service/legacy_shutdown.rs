//! The legacy daemon's existing protocol-5 shutdown, scoped to its own profile.
//! No PID lookup, process-name matching, or service-manager fallback for profiles.

use std::io;
use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use crate::paths::Endpoint;

/// Isolated desktop/LAB profile: stop only its explicit legacy endpoint, never
/// the user's installed service registration or another daemon's PID.
pub(crate) struct ForegroundOldService(pub std::path::PathBuf);

impl mdbn_legacy::OldService for ForegroundOldService {
    fn stop_and_disable(&mut self) -> Result<(), String> {
        stop(&self.0).map(|_| ())
    }
}

fn endpoint(state: &Path) -> Endpoint {
    #[cfg(unix)]
    {
        Endpoint::Unix(state.join("agent.sock"))
    }
    #[cfg(windows)]
    {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(state.to_string_lossy().as_bytes());
        let suffix: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
        Endpoint::Pipe(format!(r"\\.\pipe\mdbase-connect-{suffix}"))
    }
}

/// Called by T1 on its blocking worker. The existing takeover lock is the
/// completion barrier; an acknowledged shutdown is not proof the daemon exited.
pub(super) fn stop(state: &Path) -> Result<bool, String> {
    #[cfg(unix)]
    if !state.join("agent.sock").exists() {
        return Ok(false);
    }
    let run = async {
        tokio::time::timeout(Duration::from_secs(5), stop_async(state))
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "legacy shutdown timed out"))?
    };
    let result = match tokio::runtime::Handle::try_current() {
        Ok(runtime) => runtime.block_on(run),
        Err(_) => tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?
            .block_on(run),
    };
    result.map_err(|e| format!("legacy profile shutdown: {e}"))
}

async fn exchange(state: &Path, method: &str) -> io::Result<Value> {
    crate::fsutil::verify_owner_only(state)?;
    let endpoint = endpoint(state);
    #[cfg(unix)]
    let mut stream: crate::ipc::BoxStream = {
        crate::fsutil::verify_owner_only(&state.join("agent.sock"))?;
        let stream = tokio::net::UnixStream::connect(state.join("agent.sock")).await?;
        if stream.peer_cred()?.uid() != crate::fsutil::euid() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "legacy peer is not this user",
            ));
        }
        Box::new(stream)
    };
    #[cfg(windows)]
    let mut stream = crate::ipc::connect(&endpoint).await?;
    let _ = endpoint;
    let id = crate::secrets::new_uuid().map_err(|_| io::Error::other("legacy request ID"))?;
    let mut request = serde_json::to_vec(&json!({"id":id,"protocol_version":5,"method":method}))?;
    request.push(b'\n');
    stream.write_all(&request).await?;
    let mut line = Vec::new();
    BufReader::new(stream.take(65537))
        .read_until(b'\n', &mut line)
        .await?;
    if line.len() > 65536 || line.last() != Some(&b'\n') {
        return Err(io::Error::other("invalid legacy response frame"));
    }
    let response: Value = serde_json::from_slice(&line)?;
    if response["id"] != id || response["protocol_version"] != 5 || response["ok"] != true {
        return Err(io::Error::other("legacy protocol response mismatch"));
    }
    Ok(response["result"].clone())
}

async fn stop_async(state: &Path) -> io::Result<bool> {
    let status = match exchange(state, "status").await {
        Err(e)
            if matches!(
                e.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
            ) =>
        {
            return Ok(false);
        }
        result => result?,
    };
    if status["protocol_version"] != 5
        || !status["binary_version"]
            .as_str()
            .is_some_and(|v| v.starts_with("0.1.0"))
        || !status["registered_collections"].is_u64()
    {
        return Err(io::Error::other("endpoint is not the legacy mdbase daemon"));
    }
    if exchange(state, "daemon.shutdown").await?["stopping"] != true {
        return Err(io::Error::other(
            "legacy daemon did not acknowledge shutdown",
        ));
    }
    Ok(true)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    async fn shuts_down_only_the_identified_legacy_profile_without_a_runtime_binary() {
        let dir = crate::testutil::TestDir::new("ls");
        crate::fsutil::ensure_private_dir(dir.path()).unwrap();
        let listener = tokio::net::UnixListener::bind(dir.path().join("agent.sock")).unwrap();
        std::fs::set_permissions(
            dir.path().join("agent.sock"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let other = tokio::net::UnixListener::bind(dir.path().join("other.sock")).unwrap();
        let server = tokio::spawn(async move {
            for method in ["status", "daemon.shutdown"] {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut line = String::new();
                BufReader::new(&mut stream)
                    .read_line(&mut line)
                    .await
                    .unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                assert_eq!(request["method"], method);
                assert_eq!(request["protocol_version"], 5);
                let result = if method == "status" {
                    json!({"protocol_version":5,"binary_version":"0.1.0-beta.126","registered_collections":2})
                } else {
                    json!({"stopping":true})
                };
                let response =
                    json!({"id":request["id"],"protocol_version":5,"ok":true,"result":result});
                stream
                    .write_all(format!("{response}\n").as_bytes())
                    .await
                    .unwrap();
            }
        });
        let state = dir.path().to_path_buf();
        tokio::task::spawn_blocking(move || {
            use mdbn_legacy::OldService;
            ForegroundOldService(state).stop_and_disable().unwrap();
        })
        .await
        .unwrap();
        server.await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(20), other.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn rejects_nonlegacy_or_mismatched_responses_without_sending_shutdown() {
        for wrong in ["protocol", "id", "identity"] {
            let dir = crate::testutil::TestDir::new("lw");
            crate::fsutil::ensure_private_dir(dir.path()).unwrap();
            let listener = tokio::net::UnixListener::bind(dir.path().join("agent.sock")).unwrap();
            std::fs::set_permissions(
                dir.path().join("agent.sock"),
                std::fs::Permissions::from_mode(0o600),
            )
            .unwrap();
            let path = dir.path().to_path_buf();
            let client = tokio::spawn(async move { stop_async(&path).await });
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let mut line = String::new();
            BufReader::new(&mut stream)
                .read_line(&mut line)
                .await
                .unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            let mut response = json!({"id":request["id"],"protocol_version":5,"ok":true,"result":{"protocol_version":5,"binary_version":"0.1.0-beta.126","registered_collections":0}});
            match wrong {
                "protocol" => response["protocol_version"] = json!(1),
                "id" => response["id"] = json!("other"),
                _ => response["result"]["binary_version"] = json!("unrelated"),
            }
            stream
                .write_all(format!("{response}\n").as_bytes())
                .await
                .unwrap();
            assert!(client.await.unwrap().is_err());
            assert!(
                tokio::time::timeout(Duration::from_millis(20), listener.accept())
                    .await
                    .is_err()
            );
        }
    }

    #[tokio::test]
    async fn absent_profile_is_a_noop_and_untrusted_socket_is_refused() {
        let dir = crate::testutil::TestDir::new("la");
        crate::fsutil::ensure_private_dir(dir.path()).unwrap();
        assert!(!stop_async(dir.path()).await.unwrap());
        let listener = tokio::net::UnixListener::bind(dir.path().join("agent.sock")).unwrap();
        std::fs::set_permissions(
            dir.path().join("agent.sock"),
            std::fs::Permissions::from_mode(0o666),
        )
        .unwrap();
        assert!(stop_async(dir.path()).await.is_err());
        assert!(
            tokio::time::timeout(Duration::from_millis(20), listener.accept())
                .await
                .is_err()
        );
    }
}
