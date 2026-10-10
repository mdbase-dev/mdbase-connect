//! Device-local move fence qualification. Capture hooks exercise the private
//! metadata helper; persistent watcher fixtures cover the actual public driver.
use super::{
    engine::{Node, settle},
    unindexed_end_to_end::pair,
};
use crate::{
    log::LogPort,
    replica::AttachmentSource,
    store::{Store, Tx},
};
use mdbn_wire::common::B16;

mod lost_tail;
mod read_faults;
mod refusals;
mod retention;

struct Source(Vec<u8>);
impl AttachmentSource for Source {
    fn len(&self) -> u64 {
        self.0.len() as u64
    }
    fn read_at(&mut self, offset: u64, out: &mut [u8]) -> Result<(), String> {
        out.copy_from_slice(&self.0[offset as usize..offset as usize + out.len()]);
        Ok(())
    }
}
fn native(a: &mut Node, b: &mut Node) -> B16 {
    let id = B16([81; 16]);
    let proof =
        a.r.prepare_unindexed_markdown_capture(
            id,
            "before.md".into(),
            Box::new(Source(vec![b'x'; 1_048_577])),
        )
        .unwrap();
    let upload = a.r.start_unindexed_markdown_upload(proof).unwrap();
    settle(&mut [a, b]);
    let prepared = a.r.take_prepared_unindexed_upload(&upload).unwrap();
    a.r.capture_prepared_unindexed_upload(prepared).unwrap();
    settle(&mut [a, b]);
    id
}
#[test]
fn native_move_fence_pruning_preserves_retained_recovery_owners() {
    let (_svc, mut a, mut b) = pair();
    let id = native(&mut a, &mut b);
    a.r.test_capture_native_move(id, "before.md", "after.md")
        .unwrap();
    let first = a.r.store.pending(None, 10).unwrap().remove(0).mutation.id;
    let key = format!("native_move/{}", first.to_hex());
    settle(&mut [&mut a, &mut b]);
    assert!(a.r.store.meta(&key).unwrap().is_some());
    a.r.test_capture_native_move(id, "after.md", "again.md")
        .unwrap();
    assert!(
        a.r.store.meta(&key).unwrap().is_some(),
        "own-retained move fence survives another capture"
    );
    settle(&mut [&mut a, &mut b]);
    a.r.store
        .commit(Tx {
            own_retained_drop_below: Some(u64::MAX),
            ..Tx::default()
        })
        .unwrap();
    a.r.test_capture_native_move(id, "again.md", "final.md")
        .unwrap();
    assert!(
        a.r.store.meta(&key).unwrap().is_none(),
        "only proven ownerless fence is pruned"
    );
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.r.store.file_at("final.md").unwrap(), Some(id));
}

#[test]
fn native_move_pending_empty_effects_reserve_identity_and_both_paths() {
    let (_svc, mut a, mut b) = pair();
    let id = native(&mut a, &mut b);
    a.r.test_capture_native_move(id, "before.md", "after.md")
        .unwrap();
    let first = a.r.store.pending(None, 10).unwrap();
    assert_eq!(first.len(), 1);
    assert!(first[0].effects.is_empty());
    assert!(
        a.r.test_capture_native_move(id, "before.md", "elsewhere.md")
            .is_err()
    );
    assert_eq!(a.r.store.pending(None, 10).unwrap(), first);
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.r.store.file_at("after.md").unwrap(), Some(id));
    assert_eq!(b.r.store.file_at("after.md").unwrap(), Some(id));
    assert!(a.r.store.file_at("elsewhere.md").unwrap().is_none());
}

