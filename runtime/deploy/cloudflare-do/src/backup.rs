//! Bounded, restartable log-DO export at cut H. Ordinary appends remain writable.
//! This is an export primitive, not authenticated archive completion or restore.
use mdbn_log_service::auth::Principal;
use mdbn_log_service::model::Status;
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::schema::Wire;

use super::*;

const LEASE_MS: i64 = 30 * 60 * 1000;
const ROWS: i64 = 100;
const ITEM_BYTES: i64 = 3 * 1024 * 1024;

pub(super) const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS backup_cut (k INTEGER PRIMARY KEY, revision INTEGER NOT NULL, session BLOB NOT NULL, meta BLOB NOT NULL, expires_at INTEGER NOT NULL, valid INTEGER NOT NULL, section INTEGER NOT NULL, after_row INTEGER NOT NULL, page INTEGER NOT NULL, last_hash BLOB NOT NULL, last_page BLOB NOT NULL, quota BLOB NOT NULL, retention INTEGER NOT NULL, retained_from INTEGER NOT NULL, created_at INTEGER NOT NULL, last_previous_hash BLOB NOT NULL)",
    "CREATE TABLE IF NOT EXISTS backup_objects (address BLOB PRIMARY KEY, kind INTEGER NOT NULL, size INTEGER NOT NULL, checksum BLOB NOT NULL, created_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS backup_tokens (token BLOB PRIMARY KEY, seq INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS backup_nonces (nonce BLOB PRIMARY KEY, expires_at INTEGER NOT NULL)",
];

struct Cut {
    revision: i64,
    session: B16,
    meta: CollectionMeta,
    expires_at: i64,
    valid: bool,
    section: i64,
    after: i64,
    page: i64,
    hash: B32,
    previous: B32,
}
fn invalid(reason: &str) -> ServiceError {
    ServiceError::reason(mdbn_log_service::Code::Unavailable, reason)
}
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
fn quota_bytes(q: &mdbn_log_service::model::Quotas) -> Vec<u8> {
    [q.storage_bytes, q.items_per_s, q.bytes_per_s, q.burst_items]
        .into_iter()
        .flat_map(u64::to_le_bytes)
        .collect()
}
fn settings(m: &CollectionMeta) -> Cbor {
    Cbor::Array(vec![
        Cbor::Uint(1),
        Cbor::Array(vec![
            Cbor::Uint(m.quotas.storage_bytes),
            Cbor::Uint(m.quotas.items_per_s),
            Cbor::Uint(m.quotas.bytes_per_s),
            Cbor::Uint(m.quotas.burst_items),
        ]),
        Cbor::Uint(m.retention_tier.days()),
        Cbor::int(m.created_at),
    ])
}
impl DoBackend {
    fn backup_cut(&self, budget: &Budget) -> LsResult<Option<Cut>> {
        let rows = self.exec("SELECT revision, session, meta, expires_at, valid, section, after_row, page, last_hash, last_previous_hash FROM backup_cut WHERE k = 0", vec![])?;
        rows.first()
            .map(|r| {
                Ok(Cut {
                    revision: as_i64(&r[0]),
                    session: b16(&r[1]),
                    meta: CollectionMeta::decode_with_budget(&as_bytes(&r[2]), budget)?,
                    expires_at: as_i64(&r[3]),
                    valid: as_i64(&r[4]) == 1,
                    section: as_i64(&r[5]),
                    after: as_i64(&r[6]),
                    page: as_i64(&r[7]),
                    hash: b32(&r[8]),
                    previous: b32(&r[9]),
                })
            })
            .transpose()
    }

