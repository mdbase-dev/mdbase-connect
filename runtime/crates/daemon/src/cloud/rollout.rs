//! The rollout answer and the legacy connector's retirement.

use super::*;

impl Cloud {
    /// Automatic local takeover permission (Connect #603). Only an explicit
    /// boolean from the authenticated, uncached rollout endpoint permits it.
    pub async fn local_takeover_allowed(
        &self,
        tls: &Arc<rustls::ClientConfig>,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<bool, CloudError> {
        Ok(self.rollout(tls, current).await?.permits_takeover())
    }

    /// The authenticated, uncached rollout answer: takeover permission and the
    /// account's backend (`legacy` while it is not, or no longer, upgrading).
    pub async fn rollout(
        &self,
        tls: &Arc<rustls::ClientConfig>,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<Rollout, CloudError> {
        // Do not accept a permission from a redirected origin.
        let client = reqwest::Client::builder()
            .use_preconfigured_tls((**tls).clone())
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| CloudError::Network(e.to_string()))?;
        let request = client
            .get(format!("{}/v1/next/rollout", self.server))
            .bearer_auth(self.token.as_str())
            .header(reqwest::header::CACHE_CONTROL, "no-cache");
        let v = self
            .send_current_status(request, current, Some(200))
            .await?;
        parse_rollout(v)
    }

    /// Retire ONLY the exact full old connector (clients migration contract).
    /// A missing endpoint, rejected/unknown response or stale source is not success.
    pub async fn retire_legacy_connector(
        &self,
        tls: &Arc<rustls::ClientConfig>,
        plan: &crate::takeover::retirement::Plan,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<(), CloudError> {
        let client = reqwest::Client::builder()
            .use_preconfigured_tls((**tls).clone())
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| CloudError::Network(e.to_string()))?;
        let request = client
            .post(format!("{}/v1/next/migration/local-takeover", self.server))
            .bearer_auth(self.token.as_str())
            .json(&plan.body());
        let value = self
            .send_current_status(request, current, Some(200))
            .await?;
        parse_legacy_retirement(value, &plan.legacy_connector_id)
    }
}

pub(super) fn parse_legacy_retirement(value: Value, expected: &str) -> Result<(), CloudError> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Retired {
        retired: bool,
        legacy_connector_id: String,
    }
    let r: Retired =
        serde_json::from_value(value).map_err(|_| CloudError::Server(200, "malformed".into()))?;
    if !r.retired || r.legacy_connector_id != expected {
        return Err(CloudError::Server(200, "retirement_not_confirmed".into()));
    }
    Ok(())
}

/// The account's backend as the rollout endpoint reports it.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountBackend {
    /// Still (or again) on legacy mdbase Connect.
    Legacy,
    /// Upgraded.
    Next,
}

/// `GET /v1/next/rollout`, strictly decoded.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Rollout {
    /// Explicit takeover permission.
    pub local_takeover: bool,
    /// The account's backend, when reported.
    pub account_backend: Option<AccountBackend>,
}

impl Rollout {
    /// A released cohort alone is not permission.
    /// Apps must already be routed to next before folders are claimed.
    pub fn permits_takeover(&self) -> bool {
        self.local_takeover && self.account_backend == Some(AccountBackend::Next)
    }
}

pub(super) fn parse_rollout(v: Value) -> Result<Rollout, CloudError> {
    serde_json::from_value(v).map_err(|_| CloudError::Server(200, "malformed".into()))
}

#[cfg(test)]
pub(super) fn parse_local_takeover(v: Value) -> Result<bool, CloudError> {
    Ok(parse_rollout(v)?.permits_takeover())
}
