//! Characterization of the apply path's decisions (`Replica::apply_payload_ready`).
//!
//! The apply verdict is consensus: a void is persisted, so which check fires
//! first for a payload that fails several must not change. These tests pin it
//! by execution. Each ladder starts from a payload that violates every check in
//! its list at once, then removes one violation per step; the outcome of every
//! step names the check that fires first among those still present, so a
//! dropped, renamed, added-in-front or reordered check changes the sequence.
//!
//! Every outcome is also checked for its exit kind: a void advances the head
//! and the void counter, an apply advances the head only, and a stall or a
//! pending source read leaves the head where it was.
//!
//! `every_void_site_is_inventoried` pins the complete set of persisted void
//! reasons in `replica/apply.rs` from source, and requires each one to be
//! either driven by a ladder here or listed in `SOURCE_ONLY` with the reason it
//! cannot be reached from a payload.
use super::{
    engine::{COL, Node},
    unindexed_async::{apply_body_with_refs, contents, node, payload, planned, retain, step},
    unindexed_reverse_text::{fixture, supply},
};
use crate::{
    replica::apply::Outcome,
    seal::{KeyringSealer, Sealer},
    store::{FileLocal, FileRow, RecordRow, Store, Tx},
};
use mdbn_wire::{
    attachment::{FileAttach, FileContent, PutAttachmentFile},
    attachment_runtime_v1 as rt,
    common::{B16, B32, Hash, Text},
    entry::{
        ConflictKind, ConflictValue, DeltaOp, Effect, PutFile, PutRecord, PutResource, RemoveFile,
        RemoveRecord, Status, TextBlob, TextDef, TextDefForm, TextDelta, TextSource,
    },
    intent::{BlobRef, Create, Delete, FileDelete, MediaClass, Op, Source},
    ordinary_file_promotion::{OrdinaryFileToRecord, ReindexOrdinaryFile},
    unindexed_markdown::{
        FileKindV1, PutUnindexedMarkdown, UnindexedMarkdownPayloadV1, UnindexedMarkdownPut,
        UnindexedMarkdownToRecord,
    },
};
use std::collections::{BTreeMap, BTreeSet};

const APPLIED: &str = "applied";
const PENDING: &str = "source pending";

/// A stored unindexed holder that legacy and ordinary effects must not convert.
const UNINDEXED: B16 = B16([40; 16]);
/// A stored record holding `taken.md`.
const HOLDER: B16 = B16([41; 16]);
/// The record the legacy base payload creates.
const RECORD: B16 = B16([61; 16]);
/// The native unindexed file of `unindexed_async::payload`.
const NATIVE: B16 = B16([52; 16]);

struct Case {
    payload: rt::EntryPayload,
    refs: Vec<Hash>,
    objects: BTreeMap<Hash, Vec<u8>>,
}

type Step = (&'static str, fn(&mut Node, &mut Case));

struct Ladder {
    name: &'static str,
    setup: fn(&mut Node) -> Case,
    /// Violations in the order their checks fire.
    steps: &'static [Step],
    /// The outcome once every violation is removed.
    last: &'static str,
}

impl Ladder {
    fn expected(&self) -> Vec<&'static str> {
        self.steps
            .iter()
            .map(|(e, _)| *e)
            .chain([self.last])
            .collect()
    }
    fn run(&self) {
        let mut got = Vec::new();
        for i in 0..=self.steps.len() {
            let mut n = node();
            let mut c = (self.setup)(&mut n);
            for (_, violate) in &self.steps[i..] {
                violate(&mut n, &mut c);
            }
            got.push(outcome(&mut n, &c));
        }
        assert_eq!(got, self.expected(), "ladder {}", self.name);
    }
}

/// Drive one payload through the apply path (fetching sources when it asks),
/// check the exit kind against the store, and name the outcome.
fn outcome(n: &mut Node, c: &Case) -> String {
    let before = n.r.store.head().unwrap();
    let voids = n.r.policy.voids;
    let head = retain(n);
    let writer = n.r.cfg.device_id;
    let o = apply_body_with_refs(n, head, &c.payload, &c.objects, writer, &c.refs);
    describe(n, o, before, head, voids)
}

