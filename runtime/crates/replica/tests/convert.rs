//! Wire ↔ core conversions round-trip.

use mdbn_core::plan::{ConflictKind, ConflictValue, Effect as CoreEffect, RecordedConflict};
use mdbn_replica::convert::{self, ConvertError};
use mdbn_wire::attachment::{
    AttachmentConflictValueV1, AttachmentContentV1, AttachmentFileRowV1, AttachmentRefV1,
    AttachmentTombstoneRowV1, FileContent, PutAttachmentFile,
};
use mdbn_wire::common::{B16, B32, DataMap, Text, Value};
use mdbn_wire::entry::{Effect, PutRecord, PutSettings};
use mdbn_wire::intent::{BlobRef, FileInclusion, MediaClass};
use mdbn_wire::unindexed_markdown::{
    PutUnindexedMarkdown, ReindexUnindexedMarkdown, UnindexedMarkdownConflictValueV1,
    UnindexedMarkdownEffectV1, UnindexedMarkdownPayloadV1,
};

#[test]
fn values_round_trip_with_order() {
    let v = Value::Map(vec![
        ("z".into(), Value::Int(1)),
        ("a".into(), Value::Float(1.0)),
        (
            "l".into(),
            Value::List(vec![
                Value::Null,
                Value::Bool(true),
                Value::Text("x".into()),
            ]),
        ),
    ]);
    assert_eq!(convert::wvalue(&convert::value(&v).unwrap()), v);
    let m = DataMap(vec![
        ("b".into(), Value::Int(2)),
        ("a".into(), Value::Int(1)),
    ]);
    assert_eq!(convert::wmap(&convert::map(&m).unwrap()), m);
}

#[test]
fn effects_round_trip() {
    let effects = vec![
        Effect::PutRecord(PutRecord {
            id: B16([1; 16]),
            path: "a.md".into(),
            doc: Text::Inline("---\na: 1\n---\nx".into()),
        }),
        Effect::PutSettings(PutSettings {
            inclusion: FileInclusion {
                include: vec![MediaClass::Pdf],
                exclude: Some(vec!["big".into()]),
                max_size: Some(9),
            },
        }),
    ];
    for e in effects {
        let c = convert::effect(&e, &convert::inline_only).unwrap();
        assert_eq!(convert::weffect(&c).unwrap(), e);
    }
    let _ = B32([0; 32]);
    assert!(convert::inline_only(&Text::Index(0)).is_err());
}

fn attachment() -> AttachmentContentV1 {
    AttachmentContentV1 {
        reference: AttachmentRefV1 {
            collection: B16([11; 16]),
            key_epoch: 24,
            attachment_id: B32([12; 32]),
            manifest_cipher_hash: B32([13; 32]),
        },
        whole_plain_hash: B32([14; 32]),
        total_plain_bytes: 500 << 20,
    }
}

fn blob() -> BlobRef {
    BlobRef {
        plain_hash: B32([14; 32]),
        size: 500 << 20,
        blob_id: B32([21; 32]),
        id_epoch: 2,
        part_size: 1 << 20,
    }
}

#[test]
fn attachment_content_round_trips_whole_descriptor() {
    let a = attachment();
    let core = convert::attachment_content(&a);
    assert_eq!(core.reference.key_epoch, 24);
    assert_eq!(core.reference.attachment_id, [12; 32]);
    assert_eq!(core.total_plain_bytes, 500 << 20);
    assert_eq!(convert::wattachment_content(&core), a);
    // Same plaintext, different context: distinct content, still exact.
    let mut rekeyed = a.clone();
    rekeyed.reference.key_epoch += 1;
    rekeyed.reference.manifest_cipher_hash = B32([16; 32]);
    let rekeyed_core = convert::attachment_content(&rekeyed);
    assert_eq!(rekeyed_core.whole_plain_hash, core.whole_plain_hash);
    assert_ne!(rekeyed_core, core);
    assert_eq!(convert::wattachment_content(&rekeyed_core), rekeyed);
}

#[test]
fn file_content_keeps_each_arm_without_blob_substitution() {
    let a = FileContent::AttachmentV1(attachment());
    let b = FileContent::Blob(blob());
    assert_eq!(a.plain_hash(), b.plain_hash());
    let ca = convert::file_content(&a).unwrap();
    let cb = convert::file_content(&b).unwrap();
    assert!(matches!(
        ca,
        mdbn_core::intent::FileContent::AttachmentV1(_)
    ));
    assert!(matches!(cb, mdbn_core::intent::FileContent::Blob(_)));
    assert_ne!(ca, cb);
    assert_eq!(convert::wfile_content(&ca), a);
    assert_eq!(convert::wfile_content(&cb), b);
}

