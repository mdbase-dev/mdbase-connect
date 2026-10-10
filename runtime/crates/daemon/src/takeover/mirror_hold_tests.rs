use super::super::mirror_evidence::{FileKind, UnknownOutcome};
use super::*;
use mdbn_takeover::mirror_join::Decision;
use mdbn_wire::{
    attachment::{AttachmentContentV1, AttachmentRefV1, FileContent},
    common::{B16, B32},
};
use serde_json::json;

fn file(n: u8, kind: FileKind) -> Descriptor {
    Descriptor::file(
        kind,
        &FileContent::AttachmentV1(AttachmentContentV1 {
            reference: AttachmentRefV1 {
                collection: B16([1; 16]),
                key_epoch: u64::from(n) + 3,
                attachment_id: B32([n + 10; 32]),
                manifest_cipher_hash: B32([n + 20; 32]),
            },
            whole_plain_hash: B32([n; 32]),
            total_plain_bytes: 1_100_000 + u64::from(n),
        }),
    )
    .unwrap()
}
fn capture(kind: FileKind) -> Evidence {
    Evidence {
        schema_version: 1,
        collection: [1; 16],
        legacy_collection: [1; 16],
        legacy_replica: [2; 16],
        resource_id: Some([3; 16]),
        s_final: 10,
        cutover_seq: 2,
        barrier_f: 4,
        final_digest: [8; 32],
        verified_seq: 5,
        verified_chain: [9; 32],
        checkpoint: Checkpoint::Present {
            hash: [1; 32],
            cursor: 7,
        },
        old_path: "old-secret.bin".into(),
        resolved_path: "resolved-secret.bin".into(),
        server: Some(file(2, kind)),
        observed: Some([3; 32]),
        source_generation: 29,
        read_write: true,
        unknown_outcomes: vec![],
    }
}
fn base(kind: FileKind) -> BaseContent {
    BaseContent::Present {
        descriptor: file(1, kind),
    }
}

#[test]
fn complete_binary_three_sides_and_semantic_kinds_survive_roundtrip_without_downcast() {
    for kind in [FileKind::Ordinary, FileKind::UnindexedOversizedMarkdown] {
        let e = capture(kind);
        assert_eq!(e.decision().unwrap(), Decision::Conflict);
        let context = Context::build(&e, base(kind), Some(file(3, kind))).unwrap();
        let reopened = Context::decode(&context.encode().unwrap()).unwrap();
        assert_eq!(context, reopened);
        assert_eq!(reopened.capture(), &e);
        assert_eq!(reopened.base(), &base(kind));
        assert_eq!(reopened.lost(), e.server.as_ref());
        assert_eq!(reopened.kept(), Some(&file(3, kind)));
        // Full epoch/address/manifest/size survive, even when plaintext hashes
        // alone could not recover these different descriptors.
        let BaseContent::Present {
            descriptor: Descriptor::File { content, file_kind },
        } = reopened.base()
        else {
            panic!("file base")
        };
        assert_eq!(file_kind, &kind);
        let FileContent::AttachmentV1(decoded) =
            <FileContent as mdbn_wire::schema::Wire>::from_bytes(content).unwrap()
        else {
            panic!("native attachment")
        };
        assert_eq!(decoded.reference.key_epoch, 4);
        assert_eq!(decoded.reference.attachment_id, B32([11; 32]));
        assert_eq!(decoded.reference.manifest_cipher_hash, B32([21; 32]));
        assert_eq!(decoded.total_plain_bytes, 1_100_001);
    }
}

#[test]
fn hash_only_base_local_mismatch_noncanonical_and_foreign_descriptors_are_refused() {
    let kind = FileKind::Ordinary;
    let e = capture(kind);
    assert!(Context::build(&e, BaseContent::Unavailable, Some(file(3, kind))).is_err());
    assert!(Context::build(&e, BaseContent::CertifiedAbsent, Some(file(3, kind))).is_err());
    assert!(
        Context::build(
            &e,
            BaseContent::Present {
                descriptor: file(2, kind)
            },
            Some(file(3, kind))
        )
        .is_err()
    );
    assert!(Context::build(&e, base(kind), None).is_err());
    assert!(Context::build(&e, base(kind), Some(file(4, kind))).is_err());
    let mut wrong = file(3, kind);
    if let Descriptor::File { content, .. } = &mut wrong {
        let mut decoded = <FileContent as mdbn_wire::schema::Wire>::from_bytes(content).unwrap();
        if let FileContent::AttachmentV1(a) = &mut decoded {
            a.reference.collection = B16([4; 16]);
        }
        *content = <FileContent as mdbn_wire::schema::Wire>::to_bytes(&decoded).unwrap();
    }
    assert!(Context::build(&e, base(kind), Some(wrong)).is_err());
    let mut torn = file(3, kind);
    if let Descriptor::File { content, .. } = &mut torn {
        content.push(0);
    }
    assert!(Context::build(&e, base(kind), Some(torn)).is_err());
    let mut bad = e.clone();
    bad.resource_id = None;
    assert!(Context::build(&bad, base(kind), Some(file(3, kind))).is_err());
    bad = e.clone();
    bad.legacy_collection = [5; 16];
    assert!(Context::build(&bad, base(kind), Some(file(3, kind))).is_err());
}

