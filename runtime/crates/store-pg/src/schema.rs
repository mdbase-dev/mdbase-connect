//! The Postgres schema of the replica store.
//!
//! **Many collections share one set of tables.** Every row carries `c`, a compact
//! surrogate key for the collection (`rs_collections.k`), and every index leads
//! with it, so one collection's rows are one contiguous index range. A schema per
//! collection (the prototype's layout) multiplies catalog entries by the number of
//! collections and doesn't scale to thousands of collections per database.
//!
//! **No global locks on the data path.** A commit locks only its collection's
//! `rs_collections` row (`FOR UPDATE`). Writers of different collections never
//! touch the same row. The only advisory lock is held by [`migrate`] at process
//! start, so concurrent deploys don't race on `CREATE TABLE`.
//!
//! **Storage.** Documents are stored once (`rs_records.doc`, LZ4 when the server
//! supports it); the log is the history, so there are no version or change tables
//! (avoiding duplicated history storage). The derived index is
//! one narrow table, `rs_terms`, rebuilt from the replica-supplied `RecordMeta`.

use postgres::Client;

/// Bump when the DDL below changes incompatibly; [`migrate`] records it.
pub const SCHEMA_VERSION: i32 = 1;

/// Term kinds in `rs_terms`.
pub mod kind {
    /// A link target key (`k1`).
    pub const LINK: i16 = 1;
    /// A `unique.enforce` value: field (`k1`), value key (`k2`).
    pub const UNIQUE: i16 = 2;
    /// A matched type name (`k1`).
    pub const TYPE: i16 = 3;
    /// A tag (`k1`).
    pub const TAG: i16 = 4;
    /// A top-level effective field (`k1`) with its value (`v`, and `k2`/`num`
    /// for text/numbers).
    pub const FIELD: i16 = 5;
    /// One element of a top-level list field (`k1`), same value columns.
    pub const ELEM: i16 = 6;
}

const DDL: &str = r#"
CREATE TABLE IF NOT EXISTS rs_schema (
  version integer NOT NULL
);

CREATE TABLE IF NOT EXISTS rs_collections (
  k bigserial PRIMARY KEY,
  id bytea NOT NULL UNIQUE,
  epoch bigint NOT NULL DEFAULT 0,
  head_seq bigint NOT NULL DEFAULT 0,
  head_chain bytea NOT NULL DEFAULT '\x0000000000000000000000000000000000000000000000000000000000000000',
  settings bytea
);

CREATE TABLE IF NOT EXISTS rs_records (
  c bigint NOT NULL,
  id bytea NOT NULL,
  path text COLLATE "C" NOT NULL,
  path_key text COLLATE "C" NOT NULL,
  doc text NOT NULL,
  revision bytea NOT NULL,
  modified_seq bigint NOT NULL,
  bucket integer NOT NULL,
  meta bytea NOT NULL,
  PRIMARY KEY (c, id)
);
CREATE INDEX IF NOT EXISTS rs_records_path_key ON rs_records (c, path_key);
CREATE INDEX IF NOT EXISTS rs_records_path ON rs_records (c, path);
CREATE INDEX IF NOT EXISTS rs_records_bucket ON rs_records (c, bucket, id);

CREATE TABLE IF NOT EXISTS rs_terms (
  c bigint NOT NULL,
  kind smallint NOT NULL,
  k1 text COLLATE "C" NOT NULL,
  k2 text COLLATE "C",
  v bytea,
  num double precision,
  id bytea NOT NULL
);
CREATE INDEX IF NOT EXISTS rs_terms_key ON rs_terms (c, kind, k1, k2, id);
CREATE INDEX IF NOT EXISTS rs_terms_value ON rs_terms (c, kind, k1, v) WHERE kind >= 5;
CREATE INDEX IF NOT EXISTS rs_terms_num ON rs_terms (c, kind, k1, num) WHERE num IS NOT NULL;
CREATE INDEX IF NOT EXISTS rs_terms_id ON rs_terms (c, id);

CREATE TABLE IF NOT EXISTS rs_files (
  c bigint NOT NULL,
  id bytea NOT NULL,
  path text COLLATE "C" NOT NULL,
  path_key text COLLATE "C" NOT NULL,
  blob bytea NOT NULL,
  media smallint NOT NULL,
  modified_seq bigint NOT NULL,
  bucket integer NOT NULL,
  local smallint NOT NULL,
  PRIMARY KEY (c, id)
);
CREATE INDEX IF NOT EXISTS rs_files_path_key ON rs_files (c, path_key);
CREATE INDEX IF NOT EXISTS rs_files_bucket ON rs_files (c, bucket, id);

CREATE TABLE IF NOT EXISTS rs_resources (
  c bigint NOT NULL,
  path text COLLATE "C" NOT NULL,
  doc text NOT NULL,
  PRIMARY KEY (c, path)
);

CREATE TABLE IF NOT EXISTS rs_tombstones (
  c bigint NOT NULL,
  id bytea NOT NULL,
  kind smallint NOT NULL,
  path text COLLATE "C" NOT NULL,
  path_key text COLLATE "C" NOT NULL,
  last bytea NOT NULL,
  seq bigint NOT NULL,
  time bigint NOT NULL,
  PRIMARY KEY (c, id)
);
CREATE INDEX IF NOT EXISTS rs_tombstones_path_key ON rs_tombstones (c, path_key, id);
CREATE INDEX IF NOT EXISTS rs_tombstones_seq ON rs_tombstones (c, seq);

CREATE TABLE IF NOT EXISTS rs_aliases (
  c bigint NOT NULL,
  path_key text COLLATE "C" NOT NULL,
  path text COLLATE "C" NOT NULL,
  record bytea NOT NULL,
  PRIMARY KEY (c, path_key)
);

