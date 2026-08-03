use super::*;

const ENCRYPTED_REPLAY_WINDOW: u64 = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncryptedRequestClaim {
    Fresh,
    Completed(String),
    InProgress,
}

pub fn encrypted_request_fingerprint(
    envelope: &EncryptedRelayEnvelope,
) -> Result<String, ConnectError> {
    let digest = Sha256::digest(serde_json::to_vec(envelope)?);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

impl CollectionRegistry {
    /// Atomically claims a fresh encrypted request or returns its durable response receipt.
    ///
    /// Authentication must happen before this call so unauthenticated traffic cannot advance the
    /// durable replay window. The immediate transaction makes concurrent duplicate deliveries
    /// deterministic across relay sessions and process threads.
    pub fn claim_encrypted_request(
        &self,
        grant_id: Uuid,
        key_id: &str,
        counter: u64,
        request_id: Uuid,
        request_fingerprint: &str,
    ) -> Result<EncryptedRequestClaim, ConnectError> {
        // SQLite permits one writer at a time. Keep the small replay-ledger transactions ordered
        // within this connector process so bursts of authenticated operations cannot turn normal
        // writer contention into a false security rejection. Collection operations themselves stay
        // concurrent, and SQLite remains the cross-process serialization boundary.
        let _write_guard = self
            .encrypted_request_writes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state = transaction
            .query_row(
                "SELECT last_request_counter, reorder_floor FROM grant_crypto_state
                 WHERE grant_id = ?1 AND key_id = ?2",
                params![grant_id.to_string(), key_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
            .map(
                |(last, floor)| -> Result<(u64, u64), std::num::ParseIntError> {
                    Ok((last.parse::<u64>()?, floor.parse::<u64>()?))
                },
            )
            .transpose()
            .map_err(|_| ConnectError::EncryptedRelayRejected)?;
        let existing = transaction
            .query_row(
                "SELECT request_fingerprint, response_envelope FROM grant_crypto_requests
                 WHERE grant_id = ?1 AND key_id = ?2 AND request_id = ?3",
                params![grant_id.to_string(), key_id, request_id.to_string()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?;
        if let Some((fingerprint, response)) = existing {
            if fingerprint != request_fingerprint {
                return Err(ConnectError::EncryptedRelayRejected);
            }
            transaction.commit()?;
            return Ok(match response {
                Some(response) => EncryptedRequestClaim::Completed(response),
                None => EncryptedRequestClaim::InProgress,
            });
        }
        let duplicate_counter = transaction
            .query_row(
                "SELECT 1 FROM grant_crypto_requests
                 WHERE grant_id = ?1 AND key_id = ?2 AND request_counter = ?3",
                params![grant_id.to_string(), key_id, counter.to_string()],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        let reorder_floor = state.map_or(0, |(_, floor)| floor);
        if duplicate_counter || counter <= reorder_floor {
            return Err(ConnectError::EncryptedRelayRejected);
        }
        let last = state.map_or(counter, |(last, _)| last.max(counter));
        let reorder_floor = reorder_floor.max(last.saturating_sub(ENCRYPTED_REPLAY_WINDOW));
        transaction.execute(
            "INSERT INTO grant_crypto_state
               (grant_id, key_id, last_request_counter, reorder_floor)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(grant_id, key_id) DO UPDATE SET
               last_request_counter = excluded.last_request_counter,
               reorder_floor = excluded.reorder_floor",
            params![
                grant_id.to_string(),
                key_id,
                last.to_string(),
                reorder_floor.to_string()
            ],
        )?;
        transaction.execute(
            "INSERT INTO grant_crypto_requests
               (grant_id, key_id, request_id, request_counter, request_fingerprint)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                grant_id.to_string(),
                key_id,
                request_id.to_string(),
                counter.to_string(),
                request_fingerprint
            ],
        )?;
        transaction.execute(
            "DELETE FROM grant_crypto_requests
             WHERE grant_id = ?1 AND key_id = ?2 AND response_envelope IS NOT NULL
               AND rowid NOT IN (
               SELECT rowid FROM grant_crypto_requests
               WHERE grant_id = ?1 AND key_id = ?2
                 AND response_envelope IS NOT NULL
               ORDER BY rowid DESC LIMIT 1024
             )",
            params![grant_id.to_string(), key_id],
        )?;
        transaction.commit()?;
        Ok(EncryptedRequestClaim::Fresh)
    }

    pub fn complete_encrypted_request(
        &self,
        grant_id: Uuid,
        key_id: &str,
        request_id: Uuid,
        request_fingerprint: &str,
        response_envelope: &str,
    ) -> Result<(), ConnectError> {
        let _write_guard = self
            .encrypted_request_writes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let updated = self.connection()?.execute(
            "UPDATE grant_crypto_requests SET response_envelope = ?5
             WHERE grant_id = ?1 AND key_id = ?2 AND request_id = ?3
               AND request_fingerprint = ?4 AND response_envelope IS NULL",
            params![
                grant_id.to_string(),
                key_id,
                request_id.to_string(),
                request_fingerprint,
                response_envelope
            ],
        )?;
        if updated != 1 {
            return Err(ConnectError::EncryptedRelayRejected);
        }
        Ok(())
    }

    pub fn encrypted_request_response(
        &self,
        grant_id: Uuid,
        key_id: &str,
        request_id: Uuid,
        request_fingerprint: &str,
    ) -> Result<Option<String>, ConnectError> {
        self.connection()?
            .query_row(
                "SELECT response_envelope FROM grant_crypto_requests
                 WHERE grant_id = ?1 AND key_id = ?2 AND request_id = ?3
                   AND request_fingerprint = ?4",
                params![
                    grant_id.to_string(),
                    key_id,
                    request_id.to_string(),
                    request_fingerprint
                ],
                |row| row.get(0),
            )
            .optional()
            .map_err(ConnectError::from)
    }
}
