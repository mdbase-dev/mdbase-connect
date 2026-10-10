//! The `base` payload's optional pre-history field (snapshot.md §7, key 6): absent
//! encodes exactly as before, present round-trips, empty is refused.

use mdbn_wire::cbor;
use mdbn_wire::common::{B16, B32};
use mdbn_wire::hash::sha256;
use mdbn_wire::intent::BlobRef;
use mdbn_wire::schema::Wire;
use mdbn_wire::snapshot::{BasePayload, BaseSource, MAX_PREHISTORY_SEGMENTS};

fn base() -> BasePayload {
    BasePayload {
        manifest: B32([0xa2; 32]),
        state_digest: B32([0xd0; 32]),
        adopter: B16([
            0x9b, 0x2f, 0x6c, 0x1e, 0x3a, 0x47, 0x4d, 0x5b, 0x8e, 0x21, 0x6f, 0x0a, 0x9c, 0x3d,
            0x7e, 0x54,
        ]),
        source: BaseSource::Folder,
        legacy_collection: None,
        prehistory: None,
    }
}

fn segment(i: u8) -> BlobRef {
    BlobRef {
        plain_hash: sha256(&[i]),
        size: 1 + u64::from(i) * 1024,
        blob_id: B32([0xc0 + i; 32]),
        id_epoch: 1,
        part_size: 8 * 1024 * 1024,
    }
}

/// `conformance/wire/base/folder.cbor` as it was before key 6 existed (the golden
/// test pins the file itself; this pins the bytes a base without field 6 produces).
const FOLDER_GOLDEN: &str = concat!(
    "a500010158",
    "20",
    "a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2",
    "025820",
    "d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0",
    "0350",
    "9b2f6c1e3a474d5b8e216f0a9c3d7e54",
    "0400",
);

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[test]
fn absent_prehistory_encodes_as_before() {
    let bytes = base().to_bytes().unwrap();
    assert_eq!(hex(&bytes), FOLDER_GOLDEN);
    if let cbor::Cbor::Map(m) = cbor::decode(&bytes).unwrap() {
        assert!(!m.iter().any(|(k, _)| *k == cbor::Cbor::Uint(6)));
    } else {
        panic!("not a map");
    }
    assert_eq!(BasePayload::from_bytes(&bytes).unwrap(), base());
}

#[test]
fn prehistory_round_trips() {
    let p = BasePayload {
        source: BaseSource::HostedImport,
        legacy_collection: Some(B16([0x4c; 16])),
        prehistory: Some(vec![segment(0), segment(1)]),
        ..base()
    };
    let bytes = p.to_bytes().unwrap();
    assert_eq!(BasePayload::from_bytes(&bytes).unwrap(), p);
    // Key 6 is the last key and holds a two-element array.
    if let cbor::Cbor::Map(m) = cbor::decode(&bytes).unwrap() {
        let (k, v) = m.last().unwrap();
        assert_eq!(*k, cbor::Cbor::Uint(6));
        assert!(matches!(v, cbor::Cbor::Array(a) if a.len() == 2));
    } else {
        panic!("not a map");
    }
}

#[test]
fn empty_prehistory_is_refused() {
    let p = BasePayload {
        prehistory: Some(vec![]),
        ..base()
    };
    let bytes = p.to_bytes().unwrap();
    assert!(BasePayload::from_bytes(&bytes).is_err(), "[1*64 blob-ref]");
}

#[test]
fn bound_is_sixty_four() {
    assert_eq!(MAX_PREHISTORY_SEGMENTS, 64);
}
