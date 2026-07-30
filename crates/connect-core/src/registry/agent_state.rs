use super::*;

impl CollectionRegistry {
    pub fn set_paused(&self, paused: bool) -> Result<(), ConnectError> {
        self.connection()?.execute(
            "INSERT INTO settings (key, value) VALUES ('access_paused', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
            [if paused { "true" } else { "false" }],
        )?;
        Ok(())
    }

    pub fn paused(&self) -> Result<bool, ConnectError> {
        let value = self
            .connection()?
            .query_row(
                "SELECT value FROM settings WHERE key = 'access_paused'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(value.as_deref() == Some("true"))
    }

    pub fn next_inventory_revision(&self) -> Result<u64, ConnectError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = transaction
            .query_row(
                "SELECT value FROM settings WHERE key = 'inventory_revision'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let next = current.saturating_add(1);
        transaction.execute(
            "INSERT INTO settings (key, value) VALUES ('inventory_revision', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
            [next.to_string()],
        )?;
        transaction.commit()?;
        Ok(next)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_activity(
        &self,
        application_id: Uuid,
        application_name: &str,
        collection_id: Uuid,
        collection_name: &str,
        operation: &str,
        outcome: &str,
        detail: Option<&str>,
    ) -> Result<(), ConnectError> {
        self.connection()?.execute(
            "INSERT INTO activity
               (id, application_id, application_name, collection_id, collection_name,
                operation, outcome, detail)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                Uuid::new_v4().to_string(),
                application_id.to_string(),
                application_name,
                collection_id.to_string(),
                collection_name,
                operation,
                outcome,
                detail,
            ],
        )?;
        Ok(())
    }

    pub fn list_activity(&self, limit: usize) -> Result<Vec<ActivityEntry>, ConnectError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, application_id, application_name, collection_id, collection_name,
                    operation, outcome, detail, created_at
             FROM activity ORDER BY created_at DESC, rowid DESC LIMIT ?1",
        )?;
        let rows = statement.query_map([limit.clamp(1, 500) as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, String>(8)?,
            ))
        })?;
        rows.map(|row| {
            let (
                id,
                application_id,
                application_name,
                collection_id,
                collection_name,
                operation,
                outcome,
                detail,
                created_at,
            ) = row?;
            Ok(ActivityEntry {
                id: parse_registry_uuid(&id)?,
                application_id: parse_registry_uuid(&application_id)?,
                application_name,
                collection_id: parse_registry_uuid(&collection_id)?,
                collection_name,
                operation,
                outcome,
                detail,
                created_at,
            })
        })
        .collect()
    }
}
