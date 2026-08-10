use super::*;
use tempfile::TempDir;

const COLLECTION_ID: &str = "01911111-1111-7111-8111-111111111111";
const GRANT_ID: &str = "01922222-2222-7222-8222-222222222222";
const REQUEST_ID: &str = "01933333-3333-7333-8333-333333333333";

fn beta28_fixture(state_dir: &Path) -> Connection {
    fs::create_dir_all(state_dir).unwrap();
    let path = state_dir.join("connector.sqlite");
    let connection = Connection::open(path).unwrap();
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .unwrap();
    connection.execute_batch(BASELINE_SQL).unwrap();
    connection
        .execute(
            "INSERT INTO collections
             (id, path, display_name, description, spec_version)
             VALUES (?1, '/vault', 'Fixture', 'beta.28 data', '0.3.0')",
            [COLLECTION_ID],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO grants
             (id, application_id, collection_id, operations, scope,
              application_name, application_distribution, application_homepage,
              application_origin, collection_name, notification_criteria,
              application_authorization)
             VALUES (?1, 'dev.mdbase.fixture', ?2, '[\"read\",\"create\"]',
                     '{\"contracts\":[],\"access\":\"full_collection\"}',
                     'Fixture app', 'web', 'https://fixture.example',
                     'https://fixture.example', 'Fixture', '[]',
                     '{\"binding\":{\"protocol_version\":2}}')",
            params![GRANT_ID, COLLECTION_ID],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO activity
             (id, application_id, application_name, collection_id, collection_name,
              operation, outcome, detail)
             VALUES ('01944444-4444-7444-8444-444444444444', 'dev.mdbase.fixture',
                     'Fixture app', ?1, 'Fixture', 'create', 'succeeded', 'preserve me')",
            [COLLECTION_ID],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO grant_crypto_requests
             (grant_id, key_id, request_id, request_counter, request_fingerprint,
              response_envelope)
             VALUES (?1, 'key-1', ?2, '1', 'fingerprint', '{\"completed\":true}')",
            params![GRANT_ID, REQUEST_ID],
        )
        .unwrap();
    connection
}

fn schema1_fixture(state_dir: &Path) -> Connection {
    let connection = beta28_fixture(state_dir);
    connection.execute_batch(LEDGER_SQL).unwrap();
    let timestamp = Utc::now().to_rfc3339();
    connection
        .execute(
            "INSERT INTO connect_schema_migrations
             (version, name, checksum, state, started_at, completed_at)
             VALUES (1, ?1, ?2, 'completed', ?3, ?3)",
            params![BASELINE_NAME, BASELINE_CHECKSUM, timestamp],
        )
        .unwrap();
    connection.pragma_update(None, "user_version", 1).unwrap();
    connection
}

