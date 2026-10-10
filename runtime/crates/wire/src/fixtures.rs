//! The values behind the golden fixtures in `conformance/wire/`
//! (`docs/contracts/00-overview.md` §8).
//!
//! Each positive fixture is a typed value. Its canonical bytes (`<case>.cbor`),
//! annotated diagnostic notation (`<case>.diag`) and JSON debug view (`<case>.json`)
//! are generated from it, and checked in. Other implementations (the TS SDK) check
//! that they decode each `.cbor`, re-encode it byte for byte, and reject every
//! `<case>.bad.cbor`.
//!
//! Envelope bodies here are placeholder bytes: sealed fixtures, with fixed test
//! keys, come with the crypto layer.

use crate::attachment::*;
use crate::cbor::Cbor;
use crate::client::*;
use crate::common::{B16, B32, B64, Bytes, DataMap, Text, Value, Version};
use crate::entry::*;
use crate::envelope::*;
use crate::hash::{CHAIN_ZERO, sha256};
use crate::intent::*;
use crate::log_service::*;
use crate::policy::*;
use crate::schema::{Ann, Wire};
use crate::snapshot::*;
use crate::unindexed_markdown::*;

mod attachment_runtime_v1;
mod extended_runtime_v1;

/// Decode bytes as a fixture's type and re-encode them.
pub type Roundtrip = fn(&[u8]) -> Result<Vec<u8>, String>;

/// One positive fixture.
pub struct Fixture {
    /// Directory under `conformance/wire/`.
    pub format: &'static str,
    /// File stem.
    pub name: &'static str,
    /// Canonical bytes.
    pub bytes: Vec<u8>,
    /// Annotated view.
    pub ann: Ann,
    /// Re-decode the bytes and re-encode them (round trip through the typed value).
    pub roundtrip: Roundtrip,
}

/// One negative fixture: bytes that must be rejected.
pub struct BadFixture {
    /// Directory under `conformance/wire/`.
    pub format: &'static str,
    /// File stem (written as `<name>.bad.cbor`).
    pub name: &'static str,
    /// The bytes.
    pub bytes: Vec<u8>,
    /// Try to decode the bytes as the fixture's type.
    pub decode: fn(&[u8]) -> Result<(), String>,
    /// What the rejection is about (documentation, and `.bad.txt`).
    pub why: &'static str,
}

fn rt<T: Wire>(b: &[u8]) -> Result<Vec<u8>, String> {
    T::from_bytes(b)
        .map_err(|e| e.to_string())?
        .to_bytes()
        .map_err(|e| e.to_string())
}

fn dec<T: Wire>(b: &[u8]) -> Result<(), String> {
    T::from_bytes(b).map(|_| ()).map_err(|e| e.to_string())
}

fn fx<T: Wire>(format: &'static str, name: &'static str, v: T) -> Fixture {
    Fixture {
        format,
        name,
        bytes: v.to_bytes().expect("fixture values are canonical"),
        ann: v.annotate(),
        roundtrip: rt::<T>,
    }
}

fn bad<T: Wire>(
    format: &'static str,
    name: &'static str,
    bytes: Vec<u8>,
    why: &'static str,
) -> BadFixture {
    BadFixture {
        format,
        name,
        bytes,
        decode: dec::<T>,
        why,
    }
}

fn hexb(s: &str) -> Vec<u8> {
    let s: Vec<u8> = s.bytes().filter(|c| *c != b'-').collect();
    s.chunks(2)
        .map(|p| {
            let d = |c: u8| match c {
                b'0'..=b'9' => c - b'0',
                b'a'..=b'f' => c - b'a' + 10,
                _ => panic!("bad hex in fixture"),
            };
            (d(p[0]) << 4) | d(p[1])
        })
        .collect()
}

fn b16(s: &str) -> B16 {
    B16(hexb(s).try_into().expect("16 bytes"))
}

fn b32(fill: u8) -> B32 {
    B32([fill; 32])
}

const COLLECTION: &str = "4c18af2e-b04a-4b77-b83e-493c3695962e";
const REPLICA: &str = "9b2f6c1e-3a47-4d5b-8e21-6f0a9c3d7e54";
const DEVICE: &str = "2d7e9a41-6c3b-4f18-9a05-c8e1b2d3f467";
const RECORD: &str = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";
const FILE: &str = "0192f3a4-5b6c-7d8e-9f01-fedcba987654";
const MUTATION: &str = "0192f3a4-6000-7abc-8def-0123456789ab";
const GRANT: &str = "6f1e2d3c-4b5a-4968-8776-655443322110";

fn clock() -> OpClock {
    OpClock {
        instant: 1_791_100_800_000,
        tz: "Australia/Melbourne".into(),
        local_date: "2026-10-04".into(),
    }
}

fn blob() -> BlobRef {
    BlobRef {
        plain_hash: sha256(b"\x89PNG fixture bytes"),
        size: 18,
        blob_id: b32(0xb1),
        id_epoch: 1,
        part_size: 8 * 1024 * 1024,
    }
}

fn mutation(ops: Vec<Op>) -> Mutation {
    Mutation {
        id: b16(MUTATION),
        origin: b16(REPLICA),
        base_seq: 41,
        clock: clock(),
        seed: b32(0x5e),
        source: Source::Api,
        ops,
        on_behalf: None,
        conflict_mode: None,
        validated_at: Some(Level::Error),
        room: None,
    }
}

fn update_op() -> Op {
    Op::Update(Update {
        id: b16(RECORD),
        patch: Some(DataMap(vec![
            ("status".into(), Value::Text("done".into())),
            ("priority".into(), Value::Int(3)),
            ("estimate".into(), Value::Float(1.5)),
        ])),
        unset: Some(vec!["snoozed".into()]),
        add: Some(DataMap(vec![(
            "tags".into(),
            vec![Value::Text("urgent".into())],
        )])),
        remove: Some(DataMap(vec![(
            "tags".into(),
            vec![Value::Text("someday".into())],
        )])),
        body: None,
        body_edits: Some(vec![
            BodyEdit {
                start: 0,
                end: 5,
                insert: "Agenda".into(),
            },
            BodyEdit {
                start: 42,
                end: 42,
                insert: "\n- follow up with Bo".into(),
            },
        ]),
        body_base: Some(sha256(b"Notes\n")),
        body_base_text: None,
        base: Some(vec![
            BaseField {
                key: "status".into(),
                observed: Some(Value::Text("open".into())),
            },
            BaseField {
                key: "snoozed".into(),
                observed: None,
            },
        ]),
        if_revision: None,
    })
}

fn item(kind: ItemKind, seq: Option<u64>, body: Vec<u8>) -> Item {
    let sealed = kind.is_sealed();
    Item {
        kind,
        collection: b16(COLLECTION),
        seq,
        prev: seq.map(|s| if s == 1 { CHAIN_ZERO } else { b32(0xc4) }),
        epoch: sealed.then_some(1),
        signer: None,
        salt: sealed.then(|| b16("00112233-4455-6677-8899-aabbccddeeff")),
        idem: None,
        refs: None,
        stream: None,
        body: Bytes(body),
        sig: None,
    }
}

fn cert() -> CpCert {
    CpCert {
        policy_pk: b32(0x9c),
        not_before: 1_790_000_000_000,
        not_after: 1_800_000_000_000,
        root: b16("a0a1a2a3-a4a5-a6a7-a8a9-aaabacadaeaf"),
        sig: B64([0x51; 64]),
    }
}

fn record_view() -> RecordView {
    RecordView {
        id: b16(RECORD),
        path: "tasks/write contracts.md".into(),
        revision: sha256(b"---\nstatus: done\n---\nNotes\n"),
        frontmatter: DataMap(vec![("status".into(), Value::Text("done".into()))]),
        effective: None,
        body: Some("Notes\n".into()),
        document: None,
        types: vec!["task".into()],
        state: RecordState {
            state: Confirmation::Pending,
            confirmed_seq: 41,
            hold: None,
            unresolved: None,
        },
        diagnostics: None,
        values: None,
    }
}

