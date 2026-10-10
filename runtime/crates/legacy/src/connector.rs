//! The local connector's state directory (`MC/crates/connect-core/src/registry/`).
//!
//! **Layouts:**
//! - **schema 2** (beta.32–55): `connector.sqlite` holds the collections, the grants
//!   and the durable `mutation_journal`. Receipts are inline.
//! - **schema 3** (beta.56+, ADR 0007): `authority.sqlite` (authority versions 1–5)
//!   holds the grants and the journal, and receipts live in `authority-receipts/`.
//!
//! **Which database is canonical.** If `authority.sqlite` exists, it is canonical.
//! The connector publishes it by rename only after a complete copy
//! (`authority_store.rs:505-560`). A schema-2 `connector.sqlite` next to it is an
//! interrupted cleanup. Without `authority.sqlite`, `connector.sqlite` must be schema
//! 2. A leftover `authority.sqlite.migrating` is ignored, as the connector does.
//!
//! The `mutation_journal` DDL is identical in every version
//! (`0002_durable_mutation_journal.sql` = `authority/0001_initial.sql`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OptionalExtension, Row};

use crate::receipts::{ReceiptStore, ReceiptValue};
use crate::sqlite::{has_table, open_read_only, sqlite, user_version};
use crate::{Error, Result};

/// Which layout the state directory is in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layout {
    /// `connector.sqlite` schema 2. The journal lives in it.
    Schema2,
    /// `authority.sqlite` is canonical, at this authority version (1–5).
    /// `connector_schema` is 3, or 2 after an interrupted cleanup.
    Split {
        /// `connector.sqlite` `user_version`.
        connector_schema: u32,
        /// Highest version in `authority_schema_migrations`.
        authority_version: u32,
    },
}

/// A registered collection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Collection {
    /// The collection ID (equals `mdbase.yaml` `x-mdbase-connect.collection_id`).
    pub id: String,
    /// Absolute folder root.
    pub path: PathBuf,
    /// Display name.
    pub display_name: String,
    /// `collections.enabled`. Informational: the live value also depends on the
    /// folder's marker and the authority overlay.
    pub enabled: bool,
    /// `local_sync_collections.authority_state` (`active` / `transferring` /
    /// `retired`), if the collection ever had local sync state.
    pub authority_state: Option<String>,
}

/// A record ID the connector assigned (`local_sync_records`). Markdown never holds
/// it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordId {
    /// The record ID (UUID text).
    pub record_id: String,
    /// The collection-relative path when last reconciled.
    pub path: String,
    /// `"sha256:<hex>"` of the document when last reconciled. Migration uses the ID
    /// only while the file still has this revision.
    pub revision: String,
}

/// ADR 0005 journal states.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JournalState {
    /// Identity claimed; nothing prepared.
    Claimed,
    /// A plan is durable; the effect may or may not have begun.
    Prepared,
    /// The effect is proved present; the receipt may be missing.
    Applied,
    /// A final receipt is durable. The client may or may not have received it.
    Completed,
    /// The client acknowledged the receipt.
    Acknowledged,
    /// Proved never to have begun.
    Abandoned,
    /// The connector could not tell.
    OutcomeUnknown,
}

impl JournalState {
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "claimed" => Self::Claimed,
            "prepared" => Self::Prepared,
            "applied" => Self::Applied,
            "completed" => Self::Completed,
            "acknowledged" => Self::Acknowledged,
            "abandoned" => Self::Abandoned,
            "outcome_unknown" => Self::OutcomeUnknown,
            _ => return None,
        })
    }
}

/// One `mutation_journal` row, minus the lease and fencing columns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JournalRow {
    /// Identity: application installation ID.
    pub application_installation_id: String,
    /// Identity: grant ID.
    pub grant_id: String,
    /// Identity: request ID (UUIDv7 from the SDK).
    pub request_id: String,
    /// Catalogue operation name.
    pub operation_kind: String,
    /// Operation input schema version.
    pub input_schema_version: i64,
    /// Canonical fingerprint (unpadded base64url SHA-256).
    pub input_digest: String,
    /// State.
    pub state: JournalState,
    /// `prepared_data` JSON, if any.
    pub prepared_data: Option<String>,
    /// `after_evidence` JSON, if any.
    pub after_evidence: Option<String>,
    /// `result_metadata` JSON, if any.
    pub result_metadata: Option<String>,
    /// `final_receipt`: a receipt reference or an inline receipt.
    pub final_receipt: Option<String>,
    /// Hex SHA-256 of the final receipt.
    pub receipt_digest: Option<String>,
    /// Acceptance time, ms.
    pub accepted_at_ms: i64,
    /// Completion time, ms.
    pub completed_at_ms: Option<i64>,
}

