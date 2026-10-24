//! Read-only projection must match original-engine journal sequencing, not turn
//! complete corrupt receipts into loss-oracle evidence.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, missing_docs)]

use std::fs;
use std::path::{Path, PathBuf};

use mdbn_legacy::mirror::{self, MirrorState};
use serde_json::{Value, json};

const REP: &str = "0b9f3e7a-3c51-4a8e-9d2f-6e1b2c3d4e5f";
const RID: &str = "0192f0c1-7e1a-7b3c-8d4e-000000000001";

struct Fixture {
    ts: bool,
    base: PathBuf,
    dir: PathBuf,
}

fn entry(bytes: &[u8]) -> Value {
    let revision = mdbn_legacy::revision_of(bytes);
    json!({"path": "a.md", "hash": revision.strip_prefix("sha256:").unwrap(), "revision": revision})
}

impl Fixture {
    fn new(ts: bool, name: &str) -> Self {
        let base = Path::new(env!("CARGO_TARGET_TMPDIR"))
            .join("mirror-journal-order")
            .join(format!("{ts}-{name}"));
        let _ = fs::remove_dir_all(&base);
        let dir = base.join("mirrors").join(if ts { "digest" } else { REP });
        fs::create_dir_all(&dir).unwrap();
        if ts {
            fs::write(
                dir.join("profile.json"),
                r#"{"collection_id":"collection"}"#,
            )
            .unwrap();
        }
        Self { ts, base, dir }
    }

    fn state(next: Value, receipts: Value) -> Value {
        json!({"engine_version": 3, "replica_id": REP, "records": {RID: entry(b"A")},
            "batch": {"plan": {"fingerprint": "plan-1", "actions": [
                {"action_id": "act-a"}, {"action_id": "act-b"}]},
                "next_action": next, "receipts": receipts,
                "payloads": {"mutations": {
                    "act-a": {"mutation_id": "m-a", "operation": "put", "record_id": RID, "path": "a.md"},
                    "act-b": {"mutation_id": "m-b", "operation": "put", "record_id": RID, "path": "a.md"}}}}})
    }

    fn receipt(&self, action: &str, remove: bool) -> Value {
        let delta = if self.ts {
            json!({"records": {RID: if remove { json!(null) } else { entry(b"B") }}})
        } else {
            json!({"state_identity": RID, "record": if remove {
                json!({"operation": "remove"})
            } else { json!({"operation": "put", "value": entry(b"B")}) }})
        };
        let mut event =
            json!({"plan_fingerprint": "plan-1", "receipt": {"action_id": action}, "delta": delta});
        event[if self.ts { "type" } else { "event" }] = json!("receipt");
        event
    }

    fn read(&self, state: &Value, events: &[Value]) -> mdbn_legacy::Result<MirrorState> {
        fs::write(
            self.dir.join(if self.ts {
                "mirror-state.json"
            } else {
                "state.json"
            }),
            state.to_string(),
        )
        .unwrap();
        let journal: String = events.iter().map(|event| format!("{event}\n")).collect();
        fs::write(
            self.dir.join(if self.ts {
                "mirror-journal.ndjson"
            } else {
                "state.journal.ndjson"
            }),
            journal,
        )
        .unwrap();
        if self.ts {
            mirror::read_ts_mirrors(&self.base).map(|mut states| states.remove(0))
        } else {
            mirror::read_rust_state(&self.base, REP).map(Option::unwrap)
        }
    }
}

#[test]
fn out_of_order_receipt_never_becomes_base_or_suppresses_pending_write() {
    for ts in [false, true] {
        let f = Fixture::new(ts, "out-of-order");
        let error = f
            .read(
                &Fixture::state(json!(0), json!([])),
                &[f.receipt("act-b", true)],
            )
            .expect_err("out-of-order receipt accepted as oracle evidence");
        assert!(!error.to_string().contains("act-b"));
    }
}

#[test]
fn duplicate_journal_receipts_follow_engine_specific_replay() {
    for ts in [false, true] {
        let f = Fixture::new(ts, "duplicates");
        let state = Fixture::state(json!(0), json!([]));
        let result = f.read(
            &state,
            &[f.receipt("act-a", false), f.receipt("act-a", true)],
        );
        if ts {
            let restored = result.unwrap();
            assert_eq!(
                restored.records[RID].hash,
                entry(b"B")["hash"].as_str().unwrap()
            );
            assert_eq!(restored.unreceipted.len(), 1);
            assert_eq!(restored.unreceipted[0].mutation_id, "m-b");
        } else {
            assert!(
                result.is_err(),
                "Rust engine rejects duplicate/out-of-sequence receipt"
            );
        }
        let checkpoint = Fixture::state(json!(1), json!([{"action_id": "act-a"}]));
        let result = f.read(
            &checkpoint,
            &[f.receipt("act-a", true), f.receipt("act-b", false)],
        );
        if ts {
            let restored = result.unwrap();
            assert_eq!(
                restored.records[RID].hash,
                entry(b"B")["hash"].as_str().unwrap()
            );
            assert!(restored.unreceipted.is_empty());
        } else {
            assert!(result.is_err());
        }
    }
}

#[test]
fn completed_ts_plan_ignores_late_receipt_delta_but_rust_rejects() {
    for ts in [false, true] {
        let f = Fixture::new(ts, "completed");
        let checkpoint = Fixture::state(
            json!(2),
            json!([{"action_id": "act-a"}, {"action_id": "act-b"}]),
        );
        let result = f.read(&checkpoint, &[f.receipt("late-unknown", true)]);
        if ts {
            let restored = result.unwrap();
            assert_eq!(
                restored.records[RID].hash,
                entry(b"A")["hash"].as_str().unwrap()
            );
            assert!(restored.unreceipted.is_empty());
        } else {
            assert!(result.is_err());
        }
    }
}

#[test]
fn malformed_plan_actions_and_next_action_fail_without_source_values() {
    for ts in [false, true] {
        let f = Fixture::new(ts, "malformed");
        for next in [
            json!(null),
            json!(true),
            json!(-1),
            json!(0.5),
            json!(3),
            json!("SECRET-DOCUMENT-TEXT"),
        ] {
            let error = f.read(&Fixture::state(next, json!([])), &[]).unwrap_err();
            assert!(!error.to_string().contains("SECRET"));
        }
        for actions in [
            json!(null),
            json!({}),
            json!([{}]),
            json!([{"action_id": false}]),
        ] {
            let mut state = Fixture::state(json!(0), json!([]));
            state["batch"]["plan"]["actions"] = actions;
            assert!(f.read(&state, &[]).is_err());
        }
    }
}
