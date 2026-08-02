use super::*;

impl CollectionRegistry {
    pub fn replace_grants(&self, grants: &[GrantPolicy]) -> Result<(), ConnectError> {
        let validation = self.connection()?;
        for grant in grants {
            validate_grant_application_trust(&validation, grant)?;
        }
        let active_crypto_keys = grants
            .iter()
            .filter_map(|grant| {
                grant
                    .encryption
                    .as_ref()
                    .map(|encryption| (grant.id.to_string(), encryption.key_id.clone()))
            })
            .collect::<BTreeSet<_>>();
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM grants", [])?;
        {
            let mut statement = transaction.prepare(
                "INSERT INTO grants
                   (id, application_id, collection_id, operations, scope, application_name,
                    application_distribution, application_homepage, application_project_url,
                    application_origin, application_icon, collection_name, created_at, encryption,
                    file_capability, notification_criteria, first_contact,
                    application_authorization)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            )?;
            for grant in grants {
                statement.execute(params![
                    grant.id.to_string(),
                    grant.application_id.to_string(),
                    grant.collection_id.to_string(),
                    serde_json::to_string(&grant.operations)?,
                    serde_json::to_string(&grant.scope)?,
                    grant.application_name,
                    grant.application_distribution,
                    grant.application_homepage,
                    grant.application_project_url,
                    grant.application_origin,
                    grant.application_icon,
                    grant.collection_name,
                    grant.created_at,
                    grant
                        .encryption
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()?,
                    grant
                        .file_capability
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()?,
                    serde_json::to_string(&grant.notification_criteria)?,
                    serde_json::to_string(&grant.first_contact)?,
                    serde_json::to_string(&grant.application_authorization)?,
                ])?;
            }
        }
        transaction.execute(
            "DELETE FROM grant_crypto_state WHERE grant_id NOT IN (SELECT id FROM grants)",
            [],
        )?;
        transaction.execute(
            "DELETE FROM grant_crypto_requests WHERE grant_id NOT IN (SELECT id FROM grants)",
            [],
        )?;
        let stored_crypto_keys = {
            let mut statement = transaction.prepare(
                "SELECT grant_id, key_id FROM grant_crypto_state
                 UNION SELECT grant_id, key_id FROM grant_crypto_requests",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        for (grant_id, key_id) in stored_crypto_keys {
            if active_crypto_keys.contains(&(grant_id.clone(), key_id.clone())) {
                continue;
            }
            transaction.execute(
                "DELETE FROM grant_crypto_state WHERE grant_id = ?1 AND key_id = ?2",
                params![grant_id, key_id],
            )?;
            transaction.execute(
                "DELETE FROM grant_crypto_requests WHERE grant_id = ?1 AND key_id = ?2",
                params![grant_id, key_id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn upsert_grant(&self, grant: &GrantPolicy) -> Result<(), ConnectError> {
        let connection = self.connection()?;
        validate_grant_application_trust(&connection, grant)?;
        connection.execute(
            "INSERT INTO grants
               (id, application_id, collection_id, operations, scope, application_name,
                application_distribution, application_homepage, application_project_url,
                application_origin, application_icon, collection_name, created_at, encryption,
                file_capability, notification_criteria, first_contact,
                application_authorization)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
             ON CONFLICT(id) DO UPDATE SET
               application_id = excluded.application_id,
               collection_id = excluded.collection_id,
               operations = excluded.operations,
               scope = excluded.scope,
               application_name = excluded.application_name,
               application_distribution = excluded.application_distribution,
               application_homepage = excluded.application_homepage,
               application_project_url = excluded.application_project_url,
               application_origin = excluded.application_origin,
               application_icon = excluded.application_icon,
               collection_name = excluded.collection_name,
               created_at = excluded.created_at,
               encryption = excluded.encryption,
               file_capability = excluded.file_capability,
               notification_criteria = excluded.notification_criteria,
               first_contact = excluded.first_contact,
               application_authorization = excluded.application_authorization,
               updated_at = CURRENT_TIMESTAMP",
            params![
                grant.id.to_string(),
                grant.application_id.to_string(),
                grant.collection_id.to_string(),
                serde_json::to_string(&grant.operations)?,
                serde_json::to_string(&grant.scope)?,
                grant.application_name,
                grant.application_distribution,
                grant.application_homepage,
                grant.application_project_url,
                grant.application_origin,
                grant.application_icon,
                grant.collection_name,
                grant.created_at,
                grant
                    .encryption
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                grant
                    .file_capability
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                serde_json::to_string(&grant.notification_criteria)?,
                serde_json::to_string(&grant.first_contact)?,
                serde_json::to_string(&grant.application_authorization)?,
            ],
        )?;
        if let Some(encryption) = &grant.encryption {
            connection.execute(
                "DELETE FROM grant_crypto_state
                 WHERE grant_id = ?1 AND key_id <> ?2",
                params![grant.id.to_string(), encryption.key_id],
            )?;
            connection.execute(
                "DELETE FROM grant_crypto_requests
                 WHERE grant_id = ?1 AND key_id <> ?2",
                params![grant.id.to_string(), encryption.key_id],
            )?;
        } else {
            connection.execute(
                "DELETE FROM grant_crypto_state WHERE grant_id = ?1",
                [grant.id.to_string()],
            )?;
            connection.execute(
                "DELETE FROM grant_crypto_requests WHERE grant_id = ?1",
                [grant.id.to_string()],
            )?;
        }
        Ok(())
    }

    pub fn list_grants(&self) -> Result<Vec<GrantSummary>, ConnectError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, application_id, application_name, application_distribution,
                    application_homepage, application_project_url, application_origin,
                    application_icon, collection_id, collection_name, operations, scope,
                    created_at, encryption, file_capability, notification_criteria
             FROM grants ORDER BY application_name COLLATE NOCASE, collection_name COLLATE NOCASE",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, String>(11)?,
                row.get::<_, String>(12)?,
                row.get::<_, Option<String>>(13)?,
                row.get::<_, Option<String>>(14)?,
                row.get::<_, String>(15)?,
            ))
        })?;
        rows.map(|row| {
            let (
                id,
                application_id,
                application_name,
                application_distribution,
                application_homepage,
                application_project_url,
                application_origin,
                application_icon,
                collection_id,
                collection_name,
                operations,
                scope,
                created_at,
                encryption,
                file_capability,
                notification_criteria,
            ) = row?;
            Ok(GrantSummary {
                id: parse_registry_uuid(&id)?,
                application_id: parse_registry_uuid(&application_id)?,
                application_name,
                application_distribution,
                application_homepage,
                application_project_url,
                application_origin,
                application_icon,
                collection_id: parse_registry_uuid(&collection_id)?,
                collection_name,
                operations: serde_json::from_str(&operations)?,
                scope: serde_json::from_str(&scope)?,
                notification_criteria: serde_json::from_str(&notification_criteria)?,
                created_at,
                encryption: encryption
                    .as_deref()
                    .map(serde_json::from_str)
                    .transpose()?,
                file_capability: file_capability
                    .as_deref()
                    .map(serde_json::from_str)
                    .transpose()?,
            })
        })
        .collect()
    }