fn describe(
    n: &Node,
    o: Outcome,
    before: crate::store::Head,
    head: crate::store::Head,
    voids: u64,
) -> String {
    let at = n.r.store.head().unwrap();
    match o {
        Outcome::Void(reason) => {
            assert_eq!(at, head, "void {reason} must advance the head");
            assert_eq!(n.r.policy.voids, voids + 1, "void {reason} must count");
            reason.to_string()
        }
        Outcome::Applied => {
            assert_eq!(at, head, "apply must advance the head");
            assert_eq!(n.r.policy.voids, voids);
            APPLIED.into()
        }
        Outcome::Stall(kind, why) => {
            assert_eq!(at, before, "stall {why} must not advance the head");
            format!("stall {kind:?}: {why}")
        }
        Outcome::SourcePending => {
            assert_eq!(at, before, "pending source must not advance the head");
            PENDING.into()
        }
        other => panic!("not an apply-path outcome: {other:?}"),
    }
}

fn file_row(id: B16, path: &str, kind: FileKindV1, content: FileContent) -> FileRow {
    FileRow {
        id,
        path: path.into(),
        path_key: mdbn_core::paths::path_key(path),
        kind,
        content,
        mtime: None,
        media: MediaClass::of(path),
        modified_seq: 1,
        bucket: 0,
        local: FileLocal::Remote,
    }
}

fn record_row(id: B16, path: &str, doc: &str) -> RecordRow {
    RecordRow {
        id,
        path: path.into(),
        path_key: mdbn_core::paths::path_key(path),
        doc: doc.into(),
        revision: mdbn_wire::hash::sha256(doc.as_bytes()),
        modified_seq: 1,
        mtime: None,
        bucket: 0,
        meta: Default::default(),
    }
}

fn seed(n: &mut Node, files: Vec<FileRow>, records: Vec<RecordRow>) {
    n.r.store
        .commit(Tx {
            files_put: files,
            records_put: records,
            ..Tx::default()
        })
        .unwrap();
}

fn put_record(id: u8, path: &str) -> rt::Effect {
    rt::Effect::Legacy(Effect::PutRecord(PutRecord {
        id: B16([id; 16]),
        path: path.into(),
        doc: Text::Inline(format!("{path}\n")),
    }))
}

fn blob_ref(part_size: u64) -> BlobRef {
    BlobRef {
        plain_hash: mdbn_wire::hash::sha256(b"x"),
        size: 1,
        blob_id: B32([3; 32]),
        id_epoch: 1,
        part_size,
    }
}

/// A record create whose effects are not re-planned (its origin is this
/// replica), so it reaches every structural check and commits.
fn legacy_setup(n: &mut Node) -> Case {
    let (unindexed, _) = contents(n, &vec![b'u'; 1_048_577], false);
    seed(
        n,
        vec![file_row(
            UNINDEXED,
            "u.md",
            FileKindV1::UnindexedOversizedMarkdown,
            unindexed,
        )],
        vec![record_row(HOLDER, "taken.md", "held\n")],
    );
    let mut p = payload(FileContent::Blob(blob_ref(crate::replica::apply::MIN_PART)));
    p.mutation.id = B16([60; 16]);
    p.mutation.source = Source::Api;
    p.mutation.ops = vec![rt::Op::Legacy(Op::Create(Create {
        id: RECORD,
        path: Some("a.md".into()),
        type_name: None,
        frontmatter: None,
        body: None,
        document: Some(Text::Inline("a.md\n".into())),
    }))];
    p.effects = vec![put_record(61, "a.md")];
    Case {
        payload: p,
        refs: Vec::new(),
        objects: BTreeMap::new(),
    }
}

fn record_effect(c: &mut Case, i: usize) -> &mut PutRecord {
    let rt::Effect::Legacy(Effect::PutRecord(r)) = &mut c.payload.effects[i] else {
        panic!("expected a record effect")
    };
    r
}

