use super::*;
use chrono::{DateTime, SecondsFormat, Utc};
use mdbase_connect_protocol::{ApplicationTrust, ApplicationTrustRequest, FirstContactBinding};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplicationTrustRequestDisposition {
    Pending,
    AlreadyTrusted,
}

impl CollectionRegistry {
    pub fn record_application_trust_request(
        &self,
        request: &ApplicationTrustRequest,
    ) -> Result<ApplicationTrustRequestDisposition, ConnectError> {
        validate_request(request)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        delete_expired(&transaction)?;

        let existing = transaction
            .query_row(
                "SELECT request FROM pending_application_trusts WHERE request_id = ?1",
                [request.request_id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(existing) = existing {
            let existing: ApplicationTrustRequest = serde_json::from_str(&existing)?;
            if existing != *request {
                return Err(ConnectError::InvalidInput(
                    "A first-contact request ID was replayed with different identity material."
                        .to_string(),
                ));
            }
            let disposition = if is_trusted(&transaction, &request.binding)? {
                ApplicationTrustRequestDisposition::AlreadyTrusted
            } else {
                ApplicationTrustRequestDisposition::Pending
            };
            transaction.commit()?;
            return Ok(disposition);
        }

        if is_trusted(&transaction, &request.binding)? {
            transaction.commit()?;
            return Ok(ApplicationTrustRequestDisposition::AlreadyTrusted);
        }
        transaction.execute(
            "INSERT INTO pending_application_trusts
               (request_id, application_id, application_installation_id,
                connector_id, request, created_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                request.request_id.to_string(),
                request.binding.application_id.to_string(),
                request.binding.application_installation_id.to_string(),
                request.binding.connector_id.to_string(),
                serde_json::to_string(request)?,
                request.created_at,
                request.expires_at,
            ],
        )?;
        transaction.commit()?;
        Ok(ApplicationTrustRequestDisposition::Pending)
    }

    pub fn pending_application_trusts(&self) -> Result<Vec<ApplicationTrustRequest>, ConnectError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        delete_expired(&transaction)?;
        let requests = {
            let mut statement = transaction.prepare(
                "SELECT request FROM pending_application_trusts
                 ORDER BY created_at, request_id",
            )?;
            let requests = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .map(|row| serde_json::from_str(&row?).map_err(ConnectError::from))
                .collect::<Result<Vec<_>, _>>()?;
            requests
        };
        transaction.commit()?;
        Ok(requests)
    }

    pub fn application_trust_request(
        &self,
        request_id: Uuid,
    ) -> Result<Option<ApplicationTrustRequest>, ConnectError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        delete_expired(&transaction)?;
        let request = transaction
            .query_row(
                "SELECT request FROM pending_application_trusts WHERE request_id = ?1",
                [request_id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|value| serde_json::from_str(&value))
            .transpose()?;
        transaction.commit()?;
        Ok(request)
    }

    pub fn accept_application_trust(
        &self,
        request_id: Uuid,
    ) -> Result<ApplicationTrust, ConnectError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        delete_expired(&transaction)?;
        let request = transaction
            .query_row(
                "SELECT request FROM pending_application_trusts WHERE request_id = ?1",
                [request_id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|value| serde_json::from_str::<ApplicationTrustRequest>(&value))
            .transpose()?
            .ok_or_else(|| {
                ConnectError::InvalidInput(
                    "The first-contact request is unavailable or expired.".to_string(),
                )
            })?;
        validate_request(&request)?;
        let existing_id = transaction
            .query_row(
                "SELECT id FROM application_trusts
                 WHERE application_id = ?1 AND application_installation_id = ?2
                   AND connector_id = ?3",
                identity_params(&request.binding),
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let trust_id = existing_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let trusted_at = now();
        transaction.execute(
            "INSERT INTO application_trusts
               (id, application_id, application_installation_id, connector_id,
                binding, presentation, trusted_at, last_used_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(application_id, application_installation_id, connector_id)
             DO UPDATE SET
               binding = excluded.binding,
               presentation = excluded.presentation,
               trusted_at = excluded.trusted_at,
               last_used_at = excluded.last_used_at",
            params![
                trust_id,
                request.binding.application_id.to_string(),
                request.binding.application_installation_id.to_string(),
                request.binding.connector_id.to_string(),
                serde_json::to_string(&request.binding)?,
                serde_json::to_string(&request.presentation)?,
                trusted_at,
            ],
        )?;
        transaction.execute(
            "DELETE FROM pending_application_trusts
             WHERE application_id = ?1 AND application_installation_id = ?2
               AND connector_id = ?3",
            identity_params(&request.binding),
        )?;
        let trust = load_trust(&transaction, &trust_id)?.ok_or_else(|| {
            ConnectError::InvalidInput(
                "The accepted first-contact trust could not be read back.".to_string(),
            )
        })?;
        transaction.commit()?;
        Ok(trust)
    }

    pub fn reject_application_trust(&self, request_id: Uuid) -> Result<bool, ConnectError> {
        Ok(self.connection()?.execute(
            "DELETE FROM pending_application_trusts WHERE request_id = ?1",
            [request_id.to_string()],
        )? == 1)
    }

    pub fn application_trusts(&self) -> Result<Vec<ApplicationTrust>, ConnectError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, binding, presentation, trusted_at, last_used_at
             FROM application_trusts ORDER BY trusted_at, id",
        )?;
        let trusts = statement
            .query_map([], trust_from_row)?
            .map(|row| row.map_err(ConnectError::from).and_then(parse_trust))
            .collect();
        trusts
    }

    pub fn application_trust(
        &self,
        trust_id: Uuid,
    ) -> Result<Option<ApplicationTrust>, ConnectError> {
        load_trust(&self.connection()?, &trust_id.to_string())
    }

    pub fn application_is_trusted(
        &self,
        binding: &FirstContactBinding,
    ) -> Result<bool, ConnectError> {
        binding.validate().map_err(invalid_binding)?;
        is_trusted(&self.connection()?, binding)
    }

    pub fn touch_application_trust(
        &self,
        binding: &FirstContactBinding,
    ) -> Result<bool, ConnectError> {
        if !self.application_is_trusted(binding)? {
            return Ok(false);
        }
        Ok(self.connection()?.execute(
            "UPDATE application_trusts SET last_used_at = ?4
             WHERE application_id = ?1 AND application_installation_id = ?2
               AND connector_id = ?3",
            params![
                binding.application_id.to_string(),
                binding.application_installation_id.to_string(),
                binding.connector_id.to_string(),
                now(),
            ],
        )? == 1)
    }

    pub fn revoke_application_trust(&self, trust_id: Uuid) -> Result<bool, ConnectError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let binding = transaction
            .query_row(
                "SELECT binding FROM application_trusts WHERE id = ?1",
                [trust_id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|value| serde_json::from_str::<FirstContactBinding>(&value))
            .transpose()?;
        let Some(binding) = binding else {
            transaction.commit()?;
            return Ok(false);
        };
        let identity = identity_params(&binding);
        for table in ["grant_crypto_state", "grant_crypto_requests"] {
            transaction.execute(
                &format!(
                    "DELETE FROM {table} WHERE grant_id IN (
                       SELECT id FROM grants
                       WHERE json_extract(first_contact, '$.application_id') = ?1
                         AND json_extract(first_contact, '$.application_installation_id') = ?2
                         AND json_extract(first_contact, '$.connector_id') = ?3
                     )"
                ),
                identity.clone(),
            )?;
        }
        transaction.execute(
            "DELETE FROM grants
             WHERE json_extract(first_contact, '$.application_id') = ?1
               AND json_extract(first_contact, '$.application_installation_id') = ?2
               AND json_extract(first_contact, '$.connector_id') = ?3",
            identity.clone(),
        )?;
        transaction.execute(
            "DELETE FROM pending_application_trusts
             WHERE application_id = ?1 AND application_installation_id = ?2
               AND connector_id = ?3",
            identity,
        )?;
        transaction.execute(
            "DELETE FROM application_trusts WHERE id = ?1",
            [trust_id.to_string()],
        )?;
        transaction.commit()?;
        Ok(true)
    }
}

