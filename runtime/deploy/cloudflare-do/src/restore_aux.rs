//! Operational auxiliary recovery from authenticated, pinned raw cut pages.
//! Signed replay remains the only policy/inventory authority; no ACL imports.
use super::*;
use mdbn_log_service::{auth::Principal, model::Status};
use mdbn_wire::{cbor::Cbor, schema::Wire};

pub(super) const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS restore_aux (k INTEGER PRIMARY KEY, session BLOB NOT NULL, revision INTEGER NOT NULL, head INTEGER NOT NULL, chain BLOB NOT NULL, section INTEGER NOT NULL, page INTEGER NOT NULL, after_row INTEGER NOT NULL, hash BLOB NOT NULL, previous BLOB NOT NULL, expected_hash BLOB NOT NULL, expected_page INTEGER NOT NULL, done INTEGER NOT NULL, items INTEGER NOT NULL, snapshots INTEGER NOT NULL, refs INTEGER NOT NULL, objects INTEGER NOT NULL, tokens INTEGER NOT NULL, nonces INTEGER NOT NULL, header_hash BLOB NOT NULL)",
    "CREATE TABLE IF NOT EXISTS restore_aux_tokens (token BLOB PRIMARY KEY, seq INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
];
fn bad() -> ServiceError {
    ServiceError::invalid("restore_aux")
}
fn map(fields: Vec<(u64, Cbor)>) -> Cbor {
    Cbor::Map(
        fields
            .into_iter()
            .map(|(k, v)| (Cbor::Uint(k), v))
            .collect(),
    )
}
fn field(value: &Cbor, key: u64) -> LsResult<&Cbor> {
    let Cbor::Map(fields) = value else {
        return Err(bad());
    };
    fields
        .iter()
        .find(|(k, _)| *k == Cbor::Uint(key))
        .map(|(_, v)| v)
        .ok_or_else(bad)
}
fn integer(v: &Cbor) -> LsResult<i64> {
    match v {
        Cbor::Uint(n) if *n < (1u64 << 53) => Ok(*n as i64),
        Cbor::Nint(n) if *n < (1u64 << 53) - 1 => Ok(-1 - *n as i64),
        _ => Err(bad()),
    }
}
fn positive(v: &Cbor) -> LsResult<i64> {
    integer(v).and_then(|n| if n > 0 { Ok(n) } else { Err(bad()) })
}
fn bytes(v: &Cbor) -> LsResult<&[u8]> {
    if let Cbor::Bytes(b) = v {
        Ok(b)
    } else {
        Err(bad())
    }
}
fn uuid(v: &Cbor) -> LsResult<B16> {
    B16::from_cbor(v).map_err(|_| bad())
}
fn digest(v: &Cbor) -> LsResult<B32> {
    B32::from_cbor(v).map_err(|_| bad())
}

