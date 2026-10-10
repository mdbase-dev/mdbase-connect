//! # D2 candidate B: one Durable Object per collection, plus R2
//!
//! The same `mdbn-log-service` logic and `mdbn-wire` codec as the Postgres
//! gateway, compiled to wasm32 and run inside a Durable Object
//! (`log-service-api.md` §13):
//! - **Actor.** One object per collection, named by the collection UUID. SQLite
//!   storage holds the head, ACL, tokens, snapshot pointers, object metadata and the
//!   retained items. Storage calls are synchronous; commits run in
//!   `transactionSync`, and output gates hold the response until the write is
//!   durable (I1, ack-after-durable).
//! - **WebSockets** terminate at the object with the hibernation API, so push and
//!   ephemeral streams are local to the actor.
//! - **Objects** live in R2 under `c/<collection>/<address>`. Direct transfers go
//!   through the stateless Worker straight to R2 (never through the actor), which
//!   verifies the SHA-256 on PUT.
//!
//! The Worker routes `/v1/ws?c=` and `/v1/rpc` to the collection's object.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]
#![allow(async_fn_in_trait)]

mod backup;
mod collection_closing;
mod deletion_floor;
mod deletion_registry;
mod destination_denial;
mod ingress;
mod metrics;
mod native_r2;
mod registry_backup;
mod restore_aux;

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use js_sys::{Function, Reflect, Uint8Array};
use mdbn_log_service::auth::{
    Claims, NonceCache, Principal, collection_from_params, http_nonce, verify_http_claims,
    verify_token_with_budget,
};
use mdbn_log_service::backend::Verified;
use mdbn_log_service::backend::{Archive, Backend, Mode, ObjectStore, Txn, Write};
use mdbn_log_service::decode::{Budget, Usage};
use mdbn_log_service::direct::{DownloadSpan, RangeRejection};
use mdbn_log_service::error::{Result as LsResult, ServiceError};
use mdbn_log_service::hub::{Hub, Push};
use mdbn_log_service::limits::TOKEN_RETENTION_MS;
use mdbn_log_service::model::{
    AclEntry, CollectionMeta, CollectionState, CommitNotice, ObjectMeta, RetentionTier,
    SnapshotRow, StoredItem, archive_object_key, archive_segment_key, object_key, parse_uuid,
    unhex,
};
use mdbn_log_service::service::{base64, staging_key, verify_direct, verify_upload_with_budget};
use mdbn_log_service::session::{self, HubHost, Session};
use mdbn_log_service::{Config, Service};
use mdbn_wire::common::{B16, B32, Uuid};
use mdbn_wire::hash::{CHAIN_ZERO, chain_hash, sha256};
use mdbn_wire::log_service::{LsFrame, LsRequest, LsResponse};
use mdbn_wire::render::hex;
use mdbn_wire::schema::Wire;
use serde::{Deserialize, Serialize};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;
use worker::*;

// ---------------------------------------------------------------- host helpers

fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let arr = Uint8Array::new_with_length(N as u32);
    let crypto = Reflect::get(&js_sys::global(), &"crypto".into()).expect("crypto");
    let f: Function = Reflect::get(&crypto, &"getRandomValues".into())
        .expect("getRandomValues")
        .dyn_into()
        .expect("function");
    f.call1(&crypto, &arr).expect("random");
    let mut out = [0u8; N];
    arr.copy_to(&mut out);
    out
}

/// `/debug/*` (lose-tail injection, bucket teardown) exists only on throwaway
/// evaluation Workers: it needs both `DEBUG_HOOKS=1` and `INSECURE_TEST_KEYS=1`,
/// mirroring the native gateway's gate.
fn debug_hooks(env: &Env) -> bool {
    let on = |k: &str| env.var(k).map(|v| v.to_string()).unwrap_or_default() == "1";
    on("DEBUG_HOOKS") && on("INSECURE_TEST_KEYS")
}

fn config(env: &Env) -> Config {
    let var = |k: &str| {
        env.var(k)
            .map(|v| v.to_string())
            .ok()
            .or_else(|| env.secret(k).map(|v| v.to_string()).ok())
    };
    if var("INSECURE_TEST_KEYS").as_deref() != Some("1") {
        let base = var("PUBLIC_BASE").unwrap_or_default();
        return Config::from_hex(
            &var("LOGSVC_ROOT_KEYS").unwrap_or_default(),
            &var("LOGSVC_TOKEN_ISSUERS").unwrap_or_default(),
            &var("LOGSVC_URL_SECRET").unwrap_or_default(),
            &base,
        )
        .expect("log service config: set LOGSVC_* secrets");
    }
    // Throwaway evaluation only: deterministic test control plane.
    let label = env
        .var("TESTKIT_CP")
        .map(|v| v.to_string())
        .unwrap_or_else(|_| "conformance".into());
    let base = env
        .var("PUBLIC_BASE")
        .map(|v| v.to_string())
        .unwrap_or_else(|_| "http://127.0.0.1:8787".into());
    let cp = mdbn_log_service::testkit::ControlPlane::new(&label);
    Config {
        roots: vec![cp.root_pk()],
        token_issuers: vec![cp.issuer_pk()],
        url_secret: sha256(format!("{label}/url-secret").as_bytes()).0.to_vec(),
        public_base: base,
    }
}

// Cheap authentication preflight before allocating/reading an RPC body. Full
// possession, route/scope and replay verification still happen in the actor.
fn rpc_preflight(req: &Request, cfg: &Config, budget: &Budget) -> LsResult<Claims> {
    let unauth = || ServiceError::reason(mdbn_log_service::Code::Unauthenticated, "token");
    let auth = req
        .headers()
        .get("authorization")
        .ok()
        .flatten()
        .ok_or_else(unauth)?;
    let token = auth.strip_prefix("Bearer ").ok_or_else(unauth)?;
    if token.is_empty() || token.len() > 16 * 1024 {
        return Err(unauth());
    }
    if ![("x-mdbase-nonce", 64), ("x-mdbase-sig", 128)]
        .iter()
        .all(|(key, len)| {
            req.headers()
                .get(key)
                .ok()
                .flatten()
                .is_some_and(|s| s.len() == *len && s.bytes().all(|b| b.is_ascii_hexdigit()))
        })
    {
        return Err(unauth());
    }
    verify_token_with_budget(token, &cfg.token_issuers, now_ms(), budget)
}

// Counters restrict resources, NOT authority. The public Worker overwrites client
// values. Direct actor callers can never exceed the fresh budget's limits.
fn forwarded_budget(req: &Request) -> LsResult<Budget> {
    let values: Vec<_> = [
        "x-logsvc-decode-nodes",
        "x-logsvc-decode-work",
        "x-logsvc-decode-depth",
    ]
    .iter()
    .map(|key| req.headers().get(key).ok().flatten())
    .collect();
    if values.iter().all(Option::is_none) {
        return Ok(Budget::default());
    }
    let mut parsed = values
        .iter()
        .map(|v| v.as_deref().and_then(|s| s.parse::<usize>().ok()));
    Budget::from_usage(Usage {
        nodes: parsed
            .next()
            .flatten()
            .ok_or_else(|| ServiceError::invalid("cbor_budget"))?,
        work_bytes: parsed
            .next()
            .flatten()
            .ok_or_else(|| ServiceError::invalid("cbor_budget"))?,
        depth: parsed
            .next()
            .flatten()
            .ok_or_else(|| ServiceError::invalid("cbor_budget"))?,
    })
}

fn cbor_preflight(body: &[u8], env: &Env, budget: &Budget) -> Result<Option<Response>> {
    let Err(rejected) = budget.preflight(body) else {
        return Ok(None);
    };
    let mut response = Response::error("cbor rejected", 400)?;
    if debug_hooks(env) {
        response
            .headers_mut()
            .set("x-logsvc-cbor-nodes", &rejected.stats.nodes.to_string())?;
        response.headers_mut().set("x-logsvc-cbor-decoded", "0")?;
        response
            .headers_mut()
            .set("x-logsvc-cbor-reason", rejected.reason)?;
    }
    Ok(Some(response))
}

fn ls_err(e: impl std::fmt::Display) -> ServiceError {
    ServiceError::backend(format!("durable object: {e}"))
}

fn blob(b: &[u8]) -> JsValue {
    // DO SQLite binds BLOBs from ArrayBuffer.
    let a = Uint8Array::new_with_length(b.len() as u32);
    a.copy_from(b);
    a.buffer().into()
}
fn int(n: i64) -> JsValue {
    JsValue::from_f64(n as f64)
}

