use super::*;
use crate::collaboration::{CollaborationMode, COLLABORATION_PROFILE};

/// Internal request shape. Paths are resolved once to the stable record room;
/// subsequent record renames deliberately retain that room and ticket binding.
/// Callers never provide a stable record id.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct CollaborationTicketRequest {
    pub path: String,
    pub profile: String,
    pub mode: CollaborationMode,
    pub epoch: Option<u64>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct CollaborationTicketMetadata {
    pub(crate) replica_id: Uuid,
    pub room: RoomIdentity,
    pub mode: CollaborationMode,
    pub origin: String,
    pub proof_public_key_digest: [u8; 32],
    pub scope_epoch: u64,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct IssuedCollaborationTicket {
    /// Opaque plaintext. It is returned only to the immediate caller and is
    /// never persisted, logged, or included in a URL.
    pub plaintext: String,
    pub metadata: CollaborationTicketMetadata,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct ConsumedCollaborationTicket {
    pub metadata: CollaborationTicketMetadata,
}

impl HostedProvider {
    /// Issue a one-shot room ticket after running the normal hosted request
    /// authentication and proof nonce check. This is intentionally crate
    /// visible only: Phase 4A has no HTTP surface.
    #[allow(dead_code)]
    pub(crate) async fn issue_collaboration_ticket(
        &self,
        collection_id: Uuid,
        bearer: &str,
        request: CollaborationTicketRequest,
        origin: Option<&str>,
        proof: Option<&AuthorityRequestProof>,
    ) -> ApiResult<IssuedCollaborationTicket> {
        self.authorize_request(collection_id, bearer, origin, proof)
            .await?;
        if request.profile != COLLABORATION_PROFILE || request.epoch == Some(0) {
            return Err(collaboration_denied());
        }
        let mut transaction = self.pool.begin().await?;
        let replica_row = lock_and_load_collaboration_replica(
            &mut transaction,
            collection_id,
            token_hash(bearer),
        )
        .await?;
        let binding = collaboration_binding(
            &replica_row,
            collection_id,
            request.mode,
            origin,
            request.profile.as_str(),
        )?;

        // Only now derive the encrypted path lookup key. The authorization
        // boundary therefore never leaks whether an unauthorized path exists.
        let collection = sqlx::query(
            "SELECT wrapped_data_key FROM hosted_provider_collections
             WHERE id=$1 AND state='active' FOR UPDATE",
        )
        .bind(collection_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            )
        })?;
        let data_key = self
            .collection_key(collection_id, collection.get("wrapped_data_key"))
            .await?;
        let record_id: Uuid = sqlx::query_scalar(
            "SELECT record_id FROM hosted_provider_records
             WHERE collection_id=$1 AND path_token=$2",
        )
        .bind(collection_id)
        .bind(path_token(&data_key, &request.path))
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            ApiError::not_found("record_not_found", "The hosted record does not exist.")
        })?;
        // The durable fence owns the epoch; documents are derived state. A
        // missing fence means no room has ever been admitted, so admission
        // starts at epoch 1 and load_collaboration_room_in initializes the
        // fence transactionally under its lock.
        let fence_epoch: Option<u64> = sqlx::query_scalar(
            "SELECT current_epoch FROM hosted_provider_collaboration_epoch_fences
             WHERE collection_id = $1 AND record_id = $2",
        )
        .bind(collection_id)
        .bind(record_id)
        .fetch_optional(&mut *transaction)
        .await?
        .map(|epoch: i64| number(epoch, "collaboration epoch"))
        .transpose()?;
        let active_epoch = fence_epoch.unwrap_or(1);
        if request.epoch.is_some_and(|epoch| epoch != active_epoch) {
            return Err(ApiError::conflict(
                "collaboration_epoch_stale",
                "The collaboration epoch is not active.",
            ));
        }
        let room = RoomIdentity::new(
            collection_id,
            record_id,
            active_epoch,
            COLLABORATION_PROFILE,
        )
        .ok_or_else(collaboration_denied)?;
        self.load_collaboration_room_in(&mut transaction, &data_key, room)
            .await?;

        let mut random = [0_u8; 32];
        OsRng.fill_bytes(&mut random);
        let hash = Sha256::digest(random);
        let expires_at = Utc::now()
            + chrono::Duration::seconds(self.limits.collaboration.ticket_ttl_seconds.min(30) as i64);
        sqlx::query(
            "INSERT INTO hosted_provider_collaboration_tickets
             (ticket_hash, replica_id, collection_id, record_id, collaboration_epoch,
              profile, mode, allowed_origin, proof_public_key_digest, scope_epoch, expires_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        )
        .bind(hash.to_vec())
        .bind(binding.replica_id)
        .bind(collection_id)
        .bind(record_id)
        .bind(to_i64(active_epoch, "collaboration epoch")?)
        .bind(COLLABORATION_PROFILE)
        .bind(mode_text(request.mode))
        .bind(&binding.origin)
        .bind(binding.proof_digest.as_slice())
        .bind(to_i64(binding.scope_epoch, "scope epoch")?)
        .bind(expires_at)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(IssuedCollaborationTicket {
            plaintext: URL_SAFE_NO_PAD.encode(random),
            metadata: CollaborationTicketMetadata {
                replica_id: binding.replica_id,
                room,
                mode: request.mode,
                origin: binding.origin,
                proof_public_key_digest: binding.proof_digest,
                scope_epoch: binding.scope_epoch,
                expires_at,
            },
        })
    }

    /// Atomically consume a ticket. The one-shot secret replaces the bearer
    /// during WebSocket authentication; every mutable replica property is
    /// checked again and the browser Origin must still match exactly.
    #[allow(dead_code)]
    pub(crate) async fn consume_collaboration_ticket(
        &self,
        plaintext: &str,
        origin: Option<&str>,
    ) -> ApiResult<ConsumedCollaborationTicket> {
        let decoded = URL_SAFE_NO_PAD
            .decode(plaintext)
            .map_err(|_| collaboration_denied())?;
        if decoded.len() != 32 {
            return Err(collaboration_denied());
        }
        let hash_bytes = Sha256::digest(decoded).to_vec();
        let mut transaction = self.pool.begin().await?;
        // Discover only immutable lock keys, then follow the global
        // replica -> ticket -> collection/record lock order. The ticket row is
        // re-read under lock before any binding is trusted.
        let hint = sqlx::query(
            "SELECT replica_id, collection_id FROM hosted_provider_collaboration_tickets WHERE ticket_hash=$1",
        )
        .bind(&hash_bytes)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(collaboration_denied)?;
        let hinted_replica: Uuid = hint.get("replica_id");
        let hinted_collection: Uuid = hint.get("collection_id");
        let replica_row = lock_and_load_collaboration_replica_by_id(
            &mut transaction,
            hinted_collection,
            hinted_replica,
        )
        .await?;
        let row = sqlx::query(
            "SELECT ticket_hash, replica_id, collection_id, record_id, collaboration_epoch,
                    profile, mode, allowed_origin, proof_public_key_digest, scope_epoch,
                    expires_at, consumed_at
             FROM hosted_provider_collaboration_tickets WHERE ticket_hash=$1 FOR UPDATE",
        )
        .bind(&hash_bytes)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(collaboration_denied)?;
        let collection_id: Uuid = row.get("collection_id");
        let mode = parse_mode(row.get("mode"))?;
        let epoch = number(
            row.get::<i64, _>("collaboration_epoch"),
            "collaboration epoch",
        )?;
        let profile: String = row.get("profile");
        if row.get::<Option<DateTime<Utc>>, _>("consumed_at").is_some()
            || row.get::<DateTime<Utc>, _>("expires_at") <= Utc::now()
            || row.get::<Uuid, _>("replica_id") != hinted_replica
            || collection_id != hinted_collection
        {
            return Err(collaboration_denied());
        }
        let binding = collaboration_binding(&replica_row, collection_id, mode, origin, &profile)?;
        if replica_row.get::<Uuid, _>("id") != row.get::<Uuid, _>("replica_id")
            || binding.scope_epoch != number(row.get::<i64, _>("scope_epoch"), "scope epoch")?
            || binding.proof_digest.as_slice()
                != row.get::<Vec<u8>, _>("proof_public_key_digest").as_slice()
            || binding.origin != row.get::<String, _>("allowed_origin")
        {
            return Err(collaboration_denied());
        }
        let record_id: Uuid = row.get("record_id");
        let room = RoomIdentity::new(collection_id, record_id, epoch, COLLABORATION_PROFILE)
            .ok_or_else(collaboration_denied)?;
        // Non-locking revalidation after the replica -> ticket lock order:
        // the ticket is consumable only while its room is still the fence's
        // current epoch and that room's document is active.
        let active = sqlx::query(
            "SELECT f.current_epoch, d.state FROM hosted_provider_collaboration_epoch_fences f
             LEFT JOIN hosted_provider_collaboration_documents d
               ON d.collection_id = f.collection_id AND d.record_id = f.record_id
              AND d.collaboration_epoch = f.current_epoch AND d.profile = $3
             WHERE f.collection_id = $1 AND f.record_id = $2",
        )
        .bind(room.collection_id)
        .bind(room.record_id)
        .bind(room.profile)
        .fetch_optional(&mut *transaction)
        .await?;
        let current_and_state: Option<(i64, Option<String>)> = active.map(|row| {
            (
                row.get("current_epoch"),
                row.get::<Option<String>, _>("state"),
            )
        });
        if current_and_state != Some((to_i64(epoch, "collaboration epoch")?, Some("active".into())))
        {
            return Err(collaboration_denied());
        }
        let consumed = sqlx::query("UPDATE hosted_provider_collaboration_tickets SET consumed_at=now() WHERE ticket_hash=$1 AND consumed_at IS NULL AND expires_at > now()")
            .bind(&hash_bytes).execute(&mut *transaction).await?;
        if consumed.rows_affected() != 1 {
            return Err(collaboration_denied());
        }
        transaction.commit().await?;
        Ok(ConsumedCollaborationTicket {
            metadata: CollaborationTicketMetadata {
                replica_id: row.get("replica_id"),
                room,
                mode,
                origin: binding.origin,
                proof_public_key_digest: binding.proof_digest,
                scope_epoch: binding.scope_epoch,
                expires_at: row.get("expires_at"),
            },
        })
    }
}