impl JournalRow {
    /// The engine host claim of a runtime mutation (`prepared_data.host_claim`,
    /// `MC/crates/connect-agent/src/server/runtime_mutations.rs:17-36`). It links the
    /// row to an engine transaction journal ([`crate::engine`]).
    pub fn host_claim(&self) -> Option<String> {
        json_str(self.prepared_data.as_deref()?, "host_claim")
    }

    /// The receipt an `applied` row already has (`result_metadata.response_receipt`).
    pub fn response_receipt(&self) -> Option<String> {
        json_str(self.result_metadata.as_deref()?, "response_receipt")
    }
}

fn json_str(json: &str, key: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    v.get(key)?.as_str().map(str::to_owned)
}

/// A `mutation_journal_tombstones` row: a compacted terminal mutation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TombstoneRow {
    /// Application installation ID.
    pub application_installation_id: String,
    /// Grant ID.
    pub grant_id: String,
    /// Request ID.
    pub request_id: String,
    /// Fingerprint.
    pub input_digest: String,
    /// Terminal state.
    pub terminal_state: JournalState,
    /// Expiry, ms.
    pub expires_at_ms: i64,
}

/// How migration imports a journal row into `legacy_receipts`
/// (local migration receipt import).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReceiptImport {
    /// Return these exact bytes to a retry. They are already encrypted to the grant.
    Receipt(Vec<u8>),
    /// The request provably never ran: `not_sent`.
    NotSent,
    /// Never acknowledged, and its outcome can't be proved: `outcome_unknown`.
    OutcomeUnknown,
}

/// An open, read-only connector state directory.
pub struct ConnectorState {
    dir: PathBuf,
    layout: Layout,
    connector: Connection,
    connector_path: PathBuf,
    /// The database holding the journal (the connector DB at schema 2).
    authority: Option<(Connection, PathBuf)>,
}

impl ConnectorState {
    /// Open `dir` read-only and detect its layout.
    pub fn open(dir: &Path) -> Result<Self> {
        let connector_path = dir.join("connector.sqlite");
        let connector = open_read_only(&connector_path)?;
        let schema = user_version(&connector, &connector_path)?;
        let authority_path = dir.join("authority.sqlite");
        let (layout, authority) = if authority_path.is_file() {
            if !(schema == 2 || schema == 3) {
                return Err(Error::format(
                    &connector_path,
                    format!("connector schema {schema} next to authority.sqlite"),
                ));
            }
            let conn = open_read_only(&authority_path)?;
            let version: u32 = conn
                .query_row(
                    "SELECT coalesce(max(version), 0) FROM authority_schema_migrations",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| sqlite(&authority_path, e))?;
            if !(1..=5).contains(&version) {
                return Err(Error::format(
                    &authority_path,
                    format!("authority version {version} (supported: 1-5)"),
                ));
            }
            (
                Layout::Split {
                    connector_schema: schema,
                    authority_version: version,
                },
                Some((conn, authority_path)),
            )
        } else {
            if schema != 2 {
                return Err(Error::format(
                    &connector_path,
                    format!(
                        "connector schema {schema} without authority.sqlite (supported: 2, or 3 with authority.sqlite)"
                    ),
                ));
            }
            (Layout::Schema2, None)
        };
        let state = Self {
            dir: dir.to_path_buf(),
            layout,
            connector,
            connector_path,
            authority,
        };
        if !has_table(
            state.journal_db().0,
            state.journal_db().1,
            "mutation_journal",
        )? {
            return Err(Error::format(
                state.journal_db().1,
                "mutation_journal table is missing",
            ));
        }
        Ok(state)
    }

    /// The detected layout.
    pub fn layout(&self) -> Layout {
        self.layout
    }

    /// The receipt store of this state directory.
    pub fn receipt_store(&self) -> ReceiptStore {
        ReceiptStore::new(&self.dir)
    }

