//! Exact receipted rollback binding and storage-owner qualification.
use super::*;

/// Exact provider-local rollback binding. Driver/action IDs are correlation,
/// never authority; the caller must separately qualify native rollback guards.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyRollbackRequest {
    pub owner_account_id: Uuid,
    pub provider_migration_id: Uuid,
    pub authority_epoch: i64,
    pub fixed_head: i64,
    pub driver_id: Uuid,
    pub action_id: Uuid,
    pub replica_ids: Vec<Uuid>,
}

/// Persisted in the same transaction as restore + active. Historical evidence
/// is not a fresh permission, and active state alone is never a receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LegacyRollbackReceipt {
    pub collection_id: Uuid,
    pub binding: LegacyRollbackRequest,
    pub restored_ids: Vec<Uuid>,
    pub recorded_at: DateTime<Utc>,
}

/// V2 preserves the Connect-owner correlation while naming the physical
/// provider storage account separately. Neither identity is caller authority.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyRollbackEnvelope {
    pub provider_account_id: Uuid,
    pub binding: LegacyRollbackRequest,
}

impl HostedProvider {
    /// V1 compatibility for deployed predecessor callers: identity-only.
    pub async fn rollback_legacy_migration(
        &self,
        collection_id: Uuid,
        input: &LegacyRollbackRequest,
    ) -> ApiResult<LegacyRollbackReceipt> {
        self.rollback_legacy_migration_v2(
            collection_id,
            &LegacyRollbackEnvelope {
                provider_account_id: input.owner_account_id,
                binding: input.clone(),
            },
        )
        .await
    }

    /// V1 receipt compatibility; never relabel a legacy storage owner.
    pub async fn legacy_migration_rollback_receipt(
        &self,
        collection_id: Uuid,
        input: &LegacyRollbackRequest,
    ) -> ApiResult<LegacyRollbackReceipt> {
        self.legacy_migration_rollback_receipt_v2(
            collection_id,
            &LegacyRollbackEnvelope {
                provider_account_id: input.owner_account_id,
                binding: input.clone(),
            },
        )
        .await
    }

    /// Provider-local atomic pre-cutover rollback. The CP/native adapter must
    /// authenticate its actual saved RollingBack/pending action and settle any
    /// competing target effects BEFORE dispatch; this receipt proves none of that.
    pub async fn rollback_legacy_migration_v2(
        &self,
        collection_id: Uuid,
        envelope: &LegacyRollbackEnvelope,
    ) -> ApiResult<LegacyRollbackReceipt> {
        let input = canonical_rollback_envelope(envelope)?;
        let (_, receipt) = self
            .transition_legacy_migration_state(
                collection_id,
                "active",
                None,
                false,
                MigrationRestore::Receipted(&input, envelope.provider_account_id),
            )
            .await?;
        receipt.ok_or_else(|| ApiError::internal("Atomic rollback did not produce its receipt."))
    }

    /// Read-only lost-response settlement. Missing or superseded receipts refuse;
    /// this NEVER retries a restore or interprets an active source as success.
    pub async fn legacy_migration_rollback_receipt_v2(
        &self,
        collection_id: Uuid,
        envelope: &LegacyRollbackEnvelope,
    ) -> ApiResult<LegacyRollbackReceipt> {
        let input = canonical_rollback_envelope(envelope)?;
        let mut transaction = self.pool.begin().await?;
        let row = lock_migration_collection(&mut transaction, collection_id).await?;
        check_rollback_owner(&row, &input, envelope.provider_account_id)?;
        let receipt = existing_rollback_receipt(
            &mut transaction,
            collection_id,
            &row,
            &input,
            envelope.provider_account_id,
        )
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "legacy_rollback_receipt_unknown",
                "No exact atomic rollback receipt exists.",
            )
        })?;
        transaction.commit().await?;
        Ok(receipt)
    }
}

