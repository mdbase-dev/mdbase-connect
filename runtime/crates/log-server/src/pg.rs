//! The Postgres backend (D2 candidate A, `log-service-api.md` §13).
//!
//! **Per-collection serialization, no global lock.** A write transaction starts with
//! `SELECT … FROM ls_collections WHERE id = $1 FOR UPDATE`: the row lock *is* the
//! collection's actor. Writers of different collections never touch the same row,
//! and nothing takes an advisory or table lock. The primary key on
//! `(collection, seq)` is the second guard for I1/I2.
//!
//! **Round trips.** Statements are pipelined on one connection (tokio-postgres sends
//! them back to back): `begin` is one round trip (BEGIN + lock + ACL), `commit` is
//! one (all writes + `pg_notify` + COMMIT). An append is 3–4 round trips in total.
//!
//! **Push.** Connections are routed to the gateway that owns the collection
//! (consistent hash on the collection ID, §13), so the committing gateway pushes
//! to its own subscribers after the commit; nothing global is touched.
//! `NotifyMode::InTransaction` instead issues `pg_notify` inside the append's
//! transaction for every gateway's `LISTEN`. **That mode takes a global lock:**
//! Postgres serializes the commits of all notifying transactions on one
//! notification-queue lock (observed as `Lock: object` waits on `COMMIT` under
//! load). It is kept only to measure that cost; the default is `Local`.

use std::collections::BTreeMap;

use crate::pool::{Object, Pool};
use futures_util::future::try_join_all;
use mdbn_log_service::backend::{Backend, Mode, Txn, Write};
use mdbn_log_service::error::{Result, ServiceError};
use mdbn_log_service::limits::TOKEN_RETENTION_MS;
use mdbn_log_service::model::{
    AclEntry, CollectionMeta, CollectionState, ObjectMeta, SnapshotRow, StoredItem,
};
use mdbn_wire::common::{B16, B32, Uuid};
use mdbn_wire::hash::{CHAIN_ZERO, chain_hash};
use tokio_postgres::Row;
use tokio_postgres::types::ToSql;

/// Versioned schema migrations, applied in order, each exactly once.
/// Append new entries; never edit an applied one.
pub const MIGRATIONS: &[(i32, &str, &str)] = &[
    (1, "initial log service schema", SCHEMA),
    (
        2,
        "service-wide credential revocation (§12)",
        "CREATE TABLE IF NOT EXISTS ls_revoked_devices (
           device bytea PRIMARY KEY,
           revoked_at bigint NOT NULL)",
    ),
];

/// Apply pending migrations in one transaction. Concurrent gateways starting at
/// once serialize on the migrations table's lock (startup only, never on the
/// request path).
pub async fn migrate(c: &mut tokio_postgres::Client) -> Result<Vec<i32>> {
    c.batch_execute(
        "CREATE TABLE IF NOT EXISTS ls_schema_migrations (
           version integer PRIMARY KEY,
           name text NOT NULL,
           applied_at timestamptz NOT NULL DEFAULT now())",
    )
    .await
    .map_err(db)?;
    let tx = c.transaction().await.map_err(db)?;
    tx.batch_execute("LOCK TABLE ls_schema_migrations IN EXCLUSIVE MODE")
        .await
        .map_err(db)?;
    let done: Vec<i32> = tx
        .query("SELECT version FROM ls_schema_migrations", &[])
        .await
        .map_err(db)?
        .iter()
        .map(|r| r.get(0))
        .collect();
    let mut applied = Vec::new();
    for (v, name, sql) in MIGRATIONS {
        if done.contains(v) {
            continue;
        }
        tx.batch_execute(sql).await.map_err(db)?;
        tx.execute(
            "INSERT INTO ls_schema_migrations (version, name) VALUES ($1, $2)",
            &[v, name],
        )
        .await
        .map_err(db)?;
        applied.push(*v);
    }
    if let Some(max) = done.iter().max()
        && *max > MIGRATIONS.last().map_or(0, |m| m.0)
    {
        return Err(ServiceError::backend(format!(
            "database schema version {max} is newer than this binary"
        )));
    }
    tx.commit().await.map_err(db)?;
    Ok(applied)
}