#[test]
fn native_move_capture_abort_and_unknown_before_or_after_never_publish_ownership() {
    for fault in 0..3 {
        let (_svc, mut a, mut b) = pair();
        let id = native(&mut a, &mut b);
        let before = a.r.store.file(&id).unwrap().unwrap();
        let head = a.r.head();
        let order = a.r.next_order;
        let keys = a.r.pending_keys.clone();
        match fault {
            0 => a.r.store.fail_commits(1),
            1 => a.r.store.fail_unknown_commits(1),
            2 => a.r.store.fail_after_commit(1),
            _ => unreachable!(),
        }
        assert!(
            a.r.test_capture_native_move(id, "before.md", "after.md")
                .is_err()
        );
        assert_eq!(a.r.requires_reopen(), fault != 0);
        assert_eq!(a.r.next_order, order);
        assert_eq!(a.r.pending_keys, keys);
        assert_eq!(a.r.head(), head);
        assert_eq!(a.r.store.file(&id).unwrap(), Some(before));
        assert!(a.r.store.file_at("after.md").unwrap().is_none());
        let pending = a.r.store.pending(None, 10).unwrap();
        assert_eq!(pending.len(), usize::from(fault == 2));
        if fault == 2 {
            assert!(!pending[0].refs.is_empty());
            assert!(
                a.r.store
                    .meta(&format!("native_move/{}", pending[0].mutation.id.to_hex()))
                    .unwrap()
                    .is_some()
            );
        }
        assert!(a.r.take_log_calls().is_empty());
        if fault == 0 {
            a.r.test_capture_native_move(id, "before.md", "after.md")
                .unwrap();
            settle(&mut [&mut a, &mut b]);
            assert_eq!(a.r.store.file_at("after.md").unwrap(), Some(id));
            assert_eq!(b.r.store.file_at("after.md").unwrap(), Some(id));
        } else {
            assert!(
                a.r.test_capture_native_move(id, "before.md", "after.md")
                    .is_err()
            );
            assert!(a.r.build_snapshot_now().is_err());
            settle(&mut [&mut a, &mut b]);
            assert_eq!(a.r.store.pending(None, 10).unwrap(), pending);
            assert_eq!(a.r.head(), head);
        }
    }
}
#[test]
fn native_move_requires_current_healthy_device_and_valid_both_paths_before_capture() {
    for fault in [
        "regressed",
        "key_untrusted",
        "frozen",
        "rekey",
        "held_epoch",
        "policy_ahead",
        "not_caught_up",
        "blocked",
        "stalled",
        "fault",
        "from",
        "to",
        "oversized_path",
    ] {
        let (_svc, mut a, mut b) = pair();
        let id = native(&mut a, &mut b);
        let head = a.r.head();
        let order = a.r.next_order;
        let mut from = "before.md".to_owned();
        let mut to = "after.md".to_owned();
        match fault {
            "regressed" => a.r.regressed_at = Some(1),
            "key_untrusted" => a.r.key_untrusted = true,
            "frozen" => a.r.policy.frozen = true,
            "rekey" => a.r.policy.rekey_required = true,
            "held_epoch" => a.r.sealer.set_epoch(a.r.policy.epoch + 1),
            "policy_ahead" => a.r.policy.seq = head.seq + 1,
            "not_caught_up" => a.r.caught_up = false,
            "blocked" => a.r.apply_blocked = Some(head.seq + 1),
            "stalled" => {
                a.r.stalled = Some((mdbn_wire::client::IncidentKind::WaitingForKey, head.seq + 1))
            }
            "fault" => a.r.apply_fault = true,
            "from" => from = "before.bin".into(),
            "to" => to = "after.bin".into(),
            "oversized_path" => to = format!("{}.md", "p".repeat(2049)),
            _ => unreachable!(),
        }
        assert!(
            a.r.test_capture_native_move(id, &from, &to).is_err(),
            "{fault}"
        );
        assert_eq!(a.r.store.pending_count().unwrap(), 0, "{fault}");
        assert_eq!(a.r.next_order, order, "{fault}");
        assert_eq!(a.r.head(), head, "{fault}");
        assert!(a.r.take_log_calls().is_empty(), "{fault}");
    }
}
#[test]
fn native_move_append_rechecks_complete_descriptor_epoch_catalog_and_pending_bindings() {
    use mdbn_wire::{
        attachment::FileContent,
        cbor::{self, Cbor},
    };
    for fault in [
        "descriptor",
        "modified_seq",
        "catalog",
        "epoch",
        "policy",
        "on_behalf",
        "origin",
        "refs",
        "missing",
        "corrupt",
    ] {
        let (_svc, mut a, mut b) = pair();
        let id = native(&mut a, &mut b);
        a.r.test_capture_native_move(id, "before.md", "after.md")
            .unwrap();
        let mut row = a.r.store.pending(None, 10).unwrap().remove(0);
        assert!(a.r.test_native_move_pending_check(&row).unwrap().is_none());
        match fault {
            "descriptor" | "modified_seq" => {
                let mut file = a.r.store.file(&id).unwrap().unwrap();
                if fault == "descriptor" {
                    let FileContent::AttachmentV1(c) = &mut file.content else {
                        panic!()
                    };
                    // Same plaintext hash/size, but a different signed source.
                    c.reference.key_epoch += 1;
                } else {
                    file.modified_seq += 1;
                }
                a.r.store
                    .commit(Tx {
                        files_put: vec![file],
                        ..Tx::default()
                    })
                    .unwrap();
            }
            "catalog" => {
                a.r.store
                    .commit(Tx {
                        resources_put: vec![(
                            "mdbase.yaml".into(),
                            "spec_version: '0.3.0'\n".into(),
                        )],
                        ..Tx::default()
                    })
                    .unwrap();
            }
            "epoch" => a.r.policy.epoch += 1,
            "policy" => a.r.policy.seq += 1,
            "on_behalf" => row.mutation.on_behalf = Some(B16([12; 16])),
            "origin" => row.mutation.origin = B16([13; 16]),
            "refs" => {
                row.refs.pop();
            }
            "missing" | "corrupt" => {
                a.r.store
                    .commit(Tx {
                        meta: vec![(
                            format!("native_move/{}", row.mutation.id.to_hex()),
                            (fault == "corrupt").then(|| vec![0xff]),
                        )],
                        ..Tx::default()
                    })
                    .unwrap();
            }
            _ => unreachable!(),
        }
        let result = a.r.test_native_move_pending_check(&row);
        if fault == "corrupt" {
            assert!(result.is_err());
        } else {
            assert!(result.unwrap().is_some(), "{fault}");
        }
        assert_eq!(a.r.store.file_at("before.md").unwrap(), Some(id));
        assert!(a.r.store.file_at("after.md").unwrap().is_none());
        // Fence bytes are not synced proof, and never appear in the entry refs.
        let key = format!("native_move/{}", row.mutation.id.to_hex());
        if let Some(raw) = a.r.store.meta(&key).unwrap()
            && fault != "corrupt"
        {
            assert!(matches!(cbor::decode(&raw).unwrap(), Cbor::Array(_)));
            assert!(!row.refs.contains(&mdbn_wire::hash::sha256(&raw)));
        }
    }
}

