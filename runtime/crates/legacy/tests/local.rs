//! Readers against state directories built from the exact DDL old connectors ran
//! (`fixtures/connect-sql/`, vendored from mdbase-connect@7d91bd3f).
#![allow(clippy::disallowed_methods, clippy::disallowed_types, missing_docs)]

use std::fs;
use std::path::{Path, PathBuf};

use mdbn_legacy::connector::{ConnectorState, JournalState, Layout, ReceiptImport};
use mdbn_legacy::engine::{self, EntryState, Phase, Settlement};
use mdbn_legacy::{lock, marker, revision_of};
use rusqlite::Connection;

const FIX: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/connect-sql");
const CID: &str = "4c18af2e-b04a-4b77-b83e-493c3695962e";

/// A fresh directory under target/ (never /tmp).
fn scratch(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join("mdbn-legacy")
        .join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn sql(rel: &str) -> String {
    fs::read_to_string(Path::new(FIX).join(rel)).unwrap()
}

/// A writable fixture connection. Durability is irrelevant for fixtures, and fsync
/// per statement makes them take minutes on some filesystems.
fn fixture_conn(path: &Path) -> Connection {
    let c = Connection::open(path).unwrap();
    c.execute_batch("PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY;")
        .unwrap();
    c
}

fn connector_db(path: &Path, schema: u32) -> Connection {
    let c = fixture_conn(path);
    c.execute_batch(&sql("0001_beta28_baseline.sql")).unwrap();
    c.execute_batch(&sql("0002_durable_mutation_journal.sql"))
        .unwrap();
    if schema == 3 {
        c.execute_batch(&sql("0003_isolated_authority_cleanup.sql"))
            .unwrap();
    }
    c.pragma_update(None, "user_version", schema).unwrap();
    c.execute(
        "INSERT INTO collections (id, path, display_name, spec_version) VALUES (?1, '/x/notes', 'Notes', '0.2.0')",
        [CID],
    )
    .unwrap();
    c.execute(
        "INSERT INTO local_sync_collections (collection_id, resource_revision) VALUES (?1, 'r')",
        [CID],
    )
    .unwrap();
    for (rid, path, doc) in [
        (
            "0192f0c1-7e1a-7b3c-8d4e-5f6a7b8c9d0e",
            "notes/a.md",
            "# A\n",
        ),
        (
            "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
            "notes/b.md",
            "# B\n",
        ),
    ] {
        c.execute(
            "INSERT INTO local_sync_records (collection_id, record_id, path, revision, record) VALUES (?1, ?2, ?3, ?4, '{}')",
            [CID, rid, path, &revision_of(doc.as_bytes())],
        )
        .unwrap();
    }
    c
}

fn authority_db(path: &Path, version: u32) -> Connection {
    let c = fixture_conn(path);
    let files = [
        "authority/0001_initial.sql",
        "authority/0002_legacy_read_receipts.sql",
        "authority/0003_policy_freshness_lease.sql",
        "authority/0004_application_declaration.sql",
        "authority/0005_local_runtime_claims.sql",
    ];
    for (i, f) in files.iter().enumerate().take(version as usize) {
        c.execute_batch(&sql(f)).unwrap();
        c.execute(
            "INSERT INTO authority_schema_migrations (version, name, checksum, applied_at_ms) VALUES (?1, ?2, 'x', 0)",
            rusqlite::params![i as i64 + 1, f],
        )
        .unwrap();
    }
    c
}

fn insert_journal(c: &Connection, request: &str, state: &str, receipt: Option<&str>, extra: &str) {
    let terminal = matches!(
        state,
        "completed" | "acknowledged" | "abandoned" | "outcome_unknown"
    );
    c.execute(
        &format!(
            "INSERT INTO mutation_journal (application_installation_id, grant_id, request_id,
               operation_kind, input_schema_version, input_digest, state, process_epoch,
               lease_owner, lease_expires_at_ms, fencing_generation, prepared_data,
               result_metadata, final_receipt, receipt_digest, grant_snapshot_digest,
               accepted_at_ms, updated_at_ms, completed_at_ms, acknowledged_at_ms)
             VALUES ('inst', 'grant', ?1, 'records.create', 1, 'digest', ?2, 'e', 'o', 0, 1,
               {extra}, ?3, ?4, 'g', 1, 1, ?5, ?6)"
        ),
        rusqlite::params![
            request,
            state,
            receipt,
            terminal.then_some("d"),
            terminal.then_some(2i64),
            (state == "acknowledged").then_some(3i64),
        ],
    )
    .unwrap();
}

