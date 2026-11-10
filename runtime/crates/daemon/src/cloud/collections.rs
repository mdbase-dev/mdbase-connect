//! Synced-collection bootstrap: log tokens, cloud copy and private create, join and enrol.

use super::*;

impl Cloud {
    /// Renew this device's role-0 log token for a synced collection (Connect
    /// `POST /v1/next/collections/:id/log-token`). The proof is
    /// `H("mdbase/v1/collection-log-token", cbor[challenge, connector, device,
    /// collection])` over a fresh challenge. Returns the token and its expiry (ms).
    pub async fn collection_log_token(
        &self,
        connector_id: &str,
        collection: &[u8; 16],
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<(Zeroizing<String>, i64), CloudError> {
        let challenge = self.challenge(current).await?;
        current().map_err(CloudError::Local)?;
        let connector = crate::attest::uuid_bytes(connector_id)
            .ok_or_else(|| CloudError::Local("uuid".into()))?;
        let digest = proof::collection_log_token_digest(
            &challenge,
            &B16(connector),
            &B16(identity.device_id),
            &B16(*collection),
        );
        let sig = identity.sign_digest(&digest.0);
        let collection_id = mdbn_wire::common::B16(*collection).to_uuid_string();
        let r = self
            .post_current(
                &format!("/v1/next/collections/{collection_id}/log-token"),
                &json!({
                    "device_id": identity.public().device,
                    "capabilities": crate::relay::CAPABILITIES,
                    "challenge": secrets::hex(&challenge),
                    "sig": secrets::hex(&sig),
                }),
                current,
            )
            .await?;
        current().map_err(CloudError::Local)?;
        let token = r
            .get("token")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty() && t.len() <= 16 * 1024)
            .ok_or_else(|| CloudError::Server(200, "malformed".into()))?;
        let expires_at = r
            .get("expires_at")
            .and_then(Value::as_i64)
            .ok_or_else(|| CloudError::Server(200, "malformed".into()))?;
        Ok((Zeroizing::new(token.to_string()), expires_at))
    }

