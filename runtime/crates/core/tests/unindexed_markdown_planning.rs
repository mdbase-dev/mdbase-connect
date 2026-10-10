//! Pure planning/state semantics of the unindexed oversized Markdown kind
//! (`intent.md` §3.10): typed path/size/CAS checks and atomic holder transitions.
//! Not plaintext verification, provider, runtime or index-store behaviour.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::result_large_err)]
use mdbn_core::ids::{Hash, Uuid, revision};
use mdbn_core::intent::{
    AttachmentContentV1, AttachmentRefV1, BlobRef, ConflictMode, FileContent, FileDelete, FileKind,
    FileMove, FilePut, Mutation, Op, OpClock, RECORD_SOURCE_CAP_BYTES, RecordToUnindexedMarkdown,
    Source, UnindexedMarkdownPut, UnindexedMarkdownToRecord,
};
use mdbn_core::paths::path_key;
use mdbn_core::plan::{
    ConflictKind, ConflictValue, Effect, PlanOptions, RejectCode, Stage, Status,
};
use mdbn_core::state::{MemState, Overlay, PathHolder, StateView, Tombstone};

const PATH: &str = "notes/huge.md";
const SMALL_DOC: &str = "---\ntitle: trimmed\n---\nnow small enough to index\n";

fn id(n: u8) -> Uuid {
    let mut b = [0; 16];
    b[0] = 2;
    b[15] = n;
    Uuid(b)
}
fn blob(n: u8, size: u64) -> FileContent {
    FileContent::Blob(BlobRef {
        plain_hash: Hash::of(&[n]),
        size,
        blob_id: [n; 32],
        id_epoch: 1,
        part_size: 8_388_608,
    })
}
fn attachment(n: u8, size: u64) -> FileContent {
    FileContent::AttachmentV1(AttachmentContentV1 {
        reference: AttachmentRefV1 {
            collection: id(90),
            key_epoch: 1,
            attachment_id: [n; 32],
            manifest_cipher_hash: Hash::of(&[n, 1]),
        },
        whole_plain_hash: Hash::of(&[n, 7]),
        total_plain_bytes: size,
    })
}
fn oversized(n: u8) -> FileContent {
    blob(n, RECORD_SOURCE_CAP_BYTES + 1)
}
fn state() -> MemState {
    let mut s = MemState::new();
    s.insert_resource("mdbase.yaml", "spec_version: '0.3.0'\n");
    s
}
fn with_record(doc: &str) -> MemState {
    let mut s = state();
    s.insert_record(id(1), PATH, doc);
    s
}
fn with_unindexed(content: FileContent) -> MemState {
    let mut s = state();
    s.apply_effect(&Effect::PutUnindexedMarkdown {
        id: id(1),
        path: PATH.into(),
        content,
    });
    s
}
fn put(content: FileContent, expected: Option<FileContent>) -> Op {
    Op::UnindexedMarkdownPut(UnindexedMarkdownPut {
        id: id(1),
        path: PATH.into(),
        content,
        expected,
    })
}
fn to_file(content: FileContent, prior_revision: Hash) -> Op {
    Op::RecordToUnindexedMarkdown(RecordToUnindexedMarkdown {
        id: id(1),
        path: PATH.into(),
        content,
        prior_revision,
    })
}
fn to_record(doc: &str, prior: FileContent) -> Op {
    Op::UnindexedMarkdownToRecord(UnindexedMarkdownToRecord {
        id: id(1),
        path: PATH.into(),
        doc: doc.into(),
        prior,
    })
}
fn mutation(op: Op, source: Source) -> Mutation {
    Mutation {
        id: id(200),
        origin: id(201),
        base_seq: 0,
        clock: OpClock {
            instant_ms: 1_767_225_600_000,
            tz: "UTC".into(),
            local_date: "2026-01-01".into(),
        },
        seed: [7; 32],
        source,
        ops: vec![op],
        on_behalf: None,
        conflict_mode: ConflictMode::Record,
        validated_at: None,
        room: None,
    }
}
fn try_plan(
    op: Op,
    source: Source,
    stage: Stage,
    s: &MemState,
) -> Result<mdbn_core::plan::Planned, mdbn_core::plan::Rejection> {
    mdbn_core::plan(&mutation(op, source), s, &PlanOptions { stage })
}
fn plan(op: Op, source: Source, stage: Stage, s: &MemState) -> mdbn_core::plan::Planned {
    try_plan(op, source, stage, s).unwrap()
}
fn rejected(op: Op, stage: Stage, s: &MemState) -> (RejectCode, Option<String>) {
    let r = try_plan(op, Source::Api, stage, s).unwrap_err();
    (r.code, r.reason.clone())
}
/// Overlay and MemState must agree on every holder-visible fact.
fn apply_both(s: &mut MemState, p: &mdbn_core::plan::Planned) {
    let mut ov = Overlay::new(s);
    ov.apply(p);
    let (file, record, tomb, holder) = (
        ov.file(&id(1)),
        ov.record(&id(1)),
        ov.tombstone(&id(1)),
        ov.at_path_key(&path_key(PATH)),
    );
    s.apply(p);
    assert_eq!(s.file(&id(1)), file);
    assert_eq!(s.record(&id(1)), record);
    assert_eq!(s.tombstone(&id(1)), tomb);
    assert_eq!(s.at_path_key(&path_key(PATH)), holder);
}

