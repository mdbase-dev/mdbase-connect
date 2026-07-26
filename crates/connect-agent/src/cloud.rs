use mdbase_connect_core::ConnectError;
use mdbase_connect_protocol::{
    AccessSnapshot, ApplicationSummary, AuthorizationApproveParams, AuthorizationIdParams,
    ComputerNameParams, GrantCreateParams, GrantIdParams, GrantUpdateParams,
};
use reqwest::{Client, Method, Response};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::time::Duration;

#[derive(Clone)]
pub struct CloudControlClient {
    client: Client,
    server_url: String,
    connector_token: String,
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
        contracts: &[mdbase_connect_protocol::ContractRequirement],
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
        contracts: &[mdbase_connect_protocol::ContractRequirement],
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