fn file_sha(path: &Path) -> String {
    revision_of(&fs::read(path).unwrap())
}

#[test]
fn schema2_layout_with_inline_receipts() {
    let dir = scratch("schema2");
    let c = connector_db(&dir.join("connector.sqlite"), 2);
    insert_journal(
        &c,
        "r1",
        "completed",
        Some("{\"protocol_version\":3}"),
        "NULL, NULL",
    );
    insert_journal(
        &c,
        "r2",
        "prepared",
        None,
        "'{\"host_claim\":\"hc\"}', NULL",
    );
    insert_journal(&c, "r3", "abandoned", Some("{}"), "NULL, NULL");
    drop(c);
    let before = file_sha(&dir.join("connector.sqlite"));

    let s = ConnectorState::open(&dir).unwrap();
    assert_eq!(s.layout(), Layout::Schema2);
    let cols = s.collections().unwrap();
    assert_eq!(cols.len(), 1);
    assert_eq!(cols[0].authority_state.as_deref(), Some("active"));
    let ids = s.record_ids(CID).unwrap();
    assert_eq!(ids.len(), 2);
    assert_eq!(ids[0].path, "notes/a.md");

    let rows = s.journal().unwrap();
    assert_eq!(rows.len(), 3);
    let by = |r: &str| rows.iter().find(|x| x.request_id == r).unwrap();
    assert_eq!(by("r2").state, JournalState::Prepared);
    assert_eq!(by("r2").host_claim().as_deref(), Some("hc"));
    assert_eq!(
        s.receipt_import(by("r1")).0,
        ReceiptImport::Receipt(b"{\"protocol_version\":3}".to_vec())
    );
    assert_eq!(s.receipt_import(by("r2")).0, ReceiptImport::OutcomeUnknown);
    assert_eq!(s.receipt_import(by("r3")).0, ReceiptImport::NotSent);
    drop(s);
    assert_eq!(
        before,
        file_sha(&dir.join("connector.sqlite")),
        "reader wrote"
    );
}

#[test]
fn split_layout_every_authority_version() {
    for version in 1..=5 {
        let dir = scratch(&format!("split-v{version}"));
        drop(connector_db(&dir.join("connector.sqlite"), 3));
        let a = authority_db(&dir.join("authority.sqlite"), version);

        // A stored receipt, an applied row with a response receipt, and a dangling one.
        let body = b"{\"protocol_version\":3,\"ciphertext\":\"...\"}";
        let digest = revision_of(body)["sha256:".len()..].to_owned();
        let rdir = dir.join("authority-receipts").join(&digest[..2]);
        fs::create_dir_all(&rdir).unwrap();
        fs::write(rdir.join(format!("{}.receipt", &digest[2..])), body).unwrap();
        let reference = format!("receipt-v1:sha256:{digest}:{}", body.len());
        insert_journal(&a, "done", "completed", Some(&reference), "NULL, NULL");
        let meta = format!("NULL, '{{\"response_receipt\":\"{reference}\"}}'");
        insert_journal(&a, "applied", "applied", None, &meta);
        let dangling = format!("receipt-v1:sha256:{}:5", "0".repeat(64));
        insert_journal(&a, "lost", "completed", Some(&dangling), "NULL, NULL");
        drop(a);

        let s = ConnectorState::open(&dir).unwrap();
        assert_eq!(
            s.layout(),
            Layout::Split {
                connector_schema: 3,
                authority_version: version
            }
        );
        let rows = s.journal().unwrap();
        let by = |r: &str| rows.iter().find(|x| x.request_id == r).unwrap();
        assert_eq!(
            s.receipt_import(by("done")).0,
            ReceiptImport::Receipt(body.to_vec())
        );
        assert_eq!(
            s.receipt_import(by("applied")).0,
            ReceiptImport::Receipt(body.to_vec())
        );
        let (imp, err) = s.receipt_import(by("lost"));
        assert_eq!(imp, ReceiptImport::OutcomeUnknown);
        assert!(err.is_some());
        assert!(s.tombstones().unwrap().is_empty());
    }
}