CREATE TABLE IF NOT EXISTS rs_conflicts (
  c bigint NOT NULL,
  mutation bytea NOT NULL,
  cid bytea NOT NULL,
  seq bigint NOT NULL,
  conflict bytea NOT NULL,
  PRIMARY KEY (c, mutation, cid)
);

CREATE TABLE IF NOT EXISTS rs_receipts (
  c bigint NOT NULL,
  mutation bytea NOT NULL,
  seq bigint NOT NULL,
  time bigint NOT NULL,
  PRIMARY KEY (c, mutation)
);
CREATE INDEX IF NOT EXISTS rs_receipts_seq ON rs_receipts (c, seq);

CREATE TABLE IF NOT EXISTS rs_pending (
  c bigint NOT NULL,
  ord bigint NOT NULL,
  mutation bytea NOT NULL,
  row bytea NOT NULL,
  PRIMARY KEY (c, ord)
);
CREATE UNIQUE INDEX IF NOT EXISTS rs_pending_mutation ON rs_pending (c, mutation);

CREATE TABLE IF NOT EXISTS rs_local_receipts (
  c bigint NOT NULL,
  mutation bytea NOT NULL,
  resolved_at bigint NOT NULL,
  row bytea NOT NULL,
  PRIMARY KEY (c, mutation)
);
CREATE INDEX IF NOT EXISTS rs_local_receipts_at ON rs_local_receipts (c, resolved_at);

CREATE TABLE IF NOT EXISTS rs_holds (
  c bigint NOT NULL,
  id bytea NOT NULL,
  hold bytea NOT NULL,
  PRIMARY KEY (c, id)
);

CREATE TABLE IF NOT EXISTS rs_meta (
  c bigint NOT NULL,
  key text COLLATE "C" NOT NULL,
  v bytea NOT NULL,
  PRIMARY KEY (c, key)
);

CREATE TABLE IF NOT EXISTS rs_transfers (
  c bigint NOT NULL,
  id bytea NOT NULL,
  row bytea NOT NULL,
  PRIMARY KEY (c, id)
);

CREATE TABLE IF NOT EXISTS rs_chunks (
  c bigint NOT NULL,
  id bytea NOT NULL,
  idx bigint NOT NULL,
  bytes bytea NOT NULL,
  PRIMARY KEY (c, id, idx)
);

CREATE TABLE IF NOT EXISTS rs_blob_parts (
  c bigint NOT NULL,
  digest bytea NOT NULL,
  off bigint NOT NULL,
  bytes bytea NOT NULL,
  PRIMARY KEY (c, digest, off)
);
"#;

/// Large columns that benefit from LZ4 TOAST compression (Postgres 14+).
const LZ4: &[(&str, &str)] = &[
    ("rs_records", "doc"),
    ("rs_records", "meta"),
    ("rs_tombstones", "last"),
    ("rs_pending", "row"),
];

/// Advisory lock key that serialises migrations (startup DDL only, never the data
/// path).
pub const MIGRATION_LOCK: i64 = 7_123_402_911;

/// Create or upgrade the schema. Idempotent, and safe to run from several processes
/// at once: every migrator holds a session-level advisory lock for the whole run
/// (the version check included), so concurrent migrators serialise instead of
/// interleaving DDL.
pub fn migrate(client: &mut Client) -> Result<(), postgres::Error> {
    client.execute("SELECT pg_advisory_lock($1)", &[&MIGRATION_LOCK])?;
    let result = migrate_locked(client);
    // Release even on failure; a failed unlock is only reported if the
    // migration itself succeeded (the lock also ends with the session).
    let unlocked = client.execute("SELECT pg_advisory_unlock($1)", &[&MIGRATION_LOCK]);
    result?;
    unlocked.map(|_| ())
}

fn migrate_locked(client: &mut Client) -> Result<(), postgres::Error> {
    let mut t = client.transaction()?;
    if current_in(&mut t)?.is_some_and(|v| v >= SCHEMA_VERSION) {
        return t.commit();
    }
    t.batch_execute(DDL)?;
    let lz4: bool = t
        .query_one(
            "SELECT current_setting('server_version_num')::int >= 140000 \
             AND EXISTS (SELECT 1 FROM pg_settings WHERE name = 'default_toast_compression' \
                         AND 'lz4' = ANY(enumvals))",
            &[],
        )?
        .get(0);
    if lz4 {
        for (table, col) in LZ4 {
            t.batch_execute(&format!(
                "ALTER TABLE {table} ALTER COLUMN {col} SET COMPRESSION lz4"
            ))?;
        }
    }
    let have: Option<i32> = t
        .query_opt("SELECT max(version) FROM rs_schema", &[])?
        .and_then(|r| r.get(0));
    if have.is_none_or(|v| v < SCHEMA_VERSION) {
        t.execute("DELETE FROM rs_schema", &[])?;
        t.execute(
            "INSERT INTO rs_schema (version) VALUES ($1)",
            &[&SCHEMA_VERSION],
        )?;
    }
    t.commit()
}

/// The recorded schema version, if the schema exists.
pub fn current(client: &mut Client) -> Result<Option<i32>, postgres::Error> {
    let mut t = client.transaction()?;
    let v = current_in(&mut t)?;
    t.commit()?;
    Ok(v)
}

fn current_in(t: &mut postgres::Transaction<'_>) -> Result<Option<i32>, postgres::Error> {
    let exists: bool = t
        .query_one("SELECT to_regclass('rs_schema') IS NOT NULL", &[])?
        .get(0);
    if !exists {
        return Ok(None);
    }
    Ok(t.query_one("SELECT max(version) FROM rs_schema", &[])?
        .get(0))
}
