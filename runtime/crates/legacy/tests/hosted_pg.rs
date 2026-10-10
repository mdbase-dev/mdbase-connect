//! The hosted reader against real Postgres with the exact provider schema
//! (`fixtures/provider-sql/`, vendored from mdbase-connect@7d91bd3f, migrations
//! 0001–0045).
//!
//! Needs `MDBN_TEST_PG_URL=<libpq url>` pointing at a **disposable** database. The
//! test creates and drops its own schema. Without the variable it skips, because CI has
//! no Postgres service yet (real Postgres only, no fakes).
#![cfg(feature = "pg")]
#![allow(clippy::disallowed_methods, clippy::disallowed_types, missing_docs)]

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use mdbn_legacy::hosted::source::{Change, HostedDb};
use mdbn_legacy::hosted::{LegacyMasterKey, Unwrapper, aad};
use mdbn_legacy::revision_of;

const CID: &str = "4c18af2e-b04a-4b77-b83e-493c3695962e";
const RID: &str = "0192f0c1-7e1a-7b3c-8d4e-5f6a7b8c9d0e";
const FID: &str = "0192f0c1-7e1a-7b3c-8d4e-000000000001";
const MIRROR: &str = "0b9f3e7a-3c51-4a8e-9d2f-6e1b2c3d4e5f";

fn seal(key: &[u8; 32], plain: &[u8], aad: &[u8], n: u8) -> Vec<u8> {
    let nonce = [n; 12];
    let ct = Aes256Gcm::new_from_slice(key)
        .unwrap()
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plain, aad })
        .unwrap();
    [vec![1u8], nonce.to_vec(), ct].concat()
}

fn record_json(doc: &str, path: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "record_id": RID, "path": path, "document": doc, "revision": revision_of(doc.as_bytes()),
        "frontmatter": {}, "body": doc, "types": []
    }))
    .unwrap()
}

