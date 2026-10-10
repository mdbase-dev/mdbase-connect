//! Critical codec foundation and actual legacy whole-container rejection.
//! No crypto, emitter, provider, apply/install or custody acceptance.
use mdbn_wire::attachment::*;
use mdbn_wire::common::{B16, B32};
use mdbn_wire::entry::{ConflictValue, Effect, EntryPayload};
use mdbn_wire::intent::{BlobRef, Mutation, Op};
use mdbn_wire::snapshot::{ManifestPayload, Section, SectionKind};
use mdbn_wire::{Cbor, Wire};
fn content() -> AttachmentContentV1 {
    AttachmentContentV1 {
        reference: AttachmentRefV1 {
            collection: B16([1; 16]),
            key_epoch: u64::MAX,
            attachment_id: B32([2; 32]),
            manifest_cipher_hash: B32([3; 32]),
        },
        whole_plain_hash: B32([4; 32]),
        total_plain_bytes: u64::MAX,
    }
}
fn set(c: &Cbor, key: u64, value: Cbor) -> Cbor {
    let Cbor::Map(m) = c else { panic!() };
    let mut m = m.clone();
    m.retain(|(k, _)| *k != Cbor::Uint(key));
    m.push((Cbor::Uint(key), value));
    Cbor::Map(m)
}
fn fixture(format: &str) -> Cbor {
    let f = mdbn_wire::fixtures::all()
        .into_iter()
        .find(|f| f.format == format)
        .unwrap();
    mdbn_wire::cbor::decode(&f.bytes).unwrap()
}
#[test]
fn exact_ref_content_and_explicit_union_preserve_full_unsigned_metadata() {
    let c = content();
    let Cbor::Array(a) = c.reference.to_cbor() else {
        panic!()
    };
    assert_eq!(a.len(), 6);
    assert_eq!(a[0], Cbor::Uint(1));
    assert_eq!(a[4], Cbor::Uint(CHUNK_BYTES_V1));
    assert_eq!(
        AttachmentRefV1::from_bytes(&c.reference.to_bytes().unwrap()).unwrap(),
        c.reference
    );
    let Cbor::Array(a) = c.to_cbor() else {
        panic!()
    };
    assert_eq!(a.len(), 4);
    assert_eq!(a[3], Cbor::Uint(u64::MAX));
    assert_eq!(
        AttachmentContentV1::from_bytes(&c.to_bytes().unwrap()).unwrap(),
        c
    );
    let union = FileContent::AttachmentV1(c.clone());
    assert_eq!(union.to_bytes().unwrap(), c.to_bytes().unwrap());
    assert_eq!(
        FileContent::from_bytes(&union.to_bytes().unwrap()).unwrap(),
        union
    );
    assert_eq!(union.plain_hash(), c.whole_plain_hash);
    assert_eq!(union.size(), u64::MAX);
}
#[test]
fn legacy_content_is_byte_identical_and_never_reinterpreted() {
    let b = BlobRef {
        plain_hash: B32([3; 32]),
        size: 0,
        blob_id: B32([4; 32]),
        id_epoch: 2,
        part_size: 8_388_608,
    };
    let union = FileContent::Blob(b.clone());
    assert_eq!(union.to_bytes().unwrap(), b.to_bytes().unwrap());
    assert_eq!(
        FileContent::from_bytes(&b.to_bytes().unwrap()).unwrap(),
        union
    );
    assert!(AttachmentRefV1::from_cbor(&b.to_cbor()).is_err());
    assert!(BlobRef::from_cbor(&content().reference.to_cbor()).is_err());
    assert!(BlobRef::from_cbor(&content().to_cbor()).is_err());
}
#[test]
fn tuple_versions_profiles_and_arity_fail_closed_without_optional_ignore() {
    let Cbor::Array(a) = content().reference.to_cbor() else {
        panic!()
    };
    for version in [0, 2, u64::MAX] {
        let mut b = a.clone();
        b[0] = Cbor::Uint(version);
        assert!(
            AttachmentRefV1::from_cbor(&Cbor::Array(b))
                .unwrap_err()
                .is_unknown()
        );
    }
    for size in [0, 4_194_304, u64::MAX] {
        let mut b = a.clone();
        b[4] = Cbor::Uint(size);
        assert!(
            AttachmentRefV1::from_cbor(&Cbor::Array(b))
                .unwrap_err()
                .is_unknown()
        );
    }
    for n in 0..a.len() {
        assert!(AttachmentRefV1::from_cbor(&Cbor::Array(a[..n].to_vec())).is_err());
    }
    let mut extra = a.clone();
    extra.push(Cbor::Null);
    assert!(AttachmentRefV1::from_cbor(&Cbor::Array(extra)).is_err());
    for (i, wrong) in [
        (0, Cbor::Nint(0)),
        (1, Cbor::Bytes(vec![0; 15])),
        (2, Cbor::Nint(0)),
        (3, Cbor::Bytes(vec![0; 31])),
        (4, Cbor::Bool(false)),
        (5, Cbor::Bytes(vec![0; 33])),
    ] {
        let mut b = a.clone();
        b[i] = wrong;
        assert!(AttachmentRefV1::from_cbor(&Cbor::Array(b)).is_err());
    }
    let Cbor::Array(a) = content().to_cbor() else {
        panic!()
    };
    let mut unknown = a.clone();
    unknown[0] = Cbor::Uint(2);
    assert!(
        FileContent::from_cbor(&Cbor::Array(unknown))
            .unwrap_err()
            .is_unknown()
    );
    for n in 0..a.len() {
        assert!(AttachmentContentV1::from_cbor(&Cbor::Array(a[..n].to_vec())).is_err());
    }
    let mut extra = a.clone();
    extra.push(Cbor::Null);
    assert!(AttachmentContentV1::from_cbor(&Cbor::Array(extra)).is_err());
    for (i, wrong) in [
        (1, Cbor::Null),
        (2, Cbor::Bytes(vec![0; 31])),
        (3, Cbor::Nint(0)),
    ] {
        let mut b = a.clone();
        b[i] = wrong;
        assert!(AttachmentContentV1::from_cbor(&Cbor::Array(b)).is_err());
    }
}
#[test]
fn standalone_critical_carriers_roundtrip_while_legacy_unions_require_upgrade() {
    let c = content();
    let id = B16([5; 16]);
    let op = AttachmentOpV1::FileAttach(FileAttach {
        id,
        path: "assets/a.bin".into(),
        content: c.clone(),
        if_revision: Some(B32([6; 32])),
        base: None,
    });
    assert_eq!(
        AttachmentOpV1::from_bytes(&op.to_bytes().unwrap()).unwrap(),
        op
    );
    assert!(
        Op::from_bytes(&op.to_bytes().unwrap())
            .unwrap_err()
            .is_unknown()
    );
    let effect = AttachmentEffectV1::PutAttachmentFile(PutAttachmentFile {
        id,
        path: "assets/a.bin".into(),
        content: c.clone(),
    });
    assert_eq!(
        AttachmentEffectV1::from_bytes(&effect.to_bytes().unwrap()).unwrap(),
        effect
    );
    assert!(
        Effect::from_bytes(&effect.to_bytes().unwrap())
            .unwrap_err()
            .is_unknown()
    );
    let conflict = AttachmentConflictValueV1 { content: c };
    assert_eq!(
        AttachmentConflictValueV1::from_bytes(&conflict.to_bytes().unwrap()).unwrap(),
        conflict
    );
    assert!(
        ConflictValue::from_bytes(&conflict.to_bytes().unwrap())
            .unwrap_err()
            .is_unknown()
    );
    for kind in [
        AttachmentSectionKindV1::AttachmentFiles,
        AttachmentSectionKindV1::AttachmentTombstones,
    ] {
        let section = AttachmentSectionV1 {
            kind,
            chunks: vec![],
        };
        assert_eq!(
            AttachmentSectionV1::from_bytes(&section.to_bytes().unwrap()).unwrap(),
            section
        );
        assert!(
            SectionKind::from_cbor(&kind.to_cbor())
                .unwrap_err()
                .is_unknown()
        );
        assert!(
            Section::from_cbor(&section.to_cbor())
                .unwrap_err()
                .is_unknown()
        );
    }
    // A new critical child rejects the entire decoded parent, not a partial prefix.
    let mutation = set(&fixture("mutation"), 6, Cbor::Array(vec![op.to_cbor()]));
    assert!(Mutation::from_cbor(&mutation).unwrap_err().is_unknown());
    let entry = set(&fixture("entry"), 4, Cbor::Array(vec![effect.to_cbor()]));
    assert!(EntryPayload::from_cbor(&entry).unwrap_err().is_unknown());
    let section = AttachmentSectionV1 {
        kind: AttachmentSectionKindV1::AttachmentFiles,
        chunks: vec![],
    };
    let manifest = set(
        &fixture("manifest"),
        5,
        Cbor::Array(vec![section.to_cbor()]),
    );
    assert!(
        ManifestPayload::from_cbor(&manifest)
            .unwrap_err()
            .is_unknown()
    );
}
#[test]
fn snapshot_rows_have_exact_shapes_and_only_file_tombstones() {
    let row = AttachmentFileRowV1 {
        id: B16([5; 16]),
        path: "assets/a.bin".into(),
        content: content(),
        media: mdbn_wire::intent::MediaClass::Other,
    };
    assert_eq!(
        AttachmentFileRowV1::from_bytes(&row.to_bytes().unwrap()).unwrap(),
        row
    );
    let tomb = AttachmentTombstoneRowV1 {
        id: row.id,
        path: row.path,
        content: row.content,
        seq: u64::MAX,
        time: i64::MIN,
    };
    assert_eq!(
        AttachmentTombstoneRowV1::from_bytes(&tomb.to_bytes().unwrap()).unwrap(),
        tomb
    );
    let Cbor::Array(a) = tomb.to_cbor() else {
        panic!()
    };
    assert_eq!(a.len(), 6);
    assert_eq!(a[1], Cbor::Uint(1));
    let mut wrong = a.clone();
    wrong[1] = Cbor::Uint(0);
    assert!(AttachmentTombstoneRowV1::from_cbor(&Cbor::Array(wrong)).is_err());
    for n in 0..a.len() {
        assert!(AttachmentTombstoneRowV1::from_cbor(&Cbor::Array(a[..n].to_vec())).is_err());
    }
    let mut extra = a;
    extra.push(Cbor::Null);
    assert!(AttachmentTombstoneRowV1::from_cbor(&Cbor::Array(extra)).is_err());
}