#[test]
fn create_installs_typed_kind_at_a_record_path_without_a_record() {
    let mut s = state();
    let content = attachment(1, RECORD_SOURCE_CAP_BYTES + 1);
    let p = plan(put(content, None), Source::Api, Stage::Head, &s);
    assert_eq!(p.status, Status::Applied);
    assert_eq!(
        p.effects,
        vec![Effect::PutUnindexedMarkdown {
            id: id(1),
            path: PATH.into(),
            content
        }]
    );
    apply_both(&mut s, &p);
    let f = s.file(&id(1)).unwrap();
    assert_eq!(f.kind, FileKind::UnindexedOversizedMarkdown);
    assert_eq!(f.content, content);
    assert_eq!(s.record(&id(1)), None);
    assert_eq!(
        s.at_path_key(&path_key(PATH)),
        Some(PathHolder::File(id(1)))
    );
    assert!(!s.record_ids().contains(&id(1)));
}

#[test]
fn exactly_the_cap_and_non_record_paths_are_refused() {
    let s = state();
    assert_eq!(
        rejected(put(blob(1, RECORD_SOURCE_CAP_BYTES), None), Stage::Head, &s),
        (RejectCode::InvalidRequest, Some("not_oversized".into()))
    );
    let mut op = UnindexedMarkdownPut {
        id: id(1),
        path: "assets/huge.bin".into(),
        content: oversized(1),
        expected: None,
    };
    assert_eq!(
        rejected(Op::UnindexedMarkdownPut(op.clone()), Stage::Head, &s),
        (RejectCode::InvalidRequest, Some("not_a_record_path".into()))
    );
    op.path = "mdbase.yaml".into();
    assert_eq!(
        rejected(Op::UnindexedMarkdownPut(op), Stage::Head, &s).0,
        RejectCode::InvalidRequest
    );
}