fn validate_request(request: &ApplicationTrustRequest) -> Result<(), ConnectError> {
    request.binding.validate().map_err(invalid_binding)?;
    let created_at = parse_time(&request.created_at)?;
    let expires_at = parse_time(&request.expires_at)?;
    if expires_at <= Utc::now() || expires_at <= created_at {
        return Err(ConnectError::InvalidInput(
            "The first-contact request is expired or has an invalid lifetime.".to_string(),
        ));
    }
    let distribution = request.presentation.application_distribution.as_str();
    if request.presentation.application_name.trim().is_empty()
        || !matches!(distribution, "web" | "portable")
        || (distribution == "web" && request.presentation.application_homepage.trim().is_empty())
    {
        return Err(ConnectError::InvalidInput(
            "The first-contact request is missing application presentation metadata.".to_string(),
        ));
    }
    Ok(())
}

fn invalid_binding(error: impl std::fmt::Display) -> ConnectError {
    ConnectError::InvalidInput(format!("Invalid first-contact binding: {error}"))
}

fn parse_time(value: &str) -> Result<DateTime<Utc>, ConnectError> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| {
            ConnectError::InvalidInput(
                "The first-contact request timestamp is invalid.".to_string(),
            )
        })
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn delete_expired(connection: &Connection) -> Result<(), ConnectError> {
    connection.execute(
        "DELETE FROM pending_application_trusts WHERE expires_at <= ?1",
        [now()],
    )?;
    Ok(())
}

