use super::*;
use mdbase_connect_core::ApplicationTrustRequestDisposition;
use mdbase_connect_protocol::{
    ApplicationTrustAcceptParams, ApplicationTrustPresentation, ApplicationTrustRequest,
    ApplicationTrustSnapshot, FirstContactRole, GrantPolicy, PendingApplicationTrust,
};

pub(super) enum ActivationTrust {
    Trusted,
    Required(Box<ApplicationTrustRequest>),
}

impl AgentState {
    pub(super) fn ensure_activation_trust(
        &self,
        authorization_id: uuid::Uuid,
        grant: &GrantPolicy,
    ) -> Result<ActivationTrust, ConnectError> {
        grant
            .validate_application_security()
            .map_err(invalid_trust_binding)?;
        let authorization = &grant.application_authorization.binding;
        if authorization.authorization_id != authorization_id {
            return Err(ConnectError::AccessDenied(
                "The activation names a different application authorization request.".to_string(),
            ));
        }
        if grant.first_contact.connector_agreement_public_key != self.relay_public_key() {
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
        let request = ApplicationTrustRequest {
            request_id: authorization_id,
            binding: grant.first_contact.clone(),
            presentation: ApplicationTrustPresentation {
                application_name: grant.application_name.clone(),
                application_distribution: grant.application_distribution.clone(),
                application_homepage: grant.application_homepage.clone(),
                application_project_url: grant.application_project_url.clone(),
                application_icon: grant.application_icon.clone(),
            },
            created_at: authorization.issued_at.clone(),
            expires_at: authorization.expires_at.clone(),
        };
        match self.registry.record_application_trust_request(&request)? {
            ApplicationTrustRequestDisposition::AlreadyTrusted => {
                if !self
                    .registry
                    .touch_application_trust(&grant.first_contact)?
                {
                    return Err(ConnectError::AccessDenied(
                        "Application trust changed while activation was being checked.".to_string(),
                    ));
                }
                Ok(ActivationTrust::Trusted)
            }
            ApplicationTrustRequestDisposition::Pending => {
                Ok(ActivationTrust::Required(Box::new(request)))
            }
        }
    }

    pub(super) fn application_trust_snapshot(&self) -> Result<serde_json::Value, ConnectError> {
        let pending = self
            .registry
            .pending_application_trusts()?
            .into_iter()
            .map(|request| self.pending_application_trust(request))
            .collect::<Result<Vec<_>, _>>()?;
        serde_json::to_value(ApplicationTrustSnapshot {
            pending,
            trusted: self.registry.application_trusts()?,
        })
        .map_err(ConnectError::from)
    }

    pub(super) fn show_application_trust(
        &self,
        id: uuid::Uuid,
    ) -> Result<serde_json::Value, ConnectError> {
        if let Some(request) = self.registry.application_trust_request(id)? {
            return Ok(serde_json::json!({
                "state": "pending",
                "trust": self.pending_application_trust(request)?,
            }));
        }
        if let Some(trust) = self.registry.application_trust(id)? {
            return Ok(serde_json::json!({
                "state": "trusted",
                "trust": trust,
            }));
        }
        Err(ConnectError::InvalidInput(format!(
            "No pending request or trusted application has ID {id}."
        )))
    }

    pub(super) fn accept_application_trust(
        &self,
        params: &ApplicationTrustAcceptParams,
    ) -> Result<serde_json::Value, ConnectError> {
        let request = self
            .registry
            .application_trust_request(params.request_id)?
            .ok_or_else(|| {
                ConnectError::InvalidInput(
                    "The first-contact request is unavailable or expired.".to_string(),
                )
            })?;
        let expected = request
            .binding
            .derive_sas(&self.relay_identity, FirstContactRole::Connector)
            .map_err(invalid_trust_binding)?;
        if !authentication_strings_match(&expected, &params.authentication_string) {
            return Err(ConnectError::AccessDenied(
                "The authentication string does not match this application installation. No trust was granted."
                    .to_string(),
            ));
        }
        let trust = self.registry.accept_application_trust(params.request_id)?;
        Ok(serde_json::json!({
            "state": "trusted",
            "trust": trust,
        }))
    }

    pub(super) fn reject_application_trust(
        &self,
        request_id: uuid::Uuid,
    ) -> Result<serde_json::Value, ConnectError> {
        if !self.registry.reject_application_trust(request_id)? {
            return Err(ConnectError::InvalidInput(
                "The first-contact request is unavailable or expired.".to_string(),
            ));
        }
        Ok(serde_json::json!({
            "rejected": true,
            "request_id": request_id,
        }))
    }

    pub(super) fn revoke_application_trust(
        &self,
        trust_id: uuid::Uuid,
    ) -> Result<serde_json::Value, ConnectError> {
        if !self.registry.revoke_application_trust(trust_id)? {
            return Err(ConnectError::InvalidInput(format!(
                "No trusted application has ID {trust_id}."
            )));
        }
        Ok(serde_json::json!({
            "revoked": true,
            "trust_id": trust_id,
        }))
    }

    fn pending_application_trust(
        &self,
        request: ApplicationTrustRequest,
    ) -> Result<PendingApplicationTrust, ConnectError> {
        let authentication_string = request
            .binding
            .derive_sas(&self.relay_identity, FirstContactRole::Connector)
            .map_err(invalid_trust_binding)?;
        Ok(PendingApplicationTrust {
            request,
            authentication_string,
        })
    }
}

fn invalid_trust_binding(error: impl std::fmt::Display) -> ConnectError {
    ConnectError::InvalidInput(format!("Invalid first-contact binding: {error}"))
}

fn authentication_strings_match(expected: &str, provided: &str) -> bool {
    if provided.len() != expected.len() || provided.as_bytes().get(4) != Some(&b'-') {
        return false;
    }
    let normalized = provided.to_ascii_uppercase();
    expected
        .as_bytes()
        .iter()
        .zip(normalized.as_bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, SecondsFormat, Utc};
    use mdbase_connect_core::CollectionRegistry;
    use mdbase_connect_protocol::{
        ApplicationTrustPresentation, ApplicationTrustRequest, FirstContactBinding,
        FIRST_CONTACT_PROTOCOL_VERSION,
    };

    #[test]
    fn authentication_string_comparison_is_strict_but_case_insensitive() {
        assert!(authentication_strings_match("SY8B-VQ53", "SY8B-VQ53"));
        assert!(authentication_strings_match("SY8B-VQ53", "sy8b-vq53"));
        assert!(!authentication_strings_match("SY8B-VQ53", "SY8BVQ53"));
        assert!(!authentication_strings_match("SY8B-VQ53", "SY8B-VQ54"));
        assert!(!authentication_strings_match("SY8B-VQ53", ""));
    }

    #[tokio::test]
    async fn local_control_requires_the_application_displayed_string() {
        let directory = tempfile::tempdir().unwrap();
        let registry = CollectionRegistry::open(directory.path()).unwrap();
        let watcher = CollectionWatchService::start(registry.clone());
        let connector = RelayIdentity::generate();
        let application = RelayIdentity::generate();
        let signing = RelayIdentity::generate();
        let request = ApplicationTrustRequest {
            request_id: uuid::Uuid::new_v4(),
            binding: FirstContactBinding {
                protocol_version: FIRST_CONTACT_PROTOCOL_VERSION,
                application_id: uuid::Uuid::new_v4(),
                application_installation_id: uuid::Uuid::new_v4(),
                application_agreement_public_key: application.public_key(),
                application_signing_public_key: signing.public_key(),
                connector_id: uuid::Uuid::new_v4(),
                connector_agreement_public_key: connector.public_key(),
            },
            presentation: ApplicationTrustPresentation {
                application_name: "Control fixture".to_string(),
                application_distribution: "web".to_string(),
                application_homepage: "https://fixture.invalid".to_string(),
                application_project_url: None,
                application_icon: None,
            },
            created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            expires_at: (Utc::now() + Duration::minutes(10))
                .to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        registry.record_application_trust_request(&request).unwrap();
        let expected = request
            .binding
            .derive_sas(&connector, FirstContactRole::Connector)
            .unwrap();
        let state = AgentState::with_identity(registry.clone(), watcher, None, connector);

        let snapshot = state
            .execute(ControlRequest::new(
                ControlCommand::ApplicationTrustSnapshot,
            ))
            .await;
        assert!(snapshot.ok);
        assert_eq!(
            snapshot.result.unwrap()["pending"][0]["authentication_string"],
            expected
        );

        let mismatch = state
            .execute(ControlRequest::new(ControlCommand::ApplicationTrustAccept(
                ApplicationTrustAcceptParams {
                    request_id: request.request_id,
                    authentication_string: "0000-0000".to_string(),
                },
            )))
            .await;
        assert!(!mismatch.ok);
        assert_eq!(mismatch.error.unwrap().code, "access_denied");
        assert!(registry
            .application_trust_request(request.request_id)
            .unwrap()
            .is_some());

        let accepted = state
            .execute(ControlRequest::new(ControlCommand::ApplicationTrustAccept(
                ApplicationTrustAcceptParams {
                    request_id: request.request_id,
                    authentication_string: expected.to_ascii_lowercase(),
                },
            )))
            .await;
        assert!(accepted.ok);
        assert_eq!(accepted.result.unwrap()["state"], "trusted");
        assert!(registry.application_is_trusted(&request.binding).unwrap());
    }
}