fn as_i64(v: &SqlStorageValue) -> i64 {
    match v {
        SqlStorageValue::Integer(i) => *i,
        SqlStorageValue::Float(f) => *f as i64,
        SqlStorageValue::Boolean(b) => *b as i64,
        _ => 0,
    }
}
fn as_bytes(v: &SqlStorageValue) -> Vec<u8> {
    match v {
        SqlStorageValue::Blob(b) => b.clone(),
        _ => Vec::new(),
    }
}
fn b16(v: &SqlStorageValue) -> B16 {
    B16(as_bytes(v).try_into().unwrap_or([0; 16]))
}
fn b32(v: &SqlStorageValue) -> B32 {
    B32(as_bytes(v).try_into().unwrap_or([0; 32]))
}

// ---------------------------------------------------------------- backend

const SCHEMA: &[&str] = &[
    // Anchors the actor's namespace identity before genesis and across restart.
    "CREATE TABLE IF NOT EXISTS actor_route (k INTEGER PRIMARY KEY, id BLOB NOT NULL)",
    "CREATE TABLE IF NOT EXISTS meta (k INTEGER PRIMARY KEY, id BLOB NOT NULL, meta BLOB NOT NULL)",
    "INSERT OR IGNORE INTO actor_route (k, id) SELECT 0, id FROM meta WHERE k = 0",
    "CREATE TABLE IF NOT EXISTS acl (device BLOB PRIMARY KEY, account BLOB NOT NULL, kind INTEGER NOT NULL, sign_pk BLOB NOT NULL, active INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS items (seq INTEGER PRIMARY KEY, kind INTEGER NOT NULL, bytes BLOB NOT NULL, appended_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS tokens (token BLOB PRIMARY KEY, seq INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS snapshots (seq INTEGER PRIMARY KEY, manifest BLOB NOT NULL, author BLOB NOT NULL, created_at INTEGER NOT NULL, endorsed INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS objects (address BLOB PRIMARY KEY, kind INTEGER NOT NULL, size INTEGER NOT NULL, checksum BLOB NOT NULL, committed INTEGER NOT NULL, created_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS object_refs (address BLOB NOT NULL, holder_kind INTEGER NOT NULL, holder INTEGER NOT NULL, PRIMARY KEY (address, holder_kind, holder))",
    "CREATE INDEX IF NOT EXISTS object_refs_holder ON object_refs (holder_kind, holder)",
    // Used only in the credential registry object (§12).
    "CREATE TABLE IF NOT EXISTS revoked_devices (device BLOB PRIMARY KEY, revoked_at INTEGER NOT NULL)",
    // Single-use HTTPS proofs must survive hibernation and Worker updates.
    "CREATE TABLE IF NOT EXISTS used_http_nonces (nonce BLOB PRIMARY KEY, expires_at INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS used_http_nonces_expiry ON used_http_nonces (expires_at)",
];

/// The object named by the nil UUID is the service-wide credential registry
/// (`revoke_device_credentials`, §12). Collection IDs are never nil.
const REGISTRY: Uuid = B16([0; 16]);

/// The collection's SQLite storage. The object is the actor; the async mutex only
/// keeps two write transactions from interleaving across an `await` (there is
/// none inside an append, but object commits await R2 outside the transaction).
pub struct DoBackend {
    sql: SqlStorage,
    storage: Storage,
    lock: Rc<async_lock::Mutex<()>>,
    ns: ObjectNamespace,
    /// This object is the credential registry (learned from its first request).
    is_registry: std::cell::Cell<bool>,
}

impl DoBackend {
    async fn registry(&self, op: &str, device: &Uuid) -> LsResult<bool> {
        if self.is_registry.get() {
            return self.registry_local(op, device);
        }
        let stub = self
            .ns
            .get_by_name(&REGISTRY.to_uuid_string())
            .map_err(ls_err)?;
        let url = format!(
            "https://registry/registry/{op}?c={}&d={}",
            REGISTRY.to_uuid_string(),
            device.to_hex()
        );
        let mut r = stub.fetch_with_str(&url).await.map_err(ls_err)?;
        if r.status_code() != 200 {
            return Err(ls_err(format!("registry status {}", r.status_code())));
        }
        Ok(r.text().await.map_err(ls_err)? == "1")
    }

    fn registry_local(&self, op: &str, device: &Uuid) -> LsResult<bool> {
        match op {
            "revoke" => {
                self.registry_merge_rows(&[(*device, now_ms())])?;
                Ok(true)
            }
            _ => Ok(!self
                .exec(
                    "SELECT 1 FROM revoked_devices WHERE device = ?",
                    vec![blob(&device.0)],
                )?
                .is_empty()),
        }
    }
}

impl DoBackend {
    fn exec(&self, q: &str, b: Vec<JsValue>) -> LsResult<Vec<Vec<SqlStorageValue>>> {
        let c = self.sql.exec_raw(q, b).map_err(ls_err)?;
        c.raw().collect::<Result<Vec<_>>>().map_err(ls_err)
    }

    /// Consume an already authenticated HTTPS nonce durably. No await separates
    /// pruning and insertion, and the unique key serializes concurrent requests.
    fn consume_http_nonce(&self, nonce: &[u8; 32], now: i64) -> LsResult<()> {
        self.exec(
            "DELETE FROM used_http_nonces WHERE expires_at < ?",
            vec![int(now)],
        )?;
        let issued = u64::from_be_bytes(nonce[..8].try_into().unwrap()) as i64;
        let rows = self.exec(
            "INSERT OR IGNORE INTO used_http_nonces (nonce, expires_at) VALUES (?, ?) RETURNING nonce",
            vec![blob(nonce), int(issued + mdbn_log_service::auth::HTTP_NONCE_TTL_MS)],
        )?;
        if rows.is_empty() {
            return Err(ServiceError::reason(
                mdbn_log_service::Code::Unauthenticated,
                "replay",
            ));
        }
        Ok(())
    }

    fn route(&self) -> LsResult<Option<Uuid>> {
        Ok(self
            .exec("SELECT id FROM actor_route WHERE k = 0", vec![])?
            .first()
            .map(|r| b16(&r[0])))
    }

    fn record_route(&self, c: &Uuid) -> LsResult<()> {
        match self.route()? {
            Some(id) if id != *c => Err(ServiceError::reason(
                mdbn_log_service::Code::Forbidden,
                "actor_collection",
            )),
            Some(_) => Ok(()),
            None => self
                .exec(
                    "INSERT INTO actor_route (k, id) VALUES (0, ?)",
                    vec![blob(&c.0)],
                )
                .map(|_| ()),
        }
    }

    fn own(&self) -> Option<Uuid> {
        self.exec("SELECT id FROM meta WHERE k = 0", vec![])
            .ok()?
            .first()
            .map(|r| b16(&r[0]))
    }

    /// Test hook: lose the last `n` items (a failover that lost a tail).
    pub fn lose_tail(&self, n: u64, roots: &[B32]) -> LsResult<()> {
        // Test-only destructive hooks cannot leave an apparently valid cut.
        self.exec("UPDATE backup_cut SET valid = 0 WHERE k = 0", vec![])?;
        let rows = self.exec("SELECT meta FROM meta WHERE k = 0", vec![])?;
        let Some(r) = rows.first() else { return Ok(()) };
        let mut meta = CollectionMeta::decode(&as_bytes(&r[0]))?;
        let cut = meta.head.saturating_sub(n) as i64;
        self.exec("DELETE FROM items WHERE seq > ?", vec![int(cut)])?;
        self.exec("DELETE FROM tokens WHERE seq > ?", vec![int(cut)])?;
        let last = self.exec(
            "SELECT seq, bytes FROM items ORDER BY seq DESC LIMIT 1",
            vec![],
        )?;
        let (h, c) = last.first().map_or((0, CHAIN_ZERO), |r| {
            (as_i64(&r[0]) as u64, chain_hash(&as_bytes(&r[1])))
        });
        // A lagging standby also lacks the lost items' policy effects.
        let control: Vec<(u64, Vec<u8>)> = self
            .exec(
                "SELECT seq, bytes FROM items WHERE kind <> 1 ORDER BY seq",
                vec![],
            )?
            .iter()
            .map(|r| (as_i64(&r[0]) as u64, as_bytes(&r[1])))
            .collect();
        let st = mdbn_log_service::service::rebuild_state(&meta, &control, roots)?;
        meta = st.meta;
        self.exec("DELETE FROM acl", vec![])?;
        for e in st.acl.values() {
            self.exec(
                "INSERT INTO acl (device, account, kind, sign_pk, active) VALUES (?, ?, ?, ?, ?)",
                vec![
                    blob(&e.device.0),
                    blob(&e.account.0),
                    int(e.kind as i64),
                    blob(&e.sign_pk.0),
                    int(e.active as i64),
                ],
            )?;
        }
        meta.head = h;
        meta.head_chain = c;
        self.exec(
            "UPDATE meta SET meta = ? WHERE k = 0",
            vec![blob(&meta.encode())],
        )?;
        Ok(())
    }
}

