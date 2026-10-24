//! An old-agent-shaped device for the takeover tests: a connector state directory
//! built from the old connector's exact DDL (beta.104+: connector schema 3,
//! authority v5; `crates/legacy/fixtures`), and a folder with old engine
//! transactions caught mid-commit. Shared by the daemon's unit and integration tests.
#![allow(dead_code)]

use std::fs;
use std::path::Path;

use mdbn_legacy::revision_of;
use rusqlite::Connection;
use serde_json::json;

const FIX: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../legacy/fixtures/connect-sql"
);
pub const CID: &str = "4c18af2e-b04a-4b77-b83e-493c3695962e";
pub const RID: &str = "0192f0c1-7e1a-7b3c-8d4e-5f6a7b8c9d0e";

fn sql(rel: &str) -> String {
    fs::read_to_string(Path::new(FIX).join(rel)).unwrap()
}

fn conn(p: &Path) -> Connection {
    let c = Connection::open(p).unwrap();
    c.execute_batch("PRAGMA synchronous = OFF; PRAGMA journal_mode = DELETE;")
        .unwrap();
    c
}

fn journal(dir: &str, phase: &str, before: &[u8], after: &[u8], path: &str) -> serde_json::Value {
    json!({
        "version": 4, "id": dir, "scope": "records", "phase": phase, "applied": 0,
        "entries": [{"path": path, "before_revision": revision_of(before),
            "after_revision": revision_of(after), "stage_file": "stage/0",
            "backup_file": "backup/0"}],
        "host_claim": "ab".repeat(32), "mutation_digest": "sha256:00",
        "change_descriptor": {"schema_version": 1, "count": 0, "digest": "x"},
        "changes": [], "event_id": "e", "generation": null, "watermark": null,
        "resolution_acked": false, "event_acked": false})
}

/// One local collection `Notes` at `root`, registered in the old state at `old`:
/// a record ID for b.md, a grant, a completed (acknowledged) mutation with a stored
/// receipt and an in-flight (prepared) one. The folder has a.md mid-commit
/// (A1 → A2), c.md mid-commit but changed by the user since (diverged), and b.md.
pub fn build(old: &Path, root: &Path) {
    fs::create_dir_all(old).unwrap();
    fs::create_dir_all(root.join(".mdbase/transactions")).unwrap();

    fs::write(root.join("a.md"), b"A1").unwrap();
    fs::write(root.join("b.md"), b"B").unwrap();
    fs::write(root.join("c.md"), b"C user edit").unwrap();
    for (id, path, before, after) in [
        (
            "11111111111111111111111111111111",
            "a.md",
            &b"A1"[..],
            &b"A2"[..],
        ),
        ("22222222222222222222222222222222", "c.md", b"C1", b"C2"),
    ] {
        let t = root.join(".mdbase/transactions").join(id);
        fs::create_dir_all(t.join("stage")).unwrap();
        fs::create_dir_all(t.join("backup")).unwrap();
        fs::write(t.join("stage/0"), after).unwrap();
        fs::write(t.join("backup/0"), before).unwrap();
        fs::write(
            t.join("journal.json"),
            journal(id, "committing", before, after, path).to_string(),
        )
        .unwrap();
    }

    let c = conn(&old.join("connector.sqlite"));
    for f in [
        "0001_beta28_baseline.sql",
        "0002_durable_mutation_journal.sql",
        "0003_isolated_authority_cleanup.sql",
    ] {
        c.execute_batch(&sql(f)).unwrap();
    }
    c.pragma_update(None, "user_version", 3).unwrap();
    c.execute(
        "INSERT INTO collections (id, path, display_name, spec_version) VALUES (?1, ?2, 'Notes', '0.2.0')",
        [CID, root.to_str().unwrap()],
    )
    .unwrap();
    c.execute(
        "INSERT INTO local_sync_collections (collection_id, resource_revision) VALUES (?1, 'r')",
        [CID],
    )
    .unwrap();
    c.execute(
        "INSERT INTO local_sync_records (collection_id, record_id, path, revision, record) VALUES (?1, ?2, 'b.md', ?3, '{}')",
        [CID, RID, &revision_of(b"B")],
    )
    .unwrap();
    drop(c);
    let a = conn(&old.join("authority.sqlite"));
    for (i, f) in [
        "authority/0001_initial.sql",
        "authority/0002_legacy_read_receipts.sql",
        "authority/0003_policy_freshness_lease.sql",
        "authority/0004_application_declaration.sql",
        "authority/0005_local_runtime_claims.sql",
    ]
    .iter()
    .enumerate()
    {
        a.execute_batch(&sql(f)).unwrap();
        a.execute(
            "INSERT INTO authority_schema_migrations (version, name, checksum, applied_at_ms) VALUES (?1, ?2, 'x', 0)",
            rusqlite::params![i as i64 + 1, f],
        )
        .unwrap();
    }
    a.execute(
        "INSERT INTO grants (id, application_id, collection_id, operations, scope, application_name,
           application_distribution, application_homepage, application_origin, collection_name,
           notification_criteria, application_authorization, created_at)
         VALUES ('g1', 'app', ?1, '[]', '{}', 'App', 'web', '', '', 'Notes', '[]', '{}', 'now')",
        [CID],
    )
    .unwrap();
    let body = b"{\"protocol_version\":3,\"ciphertext\":\"opaque\"}";
    let digest = &revision_of(body)["sha256:".len()..];
    let rdir = old.join("authority-receipts").join(&digest[..2]);
    fs::create_dir_all(&rdir).unwrap();
    fs::write(rdir.join(format!("{}.receipt", &digest[2..])), body).unwrap();
    for (req, state, receipt) in [
        (
            "done",
            "completed",
            Some(format!("receipt-v1:sha256:{digest}:{}", body.len())),
        ),
        ("inflight", "prepared", None),
    ] {
        let terminal = state == "completed";
        a.execute(
            "INSERT INTO mutation_journal (application_installation_id, grant_id, request_id,
               operation_kind, input_schema_version, input_digest, state, process_epoch,
               lease_owner, lease_expires_at_ms, fencing_generation, final_receipt,
               receipt_digest, grant_snapshot_digest, accepted_at_ms, updated_at_ms,
               completed_at_ms)
             VALUES ('inst', 'g1', ?1, 'records.update', 1, 'd', ?2, 'e', 'o', 0, 1, ?3, ?4, 'g',
               1, 1, ?5)",
            rusqlite::params![
                req,
                state,
                receipt,
                terminal.then_some("x"),
                terminal.then_some(2i64)
            ],
        )
        .unwrap();
    }
    drop(a);
}
