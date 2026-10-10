//! Mirror-state readers against synthetic state in each of the three engine formats
//! (shapes from mdbase-connect@7d91bd3f: connect-mirror `lib.rs`, connect-agent
//! `mirrors.rs`, packages/sync `mirror-state.ts`/`sync-journal.ts`).
#![allow(clippy::disallowed_methods, clippy::disallowed_types, missing_docs)]

use std::fs;
use std::path::{Path, PathBuf};

use mdbn_legacy::mirror::{self, Engine, Queued};
use serde_json::json;

const CID: &str = "4c18af2e-b04a-4b77-b83e-493c3695962e";
const REP: &str = "0b9f3e7a-3c51-4a8e-9d2f-6e1b2c3d4e5f";
const R1: &str = "0192f0c1-7e1a-7b3c-8d4e-000000000001";
const R2: &str = "0192f0c1-7e1a-7b3c-8d4e-000000000002";
const R3: &str = "0192f0c1-7e1a-7b3c-8d4e-000000000003";

fn scratch(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join("mdbn-legacy-mirror")
        .join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn h(b: &[u8]) -> String {
    mdbn_legacy::revision_of(b)["sha256:".len()..].to_owned()
}

fn entry(path: &str, bytes: &[u8]) -> serde_json::Value {
    json!({"path": path, "revision": format!("sha256:{}", h(bytes)), "hash": h(bytes)})
}

/// Folder: a.md edited, b.md unchanged, c.md deleted, new.md created, temp files and
/// .mdbase ignored.
fn folder(root: &Path) {
    fs::create_dir_all(root.join("notes")).unwrap();
    fs::create_dir_all(root.join(".mdbase")).unwrap();
    fs::write(root.join("notes/a.md"), b"A edited").unwrap();
    fs::write(root.join("notes/b.md"), b"B").unwrap();
    fs::write(root.join("notes/new.md"), b"N").unwrap();
    fs::write(root.join("notes/.tmpAbc123"), b"x").unwrap();
    fs::write(root.join(".mdbase/connect-role.json"), b"{}").unwrap();
}

fn base_records() -> serde_json::Value {
    json!({
        R1: entry("notes/a.md", b"A"),
        R2: entry("notes/b.md", b"B"),
        R3: entry("notes/c.md", b"C"),
    })
}

#[test]
fn rust_v3_with_batch_in_flight() {
    let state_dir = scratch("rust-v3/state");
    let root = scratch("rust-v3/folder");
    folder(&root);
    fs::write(
        state_dir.join("mirrors.json"),
        json!({"version": 2, "mirrors": [{
            "collection_id": CID, "replica_id": REP, "name": "laptop", "mode": "read_write",
            "selective_sync": {"file_classes": [], "excluded_folders": []},
            "path": root, "sync_url": "https://x", "control_url": "https://x",
            "enrollment_id": "e", "access_token_expires_at": "2026-10-30T00:00:00Z",
            "created_at": "2026-09-01T00:00:00Z", "lifecycle": "active"}]})
        .to_string(),
    )
    .unwrap();
    let mdir = state_dir.join("mirrors").join(REP);
    fs::create_dir_all(&mdir).unwrap();
    // A batch uploading b.md (receipted in the journal) and a.md (not yet).
    let mutation = |id: &str, rid: &str, path: &str| {
        json!({"mutation_id": id, "replica_id": REP, "scope_epoch": 1, "operation": "put",
               "record_id": rid, "path": path, "document": "…", "created_at": "t"})
    };
    fs::write(
        mdir.join("state.json"),
        json!({
            "protocol_version": 1, "engine_version": 3, "generation": 4, "replica_id": REP,
            "scope_epoch": 1, "cursor": 17, "records": base_records(), "mode": "read_write",
            "last_completed_plan": "sha256:p0",
            "batch": {"phase": "applying", "plan": {"fingerprint": "sha256:p1",
                "actions": [{"action_id": "act-b"}, {"action_id": "act-a"}]},
                "next_action": 0, "receipts": [],
                "payloads": {"mutations": {
                    "act-b": mutation("m-b", R2, "notes/b.md"),
                    "act-a": mutation("m-a", R1, "notes/a.md")}},
                "checkpoint_before": {}, "checkpoint_after": {}}
        })
        .to_string(),
    )
    .unwrap();
    // The journal moves b.md's base to a new hash; then a torn final line.
    let receipt = json!({"event": "receipt", "plan_fingerprint": "sha256:p1",
        "receipt": {"action_id": "act-b", "status": "applied"},
        "delta": {"identity": R2, "state_identity": R2,
            "record": {"operation": "put", "value": entry("notes/b.md", b"B")},
            "resource": {"operation": "unchanged"}, "file": {"operation": "unchanged"},
            "conflict": {"operation": "unchanged"}, "binding": {"operation": "unchanged"}}});
    fs::write(
        mdir.join("state.journal.ndjson"),
        format!("{receipt}\n{{\"event\":\"phase\",\"plan_fi"),
    )
    .unwrap();

    let reg = mirror::read_registry(&state_dir).unwrap();
    assert_eq!(reg.len(), 1);
    assert_eq!(reg[0].path, root);
    assert_eq!(reg[0].lifecycle, "active");

    let st = mirror::read_rust_state(&state_dir, REP).unwrap().unwrap();
    assert_eq!(st.engine, Engine::RustV3);
    assert_eq!(st.cursor, 17);
    assert!(st.base_trusted);
    // Only act-a has no receipt.
    assert_eq!(st.unreceipted.len(), 1);
    assert_eq!(st.unreceipted[0].mutation_id, "m-a");

    let q = mirror::queued_writes(&st, &root).unwrap();
    assert!(q.contains(&Queued::Update {
        record_id: R1.into(),
        path: "notes/a.md".into(),
        revision: format!("sha256:{}", h(b"A edited"))
    }));
    assert!(q.contains(&Queued::Create {
        path: "notes/new.md".into(),
        revision: format!("sha256:{}", h(b"N"))
    }));
    assert!(q.contains(&Queued::Delete {
        record_id: R3.into(),
        path: "notes/c.md".into()
    }));
    assert_eq!(q.len(), 3, "{q:?}");
}

#[test]
fn rust_legacy_pending_queue() {
    let state_dir = scratch("rust-legacy");
    let mdir = state_dir.join("mirrors").join(REP);
    fs::create_dir_all(&mdir).unwrap();
    fs::write(
        mdir.join("state.json"),
        json!({"protocol_version": 1, "replica_id": REP, "scope_epoch": 1, "cursor": 74,
            "records": base_records(), "mode": "read_write",
            "pending": [{"mutation": {"mutation_id": "m1", "replica_id": REP, "scope_epoch": 1,
                "operation": "put", "record_id": R1, "input": {"path": "notes/a.md"},
                "created_at": "t"}, "local_path": "notes/a.md", "local_hash": h(b"A edited")}],
            "conflicts": {}, "local_issues": {}})
        .to_string(),
    )
    .unwrap();
    // A leftover temp file next to the state is ignored.
    fs::write(mdir.join(".tmpGgutjl"), b"{").unwrap();
    let st = mirror::read_rust_state(&state_dir, REP).unwrap().unwrap();
    assert_eq!(st.engine, Engine::RustLegacy);
    assert_eq!(st.cursor, 74);
    assert_eq!(st.unreceipted[0].path.as_deref(), Some("notes/a.md"));
}

#[test]
fn ts_cli_mirror_with_move() {
    let base = scratch("ts/base");
    let root = scratch("ts/folder");
    fs::create_dir_all(root.join("moved")).unwrap();
    fs::write(root.join("moved/a.md"), b"A").unwrap(); // a.md moved, unchanged
    fs::write(root.join("notes.md"), b"B").unwrap();
    let dir = base.join("mirrors").join("digest1");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("profile.json"),
        json!({"version": 1, "sync_url": "https://x", "collection_id": CID,
               "replica_id": REP, "mode": "read_only"})
        .to_string(),
    )
    .unwrap();
    fs::write(
        dir.join("credentials.json"),
        b"{\"access_token\":\"never-read\"}",
    )
    .unwrap();
    fs::write(
        dir.join("mirror-state.json"),
        json!({"protocol_version": 1, "engine_version": 3, "replica_id": REP, "scope_epoch": 1,
            "cursor": 3, "mode": "read_only",
            "records": {R1: entry("notes/a.md", b"A"), R2: entry("notes.md", b"B")},
            "selective_sync": {}})
        .to_string(),
    )
    .unwrap();
    let all = mirror::read_ts_mirrors(&base).unwrap();
    assert_eq!(all.len(), 1);
    let st = &all[0];
    assert_eq!(st.engine, Engine::TsV3);
    assert_eq!(st.collection_id.as_deref(), Some(CID));
    assert!(!st.base_trusted, "no last_completed_plan");
    let q = mirror::queued_writes(st, &root).unwrap();
    assert_eq!(
        q,
        vec![Queued::Update {
            record_id: R1.into(),
            path: "moved/a.md".into(),
            revision: format!("sha256:{}", h(b"A"))
        }]
    );
}