#[test]
fn snapshot_and_changes_from_provider_schema() {
    let Ok(url) = std::env::var("MDBN_TEST_PG_URL") else {
        eprintln!("skipped: set MDBN_TEST_PG_URL to a disposable database");
        return;
    };
    let mut admin = postgres::Client::connect(&url, postgres::NoTls).unwrap();
    admin
        .batch_execute(
            "DROP SCHEMA IF EXISTS mdbn_legacy_test CASCADE; CREATE SCHEMA mdbn_legacy_test;",
        )
        .unwrap();
    admin
        .batch_execute("SET search_path = mdbn_legacy_test")
        .unwrap();
    // Runtime first: a test binary built on another machine (rcargo) runs here.
    let manifest = std::env::var("CARGO_MANIFEST_DIR")
        .unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_owned());
    let dir = format!("{manifest}/fixtures/provider-sql");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    for f in &files {
        // sqlx runs each migration in its own transaction.
        let sql = std::fs::read_to_string(f).unwrap();
        admin
            .batch_execute(&format!("BEGIN;\n{sql}\nCOMMIT;"))
            .unwrap_or_else(|e| panic!("{}: {e}", f.display()));
    }

    let master = [7u8; 32];
    let dek = [9u8; 32];
    let wrapped = seal(&master, &dek, &aad::collection_key(CID), 1);
    let doc1 = "# A\n";
    let doc2 = "# A edited\n";
    let png = b"\x89PNG fake".to_vec();
    admin
        .execute(
            "INSERT INTO hosted_provider_collections (id, template, spec_version, head,
               resource_revision, wrapped_data_key, resources_ciphertext, timezone,
               max_records, max_content_bytes, max_document_bytes, max_mirror_replicas,
               max_application_replicas)
             VALUES ($1::text::uuid, 'blank', '0.2.0', 3, 'r', $2, $3, 'UTC',
               100000, 1073741824, 2097152, 10, 10)",
            &[&CID, &wrapped, &seal(&dek, b"{}", &aad::resources(CID), 2)],
        )
        .unwrap();
    admin
        .execute(
            "INSERT INTO hosted_provider_resources (collection_id, path, kind, revision, document_ciphertext)
             VALUES ($1::text::uuid, 'mdbase.yaml', 'configuration', $2, $3)",
            &[
                &CID,
                &revision_of(b"spec_version: 0.2.0\n"),
                &seal(&dek, b"spec_version: 0.2.0\n", &aad::resource_document(CID, "mdbase.yaml"), 3),
            ],
        )
        .unwrap();
    admin
        .execute(
            "INSERT INTO hosted_provider_records (collection_id, record_id, path_token, revision,
               content_bytes, payload_ciphertext, sequence)
             VALUES ($1::text::uuid, $2::text::uuid, '\\x00', $3, 4, $4, 1)",
            &[
                &CID,
                &RID,
                &revision_of(doc1.as_bytes()),
                &seal(
                    &dek,
                    &record_json(doc1, "notes/a.md"),
                    &aad::current_record(CID, RID, 1),
                    4,
                ),
            ],
        )
        .unwrap();
    let file_payload = serde_json::to_vec(&serde_json::json!({
        "path": "att/a.png", "content_digest": revision_of(&png), "media_type": "image/png",
        "media_class": "image", "modified_at": "2026-10-01T00:00:00Z"
    }))
    .unwrap();
    admin
        .execute(
            "INSERT INTO hosted_provider_files (collection_id, file_id, path_token, revision, size,
               object_key, payload_ciphertext, sequence)
             VALUES ($1::text::uuid, $2::text::uuid, '\\x01', 'file:x', $3, 'v1/blobs/c/t.x', $4, 2)",
            &[
                &CID,
                &FID,
                &(png.len() as i64),
                &seal(&dek, &file_payload, &aad::current_file(CID, FID, 2), 5),
            ],
        )
        .unwrap();
    admin
        .execute(
            "INSERT INTO hosted_provider_replicas (id, collection_id, name, purpose, mode, token_hash)
             VALUES ($1::text::uuid, $2::text::uuid, 'laptop', 'mirror', 'read_write', '\\x02')",
            &[&MIRROR, &CID],
        )
        .unwrap();
    // A change after the snapshot point: the record was edited at sequence 3.
    admin
        .execute(
            "INSERT INTO hosted_provider_changes (collection_id, sequence, record_id, after_ciphertext, revision)
             VALUES ($1::text::uuid, 3, $2::text::uuid, $3, $4)",
            &[
                &CID,
                &RID,
                &seal(&dek, &record_json(doc2, "notes/a.md"), &aad::change_record(CID, 3, "after"), 6),
                &revision_of(doc2.as_bytes()),
            ],
        )
        .unwrap();

    // A superuser session is refused: the reader must use a SELECT-only role.
    let mut su = postgres::Client::connect(&url, postgres::NoTls).unwrap();
    su.batch_execute("SET search_path = mdbn_legacy_test")
        .unwrap();
    assert!(HostedDb::from_client(su).is_err());

    // The SELECT-only role, as sql/reader-role.sql creates it (in this test schema).
    admin
        .batch_execute(
            "DROP ROLE IF EXISTS mdbn_legacy_test_reader;
             CREATE ROLE mdbn_legacy_test_reader LOGIN PASSWORD 'reader' NOSUPERUSER NOINHERIT;
             GRANT USAGE ON SCHEMA mdbn_legacy_test TO mdbn_legacy_test_reader;
             GRANT SELECT ON hosted_provider_collections, hosted_provider_resources,
               hosted_provider_records, hosted_provider_files, hosted_provider_replicas,
               hosted_provider_changes, hosted_provider_file_changes,
               hosted_provider_resource_changes TO mdbn_legacy_test_reader;",
        )
        .unwrap();
    let mut cfg: postgres::Config = url.parse().unwrap();
    cfg.user("mdbn_legacy_test_reader").password("reader");
    let client = {
        let mut c = cfg.connect(postgres::NoTls).unwrap();
        c.batch_execute("SET search_path = mdbn_legacy_test")
            .unwrap();
        c
    };
    let mut db = HostedDb::from_client(client).unwrap();
    let mk = {
        use base64::Engine;
        LegacyMasterKey::from_base64(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(master),
        )
        .unwrap()
    };
    let keys = Unwrapper {
        legacy: Some(&mk),
        kms: None,
        environment: "local",
    };
    let snap = db.snapshot(CID, &keys).unwrap();
    assert_eq!(snap.collection.head, 3);
    assert_eq!(snap.records.len(), 1);
    assert_eq!(snap.records[0].document, doc1);
    assert_eq!(snap.resources[0].bytes, b"spec_version: 0.2.0\n");
    assert_eq!(snap.files[0].object_key, "v1/blobs/c/t.x");
    assert_eq!(snap.replicas.len(), 1);
    assert_eq!(snap.replicas[0].purpose, "mirror");

    let (head, changes) = db.changes_since(CID, 2, &keys).unwrap();
    assert_eq!(head, 3);
    assert!(
        matches!(&changes[..], [Change::Record { sequence: 3, after: Some(r), .. }] if r.document == doc2)
    );

    let totals = db.file_totals(Some(CID)).unwrap();
    assert_eq!((totals.files, totals.parts), (1, 1));

    // The reader's session setting refuses writes.
    let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
    c.batch_execute("SET default_transaction_read_only = on; SET search_path = mdbn_legacy_test")
        .unwrap();
    assert!(
        c.execute("DELETE FROM hosted_provider_records", &[])
            .is_err()
    );

    // A role that gains a write privilege is refused.
    admin
        .batch_execute("GRANT DELETE ON hosted_provider_records TO mdbn_legacy_test_reader")
        .unwrap();
    let mut c = cfg.connect(postgres::NoTls).unwrap();
    c.batch_execute("SET search_path = mdbn_legacy_test")
        .unwrap();
    assert!(HostedDb::from_client(c).is_err());

    drop(db);
    admin
        .batch_execute(
            "DROP SCHEMA mdbn_legacy_test CASCADE;
             DROP ROLE mdbn_legacy_test_reader;",
        )
        .unwrap();
}

