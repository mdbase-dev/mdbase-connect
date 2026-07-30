use super::*;

#[async_trait]
pub trait SyncTransport: Send + Sync {
    async fn open_session(&self) -> Result<SyncSession, MirrorError>;
    async fn snapshot(
        &self,
        snapshot_id: Uuid,
        page: Option<&str>,
    ) -> Result<SyncSnapshotPage, MirrorError>;
    async fn changes(&self, after: u64, limit: usize) -> Result<SyncChangesPage, MirrorError>;
    async fn mutate(&self, mutation: &SyncMutation) -> Result<SyncMutationReceipt, MirrorError>;
}

#[derive(Clone)]
pub struct HttpSyncTransport {
    client: Client,
    sync_url: String,
    replica_token: String,
}

impl HttpSyncTransport {
    pub fn new(sync_url: &str, replica_token: impl Into<String>) -> Result<Self, MirrorError> {
        let endpoint = Url::parse(sync_url).map_err(|_| {
            MirrorError::new(
                "invalid_sync_url",
                "Sync URL must be an absolute authority endpoint.",
            )
        })?;
        let loopback = matches!(endpoint.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
        let secure = endpoint.scheme() == "https" || (endpoint.scheme() == "http" && loopback);
        let segments = endpoint
            .path_segments()
            .map(|segments| segments.collect::<Vec<_>>())
            .unwrap_or_default();
        let valid_path = segments.len() == 5
            && segments[0] == "v1"
            && segments[1] == "authorities"
            && Uuid::parse_str(segments[2]).is_ok()
            && segments[3] == "sync"
            && segments[4].is_empty();
        let valid_path_without_slash = segments.len() == 4
            && segments[0] == "v1"
            && segments[1] == "authorities"
            && Uuid::parse_str(segments[2]).is_ok()
            && segments[3] == "sync";
        if endpoint.host_str().is_none()
            || !secure
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || !(valid_path || valid_path_without_slash)
        {
            return Err(MirrorError::new(
                "invalid_sync_url",
                "Sync URL must identify one HTTPS authority sync endpoint, except on loopback.",
            ));
        }
        Ok(Self {
            client: Client::new(),
            sync_url: endpoint.as_str().trim_end_matches('/').to_string(),
            replica_token: replica_token.into(),
        })
    }

    async fn request<T: serde::de::DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<T, MirrorError> {
        let mut request = self
            .client
            .request(method, format!("{}/{path}", self.sync_url))
            .bearer_auth(&self.replica_token);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(|error| {
            MirrorError::new(
                "mirror_offline",
                format!("Hosted authority is unavailable: {error}"),
            )
        })?;
        let status = response.status();
        let value = response.json::<Value>().await.map_err(|error| {
            MirrorError::new(
                "invalid_sync_response",
                format!("Hosted authority returned invalid JSON: {error}"),
            )
        })?;
        if !status.is_success() {
            return Err(MirrorError::new(
                value
                    .pointer("/error/code")
                    .and_then(Value::as_str)
                    .unwrap_or("sync_failed"),
                value
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Hosted synchronization failed."),
            ));
        }
        serde_json::from_value(value).map_err(|error| {
            MirrorError::new(
                "invalid_sync_response",
                format!("Hosted authority returned an invalid response: {error}"),
            )
        })
    }
}

#[async_trait]
impl SyncTransport for HttpSyncTransport {
    async fn open_session(&self) -> Result<SyncSession, MirrorError> {
        self.request(Method::POST, "sessions", None).await
    }

    async fn snapshot(
        &self,
        snapshot_id: Uuid,
        page: Option<&str>,
    ) -> Result<SyncSnapshotPage, MirrorError> {
        let path = {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            query.append_pair("snapshot_id", &snapshot_id.to_string());
            if let Some(page) = page {
                query.append_pair("page", page);
            }
            format!("snapshot?{}", query.finish())
        };
        self.request(Method::GET, &path, None).await
    }

    async fn changes(&self, after: u64, limit: usize) -> Result<SyncChangesPage, MirrorError> {
        self.request(
            Method::GET,
            &format!("changes?after={after}&limit={}", limit.clamp(1, 1_000)),
            None,
        )
        .await
    }

    async fn mutate(&self, mutation: &SyncMutation) -> Result<SyncMutationReceipt, MirrorError> {
        let body = serde_json::to_value(mutation)?;
        self.request(Method::POST, "mutations", Some(&body)).await
    }
}