    /// Called while the collection WriteTX guard is held, before any effects.
    /// Security-policy changes invalidate the historical cut, never delay them.
    pub(super) fn backup_guard(&self, writes: &[Write]) -> LsResult<()> {
        // This hot-path check reads only tiny typed fields, never the last page
        // or a decoded policy projection (which would multiply decoder work).
        let rows = self.exec("SELECT quota, retention, retained_from, created_at, section FROM backup_cut WHERE k = 0 AND valid = 1 AND expires_at > ?", vec![int(now_ms())])?;
        let Some(cut) = rows.first() else {
            return Ok(());
        };
        let security = writes.iter().any(|w| match w {
            Write::UpsertAcl(_) => true,
            Write::InsertItem(i) => i.kind != 1,
            Write::PutMeta(m) => m.status != Status::Live,
            _ => false,
        });
        if security {
            self.exec("UPDATE backup_cut SET valid = 0 WHERE k = 0", vec![])?;
            return Ok(());
        }
        // Completed cuts still invalidate on security/deletion; only their
        // ordinary GC/settings/snapshot fence has been released.
        if as_i64(&cut[4]) == 8 {
            return Ok(());
        }
        for w in writes {
            let fenced = match w {
                Write::DeleteObject(_)
                | Write::InsertSnapshot(_)
                | Write::EndorseSnapshot(_)
                | Write::DeleteSnapshot(_)
                | Write::DeleteEntriesThrough(_)
                | Write::CreateCollection(_) => true,
                Write::PutMeta(m) => {
                    quota_bytes(&m.quotas) != as_bytes(&cut[0])
                        || m.retention_tier.days() as i64 != as_i64(&cut[1])
                        || m.retained_from as i64 != as_i64(&cut[2])
                        || m.created_at != as_i64(&cut[3])
                }
                _ => false,
            };
            if fenced {
                return Err(invalid("backup_lease"));
            }
        }
        Ok(())
    }

    pub(super) async fn backup_call(
        &self,
        p: &Principal,
        method: &str,
        params: &Cbor,
        budget: &Budget,
    ) -> LsResult<Cbor> {
        if !matches!(p, Principal::ControlPlane) {
            return Err(ServiceError::reason(
                mdbn_log_service::Code::Forbidden,
                "principal",
            ));
        }
        let c = field(params, 0)
            .and_then(|v| B16::from_cbor(v).ok())
            .filter(|c| *c != REGISTRY)
            .ok_or_else(|| ServiceError::invalid("collection"))?;
        self.record_route(&c)?;
        // Shared with ordinary write transactions. No external I/O while held.
        let _guard = self.lock.lock().await;
        if method == "backup_begin" {
            return self.backup_begin(c, budget);
        }
        let session = field(params, 1)
            .and_then(|v| B16::from_cbor(v).ok())
            .ok_or_else(|| ServiceError::invalid("backup_session"))?;
        let cut = self
            .backup_cut(budget)?
            .filter(|cut| cut.session == session)
            .ok_or_else(|| invalid("backup_session"))?;
        if method == "backup_abort" {
            self.exec("UPDATE backup_cut SET valid = 0 WHERE k = 0", vec![])?;
            return Ok(map(vec![(0, Cbor::Bool(true))]));
        }
        if !cut.valid || cut.expires_at <= now_ms() {
            return Err(invalid("backup_expired"));
        }
        let current = self.exec("SELECT meta FROM meta WHERE k = 0", vec![])?;
        let current = current.first().ok_or_else(|| invalid("backup_state"))?;
        if CollectionMeta::decode_with_budget(&as_bytes(&current[0]), budget)?.status
            != Status::Live
        {
            return Err(ServiceError::new(mdbn_log_service::Code::Gone));
        }
        match method {
            "backup_page" => self.backup_page(cut, params),
            "backup_finish" => {
                let expected = field(params, 2)
                    .and_then(|v| B32::from_cbor(v).ok())
                    .ok_or_else(|| ServiceError::invalid("backup_hash"))?;
                if cut.section != 7 && cut.section != 8 || expected != cut.hash {
                    return Err(invalid("backup_incomplete"));
                }
                self.exec("UPDATE backup_cut SET section = 8 WHERE k = 0", vec![])?;
                Ok(map(vec![
                    (0, Cbor::Uint(1)),
                    (1, c.to_cbor()),
                    (2, cut.session.to_cbor()),
                    (3, Cbor::Uint(cut.meta.head)),
                    (4, cut.meta.head_chain.to_cbor()),
                    (5, Cbor::Uint(cut.revision as u64)),
                    (6, Cbor::Uint(cut.page as u64)),
                    (7, cut.hash.to_cbor()),
                ]))
            }
            _ => Err(ServiceError::invalid("method")),
        }
    }

