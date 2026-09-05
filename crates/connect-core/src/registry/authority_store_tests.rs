use super::*;
use tempfile::TempDir;

fn job(priority: AuthorityWritePriority) -> QueuedJob {
    QueuedJob {
        enqueued_at: Instant::now(),
        priority,
        execute: Box::new(|_| {}),
    }
}

#[test]
fn writer_queues_reserve_control_capacity_and_bound_control_bursts() {
    let mut queues = WriterQueues::default();
    for _ in 0..DATA_QUEUE_CAPACITY {
        queues.push(job(AuthorityWritePriority::Admission)).unwrap();
    }
    assert!(matches!(
        queues.push(job(AuthorityWritePriority::Recovery)),
        Err(ConnectError::AuthorityOverloaded)
    ));
    for _ in 0..CONTROL_QUEUE_CAPACITY {
        queues.push(job(AuthorityWritePriority::Control)).unwrap();
    }
    assert!(matches!(
        queues.push(job(AuthorityWritePriority::Control)),
        Err(ConnectError::AuthorityOverloaded)
    ));

    let mut control_burst = 0;
    for _ in 0..MAX_CONTROL_BURST {
        assert_eq!(
            queues.pop(&mut control_burst).unwrap().priority,
            AuthorityWritePriority::Control
        );
    }
    assert_eq!(
        queues.pop(&mut control_burst).unwrap().priority,
        AuthorityWritePriority::Admission
    );
    assert_eq!(
        queues.pop(&mut control_burst).unwrap().priority,
        AuthorityWritePriority::Control
    );
}

#[test]
fn beta49_grant_column_order_migrates_by_name_without_data_loss() {
    let state = TempDir::new().unwrap();
    let legacy = state.path().join("connector.sqlite");
    super::super::migrations::migrate_registry(&legacy).unwrap();
    let connection = Connection::open(&legacy).unwrap();
    connection
        .execute_batch(
            "DROP TABLE grants;
             CREATE TABLE grants (
                 id TEXT PRIMARY KEY,
                 application_id TEXT NOT NULL,
                 collection_id TEXT NOT NULL,
                 operations TEXT NOT NULL,
                 scope TEXT NOT NULL DEFAULT '{\"contracts\":[],\"access\":\"full_collection\"}',
                 application_name TEXT NOT NULL DEFAULT 'Application',
                 application_distribution TEXT NOT NULL DEFAULT 'web',
                 application_homepage TEXT NOT NULL DEFAULT '',
                 application_project_url TEXT,
                 application_origin TEXT NOT NULL DEFAULT '',
                 application_icon TEXT,
                 collection_name TEXT NOT NULL DEFAULT 'Collection',
                 notification_criteria TEXT NOT NULL DEFAULT '[]',
                 encryption TEXT,
                 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                 file_capability TEXT,
                 application_authorization TEXT
             );
             INSERT INTO grants (
                 id, application_id, collection_id, operations, scope,
                 application_name, application_distribution, application_homepage,
                 application_project_url, application_origin, application_icon,
                 collection_name, notification_criteria, encryption, created_at,
                 updated_at, file_capability, application_authorization
             ) VALUES (
                 '01922222-2222-7222-8222-222222222222',
                 'dev.mdbase.beta49-fixture',
                 '01911111-1111-7111-8111-111111111111',
                 '[\"read\",\"update\"]',
                 '{\"contracts\":[\"workout\"],\"access\":\"full_collection\"}',
                 'Beta 49 fixture', 'web', 'https://fixture.example',
                 'https://fixture.example/project', 'https://fixture.example',
                 'https://fixture.example/icon.png', 'Fixture collection',
                 '[{\"event\":\"record.updated\"}]',
                 '{\"algorithm\":\"x25519\"}',
                 '2026-01-02 03:04:05', '2026-02-03 04:05:06', NULL,
                 '{\"binding\":{\"protocol_version\":4}}'
             );",
        )
        .unwrap();
    let grant_columns = "id, application_id, collection_id, operations, scope, application_name,
         application_distribution, application_homepage, application_project_url,
         application_origin, application_icon, collection_name, notification_criteria,
         encryption, file_capability, application_authorization, created_at, updated_at";
    let legacy_grant = connection
        .query_row(&format!("SELECT {grant_columns} FROM grants"), [], |row| {
            (0..18)
                .map(|index| row.get::<_, Option<String>>(index))
                .collect::<Result<Vec<_>, _>>()
        })
        .unwrap();
    drop(connection);

    let authority = state.path().join("authority.sqlite");
    let receipts = state.path().join("authority-receipts");
    migrate_authority_store(state.path(), &legacy, &authority, &receipts).unwrap();
    migrate_authority_store(state.path(), &legacy, &authority, &receipts).unwrap();
    verify_authority_store(&authority).unwrap();

    let migrated = Connection::open(&authority).unwrap();
    let migrated_grant = migrated
        .query_row(&format!("SELECT {grant_columns} FROM grants"), [], |row| {
            (0..18)
                .map(|index| row.get::<_, Option<String>>(index))
                .collect::<Result<Vec<_>, _>>()
        })
        .unwrap();
    assert_eq!(migrated_grant, legacy_grant);
    assert_eq!(
        migrated.pragma_query_value(None, "integrity_check", |row| row.get::<_, String>(0)),
        Ok("ok".to_string())
    );
    assert_eq!(
        Connection::open(&legacy)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM grants", [], |row| row
                .get::<_, u32>(0))
            .unwrap(),
        1
    );
}

#[test]
fn every_authority_publication_phase_is_idempotent_after_interruption() {
    for fault in [
        "after_authority_schema",
        "after_authority_copy",
        "after_authority_receipts",
        "after_authority_wal",
        "after_authority_verification",
        "after_authority_publish",
        "after_authority_directory_sync",
    ] {
        let state = TempDir::new().unwrap();
        let legacy = state.path().join("connector.sqlite");
        super::super::migrations::migrate_registry(&legacy).unwrap();
        let authority = state.path().join("authority.sqlite");
        let receipts = state.path().join("authority-receipts");
        let result = migrate_authority_store_with_hook(
            state.path(),
            &legacy,
            &authority,
            &receipts,
            &mut |point| {
                if point == fault {
                    Err(ConnectError::AuthorityReceipt {
                        detail: format!("injected process death at {point}"),
                    })
                } else {
                    Ok(())
                }
            },
        );
        assert!(result.is_err(), "fault {fault} must stop the first open");
        migrate_authority_store(state.path(), &legacy, &authority, &receipts).unwrap();
        migrate_authority_store(state.path(), &legacy, &authority, &receipts).unwrap();
        verify_authority_store(&authority).unwrap();
        assert!(receipts.is_dir(), "fault {fault}");
        assert!(!state.path().join("authority.sqlite.migrating").exists());
    }
}