#[test]
fn interrupted_cleanup_uses_authority() {
    let dir = scratch("interrupted");
    let c = connector_db(&dir.join("connector.sqlite"), 2);
    insert_journal(&c, "stale-copy", "completed", Some("{}"), "NULL, NULL");
    drop(c);
    let a = authority_db(&dir.join("authority.sqlite"), 5);
    insert_journal(&a, "canonical", "completed", Some("{}"), "NULL, NULL");
    drop(a);
    let s = ConnectorState::open(&dir).unwrap();
    assert!(matches!(
        s.layout(),
        Layout::Split {
            connector_schema: 2,
            ..
        }
    ));
    let rows = s.journal().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].request_id, "canonical");
}

#[test]
fn unsupported_layouts_fail() {
    let dir = scratch("schema3-no-authority");
    drop(connector_db(&dir.join("connector.sqlite"), 3));
    assert!(ConnectorState::open(&dir).is_err());
    let dir = scratch("empty");
    assert!(ConnectorState::open(&dir).is_err());
}

#[test]
fn folder_collection_id_from_mdbase_yaml() {
    let dir = scratch("yaml");
    fs::write(
        dir.join("mdbase.yaml"),
        format!("spec_version: 0.2.0\nx-mdbase-connect:\n  collection_id: {CID}\nother: 1\n"),
    )
    .unwrap();
    assert_eq!(
        ConnectorState::folder_collection_id(&dir)
            .unwrap()
            .as_deref(),
        Some(CID)
    );
    fs::write(dir.join("mdbase.yaml"), "spec_version: 0.2.0\n").unwrap();
    assert_eq!(ConnectorState::folder_collection_id(&dir).unwrap(), None);
}

/// Write a transaction directory the way mdbase-rs does.
fn write_txn(root: &Path, id: &str, journal: serde_json::Value, staged: &[(usize, &[u8])]) {
    let dir = root.join(".mdbase/transactions").join(id);
    fs::create_dir_all(dir.join("stage")).unwrap();
    for (i, b) in staged {
        fs::write(dir.join("stage").join(i.to_string()), b).unwrap();
    }
    fs::write(dir.join("journal.json"), journal.to_string()).unwrap();
}

fn entry(i: usize, path: &str, before: Option<&[u8]>, after: Option<&[u8]>) -> serde_json::Value {
    serde_json::json!({
        "path": path,
        "before_revision": before.map(revision_of),
        "after_revision": after.map(revision_of),
        "stage_file": after.map(|_| format!("stage/{i}")),
        "backup_file": before.map(|_| format!("backup/{i}")),
    })
}

fn runtime_journal(
    id: &str,
    version: u32,
    phase: &str,
    entries: Vec<serde_json::Value>,
) -> serde_json::Value {
    serde_json::json!({
        "version": version, "id": id, "scope": "records", "phase": phase, "applied": 0,
        "entries": entries, "host_claim": "ab".repeat(32), "mutation_digest": "sha256:00",
        "change_descriptor": {"schema_version": 1, "count": 0, "digest": "x"},
        "changes": [], "event_id": "e", "generation": null, "watermark": null,
        "resolution_acked": false, "event_acked": false,
    })
}

