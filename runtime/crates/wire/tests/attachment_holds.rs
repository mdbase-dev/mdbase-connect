//! Critical client hold arm only; never a snapshot text-source permission.
use mdbn_wire::{
    Cbor, Wire,
    attachment::*,
    attachment_runtime_v1 as rt,
    client::{Hold, HoldReason},
    common::{B16, B32},
    intent::BlobRef,
    schema::{SchemaError, type_err},
    snapshot::{self, TextOrBlob},
};

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
fn hold() -> Hold {
    let c = TextOrBlob::Attachment(content());
    Hold {
        id: B16([9; 16]),
        path: "files/held.bin".into(),
        reason: HoldReason::Conflict,
        since: 42,
        base: Some(c.clone()),
        mine: c.clone(),
        theirs: Some(c),
        saves: 1,
    }
}
fn set(c: &Cbor, key: u64, value: Cbor) -> Cbor {
    let Cbor::Map(m) = c else { panic!("map") };
    let mut m = m.clone();
    m.retain(|(k, _)| *k != Cbor::Uint(key));
    m.push((Cbor::Uint(key), value));
    Cbor::Map(m)
}

// The actual previous text/blob decoder and whole parent shape, not an
// attachment-to-BlobRef fallback. This reader must reject every new side.
#[derive(Debug, Clone, PartialEq)]
/// The text/blob-only union before critical attachment holds.
pub enum OldText {
    /// Inline text.
    Text(String),
    /// Genuine legacy blob descriptor.
    Blob(BlobRef),
}
impl Wire for OldText {
    fn to_cbor(&self) -> Cbor {
        match self {
            Self::Text(s) => s.to_cbor(),
            Self::Blob(b) => b.to_cbor(),
        }
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        match c {
            Cbor::Text(s) => Ok(Self::Text(s.clone())),
            Cbor::Map(_) => Ok(Self::Blob(BlobRef::from_cbor(c)?)),
            _ => Err(type_err("snapshot-text", "text or blob-ref", c)),
        }
    }
}
mdbn_wire::wire_struct! {
    /// The previous complete hold parent schema.
    pub struct OldHold {
        /// Entity.
        0 req id: B16,
        /// Held path.
        1 req path: String,
        /// Cause.
        2 req reason: HoldReason,
        /// First hold time.
        3 req since: i64,
        /// Complete prior source.
        4 opt base: OldText,
        /// Held user source.
        5 req mine: OldText,
        /// Current confirmed source.
        6 opt theirs: OldText,
        /// Collected saves.
        7 req saves: u64,
    }
}

#[test]
fn full_attachment_hold_roundtrip_and_native_sdk_fixture() {
    let h = hold();
    let bytes = h.to_bytes().unwrap();
    assert_eq!(Hold::from_bytes(&bytes).unwrap(), h);
    assert!(
        OldHold::from_bytes(&bytes).is_err(),
        "critical whole-parent refusal"
    );
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, include_str!("fixtures/attachment-hold.hex").trim());
    println!("native_attachment_hold_fixture={hex}");
}

#[test]
fn legacy_hold_bytes_unchanged_and_each_critical_side_fails_whole_parent() {
    for f in mdbn_wire::fixtures::all()
        .into_iter()
        .filter(|f| f.format == "client" && f.name.starts_with("hold"))
    {
        let h = Hold::from_bytes(&f.bytes).unwrap();
        assert_eq!(h.to_bytes().unwrap(), f.bytes);
        assert!(OldHold::from_bytes(&f.bytes).is_ok());
    }
    let mut old = hold();
    old.base = None;
    old.mine = TextOrBlob::Text("mine".into());
    old.theirs = None;
    for key in [4, 5, 6] {
        let valid = set(
            &old.to_cbor(),
            key,
            TextOrBlob::Attachment(content()).to_cbor(),
        );
        assert!(Hold::from_cbor(&valid).is_ok());
        assert!(OldHold::from_cbor(&valid).is_err());
        for bad in [
            Cbor::Array(vec![]),
            Cbor::Array(vec![Cbor::Uint(1)]),
            Cbor::Array(vec![Cbor::Uint(2), content().to_cbor()]),
            Cbor::Array(vec![Cbor::Uint(1), content().to_cbor(), Cbor::Null]),
            Cbor::Array(vec![Cbor::Uint(1), Cbor::Map(vec![])]),
            Cbor::Array(vec![
                Cbor::Uint(1),
                Cbor::Array(vec![
                    Cbor::Uint(99),
                    content().reference.to_cbor(),
                    content().whole_plain_hash.to_cbor(),
                    Cbor::Uint(u64::MAX),
                ]),
            ]),
        ] {
            assert!(
                Hold::from_cbor(&set(&old.to_cbor(), key, bad)).is_err(),
                "bad side {key}"
            );
        }
    }
}

#[test]
fn hold_arm_never_becomes_record_resource_or_legacy_tombstone_snapshot_source() {
    let side = TextOrBlob::Attachment(content());
    let record = snapshot::RecordRow {
        id: B16([9; 16]),
        path: "notes/held.md".into(),
        doc: side.clone(),
    }
    .to_cbor();
    let resource = snapshot::ResourceRow {
        path: ".mdbase/types/item.yaml".into(),
        doc: side.clone(),
    }
    .to_cbor();
    let tomb = snapshot::TombstoneRow {
        id: B16([9; 16]),
        kind: snapshot::EntityKind::File,
        path: "files/held.bin".into(),
        last: side,
        seq: 5,
        time: 42,
    }
    .to_cbor();
    for (section, row) in [
        (snapshot::SectionKind::Records, record),
        (snapshot::SectionKind::Resources, resource),
        (snapshot::SectionKind::Tombstones, tomb),
    ] {
        let chunk = rt::ChunkPayload {
            section: rt::SectionKind::Legacy(section),
            bucket: 0,
            rows: vec![row],
        };
        assert!(rt::ChunkPayload::from_bytes(&chunk.to_bytes().unwrap()).is_err());
    }
}
