//! Pure Op17 planning and atomic holder semantics; NOT provider/plaintext
//! authentication, Wire activation or complete setup-install qualification.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::result_large_err)]
use mdbn_core::ids::{Hash, Uuid, revision};
use mdbn_core::intent::Level;
use mdbn_core::intent::{
    AttachmentContentV1, AttachmentRefV1, BlobRef, ConflictMode, FileContent, FileKind, Mutation,
    Op, OpClock, OrdinaryFileToRecord, RECORD_SOURCE_CAP_BYTES, ResourcePut, Source,
};
use mdbn_core::paths::path_key;
use mdbn_core::plan::{Effect, PlanOptions, Planned, RejectCode, Rejection, Stage};
use mdbn_core::state::{MemState, Overlay, PathHolder, StateView};

const PATH: &str = "views/default.base";
const DOC: &str = "# owned source\r\nviews: []\r\nunknown: preserved\r\n";
fn id(n: u8) -> Uuid {
    Uuid([n; 16])
}
fn content(doc: &str, attachment: bool) -> FileContent {
    if attachment {
        FileContent::AttachmentV1(AttachmentContentV1 {
            reference: AttachmentRefV1 {
                collection: id(90),
                key_epoch: 1,
                attachment_id: [7; 32],
                manifest_cipher_hash: Hash::of(b"manifest"),
            },
            whole_plain_hash: revision(doc),
            total_plain_bytes: doc.len() as u64,
        })
    } else {
        FileContent::Blob(BlobRef {
            plain_hash: revision(doc),
            size: doc.len() as u64,
            blob_id: [7; 32],
            id_epoch: 1,
            part_size: 8_388_608,
        })
    }
}
fn state(doc: &str, attachment: bool, enabled: bool) -> MemState {
    let mut s = MemState::new();
    s.insert_resource(
        "mdbase.yaml",
        if enabled {
            "spec_version: '0.3.0'\nsettings:\n  record_extensions: [md, base]\n"
        } else {
            "spec_version: '0.3.0'\n"
        },
    );
    match content(doc, attachment) {
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
fn op(doc: &str, attachment: bool) -> Op {
    Op::OrdinaryFileToRecord(OrdinaryFileToRecord {
        id: id(1),
        path: PATH.into(),
        doc: doc.into(),
        prior: content(doc, attachment),
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
fn plan(s: &MemState, op: Op, source: Source, stage: Stage) -> Result<Planned, Rejection> {
    mdbn_core::plan(&mutation(vec![op], source), s, &PlanOptions { stage })
}
fn reason(s: &MemState, op: Op, stage: Stage) -> (RejectCode, Option<String>) {
    let r = plan(s, op, Source::Api, stage).unwrap_err();
    (r.code, r.reason)
}

#[test]
fn blob_and_attachment_keep_identity_exact_source_and_atomic_holder() {
    for attachment in [false, true] {
        for source in [Source::Api, Source::External] {
            let mut s = state(DOC, attachment, true);
            assert_eq!(s.file(&id(1)).unwrap().kind, FileKind::Ordinary);
            let p = plan(&s, op(DOC, attachment), source, Stage::Head).unwrap();
            assert_eq!(
                p.effects,
                vec![Effect::ReindexOrdinaryFile {
                    id: id(1),
                    path: PATH.into(),
                    doc: DOC.into()
                }]
            );
            let mut overlay = Overlay::new(&s);
            overlay.apply(&p);
            assert!(overlay.file(&id(1)).is_none());
            assert!(overlay.tombstone(&id(1)).is_none());
            assert_eq!(&*overlay.record(&id(1)).unwrap().source, DOC);
            assert_eq!(
                overlay.at_path_key(&path_key(PATH)),
                Some(PathHolder::Record(id(1)))
            );
            let expected = overlay.record(&id(1));
            s.apply(&p);
            assert_eq!(s.record(&id(1)), expected);
            assert!(s.file(&id(1)).is_none());
            assert!(s.tombstone(&id(1)).is_none());
        }
    }
}

#[test]
fn catalog_enablement_can_precede_promotion_in_one_atomic_plan() {
    let s = state(DOC, false, false);
    assert_eq!(
        reason(&s, op(DOC, false), Stage::Head).1.as_deref(),
        Some("not_a_record_path")
    );
    let put = Op::ResourcePut(ResourcePut {
        path: "mdbase.yaml".into(),
        doc: "spec_version: '0.3.0'\nsettings:\n  record_extensions: [md, base]\n".into(),
        base_revision: Some(revision(&s.resource("mdbase.yaml").unwrap())),
        must_not_exist: false,
    });
    let p = mdbn_core::plan(
        &mutation(vec![put, op(DOC, false)], Source::Api),
        &s,
        &PlanOptions { stage: Stage::Head },
    )
    .unwrap();
    assert_eq!(p.effects.len(), 2);
    assert!(s.record(&id(1)).is_none());
    assert!(s.file(&id(1)).is_some());
    let mut overlay = Overlay::new(&s);
    overlay.apply(&p);
    assert!(overlay.catalog().is_record_path(PATH));
    assert!(overlay.record(&id(1)).is_some());
    assert!(overlay.file(&id(1)).is_none());
}

#[test]
fn full_descriptor_cas_rejects_same_hash_reseals_and_moves_at_submit_and_head() {
    for attachment in [false, true] {
        for stage in [
            Stage::Submit {
                level: Level::Error,
            },
            Stage::Head,
        ] {
            let s = state(DOC, attachment, true);
            let Op::OrdinaryFileToRecord(mut f) = op(DOC, attachment) else {
                unreachable!()
            };
            match &mut f.prior {
                FileContent::Blob(b) => b.blob_id = [8; 32],
                FileContent::AttachmentV1(a) => a.reference.key_epoch += 1,
            }
            assert_eq!(
                reason(&s, Op::OrdinaryFileToRecord(f), stage),
                (RejectCode::Conflict, Some("revision".into()))
            );
            let Op::OrdinaryFileToRecord(mut f) = op(DOC, attachment) else {
                unreachable!()
            };
            f.path = "views/moved.base".into();
            assert_eq!(
                reason(&s, Op::OrdinaryFileToRecord(f), stage),
                (RejectCode::Conflict, Some("revision".into()))
            );
            assert!(s.record(&id(1)).is_none());
            assert!(s.file(&id(1)).is_some());
        }
    }
}

#[test]
fn resurrection_preserves_files_and_reports_fresh_setup_requirement() {
    for attachment in [false, true] {
        let s = state(DOC, attachment, true);
        for incoming in [op(DOC, attachment), op("views: [", attachment)] {
            let p = plan(&s, incoming, Source::Api, Stage::Resurrect).unwrap();
            assert!(p.effects.is_empty());
            assert_eq!(p.issues.len(), 1);
            assert_eq!(p.issues[0].id, id(1));
            assert_eq!(
                p.issues[0].issue.code,
                "ordinary_file_promotion_requires_setup"
            );
            let mut overlay = Overlay::new(&s);
            overlay.apply(&p);
            assert_eq!(overlay.file(&id(1)), s.file(&id(1)));
            assert_eq!(overlay.tombstone(&id(1)), s.tombstone(&id(1)));
            assert!(overlay.record(&id(1)).is_none());
        }
    }
}

#[test]
fn source_hash_and_exact_byte_length_are_independent_checks() {
    let s = state(DOC, false, true);
    for doc in [DOC.replace("owned", "other"), format!("{DOC}\n")] {
        let Op::OrdinaryFileToRecord(mut f) = op(DOC, false) else {
            unreachable!()
        };
        f.doc = doc;
        assert_eq!(
            reason(&s, Op::OrdinaryFileToRecord(f), Stage::Head)
                .1
                .as_deref(),
            Some("promotion_source_mismatch")
        );
    }
}

#[test]
fn excluded_and_resource_paths_refuse_even_with_base_enabled() {
    let mut s = state(DOC, false, true);
    s.insert_resource("mdbase.yaml", "spec_version: '0.3.0'\nsettings:\n  record_extensions: [md, base]\n  exclude: ['views/**']\n");
    assert_eq!(
        reason(&s, op(DOC, false), Stage::Head).1.as_deref(),
        Some("not_a_record_path")
    );
    let mut s = state(DOC, false, true);
    let FileContent::Blob(blob) = content(DOC, false) else {
        unreachable!()
    };
    s.apply_effect(&Effect::PutFile {
        id: id(1),
        path: "types/base.yaml".into(),
        blob,
    });
    let Op::OrdinaryFileToRecord(mut f) = op(DOC, false) else {
        unreachable!()
    };
    f.path = "types/base.yaml".into();
    assert_eq!(
        reason(&s, Op::OrdinaryFileToRecord(f), Stage::Head)
            .1
            .as_deref(),
        Some("not_a_record_path")
    );
}

#[test]
fn exact_length_binding_refuses_even_when_the_hash_matches() {
    let mut s = state(DOC, false, true);
    let FileContent::Blob(mut blob) = content(DOC, false) else {
        unreachable!()
    };
    blob.size += 1;
    s.apply_effect(&Effect::PutFile {
        id: id(1),
        path: PATH.into(),
        blob,
    });
    let Op::OrdinaryFileToRecord(mut f) = op(DOC, false) else {
        unreachable!()
    };
    f.prior = FileContent::Blob(blob);
    assert_eq!(
        reason(&s, Op::OrdinaryFileToRecord(f), Stage::Head)
            .1
            .as_deref(),
        Some("promotion_source_mismatch")
    );
}

#[test]
fn absent_record_tombstone_and_unindexed_holders_never_promote() {
    let mut s = state(DOC, false, true);
    s.apply_effect(&Effect::RemoveFile {
        id: id(1),
        path: PATH.into(),
    });
    assert_eq!(
        reason(&s, op(DOC, false), Stage::Head).0,
        RejectCode::NotFound
    );
    let mut s = state(DOC, false, true);
    s.apply_effect(&Effect::PutUnindexedMarkdown {
        id: id(1),
        path: PATH.into(),
        content: content(DOC, false),
    });
    assert_eq!(
        reason(&s, op(DOC, false), Stage::Head).1.as_deref(),
        Some("kind_mismatch")
    );
    let mut s = MemState::new();
    s.insert_record(id(1), PATH, DOC);
    assert_eq!(
        reason(&s, op(DOC, false), Stage::Head).0,
        RejectCode::NotFound
    );
    assert_eq!(
        reason(&MemState::new(), op(DOC, false), Stage::Head).0,
        RejectCode::NotFound
    );
}

#[test]
fn malformed_nonmapping_and_structurally_oversized_sources_stay_files() {
    for doc in ["views: [", "[]", "hello", "", "~"] {
        let s = state(doc, false, true);
        assert_eq!(
            reason(&s, op(doc, false), Stage::Head).1.as_deref(),
            Some("invalid_frontmatter")
        );
        assert!(s.file(&id(1)).is_some());
        assert!(s.record(&id(1)).is_none());
    }
    let doc = format!("views: []\nx: {}\n", "[".repeat(100));
    let s = state(&doc, false, true);
    assert!(plan(&s, op(&doc, false), Source::Api, Stage::Head).is_err());
}

#[test]
fn exact_synced_cap_is_a_candidate_and_over_cap_refuses() {
    let mut doc = "views: []\n# ".to_owned();
    doc.push_str(&"a".repeat(RECORD_SOURCE_CAP_BYTES as usize - doc.len()));
    let s = state(&doc, false, true);
    let p = plan(&s, op(&doc, false), Source::Api, Stage::Head).unwrap();
    mdbn_core::plan::admission::RecordWriteAdmission::Synced
        .check_planned(&p)
        .unwrap();
    mdbn_core::plan::frontmatter_admission::check_planned(&p).unwrap();
    doc.push('a');
    let s = state(&doc, false, true);
    assert_eq!(
        reason(&s, op(&doc, false), Stage::Head),
        (RejectCode::TooLarge, Some("record_too_large".into()))
    );
}

#[test]
fn planned_guards_cover_generated_promotion_effects() {
    let s = state(DOC, false, true);
    let mut p = plan(&s, op(DOC, false), Source::Api, Stage::Head).unwrap();
    if let Effect::ReindexOrdinaryFile { doc, .. } = &mut p.effects[0] {
        *doc = "a".repeat(RECORD_SOURCE_CAP_BYTES as usize + 1);
    }
    assert!(
        mdbn_core::plan::admission::RecordWriteAdmission::Synced
            .check_planned(&p)
            .is_err()
    );
    if let Effect::ReindexOrdinaryFile { doc, .. } = &mut p.effects[0] {
        *doc = format!("x: [{}0{}", "[".repeat(100), "]".repeat(101));
    }
    assert!(mdbn_core::plan::frontmatter_admission::check_planned(&p).is_err());
}