/// Migration 1. Idempotent.
pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS ls_collections (
  id bytea PRIMARY KEY,
  head bigint NOT NULL,
  head_chain bytea NOT NULL,
  meta bytea NOT NULL
);
CREATE TABLE IF NOT EXISTS ls_items (
  collection bytea NOT NULL,
  seq bigint NOT NULL,
  kind smallint NOT NULL,
  bytes bytea NOT NULL,
  appended_at bigint NOT NULL,
  PRIMARY KEY (collection, seq)
);
CREATE TABLE IF NOT EXISTS ls_tokens (
  collection bytea NOT NULL,
  token bytea NOT NULL,
  seq bigint NOT NULL,
  expires_at bigint NOT NULL,
  PRIMARY KEY (collection, token)
);
CREATE TABLE IF NOT EXISTS ls_acl (
  collection bytea NOT NULL,
  device bytea NOT NULL,
  account bytea NOT NULL,
  kind smallint NOT NULL,
  sign_pk bytea NOT NULL,
  active boolean NOT NULL,
  PRIMARY KEY (collection, device)
);
CREATE TABLE IF NOT EXISTS ls_snapshots (
  collection bytea NOT NULL,
  seq bigint NOT NULL,
  manifest bytea NOT NULL,
  author bytea NOT NULL,
  created_at bigint NOT NULL,
  endorsed boolean NOT NULL,
  PRIMARY KEY (collection, seq)
);
CREATE TABLE IF NOT EXISTS ls_objects (
  collection bytea NOT NULL,
  address bytea NOT NULL,
  kind smallint NOT NULL,
  size bigint NOT NULL,
  checksum bytea NOT NULL,
  committed boolean NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (collection, address)
);
-- holder_kind 0: item at seq = holder; 1: snapshot at seq = holder.
CREATE TABLE IF NOT EXISTS ls_object_refs (
  collection bytea NOT NULL,
  address bytea NOT NULL,
  holder_kind smallint NOT NULL,
  holder bigint NOT NULL,
  PRIMARY KEY (collection, address, holder_kind, holder)
);
CREATE INDEX IF NOT EXISTS ls_object_refs_holder ON ls_object_refs (collection, holder_kind, holder);
"#;

/// How commits reach subscribers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifyMode {
    /// The committing gateway pushes (connections routed by collection). Default.
    Local,
    /// `pg_notify` in the append transaction (global commit serialization).
    InTransaction,
}

/// TLS is used when the URL asks for it (`sslmode=require`/`verify-full`, the
/// default for anything but loopback). Plaintext is refused off loopback.
pub fn tls_required(cfg: &tokio_postgres::Config) -> Result<bool> {
    use tokio_postgres::config::{Host, SslMode};
    let loopback = cfg.get_hosts().iter().all(|h| match h {
        Host::Tcp(h) => h == "localhost" || h.starts_with("127.") || h == "::1",
        Host::Unix(_) => true,
    });
    match cfg.get_ssl_mode() {
        SslMode::Require => Ok(true),
        _ if !loopback => Err(ServiceError::backend(
            "postgres: TLS required off loopback (add sslmode=require)",
        )),
        _ => Ok(false),
    }
}

/// A TLS connector verifying the server certificate against the system roots.
///
/// A provider with a private CA is configured by adding that CA
/// (`LOGSVC_PG_CA_FILE`, PEM), never by loosening verification: certificate and
/// hostname checks always stay on.
pub fn tls_connector() -> Result<postgres_native_tls::MakeTlsConnector> {
    let mut b = native_tls::TlsConnector::builder();
    if let Ok(path) = std::env::var("LOGSVC_PG_CA_FILE") {
        let pem = std::fs::read(&path).map_err(|e| db(format!("{path}: {e}")))?;
        let ca = native_tls::Certificate::from_pem(&pem).map_err(db)?;
        b.add_root_certificate(ca);
    }
    let c = b.build().map_err(db)?;
    Ok(postgres_native_tls::MakeTlsConnector::new(c))
}

/// Notification channel.
pub const CHANNEL: &str = "ls_commits";

fn db(e: impl std::fmt::Display) -> ServiceError {
    ServiceError::backend(format!("postgres: {e}"))
}

/// Server-owned adapter to the actual independent native LOG nil producer.
/// Implementations MUST freshly authenticate/bind the producer namespace and
/// requested collection on every read. Unknown/unqualified absence is an error,
/// never None. CP SQL/log metadata/new empty PG tables are not this authority.
/// PG is a non-launch fallback: its factory remains unconfigured/Unavailable.
/// A real producer/configuration is post-launch and requires fresh qualification.
pub trait IndependentFloorReader: Send + Sync {
    /// Fresh authoritative lookup; no cached positive effect-time lease.
    fn read<'a>(
        &'a self,
        collection: Uuid,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<Option<mdbn_log_service::deletion::CollectionDeletionRecord>>,
                > + Send
                + 'a,
        >,
    >;
}

#[cfg(test)]
mod floor_tests;