/// A transaction on the object's own collection.
pub struct DoTxn<'a> {
    be: &'a DoBackend,
    _guard: Option<async_lock::MutexGuard<'a, ()>>,
    budget: Budget,
    writes: Vec<Write>,
}

impl Backend for DoBackend {
    type Txn<'a> = DoTxn<'a>;
    // Serialized authority replies require an explicit enclosing budget.
    // The unscoped trait method keeps its fail-closed unavailable default.
    async fn collection_deletion_floor_with_budget(
        &self,
        collection: &Uuid,
        budget: &Budget,
    ) -> LsResult<Option<mdbn_log_service::deletion::CollectionDeletionRecord>> {
        self.lookup_deletion_floor(collection, budget).await
    }
    async fn credentials_revoked(&self, device: &Uuid) -> LsResult<bool> {
        self.registry("check", device).await
    }
    async fn revoke_credentials(&self, device: &Uuid, _now: i64) -> LsResult<()> {
        self.registry("revoke", device).await.map(|_| ())
    }
    async fn begin(&self, c: &Uuid, mode: Mode) -> LsResult<DoTxn<'_>> {
        self.begin_with_budget(c, mode, &Budget::default()).await
    }
    async fn begin_with_budget(
        &self,
        c: &Uuid,
        mode: Mode,
        budget: &Budget,
    ) -> LsResult<DoTxn<'_>> {
        let guard = match mode {
            Mode::Write => Some(self.lock.lock().await),
            Mode::Read => None,
        };
        // WebSocket requests can name arbitrary collections. Never let a frame
        // access or create a collection under a different namespace actor, even
        // before genesis or after hibernation.
        if self.route()? != Some(*c) {
            return Err(ServiceError::reason(
                mdbn_log_service::Code::Forbidden,
                "actor_collection",
            ));
        }
        Ok(DoTxn {
            be: self,
            _guard: guard,
            budget: budget.clone(),
            writes: Vec::new(),
        })
    }
}

impl Txn for DoTxn<'_> {
    async fn load(&mut self) -> LsResult<Option<CollectionState>> {
        let rows = self.be.exec("SELECT meta FROM meta WHERE k = 0", vec![])?;
        let Some(r) = rows.first() else {
            return Ok(None);
        };
        let meta = CollectionMeta::decode_with_budget(&as_bytes(&r[0]), &self.budget)?;
        let mut acl = BTreeMap::new();
        for r in self.be.exec(
            "SELECT device, account, kind, sign_pk, active FROM acl",
            vec![],
        )? {
            let e = AclEntry {
                device: b16(&r[0]),
                account: b16(&r[1]),
                kind: as_i64(&r[2]) as u64,
                sign_pk: b32(&r[3]),
                active: as_i64(&r[4]) != 0,
            };
            acl.insert(e.device, e);
        }
        Ok(Some(CollectionState { meta, acl }))
    }

    async fn items(
        &mut self,
        after: u64,
        limit: u64,
        max_bytes: u64,
        control_only: bool,
    ) -> LsResult<Vec<StoredItem>> {
        let filter = if control_only { "AND kind <> 1" } else { "" };
        let q = format!(
            "SELECT seq, kind, bytes, appended_at FROM (
               SELECT seq, kind, bytes, appended_at, sum(length(bytes)) OVER (ORDER BY seq) AS run
               FROM items WHERE seq > ? {filter} ORDER BY seq LIMIT ?)
             WHERE run <= ? OR run = length(bytes) ORDER BY seq"
        );
        let max = max_bytes.min(1 << 52) as i64;
        let rows = self.be.exec(
            &q,
            vec![int(after as i64), int(limit.min(1 << 52) as i64), int(max)],
        )?;
        Ok(rows
            .iter()
            .map(|r| StoredItem {
                seq: as_i64(&r[0]) as u64,
                kind: as_i64(&r[1]) as u64,
                bytes: as_bytes(&r[2]),
                appended_at: as_i64(&r[3]),
                token: None,
                refs: vec![],
            })
            .collect())
    }

    async fn tokens(&mut self, tokens: &[B16], now: i64) -> LsResult<Vec<Option<u64>>> {
        tokens
            .iter()
            .map(|t| {
                let r = self.be.exec(
                    "SELECT seq FROM tokens WHERE token = ? AND expires_at > ?",
                    vec![blob(&t.0), int(now)],
                )?;
                Ok(r.first().map(|r| as_i64(&r[0]) as u64))
            })
            .collect()
    }

    async fn objects(&mut self, addresses: &[B32]) -> LsResult<Vec<Option<ObjectMeta>>> {
        addresses
            .iter()
            .map(|a| {
                let r = self.be.exec(
                    "SELECT kind, size, checksum, committed, created_at FROM objects WHERE address = ?",
                    vec![blob(&a.0)],
                )?;
                Ok(r.first().map(|r| ObjectMeta {
                    address: *a,
                    kind: as_i64(&r[0]) as u64,
                    size: as_i64(&r[1]) as u64,
                    checksum: b32(&r[2]),
                    committed: as_i64(&r[3]) != 0,
                    created_at: as_i64(&r[4]),
                }))
            })
            .collect()
    }

    async fn snapshots(&mut self) -> LsResult<Vec<SnapshotRow>> {
        let rows = self.be.exec(
            "SELECT seq, manifest, author, created_at, endorsed FROM snapshots ORDER BY seq DESC",
            vec![],
        )?;
        Ok(rows
            .iter()
            .map(|r| SnapshotRow {
                seq: as_i64(&r[0]) as u64,
                manifest: b32(&r[1]),
                author: b16(&r[2]),
                created_at: as_i64(&r[3]),
                endorsed: as_i64(&r[4]) != 0,
                refs: vec![],
            })
            .collect())
    }

    async fn last_seq_at_or_before(&mut self, t: i64) -> LsResult<u64> {
        let r = self.be.exec(
            "SELECT coalesce(max(seq), 0) FROM items WHERE appended_at <= ?",
            vec![int(t)],
        )?;
        Ok(r.first().map_or(0, |r| as_i64(&r[0]) as u64))
    }

    async fn entry_bytes_through(&mut self, c: u64) -> LsResult<u64> {
        let r = self.be.exec(
            "SELECT coalesce(sum(length(bytes)), 0) FROM items WHERE seq <= ? AND kind = 1",
            vec![int(c as i64)],
        )?;
        Ok(r.first().map_or(0, |r| as_i64(&r[0]) as u64))
    }

    async fn gc_candidates(&mut self, before: i64, limit: u64) -> LsResult<Vec<ObjectMeta>> {
        let rows = self.be.exec(
            "SELECT address, kind, size, checksum, committed, created_at FROM objects o
             WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM object_refs r WHERE r.address = o.address)
             LIMIT ?",
            vec![int(before), int(limit as i64)],
        )?;
        Ok(rows
            .iter()
            .map(|r| ObjectMeta {
                address: b32(&r[0]),
                kind: as_i64(&r[1]) as u64,
                size: as_i64(&r[2]) as u64,
                checksum: b32(&r[3]),
                committed: as_i64(&r[4]) != 0,
                created_at: as_i64(&r[5]),
            })
            .collect())
    }

    async fn snapshot_refs(&mut self, seq: u64) -> LsResult<Vec<B32>> {
        let rows = self.be.exec(
            "SELECT address FROM object_refs WHERE holder_kind = 1 AND holder = ? ORDER BY address",
            vec![int(seq as i64)],
        )?;
        Ok(rows.iter().map(|r| b32(&r[0])).collect())
    }

    async fn list_objects(&mut self, after: Option<B32>, limit: u64) -> LsResult<Vec<ObjectMeta>> {
        let after = after.map_or(Vec::new(), |a| a.0.to_vec());
        let rows = self.be.exec(
            "SELECT address, kind, size, checksum, committed, created_at FROM objects
             WHERE committed = 1 AND address > ? ORDER BY address LIMIT ?",
            vec![blob(&after), int(limit as i64)],
        )?;
        Ok(rows
            .iter()
            .map(|r| ObjectMeta {
                address: b32(&r[0]),
                kind: as_i64(&r[1]) as u64,
                size: as_i64(&r[2]) as u64,
                checksum: b32(&r[3]),
                committed: as_i64(&r[4]) != 0,
                created_at: as_i64(&r[5]),
            })
            .collect())
    }

    fn write(&mut self, w: Write) {
        self.writes.push(w);
    }

    async fn commit(self) -> LsResult<()> {
        let publishes = deletion_floor::publishes(&self.writes);
        if publishes {
            self.be.refuse_destination_denial()?;
            let collection = self
                .be
                .route()?
                .ok_or_else(mdbn_log_service::deletion::CollectionDeletionRecord::unavailable)?;
            self.be
                .refuse_deletion_floor(&collection, &self.budget)
                .await?;
        }
        // All guards below and the storage transaction are synchronous. No SQL
        // cursor or partially applied write crosses the authority read await.
        // The nil reply is supplementary: Closing may have committed while the
        // producer held its write lock across that await.
        if publishes {
            self.be.refuse_destination_denial()?;
        }
        self.be.backup_guard(&self.writes)?;
        let has_restore_aux = self.be.restore_aux_guard(&self.writes)?;
        let sql = self.be.sql.clone();
        let writes = self.writes;
        transaction_sync(&self.be.storage, move || {
            if publishes {
                destination_denial::refuse(&sql).map_err(|e| JsValue::from_str(&e.to_string()))?;
            }
            let x = |q: &str, b: Vec<JsValue>| -> std::result::Result<(), JsValue> {
                sql.exec_raw(q, b)
                    .map(|_| ())
                    .map_err(|e| JsValue::from_str(&e.to_string()))
            };
            for w in writes {
                match w {
                    Write::CreateCollection(s) => {
                        x(
                            "INSERT INTO meta (k, id, meta) VALUES (0, ?, ?)",
                            vec![blob(&s.meta.id.0), blob(&s.meta.encode())],
                        )?;
                        for e in s.acl.values() {
                            acl(&x, e)?;
                        }
                    }
                    Write::PutMeta(m) => {
                        if has_restore_aux && m.status == mdbn_log_service::model::Status::Live {
                            x("DELETE FROM restore_aux_tokens", vec![])?;
                            x("DELETE FROM restore_aux", vec![])?;
                        }
                        x(
                            "UPDATE meta SET meta = ? WHERE k = 0",
                            vec![blob(&m.encode())],
                        )?;
                    }
                    Write::UpsertAcl(e) => acl(&x, &e)?,
                    Write::InsertItem(i) => {
                        x(
                            "INSERT INTO items (seq, kind, bytes, appended_at) VALUES (?, ?, ?, ?)",
                            vec![
                                int(i.seq as i64),
                                int(i.kind as i64),
                                blob(&i.bytes),
                                int(i.appended_at),
                            ],
                        )?;
                        if let Some(t) = i.token {
                            x(
                                "INSERT OR REPLACE INTO tokens (token, seq, expires_at) VALUES (?, ?, ?)",
                                vec![
                                    blob(&t.0),
                                    int(i.seq as i64),
                                    int(i.appended_at + TOKEN_RETENTION_MS),
                                ],
                            )?;
                        }
                        for a in &i.refs {
                            x(
                                "INSERT OR IGNORE INTO object_refs (address, holder_kind, holder) VALUES (?, 0, ?)",
                                vec![blob(&a.0), int(i.seq as i64)],
                            )?;
                        }
                    }
                    Write::PutObject(o) => x(
                        "INSERT INTO objects (address, kind, size, checksum, committed, created_at)
                         VALUES (?, ?, ?, ?, ?, ?)
                         ON CONFLICT (address) DO UPDATE SET committed = excluded.committed,
                           created_at = excluded.created_at WHERE objects.committed = 0",
                        vec![
                            blob(&o.address.0),
                            int(o.kind as i64),
                            int(o.size as i64),
                            blob(&o.checksum.0),
                            int(o.committed as i64),
                            int(o.created_at),
                        ],
                    )?,
                    Write::DeleteObject(a) => {
                        x("DELETE FROM objects WHERE address = ?", vec![blob(&a.0)])?
                    }
                    Write::InsertSnapshot(s) => {
                        x(
                            "INSERT INTO snapshots (seq, manifest, author, created_at, endorsed) VALUES (?, ?, ?, ?, ?)",
                            vec![
                                int(s.seq as i64),
                                blob(&s.manifest.0),
                                blob(&s.author.0),
                                int(s.created_at),
                                int(s.endorsed as i64),
                            ],
                        )?;
                        for a in &s.refs {
                            x(
                                "INSERT OR IGNORE INTO object_refs (address, holder_kind, holder) VALUES (?, 1, ?)",
                                vec![blob(&a.0), int(s.seq as i64)],
                            )?;
                        }
                    }
                    Write::EndorseSnapshot(seq) => x(
                        "UPDATE snapshots SET endorsed = 1 WHERE seq = ?",
                        vec![int(seq as i64)],
                    )?,
                    Write::DeleteSnapshot(seq) => {
                        x("DELETE FROM snapshots WHERE seq = ?", vec![int(seq as i64)])?;
                        x(
                            "DELETE FROM object_refs WHERE holder_kind = 1 AND holder = ?",
                            vec![int(seq as i64)],
                        )?;
                    }
                    Write::DeleteEntriesThrough(c) => {
                        x(
                            "DELETE FROM object_refs WHERE holder_kind = 0 AND holder IN (SELECT seq FROM items WHERE seq <= ? AND kind = 1)",
                            vec![int(c as i64)],
                        )?;
                        x(
                            "DELETE FROM items WHERE seq <= ? AND kind = 1",
                            vec![int(c as i64)],
                        )?;
                    }
                    Write::Notify(_) => {}
                }
            }
            Ok(())
        })
    }
}