fn preserved_counts(path: &Path) -> (u32, u32, u32) {
    let connection = Connection::open(path).unwrap();
    (
        connection
            .query_row("SELECT COUNT(*) FROM grants", [], |row| row.get(0))
            .unwrap(),
        connection
            .query_row("SELECT COUNT(*) FROM activity", [], |row| row.get(0))
            .unwrap(),
        connection
            .query_row(
                "SELECT COUNT(*) FROM grant_crypto_requests WHERE response_envelope IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap(),
    )
}

fn split_counts(state_dir: &Path) -> (u32, u32, u32) {
    let authority = Connection::open(state_dir.join("authority.sqlite")).unwrap();
    let connector = Connection::open(state_dir.join("connector.sqlite")).unwrap();
    (
        authority
            .query_row("SELECT COUNT(*) FROM grants", [], |row| row.get(0))
            .unwrap(),
        connector
            .query_row("SELECT COUNT(*) FROM activity", [], |row| row.get(0))
            .unwrap(),
        authority
            .query_row("SELECT COUNT(*) FROM grant_crypto_requests", [], |row| {
                row.get(0)
            })
            .unwrap(),
    )
}

fn schema(path: &Path) -> Vec<(String, String, String)> {
    let connection = Connection::open(path).unwrap();
    let mut statement = connection
        .prepare(
            "SELECT type, name, sql FROM sqlite_schema
             WHERE sql IS NOT NULL ORDER BY type, name",
        )
        .unwrap();
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    rows
}

fn metadata_files(state_dir: &Path) -> Vec<PathBuf> {
    let mut paths = fs::read_dir(state_dir.join(BACKUP_DIRECTORY))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

#[test]
fn beta28_and_new_databases_converge_without_data_loss_and_reopen_twice() {
    let legacy = TempDir::new().unwrap();
    let legacy_connection = beta28_fixture(legacy.path());
    legacy_connection
        .execute(
            "INSERT INTO settings (key, value) VALUES ('wal-value', 'committed')",
            [],
        )
        .unwrap();
    assert!(legacy.path().join("connector.sqlite-wal").exists());

    migrate_registry(&legacy.path().join("connector.sqlite")).unwrap();
    assert_eq!(
        preserved_counts(&legacy.path().join("connector.sqlite")),
        (1, 1, 1)
    );
    let registry = CollectionRegistry::open(legacy.path()).unwrap();
    drop(registry);
    migrate_registry(&legacy.path().join("connector.sqlite")).unwrap();
    assert_eq!(split_counts(legacy.path()), (1, 1, 1));

    let new = TempDir::new().unwrap();
    drop(CollectionRegistry::open(new.path()).unwrap());
    assert_eq!(
        schema(&legacy.path().join("connector.sqlite")),
        schema(&new.path().join("connector.sqlite"))
    );

    let diagnostics = CollectionRegistry::registry_diagnostics(legacy.path()).unwrap();
    assert_eq!(diagnostics.schema_version, Some(LATEST_SCHEMA_VERSION));
    assert_eq!(diagnostics.quick_check, ["ok"]);
    assert_eq!(diagnostics.integrity_check, ["ok"]);
    assert_eq!(diagnostics.authority_schema_version, Some(2));
    assert_eq!(diagnostics.authority_quick_check, ["ok"]);
    assert_eq!(diagnostics.authority_integrity_check, ["ok"]);
    assert_eq!(diagnostics.authority_receipts.referenced_count, 0);
    assert_eq!(diagnostics.backups.len(), 2);
    assert!(diagnostics.backups.iter().all(|backup| backup.valid));

    let restored = legacy.path().join("restored.sqlite");
    CollectionRegistry::restore_registry_backup(
        legacy.path(),
        &diagnostics.backups[0].metadata_path,
        &restored,
    )
    .unwrap();
    assert_eq!(preserved_counts(&restored), (1, 1, 1));
    let restored_connection = Connection::open(restored).unwrap();
    assert_eq!(
        restored_connection
            .query_row(
                "SELECT value FROM settings WHERE key = 'wal-value'",
                [],
                |row| { row.get::<_, String>(0) }
            )
            .unwrap(),
        "committed"
    );
}

#[test]
fn every_transactional_migration_fault_recovers_and_is_idempotent() {
    for fault in [
        "after_backup",
        "after_ledger_schema",
        "after_baseline_schema",
        "after_ledger_record",
        "after_user_version",
        "after_commit",
    ] {
        let state = TempDir::new().unwrap();
        drop(beta28_fixture(state.path()));
        let database = state.path().join("connector.sqlite");
        let result = migrate_registry_with_hook(&database, &mut |point| {
            if point == fault {
                Err(ConnectError::RegistryMigration {
                    path: database.clone(),
                    version: 1,
                    detail: format!("injected process death at {point}"),
                })
            } else {
                Ok(())
            }
        });
        assert!(result.is_err(), "fault {fault} must stop the first open");
        migrate_registry(&database).unwrap();
        migrate_registry(&database).unwrap();
        assert_eq!(preserved_counts(&database), (1, 1, 1), "fault {fault}");
        let connection = Connection::open(database).unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
                .unwrap(),
            PRE_AUTHORITY_SCHEMA_VERSION,
            "fault {fault}"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM connect_schema_migrations
                     WHERE state = 'completed'",
                    [],
                    |row| row.get::<_, u32>(0),
                )
                .unwrap(),
            PRE_AUTHORITY_SCHEMA_VERSION,
            "fault {fault}"
        );
    }
}

