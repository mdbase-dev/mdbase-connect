//! Pairing as a connector, device registration and the connector's own account calls.

use super::*;

/// A started pairing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pairing {
    /// Pairing ID.
    pub pairing_id: String,
    /// Where the user approves it.
    pub verification_uri: String,
    /// Seconds until it expires.
    pub expires_in: u64,
    /// The pairing secret (kept in memory by the daemon only).
    #[serde(skip)]
    pub secret: String,
}

/// Start pairing (`POST /v1/pairing-requests`, unauthenticated).
pub async fn pairing_start(
    tls: &Arc<rustls::ClientConfig>,
    server: &str,
    name: &str,
) -> Result<Pairing, CloudError> {
    let r = http(tls)?
        .post(format!("{server}/v1/pairing-requests"))
        .json(&json!({ "connector_name": name }))
        .send()
        .await
        .map_err(|e| CloudError::Network(e.to_string()))?;
    let (_, v) = json_response(r).await?;
    let get = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let uri = get("verification_uri").ok_or_else(|| CloudError::Server(200, "malformed".into()))?;
    // The approval page must be on the same origin as the server.
    if canonical_server_url(&uri).ok().as_deref() != Some(server) {
        return Err(CloudError::Server(200, "verification_uri_origin".into()));
    }
    Ok(Pairing {
        pairing_id: get("pairing_id").ok_or_else(|| CloudError::Server(200, "malformed".into()))?,
        verification_uri: uri,
        expires_in: v.get("expires_in").and_then(Value::as_u64).unwrap_or(600),
        secret: get("pairing_secret").ok_or_else(|| CloudError::Server(200, "malformed".into()))?,
    })
}

/// An authenticated successful pairing. No Debug implementation exposes the token.
pub struct Paired {
    /// Connector identity (not the account).
    pub connector_id: String,
    /// Canonical account UUID from the authenticated exchange response.
    pub account_id: String,
    /// Connector credential, retained only in memory/keychain.
    pub token: Zeroizing<String>,
}

fn paired_response(status: u16, v: &Value) -> Result<Paired, CloudError> {
    let malformed = || CloudError::Server(status, "invalid_pairing_identity".into());
    let account = v
        .get("account_id")
        .and_then(Value::as_str)
        .ok_or_else(malformed)?;
    crate::authority::account_id(account).ok_or_else(malformed)?;
    let connector = v
        .pointer("/connector/id")
        .and_then(Value::as_str)
        .ok_or_else(malformed)?;
    let token = v
        .get("token")
        .and_then(Value::as_str)
        .filter(|t| t.starts_with("con_") && t.len() >= 24 && !t.contains(char::is_whitespace))
        .ok_or_else(malformed)?;
    Ok(Paired {
        connector_id: connector.into(),
        account_id: account.into(),
        token: Zeroizing::new(token.into()),
    })
}

/// Poll a pairing once: an authenticated account/connector/credential once approved.
pub async fn pairing_exchange(
    tls: &Arc<rustls::ClientConfig>,
    server: &str,
    p: &Pairing,
) -> Result<Option<Paired>, CloudError> {
    let r = http(tls)?
        .post(format!(
            "{server}/v1/pairing-requests/{}/exchange",
            p.pairing_id
        ))
        .bearer_auth(&p.secret)
        .send()
        .await
        .map_err(|e| CloudError::Network(e.to_string()))?;
    let (status, v) = json_response(r).await?;
    if status == 202 {
        return Ok(None);
    }
    Ok(Some(paired_response(status, &v)?))
}