impl DoBackend {
    /// Held under WriteTX; opt-in begin MUST precede any completion request.
    pub(super) fn restore_aux_guard(&self, writes: &[Write]) -> LsResult<bool> {
        let row = self.exec("SELECT done, page FROM restore_aux WHERE k = 0", vec![])?;
        let Some(row) = row.first() else {
            return Ok(false);
        };
        if writes
            .iter()
            .any(|w| matches!(w, Write::PutMeta(m) if m.status == Status::Gone))
        {
            return Ok(false); // deletion always wins; reads below recheck current Gone
        }
        if writes
            .iter()
            .any(|w| matches!(w, Write::PutMeta(m) if m.status == Status::Live))
            && as_i64(&row[0]) != 1
        {
            return Err(ServiceError::reason(
                mdbn_log_service::Code::Unavailable,
                "restore_aux_incomplete",
            ));
        }
        if as_i64(&row[1]) > 0
            && writes.iter().any(|w| {
                matches!(
                    w,
                    Write::InsertItem(_)
                        | Write::InsertSnapshot(_)
                        | Write::EndorseSnapshot(_)
                        | Write::DeleteSnapshot(_)
                        | Write::DeleteEntriesThrough(_)
                        | Write::DeleteObject(_)
                )
            })
        {
            return Err(bad());
        }
        Ok(true)
    }
    pub(super) async fn restore_aux_call(
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
        let c = uuid(field(params, 0)?)?;
        if c == REGISTRY {
            return Err(bad());
        }
        self.record_route(&c)?;
        let _guard = self.lock.lock().await;
        self.refuse_destination_denial()?;
        self.refuse_deletion_floor(&c, budget).await?;
        self.refuse_destination_denial()?;
        // Materialize current collection/plan only after the independent read;
        // the rest of the validation and transaction contain no awaits.
        let meta = self.exec("SELECT meta FROM meta WHERE k = 0", vec![])?;
        let meta = meta.first().ok_or_else(bad)?;
        let meta = CollectionMeta::decode_with_budget(&as_bytes(&meta[0]), budget)?;
        if meta.status == Status::Gone {
            return Err(ServiceError::new(mdbn_log_service::Code::Gone));
        }
        let plan = meta
            .restore_plan
            .as_ref()
            .filter(|_| meta.status == Status::Importing && meta.id == c)
            .ok_or_else(bad)?;
        let stored = self.exec("SELECT session, revision, head, chain, section, page, after_row, hash, previous, expected_hash, expected_page, done, items, snapshots, refs, objects, tokens, nonces, header_hash FROM restore_aux WHERE k = 0", vec![])?;
        if method == "restore_aux_begin" {
            let raw = bytes(field(params, 1)?)?;
            let header = budget.raw(raw)?;
            let session = uuid(field(&header, 2)?)?;
            let revision = positive(field(&header, 6)?)?;
            let head = positive(field(&header, 3)?)?;
            let chain = digest(field(&header, 4)?)?;
            let expected_hash = digest(field(params, 2)?)?;
            let expected_page = positive(field(params, 3)?)?;
            let Cbor::Array(settings) = field(&header, 7)? else {
                return Err(bad());
            };
            let [Cbor::Uint(1), Cbor::Array(quotas), retention, created] = settings.as_slice()
            else {
                return Err(bad());
            };
            let expected_quota = [
                meta.quotas.storage_bytes,
                meta.quotas.items_per_s,
                meta.quotas.bytes_per_s,
                meta.quotas.burst_items,
            ];
            if field(&header, 0)? != &Cbor::Text("mdbase-next-backup/1".into())
                || uuid(field(&header, 1)?)? != c
                || head as u64 != plan.head
                || chain != plan.chain
                || positive(field(&header, 5)?)? as u64 != plan.retained_from
                || integer(field(&header, 9)?)? as u64 != plan.used_bytes
                || quotas != &expected_quota.map(Cbor::Uint)
                || integer(retention)? as u64 != meta.retention_tier.days()
                || integer(created)? != meta.created_at
                || expected_page < 6
            {
                return Err(bad());
            }
            let hash = sha256(raw);
            if let Some(state) = stored.first() {
                if hash != b32(&state[18])
                    || expected_hash != b32(&state[9])
                    || expected_page != as_i64(&state[10])
                {
                    return Err(bad());
                }
                return Ok(map(vec![
                    (0, Cbor::Bool(true)),
                    (1, Cbor::int(as_i64(&state[5]))),
                    (2, b32(&state[7]).to_cbor()),
                ]));
            }
            let sql = self.sql.clone();
            transaction_sync(&self.storage, move || {
                destination_denial::refuse(&sql).map_err(|e| JsValue::from_str(&e.to_string()))?;
                sql.exec_raw("INSERT INTO restore_aux VALUES (0, ?, ?, ?, ?, 1, 0, 0, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, ?)",
                    vec![blob(&session.0),int(revision),int(head),blob(&chain.0),blob(&hash.0),blob(&hash.0),blob(&expected_hash.0),int(expected_page),blob(&hash.0)])
                    .map_err(|e| JsValue::from_str(&e.to_string()))?;
                Ok(())
            })?;
            return Ok(map(vec![
                (0, Cbor::Bool(true)),
                (1, Cbor::Uint(0)),
                (2, hash.to_cbor()),
            ]));
        }
        if method != "restore_aux_page" {
            return Err(bad());
        }
        let state = stored.first().ok_or_else(bad)?;
        let raw = bytes(field(params, 1)?)?;
        if raw.len() > 4 * 1024 * 1024 {
            return Err(bad());
        }
        let page = budget.raw(raw)?;
        let number = positive(field(&page, 4)?)?;
        let previous = digest(field(&page, 5)?)?;
        let hash = sha256(raw);
        if field(&page, 0)? != &Cbor::Uint(1)
            || uuid(field(&page, 1)?)? != c
            || uuid(field(&page, 2)?)? != b16(&state[0])
            || positive(field(&page, 3)?)? != as_i64(&state[1])
            || positive(field(&page, 9)?)? != as_i64(&state[2])
            || digest(field(&page, 10)?)? != b32(&state[3])
        {
            return Err(bad());
        }
        if number == as_i64(&state[5]) && hash == b32(&state[7]) && previous == b32(&state[8]) {
            return Ok(map(vec![
                (0, Cbor::Bool(true)),
                (1, Cbor::int(number)),
                (2, hash.to_cbor()),
            ]));
        }
        if as_i64(&state[11]) != 0
            || number != as_i64(&state[5]) + 1
            || previous != b32(&state[7])
            || number > as_i64(&state[10])
            || meta.head != plan.head
            || meta.head_chain != plan.chain
            || meta.used_bytes != plan.used_bytes
        {
            return Err(bad());
        }
        let section = positive(field(&page, 6)?)?;
        let Cbor::Array(rows) = field(&page, 7)? else {
            return Err(bad());
        };
        let Cbor::Bool(terminal) = field(&page, 8)? else {
            return Err(bad());
        };
        if section != as_i64(&state[4])
            || section > 6
            || rows.len() > if section == 1 { 32 } else { 100 }
            || *terminal != rows.is_empty()
        {
            return Err(bad());
        }
        let mut after = as_i64(&state[6]);
        let mut mutations: Vec<(&'static str, Vec<JsValue>)> = Vec::new();
        // Validate all rows against already verified logical target before effects.
        for row in rows {
            let Cbor::Array(r) = row else {
                return Err(bad());
            };
            let cursor = positive(r.first().ok_or_else(bad)?)?;
            if cursor <= after {
                return Err(bad());
            }
            after = cursor;
            let matched = match (section, r.as_slice()) {
                (1, [seq, kind, data, time]) => {
                    let seq = positive(seq)?;
                    let kind = positive(kind)?;
                    let data = bytes(data)?;
                    let time = integer(time)?;
                    mutations.push((
                        "UPDATE items SET appended_at = ? WHERE seq = ?",
                        vec![int(time), int(seq)],
                    ));
                    self.exec(
                        "SELECT 1 FROM items WHERE seq = ? AND kind = ? AND bytes = ?",
                        vec![int(seq), int(kind), blob(data)],
                    )?
                }
                (2, [seq, manifest, author, time, endorsed]) => {
                    let seq = positive(seq)?;
                    let time = integer(time)?;
                    let endorsed = integer(endorsed)?;
                    if !(0..=1).contains(&endorsed) {
                        return Err(bad());
                    }
                    self.exec("SELECT 1 FROM snapshots WHERE seq = ? AND manifest = ? AND author = ? AND created_at = ? AND endorsed = ?",
                        vec![int(seq),blob(&digest(manifest)?.0),blob(&uuid(author)?.0),int(time),int(endorsed)])?
                }
                (3, [_, address, kind, holder]) => {
                    let kind = integer(kind)?;
                    let holder = positive(holder)?;
                    if !(0..=1).contains(&kind) || holder > as_i64(&state[2]) {
                        return Err(bad());
                    }
                    self.exec("SELECT 1 FROM object_refs WHERE address = ? AND holder_kind = ? AND holder = ?",
                        vec![blob(&digest(address)?.0),int(kind),int(holder)])?
                }
                (4, [_, address, kind, size, checksum, time]) => {
                    let address = digest(address)?;
                    let kind = positive(kind)?;
                    let size = integer(size)?;
                    let time = integer(time)?;
                    if size < 0 {
                        return Err(bad());
                    }
                    mutations.push((
                        "UPDATE objects SET created_at = ? WHERE address = ?",
                        vec![int(time), blob(&address.0)],
                    ));
                    self.exec("SELECT 1 FROM objects WHERE address = ? AND kind = ? AND size = ? AND checksum = ? AND committed = 1",
                        vec![blob(&address.0),int(kind),int(size),blob(&digest(checksum)?.0)])?
                }
                (5, [_, token, seq, expiry]) => {
                    let token = uuid(token)?;
                    let seq = positive(seq)?;
                    let expiry = integer(expiry)?;
                    if seq > as_i64(&state[2]) {
                        return Err(bad());
                    }
                    mutations.push((
                        "INSERT INTO restore_aux_tokens VALUES (?, ?, ?)",
                        vec![blob(&token.0), int(seq), int(expiry)],
                    ));
                    vec![vec![]] // compacted positions intentionally have no retained item
                }
                (6, [_, nonce, expiry]) => {
                    digest(nonce)?;
                    integer(expiry)?;
                    vec![vec![]] // NOT restored: target URL secret MUST rotate before serving
                }
                _ => return Err(bad()),
            };
            if matched.len() != 1 {
                return Err(bad());
            }
        }
        let mut counts: Vec<i64> = state[12..18].iter().map(as_i64).collect();
        counts[(section - 1) as usize] += rows.len() as i64;
        let finished = *terminal && section == 6;
        if finished != (number == as_i64(&state[10])) || finished && hash != b32(&state[9]) {
            return Err(bad());
        }
        if finished {
            for (query, count) in [
                ("SELECT count(*) FROM items", counts[0]),
                ("SELECT count(*) FROM snapshots", counts[1]),
                ("SELECT count(*) FROM object_refs", counts[2]),
                (
                    "SELECT count(*) FROM objects WHERE committed = 1",
                    counts[3],
                ),
            ] {
                if as_i64(&self.exec(query, vec![])?[0][0]) != count {
                    return Err(bad());
                }
            }
            mutations.push(("DELETE FROM tokens", vec![]));
            mutations.push((
                "INSERT INTO tokens SELECT token, seq, expires_at FROM restore_aux_tokens",
                vec![],
            ));
        }
        let sql = self.sql.clone();
        let next_section = if *terminal { section + 1 } else { section };
        let next_after = if *terminal { 0 } else { after };
        transaction_sync(&self.storage, move || {
            destination_denial::refuse(&sql).map_err(|e| JsValue::from_str(&e.to_string()))?;
            for (q, args) in mutations {
                sql.exec_raw(q, args)
                    .map_err(|e| JsValue::from_str(&e.to_string()))?;
            }
            sql.exec_raw("UPDATE restore_aux SET section = ?, page = ?, after_row = ?, hash = ?, previous = ?, done = ?, items = ?, snapshots = ?, refs = ?, objects = ?, tokens = ?, nonces = ? WHERE k = 0",
                vec![int(next_section),int(number),int(next_after),blob(&hash.0),blob(&previous.0),int(i64::from(finished)),int(counts[0]),int(counts[1]),int(counts[2]),int(counts[3]),int(counts[4]),int(counts[5])]).map_err(|e|JsValue::from_str(&e.to_string()))?;
            Ok(())
        })?;
        Ok(map(vec![
            (0, Cbor::Bool(true)),
            (1, Cbor::int(number)),
            (2, hash.to_cbor()),
        ]))
    }
}