/// Every check before the effects loop, then the loop, then the path check
/// after it.
const STRUCTURAL: Ladder = Ladder {
    name: "structural",
    setup: legacy_setup,
    steps: &[
        (
            "stall UpgradeRequired: delegated native file mediation is not supported",
            |_, c| {
                c.payload.mutation.on_behalf = Some(B16([70; 16]));
                c.payload
                    .mutation
                    .ops
                    .push(rt::Op::Legacy(Op::FileDelete(FileDelete {
                        id: UNINDEXED,
                        if_revision: None,
                        base: None,
                    })));
            },
        ),
        ("V7: reverse text descriptor or refs", |_, c| {
            c.payload
                .texts
                .get_or_insert_default()
                .push(TextDef::Form(TextDefForm::Blob(TextBlob {
                    blob: blob_ref(crate::replica::apply::MIN_PART),
                })));
        }),
        ("V7: text table", |_, c| {
            c.payload
                .texts
                .get_or_insert_default()
                .push(TextDef::Form(TextDefForm::Delta(TextDelta {
                    source: TextSource::PrevRecord(B16([99; 16])),
                    ops: vec![DeltaOp::Copy { offset: 0, len: 1 }],
                })));
        }),
        ("V7: effect texts", |_, c| {
            c.payload
                .effects
                .push(rt::Effect::Legacy(Effect::PutRecord(PutRecord {
                    id: B16([62; 16]),
                    path: "e.md".into(),
                    doc: Text::Index(9),
                })));
        }),
        ("V7: conflict texts", |_, c| {
            c.payload
                .conflicts
                .get_or_insert_default()
                .push(rt::Conflict {
                    kind: ConflictKind::Body,
                    id: RECORD,
                    field: None,
                    base: None,
                    kept: rt::ConflictValue::Legacy(ConflictValue::Text(Text::Index(9))),
                    lost: rt::ConflictValue::Legacy(ConflictValue::Missing),
                });
        }),
        ("V7: blob part size or count out of range", |_, c| {
            c.payload
                .conflicts
                .get_or_insert_default()
                .push(rt::Conflict {
                    kind: ConflictKind::Body,
                    id: RECORD,
                    field: None,
                    base: None,
                    kept: rt::ConflictValue::Legacy(ConflictValue::Blob(blob_ref(1))),
                    lost: rt::ConflictValue::Legacy(ConflictValue::Missing),
                });
        }),
        ("V7: status inconsistent with conflicts", |_, c| {
            c.payload.status = Status::Conflicted;
        }),
        ("V7: too many operations", |_, c| {
            for i in 0..1000u16 {
                let mut id = [0u8; 16];
                id[..2].copy_from_slice(&i.to_be_bytes());
                c.payload
                    .mutation
                    .ops
                    .push(rt::Op::Legacy(Op::Delete(Delete {
                        id: B16(id),
                        base_revision: None,
                        if_revision: None,
                    })));
            }
        }),
        ("V7: external source on an api-only operation", |_, c| {
            c.payload.mutation.source = Source::External;
        }),
        ("V7: mutation texts", |_, c| {
            let rt::Op::Legacy(Op::Create(create)) = &mut c.payload.mutation.ops[0] else {
                panic!("expected the create")
            };
            create.document = Some(Text::Index(9));
        }),
        ("V7: invalid path", |_, c| {
            c.payload.effects.insert(0, put_record(63, "../up.md"));
        }),
        ("V7: path already taken", |_, c| {
            c.payload.effects.push(put_record(64, "taken.md"));
        }),
    ],
    last: APPLIED,
};

const RECORD_EFFECT: Ladder = Ladder {
    name: "put record",
    setup: legacy_setup,
    steps: &[
        ("V7: invalid path", |_, c| {
            record_effect(c, 0).path = "../a.md".into();
        }),
        (
            "V7: ordinary record effect changes unindexed kind",
            |_, c| {
                record_effect(c, 0).id = UNINDEXED;
            },
        ),
        ("V7: two records share a path", |_, c| {
            c.payload.effects.push(put_record(65, "a.md"));
        }),
    ],
    last: APPLIED,
};

