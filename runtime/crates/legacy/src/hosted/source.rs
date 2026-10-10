//! Reading hosted provider rows from Postgres (feature `pg`).
//!
//! **Read-only by construction**:
//! - the database role must be SELECT-only: [`HostedDb`] refuses a superuser and any role
//!   with INSERT, UPDATE, DELETE or TRUNCATE on a provider table. The role is created
//!   by `sql/reader-role.sql`;
//! - every session also sets `default_transaction_read_only = on`;
//! - connections to anything but a loopback address require TLS (rustls, verified
//!   against the platform roots plus an optional CA bundle);
//! - every snapshot is one `REPEATABLE READ READ ONLY` transaction, so the records,
//!   files, resources and `head` it returns are mutually consistent.
//!
//! Only metadata and the sealed columns are selected. Plaintext exists only after
//! [`super`] decrypts it, in memory.

use postgres::config::{Host, SslMode};
use postgres::{Client, Config, NoTls, Transaction};

use super::{
    CollectionKey, FileMeta, FileVersion, HostedError, Record, RecordVersion, Unwrapper,
    decode_file, decode_file_version, decode_record, decode_record_version, decode_resource,
};

/// Errors from the Postgres source.
#[derive(Debug)]
pub enum SourceError {
    /// A database error.
    Db(postgres::Error),
    /// Decryption or decoding failed for a row.
    Row(HostedError),
    /// The collection is missing, or not in a state that can be migrated.
    Collection(String),
}

impl std::fmt::Display for SourceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Db(e) => write!(f, "postgres: {e}"),
            Self::Row(e) => write!(f, "row: {e}"),
            Self::Collection(d) => write!(f, "collection: {d}"),
        }
    }
}

impl std::error::Error for SourceError {}

impl From<postgres::Error> for SourceError {
    fn from(e: postgres::Error) -> Self {
        Self::Db(e)
    }
}

impl From<HostedError> for SourceError {
    fn from(e: HostedError) -> Self {
        Self::Row(e)
    }
}

type SResult<T> = std::result::Result<T, SourceError>;

/// A collection's row (metadata only).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CollectionRow {
    /// Collection ID.
    pub id: String,
    /// Provider state (`active`, `importing`, `transferring`, …).
    pub state: String,
    /// The shared change sequence head.
    pub head: i64,
    /// Display name.
    pub display_name: String,
}

/// A resource document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resource {
    /// Path, e.g. `mdbase.yaml`.
    pub path: String,
    /// `configuration` / `type` / `contract` / `schema` / `view` / `lock`.
    pub kind: String,
    /// Exact bytes.
    pub bytes: Vec<u8>,
}

/// A non-revoked replica credential (`hosted_provider_replicas`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Replica {
    /// Replica ID: what H8 revokes, and what `migration-cutover` lists.
    pub id: String,
    /// `mirror` or `application`.
    pub purpose: String,
}

/// A consistent generation-0 read of one collection (migration H2).
#[derive(Debug)]
pub struct Snapshot {
    /// The collection.
    pub collection: CollectionRow,
    /// Resources, by path.
    pub resources: Vec<Resource>,
    /// Current records, by record ID.
    pub records: Vec<Record>,
    /// Live files, by file ID.
    pub files: Vec<FileMeta>,
    /// Replicas that are not revoked.
    pub replicas: Vec<Replica>,
}

/// One change after a sequence (migration H5/H7, the shadow).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    /// A record now has this state, or was deleted (`None`).
    Record {
        /// Sequence.
        sequence: i64,
        /// Record ID.
        record_id: String,
        /// After-image.
        after: Option<Record>,
    },
    /// A file now has this state, or was deleted (`None`).
    File {
        /// Sequence.
        sequence: i64,
        /// File ID.
        file_id: String,
        /// After-image metadata.
        after: Option<FileMeta>,
    },
    /// A resource changed. Resource changes carry no ciphertext, so the shadow
    /// re-reads the current resources.
    Resource {
        /// Sequence.
        sequence: i64,
        /// Path.
        path: String,
    },
}

/// Aggregate live-file metadata for the migration re-seal estimate.
/// Counts only, never content.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileTotals {
    /// Live files.
    pub files: i64,
    /// Their bytes.
    pub bytes: i64,
    /// 8 MiB blob parts (at least one per file).
    pub parts: i64,
}

