//! Earlier semantics replay through the authenticated log receive path.
use super::engine::{COL, Node, node_with, settle};
use crate::{
    Store,
    fake::FakeLogService,
    mem::MemStore,
    plan::{CorePlanner, Planner, StoreView},
    store::{FileLocal, FileRow, Tx},
};
use mdbn_core::{
    plan::{PlanOptions, Stage},
    types::Catalog,
};
use mdbn_wire::{
    attachment::FileContent,
    attachment_runtime_v1 as rt,
    common::{B16, B32, B64, Bytes, Text, Version},
    envelope::{Item, ItemKind},
    intent::{BlobRef, MediaClass, OpClock, Source},
    schema::Wire,
    unindexed_markdown::{FileKindV1, UnindexedMarkdownPayloadV1, UnindexedMarkdownToRecord},
};
use std::sync::Arc;

fn replay(sem: Version, change: impl FnOnce(&mut rt::EntryPayload)) -> Node {
    let svc = FakeLogService::new();
    let id = B16([52; 16]);
    let content = FileContent::Blob(BlobRef {
        plain_hash: B32([9; 32]),
        size: 1_048_577,
        blob_id: B32([8; 32]),
        id_epoch: 1,
        part_size: 8 << 20,
    });
    let mut store = MemStore::new();
    store
        .commit(Tx {
            files_put: vec![FileRow {
                id,
                path: "huge.md".into(),
                path_key: "huge.md".into(),
                kind: FileKindV1::UnindexedOversizedMarkdown,
                content: content.clone(),
                mtime: None,
                media: MediaClass::Other,
                modified_seq: 2,
                bucket: 0,
                local: FileLocal::Remote,
            }],
            ..Tx::default()
        })
        .unwrap();
    let mut node = node_with(&svc, 1, store, vec![], None);
    node.r.planner = Box::new(CorePlanner);
    settle(&mut [&mut node]);
    assert_eq!(node.r.head().seq, 2);
    let mut payload = rt::EntryPayload {
        sem,
        mutation: rt::Mutation {
            id: B16([51; 16]),
            origin: B16([2; 16]),
            base_seq: 2,
            clock: OpClock {
                instant: 1_700_000_000_000,
                tz: "UTC".into(),
                local_date: "2023-11-14".into(),
            },
            seed: B32([2; 32]),
            source: Source::External,
            ops: vec![rt::Op::UnindexedMarkdownToRecord(
                UnindexedMarkdownToRecord {
                    id,
                    path: "huge.md".into(),
                    doc: Text::Inline("small\n".into()),
                    prior: UnindexedMarkdownPayloadV1 { content },
                },
            )],
            on_behalf: None,
            conflict_mode: None,
            validated_at: None,
            room: None,
        },
        status: mdbn_wire::entry::Status::Applied,
        effects: vec![],
        conflicts: None,
        aliases: None,
        texts: None,
        resurrect: None,
    };
    let mutation = crate::convert::runtime_mutation(&payload.mutation, &|text| match text {
        Text::Inline(text) => Ok(text.clone()),
        _ => unreachable!(),
    })
    .unwrap();
    let view = StoreView::new(node.r.store(), Arc::new(Catalog::empty()));
    let planned = CorePlanner
        .plan(&mutation, &view, &PlanOptions { stage: Stage::Head })
        .unwrap();
    payload.effects = planned
        .effects
        .iter()
        .map(crate::convert::wruntime_effect)
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(!payload.effects.is_empty());
    change(&mut payload);
    let item = Item {
        kind: ItemKind::Entry,
        collection: COL,
        seq: Some(3),
        prev: Some(svc.head(&COL).1),
        epoch: Some(1),
        signer: Some(node.r.cfg.device_id),
        salt: Some(B16([3; 16])),
        idem: Some(B16([4; 16])),
        refs: None,
        stream: None,
        body: Bytes(payload.to_bytes().unwrap()),
        sig: Some(B64([0; 64])),
    };
    svc.push_raw(&COL, item.to_bytes().unwrap());
    let mut node = node_with(&svc, 1, node.r.into_store(), vec![], None);
    node.r.planner = Box::new(CorePlanner);
    settle(&mut [&mut node]);
    node
}

#[test]
fn retained_previous_sem_native_entry_must_apply_structurally() {
    let node = replay(Version { major: 1, minor: 0 }, |_| {});
    assert_eq!(
        node.r.head().seq,
        3,
        "previous minor must not require an upgrade"
    );
    assert_eq!(
        node.r.store().record(&B16([52; 16])).unwrap().unwrap().doc,
        "small\n"
    );
    assert_eq!(node.r.policy.voids, 0);
}

