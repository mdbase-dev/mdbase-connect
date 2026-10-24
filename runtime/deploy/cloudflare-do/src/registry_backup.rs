//! Credential-registry recovery: deny-only merge, never collection-deletion
//! freshness or key/permission authority. Archive authentication is external.
use super::*;
use mdbn_log_service::auth::Principal;
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::schema::Wire;

const LEASE_MS: i64 = 30 * 60 * 1000;
const LIMIT: usize = 100;
pub(super) const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS credential_registry_generation (k INTEGER PRIMARY KEY, generation INTEGER NOT NULL)",
    "INSERT OR IGNORE INTO credential_registry_generation VALUES (0, 0)",
    "CREATE TABLE IF NOT EXISTS registry_backup_cut (k INTEGER PRIMARY KEY, session BLOB NOT NULL, generation INTEGER NOT NULL, expires_at INTEGER NOT NULL, valid INTEGER NOT NULL, page INTEGER NOT NULL, after_row INTEGER NOT NULL, done INTEGER NOT NULL, hash BLOB NOT NULL, previous BLOB NOT NULL, body BLOB NOT NULL)",
    "CREATE TABLE IF NOT EXISTS registry_backup_rows (device BLOB PRIMARY KEY, revoked_at INTEGER NOT NULL)",
];
fn map(fields: Vec<(u64, Cbor)>) -> Cbor {
    Cbor::Map(
        fields
            .into_iter()
            .map(|(k, v)| (Cbor::Uint(k), v))
            .collect(),
    )
}
fn field(value: &Cbor, key: u64) -> Option<&Cbor> {
    let Cbor::Map(fields) = value else {
        return None;
    };
    fields
        .iter()
        .find(|(k, _)| *k == Cbor::Uint(key))
        .map(|(_, v)| v)
}
fn bad(reason: &str) -> ServiceError {
    ServiceError::invalid(reason)
}
fn unavailable() -> ServiceError {
    ServiceError::reason(mdbn_log_service::Code::Unavailable, "registry_backup_state")
}
fn integer(value: &Cbor) -> Option<i64> {
    match value {
        Cbor::Uint(n) if *n < (1u64 << 53) => Some(*n as i64),
        Cbor::Nint(n) if *n < (1u64 << 53) - 1 => Some(-1 - *n as i64),
        _ => None,
    }
}

impl DoBackend {
    /// Synchronous deny-only mutation; no await can split denial and cut invalidation.
    pub(super) fn registry_merge_rows(&self, rows: &[(B16, i64)]) -> LsResult<()> {
        let sql = self.sql.clone();
        let rows = rows.to_vec();
        transaction_sync(&self.storage, move || {
            for (device, revoked_at) in rows {
                // Existing target denial is never removed or made newer by restore.
                let cursor = sql.exec_raw(
                    "INSERT INTO revoked_devices (device, revoked_at) VALUES (?, ?) ON CONFLICT(device) DO UPDATE SET revoked_at = min(revoked_at, excluded.revoked_at) WHERE excluded.revoked_at < revoked_at RETURNING device",
                    vec![blob(&device.0), int(revoked_at)],
                ).map_err(|e| JsValue::from_str(&e.to_string()))?;
                let changed = !cursor
                    .raw()
                    .collect::<Result<Vec<_>>>()
                    .map_err(|e| JsValue::from_str(&e.to_string()))?
                    .is_empty();
                if changed {
                    sql.exec_raw("UPDATE credential_registry_generation SET generation = generation + 1 WHERE k = 0", vec![])
                        .map_err(|e| JsValue::from_str(&e.to_string()))?;
                    sql.exec_raw(
                        "UPDATE registry_backup_cut SET valid = 0 WHERE k = 0",
                        vec![],
                    )
                    .map_err(|e| JsValue::from_str(&e.to_string()))?;
                }
            }
            Ok(())
        })?;
        Ok(())
    }

