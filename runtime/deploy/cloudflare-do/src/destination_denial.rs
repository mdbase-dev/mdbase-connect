//! Monotonic local SQL denial, independent of the awaited producer write lock.
//!
//! This is a refusal-only latch, not a destination fence receipt or liveness
//! authority. Absence preserves existing behavior; it never authorizes a future
//! positive issuer. No restore, export, clear, generation or reopen operation.
use super::*;
use mdbn_wire::cbor::Cbor;

pub(super) const PATH: &str = "/v1/collection-destination-close";
pub(super) const METHOD: &str = "collection_destination_close";
pub(super) const BODY_CAP: usize = 1024;

/// The small body reservation is only for denial, never ordinary RPC dispatch.
pub(super) fn transport_matches(path: &str, method: &str) -> bool {
    (path == PATH) == (method == METHOD)
}

pub(super) const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS log_destination_denial (k INTEGER PRIMARY KEY CHECK (k = 0), version BLOB NOT NULL, collection BLOB NOT NULL, deletion_id BLOB NOT NULL, lifecycle_epoch BLOB NOT NULL)",
];

fn unavailable() -> ServiceError {
    ServiceError::reason(
        mdbn_log_service::Code::Unavailable,
        "collection_destination_denial_unavailable",
    )
}
fn invalid() -> ServiceError {
    ServiceError::invalid("collection_destination_close_request")
}

/// Presence alone denies, even if its contents are malformed. SQL failure is
/// unknown/denied. Call inside the actual synchronous effect transaction too.
pub(super) fn refuse(sql: &SqlStorage) -> LsResult<()> {
    let cursor = sql
        .exec_raw("SELECT 1 FROM log_destination_denial LIMIT 1", vec![])
        .map_err(|_| unavailable())?;
    match cursor.raw().next() {
        None => Ok(()),
        Some(Ok(_)) => Err(ServiceError::reason(
            mdbn_log_service::Code::Unavailable,
            "collection_destination_closing",
        )),
        Some(Err(_)) => Err(unavailable()),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Closing {
    collection: Uuid,
    deletion_id: Uuid,
    lifecycle_epoch: u64,
}
impl Closing {
    fn reply(self) -> Cbor {
        Cbor::Map(vec![
            (Cbor::Uint(0), Cbor::Uint(1)),
            (Cbor::Uint(1), self.collection.to_cbor()),
            (Cbor::Uint(2), self.deletion_id.to_cbor()),
            (Cbor::Uint(3), Cbor::Uint(self.lifecycle_epoch)),
            (Cbor::Uint(4), Cbor::Text("log_sql_closing".into())),
        ])
    }
}
fn stored(row: &[SqlStorageValue]) -> LsResult<Closing> {
    if row.len() != 4 || as_bytes(&row[0]) != [1] {
        return Err(unavailable());
    }
    let collection = B16(as_bytes(&row[1]).try_into().map_err(|_| unavailable())?);
    let deletion_id = B16(as_bytes(&row[2]).try_into().map_err(|_| unavailable())?);
    let epoch = u64::from_be_bytes(as_bytes(&row[3]).try_into().map_err(|_| unavailable())?);
    if collection == REGISTRY || deletion_id == REGISTRY || epoch == 0 {
        return Err(unavailable());
    }
    Ok(Closing {
        collection,
        deletion_id,
        lifecycle_epoch: epoch,
    })
}

impl DoBackend {
    pub(super) fn refuse_destination_denial(&self) -> LsResult<()> {
        refuse(&self.sql)
    }

    /// Authenticated CP HTTPS dispatch only. Deliberately synchronous: a
    /// producer may hold `lock` while paused in nil/R2 I/O. Closing cannot wait
    /// for that producer to resume. SQL/output gates own durable ordering.
    pub(super) fn destination_close_call(
        &self,
        principal: &Principal,
        value: &Cbor,
    ) -> LsResult<Cbor> {
        if !matches!(principal, Principal::ControlPlane) {
            return Err(ServiceError::reason(
                mdbn_log_service::Code::Forbidden,
                "principal",
            ));
        }
        let Cbor::Map(fields) = value else {
            return Err(invalid());
        };
        if fields.len() != 4
            || fields
                .iter()
                .enumerate()
                .any(|(i, (key, _))| *key != Cbor::Uint(i as u64))
            || fields[1].1 != Cbor::Uint(1)
        {
            return Err(invalid());
        }
        let requested = Closing {
            collection: Uuid::from_cbor(&fields[0].1).map_err(|_| invalid())?,
            deletion_id: Uuid::from_cbor(&fields[2].1).map_err(|_| invalid())?,
            lifecycle_epoch: u64::from_cbor(&fields[3].1).map_err(|_| invalid())?,
        };
        if requested.collection == REGISTRY
            || requested.deletion_id == REGISTRY
            || requested.lifecycle_epoch == 0
            || self.is_registry.get()
            || self.route()? != Some(requested.collection)
        {
            return Err(invalid());
        }
        // No await or external callback between inspection and transaction.
        // First identity is immutable; malformed presence never gets replaced.
        let rows = self.exec("SELECT version, collection, deletion_id, lifecycle_epoch FROM log_destination_denial LIMIT 2", vec![]).map_err(|_| unavailable())?;
        let actual = match rows.as_slice() {
            [] => {
                let sql = self.sql.clone();
                transaction_sync(&self.storage, move || {
                    sql.exec_raw(
                        "INSERT INTO log_destination_denial VALUES (0, ?, ?, ?, ?)",
                        vec![
                            blob(&[1]),
                            blob(&requested.collection.0),
                            blob(&requested.deletion_id.0),
                            blob(&requested.lifecycle_epoch.to_be_bytes()),
                        ],
                    )
                    .map_err(|e| JsValue::from_str(&e.to_string()))?;
                    Ok(())
                })?;
                requested
            }
            [row] => stored(row)?,
            _ => return Err(unavailable()),
        };
        if actual != requested {
            let mut error = ServiceError::reason(
                mdbn_log_service::Code::Forbidden,
                "collection_destination_close_conflict",
            );
            error.details = Some(actual.reply());
            return Err(error);
        }
        // Acknowledges local SQL denial only. Never independent floor/Gone,
        // physical R2/egress/issuer completion, or an aggregate fence receipt.
        Ok(actual.reply())
    }
}
