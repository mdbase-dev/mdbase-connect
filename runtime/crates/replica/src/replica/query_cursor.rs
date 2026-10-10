//! Resident, session-bound generic Query continuations. No source rows or SQL
//! snapshot leases are retained. A handle is a position, never READ authority.
use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;

use mdbn_core::query::{Query, QueryEnv};
use mdbn_wire::client::{Include, QueryResult};
use mdbn_wire::common::{Hash, Uuid, Value};
use mdbn_wire::{Cbor, Wire};

use super::Replica;
use super::query_driver::{MAX_BYTES, MAX_SELECTED};
use super::submit::store_err;
use crate::api::{ApiResult, ErrorCode, SessionId};
use crate::layer::LayerView;
use crate::plan::StoreView;
use crate::store::{Head, Store};
use crate::store_query::{QueryGeneration, QueryKeyedId};

/// Bounds are PER REPLICA SESSION, not per cursor or a caller-supplied budget.
pub(crate) const MAX_CURSORS: usize = 16;
pub(crate) const MAX_CURSOR_BYTES: usize = 1 << 20;
const TTL_MS: i64 = 300_000;
const TOKEN_PREFIX: &str = "q1.";
const MAX_TOKEN_BYTES: usize = 128;

type Handle = [u8; 16];

fn invalid(message: &str) -> crate::api::ApiError {
    ErrorCode::InvalidRequest.err_with_reason("invalid_query_cursor", message)
}
fn expired() -> crate::api::ApiError {
    ErrorCode::InvalidRequest.err_with_reason("cursor_expired", "restart from the first query page")
}
fn stale() -> crate::api::ApiError {
    ErrorCode::InvalidRequest.err_with_reason(
        "cursor_stale",
        "the query view changed; restart from the first page",
    )
}
fn full() -> crate::api::ApiError {
    ErrorCode::TooLarge.err_with_reason(
        "query_budget_exceeded",
        "query continuation ownership exceeds its fixed budget",
    )
}

#[derive(Clone, PartialEq, Eq)]
struct Stamp {
    generation: Option<QueryGeneration>,
    head: Head,
    as_of: u64,
    store_generation: u64,
    grant: Option<Uuid>,
}

enum Payload {
    Query {
        env: QueryEnv,
        frontier: QueryKeyedId,
    },
    Resource {
        after: String,
    },
}
struct Entry {
    handle: Handle,
    stamp: Stamp,
    invocation: Hash,
    payload: Payload,
    expires_at: i64,
    bytes: usize,
}