pub(super) fn rollback_binding_conflict() -> ApiError {
    ApiError::conflict(
        "legacy_rollback_binding_conflict",
        "The provider source or rollback receipt does not match the exact pending action.",
    )
}

fn canonical_rollback_envelope(
    envelope: &LegacyRollbackEnvelope,
) -> ApiResult<LegacyRollbackRequest> {
    if envelope.provider_account_id.is_nil() {
        return Err(ApiError::bad_request(
            "legacy_rollback_binding_invalid",
            "A physical storage owner is required.",
        ));
    }
    canonical_rollback_request(&envelope.binding)
}

fn canonical_rollback_request(input: &LegacyRollbackRequest) -> ApiResult<LegacyRollbackRequest> {
    check_replica_ids(&input.replica_ids)?;
    let mut input = input.clone();
    input.replica_ids.sort_unstable();
    if input.authority_epoch <= 0
        || input.fixed_head < 0
        || [
            input.owner_account_id,
            input.provider_migration_id,
            input.driver_id,
            input.action_id,
        ]
        .iter()
        .any(Uuid::is_nil)
        || input.replica_ids.iter().any(Uuid::is_nil)
        || input.replica_ids.windows(2).any(|ids| ids[0] == ids[1])
    {
        return Err(ApiError::bad_request(
            "legacy_rollback_binding_invalid",
            "Rollback needs a valid exact source and replica scope.",
        ));
    }
    Ok(input)
}

pub(super) fn check_rollback_owner(
    row: &PgRow,
    input: &LegacyRollbackRequest,
    storage_owner: Uuid,
) -> ApiResult<()> {
    if row.get::<Option<Uuid>, _>("account_id") != Some(storage_owner)
        || row.get::<i64, _>("authority_epoch") != input.authority_epoch
    {
        return Err(rollback_binding_conflict());
    }
    Ok(())
}

pub(super) async fn existing_rollback_receipt(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    source: &PgRow,
    input: &LegacyRollbackRequest,
    storage_owner: Uuid,
) -> ApiResult<Option<LegacyRollbackReceipt>> {
    let Some(row) = sqlx::query(
        "SELECT * FROM hosted_provider_legacy_rollback_receipts WHERE collection_id = $1 AND provider_migration_id = $2",
    ).bind(collection_id).bind(input.provider_migration_id)
        .fetch_optional(&mut **transaction).await? else { return Ok(None) };
    let binding = LegacyRollbackRequest {
        owner_account_id: row.get("owner_account_id"),
        provider_migration_id: row.get("provider_migration_id"),
        authority_epoch: row.get("authority_epoch"),
        fixed_head: row.get("fixed_head"),
        driver_id: row.get("driver_id"),
        action_id: row.get("action_id"),
        replica_ids: row.get("requested_ids"),
    };
    // Old writes may legitimately have advanced the head after the atomic
    // rollback. They do not invalidate its historical receipt; a NEW migration
    // does, even if that later run has already returned to active.
    // NULL identifies an actual legacy v1 row. Its original owner was the
    // storage owner; it is readable only under that identical owner, never
    // translated into a different Connect user's receipt.
    let recorded_storage = row
        .get::<Option<Uuid>, _>("provider_account_id")
        .unwrap_or(binding.owner_account_id);
    if recorded_storage != storage_owner
        || binding != *input
        || row
            .get::<Option<DateTime<Utc>>, _>("superseded_at")
            .is_some()
        || source.get::<String, _>("state") != "active"
        || source
            .get::<Option<Uuid>, _>("legacy_migration_id")
            .is_some()
        || source
            .get::<Option<DateTime<Utc>>, _>("legacy_migration_started_at")
            .is_some()
        || source
            .get::<Option<DateTime<Utc>>, _>("legacy_retain_until")
            .is_some()
        || source.get::<i64, _>("head") < input.fixed_head
    {
        return Err(rollback_binding_conflict());
    }
    Ok(Some(LegacyRollbackReceipt {
        collection_id,
        binding,
        restored_ids: row.get("restored_ids"),
        recorded_at: row.get("recorded_at"),
    }))
}