#[test]
fn malformed_state_errors_without_quoting_content() {
    let state_dir = scratch("bad");
    let mdir = state_dir.join("mirrors").join(REP);
    fs::create_dir_all(&mdir).unwrap();
    fs::write(
        mdir.join("state.json"),
        b"{\"records\": SECRET-DOCUMENT-TEXT",
    )
    .unwrap();
    let err = mirror::read_rust_state(&state_dir, REP)
        .unwrap_err()
        .to_string();
    assert!(!err.contains("SECRET"), "{err}");
    assert!(mirror::read_rust_state(&state_dir, "../escape").is_err());
    assert!(mirror::read_registry(&scratch("none")).unwrap().is_empty());
}

#[test]
fn malformed_rust_state_fields_never_become_empty_queues() {
    let state_dir = scratch("bad-fields");
    let mdir = state_dir.join("mirrors").join(REP);
    fs::create_dir_all(&mdir).unwrap();
    let legacy = json!({"replica_id": REP, "records": {}, "pending": []});
    let v3 = json!({"engine_version": 3, "replica_id": REP, "records": {},
        "batch": {"plan": {"fingerprint": "plan-1", "actions": []}, "next_action": 0, "receipts": [],
            "payloads": {"mutations": {}}}});
    let mut accepted = Vec::new();
    for (index, (template, pointer, bad)) in [
        (&legacy, "/engine_version", json!("SECRET-DOCUMENT-TEXT")),
        (&legacy, "/engine_version", json!(null)),
        (&legacy, "/engine_version", json!(true)),
        (&legacy, "/engine_version", json!(3.5)),
        (
            &legacy,
            "/pending",
            json!({"mutation": "SECRET-DOCUMENT-TEXT"}),
        ),
        (&legacy, "/pending", json!(null)),
        (&legacy, "/cursor", json!("SECRET-DOCUMENT-TEXT")),
        (&legacy, "/mode", json!("SECRET-DOCUMENT-TEXT")),
        (&v3, "/batch", json!("SECRET-DOCUMENT-TEXT")),
        (
            &v3,
            "/batch/receipts",
            json!({"action_id": "SECRET-DOCUMENT-TEXT"}),
        ),
        (&v3, "/batch/receipts", json!([{}])),
        (&v3, "/batch/receipts", json!([{"action_id": false}])),
        (&v3, "/batch/payloads", json!("SECRET-DOCUMENT-TEXT")),
        (
            &v3,
            "/batch/payloads/mutations",
            json!([{"document": "SECRET-DOCUMENT-TEXT"}]),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let mut state = template.clone();
        if let Some(value) = state.pointer_mut(pointer) {
            *value = bad;
        } else {
            state
                .as_object_mut()
                .unwrap()
                .insert(pointer[1..].into(), bad);
        }
        fs::write(mdir.join("state.json"), state.to_string()).unwrap();
        let result = mirror::read_rust_state(&state_dir, REP);
        match result {
            Ok(_) => accepted.push((index, pointer)),
            Err(error) => assert!(!error.to_string().contains("SECRET")),
        }
    }
    assert!(
        accepted.is_empty(),
        "malformed fields accepted: {accepted:?}"
    );
    for required in ["plan", "receipts", "payloads"] {
        let mut state = v3.clone();
        state["batch"].as_object_mut().unwrap().remove(required);
        fs::write(mdir.join("state.json"), state.to_string()).unwrap();
        assert!(
            mirror::read_rust_state(&state_dir, REP).is_err(),
            "missing {required} accepted"
        );
    }
    let mut resource_only = v3.clone();
    resource_only["batch"]["payloads"] = json!({});
    fs::write(mdir.join("state.json"), resource_only.to_string()).unwrap();
    assert!(
        mirror::read_rust_state(&state_dir, REP)
            .unwrap()
            .unwrap()
            .unreceipted
            .is_empty()
    );
    fs::write(mdir.join("state.json"), legacy.to_string()).unwrap();
    let state = mirror::read_rust_state(&state_dir, REP).unwrap().unwrap();
    assert!(state.unreceipted.is_empty());
    assert_eq!(state.engine, Engine::RustLegacy);
}

#[test]
fn malformed_ts_receipt_delta_never_erases_a_base_entry() {
    let base = scratch("bad-ts-delta");
    let dir = base.join("mirrors/digest");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("profile.json"),
        json!({"collection_id": CID}).to_string(),
    )
    .unwrap();
    fs::write(
        dir.join("mirror-state.json"),
        json!({
            "engine_version": 3, "replica_id": REP, "records": {R1: entry("a.md", b"A")},
            "batch": {"plan": {"fingerprint": "plan-1", "actions": [{"action_id": "act-a"}]},
                "next_action": 0, "receipts": [],
                "payloads": {"mutations": {}}}
        })
        .to_string(),
    )
    .unwrap();
    let mut accepted = 0;
    for delta in [
        json!({"records": []}),
        json!({"records": {R1: {"document": "SECRET-DOCUMENT-TEXT"}}}),
        json!(null),
    ] {
        let event = json!({"type": "receipt", "plan_fingerprint": "plan-1",
            "receipt": {"action_id": "act-a"}, "delta": delta});
        fs::write(dir.join("mirror-journal.ndjson"), format!("{event}\n")).unwrap();
        match mirror::read_ts_mirrors(&base) {
            Ok(_) => accepted += 1,
            Err(error) => assert!(!error.to_string().contains("SECRET")),
        }
    }
    assert_eq!(accepted, 0, "malformed deltas accepted");
}