fn acl(
    x: &impl Fn(&str, Vec<JsValue>) -> std::result::Result<(), JsValue>,
    e: &AclEntry,
) -> std::result::Result<(), JsValue> {
    x(
        "INSERT OR REPLACE INTO acl (device, account, kind, sign_pk, active) VALUES (?, ?, ?, ?, ?)",
        vec![
            blob(&e.device.0),
            blob(&e.account.0),
            int(e.kind as i64),
            blob(&e.sign_pk.0),
            int(e.active as i64),
        ],
    )
}

/// `ctx.storage.transactionSync(fn)`: all writes commit atomically or none do.
fn transaction_sync<F>(storage: &Storage, f: F) -> LsResult<()>
where
    F: FnOnce() -> std::result::Result<(), JsValue> + 'static,
{
    let raw: &JsValue = storage.as_raw().as_ref();
    let ts: Function = Reflect::get(raw, &"transactionSync".into())
        .map_err(|_| ls_err("transactionSync"))?
        .dyn_into()
        .map_err(|_| ls_err("transactionSync"))?;
    let mut f = Some(f);
    let cl = Closure::once(move || -> std::result::Result<JsValue, JsValue> {
        (f.take().unwrap())()?;
        Ok(JsValue::UNDEFINED)
    });
    ts.call1(raw, cl.as_ref().unchecked_ref())
        .map_err(|e| ls_err(format!("commit: {e:?}")))?;
    Ok(())
}

// ---------------------------------------------------------------- objects

/// R2 object store.
pub struct R2Objects {
    bucket: Bucket,
}