/// A read-only connection to the provider database.
pub struct HostedDb {
    client: Client,
}

impl HostedDb {
    /// Connect to `url` (a libpq connection string or URL).
    ///
    /// - **TLS:** required unless every host is loopback (`127.0.0.1`, `::1`,
    ///   `localhost`) or a Unix socket. It is verified against the platform root store,
    ///   plus `extra_ca_pem` if given (for example, a Render or LAB CA).
    ///   `sslmode=disable` towards a remote host is refused.
    /// - **Role:** checked SELECT-only before any read ([`HostedDb::from_client`]).
    pub fn connect(url: &str, extra_ca_pem: Option<&[u8]>) -> SResult<Self> {
        let config: Config = url.parse()?;
        let local = config.get_hosts().iter().all(|h| match h {
            Host::Tcp(name) => matches!(name.as_str(), "localhost" | "127.0.0.1" | "::1"),
            #[cfg(unix)]
            Host::Unix(_) => true,
        });
        let client = if local && config.get_ssl_mode() != SslMode::Require {
            config.connect(NoTls)?
        } else {
            if config.get_ssl_mode() == SslMode::Disable {
                return Err(SourceError::Collection(
                    "refusing sslmode=disable to a non-loopback database".into(),
                ));
            }
            let mut config = config;
            config.ssl_mode(SslMode::Require);
            config.connect(tls(extra_ca_pem)?)?
        };
        Self::from_client(client)
    }

    /// Wrap an existing client: check that its role is SELECT-only, then make the
    /// session read-only.
    pub fn from_client(mut client: Client) -> SResult<Self> {
        verify_select_only(&mut client)?;
        client.batch_execute("SET default_transaction_read_only = on")?;
        Ok(Self { client })
    }

    /// Every collection's metadata, by ID.
    pub fn collections(&mut self) -> SResult<Vec<CollectionRow>> {
        let rows = self.client.query(
            "SELECT id::text, state, head, display_name FROM hosted_provider_collections ORDER BY id",
            &[],
        )?;
        Ok(rows
            .iter()
            .map(|r| CollectionRow {
                id: r.get(0),
                state: r.get(1),
                head: r.get(2),
                display_name: r.get(3),
            })
            .collect())
    }

    /// Live-file totals, for one collection or all.
    pub fn file_totals(&mut self, collection: Option<&str>) -> SResult<FileTotals> {
        let row = self.client.query_one(
            "SELECT count(*)::bigint,
                    coalesce(sum(size), 0)::bigint,
                    coalesce(sum(greatest(1, ceil(size / 8388608.0))), 0)::bigint
             FROM hosted_provider_files
             WHERE $1::text IS NULL OR collection_id::text = $1",
            &[&collection],
        )?;
        Ok(FileTotals {
            files: row.get(0),
            bytes: row.get(1),
            parts: row.get(2),
        })
    }