/// Postgres backend over a connection pool.
pub struct PgBackend {
    pool: Pool,
    /// How commits reach subscribers.
    pub notify: NotifyMode,
    independent_floor_reader: Option<std::sync::Arc<dyn IndependentFloorReader>>,
}

impl PgBackend {
    /// Connect and migrate.
    pub async fn connect(url: &str, pool_size: usize) -> Result<Self> {
        let cfg: tokio_postgres::Config = url.parse().map_err(db)?;
        let pool = Pool::new(cfg, pool_size).map_err(db)?;
        let mut c = pool.get().await.map_err(db)?;
        migrate(&mut c).await?;
        Ok(PgBackend {
            pool,
            notify: NotifyMode::Local,
            independent_floor_reader: None,
        })
    }

    /// Configure only a trusted server-owned reader bound to the independent
    /// native nil producer. No caller/CPDB-derived authority or default reader.
    /// Deployment/profile approval is separate from constructing this seam.
    pub fn with_independent_floor_reader(
        mut self,
        reader: std::sync::Arc<dyn IndependentFloorReader>,
    ) -> Self {
        self.independent_floor_reader = Some(reader);
        self
    }

    /// The pool (tests and the listener).
    pub fn pool(&self) -> &Pool {
        &self.pool
    }

    /// Test hook: lose the last `n` items, as a failover to an asynchronous standby
    /// that had not received them would.
    pub async fn lose_tail(&self, c: &Uuid, n: u64, roots: &[B32]) -> Result<()> {
        let mut client = self.pool.get().await.map_err(db)?;
        let tx = client.transaction().await.map_err(db)?;
        let id = &c.0[..];
        let row = tx
            .query_one(
                "SELECT meta FROM ls_collections WHERE id = $1 FOR UPDATE",
                &[&id],
            )
            .await
            .map_err(db)?;
        let mut meta = CollectionMeta::decode(row.get(0))?;
        let cut = meta.head.saturating_sub(n) as i64;
        tx.execute(
            "DELETE FROM ls_items WHERE collection = $1 AND seq > $2",
            &[&id, &cut],
        )
        .await
        .map_err(db)?;
        tx.execute(
            "DELETE FROM ls_tokens WHERE collection = $1 AND seq > $2",
            &[&id, &cut],
        )
        .await
        .map_err(db)?;
        let last = tx
            .query_opt(
                "SELECT seq, bytes FROM ls_items WHERE collection = $1 ORDER BY seq DESC LIMIT 1",
                &[&id],
            )
            .await
            .map_err(db)?;
        let (head, chain) = last.map_or((0, CHAIN_ZERO), |r| {
            (r.get::<_, i64>(0) as u64, chain_hash(r.get::<_, &[u8]>(1)))
        });
        // A lagging standby also lacks the lost items' policy effects.
        let control: Vec<(u64, Vec<u8>)> = tx
            .query(
                "SELECT seq, bytes FROM ls_items WHERE collection = $1 AND kind <> 1 ORDER BY seq",
                &[&id],
            )
            .await
            .map_err(db)?
            .iter()
            .map(|r| (r.get::<_, i64>(0) as u64, r.get::<_, Vec<u8>>(1)))
            .collect();
        let st = mdbn_log_service::service::rebuild_state(&meta, &control, roots)?;
        meta = st.meta;
        tx.execute("DELETE FROM ls_acl WHERE collection = $1", &[&id])
            .await
            .map_err(db)?;
        for e in st.acl.values() {
            tx.execute(
                "INSERT INTO ls_acl (collection, device, account, kind, sign_pk, active) VALUES ($1, $2, $3, $4, $5, $6)",
                &[&id, &&e.device.0[..], &&e.account.0[..], &(e.kind as i16), &&e.sign_pk.0[..], &e.active],
            )
            .await
            .map_err(db)?;
        }
        meta.head = head;
        meta.head_chain = chain;
        tx.execute(
            "UPDATE ls_collections SET head = $2, head_chain = $3, meta = $4 WHERE id = $1",
            &[&id, &(head as i64), &&chain.0[..], &meta.encode()],
        )
        .await
        .map_err(db)?;
        tx.commit().await.map_err(db)
    }

    /// Items `(after, after + n]` (for push after a notification).
    pub async fn items_after(&self, c: &Uuid, after: u64, n: u64) -> Result<Vec<(u64, Vec<u8>)>> {
        let client = self.pool.get().await.map_err(db)?;
        let rows = client
            .query(
                "SELECT seq, bytes FROM ls_items WHERE collection = $1 AND seq > $2 ORDER BY seq LIMIT $3",
                &[&&c.0[..], &(after as i64), &(n as i64)],
            )
            .await
            .map_err(db)?;
        Ok(rows
            .iter()
            .map(|r| (r.get::<_, i64>(0) as u64, r.get::<_, Vec<u8>>(1)))
            .collect())
    }
}