#[test]
fn ordinary_file_ops_never_reach_record_paths_or_change_the_kind() {
    let s = with_unindexed(oversized(1));
    // An ordinary put at a record path is still refused.
    let r = try_plan(
        Op::FilePut(FilePut {
            id: id(2),
            path: PATH.into(),
            blob: match oversized(2) {
                FileContent::Blob(b) => b,
                _ => unreachable!(),
            },
            if_revision: None,
            base: None,
        }),
        Source::Api,
        Stage::Head,
        &s,
    )
    .unwrap_err();
    assert_eq!(r.reason.as_deref(), Some("not_a_file_path"));
    // Replacing the typed file through the ordinary op is a kind mismatch
    // (at an otherwise eligible file path, so the path check cannot mask it).
    let r = try_plan(
        Op::FilePut(FilePut {
            id: id(1),
            path: "assets/huge.bin".into(),
            blob: match oversized(2) {
                FileContent::Blob(b) => b,
                _ => unreachable!(),
            },
            if_revision: None,
            base: None,
        }),
        Source::Api,
        Stage::Head,
        &s,
    )
    .unwrap_err();
    assert_eq!(r.reason.as_deref(), Some("kind_mismatch"));
    // Moving it off record paths needs an explicit conversion, never a silent one.
    let r = try_plan(
        Op::FileMove(FileMove {
            id: id(1),
            from: PATH.into(),
            to: "assets/huge.bin".into(),
            if_revision: None,
            update_refs: false,
        }),
        Source::Api,
        Stage::Head,
        &s,
    )
    .unwrap_err();
    assert_eq!(r.reason.as_deref(), Some("not_a_record_path"));
    // A move between record paths keeps the kind in the typed effect.
    let p = plan(
        Op::FileMove(FileMove {
            id: id(1),
            from: PATH.into(),
            to: "notes/moved.md".into(),
            if_revision: None,
            update_refs: false,
        }),
        Source::Api,
        Stage::Head,
        &s,
    );
    assert_eq!(
        p.effects,
        vec![Effect::PutUnindexedMarkdown {
            id: id(1),
            path: "notes/moved.md".into(),
            content: oversized(1)
        }]
    );
}

#[test]
fn replace_requires_the_exact_full_prior_content() {
    let mut s = with_unindexed(oversized(1));
    let stale = rejected(put(oversized(2), None), Stage::Head, &s);
    assert_eq!(stale, (RejectCode::Conflict, Some("revision".into())));
    let stale = rejected(put(oversized(2), Some(oversized(3))), Stage::Head, &s);
    assert_eq!(stale, (RejectCode::Conflict, Some("revision".into())));
    // A same-plaintext-hash attachment reseal is a different full descriptor.
    let mut resealed = attachment(1, RECORD_SOURCE_CAP_BYTES + 1);
    if let FileContent::AttachmentV1(a) = &mut resealed {
        a.whole_plain_hash = oversized(1).plain_hash();
    }
    let mut s2 = with_unindexed(resealed);
    let mut rekeyed = resealed;
    if let FileContent::AttachmentV1(a) = &mut rekeyed {
        a.reference.key_epoch = 2;
    }
    assert_eq!(
        rejected(put(rekeyed, Some(oversized(1))), Stage::Head, &s2).1,
        Some("revision".into())
    );
    let p = plan(put(rekeyed, Some(resealed)), Source::Api, Stage::Head, &s2);
    assert_eq!(p.effects.len(), 1);
    apply_both(&mut s2, &p);
    assert_eq!(s2.file(&id(1)).unwrap().content, rekeyed);
    // Exact CAS replaces; identical content is a no-op; resurrection records a conflict.
    let p = plan(
        put(oversized(2), Some(oversized(1))),
        Source::Api,
        Stage::Head,
        &s,
    );
    apply_both(&mut s, &p);
    assert_eq!(s.file(&id(1)).unwrap().content, oversized(2));
    let p = plan(
        put(oversized(2), Some(oversized(2))),
        Source::Api,
        Stage::Head,
        &s,
    );
    assert!(p.effects.is_empty());
    let p = plan(
        put(oversized(3), Some(oversized(1))),
        Source::Api,
        Stage::Resurrect,
        &s,
    );
    assert_eq!(p.status, Status::Conflicted);
    assert!(p.effects.is_empty());
    assert_eq!(p.conflicts[0].kind, ConflictKind::File);
    assert_eq!(
        p.conflicts[0].kept,
        ConflictValue::UnindexedMarkdown(oversized(2))
    );
    assert_eq!(
        p.conflicts[0].lost,
        ConflictValue::UnindexedMarkdown(oversized(3))
    );
}