impl Cloud {
    /// Register this device to the connector (idempotent for the same keys).
    pub async fn register_device(
        &self,
        connector_id: &str,
        identity: &DeviceIdentity,
    ) -> Result<(), CloudError> {
        let c = self.post("/v1/next/devices/challenge", &json!({})).await?;
        let challenge = c
            .get("challenge")
            .and_then(Value::as_str)
            .and_then(|h| secrets::hex_decode(h).ok())
            .filter(|b| b.len() == 32)
            .ok_or_else(|| CloudError::Server(200, "malformed".into()))?;
        let p = identity.public();
        let challenge: [u8; 32] = challenge
            .try_into()
            .map_err(|_| CloudError::Server(200, "malformed".into()))?;
        let connector = crate::attest::uuid_bytes(connector_id)
            .ok_or_else(|| CloudError::Local("uuid".into()))?;
        let pk = |h: &str| -> Result<[u8; 32], CloudError> {
            secrets::hex_decode(h)
                .ok()
                .and_then(|b| b.try_into().ok())
                .ok_or_else(|| CloudError::Local("key".into()))
        };
        let digest = mdbn_replica::crypto::proof::cp_enrol_digest(
            &challenge,
            &mdbn_wire::common::B16(connector),
            &mdbn_wire::common::B16(identity.device_id),
            &pk(&p.sign_pk)?,
            &pk(&p.kem_pk)?,
            &pk(&p.noise_pk)?,
        );
        let sig = identity.sign_digest(&digest.0);
        self.post(
            "/v1/next/devices",
            &json!({
                "device_id": p.device,
                "kind": "desktop",
                "capabilities": crate::relay::CAPABILITIES,
                "sign_pk": p.sign_pk,
                "kem_pk": p.kem_pk,
                "noise_pk": p.noise_pk,
                "challenge": secrets::hex(&challenge),
                "sig": secrets::hex(&sig),
            }),
        )
        .await?;
        Ok(())
    }

    /// Rename this computer in the account (`PATCH /v1/connectors/self`); returns
    /// the name the account stored.
    pub async fn rename_self(&self, name: &str) -> Result<String, CloudError> {
        let r = self
            .http
            .patch(format!("{}/v1/connectors/self", self.server))
            .bearer_auth(self.token.as_str())
            .json(&json!({ "name": name }))
            .send()
            .await
            .map_err(|e| CloudError::Network(e.to_string()))?;
        let (status, v) = json_response(r).await?;
        v.pointer("/connector/name")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| CloudError::Server(status, "invalid_connector_rename".into()))
    }

    /// The apps approved anywhere in this computer's account
    /// (`GET /v1/connectors/self/applications`). Only well-formed entries are
    /// returned; a malformed reply is refused whole.
    pub async fn account_applications(&self) -> Result<Vec<AccountApplication>, CloudError> {
        let r = self
            .http
            .get(format!("{}/v1/connectors/self/applications", self.server))
            .bearer_auth(self.token.as_str())
            .send()
            .await
            .map_err(|e| CloudError::Network(e.to_string()))?;
        let (status, v) = json_response(r).await?;
        parse_account_applications(v).ok_or_else(|| CloudError::Server(status, "malformed".into()))
    }

    /// Publish the collection inventory (`POST /v1/connectors/sync`).
    pub async fn inventory(
        &self,
        revision: u64,
        collections: Vec<Value>,
    ) -> Result<(), CloudError> {
        self.post(
            "/v1/connectors/sync",
            &json!({ "inventory_revision": revision, "collections": collections }),
        )
        .await?;
        Ok(())
    }

    /// Revoke a grant the user revoked on this device
    /// (`DELETE /v1/connectors/grants/:id`). The relay must keep acking
    /// snapshots while this is in flight.
    pub async fn revoke_grant(&self, grant: &str) -> Result<(), CloudError> {
        let r = self
            .http
            .delete(format!("{}/v1/connectors/grants/{grant}", self.server))
            .bearer_auth(self.token.as_str())
            .send()
            .await
            .map_err(|e| CloudError::Network(e.to_string()))?;
        json_response(r).await?;
        Ok(())
    }
}

/// An app approved somewhere in the account, as `account.applications` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountApplication {
    /// Application ID.
    pub id: String,
    /// Display name.
    pub name: String,
    /// How the app is delivered.
    pub distribution: AppDistribution,
    /// Where the app is opened, when it has a web home.
    pub homepage: Option<String>,
    /// Icon URL.
    pub icon: Option<String>,
    /// The account collections it is approved for.
    pub collections: Vec<AccountApplicationCollection>,
}

