//! Local probes: the replica endpoint handshake, the computer's name and opening the browser.

use super::*;

/// Handshake with the replica endpoint as the hosting app, using the Noise key
/// pinned from `daemon.json` for a collection that cannot exist. A
/// healthy endpoint completes the handshake and answers `unknown_collection`.
pub(super) async fn replica_endpoint_check(profile: &Profile) -> Check {
    use crate::session::{ClientSession, Prologue, request};
    let check = |status: &str, detail: String, action: Option<&str>| Check {
        id: "replica_endpoint".into(),
        status: status.into(),
        detail,
        action: action.map(str::to_string),
    };
    let ident =
        match crate::secrets::read_daemon_identity(&profile.state_dir, &profile.identity_file()) {
            Ok(i) => i,
            Err(e) => {
                return check(
                    "fail",
                    e.to_string(),
                    Some("Check the state directory's owner and permissions."),
                );
            }
        };
    let decode = |h: &str| crate::secrets::hex_decode(h).ok();
    let (Some(pk), Some(dev)) = (
        decode(&ident.noise_pk).and_then(|v| <[u8; 32]>::try_from(v).ok()),
        decode(&ident.device.replace('-', "")).and_then(|v| <[u8; 16]>::try_from(v).ok()),
    ) else {
        return check("fail", "daemon.json is malformed".into(), None);
    };
    let Ok(client_sk) = crate::noise::ephemeral() else {
        return check("fail", "no OS entropy".into(), None);
    };
    let prologue = Prologue {
        collection: [0xff; 16],
        grant: [0; 16],
        target: dev,
    };
    let attempt = async {
        let s = crate::ipc::connect(&profile.replica)
            .await
            .map_err(|e| e.to_string())?;
        let (_, hello) = ClientSession::connect(
            s,
            &client_sk,
            &pk,
            prologue,
            request(0, "hello", mdbn_wire::cbor::Cbor::Null),
        )
        .await
        .map_err(|e| e.to_string())?;
        Ok::<_, String>(hello)
    };
    match tokio::time::timeout(Duration::from_secs(10), attempt).await {
        // The probe has no host key, so the daemon refuses it once the
        // handshake has succeeded; an older daemon answers unknown_collection.
        Ok(Ok(h))
            if matches!(
                h.problem.as_ref().and_then(|p| p.reason.as_deref()),
                Some("host_key_required" | "unknown_collection")
            ) =>
        {
            check(
                "ok",
                format!("Noise handshake with {} succeeded", profile.replica),
                None,
            )
        }
        Ok(Ok(h)) => check(
            "warn",
            format!(
                "handshake succeeded; unexpected answer {:?}",
                h.problem.map(|p| p.reason)
            ),
            None,
        ),
        Ok(Err(e)) => check(
            "fail",
            format!("{}: {e}", profile.replica),
            Some("Restart the daemon; if it persists, see `mdbase logs`."),
        ),
        Err(_) => check("fail", "the replica endpoint did not answer".into(), None),
    }
}

pub(super) fn hostname() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .ok()
        .filter(|h| !h.is_empty() && h.len() <= 80)
        .map(|h| format!("mdbase on {h}"))
        .unwrap_or_else(|| "mdbase on this computer".into())
}

/// Best effort; the URL is printed either way.
pub(super) fn open_browser(uri: &str) {
    if !uri.starts_with("https://") && !uri.starts_with("http://") {
        return;
    }
    let cmd = if cfg!(target_os = "macos") {
        Some(("open", vec![uri]))
    } else if cfg!(windows) {
        Some(("rundll32", vec!["url.dll,FileProtocolHandler", uri]))
    } else {
        Some(("xdg-open", vec![uri]))
    };
    if let Some((bin, args)) = cmd {
        let _ = std::process::Command::new(bin)
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
}
