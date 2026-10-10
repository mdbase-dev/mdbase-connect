//! First nil-authority Closing: denial only, never a completed destination set.
//! Original start is immutable; neither time nor local SQL denial permits a floor.
use super::*;
use mdbn_wire::cbor::Cbor;

pub(super) const PATH: &str = "/v1/registry-collection-closing";
pub(super) const METHOD: &str = "registry_begin_collection_closing";
pub(super) const BODY_CAP: usize = 1024;
const DRAIN_MS: i64 = 30_000;
const MAX_START_MS: i64 = (1_i64 << 53) - 1 - DRAIN_MS;

pub(super) const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS collection_closing (collection BLOB PRIMARY KEY NOT NULL, version BLOB NOT NULL, deletion_id BLOB NOT NULL, lifecycle_epoch BLOB NOT NULL, first_started_at_ms BLOB NOT NULL)",
];

pub(super) fn transport_matches(path: &str, method: &str) -> bool {
    (path == PATH) == (method == METHOD)
}
fn unavailable() -> ServiceError {
    ServiceError::reason(
        mdbn_log_service::Code::Unavailable,
        "collection_closing_unavailable",
    )
}
fn invalid() -> ServiceError {
    ServiceError::invalid("collection_closing_request")
}
fn present(sql: &SqlStorage, query: &str, c: &Uuid) -> LsResult<bool> {
    let cursor = sql
        .exec_raw(query, vec![blob(&c.0)])
        .map_err(|_| unavailable())?;
    match cursor.raw().next() {
        None => Ok(false),
        Some(Ok(_)) => Ok(true),
        Some(Err(_)) => Err(unavailable()),
    }
}

/// Applies to NEW floors only. Existing exact floor retry is historical
/// reconciliation, not proof that its original insertion followed fences.
pub(super) fn refuse_new_floor(sql: &SqlStorage, c: &Uuid) -> LsResult<()> {
    if present(
        sql,
        "SELECT 1 FROM collection_closing WHERE collection = ? LIMIT 1",
        c,
    )? {
        return Err(ServiceError::reason(
            mdbn_log_service::Code::Unavailable,
            "collection_closing_pending",
        ));
    }
    Ok(())
}
fn refuse_existing_floor(sql: &SqlStorage, c: &Uuid) -> LsResult<()> {
    if present(
        sql,
        "SELECT 1 FROM collection_deletion_floor WHERE collection = ? LIMIT 1",
        c,
    )? {
        // Presence is sufficient to forbid relabeling even malformed history.
        // No projection or synthetic claim about a valid earlier receipt.
        return Err(ServiceError::reason(
            mdbn_log_service::Code::Unavailable,
            "collection_closing_reconciliation_required",
        ));
    }
    Ok(())
}