fn file_setup(n: &mut Node) -> Case {
    let mut c = legacy_setup(n);
    let (FileContent::Blob(blob), _) = contents(n, b"file", false) else {
        unreachable!()
    };
    c.payload.effects = vec![rt::Effect::Legacy(Effect::PutFile(PutFile {
        id: B16([73; 16]),
        path: "f.bin".into(),
        blob,
    }))];
    c
}

fn file_effect(c: &mut Case) -> &mut PutFile {
    let rt::Effect::Legacy(Effect::PutFile(f)) = &mut c.payload.effects[0] else {
        panic!("expected a file effect")
    };
    f
}

const FILE_EFFECT: Ladder = Ladder {
    name: "put file",
    setup: file_setup,
    steps: &[
        ("V7: invalid path", |_, c| {
            file_effect(c).path = "../f.bin".into();
        }),
        ("V7: blob part size or count out of range", |_, c| {
            file_effect(c).blob.part_size = 1;
        }),
        ("V7: ordinary effect changes file kind", |_, c| {
            file_effect(c).id = UNINDEXED;
        }),
        ("V7: two entries share a path", |_, c| {
            c.payload.effects.insert(0, put_record(74, "f.bin"));
        }),
    ],
    last: APPLIED,
};

fn attachment_setup(n: &mut Node) -> Case {
    let mut c = legacy_setup(n);
    let (FileContent::AttachmentV1(content), _) = contents(n, b"picture", true) else {
        unreachable!()
    };
    c.payload.mutation.ops = vec![rt::Op::FileAttach(FileAttach {
        id: B16([71; 16]),
        path: "pic.png".into(),
        content: content.clone(),
        if_revision: None,
        base: None,
        mtime: None,
    })];
    c.payload.effects = vec![rt::Effect::PutAttachmentFile(PutAttachmentFile {
        id: B16([71; 16]),
        path: "pic.png".into(),
        content,
        mtime: None,
    })];
    c
}

fn attachment_effect(c: &mut Case) -> &mut PutAttachmentFile {
    let rt::Effect::PutAttachmentFile(f) = &mut c.payload.effects[0] else {
        panic!("expected an attachment effect")
    };
    f
}

const ATTACHMENT_EFFECT: Ladder = Ladder {
    name: "put attachment file",
    setup: attachment_setup,
    steps: &[
        ("V7: invalid path", |_, c| {
            attachment_effect(c).path = "../pic.png".into();
        }),
        ("V7: attachment descriptor out of range", |_, c| {
            attachment_effect(c).content.reference.key_epoch = 99;
        }),
        ("V7: ordinary effect changes file kind", |_, c| {
            attachment_effect(c).id = UNINDEXED;
        }),
        ("V7: two entries share a path", |_, c| {
            c.payload.effects.insert(0, put_record(72, "pic.png"));
        }),
    ],
    last: APPLIED,
};

/// A planned native unindexed create whose source bytes are served on request.
fn native_setup(n: &mut Node) -> Case {
    let (content, objects) = contents(n, &vec![b'x'; 1_048_577], true);
    let p = planned(n, payload(content));
    Case {
        payload: p,
        refs: objects.keys().copied().collect(),
        objects,
    }
}

fn native_op(c: &mut Case) -> &mut UnindexedMarkdownPut {
    let rt::Op::UnindexedMarkdownPut(op) = &mut c.payload.mutation.ops[0] else {
        panic!("expected the native put")
    };
    op
}

fn native_effect(c: &mut Case) -> &mut PutUnindexedMarkdown {
    let rt::Effect::PutUnindexedMarkdown(e) = &mut c.payload.effects[0] else {
        panic!("expected the native effect")
    };
    e
}