    fn journal_db(&self) -> (&Connection, &Path) {
        match &self.authority {
            Some((c, p)) => (c, p),
            None => (&self.connector, &self.connector_path),
        }
    }

    /// Registered collections, ordered by ID.
    pub fn collections(&self) -> Result<Vec<Collection>> {
        let p = &self.connector_path;
        let mut stmt = self
            .connector
            .prepare(
                "SELECT c.id, c.path, c.display_name, c.enabled, s.authority_state
                 FROM collections c
                 LEFT JOIN local_sync_collections s ON s.collection_id = c.id
                 ORDER BY c.id",
            )
            .map_err(|e| sqlite(p, e))?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Collection {
                    id: r.get(0)?,
                    path: PathBuf::from(r.get::<_, String>(1)?),
                    display_name: r.get(2)?,
                    enabled: r.get::<_, i64>(3)? != 0,
                    authority_state: r.get(4)?,
                })
            })
            .map_err(|e| sqlite(p, e))?;
        rows.collect::<std::result::Result<_, _>>()
            .map_err(|e| sqlite(p, e))
    }

    /// Record IDs for `collection_id`, ordered by path.
    pub fn record_ids(&self, collection_id: &str) -> Result<Vec<RecordId>> {
        let p = &self.connector_path;
        let mut stmt = self
            .connector
            .prepare(
                "SELECT record_id, path, revision FROM local_sync_records
                 WHERE collection_id = ?1 ORDER BY path",
            )
            .map_err(|e| sqlite(p, e))?;
        let rows = stmt
            .query_map([collection_id], |r| {
                Ok(RecordId {
                    record_id: r.get(0)?,
                    path: r.get(1)?,
                    revision: r.get(2)?,
                })
            })
            .map_err(|e| sqlite(p, e))?;
        rows.collect::<std::result::Result<_, _>>()
            .map_err(|e| sqlite(p, e))
    }

    /// Every journal row, ordered by acceptance time then identity.
    pub fn journal(&self) -> Result<Vec<JournalRow>> {
        let (conn, p) = self.journal_db();
        let mut stmt = conn
            .prepare(
                "SELECT application_installation_id, grant_id, request_id, operation_kind,
                        input_schema_version, input_digest, state, prepared_data,
                        after_evidence, result_metadata, final_receipt, receipt_digest,
                        accepted_at_ms, completed_at_ms
                 FROM mutation_journal
                 ORDER BY accepted_at_ms, application_installation_id, grant_id, request_id",
            )
            .map_err(|e| sqlite(p, e))?;
        let rows = stmt.query_map([], journal_row).map_err(|e| sqlite(p, e))?;
        let mut out = Vec::new();
        for row in rows {
            let (row, state) = row.map_err(|e| sqlite(p, e))?;
            match row {
                Some(row) => out.push(row),
                None => return Err(Error::format(p, format!("unknown journal state {state}"))),
            }
        }
        Ok(out)
    }

    /// Every journal tombstone.
    pub fn tombstones(&self) -> Result<Vec<TombstoneRow>> {
        let (conn, p) = self.journal_db();
        let mut stmt = conn
            .prepare(
                "SELECT application_installation_id, grant_id, request_id, input_digest,
                        terminal_state, expires_at_ms
                 FROM mutation_journal_tombstones
                 ORDER BY application_installation_id, grant_id, request_id",
            )
            .map_err(|e| sqlite(p, e))?;
        let rows = stmt
            .query_map([], |r| {
                let state: String = r.get(4)?;
                let row = match JournalState::parse(&state) {
                    Some(terminal_state) => Some(TombstoneRow {
                        application_installation_id: r.get(0)?,
                        grant_id: r.get(1)?,
                        request_id: r.get(2)?,
                        input_digest: r.get(3)?,
                        terminal_state,
                        expires_at_ms: r.get(5)?,
                    }),
                    None => None,
                };
                Ok((row, state))
            })
            .map_err(|e| sqlite(p, e))?;
        let mut out = Vec::new();
        for row in rows {
            let (row, state) = row.map_err(|e| sqlite(p, e))?;
            out.push(
                row.ok_or_else(|| Error::format(p, format!("unknown tombstone state {state}")))?,
            );
        }
        Ok(out)
    }

    /// How `row` is imported for the compatibility shim. A receipt that is referenced
    /// but missing or corrupt makes the request `outcome_unknown`, never a replay
    /// (ADR 0007 fails closed in the same case). The error is returned alongside it, so
    /// the migration report can count it.
    pub fn receipt_import(&self, row: &JournalRow) -> (ReceiptImport, Option<Error>) {
        let reference = match row.state {
            JournalState::Completed | JournalState::Acknowledged => row.final_receipt.clone(),
            JournalState::Applied => row.response_receipt(),
            JournalState::Abandoned => return (ReceiptImport::NotSent, None),
            JournalState::Claimed | JournalState::Prepared | JournalState::OutcomeUnknown => {
                return (ReceiptImport::OutcomeUnknown, None);
            }
        };
        let Some(reference) = reference else {
            return (ReceiptImport::OutcomeUnknown, None);
        };
        let loaded = ReceiptValue::parse(&reference)
            .map_err(|d| Error::format(self.journal_db().1, d))
            .and_then(|v| self.receipt_store().load(&v));
        match loaded {
            Ok(bytes) => (ReceiptImport::Receipt(bytes), None),
            Err(e) => (ReceiptImport::OutcomeUnknown, Some(e)),
        }
    }

    /// The collection ID written in a folder's `mdbase.yaml`
    /// (`x-mdbase-connect.collection_id`), if any. This is a line scan, not a YAML
    /// parse: the connector writes the key in block style under a top-level
    /// `x-mdbase-connect:` mapping (`identity.rs:132-159`). Anything else returns
    /// `None`, and the registry row is used.
    pub fn folder_collection_id(root: &Path) -> Result<Option<String>> {
        let path = root.join("mdbase.yaml");
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(Error::io(&path, e)),
        };
        let mut in_block = false;
        for line in text.lines() {
            if !line.starts_with([' ', '\t']) {
                in_block = line.trim_end() == "x-mdbase-connect:";
                continue;
            }
            if in_block && let Some(v) = line.trim().strip_prefix("collection_id:") {
                let v = v.trim().trim_matches(['"', '\'']);
                return Ok(crate::is_uuid(v).then(|| v.to_owned()));
            }
        }
        Ok(None)
    }

    /// Check a setting in the operational database (for diagnostics).
    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        self.connector
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| sqlite(&self.connector_path, e))
    }
}

