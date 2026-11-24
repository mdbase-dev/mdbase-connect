//! Collection mode changes: status, intent, cancel and the signed native prepare/finish.

use super::*;

impl Cloud {
    pub(crate) async fn collection_mode_status(
        &self,
        collection: &str,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<Value, CloudError> {
        self.send_current(
            self.http
                .get(format!(
                    "{}/v1/next/collections/{collection}/mode",
                    self.server
                ))
                .bearer_auth(self.token.as_str()),
            current,
        )
        .await
    }
    pub(crate) async fn collection_mode_intent(
        &self,
        collection: &str,
        request: &str,
        private: bool,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<Value, CloudError> {
        self.post_current(
            &format!("/v1/next/collections/{collection}/mode"),
            &json!({"request_id":request,"target_mode":if private {"private"} else {"cloud_copy"}}),
            current,
        )
        .await
    }

    pub(crate) async fn collection_mode_request_status(
        &self,
        collection: &str,
        request: &str,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<Value, CloudError> {
        self.send_current(
            self.http
                .get(format!(
                    "{}/v1/next/collections/{collection}/mode/{request}",
                    self.server
                ))
                .bearer_auth(self.token.as_str()),
            current,
        )
        .await
    }
    pub(crate) async fn collection_mode_cancel(
        &self,
        collection: &str,
        request: &str,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<Value, CloudError> {
        self.send_current(
            self.http
                .delete(format!(
                    "{}/v1/next/collections/{collection}/mode/{request}",
                    self.server
                ))
                .bearer_auth(self.token.as_str()),
            current,
        )
        .await
    }

    /// Native mode prepare/finish. Fields are derived from the live replica, not
    /// forwarded from a web caller. This proof is independent of create/join.
    pub(crate) async fn collection_mode_post(
        &self,
        connector_id: &str,
        collection: &[u8; 16],
        mode: &proof::ModeProof,
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<Value, CloudError> {
        current().map_err(CloudError::Local)?;
        let challenge = self.challenge(current).await?;
        current().map_err(CloudError::Local)?;
        let connector = crate::attest::uuid_bytes(connector_id)
            .ok_or_else(|| CloudError::Local("connector UUID".into()))?;
        let digest = proof::collection_mode_digest(
            &challenge,
            &B16(connector),
            &B16(identity.device_id),
            &B16(*collection),
            mode,
        );
        let mut body = json!({ "device_id": identity.public().device, "challenge": secrets::hex(&challenge),
            "sig": secrets::hex(&identity.sign_digest(&digest.0)), "epoch": mode.epoch.to_string() });
        body["seq"] = json!(mode.seq.to_string());
        body["chain"] = json!(secrets::hex(&mode.chain.0));
        body["members"] = json!(
            mode.members
                .iter()
                .map(|id| id.to_uuid_string())
                .collect::<Vec<_>>()
        );
        let path = format!(
            "/v1/next/collections/{}/mode/{}/{}",
            B16(*collection).to_uuid_string(),
            mode.request.to_uuid_string(),
            if mode.finish { "finish" } else { "prepare" }
        );
        current().map_err(CloudError::Local)?;
        let request = self
            .http
            .post(format!("{}{path}", self.server))
            .bearer_auth(self.token.as_str())
            .json(&body);
        let (status, bytes) = self.send_current_raw_status(request, current, None).await?;
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| CloudError::Server(status, "malformed".into()))?;
        if status == 409
            && mode.private
            && !mode.finish
            && value.pointer("/error/code").and_then(Value::as_str)
                == Some("mode_devices_need_update")
        {
            let devices = mode_missing_devices(&value, &mode.members)
                .ok_or_else(|| CloudError::Server(status, "malformed".into()))?;
            current().map_err(CloudError::Local)?;
            return Ok(
                json!({"collection_id": B16(*collection).to_uuid_string(), "request_id": mode.request.to_uuid_string(), "target_mode":"private", "phase":"waiting_for_devices", "devices":devices.iter().map(secrets::uuid_string).collect::<Vec<_>>()}),
            );
        }
        if status >= 400 {
            let code = value
                .pointer("/error/code")
                .and_then(Value::as_str)
                .filter(|s| {
                    s.len() <= 64
                        && s.bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
                })
                .unwrap_or("error");
            return Err(CloudError::Server(status, code.into()));
        }
        current().map_err(CloudError::Local)?;
        Ok(value)
    }
}

fn mode_missing_devices(value: &Value, members: &[B16]) -> Option<Vec<[u8; 16]>> {
    let ids = value.get("devices")?.as_array()?;
    if ids.is_empty() || ids.len() > members.len() {
        return None;
    }
    let ids = ids
        .iter()
        .map(|id| {
            id.as_str()
                .and_then(crate::attest::uuid_bytes)
                .filter(|id| members.iter().any(|member| member.0 == *id))
        })
        .collect::<Option<Vec<_>>>()?;
    (ids.iter().collect::<std::collections::BTreeSet<_>>().len() == ids.len()).then_some(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn mode_refusal_devices_are_bounded_by_the_signed_native_preflight() {
        let member = B16([1; 16]);
        let id = member.to_uuid_string();
        assert_eq!(
            mode_missing_devices(&json!({"devices":[id.clone()]}), &[member]),
            Some(vec![member.0])
        );
        for value in [
            json!({"devices":[]}),
            json!({"devices":["invalid"]}),
            json!({"devices":[B16([2;16]).to_uuid_string()]}),
            json!({"devices":[id.clone(),id]}),
            json!({"devices":"invalid"}),
        ] {
            assert!(mode_missing_devices(&value, &[member]).is_none());
        }
    }

    #[tokio::test]
    async fn mode_post_maps_http_429_to_rate_limited_and_preserves_409_codes() {
        let id = DeviceIdentity::generate().unwrap();
        let proof = proof::ModeProof {
            request: B16([4; 16]),
            private: true,
            finish: false,
            epoch: 1,
            seq: 2,
            chain: mdbn_wire::common::B32([5; 32]),
            members: vec![B16(id.device_id)],
        };
        for (status, extra_header, body, expected) in [
            (
                "429 Too Many Requests",
                "Retry-After: 12\r\n",
                r#"{"error":{"code":"rate_limited"}}"#,
                CloudError::RateLimited(Some(12)),
            ),
            (
                "429 Too Many Requests",
                "",
                r#"{"error":{"code":"rate_limited"}}"#,
                CloudError::RateLimited(None),
            ),
            (
                "409 Conflict",
                "",
                r#"{"error":{"code":"mode_source_changed"}}"#,
                CloudError::Server(409, "mode_source_changed".into()),
            ),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let mock = tokio::spawn(async move {
                for step in 0..2 {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut buf = [0; 4096];
                    let _ = socket.read(&mut buf).await.unwrap();
                    let reply = if step == 0 {
                        let challenge = json!({"challenge": secrets::hex(&[7; 32])}).to_string();
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{challenge}",
                            challenge.len()
                        )
                    } else {
                        format!(
                            "HTTP/1.1 {status}\r\n{extra_header}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                    };
                    socket.write_all(reply.as_bytes()).await.unwrap();
                }
            });
            let cloud = Cloud {
                http: reqwest::Client::new(),
                server: format!("http://{address}"),
                clock_skew: std::sync::atomic::AtomicBool::new(false),
                token: Zeroizing::new("synthetic-token".into()),
            };
            let error = cloud
                .collection_mode_post(
                    "11111111-1111-4111-8111-111111111111",
                    &[9; 16],
                    &proof,
                    &id,
                    &|| Ok(()),
                )
                .await
                .unwrap_err();
            assert_eq!(error, expected);
            mock.await.unwrap();
        }
    }
}