    /// A consistent decrypted snapshot of `cid` (migration H2). It fails on the first
    /// row that doesn't decrypt or check out: migration of that collection stops.
    pub fn snapshot(&mut self, cid: &str, keys: &Unwrapper<'_>) -> SResult<Snapshot> {
        let mut tx = self
            .client
            .build_transaction()
            .isolation_level(postgres::IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()?;
        let (collection, key) = collection_and_key(&mut tx, cid, keys)?;

        let mut resources = Vec::new();
        for r in tx.query(
            "SELECT path, kind, revision, document_ciphertext FROM hosted_provider_resources
             WHERE collection_id::text = $1 ORDER BY path",
            &[&cid],
        )? {
            let path: String = r.get(0);
            let bytes = decode_resource(&key, cid, &path, r.get(2), r.get(3))?;
            resources.push(Resource {
                path,
                kind: r.get(1),
                bytes,
            });
        }

        let mut records = Vec::new();
        for r in tx.query(
            "SELECT record_id::text, revision, sequence, payload_ciphertext
             FROM hosted_provider_records WHERE collection_id::text = $1 ORDER BY record_id",
            &[&cid],
        )? {
            let seq: i64 = r.get(2);
            records.push(decode_record(
                &key,
                cid,
                r.get(0),
                r.get(1),
                seq as u64,
                r.get(3),
            )?);
        }

        let mut files = Vec::new();
        for r in tx.query(
            "SELECT file_id::text, sequence, size, object_key, payload_ciphertext
             FROM hosted_provider_files WHERE collection_id::text = $1 ORDER BY file_id",
            &[&cid],
        )? {
            let seq: i64 = r.get(1);
            let size: i64 = r.get(2);
            files.push(decode_file(
                &key,
                cid,
                r.get(0),
                seq as u64,
                size as u64,
                r.get(3),
                r.get(4),
            )?);
        }

        let replicas = tx
            .query(
                "SELECT id::text, purpose FROM hosted_provider_replicas
                 WHERE collection_id::text = $1 AND revoked_at IS NULL ORDER BY id",
                &[&cid],
            )?
            .iter()
            .map(|r| Replica {
                id: r.get(0),
                purpose: r.get(1),
            })
            .collect();
        tx.commit()?;
        Ok(Snapshot {
            collection,
            resources,
            records,
            files,
            replicas,
        })
    }

    /// Changes with `sequence > after`, in sequence order (migration H5/H7).
    /// Returns them with the head they were read at.
    pub fn changes_since(
        &mut self,
        cid: &str,
        after: i64,
        keys: &Unwrapper<'_>,
    ) -> SResult<(i64, Vec<Change>)> {
        let mut tx = self
            .client
            .build_transaction()
            .isolation_level(postgres::IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()?;
        let (collection, key) = collection_and_key(&mut tx, cid, keys)?;
        let mut out = Vec::new();
        for r in tx.query(
            "SELECT c.sequence, c.record_id::text, c.after_ciphertext, c.revision
             FROM hosted_provider_changes c
             WHERE c.collection_id::text = $1 AND c.sequence > $2 ORDER BY c.sequence",
            &[&cid, &after],
        )? {
            let sequence: i64 = r.get(0);
            let record_id: String = r.get(1);
            let after: Option<Vec<u8>> = r.get(2);
            let after = match after {
                None => None,
                Some(ct) => Some(decode_change_record(
                    &key,
                    cid,
                    sequence,
                    &record_id,
                    r.get(3),
                    &ct,
                )?),
            };
            out.push(Change::Record {
                sequence,
                record_id,
                after,
            });
        }
        for r in tx.query(
            "SELECT sequence, file_id::text, after_size, after_object_key, after_ciphertext
             FROM hosted_provider_file_changes
             WHERE collection_id::text = $1 AND sequence > $2 ORDER BY sequence",
            &[&cid, &after],
        )? {
            let sequence: i64 = r.get(0);
            let file_id: String = r.get(1);
            let ct: Option<Vec<u8>> = r.get(4);
            let after = match ct {
                None => None,
                Some(ct) => {
                    let size: i64 = r.get(2);
                    let object_key: String = r.get(3);
                    Some(decode_change_file(
                        &key,
                        cid,
                        sequence,
                        &file_id,
                        size as u64,
                        &object_key,
                        &ct,
                    )?)
                }
            };
            out.push(Change::File {
                sequence,
                file_id,
                after,
            });
        }
        for r in tx.query(
            "SELECT sequence, path FROM hosted_provider_resource_changes
             WHERE collection_id::text = $1 AND sequence > $2 ORDER BY sequence",
            &[&cid, &after],
        )? {
            out.push(Change::Resource {
                sequence: r.get(0),
                path: r.get(1),
            });
        }
        tx.commit()?;
        out.sort_by_key(|c| match c {
            Change::Record { sequence, .. }
            | Change::File { sequence, .. }
            | Change::Resource { sequence, .. } => *sequence,
        });
        Ok((collection.head, out))
    }
}

/// The nil UUID: the keyset start for version pages.
const NIL: &str = "00000000-0000-0000-0000-000000000000";

impl HostedDb {
    /// The collection's metadata and unwrapped key, for the version pages below.
    pub fn collection_key(
        &mut self,
        cid: &str,
        keys: &Unwrapper<'_>,
    ) -> SResult<(CollectionRow, CollectionKey)> {
        let mut tx = self
            .client
            .build_transaction()
            .isolation_level(postgres::IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()?;
        let out = collection_and_key(&mut tx, cid, keys)?;
        tx.commit()?;
        Ok(out)
    }

    /// One keyset page of record versions with `sequence <= s0`, after
    /// `after = (record_id, sequence)` (`None` from the start), in `(record_id, sequence)`
    /// order (pre-history, pre-history preservation). Version rows are append-only
    /// and bounded by `s0`, so pages read in separate transactions are consistent as
    /// long as the backup hold keeps retention from deleting them.
    pub fn record_versions(
        &mut self,
        cid: &str,
        key: &CollectionKey,
        s0: i64,
        after: Option<(&str, i64)>,
        limit: i64,
    ) -> SResult<Vec<RecordVersion>> {
        let (aid, aseq) = after.unwrap_or((NIL, 0));
        let mut tx = self
            .client
            .build_transaction()
            .isolation_level(postgres::IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()?;
        let mut out = Vec::new();
        for r in tx.query(
            "SELECT record_id::text, sequence, revision,
                    (extract(epoch FROM created_at) * 1000)::bigint, deleted, payload_ciphertext
             FROM hosted_provider_record_versions
             WHERE collection_id::text = $1 AND sequence <= $2
               AND (record_id, sequence) > ($3::text::uuid, $4::bigint)
             ORDER BY record_id, sequence LIMIT $5",
            &[&cid, &s0, &aid, &aseq, &limit],
        )? {
            let rid: String = r.get(0);
            let seq: i64 = r.get(1);
            let payload: Option<Vec<u8>> = r.get(5);
            out.push(decode_record_version(
                key,
                cid,
                &rid,
                seq as u64,
                r.get(2),
                r.get(3),
                r.get(4),
                payload.as_deref(),
            )?);
        }
        tx.commit()?;
        Ok(out)
    }

    /// One keyset page of file versions, as [`HostedDb::record_versions`].
    pub fn file_versions(
        &mut self,
        cid: &str,
        key: &CollectionKey,
        s0: i64,
        after: Option<(&str, i64)>,
        limit: i64,
    ) -> SResult<Vec<FileVersion>> {
        let (aid, aseq) = after.unwrap_or((NIL, 0));
        let mut tx = self
            .client
            .build_transaction()
            .isolation_level(postgres::IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()?;
        let mut out = Vec::new();
        for r in tx.query(
            "SELECT file_id::text, sequence, revision,
                    (extract(epoch FROM created_at) * 1000)::bigint, deleted, size, object_key,
                    payload_ciphertext
             FROM hosted_provider_file_versions
             WHERE collection_id::text = $1 AND sequence <= $2
               AND (file_id, sequence) > ($3::text::uuid, $4::bigint)
             ORDER BY file_id, sequence LIMIT $5",
            &[&cid, &s0, &aid, &aseq, &limit],
        )? {
            let fid: String = r.get(0);
            let seq: i64 = r.get(1);
            let size: Option<i64> = r.get(5);
            let object_key: Option<String> = r.get(6);
            let payload: Option<Vec<u8>> = r.get(7);
            out.push(decode_file_version(
                key,
                cid,
                &fid,
                seq as u64,
                r.get(2),
                r.get(3),
                r.get(4),
                size.map(|s| s as u64),
                object_key.as_deref(),
                payload.as_deref(),
            )?);
        }
        tx.commit()?;
        Ok(out)
    }
}

/// Refuse a role that could write: a superuser, or any write privilege on a provider
/// table visible in the search path.
fn verify_select_only(client: &mut Client) -> SResult<()> {
    let row = client.query_one(
        "SELECT r.rolsuper,
                (SELECT count(*) FROM pg_tables t
                  WHERE t.tablename LIKE 'hosted\\_provider\\_%'
                    AND t.schemaname = ANY (current_schemas(false))) AS tables,
                (SELECT count(*) FROM pg_tables t
                  WHERE t.tablename LIKE 'hosted\\_provider\\_%'
                    AND t.schemaname = ANY (current_schemas(false))
                    AND has_table_privilege(current_user,
                          quote_ident(t.schemaname) || '.' || quote_ident(t.tablename),
                          'INSERT,UPDATE,DELETE,TRUNCATE')) AS writable
         FROM pg_roles r WHERE r.rolname = current_user",
        &[],
    )?;
    let (superuser, tables, writable): (bool, i64, i64) = (row.get(0), row.get(1), row.get(2));
    if superuser || writable > 0 {
        return Err(SourceError::Collection(
            "the database role can write; use the SELECT-only reader role (sql/reader-role.sql)"
                .into(),
        ));
    }
    if tables == 0 {
        return Err(SourceError::Collection(
            "no provider tables visible to this role".into(),
        ));
    }
    Ok(())
}

fn tls(extra_ca_pem: Option<&[u8]>) -> SResult<tokio_postgres_rustls::MakeRustlsConnect> {
    let mut roots = rustls::RootCertStore::empty();
    for cert in rustls_native_certs::load_native_certs().certs {
        // Unparseable platform certificates are skipped, as browsers do.
        let _ = roots.add(cert);
    }
    if let Some(pem) = extra_ca_pem {
        let mut reader = pem;
        for cert in rustls_pemfile_certs(&mut reader)? {
            roots
                .add(cert)
                .map_err(|e| SourceError::Collection(format!("CA certificate: {e}")))?;
        }
    }
    if roots.is_empty() {
        return Err(SourceError::Collection("no trusted CA certificates".into()));
    }
    let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| SourceError::Collection(format!("tls: {e}")))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(tokio_postgres_rustls::MakeRustlsConnect::new(config))
}

fn rustls_pemfile_certs(
    pem: &mut &[u8],
) -> SResult<Vec<rustls::pki_types::CertificateDer<'static>>> {
    use rustls::pki_types::pem::PemObject;
    rustls::pki_types::CertificateDer::pem_slice_iter(pem)
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| SourceError::Collection(format!("CA bundle: {e}")))
}

fn collection_and_key(
    tx: &mut Transaction<'_>,
    cid: &str,
    keys: &Unwrapper<'_>,
) -> SResult<(CollectionRow, CollectionKey)> {
    let row = tx
        .query_opt(
            "SELECT id::text, state, head, display_name, wrapped_data_key
             FROM hosted_provider_collections WHERE id::text = $1",
            &[&cid],
        )?
        .ok_or_else(|| SourceError::Collection(format!("{cid} not found")))?;
    let wrapped: Vec<u8> = row.get(4);
    let key = keys.unwrap(&wrapped, cid)?;
    Ok((
        CollectionRow {
            id: row.get(0),
            state: row.get(1),
            head: row.get(2),
            display_name: row.get(3),
        },
        key,
    ))
}

fn decode_change_record(
    key: &CollectionKey,
    cid: &str,
    sequence: i64,
    record_id: &str,
    revision: &str,
    ct: &[u8],
) -> std::result::Result<Record, HostedError> {
    // Same plaintext type as the current row, under the change AAD.
    let plain = super::open(
        key,
        ct,
        &super::aad::change_record(cid, sequence as u64, "after"),
    )?;
    let r: super::SyncRecord = serde_json::from_slice(&plain).map_err(|e| super::json_error(&e))?;
    if r.record_id != record_id
        || r.revision != revision
        || crate::revision_of(r.document.as_bytes()) != r.revision
    {
        return Err(HostedError::Inconsistent(format!(
            "change {sequence}: after-image does not match its row"
        )));
    }
    Ok(Record {
        record_id: r.record_id,
        path: r.path,
        document: r.document,
        revision: r.revision,
    })
}

fn decode_change_file(
    key: &CollectionKey,
    cid: &str,
    sequence: i64,
    file_id: &str,
    size: u64,
    object_key: &str,
    ct: &[u8],
) -> std::result::Result<FileMeta, HostedError> {
    let plain = super::open(
        key,
        ct,
        &super::aad::change_file(cid, sequence as u64, "after"),
    )?;
    let p: super::FilePayload =
        serde_json::from_slice(&plain).map_err(|e| super::json_error(&e))?;
    Ok(FileMeta {
        file_id: file_id.to_owned(),
        path: p.path,
        content_digest: p.content_digest,
        size,
        object_key: object_key.to_owned(),
        media_type: p.media_type,
        media_class: p.media_class,
    })
}