    pub fn grant_context(&self, grant_id: Uuid) -> Result<Option<GrantSummary>, ConnectError> {
        Ok(self
            .list_grants()?
            .into_iter()
            .find(|grant| grant.id == grant_id))
    }

    pub fn authorizes(
        &self,
        grant_id: Uuid,
        application_id: Uuid,
        collection_id: Uuid,
        operation: &str,
    ) -> Result<bool, ConnectError> {
        let operations = self
            .connection()?
            .query_row(
                "SELECT operations FROM grants
                 WHERE id = ?1 AND application_id = ?2 AND collection_id = ?3",
                params![
                    grant_id.to_string(),
                    application_id.to_string(),
                    collection_id.to_string()
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(operations) = operations else {
            return Ok(false);
        };
        let operations: Vec<String> = serde_json::from_str(&operations)?;
        Ok(operations.iter().any(|allowed| allowed == operation))
    }
}

fn validate_grant_application_trust(
    connection: &rusqlite::Connection,
    grant: &GrantPolicy,
) -> Result<(), ConnectError> {
    grant.validate_application_security().map_err(|error| {
        invalid_grant_security(format!(
            "grant does not match its application proof: {error}"
        ))
    })?;
    if !super::application_trust::is_trusted(connection, &grant.first_contact)? {
        return Err(ConnectError::AccessDenied(
            "This application installation has not passed first-contact verification.".to_string(),
        ));
    }
    Ok(())
}

fn invalid_grant_security(message: impl Into<String>) -> ConnectError {
    ConnectError::InvalidInput(format!(
        "Invalid application authorization: {}",
        message.into()
    ))
}
