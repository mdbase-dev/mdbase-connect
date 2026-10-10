//! Normal generator values for the explicitly selected runtime parent family.
use super::*;
use crate::attachment_runtime_v1 as r;

pub(super) fn runtime_mutation() -> r::Mutation {
    let mut v = r::Mutation::from(mutation(vec![
        update_op(),
        Op::FileDelete(FileDelete {
            id: b16(FILE),
            if_revision: None,
            base: None,
        }),
    ]));
    v.ops.insert(
        1,
        r::Op::FileAttach(FileAttach {
            id: b16(FILE),
            path: "assets/photo.webp".into(),
            content: attachment_content(),
            if_revision: Some(b32(0xb3)),
            base: Some(b32(0xb4)),
        }),
    );
    v.on_behalf = Some(b16(GRANT));
    v.conflict_mode = Some(ConflictMode::Record);
    v.room = Some(RoomCheckpoint {
        stream: b16(DEVICE),
        state: b32(0x77),
    });
    v
}
fn conflict() -> r::Conflict {
    r::Conflict {
        kind: ConflictKind::File,
        id: b16(FILE),
        field: None,
        base: Some(r::ConflictValue::Legacy(ConflictValue::Blob(blob()))),
        kept: r::ConflictValue::Attachment(attachment_content()),
        lost: r::ConflictValue::Legacy(ConflictValue::Deleted),
    }
}
pub(super) fn runtime_entry() -> r::EntryPayload {
    r::EntryPayload {
        sem: Version { major: 1, minor: 0 },
        mutation: runtime_mutation(),
        status: Status::Conflicted,
        effects: vec![
            r::Effect::Legacy(Effect::PutRecord(PutRecord {
                id: b16(RECORD),
                path: "tasks/a.md".into(),
                doc: Text::Index(0),
            })),
            r::Effect::PutAttachmentFile(PutAttachmentFile {
                id: b16(FILE),
                path: "assets/photo.webp".into(),
                content: attachment_content(),
            }),
            r::Effect::Legacy(Effect::PutSettings(PutSettings {
                inclusion: FileInclusion {
                    include: vec![MediaClass::Image],
                    exclude: None,
                    max_size: Some(1 << 30),
                },
            })),
        ],
        conflicts: Some(vec![conflict()]),
        aliases: Some(vec![Alias {
            path: "tasks/old.md".into(),
            record: b16(RECORD),
        }]),
        texts: Some(vec![TextDef::Literal("---\nstatus: open\n---\n".into())]),
        resurrect: Some(41),
    }
}
pub(super) fn runtime_manifest() -> r::ManifestPayload {
    r::ManifestPayload {
        seq: 42,
        chain: b32(0xc4),
        state_digest: b32(0xc5),
        bucket_bits: 0,
        sections: vec![
            r::Section {
                kind: r::SectionKind::Legacy(SectionKind::Resources),
                chunks: vec![],
            },
            r::Section {
                kind: r::SectionKind::AttachmentFiles,
                chunks: vec![ChunkRef {
                    address: b32(0xa4),
                    plain_hash: b32(0xa5),
                    rows: 3,
                    bucket: 0,
                    plain_size: 600,
                }],
            },
            r::Section {
                kind: r::SectionKind::AttachmentTombstones,
                chunks: vec![],
            },
        ],
        horizon: Horizon {
            seq_floor: 1,
            time_floor: 0,
        },
        sem: Version { major: 1, minor: 0 },
        record_count: 1,
        file_count: 3,
        previous: Some(b32(0xa6)),
        control_chain: b32(0xa7),
    }
}
fn file_chunk() -> r::ChunkPayload {
    r::ChunkPayload {
        section: r::SectionKind::AttachmentFiles,
        bucket: 0,
        rows: (1..=3)
            .map(|n| {
                AttachmentFileRowV1 {
                    id: B16([n; 16]),
                    path: format!("assets/{n}.webp"),
                    content: attachment_content(),
                    media: MediaClass::Image,
                }
                .to_cbor()
            })
            .collect(),
    }
}
fn tomb_chunk() -> r::ChunkPayload {
    r::ChunkPayload {
        section: r::SectionKind::AttachmentTombstones,
        bucket: 0,
        rows: vec![
            AttachmentTombstoneRowV1 {
                id: b16(FILE),
                path: "assets/old.webp".into(),
                content: attachment_content(),
                seq: 41,
                time: 1_791_100_800_000,
            }
            .to_cbor(),
        ],
    }
}
fn continuation_mutation() -> r::Mutation {
    let mut m = runtime_mutation();
    m.ops[1] = r::Op::OrdinaryAttachmentContinuation(OrdinaryAttachmentContinuation {
        id: b16(FILE),
        path: "notes/ordinary.md".into(),
        content: attachment_content(),
        prior: FileContent::Blob(blob()),
    });
    m.on_behalf = None;
    m
}
pub(super) fn positive() -> Vec<Fixture> {
    let mut continued = runtime_entry();
    continued.mutation = continuation_mutation();
    vec![
        fx(
            "mutation",
            "runtime-v1-ordinary-continuation",
            continuation_mutation(),
        ),
        fx("entry", "runtime-v1-ordinary-continuation", continued),
        fx("mutation", "runtime-v1-mixed", runtime_mutation()),
        fx("entry", "runtime-v1-mixed", runtime_entry()),
        fx("manifest", "runtime-v1-attachments", runtime_manifest()),
        fx("chunk", "runtime-v1-files", file_chunk()),
        fx("chunk", "runtime-v1-tombstones", tomb_chunk()),
        fx(
            "chunk",
            "runtime-v1-conflicts",
            r::ChunkPayload {
                section: r::SectionKind::Legacy(SectionKind::Conflicts),
                bucket: 0,
                rows: vec![
                    r::ConflictRow {
                        mutation: b16(MUTATION),
                        seq: 42,
                        conflict: conflict(),
                    }
                    .to_cbor(),
                ],
            },
        ),
    ]
}
fn field(c: &mut Cbor, key: u64) -> &mut Cbor {
    let Cbor::Map(m) = c else {
        panic!("fixture map")
    };
    &mut m
        .iter_mut()
        .find(|(k, _)| *k == Cbor::Uint(key))
        .expect("fixture field")
        .1
}
fn element(c: &mut Cbor, i: usize) -> &mut Cbor {
    let Cbor::Array(v) = c else {
        panic!("fixture array")
    };
    &mut v[i]
}
pub(super) fn negative() -> Vec<BadFixture> {
    let mut short_prior = continuation_mutation().to_cbor();
    *field(field(element(field(&mut short_prior, 6), 1), 4), 0) = Cbor::Bytes(vec![0; 31]);
    let m = runtime_mutation().to_cbor();
    let mut unknown_op = m.clone();
    *field(element(field(&mut unknown_op, 6), 1), 0) = Cbor::Uint(19);
    let mut unknown_content = m.clone();
    *element(field(element(field(&mut unknown_content, 6), 1), 3), 0) = Cbor::Uint(2);
    let mut short_hash = m;
    *element(
        element(field(element(field(&mut short_hash, 6), 1), 3), 1),
        5,
    ) = Cbor::Bytes(vec![0; 31]);
    // Isolate effect/conflict failures from the critical mutation child.
    let mut e = runtime_entry();
    e.mutation = r::Mutation::from(mutation(vec![update_op()]));
    let mut unknown_effect = e.to_cbor();
    *field(element(field(&mut unknown_effect, 4), 1), 0) = Cbor::Uint(12);
    let mut unknown_conflict = e.to_cbor();
    *element(field(element(field(&mut unknown_conflict, 5), 0), 4), 0) = Cbor::Uint(7);
    let mut unknown_section = runtime_manifest().to_cbor();
    *field(element(field(&mut unknown_section, 5), 1), 0) = Cbor::Uint(14);
    let mut future_row = file_chunk().to_cbor();
    *element(element(element(field(&mut future_row, 3), 1), 2), 0) = Cbor::Uint(2);
    let mut wrong_section = file_chunk().to_cbor();
    *field(&mut wrong_section, 1) = Cbor::Uint(4);
    let mut old_row = file_chunk().to_cbor();
    *element(field(&mut old_row, 3), 1) = FileRow {
        id: b16(FILE),
        path: "assets/a.webp".into(),
        blob: blob(),
        media: MediaClass::Image,
    }
    .to_cbor();
    let mut wrong_tomb = tomb_chunk().to_cbor();
    *element(element(field(&mut wrong_tomb, 3), 0), 1) = Cbor::Uint(0);
    vec![
        bad::<r::Mutation>(
            "mutation",
            "runtime-v1-short-continuation-prior",
            raw(short_prior),
            "current full prior hash must be32bytes",
        ),
        bad::<r::Mutation>(
            "mutation",
            "runtime-v1-unknown-op",
            raw(unknown_op),
            "unknown future operation fails the whole mixed mutation",
        ),
        bad::<r::Mutation>(
            "mutation",
            "runtime-v1-unknown-content",
            raw(unknown_content),
            "unknown critical attachment profile fails the whole mutation",
        ),
        bad::<r::Mutation>(
            "mutation",
            "runtime-v1-short-manifest-hash",
            raw(short_hash),
            "complete sealed manifest SHA must be exactly32bytes",
        ),
        bad::<r::EntryPayload>(
            "entry",
            "runtime-v1-unknown-effect",
            raw(unknown_effect),
            "unknown future effect fails the whole mixed entry",
        ),
        bad::<r::EntryPayload>(
            "entry",
            "runtime-v1-unknown-conflict",
            raw(unknown_conflict),
            "unknown conflict side fails the whole entry",
        ),
        bad::<r::ManifestPayload>(
            "manifest",
            "runtime-v1-unknown-section",
            raw(unknown_section),
            "unknown future section fails the whole manifest",
        ),
        bad::<r::ChunkPayload>(
            "chunk",
            "runtime-v1-unknown-row-profile",
            raw(future_row),
            "unknown middle row profile fails the whole chunk, never a prefix",
        ),
        bad::<r::ChunkPayload>(
            "chunk",
            "runtime-v1-attachment-in-legacy-files",
            raw(wrong_section),
            "attachment rows cannot inhabit legacyFiles4",
        ),
        bad::<r::ChunkPayload>(
            "chunk",
            "runtime-v1-legacy-in-attachment-files",
            raw(old_row),
            "legacy Blob rows cannot inhabit AttachmentFiles10",
        ),
        bad::<r::ChunkPayload>(
            "chunk",
            "runtime-v1-record-attachment-tombstone",
            raw(wrong_tomb),
            "AttachmentTombstones11 only admits File1",
        ),
    ]
}