/// Every positive fixture.
pub fn all() -> Vec<Fixture> {
    let mut v = Vec::new();

    // ---- value
    v.push(fx(
        "value",
        "frontmatter-kinds",
        Value::Map(vec![
            ("title".into(), Value::Text("Write contracts".into())),
            ("zeta-before-alpha".into(), Value::Bool(true)),
            ("alpha".into(), Value::Null),
            ("count".into(), Value::Int(-7)),
            ("big".into(), Value::Int(i64::MAX)),
            ("ratio".into(), Value::Float(-0.0)),
            ("one-point-zero".into(), Value::Float(1.0)),
            (
                "tags".into(),
                Value::List(vec![Value::Text("a".into()), Value::Text("b".into())]),
            ),
            (
                "nested".into(),
                Value::Map(vec![("k".into(), Value::List(vec![]))]),
            ),
        ]),
    ));

    // ---- mutations (one per operation kind)
    v.push(fx(
        "mutation",
        "create",
        mutation(vec![Op::Create(Create {
            id: b16(RECORD),
            path: None,
            type_name: Some("task".into()),
            frontmatter: Some(DataMap(vec![
                ("title".into(), Value::Text("Write contracts".into())),
                ("status".into(), Value::Text("open".into())),
            ])),
            body: Some(Text::Inline("Notes\n".into())),
            document: None,
        })]),
    ));
    v.push(fx("mutation", "update", mutation(vec![update_op()])));
    let mut ext = mutation(vec![Op::Document(Document {
        id: b16(RECORD),
        base: Some(DocVersion {
            path: "tasks/a.md".into(),
            doc: Text::Inline("---\nstatus: open\n---\n".into()),
        }),
        new: Some(DocVersion {
            path: "tasks/b.md".into(),
            doc: Text::Inline("---\nstatus: open\n---\nedited\n".into()),
        }),
        if_revision: None,
    })]);
    ext.source = Source::External;
    ext.validated_at = None;
    v.push(fx("mutation", "document-external-move", ext));
    v.push(fx(
        "mutation",
        "delete-rename-batch",
        Mutation {
            conflict_mode: Some(ConflictMode::Reject),
            on_behalf: Some(b16(GRANT)),
            ..mutation(vec![
                Op::Delete(Delete {
                    id: b16(FILE),
                    base_revision: Some(b32(0x11)),
                    if_revision: None,
                }),
                Op::Rename(Rename {
                    id: b16(RECORD),
                    from: "tasks/a.md".into(),
                    to: "archive/a.md".into(),
                    update_refs: true,
                    if_revision: Some(b32(0x22)),
                }),
                Op::ConflictDismiss(ConflictDismiss {
                    mutation: b16(MUTATION),
                    record: b16(RECORD),
                }),
            ])
        },
    ));
    v.push(fx(
        "mutation",
        "resources",
        mutation(vec![
            Op::ResourcePut(ResourcePut {
                path: "_types/task.md".into(),
                doc: Text::Inline("---\nname: task\n---\n".into()),
                base_revision: Some(b32(0x33)),
                must_not_exist: None,
            }),
            Op::ResourceDelete(ResourceDelete {
                path: "_types/old.md".into(),
                base_revision: None,
            }),
        ]),
    ));
    v.push(fx(
        "mutation",
        "files",
        mutation(vec![
            Op::FilePut(FilePut {
                id: b16(FILE),
                path: "Photos/today.png".into(),
                blob: blob(),
                if_revision: None,
                base: None,
            }),
            Op::FileMove(FileMove {
                id: b16("0192f3a4-5b6c-7d8e-9f01-000000000001"),
                from: "a.pdf".into(),
                to: "Archive/a.pdf".into(),
                update_refs: true,
                if_revision: None,
            }),
            Op::FileDelete(FileDelete {
                id: b16("0192f3a4-5b6c-7d8e-9f01-000000000002"),
                if_revision: Some(b32(0x44)),
                base: None,
            }),
            Op::SyncSettings(SyncSettings {
                inclusion: FileInclusion {
                    include: vec![MediaClass::Image, MediaClass::Pdf, MediaClass::Other],
                    exclude: Some(vec!["Videos".into()]),
                    max_size: Some(2 * 1024 * 1024 * 1024),
                },
            }),
        ]),
    ));
    v.push(fx(
        "mutation",
        "room-checkpoint",
        Mutation {
            room: Some(RoomCheckpoint {
                stream: b16("5a5a5a5a-5a5a-5a5a-5a5a-5a5a5a5a5a5a"),
                state: b32(0x77),
            }),
            ..mutation(vec![Op::Update(Update {
                id: b16(RECORD),
                patch: None,
                unset: None,
                add: None,
                remove: None,
                body: None,
                body_edits: Some(vec![BodyEdit {
                    start: 6,
                    end: 6,
                    insert: "typed in a room\n".into(),
                }]),
                body_base: Some(sha256(b"Notes\n")),
                body_base_text: Some(Text::Inline("Notes\n".into())),
                base: None,
                if_revision: None,
            })])
        },
    ));

    // ---- entry payloads
    v.push(fx(
        "entry",
        "applied-with-text-table",
        EntryPayload {
            resurrect: None,
            sem: Version { major: 1, minor: 0 },
            mutation: mutation(vec![update_op()]),
            status: Status::Merged,
            effects: vec![Effect::PutRecord(PutRecord {
                id: b16(RECORD),
                path: "tasks/write contracts.md".into(),
                doc: Text::Index(1),
            })],
            conflicts: None,
            aliases: None,
            texts: Some(vec![
                TextDef::Literal("---\nstatus: open\n---\nNotes\n".into()),
                TextDef::Form(TextDefForm::Delta(TextDelta {
                    source: TextSource::PrevRecord(b16(RECORD)),
                    ops: vec![
                        DeltaOp::Copy { offset: 0, len: 12 },
                        DeltaOp::Insert(Bytes(b"done".to_vec())),
                        DeltaOp::Copy {
                            offset: 16,
                            len: 10,
                        },
                    ],
                })),
                TextDef::Form(TextDefForm::Blob(TextBlob { blob: blob() })),
            ]),
        },
    ));
    v.push(fx(
        "entry",
        "conflicted-external",
        EntryPayload {
            resurrect: None,
            sem: Version { major: 1, minor: 0 },
            mutation: Mutation {
                source: Source::External,
                validated_at: None,
                ..mutation(vec![Op::FilePut(FilePut {
                    id: b16(FILE),
                    path: "Photos/today.png".into(),
                    blob: BlobRef {
                        blob_id: b32(0xb2),
                        ..blob()
                    },
                    if_revision: None,
                    base: Some(b32(0x99)),
                })])
            },
            status: Status::Conflicted,
            effects: vec![
                Effect::PutRecord(PutRecord {
                    id: b16(RECORD),
                    path: "archive/a.md".into(),
                    doc: "---\nstatus: done\n---\n".into(),
                }),
                Effect::RemoveRecord(RemoveRecord {
                    id: b16("0192f3a4-5b6c-7d8e-9f01-000000000003"),
                    path: "old.md".into(),
                }),
                Effect::PutFile(PutFile {
                    id: b16(FILE),
                    path: "Photos/today.png".into(),
                    blob: blob(),
                }),
                Effect::RemoveFile(RemoveFile {
                    id: b16("0192f3a4-5b6c-7d8e-9f01-000000000002"),
                    path: "x.bin".into(),
                }),
                Effect::PutResource(PutResource {
                    path: "mdbase.yaml".into(),
                    doc: "spec_version: \"0.3.0\"\n".into(),
                }),
                Effect::RemoveResource(RemoveResource {
                    path: "_types/old.md".into(),
                }),
                Effect::PutSettings(PutSettings {
                    inclusion: FileInclusion {
                        include: vec![MediaClass::Image],
                        exclude: None,
                        max_size: None,
                    },
                }),
            ],
            conflicts: Some(vec![
                Conflict {
                    kind: ConflictKind::Field,
                    id: b16(RECORD),
                    field: Some("status".into()),
                    base: Some(ConflictValue::Value(Value::Text("open".into()))),
                    kept: ConflictValue::Value(Value::Text("done".into())),
                    lost: ConflictValue::Value(Value::Text("in-progress".into())),
                },
                Conflict {
                    kind: ConflictKind::File,
                    id: b16(FILE),
                    field: None,
                    base: None,
                    kept: ConflictValue::Blob(blob()),
                    lost: ConflictValue::Blob(BlobRef {
                        blob_id: b32(0xb2),
                        ..blob()
                    }),
                },
                Conflict {
                    kind: ConflictKind::Delete,
                    id: b16(RECORD),
                    field: None,
                    base: Some(ConflictValue::Missing),
                    kept: ConflictValue::Text(Text::Inline("kept".into())),
                    lost: ConflictValue::Deleted,
                },
            ]),
            aliases: Some(vec![Alias {
                path: "tasks/a.md".into(),
                record: b16(RECORD),
            }]),
            texts: None,
        },
    ));

    // ---- item envelopes, one per kind
    let mut entry = item(ItemKind::Entry, Some(42), vec![0xde, 0xad, 0xbe, 0xef]);
    entry.signer = Some(b16(DEVICE));
    entry.idem = Some(b16("1d1d1d1d-1d1d-1d1d-1d1d-1d1d1d1d1d1d"));
    entry.refs = Some(vec![b32(0xa1)]);
    entry.sig = Some(B64([0x5a; 64]));
    v.push(fx("item", "entry", entry));
    let mut pol = item(ItemKind::Policy, Some(1), vec![0xa0]);
    pol.signer = Some(cert().key_id());
    pol.sig = Some(B64([0x5b; 64]));
    v.push(fx("item", "policy", pol));
    let mut rk = item(ItemKind::Rekey, Some(2), vec![0xa0]);
    rk.signer = Some(b16(DEVICE));
    rk.sig = Some(B64([0x5c; 64]));
    v.push(fx("item", "rekey", rk));
    let mut base = item(ItemKind::Base, Some(3), vec![1, 2, 3]);
    base.signer = Some(b16(DEVICE));
    base.refs = Some(vec![b32(0xa2)]);
    base.sig = Some(B64([0x5d; 64]));
    v.push(fx("item", "base", base));
    let mut man = item(ItemKind::Manifest, None, vec![4, 5, 6]);
    man.signer = Some(b16(DEVICE));
    man.refs = Some(vec![b32(0xa3), b32(0xa4)]);
    man.sig = Some(B64([0x5e; 64]));
    v.push(fx("item", "manifest", man));
    v.push(fx(
        "item",
        "chunk",
        item(ItemKind::Chunk, None, vec![7; 20]),
    ));
    v.push(fx(
        "item",
        "blob-part",
        item(ItemKind::BlobPart, None, vec![8; 20]),
    ));
    let mut eph = item(ItemKind::Ephemeral, None, vec![9; 8]);
    eph.signer = Some(b16(DEVICE));
    eph.stream = Some(b16("5a5a5a5a-5a5a-5a5a-5a5a-5a5a5a5a5a5a"));
    v.push(fx("item", "ephemeral", eph));
    let mut ga = item(ItemKind::GrantApproval, Some(4), vec![0x6a; 12]);
    ga.signer = Some(b16(DEVICE));
    ga.sig = Some(B64([0x5f; 64]));
    v.push(fx("item", "grant-approval", ga));

    // ---- key items
    let wrap = |d: &str| KeyWrap {
        device: b16(d),
        enc: b32(0xe1),
        ct: Bytes(vec![0xc7; 48]),
    };
    v.push(fx(
        "rekey",
        "device-revoked",
        RekeyPayload {
            epoch: 2,
            from: 1,
            commit: b32(0xcc),
            wraps: vec![wrap(DEVICE), wrap(REPLICA)],
            history: SealedBox {
                salt: b16("0f0e0d0c-0b0a-0908-0706-050403020100"),
                ct: Bytes(vec![0xab; 80]),
            },
            reason: RekeyReason::DeviceRevoked,
        },
    ));
    v.push(fx(
        "key-grant",
        "new-device",
        KeyGrantPayload {
            recipient: b16(DEVICE),
            epoch: 2,
            wrap: wrap(DEVICE),
        },
    ));

    // ---- snapshots
    v.push(fx(
        "manifest",
        "bucketed",
        ManifestPayload {
            seq: 10_000,
            chain: b32(0xc5),
            state_digest: b32(0xd5),
            bucket_bits: 8,
            sections: vec![
                Section {
                    kind: SectionKind::Resources,
                    chunks: vec![ChunkRef {
                        address: b32(0x01),
                        plain_hash: b32(0x02),
                        rows: 3,
                        bucket: 0,
                        plain_size: 900,
                    }],
                },
                Section {
                    kind: SectionKind::Index,
                    chunks: vec![ChunkRef {
                        address: b32(0x03),
                        plain_hash: b32(0x04),
                        rows: 400,
                        bucket: 0,
                        plain_size: 44_000,
                    }],
                },
                Section {
                    kind: SectionKind::Receipts,
                    chunks: vec![],
                },
            ],
            horizon: Horizon {
                seq_floor: 1,
                time_floor: 0,
            },
            sem: Version { major: 1, minor: 0 },
            record_count: 100_000,
            file_count: 1_234,
            previous: Some(b32(0x06)),
            control_chain: b32(0x07),
        },
    ));
    let rows = vec![
        RecordRow {
            id: b16(RECORD),
            path: "tasks/a.md".into(),
            doc: TextOrBlob::Text("---\nstatus: open\n---\n".into()),
        }
        .to_cbor(),
        RecordRow {
            id: b16(FILE),
            path: "big.md".into(),
            doc: TextOrBlob::Blob(blob()),
        }
        .to_cbor(),
    ];
    v.push(fx(
        "chunk",
        "records",
        ChunkPayload {
            section: SectionKind::Records,
            bucket: 7,
            rows,
        },
    ));
    v.push(fx(
        "chunk",
        "index",
        ChunkPayload {
            section: SectionKind::Index,
            bucket: 7,
            rows: vec![
                IndexRow {
                    id: b16(RECORD),
                    kind: EntityKind::Record,
                    path: "tasks/a.md".into(),
                    revision: b32(0x10),
                    size: 21,
                    modified_seq: 0,
                }
                .to_cbor(),
            ],
        },
    ));
    v.push(fx(
        "chunk",
        "files-and-side-tables",
        ChunkPayload {
            section: SectionKind::Files,
            bucket: 0,
            rows: vec![
                FileRow {
                    id: b16(FILE),
                    path: "Photos/today.png".into(),
                    blob: blob(),
                    media: MediaClass::Image,
                }
                .to_cbor(),
                TombstoneRow {
                    id: b16(RECORD),
                    kind: EntityKind::File,
                    path: "old.png".into(),
                    last: TextOrBlob::Blob(blob()),
                    seq: 9_000,
                    time: 1_791_000_000_000,
                }
                .to_cbor(),
                ResourceRow {
                    path: "mdbase.yaml".into(),
                    doc: TextOrBlob::Text("spec_version: \"0.3.0\"\n".into()),
                }
                .to_cbor(),
                Alias {
                    path: "tasks/a.md".into(),
                    record: b16(RECORD),
                }
                .to_cbor(),
                ReceiptRow {
                    mutation: b16(MUTATION),
                    seq: 41,
                    time: 1_791_100_800_000,
                }
                .to_cbor(),
            ],
        },
    ));
    v.push(fx(
        "base",
        "folder",
        BasePayload {
            manifest: b32(0xa2),
            state_digest: b32(0xd0),
            adopter: b16(REPLICA),
            source: BaseSource::Folder,
            legacy_collection: None,
            prehistory: None,
        },
    ));
    v.push(fx(
        "base",
        "hosted-import-prehistory",
        BasePayload {
            manifest: b32(0xa2),
            state_digest: b32(0xd0),
            adopter: b16(REPLICA),
            source: BaseSource::HostedImport,
            legacy_collection: Some(b16(COLLECTION)),
            prehistory: Some(vec![
                BlobRef {
                    plain_hash: sha256(b"prehistory segment 0"),
                    size: 9 * 1024 * 1024,
                    blob_id: b32(0xc0),
                    id_epoch: 1,
                    part_size: 8 * 1024 * 1024,
                },
                BlobRef {
                    plain_hash: sha256(b"prehistory segment 1"),
                    size: 4096,
                    blob_id: b32(0xc1),
                    id_epoch: 1,
                    part_size: 8 * 1024 * 1024,
                },
            ]),
        },
    ));

    // ---- policy
    v.push(fx(
        "policy",
        "genesis",
        PolicyPayload {
            cert: cert(),
            issued_at: 1_791_100_000_000,
            ops: vec![
                PolicyOp::Genesis(Genesis {
                    owner: b16(GRANT),
                    root: b16("a0a1a2a3-a4a5-a6a7-a8a9-aaabacadaeaf"),
                    state: CState::E2e,
                }),
                PolicyOp::MemberSet(MemberSet {
                    account: b16(GRANT),
                    role: Role::Owner,
                }),
                PolicyOp::DeviceEnrol(DeviceEnrol {
                    device: b16(DEVICE),
                    account: b16(GRANT),
                    kind: DeviceKind::Desktop,
                    sign_pk: b32(0x01),
                    kem_pk: b32(0x02),
                    noise_pk: b32(0x03),
                    sas_commit: None,
                    local_root: None,
                }),
            ],
        },
    ));
    v.push(fx(
        "policy",
        "every-op",
        PolicyPayload {
            cert: cert(),
            issued_at: 1_791_200_000_000,
            ops: vec![
                PolicyOp::DeviceRevoke(DeviceRevoke {
                    device: b16(DEVICE),
                }),
                PolicyOp::MemberRemove(MemberRemove {
                    account: b16(REPLICA),
                }),
                PolicyOp::Grant(Grant {
                    grant: b16(GRANT),
                    installation: b16(REPLICA),
                    app_id: "tasknotes-planner".into(),
                    account: b16(GRANT),
                    capabilities: vec!["collection.read".into(), "records.edit".into()],
                    client_pk: b32(0x0c),
                    file_folders: Some(vec!["Photos".into()]),
                    folder_scoped: None,
                }),
                PolicyOp::GrantRevoke(GrantRevoke { grant: b16(GRANT) }),
                PolicyOp::CollectionState(CollectionState {
                    state: CState::CloudCopy,
                    compress: Some(false),
                    min_sem_major: None,
                }),
                PolicyOp::CpKeyRevoke(CpKeyRevoke {
                    key_id: cert().key_id(),
                    revoked_from: 1_791_150_000_000,
                    root_sig: B64([0x52; 64]),
                }),
                PolicyOp::MigrationCutover(MigrationCutover {
                    legacy_collection: b16(COLLECTION),
                    revoked: vec![b16(REPLICA)],
                    cutover_at: 1_791_200_000_000,
                }),
                PolicyOp::Freeze(Freeze {
                    frozen: false,
                    reason: Some("cutover complete".into()),
                }),
            ],
        },
    ));

    v.push(fx(
        "policy",
        "security-ops",
        PolicyPayload {
            cert: cert(),
            issued_at: 1_791_300_000_000,
            ops: vec![
                PolicyOp::DeviceEnrol(DeviceEnrol {
                    device: b16(REPLICA),
                    account: b16(GRANT),
                    kind: DeviceKind::Mobile,
                    sign_pk: b32(0x11),
                    kem_pk: b32(0x12),
                    noise_pk: b32(0x13),
                    sas_commit: Some(b32(0x14)),
                    local_root: Some(b32(0x15)),
                }),
                PolicyOp::DeviceEnrol(DeviceEnrol {
                    device: b16(FILE),
                    account: b16(GRANT),
                    kind: DeviceKind::Recovery,
                    sign_pk: b32(0x21),
                    kem_pk: b32(0x22),
                    noise_pk: b32(0x00),
                    sas_commit: None,
                    local_root: None,
                }),
                PolicyOp::Grant(Grant {
                    grant: b16(GRANT),
                    installation: b16(REPLICA),
                    app_id: "tasknotes-planner".into(),
                    account: b16(GRANT),
                    capabilities: vec!["collection.read".into()],
                    client_pk: b32(0x0c),
                    file_folders: None,
                    folder_scoped: Some(true),
                }),
                PolicyOp::RootHandover(RootHandover {
                    new_root: b32(0x15),
                    owner_device: b16(DEVICE),
                    move_id: b16(MUTATION),
                    consent: B64([0x53; 64]),
                }),
            ],
        },
    ));
    v.push(fx(
        "grant-approval",
        "folder-scoped",
        GrantApprovalPayload {
            grant: b16(GRANT),
            client_pk: b32(0x0c),
            capabilities: vec!["collection.read".into(), "records.edit".into()],
            file_folders: Some(vec!["Photos".into(), "Scans/2026".into()]),
        },
    ));
    v.push(fx(
        "head-witness",
        "signed",
        HeadWitness {
            collection: b16(COLLECTION),
            device: b16(DEVICE),
            seq: 42,
            chain: b32(0xc4),
            epoch: 2,
            signed_at: 1_791_400_000_000,
            sig: B64([0x54; 64]),
            policy_generation: None,
            catalog_generation: None,
        },
    ));

    let mut handover_witness = witness_min();
    handover_witness.policy_generation = Some(b32(0xc1));
    handover_witness.catalog_generation = Some(b32(0xca));
    v.push(fx(
        "head-witness",
        "signed-handover",
        handover_witness.clone(),
    ));
    let confirmed = ConfirmedHead {
        seq: handover_witness.seq,
        chain: handover_witness.chain,
        policy_generation: handover_witness.policy_generation.unwrap(),
        catalog_generation: handover_witness.catalog_generation.unwrap(),
    };
    v.push(fx("client", "confirmed-head", confirmed.clone()));
    v.push(fx(
        "client",
        "applied-prefix-params",
        AppliedPrefixParams { seq: 1 },
    ));
    v.push(fx(
        "client",
        "applied-prefix-behind",
        AppliedPrefix {
            applied_through: 0,
            seq: 1,
            chain: None,
        },
    ));
    v.push(fx(
        "client",
        "applied-prefix-ahead",
        AppliedPrefix {
            applied_through: 9,
            seq: 1,
            chain: Some(confirmed.chain),
        },
    ));

    // ---- log service messages
    for (name, max_bytes) in [
        ("read-request-default", None),
        ("read-request-max-bytes", Some(512 * 1024)),
    ] {
        v.push(fx(
            "log-service",
            name,
            LsFrame::Request(LsRequest {
                id: 9,
                method: "read".into(),
                params: ReadParams {
                    collection: b16(COLLECTION),
                    after: 42,
                    limit: 1000,
                    kinds: None,
                    max_bytes,
                }
                .to_cbor(),
            }),
        ));
    }
    v.push(fx(
        "log-service",
        "append-request",
        LsFrame::Request(LsRequest {
            id: 7,
            method: "append".into(),
            params: AppendParams {
                collection: b16(COLLECTION),
                expect_seq: 43,
                expect_prev: b32(0xc4),
                items: vec![Bytes(vec![0xa1, 0x00, 0x01])],
            }
            .to_cbor(),
        }),
    ));
    v.push(fx(
        "log-service",
        "append-head-moved",
        LsFrame::Response(LsResponse {
            id: 7,
            result: Some(
                AppendResult::HeadMoved(HeadMoved {
                    head: 44,
                    head_chain: b32(0xc6),
                })
                .to_cbor(),
            ),
            error: None,
        }),
    ));
    v.push(fx(
        "log-service",
        "append-appended",
        AppendResult::Appended(Appended {
            first: 43,
            last: 44,
            head_chain: b32(0xc7),
            appended_at: 1_791_100_900_000,
        }),
    ));
    v.push(fx(
        "log-service",
        "append-duplicate",
        AppendResult::Duplicate(Duplicate { index: 0, seq: 12 }),
    ));
    v.push(fx(
        "log-service",
        "error-rate-limited",
        LsFrame::Response(LsResponse {
            id: 8,
            result: None,
            error: Some(LsError {
                code: "rate_limited".into(),
                reason: None,
                message: None,
                retry_after_ms: Some(250),
                details: None,
            }),
        }),
    ));
    v.push(fx(
        "log-service",
        "read-result-behind",
        ReadResult {
            items: vec![],
            head: 120_000,
            head_chain: b32(0xc8),
            retained_from: 100_001,
            behind: true,
            snapshot: Some(SnapshotPointer {
                seq: 110_000,
                manifest: b32(0xa3),
                author: b16(DEVICE),
                created_at: 1_791_000_000_000,
                endorsed: true,
            }),
            more: false,
        },
    ));
    v.push(fx(
        "log-service",
        "put-object-upload",
        PutObjectResult {
            status: PutStatus::Upload,
            direct: Some(DirectTransfer {
                url: "https://objects.example/c/4c18af2e/abcd?sig=x".into(),
                headers: DataMap(vec![("x-amz-checksum-sha256".into(), "q83v".into())]),
                expires_at: 1_791_100_900_000,
            }),
        },
    ));
    v.push(fx(
        "log-service",
        "get-object-range",
        GetObjectParams {
            collection: b16(COLLECTION),
            address: b32(0xa5),
            range: Some(ByteRange {
                offset: 65_552,
                len: 65_552,
            }),
        },
    ));
    v.push(fx(
        "log-service",
        "items-push",
        LsFrame::Push(LsPush {
            kind: "items".into(),
            payload: ItemsPush {
                collection: b16(COLLECTION),
                items: vec![SeqItem {
                    seq: 45,
                    item: Bytes(vec![0xa0]),
                }],
                head: 45,
                head_chain: b32(0xc9),
            }
            .to_cbor(),
        }),
    ));
    v.push(fx(
        "log-service",
        "stream-event",
        StreamEvent {
            collection: b16(COLLECTION),
            stream: b16("5a5a5a5a-5a5a-5a5a-5a5a-5a5a5a5a5a5a"),
            device: b16(DEVICE),
            event: StreamEventKind::Joined,
        },
    ));

    // ---- client API messages
    v.push(fx(
        "client",
        "submit-request",
        ClientFrame::Request(ClientRequest {
            id: 1,
            method: "submit".into(),
            params: SubmitParams {
                ops: vec![update_op()],
                mutation_id: Some(b16(MUTATION)),
                conflict_mode: None,
                timezone: Some("Australia/Melbourne".into()),
                allow_partial: None,
                mutation_ids: None,
                dry_run: None,
                include: Some(Include {
                    effective: None,
                    body: Some(true),
                    document: None,
                    diagnostics: None,
                }),
                wait: None,
            }
            .to_cbor(),
        }),
    ));
    v.push(fx(
        "client",
        "receipt-pending",
        Receipt {
            relocated_from: None,
            mutation: b16(MUTATION),
            state: ReceiptState::Pending,
            seq: None,
            status: None,
            conflicts: None,
            records: Some(vec![record_view()]),
            problem: None,
            published: None,
        },
    ));
    v.push(fx(
        "client",
        "receipt-rejected",
        Receipt {
            relocated_from: None,
            mutation: b16(MUTATION),
            state: ReceiptState::Rejected,
            seq: None,
            status: None,
            conflicts: None,
            records: None,
            problem: Some(Problem {
                code: "conflict".into(),
                recovery: Recovery::ResolveConflict,
                message: "the record changed since if_revision".into(),
                reason: Some("revision".into()),
                details: Some(Value::Map(vec![(
                    "current".into(),
                    Value::Text("sha256:ab".into()),
                )])),
                retry_after_ms: None,
                issues: None,
                trace_id: None,
            }),
            published: None,
        },
    ));
    v.push(fx(
        "client",
        "hello-result-witness",
        HelloResult {
            version: Version { major: 1, minor: 0 },
            runtime_version: "0.1.0".into(),
            sem: Version { major: 1, minor: 0 },
            collection: b16(COLLECTION),
            grant: GrantInfo {
                grant: Some(b16(GRANT)),
                capabilities: vec!["collection.read".into()],
                role: Role::Editor,
            },
            status: SyncStatus {
                resyncing: None,
                confirmed_head: None,
                mode: SyncMode::Synced,
                confirmed_through: 42,
                head_known: 42,
                pending: 0,
                oldest_pending: None,
                holds: 0,
                unresolved: 0,
                connection: Connection::Online,
                installing: None,
                incidents: vec![],
            },
            features: vec![],
            head_witness: Some(Bytes(witness_min().to_bytes().expect("canonical"))),
        },
    ));
    v.push(fx(
        "client",
        "status",
        SyncStatus {
            resyncing: None,
            confirmed_head: None,
            mode: SyncMode::Synced,
            confirmed_through: 41,
            head_known: 44,
            pending: 3,
            oldest_pending: Some(1_791_100_700_000),
            holds: 1,
            unresolved: 2,
            connection: Connection::Online,
            installing: None,
            incidents: vec![Incident {
                kind: IncidentKind::VoidedItems,
                details: Some(Value::Int(1)),
            }],
        },
    ));
    let base = v
        .iter()
        .find(|f| f.format == "client" && f.name == "status")
        .unwrap();
    let mut handover_status = SyncStatus::from_bytes(&base.bytes).unwrap();
    handover_status.confirmed_through = confirmed.seq;
    handover_status.confirmed_head = Some(confirmed);
    v.push(fx("client", "status-handover", handover_status.clone()));
    let base = v
        .iter()
        .find(|f| f.format == "client" && f.name == "hello-result-witness")
        .unwrap();
    let mut handover_hello = HelloResult::from_bytes(&base.bytes).unwrap();
    handover_hello.status = handover_status;
    handover_hello.head_witness = Some(Bytes(handover_witness.to_bytes().unwrap()));
    v.push(fx("client", "hello-result-handover", handover_hello));
    // Lost-tail extensions use ONLY the already allocated contract keys.
    for (name, phase) in [
        ("status-resync-probing", ResyncPhase::Probing),
        ("status-resync-repairing", ResyncPhase::Repairing),
        ("status-resync-rolling-back", ResyncPhase::RollingBack),
        (
            "status-resync-awaiting-control",
            ResyncPhase::AwaitingControl,
        ),
    ] {
        let base = v
            .iter()
            .find(|f| f.format == "client" && f.name == "status")
            .unwrap();
        let mut status = SyncStatus::from_bytes(&base.bytes).unwrap();
        status.resyncing = Some(Resyncing {
            phase,
            positions: 3,
        });
        status.incidents = vec![
            Incident {
                kind: IncidentKind::LogRegressed,
                details: None,
            },
            Incident {
                kind: IncidentKind::LostEntries,
                details: None,
            },
        ];
        v.push(fx("client", name, status));
    }
    let base = v
        .iter()
        .find(|f| f.format == "client" && f.name == "receipt-pending")
        .unwrap();
    let mut relocated = Receipt::from_bytes(&base.bytes).unwrap();
    relocated.state = ReceiptState::Confirmed;
    relocated.seq = Some(99);
    relocated.relocated_from = Some(42);
    v.push(fx("client", "receipt-relocated", relocated));
    let base = v
        .iter()
        .find(|f| f.format == "entry" && f.name == "applied-with-text-table")
        .unwrap();
    let mut resurrected = EntryPayload::from_bytes(&base.bytes).unwrap();
    resurrected.resurrect = Some(42);
    v.push(fx("entry", "resurrected", resurrected));
    v.push(fx(
        "client",
        "query-update-diff",
        QueryUpdate {
            sub: 3,
            kind: UpdateKind::Diff,
            added: None,
            changed: Some(vec![record_view()]),
            removed: Some(vec![b16(FILE)]),
            order: None,
            complete: true,
            as_of: 99,
            metadata: None,
        },
    ));
    let groups = vec![QueryGroup {
        values: DataMap(vec![("status".into(), Value::Text("done".into()))]),
        count: 12,
        summaries: Some(DataMap(vec![("total_estimate".into(), Value::Int(30))])),
    }];
    let mut selected = record_view();
    selected.values = Some(DataMap(vec![("label".into(), Value::Text("Done".into()))]));
    v.push(fx(
        "client",
        "query-result-metadata",
        QueryResult {
            records: vec![selected],
            cursor: None,
            complete: true,
            as_of: 99,
            columns: Some(vec!["label".into()]),
            total_count: Some(12),
            diagnostics: Some(vec![]),
            view: Some(ViewRef {
                path: "tasks.base".into(),
                view: "board".into(),
            }),
            groups: Some(groups.clone()),
            has_more: Some(true),
        },
    ));
    v.push(fx(
        "client",
        "query-result-limit-zero",
        QueryResult {
            records: vec![],
            cursor: None,
            complete: true,
            as_of: 99,
            columns: None,
            total_count: Some(12),
            diagnostics: Some(vec![]),
            view: None,
            groups: Some(groups.clone()),
            has_more: Some(true),
        },
    ));
    v.push(fx(
        "client",
        "query-update-metadata",
        QueryUpdate {
            sub: 3,
            kind: UpdateKind::Diff,
            added: None,
            changed: None,
            removed: None,
            order: None,
            complete: true,
            as_of: 100,
            metadata: Some(QueryMetadata {
                columns: Some(vec!["label".into()]),
                total_count: Some(12),
                diagnostics: Some(vec![]),
                view: None,
                groups: Some(groups),
                has_more: Some(true),
            }),
        },
    ));
    v.push(fx(
        "client",
        "hold-file",
        Hold {
            id: b16(FILE),
            path: "Photos/today.png".into(),
            reason: HoldReason::Conflict,
            since: 1_791_100_000_000,
            base: None,
            mine: TextOrBlob::Blob(BlobRef {
                blob_id: b32(0xb3),
                ..blob()
            }),
            theirs: Some(TextOrBlob::Blob(blob())),
            saves: 0,
        },
    ));
    v.push(fx(
        "client",
        "file-view",
        FileView {
            id: b16(FILE),
            path: "Photos/today.png".into(),
            size: 18,
            digest: blob().plain_hash,
            media: MediaClass::Image,
            state: FileState::Remote,
            confirmed_seq: 40,
            hold: None,
        },
    ));
    v.push(fx(
        "client",
        "open-upload",
        OpenUploadParams {
            transfer: b16("7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a"),
            path: "Media/video.mp4".into(),
            size: 3_221_225_472,
            digest: Some(b32(0x3d)),
            file_id: None,
            if_revision: None,
            mutation_id: Some(b16(MUTATION)),
        },
    ));
    v.push(fx(
        "client",
        "transfer-progress",
        TransferProgress {
            id: TransferId::Upload(b16("7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a")),
            phase: Phase::Uploading,
            done: 16_777_216,
            total: 3_221_225_472,
        },
    ));
    v.push(fx(
        "client",
        "materialization",
        Materialization {
            mode: MaterializeMode::OnDemand,
            pinned: Some(vec!["Journal".into()]),
            media: Some(vec![MediaClass::Image, MediaClass::Pdf]),
            max_size: None,
        },
    ));
    v.push(fx(
        "client",
        "hello",
        HelloParams {
            versions: vec![Version { major: 1, minor: 0 }],
            client_name: "tasknotes".into(),
            client_version: "5.0.0".into(),
            features: Some(vec!["presence".into(), "fence".into()]),
            timezone: Some("Australia/Melbourne".into()),
        },
    ));
    v.push(fx(
        "client",
        "presence-peer",
        Peer {
            session: b16("abababab-abab-abab-abab-abababababab"),
            account: Some(b16(GRANT)),
            app: Some("mdbase-editor".into()),
            state: Value::Map(vec![
                ("cursor".into(), Value::Int(120)),
                ("editing".into(), Value::Bool(true)),
            ]),
            last_seen: 1_791_100_800_500,
        },
    ));

    v.extend(attachment_fixtures());
    v.extend(unindexed_markdown_fixtures());
    v.extend(attachment_runtime_v1::positive());
    v.extend(extended_runtime_v1::positive());
    v
}