impl ObjectStore for R2Objects {
    async fn put(&self, key: &str, bytes: Vec<u8>) -> LsResult<()> {
        let ck = sha256(&bytes).0.to_vec();
        self.bucket
            .put(key, bytes)
            .sha256(ck)
            .execute()
            .await
            .map_err(ls_err)?;
        Ok(())
    }
    async fn put_new(&self, key: &str, bytes: Vec<u8>) -> LsResult<bool> {
        self.put_new_with_budget(key, bytes, &Budget::default())
            .await
    }
    async fn put_new_with_budget(
        &self,
        key: &str,
        bytes: Vec<u8>,
        budget: &Budget,
    ) -> LsResult<bool> {
        // `If-None-Match: *`: R2 returns null when an object already exists.
        // Final keys are written only after verification; record it.
        let v = Verified {
            kind: budget
                .wire::<mdbn_wire::envelope::Item>(&bytes)?
                .kind
                .value(),
            size: bytes.len() as u64,
            checksum: sha256(&bytes),
        };
        let r = self
            .bucket
            .put(key, bytes)
            .sha256(v.checksum.0.to_vec())
            .custom_metadata(verified_md(&v))
            .only_if(Conditional {
                etag_does_not_match: Some("*".into()),
                ..Default::default()
            })
            .execute()
            .await
            .map_err(ls_err)?;
        Ok(r.is_some())
    }
    async fn get(&self, key: &str, range: Option<(u64, u64)>) -> LsResult<Option<Vec<u8>>> {
        let mut g = self.bucket.get(key);
        if let Some((offset, length)) = range {
            g = g.range(Range::OffsetWithLength { offset, length });
        }
        let Some(o) = g.execute().await.map_err(ls_err)? else {
            return Ok(None);
        };
        let Some(b) = o.body() else { return Ok(None) };
        Ok(Some(b.bytes().await.map_err(ls_err)?))
    }
    async fn delete(&self, key: &str) -> LsResult<()> {
        self.bucket.delete(key).await.map_err(ls_err)
    }
    async fn verified_meta(&self, key: &str) -> LsResult<Option<Verified>> {
        let Some(o) = self.bucket.head(key).await.map_err(ls_err)? else {
            return Ok(None);
        };
        Ok(verified_from(&o.custom_metadata().map_err(ls_err)?))
    }
    async fn copy_new(&self, from: &str, to: &str) -> LsResult<bool> {
        // Streamed: R2 → R2 through the runtime, never buffered in wasm (D2 §2.4).
        let Some(o) = self.bucket.get(from).execute().await.map_err(ls_err)? else {
            return Err(ls_err("staged object vanished"));
        };
        let md = o.custom_metadata().map_err(ls_err)?;
        let v = verified_from(&md).ok_or_else(|| ls_err("staged object not verified"))?;
        let body = o.body().ok_or_else(|| ls_err("no body"))?;
        let ResponseBody::Stream(rs) = body.response_body().map_err(ls_err)? else {
            return Err(ls_err("no stream"));
        };
        let r = self
            .bucket
            .put(to, Data::ReadableStream(rs))
            .sha256(v.checksum.0.to_vec())
            .custom_metadata(md)
            .only_if(Conditional {
                etag_does_not_match: Some("*".into()),
                ..Default::default()
            })
            .execute()
            .await
            .map_err(ls_err)?;
        Ok(r.is_some())
    }
}

impl Archive for R2Objects {
    async fn put_segment(
        &self,
        collection: &Uuid,
        tier: RetentionTier,
        from: u64,
        to: u64,
        bytes: Vec<u8>,
    ) -> LsResult<()> {
        self.put(&archive_segment_key(collection, tier, from, to), bytes)
            .await
    }
    async fn archive_object(
        &self,
        collection: &Uuid,
        tier: RetentionTier,
        address: &B32,
    ) -> LsResult<()> {
        // R2 has no server-side copy in worker 0.8: stream R2 → R2 through the
        // runtime, never buffered in wasm (as `copy_new`). Overwrites on retry.
        let from = object_key(collection, address);
        let to = archive_object_key(collection, tier, address);
        let Some(o) = self.bucket.get(&from).execute().await.map_err(ls_err)? else {
            return Ok(());
        };
        let md = o.custom_metadata().map_err(ls_err)?;
        let body = o.body().ok_or_else(|| ls_err("no body"))?;
        let ResponseBody::Stream(rs) = body.response_body().map_err(ls_err)? else {
            return Err(ls_err("no stream"));
        };
        let mut put = self
            .bucket
            .put(&to, Data::ReadableStream(rs))
            .custom_metadata(md.clone());
        if let Some(v) = verified_from(&md) {
            put = put.sha256(v.checksum.0.to_vec());
        }
        put.execute().await.map_err(ls_err)?;
        Ok(())
    }
}

/// R2 custom metadata recording an upload-time verification.
fn verified_md(v: &Verified) -> std::collections::HashMap<String, String> {
    [
        ("mdbn-verified".to_string(), "1".to_string()),
        ("kind".to_string(), v.kind.to_string()),
        ("size".to_string(), v.size.to_string()),
        ("sha256".to_string(), v.checksum.to_hex()),
    ]
    .into_iter()
    .collect()
}

fn verified_from(md: &std::collections::HashMap<String, String>) -> Option<Verified> {
    if md.get("mdbn-verified").map(String::as_str) != Some("1") {
        return None;
    }
    Some(Verified {
        kind: md.get("kind")?.parse().ok()?,
        size: md.get("size")?.parse().ok()?,
        checksum: B32(unhex(md.get("sha256")?)?.try_into().ok()?),
    })
}

// ---------------------------------------------------------------- the object

#[derive(Serialize, Deserialize, Clone, Default)]
struct Attachment {
    id: u64,
    /// `None` before hello; `Some("")` for the control plane; else hex device ‖ hex key.
    principal: Option<String>,
    nonce: String,
    /// `Some(inline_bytes)` when subscribed.
    sub: Option<u64>,
}

fn principal_to(p: &Option<Principal>) -> Option<String> {
    p.map(|p| match p {
        Principal::ControlPlane => String::new(),
        Principal::Device {
            id,
            sign_pk,
            collection,
        } => format!(
            "{}{}{}",
            id.to_hex(),
            sign_pk.to_hex(),
            collection.map(|c| c.to_hex()).unwrap_or_default()
        ),
    })
}
fn principal_from(s: &Option<String>) -> Option<Principal> {
    let s = s.as_ref()?;
    if s.is_empty() {
        return Some(Principal::ControlPlane);
    }
    Some(Principal::Device {
        id: B16(unhex(&s[..32])?.try_into().ok()?),
        sign_pk: B32(unhex(&s[32..96])?.try_into().ok()?),
        collection: match s.get(96..) {
            Some(c) if !c.is_empty() => Some(B16(unhex(c)?.try_into().ok()?)),
            _ => None,
        },
    })
}

struct Host {
    metrics: metrics::Metrics,
    hub: RefCell<Option<Hub>>,
    sockets: RefCell<BTreeMap<u64, WebSocket>>,
    sessions: RefCell<BTreeMap<u64, (Session, Option<u64>)>>,
    state: State,
}

impl Host {
    /// Rebuild sessions and subscriptions from socket attachments (after hibernation).
    fn restore(&self, c: Uuid) {
        if self.hub.borrow().is_some() {
            return;
        }
        let mut hub = Hub::new(c);
        let mut socks = self.sockets.borrow_mut();
        let mut sess = self.sessions.borrow_mut();
        for ws in self.state.get_websockets() {
            if let Ok(Some(a)) = ws.deserialize_attachment::<Attachment>() {
                let p = principal_from(&a.principal);
                let mut s = Session::new(
                    a.id,
                    unhex(&a.nonce)
                        .and_then(|v| v.try_into().ok())
                        .unwrap_or([0; 32]),
                );
                s.principal = p;
                if let Some(inline) = a.sub {
                    let dev = match p {
                        Some(Principal::Device { id, .. }) => Some(id),
                        _ => None,
                    };
                    hub.subscribe(a.id, dev, Some(inline));
                    s.collections.insert(c);
                }
                socks.insert(a.id, ws);
                sess.insert(a.id, (s, a.sub));
            }
        }
        *self.hub.borrow_mut() = Some(hub);
    }
}

impl HubHost for Host {
    fn repair_append(&self, r: &mdbn_log_service::service::RepairAppend) {
        self.metrics
            .event("repair", "append", "ok", "actor", 0, r.foreign_items);
        // Structured log for ops (Workers Logs): a lost tail is an I1 violation
        // even when devices repair it.
        console_log!(
            "{{\"event\":\"service_lost_tail\",\"outcome\":\"repaired\",\"from\":{},\"to\":{},\"items\":{}}}",
            r.first,
            r.last,
            r.foreign_items
        );
    }
    fn with_hub<R>(&self, c: &Uuid, f: impl FnOnce(&mut Hub) -> R) -> R {
        let mut h = self.hub.borrow_mut();
        f(h.get_or_insert_with(|| Hub::new(*c)))
    }
    fn deliver(&self, pushes: Vec<Push>) {
        let socks = self.sockets.borrow();
        for p in pushes {
            if let Some(ws) = socks.get(&p.to) {
                let f = LsFrame::Push(p.push).to_bytes().unwrap_or_default();
                let outcome = if ws.send_with_bytes(f).is_ok() {
                    "ok"
                } else {
                    "dropped"
                };
                self.metrics.event("push", "other", outcome, "ws", 0, 1);
            }
        }
    }
    fn committed(&self, n: &CommitNotice, items: &[(u64, Vec<u8>)]) {
        self.metrics.event("commit", "append", "ok", "actor", 0, 1);
        let pushes = self.with_hub(&n.collection, |h| h.on_commit(n, items));
        self.deliver(pushes);
    }
}

/// One collection's log service actor.
#[durable_object]
pub struct LogCollection {
    svc: Service<DoBackend, R2Objects>,
    heavy: async_lock::Mutex<()>,
    host: Host,
    _env: Env,
}