#[test]
fn every_mutation_journal_migration_fault_recovers_and_preserves_legacy_receipts() {
    for fault in [
        "after_mutation_journal_backup",
        "after_mutation_journal_schema",
        "after_mutation_journal_ledger",
        "after_mutation_journal_user_version",
        "after_mutation_journal_commit",
    ] {
        let state = TempDir::new().unwrap();
        drop(schema1_fixture(state.path()));
        let database = state.path().join("connector.sqlite");
        let result = migrate_registry_with_hook(&database, &mut |point| {
            if point == fault {
                Err(ConnectError::RegistryMigration {
                    path: database.clone(),
                    version: 2,
                    detail: format!("injected process death at {point}"),
                })
            } else {
                Ok(())
            }
        });
        assert!(result.is_err(), "fault {fault} must stop the first open");
        migrate_registry(&database).unwrap();
        migrate_registry(&database).unwrap();
        assert_eq!(preserved_counts(&database), (1, 1, 1), "fault {fault}");
        let connection = Connection::open(database).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM legacy_encrypted_operation_receipts",
                    [],
                    |row| row.get::<_, u32>(0),
                )
                .unwrap(),
            1,
            "fault {fault}"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM connect_schema_migrations
                     WHERE state = 'completed'",
                    [],
                    |row| row.get::<_, u32>(0),
                )
                .unwrap(),
            PRE_AUTHORITY_SCHEMA_VERSION,
            "fault {fault}"
        );
    }
}

#[test]
fn every_authority_cleanup_fault_resumes_without_losing_either_store() {
    for fault in [
        "after_authority_cleanup_backup",
        "after_authority_cleanup_schema",
        "after_authority_cleanup_ledger",
        "after_authority_cleanup_user_version",
        "after_authority_cleanup_commit",
        "after_authority_cleanup_vacuum",
    ] {
        let state = TempDir::new().unwrap();
        drop(beta28_fixture(state.path()));
        let database = state.path().join("connector.sqlite");
        migrate_registry(&database).unwrap();
        drop(AuthorityStore::open(state.path(), &database).unwrap());

        let result = finalize_authority_split_with_hook(&database, &mut |point| {
            if point == fault {
                Err(ConnectError::RegistryMigration {
                    path: database.clone(),
                    version: LATEST_SCHEMA_VERSION,
                    detail: format!("injected process death at {point}"),
                })
            } else {
                Ok(())
            }
        });
        assert!(result.is_err(), "fault {fault} must stop the first open");

        drop(CollectionRegistry::open(state.path()).unwrap());
        drop(CollectionRegistry::open(state.path()).unwrap());
        assert_eq!(split_counts(state.path()), (1, 1, 1), "fault {fault}");
        let connector = Connection::open(&database).unwrap();
        let sensitive_tables: u32 = connector
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema
                 WHERE type = 'table' AND name IN (
                   'grants', 'grant_crypto_state', 'grant_crypto_requests',
                   'mutation_journal', 'mutation_journal_tombstones',
                   'revoked_grant_replay_material', 'legacy_encrypted_operation_receipts'
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sensitive_tables, 0, "fault {fault}");
        assert_eq!(
            connector
                .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
                .unwrap(),
            LATEST_SCHEMA_VERSION,
            "fault {fault}"
        );
        assert!(CollectionRegistry::registry_diagnostics(state.path())
            .unwrap()
            .backups
            .iter()
            .all(|backup| backup.valid));
    }
}