fn first_native_start() -> LsResult<i64> {
    // Preserve the native JS value's type before the WASM f64 import could
    // coerce a nonnumeric clock result (for example, malformed host state).
    let date = Reflect::get(&js_sys::global(), &"Date".into()).map_err(|_| unavailable())?;
    let now: Function = Reflect::get(&date, &"now".into())
        .map_err(|_| unavailable())?
        .dyn_into()
        .map_err(|_| unavailable())?;
    let raw = now
        .call0(&date)
        .map_err(|_| unavailable())?
        .as_f64()
        .ok_or_else(unavailable)?;
    // Validate the actual native reading BEFORE any saturating/lossy cast.
    if !raw.is_finite() || raw.fract() != 0.0 || raw <= 0.0 || raw > MAX_START_MS as f64 {
        return Err(unavailable());
    }
    let start = raw as i64;
    start.checked_add(DRAIN_MS).ok_or_else(unavailable)?;
    Ok(start)
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Identity {
    collection: Uuid,
    deletion_id: Uuid,
    lifecycle_epoch: u64,
}
#[derive(Clone, Copy)]
struct Closing {
    identity: Identity,
    first_started_at_ms: i64,
}
impl Closing {
    fn reply(self) -> Cbor {
        Cbor::Map(vec![
            (Cbor::Uint(0), Cbor::Uint(1)),
            (Cbor::Uint(1), self.identity.collection.to_cbor()),
            (Cbor::Uint(2), self.identity.deletion_id.to_cbor()),
            (Cbor::Uint(3), Cbor::Uint(self.identity.lifecycle_epoch)),
            (Cbor::Uint(4), Cbor::int(self.first_started_at_ms)),
            (Cbor::Uint(5), Cbor::Text("registry_closing".into())),
        ])
    }
}
fn stored(c: Uuid, row: &[SqlStorageValue]) -> LsResult<Closing> {
    if row.len() != 4 || as_bytes(&row[0]) != [1] {
        return Err(unavailable());
    }
    let deletion_id = B16(as_bytes(&row[1]).try_into().map_err(|_| unavailable())?);
    let lifecycle_epoch =
        u64::from_be_bytes(as_bytes(&row[2]).try_into().map_err(|_| unavailable())?);
    let start = i64::from_be_bytes(as_bytes(&row[3]).try_into().map_err(|_| unavailable())?);
    if deletion_id == REGISTRY || lifecycle_epoch == 0 || start <= 0 || start > MAX_START_MS {
        return Err(unavailable());
    }
    start.checked_add(DRAIN_MS).ok_or_else(unavailable)?;
    Ok(Closing {
        identity: Identity {
            collection: c,
            deletion_id,
            lifecycle_epoch,
        },
        first_started_at_ms: start,
    })
}

impl DoBackend {
    pub(super) fn refuse_collection_closing(&self, c: &Uuid) -> LsResult<()> {
        if self.route()? != Some(REGISTRY) || !self.is_registry.get() {
            return Err(unavailable());
        }
        refuse_new_floor(&self.sql, c)
    }

    /// No producer mutex or external await. This acknowledges only the first
    /// persistent denial, not membership, a generation, any receipt or a floor.
    pub(super) fn begin_collection_closing(&self, p: &Principal, value: &Cbor) -> LsResult<Cbor> {
        if !matches!(p, Principal::ControlPlane) {
            return Err(ServiceError::reason(
                mdbn_log_service::Code::Forbidden,
                "principal",
            ));
        }
        let Cbor::Map(fields) = value else {
            return Err(invalid());
        };
        if fields.len() != 5
            || fields
                .iter()
                .enumerate()
                .any(|(i, (key, _))| *key != Cbor::Uint(i as u64))
            || Uuid::from_cbor(&fields[0].1).ok() != Some(REGISTRY)
            || fields[1].1 != Cbor::Uint(1)
            || self.route()? != Some(REGISTRY)
            || !self.is_registry.get()
        {
            return Err(invalid());
        }
        let requested = Identity {
            collection: Uuid::from_cbor(&fields[2].1).map_err(|_| invalid())?,
            deletion_id: Uuid::from_cbor(&fields[3].1).map_err(|_| invalid())?,
            lifecycle_epoch: u64::from_cbor(&fields[4].1).map_err(|_| invalid())?,
        };
        if requested.collection == REGISTRY
            || requested.deletion_id == REGISTRY
            || requested.lifecycle_epoch == 0
        {
            return Err(invalid());
        }
        refuse_existing_floor(&self.sql, &requested.collection)?;
        // Bound every projected field BEFORE workers-rs copies it into Rust.
        // Bad presence projects NULL, never an absent row or large raw BLOB.
        let rows = self.exec("SELECT CASE WHEN typeof(version) = 'blob' AND length(version) = 1 THEN version END, CASE WHEN typeof(deletion_id) = 'blob' AND length(deletion_id) = 16 THEN deletion_id END, CASE WHEN typeof(lifecycle_epoch) = 'blob' AND length(lifecycle_epoch) = 8 THEN lifecycle_epoch END, CASE WHEN typeof(first_started_at_ms) = 'blob' AND length(first_started_at_ms) = 8 THEN first_started_at_ms END FROM collection_closing WHERE collection = ? LIMIT 1", vec![blob(&requested.collection.0)]).map_err(|_| unavailable())?;
        let actual = match rows.as_slice() {
            [] => {
                let sql = self.sql.clone();
                let start = Rc::new(std::cell::Cell::new(None));
                let result = start.clone();
                transaction_sync(&self.storage, move || {
                    refuse_existing_floor(&sql, &requested.collection)
                        .map_err(|e| JsValue::from_str(&e.to_string()))?;
                    let first =
                        first_native_start().map_err(|e| JsValue::from_str(&e.to_string()))?;
                    sql.exec_raw(
                        "INSERT INTO collection_closing VALUES (?, ?, ?, ?, ?)",
                        vec![
                            blob(&requested.collection.0),
                            blob(&[1]),
                            blob(&requested.deletion_id.0),
                            blob(&requested.lifecycle_epoch.to_be_bytes()),
                            blob(&first.to_be_bytes()),
                        ],
                    )
                    .map_err(|e| JsValue::from_str(&e.to_string()))?;
                    result.set(Some(first));
                    Ok(())
                })?;
                Closing {
                    identity: requested,
                    first_started_at_ms: start.get().ok_or_else(unavailable)?,
                }
            }
            [row] => stored(requested.collection, row)?,
            _ => return Err(unavailable()),
        };
        if actual.identity != requested {
            let mut error = ServiceError::reason(
                mdbn_log_service::Code::Forbidden,
                "collection_closing_conflict",
            );
            error.details = Some(actual.reply());
            return Err(error);
        }
        // A valid original start may be future/rollback relative to now. Exact
        // retry keeps denial; no elapsed-time or completion claim is returned.
        Ok(actual.reply())
    }
}