/// A raw row, column → value. Blobs are lowercase hex. Used for state migration carries
/// through unchanged (grants, replay windows) rather than interprets.
pub type RawRow = BTreeMap<String, serde_json::Value>;

/// A collection's grants and their replay state (local takeover, T5).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GrantState {
    /// `grants` rows for the collection.
    pub grants: Vec<RawRow>,
    /// `grant_crypto_state` rows (per-grant counters) for those grants.
    pub crypto_state: Vec<RawRow>,
    /// `grant_crypto_requests` rows (request bindings) for those grants.
    pub crypto_requests: Vec<RawRow>,
    /// `collection_access_overlays.enabled` (authority layout only).
    pub overlay_enabled: Option<bool>,
    /// The profile-wide pause flag.
    pub access_paused: Option<bool>,
    /// `policy_state` (authority layout only).
    pub policy_state: Option<RawRow>,
}

impl ConnectorState {
    /// Grants and replay state for `collection_id`, read-only.
    pub fn grant_state(&self, collection_id: &str) -> Result<GrantState> {
        let (conn, p) = self.journal_db();
        let mut out = GrantState {
            grants: raw_rows(
                conn,
                p,
                "SELECT * FROM grants WHERE collection_id = ?1 ORDER BY id",
                &[collection_id],
            )?,
            ..GrantState::default()
        };
        for table in ["grant_crypto_state", "grant_crypto_requests"] {
            if !has_table(conn, p, table)? {
                continue;
            }
            let rows = raw_rows(
                conn,
                p,
                &format!(
                    "SELECT * FROM {table} WHERE grant_id IN
                       (SELECT id FROM grants WHERE collection_id = ?1)
                     ORDER BY grant_id, key_id"
                ),
                &[collection_id],
            )?;
            if table == "grant_crypto_state" {
                out.crypto_state = rows;
            } else {
                out.crypto_requests = rows;
            }
        }
        if has_table(conn, p, "collection_access_overlays")? {
            out.overlay_enabled = conn
                .query_row(
                    "SELECT enabled FROM collection_access_overlays WHERE collection_id = ?1",
                    [collection_id],
                    |r| r.get::<_, i64>(0),
                )
                .optional()
                .map_err(|e| sqlite(p, e))?
                .map(|v| v != 0);
        }
        let paused_sql = if has_table(conn, p, "authority_settings")? {
            "SELECT value FROM authority_settings WHERE key = 'access_paused'"
        } else {
            "SELECT value FROM settings WHERE key = 'access_paused'"
        };
        out.access_paused = conn
            .query_row(paused_sql, [], |r| r.get::<_, String>(0))
            .optional()
            .map_err(|e| sqlite(p, e))?
            .map(|v| v == "true");
        if has_table(conn, p, "policy_state")? {
            out.policy_state = raw_rows(conn, p, "SELECT * FROM policy_state", &[])?
                .into_iter()
                .next();
        }
        Ok(out)
    }

