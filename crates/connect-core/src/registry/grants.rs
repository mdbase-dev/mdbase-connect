use super::*;

impl CollectionRegistry {
    pub fn replace_grants(&self, grants: &[GrantPolicy]) -> Result<(), ConnectError> {
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
                    notification_criteria)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
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
                    serde_json::to_string(&grant.notification_criteria)?,
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
        connection.execute(
            "INSERT INTO grants
               (id, application_id, collection_id, operations, scope, application_name,
                application_distribution, application_homepage, application_project_url,
                application_origin, application_icon, collection_name, created_at, encryption,
                notification_criteria)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
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
               notification_criteria = excluded.notification_criteria,
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
                serde_json::to_string(&grant.notification_criteria)?,
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

    pub fn replace_grant_summaries(&self, grants: &[GrantSummary]) -> Result<(), ConnectError> {
        self.replace_grants(
            &grants
                .iter()
                .map(|grant| GrantPolicy {
                    id: grant.id,
                    application_id: grant.application_id,
                    collection_id: grant.collection_id,
                    operations: grant.operations.clone(),
                    scope: grant.scope.clone(),
                    application_name: grant.application_name.clone(),
                    application_distribution: grant.application_distribution.clone(),
                    application_homepage: grant.application_homepage.clone(),
                    application_project_url: grant.application_project_url.clone(),
                    application_origin: grant.application_origin.clone(),
                    application_icon: grant.application_icon.clone(),
                    collection_name: grant.collection_name.clone(),
                    notification_criteria: grant.notification_criteria.clone(),
                    created_at: grant.created_at.clone(),
                    encryption: grant.encryption.clone(),
                })
                .collect::<Vec<_>>(),
        )
    }

    pub fn list_grants(&self) -> Result<Vec<GrantSummary>, ConnectError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, application_id, application_name, application_distribution,
                    application_homepage, application_project_url, application_origin,
                    application_icon, collection_id, collection_name, operations, scope,
                    created_at, encryption, notification_criteria
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
                row.get::<_, String>(14)?,
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