impl LogCollection {
    fn collection_from(req: &Request) -> Option<Uuid> {
        let url = req.url().ok()?;
        let c = url.query_pairs().find(|(k, _)| k == "c")?.1.to_string();
        parse_uuid(&c)
    }

    fn on_close(&self, ws: &WebSocket) {
        if let Ok(Some(att)) = ws.deserialize_attachment::<Attachment>() {
            let s = self.host.sessions.borrow_mut().remove(&att.id);
            if let Some((s, _)) = s {
                session::close(&self.host, &s);
            }
            self.host.sockets.borrow_mut().remove(&att.id);
        }
    }

    fn save_attachment(&self, ws: &WebSocket, s: &Session, sub: Option<u64>) {
        let _ = ws.serialize_attachment(Attachment {
            id: s.id,
            principal: principal_to(&s.principal),
            nonce: hex(&s.nonce),
            sub,
        });
    }
}

impl DurableObject for LogCollection {
    fn new(state: State, env: Env) -> Self {
        let sql = state.storage().sql();
        for q in SCHEMA
            .iter()
            .chain(backup::SCHEMA)
            .chain(registry_backup::SCHEMA)
            .chain(restore_aux::SCHEMA)
            .chain(deletion_registry::SCHEMA)
            .chain(destination_denial::SCHEMA)
            .chain(collection_closing::SCHEMA)
        {
            sql.exec(q, None).expect("schema");
        }
        let backend = DoBackend {
            sql,
            storage: state.storage(),
            lock: Rc::new(async_lock::Mutex::new(())),
            ns: env.durable_object("LOG").expect("LOG binding"),
            is_registry: std::cell::Cell::new(false),
        };
        backend
            .is_registry
            .set(backend.route().expect("actor route") == Some(REGISTRY));
        let objects = R2Objects {
            bucket: env.bucket("OBJECTS").expect("OBJECTS binding"),
        };
        let svc = Service::new(backend, objects, config(&env));
        LogCollection {
            svc,
            heavy: async_lock::Mutex::new(()),
            host: Host {
                metrics: metrics::Metrics::new(&env),
                hub: RefCell::new(None),
                sockets: RefCell::new(BTreeMap::new()),
                sessions: RefCell::new(BTreeMap::new()),
                state,
            },
            _env: env,
        }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        let Some(c) = Self::collection_from(&req) else {
            return Response::error("missing ?c=<collection>", 400);
        };
        self.svc
            .backend
            .record_route(&c)
            .map_err(|e| Error::RustError(e.to_string()))?;
        if c == REGISTRY {
            self.svc.backend.is_registry.set(true);
            let path = req.path();
            if path == "/registry/collection-deletion" {
                let target = req
                    .url()?
                    .query_pairs()
                    .find(|(k, _)| k == "target")
                    .and_then(|(_, v)| parse_uuid(&v));
                let Some(target) = target.filter(|id| *id != REGISTRY) else {
                    return Response::error("collection", 400);
                };
                let bytes = self
                    .svc
                    .backend
                    .deletion_floor_response(&target)
                    .map_err(|e| Error::RustError(e.to_string()))?;
                return Response::from_bytes(bytes);
            }
            if let Some(op) = path.strip_prefix("/registry/") {
                let url = req.url()?;
                let d = url
                    .query_pairs()
                    .find(|(k, _)| k == "d")
                    .and_then(|(_, v)| parse_uuid(&v));
                let Some(d) = d else {
                    return Response::error("device", 400);
                };
                let r = self
                    .svc
                    .backend
                    .registry_local(op, &d)
                    .map_err(|e| Error::RustError(e.to_string()))?;
                return Response::ok(if r { "1" } else { "0" });
            }
        }
        self.host.restore(c);
        let path = req.path();
        if path == "/ready" {
            if c != REGISTRY || self.svc.backend.exec("SELECT 1", vec![]).is_err() {
                return Response::error("not ready", 503);
            }
            return Response::ok("ready");
        }
        if path == "/v1/ws" {
            let pair = WebSocketPair::new()?;
            let nonce: [u8; 32] = random_bytes();
            // ≤ 2^53: attachments round-trip through JS numbers.
            let id = u64::from_le_bytes(random_bytes()) & ((1 << 52) - 1);
            self.host.state.accept_web_socket(&pair.server);
            let s = Session::new(id, nonce);
            self.save_attachment(&pair.server, &s, None);
            self.host.sockets.borrow_mut().insert(id, pair.server);
            self.host.sessions.borrow_mut().insert(id, (s, None));
            let mut resp = Response::from_websocket(pair.client)?;
            resp.headers_mut().set("x-mdbase-nonce", &hex(&nonce))?;
            return Ok(resp);
        }
        if path == "/v1/rpc" || path == destination_denial::PATH || path == collection_closing::PATH
        {
            let started = now_ms();
            let budget = match forwarded_budget(&req) {
                Ok(b) => b,
                Err(e) => {
                    ingress::cancel(&req);
                    return Response::error(e.to_string(), 400);
                }
            };
            if req.method() != Method::Post {
                ingress::cancel(&req);
                return Response::error("unauthenticated", 401);
            }
            let claims = match rpc_preflight(&req, &self.svc.config, &budget) {
                Ok(c) => c,
                Err(e) => {
                    ingress::cancel(&req);
                    return Response::error(
                        e.to_string(),
                        if e.code == mdbn_log_service::Code::Invalid {
                            400
                        } else {
                            401
                        },
                    );
                }
            };
            let body_cap = if path == destination_denial::PATH {
                destination_denial::BODY_CAP
            } else if path == collection_closing::PATH {
                collection_closing::BODY_CAP
            } else {
                ingress::RPC_CAP
            };
            let incoming = match ingress::read(&req, body_cap).await {
                Ok(body) => body,
                Err(ingress::Reject(status)) => return Response::error("body rejected", status),
            };
            let body = &incoming.bytes;
            if let Some(rejected) = cbor_preflight(body, &self._env, &budget)? {
                return Ok(rejected);
            }
            // Already preflighted/charged: decode once for metrics/proof/dispatch.
            let decoded = LsFrame::from_bytes(body);
            let method = match &decoded {
                Ok(LsFrame::Request(r)) => r.method.as_str(),
                _ => "other",
            };
            let h = req.headers();
            let get = |k: &str| h.get(k).ok().flatten().unwrap_or_default();
            let token = get("authorization")
                .trim_start_matches("Bearer ")
                .to_string();
            let r: LsResult<(u64, mdbn_wire::cbor::Cbor)> = async {
                let Ok(LsFrame::Request(rq)) = &decoded else {
                    return Err(ServiceError::invalid("shape"));
                };
                let p = verify_http_claims(
                    &token,
                    &get("x-mdbase-nonce"),
                    &get("x-mdbase-sig"),
                    &path,
                    &rq.method,
                    body,
                    &collection_from_params(&rq.params),
                    &claims,
                    &self.svc.config.url_secret,
                    // Verify authentication first; SQLite, not this temporary
                    // cache, owns single-use state across actor lifetimes.
                    &NonceCache::default(),
                    now_ms(),
                )?;
                let nonce: [u8; 32] = unhex(&get("x-mdbase-nonce"))
                    .and_then(|v| v.try_into().ok())
                    .expect("verify_http checked nonce shape");
                self.svc.backend.consume_http_nonce(&nonce, now_ms())?;
                if !destination_denial::transport_matches(&path, &rq.method)
                    || !collection_closing::transport_matches(&path, &rq.method)
                {
                    return Err(ServiceError::invalid(
                        "collection_destination_close_transport",
                    ));
                }
                if matches!(
                    rq.method.as_str(),
                    "backup_begin" | "backup_page" | "backup_finish" | "backup_abort"
                ) {
                    let result = self
                        .svc
                        .backend
                        .backup_call(&p, &rq.method, &rq.params, &budget)
                        .await?;
                    return Ok((rq.id, result));
                }
                if rq.method == destination_denial::METHOD {
                    let result = self.svc.backend.destination_close_call(&p, &rq.params)?;
                    return Ok((rq.id, result));
                }
                if rq.method == collection_closing::METHOD {
                    let result = self.svc.backend.begin_collection_closing(&p, &rq.params)?;
                    return Ok((rq.id, result));
                }
                if matches!(rq.method.as_str(), "restore_aux_begin" | "restore_aux_page") {
                    let result = self
                        .svc
                        .backend
                        .restore_aux_call(&p, &rq.method, &rq.params, &budget)
                        .await?;
                    return Ok((rq.id, result));
                }
                if matches!(
                    rq.method.as_str(),
                    "backup_registry_begin"
                        | "backup_registry_page"
                        | "backup_registry_finish"
                        | "backup_registry_abort"
                        | "backup_registry_merge"
                ) {
                    let result = self
                        .svc
                        .backend
                        .registry_backup_call(&p, &rq.method, &rq.params)
                        .await?;
                    return Ok((rq.id, result));
                }
                if matches!(
                    rq.method.as_str(),
                    "registry_record_collection_deletion"
                        | "registry_collection_deletions"
                        | "registry_collection_deletion"
                ) {
                    let result = self
                        .svc
                        .backend
                        .deletion_registry_call(&p, &rq.method, &rq.params)
                        .await?;
                    return Ok((rq.id, result));
                }
                let out = self
                    .svc
                    .call_with_budget(&p, &rq.method, &rq.params, now_ms(), &budget)
                    .await?;
                if let Some(n) = &out.notice {
                    self.host.committed(n, &out.items);
                }
                if let Some(r) = &out.repair {
                    self.host.repair_append(r);
                }
                Ok((rq.id, out.result))
            }
            .await;
            let outcome = r.as_ref().err().map_or("ok", |e| e.code.as_str());
            self.host
                .metrics
                .event("request", method, outcome, "http", now_ms() - started, 1);
            let frame = match r {
                Ok((id, v)) => LsResponse {
                    id,
                    result: Some(v),
                    error: None,
                },
                Err(e) => LsResponse {
                    id: 0,
                    result: None,
                    error: Some(e.to_wire()),
                },
            };
            let mut resp =
                Response::from_bytes(LsFrame::Response(frame).to_bytes().unwrap_or_default())?;
            resp.headers_mut()
                .set("content-type", "application/vnd.mdbase.v1+cbor")?;
            return Ok(resp);
        }
        if path.starts_with("/debug/lose_tail/") {
            let n: u64 = path
                .rsplit('/')
                .next()
                .and_then(|s| s.parse().ok())
                .unwrap_or(1);
            self.svc
                .backend
                .lose_tail(n, &self.svc.config.roots)
                .map_err(|e| Error::RustError(e.to_string()))?;
            return Response::ok("ok");
        }
        Response::error("not found", 404)
    }