fn attachment_content() -> AttachmentContentV1 {
    AttachmentContentV1 {
        reference: AttachmentRefV1 {
            collection: b16(COLLECTION),
            key_epoch: 3,
            attachment_id: b32(0xa1),
            manifest_cipher_hash: b32(0xa2),
        },
        whole_plain_hash: b32(0xa3),
        total_plain_bytes: 9_000_000,
    }
}
fn attachment_fixtures() -> Vec<Fixture> {
    let content = attachment_content();
    let id = b16(FILE);
    let path = "assets/photo.webp".to_owned();
    let chunk = ChunkRef {
        address: b32(0xa4),
        plain_hash: b32(0xa5),
        rows: 1,
        bucket: 0,
        plain_size: 256,
    };
    vec![
        fx("attachment", "ref-v1", content.reference.clone()),
        fx("attachment", "content-v1", content.clone()),
        fx(
            "attachment",
            "content-legacy",
            FileContent::Blob(BlobRef {
                plain_hash: b32(0xb1),
                size: 42,
                blob_id: b32(0xb2),
                id_epoch: 2,
                part_size: 8_388_608,
            }),
        ),
        fx(
            "attachment",
            "file-attach-v1",
            AttachmentOpV1::FileAttach(FileAttach {
                id,
                path: path.clone(),
                content: content.clone(),
                if_revision: Some(b32(0xb3)),
                base: None,
            }),
        ),
        fx(
            "attachment",
            "put-file-v1",
            AttachmentEffectV1::PutAttachmentFile(PutAttachmentFile {
                id,
                path: path.clone(),
                content: content.clone(),
            }),
        ),
        fx(
            "attachment",
            "conflict-v1",
            AttachmentConflictValueV1 {
                content: content.clone(),
            },
        ),
        fx(
            "attachment",
            "file-row-v1",
            AttachmentFileRowV1 {
                id,
                path: path.clone(),
                content: content.clone(),
                media: MediaClass::Image,
            },
        ),
        fx(
            "attachment",
            "tombstone-row-v1",
            AttachmentTombstoneRowV1 {
                id,
                path,
                content,
                seq: 42,
                time: 1_791_100_800_000,
            },
        ),
        fx(
            "attachment",
            "section-files-v1",
            AttachmentSectionV1 {
                kind: AttachmentSectionKindV1::AttachmentFiles,
                chunks: vec![chunk.clone()],
            },
        ),
        fx(
            "attachment",
            "section-tombstones-v1",
            AttachmentSectionV1 {
                kind: AttachmentSectionKindV1::AttachmentTombstones,
                chunks: vec![chunk],
            },
        ),
    ]
}
fn attachment_negatives() -> Vec<BadFixture> {
    let content = attachment_content();
    let Cbor::Array(reference) = content.reference.to_cbor() else {
        unreachable!()
    };
    let mut unknown = reference.clone();
    unknown[0] = Cbor::Uint(2);
    let mut chunk = reference.clone();
    chunk[4] = Cbor::Uint(4_194_304);
    let mut extra = reference;
    extra.push(Cbor::Uint(0));
    let Cbor::Array(mut unknown_content) = content.to_cbor() else {
        unreachable!()
    };
    unknown_content[0] = Cbor::Uint(2);
    vec![
        bad::<AttachmentRefV1>(
            "attachment",
            "ref-unknown-version",
            raw(Cbor::Array(unknown)),
            "unknown critical version requires upgrade",
        ),
        bad::<AttachmentRefV1>(
            "attachment",
            "ref-unknown-chunk-profile",
            raw(Cbor::Array(chunk)),
            "unknown fixed chunk profile requires upgrade",
        ),
        bad::<AttachmentRefV1>(
            "attachment",
            "ref-extra-element",
            raw(Cbor::Array(extra)),
            "exact tuple arity; no ignored critical elements",
        ),
        bad::<AttachmentContentV1>(
            "attachment",
            "content-unknown-version",
            raw(Cbor::Array(unknown_content)),
            "unknown critical content version requires upgrade",
        ),
    ]
}