/// A transaction on one collection.
pub struct PgTxn {
    notify: NotifyMode,
    independent_floor_reader: Option<std::sync::Arc<dyn IndependentFloorReader>>,
    client: Option<Object>,
    id: Vec<u8>,
    state: Option<CollectionState>,
    writes: Vec<Write>,
    done: bool,
}

impl Drop for PgTxn {
    fn drop(&mut self) {
        if !self.done
            && let Some(c) = self.client.take()
        {
            // Roll back before the connection goes back to the pool.
            tokio::spawn(async move {
                let _ = c.batch_execute("ROLLBACK").await;
            });
        }
    }
}

fn b16(r: &Row, i: usize) -> B16 {
    B16(r.get::<_, &[u8]>(i).try_into().expect("16 bytes"))
}
fn b32(r: &Row, i: usize) -> B32 {
    B32(r.get::<_, &[u8]>(i).try_into().expect("32 bytes"))
}

fn publishes(writes: &[Write]) -> bool {
    writes.iter().any(|write| match write {
        Write::CreateCollection(_) => true,
        Write::PutMeta(meta) => meta.status != mdbn_log_service::model::Status::Gone,
        Write::UpsertAcl(acl) => acl.active,
        Write::InsertItem(_)
        | Write::PutObject(_)
        | Write::InsertSnapshot(_)
        | Write::EndorseSnapshot(_) => true,
        Write::Notify(notice) => !notice.gone,
        Write::DeleteObject(_) | Write::DeleteSnapshot(_) | Write::DeleteEntriesThrough(_) => false,
    })
}

async fn read_floor(
    reader: &Option<std::sync::Arc<dyn IndependentFloorReader>>,
    collection: Uuid,
) -> Result<Option<mdbn_log_service::deletion::CollectionDeletionRecord>> {
    use mdbn_log_service::deletion::CollectionDeletionRecord;
    if collection == B16([0; 16]) {
        return Err(CollectionDeletionRecord::unavailable());
    }
    let reader = reader
        .as_ref()
        .ok_or_else(CollectionDeletionRecord::unavailable)?;
    let floor = reader.read(collection).await?;
    if let Some(record) = floor {
        record.validate()?;
        if record.collection != collection {
            return Err(CollectionDeletionRecord::unavailable());
        }
    }
    Ok(floor)
}

impl Backend for PgBackend {
    type Txn<'a> = PgTxn;

    async fn collection_deletion_floor(
        &self,
        collection: &Uuid,
    ) -> Result<Option<mdbn_log_service::deletion::CollectionDeletionRecord>> {
        read_floor(&self.independent_floor_reader, *collection).await
    }

    async fn credentials_revoked(&self, device: &Uuid) -> Result<bool> {
        let c = self.pool.get().await.map_err(db)?;
        let st = c
            .prepare_cached("SELECT 1 FROM ls_revoked_devices WHERE device = $1")
            .await
            .map_err(db)?;
        Ok(c.query_opt(&st, &[&&device.0[..]])
            .await
            .map_err(db)?
            .is_some())
    }

    async fn revoke_credentials(&self, device: &Uuid, now: i64) -> Result<()> {
        let c = self.pool.get().await.map_err(db)?;
        c.execute(
            "INSERT INTO ls_revoked_devices (device, revoked_at) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            &[&&device.0[..], &now],
        )
        .await
        .map_err(db)?;
        Ok(())
    }

    async fn begin(&self, c: &Uuid, mode: Mode) -> Result<PgTxn> {
        self.begin_with_budget(c, mode, &mdbn_log_service::decode::Budget::default())
            .await
    }

