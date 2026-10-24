//! Permanent collection deletion floor, independent of CP/credential backups.
//! No positive liveness permit; exactly one immutable tuple per collection.
use super::*;
use mdbn_log_service::auth::Principal;
use mdbn_wire::cbor::Cbor;
use mdbn_wire::schema::Wire;

const PAGE_ROWS: usize = 128;
pub(super) const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS collection_deletion_floor (collection BLOB PRIMARY KEY, deletion_id BLOB NOT NULL, lifecycle_epoch BLOB NOT NULL)",
    "CREATE TABLE IF NOT EXISTS collection_deletion_revision (k INTEGER PRIMARY KEY, revision BLOB NOT NULL)",
    "INSERT OR IGNORE INTO collection_deletion_revision VALUES (0, zeroblob(8))",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct DeletionRecord {
    pub collection: Uuid,
    pub deletion_id: Uuid,
    pub lifecycle_epoch: u64,
}
impl DeletionRecord {
    fn to_cbor(self) -> Cbor {
        Cbor::Array(vec![
            self.collection.to_cbor(),
            self.deletion_id.to_cbor(),
            Cbor::Uint(self.lifecycle_epoch),
        ])
    }
}
fn unavailable() -> ServiceError {
    ServiceError::reason(
        mdbn_log_service::Code::Unavailable,
        "collection_deletion_floor_unavailable",
    )
}
fn invalid() -> ServiceError {
    ServiceError::invalid("collection_deletion_request")
}
fn params(value: &Cbor, count: usize) -> LsResult<Vec<&Cbor>> {
    let Cbor::Map(fields) = value else {
        return Err(invalid());
    };
    if fields.len() != count
        || fields
            .iter()
            .enumerate()
            .any(|(i, (k, _))| *k != Cbor::Uint(i as u64))
    {
        return Err(invalid());
    }
    Ok(fields.iter().map(|(_, v)| v).collect())
}
fn uuid(value: &Cbor) -> LsResult<Uuid> {
    let id = Uuid::from_cbor(value).map_err(|_| invalid())?;
    if id == REGISTRY {
        return Err(invalid());
    }
    Ok(id)
}
fn uint(value: &Cbor) -> LsResult<u64> {
    u64::from_cbor(value).map_err(|_| invalid())
}
fn stored_uint(value: &SqlStorageValue) -> LsResult<u64> {
    let bytes: [u8; 8] = as_bytes(value).try_into().map_err(|_| unavailable())?;
    Ok(u64::from_be_bytes(bytes))
}
fn record(row: &[SqlStorageValue]) -> LsResult<DeletionRecord> {
    if row.len() != 3 {
        return Err(unavailable());
    }
    let collection: [u8; 16] = as_bytes(&row[0]).try_into().map_err(|_| unavailable())?;
    let deletion_id: [u8; 16] = as_bytes(&row[1]).try_into().map_err(|_| unavailable())?;
    let lifecycle_epoch = stored_uint(&row[2])?;
    if collection == [0; 16] || deletion_id == [0; 16] || lifecycle_epoch == 0 {
        return Err(unavailable());
    }
    Ok(DeletionRecord {
        collection: B16(collection),
        deletion_id: B16(deletion_id),
        lifecycle_epoch,
    })
}
fn reply(fields: Vec<(u64, Cbor)>) -> Cbor {
    Cbor::Map(
        fields
            .into_iter()
            .map(|(k, v)| (Cbor::Uint(k), v))
            .collect(),
    )
}

