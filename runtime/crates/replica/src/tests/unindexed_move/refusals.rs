//! Pure verified-stage boundary fixtures: outside-matrix recovery stays owned.
use super::*;
use crate::store::{RecordMeta, RecordRow, TombstoneLast, TombstoneRow, bucket16};
use mdbn_wire::{
    client::{Hold, HoldReason},
    snapshot::{EntityKind, TextOrBlob},
};

#[test]
fn native_move_recovery_refuses_lifecycle_authority_and_fence_drift_without_resolution() {
    for case in [
        "record",
        "native_tomb",
        "record_tomb",
        "hold",
        "unkeyed",
        "epoch",
        "policy_ahead",
        "not_caught_up",
        "blocked",
        "fault",
        "rekey",
        "lost_control",
        "path",
        "missing_fence",
        "corrupt_fence",
        "wrong_file",
        "wrong_from",
        "wrong_to",
        "update_refs",
        "prior_cas",
        "grant",
        "origin",
    ] {
        let (_svc, mut a, mut b) = pair();
        let id = native(&mut a, &mut b);
        a.r.test_capture_native_move(id, "before.md", "after.md")
            .unwrap();
        let original = a.r.store.pending(None, 10).unwrap().remove(0);
        a.r.resurrected.insert(original.mutation.id, a.r.head().seq);
        let current = a.r.store.file(&id).unwrap().unwrap();
        let mut checked = original.clone();
        match case {
            "record" => {
                a.r.store
                    .commit(Tx {
                        files_del: vec![id],
                        records_put: vec![RecordRow {
                            id,
                            path: current.path.clone(),
                            path_key: current.path_key.clone(),
                            doc: "restored record".into(),
                            revision: mdbn_wire::hash::sha256(b"restored record"),
                            modified_seq: a.r.head().seq,
                            bucket: bucket16(&id),
                            meta: RecordMeta::default(),
                        }],
                        ..Tx::default()
                    })
                    .unwrap();
            }
            "native_tomb" | "record_tomb" => {
                a.r.store
                    .commit(Tx {
                        files_del: vec![id],
                        tombstones_put: vec![TombstoneRow {
                            id,
                            kind: if case == "native_tomb" {
                                EntityKind::File
                            } else {
                                EntityKind::Record
                            },
                            path: current.path.clone(),
                            path_key: current.path_key.clone(),
                            last: if case == "native_tomb" {
                                TombstoneLast::from_file(&current).unwrap()
                            } else {
                                TombstoneLast::Doc("old record".into())
                            },
                            seq: a.r.head().seq,
                            time: 1,
                        }],
                        ..Tx::default()
                    })
                    .unwrap();
            }
            "hold" => {
                a.r.store
                    .commit(Tx {
                        holds_put: vec![Hold {
                            id,
                            path: current.path.clone(),
                            reason: HoldReason::EditorBusy,
                            since: 1,
                            base: None,
                            mine: TextOrBlob::Text("user bytes".into()),
                            theirs: None,
                            saves: 1,
                        }],
                        ..Tx::default()
                    })
                    .unwrap();
            }
            "unkeyed" => a.r.key_untrusted = true,
            "epoch" => a.r.policy.epoch += 1,
            "policy_ahead" => a.r.policy.seq = a.r.head().seq + 1,
            "not_caught_up" => a.r.caught_up = false,
            "blocked" => a.r.apply_blocked = Some(a.r.head().seq + 1),
            "fault" => a.r.apply_fault = true,
            "rekey" => a.r.policy.rekey_required = true,
            "lost_control" => a.r.latch.frozen = true,
            "path" => {
                let mut f = current.clone();
                f.path = "outside.bin".into();
                f.path_key = f.path.clone();
                a.r.store
                    .commit(Tx {
                        files_put: vec![f],
                        ..Tx::default()
                    })
                    .unwrap();
            }
            "missing_fence" | "corrupt_fence" => {
                a.r.store
                    .commit(Tx {
                        meta: vec![(
                            format!("native_move/{}", original.mutation.id.to_hex()),
                            (case == "corrupt_fence").then(|| vec![0xff]),
                        )],
                        ..Tx::default()
                    })
                    .unwrap();
            }
            "grant" => checked.grant = Some(B16([91; 16])),
            "origin" => checked.mutation.origin = B16([92; 16]),
            _ => {
                let mdbn_wire::attachment_runtime_v1::Op::Legacy(mdbn_wire::intent::Op::FileMove(
                    op,
                )) = &mut checked.mutation.ops[0]
                else {
                    panic!()
                };
                match case {
                    "wrong_file" => op.id = B16([93; 16]),
                    "wrong_from" => op.from = "another.md".into(),
                    "wrong_to" => op.to = "another.md".into(),
                    "update_refs" => op.update_refs = true,
                    "prior_cas" => op.if_revision = None,
                    _ => unreachable!(),
                }
            }
        }
        let result = a.r.test_native_move_pending_check(&checked);
        if case == "corrupt_fence" {
            assert!(result.is_err());
        } else {
            assert!(result.unwrap().is_some(), "{case}");
        }
        assert_eq!(
            a.r.store.pending_get(&original.mutation.id).unwrap(),
            Some(original.clone()),
            "{case}"
        );
        assert!(a.r.resurrected.contains_key(&original.mutation.id));
        assert!(a.r.take_log_calls().is_empty(), "{case}");
        assert!(a.r.store.receipt(&original.mutation.id).unwrap().is_none());
    }
}