/// Pre-history: version rows page in `(id, sequence)` order, bounded by `s0`, with
/// tombstones and live versions decoded under the version AADs, through the SELECT-only
/// role.
#[test]
fn version_pages_from_provider_schema() {
    let Ok(url) = std::env::var("MDBN_TEST_PG_URL") else {
        eprintln!("skipped: set MDBN_TEST_PG_URL to a disposable database");
        return;
    };
    let mut admin = postgres::Client::connect(&url, postgres::NoTls).unwrap();
    admin
        .batch_execute(
            "DROP SCHEMA IF EXISTS mdbn_legacy_versions_test CASCADE;
             CREATE SCHEMA mdbn_legacy_versions_test;",
        )
        .unwrap();
    admin
        .batch_execute("SET search_path = mdbn_legacy_versions_test")
        .unwrap();
    let manifest = std::env::var("CARGO_MANIFEST_DIR")
        .unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_owned());
    let dir = format!("{manifest}/fixtures/provider-sql");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    for f in &files {
        let sql = std::fs::read_to_string(f).unwrap();
        admin
            .batch_execute(&format!("BEGIN;\n{sql}\nCOMMIT;"))
            .unwrap_or_else(|e| panic!("{}: {e}", f.display()));
    }
    let master = [7u8; 32];
    let dek = [9u8; 32];
    let wrapped = seal(&master, &dek, &aad::collection_key(CID), 1);
    admin
        .execute(
            "INSERT INTO hosted_provider_collections (id, template, spec_version, head,
               resource_revision, wrapped_data_key, resources_ciphertext, timezone,
               max_records, max_content_bytes, max_document_bytes, max_mirror_replicas,
               max_application_replicas)
             VALUES ($1::text::uuid, 'blank', '0.2.0', 9, 'r', $2, $3, 'UTC',
               100000, 1073741824, 2097152, 10, 10)",
            &[&CID, &wrapped, &seal(&dek, b"{}", &aad::resources(CID), 2)],
        )
        .unwrap();
    // Record R: v1 live, v2 live, v3 tombstone, v10 beyond s0 (excluded).
    let docs = ["# v1\n", "# v2\n"];
    for (i, doc) in docs.iter().enumerate() {
        let seq = i as i64 + 1;
        admin
            .execute(
                "INSERT INTO hosted_provider_record_versions (collection_id, record_id, sequence,
                   revision, payload_ciphertext, deleted, created_at)
                 VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5, false,
                   to_timestamp(1790000000 + $3::bigint))",
                &[
                    &CID,
                    &RID,
                    &seq,
                    &revision_of(doc.as_bytes()),
                    &seal(
                        &dek,
                        &record_json(doc, "notes/a.md"),
                        &aad::record_version(CID, RID, seq as u64),
                        10 + i as u8,
                    ),
                ],
            )
            .unwrap();
    }
    admin
        .execute(
            "INSERT INTO hosted_provider_record_versions (collection_id, record_id, sequence,
               revision, payload_ciphertext, deleted, created_at)
             VALUES ($1::text::uuid, $2::text::uuid, 3, 'prev', NULL, true, to_timestamp(1790000003)),
                    ($1::text::uuid, $2::text::uuid, 10, 'late', NULL, true, to_timestamp(1790000010))",
            &[&CID, &RID],
        )
        .unwrap();
    // File F: v4 live, v5 tombstone.
    let fp = serde_json::to_vec(&serde_json::json!({
        "path": "att/a.png", "content_digest": revision_of(b"png"), "media_type": "image/png",
        "media_class": "image"
    }))
    .unwrap();
    admin
        .execute(
            "INSERT INTO hosted_provider_file_versions (collection_id, file_id, sequence, revision,
               size, object_key, payload_ciphertext, deleted, created_at)
             VALUES ($1::text::uuid, $2::text::uuid, 4, 'f4', 3, 'v1/blobs/c/old', $3, false,
               to_timestamp(1790000004)),
                    ($1::text::uuid, $2::text::uuid, 5, 'f5', NULL, NULL, NULL, true,
               to_timestamp(1790000005))",
            &[
                &CID,
                &FID,
                &seal(&dek, &fp, &aad::file_version(CID, FID, 4), 12),
            ],
        )
        .unwrap();
    admin
        .batch_execute(
            "DROP ROLE IF EXISTS mdbn_legacy_versions_reader;
             CREATE ROLE mdbn_legacy_versions_reader LOGIN PASSWORD 'reader' NOSUPERUSER NOINHERIT;
             GRANT USAGE ON SCHEMA mdbn_legacy_versions_test TO mdbn_legacy_versions_reader;
             GRANT SELECT ON hosted_provider_collections, hosted_provider_record_versions,
               hosted_provider_file_versions TO mdbn_legacy_versions_reader;",
        )
        .unwrap();
    let mut cfg: postgres::Config = url.parse().unwrap();
    cfg.user("mdbn_legacy_versions_reader").password("reader");
    let mut c = cfg.connect(postgres::NoTls).unwrap();
    c.batch_execute("SET search_path = mdbn_legacy_versions_test")
        .unwrap();
    let mut db = HostedDb::from_client(c).unwrap();
    let mk = {
        use base64::Engine;
        LegacyMasterKey::from_base64(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(master),
        )
        .unwrap()
    };
    let keys = Unwrapper {
        legacy: Some(&mk),
        kms: None,
        environment: "local",
    };
    let (row, key) = db.collection_key(CID, &keys).unwrap();
    assert_eq!(row.head, 9);
    // Pages of 2 at s0 = 9: v1, v2 | v3; v10 never appears.
    let p1 = db.record_versions(CID, &key, 9, None, 2).unwrap();
    assert_eq!(p1.len(), 2);
    assert_eq!(p1[0].sequence, 1);
    assert_eq!(p1[0].document.as_deref(), Some("# v1\n"));
    assert_eq!(p1[0].created_at_ms, 1_790_000_001_000);
    assert_eq!(p1[1].document.as_deref(), Some("# v2\n"));
    let last = (p1[1].record_id.as_str(), p1[1].sequence as i64);
    let p2 = db.record_versions(CID, &key, 9, Some(last), 2).unwrap();
    assert_eq!(p2.len(), 1);
    assert!(p2[0].deleted && p2[0].document.is_none());
    assert_eq!(p2[0].revision, "prev");
    assert!(
        db.record_versions(CID, &key, 9, Some((&p2[0].record_id, 3)), 2)
            .unwrap()
            .is_empty()
    );
    // s0 = 2 hides the tombstone at 3.
    assert_eq!(db.record_versions(CID, &key, 2, None, 10).unwrap().len(), 2);
    let fv = db.file_versions(CID, &key, 9, None, 10).unwrap();
    assert_eq!(fv.len(), 2);
    assert_eq!(fv[0].object_key.as_deref(), Some("v1/blobs/c/old"));
    assert_eq!(fv[0].size, Some(3));
    assert_eq!(
        fv[0].content_digest.as_deref(),
        Some(revision_of(b"png").as_str())
    );
    assert!(fv[1].deleted && fv[1].object_key.is_none());
    drop(db);
    admin
        .batch_execute(
            "DROP SCHEMA mdbn_legacy_versions_test CASCADE;
             DROP ROLE mdbn_legacy_versions_reader;",
        )
        .unwrap();
}