    async fn begin_with_budget(
        &self,
        c: &Uuid,
        mode: Mode,
        budget: &mdbn_log_service::decode::Budget,
    ) -> Result<PgTxn> {
        let mut transaction = PgTxn {
            notify: self.notify,
            independent_floor_reader: self.independent_floor_reader.clone(),
            client: Some(self.pool.get().await.map_err(db)?),
            id: c.0.to_vec(),
            state: None,
            writes: Vec::new(),
            done: false,
        };
        // Own the connection through rollback from BEFORE BEGIN. Budget/schema
        // rejection while decoding projection state must not return an open
        // transaction to the pool (nor may cancellation of the begin future).
        let client = transaction.c();
        let (begin, lock) = match mode {
            Mode::Write => (
                "BEGIN",
                "SELECT meta FROM ls_collections WHERE id = $1 FOR UPDATE",
            ),
            Mode::Read => (
                "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
                "SELECT meta FROM ls_collections WHERE id = $1",
            ),
        };
        let lock_st = client.prepare_cached(lock).await.map_err(db)?;
        let acl_st = client
            .prepare_cached(
                "SELECT device, account, kind, sign_pk, active FROM ls_acl WHERE collection = $1",
            )
            .await
            .map_err(db)?;
        let idr: [&(dyn ToSql + Sync); 1] = [&transaction.id];
        // Pipelined: one round trip.
        let (_, meta, acl) = tokio::try_join!(
            client.batch_execute(begin),
            client.query_opt(&lock_st, &idr),
            client.query(&acl_st, &idr),
        )
        .map_err(db)?;
        let state = match meta {
            None => None,
            Some(row) => {
                let meta = CollectionMeta::decode_with_budget(row.get(0), budget)?;
                let mut map = BTreeMap::new();
                for r in &acl {
                    let e = AclEntry {
                        device: b16(r, 0),
                        account: b16(r, 1),
                        kind: r.get::<_, i16>(2) as u64,
                        sign_pk: b32(r, 3),
                        active: r.get(4),
                    };
                    map.insert(e.device, e);
                }
                Some(CollectionState { meta, acl: map })
            }
        };
        transaction.state = state;
        Ok(transaction)
    }
}

impl PgTxn {
    fn c(&self) -> &Object {
        self.client.as_ref().expect("live transaction")
    }
}

impl Txn for PgTxn {
    async fn load(&mut self) -> Result<Option<CollectionState>> {
        Ok(self.state.clone())
    }

