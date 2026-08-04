use super::*;
use chrono::Utc;
use hmac::{Hmac, Mac};
use rand_core::{OsRng, RngCore};
use rusqlite::backup::Backup;
use rusqlite::{ffi::ErrorCode, OpenFlags};
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::time::Duration;

const LATEST_SCHEMA_VERSION: u32 = 2;
const BASELINE_NAME: &str = "beta28_baseline";
const BASELINE_SQL: &str = include_str!("migrations/0001_beta28_baseline.sql");
const BASELINE_CHECKSUM: &str = "2ea037f01e1e6a8c0feb52f88dbd2c2350ae60631e563a4e719c79b2a5ca32b7";
const MUTATION_JOURNAL_NAME: &str = "durable_mutation_journal";
const MUTATION_JOURNAL_SQL: &str = include_str!("migrations/0002_durable_mutation_journal.sql");
const MUTATION_JOURNAL_CHECKSUM: &str =
    "f06c9e746030f85b2586d3837e4637b61cca2cc1c9a39db44e293482f0634c15";
const BACKUP_FORMAT_VERSION: u32 = 1;
const BACKUP_DIRECTORY: &str = "registry-backups";
const BACKUP_KEY_FILE: &str = ".registry-backup-auth-key";

const LEDGER_SQL: &str = "
CREATE TABLE connect_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('prepared', 'completed')),
    started_at TEXT NOT NULL,
    completed_at TEXT
);";

const BETA28_TABLES: &[&str] = &[
    "activity",
    "collection_changes",
    "collection_file_changes",
    "collection_file_inventory_state",
    "collection_file_mutations",
    "collection_file_transfer_chunks",
    "collection_file_transfers",
    "collection_files",
    "collections",
    "grant_crypto_requests",
    "grant_crypto_state",
    "grants",
    "local_sync_changes",
    "local_sync_collections",
    "local_sync_receipts",
    "local_sync_records",
    "local_sync_replicas",
    "local_sync_snapshots",
    "settings",
];