/// Native checks before the loop, the native effect arm, then planner
/// verification and the source check, which run after the loop.
const NATIVE_EFFECT: Ladder = Ladder {
    name: "native unindexed put",
    setup: native_setup,
    steps: &[
        ("V7: invalid request", |_, c| {
            native_op(c).path = "../huge.md".into();
        }),
        ("V7: unindexed source descriptor", |_, c| {
            c.payload
                .mutation
                .ops
                .push(rt::Op::UnindexedMarkdownPut(UnindexedMarkdownPut {
                    id: B16([54; 16]),
                    path: "small.md".into(),
                    payload: UnindexedMarkdownPayloadV1 {
                        content: FileContent::Blob(blob_ref(crate::replica::apply::MIN_PART)),
                    },
                    expected: None,
                }));
        }),
        ("V7: unindexed effect descriptor or path", |_, c| {
            native_effect(c).path = "../huge.md".into();
        }),
        ("V7: unindexed effect changes ordinary kind", |n, c| {
            let content = native_effect(c).payload.content.clone();
            seed(
                n,
                vec![file_row(NATIVE, "huge.md", FileKindV1::Ordinary, content)],
                vec![],
            );
        }),
        ("V7: unindexed prior CAS", |_, c| {
            let expected = native_op(c).payload.clone();
            native_op(c).expected = Some(expected);
        }),
        ("V7: two entries share a path", |_, c| {
            let mut second = native_effect(c).clone();
            second.id = B16([66; 16]);
            c.payload
                .effects
                .push(rt::Effect::PutUnindexedMarkdown(second));
        }),
        ("V7: path already taken", |n, _| {
            seed(n, vec![], vec![record_row(B16([67; 16]), "huge.md", "x\n")]);
        }),
        ("V7: native source refs", |_, c| {
            c.refs.clear();
        }),
        (
            "stall UpgradeRequired: native results cannot be verified by this build's planner",
            |_, c| {
                c.payload.status = Status::Merged;
            },
        ),
    ],
    last: APPLIED,
};

/// A planned unindexed → record reindex with an inline source.
fn reindex_setup(n: &mut Node) -> Case {
    let (prior, objects) = contents(n, &vec![b'x'; 1_048_577], false);
    seed(
        n,
        vec![file_row(
            NATIVE,
            "huge.md",
            FileKindV1::UnindexedOversizedMarkdown,
            prior.clone(),
        )],
        vec![],
    );
    let mut p = payload(prior.clone());
    p.mutation.ops = vec![rt::Op::UnindexedMarkdownToRecord(
        UnindexedMarkdownToRecord {
            id: NATIVE,
            path: "huge.md".into(),
            doc: Text::Inline("doc\n".into()),
            prior: UnindexedMarkdownPayloadV1 { content: prior },
        },
    )];
    let p = planned(n, p);
    Case {
        payload: p,
        refs: objects.keys().copied().collect(),
        objects,
    }
}

fn reindex_effect(c: &mut Case) -> &mut mdbn_wire::unindexed_markdown::ReindexUnindexedMarkdown {
    let rt::Effect::ReindexUnindexedMarkdown(e) = &mut c.payload.effects[0] else {
        panic!("expected the reindex effect")
    };
    e
}

const REINDEX_EFFECT: Ladder = Ladder {
    name: "reindex unindexed markdown",
    setup: reindex_setup,
    steps: &[
        ("V7: reindex requires unindexed holder", |_, c| {
            reindex_effect(c).id = B16([68; 16]);
        }),
        ("V7: reindex prior CAS", |_, c| {
            let rt::Op::UnindexedMarkdownToRecord(op) = &mut c.payload.mutation.ops[0] else {
                panic!("expected the reindex op")
            };
            op.prior.content = FileContent::Blob(blob_ref(crate::replica::apply::MIN_PART));
        }),
        ("V7: reindex source or path", |_, c| {
            reindex_effect(c).path = "../huge.md".into();
        }),
        ("V7: two entries share a path", |_, c| {
            c.payload.effects.insert(0, put_record(69, "huge.md"));
        }),
    ],
    last: APPLIED,
};

