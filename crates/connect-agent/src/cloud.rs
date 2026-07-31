use mdbase_connect_core::ConnectError;
use mdbase_connect_protocol::{
    AccessSnapshot, ApplicationSummary, AuthorityImportManifest, AuthorityImportRecordPage,
    AuthoritySnapshot, AuthorizationApproveParams, AuthorizationIdParams, ComputerNameParams,
    GrantCreateParams, GrantIdParams, GrantUpdateParams, CONTROL_PROTOCOL_VERSION,
};
use reqwest::{Client, Method, Response};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

#[derive(Clone)]
pub struct CloudControlClient {
    client: Client,
    server_url: String,
    connector_token: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RemoteAuthorityTransfer {
    pub id: uuid::Uuid,
    pub collection_id: uuid::Uuid,
    pub state: String,
    pub authority_epoch: u64,
    pub final_head: Option<u64>,
    pub manifest_digest: Option<String>,
    pub source_revision: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AuthorityImportCapability {
    pub manifest_url: String,
    pub records_url: String,
    pub finalize_url: String,
    pub access_token: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BeginRemoteAuthorityTransfer {
    pub transfer: RemoteAuthorityTransfer,
    pub import: Option<AuthorityImportCapability>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CompleteRemoteAuthorityTransfer {
    pub status: String,
    pub collection_id: uuid::Uuid,
    pub authority_epoch: u64,
}

impl CloudControlClient {
    pub fn new(server_url: String, connector_token: String) -> Self {
        Self {
            client: Client::new(),
            server_url: server_url.trim_end_matches('/').to_string(),
            connector_token,
        }
    }

    pub async fn snapshot(&self) -> Result<AccessSnapshot, ConnectError> {
        self.json(Method::GET, "/v1/connectors/control", None).await
    }

    pub fn server_url(&self) -> &str {
        &self.server_url
    }

    pub(crate) async fn connector_request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<T, ConnectError> {
        self.json(method, path, body).await
    }

    pub(crate) async fn revoke_hosted_replica(
        &self,
        replica_id: uuid::Uuid,
    ) -> Result<(), ConnectError> {
        let response = self
            .client
            .delete(format!(
                "{}/v1/connectors/hosted/replicas/{replica_id}",
                self.server_url
            ))
            .timeout(Duration::from_secs(15))
            .bearer_auth(&self.connector_token)
            .send()
            .await
            .map_err(cloud_error)?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(cloud_error)?;
        if status.is_success() {
            return Ok(());
        }
        let body = serde_json::from_slice::<Value>(&bytes).ok();
        let code = body
            .as_ref()
            .and_then(|body| body.pointer("/error/code"))
            .and_then(Value::as_str);
        if status == reqwest::StatusCode::NOT_FOUND && code == Some("replica_not_found") {
            return Ok(());
        }
        let message = body
            .as_ref()
            .and_then(|body| body.pointer("/error/message"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("Cloud request failed with HTTP {status}"));
        Err(ConnectError::Cloud(message))
    }

    pub async fn rename_computer(
        &self,
        params: &ComputerNameParams,
    ) -> Result<Value, ConnectError> {
        self.json(
            Method::PATCH,
            "/v1/connectors/self",
            Some(serde_json::to_value(params)?),
        )
        .await
    }

    pub async fn take_collection_authority(
        &self,
        collection_id: uuid::Uuid,
    ) -> Result<Value, ConnectError> {
        self.json(
            Method::POST,
            &format!("/v1/connectors/authority-conflicts/{collection_id}/move"),
            None,
        )
        .await
    }

    pub async fn begin_remote_authority_transfer(
        &self,
        collection_id: uuid::Uuid,
    ) -> Result<BeginRemoteAuthorityTransfer, ConnectError> {
        self.json(
            Method::POST,
            &format!("/v1/connectors/collections/{collection_id}/authority-transfers"),
            Some(serde_json::json!({})),
        )
        .await
    }

    pub async fn upload_authority_snapshot(
        &self,
        capability: &AuthorityImportCapability,
        snapshot: &AuthoritySnapshot,
    ) -> Result<(), ConnectError> {
        let manifest = AuthorityImportManifest {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            collection_id: snapshot.collection_id,
            source_head: snapshot.source_head,
            source_revision: snapshot.source_revision.clone(),
            manifest_digest: snapshot.manifest_digest.clone(),
            resources: snapshot.resources.clone(),
            record_count: snapshot.records.len() as u64,
        };
        self.external_json(
            Method::PUT,
            &capability.manifest_url,
            &capability.access_token,
            Some(serde_json::to_value(manifest)?),
        )
        .await?;
        const PAGE_BYTES: usize = 8 * 1024 * 1024;
        let mut page_number = 0_u64;
        let mut page = Vec::new();
        let mut page_bytes = 0_usize;
        for record in &snapshot.records {
            let record_bytes = serde_json::to_vec(record)?.len();
            if !page.is_empty() && (page.len() == 200 || page_bytes + record_bytes > PAGE_BYTES) {
                self.upload_authority_page(capability, page_number, std::mem::take(&mut page))
                    .await?;
                page_number += 1;
                page_bytes = 0;
            }
            page.push(mdbase_connect_protocol::AuthorityImportRecord {
                record_id: record.record.record_id,
                path: record.record.path.clone(),
                document: record.document.clone(),
            });
            page_bytes += record_bytes;
        }
        if !page.is_empty() {
            self.upload_authority_page(capability, page_number, page)
                .await?;
        }
        self.external_json(
            Method::POST,
            &capability.finalize_url,
            &capability.access_token,
            None,
        )
        .await?;
        Ok(())
    }

    async fn upload_authority_page(
        &self,
        capability: &AuthorityImportCapability,
        page: u64,
        records: Vec<mdbase_connect_protocol::AuthorityImportRecord>,
    ) -> Result<(), ConnectError> {
        self.external_json(
            Method::PUT,
            &capability.records_url,
            &capability.access_token,
            Some(serde_json::to_value(AuthorityImportRecordPage {
                protocol_version: CONTROL_PROTOCOL_VERSION,
                page,
                records,
            })?),
        )
        .await
        .map(|_| ())
    }

    pub async fn complete_remote_authority_transfer(
        &self,
        transfer_id: uuid::Uuid,
        manifest_digest: &str,
        source_revision: &str,
        source_head: u64,
    ) -> Result<CompleteRemoteAuthorityTransfer, ConnectError> {
        self.json(
            Method::POST,
            &format!("/v1/connectors/authority-transfers/{transfer_id}/complete"),
            Some(serde_json::json!({
                "manifest_digest": manifest_digest,
                "source_revision": source_revision,
                "source_head": source_head,
            })),
        )
        .await
    }

    pub async fn cancel_remote_authority_transfer(
        &self,
        transfer_id: uuid::Uuid,
    ) -> Result<(), ConnectError> {
        let _: Value = self
            .json(
                Method::DELETE,
                &format!("/v1/connectors/authority-transfers/{transfer_id}"),
                None,
            )
            .await?;
        Ok(())
    }

    pub async fn application(
        &self,
        application_id: uuid::Uuid,
    ) -> Result<ApplicationSummary, ConnectError> {
        let value: Value = self
            .json(
                Method::GET,
                &format!("/v1/connectors/apps/{application_id}"),
                None,
            )
            .await?;
        serde_json::from_value(value["application"].clone()).map_err(ConnectError::from)
    }

    pub async fn create_grant(
        &self,
        params: &GrantCreateParams,
        contracts: &[mdbase_connect_protocol::CollectionContractDescriptor],
    ) -> Result<Value, ConnectError> {
        self.json(
            Method::POST,
            "/v1/connectors/grants",
            Some(serde_json::json!({
                "application_id": params.application_id,
                "collection_id": params.collection_id,
                "operations": params.operations,
                "contracts": contracts,
            })),
        )
        .await
    }

    pub async fn update_grant(&self, params: &GrantUpdateParams) -> Result<Value, ConnectError> {
        self.json(
            Method::PATCH,
            &format!("/v1/connectors/grants/{}", params.grant_id),
            Some(serde_json::json!({ "operations": params.operations })),
        )
        .await
    }

    pub async fn revoke_grant(&self, params: &GrantIdParams) -> Result<Value, ConnectError> {
        self.json(
            Method::DELETE,
            &format!("/v1/connectors/grants/{}", params.grant_id),
            None,
        )
        .await
    }

    pub async fn approve_authorization(
        &self,
        params: &AuthorizationApproveParams,
        contracts: &[mdbase_connect_protocol::CollectionContractDescriptor],
    ) -> Result<Value, ConnectError> {
        self.json(
            Method::POST,
            &format!(
                "/v1/connectors/authorization-requests/{}/approve",
                params.request_id
            ),
            Some(serde_json::json!({
                "collection_id": params.collection_id,
                "operations": params.operations,
                "contracts": contracts,
                "contract_setups": params.contract_setups,
            })),
        )
        .await
    }

    pub async fn deny_authorization(
        &self,
        params: &AuthorizationIdParams,
    ) -> Result<Value, ConnectError> {
        self.json(
            Method::POST,
            &format!(
                "/v1/connectors/authorization-requests/{}/deny",
                params.request_id
            ),
            None,
        )
        .await
    }

    pub async fn emit_notification_signal(
        &self,
        signal_id: &str,
        grant_id: uuid::Uuid,
        criterion_id: &str,
        cursor: &str,
    ) -> Result<Value, ConnectError> {
        self.json(
            Method::POST,
            "/v1/connectors/notification-signals",
            Some(serde_json::json!({
                "signal_id": signal_id,
                "grant_id": grant_id,
                "criterion_id": criterion_id,
                "cursor": cursor,
            })),
        )
        .await
    }

    async fn json<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<T, ConnectError> {
        let mut request = self
            .client
            .request(method, format!("{}{}", self.server_url, path))
            .timeout(Duration::from_secs(15))
            .bearer_auth(&self.connector_token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        decode(request.send().await.map_err(cloud_error)?).await
    }

    async fn external_json(
        &self,
        method: Method,
        url: &str,
        token: &str,
        body: Option<Value>,
    ) -> Result<Value, ConnectError> {
        let mut request = self
            .client
            .request(method, url)
            .timeout(Duration::from_secs(60))
            .bearer_auth(token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        decode(request.send().await.map_err(cloud_error)?).await
    }
}

async fn decode<T: DeserializeOwned>(response: Response) -> Result<T, ConnectError> {
    let status = response.status();
    let bytes = response.bytes().await.map_err(cloud_error)?;
    if !status.is_success() {
        let message = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|body| {
                body.pointer("/error/message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| format!("Cloud request failed with HTTP {status}"));
        return Err(ConnectError::Cloud(message));
    }
    serde_json::from_slice(&bytes).map_err(ConnectError::from)
}

fn cloud_error(error: reqwest::Error) -> ConnectError {
    ConnectError::Cloud(error.to_string())
}
