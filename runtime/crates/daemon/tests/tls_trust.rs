//! Sign-in over TLS trusts what the OS trusts (Connect #1696): a server whose
//! certificate chains to a private CA (as behind HTTPS inspection) is accepted
//! once the OS trusts that CA, and refused with the TLS cause in the error when
//! it does not.
//!
//! The OS trust is set through `SSL_CERT_FILE`, which only the system-bundle
//! verifier reads (Linux and the other non-Apple Unixes); each case runs in a
//! child copy of this test so the variable never leaks between cases.
#![cfg(all(unix, not(target_vendor = "apple")))]
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use mdbn_daemon::cloud::{CloudError, pairing_start, tls_config};
use rcgen::{BasicConstraints, CertificateParams, CertifiedIssuer, IsCa, KeyPair};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_rustls::rustls::{self, pki_types::PrivateKeyDer};

const TEST: &str = "sign_in_trusts_the_os_trust_store";
/// Set in a child: `trusted` or `untrusted`, and the scratch directory.
const CASE: &str = "MDBN_TLS_TRUST_CASE";
const DIR: &str = "MDBN_TLS_TRUST_DIR";

#[test]
fn sign_in_trusts_the_os_trust_store() {
    if let Ok(case) = std::env::var(CASE) {
        let dir = std::env::var(DIR).unwrap();
        return child(&case, Path::new(&dir));
    }
    let dir = std::path::PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("tls-trust-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let inspection = ca("mdbase test inspection CA");
    let unrelated = ca("mdbase test unrelated CA");
    let server_key = KeyPair::generate().unwrap();
    let server = CertificateParams::new(vec!["localhost".to_string()])
        .unwrap()
        .signed_by(&server_key, &inspection)
        .unwrap();
    let write = |name: &str, body: String| std::fs::write(dir.join(name), body).unwrap();
    write("inspection-ca.pem", inspection.pem());
    write("unrelated-ca.pem", unrelated.pem());
    write("server.pem", server.pem());
    write("server.key", server_key.serialize_pem());

    for (case, roots) in [
        ("trusted", "inspection-ca.pem"),
        ("untrusted", "unrelated-ca.pem"),
    ] {
        let out = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--nocapture", "--test-threads=1"])
            .env(CASE, case)
            .env(DIR, &dir)
            .env("SSL_CERT_FILE", dir.join(roots))
            .env_remove("SSL_CERT_DIR")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{case} case failed:\n{}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }
}

fn ca(name: &str) -> CertifiedIssuer<'static, KeyPair> {
    let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, name);
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    CertifiedIssuer::self_signed(params, KeyPair::generate().unwrap()).unwrap()
}

fn child(case: &str, dir: &Path) {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let origin = serve(dir).await;
        let result = pairing_start(&tls_config().unwrap(), &origin, "test").await;
        match case {
            "trusted" => {
                let pairing = result.unwrap();
                assert_eq!(pairing.pairing_id, "p1");
            }
            "untrusted" => match result {
                // The cause, not just "error sending request", reaches the user.
                Err(CloudError::Network(m)) => assert!(m.contains("UnknownIssuer"), "{m}"),
                other => panic!("expected an untrusted-issuer network error, got {other:?}"),
            },
            _ => unreachable!(),
        }
    });
}

/// A one-request HTTPS server on localhost answering a pairing start.
async fn serve(dir: &Path) -> String {
    use rustls::pki_types::{CertificateDer, pem::PemObject};
    let cert = CertificateDer::from_pem_file(dir.join("server.pem")).unwrap();
    let key = PrivateKeyDer::from_pem_file(dir.join("server.key")).unwrap();
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(vec![cert], key)
    .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!(
        "https://localhost:{}",
        listener.local_addr().unwrap().port()
    );
    let body = serde_json::json!({
        "pairing_id": "p1",
        "pairing_secret": "s1",
        "verification_uri": format!("{origin}/approve"),
        "expires_in": 600,
    })
    .to_string();
    tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        // An untrusted client aborts the handshake; nothing more to serve.
        let Ok(mut tls) = acceptor.accept(tcp).await else {
            return;
        };
        let mut request = Vec::new();
        let mut buf = [0u8; 4096];
        while !request.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = tls.read(&mut buf).await.unwrap();
            assert!(n > 0, "request ended early");
            request.extend_from_slice(&buf[..n]);
        }
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        tls.write_all(response.as_bytes()).await.unwrap();
        tls.shutdown().await.unwrap();
    });
    origin
}