/// A ordinary file → record promotion whose source matches the holder.
fn promotion_setup(n: &mut Node) -> Case {
    let doc = "promoted\n";
    let (prior, objects) = contents(n, doc.as_bytes(), false);
    seed(
        n,
        vec![file_row(
            NATIVE,
            "note.md",
            FileKindV1::Ordinary,
            prior.clone(),
        )],
        vec![],
    );
    let mut p = payload(prior.clone());
    p.mutation.source = Source::Api;
    p.mutation.ops = vec![rt::Op::OrdinaryFileToRecord(OrdinaryFileToRecord {
        id: NATIVE,
        path: "note.md".into(),
        doc: Text::Inline(doc.into()),
        prior,
    })];
    let p = planned(n, p);
    Case {
        payload: p,
        refs: objects.keys().copied().collect(),
        objects,
    }
}

fn promotion_effect(c: &mut Case) -> &mut ReindexOrdinaryFile {
    let rt::Effect::ReindexOrdinaryFile(e) = &mut c.payload.effects[0] else {
        panic!("expected the promotion effect")
    };
    e
}

const PROMOTION_EFFECT: Ladder = Ladder {
    name: "reindex ordinary file",
    setup: promotion_setup,
    steps: &[
        ("V7: promotion requires exact ordinary holder", |_, c| {
            promotion_effect(c).path = "other.md".into();
        }),
        ("V7: promotion prior CAS", |_, c| {
            let rt::Op::OrdinaryFileToRecord(op) = &mut c.payload.mutation.ops[0] else {
                panic!("expected the promotion op")
            };
            op.prior = FileContent::Blob(blob_ref(crate::replica::apply::MIN_PART));
        }),
        ("V7: ordinary source identity or path", |_, c| {
            promotion_effect(c).doc = Text::Inline("different\n".into());
        }),
        ("V7: two entries share a path", |_, c| {
            c.payload.effects.insert(0, put_record(75, "note.md"));
        }),
    ],
    last: APPLIED,
};

/// Single-check arms: removes of unknown entities, resource paths, and the
/// same-entry put-then-remove that is not a void.
const REMOVES_AND_RESOURCES: Ladder = Ladder {
    name: "removes and resources",
    setup: legacy_setup,
    steps: &[
        ("V7: remove of an unknown record", |_, c| {
            c.payload.effects.insert(
                0,
                rt::Effect::Legacy(Effect::RemoveRecord(RemoveRecord {
                    id: B16([76; 16]),
                    path: "gone.md".into(),
                })),
            );
        }),
        ("V7: remove of an unknown file", |_, c| {
            c.payload
                .effects
                .push(rt::Effect::Legacy(Effect::RemoveFile(RemoveFile {
                    id: B16([77; 16]),
                    path: "gone.bin".into(),
                })));
        }),
        ("V7: invalid path", |_, c| {
            c.payload
                .effects
                .push(rt::Effect::Legacy(Effect::PutResource(PutResource {
                    path: "../types.md".into(),
                    doc: Text::Inline("x".into()),
                })));
        }),
        // Not a void: a record put earlier in the same entry may be removed.
        (APPLIED, |_, c| {
            c.payload
                .effects
                .push(rt::Effect::Legacy(Effect::RemoveRecord(RemoveRecord {
                    id: RECORD,
                    path: "a.md".into(),
                })));
        }),
    ],
    last: APPLIED,
};

const LADDERS: &[Ladder] = &[
    STRUCTURAL,
    RECORD_EFFECT,
    FILE_EFFECT,
    ATTACHMENT_EFFECT,
    NATIVE_EFFECT,
    REINDEX_EFFECT,
    PROMOTION_EFFECT,
    REMOVES_AND_RESOURCES,
];

#[test]
fn structural_checks_fire_in_order() {
    STRUCTURAL.run();
}
#[test]
fn record_effect_checks_fire_in_order() {
    RECORD_EFFECT.run();
}
#[test]
fn file_effect_checks_fire_in_order() {
    FILE_EFFECT.run();
}
#[test]
fn attachment_effect_checks_fire_in_order() {
    ATTACHMENT_EFFECT.run();
}
#[test]
fn native_effect_checks_fire_in_order() {
    NATIVE_EFFECT.run();
}
#[test]
fn reindex_effect_checks_fire_in_order() {
    REINDEX_EFFECT.run();
}
#[test]
fn promotion_effect_checks_fire_in_order() {
    PROMOTION_EFFECT.run();
}
#[test]
fn remove_and_resource_checks_fire_in_order() {
    REMOVES_AND_RESOURCES.run();
}