/// Pure verified-stage fixtures; not a live lost-tail/prefix-proof claim.
#[test]
fn native_move_recovery_follows_current_identity_and_allocates_without_kind_change() {
    use mdbn_core::plan::{PlanOptions, Stage};
    for case in [
        "same",
        "renamed",
        "already_to",
        "collision",
        "collision_native",
        "collision_record",
        "policy",
        "epoch",
        "catalog",
        "recent_regression",
        "source",
    ] {
        let (_svc, mut a, mut b) = pair();
        let id = native(&mut a, &mut b);
        let replacement = if case == "source" {
            let proof =
                a.r.prepare_unindexed_markdown_capture(
                    id,
                    "before.md".into(),
                    Box::new(Source(vec![b'y'; 1_048_577])),
                )
                .unwrap();
            let upload = a.r.start_unindexed_markdown_upload(proof).unwrap();
            settle(&mut [&mut a, &mut b]);
            Some(a.r.take_prepared_unindexed_upload(&upload).unwrap())
        } else {
            None
        };
        a.r.test_capture_native_move(id, "before.md", "after.md")
            .unwrap();
        let row = a.r.store.pending(None, 10).unwrap().remove(0);
        a.r.resurrected.insert(row.mutation.id, a.r.head().seq);
        let mut current = a.r.store.file(&id).unwrap().unwrap();
        if case == "renamed" {
            current.path = "latest.md".into();
        }
        if case == "already_to" {
            current.path = "after.md".into();
        }
        current.path_key = mdbn_core::paths::path_key(&current.path);
        current.modified_seq += 1;
        let mut meta = vec![];
        let expected_refs = if let Some(p) = replacement {
            current.content = mdbn_wire::attachment::FileContent::AttachmentV1(p.content().clone());
            use mdbn_wire::schema::Wire;
            meta.push((
                format!(
                    "replica.attachment_inventory.{}",
                    p.content().reference.manifest_cipher_hash.to_hex()
                ),
                Some(
                    mdbn_wire::cbor::encode(&mdbn_wire::cbor::Cbor::Array(
                        p.refs().iter().map(Wire::to_cbor).collect(),
                    ))
                    .unwrap(),
                ),
            ));
            p.refs().to_vec()
        } else {
            row.refs.clone()
        };
        let mut files = vec![current.clone()];
        if matches!(case, "collision" | "collision_native") {
            let mut other = current.clone();
            other.id = B16([82; 16]);
            other.path = "after.md".into();
            other.path_key = "after.md".into();
            if case == "collision" {
                other.kind = mdbn_wire::unindexed_markdown::FileKindV1::Ordinary;
            }
            files.push(other);
        }
        let records = if case == "collision_record" {
            vec![crate::store::RecordRow {
                id: B16([82; 16]),
                path: "after.md".into(),
                path_key: "after.md".into(),
                doc: "other record".into(),
                revision: mdbn_wire::hash::sha256(b"other record"),
                modified_seq: a.r.head().seq,
                bucket: crate::store::bucket16(&B16([82; 16])),
                meta: crate::store::RecordMeta::default(),
            }]
        } else {
            vec![]
        };
        a.r.store
            .commit(Tx {
                files_put: files,
                records_put: records,
                meta,
                ..Tx::default()
            })
            .unwrap();
        if case == "policy" {
            a.r.policy.seq = a.r.head().seq;
        }
        if case == "epoch" {
            // Trusted pure-Stage fixture: retain the real old source keys and
            // supply an actual new key, not merely an unavailable epoch label.
            let mut keys = crate::crypto::keys::Keyring::new();
            for (epoch, key) in a.r.sealer.testing_epoch_keys() {
                keys.insert(epoch, crate::crypto::Secret32(*key));
            }
            a.r.policy.epoch += 1;
            keys.insert(a.r.policy.epoch, crate::crypto::Secret32([0x71; 32]));
            let raw = zeroize::Zeroizing::new(keys.to_bytes());
            let mut saved = zeroize::Zeroizing::new((raw.len() as u64).to_be_bytes().to_vec());
            saved.extend_from_slice(&raw);
            a.r.sealer.import(&saved).unwrap();
            a.r.sealer.set_epoch(a.r.policy.epoch);
        }
        if case == "catalog" {
            a.r.store
                .commit(Tx {
                    resources_put: vec![("mdbase.yaml".into(), "spec_version: '0.3.0'\n".into())],
                    ..Tx::default()
                })
                .unwrap();
            a.r.catalog = std::sync::Arc::new(crate::plan::load_catalog(&a.r.store).unwrap());
        }
        if case == "recent_regression" {
            a.r.regressed_at = Some(1);
            assert!(
                a.r.prepare_unindexed_markdown_capture(
                    id,
                    "before.md".into(),
                    Box::new(Source(vec![b'x'; 1_048_577]))
                )
                .is_err(),
                "fresh capture remains fenced"
            );
        }
        assert_eq!(
            a.r.test_native_move_recovery_refs(&row).unwrap(),
            Some(expected_refs),
            "{case}"
        );
        let cm =
            crate::convert::runtime_mutation(&row.mutation, &crate::convert::inline_only).unwrap();
        let view = crate::plan::StoreView::new(&a.r.store, a.r.catalog.clone());
        let planned =
            a.r.planner
                .plan(
                    &cm,
                    &view,
                    &PlanOptions {
                        stage: Stage::Resurrect,
                    },
                )
                .unwrap();
        let expected_path = if matches!(case, "collision" | "collision_native" | "collision_record")
        {
            "after (2).md"
        } else {
            "after.md"
        };
        assert!(
            matches!(planned.effects.as_slice(),
            [mdbn_core::plan::Effect::PutUnindexedMarkdown { id: moved, path, content }]
            if crate::convert::wuuid(moved) == id && path == expected_path
                && crate::convert::wfile_content(content) == current.content),
            "{case}: {:?}",
            planned.effects
        );
        assert_eq!(
            a.r.test_native_move_plan(&row, &planned).unwrap(),
            Some(true)
        );
        assert_eq!(a.r.store.pending_get(&row.mutation.id).unwrap(), Some(row));
    }
}