#[test]
fn legacy_effect_codec_refuses_attachment_and_explicit_codec_round_trips() {
    let put = PutAttachmentFile {
        id: B16([19; 16]),
        path: "large.bin".into(),
        content: attachment(),
    };
    let core = convert::attachment_effect(&put);
    let CoreEffect::PutAttachmentFile { id, path, content } = &core else {
        panic!("typed attachment effect");
    };
    assert_eq!(*id, convert::uuid(&put.id));
    assert_eq!(path, "large.bin");
    assert_eq!(convert::wattachment_content(content), put.content);
    assert_eq!(convert::wattachment_effect(&core), Some(put.clone()));
    assert_eq!(
        convert::weffect(&core),
        Err(ConvertError::AttachmentUnsupported)
    );
    // A mixed batch is refused as a whole: no partial legacy encoding.
    let batch = [
        CoreEffect::PutRecord {
            id: convert::uuid(&B16([17; 16])),
            path: "a.md".into(),
            doc: "legacy".into(),
        },
        core,
    ];
    assert_eq!(
        batch
            .iter()
            .map(convert::weffect)
            .collect::<Result<Vec<_>, _>>(),
        Err(ConvertError::AttachmentUnsupported)
    );
    assert_eq!(convert::wattachment_effect(&batch[0]), None);
}

#[test]
fn legacy_conflict_codec_refuses_attachment_side_and_explicit_codec_round_trips() {
    let value = AttachmentConflictValueV1 {
        content: attachment(),
    };
    let core = convert::attachment_conflict_value(&value);
    assert!(matches!(core, ConflictValue::Attachment(_)));
    assert_eq!(convert::wattachment_conflict_value(&core), Some(value));
    assert_eq!(
        convert::wattachment_conflict_value(&ConflictValue::Deleted),
        None
    );
    let conflict = |kept: ConflictValue, lost: ConflictValue| RecordedConflict {
        kind: ConflictKind::File,
        id: convert::uuid(&B16([18; 16])),
        field: None,
        base: None,
        kept,
        lost,
    };
    let blob_side = ConflictValue::Blob(convert::blob(&blob()));
    assert!(convert::wconflict(&conflict(blob_side.clone(), ConflictValue::Deleted)).is_ok());
    assert_eq!(
        convert::wconflict(&conflict(blob_side.clone(), core.clone())),
        Err(ConvertError::AttachmentUnsupported)
    );
    assert_eq!(
        convert::wconflict(&conflict(core, blob_side)),
        Err(ConvertError::AttachmentUnsupported)
    );
}

#[test]
fn attachment_rows_become_typed_state() {
    let file = convert::attachment_file_row(&AttachmentFileRowV1 {
        id: B16([20; 16]),
        path: "img/big.png".into(),
        content: attachment(),
        media: MediaClass::Image,
    });
    assert_eq!(file.id, convert::uuid(&B16([20; 16])));
    assert_eq!(file.path, "img/big.png");
    assert_eq!(
        file.content,
        mdbn_core::intent::FileContent::AttachmentV1(convert::attachment_content(&attachment()))
    );
    let tomb = convert::attachment_tombstone_row(&AttachmentTombstoneRowV1 {
        id: B16([20; 16]),
        path: "img/big.png".into(),
        content: attachment(),
        seq: 9,
        time: 1,
    });
    assert_eq!(
        tomb,
        mdbn_core::state::Tombstone::File {
            path: "img/big.png".into(),
            content: file.content,
            kind: mdbn_core::intent::FileKind::Ordinary,
        }
    );
}

fn unindexed_payload(content: FileContent) -> UnindexedMarkdownPayloadV1 {
    UnindexedMarkdownPayloadV1 { content }
}