/// Source-read outcomes: the reverse-text hydration and the native source
/// check, each with an unavailable key, a corrupt object and invalid UTF-8.
#[test]
fn source_read_outcomes() {
    let mut got = Vec::new();
    // Reverse text: invalid UTF-8 rejects; corruption keeps waiting; no key stalls.
    for (source, corrupt) in [(&[0xff][..], false), (&b"doc"[..], true)] {
        let mut a = node();
        let (p, refs, objects, _) = fixture(&mut a, "doc", source);
        let before = a.r.store.head().unwrap();
        let voids = a.r.policy.voids;
        let h = retain(&mut a);
        let writer = a.r.cfg.device_id;
        let apply = |a: &mut Node| {
            a.r.test_apply_authorized_unindexed_with_refs(
                h.seq,
                h,
                p.clone(),
                &mut BTreeSet::new(),
                writer,
                &refs,
            )
            .unwrap()
        };
        let first = apply(&mut a);
        got.push(describe(&a, first, before, h, voids));
        supply(&mut a, &objects, corrupt);
        let second = apply(&mut a);
        got.push(describe(&a, second, before, h, voids));
    }
    {
        let mut a = node();
        let (p, refs, _, _) = fixture(&mut a, "doc", b"doc");
        without_epoch_one_key(&mut a);
        let mut c = Case {
            payload: p,
            refs,
            objects: BTreeMap::new(),
        };
        c.refs.sort();
        got.push(outcome(&mut a, &c));
    }
    // Native source check: invalid UTF-8 rejects; corruption keeps waiting; no key stalls.
    {
        let mut a = node();
        let (content, objects) = contents(&mut a, &vec![0xff; 1_048_577], true);
        let c = Case {
            payload: planned(&a, payload(content)),
            refs: objects.keys().copied().collect(),
            objects,
        };
        got.push(outcome(&mut a, &c));
    }
    {
        let mut a = node();
        let c = native_setup(&mut a);
        let before = a.r.store.head().unwrap();
        let voids = a.r.policy.voids;
        let h = retain(&mut a);
        let writer = a.r.cfg.device_id;
        let apply = |a: &mut Node| {
            a.r.test_apply_authorized_unindexed_with_refs(
                h.seq,
                h,
                c.payload.clone(),
                &mut BTreeSet::new(),
                writer,
                &c.refs,
            )
            .unwrap()
        };
        let first = apply(&mut a);
        got.push(describe(&a, first, before, h, voids));
        step(&mut a, &c.objects, h, true);
        let second = apply(&mut a);
        got.push(describe(&a, second, before, h, voids));
    }
    {
        let mut a = node();
        let c = native_setup(&mut a);
        without_epoch_one_key(&mut a);
        got.push(outcome(&mut a, &c));
    }
    assert_eq!(
        got,
        [
            PENDING,
            "unindexed_markdown_invalid_utf8",
            PENDING,
            PENDING,
            "stall WaitingForKey: reverse text key unavailable",
            "unindexed_markdown_invalid_utf8",
            PENDING,
            PENDING,
            "stall WaitingForKey: T6b source key unavailable",
        ]
    );
}

/// Replace the sealer with one that holds only epoch 2's key.
fn without_epoch_one_key(a: &mut Node) {
    let mut keys = crate::crypto::keys::Keyring::new();
    keys.insert(2, crate::crypto::Secret32([9; 32]));
    let raw = keys.to_bytes();
    let mut saved = zeroize::Zeroizing::new((raw.len() as u64).to_be_bytes().to_vec());
    saved.extend_from_slice(&raw);
    let mut sealer = KeyringSealer::new(COL, B16([101; 16]), &[6; 32], &[7; 32]);
    sealer.import(&saved).unwrap();
    sealer.set_epoch(2);
    a.r.sealer = Box::new(sealer);
    a.r.policy.epoch = 2;
}