#[test]
fn record_to_file_is_one_atomic_effect_with_no_record_tombstone() {
    let doc = "---\ntitle: before\n---\nabout to grow past the cap\n";
    let mut s = with_record(doc);
    let content = oversized(1);
    assert_eq!(
        rejected(to_file(content, Hash::of(b"stale")), Stage::Head, &s),
        (RejectCode::Conflict, Some("revision".into()))
    );
    assert_eq!(
        rejected(
            to_file(blob(1, RECORD_SOURCE_CAP_BYTES), revision(doc)),
            Stage::Head,
            &s
        )
        .1,
        Some("not_oversized".into())
    );
    let p = plan(
        to_file(content, revision(doc)),
        Source::External,
        Stage::Head,
        &s,
    );
    assert_eq!(p.status, Status::Applied);
    assert_eq!(
        p.effects,
        vec![Effect::PutUnindexedMarkdown {
            id: id(1),
            path: PATH.into(),
            content
        }]
    );
    apply_both(&mut s, &p);
    assert_eq!(s.record(&id(1)), None);
    assert_eq!(s.tombstone(&id(1)), None);
    let f = s.file(&id(1)).unwrap();
    assert_eq!(
        (f.path.as_str(), f.kind),
        (PATH, FileKind::UnindexedOversizedMarkdown)
    );
    assert_eq!(
        s.at_path_key(&path_key(PATH)),
        Some(PathHolder::File(id(1)))
    );
    // A live record is never silently replaced by the create op.
    let s2 = with_record(doc);
    assert_eq!(
        rejected(put(content, None), Stage::Head, &s2).1,
        Some("id_is_record".into())
    );
    // Lost transition is always skipped, even before a stale CAS is inspected.
    let s3 = with_record("---\ntitle: changed\n---\n");
    let p = plan(
        to_file(content, revision(doc)),
        Source::External,
        Stage::Resurrect,
        &s3,
    );
    assert!(p.effects.is_empty());
    assert!(p.conflicts.is_empty());
    assert_eq!(p.issues.len(), 1);
    assert_eq!(
        p.issues[0].issue.code,
        "unindexed_kind_transition_requires_capture"
    );
    let mut overlay = Overlay::new(&s3);
    overlay.apply(&p);
    assert_eq!(overlay.record(&id(1)), s3.record(&id(1)));
    assert!(overlay.file(&id(1)).is_none());
}

#[test]
fn file_to_record_checks_full_descriptor_cap_and_parse_then_reindexes_atomically() {
    let mut s = with_unindexed(oversized(1));
    assert_eq!(
        rejected(to_record(SMALL_DOC, oversized(2)), Stage::Head, &s),
        (RejectCode::Conflict, Some("revision".into()))
    );
    let big = "a".repeat(usize::try_from(RECORD_SOURCE_CAP_BYTES).unwrap() + 1);
    assert_eq!(
        rejected(to_record(&big, oversized(1)), Stage::Head, &s),
        (RejectCode::TooLarge, Some("record_too_large".into()))
    );
    assert_eq!(
        rejected(
            to_record("---\n- not a mapping\n---\n", oversized(1)),
            Stage::Head,
            &s
        )
        .1,
        Some("invalid_frontmatter".into())
    );
    let p = plan(
        to_record(SMALL_DOC, oversized(1)),
        Source::External,
        Stage::Head,
        &s,
    );
    assert_eq!(p.status, Status::Applied);
    assert_eq!(
        p.effects,
        vec![Effect::ReindexUnindexedMarkdown {
            id: id(1),
            path: PATH.into(),
            doc: SMALL_DOC.into()
        }]
    );
    apply_both(&mut s, &p);
    assert_eq!(s.file(&id(1)), None);
    assert_eq!(s.tombstone(&id(1)), None);
    assert_eq!(&*s.record(&id(1)).unwrap().source, SMALL_DOC);
    assert_eq!(
        s.at_path_key(&path_key(PATH)),
        Some(PathHolder::Record(id(1)))
    );
    assert!(s.record_ids().contains(&id(1)));
    // Exactly the cap is a record again.
    let mut s = with_unindexed(oversized(1));
    let at_cap = format!(
        "---\nt: x\n---\n{}",
        "b".repeat(usize::try_from(RECORD_SOURCE_CAP_BYTES).unwrap() - 13)
    );
    assert_eq!(at_cap.len() as u64, RECORD_SOURCE_CAP_BYTES);
    let p = plan(
        to_record(&at_cap, oversized(1)),
        Source::External,
        Stage::Head,
        &s,
    );
    apply_both(&mut s, &p);
    assert!(s.record(&id(1)).is_some());
}

