//! Account state on disk: the non-secret cloud config and the account publication fence.

use super::*;

/// Non-secret account state (`<state>/cloud.json`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudConfig {
    /// Schema version.
    pub schema_version: u32,
    /// Account epoch; must match the durable signed-in fence before reconnect.
    #[serde(default)]
    pub account_epoch: u64,
    /// Canonical server origin.
    pub server_url: String,
    /// This connector's ID, pinned at pairing (or from the first snapshot).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connector_id: Option<String>,
    /// This computer's name in the account, as last set from here (pairing or
    /// `account.rename`). Shown locally; the account is authoritative.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub computer_name: Option<String>,
    /// Whether this device is registered to the connector.
    #[serde(default)]
    pub device_registered: bool,
    /// In-memory relay replay guard. At relay startup, the authoritative cursor
    /// is loaded from access.json; feed commits do not write cloud.json.
    #[serde(default)]
    pub policy_sequence: u64,
    /// Revision of `policy_sequence`.
    #[serde(default)]
    pub policy_revision: String,
}

impl CloudConfig {
    /// Load, or `None` when not signed in.
    pub fn load(path: &Path) -> Result<Option<CloudConfig>, CloudError> {
        match fsutil::read_optional(path).map_err(|e| CloudError::Local(e.to_string()))? {
            None => Ok(None),
            Some(b) => serde_json::from_slice(&b)
                .map(Some)
                .map_err(|e| CloudError::Local(format!("cloud.json: {e}"))),
        }
    }

    /// Save durably.
    pub fn save(&self, path: &Path) -> Result<(), CloudError> {
        let mut b =
            serde_json::to_vec_pretty(self).map_err(|e| CloudError::Local(e.to_string()))?;
        b.push(b'\n');
        fsutil::write_atomic(path, &b).map_err(|e| CloudError::Local(e.to_string()))
    }
}

/// Durable account publication fence. Missing/invalid state never reconnects.
/// Written signed-out before cleanup, and signed-in only after token/config save.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountRecord {
    /// Current schema (1); default/missing file is signed-out schema 1.
    pub schema_version: u32,
    /// Monotonically increasing login/logout generation.
    pub epoch: u64,
    /// Whether this epoch completed credential/config publication.
    pub signed_in: bool,
    /// Pinned connector, required when signed in.
    pub connector_id: Option<String>,
    /// Authenticated Connect pairing account; missing legacy fences never serve.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

impl AccountRecord {
    /// Load a fence. An absent file is signed out; malformed/newer data fails.
    pub fn load(path: &Path) -> Result<Self, CloudError> {
        let Some(bytes) =
            fsutil::read_optional(path).map_err(|e| CloudError::Local(e.to_string()))?
        else {
            return Ok(Self {
                schema_version: 1,
                ..Self::default()
            });
        };
        fsutil::verify_owner_only(path).map_err(|e| CloudError::Local(e.to_string()))?;
        let record: Self = serde_json::from_slice(&bytes)
            .map_err(|_| CloudError::Local("invalid account fence".into()))?;
        if record.schema_version != 1 || (record.signed_in && record.connector_id.is_none()) {
            return Err(CloudError::Local("unsupported account fence".into()));
        }
        Ok(record)
    }

    /// Save the authoritative publication fence atomically and durably.
    pub fn save(&self, path: &Path) -> Result<(), CloudError> {
        let bytes = serde_json::to_vec(self)
            .map_err(|_| CloudError::Local("account fence encoding".into()))?;
        fsutil::write_atomic(path, &bytes).map_err(|e| CloudError::Local(e.to_string()))
    }

    /// The paired account, never inferred from connector/device/grant metadata.
    pub fn active_account(&self) -> Option<mdbn_wire::common::B16> {
        if self.schema_version != 1 || !self.signed_in {
            return None;
        }
        crate::authority::account_id(self.account_id.as_deref()?)
    }

    /// Stale/partial cloud metadata cannot reactivate this account.
    pub fn permits(&self, config: &CloudConfig) -> bool {
        self.schema_version == 1
            && self.active_account().is_some()
            && self.epoch == config.account_epoch
            && self.connector_id.is_some()
            && self.connector_id == config.connector_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_account_fence_is_readable_for_normal_repair_but_never_authority() {
        let dir = crate::testutil::TestDir::new("old-account");
        let path = dir.path().join("account.json");
        crate::fsutil::write_atomic(
            &path,
            br#"{"schema_version":1,"epoch":7,"signed_in":true,"connector_id":"connector"}"#,
        )
        .unwrap();
        let record = AccountRecord::load(&path).unwrap();
        let config = CloudConfig {
            account_epoch: 7,
            connector_id: Some("connector".into()),
            ..Default::default()
        };
        assert_eq!(record.active_account(), None);
        assert!(!record.permits(&config));
    }
}