#[test]
fn corruption_incompatible_schema_and_tampered_ledger_fail_closed() {
    let corrupt = TempDir::new().unwrap();
    let corrupt_path = corrupt.path().join("connector.sqlite");
    fs::write(&corrupt_path, b"not a sqlite database").unwrap();
    let before = fs::read(&corrupt_path).unwrap();
    assert!(matches!(
        migrate_registry(&corrupt_path),
        Err(ConnectError::RegistryCorrupt { .. })
    ));
    assert_eq!(fs::read(&corrupt_path).unwrap(), before);
    assert!(!corrupt.path().join(BACKUP_DIRECTORY).exists());

    let future = TempDir::new().unwrap();
    let future_path = future.path().join("connector.sqlite");
    let connection = Connection::open(&future_path).unwrap();
    connection.pragma_update(None, "user_version", 99).unwrap();
    drop(connection);
    assert!(matches!(
        migrate_registry(&future_path),
        Err(ConnectError::RegistrySchemaIncompatible { found: 99, .. })
    ));

    let tampered = TempDir::new().unwrap();
    let tampered_path = tampered.path().join("connector.sqlite");
    migrate_registry(&tampered_path).unwrap();
    let connection = Connection::open(&tampered_path).unwrap();
    connection
        .execute(
            "UPDATE connect_schema_migrations SET checksum = 'tampered' WHERE version = 1",
            [],
        )
        .unwrap();
    drop(connection);
    assert!(matches!(
        migrate_registry(&tampered_path),
        Err(ConnectError::RegistrySchemaIncompatible {
            found: LATEST_SCHEMA_VERSION,
            ..
        })
    ));
}

#[test]
fn authenticated_backup_rejects_tampering_and_restore_overwrite() {
    let state = TempDir::new().unwrap();
    drop(beta28_fixture(state.path()));
    let database = state.path().join("connector.sqlite");
    migrate_registry(&database).unwrap();
    let metadata = metadata_files(state.path()).remove(0);
    let diagnostics = CollectionRegistry::registry_diagnostics(state.path()).unwrap();
    let backup = diagnostics.backups[0].backup_path.clone();

    assert!(matches!(
        CollectionRegistry::restore_registry_backup(state.path(), &metadata, &database),
        Err(ConnectError::RegistryBackupInvalid { .. })
    ));

    let mut bytes = fs::read(&backup).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    fs::write(&backup, bytes).unwrap();
    let destination = state.path().join("tampered-restore.sqlite");
    assert!(matches!(
        CollectionRegistry::restore_registry_backup(state.path(), &metadata, &destination),
        Err(ConnectError::RegistryBackupInvalid { .. })
    ));
    assert!(!destination.exists());
}

#[test]
fn old_unversioned_shapes_and_busy_errors_are_distinct() {
    let old = TempDir::new().unwrap();
    let old_path = old.path().join("connector.sqlite");
    let connection = Connection::open(&old_path).unwrap();
    connection
        .execute_batch("CREATE TABLE collections (id TEXT PRIMARY KEY);")
        .unwrap();
    drop(connection);
    assert!(matches!(
        migrate_registry(&old_path),
        Err(ConnectError::RegistrySchemaIncompatible { found: 0, .. })
    ));
    assert!(!old.path().join(BACKUP_DIRECTORY).exists());

    let sqlite_busy =
        rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY), None);
    assert!(matches!(
        database_error(&old_path, sqlite_busy),
        ConnectError::RegistryBusy { .. }
    ));
}

#[test]
fn deliberate_index_rebuild_preserves_authorization_and_receipts() {
    let state = TempDir::new().unwrap();
    drop(beta28_fixture(state.path()));
    migrate_registry(&state.path().join("connector.sqlite")).unwrap();
    CollectionRegistry::rebuild_registry_indexes(state.path()).unwrap();
    assert_eq!(
        preserved_counts(&state.path().join("connector.sqlite")),
        (1, 1, 1)
    );
}

#[cfg(unix)]
#[test]
fn backup_material_is_permission_restricted() {
    use std::os::unix::fs::PermissionsExt;

    let state = TempDir::new().unwrap();
    drop(beta28_fixture(state.path()));
    migrate_registry(&state.path().join("connector.sqlite")).unwrap();
    assert_eq!(
        fs::metadata(state.path().join(BACKUP_DIRECTORY))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(state.path().join(BACKUP_KEY_FILE))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    for entry in fs::read_dir(state.path().join(BACKUP_DIRECTORY)).unwrap() {
        assert_eq!(
            entry.unwrap().metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