    /// Copy both databases into `out_dir` with SQLite's online backup, from the
    /// read-only connections (migration T3). A live WAL is included, and the originals
    /// are not written. Returns the files written.
    pub fn backup_to(&self, out_dir: &Path) -> Result<Vec<PathBuf>> {
        std::fs::create_dir_all(out_dir).map_err(|e| Error::io(out_dir, e))?;
        let mut written = Vec::new();
        let mut copy = |conn: &Connection, src: &Path, name: &str| -> Result<()> {
            let dst = out_dir.join(name);
            let _ = std::fs::remove_file(&dst);
            let mut target = Connection::open(&dst).map_err(|e| sqlite(&dst, e))?;
            {
                let backup =
                    rusqlite::backup::Backup::new(conn, &mut target).map_err(|e| sqlite(src, e))?;
                backup
                    .run_to_completion(256, std::time::Duration::ZERO, None)
                    .map_err(|e| sqlite(src, e))?;
            }
            target
                .pragma_update(None, "journal_mode", "DELETE")
                .map_err(|e| sqlite(&dst, e))?;
            written.push(dst);
            Ok(())
        };
        copy(&self.connector, &self.connector_path, "connector.sqlite")?;
        if let Some((conn, path)) = &self.authority {
            copy(conn, path, "authority.sqlite")?;
        }
        Ok(written)
    }
}

fn raw_rows(conn: &Connection, path: &Path, sql: &str, params: &[&str]) -> Result<Vec<RawRow>> {
    let mut stmt = conn.prepare(sql).map_err(|e| sqlite(path, e))?;
    let names: Vec<String> = stmt
        .column_names()
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), |r| {
            let mut row = RawRow::new();
            for (i, name) in names.iter().enumerate() {
                let v = match r.get_ref(i)? {
                    ValueRef::Null => serde_json::Value::Null,
                    ValueRef::Integer(n) => n.into(),
                    ValueRef::Real(f) => serde_json::json!(f),
                    ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned().into(),
                    ValueRef::Blob(b) => crate::hex(b).into(),
                };
                row.insert(name.clone(), v);
            }
            Ok(row)
        })
        .map_err(|e| sqlite(path, e))?;
    rows.collect::<std::result::Result<_, _>>()
        .map_err(|e| sqlite(path, e))
}

type RowResult = (Option<JournalRow>, String);

fn journal_row(r: &Row<'_>) -> rusqlite::Result<RowResult> {
    let state_text: String = r.get(6)?;
    let Some(state) = JournalState::parse(&state_text) else {
        return Ok((None, state_text));
    };
    Ok((
        Some(JournalRow {
            application_installation_id: r.get(0)?,
            grant_id: r.get(1)?,
            request_id: r.get(2)?,
            operation_kind: r.get(3)?,
            input_schema_version: r.get(4)?,
            input_digest: r.get(5)?,
            state,
            prepared_data: r.get(7)?,
            after_evidence: r.get(8)?,
            result_metadata: r.get(9)?,
            final_receipt: r.get(10)?,
            receipt_digest: r.get(11)?,
            accepted_at_ms: r.get(12)?,
            completed_at_ms: r.get(13)?,
        }),
        state_text,
    ))
}