/// Persisted void reasons that no payload can reach, and why.
const SOURCE_ONLY: &[(&str, &str)] = &[
    (
        "V7: unresolved text",
        "effect texts are resolved to Text::Inline before the effects loop",
    ),
    (
        "V7: unresolved reindex source",
        "reindex sources are resolved to Text::Inline before the effects loop",
    ),
    (
        "V7: unresolved ordinary source",
        "promotion sources are resolved to Text::Inline before the effects loop",
    ),
];

/// Every `commit_payload_void` site in `replica/apply.rs`, with its count.
const VOID_SITES: &[(&str, usize)] = &[
    ("V7: attachment descriptor out of range", 1),
    ("V7: blob part size or count out of range", 2),
    ("V7: conflict texts", 1),
    ("V7: effect texts", 1),
    ("V7: external source on an api-only operation", 1),
    ("V7: invalid path", 4),
    ("V7: invalid request", 1),
    ("V7: mutation texts", 1),
    ("V7: native source refs", 1),
    ("V7: ordinary effect changes file kind", 2),
    ("V7: ordinary record effect changes unindexed kind", 1),
    ("V7: ordinary source identity or path", 1),
    ("V7: path already taken", 1),
    ("V7: promotion prior CAS", 1),
    ("V7: promotion requires exact ordinary holder", 1),
    ("V7: reindex prior CAS", 1),
    ("V7: reindex requires unindexed holder", 1),
    ("V7: reindex source or path", 1),
    ("V7: remove of an unknown file", 1),
    ("V7: remove of an unknown record", 1),
    ("V7: reverse text descriptor or refs", 1),
    ("V7: status inconsistent with conflicts", 1),
    ("V7: text table", 1),
    ("V7: too many operations", 1),
    ("V7: two entries share a path", 5),
    ("V7: two records share a path", 1),
    ("V7: unindexed effect changes ordinary kind", 1),
    ("V7: unindexed effect descriptor or path", 1),
    ("V7: unindexed prior CAS", 1),
    ("V7: unindexed source descriptor", 1),
    ("V7: unresolved ordinary source", 1),
    ("V7: unresolved reindex source", 1),
    ("V7: unresolved text", 2),
];

/// The reason literal of every `commit_payload_void(` call in the source.
fn void_sites_in_source() -> BTreeMap<String, usize> {
    let src = include_str!("../replica/apply.rs");
    let mut sites = BTreeMap::new();
    for (at, _) in src.match_indices("commit_payload_void(") {
        let rest = &src[at..];
        // The definition, not a call.
        if src[..at].ends_with("fn ") {
            continue;
        }
        let close = rest.find(')').expect("call closes");
        let call = &rest[..close];
        let start = call.find('"').expect("reason literal") + 1;
        let end = start + call[start..].find('"').expect("literal closes");
        *sites.entry(call[start..end].to_string()).or_default() += 1;
    }
    sites
}

#[test]
fn every_void_site_is_inventoried() {
    let expected: BTreeMap<String, usize> = VOID_SITES
        .iter()
        .map(|(r, n)| (r.to_string(), *n))
        .collect();
    assert_eq!(void_sites_in_source(), expected);
    // Each site is driven by a ladder or explained as unreachable, not both.
    let driven: BTreeSet<&str> = LADDERS
        .iter()
        .flat_map(Ladder::expected)
        .filter(|r| r.starts_with("V7: "))
        .collect();
    let unreachable: BTreeSet<&str> = SOURCE_ONLY.iter().map(|(r, _)| *r).collect();
    assert!(
        driven.is_disjoint(&unreachable),
        "{driven:?} {unreachable:?}"
    );
    let covered: BTreeSet<&str> = driven.union(&unreachable).copied().collect();
    let sites: BTreeSet<&str> = VOID_SITES.iter().map(|(r, _)| *r).collect();
    assert_eq!(covered, sites);
}
