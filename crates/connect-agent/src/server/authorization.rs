use super::*;
use mdbase_connect_protocol::GrantPolicy;

impl AgentState {
    pub(super) fn validate_activation_authorization(
        &self,
        authorization_id: uuid::Uuid,
        grant: &GrantPolicy,
    ) -> Result<(), ConnectError> {
        grant.validate_application_security().map_err(|error| {
            ConnectError::InvalidInput(format!("Invalid application authorization: {error}"))
        })?;
        let authorization = &grant.application_authorization.binding;
        if authorization.authorization_id != authorization_id {
            return Err(ConnectError::AccessDenied(
                "The activation names a different application authorization request.".to_string(),
            ));
        }
        let encryption = grant.encryption.as_ref().ok_or_else(|| {
            ConnectError::AccessDenied(
                "The activation is missing its encrypted connector binding.".to_string(),
            )
        })?;
        if encryption.connector_agreement_public_key != self.relay_public_key() {
            return Err(ConnectError::AccessDenied(
                "The activation is bound to a different connector identity.".to_string(),
            ));
        }
        let issued_at = chrono::DateTime::parse_from_rfc3339(&authorization.issued_at)
            .map(|value| value.with_timezone(&chrono::Utc))
            .map_err(|_| {
                ConnectError::InvalidInput(
                    "The application authorization issue time is invalid.".to_string(),
                )
            })?;
        let expires_at = chrono::DateTime::parse_from_rfc3339(&authorization.expires_at)
            .map(|value| value.with_timezone(&chrono::Utc))
            .map_err(|_| {
                ConnectError::InvalidInput(
                    "The application authorization expiry is invalid.".to_string(),
                )
            })?;
        let now = chrono::Utc::now();
        if expires_at <= now
            || expires_at <= issued_at
            || expires_at - issued_at > chrono::Duration::minutes(15)
            || issued_at > now + chrono::Duration::minutes(2)
        {
            return Err(ConnectError::AccessDenied(
                "The application authorization is expired or has an invalid lifetime.".to_string(),
            ));
        }
        Ok(())
    }
}
