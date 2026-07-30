use super::*;

impl MirrorManager {
    pub(super) async fn public_json<T: serde::de::DeserializeOwned>(
        &self,
        method: Method,
        url: &str,
        body: Option<Value>,
        bearer: Option<&str>,
    ) -> Result<T, ConnectError> {
        let mut request = self.client.request(method, url);
        if let Some(body) = body {
            request = request.json(&body);
        }
        if let Some(bearer) = bearer {
            request = request.bearer_auth(bearer);
        }
        let response = request
            .send()
            .await
            .map_err(|error| ConnectError::Cloud(error.to_string()))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| ConnectError::Cloud(error.to_string()))?;
        if !status.is_success() {
            let message = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|value| {
                    value
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| format!("Connect request failed with HTTP {status}."));
            return Err(ConnectError::Cloud(message));
        }
        serde_json::from_slice(&bytes).map_err(ConnectError::from)
    }

    pub(super) async fn wait_for_prepared_transfer(
        &self,
        entry: &MirrorRegistryEntry,
        checkpoint: &MirrorPromotionCheckpoint,
        refresh_token: &str,
    ) -> Result<AuthorityTransfer, ConnectError> {
        let deadline = parse_deadline(&checkpoint.expires_at)?;
        loop {
            if chrono::Utc::now() >= deadline {
                return Err(mirror_error(
                    "authority_transfer_expired",
                    "Authority transfer approval expired.",
                ));
            }
            let response = self
                .client
                .post(format!(
                    "{}/v1/authority-transfers/{}/prepare",
                    entry.control_url, checkpoint.transfer_id
                ))
                .bearer_auth(refresh_token)
                .json(&serde_json::json!({}))
                .send()
                .await
                .map_err(|error| ConnectError::Cloud(error.to_string()))?;
            if response.status().as_u16() == 202 {
                tokio::time::sleep(Duration::from_millis(1_500)).await;
                continue;
            }
            let value = checked_json::<AuthorityTransferResponse>(response).await?;
            validate_transfer(&value.transfer, entry, Some(checkpoint.transfer_id))?;
            if value.transfer.state != "prepared"
                || value.transfer.final_head.is_none()
                || value.transfer.authority_epoch.is_none()
                || value.transfer.manifest_digest.is_none()
            {
                return Err(mirror_error(
                    "invalid_authority_transfer",
                    "Authority returned an incomplete prepared transfer.",
                ));
            }
            return Ok(value.transfer);
        }
    }

    pub(super) async fn wait_for_completed_transfer(
        &self,
        entry: &MirrorRegistryEntry,
        checkpoint: &MirrorPromotionCheckpoint,
        refresh_token: &str,
    ) -> Result<AuthorityTransferCompletion, ConnectError> {
        let deadline = parse_deadline(&checkpoint.expires_at)?;
        loop {
            let response = self
                .client
                .post(format!(
                    "{}/v1/authority-transfers/{}/complete",
                    entry.control_url, checkpoint.transfer_id
                ))
                .bearer_auth(refresh_token)
                .json(&serde_json::json!({
                    "manifest_digest": checkpoint.manifest_digest
                }))
                .send()
                .await
                .map_err(|error| ConnectError::Cloud(error.to_string()))?;
            if response.status().as_u16() == 202 {
                if chrono::Utc::now() >= deadline {
                    return Err(mirror_error(
                        "authority_transfer_expired",
                        "Authority transfer expired before activation completed.",
                    ));
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
            return checked_json(response).await;
        }
    }

    pub(super) async fn cancel_promotion(
        &self,
        entry: &MirrorRegistryEntry,
        transfer_id: Uuid,
        refresh_token: &str,
    ) -> Result<(), ConnectError> {
        let response = self
            .client
            .delete(format!(
                "{}/v1/authority-transfers/{transfer_id}",
                entry.control_url
            ))
            .bearer_auth(refresh_token)
            .send()
            .await
            .map_err(|error| ConnectError::Cloud(error.to_string()))?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(mirror_error(
                "authority_transfer_cancel_failed",
                "Authority transfer could not be cancelled.",
            ))
        }
    }
}