    fn backup_begin(&self, c: Uuid, budget: &Budget) -> LsResult<Cbor> {
        let previous = self.backup_cut(budget)?;
        if previous
            .as_ref()
            .is_some_and(|s| s.valid && s.expires_at > now_ms() && s.section != 8)
        {
            return Err(invalid("backup_lease"));
        }
        let rows = self.exec("SELECT meta FROM meta WHERE k = 0", vec![])?;
        let meta = rows
            .first()
            .ok_or_else(|| ServiceError::new(mdbn_log_service::Code::NotFound))?;
        let meta = CollectionMeta::decode_with_budget(&as_bytes(&meta[0]), budget)?;
        if meta.id != c || meta.status != Status::Live {
            return Err(invalid("backup_state"));
        }
        let revision = previous.map_or(1, |p| p.revision + 1);
        if revision > (1 << 52) {
            return Err(invalid("backup_revision"));
        }
        let session = B16(random_bytes());
        let now = now_ms();
        let expires_at = now + LEASE_MS;
        // A domain/version-tagged canonical header is the page chain anchor.
        let header = map(vec![
            (0, Cbor::Text("mdbase-next-backup/1".into())),
            (1, c.to_cbor()),
            (2, session.to_cbor()),
            (3, Cbor::Uint(meta.head)),
            (4, meta.head_chain.to_cbor()),
            (5, Cbor::Uint(meta.retained_from)),
            (6, Cbor::Uint(revision as u64)),
            (7, settings(&meta)),
            (8, Cbor::int(expires_at)),
            (9, Cbor::Uint(meta.used_bytes)),
            (
                10,
                Cbor::Text("rotate-url-secret-before-restored-traffic".into()),
            ),
        ]);
        let bytes = cbor::encode(&header).map_err(ls_err)?;
        let hash = sha256(&bytes);
        let sql = self.sql.clone();
        // Persist operational cut fields only, not a duplicate policy/ACL
        // projection that would multiply decoder work on every page request.
        let mut cut_meta = CollectionMeta::new(c, meta.created_at);
        cut_meta.head = meta.head;
        cut_meta.head_chain = meta.head_chain;
        cut_meta.retained_from = meta.retained_from;
        cut_meta.quotas = meta.quotas;
        cut_meta.retention_tier = meta.retention_tier;
        cut_meta.used_bytes = meta.used_bytes;
        let stored = cut_meta.encode();
        let quota = quota_bytes(&meta.quotas);
        let retention = meta.retention_tier.days() as i64;
        let retained_from = meta.retained_from as i64;
        let created_at = meta.created_at;
        let head = meta.head as i64;
        transaction_sync(&self.storage, move || {
            let x = |q: &str, args: Vec<JsValue>| {
                sql.exec_raw(q, args)
                    .map(|_| ())
                    .map_err(|e| JsValue::from_str(&e.to_string()))
            };
            // SQL-to-SQL copies: bounded metadata, never materialize object bytes.
            x("DELETE FROM backup_objects", vec![])?;
            x(
                "INSERT INTO backup_objects SELECT address, kind, size, checksum, created_at FROM objects WHERE committed = 1 ORDER BY address",
                vec![],
            )?;
            x("DELETE FROM backup_tokens", vec![])?;
            x(
                "INSERT INTO backup_tokens SELECT token, seq, expires_at FROM tokens WHERE seq <= ? ORDER BY token",
                vec![int(head)],
            )?;
            x("DELETE FROM backup_nonces", vec![])?;
            x(
                "INSERT INTO backup_nonces SELECT nonce, expires_at FROM used_http_nonces WHERE expires_at >= ? ORDER BY nonce",
                vec![int(now)],
            )?;
            x(
                "INSERT OR REPLACE INTO backup_cut (k, revision, session, meta, expires_at, valid, section, after_row, page, last_hash, last_page, quota, retention, retained_from, created_at, last_previous_hash) VALUES (0, ?, ?, ?, ?, 1, 1, 0, 0, ?, ?, ?, ?, ?, ?, ?)",
                vec![
                    int(revision),
                    blob(&session.0),
                    blob(&stored),
                    int(expires_at),
                    blob(&hash.0),
                    blob(&[]),
                    blob(&quota),
                    int(retention),
                    int(retained_from),
                    int(created_at),
                    blob(&hash.0),
                ],
            )?;
            Ok(())
        })?;
        Ok(map(vec![(0, Cbor::Bytes(bytes)), (1, hash.to_cbor())]))
    }