    async fn items(
        &mut self,
        after: u64,
        limit: u64,
        max_bytes: u64,
        control_only: bool,
    ) -> Result<Vec<StoredItem>> {
        let sql = if control_only {
            "SELECT seq, kind, bytes, appended_at FROM (
               SELECT seq, kind, bytes, appended_at,
                      sum(octet_length(bytes)) OVER (ORDER BY seq) AS run
               FROM ls_items WHERE collection = $1 AND seq > $2 AND kind <> 1
               ORDER BY seq LIMIT $3) t
             WHERE run <= $4 OR run = octet_length(bytes) ORDER BY seq"
        } else {
            "SELECT seq, kind, bytes, appended_at FROM (
               SELECT seq, kind, bytes, appended_at,
                      sum(octet_length(bytes)) OVER (ORDER BY seq) AS run
               FROM ls_items WHERE collection = $1 AND seq > $2
               ORDER BY seq LIMIT $3) t
             WHERE run <= $4 OR run = octet_length(bytes) ORDER BY seq"
        };
        let st = self.c().prepare_cached(sql).await.map_err(db)?;
        let max = max_bytes.min(i64::MAX as u64) as i64;
        let rows = self
            .c()
            .query(
                &st,
                &[
                    &self.id,
                    &(after as i64),
                    &(limit.min(i64::MAX as u64) as i64),
                    &max,
                ],
            )
            .await
            .map_err(db)?;
        Ok(rows
            .iter()
            .map(|r| StoredItem {
                seq: r.get::<_, i64>(0) as u64,
                kind: r.get::<_, i16>(1) as u64,
                bytes: r.get(2),
                appended_at: r.get(3),
                token: None,
                refs: vec![],
            })
            .collect())
    }

    async fn tokens(&mut self, tokens: &[B16], now: i64) -> Result<Vec<Option<u64>>> {
        let st = self
            .c()
            .prepare_cached(
                "SELECT token, seq FROM ls_tokens WHERE collection = $1 AND token = ANY($2) AND expires_at > $3",
            )
            .await
            .map_err(db)?;
        let ts: Vec<&[u8]> = tokens.iter().map(|t| &t.0[..]).collect();
        let rows = self
            .c()
            .query(&st, &[&self.id, &ts, &now])
            .await
            .map_err(db)?;
        let found: BTreeMap<B16, u64> = rows
            .iter()
            .map(|r| (b16(r, 0), r.get::<_, i64>(1) as u64))
            .collect();
        Ok(tokens.iter().map(|t| found.get(t).copied()).collect())
    }

    async fn objects(&mut self, addresses: &[B32]) -> Result<Vec<Option<ObjectMeta>>> {
        let st = self
            .c()
            .prepare_cached(
                "SELECT address, kind, size, checksum, committed, created_at FROM ls_objects
                 WHERE collection = $1 AND address = ANY($2)",
            )
            .await
            .map_err(db)?;
        let ad: Vec<&[u8]> = addresses.iter().map(|a| &a.0[..]).collect();
        let rows = self.c().query(&st, &[&self.id, &ad]).await.map_err(db)?;
        let found: BTreeMap<B32, ObjectMeta> = rows
            .iter()
            .map(|r| {
                let o = ObjectMeta {
                    address: b32(r, 0),
                    kind: r.get::<_, i16>(1) as u64,
                    size: r.get::<_, i64>(2) as u64,
                    checksum: b32(r, 3),
                    committed: r.get(4),
                    created_at: r.get(5),
                };
                (o.address, o)
            })
            .collect();
        Ok(addresses.iter().map(|a| found.get(a).cloned()).collect())
    }

    async fn snapshots(&mut self) -> Result<Vec<SnapshotRow>> {
        let rows = self
            .c()
            .query(
                "SELECT seq, manifest, author, created_at, endorsed FROM ls_snapshots
                 WHERE collection = $1 ORDER BY seq DESC",
                &[&self.id],
            )
            .await
            .map_err(db)?;
        Ok(rows
            .iter()
            .map(|r| SnapshotRow {
                seq: r.get::<_, i64>(0) as u64,
                manifest: b32(r, 1),
                author: b16(r, 2),
                created_at: r.get(3),
                endorsed: r.get(4),
                refs: vec![],
            })
            .collect())
    }

    async fn last_seq_at_or_before(&mut self, t: i64) -> Result<u64> {
        let r = self
            .c()
            .query_one(
                "SELECT coalesce(max(seq), 0) FROM ls_items WHERE collection = $1 AND appended_at <= $2",
                &[&self.id, &t],
            )
            .await
            .map_err(db)?;
        Ok(r.get::<_, i64>(0) as u64)
    }

    async fn entry_bytes_through(&mut self, c: u64) -> Result<u64> {
        let r = self
            .c()
            .query_one(
                "SELECT coalesce(sum(octet_length(bytes)), 0)::bigint FROM ls_items
                 WHERE collection = $1 AND seq <= $2 AND kind = 1",
                &[&self.id, &(c as i64)],
            )
            .await
            .map_err(db)?;
        Ok(r.get::<_, i64>(0) as u64)
    }

    async fn gc_candidates(&mut self, before: i64, limit: u64) -> Result<Vec<ObjectMeta>> {
        let rows = self
            .c()
            .query(
                "SELECT o.address, o.kind, o.size, o.checksum, o.committed, o.created_at
                 FROM ls_objects o
                 WHERE o.collection = $1 AND o.created_at < $2
                   AND NOT EXISTS (SELECT 1 FROM ls_object_refs r
                                   WHERE r.collection = o.collection AND r.address = o.address)
                 LIMIT $3",
                &[&self.id, &before, &(limit as i64)],
            )
            .await
            .map_err(db)?;
        Ok(rows
            .iter()
            .map(|r| ObjectMeta {
                address: b32(r, 0),
                kind: r.get::<_, i16>(1) as u64,
                size: r.get::<_, i64>(2) as u64,
                checksum: b32(r, 3),
                committed: r.get(4),
                created_at: r.get(5),
            })
            .collect())
    }

    async fn snapshot_refs(&mut self, seq: u64) -> Result<Vec<B32>> {
        let rows = self
            .c()
            .query(
                "SELECT address FROM ls_object_refs
                 WHERE collection = $1 AND holder_kind = 1 AND holder = $2 ORDER BY address",
                &[&self.id, &(seq as i64)],
            )
            .await
            .map_err(db)?;
        Ok(rows.iter().map(|r| b32(r, 0)).collect())
    }

    async fn list_objects(&mut self, after: Option<B32>, limit: u64) -> Result<Vec<ObjectMeta>> {
        let after = after.map_or(Vec::new(), |a| a.0.to_vec());
        let rows = self
            .c()
            .query(
                "SELECT address, kind, size, checksum, committed, created_at FROM ls_objects
                 WHERE collection = $1 AND committed AND address > $2
                 ORDER BY address LIMIT $3",
                &[&self.id, &after, &(limit as i64)],
            )
            .await
            .map_err(db)?;
        Ok(rows
            .iter()
            .map(|r| ObjectMeta {
                address: b32(r, 0),
                kind: r.get::<_, i16>(1) as u64,
                size: r.get::<_, i64>(2) as u64,
                checksum: b32(r, 3),
                committed: r.get(4),
                created_at: r.get(5),
            })
            .collect())
    }

    fn write(&mut self, w: Write) {
        self.writes.push(w);
    }

    async fn commit(mut self) -> Result<()> {
        if publishes(&self.writes) {
            let collection = B16(self.id.as_slice().try_into().map_err(|_| {
                mdbn_log_service::deletion::CollectionDeletionRecord::unavailable()
            })?);
            if let Some(record) = read_floor(&self.independent_floor_reader, collection).await? {
                let mut error =
                    ServiceError::reason(mdbn_log_service::Code::Gone, "collection_deletion_floor");
                error.details = Some(record.to_cbor());
                return Err(error);
            }
        }
        // Unknown PG authority refuses before any buffered SQL write. Rollback
        // ownership stays with Drop when the guard returns early.
        let client = self.client.take().expect("live transaction");
        let id = std::mem::take(&mut self.id);
        let writes = std::mem::take(&mut self.writes);
        self.done = true;
        let writes = if self.notify == NotifyMode::InTransaction {
            writes
        } else {
            writes
                .into_iter()
                .filter(|w| !matches!(w, Write::Notify(_)))
                .collect()
        };
        let r = commit_writes(&client, &id, writes).await;
        if r.is_err() {
            let _ = client.batch_execute("ROLLBACK").await;
        }
        r
    }
}