fn unindexed_markdown_payload() -> UnindexedMarkdownPayloadV1 {
    UnindexedMarkdownPayloadV1 {
        content: FileContent::AttachmentV1(attachment_content()),
    }
}
fn unindexed_markdown_fixtures() -> Vec<Fixture> {
    let payload = unindexed_markdown_payload();
    let legacy = UnindexedMarkdownPayloadV1 {
        content: FileContent::Blob(BlobRef {
            plain_hash: b32(0xc1),
            size: 2_000_000,
            blob_id: b32(0xc2),
            id_epoch: 2,
            part_size: 8_388_608,
        }),
    };
    let id = b16(FILE);
    let path = "notes/huge-export.md".to_owned();
    let chunk = ChunkRef {
        address: b32(0xc4),
        plain_hash: b32(0xc5),
        rows: 1,
        bucket: 0,
        plain_size: 256,
    };
    let dir = "unindexed-markdown";
    vec![
        fx(dir, "payload-v1", payload.clone()),
        fx(dir, "payload-legacy-blob", legacy.clone()),
        fx(
            dir,
            "put-create-v1",
            UnindexedMarkdownOpV1::Put(UnindexedMarkdownPut {
                id,
                path: path.clone(),
                payload: payload.clone(),
                expected: None,
            }),
        ),
        fx(
            dir,
            "put-replace-v1",
            UnindexedMarkdownOpV1::Put(UnindexedMarkdownPut {
                id,
                path: path.clone(),
                payload: payload.clone(),
                expected: Some(legacy.clone()),
            }),
        ),
        fx(
            dir,
            "record-to-file-v1",
            UnindexedMarkdownOpV1::RecordToFile(RecordToUnindexedMarkdown {
                id,
                path: path.clone(),
                payload: payload.clone(),
                prior_revision: b32(0xc3),
            }),
        ),
        fx(
            dir,
            "file-to-record-v1",
            UnindexedMarkdownOpV1::FileToRecord(UnindexedMarkdownToRecord {
                id,
                path: path.clone(),
                doc: Text::Inline(
                    "---\ntitle: trimmed\n---\nnow small enough to index\n".to_owned(),
                ),
                prior: payload.clone(),
            }),
        ),
        fx(
            dir,
            "effect-put-v1",
            UnindexedMarkdownEffectV1::PutUnindexedMarkdown(PutUnindexedMarkdown {
                id,
                path: path.clone(),
                payload: payload.clone(),
            }),
        ),
        fx(
            dir,
            "effect-reindex-v1",
            UnindexedMarkdownEffectV1::ReindexUnindexedMarkdown(ReindexUnindexedMarkdown {
                id,
                path: path.clone(),
                doc: Text::Inline(
                    "---\ntitle: trimmed\n---\nnow small enough to index\n".to_owned(),
                ),
            }),
        ),
        fx(
            dir,
            "conflict-v1",
            UnindexedMarkdownConflictValueV1 {
                payload: payload.clone(),
            },
        ),
        fx(
            dir,
            "file-row-v1",
            UnindexedMarkdownFileRowV1 {
                id,
                path: path.clone(),
                payload: payload.clone(),
                media: MediaClass::Other,
            },
        ),
        fx(
            dir,
            "tombstone-row-v1",
            UnindexedMarkdownTombstoneRowV1 {
                id,
                path,
                payload: payload.clone(),
                seq: 43,
                time: 1_791_100_800_000,
            },
        ),
        fx(
            dir,
            "section-files-v1",
            UnindexedMarkdownSectionV1 {
                kind: UnindexedMarkdownSectionKindV1::UnindexedMarkdownFiles,
                chunks: vec![chunk.clone()],
            },
        ),
        fx(
            dir,
            "section-tombstones-v1",
            UnindexedMarkdownSectionV1 {
                kind: UnindexedMarkdownSectionKindV1::UnindexedMarkdownTombstones,
                chunks: vec![chunk],
            },
        ),
        fx(
            dir,
            "native-tombstone-last-v1",
            NativeUnindexedMarkdownTombstoneLastV1 { payload },
        ),
    ]
}
fn unindexed_markdown_negatives() -> Vec<BadFixture> {
    let payload = unindexed_markdown_payload();
    let Cbor::Array(envelope) = payload.to_cbor() else {
        unreachable!()
    };
    let mut discriminator = envelope.clone();
    discriminator[0] = Cbor::Uint(3);
    let mut profile = envelope.clone();
    profile[1] = Cbor::Uint(2);
    let mut ordinary = envelope.clone();
    ordinary[2] = Cbor::Uint(0);
    let mut extra = envelope.clone();
    extra.push(Cbor::Uint(0));
    let conflict = Cbor::Array(vec![Cbor::Uint(5), Cbor::Array(envelope.clone())]);
    let dir = "unindexed-markdown";
    vec![
        bad::<UnindexedMarkdownPayloadV1>(
            dir,
            "payload-unknown-discriminator",
            raw(Cbor::Array(discriminator)),
            "unknown file-payload discriminator requires upgrade",
        ),
        bad::<UnindexedMarkdownPayloadV1>(
            dir,
            "payload-unknown-profile",
            raw(Cbor::Array(profile)),
            "unknown envelope profile requires upgrade",
        ),
        bad::<UnindexedMarkdownPayloadV1>(
            dir,
            "payload-ordinary-kind",
            raw(Cbor::Array(ordinary)),
            "Ordinary0 never uses the envelope; unknown kinds require upgrade",
        ),
        bad::<UnindexedMarkdownPayloadV1>(
            dir,
            "payload-extra-element",
            raw(Cbor::Array(extra)),
            "exact tuple arity; no ignored critical elements",
        ),
        bad::<UnindexedMarkdownConflictValueV1>(
            dir,
            "conflict-attachment-tag",
            raw(conflict),
            "conflict value6 only; value5 is the attachment family",
        ),
    ]
}

