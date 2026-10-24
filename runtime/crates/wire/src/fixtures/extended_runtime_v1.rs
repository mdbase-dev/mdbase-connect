//! Extended closed-family syntax vectors, not authenticated apply/provider proof.
use super::*;
use crate::attachment_runtime_v1 as r;
use crate::ordinary_file_promotion::{OrdinaryFileToRecord, ReindexOrdinaryFile};

const DOC: &str = "views: []\n";
fn prior() -> FileContent {
    let mut b = blob();
    b.plain_hash = crate::hash::sha256(DOC.as_bytes());
    b.size = DOC.len() as u64;
    FileContent::Blob(b)
}
fn promotion() -> r::Op {
    r::Op::OrdinaryFileToRecord(OrdinaryFileToRecord {
        id: B16([17; 16]),
        path: "views/existing.base".into(),
        doc: Text::Inline(DOC.into()),
        prior: prior(),
    })
}
fn mutation_extended() -> r::Mutation {
    let mut m = attachment_runtime_v1::runtime_mutation();
    let p = unindexed_markdown_payload();
    m.ops.extend([
        r::Op::UnindexedMarkdownPut(UnindexedMarkdownPut {
            id: B16([14; 16]),
            path: "notes/14.md".into(),
            payload: p.clone(),
            expected: Some(p.clone()),
        }),
        r::Op::RecordToUnindexedMarkdown(RecordToUnindexedMarkdown {
            id: B16([15; 16]),
            path: "notes/15.md".into(),
            payload: p.clone(),
            prior_revision: b32(0xd1),
        }),
        r::Op::UnindexedMarkdownToRecord(UnindexedMarkdownToRecord {
            id: B16([16; 16]),
            path: "notes/16.md".into(),
            doc: Text::Index(0),
            prior: p,
        }),
        promotion(),
    ]);
    m
}
fn conflict_extended() -> r::Conflict {
    r::Conflict {
        kind: ConflictKind::File,
        id: B16([14; 16]),
        field: None,
        base: Some(r::ConflictValue::UnindexedMarkdown(
            unindexed_markdown_payload(),
        )),
        kept: r::ConflictValue::UnindexedMarkdown(unindexed_markdown_payload()),
        lost: r::ConflictValue::Legacy(ConflictValue::Deleted),
    }
}
fn entry_extended() -> r::EntryPayload {
    let mut e = attachment_runtime_v1::runtime_entry();
    e.mutation = mutation_extended();
    e.effects.extend([
        r::Effect::PutUnindexedMarkdown(PutUnindexedMarkdown {
            id: B16([14; 16]),
            path: "notes/14.md".into(),
            payload: unindexed_markdown_payload(),
        }),
        r::Effect::ReindexUnindexedMarkdown(ReindexUnindexedMarkdown {
            id: B16([16; 16]),
            path: "notes/16.md".into(),
            doc: Text::Index(0),
        }),
        r::Effect::ReindexOrdinaryFile(ReindexOrdinaryFile {
            id: B16([17; 16]),
            path: "views/existing.base".into(),
            doc: Text::Inline(DOC.into()),
        }),
    ]);
    e.conflicts.as_mut().unwrap().push(conflict_extended());
    e
}
fn manifest_extended() -> r::ManifestPayload {
    let mut m = attachment_runtime_v1::runtime_manifest();
    for kind in [
        r::SectionKind::UnindexedMarkdownFiles,
        r::SectionKind::UnindexedMarkdownTombstones,
    ] {
        m.sections.push(r::Section {
            kind,
            chunks: vec![ChunkRef {
                address: b32(0xd4),
                plain_hash: b32(0xd5),
                rows: 1,
                bucket: 0,
                plain_size: 256,
            }],
        });
    }
    m.file_count += 1;
    m
}
fn files() -> r::ChunkPayload {
    r::ChunkPayload {
        section: r::SectionKind::UnindexedMarkdownFiles,
        bucket: 0,
        rows: (1..=3)
            .map(|n| {
                UnindexedMarkdownFileRowV1 {
                    id: B16([n; 16]),
                    path: format!("notes/{n}.md"),
                    payload: unindexed_markdown_payload(),
                    media: MediaClass::Other,
                }
                .to_cbor()
            })
            .collect(),
    }
}
fn tombs() -> r::ChunkPayload {
    r::ChunkPayload {
        section: r::SectionKind::UnindexedMarkdownTombstones,
        bucket: 0,
        rows: vec![
            UnindexedMarkdownTombstoneRowV1 {
                id: B16([15; 16]),
                path: "notes/15.md".into(),
                payload: unindexed_markdown_payload(),
                seq: 41,
                time: 1_791_100_800_000,
            }
            .to_cbor(),
        ],
    }
}
pub(super) fn positive() -> Vec<Fixture> {
    let mut a = attachment_content();
    a.whole_plain_hash = crate::hash::sha256(DOC.as_bytes());
    a.total_plain_bytes = DOC.len() as u64;
    vec![
        fx("mutation", "runtime-v1-extended", mutation_extended()),
        fx("entry", "runtime-v1-extended", entry_extended()),
        fx("manifest", "runtime-v1-extended", manifest_extended()),
        fx("chunk", "runtime-v1-unindexed-files", files()),
        fx("chunk", "runtime-v1-unindexed-tombstones", tombs()),
        fx(
            "chunk",
            "runtime-v1-extended-conflicts",
            r::ChunkPayload {
                section: r::SectionKind::Legacy(SectionKind::Conflicts),
                bucket: 0,
                rows: vec![
                    r::ConflictRow {
                        mutation: b16(MUTATION),
                        seq: 42,
                        conflict: conflict_extended(),
                    }
                    .to_cbor(),
                ],
            },
        ),
        fx("ordinary-file-promotion", "op-blob-v1", promotion()),
        fx(
            "ordinary-file-promotion",
            "op-attachment-v1",
            r::Op::OrdinaryFileToRecord(OrdinaryFileToRecord {
                id: B16([17; 16]),
                path: "views/existing.base".into(),
                doc: Text::Inline(DOC.into()),
                prior: FileContent::AttachmentV1(a),
            }),
        ),
        fx(
            "ordinary-file-promotion",
            "effect-v1",
            r::Effect::ReindexOrdinaryFile(ReindexOrdinaryFile {
                id: B16([17; 16]),
                path: "views/existing.base".into(),
                doc: Text::Inline(DOC.into()),
            }),
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
fn element(c: &mut Cbor, index: usize) -> &mut Cbor {
    let Cbor::Array(a) = c else {
        panic!("fixture array")
    };
    &mut a[index]
}
fn op(c: &mut Cbor, tag: u64) -> &mut Cbor {
    let Cbor::Array(ops) = field(c, 6) else {
        panic!("ops")
    };
    ops.iter_mut().find(|o| matches!(o, Cbor::Map(m) if m.iter().any(|(k,v)| *k == Cbor::Uint(0) && *v == Cbor::Uint(tag)))).unwrap()
}
fn remove_field(c: &mut Cbor, key: u64) {
    let Cbor::Map(m) = c else { panic!("map") };
    m.retain(|(k, _)| *k != Cbor::Uint(key));
}
pub(super) fn negative() -> Vec<BadFixture> {
    let mut unknown_payload = mutation_extended().to_cbor();
    *element(field(op(&mut unknown_payload, 14), 3), 1) = Cbor::Uint(2);
    let mut no_prior16 = mutation_extended().to_cbor();
    remove_field(op(&mut no_prior16, 16), 4);
    let mut no_prior17 = mutation_extended().to_cbor();
    remove_field(op(&mut no_prior17, 17), 4);
    let mut wrong_prior = mutation_extended().to_cbor();
    *field(op(&mut wrong_prior, 17), 4) = unindexed_markdown_payload().to_cbor();
    let mut short_prior_hash = mutation_extended().to_cbor();
    *field(field(op(&mut short_prior_hash, 17), 4), 0) = Cbor::Bytes(vec![0; 31]);
    let mut no_effect_doc = entry_extended().to_cbor();
    remove_field(element(field(&mut no_effect_doc, 4), 5), 3);
    let mut wrong_row = files().to_cbor();
    *element(element(field(&mut wrong_row, 3), 1), 2) = attachment_content().to_cbor();
    let mut wrong_tomb = tombs().to_cbor();
    *element(element(field(&mut wrong_tomb, 3), 0), 1) = Cbor::Uint(0);
    vec![
        bad::<r::Mutation>(
            "mutation",
            "runtime-v1-future-unindexed-payload",
            raw(unknown_payload),
            "future unindexed payload fails whole mixed mutation",
        ),
        bad::<r::Mutation>(
            "mutation",
            "runtime-v1-reindex-missing-prior",
            raw(no_prior16),
            "Op16 requires full prior kind/content",
        ),
        bad::<r::Mutation>(
            "mutation",
            "runtime-v1-promotion-missing-prior",
            raw(no_prior17),
            "Op17 requires full prior Ordinary content",
        ),
        bad::<r::Mutation>(
            "mutation",
            "runtime-v1-promotion-wrong-prior",
            raw(wrong_prior),
            "Op17 prior is FileContent, never unindexed payload",
        ),
        bad::<r::Mutation>(
            "mutation",
            "runtime-v1-promotion-short-prior-hash",
            raw(short_prior_hash),
            "Op17 prior digest must be exactly32bytes",
        ),
        bad::<r::EntryPayload>(
            "entry",
            "runtime-v1-promotion-missing-doc",
            raw(no_effect_doc),
            "Effect11 requires exact complete doc",
        ),
        bad::<r::ChunkPayload>(
            "chunk",
            "runtime-v1-wrong-unindexed-middle-row",
            raw(wrong_row),
            "section12 requires typed unindexed rows; no valid prefix returned",
        ),
        bad::<r::ChunkPayload>(
            "chunk",
            "runtime-v1-record-unindexed-tombstone",
            raw(wrong_tomb),
            "section13 accepts only File1 tombstones",
        ),
    ]
}
