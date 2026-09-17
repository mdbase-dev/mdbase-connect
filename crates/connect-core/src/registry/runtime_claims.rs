use super::*;
use mdbase::runtime::{DurableCommitState, HostClaimId};

impl CollectionRegistry {
    /// Local administration only. Empty selections are a read-only preview.
    /// Old journals do not prove local ownership: explicit selection attests
    /// that the user has independently verified these were local CLI writes.
    pub fn recover_runtime_claims(
        &self,
        id: Uuid,
        commits: &[String],
        confirm_local: bool,
    ) -> Result<Value, ConnectError> {
        if !commits.is_empty() && !confirm_local {
            return Err(ConnectError::InvalidInput("Preview first, then select --commit IDs with --confirm-local only for independently verified local writes.".into()));
        }
        let registered = self.get(id)?;
        assert_local_authority_folder(Path::new(&registered.path))?;
        let sync = crate::LocalSyncStore::for_registry(self);
        sync.assert_authority_available(id)?;
        if !commits.is_empty() {
            sync.assert_mutation_allowed(id)?;
        }
        let executor = self.executor_for(&registered)?;
        let context = operation_context(&mdbase::OperationCancellation::new());
        executor.with_mutation(&context, |runtime| {
            let runtime = require_runtime(runtime)?;
            let claims = runtime.inspect_runtime_claims(&context)?;
            let protected = {
                let connection = self.authority.connection()?;
                let mut statement = connection.prepare("SELECT json_extract(prepared_data, '$.host_claim') FROM mutation_journal WHERE json_extract(prepared_data, '$.host_claim') IS NOT NULL")?;
                let values = statement.query_map([], |row| row.get::<_, String>(0))?.collect::<Result<std::collections::HashSet<_>, _>>()?;
                values
            };
            let eligible = |claim: &mdbase::runtime::RuntimeClaimInspection| {
                claim.phase == "committed" && claim.event_acked && claim.current_revisions_match && !protected.contains(claim.claim.as_str())
            };
            // Validate the entire selection before recording or acknowledging any.
            let mut selected = Vec::new();
            let unique = commits.iter().collect::<std::collections::BTreeSet<_>>();
            for commit in unique {
                let claim = claims.iter().find(|claim| claim.commit_id.as_str() == commit).ok_or_else(|| ConnectError::InvalidInput(format!("Transaction {commit} is not retained; preview again.")))?;
                if !eligible(claim) {
                    return Err(ConnectError::InvalidInput(format!("Transaction {commit} is protected, unsettled, or no longer matches its committed revisions; it was not acknowledged.")));
                }
                selected.push(claim);
            }
            let mut recovered = Vec::new();
            for claim in selected {
                let commit = claim.commit_id.as_str().to_string();
                let audit_commit = commit.clone();
                self.authority.write(AuthorityWritePriority::Recovery, move |connection| {
                    connection.execute("INSERT INTO runtime_claim_recoveries (collection_id, commit_id, selected_at_ms) VALUES (?1, ?2, ?3) ON CONFLICT(collection_id, commit_id) DO NOTHING",
                        params![id.to_string(), audit_commit, authority_store::current_time_ms()])?;
                    Ok(())
                })?;
                if !runtime.acknowledge_verified_runtime_claim(&claim.claim, &context)? {
                    return Err(ConnectError::InvalidInput(format!("Transaction {commit} changed during recovery; preview again. Earlier acknowledgements are recorded in the recovery audit.")));
                }
                let audit_commit = commit.clone();
                self.authority.write(AuthorityWritePriority::Recovery, move |connection| {
                    connection.execute("UPDATE runtime_claim_recoveries SET completed_at_ms = ?3 WHERE collection_id = ?1 AND commit_id = ?2",
                        params![id.to_string(), audit_commit, authority_store::current_time_ms()])?;
                    Ok(())
                })?;
                recovered.push(commit);
            }
            let transactions = claims.iter().map(|claim| {
                let mut value = serde_json::to_value(claim).expect("claim inspection serializes");
                value["application_owned"] = json!(protected.contains(claim.claim.as_str()));
                value["eligible_for_confirmed_local_recovery"] = json!(eligible(claim));
                value
            }).collect::<Vec<_>>();
            let audit = {
                let connection = self.authority.connection()?;
                let mut statement = connection.prepare("SELECT commit_id, selected_at_ms, completed_at_ms FROM runtime_claim_recoveries WHERE collection_id = ?1 ORDER BY selected_at_ms, commit_id")?;
                let rows = statement.query_map([id.to_string()], |row| Ok(json!({"commit_id": row.get::<_, String>(0)?, "selected_at_ms": row.get::<_, i64>(1)?, "completed_at_ms": row.get::<_, Option<i64>>(2)?})))?.collect::<Result<Vec<_>, _>>()?;
                rows
            };
            Ok(json!({
                "collection_id": id, "transactions_before": transactions, "recovered": recovered, "audit": audit,
                "guidance": "Only select transactions independently verified as local CLI writes. Application-owned, unsettled, and revision-mismatched transactions are protected. Recovery acknowledges completion; it does not modify record contents."
            }))
        })
    }