    pub(super) async fn registry_backup_call(
        &self,
        p: &Principal,
        method: &str,
        params: &Cbor,
    ) -> LsResult<Cbor> {
        if !matches!(p, Principal::ControlPlane) {
            return Err(ServiceError::reason(
                mdbn_log_service::Code::Forbidden,
                "principal",
            ));
        }
        if field(params, 0).and_then(|v| B16::from_cbor(v).ok()) != Some(REGISTRY)
            || self.route()? != Some(REGISTRY)
            || !self.is_registry.get()
        {
            return Err(bad("registry_collection"));
        }
        let _guard = self.lock.lock().await;
        if method == "backup_registry_merge" {
            let Some(Cbor::Array(values)) = field(params, 1) else {
                return Err(bad("registry_rows"));
            };
            if values.len() > LIMIT {
                return Err(bad("registry_rows"));
            }
            let mut rows = Vec::with_capacity(values.len());
            let mut previous = None;
            for value in values {
                let Cbor::Array(row) = value else {
                    return Err(bad("registry_rows"));
                };
                let [device, revoked_at] = row.as_slice() else {
                    return Err(bad("registry_rows"));
                };
                let device = B16::from_cbor(device).map_err(|_| bad("registry_rows"))?;
                let revoked_at = integer(revoked_at).ok_or_else(|| bad("registry_rows"))?;
                if device == REGISTRY || previous.is_some_and(|d| device <= d) {
                    return Err(bad("registry_rows"));
                }
                previous = Some(device);
                rows.push((device, revoked_at));
            }
            self.registry_merge_rows(&rows)?;
            return Ok(map(vec![(0, Cbor::Bool(true))]));
        }
        if method == "backup_registry_begin" {
            return self.registry_backup_begin();
        }
        let session = field(params, 1)
            .and_then(|v| B16::from_cbor(v).ok())
            .ok_or_else(|| bad("registry_session"))?;
        let rows = self.exec("SELECT session, generation, expires_at, valid, page, after_row, done, hash, previous, body FROM registry_backup_cut WHERE k = 0", vec![])?;
        let row = rows
            .first()
            .filter(|r| b16(&r[0]) == session)
            .ok_or_else(unavailable)?;
        if method == "backup_registry_abort" {
            self.exec(
                "UPDATE registry_backup_cut SET valid = 0 WHERE k = 0",
                vec![],
            )?;
            return Ok(map(vec![(0, Cbor::Bool(true))]));
        }
        let generation = self.exec(
            "SELECT generation FROM credential_registry_generation WHERE k = 0",
            vec![],
        )?;
        if as_i64(&row[3]) != 1
            || as_i64(&row[2]) <= now_ms()
            || as_i64(&row[1]) != as_i64(&generation[0][0])
        {
            return Err(unavailable());
        }
        let hash = b32(&row[7]);
        if method == "backup_registry_finish" {
            let expected = field(params, 2)
                .and_then(|v| B32::from_cbor(v).ok())
                .ok_or_else(|| bad("registry_hash"))?;
            if as_i64(&row[6]) != 1 || expected != hash {
                return Err(unavailable());
            }
            return Ok(map(vec![
                (0, Cbor::Uint(1)),
                (1, session.to_cbor()),
                (2, hash.to_cbor()),
                (3, Cbor::int(as_i64(&row[4]))),
            ]));
        }
        if method != "backup_registry_page" {
            return Err(bad("method"));
        }
        let page = field(params, 2)
            .and_then(integer)
            .filter(|n| *n > 0)
            .ok_or_else(|| bad("registry_page"))?;
        let previous = field(params, 3)
            .and_then(|v| B32::from_cbor(v).ok())
            .ok_or_else(|| bad("registry_hash"))?;
        if page == as_i64(&row[4]) {
            if previous != b32(&row[8]) {
                return Err(unavailable());
            }
            return Ok(map(vec![
                (0, Cbor::Bytes(as_bytes(&row[9]))),
                (1, hash.to_cbor()),
            ]));
        }
        if page != as_i64(&row[4]) + 1 || previous != hash || as_i64(&row[6]) != 0 {
            return Err(unavailable());
        }
        let values = self.exec("SELECT rowid, device, revoked_at FROM registry_backup_rows WHERE rowid > ? ORDER BY rowid LIMIT 100", vec![int(as_i64(&row[5]))])?;
        let done = values.is_empty();
        let after = values.last().map_or(as_i64(&row[5]), |r| as_i64(&r[0]));
        let body = map(vec![
            (0, Cbor::Uint(1)),
            (1, REGISTRY.to_cbor()),
            (2, session.to_cbor()),
            (3, Cbor::int(as_i64(&row[1]))),
            (4, Cbor::int(page)),
            (5, hash.to_cbor()),
            (
                6,
                Cbor::Array(
                    values
                        .iter()
                        .map(|r| Cbor::Array(vec![b16(&r[1]).to_cbor(), Cbor::int(as_i64(&r[2]))]))
                        .collect(),
                ),
            ),
            (7, Cbor::Bool(done)),
        ]);
        let bytes = cbor::encode(&body).map_err(ls_err)?;
        let next = sha256(&bytes);
        self.exec("UPDATE registry_backup_cut SET page = ?, after_row = ?, done = ?, hash = ?, previous = ?, body = ? WHERE k = 0",
            vec![int(page), int(after), int(i64::from(done)), blob(&next.0), blob(&hash.0), blob(&bytes)])?;
        Ok(map(vec![(0, Cbor::Bytes(bytes)), (1, next.to_cbor())]))
    }
    fn registry_backup_begin(&self) -> LsResult<Cbor> {
        let active = self.exec(
            "SELECT 1 FROM registry_backup_cut WHERE valid = 1 AND expires_at > ? AND done = 0",
            vec![int(now_ms())],
        )?;
        if !active.is_empty() {
            return Err(unavailable());
        }
        let session = B16(random_bytes());
        let generation = self.exec(
            "SELECT generation FROM credential_registry_generation WHERE k = 0",
            vec![],
        )?;
        let generation = as_i64(&generation[0][0]);
        if !(0..(1 << 52)).contains(&generation) {
            return Err(unavailable());
        }
        let expires = now_ms() + LEASE_MS;
        let header = map(vec![
            (0, Cbor::Text("mdbase-next-credential-registry/1".into())),
            (1, REGISTRY.to_cbor()),
            (2, session.to_cbor()),
            (3, Cbor::int(generation)),
            (4, Cbor::int(expires)),
            (
                5,
                Cbor::Text("denial-only-not-collection-deletion-freshness".into()),
            ),
        ]);
        let bytes = cbor::encode(&header).map_err(ls_err)?;
        let hash = sha256(&bytes);
        let sql = self.sql.clone();
        transaction_sync(&self.storage, move || {
            let x = |q: &str, args: Vec<JsValue>| {
                sql.exec_raw(q, args)
                    .map(|_| ())
                    .map_err(|e| JsValue::from_str(&e.to_string()))
            };
            x("DELETE FROM registry_backup_rows", vec![])?;
            x(
                "INSERT INTO registry_backup_rows SELECT device, revoked_at FROM revoked_devices ORDER BY device",
                vec![],
            )?;
            x(
                "INSERT OR REPLACE INTO registry_backup_cut VALUES (0, ?, ?, ?, 1, 0, 0, 0, ?, ?, ?)",
                vec![
                    blob(&session.0),
                    int(generation),
                    int(expires),
                    blob(&hash.0),
                    blob(&hash.0),
                    blob(&[]),
                ],
            )?;
            Ok(())
        })?;
        Ok(map(vec![(0, Cbor::Bytes(bytes)), (1, hash.to_cbor())]))
    }
}
