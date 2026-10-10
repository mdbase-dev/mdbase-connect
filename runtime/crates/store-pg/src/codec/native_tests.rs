use super::*;
use mdbn_wire::{
    attachment::{AttachmentContentV1, AttachmentRefV1, FileContent},
    intent::BlobRef,
    unindexed_markdown::{FileKindV1, UnindexedMarkdownPayloadV1},
};
fn blob() -> BlobRef {
    BlobRef {
        plain_hash: B32([1; 32]),
        size: 1048577,
        blob_id: B32([2; 32]),
        id_epoch: 1,
        part_size: 8388608,
    }
}
#[test]
fn ordinary_blob_bytes_are_exact_and_native_blob_retains_kind() {
    let b = blob();
    let c = FileContent::Blob(b.clone());
    let ordinary = file_payload_bytes(FileKindV1::Ordinary, &c).unwrap();
    assert_eq!(ordinary, bytes(&b).unwrap());
    assert_eq!(
        file_payload_from(&ordinary).unwrap(),
        (FileKindV1::Ordinary, c.clone())
    );
    let native = file_payload_bytes(FileKindV1::UnindexedOversizedMarkdown, &c).unwrap();
    assert_ne!(native, ordinary);
    assert_eq!(
        file_payload_from(&native).unwrap(),
        (FileKindV1::UnindexedOversizedMarkdown, c.clone())
    );
    assert!(from_bytes::<BlobRef>(&native, "old blob decoder").is_err());
    let p = UnindexedMarkdownPayloadV1 { content: c };
    let t = TombstoneLast::UnindexedMarkdown(p);
    assert_eq!(last_from(&last_bytes(&t).unwrap()).unwrap(), t);
}
#[test]
fn native_attachment_closed_descriptor_roundtrip_without_ordinary_activation() {
    let c = FileContent::AttachmentV1(AttachmentContentV1 {
        reference: AttachmentRefV1 {
            collection: B16([3; 16]),
            key_epoch: 1,
            attachment_id: B32([4; 32]),
            manifest_cipher_hash: B32([5; 32]),
        },
        whole_plain_hash: B32([6; 32]),
        total_plain_bytes: 1048577,
    });
    assert!(file_payload_bytes(FileKindV1::Ordinary, &c).is_err());
    let b = file_payload_bytes(FileKindV1::UnindexedOversizedMarkdown, &c).unwrap();
    assert_eq!(
        file_payload_from(&b).unwrap(),
        (FileKindV1::UnindexedOversizedMarkdown, c.clone())
    );
    let t = TombstoneLast::UnindexedMarkdown(UnindexedMarkdownPayloadV1 { content: c });
    assert_eq!(last_from(&last_bytes(&t).unwrap()).unwrap(), t);
}
#[test]
fn small_and_future_native_boxes_fail_closed_without_downgrade() {
    let mut b = blob();
    b.size = 1048576;
    assert!(
        file_payload_bytes(
            FileKindV1::UnindexedOversizedMarkdown,
            &FileContent::Blob(b)
        )
        .is_err()
    );
    let p = UnindexedMarkdownPayloadV1 {
        content: FileContent::Blob(blob()),
    };
    let Cbor::Array(fields) = p.to_cbor() else {
        panic!()
    };
    for slot in 0..3 {
        let mut f = fields.clone();
        f[slot] = Cbor::Uint(77);
        assert!(file_payload_from(&enc(Cbor::Array(f), "future").unwrap()).is_err());
    }
    let mut f = fields;
    f.pop();
    assert!(file_payload_from(&enc(Cbor::Array(f), "short").unwrap()).is_err());
    assert!(
        last_from(&enc(Cbor::Array(vec![Cbor::Uint(3), Cbor::Null]), "bad tomb").unwrap()).is_err()
    );
}