    fn backup_page(&self, cut: Cut, params: &Cbor) -> LsResult<Cbor> {
        let page = field(params, 2)
            .and_then(|v| match v {
                Cbor::Uint(n) => i64::try_from(*n).ok(),
                _ => None,
            })
            .ok_or_else(|| ServiceError::invalid("backup_page"))?;
        let previous = field(params, 3)
            .and_then(|v| B32::from_cbor(v).ok())
            .ok_or_else(|| ServiceError::invalid("backup_hash"))?;
        if page == cut.page && page > 0 {
            if previous != cut.previous {
                return Err(invalid("backup_cursor"));
            }
            let saved = self.exec("SELECT last_page FROM backup_cut WHERE k = 0", vec![])?;
            return Ok(map(vec![
                (0, Cbor::Bytes(as_bytes(&saved[0][0]))),
                (1, cut.hash.to_cbor()),
            ]));
        }
        if page != cut.page + 1 || previous != cut.hash || cut.section >= 7 {
            return Err(invalid("backup_cursor"));
        }
        let h = cut.meta.head as i64;
        let rows = match cut.section {
            1 => self.exec("SELECT seq, kind, bytes, appended_at FROM (SELECT seq, kind, bytes, appended_at, sum(length(bytes)) OVER (ORDER BY seq) AS run FROM (SELECT seq, kind, bytes, appended_at FROM items WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT 32)) WHERE run <= ? OR run = length(bytes) ORDER BY seq", vec![int(cut.after), int(h), int(ITEM_BYTES)])?,
            2 => self.exec("SELECT seq, manifest, author, created_at, endorsed FROM snapshots WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?", vec![int(cut.after), int(h), int(ROWS)])?,
            3 => self.exec("SELECT rowid, address, holder_kind, holder FROM object_refs WHERE rowid > ? AND holder <= ? ORDER BY rowid LIMIT ?", vec![int(cut.after), int(h), int(ROWS)])?,
            4 => self.exec("SELECT rowid, address, kind, size, checksum, created_at FROM backup_objects WHERE rowid > ? ORDER BY rowid LIMIT ?", vec![int(cut.after), int(ROWS)])?,
            5 => self.exec("SELECT rowid, token, seq, expires_at FROM backup_tokens WHERE rowid > ? ORDER BY rowid LIMIT ?", vec![int(cut.after), int(ROWS)])?,
            6 => self.exec("SELECT rowid, nonce, expires_at FROM backup_nonces WHERE rowid > ? ORDER BY rowid LIMIT ?", vec![int(cut.after), int(ROWS)])?,
            _ => return Err(invalid("backup_cursor")),
        };
        let after = rows.last().map_or(cut.after, |r| as_i64(&r[0]));
        // Each section ends with an explicit empty page, making traversal complete
        // even when a full page lands exactly on the final row.
        let done = rows.is_empty();
        let encoded_rows = rows
            .iter()
            .map(|r| {
                Ok(Cbor::Array(
                    r.iter()
                        .map(|v| match v {
                            SqlStorageValue::Blob(b) => Ok(Cbor::Bytes(b.clone())),
                            SqlStorageValue::Integer(i) => Ok(Cbor::int(*i)),
                            SqlStorageValue::Float(f)
                                if f.is_finite()
                                    && f.fract() == 0.0
                                    && f.abs() < (1u64 << 53) as f64 =>
                            {
                                Ok(Cbor::int(*f as i64))
                            }
                            _ => Err(invalid("backup_storage_type")),
                        })
                        .collect::<LsResult<Vec<_>>>()?,
                ))
            })
            .collect::<LsResult<Vec<_>>>()?;
        let body = map(vec![
            (0, Cbor::Uint(1)),
            (1, cut.meta.id.to_cbor()),
            (2, cut.session.to_cbor()),
            (3, Cbor::Uint(cut.revision as u64)),
            (4, Cbor::Uint(page as u64)),
            (5, cut.hash.to_cbor()),
            (6, Cbor::Uint(cut.section as u64)),
            (7, Cbor::Array(encoded_rows)),
            (8, Cbor::Bool(done)),
            (9, Cbor::Uint(cut.meta.head)),
            (10, cut.meta.head_chain.to_cbor()),
        ]);
        let bytes = cbor::encode(&body).map_err(ls_err)?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err(invalid("backup_page_size"));
        }
        let hash = sha256(&bytes);
        self.exec("UPDATE backup_cut SET section = ?, after_row = ?, page = ?, last_hash = ?, last_page = ?, last_previous_hash = ? WHERE k = 0", vec![
            int(if done { cut.section + 1 } else { cut.section }), int(if done { 0 } else { after }),
            int(page), blob(&hash.0), blob(&bytes), blob(&cut.hash.0),
        ])?;
        Ok(map(vec![(0, Cbor::Bytes(bytes)), (1, hash.to_cbor())]))
    }
}