pub(super) async fn record_rollback_receipt(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    input: &LegacyRollbackRequest,
    restored: &[Uuid],
    storage_owner: Uuid,
) -> ApiResult<LegacyRollbackReceipt> {
    let mut restored_ids = restored.to_vec();
    restored_ids.sort_unstable();
    let recorded_at = sqlx::query_scalar(
        r#"INSERT INTO hosted_provider_legacy_rollback_receipts
           (collection_id, provider_migration_id, owner_account_id, authority_epoch,
            fixed_head, driver_id, action_id, requested_ids, restored_ids, provider_account_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT DO NOTHING RETURNING recorded_at"#,
    )
    .bind(collection_id)
    .bind(input.provider_migration_id)
    .bind(input.owner_account_id)
    .bind(input.authority_epoch)
    .bind(input.fixed_head)
    .bind(input.driver_id)
    .bind(input.action_id)
    .bind(&input.replica_ids)
    .bind(&restored_ids)
    .bind(storage_owner)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or_else(rollback_binding_conflict)?;
    Ok(LegacyRollbackReceipt {
        collection_id,
        binding: input.clone(),
        restored_ids,
        recorded_at,
    })
}

#[cfg(test)]
mod rollback_binding_tests {
    use super::*;

    fn input() -> LegacyRollbackRequest {
        LegacyRollbackRequest {
            owner_account_id: Uuid::new_v4(),
            provider_migration_id: Uuid::new_v4(),
            authority_epoch: 1,
            fixed_head: 0,
            driver_id: Uuid::new_v4(),
            action_id: Uuid::new_v4(),
            replica_ids: vec![Uuid::new_v4(), Uuid::new_v4()],
        }
    }

    #[test]
    fn canonical_scope_is_a_bounded_distinct_nonzero_set() {
        let original = input();
        let mut reversed = original.clone();
        reversed.replica_ids.reverse();
        assert_eq!(
            canonical_rollback_request(&original).unwrap(),
            canonical_rollback_request(&reversed).unwrap()
        );
        let mut duplicate = original.clone();
        duplicate.replica_ids.push(duplicate.replica_ids[0]);
        assert_eq!(
            canonical_rollback_request(&duplicate).unwrap_err().code,
            "legacy_rollback_binding_invalid"
        );
        let mut oversized = original.clone();
        oversized.replica_ids = (0..1001).map(|_| Uuid::new_v4()).collect();
        assert_eq!(
            canonical_rollback_request(&oversized).unwrap_err().code,
            "legacy_replica_limit"
        );
        let mut empty = original;
        empty.replica_ids.clear();
        assert!(canonical_rollback_request(&empty).is_ok());
    }

    #[test]
    fn invalid_counters_and_nil_identities_are_not_bindings() {
        for field in [
            "owner", "provider", "driver", "action", "replica", "epoch", "head",
        ] {
            let mut wrong = input();
            match field {
                "owner" => wrong.owner_account_id = Uuid::nil(),
                "provider" => wrong.provider_migration_id = Uuid::nil(),
                "driver" => wrong.driver_id = Uuid::nil(),
                "action" => wrong.action_id = Uuid::nil(),
                "replica" => wrong.replica_ids[0] = Uuid::nil(),
                "epoch" => wrong.authority_epoch = 0,
                "head" => wrong.fixed_head = -1,
                _ => unreachable!(),
            }
            assert_eq!(
                canonical_rollback_request(&wrong).unwrap_err().code,
                "legacy_rollback_binding_invalid",
                "{field}"
            );
        }
    }

    #[test]
    fn flags_do_not_create_rollback_authority() {
        for field in ["reverse_verified", "verified", "ready", "pre_cutover"] {
            let mut value = serde_json::to_value(input()).unwrap();
            value[field] = serde_json::json!(true);
            assert!(
                serde_json::from_value::<LegacyRollbackRequest>(value).is_err(),
                "{field}"
            );
        }
    }
}