#[test]
fn delete_retains_kind_and_content_in_the_tombstone() {
    let mut s = with_unindexed(oversized(1));
    let p = plan(
        Op::FileDelete(FileDelete {
            id: id(1),
            if_revision: None,
            base: None,
        }),
        Source::Api,
        Stage::Head,
        &s,
    );
    apply_both(&mut s, &p);
    assert_eq!(
        s.tombstone(&id(1)),
        Some(Tombstone::File {
            path: PATH.into(),
            content: oversized(1),
            kind: FileKind::UnindexedOversizedMarkdown,
        })
    );
    // Resurrecting from the tombstone keeps the typed kind.
    let p = plan(put(oversized(1), None), Source::Api, Stage::Resurrect, &s);
    assert_eq!(p.status, Status::Merged);
    apply_both(&mut s, &p);
    assert_eq!(
        s.file(&id(1)).unwrap().kind,
        FileKind::UnindexedOversizedMarkdown
    );
}

#[test]
fn restored_content_follows_current_rename_and_keeps_both_on_cas_mismatch() {
    for matching in [false, true] {
        let mut s = with_unindexed(oversized(1));
        s.apply_effect(&Effect::PutUnindexedMarkdown {
            id: id(1),
            path: "notes/renamed.md".into(),
            content: oversized(1),
        });
        let p = plan(
            put(oversized(3), Some(oversized(if matching { 1 } else { 2 }))),
            Source::External,
            Stage::Resurrect,
            &s,
        );
        if matching {
            assert!(p.conflicts.is_empty());
            assert_eq!(
                p.effects,
                vec![Effect::PutUnindexedMarkdown {
                    id: id(1),
                    path: "notes/renamed.md".into(),
                    content: oversized(3)
                }]
            );
        } else {
            assert!(p.effects.is_empty());
            assert_eq!(p.conflicts.len(), 1);
            assert_eq!(
                p.conflicts[0].kept,
                ConflictValue::UnindexedMarkdown(oversized(1))
            );
            assert_eq!(
                p.conflicts[0].lost,
                ConflictValue::UnindexedMarkdown(oversized(3))
            );
        }
        let mut ov = Overlay::new(&s);
        ov.apply(&p);
        assert_eq!(ov.file(&id(1)).unwrap().path, "notes/renamed.md");
    }
}