#[test]
fn engine_settlement_matches_old_recovery() {
    let root = scratch("engine");
    fs::create_dir_all(root.join("notes")).unwrap();
    // a.md already applied, b.md still old, c.md changed by someone else.
    fs::write(root.join("notes/a.md"), b"A2").unwrap();
    fs::write(root.join("notes/b.md"), b"B1").unwrap();
    fs::write(root.join("notes/c.md"), b"C-user").unwrap();

    let id1 = "11111111111111111111111111111111";
    write_txn(
        &root,
        id1,
        runtime_journal(
            id1,
            4,
            "committing",
            vec![
                entry(0, "notes/a.md", Some(b"A1"), Some(b"A2")),
                entry(1, "notes/b.md", Some(b"B1"), Some(b"B2")),
            ],
        ),
        &[(0, b"A2"), (1, b"B2")],
    );
    let id2 = "22222222222222222222222222222222";
    write_txn(
        &root,
        id2,
        runtime_journal(
            id2,
            2,
            "committing",
            vec![entry(0, "notes/c.md", Some(b"C1"), Some(b"C2"))],
        ),
        &[(0, b"C2")],
    );
    let id3 = "33333333333333333333333333333333";
    write_txn(
        &root,
        id3,
        runtime_journal(
            id3,
            3,
            "prepared",
            vec![entry(0, "notes/b.md", Some(b"B1"), Some(b"B9"))],
        ),
        &[(0, b"B9")],
    );
    // v1 shadow, prepared but partly applied: the old engine rolls it forward.
    let id4 = "44444444444444444444444444444444";
    write_txn(
        &root,
        id4,
        serde_json::json!({"version": 1, "id": id4, "scope": "records", "phase": "prepared",
            "applied": 1, "entries": [entry(0, "notes/a.md", Some(b"A1"), Some(b"A2")),
                                       entry(1, "notes/new.md", None, Some(b"N"))]}),
        &[(0, b"A2"), (1, b"N")],
    );

    let txns = engine::scan(&root).unwrap();
    assert_eq!(txns.len(), 4);
    let t = |id: &str| txns.iter().find(|t| t.id == id).unwrap();
    assert_eq!(t(id1).phase, Phase::Committing);
    assert_eq!(t(id1).entry_state(&root, 0).unwrap(), EntryState::AtAfter);
    assert_eq!(
        t(id1).settlement(&root).unwrap(),
        Settlement::RollForward(vec![1])
    );
    assert_eq!(t(id1).staged_bytes(1).unwrap().as_deref(), Some(&b"B2"[..]));
    assert_eq!(
        t(id2).settlement(&root).unwrap(),
        Settlement::Diverged(vec![0])
    );
    assert_eq!(t(id3).settlement(&root).unwrap(), Settlement::Nothing);
    assert_eq!(
        t(id4).settlement(&root).unwrap(),
        Settlement::RollForward(vec![1])
    );

    // Reading never changed a file.
    assert_eq!(fs::read(root.join("notes/b.md")).unwrap(), b"B1");
}

#[test]
fn engine_rejects_malformed_journals() {
    let root = scratch("engine-bad");
    let id = "55555555555555555555555555555555";
    // Escaping path.
    write_txn(
        &root,
        id,
        runtime_journal(
            id,
            4,
            "committing",
            vec![entry(0, "../outside.md", None, Some(b"x"))],
        ),
        &[(0, b"x")],
    );
    assert!(engine::scan(&root).is_err());
    // Id/directory mismatch.
    let root = scratch("engine-bad-id");
    write_txn(
        &root,
        id,
        runtime_journal("66666666666666666666666666666666", 4, "committed", vec![]),
        &[],
    );
    assert!(engine::scan(&root).is_err());
    // Corrupt stage bytes are refused when read.
    let root = scratch("engine-bad-stage");
    write_txn(
        &root,
        id,
        runtime_journal(
            id,
            4,
            "committing",
            vec![entry(0, "a.md", None, Some(b"good"))],
        ),
        &[(0, b"tampered")],
    );
    let txns = engine::scan(&root).unwrap();
    assert!(txns[0].staged_bytes(0).is_err());
}