fn identity_params(binding: &FirstContactBinding) -> [String; 3] {
    [
        binding.application_id.to_string(),
        binding.application_installation_id.to_string(),
        binding.connector_id.to_string(),
    ]
}

pub(super) fn is_trusted(
    connection: &Connection,
    binding: &FirstContactBinding,
) -> Result<bool, ConnectError> {
    let stored = connection
        .query_row(
            "SELECT binding FROM application_trusts
             WHERE application_id = ?1 AND application_installation_id = ?2
               AND connector_id = ?3",
            identity_params(binding),
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok(stored
        .map(|value| serde_json::from_str::<FirstContactBinding>(&value))
        .transpose()?
        .is_some_and(|stored| stored == *binding))
}

fn load_trust(
    connection: &Connection,
    trust_id: &str,
) -> Result<Option<ApplicationTrust>, ConnectError> {
    connection
        .query_row(
            "SELECT id, binding, presentation, trusted_at, last_used_at
             FROM application_trusts WHERE id = ?1",
            [trust_id],
            trust_from_row,
        )
        .optional()?
        .map(parse_trust)
        .transpose()
}

type TrustRow = (String, String, String, String, String);

fn trust_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TrustRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
    ))
}

fn parse_trust(row: TrustRow) -> Result<ApplicationTrust, ConnectError> {
    Ok(ApplicationTrust {
        id: parse_registry_uuid(&row.0)?,
        binding: serde_json::from_str(&row.1)?,
        presentation: serde_json::from_str(&row.2)?,
        trusted_at: row.3,
        last_used_at: row.4,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;
    use mdbase_connect_protocol::{
        crypto::RelayIdentity, ApplicationTrustPresentation, FIRST_CONTACT_PROTOCOL_VERSION,
    };

    fn request(expires_at: DateTime<Utc>) -> ApplicationTrustRequest {
        let application = RelayIdentity::generate();
        let signing = RelayIdentity::generate();
        let connector = RelayIdentity::generate();
        ApplicationTrustRequest {
            request_id: Uuid::new_v4(),
            binding: FirstContactBinding {
                protocol_version: FIRST_CONTACT_PROTOCOL_VERSION,
                application_id: Uuid::new_v4(),
                application_installation_id: Uuid::new_v4(),
                application_agreement_public_key: application.public_key(),
                application_signing_public_key: signing.public_key(),
                connector_id: Uuid::new_v4(),
                connector_agreement_public_key: connector.public_key(),
            },
            presentation: ApplicationTrustPresentation {
                application_name: "Fixture application".to_string(),
                application_distribution: "web".to_string(),
                application_homepage: "https://fixture.invalid".to_string(),
                application_project_url: None,
                application_icon: None,
            },
            created_at: (Utc::now() - Duration::seconds(1))
                .to_rfc3339_opts(SecondsFormat::Millis, true),
            expires_at: expires_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        }
    }

    #[test]
    fn trust_acceptance_is_exact_and_survives_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let registry = CollectionRegistry::open(directory.path()).unwrap();
        let request = request(Utc::now() + Duration::minutes(10));
        assert_eq!(
            registry.record_application_trust_request(&request).unwrap(),
            ApplicationTrustRequestDisposition::Pending
        );
        assert_eq!(
            registry.record_application_trust_request(&request).unwrap(),
            ApplicationTrustRequestDisposition::Pending
        );
        let concurrent = ApplicationTrustRequest {
            request_id: Uuid::new_v4(),
            ..request.clone()
        };
        registry
            .record_application_trust_request(&concurrent)
            .unwrap();
        assert_eq!(registry.pending_application_trusts().unwrap().len(), 2);
        let trust = registry
            .accept_application_trust(request.request_id)
            .unwrap();
        assert!(registry.application_is_trusted(&request.binding).unwrap());
        assert!(registry.pending_application_trusts().unwrap().is_empty());
        drop(registry);

        let reopened = CollectionRegistry::open(directory.path()).unwrap();
        assert_eq!(reopened.application_trust(trust.id).unwrap(), Some(trust));
        assert_eq!(
            reopened.record_application_trust_request(&request).unwrap(),
            ApplicationTrustRequestDisposition::AlreadyTrusted
        );
    }

    #[test]
    fn request_replay_cannot_change_identity_material() {
        let directory = tempfile::tempdir().unwrap();
        let registry = CollectionRegistry::open(directory.path()).unwrap();
        let request = request(Utc::now() + Duration::minutes(10));
        registry.record_application_trust_request(&request).unwrap();
        let mut substituted = request;
        substituted.binding.application_agreement_public_key =
            RelayIdentity::generate().public_key();
        let error = registry
            .record_application_trust_request(&substituted)
            .unwrap_err();
        assert_eq!(error.code(), "invalid_input");
    }

    #[test]
    fn expired_requests_fail_closed_and_are_removed() {
        let directory = tempfile::tempdir().unwrap();
        let registry = CollectionRegistry::open(directory.path()).unwrap();
        let request = request(Utc::now() - Duration::seconds(1));
        let error = registry
            .record_application_trust_request(&request)
            .unwrap_err();
        assert_eq!(error.code(), "invalid_input");
        assert!(registry.pending_application_trusts().unwrap().is_empty());
    }

    #[test]
    fn changed_keys_need_reacceptance_and_revocation_is_immediate() {
        let directory = tempfile::tempdir().unwrap();
        let registry = CollectionRegistry::open(directory.path()).unwrap();
        let first = request(Utc::now() + Duration::minutes(10));
        registry.record_application_trust_request(&first).unwrap();
        let trust = registry.accept_application_trust(first.request_id).unwrap();

        let mut changed = first.clone();
        changed.request_id = Uuid::new_v4();
        changed.binding.application_agreement_public_key = RelayIdentity::generate().public_key();
        assert!(!registry.application_is_trusted(&changed.binding).unwrap());
        assert_eq!(
            registry.record_application_trust_request(&changed).unwrap(),
            ApplicationTrustRequestDisposition::Pending
        );
        assert!(registry.revoke_application_trust(trust.id).unwrap());
        assert!(!registry.application_is_trusted(&first.binding).unwrap());
    }
}