impl DoBackend {
    fn deletion_revision(&self) -> LsResult<u64> {
        let rows = self.exec(
            "SELECT revision FROM collection_deletion_revision WHERE k = 0",
            vec![],
        )?;
        stored_uint(
            rows.first()
                .and_then(|r| r.first())
                .ok_or_else(unavailable)?,
        )
    }
    pub(super) fn deletion_floor_local(
        &self,
        collection: &Uuid,
    ) -> LsResult<Option<DeletionRecord>> {
        if self.route()? != Some(REGISTRY) || !self.is_registry.get() {
            return Err(unavailable());
        }
        let rows = self.exec("SELECT collection, deletion_id, lifecycle_epoch FROM collection_deletion_floor WHERE collection = ?", vec![blob(&collection.0)])?;
        rows.first().map(|r| record(r)).transpose()
    }
    pub(super) async fn deletion_registry_call(
        &self,
        principal: &Principal,
        method: &str,
        value: &Cbor,
    ) -> LsResult<Cbor> {
        if !matches!(principal, Principal::ControlPlane) {
            return Err(ServiceError::reason(
                mdbn_log_service::Code::Forbidden,
                "principal",
            ));
        }
        if self.route()? != Some(REGISTRY) || !self.is_registry.get() {
            return Err(invalid());
        }
        let count = match method {
            "registry_record_collection_deletion" => 4,
            "registry_collection_deletions" => 3,
            "registry_collection_deletion" => 2,
            _ => return Err(invalid()),
        };
        let fields = params(value, count)?;
        if Uuid::from_cbor(fields[0]).map_err(|_| invalid())? != REGISTRY {
            return Err(invalid());
        }
        let _guard = self.lock.lock().await;
        // No awaits below: generation/records/receipts share this synchronous
        // actor boundary. Nonce consumption never advances floor revision.
        if method == "registry_record_collection_deletion" {
            let requested = DeletionRecord {
                collection: uuid(fields[1])?,
                deletion_id: uuid(fields[2])?,
                lifecycle_epoch: uint(fields[3])?,
            };
            if requested.lifecycle_epoch == 0 {
                return Err(invalid());
            }
            let current = self.deletion_floor_local(&requested.collection)?;
            let actual = current.unwrap_or(requested);
            if current.is_none() {
                self.refuse_collection_closing(&requested.collection)?;
                let next = self
                    .deletion_revision()?
                    .checked_add(1)
                    .ok_or_else(unavailable)?;
                let sql = self.sql.clone();
                transaction_sync(&self.storage, move || {
                    collection_closing::refuse_new_floor(&sql, &requested.collection)
                        .map_err(|e| JsValue::from_str(&e.to_string()))?;
                    sql.exec_raw(
                        "INSERT INTO collection_deletion_floor VALUES (?, ?, ?)",
                        vec![
                            blob(&requested.collection.0),
                            blob(&requested.deletion_id.0),
                            blob(&requested.lifecycle_epoch.to_be_bytes()),
                        ],
                    )
                    .map_err(|e| JsValue::from_str(&e.to_string()))?;
                    sql.exec_raw(
                        "UPDATE collection_deletion_revision SET revision = ? WHERE k = 0",
                        vec![blob(&next.to_be_bytes())],
                    )
                    .map_err(|e| JsValue::from_str(&e.to_string()))?;
                    Ok(())
                })?;
            }
            let receipt = reply(vec![
                (0, Cbor::Uint(1)),
                (1, actual.collection.to_cbor()),
                (2, actual.deletion_id.to_cbor()),
                (3, Cbor::Uint(actual.lifecycle_epoch)),
                (4, Cbor::Uint(self.deletion_revision()?)),
            ]);
            // Refuse conflicts with the FIRST receipt in error details. Never
            // mutate/bump the record or return a successful mismatched receipt.
            if actual != requested {
                let mut error = ServiceError::reason(
                    mdbn_log_service::Code::Forbidden,
                    "collection_deletion_conflict",
                );
                error.details = Some(receipt);
                return Err(error);
            }
            return Ok(receipt);
        }
        if method == "registry_collection_deletion" {
            let collection = uuid(fields[1])?;
            let floor = self.deletion_floor_local(&collection)?;
            return Ok(reply(vec![
                (0, Cbor::Uint(1)),
                (1, collection.to_cbor()),
                (2, floor.map_or(Cbor::Null, DeletionRecord::to_cbor)),
                (3, Cbor::Uint(self.deletion_revision()?)),
            ]));
        }
        let after = match fields[1] {
            Cbor::Null => None,
            value => Some(uuid(value)?),
        };
        let expected = match fields[2] {
            Cbor::Null => None,
            value => Some(uint(value)?),
        };
        if after.is_some() && expected.is_none() {
            return Err(invalid());
        }
        let revision = self.deletion_revision()?;
        if expected.is_some_and(|n| n != revision) {
            return Err(unavailable());
        }
        let rows = self.exec("SELECT collection, deletion_id, lifecycle_epoch FROM collection_deletion_floor WHERE collection > ? ORDER BY collection LIMIT 128", vec![blob(&after.unwrap_or(REGISTRY).0)])?;
        let records: Vec<DeletionRecord> =
            rows.iter().map(|r| record(r)).collect::<LsResult<_>>()?;
        let next = records.last().map(|r| r.collection).or(after);
        Ok(reply(vec![
            (0, Cbor::Uint(1)),
            (1, Cbor::Uint(revision)),
            (
                2,
                Cbor::Array(records.into_iter().map(DeletionRecord::to_cbor).collect()),
            ),
            (3, next.map_or(Cbor::Null, |id| id.to_cbor())),
            (4, Cbor::Bool(rows.len() < PAGE_ROWS)),
        ]))
    }
}