    pub(super) fn create_local_runtime_claim(&self, id: Uuid) -> Result<HostClaimId, ConnectError> {
        let claim = HostClaimId::generate();
        let stored = claim.as_str().to_owned();
        self.authority
            .write(AuthorityWritePriority::Admission, move |connection| {
                connection.execute(
                    "INSERT INTO local_runtime_claims (collection_id, host_claim) VALUES (?1, ?2)",
                    params![id.to_string(), stored],
                )?;
                Ok(())
            })?;
        Ok(claim)
    }

    /// Caller holds the collection mutation gate. A previous local invocation
    /// cannot still be preparing here; a commit worker may still be settling.
    pub(super) fn settle_local_runtime_claims(
        &self,
        id: Uuid,
        runtime: &FilesystemRuntime,
    ) -> Result<(), ConnectError> {
        let claims = {
            let connection = self.authority.connection()?;
            let mut statement = connection
                .prepare("SELECT host_claim FROM local_runtime_claims WHERE collection_id = ?1")?;
            let claims = statement
                .query_map([id.to_string()], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            claims
        };
        let context = operation_context(&mdbase::OperationCancellation::new());
        for stored in claims {
            let claim: HostClaimId = serde_json::from_value(json!(stored))?;
            if let Some((commit_id, state)) = runtime.resolve_claim(&claim, &context)? {
                match state {
                    DurableCommitState::Prepared => {
                        let prepared =
                            runtime.attach_prepared(&claim, &context)?.ok_or_else(|| {
                                ConnectError::Provider(
                                    mdbase::runtime::ProviderError::Transaction {
                                        code: "prepared_claim_missing",
                                        message:
                                            "Local prepared claim disappeared during settlement"
                                                .into(),
                                    },
                                )
                            })?;
                        if !matches!(
                            runtime.cancel(&prepared, &context)?,
                            mdbase::runtime::CancelOutcome::CancelledBeforeCommit
                        ) {
                            return Err(ConnectError::Provider(mdbase::runtime::ProviderError::Transaction {
                                code: "local_claim_state_changed",
                                message: "Local prepared claim changed while holding the mutation gate".into(),
                            }));
                        }
                    }
                    DurableCommitState::Committing | DurableCommitState::NeedsManualRecovery => {
                        continue
                    }
                    DurableCommitState::Committed { .. }
                    | DurableCommitState::RejectedBeforeCommit { .. }
                    | DurableCommitState::CancelledBeforeCommit => {}
                }
                runtime.ack_commit_resolution(&commit_id, &context)?;
            }
            self.authority.write(AuthorityWritePriority::Recovery, move |connection| {
                connection.execute("DELETE FROM local_runtime_claims WHERE collection_id = ?1 AND host_claim = ?2", params![id.to_string(), stored])?;
                Ok(())
            })?;
        }
        Ok(())
    }
}