const BETA28_SENTINEL_COLUMNS: &[(&str, &[&str])] = &[
    (
        "grants",
        &[
            "application_authorization",
            "application_distribution",
            "file_capability",
            "notification_criteria",
            "scope",
        ],
    ),
    (
        "grant_crypto_requests",
        &[
            "request_counter",
            "request_fingerprint",
            "response_envelope",
        ],
    ),
    ("grant_crypto_state", &["reorder_floor"]),
    ("local_sync_snapshots", &["files"]),
    ("collection_file_mutations", &["planned_receipt"]),
];

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RegistryBackupMetadata {
    pub format_version: u32,
    pub source_schema_version: u32,
    pub created_at: String,
    pub backup_file: String,
    pub byte_length: u64,
    pub sha256: String,
    pub authentication: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct RegistryBackupDiagnostic {
    pub metadata_path: PathBuf,
    pub backup_path: PathBuf,
    pub valid: bool,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct RegistryDiagnostics {
    pub database_path: PathBuf,
    pub schema_version: Option<u32>,
    pub quick_check: Vec<String>,
    pub integrity_check: Vec<String>,
    pub backups: Vec<RegistryBackupDiagnostic>,
}

pub(super) fn migrate_registry(path: &Path) -> Result<(), ConnectError> {
    migrate_registry_with_hook(path, &mut |_| Ok(()))
}

fn migrate_registry_with_hook(
    path: &Path,
    hook: &mut dyn FnMut(&'static str) -> Result<(), ConnectError>,
) -> Result<(), ConnectError> {
    debug_assert_eq!(sha256_hex(BASELINE_SQL.as_bytes()), BASELINE_CHECKSUM);
    debug_assert_eq!(
        sha256_hex(MUTATION_JOURNAL_SQL.as_bytes()),
        MUTATION_JOURNAL_CHECKSUM
    );
    let had_database = path.metadata().is_ok_and(|metadata| metadata.len() > 0);
    let mut connection = open_database(path, false)?;
    configure_connection(path, &connection)?;

    if had_database {
        require_integrity(path, &connection, "before migration")?;
    }
    let mut found = schema_version(path, &connection)?;
    if found > LATEST_SCHEMA_VERSION {
        return Err(schema_incompatible(
            path,
            found,
            "the database was opened by a newer Connect build",
        ));
    }
    if found == LATEST_SCHEMA_VERSION {
        verify_ledger(path, &connection)?;
        enable_wal(path, &connection)?;
        require_integrity(path, &connection, "on open")?;
        return Ok(());
    }
    if found != 0 && found != 1 {
        return Err(schema_incompatible(
            path,
            found,
            "there is no migration path from this schema",
        ));
    }

    let mut backup_created = false;
    if found == 0 {
        let empty = database_is_empty(path, &connection)?;
        if had_database && !empty {
            require_beta28_schema(path, &connection)?;
            create_registry_backup(path, &connection, found)?;
            backup_created = true;
            hook("after_backup")?;
        }

        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| migration_error(path, 1, error))?;
        transaction
            .execute_batch(LEDGER_SQL)
            .map_err(|error| migration_error(path, 1, error))?;
        hook("after_ledger_schema")?;
        transaction
            .execute_batch(BASELINE_SQL)
            .map_err(|error| migration_error(path, 1, error))?;
        hook("after_baseline_schema")?;
        let started_at = Utc::now().to_rfc3339();
        transaction
            .execute(
                "INSERT INTO connect_schema_migrations
                 (version, name, checksum, state, started_at, completed_at)
                 VALUES (1, ?1, ?2, 'completed', ?3, ?3)",
                params![BASELINE_NAME, BASELINE_CHECKSUM, started_at],
            )
            .map_err(|error| migration_error(path, 1, error))?;
        hook("after_ledger_record")?;
        transaction
            .pragma_update(None, "user_version", 1)
            .map_err(|error| migration_error(path, 1, error))?;
        hook("after_user_version")?;
        transaction
            .commit()
            .map_err(|error| migration_error(path, 1, error))?;
        hook("after_commit")?;
        found = 1;
    }

    if found == 1 {
        if had_database && !backup_created {
            create_registry_backup(path, &connection, found)?;
            hook("after_mutation_journal_backup")?;
        }
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| migration_error(path, 2, error))?;
        transaction
            .execute_batch(MUTATION_JOURNAL_SQL)
            .map_err(|error| migration_error(path, 2, error))?;
        hook("after_mutation_journal_schema")?;
        let started_at = Utc::now().to_rfc3339();
        transaction
            .execute(
                "INSERT INTO connect_schema_migrations
                 (version, name, checksum, state, started_at, completed_at)
                 VALUES (2, ?1, ?2, 'completed', ?3, ?3)",
                params![MUTATION_JOURNAL_NAME, MUTATION_JOURNAL_CHECKSUM, started_at],
            )
            .map_err(|error| migration_error(path, 2, error))?;
        hook("after_mutation_journal_ledger")?;
        transaction
            .pragma_update(None, "user_version", LATEST_SCHEMA_VERSION)
            .map_err(|error| migration_error(path, 2, error))?;
        hook("after_mutation_journal_user_version")?;
        transaction
            .commit()
            .map_err(|error| migration_error(path, 2, error))?;
        hook("after_mutation_journal_commit")?;
    }

    enable_wal(path, &connection)?;
    require_integrity(path, &connection, "after migration")?;
    verify_ledger(path, &connection)?;
    Ok(())
}

impl CollectionRegistry {
    /// Privacy-safe registry diagnostics. No grants, record content, or receipts are exported.
    pub fn registry_diagnostics(
        state_dir: impl AsRef<Path>,
    ) -> Result<RegistryDiagnostics, ConnectError> {
        let state_dir = state_dir.as_ref();
        let database_path = state_dir.join("connector.sqlite");
        let connection = open_database(&database_path, true).ok();
        let schema_version = connection.as_ref().and_then(|value| {
            value
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .ok()
        });
        let quick_check = connection
            .as_ref()
            .and_then(|value| integrity_results(value, "quick_check").ok())
            .unwrap_or_else(|| vec!["database could not be read".to_string()]);
        let integrity_check = connection
            .as_ref()
            .and_then(|value| integrity_results(value, "integrity_check").ok())
            .unwrap_or_else(|| vec!["database could not be read".to_string()]);
        let backups = backup_diagnostics(state_dir)?;
        Ok(RegistryDiagnostics {
            database_path,
            schema_version,
            quick_check,
            integrity_check,
            backups,
        })
    }

    /// Restore a verified backup to a new path. The destination must not exist.
    pub fn restore_registry_backup(
        state_dir: impl AsRef<Path>,
        metadata_path: impl AsRef<Path>,
        destination: impl AsRef<Path>,
    ) -> Result<(), ConnectError> {
        restore_registry_backup(
            state_dir.as_ref(),
            metadata_path.as_ref(),
            destination.as_ref(),
        )
    }

    /// Deliberately rebuild SQLite indexes without discarding any table, grant, or receipt.
    pub fn rebuild_registry_indexes(state_dir: impl AsRef<Path>) -> Result<(), ConnectError> {
        let path = state_dir.as_ref().join("connector.sqlite");
        let connection = open_database(&path, false)?;
        configure_connection(&path, &connection)?;
        connection
            .execute_batch("REINDEX;")
            .map_err(|error| database_error(&path, error))?;
        require_integrity(&path, &connection, "after index rebuild")
    }
}

fn open_database(path: &Path, read_only: bool) -> Result<Connection, ConnectError> {
    let result = if read_only {
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
    } else {
        Connection::open(path)
    };
    result.map_err(|error| database_error(path, error))
}

fn configure_connection(path: &Path, connection: &Connection) -> Result<(), ConnectError> {
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| database_error(path, error))?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| database_error(path, error))
}

