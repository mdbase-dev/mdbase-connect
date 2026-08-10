use super::*;

#[derive(Debug, Clone, Serialize)]
pub struct HostedProtocolUsageEntry {
    pub account_id: Uuid,
    pub protocol_version: u32,
    pub sample_count: u64,
    pub first_seen_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HostedProtocolUsageReport {
    pub entries: Vec<HostedProtocolUsageEntry>,
    pub unbound_application_replicas: u64,
    pub v2_recovery_application_replicas: u64,
}

impl HostedProvider {
    pub async fn record_operation_protocol_usage(
        &self,
        collection_id: Uuid,
        protocol_version: u32,
    ) -> ApiResult<()> {
        let protocol_version = i32::try_from(protocol_version).map_err(|_| {
            ApiError::bad_request(
                "invalid_protocol_version",
                "The operation protocol version is outside the supported range.",
            )
        })?;
        sqlx::query(
            r#"INSERT INTO hosted_provider_protocol_usage
                 (account_id, protocol_version, sample_count)
               SELECT account_id, $2, 1
               FROM hosted_provider_collections
               WHERE id = $1 AND account_id IS NOT NULL
               ON CONFLICT (account_id, protocol_version)
               DO UPDATE SET
                 sample_count = hosted_provider_protocol_usage.sample_count + 1,
                 last_seen_at = now()"#,
        )
        .bind(collection_id)
        .bind(protocol_version)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn protocol_usage_report(&self) -> ApiResult<HostedProtocolUsageReport> {
        let rows = sqlx::query(
            r#"SELECT account_id, protocol_version, sample_count,
                      first_seen_at, last_seen_at
               FROM hosted_provider_protocol_usage
               ORDER BY account_id, protocol_version"#,
        )
        .fetch_all(&self.pool)
        .await?;
        let mut entries = Vec::with_capacity(rows.len());
        for row in rows {
            entries.push(HostedProtocolUsageEntry {
                account_id: row.get("account_id"),
                protocol_version: u32::try_from(row.get::<i32, _>("protocol_version"))
                    .map_err(|_| ApiError::internal("Stored protocol version is invalid."))?,
                sample_count: number(row.get::<i64, _>("sample_count"), "protocol usage count")?,
                first_seen_at: row.get("first_seen_at"),
                last_seen_at: row.get("last_seen_at"),
            });
        }
        let unbound_application_replicas = sqlx::query_scalar::<_, i64>(
            r#"SELECT count(*)
               FROM hosted_provider_replicas
               WHERE purpose = 'application'
                 AND revoked_at IS NULL
                 AND operation_transport_protocol IS NULL"#,
        )
        .fetch_one(&self.pool)
        .await?;
        let v2_recovery_application_replicas = sqlx::query_scalar::<_, i64>(
            r#"SELECT count(*)
               FROM hosted_provider_replicas
               WHERE purpose = 'application'
                 AND revoked_at IS NULL
                 AND 2 = ANY(operation_transport_recovery_protocols)"#,
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(HostedProtocolUsageReport {
            entries,
            unbound_application_replicas: number(
                unbound_application_replicas,
                "unbound application replica count",
            )?,
            v2_recovery_application_replicas: number(
                v2_recovery_application_replicas,
                "v2 recovery application replica count",
            )?,
        })
    }
}
