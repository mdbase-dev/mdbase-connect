use super::*;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RemotePolicyAuthorityMode {
    LeaseV1,
    LegacyAckV0,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemotePolicyAuthority {
    pub mode: RemotePolicyAuthorityMode,
    pub revision: String,
    pub sequence: u64,
    pub connector_id: Option<Uuid>,
    pub authority_digest: Option<String>,
    pub lease_expires_at_ms: i64,
    pub observed_at_ms: i64,
    pub fresh: bool,
}

/// Digest the exact normalized policy authority represented by the wire type.
/// Array order is normalized by grant ID; serde's GrantPolicy representation
/// decides which optional fields are present, identically to snapshot hashing.
pub fn canonical_policy_authority_digest(
    connector_id: Uuid,
    grants: &[GrantPolicy],
) -> Result<String, ConnectError> {
    let mut grants = grants.to_vec();
    grants.sort_by_key(|grant| grant.id);
    let body = serde_json::json!({
        "connector_id": connector_id,
        "grants": grants,
    });
    let canonical = serde_jcs::to_vec(&body)?;
    Ok(format!("sha256:{:x}", Sha256::digest(canonical)))
}

#[derive(Debug)]
struct CurrentPolicySnapshot {
    sequence: u64,
    revision: String,
    connector_id: Option<String>,
}

fn validate_policy_snapshot(
    connector_id: Option<Uuid>,
    revision: &str,
    sequence: u64,
    lease_ms: &std::ops::Range<i64>,
    grants: &[GrantPolicy],
    now_ms: i64,
    current: &CurrentPolicySnapshot,
) -> Result<(), ConnectError> {
    const MAX_POLICY_SEQUENCE: u64 = 9_007_199_254_740_991;
    const MAX_POLICY_LEASE_MS: i64 = 60_000;
    const CLOCK_SKEW_ALLOWANCE_MS: i64 = 5_000;
    let lease_issued_at_ms = lease_ms.start;
    let lease_expires_at_ms = lease_ms.end;
    if sequence > MAX_POLICY_SEQUENCE
        || lease_issued_at_ms < 0
        || lease_issued_at_ms > now_ms.saturating_add(CLOCK_SKEW_ALLOWANCE_MS)
        || lease_expires_at_ms <= lease_issued_at_ms
        || lease_expires_at_ms.saturating_sub(lease_issued_at_ms) > MAX_POLICY_LEASE_MS
        || lease_expires_at_ms > now_ms.saturating_add(MAX_POLICY_LEASE_MS)
    {
        return Err(ConnectError::InvalidInput(
            "Invalid policy freshness lease.".to_string(),
        ));
    }
    for grant in grants {
        validate_grant_application_authorization(grant)?;
        if connector_id.is_some_and(|expected| {
            grant
                .encryption
                .as_ref()
                .is_none_or(|encryption| encryption.connector_id != expected)
        }) {
            return Err(ConnectError::InvalidInput(
                "Policy grant authority does not match the pinned connector.".to_string(),
            ));
        }
    }
    let connector_id = connector_id.map(|value| value.to_string());
    if let (Some(expected), Some(received)) = (&current.connector_id, &connector_id) {
        if expected != received {
            return Err(ConnectError::InvalidInput(
                "Policy snapshot connector does not match the pinned authority.".to_string(),
            ));
        }
    }
    // Legacy beta snapshots and lease snapshots use independent sequence
    // domains. The first authenticated lease pins the connector and starts its
    // sequence comparison at that lease, regardless of the legacy counter.
    if (current.connector_id.is_some() || connector_id.is_none())
        && (sequence < current.sequence
            || (sequence == current.sequence && revision != current.revision))
    {
        return Err(ConnectError::InvalidInput(
            "Stale or conflicting policy snapshot.".to_string(),
        ));
    }
    Ok(())
}

impl CollectionRegistry {
    pub fn replace_grants(&self, grants: &[GrantPolicy]) -> Result<(), ConnectError> {
        let digest = Sha256::digest(serde_json::to_vec(grants)?)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let sequence = self.authority.connection()?.query_row(
            "SELECT sequence FROM policy_state WHERE singleton = 1",
            [],
            |row| row.get::<_, u64>(0),
        )? + 1;
        let issued_at_ms = super::authority_store::current_time_ms();
        self.replace_grants_at_revision(
            &format!("local:{digest}"),
            sequence,
            issued_at_ms,
            issued_at_ms + 60_000,
            grants,
        )
    }

    /// Test/local compatibility helper. Authenticated relay snapshots must use
    /// `replace_remote_grants_at_revision` so connector continuity is pinned.
    pub fn replace_grants_at_revision(
        &self,
        revision: &str,
        sequence: u64,
        lease_issued_at_ms: i64,
        lease_expires_at_ms: i64,
        grants: &[GrantPolicy],
    ) -> Result<(), ConnectError> {
        self.replace_grants_at_revision_at(
            None,
            revision,
            sequence,
            lease_issued_at_ms..lease_expires_at_ms,
            grants,
            super::authority_store::current_time_ms(),
        )
    }

    pub fn replace_legacy_remote_grants_at_revision(
        &self,
        revision: &str,
        grants: &[GrantPolicy],
    ) -> Result<(), ConnectError> {
        let (sequence, connector_id) = self.authority.connection()?.query_row(
            "SELECT sequence, connector_id FROM policy_state WHERE singleton = 1",
            [],
            |row| Ok((row.get::<_, u64>(0)?, row.get::<_, Option<String>>(1)?)),
        )?;
        if connector_id.is_some() {
            return Err(ConnectError::InvalidInput(
                "Legacy policy is forbidden after lease authority was pinned.".to_string(),
            ));
        }
        let now = super::authority_store::current_time_ms();
        self.replace_grants_at_revision_at_inner(
            None,
            revision,
            sequence.checked_add(1).ok_or_else(|| {
                ConnectError::InvalidInput("The local policy sequence is exhausted.".to_string())
            })?,
            now..now.saturating_add(60_000),
            grants,
            now,
            true,
        )
    }

    pub fn replace_remote_grants_at_revision(
        &self,
        connector_id: Uuid,
        revision: &str,
        sequence: u64,
        lease_issued_at_ms: i64,
        lease_expires_at_ms: i64,
        grants: &[GrantPolicy],
    ) -> Result<(), ConnectError> {
        self.replace_grants_at_revision_at(
            Some(connector_id),
            revision,
            sequence,
            lease_issued_at_ms..lease_expires_at_ms,
            grants,
            super::authority_store::current_time_ms(),
        )
    }

    /// Run the exact durable snapshot checks without mutating policy state.
    /// The write transaction repeats these checks against its authoritative
    /// current row, so this early rejection is only a side-effect guard.
    pub fn prevalidate_remote_grants_at_revision(
        &self,
        connector_id: Uuid,
        revision: &str,
        sequence: u64,
        lease_issued_at_ms: i64,
        lease_expires_at_ms: i64,
        grants: &[GrantPolicy],
    ) -> Result<(), ConnectError> {
        let current = self.authority.connection()?.query_row(
            "SELECT sequence, revision, connector_id FROM policy_state WHERE singleton = 1",
            [],
            |row| {
                Ok(CurrentPolicySnapshot {
                    sequence: row.get(0)?,
                    revision: row.get(1)?,
                    connector_id: row.get(2)?,
                })
            },
        )?;
        validate_policy_snapshot(
            Some(connector_id),
            revision,
            sequence,
            &(lease_issued_at_ms..lease_expires_at_ms),
            grants,
            super::authority_store::current_time_ms(),
            &current,
        )
    }

    pub(crate) fn replace_grants_at_revision_at(
        &self,
        connector_id: Option<Uuid>,
        revision: &str,
        sequence: u64,
        lease_ms: std::ops::Range<i64>,
        grants: &[GrantPolicy],
        now_ms: i64,
    ) -> Result<(), ConnectError> {
        self.replace_grants_at_revision_at_inner(
            connector_id,
            revision,
            sequence,
            lease_ms,
            grants,
            now_ms,
            false,
        )
    }

    fn replace_grants_at_revision_at_inner(
        &self,
        connector_id: Option<Uuid>,
        revision: &str,
        sequence: u64,
        lease_ms: std::ops::Range<i64>,
        grants: &[GrantPolicy],
        now_ms: i64,
        reject_pinned_legacy: bool,
    ) -> Result<(), ConnectError> {
        let lease_expires_at_ms = lease_ms.end;
        let connector_id_string = connector_id.map(|value| value.to_string());
        let revision = revision.to_string();
        let grants = grants.to_vec();
        let active_crypto_keys = grants
            .iter()
            .filter_map(|grant| {
                grant
                    .encryption
                    .as_ref()
                    .map(|encryption| (grant.id.to_string(), encryption.key_id.clone()))
            })
            .collect::<BTreeSet<_>>();
        self.authority
            .write(AuthorityWritePriority::Control, move |connection| {
                let transaction = connection.transaction()?;
                let current = transaction.query_row(
                    "SELECT sequence, revision, connector_id FROM policy_state WHERE singleton = 1",
                    [],
                    |row| {
                        Ok(CurrentPolicySnapshot {
                            sequence: row.get(0)?,
                            revision: row.get(1)?,
                            connector_id: row.get(2)?,
                        })
                    },
                )?;
                if reject_pinned_legacy && current.connector_id.is_some() {
                    return Err(ConnectError::InvalidInput(
                        "Legacy policy is forbidden after lease authority was pinned.".to_string(),
                    ));
                }
                validate_policy_snapshot(
                    connector_id,
                    &revision,
                    sequence,
                    &lease_ms,
                    &grants,
                    now_ms,
                    &current,
                )?;
                if sequence == current.sequence && revision == current.revision {
                    return Ok(());
                }
                let stored_crypto_keys = {
                    let mut statement = transaction.prepare(
                        "SELECT id, json_extract(encryption, '$.key_id')
                         FROM grants WHERE encryption IS NOT NULL",
                    )?;
                    let rows = statement
                        .query_map([], |row| {
                            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                        })?
                        .collect::<Result<Vec<_>, _>>()?;
                    rows
                };
                for (grant_id, key_id) in stored_crypto_keys {
                    if !active_crypto_keys.contains(&(grant_id.clone(), key_id)) {
                        archive_grant_replay_material(&transaction, &grant_id)?;
                    }
                }
                transaction.execute("DELETE FROM grants", [])?;
                {
                    let mut statement = transaction.prepare(
                        "INSERT INTO grants
                           (id, application_id, collection_id, operations, scope, application_name,
                            application_distribution, application_homepage, application_project_url,
                            application_origin, application_icon, collection_name, created_at, encryption,
                            file_capability, notification_criteria, application_authorization)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
                    )?;
                    for grant in &grants {
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
                            serde_json::to_string(&grant.application_authorization)?,
                        ])?;
                    }
                }
                transaction.execute(
                    "UPDATE policy_state
                     SET revision = ?1, sequence = ?2, lease_expires_at_ms = ?3,
                         observed_at_ms = max(observed_at_ms, ?4),
                         connector_id = COALESCE(connector_id, ?5), epoch = epoch + 1,
                         applied_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
                     WHERE singleton = 1",
                    params![
                        revision,
                        sequence,
                        lease_expires_at_ms,
                        now_ms,
                        connector_id_string
                    ],
                )?;
                transaction.commit()?;
                Ok(())
            })
    }

    pub fn upsert_grant(&self, grant: &GrantPolicy) -> Result<(), ConnectError> {
        validate_grant_application_authorization(grant)?;
        let grant = grant.clone();
        self.authority
            .write(AuthorityWritePriority::Control, move |connection| {
                archive_grant_replay_material(connection, &grant.id.to_string())?;
                connection.execute(
                    "INSERT INTO grants
                       (id, application_id, collection_id, operations, scope, application_name,
                        application_distribution, application_homepage, application_project_url,
                        application_origin, application_icon, collection_name, created_at, encryption,
                        file_capability, notification_criteria, application_authorization)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
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
                        serde_json::to_string(&grant.application_authorization)?,
                    ],
                )?;
                Ok(())
            })
    }

    pub fn list_grants(&self) -> Result<Vec<GrantSummary>, ConnectError> {
        let connection = self.authority.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, application_id, application_name, application_distribution,
                    application_homepage, application_project_url, application_origin,
                    application_icon, collection_id, collection_name, operations, scope,
                    created_at, encryption, file_capability, notification_criteria,
                    application_authorization
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
                row.get::<_, String>(16)?,
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
                application_authorization,
            ) = row?;
            let proof: ApplicationAuthorizationProof =
                serde_json::from_str(&application_authorization)?;
            Ok(GrantSummary {
                id: parse_registry_uuid(&id)?,
                application_id: parse_registry_uuid(&application_id)?,
                application_declaration_id: proof.binding.application_declaration_id,
                application_manifest_digest: proof.binding.application_manifest_digest,
                application_name,
                application_distribution,
                application_homepage,
                application_project_url,
                application_origin: Some(application_origin),
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
                contracts: proof.binding.contracts,
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

    /// Return the immutable installation identity and authorization snapshot digest used to bind
    /// a durable mutation claim. The digest is over the exact signed proof stored with the grant.
    pub fn grant_mutation_identity(
        &self,
        grant_id: Uuid,
    ) -> Result<Option<(Uuid, String)>, ConnectError> {
        let authorization = self
            .authority
            .connection()?
            .query_row(
                "SELECT application_authorization FROM grants WHERE id = ?1",
                [grant_id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(authorization) = authorization else {
            return Ok(None);
        };
        let proof: ApplicationAuthorizationProof = serde_json::from_str(&authorization)?;
        let digest = Sha256::digest(authorization.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok(Some((proof.binding.application_installation_id, digest)))
    }

    /// Resolve either the active grant or the exact historical public-key material needed to
    /// authenticate replay of an already-accepted request. Callers must never use a revoked
    /// context to claim or apply a new mutation.
    pub fn grant_replay_context(
        &self,
        grant_id: Uuid,
        key_id: &str,
    ) -> Result<Option<GrantReplayContext>, ConnectError> {
        if let Some(grant) = self.grant_context(grant_id)? {
            if grant
                .encryption
                .as_ref()
                .is_some_and(|encryption| encryption.key_id == key_id)
            {
                let Some((application_installation_id, grant_snapshot_digest)) =
                    self.grant_mutation_identity(grant_id)?
                else {
                    return Ok(None);
                };
                return Ok(Some(GrantReplayContext {
                    grant,
                    revoked: false,
                    application_installation_id,
                    grant_snapshot_digest,
                }));
            }
        }

        let row = self
            .authority
            .connection()?
            .query_row(
                "SELECT application_id, application_name, application_distribution,
                        application_homepage, application_project_url, application_origin,
                        application_icon, collection_id, collection_name, operations, scope,
                        created_at, encryption, file_capability, notification_criteria,
                        application_authorization
                 FROM revoked_grant_replay_material
                 WHERE grant_id = ?1 AND key_id = ?2",
                params![grant_id.to_string(), key_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                        row.get::<_, String>(10)?,
                        row.get::<_, String>(11)?,
                        row.get::<_, String>(12)?,
                        row.get::<_, Option<String>>(13)?,
                        row.get::<_, String>(14)?,
                        row.get::<_, String>(15)?,
                    ))
                },
            )
            .optional()?;
        let Some((
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
            application_authorization,
        )) = row
        else {
            return Ok(None);
        };
        let proof: ApplicationAuthorizationProof =
            serde_json::from_str(&application_authorization)?;
        proof.verify().map_err(|error| {
            ConnectError::InvalidInput(format!(
                "Stored revoked grant authorization is invalid: {error}"
            ))
        })?;
        let grant_snapshot_digest = Sha256::digest(application_authorization.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok(Some(GrantReplayContext {
            grant: GrantSummary {
                id: grant_id,
                application_id: parse_registry_uuid(&application_id)?,
                application_declaration_id: proof.binding.application_declaration_id.clone(),
                application_manifest_digest: proof.binding.application_manifest_digest.clone(),
                application_name,
                application_distribution,
                application_homepage,
                application_project_url,
                application_origin: Some(application_origin),
                application_icon,
                collection_id: parse_registry_uuid(&collection_id)?,
                collection_name,
                operations: serde_json::from_str(&operations)?,
                scope: serde_json::from_str(&scope)?,
                notification_criteria: serde_json::from_str(&notification_criteria)?,
                created_at,
                encryption: Some(serde_json::from_str(&encryption)?),
                file_capability: file_capability
                    .as_deref()
                    .map(serde_json::from_str)
                    .transpose()?,
                contracts: proof.binding.contracts.clone(),
            },
            revoked: true,
            application_installation_id: proof.binding.application_installation_id,
            grant_snapshot_digest,
        }))
    }

    pub fn replay_origin_allowed(&self, origin: &str) -> Result<bool, ConnectError> {
        Ok(self
            .authority
            .connection()?
            .query_row(
                "SELECT 1 FROM revoked_grant_replay_material
                 WHERE application_origin = ?1 LIMIT 1",
                [origin],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// Remote application authority is usable only while the latest server-issued
    /// snapshot lease is fresh. Local collection registration and offline collection
    /// operations do not consult this lease.
    pub fn remote_policy_is_fresh(&self) -> Result<bool, ConnectError> {
        self.remote_policy_is_fresh_at(super::authority_store::current_time_ms())
    }

    /// Admission predicate. Legacy beta authority is intentionally unbounded,
    /// but remains explicitly distinct from fresh lease protection.
    pub fn remote_policy_is_usable(&self) -> Result<bool, ConnectError> {
        let now_ms = super::authority_store::current_time_ms();
        let (connector_id, expires_at_ms, observed_at_ms) =
            self.authority.connection()?.query_row(
                "SELECT connector_id, lease_expires_at_ms, observed_at_ms
             FROM policy_state WHERE singleton = 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )?;
        Ok(connector_id.is_none() || expires_at_ms > now_ms.max(observed_at_ms))
    }

    /// Reconstruct the authority digest from exact stored columns. Every
    /// GrantPolicy field is supplied explicitly; serde defaults are never used
    /// to infer absent database state.
    pub fn remote_policy_authority(&self) -> Result<RemotePolicyAuthority, ConnectError> {
        let mut connection = self.authority.connection()?;
        let transaction = connection.transaction()?;
        let (revision, sequence, connector_id, lease_expires_at_ms, observed_at_ms) = transaction
            .query_row(
            "SELECT revision, sequence, connector_id, lease_expires_at_ms, observed_at_ms
                 FROM policy_state WHERE singleton = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, u64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )?;
        let connector_id = connector_id
            .as_deref()
            .map(parse_registry_uuid)
            .transpose()?;
        let mode = if connector_id.is_some() {
            RemotePolicyAuthorityMode::LeaseV1
        } else {
            RemotePolicyAuthorityMode::LegacyAckV0
        };
        let authority_digest = connector_id
            .map(|connector_id| {
                let mut statement = transaction.prepare(
                    "SELECT id, application_id, collection_id, operations, scope,
                            application_name, application_distribution, application_homepage,
                            application_project_url, application_origin, application_icon,
                            collection_name, notification_criteria, created_at, encryption,
                            file_capability, application_authorization
                     FROM grants ORDER BY id",
                )?;
                let grants = statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, String>(6)?,
                            row.get::<_, String>(7)?,
                            row.get::<_, Option<String>>(8)?,
                            row.get::<_, String>(9)?,
                            row.get::<_, Option<String>>(10)?,
                            row.get::<_, String>(11)?,
                            row.get::<_, String>(12)?,
                            row.get::<_, String>(13)?,
                            row.get::<_, Option<String>>(14)?,
                            row.get::<_, Option<String>>(15)?,
                            row.get::<_, String>(16)?,
                        ))
                    })?
                    .map(|row| {
                        let row = row?;
                        Ok(GrantPolicy {
                            id: parse_registry_uuid(&row.0)?,
                            application_id: parse_registry_uuid(&row.1)?,
                            collection_id: parse_registry_uuid(&row.2)?,
                            operations: serde_json::from_str(&row.3)?,
                            scope: serde_json::from_str(&row.4)?,
                            application_name: row.5,
                            application_distribution: row.6,
                            application_homepage: row.7,
                            application_project_url: row.8,
                            application_origin: row.9,
                            application_icon: row.10,
                            collection_name: row.11,
                            notification_criteria: serde_json::from_str(&row.12)?,
                            created_at: row.13,
                            encryption: row.14.as_deref().map(serde_json::from_str).transpose()?,
                            file_capability: row
                                .15
                                .as_deref()
                                .map(serde_json::from_str)
                                .transpose()?,
                            application_authorization: serde_json::from_str(&row.16)?,
                        })
                    })
                    .collect::<Result<Vec<_>, ConnectError>>()?;
                canonical_policy_authority_digest(connector_id, &grants)
            })
            .transpose()?
            .or_else(|| (!revision.is_empty()).then(|| revision.clone()));
        transaction.commit()?;
        let now_ms = super::authority_store::current_time_ms();
        Ok(RemotePolicyAuthority {
            mode: mode.clone(),
            revision,
            sequence,
            connector_id,
            authority_digest,
            lease_expires_at_ms,
            observed_at_ms,
            fresh: mode == RemotePolicyAuthorityMode::LeaseV1
                && lease_expires_at_ms > now_ms.max(observed_at_ms),
        })
    }

    pub fn remote_policy_revision_if_fresh(&self) -> Result<Option<String>, ConnectError> {
        let now_ms = super::authority_store::current_time_ms();
        let (revision, expires_at_ms, observed_at_ms) = self.authority.connection()?.query_row(
            "SELECT revision, lease_expires_at_ms, observed_at_ms FROM policy_state WHERE singleton = 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
        )?;
        Ok((expires_at_ms > now_ms.max(observed_at_ms)).then_some(revision))
    }

    pub fn remote_policy_matches_fresh(&self, revision: &str) -> Result<bool, ConnectError> {
        Ok(self.remote_policy_revision_if_fresh()?.as_deref() == Some(revision))
    }

    pub fn remote_policy_remaining(&self) -> Result<std::time::Duration, ConnectError> {
        let now_ms = super::authority_store::current_time_ms();
        if !self.remote_policy_is_fresh_at(now_ms)? {
            return Ok(std::time::Duration::ZERO);
        }
        let (expires_at_ms, observed_at_ms) = self.authority.connection()?.query_row(
            "SELECT lease_expires_at_ms, observed_at_ms FROM policy_state WHERE singleton = 1",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )?;
        Ok(std::time::Duration::from_millis(
            expires_at_ms.saturating_sub(now_ms.max(observed_at_ms)) as u64,
        ))
    }

    pub(crate) fn remote_policy_is_fresh_at(&self, now_ms: i64) -> Result<bool, ConnectError> {
        let (expires_at_ms, observed_at_ms) = self.authority.connection()?.query_row(
            "SELECT lease_expires_at_ms, observed_at_ms FROM policy_state WHERE singleton = 1",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )?;
        let effective_now = now_ms.max(observed_at_ms);
        if effective_now > observed_at_ms {
            self.authority
                .write(AuthorityWritePriority::Control, move |connection| {
                    connection.execute(
                        "UPDATE policy_state SET observed_at_ms = max(observed_at_ms, ?1)
                         WHERE singleton = 1",
                        [effective_now],
                    )?;
                    Ok(())
                })?;
        }
        Ok(expires_at_ms > effective_now)
    }

    pub fn authorizes(
        &self,
        grant_id: Uuid,
        application_id: Uuid,
        collection_id: Uuid,
        operation: &str,
    ) -> Result<bool, ConnectError> {
        let operations = self
            .authority
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

fn validate_grant_application_authorization(grant: &GrantPolicy) -> Result<(), ConnectError> {
    grant.validate_application_security().map_err(|error| {
        invalid_grant_security(format!(
            "grant does not match its application proof: {error}"
        ))
    })?;
    Ok(())
}

fn invalid_grant_security(message: impl Into<String>) -> ConnectError {
    ConnectError::InvalidInput(format!(
        "Invalid application authorization: {}",
        message.into()
    ))
}

pub(super) fn archive_grant_replay_material(
    connection: &Connection,
    grant_id: &str,
) -> Result<(), ConnectError> {
    connection.execute(
        "INSERT OR REPLACE INTO revoked_grant_replay_material (
            grant_id, key_id, application_id, collection_id, operations, scope,
            application_name, application_distribution, application_homepage,
            application_project_url, application_origin, application_icon,
            collection_name, notification_criteria, created_at, encryption,
            file_capability, application_authorization, revoked_at_ms
         )
         SELECT id, json_extract(encryption, '$.key_id'), application_id, collection_id,
                operations, scope, application_name, application_distribution,
                application_homepage, application_project_url, application_origin,
                application_icon, collection_name, notification_criteria, created_at,
                encryption, file_capability, application_authorization,
                CAST(unixepoch('subsec') * 1000 AS INTEGER)
         FROM grants WHERE id = ?1 AND encryption IS NOT NULL",
        [grant_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod canonical_fixture_tests {
    use super::*;

    #[test]
    fn legacy_can_upgrade_to_lease_but_cannot_return_after_restart() {
        let directory = tempfile::tempdir().unwrap();
        let connector_id = Uuid::new_v4();
        {
            let registry = CollectionRegistry::open(directory.path()).unwrap();
            registry
                .replace_legacy_remote_grants_at_revision("legacy-one", &[])
                .unwrap();
            registry
                .replace_legacy_remote_grants_at_revision("legacy-two", &[])
                .unwrap();
            let authority = registry.remote_policy_authority().unwrap();
            assert_eq!(authority.mode, RemotePolicyAuthorityMode::LegacyAckV0);
            assert!(!authority.fresh);
            assert!(registry.remote_policy_is_usable().unwrap());
        }
        {
            let registry = CollectionRegistry::open(directory.path()).unwrap();
            let now = super::super::authority_store::current_time_ms();
            registry
                .replace_remote_grants_at_revision(connector_id, "lease", 1, now, now + 60_000, &[])
                .unwrap();
        }
        let registry = CollectionRegistry::open(directory.path()).unwrap();
        assert_eq!(
            registry.remote_policy_authority().unwrap().mode,
            RemotePolicyAuthorityMode::LeaseV1
        );
        assert!(registry
            .replace_legacy_remote_grants_at_revision("legacy-again", &[])
            .is_err());
    }

    #[test]
    fn protocol_v1_fixture_round_trips_exact_grant_policy_and_digests() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../test-fixtures/protocol-v1-policy-canonical.json"
        ))
        .unwrap();
        assert_eq!(fixture["protocol_version"], 1);
        let wire_body = &fixture["normalized_wire_body"];
        let mut grants: Vec<GrantPolicy> =
            serde_json::from_value(wire_body["grants"].clone()).unwrap();
        assert_eq!(serde_json::to_value(&grants).unwrap(), wire_body["grants"]);
        grants.reverse();

        let connector_id: Uuid = serde_json::from_value(wire_body["connector_id"].clone()).unwrap();
        assert_eq!(
            canonical_policy_authority_digest(connector_id, &grants).unwrap(),
            fixture["authority_digest"].as_str().unwrap()
        );
        let mut normalized = grants;
        normalized.sort_by_key(|grant| grant.id);
        let reconstructed_wire = serde_json::json!({
            "connector_id": connector_id,
            "sequence": wire_body["sequence"],
            "lease_issued_at_ms": wire_body["lease_issued_at_ms"],
            "lease_expires_at_ms": wire_body["lease_expires_at_ms"],
            "grants": &normalized,
        });
        let reconstructed_authority = serde_json::json!({
            "connector_id": connector_id,
            "grants": &normalized,
        });
        assert_eq!(reconstructed_authority, fixture["authority_body"]);
        let canonical = String::from_utf8(serde_jcs::to_vec(&reconstructed_wire).unwrap()).unwrap();
        let authority_canonical =
            String::from_utf8(serde_jcs::to_vec(&reconstructed_authority).unwrap()).unwrap();
        assert_eq!(
            canonical,
            fixture["normalized_wire_canonical"].as_str().unwrap()
        );
        assert_eq!(
            authority_canonical,
            fixture["authority_canonical"].as_str().unwrap()
        );
        assert_eq!(
            format!("sha256:{:x}", Sha256::digest(canonical.as_bytes())),
            fixture["revision"].as_str().unwrap()
        );
        assert_eq!(
            fixture["revision"],
            "sha256:ccfe7bb1eb75acbec1abe0ee2e8a0c13f1d2be3e2cb47aa30cf6ba6bc3d982ea"
        );
        assert_eq!(
            fixture["authority_digest"],
            "sha256:141ae510bcd2582cc075046327940a622d68a87355e1f11fb7358bf5fe0803fd"
        );
    }
}