/// How an approved app is delivered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppDistribution {
    /// Served from the web.
    Web,
    /// Installed locally.
    Portable,
}

/// A collection an approved app can use, by account ID and name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountApplicationCollection {
    /// Account collection ID.
    pub id: String,
    /// Display name.
    pub name: String,
}

fn parse_account_applications(value: Value) -> Option<Vec<AccountApplication>> {
    #[derive(Deserialize)]
    struct Reply {
        applications: Vec<AccountApplication>,
    }
    let reply: Reply = serde_json::from_value(value).ok()?;
    let well_formed = reply.applications.iter().all(|a| {
        !a.id.is_empty()
            && !a.name.is_empty()
            && a.collections
                .iter()
                .all(|c| !c.id.is_empty() && !c.name.is_empty())
    });
    well_formed.then_some(reply.applications)
}

/// The relay device-bind signature:
/// `Ed25519(H("mdbase/v1/relay-device", connector_id ‖ utf8(session_id) ‖ nonce))`.
pub fn device_bind_sig(
    identity: &DeviceIdentity,
    connector_id: &[u8; 16],
    session_id: &str,
    nonce: &[u8; 32],
) -> [u8; 64] {
    let d = mdbn_replica::crypto::proof::relay_device_digest(
        &mdbn_wire::common::B16(*connector_id),
        session_id,
        nonce,
    );
    identity.sign_digest(&d.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_identity_is_explicit_and_never_inferred_from_connector_or_token() {
        let mut response = json!({"connector":{"id":"22222222-2222-4222-8222-222222222222"},"token":"con_test_pairing_fixture_12345"});
        for value in [
            Value::Null,
            json!(""),
            json!("SERVICE_ACCOUNT"),
            json!("00000000-0000-0000-0000-000000000000"),
            json!("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"),
        ] {
            response["account_id"] = value;
            assert!(paired_response(200, &response).is_err());
        }
        response.as_object_mut().unwrap().remove("account_id");
        assert!(paired_response(200, &response).is_err());
        response["account_id"] = json!("11111111-1111-4111-8111-111111111111");
        let paired = paired_response(200, &response).unwrap();
        assert_ne!(paired.account_id, paired.connector_id);
        assert_eq!(paired.account_id, "11111111-1111-4111-8111-111111111111");
    }

    /// Computer rename is the connector's own PATCH, and the stored name comes from
    /// the account's reply, not from what was sent.
    #[tokio::test]
    async fn rename_self_patches_the_connector_and_returns_the_stored_name() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mock = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            while !String::from_utf8_lossy(&request).contains("}") {
                let n = socket.read(&mut buffer).await.unwrap();
                request.extend_from_slice(&buffer[..n]);
            }
            let body = r#"{"connector":{"id":"c","name":"Studio iMac"}}"#;
            let reply = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&request).to_string()
        });
        let cloud = Cloud {
            http: reqwest::Client::new(),
            server: format!("http://{address}"),
            clock_skew: std::sync::atomic::AtomicBool::new(false),
            token: Zeroizing::new("synthetic-token".into()),
        };
        assert_eq!(
            cloud.rename_self(" Studio iMac ").await.unwrap(),
            "Studio iMac"
        );
        let request = mock.await.unwrap();
        assert!(
            request.starts_with("PATCH /v1/connectors/self "),
            "{request}"
        );
        assert!(request.contains(r#"{"name":" Studio iMac "}"#), "{request}");
    }

    #[test]
    fn domain_hash_prefixes_the_tag_length() {
        use sha2::{Digest, Sha256};
        let mut d = Sha256::new();
        d.update([22u8]);
        d.update(b"mdbase/v1/relay-device");
        d.update(b"x");
        let want: [u8; 32] = d.finalize().into();
        assert_eq!(
            secrets::domain_hash("mdbase/v1/relay-device", &[b"x"]),
            want
        );
    }
}