    /// One proof-of-possession next-bootstrap request: a fresh challenge, the
    /// caller's authority rechecked after it, then the device signs the shared
    /// [`proof::collection_proof_digest`] of `kind`.
    #[allow(clippy::too_many_arguments)]
    async fn proven_post(
        &self,
        path: &str,
        kind: proof::CollectionProof,
        connector_id: &str,
        collection: &[u8; 16],
        sas_commit: Option<&[u8; 32]>,
        mut body: serde_json::Map<String, Value>,
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<Value, CloudError> {
        current().map_err(CloudError::Local)?;
        let challenge = self.challenge(current).await?;
        current().map_err(CloudError::Local)?;
        let connector = crate::attest::uuid_bytes(connector_id)
            .ok_or_else(|| CloudError::Local("uuid".into()))?;
        let digest = proof::collection_proof_digest(
            kind,
            &challenge,
            &B16(connector),
            &B16(identity.device_id),
            &B16(*collection),
            sas_commit,
        )
        .ok_or_else(|| CloudError::Local("proof shape".into()))?;
        let sig = identity.sign_digest(&digest.0);
        body.insert("device_id".into(), json!(identity.public().device));
        body.insert("capabilities".into(), json!(crate::relay::CAPABILITIES));
        body.insert("challenge".into(), json!(secrets::hex(&challenge)));
        body.insert("sig".into(), json!(secrets::hex(&sig)));
        if let Some(c) = sas_commit {
            body.insert("sas_commit".into(), json!(secrets::hex(c)));
        }
        current().map_err(CloudError::Local)?;
        let answer = self.post_current(path, &Value::Object(body), current).await;
        // A stale result is never publication authority, including a refusal.
        // This does not claim the old request was not sent or not committed.
        current().map_err(CloudError::Local)?;
        answer
    }

    /// Create a **cloud copy** owned by this account, from this registered device
    /// (Connect #616, `POST /v1/next/collections/cloud-copy`).
    pub async fn create_cloud_copy(
        &self,
        connector_id: &str,
        collection: &[u8; 16],
        display_name: &str,
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<Created, CloudError> {
        let mut body = serde_json::Map::new();
        body.insert(
            "collection_id".into(),
            json!(mdbn_wire::common::B16(*collection).to_uuid_string()),
        );
        body.insert("display_name".into(), json!(display_name));
        let v = self
            .proven_post(
                "/v1/next/collections/cloud-copy",
                proof::CollectionProof::CloudCopyCreate,
                connector_id,
                collection,
                None,
                body,
                identity,
                current,
            )
            .await?;
        Created::parse(&v, "cloud-copy")
    }

    /// Create a **private** (end-to-end) collection from this registered device
    /// (Connect #621, `POST /v1/next/collections/private`).
    pub async fn create_private(
        &self,
        connector_id: &str,
        collection: &[u8; 16],
        display_name: &str,
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<Created, CloudError> {
        let mut body = serde_json::Map::new();
        body.insert(
            "collection_id".into(),
            json!(mdbn_wire::common::B16(*collection).to_uuid_string()),
        );
        body.insert("display_name".into(), json!(display_name));
        let v = self
            .proven_post(
                "/v1/next/collections/private",
                proof::CollectionProof::PrivateCreate,
                connector_id,
                collection,
                None,
                body,
                identity,
                current,
            )
            .await?;
        Created::parse(&v, "private")
    }

    /// Join this account's cloud copy from this registered device (Connect #616,
    /// `POST /v1/next/collections/:id/devices`). Hosted (or escrow) then wraps the
    /// current epoch key to it.
    pub async fn join_cloud_copy(
        &self,
        connector_id: &str,
        collection: &[u8; 16],
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<Joined, CloudError> {
        let id = mdbn_wire::common::B16(*collection).to_uuid_string();
        let v = self
            .proven_post(
                &format!("/v1/next/collections/{id}/devices"),
                proof::CollectionProof::CloudCopyJoin,
                connector_id,
                collection,
                None,
                serde_json::Map::new(),
                identity,
                current,
            )
            .await?;
        Joined::parse(&v)
    }

    /// Enrol this device in a private collection with its SAS commitment (Connect
    /// #621, `POST /v1/next/collections/:id/private/devices`). An owner device then
    /// approves it (`device.approve`).
    pub async fn enrol_private(
        &self,
        connector_id: &str,
        collection: &[u8; 16],
        sas_commit: &[u8; 32],
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<Joined, CloudError> {
        let id = mdbn_wire::common::B16(*collection).to_uuid_string();
        let v = self
            .proven_post(
                &format!("/v1/next/collections/{id}/private/devices"),
                proof::CollectionProof::PrivateDeviceEnrol,
                connector_id,
                collection,
                Some(sas_commit),
                serde_json::Map::new(),
                identity,
                current,
            )
            .await?;
        Joined::parse(&v)
    }

    /// Log a fresh SAS commitment for an enrolled private device (Connect #624,
    /// `POST /v1/next/collections/:id/private/devices/approval-request`).
    pub async fn request_private_approval(
        &self,
        connector_id: &str,
        collection: &[u8; 16],
        sas_commit: &[u8; 32],
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<u64, CloudError> {
        let id = mdbn_wire::common::B16(*collection).to_uuid_string();
        let v = self
            .proven_post(
                &format!("/v1/next/collections/{id}/private/devices/approval-request"),
                proof::CollectionProof::PrivateApprovalRequest,
                connector_id,
                collection,
                Some(sas_commit),
                serde_json::Map::new(),
                identity,
                current,
            )
            .await?;
        v.get("requested_at")
            .and_then(Value::as_u64)
            .ok_or_else(|| CloudError::Server(200, "malformed".into()))
    }

    /// The name of another of this account's computers by its device ID
    /// (`GET /v1/next/devices/:id/name`), shown when it asks to open a private
    /// collection here. `None` when the server does not know it as ours.
    pub async fn computer_name(
        &self,
        device: &[u8; 16],
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<Option<String>, CloudError> {
        let request = self
            .http
            .get(format!(
                "{}/v1/next/devices/{}/name",
                self.server,
                secrets::uuid_string(device)
            ))
            .bearer_auth(self.token.as_str());
        match self.send_current(request, current).await {
            Ok(v) => Ok(v
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .map(|n| n.chars().take(80).collect())),
            Err(CloudError::Server(404, _)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Permanently delete a synced collection using this owner-device credential.
    /// The server checks enrollment and the current shared name. Never retries.
    pub async fn delete_collection(
        &self,
        collection: &str,
        confirm_name: &str,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<(), CloudError> {
        let request = self
            .http
            .delete(format!("{}/v1/next/collections/{collection}", self.server))
            .bearer_auth(self.token.as_str())
            .json(&json!({ "confirm_name": confirm_name }));
        let value = self.send_current(request, current).await?;
        if value.get("collection_id").and_then(Value::as_str) != Some(collection)
            || value.get("deleted").and_then(Value::as_bool) != Some(true)
        {
            return Err(CloudError::Server(200, "malformed".into()));
        }
        Ok(())
    }
}

/// A created next collection (cloud copy or private): where its log is and the
/// genesis the control plane appended, plus this device's role-0 log token.
/// The genesis bytes are checked against the trusted pins before any use.
pub struct Created {
    /// Collection.
    pub collection_id: String,
    /// `cloud-copy` or `private`.
    pub state: String,
    /// The log origin the control plane named (must equal the trusted origin).
    pub log_url: String,
    /// The appended genesis item (position 1).
    pub genesis_item: Vec<u8>,
    /// This device's log token.
    pub token: Zeroizing<String>,
    /// Its expiry (ms).
    pub expires_at: i64,
}

impl std::fmt::Debug for Created {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Created")
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}

impl Created {
    fn parse(v: &Value, state: &str) -> Result<Created, CloudError> {
        let bad = || CloudError::Server(200, "malformed".into());
        let s = |k: &str| v.get(k).and_then(Value::as_str).ok_or_else(bad);
        if s("state")? != state {
            return Err(bad());
        }
        let genesis = v.get("genesis").ok_or_else(bad)?;
        if genesis.get("seq").and_then(Value::as_u64) != Some(1) {
            return Err(bad());
        }
        let item = genesis
            .get("item")
            .and_then(Value::as_str)
            .filter(|h| h.len() <= 128 * 1024)
            .and_then(|h| secrets::hex_decode(h).ok())
            .filter(|b| !b.is_empty() && b.len() <= 64 * 1024)
            .ok_or_else(bad)?;
        let joined = Joined::parse(v)?;
        Ok(Created {
            collection_id: s("collection_id")?.to_string(),
            state: state.to_string(),
            log_url: s("log_url")?.to_string(),
            genesis_item: item.to_vec(),
            token: joined.token,
            expires_at: joined.expires_at,
        })
    }
}

/// An enrolment's answer: this device's role-0 log token, and (Connect with
/// mdbase-connect#630) the collection's log URL and candidate genesis bytes.
pub struct Joined {
    /// Token.
    pub token: Zeroizing<String>,
    /// Expiry (ms).
    pub expires_at: i64,
    /// The log origin the control plane named.
    pub log_url: Option<String>,
    /// Candidate genesis bytes (seq 1), verified by the caller before use.
    pub genesis_item: Option<Vec<u8>>,
    /// The collection's name in the account, if the control plane sent one.
    pub display_name: Option<String>,
}

impl std::fmt::Debug for Joined {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Joined").finish_non_exhaustive()
    }
}

impl Joined {
    /// Parse a JOIN / PRIVATE ENROL answer (Connect `cloud-copy-bootstrap`,
    /// `private-bootstrap`): `device.token`/`expires_at`, optional `log_url` and
    /// `genesis {seq: 1, item: hex}`; the caller verifies the genesis bytes.
    pub(crate) fn parse(v: &Value) -> Result<Joined, CloudError> {
        let bad = || CloudError::Server(200, "malformed".into());
        let genesis_item = match v.get("genesis") {
            None => None,
            Some(g) => {
                if g.get("seq").and_then(Value::as_u64) != Some(1) {
                    return Err(bad());
                }
                Some(
                    g.get("item")
                        .and_then(Value::as_str)
                        .filter(|h| h.len() <= 128 * 1024)
                        .and_then(|h| secrets::hex_decode(h).ok())
                        .filter(|b| !b.is_empty() && b.len() <= 64 * 1024)
                        .ok_or_else(bad)?
                        .to_vec(),
                )
            }
        };
        let log_url = v.get("log_url").and_then(Value::as_str).map(str::to_string);
        let display_name = v
            .get("display_name")
            .and_then(Value::as_str)
            .map(str::to_string);
        let d = v.get("device").ok_or_else(bad)?;
        let token = d
            .get("token")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty() && t.len() <= 16 * 1024)
            .ok_or_else(bad)?;
        let expires_at = d
            .get("expires_at")
            .and_then(Value::as_i64)
            .ok_or_else(bad)?;
        Ok(Joined {
            token: Zeroizing::new(token.to_string()),
            expires_at,
            log_url,
            genesis_item,
            display_name,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_join_answer_carries_the_account_name() {
        let answer = |name: Value| {
            json!({
                "collection_id": "c",
                "enrolled_at": 2,
                "display_name": name,
                "device": { "token": "t", "expires_at": 1 },
            })
        };
        let named = Joined::parse(&answer(json!("Work notes"))).unwrap();
        assert_eq!(named.display_name.as_deref(), Some("Work notes"));
        assert_eq!(
            Joined::parse(&answer(Value::Null)).unwrap().display_name,
            None
        );
    }

    #[test]
    fn bootstrap_debug_never_exposes_tokens_or_genesis() {
        let joined = Joined {
            token: Zeroizing::new("synthetic-token-sentinel".into()),
            expires_at: 0,
            log_url: Some("synthetic-origin-sentinel".into()),
            genesis_item: Some(b"synthetic-genesis-sentinel".to_vec()),
            display_name: None,
        };
        let created = Created {
            collection_id: "synthetic-id-sentinel".into(),
            state: "cloud-copy".into(),
            log_url: "synthetic-origin-sentinel".into(),
            genesis_item: b"synthetic-genesis-sentinel".to_vec(),
            token: Zeroizing::new("synthetic-token-sentinel".into()),
            expires_at: 0,
        };
        let text = format!("{joined:?} {created:?}");
        for secret in [
            "synthetic-token-sentinel",
            "synthetic-genesis-sentinel",
            "synthetic-origin-sentinel",
            "synthetic-id-sentinel",
        ] {
            assert!(!text.contains(secret));
        }
    }

    #[tokio::test]
    async fn bootstrap_stale_source_denies_before_challenge_io() {
        let cloud = Cloud {
            http: reqwest::Client::new(),
            server: "http://127.0.0.1:1".into(),
            clock_skew: std::sync::atomic::AtomicBool::new(false),
            token: Zeroizing::new("synthetic-token".into()),
        };
        let id = DeviceIdentity::generate().unwrap();
        let error = cloud
            .create_cloud_copy(
                "11111111-1111-4111-8111-111111111111",
                &[1; 16],
                "[test] Notes",
                &id,
                &|| Err("account_changed".into()),
            )
            .await
            .unwrap_err();
        assert!(matches!(error, CloudError::Local(ref reason) if reason == "account_changed"));
    }

    #[tokio::test]
    async fn bootstrap_account_change_after_challenge_denies_proof_post() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let active = Arc::new(AtomicBool::new(true));
        let changed = active.clone();
        let mock = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            let _ = socket.read(&mut buffer).await.unwrap();
            let body = serde_json::to_string(&json!({"challenge": secrets::hex(&[1;32])})).unwrap();
            changed.store(false, Ordering::SeqCst);
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
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(100), listener.accept())
                    .await
                    .is_err()
            );
        });
        let cloud = Cloud {
            http: reqwest::Client::new(),
            server: format!("http://{address}"),
            clock_skew: std::sync::atomic::AtomicBool::new(false),
            token: Zeroizing::new("synthetic-token".into()),
        };
        let id = DeviceIdentity::generate().unwrap();
        let current = || {
            if active.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err("account_changed".into())
            }
        };
        let error = cloud
            .create_cloud_copy(
                "11111111-1111-4111-8111-111111111111",
                &[1; 16],
                "[test] Notes",
                &id,
                &current,
            )
            .await
            .unwrap_err();
        assert!(matches!(error, CloudError::Local(ref reason) if reason == "account_changed"));
        mock.await.unwrap();
    }

    #[tokio::test]
    async fn bootstrap_changed_account_cannot_accept_a_sent_result() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let active = Arc::new(AtomicBool::new(true));
        let changed = active.clone();
        let mock = tokio::spawn(async move {
            for attempt in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 4096];
                let _ = socket.read(&mut buffer).await.unwrap();
                let body = if attempt == 0 {
                    serde_json::to_string(&json!({"challenge": secrets::hex(&[1;32])})).unwrap()
                } else {
                    changed.store(false, Ordering::SeqCst);
                    "{}".into()
                };
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
        });
        let cloud = Cloud {
            http: reqwest::Client::new(),
            server: format!("http://{address}"),
            clock_skew: std::sync::atomic::AtomicBool::new(false),
            token: Zeroizing::new("synthetic-token".into()),
        };
        let id = DeviceIdentity::generate().unwrap();
        let current = || {
            if active.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err("account_changed".into())
            }
        };
        let error = cloud
            .create_cloud_copy(
                "11111111-1111-4111-8111-111111111111",
                &[1; 16],
                "[test] Notes",
                &id,
                &current,
            )
            .await
            .unwrap_err();
        assert!(matches!(error, CloudError::Local(ref reason) if reason == "account_changed"));
        // Both requests reached the mock: denial is NOT not-sent evidence.
        mock.await.unwrap();
    }

    /// Every bootstrap call signs the shared proof digest of its own kind over the
    /// served challenge, this connector, device and collection (and the SAS
    /// commitment where the kind carries one), and sends exactly that.
    #[tokio::test]
    async fn bootstrap_calls_sign_the_shared_proof_digests() {
        use ed25519_dalek::Verifier;
        use proof::CollectionProof as K;
        const CONNECTOR: &str = "11111111-1111-4111-8111-111111111111";
        let collection = [9u8; 16];
        let sas = [5u8; 32];
        let id = DeviceIdentity::generate().unwrap();
        let ok = || Ok(());
        let collection_id = B16(collection).to_uuid_string();
        let cases: Vec<(K, String, Option<[u8; 32]>)> = vec![
            (
                K::CloudCopyCreate,
                "POST /v1/next/collections/cloud-copy ".into(),
                None,
            ),
            (
                K::PrivateCreate,
                "POST /v1/next/collections/private ".into(),
                None,
            ),
            (
                K::CloudCopyJoin,
                format!("POST /v1/next/collections/{collection_id}/devices "),
                None,
            ),
            (
                K::PrivateDeviceEnrol,
                format!("POST /v1/next/collections/{collection_id}/private/devices "),
                Some(sas),
            ),
            (
                K::PrivateApprovalRequest,
                format!(
                    "POST /v1/next/collections/{collection_id}/private/devices/approval-request "
                ),
                Some(sas),
            ),
        ];
        for (kind, path, commit) in cases {
            let (line, body) = capture_proven(
                |cloud, id| {
                    Box::pin(async move {
                        let c = &collection;
                        match kind {
                            K::CloudCopyCreate => cloud
                                .create_cloud_copy(
                                    CONNECTOR,
                                    c,
                                    "[test] migrated Legacy name / Δ",
                                    id,
                                    &ok,
                                )
                                .await
                                .map(drop),
                            K::PrivateCreate => cloud
                                .create_private(
                                    CONNECTOR,
                                    c,
                                    "[test] migrated Legacy name / Δ",
                                    id,
                                    &ok,
                                )
                                .await
                                .map(drop),
                            K::CloudCopyJoin => {
                                cloud.join_cloud_copy(CONNECTOR, c, id, &ok).await.map(drop)
                            }
                            K::PrivateDeviceEnrol => cloud
                                .enrol_private(CONNECTOR, c, &sas, id, &ok)
                                .await
                                .map(drop),
                            K::PrivateApprovalRequest => cloud
                                .request_private_approval(CONNECTOR, c, &sas, id, &ok)
                                .await
                                .map(drop),
                        }
                    })
                },
                &id,
            )
            .await;
            assert!(line.starts_with(&path), "{kind:?}: {line}");
            if matches!(kind, K::PrivateCreate | K::CloudCopyCreate) {
                assert_eq!(body["display_name"], "[test] migrated Legacy name / Δ");
            }
            assert_eq!(body["challenge"], secrets::hex(&[7; 32]));
            assert_eq!(body["device_id"], id.public().device);
            assert_eq!(
                body.get("sas_commit").and_then(Value::as_str),
                commit.map(|c| secrets::hex(&c)).as_deref()
            );
            let digest = proof::collection_proof_digest(
                kind,
                &[7; 32],
                &B16(crate::attest::uuid_bytes(CONNECTOR).unwrap()),
                &B16(id.device_id),
                &B16(collection),
                commit.as_ref(),
            )
            .unwrap();
            let sig: [u8; 64] = secrets::hex_decode(body["sig"].as_str().unwrap())
                .unwrap()
                .try_into()
                .unwrap();
            let sign_pk: [u8; 32] = secrets::hex_decode(&id.public().sign_pk)
                .unwrap()
                .try_into()
                .unwrap();
            let pk = ed25519_dalek::VerifyingKey::from_bytes(&sign_pk).unwrap();
            assert!(
                pk.verify(&digest.0, &ed25519_dalek::Signature::from_bytes(&sig))
                    .is_ok(),
                "{kind:?}"
            );
        }
        // The role-0 log token renewal signs the shared log-token digest.
        let (line, body) = capture_proven(
            |cloud, id| {
                Box::pin(async move {
                    cloud
                        .collection_log_token(CONNECTOR, &collection, id, &ok)
                        .await
                        .map(drop)
                })
            },
            &id,
        )
        .await;
        assert!(line.starts_with(&format!(
            "POST /v1/next/collections/{collection_id}/log-token "
        )));
        let digest = proof::collection_log_token_digest(
            &[7; 32],
            &B16(crate::attest::uuid_bytes(CONNECTOR).unwrap()),
            &B16(id.device_id),
            &B16(collection),
        );
        let sig: [u8; 64] = secrets::hex_decode(body["sig"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        assert_eq!(sig, id.sign_digest(&digest.0), "deterministic Ed25519");
    }
}