#[test]
fn resurrect_preserves_opposite_kind_tombs_and_retains_both_descriptor_profiles() {
    let mut record = with_record(SMALL_DOC);
    record.apply_effect(&Effect::RemoveRecord {
        id: id(1),
        path: PATH.into(),
    });
    let mut states = vec![record];
    for content in [blob(1, 12), attachment(1, 12)] {
        let mut s = state();
        s.apply_effect(&match content {
            FileContent::Blob(blob) => Effect::PutFile {
                id: id(1),
                path: PATH.into(),
                blob,
            },
            FileContent::AttachmentV1(content) => Effect::PutAttachmentFile {
                id: id(1),
                path: PATH.into(),
                content,
            },
        });
        s.apply_effect(&Effect::RemoveFile {
            id: id(1),
            path: PATH.into(),
        });
        states.push(s);
    }
    for s in states {
        let original = s.tombstone(&id(1));
        assert!(original.is_some());
        for incoming in [oversized(3), attachment(3, RECORD_SOURCE_CAP_BYTES + 1)] {
            for prior in [None, Some(oversized(1))] {
                let p = plan(put(incoming, prior), Source::External, Stage::Resurrect, &s);
                assert_eq!(p.status, Status::Conflicted);
                assert!(p.effects.is_empty());
                assert_eq!(p.conflicts.len(), 1);
                assert_eq!(p.conflicts[0].kept, ConflictValue::Deleted);
                assert_eq!(
                    p.conflicts[0].lost,
                    ConflictValue::UnindexedMarkdown(incoming)
                );
                let mut ov = Overlay::new(&s);
                ov.apply(&p);
                assert_eq!(ov.tombstone(&id(1)), original);
                assert!(ov.file(&id(1)).is_none());
                assert!(ov.record(&id(1)).is_none());
            }
        }
    }
}

#[test]
fn resurrect_never_replays_either_kind_transition_even_with_matching_cas() {
    let record = with_record(SMALL_DOC);
    let file = with_unindexed(oversized(1));
    for s in [&record, &file] {
        for op in [
            to_file(oversized(3), revision(SMALL_DOC)),
            to_record(SMALL_DOC, oversized(1)),
            to_record("views: [", oversized(2)),
        ] {
            let p = plan(op, Source::External, Stage::Resurrect, s);
            assert!(p.effects.is_empty());
            assert!(p.conflicts.is_empty());
            assert_eq!(p.issues.len(), 1);
            assert_eq!(
                p.issues[0].issue.code,
                "unindexed_kind_transition_requires_capture"
            );
            let mut ov = Overlay::new(s);
            ov.apply(&p);
            assert_eq!(ov.record(&id(1)), s.record(&id(1)));
            assert_eq!(ov.file(&id(1)), s.file(&id(1)));
            assert_eq!(ov.tombstone(&id(1)), s.tombstone(&id(1)));
        }
    }
}

#[test]
fn restored_create_preserves_record_and_ordinary_holders_with_lost_descriptor_root() {
    let doc = "---\ntitle: saved\n---\nkept body\n";
    let s = with_record(doc);
    let p = plan(
        put(oversized(3), None),
        Source::External,
        Stage::Resurrect,
        &s,
    );
    assert!(p.effects.is_empty());
    assert_eq!(p.conflicts.len(), 1);
    assert_eq!(p.conflicts[0].kept, ConflictValue::Text(doc.into()));
    assert_eq!(
        p.conflicts[0].lost,
        ConflictValue::UnindexedMarkdown(oversized(3))
    );
    let mut ov = Overlay::new(&s);
    ov.apply(&p);
    assert_eq!(ov.record(&id(1)), s.record(&id(1)));
    assert!(ov.file(&id(1)).is_none());
    for content in [blob(1, 12), attachment(1, 12)] {
        let mut s = state();
        s.apply_effect(&match content {
            FileContent::Blob(blob) => Effect::PutFile {
                id: id(1),
                path: PATH.into(),
                blob,
            },
            FileContent::AttachmentV1(content) => Effect::PutAttachmentFile {
                id: id(1),
                path: PATH.into(),
                content,
            },
        });
        let p = plan(
            put(oversized(3), None),
            Source::External,
            Stage::Resurrect,
            &s,
        );
        assert!(p.effects.is_empty());
        assert_eq!(p.conflicts.len(), 1);
        assert_eq!(
            p.conflicts[0].lost,
            ConflictValue::UnindexedMarkdown(oversized(3))
        );
        let mut ov = Overlay::new(&s);
        ov.apply(&p);
        assert_eq!(ov.file(&id(1)), s.file(&id(1)));
    }
}
