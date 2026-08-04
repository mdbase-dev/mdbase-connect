use super::*;
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DEFAULT_LEASE: Duration = Duration::from_secs(30);
const MAX_LEASE_MS: i64 = 60_000;
const DAY_MS: i64 = 24 * 60 * 60 * 1_000;
const ONLINE_RECOVERY_MS: i64 = 180 * DAY_MS;
const ACKNOWLEDGED_RECOVERY_MS: i64 = 30 * DAY_MS;
const TOMBSTONE_RETENTION_MS: i64 = 365 * DAY_MS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MutationJournalState {
    Claimed,
    Prepared,
    Applied,
    Completed,
    Acknowledged,
    Abandoned,
    OutcomeUnknown,
}

impl MutationJournalState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Claimed => "claimed",
            Self::Prepared => "prepared",
            Self::Applied => "applied",
            Self::Completed => "completed",
            Self::Acknowledged => "acknowledged",
            Self::Abandoned => "abandoned",
            Self::OutcomeUnknown => "outcome_unknown",
        }
    }

    fn parse(value: &str) -> Result<Self, ConnectError> {
        match value {
            "claimed" => Ok(Self::Claimed),
            "prepared" => Ok(Self::Prepared),
            "applied" => Ok(Self::Applied),
            "completed" => Ok(Self::Completed),
            "acknowledged" => Ok(Self::Acknowledged),
            "abandoned" => Ok(Self::Abandoned),
            "outcome_unknown" => Ok(Self::OutcomeUnknown),
            _ => Err(ConnectError::RegistryCorrupt {
                path: PathBuf::from("connector.sqlite"),
                detail: format!("mutation journal contains unknown state {value}"),
            }),
        }
    }

    fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Acknowledged | Self::Abandoned | Self::OutcomeUnknown
        )
    }
}

