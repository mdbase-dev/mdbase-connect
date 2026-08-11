use super::*;
use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::time::{Duration, Instant};

const ENCRYPTED_REPLAY_WINDOW: u64 = 1024;
const EPHEMERAL_RESPONSE_MAX_COUNT: usize = 128;
const EPHEMERAL_RESPONSE_MAX_BYTES: usize = 32 * 1024 * 1024;
const EPHEMERAL_RESPONSE_MAX_AGE: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncryptedReplayClass {
    Read,
    Mutation,
}

impl EncryptedReplayClass {
    fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Mutation => "mutation",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncryptedRequestClaim {
    Fresh,
    Completed(String),
    InProgress,
    FreshRequired,
    Conflict,
}

#[derive(Debug, Clone, Eq)]
struct EphemeralRequestKey {
    grant_id: Uuid,
    key_id: String,
    request_id: Uuid,
    fingerprint: String,
}

impl PartialEq for EphemeralRequestKey {
    fn eq(&self, other: &Self) -> bool {
        self.grant_id == other.grant_id
            && self.key_id == other.key_id
            && self.request_id == other.request_id
            && self.fingerprint == other.fingerprint
    }
}

impl Hash for EphemeralRequestKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.grant_id.hash(state);
        self.key_id.hash(state);
        self.request_id.hash(state);
        self.fingerprint.hash(state);
    }
}

#[derive(Debug)]
enum EphemeralResponse {
    InFlight {
        started: Instant,
    },
    Completed {
        response: String,
        completed: Instant,
    },
}

#[derive(Debug, Default)]
pub(super) struct EphemeralResponseCache {
    entries: HashMap<EphemeralRequestKey, EphemeralResponse>,
    completed_order: VecDeque<EphemeralRequestKey>,
    completed_bytes: usize,
}

impl EphemeralResponseCache {
    fn begin(&mut self, key: EphemeralRequestKey) {
        self.prune();
        self.entries.insert(
            key,
            EphemeralResponse::InFlight {
                started: Instant::now(),
            },
        );
    }

    fn claim(&mut self, key: &EphemeralRequestKey) -> EncryptedRequestClaim {
        self.prune();
        match self.entries.get(key) {
            Some(EphemeralResponse::InFlight { .. }) => EncryptedRequestClaim::InProgress,
            Some(EphemeralResponse::Completed { response, .. }) => {
                EncryptedRequestClaim::Completed(response.clone())
            }
            None => EncryptedRequestClaim::FreshRequired,
        }
    }

    fn complete(&mut self, key: EphemeralRequestKey, response: String) -> bool {
        self.prune();
        if !matches!(
            self.entries.get(&key),
            Some(EphemeralResponse::InFlight { .. })
        ) {
            return false;
        }
        self.completed_bytes = self.completed_bytes.saturating_add(response.len());
        self.entries.insert(
            key.clone(),
            EphemeralResponse::Completed {
                response,
                completed: Instant::now(),
            },
        );
        self.completed_order.push_back(key);
        self.prune();
        true
    }

    fn response(&mut self, key: &EphemeralRequestKey) -> Option<String> {
        self.prune();
        match self.entries.get(key) {
            Some(EphemeralResponse::Completed { response, .. }) => Some(response.clone()),
            _ => None,
        }
    }

    fn prune(&mut self) {
        let now = Instant::now();
        self.entries.retain(|_, entry| match entry {
            EphemeralResponse::InFlight { started } => {
                now.duration_since(*started) <= EPHEMERAL_RESPONSE_MAX_AGE
            }
            EphemeralResponse::Completed { .. } => true,
        });
        loop {
            let Some(key) = self.completed_order.front() else {
                break;
            };
            let remove = match self.entries.get(key) {
                Some(EphemeralResponse::Completed { completed, .. }) => {
                    self.completed_order.len() > EPHEMERAL_RESPONSE_MAX_COUNT
                        || self.completed_bytes > EPHEMERAL_RESPONSE_MAX_BYTES
                        || now.duration_since(*completed) > EPHEMERAL_RESPONSE_MAX_AGE
                }
                _ => true,
            };
            if !remove {
                break;
            }
            let key = self.completed_order.pop_front().expect("front existed");
            if let Some(EphemeralResponse::Completed { response, .. }) = self.entries.remove(&key) {
                self.completed_bytes = self.completed_bytes.saturating_sub(response.len());
            }
        }
    }
}