#[test]
fn legacy_effect_codec_refuses_unindexed_markdown_and_explicit_codec_round_trips() {
    // Each content arm of the payload envelope stays its own arm through core.
    for content in [
        FileContent::AttachmentV1(attachment()),
        FileContent::Blob(blob()),
    ] {
        let put = UnindexedMarkdownEffectV1::PutUnindexedMarkdown(PutUnindexedMarkdown {
            id: B16([21; 16]),
            path: "notes/huge.md".into(),
            payload: unindexed_payload(content.clone()),
        });
        let core = convert::unindexed_markdown_effect(&put).unwrap();
        let CoreEffect::PutUnindexedMarkdown {
            id,
            path,
            content: core_content,
        } = &core
        else {
            panic!("typed unindexed markdown put effect");
        };
        assert_eq!(*id, convert::uuid(&B16([21; 16])));
        assert_eq!(path, "notes/huge.md");
        assert_eq!(convert::wfile_content(core_content), content);
        assert_eq!(convert::wunindexed_markdown_effect(&core), Some(put));
        assert_eq!(
            convert::weffect(&core),
            Err(ConvertError::UnindexedMarkdownUnsupported)
        );
        assert_eq!(convert::wattachment_effect(&core), None);
    }

    let reindex = UnindexedMarkdownEffectV1::ReindexUnindexedMarkdown(ReindexUnindexedMarkdown {
        id: B16([22; 16]),
        path: "notes/huge.md".into(),
        doc: "---\ntitle: back\n---\nsmall again".into(),
    });
    let core = convert::unindexed_markdown_effect(&reindex).unwrap();
    let CoreEffect::ReindexUnindexedMarkdown { id, path, doc } = &core else {
        panic!("typed reindex effect");
    };
    assert_eq!(*id, convert::uuid(&B16([22; 16])));
    assert_eq!(path, "notes/huge.md");
    assert_eq!(doc, "---\ntitle: back\n---\nsmall again");
    assert_eq!(convert::wunindexed_markdown_effect(&core), Some(reindex));
    assert_eq!(
        convert::weffect(&core),
        Err(ConvertError::UnindexedMarkdownUnsupported)
    );

    // A mixed batch is refused as a whole: no partial legacy encoding.
    let batch = [
        CoreEffect::PutRecord {
            id: convert::uuid(&B16([17; 16])),
            path: "a.md".into(),
            doc: "legacy".into(),
        },
        core,
    ];
    assert_eq!(
        batch
            .iter()
            .map(convert::weffect)
            .collect::<Result<Vec<_>, _>>(),
        Err(ConvertError::UnindexedMarkdownUnsupported)
    );
    assert_eq!(convert::wunindexed_markdown_effect(&batch[0]), None);
}

#[test]
fn legacy_conflict_codec_refuses_unindexed_markdown_side_and_explicit_codec_round_trips() {
    let value = UnindexedMarkdownConflictValueV1 {
        payload: unindexed_payload(FileContent::AttachmentV1(attachment())),
    };
    let core = convert::unindexed_markdown_conflict_value(&value).unwrap();
    assert!(matches!(core, ConflictValue::UnindexedMarkdown(_)));
    assert_eq!(
        convert::wunindexed_markdown_conflict_value(&core),
        Some(value)
    );
    assert_eq!(
        convert::wunindexed_markdown_conflict_value(&ConflictValue::Deleted),
        None
    );
    assert_eq!(convert::wattachment_conflict_value(&core), None);
    let conflict = |kept: ConflictValue, lost: ConflictValue| RecordedConflict {
        kind: ConflictKind::File,
        id: convert::uuid(&B16([23; 16])),
        field: None,
        base: None,
        kept,
        lost,
    };
    let blob_side = ConflictValue::Blob(convert::blob(&blob()));
    assert_eq!(
        convert::wconflict(&conflict(blob_side.clone(), core.clone())),
        Err(ConvertError::UnindexedMarkdownUnsupported)
    );
    assert_eq!(
        convert::wconflict(&conflict(core, blob_side)),
        Err(ConvertError::UnindexedMarkdownUnsupported)
    );
}

#[test]
fn attachment_rows_are_ordinary_kind() {
    let file = convert::attachment_file_row(&AttachmentFileRowV1 {
        id: B16([24; 16]),
        path: "img/big.png".into(),
        content: attachment(),
        media: MediaClass::Image,
    });
    assert_eq!(file.kind, mdbn_core::intent::FileKind::Ordinary);
    let tomb = convert::attachment_tombstone_row(&AttachmentTombstoneRowV1 {
        id: B16([24; 16]),
        path: "img/big.png".into(),
        content: attachment(),
        seq: 9,
        time: 1,
    });
    assert!(matches!(
        tomb,
        mdbn_core::state::Tombstone::File {
            kind: mdbn_core::intent::FileKind::Ordinary,
            ..
        }
    ));
}
