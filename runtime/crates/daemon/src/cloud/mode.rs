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

    /// A loopback control plane: serves one challenge, then captures the proven
    /// request's request line and JSON body (answering 409).
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
}