#[derive(Debug)]
struct Binding {
    replica_id: Uuid,
    origin: String,
    proof_digest: [u8; 32],
    scope_epoch: u64,
}

async fn lock_and_load_collaboration_replica_by_id(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    replica_id: Uuid,
) -> ApiResult<PgRow> {
    sqlx::query("SELECT id, collection_id, purpose, mode, full_collection, allowed_types, contract_scope, allowed_operations, collaboration_capability, allowed_origin, proof_public_key, grant_id, application_declaration_id, application_declaration_digest, scope_epoch FROM hosted_provider_replicas WHERE collection_id=$1 AND id=$2 AND revoked_at IS NULL AND token_expires_at > now() FOR UPDATE")
        .bind(collection_id).bind(replica_id).fetch_optional(&mut **transaction).await?
        .ok_or_else(collaboration_denied)
}

async fn lock_and_load_collaboration_replica(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    hash: Vec<u8>,
) -> ApiResult<PgRow> {
    sqlx::query("SELECT id, collection_id, purpose, mode, full_collection, allowed_types, contract_scope, allowed_operations, collaboration_capability, allowed_origin, proof_public_key, grant_id, application_declaration_id, application_declaration_digest, scope_epoch FROM hosted_provider_replicas WHERE collection_id=$1 AND token_hash=$2 AND revoked_at IS NULL AND token_expires_at > now() FOR UPDATE")
        .bind(collection_id).bind(hash).fetch_optional(&mut **transaction).await?
        .ok_or_else(collaboration_denied)
}