fn enable_wal(path: &Path, connection: &Connection) -> Result<(), ConnectError> {
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| database_error(path, error))
}

fn schema_version(path: &Path, connection: &Connection) -> Result<u32, ConnectError> {
    connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| database_error(path, error))
}

fn database_is_empty(path: &Path, connection: &Connection) -> Result<bool, ConnectError> {
    let count: u32 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| database_error(path, error))?;
    Ok(count == 0)
}

fn require_beta28_schema(path: &Path, connection: &Connection) -> Result<(), ConnectError> {
    let mut statement = connection
        .prepare(
            "SELECT name FROM sqlite_schema
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .map_err(|error| database_error(path, error))?;
    let tables = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| database_error(path, error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| database_error(path, error))?;
    if tables != BETA28_TABLES {
        return Err(schema_incompatible(
            path,
            0,
            "the unversioned database does not match the supported beta.28 table set",
        ));
    }
    for (table, required) in BETA28_SENTINEL_COLUMNS {
        let sql = format!("PRAGMA table_info({table})");
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| database_error(path, error))?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| database_error(path, error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| database_error(path, error))?;
        if required
            .iter()
            .any(|column| !columns.iter().any(|value| value == column))
        {
            return Err(schema_incompatible(
                path,
                0,
                &format!("the unversioned {table} table is older than beta.28"),
            ));
        }
    }
    Ok(())
}