#[derive(Debug, Clone)]
pub struct MutationClaimRequest {
    pub application_installation_id: Uuid,
    pub grant_id: Uuid,
    pub request_id: Uuid,
    pub operation_kind: String,
    pub input_schema_version: u32,
    pub input_digest: String,
    pub grant_snapshot_digest: String,
    pub allow_new: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MutationLease {
    application_installation_id: Uuid,
    grant_id: Uuid,
    request_id: Uuid,
    input_digest: String,
    owner: Uuid,
    process_epoch: Uuid,
    pub fencing_generation: u64,
}

impl MutationLease {
    pub fn request_id(&self) -> Uuid {
        self.request_id
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MutationRecoveryData {
    pub state: MutationJournalState,
    pub prepared_data: Option<Value>,
    pub before_evidence: Option<Value>,
    pub after_evidence: Option<Value>,
    pub result_metadata: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MutationClaim {
    Owned {
        lease: MutationLease,
        recovery: Box<MutationRecoveryData>,
    },
    Live {
        fencing_generation: u64,
        retry_after_ms: u64,
    },
    Terminal {
        state: MutationJournalState,
        receipt: String,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MutationJournalDiagnostics {
    pub state_counts: std::collections::BTreeMap<String, u64>,
    pub oldest_unresolved_age_ms: Option<u64>,
    pub live_leases: u64,
    pub stale_leases: u64,
    pub tombstones: u64,
}

#[derive(Debug)]
struct StoredMutation {
    operation_kind: String,
    input_schema_version: u32,
    input_digest: String,
    state: MutationJournalState,
    process_epoch: Uuid,
    lease_expires_at_ms: i64,
    fencing_generation: u64,
    prepared_data: Option<String>,
    before_evidence: Option<String>,
    after_evidence: Option<String>,
    result_metadata: Option<String>,
    final_receipt: Option<String>,
}

impl CollectionRegistry {
    /// Return the applied registry schema version without exposing registry paths or content.
    pub fn schema_version(&self) -> Result<u32, ConnectError> {
        self.connection()?
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(ConnectError::from)
    }

    pub fn claim_mutation(
        &self,
        request: &MutationClaimRequest,
    ) -> Result<MutationClaim, ConnectError> {
        self.claim_mutation_with_lease(request, DEFAULT_LEASE)
    }

    fn claim_mutation_with_lease(
        &self,
        request: &MutationClaimRequest,
        lease_duration: Duration,
    ) -> Result<MutationClaim, ConnectError> {
        if request.input_schema_version == 0 || lease_duration.as_millis() == 0 {
            return Err(ConnectError::InvalidInput(
                "A mutation claim requires a versioned input and a non-zero lease.".to_string(),
            ));
        }
        let lease_ms = i64::try_from(lease_duration.as_millis())
            .unwrap_or(i64::MAX)
            .min(MAX_LEASE_MS);
        let now = now_ms();
        let _write_guard = self
            .encrypted_request_writes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        if let Some((operation, schema, digest)) = transaction
            .query_row(
                "SELECT operation_kind, input_schema_version, input_digest
                 FROM mutation_journal_tombstones
                 WHERE application_installation_id = ?1 AND grant_id = ?2 AND request_id = ?3",
                identity_params(request),
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, u32>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?
        {
            if operation != request.operation_kind
                || schema != request.input_schema_version
                || digest != request.input_digest
            {
                return Err(ConnectError::MutationRequestConflict {
                    request_id: request.request_id,
                });
            }
            return Err(ConnectError::MutationRecoveryExpired {
                request_id: request.request_id,
            });
        }

        let existing = load_mutation(&transaction, request)?;
        if let Some(existing) = existing {
            if existing.operation_kind != request.operation_kind
                || existing.input_schema_version != request.input_schema_version
                || existing.input_digest != request.input_digest
            {
                return Err(ConnectError::MutationRequestConflict {
                    request_id: request.request_id,
                });
            }
            if existing.state.is_terminal() {
                let receipt =
                    existing
                        .final_receipt
                        .ok_or_else(|| ConnectError::RegistryCorrupt {
                            path: self.db_path.clone(),
                            detail: "terminal mutation journal row has no receipt".to_string(),
                        })?;
                transaction.commit()?;
                return Ok(MutationClaim::Terminal {
                    state: existing.state,
                    receipt,
                });
            }

            let lease_is_live = existing.process_epoch == self.process_epoch
                && existing.lease_expires_at_ms > now
                && existing.lease_expires_at_ms <= now.saturating_add(MAX_LEASE_MS);
            if lease_is_live {
                let retry_after_ms = existing.lease_expires_at_ms.saturating_sub(now) as u64;
                transaction.commit()?;
                return Ok(MutationClaim::Live {
                    fencing_generation: existing.fencing_generation,
                    retry_after_ms,
                });
            }

            let owner = Uuid::new_v4();
            let generation = existing.fencing_generation.saturating_add(1);
            let updated = transaction.execute(
                "UPDATE mutation_journal
                 SET process_epoch = ?4, lease_owner = ?5, lease_expires_at_ms = ?6,
                     fencing_generation = ?7, updated_at_ms = ?8
                 WHERE application_installation_id = ?1 AND grant_id = ?2 AND request_id = ?3
                   AND input_digest = ?9 AND fencing_generation = ?10
                   AND state IN ('claimed', 'prepared', 'applied')",
                params![
                    request.application_installation_id.to_string(),
                    request.grant_id.to_string(),
                    request.request_id.to_string(),
                    self.process_epoch.to_string(),
                    owner.to_string(),
                    now.saturating_add(lease_ms),
                    generation,
                    now,
                    request.input_digest,
                    existing.fencing_generation,
                ],
            )?;
            if updated != 1 {
                return Err(ConnectError::MutationFenceLost {
                    request_id: request.request_id,
                });
            }
            transaction.commit()?;
            return Ok(MutationClaim::Owned {
                lease: MutationLease {
                    application_installation_id: request.application_installation_id,
                    grant_id: request.grant_id,
                    request_id: request.request_id,
                    input_digest: request.input_digest.clone(),
                    owner,
                    process_epoch: self.process_epoch,
                    fencing_generation: generation,
                },
                recovery: Box::new(recovery_data(existing)?),
            });
        }

        let owner = Uuid::new_v4();
        if !request.allow_new {
            return Err(ConnectError::AccessDenied(
                "The grant was revoked before this mutation was accepted.".to_string(),
            ));
        }
        transaction.execute(
            "INSERT INTO mutation_journal (
                application_installation_id, grant_id, request_id, operation_kind,
                input_schema_version, input_digest, state, process_epoch, lease_owner,
                lease_expires_at_ms, fencing_generation, grant_snapshot_digest,
                accepted_at_ms, updated_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'claimed', ?7, ?8, ?9, 1, ?10, ?11, ?11)",
            params![
                request.application_installation_id.to_string(),
                request.grant_id.to_string(),
                request.request_id.to_string(),
                request.operation_kind,
                request.input_schema_version,
                request.input_digest,
                self.process_epoch.to_string(),
                owner.to_string(),
                now.saturating_add(lease_ms),
                request.grant_snapshot_digest,
                now,
            ],
        )?;
        transaction.commit()?;
        Ok(MutationClaim::Owned {
            lease: MutationLease {
                application_installation_id: request.application_installation_id,
                grant_id: request.grant_id,
                request_id: request.request_id,
                input_digest: request.input_digest.clone(),
                owner,
                process_epoch: self.process_epoch,
                fencing_generation: 1,
            },
            recovery: Box::new(MutationRecoveryData {
                state: MutationJournalState::Claimed,
                prepared_data: None,
                before_evidence: None,
                after_evidence: None,
                result_metadata: None,
            }),
        })
    }

    pub fn prepare_mutation(
        &self,
        lease: &MutationLease,
        prepared_data: Option<&Value>,
        before_evidence: Option<&Value>,
    ) -> Result<(), ConnectError> {
        self.transition_owned(
            lease,
            "state = 'prepared', prepared_data = ?8, before_evidence = ?9",
            &[
                MutationJournalState::Claimed,
                MutationJournalState::Prepared,
            ],
            prepared_data,
            before_evidence,
        )
    }

    pub fn mark_mutation_applied(
        &self,
        lease: &MutationLease,
        after_evidence: Option<&Value>,
        result_metadata: Option<&Value>,
    ) -> Result<(), ConnectError> {
        self.transition_owned(
            lease,
            "state = 'applied', after_evidence = ?8, result_metadata = ?9",
            &[
                MutationJournalState::Prepared,
                MutationJournalState::Applied,
            ],
            after_evidence,
            result_metadata,
        )
    }

    fn transition_owned(
        &self,
        lease: &MutationLease,
        assignments: &str,
        allowed: &[MutationJournalState],
        first: Option<&Value>,
        second: Option<&Value>,
    ) -> Result<(), ConnectError> {
        let states = allowed
            .iter()
            .map(|state| format!("'{}'", state.as_str()))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "UPDATE mutation_journal SET {assignments}, updated_at_ms = ?7
             WHERE application_installation_id = ?1 AND grant_id = ?2 AND request_id = ?3
               AND input_digest = ?4 AND process_epoch = ?5 AND lease_owner = ?6
               AND fencing_generation = ?10 AND state IN ({states})"
        );
        let updated = self.connection()?.execute(
            &sql,
            params![
                lease.application_installation_id.to_string(),
                lease.grant_id.to_string(),
                lease.request_id.to_string(),
                lease.input_digest,
                lease.process_epoch.to_string(),
                lease.owner.to_string(),
                now_ms(),
                first.map(serde_json::to_string).transpose()?,
                second.map(serde_json::to_string).transpose()?,
                lease.fencing_generation,
            ],
        )?;
        require_fence(updated, lease.request_id)
    }

    pub fn complete_mutation(
        &self,
        lease: &MutationLease,
        receipt: &str,
        result_metadata: Option<&Value>,
    ) -> Result<(), ConnectError> {
        self.finish_mutation(
            lease,
            MutationJournalState::Completed,
            receipt,
            result_metadata,
            &[
                MutationJournalState::Claimed,
                MutationJournalState::Prepared,
                MutationJournalState::Applied,
            ],
        )
    }

    pub fn abandon_mutation(
        &self,
        lease: &MutationLease,
        receipt: &str,
        result_metadata: Option<&Value>,
    ) -> Result<(), ConnectError> {
        self.finish_mutation(
            lease,
            MutationJournalState::Abandoned,
            receipt,
            result_metadata,
            &[
                MutationJournalState::Claimed,
                MutationJournalState::Prepared,
            ],
        )
    }

    pub fn mark_mutation_outcome_unknown(
        &self,
        lease: &MutationLease,
        receipt: &str,
        diagnostics: Option<&Value>,
    ) -> Result<(), ConnectError> {
        self.finish_mutation(
            lease,
            MutationJournalState::OutcomeUnknown,
            receipt,
            diagnostics,
            &[
                MutationJournalState::Prepared,
                MutationJournalState::Applied,
            ],
        )
    }

    fn finish_mutation(
        &self,
        lease: &MutationLease,
        state: MutationJournalState,
        receipt: &str,
        result_metadata: Option<&Value>,
        allowed: &[MutationJournalState],
    ) -> Result<(), ConnectError> {
        let now = now_ms();
        let states = allowed
            .iter()
            .map(|state| format!("'{}'", state.as_str()))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "UPDATE mutation_journal
             SET state = ?8, result_metadata = COALESCE(?9, result_metadata),
                 final_receipt = ?10, receipt_digest = ?11,
                 completed_at_ms = ?7, updated_at_ms = ?7, lease_expires_at_ms = ?7
             WHERE application_installation_id = ?1 AND grant_id = ?2 AND request_id = ?3
               AND input_digest = ?4 AND process_epoch = ?5 AND lease_owner = ?6
               AND fencing_generation = ?12 AND state IN ({states})"
        );
        let updated = self.connection()?.execute(
            &sql,
            params![
                lease.application_installation_id.to_string(),
                lease.grant_id.to_string(),
                lease.request_id.to_string(),
                lease.input_digest,
                lease.process_epoch.to_string(),
                lease.owner.to_string(),
                now,
                state.as_str(),
                result_metadata.map(serde_json::to_string).transpose()?,
                receipt,
                receipt_digest(receipt.as_bytes()),
                lease.fencing_generation,
            ],
        )?;
        require_fence(updated, lease.request_id)
    }

    pub fn acknowledge_mutation(
        &self,
        application_installation_id: Uuid,
        grant_id: Uuid,
        request_id: Uuid,
        input_digest: &str,
    ) -> Result<(), ConnectError> {
        let now = now_ms();
        let updated = self.connection()?.execute(
            "UPDATE mutation_journal
             SET state = 'acknowledged', acknowledged_at_ms = ?5, updated_at_ms = ?5
             WHERE application_installation_id = ?1 AND grant_id = ?2 AND request_id = ?3
               AND input_digest = ?4 AND state = 'completed'",
            params![
                application_installation_id.to_string(),
                grant_id.to_string(),
                request_id.to_string(),
                input_digest,
                now,
            ],
        )?;
        if updated == 0 {
            let state: Option<String> = self
                .connection()?
                .query_row(
                    "SELECT state FROM mutation_journal
                     WHERE application_installation_id = ?1 AND grant_id = ?2
                       AND request_id = ?3 AND input_digest = ?4",
                    params![
                        application_installation_id.to_string(),
                        grant_id.to_string(),
                        request_id.to_string(),
                        input_digest,
                    ],
                    |row| row.get(0),
                )
                .optional()?;
            if state.as_deref() != Some("acknowledged") {
                return Err(ConnectError::MutationFenceLost { request_id });
            }
        }
        Ok(())
    }

    pub fn compact_mutation_journal(&self, at_ms: i64) -> Result<u64, ConnectError> {
        let _write_guard = self
            .encrypted_request_writes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let compacted = transaction.execute(
            "INSERT INTO mutation_journal_tombstones (
                application_installation_id, grant_id, request_id, operation_kind,
                input_schema_version, input_digest, terminal_state, receipt_digest,
                accepted_at_ms, completed_at_ms, tombstoned_at_ms, expires_at_ms
             )
             SELECT application_installation_id, grant_id, request_id, operation_kind,
                    input_schema_version, input_digest, state, receipt_digest,
                    accepted_at_ms, completed_at_ms, ?1, ?2
             FROM mutation_journal
             WHERE state IN ('completed', 'acknowledged', 'abandoned')
               AND completed_at_ms <= ?3
               AND (acknowledged_at_ms IS NULL OR acknowledged_at_ms <= ?4)
             ON CONFLICT(application_installation_id, grant_id, request_id) DO NOTHING",
            params![
                at_ms,
                at_ms.saturating_add(TOMBSTONE_RETENTION_MS),
                at_ms.saturating_sub(ONLINE_RECOVERY_MS),
                at_ms.saturating_sub(ACKNOWLEDGED_RECOVERY_MS),
            ],
        )? as u64;
        transaction.execute(
            "DELETE FROM mutation_journal
             WHERE EXISTS (
               SELECT 1 FROM mutation_journal_tombstones tombstone
               WHERE tombstone.application_installation_id = mutation_journal.application_installation_id
                 AND tombstone.grant_id = mutation_journal.grant_id
                 AND tombstone.request_id = mutation_journal.request_id
             )",
            [],
        )?;
        transaction.commit()?;
        Ok(compacted)
    }

    pub fn mutation_journal_diagnostics(&self) -> Result<MutationJournalDiagnostics, ConnectError> {
        let connection = self.connection()?;
        let now = now_ms();
        let mut statement = connection.prepare(
            "SELECT state, COUNT(*) FROM mutation_journal GROUP BY state ORDER BY state",
        )?;
        let state_counts = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
            })?
            .collect::<Result<std::collections::BTreeMap<_, _>, _>>()?;
        let oldest: Option<i64> = connection.query_row(
            "SELECT MIN(accepted_at_ms) FROM mutation_journal
             WHERE state IN ('claimed', 'prepared', 'applied', 'outcome_unknown')",
            [],
            |row| row.get(0),
        )?;
        let live_leases = connection.query_row(
            "SELECT COUNT(*) FROM mutation_journal
             WHERE state IN ('claimed', 'prepared', 'applied')
               AND process_epoch = ?1 AND lease_expires_at_ms > ?2
               AND lease_expires_at_ms <= ?3",
            params![
                self.process_epoch.to_string(),
                now,
                now.saturating_add(MAX_LEASE_MS)
            ],
            |row| row.get(0),
        )?;
        let stale_leases = connection.query_row(
            "SELECT COUNT(*) FROM mutation_journal
             WHERE state IN ('claimed', 'prepared', 'applied')
               AND NOT (process_epoch = ?1 AND lease_expires_at_ms > ?2
                        AND lease_expires_at_ms <= ?3)",
            params![
                self.process_epoch.to_string(),
                now,
                now.saturating_add(MAX_LEASE_MS)
            ],
            |row| row.get(0),
        )?;
        let tombstones = connection.query_row(
            "SELECT COUNT(*) FROM mutation_journal_tombstones",
            [],
            |row| row.get(0),
        )?;
        Ok(MutationJournalDiagnostics {
            state_counts,
            oldest_unresolved_age_ms: oldest.map(|value| now.saturating_sub(value) as u64),
            live_leases,
            stale_leases,
            tombstones,
        })
    }
}

fn identity_params(request: &MutationClaimRequest) -> [String; 3] {
    [
        request.application_installation_id.to_string(),
        request.grant_id.to_string(),
        request.request_id.to_string(),
    ]
}

fn load_mutation(
    connection: &Connection,
    request: &MutationClaimRequest,
) -> Result<Option<StoredMutation>, ConnectError> {
    connection
        .query_row(
            "SELECT operation_kind, input_schema_version, input_digest, state,
                    process_epoch, lease_expires_at_ms, fencing_generation,
                    prepared_data, before_evidence, after_evidence,
                    result_metadata, final_receipt
             FROM mutation_journal
             WHERE application_installation_id = ?1 AND grant_id = ?2 AND request_id = ?3",
            identity_params(request),
            |row| {
                let state = row.get::<_, String>(3)?;
                let process_epoch = row.get::<_, String>(4)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, u32>(1)?,
                    row.get::<_, String>(2)?,
                    state,
                    process_epoch,
                    row.get::<_, i64>(5)?,
                    row.get::<_, u64>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, Option<String>>(11)?,
                ))
            },
        )
        .optional()?
        .map(
            |(
                operation_kind,
                input_schema_version,
                input_digest,
                state,
                process_epoch,
                lease_expires_at_ms,
                fencing_generation,
                prepared_data,
                before_evidence,
                after_evidence,
                result_metadata,
                final_receipt,
            )| {
                Ok(StoredMutation {
                    operation_kind,
                    input_schema_version,
                    input_digest,
                    state: MutationJournalState::parse(&state)?,
                    process_epoch: Uuid::parse_str(&process_epoch).map_err(|error| {
                        ConnectError::RegistryCorrupt {
                            path: PathBuf::from("connector.sqlite"),
                            detail: format!("invalid mutation process epoch: {error}"),
                        }
                    })?,
                    lease_expires_at_ms,
                    fencing_generation,
                    prepared_data,
                    before_evidence,
                    after_evidence,
                    result_metadata,
                    final_receipt,
                })
            },
        )
        .transpose()
}

fn recovery_data(stored: StoredMutation) -> Result<MutationRecoveryData, ConnectError> {
    Ok(MutationRecoveryData {
        state: stored.state,
        prepared_data: parse_optional_json(stored.prepared_data)?,
        before_evidence: parse_optional_json(stored.before_evidence)?,
        after_evidence: parse_optional_json(stored.after_evidence)?,
        result_metadata: parse_optional_json(stored.result_metadata)?,
    })
}

fn parse_optional_json(value: Option<String>) -> Result<Option<Value>, ConnectError> {
    value
        .map(|value| serde_json::from_str(&value).map_err(ConnectError::from))
        .transpose()
}

fn require_fence(updated: usize, request_id: Uuid) -> Result<(), ConnectError> {
    if updated == 1 {
        Ok(())
    } else {
        Err(ConnectError::MutationFenceLost { request_id })
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| i64::try_from(value.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn receipt_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests;