    async fn websocket_message(
        &self,
        ws: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> Result<()> {
        let WebSocketIncomingMessage::Binary(bytes) = message else {
            return Ok(());
        };
        let started = now_ms();
        let budget = Budget::default();
        let decoded = budget.wire::<LsFrame>(&bytes);
        let method = match &decoded {
            Ok(LsFrame::Request(r)) => r.method.as_str(),
            _ => "other",
        };
        let att = match ws.deserialize_attachment::<Attachment>() {
            Ok(Some(a)) => a,
            other => {
                console_error!("websocket without a usable attachment: {:?}", other.err());
                let _ = ws.close(Some(1011), Some("session state lost"));
                return Ok(());
            }
        };
        let c = self.svc.backend.own();
        if let Some(c) = c {
            self.host.restore(c);
        }
        self.host
            .sockets
            .borrow_mut()
            .entry(att.id)
            .or_insert_with(|| ws.clone());
        let (mut s, sub_before) = self
            .host
            .sessions
            .borrow_mut()
            .remove(&att.id)
            .unwrap_or_else(|| {
                let mut s = Session::new(
                    att.id,
                    unhex(&att.nonce)
                        .and_then(|v| v.try_into().ok())
                        .unwrap_or([0; 32]),
                );
                s.principal = principal_from(&att.principal);
                (s, att.sub)
            });
        let before = (s.principal, s.nonce);
        // The object's isolate has 128 MB. Verifying a 9 MiB object holds several
        // copies of it, so object commits and puts run one at a time per actor.
        let heavy = matches!(
            &decoded,
            Ok(LsFrame::Request(r)) if r.method == "commit_object" || r.method == "put_object" || r.method == "get_object"
        );
        let _g = if heavy {
            Some(self.heavy.lock().await)
        } else {
            None
        };
        let resp = match &decoded {
            Ok(LsFrame::Request(r)) => {
                session::handle_request(
                    &self.svc,
                    &self.host,
                    &mut s,
                    r,
                    now_ms(),
                    random_bytes(),
                    &budget,
                )
                .await
            }
            _ => Some(
                LsFrame::Response(LsResponse {
                    id: 0,
                    result: None,
                    error: Some(
                        decoded
                            .as_ref()
                            .err()
                            .cloned()
                            .unwrap_or_else(|| ServiceError::invalid("shape"))
                            .to_wire(),
                    ),
                })
                .to_bytes()
                .unwrap_or_default(),
            ),
        };
        drop(_g);
        if let Some(r) = resp {
            let outcome = match mdbn_log_service::decode::wire::<LsFrame>(&r) {
                Ok(LsFrame::Response(r)) => r.error.map_or_else(|| "ok".to_string(), |e| e.code),
                _ => "invalid".into(),
            };
            self.host
                .metrics
                .event("request", method, &outcome, "ws", now_ms() - started, 1);
            ws.send_with_bytes(r)?;
        }
        // Persist what hibernation must survive: principal, nonce, subscription.
        let sub_now = self
            .host
            .hub
            .borrow()
            .as_ref()
            .and_then(|h| h.subscription(s.id));
        if before != (s.principal, s.nonce) || sub_now != sub_before {
            self.save_attachment(&ws, &s, sub_now);
        }
        self.host.sessions.borrow_mut().insert(s.id, (s, sub_now));
        Ok(())
    }

    async fn websocket_close(
        &self,
        ws: WebSocket,
        _code: usize,
        _reason: String,
        _clean: bool,
    ) -> Result<()> {
        self.on_close(&ws);
        Ok(())
    }

    async fn websocket_error(&self, ws: WebSocket, _error: Error) -> Result<()> {
        self.on_close(&ws);
        Ok(())
    }
}

// ---------------------------------------------------------------- the Worker

fn collection_of_rpc(r: &LsRequest) -> Option<Uuid> {
    match &r.params {
        mdbn_wire::cbor::Cbor::Map(m) => m
            .iter()
            .find(|(k, _)| *k == mdbn_wire::cbor::Cbor::Uint(0))
            .and_then(|(_, v)| Uuid::from_cbor(v).ok()),
        _ => None,
    }
}

async fn forward(env: &Env, c: &Uuid, req: Request) -> Result<Response> {
    let ns = env.durable_object("LOG")?;
    let stub = ns.get_by_name(&c.to_uuid_string())?;
    stub.fetch_with_request(req).await
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let url = req.url()?;
    let path = url.path().to_string();
    let cfg = config(&env);
    if path == "/health" {
        return Response::ok("ok");
    }
    if path == "/ready" {
        // Check bindings and storage without reading any collection/object data.
        // Analytics is required here: local tests explicitly bind its mock too.
        if env.analytics_engine("METRICS").is_err() {
            return Response::error("not ready", 503);
        }
        let request = Request::new(
            &format!("https://do/ready?c={}", REGISTRY.to_uuid_string()),
            Method::Get,
        )?;
        match forward(&env, &REGISTRY, request).await {
            Ok(response) if response.status_code() == 200 => {}
            _ => return Response::error("not ready", 503),
        }
        let Ok(bucket) = env.bucket("OBJECTS") else {
            return Response::error("not ready", 503);
        };
        if bucket.head("__logsvc_readiness_probe__").await.is_err() {
            return Response::error("not ready", 503);
        }
        return Response::ok("ready");
    }
    // Teardown of the throwaway evaluation bucket (DEBUG_HOOKS only).
    if path == "/debug/empty_bucket" && debug_hooks(&env) {
        let bucket = env.bucket("OBJECTS")?;
        let mut n = 0;
        loop {
            let page = bucket.list().limit(1000).execute().await?;
            let keys: Vec<String> = page.objects().iter().map(|o| o.key()).collect();
            if keys.is_empty() {
                break;
            }
            n += keys.len();
            bucket.delete_multiple(keys).await?;
        }
        return Response::ok(format!("deleted {n}"));
    }
    if path == "/debug/ingress_budget" && debug_hooks(&env) {
        return Response::ok(ingress::reserved().to_string());
    }
    if path == "/v1/nonce" {
        return Response::ok(hex(&http_nonce(&cfg.url_secret, now_ms(), random_bytes())));
    }
    if path == "/v1/ws" {
        let Some(c) = LogCollection::collection_from(&req) else {
            return Response::error("missing ?c=<collection>", 400);
        };
        return forward(&env, &c, req).await;
    }
    if path == "/v1/rpc" || path == destination_denial::PATH || path == collection_closing::PATH {
        let budget = Budget::default();
        if req.method() != Method::Post {
            ingress::cancel(&req);
            return Response::error("unauthenticated", 401);
        }
        if let Err(e) = rpc_preflight(&req, &cfg, &budget) {
            ingress::cancel(&req);
            return Response::error(
                e.to_string(),
                if e.code == mdbn_log_service::Code::Invalid {
                    400
                } else {
                    401
                },
            );
        }
        let body_cap = if path == destination_denial::PATH {
            destination_denial::BODY_CAP
        } else if path == collection_closing::PATH {
            collection_closing::BODY_CAP
        } else {
            ingress::RPC_CAP
        };
        let incoming = match ingress::read(&req, body_cap).await {
            Ok(body) => body,
            Err(ingress::Reject(status)) => return Response::error("body rejected", status),
        };
        let body = &incoming.bytes;
        if let Some(rejected) = cbor_preflight(body, &env, &budget)? {
            return Ok(rejected);
        }
        let Ok(LsFrame::Request(r)) = LsFrame::from_bytes(body) else {
            return Response::error("invalid frame", 400);
        };
        if !destination_denial::transport_matches(&path, &r.method)
            || !collection_closing::transport_matches(&path, &r.method)
        {
            return Response::error("collection_destination_close_transport", 400);
        }
        let admin_creds = r.method == "revoke_device_credentials";
        let Some(c) = (if admin_creds {
            Some(REGISTRY)
        } else {
            collection_of_rpc(&r)
        }) else {
            return Response::error("no collection in params", 400);
        };
        let headers = req.headers().clone();
        let used = budget.usage();
        headers.set("x-logsvc-decode-nodes", &(used.nodes as u64).to_string())?;
        headers.set(
            "x-logsvc-decode-work",
            &(used.work_bytes as u64).to_string(),
        )?;
        headers.set("x-logsvc-decode-depth", &(used.depth as u64).to_string())?;
        drop(r);
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_headers(headers)
            .with_body(Some(Uint8Array::from(body.as_slice()).into()));
        let fwd =
            Request::new_with_init(&format!("https://do{path}?c={}", c.to_uuid_string()), &init)?;
        let _forwarded = incoming.forwarded();
        return forward(&env, &c, fwd).await;
    }
    if let Some(rest) = path.strip_prefix("/debug/lose_tail/") {
        if !debug_hooks(&env) {
            return Response::error("not found", 404);
        }
        let mut parts = rest.split('/');
        let Some(c) = parts.next().and_then(parse_uuid) else {
            return Response::error("bad collection", 400);
        };
        let n = parts.next().unwrap_or("1");
        let fwd = Request::new(
            &format!("https://do/debug/lose_tail/{n}?c={}", c.to_uuid_string()),
            Method::Post,
        )?;
        return forward(&env, &c, fwd).await;
    }
    if let Some(rest) = path.strip_prefix("/v1/o/") {
        // Direct transfers: Worker ↔ R2, never through the collection's actor.
        let mut parts = rest.split('/');
        let (Some(c), Some(a)) = (parts.next(), parts.next()) else {
            return Response::error("bad path", 400);
        };
        if parts.next().is_some() {
            return Response::error("bad path", 400);
        }
        if !matches!(req.method(), Method::Get | Method::Put) {
            return Response::error("method", 405);
        }
        let q = url.query().unwrap_or("");
        let op = match verify_direct(&cfg.url_secret, c, a, q, now_ms()) {
            Ok(op) => op,
            Err(e) => return Response::error(e.to_string(), 403),
        };
        let bucket = env.bucket("OBJECTS")?;
        let key = object_key(&op.collection, &op.address);
        if req.method() == Method::Put {
            // Uploads land in the device's staging key; commit copies them
            // write-once to the final key.
            let Some(dev) = op.device else {
                return Response::error("op", 403);
            };
            let key = staging_key(&op.collection, &op.address, &dev);
            let Some((size, ck)) = op.expect else {
                return Response::error("op", 403);
            };
            if req
                .headers()
                .get("x-amz-checksum-sha256")?
                .unwrap_or_default()
                != base64(&ck.0)
            {
                return Response::error("checksum header", 400);
            }
            if size > mdbn_log_service::limits::MAX_OBJECT_BYTES {
                ingress::cancel(&req);
                return Response::error("body rejected", 413);
            }
            let budget = Budget::default();
            let incoming = match ingress::read(&req, size as usize).await {
                Ok(body) => body,
                Err(ingress::Reject(status)) => return Response::error("body rejected", status),
            };
            let body = &incoming.bytes;
            if let Some(rejected) = cbor_preflight(body, &env, &budget)? {
                return Ok(rejected);
            }
            if body.len() as u64 != size || sha256(body) != ck {
                return Response::error("checksum", 400);
            }
            // Verify here, while the Worker holds the body anyway; the actor's
            // commit then only checks this record and streams the copy (D2 §2.4).
            let v = match verify_upload_with_budget(&op.collection, &op.address, body, &budget) {
                Ok(v) => v,
                Err(e) => return Response::error(e.to_string(), 400),
            };
            // R2 verifies the SHA-256 again on write.
            bucket
                .put(key, body.clone())
                .sha256(ck.0.to_vec())
                .custom_metadata(verified_md(&v))
                .execute()
                .await?;
            return Response::ok("");
        }
        if op.put {
            return Response::error("op", 403);
        }
        let Some(meta) = bucket.head(&key).await? else {
            return Response::error("not found", 404);
        };
        let Some(verified) = verified_from(&meta.custom_metadata()?) else {
            return Response::error("object metadata", 502);
        };
        if verified.size != meta.size()
            || !matches!(verified.kind, 16..=18)
            || verified.size != op.sealed_size
            || verified.checksum != op.sealed_checksum
        {
            return Response::error("object metadata", 502);
        }
        let range = req.headers().get("range")?;
        let span = match DownloadSpan::resolve(range.as_deref(), meta.size()) {
            Ok(span) => span,
            Err(RangeRejection::ObjectSize) => return Response::error("object metadata", 502),
            Err(_) => {
                let mut resp = Response::error("range", 416)?;
                resp.headers_mut()
                    .set("content-range", &format!("bytes */{}", meta.size()))?;
                return Ok(resp);
            }
        };
        // HEAD and GET are separate storage awaits: condition the latter on the
        // observed immutable version, then check its returned metadata/span.
        let obj = native_r2::get(&bucket, &key, span, &meta.etag()).await?;
        if obj.is_null() || obj.is_undefined() {
            return Response::error("not found", 404);
        }
        let md = native_r2::field(&obj, "customMetadata")?;
        let same = md.is_object()
            && native_r2::field(&obj, "version")?.as_string() == Some(meta.version())
            && native_r2::field(&obj, "size")?.as_f64() == Some(span.total() as f64)
            && native_r2::field(&md, "mdbn-verified")?
                .as_string()
                .as_deref()
                == Some("1")
            && native_r2::field(&md, "kind")?.as_string() == Some(verified.kind.to_string())
            && native_r2::field(&md, "size")?.as_string() == Some(verified.size.to_string())
            && native_r2::field(&md, "sha256")?.as_string() == Some(verified.checksum.to_hex());
        if !same {
            native_r2::cancel(&obj).await?;
            return Response::error("object metadata", 502);
        }
        if span.partial() {
            let actual = native_r2::field(&obj, "range")?;
            if !actual.is_object()
                || native_r2::field(&actual, "offset")?.as_f64() != Some(span.offset() as f64)
                || native_r2::field(&actual, "length")?.as_f64() != Some(span.length() as f64)
                || {
                    let suffix = native_r2::field(&actual, "suffix")?;
                    !suffix.is_null() && !suffix.is_undefined()
                }
            {
                native_r2::cancel(&obj).await?;
                return Response::error("object range", 502);
            }
        }
        // Cap expiry is checked again after storage awaits, before emission.
        if verify_direct(&cfg.url_secret, c, a, q, now_ms()).is_err() {
            native_r2::cancel(&obj).await?;
            return Response::error("op", 403);
        }
        let body = native_r2::field(&obj, "body")?;
        if body.is_null() || body.is_undefined() {
            return Response::error("object changed", 409);
        }
        let mut resp = Response::from_body(ResponseBody::Stream(body.dyn_into()?))?
            .with_status(if span.partial() { 206 } else { 200 });
        let headers = resp.headers_mut();
        headers.set("content-type", "application/octet-stream")?;
        headers.set("content-length", &span.length().to_string())?;
        headers.set("accept-ranges", "bytes")?;
        headers.set("etag", &meta.http_etag())?;
        headers.set("x-amz-checksum-sha256", &base64(&verified.checksum.0))?;
        if let Some(content_range) = span.content_range() {
            headers.set("content-range", &content_range)?;
        }
        return Ok(resp);
    }
    Response::error("not found", 404)
}