#[test]
fn previous_sem_structural_defect_voids() {
    for minor in [0, 1, 2] {
        let node = replay(Version { major: 1, minor: 0 }, |payload| {
            payload.sem.minor = minor;
            let rt::Effect::ReindexUnindexedMarkdown(effect) = &mut payload.effects[0] else {
                unreachable!()
            };
            effect.path = "../x.md".into();
        });
        assert_eq!(node.r.head().seq, 3);
        assert_eq!(node.r.policy.voids, 1);
        assert!(node.r.store().record(&B16([52; 16])).unwrap().is_none());
    }
}

#[test]
fn previous_sem_trusts_declared_effects_but_same_sem_still_replans() {
    let current = mdbn_core::semantics::SEM;
    for sem in [
        Version { major: 1, minor: 0 },
        Version {
            major: current.major,
            minor: current.minor,
        },
    ] {
        let previous = sem.major == 1 && sem.minor == 0;
        let node = replay(sem, |payload| {
            let rt::Effect::ReindexUnindexedMarkdown(effect) = &mut payload.effects[0] else {
                unreachable!()
            };
            effect.doc = Text::Inline("earlier planner's declared bytes\n".into());
        });
        assert_eq!(node.r.policy.voids, 0);
        if previous {
            assert_eq!(node.r.head().seq, 3);
            assert_eq!(
                node.r.store().record(&B16([52; 16])).unwrap().unwrap().doc,
                "earlier planner's declared bytes\n"
            );
        } else {
            assert_eq!(node.r.head().seq, 2);
            assert!(node.r.store().record(&B16([52; 16])).unwrap().is_none());
        }
    }
}

#[test]
fn previous_sem_prior_cas_defect_voids() {
    for minor in [0, 1, 2] {
        let node = replay(Version { major: 1, minor }, |payload| {
            let rt::Op::UnindexedMarkdownToRecord(op) = &mut payload.mutation.ops[0] else {
                unreachable!()
            };
            let FileContent::Blob(prior) = &mut op.prior.content else {
                unreachable!()
            };
            prior.blob_id = B32([99; 32]);
        });
        assert_eq!(node.r.head().seq, 3);
        assert_eq!(node.r.policy.voids, 1);
        assert!(node.r.store().record(&B16([52; 16])).unwrap().is_none());
    }
}

#[test]
fn previous_sem_delegated_native_entry_still_stalls() {
    for effects_only in [false, true] {
        let node = replay(Version { major: 1, minor: 0 }, |payload| {
            payload.mutation.on_behalf = Some(B16([99; 16]));
            if effects_only {
                payload.mutation.ops = vec![rt::Op::Legacy(mdbn_wire::intent::Op::FileDelete(
                    mdbn_wire::intent::FileDelete {
                        id: B16([88; 16]),
                        if_revision: None,
                        base: None,
                    },
                ))];
            }
        });
        assert_eq!(node.r.head().seq, 2);
        assert_eq!(node.r.policy.voids, 0);
        assert!(node.r.store().record(&B16([52; 16])).unwrap().is_none());
    }
}

#[test]
fn newer_sem_native_entry_stalls() {
    let current = mdbn_core::semantics::SEM;
    let node = replay(
        Version {
            major: current.major,
            minor: current.minor + 1,
        },
        |_| {},
    );
    assert_eq!(node.r.head().seq, 2);
    assert_eq!(node.r.policy.voids, 0);
    assert!(node.r.store().record(&B16([52; 16])).unwrap().is_none());
    assert!(format!("{:?}", node.r.sync_status()).contains("UpgradeRequired"));
}

#[test]
fn review_1062_stateless_request_defects_void_across_sem_versions() {
    let mut outcomes = Vec::new();
    for defect in ["duplicate_id", "unsafe_op_path"] {
        for minor in [0, 1, 2] {
            let node = replay(Version { major: 1, minor }, |payload| match defect {
                "duplicate_id" => payload.mutation.ops.push(payload.mutation.ops[0].clone()),
                "unsafe_op_path" => {
                    payload
                        .mutation
                        .ops
                        .push(rt::Op::Legacy(mdbn_wire::intent::Op::Document(
                            mdbn_wire::intent::Document {
                                id: B16([90; 16]),
                                base: None,
                                new: Some(mdbn_wire::intent::DocVersion {
                                    path: "../escape.md".into(),
                                    doc: Text::Inline("other\n".into()),
                                }),
                                if_revision: None,
                            },
                        )))
                }
                _ => unreachable!(),
            });
            outcomes.push((defect, minor, node.r.head().seq, node.r.policy.voids));
        }
    }
    eprintln!("request defects (defect, SEM minor, head, voids): {outcomes:?}");
    assert!(
        outcomes
            .iter()
            .all(|(_, _, head, voids)| *head == 3 && *voids == 1),
        "format-level request defects must void identically: {outcomes:?}"
    );
}