fn verify_ledger(path: &Path, connection: &Connection) -> Result<(), ConnectError> {
    let mut statement = connection
        .prepare(
            "SELECT version, name, checksum, state
             FROM connect_schema_migrations ORDER BY version",
        )
        .map_err(|error| database_error(path, error))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, u32>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| database_error(path, error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| database_error(path, error))?;
    let expected = [
        (1, BASELINE_NAME, BASELINE_CHECKSUM, "completed"),
        (
            2,
            MUTATION_JOURNAL_NAME,
            MUTATION_JOURNAL_CHECKSUM,
            "completed",
        ),
    ];
    if rows.len() != expected.len()
        || rows
            .iter()
            .zip(expected)
            .any(|((version, name, checksum, state), expected)| {
                *version != expected.0
                    || name != expected.1
                    || checksum != expected.2
                    || state != expected.3
            })
    {
        return Err(schema_incompatible(
            path,
            LATEST_SCHEMA_VERSION,
            "the migration ledger is missing or its checksum/state does not match this build",
        ));
    }
    Ok(())
}

fn require_integrity(
    path: &Path,
    connection: &Connection,
    context: &str,
) -> Result<(), ConnectError> {
    let results = integrity_results(connection, "quick_check")
        .map_err(|error| database_error(path, error))?;
    if results.len() == 1 && results[0] == "ok" {
        return Ok(());
    }
    Err(ConnectError::RegistryCorrupt {
        path: path.to_path_buf(),
        detail: format!("{context}: {}", results.join("; ")),
    })
}

fn integrity_results(
    connection: &Connection,
    pragma: &str,
) -> Result<Vec<String>, rusqlite::Error> {
    let mut statement = connection.prepare(&format!("PRAGMA {pragma}"))?;
    let results = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(results)
}

fn create_registry_backup(
    database_path: &Path,
    source: &Connection,
    source_schema_version: u32,
) -> Result<RegistryBackupMetadata, ConnectError> {
    let state_dir = database_path
        .parent()
        .ok_or_else(|| ConnectError::RegistryBackupInvalid {
            path: database_path.to_path_buf(),
            detail: "database has no state directory".to_string(),
        })?;
    let backup_dir = state_dir.join(BACKUP_DIRECTORY);
    ensure_private_directory(&backup_dir)?;
    let created_at = Utc::now();
    let backup_file = format!(
        "connector-v{source_schema_version}-{}-{}.sqlite",
        created_at.timestamp_millis(),
        Uuid::new_v4()
    );
    let backup_path = backup_dir.join(&backup_file);
    create_private_file(&backup_path)?;
    let mut destination = open_database(&backup_path, false)?;
    {
        let backup = Backup::new(source, &mut destination)
            .map_err(|error| database_error(database_path, error))?;
        backup
            .run_to_completion(64, Duration::from_millis(10), None)
            .map_err(|error| database_error(database_path, error))?;
    }
    require_integrity(&backup_path, &destination, "backup verification")?;
    drop(destination);
    sync_file(&backup_path)?;
    let (byte_length, sha256) = file_digest(&backup_path)?;
    let mut metadata = RegistryBackupMetadata {
        format_version: BACKUP_FORMAT_VERSION,
        source_schema_version,
        created_at: created_at.to_rfc3339(),
        backup_file,
        byte_length,
        sha256,
        authentication: String::new(),
    };
    metadata.authentication = authenticate_metadata(state_dir, &metadata)?;
    let metadata_path = backup_path.with_extension("sqlite.json");
    write_private_json(&metadata_path, &metadata)?;
    sync_directory(&backup_dir)?;
    Ok(metadata)
}

fn backup_diagnostics(state_dir: &Path) -> Result<Vec<RegistryBackupDiagnostic>, ConnectError> {
    let backup_dir = state_dir.join(BACKUP_DIRECTORY);
    let Ok(entries) = fs::read_dir(&backup_dir) else {
        return Ok(Vec::new());
    };
    let mut diagnostics = Vec::new();
    for entry in entries {
        let path = entry?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        match verify_backup(state_dir, &path) {
            Ok((metadata, backup_path)) => diagnostics.push(RegistryBackupDiagnostic {
                metadata_path: path,
                backup_path,
                valid: true,
                detail: format!(
                    "verified schema {} backup from {}",
                    metadata.source_schema_version, metadata.created_at
                ),
            }),
            Err(error) => diagnostics.push(RegistryBackupDiagnostic {
                metadata_path: path.clone(),
                backup_path: PathBuf::new(),
                valid: false,
                detail: error.to_string(),
            }),
        }
    }
    diagnostics.sort_by(|left, right| left.metadata_path.cmp(&right.metadata_path));
    Ok(diagnostics)
}