#[test]
fn markers_on_disk() {
    let root = scratch("marker");
    assert_eq!(marker::read(&root).unwrap(), marker::Marker::Absent);
    fs::create_dir_all(root.join(".mdbase")).unwrap();
    fs::write(
        root.join(".mdbase/connect-role.json"),
        format!(
            "{{\n  \"version\": 1,\n  \"role\": \"mirror\",\n  \"collection_id\": \"{CID}\"\n}}\n"
        ),
    )
    .unwrap();
    assert_eq!(
        marker::read(&root).unwrap(),
        marker::Marker::Mirror {
            collection_id: CID.into()
        }
    );
    fs::remove_file(root.join(".mdbase/connect-role.json")).unwrap();
    fs::create_dir(root.join(".mdbase/connect-role.json")).unwrap();
    assert!(matches!(
        marker::read(&root).unwrap(),
        marker::Marker::Invalid(_)
    ));
}

#[test]
fn daemon_lock_excludes_a_second_holder() {
    let dir = scratch("lock");
    let path = lock::daemon_lock_path(&dir);
    let held = lock::try_exclusive(&path).unwrap().expect("free");
    // A second open file description is refused, as a starting old daemon would be.
    assert!(lock::try_exclusive(&path).unwrap().is_none());
    drop(held);
    assert!(lock::try_exclusive(&path).unwrap().is_some());
}

#[test]
fn grant_state_and_backup_leave_originals_untouched() {
    let dir = scratch("grants");
    drop(connector_db(&dir.join("connector.sqlite"), 3));
    let a = authority_db(&dir.join("authority.sqlite"), 5);
    a.execute(
        "INSERT INTO grants (id, application_id, collection_id, operations, scope, application_name,
           application_distribution, application_homepage, application_origin, collection_name,
           notification_criteria, encryption, application_authorization, created_at)
         VALUES ('g1', 'app', ?1, '[\"records.read\"]', '{}', 'App', 'web', '', '', 'Notes', '[]',
           '{\"key_id\":\"k1\"}', '{}', 'now')",
        [CID],
    )
    .unwrap();
    a.execute(
        "INSERT INTO grant_crypto_state (grant_id, key_id, last_request_counter) VALUES ('g1', 'k1', '41')",
        [],
    )
    .unwrap();
    a.execute(
        "INSERT INTO collection_access_overlays (collection_id, enabled, updated_at_ms) VALUES (?1, 1, 0)",
        [CID],
    )
    .unwrap();
    a.execute(
        "INSERT INTO authority_settings (key, value, updated_at_ms) VALUES ('access_paused', 'false', 0)",
        [],
    )
    .unwrap();
    drop(a);
    let before = (
        file_sha(&dir.join("connector.sqlite")),
        file_sha(&dir.join("authority.sqlite")),
    );

    let s = ConnectorState::open(&dir).unwrap();
    let g = s.grant_state(CID).unwrap();
    assert_eq!(g.grants.len(), 1);
    assert_eq!(g.grants[0]["id"], "g1");
    assert_eq!(g.crypto_state[0]["last_request_counter"], "41");
    assert_eq!(g.overlay_enabled, Some(true));
    assert_eq!(g.access_paused, Some(false));
    assert!(s.grant_state("other").unwrap().grants.is_empty());

    let out = dir.join("evidence");
    let files = s.backup_to(&out).unwrap();
    assert_eq!(files.len(), 2);
    drop(s);
    // The copy is a complete, readable state directory of its own.
    let copy = ConnectorState::open(&out).unwrap();
    assert_eq!(copy.grant_state(CID).unwrap().grants.len(), 1);
    assert_eq!(
        before,
        (
            file_sha(&dir.join("connector.sqlite")),
            file_sha(&dir.join("authority.sqlite"))
        ),
        "originals unchanged"
    );
}