#[test]
fn journals_match_engine_tail_and_plan_boundaries() {
    for ts in [false, true] {
        let base = scratch(if ts {
            "ts-journal-boundaries"
        } else {
            "rust-journal-boundaries"
        });
        let dir = if ts {
            base.join("mirrors/digest")
        } else {
            base.join("mirrors").join(REP)
        };
        fs::create_dir_all(&dir).unwrap();
        if ts {
            fs::write(
                dir.join("profile.json"),
                json!({"collection_id": CID}).to_string(),
            )
            .unwrap();
        }
        let state_file = dir.join(if ts {
            "mirror-state.json"
        } else {
            "state.json"
        });
        let journal = dir.join(if ts {
            "mirror-journal.ndjson"
        } else {
            "state.journal.ndjson"
        });
        fs::write(
            state_file,
            json!({"engine_version": 3, "replica_id": REP,
                "records": {R1: entry("a.md", b"A")},
                "batch": {"plan": {"fingerprint": "plan-1", "actions": [{"action_id": "act-a"}]},
                    "next_action": 0, "receipts": [],
                    "payloads": {"mutations": {"act-a": {"mutation_id": "m-a",
                        "record_id": R1, "operation": "put", "path": "a.md"}}}}
            })
            .to_string(),
        )
        .unwrap();
        let read = || {
            if ts {
                mirror::read_ts_mirrors(&base).map(|mut states| states.remove(0))
            } else {
                mirror::read_rust_state(&base, REP).map(Option::unwrap)
            }
        };
        let event = |plan: &str, remove: bool| {
            let delta = if ts {
                json!({"records": {R1: if remove { json!(null) } else { entry("a.md", b"B") }}})
            } else {
                json!({"state_identity": R1, "record": if remove {
                    json!({"operation": "remove"})
                } else { json!({"operation": "put", "value": entry("a.md", b"B")}) }})
            };
            let mut event = json!({"plan_fingerprint": plan, "receipt": {"action_id": "act-a"}, "delta": delta});
            event[if ts { "type" } else { "event" }] = json!("receipt");
            event.to_string()
        };
        fs::write(&journal, format!("{}\n", event("plan-1", false))).unwrap();
        let state = read().unwrap();
        assert!(state.unreceipted.is_empty());
        assert_eq!(state.records[R1].hash, h(b"B"));
        fs::write(&journal, event("plan-1", false)).unwrap();
        let state = read().unwrap();
        assert_eq!(state.unreceipted.len(), usize::from(!ts));
        assert_eq!(state.records[R1].hash, h(if ts { b"B" } else { b"A" }));
        fs::write(&journal, "{SECRET-DOCUMENT-TEXT").unwrap();
        assert_eq!(read().unwrap().unreceipted.len(), 1);
        // A partial multibyte write may leave non-UTF-8 in an uncommitted tail.
        fs::write(&journal, b"{\xff").unwrap();
        assert_eq!(read().unwrap().unreceipted.len(), 1);
        fs::write(&journal, b"{\xff\n").unwrap();
        assert!(read().is_err(), "completed non-UTF-8 line accepted");
        fs::write(&journal, "{SECRET-DOCUMENT-TEXT\n").unwrap();
        let error = read().unwrap_err().to_string();
        assert!(!error.contains("SECRET"));
        fs::write(&journal, format!("{}\n", event("foreign-plan", false))).unwrap();
        if ts {
            let state = read().unwrap();
            assert_eq!(state.unreceipted.len(), 1);
            assert_eq!(state.records[R1].hash, h(b"A"));
        } else {
            assert!(read().is_err());
        }
        fs::write(&journal, format!("{}\n", event("plan-1", true))).unwrap();
        assert!(!read().unwrap().records.contains_key(R1));
    }
}