fn collaboration_binding(
    row: &PgRow,
    collection_id: Uuid,
    mode: CollaborationMode,
    origin: Option<&str>,
    profile: &str,
) -> ApiResult<Binding> {
    let capability: Option<ReplicaCollaborationCapability> = row
        .get::<Option<Value>, _>("collaboration_capability")
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| collaboration_denied())?;
    let access_ok = capability.as_ref().is_some_and(|cap| {
        cap.contract_version == 1
            && cap.profiles == vec![profile.to_owned()]
            && ((mode == CollaborationMode::ReadOnly
                && matches!(
                    cap.access,
                    CollaborationAccess::ReadOnly | CollaborationAccess::ReadWrite
                ))
                || (mode == CollaborationMode::ReadWrite
                    && cap.access == CollaborationAccess::ReadWrite))
    });
    let operations: Vec<String> = row.get("allowed_operations");
    if row.get::<Uuid, _>("collection_id") != collection_id
        || row.get::<String, _>("purpose") != "application"
        || !row.get::<bool, _>("full_collection")
        || !row.get::<Vec<String>, _>("allowed_types").is_empty()
        || row.get::<Value, _>("contract_scope") != Value::Array(Vec::new())
        || !operations.iter().any(|op| op == "read")
        || mode == CollaborationMode::ReadWrite
            && (!operations.iter().any(|op| op == "update")
                || row.get::<String, _>("mode") != "read_write")
        || !access_ok
        || row.get::<Option<Uuid>, _>("grant_id").is_none()
        || row
            .get::<Option<String>, _>("application_declaration_id")
            .is_none()
        || row
            .get::<Option<String>, _>("application_declaration_digest")
            .is_none()
    {
        return Err(collaboration_denied());
    }
    let origin = origin
        .filter(|value| !value.is_empty())
        .ok_or_else(collaboration_denied)?;
    if row.get::<Option<String>, _>("allowed_origin").as_deref() != Some(origin) {
        return Err(collaboration_denied());
    }
    let key = row
        .get::<Option<String>, _>("proof_public_key")
        .ok_or_else(collaboration_denied)?;
    let proof_digest: [u8; 32] = Sha256::digest(key.as_bytes()).into();
    Ok(Binding {
        replica_id: row.get("id"),
        origin: origin.to_owned(),
        proof_digest,
        scope_epoch: number(row.get::<i64, _>("scope_epoch"), "scope epoch")?,
    })
}

fn mode_text(mode: CollaborationMode) -> &'static str {
    match mode {
        CollaborationMode::ReadOnly => "read_only",
        CollaborationMode::ReadWrite => "read_write",
    }
}
fn parse_mode(value: String) -> ApiResult<CollaborationMode> {
    match value.as_str() {
        "read_only" => Ok(CollaborationMode::ReadOnly),
        "read_write" => Ok(CollaborationMode::ReadWrite),
        _ => Err(collaboration_denied()),
    }
}
fn collaboration_denied() -> ApiError {
    ApiError::forbidden(
        "collaboration_scope_denied",
        "The collaboration session is not authorized.",
    )
}