/// Temporary inventory position; no source or catalog is retained in the pool.
pub(super) struct ResourcePosition {
    pub(super) after: Option<String>,
    stamp: Stamp,
    invocation: Hash,
    expires_at: i64,
}
#[derive(Default)]
struct SessionCursors {
    entries: VecDeque<Arc<Entry>>,
    bytes: usize,
}
#[derive(Default)]
pub(crate) struct Cursors {
    sessions: BTreeMap<SessionId, SessionCursors>,
    owners: BTreeMap<Handle, SessionId>,
    /// Only injected current host time, never the frozen query clock. Clamp
    /// backward clock steps; expiry is not a substitute for current authority.
    time_floor: i64,
}
impl Cursors {
    fn now(&mut self, now: i64) -> i64 {
        self.time_floor = self.time_floor.max(now);
        self.time_floor
    }
    pub(crate) fn clear(&mut self) {
        self.sessions.clear();
        self.owners.clear();
    }
    pub(crate) fn close(&mut self, session: SessionId) {
        if let Some(entries) = self.sessions.remove(&session) {
            for e in entries.entries {
                self.owners.remove(&e.handle);
            }
        }
    }
    fn get(&mut self, session: SessionId, handle: Handle, now: i64) -> ApiResult<Arc<Entry>> {
        let now = self.now(now);
        match self.owners.get(&handle) {
            Some(owner) if *owner != session => {
                return Err(invalid("cursor belongs to another session"));
            }
            None => return Err(expired()),
            _ => {}
        }
        let entry = self
            .sessions
            .get(&session)
            .and_then(|s| s.entries.iter().find(|e| e.handle == handle))
            .cloned()
            .ok_or_else(expired)?;
        if now >= entry.expires_at {
            return Err(expired());
        }
        Ok(entry)
    }
    fn issue(
        &mut self,
        session: SessionId,
        mut entry: Entry,
        entropy: &mut dyn crate::crypto::CsprngEntropy,
    ) -> ApiResult<String> {
        if entry.bytes > MAX_CURSOR_BYTES {
            return Err(full());
        }
        // Bounded collision handling; never replace a different saved position.
        let mut handle = [0; 16];
        let mut unique = false;
        for _ in 0..4 {
            entropy.fill(&mut handle);
            if !self.owners.contains_key(&handle) {
                unique = true;
                break;
            }
        }
        if !unique {
            return Err(ErrorCode::Internal.err("cursor entropy collision"));
        }
        entry.handle = handle;
        let entries = self.sessions.entry(session).or_default();
        while entries.entries.len() >= MAX_CURSORS
            || entries
                .bytes
                .checked_add(entry.bytes)
                .is_none_or(|n| n > MAX_CURSOR_BYTES)
        {
            let old = entries.entries.pop_front().ok_or_else(full)?;
            entries.bytes -= old.bytes;
            self.owners.remove(&old.handle);
        }
        let prefix = match entry.payload {
            Payload::Query { .. } => TOKEN_PREFIX,
            Payload::Resource { .. } => "r1.",
        };
        entries.bytes += entry.bytes;
        entries.entries.push_back(Arc::new(entry));
        self.owners.insert(handle, session);
        Ok(token_with_prefix(handle, prefix))
    }
}
#[cfg(test)]
fn token(handle: Handle) -> String {
    token_with_prefix(handle, TOKEN_PREFIX)
}
fn token_with_prefix(handle: Handle, prefix: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut token = String::with_capacity(35);
    token.push_str(prefix);
    for byte in handle {
        token.push(char::from(HEX[usize::from(byte >> 4)]));
        token.push(char::from(HEX[usize::from(byte & 15)]));
    }
    token
}
fn parse_token(value: &str) -> ApiResult<Handle> {
    parse_token_with_prefix(value, TOKEN_PREFIX)
}
fn parse_token_with_prefix(value: &str, prefix: &str) -> ApiResult<Handle> {
    if value.len() > MAX_TOKEN_BYTES || value.len() != 35 || !value.starts_with(prefix) {
        return Err(invalid("malformed cursor"));
    }
    fn nibble(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            _ => None,
        }
    }
    let mut handle = [0; 16];
    for (out, pair) in handle.iter_mut().zip(value.as_bytes()[3..].chunks_exact(2)) {
        *out = (nibble(pair[0]).ok_or_else(|| invalid("malformed query cursor"))? << 4)
            | nibble(pair[1]).ok_or_else(|| invalid("malformed query cursor"))?;
    }
    Ok(handle)
}
pub(crate) fn supplied(query: &Value) -> ApiResult<Option<Handle>> {
    let Value::Map(fields) = query else {
        return Ok(None);
    };
    let mut token = None;
    for (key, value) in fields {
        if key == "cursor" {
            if token.is_some() {
                return Err(invalid("duplicate cursor"));
            }
            let Value::Text(value) = value else {
                return Err(invalid("cursor must be opaque text"));
            };
            token = Some(parse_token(value)?);
        }
    }
    Ok(token)
}