fn raw(c: Cbor) -> Vec<u8> {
    let mut out = Vec::new();
    raw_into(&c, &mut out);
    out
}

/// Encode without the profile checks, to build invalid fixtures.
fn raw_into(c: &Cbor, out: &mut Vec<u8>) {
    match c {
        Cbor::Map(m) => {
            out.push(0xa0 | u8::try_from(m.len()).expect("small fixture map"));
            for (k, v) in m {
                raw_into(k, out);
                raw_into(v, out);
            }
        }
        Cbor::Array(a) => {
            out.push(0x80 | u8::try_from(a.len()).expect("small fixture array"));
            for x in a {
                raw_into(x, out);
            }
        }
        other => out.extend(crate::cbor::encode(other).expect("scalar")),
    }
}

fn with_key(v: &impl Wire, key: u64, value: Option<Cbor>) -> Vec<u8> {
    let Cbor::Map(mut m) = v.to_cbor() else {
        panic!("struct expected")
    };
    m.retain(|(k, _)| *k != Cbor::Uint(key));
    if let Some(val) = value {
        m.push((Cbor::Uint(key), val));
        m.sort_by_key(|(k, _)| if let Cbor::Uint(n) = k { *n } else { 0 });
    }
    crate::cbor::encode(&Cbor::Map(m)).expect("canonical")
}