#[test]
fn explicit_absence_unavailable_and_original_unknown_outcomes_remain_distinct() {
    let kind = FileKind::Ordinary;
    let mut e = capture(kind);
    e.checkpoint = Checkpoint::CertifiedAbsent { cursor: 7 };
    let absent = Context::build(&e, BaseContent::CertifiedAbsent, Some(file(3, kind))).unwrap();
    assert_eq!(absent.base(), &BaseContent::CertifiedAbsent);
    assert!(Context::build(&e, BaseContent::Unavailable, Some(file(3, kind))).is_err());
    e.checkpoint = Checkpoint::Unavailable;
    assert!(Context::build(&e, BaseContent::CertifiedAbsent, Some(file(3, kind))).is_err());
    e.unknown_outcomes.push(UnknownOutcome {
        mutation_id: "original-unknown-id".into(),
        record_id: "original-record-id".into(),
        operation: "put".into(),
        path: Some("original-secret.bin".into()),
    });
    let unknown = Context::build(&e, BaseContent::Unavailable, Some(file(3, kind))).unwrap();
    let reopened = Context::decode(&unknown.encode().unwrap()).unwrap();
    assert_eq!(reopened.capture().unknown_outcomes, e.unknown_outcomes);
    assert_eq!(
        reopened.capture().decision().unwrap(),
        Decision::UnknownOutcome
    );
    assert_eq!(reopened.base(), &BaseContent::Unavailable);
    e.observed = None;
    let deleted = Context::build(&e, BaseContent::Unavailable, None).unwrap();
    assert!(deleted.kept().is_none());
    assert_eq!(deleted.lost(), e.server.as_ref());
    e.observed = Some([3; 32]);
    e.server = None;
    let retained = Context::build(&e, BaseContent::Unavailable, Some(file(3, kind))).unwrap();
    assert!(retained.lost().is_none());
    assert_eq!(retained.kept(), Some(&file(3, kind)));
}

#[test]
fn full_record_source_is_retained_and_debug_never_discloses_content_paths_or_ids() {
    let mut e = capture(FileKind::Ordinary);
    let descriptor = |source: &str| Descriptor::Record {
        source: source.into(),
    };
    let b = descriptor("base secret\nformatting:  exact\n");
    let l = descriptor("kept secret\nchanged bytes\n");
    e.checkpoint = Checkpoint::Present {
        hash: b.hash(e.collection).unwrap(),
        cursor: 7,
    };
    e.server = Some(descriptor("lost secret\nserver changed\n"));
    e.observed = Some(l.hash(e.collection).unwrap());
    let context = Context::build(
        &e,
        BaseContent::Present {
            descriptor: b.clone(),
        },
        Some(l.clone()),
    )
    .unwrap();
    let reopened = Context::decode(&context.encode().unwrap()).unwrap();
    assert_eq!(reopened.base(), &BaseContent::Present { descriptor: b });
    assert_eq!(reopened.kept(), Some(&l));
    assert_eq!(reopened.lost(), e.server.as_ref());
    let debug = format!("{context:?}");
    for secret in [
        "base secret",
        "kept secret",
        "lost secret",
        "old-secret",
        "resolved-secret",
    ] {
        assert!(!debug.contains(secret));
    }
}

#[test]
fn persisted_draft_refuses_future_torn_extra_duplicate_missing_and_changed_context() {
    let kind = FileKind::Ordinary;
    let context = Context::build(&capture(kind), base(kind), Some(file(3, kind))).unwrap();
    let bytes = context.encode().unwrap();
    assert!(Context::decode(&bytes[..bytes.len() - 1]).is_err());
    assert!(Context::decode(&vec![b' '; MAX_BYTES + 1]).is_err());
    let good: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    for (key, value) in [
        ("schema_version", json!(2)),
        ("future", json!(true)),
        ("kept", json!(null)),
    ] {
        let mut bad = good.clone();
        bad[key] = value;
        assert!(Context::decode(&serde_json::to_vec(&bad).unwrap()).is_err());
    }
    for field in ["schema_version", "capture", "base", "kept"] {
        let mut missing = good.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(Context::decode(&serde_json::to_vec(&missing).unwrap()).is_err());
        let duplicate = format!("{{\"{field}\":{},{}", good[field], &good.to_string()[1..]);
        assert!(Context::decode(duplicate.as_bytes()).is_err());
    }
    let mut bad = good.clone();
    bad["capture"]["observed"] = json!([4; 32].to_vec());
    assert!(Context::decode(&serde_json::to_vec(&bad).unwrap()).is_err());
    let mut bad = good.clone();
    bad["base"]["descriptor"]["content"] = json!([]);
    assert!(Context::decode(&serde_json::to_vec(&bad).unwrap()).is_err());
}