// Bound the temporary canonical invocation BEFORE to_cbor/encode clone values.
fn invocation(query: &Value, include: &Include) -> ApiResult<Hash> {
    fn preflight(v: &Value, depth: usize, bytes: &mut usize) -> ApiResult<()> {
        if depth > 32 {
            return Err(full());
        }
        *bytes = bytes
            .checked_add(64)
            .filter(|n| *n <= MAX_BYTES as usize)
            .ok_or_else(full)?;
        match v {
            Value::Text(s) => {
                *bytes = bytes
                    .checked_add(s.len())
                    .filter(|n| *n <= MAX_BYTES as usize)
                    .ok_or_else(full)?
            }
            Value::List(values) => {
                for value in values {
                    preflight(value, depth + 1, bytes)?;
                }
            }
            Value::Map(values) => {
                for (key, value) in values {
                    *bytes = bytes
                        .checked_add(key.len())
                        .filter(|n| *n <= MAX_BYTES as usize)
                        .ok_or_else(full)?;
                    preflight(value, depth + 1, bytes)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    preflight(query, 0, &mut 0)?;
    let Value::Map(fields) = query else {
        return Err(invalid("query must be a map"));
    };
    let query = Value::Map(
        fields
            .iter()
            .filter(|(k, _)| k != "cursor")
            .cloned()
            .collect(),
    );
    let bytes = mdbn_wire::cbor::encode(&Cbor::Array(vec![
        Cbor::Text("mdbase/query-invocation/v1".into()),
        query.to_cbor(),
        include.to_cbor(),
    ]))
    .map_err(|_| invalid("invalid query invocation"))?;
    Ok(mdbn_wire::hash::sha256(&bytes))
}
fn resource_invalid() -> crate::api::ApiError {
    ErrorCode::InvalidRequest.err_with_reason(
        "invalid_resource_cursor",
        "resource cursor method, session or selection changed",
    )
}
fn resource_full() -> crate::api::ApiError {
    ErrorCode::TooLarge.err_with_reason(
        "resource_budget_exceeded",
        "resource continuation exceeds its fixed budget",
    )
}
fn resource_cursor_error(error: crate::api::ApiError) -> crate::api::ApiError {
    match error.problem().reason.as_deref() {
        Some("invalid_query_cursor") => resource_invalid(),
        Some("query_budget_exceeded") => resource_full(),
        _ => error,
    }
}
fn owned_bytes(frontier: &QueryKeyedId, env: &QueryEnv) -> ApiResult<usize> {
    // Conservative entry + Arc/deque + TWO BTree ownership nodes. Keys use
    // actual capacity; this bound is allocation admission, not heap evidence.
    let mut bytes = 1024usize
        .checked_add(env.tz.capacity())
        .and_then(|n| n.checked_add(env.today.capacity()))
        .ok_or_else(full)?;
    bytes = bytes
        .checked_add(
            frontier
                .keys
                .capacity()
                .checked_mul(std::mem::size_of::<crate::store_query::QueryAtom>())
                .ok_or_else(full)?,
        )
        .ok_or_else(full)?;
    for key in &frontier.keys {
        bytes = bytes.checked_add(key.key.capacity()).ok_or_else(full)?;
    }
    Ok(bytes)
}

impl<S: Store> Replica<S> {
    /// Diagnostic injection only; no ambient clock or timing in production.
    #[cfg(feature = "testing")]
    pub fn set_query_trace(&mut self, trace: Option<Box<dyn Fn(&'static str)>>) {
        self.query_trace = trace;
    }
    pub(crate) fn trace_query(&self, _phase: &'static str) {
        #[cfg(feature = "testing")]
        if let Some(trace) = &self.query_trace {
            trace(_phase);
        }
    }
    fn cursor_stamp(&self, session: SessionId) -> ApiResult<Stamp> {
        if self.install.is_some()
            || self.apply_fault
            || !self.layer.touched_ids().is_empty()
            || self.layer.catalog().is_some()
        {
            return Err(stale());
        }
        let context = self.ready_context()?.map_err(|_| stale())?;
        if self.store.head().map_err(store_err)? != self.head {
            return Err(stale());
        }
        Ok(Stamp {
            generation: Some(context.generation()),
            head: self.head,
            as_of: self.view_version,
            store_generation: self.store_generation,
            grant: self.sessions.get(&session).and_then(super::Session::grant),
        })
    }
    fn resource_stamp(&self, session: SessionId) -> ApiResult<Stamp> {
        self.require_resource_inventory_read(session)?;
        if self.install.is_some() || self.apply_fault {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "resource_inventory_unavailable",
                "resource inventory is not ready",
            ));
        }
        if self.layer.resources_pending() {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "resource_inventory_pending",
                "resource inventory has pending changes",
            ));
        }
        // Catalog validity is deliberately NOT an inventory qualification.
        if self.store.head().map_err(store_err)? != self.head {
            return Err(stale());
        }
        Ok(Stamp {
            generation: None,
            head: self.head,
            as_of: self.view_version,
            store_generation: self.store_generation,
            grant: self.sessions.get(&session).and_then(super::Session::grant),
        })
    }

    pub(super) fn begin_resource_page(
        &mut self,
        session: SessionId,
        folder: Option<&str>,
        text: bool,
        limit: u32,
        cursor: Option<&str>,
    ) -> ApiResult<ResourcePosition> {
        let stamp = self.resource_stamp(session).map_err(|error| {
            if cursor.is_none() && error.problem().reason.as_deref() == Some("cursor_stale") {
                ErrorCode::Unavailable.err_with_reason(
                    "resource_inventory_unavailable",
                    "resource inventory head is not current",
                )
            } else {
                error
            }
        })?;
        let bytes = mdbn_wire::cbor::encode(&Cbor::Array(vec![
            Cbor::Text("mdbase/resource-invocation/v1".into()),
            folder.map(|s| Cbor::Text(s.into())).unwrap_or(Cbor::Null),
            Cbor::Bool(text),
            Cbor::Uint(u64::from(limit)),
        ]))
        .map_err(|_| resource_invalid())?;
        let fingerprint = mdbn_wire::hash::sha256(&bytes);
        let now = self.now();
        let saved = cursor
            .map(|token| {
                let handle =
                    parse_token_with_prefix(token, "r1.").map_err(resource_cursor_error)?;
                self.query_cursors
                    .get(session, handle, now)
                    .map_err(resource_cursor_error)
            })
            .transpose()?;
        if let Some(saved) = saved {
            let Payload::Resource { after } = &saved.payload else {
                return Err(resource_invalid());
            };
            if saved.invocation != fingerprint {
                return Err(resource_invalid());
            }
            if saved.stamp != stamp {
                return Err(stale());
            }
            Ok(ResourcePosition {
                after: Some(after.clone()),
                stamp,
                invocation: fingerprint,
                expires_at: saved.expires_at,
            })
        } else {
            Ok(ResourcePosition {
                after: None,
                stamp,
                invocation: fingerprint,
                expires_at: self
                    .query_cursors
                    .now(now)
                    .checked_add(TTL_MS)
                    .ok_or_else(resource_full)?,
            })
        }
    }

    pub(super) fn finish_resource_page(
        &mut self,
        session: SessionId,
        position: ResourcePosition,
        after: Option<String>,
    ) -> ApiResult<Option<String>> {
        if self.resource_stamp(session)? != position.stamp {
            return Err(stale());
        }
        let Some(after) = after else { return Ok(None) };
        let bytes = 1024usize
            .checked_add(after.capacity())
            .ok_or_else(resource_full)?;
        let entry = Entry {
            handle: [0; 16],
            stamp: position.stamp,
            invocation: position.invocation,
            payload: Payload::Resource { after },
            expires_at: position.expires_at,
            bytes,
        };
        self.query_cursors
            .issue(session, entry, &mut *self.host.entropy)
            .map(Some)
            .map_err(resource_cursor_error)
    }

    /// Ordinary no-cursor calls retain their fallback. Cursor calls never do.
    pub(crate) fn query_keyset(
        &mut self,
        session: SessionId,
        query: &Value,
        include: &Include,
    ) -> ApiResult<QueryResult> {
        self.trace_query("request_start");
        self.require(session, crate::policy::capability::READ)?;
        self.trace_query("read_before");
        let handle = supplied(query)?;
        let now = self.now();
        let saved = handle
            .map(|h| self.query_cursors.get(session, h, now))
            .transpose()?;
        if saved
            .as_ref()
            .is_some_and(|s| !matches!(s.payload, Payload::Query { .. }))
        {
            return Err(invalid("cursor method changed"));
        }
        let mut cq = crate::convert::value(query)
            .map_err(|e| ErrorCode::InvalidRequest.err(e.to_string()))?;
        if let mdbn_core::value::Value::Map(fields) = &mut cq {
            fields.remove("cursor"); // Resident envelope, not a Core query member.
        }
        let mut q = Query::from_value(&cq).map_err(|e| {
            ErrorCode::InvalidRequest.err_with_reason("invalid_query", format!("{e:?}"))
        })?;
        if saved.is_none()
            && (self.install.is_some()
                || !self.layer.touched_ids().is_empty()
                || self.layer.catalog().is_some()
                || q.limit.is_none_or(|n| n == 0 || n > MAX_SELECTED)
                || !q.projections.is_empty()
                || !q.select.is_empty()
                || !q.group_by.is_empty()
                || !q.summaries.is_empty())
        {
            return self.run_query(query, include);
        }
        let stamp = match self.cursor_stamp(session) {
            Ok(s) => s,
            Err(e) if saved.is_none() && e.problem().reason.as_deref() == Some("cursor_stale") => {
                return self.run_query(query, include);
            }
            Err(e) => return Err(e),
        };
        self.trace_query("capture_before");
        let fingerprint = invocation(query, include)?;
        if let Some(saved) = &saved {
            if saved.invocation != fingerprint {
                return Err(invalid("cursor query/include/offset/limit changed"));
            }
            if saved.stamp != stamp {
                return Err(stale());
            }
            // SDK repeats its original query. Its initial offset is paid ONCE.
            q.offset = 0;
        }
        let env = if let Some(saved) = &saved {
            let Payload::Query { env, .. } = &saved.payload else {
                return Err(invalid("cursor method changed"));
            };
            QueryEnv {
                now_ms: env.now_ms,
                today: env.today.clone(),
                tz: env.tz.clone(),
            }
        } else {
            let tz = self.host.zones.default_zone();
            QueryEnv {
                now_ms: now,
                today: self
                    .host
                    .zones
                    .local_date(now, &tz)
                    .unwrap_or_else(|| super::utc_date(now)),
                tz,
            }
        };
        let view = StoreView::new(&self.store, self.catalog.clone());
        let lv = LayerView {
            base: &view,
            layer: &self.layer,
        };
        let plan = mdbn_core::query::compile(&q, &self.catalog).map_err(|e| {
            ErrorCode::InvalidRequest.err_with_reason("invalid_query", format!("{e:?}"))
        })?;
        if mdbn_core::query::profile::lower(&plan, &self.catalog).is_err() && saved.is_none() {
            return self.run_query(query, include);
        }
        self.trace_query("prepare_done");
        let page = self.indexed_query_page(
            &plan,
            &lv,
            &env,
            include,
            saved.as_ref().and_then(|s| match &s.payload {
                Payload::Query { frontier, .. } => Some(frontier),
                Payload::Resource { .. } => None,
            }),
        );
        self.require(session, crate::policy::capability::READ)?;
        if self.cursor_stamp(session)? != stamp {
            return Err(stale());
        }
        if let Some(error) = view.error() {
            return Err(store_err(error));
        }
        let page = page.map_err(|e| {
            if saved.is_some() && e.problem().reason.as_deref() == Some("query_index_stale") {
                stale()
            } else {
                e
            }
        })?;
        let mut page = match page {
            Ok(p) => p,
            Err(_) if saved.is_none() => return self.run_query_per_record(query, include),
            Err(_) => return Err(stale()),
        };
        self.require(session, crate::policy::capability::READ)?;
        if self.cursor_stamp(session)? != stamp {
            return Err(stale());
        }
        self.trace_query("check_after");
        if page.result.has_more == Some(true) && !page.result.records.is_empty() {
            let frontier = page
                .frontier
                .take()
                .ok_or_else(|| ErrorCode::Internal.err("missing query frontier"))?;
            let bytes = owned_bytes(&frontier, &env)?;
            let expires_at = saved.as_ref().map(|s| s.expires_at).unwrap_or(
                self.query_cursors
                    .now(now)
                    .checked_add(TTL_MS)
                    .ok_or_else(full)?,
            );
            let entry = Entry {
                handle: [0; 16],
                stamp,
                invocation: fingerprint,
                payload: Payload::Query { env, frontier },
                expires_at,
                bytes,
            };
            page.result.cursor = Some(self.query_cursors.issue(
                session,
                entry,
                &mut *self.host.entropy,
            )?);
        } else if page.result.has_more == Some(true) {
            return Err(ErrorCode::Internal.err("query keyset made no progress"));
        }
        self.trace_query("request_end");
        Ok(page.result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::TestEntropy;
    use mdbn_wire::common::{B16, B32};

    fn entry(bytes: usize) -> Entry {
        Entry {
            handle: [0; 16],
            stamp: Stamp {
                generation: Some([3; 32]),
                head: Head::GENESIS,
                as_of: 7,
                store_generation: 2,
                grant: None,
            },
            invocation: B32([9; 32]),
            payload: Payload::Query {
                env: QueryEnv {
                    now_ms: 1,
                    today: "2026-10-08".into(),
                    tz: "UTC".into(),
                },
                frontier: QueryKeyedId {
                    id: B16([1; 16]),
                    keys: vec![],
                    encoded_bytes: 1,
                },
            },
            expires_at: 300_001,
            bytes,
        }
    }
    #[test]
    fn cursor_registry_bounds_are_per_session_and_eviction_is_typed() {
        let mut registry = Cursors::default();
        let mut entropy = TestEntropy::new(17);
        let a = SessionId(1);
        let b = SessionId(2);
        let first = registry.issue(a, entry(1024), &mut entropy).unwrap();
        let other = registry.issue(b, entry(1024), &mut entropy).unwrap();
        for _ in 0..MAX_CURSORS {
            registry.issue(a, entry(1024), &mut entropy).unwrap();
        }
        assert_eq!(registry.sessions[&a].entries.len(), MAX_CURSORS);
        assert_eq!(registry.sessions[&b].entries.len(), 1);
        assert_eq!(
            registry
                .get(a, parse_token(&first).unwrap(), 1)
                .err()
                .unwrap()
                .problem()
                .reason
                .as_deref(),
            Some("cursor_expired")
        );
        assert!(registry.get(b, parse_token(&other).unwrap(), 1).is_ok());
        assert_eq!(
            registry
                .get(a, parse_token(&other).unwrap(), 1)
                .err()
                .unwrap()
                .problem()
                .reason
                .as_deref(),
            Some("invalid_query_cursor")
        );
        registry.close(a);
        assert_eq!(registry.owners.len(), 1);
        registry.clear();
        assert!(registry.sessions.is_empty() && registry.owners.is_empty());
    }
    #[test]
    fn cursor_registry_bytes_expiry_replay_and_clock_are_bounded() {
        let mut registry = Cursors::default();
        let mut entropy = TestEntropy::new(23);
        let session = SessionId(1);
        let first = registry
            .issue(session, entry(MAX_CURSOR_BYTES / 2), &mut entropy)
            .unwrap();
        let handle = parse_token(&first).unwrap();
        let a = registry.get(session, handle, 12).unwrap();
        let b = registry.get(session, handle, 13).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        let Payload::Query { env, .. } = &b.payload else {
            panic!("query payload")
        };
        assert_eq!(env.now_ms, 1); // Never replaced by fresh host time.
        assert_eq!(b.expires_at, 300_001); // Retry never extends the family.
        assert!(
            registry
                .issue(session, entry(MAX_CURSOR_BYTES + 1), &mut entropy)
                .is_err()
        );
        assert_eq!(registry.sessions[&session].entries.len(), 1);
        registry
            .issue(session, entry(MAX_CURSOR_BYTES / 2), &mut entropy)
            .unwrap();
        assert_eq!(registry.sessions[&session].bytes, MAX_CURSOR_BYTES);
        registry
            .issue(session, entry(MAX_CURSOR_BYTES / 2), &mut entropy)
            .unwrap();
        assert_eq!(registry.sessions[&session].entries.len(), 2);
        assert!(registry.sessions[&session].bytes <= MAX_CURSOR_BYTES);
        let handle = registry.sessions[&session].entries.back().unwrap().handle;
        assert_eq!(
            registry
                .get(session, handle, 300_001)
                .err()
                .unwrap()
                .problem()
                .reason
                .as_deref(),
            Some("cursor_expired")
        );
        assert_eq!(
            registry
                .get(session, handle, 1)
                .err()
                .unwrap()
                .problem()
                .reason
                .as_deref(),
            Some("cursor_expired")
        );
    }
    #[test]
    fn resource_and_query_payloads_share_one_session_pool_and_fixed_expiry() {
        let mut registry = Cursors::default();
        let mut entropy = TestEntropy::new(29);
        let session = SessionId(1);
        let query = registry
            .issue(session, entry(MAX_CURSOR_BYTES / 2), &mut entropy)
            .unwrap();
        let mut resource = entry(MAX_CURSOR_BYTES / 2);
        resource.stamp.generation = None;
        resource.payload = Payload::Resource {
            after: "_types/a.md".into(),
        };
        let resource = registry.issue(session, resource, &mut entropy).unwrap();
        assert!(resource.starts_with("r1."));
        assert!(parse_token(&resource).is_err());
        assert!(parse_token_with_prefix(&query, "r1.").is_err());
        assert_eq!(registry.sessions[&session].entries.len(), 2);
        assert_eq!(registry.sessions[&session].bytes, MAX_CURSOR_BYTES);
        let handle = parse_token_with_prefix(&resource, "r1.").unwrap();
        let saved = registry.get(session, handle, 10).unwrap();
        assert!(matches!(saved.payload, Payload::Resource { .. }));
        assert_eq!(saved.expires_at, 300_001);
        registry
            .issue(session, entry(MAX_CURSOR_BYTES / 2), &mut entropy)
            .unwrap();
        assert_eq!(registry.sessions[&session].entries.len(), 2);
        assert_eq!(
            registry
                .get(session, parse_token(&query).unwrap(), 10)
                .err()
                .unwrap()
                .problem()
                .reason
                .as_deref(),
            Some("cursor_expired")
        );
        assert!(registry.get(session, handle, 10).is_ok());
        assert_eq!(
            registry
                .get(session, handle, 300_001)
                .err()
                .unwrap()
                .problem()
                .reason
                .as_deref(),
            Some("cursor_expired")
        );
        registry.close(session);
        assert!(registry.sessions.is_empty() && registry.owners.is_empty());
    }
    #[test]
    fn cursor_parse_and_invocation_binding_are_exact() {
        for value in [
            "",
            "q2.00000000000000000000000000000000",
            "q1.0000000000000000000000000000000G",
        ] {
            assert_eq!(
                parse_token(value)
                    .err()
                    .unwrap()
                    .problem()
                    .reason
                    .as_deref(),
                Some("invalid_query_cursor")
            );
        }
        assert!(parse_token(&"x".repeat(MAX_TOKEN_BYTES + 1)).is_err());
        let mut fields = vec![
            ("limit".into(), Value::Int(5)),
            ("offset".into(), Value::Int(10)),
        ];
        let include = Include {
            effective: None,
            body: None,
            document: None,
            diagnostics: None,
        };
        let original = invocation(&Value::Map(fields.clone()), &include).unwrap();
        fields.push(("cursor".into(), Value::Text(token([1; 16]))));
        assert_eq!(
            invocation(&Value::Map(fields.clone()), &include).unwrap(),
            original
        );
        fields[1].1 = Value::Int(11);
        assert_ne!(invocation(&Value::Map(fields), &include).unwrap(), original);
    }
}