type Param = Box<dyn ToSql + Sync + Send>;

async fn commit_writes(client: &Object, id: &[u8], writes: Vec<Write>) -> Result<()> {
    let mut stmts: Vec<(&'static str, Vec<Param>)> = Vec::new();
    let idp = || -> Param { Box::new(id.to_vec()) };
    // Items, tokens and item refs are batched into one statement each.
    let (mut seqs, mut kinds, mut bytes, mut ats) = (vec![], vec![], vec![], vec![]);
    let (mut tok, mut tok_seq, mut tok_exp) = (vec![], vec![], vec![]);
    let (mut ref_addr, mut ref_kind, mut ref_holder) = (vec![], vec![], vec![]);
    let mut tail: Vec<(&'static str, Vec<Param>)> = Vec::new();
    for w in writes {
        match w {
            Write::CreateCollection(s) => {
                stmts.push((
                    "INSERT INTO ls_collections (id, head, head_chain, meta) VALUES ($1, $2, $3, $4)",
                    vec![
                        idp(),
                        Box::new(s.meta.head as i64),
                        Box::new(s.meta.head_chain.0.to_vec()),
                        Box::new(s.meta.encode()),
                    ],
                ));
                for e in s.acl.values() {
                    stmts.push(acl_upsert(id, e));
                }
            }
            Write::PutMeta(m) => tail.push((
                "UPDATE ls_collections SET head = $2, head_chain = $3, meta = $4 WHERE id = $1",
                vec![
                    idp(),
                    Box::new(m.head as i64),
                    Box::new(m.head_chain.0.to_vec()),
                    Box::new(m.encode()),
                ],
            )),
            Write::UpsertAcl(e) => stmts.push(acl_upsert(id, &e)),
            Write::InsertItem(i) => {
                if let Some(t) = i.token {
                    tok.push(t.0.to_vec());
                    tok_seq.push(i.seq as i64);
                    tok_exp.push(i.appended_at + TOKEN_RETENTION_MS);
                }
                for a in &i.refs {
                    ref_addr.push(a.0.to_vec());
                    ref_kind.push(0i16);
                    ref_holder.push(i.seq as i64);
                }
                seqs.push(i.seq as i64);
                kinds.push(i.kind as i16);
                bytes.push(i.bytes);
                ats.push(i.appended_at);
            }
            Write::PutObject(o) => stmts.push((
                "INSERT INTO ls_objects (collection, address, kind, size, checksum, committed, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (collection, address) DO UPDATE
                   SET committed = EXCLUDED.committed, created_at = EXCLUDED.created_at
                   WHERE NOT ls_objects.committed",
                vec![
                    idp(),
                    Box::new(o.address.0.to_vec()),
                    Box::new(o.kind as i16),
                    Box::new(o.size as i64),
                    Box::new(o.checksum.0.to_vec()),
                    Box::new(o.committed),
                    Box::new(o.created_at),
                ],
            )),
            Write::DeleteObject(a) => stmts.push((
                "DELETE FROM ls_objects WHERE collection = $1 AND address = $2",
                vec![idp(), Box::new(a.0.to_vec())],
            )),
            Write::InsertSnapshot(s) => {
                stmts.push((
                    "INSERT INTO ls_snapshots (collection, seq, manifest, author, created_at, endorsed)
                     VALUES ($1, $2, $3, $4, $5, $6)",
                    vec![
                        idp(),
                        Box::new(s.seq as i64),
                        Box::new(s.manifest.0.to_vec()),
                        Box::new(s.author.0.to_vec()),
                        Box::new(s.created_at),
                        Box::new(s.endorsed),
                    ],
                ));
                for a in &s.refs {
                    ref_addr.push(a.0.to_vec());
                    ref_kind.push(1);
                    ref_holder.push(s.seq as i64);
                }
            }
            Write::EndorseSnapshot(seq) => stmts.push((
                "UPDATE ls_snapshots SET endorsed = true WHERE collection = $1 AND seq = $2",
                vec![idp(), Box::new(seq as i64)],
            )),
            Write::DeleteSnapshot(seq) => {
                stmts.push((
                    "DELETE FROM ls_snapshots WHERE collection = $1 AND seq = $2",
                    vec![idp(), Box::new(seq as i64)],
                ));
                stmts.push((
                    "DELETE FROM ls_object_refs WHERE collection = $1 AND holder_kind = 1 AND holder = $2",
                    vec![idp(), Box::new(seq as i64)],
                ));
            }
            Write::DeleteEntriesThrough(c) => {
                stmts.push((
                    "DELETE FROM ls_object_refs r USING ls_items i
                     WHERE r.collection = $1 AND r.holder_kind = 0 AND r.holder <= $2
                       AND i.collection = r.collection AND i.seq = r.holder AND i.kind = 1",
                    vec![idp(), Box::new(c as i64)],
                ));
                stmts.push((
                    "DELETE FROM ls_items WHERE collection = $1 AND seq <= $2 AND kind = 1",
                    vec![idp(), Box::new(c as i64)],
                ));
            }
            Write::Notify(n) => tail.push((
                "SELECT pg_notify('ls_commits', $1)",
                vec![Box::new(n.to_text())],
            )),
        }
    }
    if !seqs.is_empty() {
        stmts.push((
            "INSERT INTO ls_items (collection, seq, kind, bytes, appended_at)
             SELECT $1, * FROM unnest($2::bigint[], $3::smallint[], $4::bytea[], $5::bigint[])",
            vec![
                idp(),
                Box::new(seqs),
                Box::new(kinds),
                Box::new(bytes),
                Box::new(ats),
            ],
        ));
    }
    if !tok.is_empty() {
        stmts.push((
            "INSERT INTO ls_tokens (collection, token, seq, expires_at)
             SELECT $1, * FROM unnest($2::bytea[], $3::bigint[], $4::bigint[])
             ON CONFLICT (collection, token) DO UPDATE SET seq = EXCLUDED.seq, expires_at = EXCLUDED.expires_at",
            vec![idp(), Box::new(tok), Box::new(tok_seq), Box::new(tok_exp)],
        ));
    }
    if !ref_addr.is_empty() {
        stmts.push((
            "INSERT INTO ls_object_refs (collection, address, holder_kind, holder)
             SELECT $1, * FROM unnest($2::bytea[], $3::smallint[], $4::bigint[])
             ON CONFLICT DO NOTHING",
            vec![
                idp(),
                Box::new(ref_addr),
                Box::new(ref_kind),
                Box::new(ref_holder),
            ],
        ));
    }
    stmts.extend(tail);
    let mut prepared = Vec::with_capacity(stmts.len());
    for (sql, _) in &stmts {
        prepared.push(client.prepare_cached(sql).await.map_err(db)?);
    }
    // Pipelined: every write, then COMMIT, in one round trip. A failed write aborts
    // the transaction; its error is reported by try_join_all before COMMIT's result
    // is trusted.
    let writes = try_join_all(stmts.iter().zip(&prepared).map(|((_, params), st)| {
        let p: Vec<&(dyn ToSql + Sync)> =
            params.iter().map(|b| &**b as &(dyn ToSql + Sync)).collect();
        async move { client.execute(st, &p).await }
    }));
    let (w, c) = tokio::join!(writes, client.batch_execute("COMMIT"));
    w.map_err(db)?;
    c.map_err(db)?;
    Ok(())
}

fn acl_upsert(id: &[u8], e: &AclEntry) -> (&'static str, Vec<Param>) {
    (
        "INSERT INTO ls_acl (collection, device, account, kind, sign_pk, active)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (collection, device) DO UPDATE
           SET account = EXCLUDED.account, kind = EXCLUDED.kind,
               sign_pk = EXCLUDED.sign_pk, active = EXCLUDED.active",
        vec![
            Box::new(id.to_vec()),
            Box::new(e.device.0.to_vec()),
            Box::new(e.account.0.to_vec()),
            Box::new(e.kind as i16),
            Box::new(e.sign_pk.0.to_vec()),
            Box::new(e.active),
        ],
    )
}