fn restore_registry_backup(
    state_dir: &Path,
    metadata_path: &Path,
    destination: &Path,
) -> Result<(), ConnectError> {
    if destination.exists() {
        return Err(ConnectError::RegistryBackupInvalid {
            path: destination.to_path_buf(),
            detail: "restore destination already exists; preserve or move it first".to_string(),
        });
    }
    let (_, backup_path) = verify_backup(state_dir, metadata_path)?;
    let mut source = File::open(&backup_path)?;
    let mut target = private_file_options()
        .create_new(true)
        .write(true)
        .open(destination)?;
    if let Err(error) = std::io::copy(&mut source, &mut target).and_then(|_| target.sync_all()) {
        drop(target);
        let _ = fs::remove_file(destination);
        return Err(error.into());
    }
    drop(target);
    let restored = match open_database(destination, true) {
        Ok(value) => value,
        Err(error) => {
            let _ = fs::remove_file(destination);
            return Err(error);
        }
    };
    if let Err(error) = require_integrity(destination, &restored, "restored backup verification") {
        drop(restored);
        let _ = fs::remove_file(destination);
        return Err(error);
    }
    Ok(())
}

fn verify_backup(
    state_dir: &Path,
    metadata_path: &Path,
) -> Result<(RegistryBackupMetadata, PathBuf), ConnectError> {
    let bytes = fs::read(metadata_path)?;
    let metadata: RegistryBackupMetadata =
        serde_json::from_slice(&bytes).map_err(|error| ConnectError::RegistryBackupInvalid {
            path: metadata_path.to_path_buf(),
            detail: format!("metadata is not valid JSON: {error}"),
        })?;
    if metadata.format_version != BACKUP_FORMAT_VERSION {
        return Err(ConnectError::RegistryBackupInvalid {
            path: metadata_path.to_path_buf(),
            detail: format!("unsupported metadata version {}", metadata.format_version),
        });
    }
    let backup_name = Path::new(&metadata.backup_file);
    if backup_name.components().count() != 1 {
        return Err(ConnectError::RegistryBackupInvalid {
            path: metadata_path.to_path_buf(),
            detail: "backup filename is not local to the backup directory".to_string(),
        });
    }
    let expected_authentication = authenticate_metadata(
        state_dir,
        &RegistryBackupMetadata {
            authentication: String::new(),
            ..metadata.clone()
        },
    )?;
    if !constant_time_text_eq(&metadata.authentication, &expected_authentication) {
        return Err(ConnectError::RegistryBackupInvalid {
            path: metadata_path.to_path_buf(),
            detail: "metadata authentication failed".to_string(),
        });
    }
    let backup_path = state_dir.join(BACKUP_DIRECTORY).join(backup_name);
    let (byte_length, sha256) = file_digest(&backup_path)?;
    if byte_length != metadata.byte_length || sha256 != metadata.sha256 {
        return Err(ConnectError::RegistryBackupInvalid {
            path: backup_path,
            detail: "backup length or SHA-256 digest does not match authenticated metadata"
                .to_string(),
        });
    }
    Ok((metadata, backup_path))
}

