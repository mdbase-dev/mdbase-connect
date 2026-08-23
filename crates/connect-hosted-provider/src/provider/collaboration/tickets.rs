use super::*;
use crate::collaboration::{CollaborationMode, COLLABORATION_PROFILE};

/// Internal request shape. Paths are deliberately resolved before they become
/// part of a room identity; callers never provide a stable record id.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct CollaborationTicketRequest {
    pub path: String,
    pub profile: String,
    pub mode: CollaborationMode,
    pub epoch: u64,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct CollaborationTicketMetadata {
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
        if request.profile != COLLABORATION_PROFILE || request.epoch == 0 {
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
        let active_epoch: Option<i64> = sqlx::query_scalar(
            "SELECT max(collaboration_epoch) FROM hosted_provider_collaboration_documents
             WHERE collection_id=$1 AND record_id=$2 AND profile=$3",
        )
        .bind(collection_id)
        .bind(record_id)
        .bind(COLLABORATION_PROFILE)
        .fetch_one(&mut *transaction)
        .await?;
        let highest = active_epoch
            .map(|value| number(value, "collaboration epoch"))
            .transpose()?;
        if highest.is_some_and(|epoch| epoch != request.epoch)
            || highest.is_none() && request.epoch != 1
        {
            return Err(ApiError::conflict(
                "collaboration_epoch_stale",
                "The collaboration epoch is not active.",
            ));
        }
        let room = RoomIdentity::new(
            collection_id,
            record_id,
            request.epoch,
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
        .bind(hash.as_slice())
        .bind(binding.replica_id)
        .bind(collection_id)
        .bind(record_id)
        .bind(to_i64(request.epoch, "collaboration epoch")?)
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
                room,
                mode: request.mode,
                origin: binding.origin,
                proof_public_key_digest: binding.proof_digest,
                scope_epoch: binding.scope_epoch,
                expires_at,
            },
        })
    }

    /// Atomically consume a ticket. The bearer and proof are session context,
    /// not ticket contents; every mutable authorization property is checked
    /// again while the ticket row is locked.
    #[allow(dead_code)]
    pub(crate) async fn consume_collaboration_ticket(
        &self,
        bearer: &str,
        plaintext: &str,
        expected: &CollaborationTicketRequest,
        origin: Option<&str>,
        proof: Option<&AuthorityRequestProof>,
    ) -> ApiResult<ConsumedCollaborationTicket> {
        if expected.profile != COLLABORATION_PROFILE || expected.epoch == 0 {
            return Err(collaboration_denied());
        }
        // This invokes the canonical origin, signature, timestamp and nonce
        // verification rather than creating a second proof implementation.
        let collection_hint = expected_collection_hint(&self.pool, plaintext).await?;
        self.authorize_request(collection_hint, bearer, origin, proof)
            .await?;
        let decoded = URL_SAFE_NO_PAD
            .decode(plaintext)
            .map_err(|_| collaboration_denied())?;
        if decoded.len() != 32 {
            return Err(collaboration_denied());
        }
        let hash = Sha256::digest(decoded);
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT ticket_hash, replica_id, collection_id, record_id, collaboration_epoch,
                    profile, mode, allowed_origin, proof_public_key_digest, scope_epoch,
                    expires_at, consumed_at
             FROM hosted_provider_collaboration_tickets WHERE ticket_hash=$1 FOR UPDATE",
        )
        .bind(hash.as_slice())
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(collaboration_denied)?;
        let collection_id: Uuid = row.get("collection_id");
        let mode = parse_mode(row.get("mode"))?;
        let epoch = number(
            row.get::<i64, _>("collaboration_epoch"),
            "collaboration epoch",
        )?;
        let ticket_request = CollaborationTicketRequest {
            path: String::new(),
            profile: row.get("profile"),
            mode,
            epoch,
        };
        if row.get::<Option<DateTime<Utc>>, _>("consumed_at").is_some()
            || row.get::<DateTime<Utc>, _>("expires_at") <= Utc::now()
            || expected.mode != mode
            || expected.epoch != epoch
        {
            return Err(collaboration_denied());
        }
        let replica_row = lock_and_load_collaboration_replica(
            &mut transaction,
            collection_id,
            token_hash(bearer),
        )
        .await?;
        let binding = collaboration_binding(
            &replica_row,
            collection_id,
            mode,
            origin,
            &ticket_request.profile,
        )?;
        if replica_row.get::<Uuid, _>("id") != row.get::<Uuid, _>("replica_id")
            || binding.scope_epoch != number(row.get::<i64, _>("scope_epoch"), "scope epoch")?
            || binding.proof_digest.as_slice()
                != row.get::<Vec<u8>, _>("proof_public_key_digest").as_slice()
            || binding.origin != row.get::<String, _>("allowed_origin")
        {
            return Err(collaboration_denied());
        }
        // Resolve the expected path only after bearer/origin/proof and the
        // current replica binding have passed. A ticket cannot be moved to a
        // different path or room by its consumer.
        let collection = sqlx::query(
            "SELECT wrapped_data_key FROM hosted_provider_collections
             WHERE id=$1 AND state='active' FOR SHARE",
        )
        .bind(collection_id)
        .fetch_one(&mut *transaction)
        .await?;
        let data_key = self
            .collection_key(collection_id, collection.get("wrapped_data_key"))
            .await?;
        let expected_record: Option<Uuid> = sqlx::query_scalar(
            "SELECT record_id FROM hosted_provider_records
             WHERE collection_id=$1 AND path_token=$2",
        )
        .bind(collection_id)
        .bind(path_token(&data_key, &expected.path))
        .fetch_optional(&mut *transaction)
        .await?;
        let record_id: Uuid = row.get("record_id");
        if expected_record != Some(record_id) {
            return Err(collaboration_denied());
        }
        let room = RoomIdentity::new(collection_id, record_id, epoch, COLLABORATION_PROFILE)
            .ok_or_else(collaboration_denied)?;
        let active = sqlx::query_scalar::<_, String>(
            "SELECT state FROM hosted_provider_collaboration_documents
             WHERE collection_id=$1 AND record_id=$2 AND collaboration_epoch=$3 AND profile=$4",
        )
        .bind(room.collection_id)
        .bind(room.record_id)
        .bind(to_i64(epoch, "collaboration epoch")?)
        .bind(room.profile)
        .fetch_optional(&mut *transaction)
        .await?;
        if active.as_deref() != Some("active") {
            return Err(collaboration_denied());
        }
        let consumed = sqlx::query("UPDATE hosted_provider_collaboration_tickets SET consumed_at=now() WHERE ticket_hash=$1 AND consumed_at IS NULL AND expires_at > now()")
            .bind(hash.as_slice()).execute(&mut *transaction).await?;
        if consumed.rows_affected() != 1 {
            return Err(collaboration_denied());
        }
        transaction.commit().await?;
        Ok(ConsumedCollaborationTicket {
            metadata: CollaborationTicketMetadata {
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
        || row.get::<bool, _>("full_collection")
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

// Ticket lookup must not turn an unknown ticket into a room oracle. The
// collection hint is obtained only from a hash lookup and is never returned.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_plaintext_is_exactly_256_bits_and_hashes_without_reuse() {
        let mut bytes = [0_u8; 32];
        OsRng.fill_bytes(&mut bytes);
        let encoded = URL_SAFE_NO_PAD.encode(bytes);
        assert_eq!(URL_SAFE_NO_PAD.decode(encoded).unwrap().len(), 32);
        assert_ne!(Sha256::digest(bytes), Sha256::digest([0_u8; 32]));
    }

    #[test]
    fn modes_are_closed_and_wire_stable() {
        assert_eq!(mode_text(CollaborationMode::ReadOnly), "read_only");
        assert_eq!(mode_text(CollaborationMode::ReadWrite), "read_write");
        assert!(parse_mode("other".to_owned()).is_err());
    }
}

async fn expected_collection_hint(pool: &PgPool, plaintext: &str) -> ApiResult<Uuid> {
    let decoded = URL_SAFE_NO_PAD
        .decode(plaintext)
        .map_err(|_| collaboration_denied())?;
    if decoded.len() != 32 {
        return Err(collaboration_denied());
    }
    sqlx::query_scalar(
        "SELECT collection_id FROM hosted_provider_collaboration_tickets WHERE ticket_hash=$1",
    )
    .bind(Sha256::digest(decoded).as_slice())
    .fetch_optional(pool)
    .await?
    .ok_or_else(collaboration_denied)
}
