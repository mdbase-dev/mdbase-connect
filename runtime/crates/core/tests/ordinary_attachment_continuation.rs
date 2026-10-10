//! Pure Op18 semantics; no plaintext/provider proof or receiver activation.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::result_large_err)]
use mdbn_core::{
    ids::{Hash, Uuid},
    intent::{
        AttachmentContentV1, AttachmentRefV1, BlobRef, ConflictMode, FileContent, FileKind, Level,
        Mutation, Op, OpClock, OrdinaryAttachmentContinuation, Source,
    },
    plan::{ConflictKind, ConflictValue, Effect, PlanOptions, Planned, Rejection, Stage},
    state::{MemState, Overlay, StateView},
};
const PATH: &str = "notes/ordinary.md";
fn id(n: u8) -> Uuid {
    Uuid([n; 16])
}
fn attachment(n: u8) -> AttachmentContentV1 {
    AttachmentContentV1 {
        reference: AttachmentRefV1 {
            collection: id(90),
            key_epoch: 1,
            attachment_id: [n; 32],
            manifest_cipher_hash: Hash::of(&[n]),
        },
        whole_plain_hash: Hash::of(&[n, 7]),
        total_plain_bytes: 1_048_577,
    }
}
fn prior(attachment_form: bool) -> FileContent {
    if attachment_form {
        FileContent::AttachmentV1(attachment(1))
    } else {
        FileContent::Blob(BlobRef {
            plain_hash: Hash::of(b"prior"),
            blob_id: [1; 32],
            id_epoch: 1,
            size: 1_048_577,
            part_size: 8_388_608,
        })
    }
}
fn state(content: FileContent) -> MemState {
    let mut s = MemState::new();
    s.insert_resource("mdbase.yaml", "spec_version: '0.3.0'\n");
    match content {
        FileContent::Blob(blob) => s.apply_effect(&Effect::PutFile {
            id: id(1),
            path: PATH.into(),
            blob,
        }),
        FileContent::AttachmentV1(content) => s.apply_effect(&Effect::PutAttachmentFile {
            id: id(1),
            path: PATH.into(),
            content,
        }),
    }
    s
}
fn op(prior: FileContent) -> Op {
    Op::OrdinaryAttachmentContinuation(OrdinaryAttachmentContinuation {
        id: id(1),
        path: PATH.into(),
        content: attachment(2),
        prior,
    })
}
fn mutation(ops: Vec<Op>, source: Source) -> Mutation {
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
        ops,
        on_behalf: None,
        conflict_mode: ConflictMode::Record,
        validated_at: None,
        room: None,
    }
}
fn plan(s: &MemState, op: Op, stage: Stage) -> Result<Planned, Rejection> {
    mdbn_core::plan(
        &mutation(vec![op], Source::External),
        s,
        &PlanOptions { stage },
    )
}
#[test]
fn exact_blob_and_attachment_prior_preserve_identity_kind_path_and_use_only_effect8() {
    for form in [false, true] {
        for stage in [
            Stage::Submit {
                level: Level::Error,
            },
            Stage::Head,
            Stage::Resurrect,
        ] {
            for source in [Source::Api, Source::External] {
                let mut s = state(prior(form));
                let p = mdbn_core::plan(
                    &mutation(vec![op(prior(form))], source),
                    &s,
                    &PlanOptions { stage },
                )
                .unwrap();
                assert_eq!(
                    p.effects,
                    vec![Effect::PutAttachmentFile {
                        id: id(1),
                        path: PATH.into(),
                        content: attachment(2)
                    }]
                );
                assert!(p.conflicts.is_empty());
                let mut overlay = Overlay::new(&s);
                overlay.apply(&p);
                let expected = overlay.file(&id(1)).unwrap();
                s.apply(&p);
                assert_eq!(s.file(&id(1)).unwrap(), expected);
                assert_eq!(expected.kind, FileKind::Ordinary);
                assert_eq!(expected.path, PATH);
                assert!(s.record(&id(1)).is_none());
                assert!(s.tombstone(&id(1)).is_none());
            }
        }
    }
}
fn drift(form: bool, case: &str) -> MemState {
    let mut s = state(prior(form));
    match case {
        "reseal" | "epoch" | "attachment_id" | "size" => {
            let mut c = prior(form);
            match &mut c {
                FileContent::AttachmentV1(c) => match case {
                    "reseal" => c.reference.manifest_cipher_hash = Hash::of(b"another seal"),
                    "epoch" => c.reference.key_epoch += 1,
                    "attachment_id" => c.reference.attachment_id = [3; 32],
                    "size" => c.total_plain_bytes += 1,
                    _ => unreachable!(),
                },
                FileContent::Blob(b) => match case {
                    "reseal" | "attachment_id" => b.blob_id = [3; 32],
                    "epoch" => b.id_epoch += 1,
                    "size" => b.size += 1,
                    _ => unreachable!(),
                },
            }
            s = state(c);
        }
        "missing" => {
            s = MemState::new();
            s.insert_resource("mdbase.yaml", "spec_version: '0.3.0'\n");
        }
        "tomb" => s.apply_effect(&Effect::RemoveFile {
            id: id(1),
            path: PATH.into(),
        }),
        "record" => {
            s = MemState::new();
            s.insert_resource("mdbase.yaml", "spec_version: '0.3.0'\n");
            s.insert_record(id(1), PATH, "current record");
        }
        "native" => s.apply_effect(&Effect::PutUnindexedMarkdown {
            id: id(1),
            path: PATH.into(),
            content: prior(form),
        }),
        "moved" => s.apply_effect(&Effect::PutAttachmentFile {
            id: id(1),
            path: "latest.md".into(),
            content: attachment(1),
        }),
        "catalog" => s.insert_resource(
            "mdbase.yaml",
            "spec_version: '0.3.0'\nsettings:\n  record_extensions: [base]\n",
        ),
        _ => unreachable!(),
    }
    s
}
#[test]
fn full_descriptor_and_lifecycle_cas_never_create_convert_move_or_ignore_same_hash_drift() {
    for form in [false, true] {
        for case in [
            "reseal",
            "epoch",
            "attachment_id",
            "size",
            "missing",
            "tomb",
            "record",
            "native",
            "moved",
            "catalog",
        ] {
            let mut s = drift(form, case);
            let file_before = s.file(&id(1));
            let record_before = s.record(&id(1));
            let tomb_before = s.tombstone(&id(1));
            for stage in [
                Stage::Submit {
                    level: Level::Error,
                },
                Stage::Head,
            ] {
                assert!(
                    plan(&s, op(prior(form)), stage).is_err(),
                    "form={form}, {case}"
                );
            }
            let p = plan(&s, op(prior(form)), Stage::Resurrect).unwrap();
            assert!(p.effects.is_empty(), "form={form}, {case}");
            assert_eq!(p.conflicts.len(), 1);
            let c = &p.conflicts[0];
            assert_eq!(c.id, id(1));
            assert_eq!(c.kind, ConflictKind::File);
            assert_eq!(
                c.lost,
                ConflictValue::Attachment(attachment(2)),
                "new attachment is retained/recoverable"
            );
            assert_eq!(
                c.base,
                Some(match prior(form) {
                    FileContent::Blob(b) => ConflictValue::Blob(b),
                    FileContent::AttachmentV1(c) => ConflictValue::Attachment(c),
                })
            );
            if case == "native" {
                assert!(matches!(c.kept, ConflictValue::UnindexedMarkdown(_)));
            }
            if case == "record" {
                assert_eq!(c.kept, ConflictValue::Text("current record".into()));
            }
            if matches!(case, "missing" | "tomb") {
                assert_eq!(c.kept, ConflictValue::Deleted);
            }
            s.apply(&p);
            assert_eq!(s.file(&id(1)), file_before);
            assert_eq!(s.record(&id(1)), record_before);
            assert_eq!(s.tombstone(&id(1)), tomb_before);
        }
    }
}
#[test]
fn api_exclusion_preserves_current_holder_and_reports_excluded_not_holder_drift() {
    for form in [false, true] {
        let mut s = state(prior(form));
        s.insert_resource(
            "mdbase.yaml",
            "spec_version: '0.3.0'\nsettings:\n  exclude: ['notes/**']\n",
        );
        let before = s.file(&id(1));
        for stage in [
            Stage::Submit {
                level: Level::Error,
            },
            Stage::Head,
        ] {
            let error = mdbn_core::plan(
                &mutation(vec![op(prior(form))], Source::Api),
                &s,
                &PlanOptions { stage },
            )
            .unwrap_err();
            assert_eq!(error.reason.as_deref(), Some("excluded"));
            assert_eq!(s.file(&id(1)), before);
        }
        let restored = mdbn_core::plan(
            &mutation(vec![op(prior(form))], Source::Api),
            &s,
            &PlanOptions {
                stage: Stage::Resurrect,
            },
        )
        .unwrap();
        assert!(restored.effects.is_empty());
        assert_eq!(
            restored.conflicts.len(),
            1,
            "resurrect retains acknowledged new content"
        );
        assert_eq!(
            restored.conflicts[0].lost,
            ConflictValue::Attachment(attachment(2))
        );
        s.apply(&restored);
        assert_eq!(s.file(&id(1)), before);
    }
}

#[test]
fn static_paths_and_duplicate_identity_or_path_batches_remain_rejected() {
    let s = state(prior(true));
    for path in ["../outside.md", ".mdbase/a.md", "files/a.bin"] {
        let mut op = op(prior(true));
        let Op::OrdinaryAttachmentContinuation(ref mut c) = op else {
            panic!()
        };
        c.path = path.into();
        assert!(plan(&s, op, Stage::Head).is_err());
    }
    for source in [Source::Api, Source::External] {
        let result = mdbn_core::plan(
            &mutation(vec![op(prior(true)), op(prior(true))], source),
            &s,
            &PlanOptions { stage: Stage::Head },
        );
        assert!(result.is_err());
    }
}