pub fn encrypted_request_fingerprint(
    envelope: &EncryptedRelayEnvelope,
) -> Result<String, ConnectError> {
    // Scheduling hints are intentionally not authenticated and must not alter
    // the durable replay identity of the encrypted operation.
    let mut authenticated_envelope = envelope.clone();
    authenticated_envelope.deadline_unix_ms = None;
    let digest = Sha256::digest(serde_json::to_vec(&authenticated_envelope)?);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

impl CollectionRegistry {
    /// Atomically claims a fresh authenticated envelope under the currently
    /// installed grant, or resolves its operation-class replay behavior.
    #[allow(clippy::too_many_arguments)]
    pub fn claim_encrypted_request(
        &self,
        grant_id: Uuid,
        key_id: &str,
        operation: &str,
        replay_class: EncryptedReplayClass,
        counter: u64,
        request_id: Uuid,
        request_fingerprint: &str,
        protocol_version: u32,
    ) -> Result<EncryptedRequestClaim, ConnectError> {
        let key_id = key_id.to_string();
        let operation = operation.to_string();
        let request_fingerprint = request_fingerprint.to_string();
        let process_epoch = self.process_epoch.to_string();
        let write_key_id = key_id.clone();
        let write_fingerprint = request_fingerprint.clone();
        let write_process_epoch = process_epoch.clone();
        let result =
            self.authority
                .write(AuthorityWritePriority::Admission, move |connection| {
                    let transaction =
                        connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                    let existing = transaction
                        .query_row(
                            "SELECT request_fingerprint, replay_class, process_epoch,
                                    response_receipt, response_expired
                         FROM grant_crypto_requests
                         WHERE grant_id = ?1 AND key_id = ?2 AND request_id = ?3",
                            params![grant_id.to_string(), write_key_id, request_id.to_string()],
                            |row| {
                                Ok((
                                    row.get::<_, String>(0)?,
                                    row.get::<_, String>(1)?,
                                    row.get::<_, String>(2)?,
                                    row.get::<_, Option<String>>(3)?,
                                    row.get::<_, bool>(4)?,
                                ))
                            },
                        )
                        .optional()?;
                    if let Some((fingerprint, stored_class, stored_epoch, receipt, expired)) = existing {
                        if fingerprint != write_fingerprint || stored_class != replay_class.as_str()
                        {
                            transaction.commit()?;
                            return Ok(DatabaseClaim::Conflict);
                        }
                        let claim = match replay_class {
                            EncryptedReplayClass::Mutation => DatabaseClaim::MutationReplay,
                            EncryptedReplayClass::Read if expired => {
                                DatabaseClaim::FreshReadRequired
                            }
                            EncryptedReplayClass::Read if receipt.is_some() => {
                                DatabaseClaim::DurableReadReplay(receipt.expect("checked"))
                            }
                            EncryptedReplayClass::Read if stored_epoch == write_process_epoch => {
                                DatabaseClaim::LocalReadReplay
                            }
                            EncryptedReplayClass::Read
                                if protocol_version
                                    == mdbase_connect_protocol::LEGACY_OPERATION_TRANSPORT_PROTOCOL_VERSION =>
                            {
                                transaction.execute(
                                    "UPDATE grant_crypto_requests SET process_epoch = ?4
                                     WHERE grant_id = ?1 AND key_id = ?2 AND request_id = ?3",
                                    params![
                                        grant_id.to_string(),
                                        write_key_id,
                                        request_id.to_string(),
                                        write_process_epoch
                                    ],
                                )?;
                                DatabaseClaim::Fresh
                            }
                            EncryptedReplayClass::Read => DatabaseClaim::FreshReadRequired,
                        };
                        transaction.commit()?;
                        return Ok(claim);
                    }

                    let authorization = transaction
                        .query_row(
                            "SELECT operations, file_capability, collection_id FROM grants
                         WHERE id = ?1 AND json_extract(encryption, '$.key_id') = ?2",
                            params![grant_id.to_string(), write_key_id],
                            |row| {
                                Ok((
                                    row.get::<_, String>(0)?,
                                    row.get::<_, Option<String>>(1)?,
                                    row.get::<_, String>(2)?,
                                ))
                            },
                        )
                        .optional()?;
                    let Some((operations, file_capability, collection_id)) = authorization else {
                        return Err(ConnectError::AccessDenied(
                            "The grant was revoked before this request was accepted.".to_string(),
                        ));
                    };
                    let paused = transaction
                        .query_row(
                            "SELECT value FROM authority_settings WHERE key = 'access_paused'",
                            [],
                            |row| row.get::<_, String>(0),
                        )
                        .optional()?
                        .as_deref()
                        == Some("true");
                    let collection_enabled = transaction
                        .query_row(
                            "SELECT enabled FROM collection_access_overlays
                             WHERE collection_id = ?1",
                            [collection_id],
                            |row| row.get::<_, bool>(0),
                        )
                        .optional()?
                        .unwrap_or(false);
                    if paused {
                        return Err(ConnectError::AccessPaused);
                    }
                    if !collection_enabled {
                        return Err(ConnectError::AccessDenied(
                            "Remote access to this collection is disabled.".to_string(),
                        ));
                    }
                    let allowed = if operation == "file_control" {
                        file_capability.is_some()
                    } else {
                        serde_json::from_str::<Vec<String>>(&operations)?
                            .iter()
                            .any(|allowed| allowed == &operation)
                    };
                    if !allowed {
                        return Err(ConnectError::AccessDenied(
                            "The operation is no longer allowed by the installed policy."
                                .to_string(),
                        ));
                    }

                    let state = transaction
                        .query_row(
                            "SELECT last_request_counter, reorder_floor FROM grant_crypto_state
                         WHERE grant_id = ?1 AND key_id = ?2",
                            params![grant_id.to_string(), write_key_id],
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
                    let duplicate_counter = transaction
                        .query_row(
                            "SELECT 1 FROM grant_crypto_requests
                         WHERE grant_id = ?1 AND key_id = ?2 AND request_counter = ?3",
                            params![grant_id.to_string(), write_key_id, counter.to_string()],
                            |_| Ok(()),
                        )
                        .optional()?
                        .is_some();
                    let reorder_floor = state.map_or(0, |(_, floor)| floor);
                    if duplicate_counter || counter <= reorder_floor {
                        return Err(ConnectError::EncryptedRelayRejected);
                    }
                    let last = state.map_or(counter, |(last, _)| last.max(counter));
                    let reorder_floor =
                        reorder_floor.max(last.saturating_sub(ENCRYPTED_REPLAY_WINDOW));
                    transaction.execute(
                        "INSERT INTO grant_crypto_state
                       (grant_id, key_id, last_request_counter, reorder_floor)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(grant_id, key_id) DO UPDATE SET
                       last_request_counter = excluded.last_request_counter,
                       reorder_floor = excluded.reorder_floor",
                        params![
                            grant_id.to_string(),
                            write_key_id,
                            last.to_string(),
                            reorder_floor.to_string()
                        ],
                    )?;
                    transaction.execute(
                        "INSERT INTO grant_crypto_requests
                       (grant_id, key_id, request_id, request_counter, request_fingerprint,
                        replay_class, process_epoch, received_at_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7,
                             CAST(unixepoch('subsec') * 1000 AS INTEGER))",
                        params![
                            grant_id.to_string(),
                            write_key_id,
                            request_id.to_string(),
                            counter.to_string(),
                            write_fingerprint,
                            replay_class.as_str(),
                            write_process_epoch,
                        ],
                    )?;
                    transaction.execute(
                        "DELETE FROM grant_crypto_requests
                     WHERE grant_id = ?1 AND key_id = ?2 AND replay_class = 'read'
                       AND response_receipt IS NULL
                       AND rowid NOT IN (
                         SELECT rowid FROM grant_crypto_requests
                         WHERE grant_id = ?1 AND key_id = ?2 AND replay_class = 'read'
                         ORDER BY received_at_ms DESC, rowid DESC LIMIT 1024
                       )",
                        params![grant_id.to_string(), write_key_id],
                    )?;
                    transaction.commit()?;
                    Ok(DatabaseClaim::Fresh)
                })?;

        let cache_key = EphemeralRequestKey {
            grant_id,
            key_id,
            request_id,
            fingerprint: request_fingerprint,
        };
        let mut cache = self
            .ephemeral_responses
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Ok(match result {
            DatabaseClaim::Fresh => {
                if replay_class == EncryptedReplayClass::Read {
                    cache.begin(cache_key);
                }
                EncryptedRequestClaim::Fresh
            }
            DatabaseClaim::LocalReadReplay => cache.claim(&cache_key),
            DatabaseClaim::DurableReadReplay(reference) => EncryptedRequestClaim::Completed(
                self.authority.load_legacy_read_receipt(&reference)?,
            ),
            DatabaseClaim::FreshReadRequired => EncryptedRequestClaim::FreshRequired,
            DatabaseClaim::MutationReplay => EncryptedRequestClaim::InProgress,
            DatabaseClaim::Conflict => EncryptedRequestClaim::Conflict,
        })
    }

    pub fn complete_encrypted_request(
        &self,
        grant_id: Uuid,
        key_id: &str,
        request_id: Uuid,
        request_fingerprint: &str,
        response_envelope: &str,
        protocol_version: u32,
    ) -> Result<(), ConnectError> {
        if protocol_version == mdbase_connect_protocol::LEGACY_OPERATION_TRANSPORT_PROTOCOL_VERSION
        {
            self.authority.complete_legacy_read_receipt(
                grant_id,
                key_id,
                request_id,
                request_fingerprint,
                self.process_epoch,
                response_envelope,
            )?;
            let _ = self
                .ephemeral_responses
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .complete(
                    EphemeralRequestKey {
                        grant_id,
                        key_id: key_id.to_string(),
                        request_id,
                        fingerprint: request_fingerprint.to_string(),
                    },
                    response_envelope.to_string(),
                );
            return Ok(());
        }
        let exists = self
            .authority
            .connection()?
            .query_row(
                "SELECT 1 FROM grant_crypto_requests
                 WHERE grant_id = ?1 AND key_id = ?2 AND request_id = ?3
                   AND request_fingerprint = ?4 AND replay_class = 'read'
                   AND process_epoch = ?5",
                params![
                    grant_id.to_string(),
                    key_id,
                    request_id.to_string(),
                    request_fingerprint,
                    self.process_epoch.to_string(),
                ],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        let completed = exists
            && self
                .ephemeral_responses
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .complete(
                    EphemeralRequestKey {
                        grant_id,
                        key_id: key_id.to_string(),
                        request_id,
                        fingerprint: request_fingerprint.to_string(),
                    },
                    response_envelope.to_string(),
                );
        if !completed {
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
        let cached = self
            .ephemeral_responses
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .response(&EphemeralRequestKey {
                grant_id,
                key_id: key_id.to_string(),
                request_id,
                fingerprint: request_fingerprint.to_string(),
            });
        if cached.is_some() {
            return Ok(cached);
        }
        let reference = self
            .authority
            .connection()?
            .query_row(
                "SELECT response_receipt FROM grant_crypto_requests
             WHERE grant_id = ?1 AND key_id = ?2 AND request_id = ?3
               AND request_fingerprint = ?4 AND replay_class = 'read'
               AND response_expired = 0",
                params![
                    grant_id.to_string(),
                    key_id,
                    request_id.to_string(),
                    request_fingerprint
                ],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        reference
            .map(|reference| self.authority.load_legacy_read_receipt(&reference))
            .transpose()
    }
}

enum DatabaseClaim {
    Fresh,
    LocalReadReplay,
    DurableReadReplay(String),
    FreshReadRequired,
    MutationReplay,
    Conflict,
}

#[cfg(test)]
mod cache_tests {
    use super::*;

    fn envelope(deadline_unix_ms: Option<u64>) -> EncryptedRelayEnvelope {
        EncryptedRelayEnvelope {
            protocol_version: 3,
            suite: "test-suite".to_string(),
            request_id: Uuid::from_u128(1),
            grant_id: Uuid::from_u128(2),
            application_id: Uuid::from_u128(3),
            connector_id: Uuid::from_u128(4),
            collection_id: Uuid::from_u128(5),
            operation: "query".to_string(),
            scope_epoch: 1,
            key_id: "test-key".to_string(),
            counter: "1".to_string(),
            deadline_unix_ms,
            ciphertext: "opaque".to_string(),
        }
    }

    fn key() -> EphemeralRequestKey {
        EphemeralRequestKey {
            grant_id: Uuid::nil(),
            key_id: "key".to_string(),
            request_id: Uuid::nil(),
            fingerprint: "fingerprint".to_string(),
        }
    }

    #[test]
    fn response_cache_distinguishes_inflight_completed_and_missing() {
        let mut cache = EphemeralResponseCache::default();
        let key = key();
        assert_eq!(cache.claim(&key), EncryptedRequestClaim::FreshRequired);
        cache.begin(key.clone());
        assert_eq!(cache.claim(&key), EncryptedRequestClaim::InProgress);
        assert!(cache.complete(key.clone(), "response".to_string()));
        assert_eq!(
            cache.claim(&key),
            EncryptedRequestClaim::Completed("response".to_string())
        );
    }

    #[test]
    fn scheduling_deadlines_do_not_change_durable_replay_identity() {
        let without_deadline = encrypted_request_fingerprint(&envelope(None)).unwrap();
        let with_deadline =
            encrypted_request_fingerprint(&envelope(Some(1_800_000_000_000))).unwrap();
        assert_eq!(without_deadline, with_deadline);
    }

    #[test]
    fn response_cache_is_bounded_by_bytes_and_evicts_to_fresh_required() {
        let mut cache = EphemeralResponseCache::default();
        let mut first = None;
        let mut last = None;
        for index in 0..=EPHEMERAL_RESPONSE_MAX_BYTES / (1024 * 1024) {
            let current = EphemeralRequestKey {
                request_id: Uuid::from_u128(index as u128 + 1),
                fingerprint: format!("fingerprint-{index}"),
                ..key()
            };
            cache.begin(current.clone());
            assert!(cache.complete(current.clone(), "x".repeat(1024 * 1024)));
            if index == 0 {
                first = Some(current.clone());
            }
            if index == EPHEMERAL_RESPONSE_MAX_BYTES / (1024 * 1024) {
                last = Some(current);
            }
        }
        assert!(cache.completed_bytes <= EPHEMERAL_RESPONSE_MAX_BYTES);
        assert_eq!(
            cache.claim(first.as_ref().unwrap()),
            EncryptedRequestClaim::FreshRequired
        );
        assert!(matches!(
            cache.claim(last.as_ref().unwrap()),
            EncryptedRequestClaim::Completed(_)
        ));
    }
}