#[test]
fn native_move_recovery_outside_matrix_holds_pending_and_never_appends_or_acks() {
    for case in ["ordinary", "missing", "frozen", "inventory"] {
        let (_svc, mut a, mut b) = pair();
        let id = native(&mut a, &mut b);
        a.r.test_capture_native_move(id, "before.md", "after.md")
            .unwrap();
        let row = a.r.store.pending(None, 10).unwrap().remove(0);
        a.r.resurrected.insert(row.mutation.id, a.r.head().seq);
        match case {
            "ordinary" => {
                let mut current = a.r.store.file(&id).unwrap().unwrap();
                current.kind = mdbn_wire::unindexed_markdown::FileKindV1::Ordinary;
                a.r.store
                    .commit(Tx {
                        files_put: vec![current],
                        ..Tx::default()
                    })
                    .unwrap();
            }
            "missing" => {
                a.r.store
                    .commit(Tx {
                        files_del: vec![id],
                        ..Tx::default()
                    })
                    .unwrap();
            }
            "frozen" => a.r.policy.frozen = true,
            "inventory" => {
                let current = a.r.store.file(&id).unwrap().unwrap();
                let mdbn_wire::attachment::FileContent::AttachmentV1(c) = current.content else {
                    panic!()
                };
                a.r.store
                    .commit(Tx {
                        meta: vec![(
                            format!(
                                "replica.attachment_inventory.{}",
                                c.reference.manifest_cipher_hash.to_hex()
                            ),
                            None,
                        )],
                        ..Tx::default()
                    })
                    .unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            a.r.test_native_move_pending_check(&row).unwrap().is_some(),
            "{case}"
        );
        a.r.pump();
        assert_eq!(a.r.store.pending_get(&row.mutation.id).unwrap(), Some(row));
        assert!(a.r.take_log_calls().is_empty(), "{case}");
    }
}
