use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderAuthorityTransferState {
    Prepared,
    Completed,
    Aborted,
}

impl TryFrom<&str> for ProviderAuthorityTransferState {
    type Error = ApiError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "prepared" => Ok(Self::Prepared),
            "completed" => Ok(Self::Completed),
            "aborted" => Ok(Self::Aborted),
            _ => Err(ApiError::internal(
                "Stored authority transfer state is invalid.",
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderAuthorityImportState {
    Receiving,
    Uploaded,
    Completed,
    Aborted,
}

impl ProviderAuthorityImportState {
    pub(super) const fn accepts_upload(self) -> bool {
        matches!(self, Self::Receiving | Self::Uploaded)
    }
}

impl TryFrom<&str> for ProviderAuthorityImportState {
    type Error = ApiError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "receiving" => Ok(Self::Receiving),
            "uploaded" => Ok(Self::Uploaded),
            "completed" => Ok(Self::Completed),
            "aborted" => Ok(Self::Aborted),
            _ => Err(ApiError::internal(
                "Stored authority import state is invalid.",
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum HostedCollectionState {
    Active,
    Importing,
    Transferring,
    Transferred,
    Deleting,
}

impl TryFrom<&str> for HostedCollectionState {
    type Error = ApiError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "active" => Ok(Self::Active),
            "importing" => Ok(Self::Importing),
            "transferring" => Ok(Self::Transferring),
            "transferred" => Ok(Self::Transferred),
            "deleting" => Ok(Self::Deleting),
            _ => Err(ApiError::internal(
                "Stored hosted collection authority state is invalid.",
            )),
        }
    }
}

pub(super) fn authority_transfer_state(row: &PgRow) -> ApiResult<ProviderAuthorityTransferState> {
    let value = row.get::<String, _>("state");
    ProviderAuthorityTransferState::try_from(value.as_str())
}

pub(super) fn authority_import_state(
    row: &PgRow,
    column: &str,
) -> ApiResult<ProviderAuthorityImportState> {
    let value = row.get::<String, _>(column);
    ProviderAuthorityImportState::try_from(value.as_str())
}

pub(super) fn hosted_collection_state(
    row: &PgRow,
    column: &str,
) -> ApiResult<HostedCollectionState> {
    let value = row.get::<String, _>(column);
    HostedCollectionState::try_from(value.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_lifecycle_states_are_closed_and_fail_unknown_values() {
        assert_eq!(
            ProviderAuthorityTransferState::try_from("prepared").unwrap(),
            ProviderAuthorityTransferState::Prepared
        );
        assert_eq!(
            ProviderAuthorityImportState::try_from("uploaded").unwrap(),
            ProviderAuthorityImportState::Uploaded
        );
        assert_eq!(
            HostedCollectionState::try_from("transferring").unwrap(),
            HostedCollectionState::Transferring
        );
        assert!(ProviderAuthorityTransferState::try_from("pending").is_err());
        assert!(ProviderAuthorityImportState::try_from("finalizing").is_err());
        assert!(HostedCollectionState::try_from("unknown").is_err());
    }

    #[test]
    fn lifecycle_states_keep_the_public_wire_values_stable() {
        assert_eq!(
            serde_json::to_value(ProviderAuthorityTransferState::Completed).unwrap(),
            json!("completed")
        );
        assert_eq!(
            serde_json::to_value(ProviderAuthorityImportState::Receiving).unwrap(),
            json!("receiving")
        );
    }
}