fn authenticate_metadata(
    state_dir: &Path,
    metadata: &RegistryBackupMetadata,
) -> Result<String, ConnectError> {
    let key = backup_authentication_key(state_dir)?;
    let mut hmac = Hmac::<Sha256>::new_from_slice(&key).expect("HMAC accepts a 32-byte key");
    hmac.update(
        format!(
            "mdbase-connect registry backup metadata v1\0{}\0{}\0{}\0{}\0{}\0{}",
            metadata.format_version,
            metadata.source_schema_version,
            metadata.created_at,
            metadata.backup_file,
            metadata.byte_length,
            metadata.sha256
        )
        .as_bytes(),
    );
    Ok(hex_bytes(&hmac.finalize().into_bytes()))
}

fn backup_authentication_key(state_dir: &Path) -> Result<[u8; 32], ConnectError> {
    let path = state_dir.join(BACKUP_KEY_FILE);
    match fs::read(&path) {
        Ok(bytes) => {
            return bytes
                .try_into()
                .map_err(|_| ConnectError::RegistryBackupInvalid {
                    path,
                    detail: "backup authentication key has the wrong length".to_string(),
                })
        }
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
        Err(_) => {}
    }
    let mut key = [0_u8; 32];
    OsRng.fill_bytes(&mut key);
    match private_file_options()
        .create_new(true)
        .write(true)
        .open(&path)
    {
        Ok(mut file) => {
            file.write_all(&key)?;
            file.sync_all()?;
            sync_directory(state_dir)?;
            Ok(key)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let bytes = fs::read(&path)?;
            bytes
                .try_into()
                .map_err(|_| ConnectError::RegistryBackupInvalid {
                    path,
                    detail: "backup authentication key has the wrong length".to_string(),
                })
        }
        Err(error) => Err(error.into()),
    }
}

fn file_digest(path: &Path) -> Result<(u64, String), ConnectError> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut length = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        length += read as u64;
    }
    Ok((length, hex_bytes(&digest.finalize())))
}

fn write_private_json(path: &Path, value: &impl Serialize) -> Result<(), ConnectError> {
    let bytes = serde_json::to_vec_pretty(value)?;
    let mut file = private_file_options()
        .create_new(true)
        .write(true)
        .open(path)?;
    file.write_all(&bytes)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

fn create_private_file(path: &Path) -> Result<(), ConnectError> {
    private_file_options()
        .create_new(true)
        .write(true)
        .open(path)?
        .sync_all()?;
    Ok(())
}

fn private_file_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

fn ensure_private_directory(path: &Path) -> Result<(), ConnectError> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn sync_file(path: &Path) -> Result<(), ConnectError> {
    // Windows requires a write-capable handle for FlushFileBuffers. Opening
    // read-only happens to work on Unix but makes the same durability boundary
    // fail with ERROR_ACCESS_DENIED on Windows.
    OpenOptions::new().write(true).open(path)?.sync_all()?;
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), ConnectError> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    Ok(())
}

fn database_error(path: &Path, error: rusqlite::Error) -> ConnectError {
    match error.sqlite_error_code() {
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => ConnectError::RegistryBusy {
            path: path.to_path_buf(),
        },
        Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase) => {
            ConnectError::RegistryCorrupt {
                path: path.to_path_buf(),
                detail: error.to_string(),
            }
        }
        _ => ConnectError::Registry(error),
    }
}

fn migration_error(path: &Path, version: u32, error: rusqlite::Error) -> ConnectError {
    match database_error(path, error) {
        ConnectError::Registry(error) => ConnectError::RegistryMigration {
            path: path.to_path_buf(),
            version,
            detail: error.to_string(),
        },
        classified => classified,
    }
}

fn schema_incompatible(path: &Path, found: u32, detail: &str) -> ConnectError {
    ConnectError::RegistrySchemaIncompatible {
        path: path.to_path_buf(),
        found,
        supported: LATEST_SCHEMA_VERSION,
        detail: detail.to_string(),
    }
}

fn sha256_hex(value: &[u8]) -> String {
    hex_bytes(&Sha256::digest(value))
}

fn hex_bytes(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn constant_time_text_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.as_bytes()
        .iter()
        .zip(right.as_bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(test)]
mod tests;
