//! Pure attachment planning/state semantics, not manifest/authority verification.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use mdbn_core::ids::{Hash, Uuid};
use mdbn_core::intent::{
    AttachmentContentV1, AttachmentRefV1, BlobRef, ConflictMode, FileAttach, FileContent,
    FileDelete, FileInclusion, FileKind, FileMove, FilePut, Mutation, Op, OpClock, Source,
};
use mdbn_core::paths::path_key;
use mdbn_core::plan::{ConflictKind, ConflictValue, Effect, PlanOptions, Stage, Status};
use mdbn_core::state::{MemState, Overlay, PathHolder, StateView, Tombstone};

fn id(n: u8) -> Uuid {
    let mut b = [0; 16];
    b[0] = 1;
    b[15] = n;
    Uuid(b)
}
fn content(n: u8) -> AttachmentContentV1 {
    AttachmentContentV1 {
        reference: AttachmentRefV1 {
            collection: id(90),
            key_epoch: 1,
            attachment_id: [n; 32],
            manifest_cipher_hash: Hash::of(&[n]),
        },
        whole_plain_hash: Hash::of(&[n, 7]),
        total_plain_bytes: 1 << 30,
    }
}
fn blob(hash: Hash) -> BlobRef {
    BlobRef {
        plain_hash: hash,
        size: 17,
        blob_id: [9; 32],
        id_epoch: 1,
        part_size: 17,
    }
}
fn state() -> MemState {
    let mut s = MemState::new();
    s.insert_resource("mdbase.yaml", "spec_version: '0.3.0'\n");
    s
}
fn seeded(a: AttachmentContentV1) -> MemState {
    let mut s = state();
    s.apply_effect(&Effect::PutAttachmentFile {
        id: id(1),
        path: "files/a.bin".into(),
        content: a,
    });
    s
}
fn attach(a: AttachmentContentV1) -> Op {
    Op::FileAttach(FileAttach {
        id: id(1),
        path: "files/a.bin".into(),
        content: a,
        if_revision: None,
        base: None,
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
fn plan(op: Op, source: Source, stage: Stage, s: &MemState) -> mdbn_core::plan::Planned {
    mdbn_core::plan(&mutation(op, source), s, &PlanOptions { stage }).unwrap()
}
fn apply_both(s: &mut MemState, p: &mdbn_core::plan::Planned) {
    let mut ov = Overlay::new(s);
    ov.apply(p);
    let expected = ov.file(&id(1));
    let tombstone = ov.tombstone(&id(1));
    s.apply(p);
    assert_eq!(s.file(&id(1)), expected);
    assert_eq!(s.tombstone(&id(1)), tombstone);
}

#[test]
fn whole_metadata_is_exact_and_not_an_allocation() {
    let mut a = content(1);
    a.total_plain_bytes = u64::MAX;
    let c = FileContent::AttachmentV1(a);
    assert_eq!(c.size(), u64::MAX);
    assert_eq!(c.plain_hash(), a.whole_plain_hash);
    assert_ne!(c, FileContent::Blob(blob(a.whole_plain_hash)));
}
#[test]
fn create_uses_explicit_effect_and_same_file_namespace() {
    let mut s = state();
    let a = content(1);
    let p = plan(attach(a), Source::Api, Stage::Head, &s);
    assert_eq!(
        p.effects,
        vec![Effect::PutAttachmentFile {
            id: id(1),
            path: "files/a.bin".into(),
            content: a
        }]
    );
    apply_both(&mut s, &p);
    assert_eq!(
        s.file(&id(1)).unwrap().content,
        FileContent::AttachmentV1(a)
    );
    assert_eq!(
        s.at_path_key(&path_key("files/a.bin")),
        Some(PathHolder::File(id(1)))
    );
}
#[test]
fn exact_content_is_noop_but_same_hash_rekey_and_reseal_emit() {
    let a = content(1);
    let mut s = seeded(a);
    assert!(
        plan(attach(a), Source::Api, Stage::Head, &s)
            .effects
            .is_empty()
    );
    let mut rekey = a;
    rekey.reference.key_epoch = 2;
    let p = plan(attach(rekey), Source::Api, Stage::Head, &s);
    assert_eq!(p.effects.len(), 1);
    apply_both(&mut s, &p);
    let mut reseal = rekey;
    reseal.reference.manifest_cipher_hash = Hash::of(b"resealed");
    let p = plan(attach(reseal), Source::Api, Stage::Head, &s);
    assert_eq!(p.effects.len(), 1);
    apply_both(&mut s, &p);
    assert_eq!(
        s.file(&id(1)).unwrap().content,
        FileContent::AttachmentV1(reseal)
    );
}
#[test]
fn same_hash_representation_changes_are_not_silently_dropped() {
    let a = content(1);
    let b = blob(a.whole_plain_hash);
    let mut s = state();
    s.apply_effect(&Effect::PutFile {
        id: id(1),
        path: "files/a.bin".into(),
        blob: b,
    });
    let p = plan(attach(a), Source::Api, Stage::Head, &s);
    assert!(matches!(p.effects[0], Effect::PutAttachmentFile { .. }));
    apply_both(&mut s, &p);
    let p = plan(
        Op::FilePut(FilePut {
            id: id(1),
            path: "files/a.bin".into(),
            blob: b,
            if_revision: Some(a.whole_plain_hash),
            base: None,
        }),
        Source::Api,
        Stage::Head,
        &s,
    );
    assert!(matches!(p.effects[0], Effect::PutFile { .. }));
    apply_both(&mut s, &p);
    assert_eq!(s.file(&id(1)).unwrap().content, FileContent::Blob(b));
}
#[test]
fn legacy_blob_same_plaintext_noop_is_preserved() {
    let b = blob(Hash::of(b"legacy"));
    let mut s = state();
    s.apply_effect(&Effect::PutFile {
        id: id(1),
        path: "files/a.bin".into(),
        blob: b,
    });
    let mut reseal = b;
    reseal.id_epoch = 2;
    reseal.blob_id = [10; 32];
    let p = plan(
        Op::FilePut(FilePut {
            id: id(1),
            path: "files/a.bin".into(),
            blob: reseal,
            if_revision: None,
            base: None,
        }),
        Source::Api,
        Stage::Head,
        &s,
    );
    assert!(p.effects.is_empty());
    assert_eq!(s.file(&id(1)).unwrap().content, FileContent::Blob(b));
}
#[test]
fn api_stale_whole_revision_rejects_without_changing_state() {
    let a = content(1);
    let s = seeded(a);
    let mut op = attach(content(2));
    let Op::FileAttach(f) = &mut op else {
        panic!("fixture")
    };
    f.if_revision = Some(Hash::of(b"stale"));
    let r = mdbn_core::plan(
        &mutation(op, Source::Api),
        &s,
        &PlanOptions { stage: Stage::Head },
    )
    .unwrap_err();
    assert_eq!(r.reason.as_deref(), Some("revision"));
    assert_eq!(
        s.file(&id(1)).unwrap().content,
        FileContent::AttachmentV1(a)
    );
}
#[test]
fn external_stale_base_preserves_both_descriptors_as_conflict() {
    let a = content(1);
    let b = content(2);
    let s = seeded(a);
    let mut op = attach(b);
    let Op::FileAttach(f) = &mut op else {
        panic!("fixture")
    };
    f.base = Some(Hash::of(b"stale"));
    let p = plan(op, Source::External, Stage::Head, &s);
    assert!(p.effects.is_empty());
    assert_eq!(p.conflicts.len(), 1);
    assert_eq!(p.conflicts[0].kind, ConflictKind::File);
    assert_eq!(p.conflicts[0].kept, ConflictValue::Attachment(a));
    assert_eq!(p.conflicts[0].lost, ConflictValue::Attachment(b));
}
#[test]
fn resurrection_stale_cas_retains_even_same_hash_new_context() {
    let a = content(1);
    let mut b = a;
    b.reference.key_epoch = 2;
    let s = seeded(a);
    let mut op = attach(b);
    let Op::FileAttach(f) = &mut op else {
        panic!("fixture")
    };
    f.if_revision = Some(Hash::of(b"stale"));
    let p = plan(op, Source::Api, Stage::Resurrect, &s);
    assert!(p.effects.is_empty());
    assert_eq!(p.conflicts.len(), 1);
    assert_eq!(p.conflicts[0].kept, ConflictValue::Attachment(a));
    assert_eq!(p.conflicts[0].lost, ConflictValue::Attachment(b));
}
#[test]
fn delete_and_resurrect_keep_complete_content_and_path() {
    let a = content(1);
    let mut s = seeded(a);
    let p = plan(
        Op::FileDelete(FileDelete {
            id: id(1),
            if_revision: Some(a.whole_plain_hash),
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
            path: "files/a.bin".into(),
            content: FileContent::AttachmentV1(a),
            kind: FileKind::Ordinary,
        })
    );
    let p = plan(attach(a), Source::Api, Stage::Resurrect, &s);
    assert_eq!(p.status, Status::Merged);
    apply_both(&mut s, &p);
    assert!(s.tombstone(&id(1)).is_none());
}
#[test]
fn stale_delete_holds_attachment_root_in_conflict() {
    let a = content(1);
    let s = seeded(a);
    let p = plan(
        Op::FileDelete(FileDelete {
            id: id(1),
            if_revision: None,
            base: Some(Hash::of(b"stale")),
        }),
        Source::External,
        Stage::Head,
        &s,
    );
    assert!(p.effects.is_empty());
    assert_eq!(p.conflicts[0].kept, ConflictValue::Attachment(a));
    assert_eq!(p.conflicts[0].lost, ConflictValue::Deleted);
}
#[test]
fn move_preserves_descriptor_and_updates_path_indexes() {
    let a = content(1);
    let mut s = seeded(a);
    let p = plan(
        Op::FileMove(FileMove {
            id: id(1),
            from: "files/a.bin".into(),
            to: "files/b.bin".into(),
            update_refs: false,
            if_revision: Some(a.whole_plain_hash),
        }),
        Source::Api,
        Stage::Head,
        &s,
    );
    assert_eq!(
        p.effects,
        vec![Effect::PutAttachmentFile {
            id: id(1),
            path: "files/b.bin".into(),
            content: a
        }]
    );
    apply_both(&mut s, &p);
    assert_eq!(s.at_path_key(&path_key("files/a.bin")), None);
    assert_eq!(
        s.at_path_key(&path_key("files/b.bin")),
        Some(PathHolder::File(id(1)))
    );
}
#[test]
fn collision_rejects_api_and_external_allocates_deterministically() {
    let a = content(1);
    let mut s = state();
    s.apply_effect(&Effect::PutFile {
        id: id(2),
        path: "files/a.bin".into(),
        blob: blob(Hash::of(b"taken")),
    });
    let r = mdbn_core::plan(
        &mutation(attach(a), Source::Api),
        &s,
        &PlanOptions { stage: Stage::Head },
    )
    .unwrap_err();
    assert_eq!(r.reason.as_deref(), Some("path_taken"));
    let p = plan(attach(a), Source::External, Stage::Head, &s);
    let q = plan(attach(a), Source::External, Stage::Head, &s);
    assert_eq!(p, q);
    let Effect::PutAttachmentFile { path, .. } = &p.effects[0] else {
        panic!("fixture")
    };
    assert_ne!(path, "files/a.bin");
    apply_both(&mut s, &p);
    assert_eq!(s.file(&id(2)).unwrap().path, "files/a.bin");
}
#[test]
fn resource_record_excluded_and_unsafe_paths_remain_denied() {
    for path in [
        "_types/definition.json",
        "notes/record.md",
        "../escape.bin",
        ".hidden/a.bin",
    ] {
        let mut op = attach(content(1));
        let Op::FileAttach(f) = &mut op else {
            panic!("fixture")
        };
        f.path = path.into();
        assert!(
            mdbn_core::plan(
                &mutation(op, Source::Api),
                &state(),
                &PlanOptions { stage: Stage::Head }
            )
            .is_err(),
            "{path}"
        );
    }
    let mut s = state();
    let policy = FileInclusion {
        max_size: Some(100),
        ..FileInclusion::default()
    };
    s.apply_effect(&Effect::PutSettings(policy));
    let r = mdbn_core::plan(
        &mutation(attach(content(1)), Source::Api),
        &s,
        &PlanOptions { stage: Stage::Head },
    )
    .unwrap_err();
    assert_eq!(r.reason.as_deref(), Some("excluded"));
}