/// Every negative fixture: one per profile rule, and the schema rules.
pub fn negative() -> Vec<BadFixture> {
    let m = mutation(vec![update_op()]);
    let entry_ok = EntryPayload {
        resurrect: None,
        sem: Version { major: 1, minor: 0 },
        mutation: m.clone(),
        status: Status::Applied,
        effects: vec![],
        conflicts: None,
        aliases: None,
        texts: None,
    };
    let mut v = vec![
        // profile rules (00-overview.md §3.2), checked on a value
        bad::<Value>(
            "cbor",
            "indefinite-array",
            vec![0x9f, 0x01, 0xff],
            "rule 1: indefinite length",
        ),
        bad::<Value>(
            "cbor",
            "non-shortest-int",
            vec![0x18, 0x05],
            "rule 2: integer not in shortest form",
        ),
        bad::<Value>(
            "cbor",
            "non-shortest-length",
            vec![0x78, 0x01, 0x61],
            "rule 2: length not in shortest form",
        ),
        bad::<Value>(
            "cbor",
            "bignum-tag",
            vec![0xc2, 0x41, 0x01],
            "rules 3 and 8: bignum tag",
        ),
        bad::<Value>(
            "cbor",
            "half-float",
            vec![0xf9, 0x3c, 0x00],
            "rule 4: float not binary64",
        ),
        bad::<Value>(
            "cbor",
            "nan",
            vec![0xfb, 0x7f, 0xf8, 0, 0, 0, 0, 0, 0],
            "rule 4: NaN",
        ),
        bad::<Value>("cbor", "undefined", vec![0xf7], "rule 5: undefined"),
        bad::<Value>(
            "cbor",
            "invalid-utf8",
            vec![0x62, 0xc3, 0x28],
            "rule 7: invalid UTF-8",
        ),
        bad::<Value>(
            "cbor",
            "duplicate-data-key",
            raw(Cbor::Map(vec![
                (Cbor::Text("a".into()), Cbor::Null),
                (Cbor::Text("a".into()), Cbor::Null),
            ])),
            "rule 6: duplicate data map key",
        ),
        bad::<Value>(
            "cbor",
            "mixed-map-keys",
            raw(Cbor::Map(vec![
                (Cbor::Text("a".into()), Cbor::Null),
                (Cbor::Uint(1), Cbor::Null),
            ])),
            "rule 6: mixed key types",
        ),
        bad::<Value>(
            "cbor",
            "trailing-bytes",
            vec![0x01, 0x02],
            "rule 9: trailing bytes",
        ),
        bad::<OpClock>(
            "cbor",
            "unsorted-struct-keys",
            raw(Cbor::Map(vec![
                (Cbor::Uint(1), Cbor::Text("UTC".into())),
                (Cbor::Uint(0), Cbor::Uint(0)),
            ])),
            "rule 6: struct keys not ascending",
        ),
        // value model
        bad::<Value>(
            "value",
            "bytes-not-a-value",
            vec![0x41, 0x00],
            "byte strings are not frontmatter values",
        ),
        bad::<Value>(
            "value",
            "int-beyond-int64",
            vec![0x1b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
            "integers must fit int64",
        ),
        // schema rules
        bad::<Mutation>(
            "mutation",
            "missing-required-ops",
            with_key(&m, 6, None),
            "a required key is absent",
        ),
        bad::<Mutation>(
            "mutation",
            "empty-ops",
            with_key(&m, 6, Some(Cbor::Array(vec![]))),
            "a [+ op] list must not be empty",
        ),
        bad::<Mutation>(
            "mutation",
            "unknown-op-kind",
            with_key(
                &m,
                6,
                Some(Cbor::Array(vec![Cbor::Map(vec![(
                    Cbor::Uint(0),
                    Cbor::Uint(99),
                )])])),
            ),
            "unknown variants are critical",
        ),
        bad::<Mutation>(
            "mutation",
            "unknown-source",
            with_key(&m, 5, Some(Cbor::Uint(7))),
            "unknown enum values are critical",
        ),
        bad::<Mutation>(
            "mutation",
            "short-uuid",
            with_key(&m, 0, Some(Cbor::Bytes(vec![1, 2, 3]))),
            "UUIDs are 16 bytes",
        ),
        bad::<Mutation>(
            "mutation",
            "wrong-type",
            with_key(&m, 2, Some(Cbor::Text("41".into()))),
            "base_seq must be a uint",
        ),
        bad::<EntryPayload>(
            "entry",
            "unknown-fmt",
            with_key(&entry_ok, 0, Some(Cbor::Uint(2))),
            "an unknown fmt is critical (stall)",
        ),
        bad::<EntryPayload>(
            "entry",
            "unknown-effect",
            with_key(
                &entry_ok,
                4,
                Some(Cbor::Array(vec![Cbor::Map(vec![(
                    Cbor::Uint(0),
                    Cbor::Uint(64),
                )])])),
            ),
            "unknown effect kinds are critical",
        ),
        bad::<Item>(
            "item",
            "unknown-kind",
            with_key(
                &item(ItemKind::Chunk, None, vec![1]),
                1,
                Some(Cbor::Uint(99)),
            ),
            "unknown item kinds stall",
        ),
        bad::<ManifestPayload>(
            "manifest",
            "missing-control-chain",
            with_key(&manifest_min(), 11, None),
            "control_chain (key 11) is required (snapshot.md §8.1, SEC-006)",
        ),
        bad::<GrantApprovalPayload>(
            "grant-approval",
            "no-capabilities",
            with_key(&approval_min(), 3, Some(Cbor::Array(vec![]))),
            "capabilities must be non-empty",
        ),
        bad::<HeadWitness>(
            "head-witness",
            "unsigned",
            with_key(&witness_min(), 7, None),
            "the signature (key 7) is required",
        ),
    ];
    v.extend(attachment_negatives());
    v.extend(unindexed_markdown_negatives());
    v.extend(attachment_runtime_v1::negative());
    v.extend(extended_runtime_v1::negative());
    v
}

fn manifest_min() -> ManifestPayload {
    ManifestPayload {
        seq: 0,
        chain: CHAIN_ZERO,
        state_digest: b32(0xd0),
        bucket_bits: 0,
        sections: vec![Section {
            kind: SectionKind::Index,
            chunks: vec![],
        }],
        horizon: Horizon {
            seq_floor: 0,
            time_floor: 0,
        },
        sem: Version { major: 1, minor: 0 },
        record_count: 0,
        file_count: 0,
        previous: None,
        control_chain: b32(0x07),
    }
}

fn approval_min() -> GrantApprovalPayload {
    GrantApprovalPayload {
        grant: b16(GRANT),
        client_pk: b32(0x0c),
        capabilities: vec!["collection.read".into()],
        file_folders: None,
    }
}

fn witness_min() -> HeadWitness {
    HeadWitness {
        collection: b16(COLLECTION),
        device: b16(DEVICE),
        seq: 1,
        chain: b32(0xc4),
        epoch: 1,
        signed_at: 0,
        sig: B64([0x54; 64]),
        policy_generation: None,
        catalog_generation: None,
    }
}

/// Struct maps whose unknown keys must be ignored: `(format, name, bytes, decode)`.
/// The bytes are canonical; the typed decode succeeds and re-encodes without the
/// unknown key.
pub fn unknown_key_cases() -> Vec<(&'static str, Vec<u8>, Roundtrip)> {
    let m = mutation(vec![update_op()]);
    vec![(
        "mutation-with-key-99",
        with_key(&m, 99, Some(Cbor::Text("from a newer writer".into()))),
        rt::<Mutation>,
    )]
}
