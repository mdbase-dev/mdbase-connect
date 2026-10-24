//! Snapshot ref-index objects (`sealed-envelope.md` §4.3, `snapshot.md` §2.1).
//!
//! A snapshot whose complete refs inventory is too large for one log-service
//! request lists those refs in a few `ref-index` objects (kind 19) instead, and
//! names the index objects in its `refs`. The log service reads each index when
//! the snapshot is registered and retains every address it lists (depth exactly
//! one: an index never lists another index).
//!
//! The body is clear, because the service must read it for garbage collection.
//! It reveals exactly what a snapshot's clear `refs` already reveal (§8 of
//! `sealed-envelope.md`). Integrity comes from content addressing: the object's
//! address is `SHA-256` of its bytes, named in the signed manifest. So the
//! object carries no epoch, salt, signer or signature.
//!
//! Addresses are packed in one byte string (32 bytes each, strictly ascending),
//! so an index costs a handful of CBOR values whatever its size and the
//! service's decode budget is unchanged.
//!
//! **Manifest fmt 2.** A manifest whose `refs` name ref-index objects is
//! encoded with `fmt = 2` and lists those objects in the required key 12
//! ([`IndexedManifest`]). Every decoder that predates ref indices checks
//! `fmt = 1` and refuses it as an unknown format: an older replica stalls the
//! install with `UpgradeRequired` and does not endorse, instead of installing a
//! snapshot whose retained set it cannot see. Use [`decode_manifest`] to accept
//! both formats.
use crate::attachment_runtime_v1::ManifestPayload;
use crate::cbor::Cbor;
use crate::common::{B32, Bytes, Hash, Uuid};
use crate::envelope::{Item, ItemKind};
use crate::hash::sha256;
use crate::schema::{Ann, SchemaError, Wire, check_fmt, require, struct_map};
use crate::wire_struct;

/// Addresses one ref-index object may list (256 KiB of addresses: an index
/// object is smaller than an ordinary snapshot chunk and travels inline).
pub const MAX_REF_INDEX_ENTRIES: usize = 8_192;
/// Ref-index objects one snapshot may name, so at most 262,144 indexed refs
/// (about 131,000 small attachments).
pub const MAX_REF_INDICES: usize = 32;
/// The manifest format whose `refs` include ref-index objects.
pub const MANIFEST_FMT_REF_INDEXED: u64 = 2;

const TY: &str = "RefIndex";

wire_struct! {
    /// `ref-index-payload`: the clear body of a `ref-index` object.
    pub struct RefIndexPayload [fmt = 1] {
        /// The listed addresses: 32 bytes each, strictly ascending, 1 to
        /// [`MAX_REF_INDEX_ENTRIES`] of them.
        1 req addresses: Bytes,
    }
}

fn invalid(reason: &'static str) -> SchemaError {
    SchemaError::Invalid { ty: TY, reason }
}

fn check(addresses: &[B32]) -> Result<(), SchemaError> {
    if addresses.is_empty() || addresses.len() > MAX_REF_INDEX_ENTRIES {
        return Err(invalid("entry count out of range"));
    }
    if !addresses.windows(2).all(|w| w[0] < w[1]) {
        return Err(invalid("addresses must be strictly ascending"));
    }
    Ok(())
}

/// The `ref-index` object listing `addresses` (sorted, distinct, 1 to
/// [`MAX_REF_INDEX_ENTRIES`]).
pub fn ref_index_item(collection: Uuid, addresses: &[B32]) -> Result<Item, SchemaError> {
    check(addresses)?;
    let packed: Vec<u8> = addresses.iter().flat_map(|a| a.0).collect();
    let body = RefIndexPayload {
        addresses: Bytes(packed),
    }
    .to_bytes()
    .map_err(SchemaError::Cbor)?;
    Ok(Item {
        kind: ItemKind::RefIndex,
        collection,
        seq: None,
        prev: None,
        epoch: None,
        signer: None,
        salt: None,
        idem: None,
        refs: None,
        stream: None,
        body: Bytes(body),
        sig: None,
    })
}

/// The addresses a decoded `ref-index` item lists, after checking its kind,
/// header shape and payload rules.
pub fn ref_index_addresses(item: &Item) -> Result<Vec<B32>, SchemaError> {
    if item.kind != ItemKind::RefIndex {
        return Err(invalid("not a ref-index object"));
    }
    item.check_shape()?;
    let p = RefIndexPayload::from_bytes(&item.body.0)?;
    let raw = &p.addresses.0;
    if raw.len() % 32 != 0 {
        return Err(invalid("addresses are not a multiple of 32 bytes"));
    }
    let out: Vec<B32> = raw
        .chunks_exact(32)
        .map(|c| {
            let mut a = [0u8; 32];
            a.copy_from_slice(c);
            B32(a)
        })
        .collect();
    check(&out)?;
    Ok(out)
}

/// Open the stored bytes of the ref-index object at `address` in `collection`:
/// the address is the bytes' SHA-256, and the item is a well-formed index of
/// this collection.
pub fn open_ref_index(
    collection: &Uuid,
    address: &B32,
    bytes: &[u8],
) -> Result<Vec<B32>, SchemaError> {
    if sha256(bytes) != *address {
        return Err(invalid("address is not the SHA-256 of the bytes"));
    }
    let item = Item::from_bytes(bytes)?;
    if item.collection != *collection {
        return Err(invalid("ref-index object of another collection"));
    }
    ref_index_addresses(&item)
}

/// Split a sorted, distinct refs inventory into ref-index objects: as few as
/// possible, of near-equal size, each `(address, bytes)`. Refused when the
/// inventory needs more than [`MAX_REF_INDICES`] objects.
pub fn pack_ref_indices(
    collection: Uuid,
    refs: &[B32],
) -> Result<Vec<(B32, Vec<u8>)>, SchemaError> {
    if refs.is_empty() {
        return Ok(Vec::new());
    }
    let n = refs.len().div_ceil(MAX_REF_INDEX_ENTRIES);
    if n > MAX_REF_INDICES {
        return Err(invalid(
            "inventory needs more ref-index objects than a snapshot may name",
        ));
    }
    let per = refs.len().div_ceil(n);
    refs.chunks(per)
        .map(|part| {
            let bytes = ref_index_item(collection, part)?
                .to_bytes()
                .map_err(SchemaError::Cbor)?;
            Ok((sha256(&bytes), bytes))
        })
        .collect()
}

/// A fmt-2 manifest: the fmt-1 fields of [`ManifestPayload`] plus the required
/// key 12, the ref-index objects among the envelope `refs` (sorted, distinct, 1
/// to [`MAX_REF_INDICES`]).
#[derive(Debug, Clone, PartialEq)]
pub struct IndexedManifest {
    /// Every fmt-1 field.
    pub manifest: ManifestPayload,
    /// Ref-index object addresses.
    pub ref_indices: Vec<Hash>,
}

fn check_indices(ty: &'static str, v: &[Hash]) -> Result<(), SchemaError> {
    if v.is_empty() || v.len() > MAX_REF_INDICES {
        return Err(SchemaError::Invalid {
            ty,
            reason: "ref_indices count out of range",
        });
    }
    if !v.windows(2).all(|w| w[0] < w[1]) {
        return Err(SchemaError::Invalid {
            ty,
            reason: "ref_indices must be strictly ascending",
        });
    }
    Ok(())
}

impl Wire for IndexedManifest {
    fn to_cbor(&self) -> Cbor {
        let mut c = self.manifest.to_cbor();
        if let Cbor::Map(m) = &mut c {
            for (k, v) in m.iter_mut() {
                if *k == Cbor::Uint(0) {
                    *v = Cbor::Uint(MANIFEST_FMT_REF_INDEXED);
                }
            }
            // Key 12 sorts after every fmt-1 key.
            m.push((Cbor::Uint(12), self.ref_indices.to_cbor()));
        }
        c
    }

    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        let ty = "IndexedManifest";
        let m = struct_map(c, ty)?;
        check_fmt(m, ty, MANIFEST_FMT_REF_INDEXED)?;
        let ref_indices = Vec::<Hash>::from_cbor(require(m, 12, ty)?)?;
        check_indices(ty, &ref_indices)?;
        let fmt1: Vec<(Cbor, Cbor)> = m
            .iter()
            .filter(|(k, _)| *k != Cbor::Uint(12))
            .map(|(k, v)| {
                if *k == Cbor::Uint(0) {
                    (k.clone(), Cbor::Uint(1))
                } else {
                    (k.clone(), v.clone())
                }
            })
            .collect();
        Ok(Self {
            manifest: ManifestPayload::from_cbor(&Cbor::Map(fmt1))?,
            ref_indices,
        })
    }

    fn annotate(&self) -> Ann {
        match self.manifest.annotate() {
            Ann::Struct(_, mut f) => {
                for (k, _, v) in f.iter_mut() {
                    if *k == 0 {
                        *v = Ann::Leaf(Cbor::Uint(MANIFEST_FMT_REF_INDEXED));
                    }
                }
                f.push((12, "ref_indices", self.ref_indices.annotate()));
                Ann::Struct("IndexedManifest", f)
            }
            other => other,
        }
    }
}

/// Encode a manifest: fmt 1 without ref indices, fmt 2 with them.
pub fn encode_manifest(
    manifest: &ManifestPayload,
    ref_indices: &[Hash],
) -> Result<Vec<u8>, SchemaError> {
    if ref_indices.is_empty() {
        return manifest.to_bytes().map_err(SchemaError::Cbor);
    }
    check_indices("IndexedManifest", ref_indices)?;
    IndexedManifest {
        manifest: manifest.clone(),
        ref_indices: ref_indices.to_vec(),
    }
    .to_bytes()
    .map_err(SchemaError::Cbor)
}

/// Decode a fmt-1 or fmt-2 manifest payload: the fields and its ref-index
/// objects (empty for fmt 1). Any other format is
/// [`SchemaError::UnknownFormat`].
pub fn decode_manifest(bytes: &[u8]) -> Result<(ManifestPayload, Vec<Hash>), SchemaError> {
    let c = crate::cbor::decode(bytes).map_err(SchemaError::Cbor)?;
    let m = struct_map(&c, "ManifestPayload")?;
    match require(m, 0, "ManifestPayload")? {
        Cbor::Uint(MANIFEST_FMT_REF_INDEXED) => {
            let x = IndexedManifest::from_bytes(bytes)?;
            Ok((x.manifest, x.ref_indices))
        }
        _ => Ok((ManifestPayload::from_bytes(bytes)?, Vec::new())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::B16;

    const C: Uuid = B16([9; 16]);

    fn addr(i: u64) -> B32 {
        let mut a = [0u8; 32];
        a[..8].copy_from_slice(&i.to_be_bytes());
        B32(a)
    }

    #[test]
    fn round_trips_and_is_content_addressed() {
        let refs: Vec<B32> = (0..40_000).map(addr).collect();
        let packed = pack_ref_indices(C, &refs).unwrap();
        assert_eq!(packed.len(), 40_000usize.div_ceil(MAX_REF_INDEX_ENTRIES));
        let mut back = Vec::new();
        for (a, bytes) in &packed {
            assert!(bytes.len() < 1 << 20, "travels inline");
            back.extend(open_ref_index(&C, a, bytes).unwrap());
        }
        assert_eq!(back, refs);
        // Deterministic: the same inventory gives the same objects.
        assert_eq!(pack_ref_indices(C, &refs).unwrap(), packed);
    }

    fn manifest() -> ManifestPayload {
        use crate::attachment_runtime_v1::{Section, SectionKind};
        use crate::common::Version;
        use crate::snapshot::{ChunkRef, Horizon, SectionKind as L};
        ManifestPayload {
            seq: 42,
            chain: addr(0xc4),
            state_digest: addr(0xc5),
            bucket_bits: 0,
            sections: vec![Section {
                kind: SectionKind::Legacy(L::Resources),
                chunks: vec![ChunkRef {
                    address: addr(0xa4),
                    plain_hash: addr(0xa5),
                    rows: 3,
                    bucket: 0,
                    plain_size: 600,
                }],
            }],
            horizon: Horizon {
                seq_floor: 1,
                time_floor: 0,
            },
            sem: Version { major: 1, minor: 0 },
            record_count: 1,
            file_count: 0,
            previous: Some(addr(0xa6)),
            control_chain: addr(0xa7),
        }
    }

    #[test]
    fn indexed_manifest_round_trips_and_old_decoders_refuse_it() {
        let m = manifest();
        let fmt1 = encode_manifest(&m, &[]).unwrap();
        assert_eq!(
            fmt1,
            m.to_bytes().unwrap(),
            "no indices: unchanged fmt-1 bytes"
        );
        assert_eq!(decode_manifest(&fmt1).unwrap(), (m.clone(), vec![]));
        let idx = vec![addr(1), addr(2)];
        let fmt2 = encode_manifest(&m, &idx).unwrap();
        assert_eq!(decode_manifest(&fmt2).unwrap(), (m.clone(), idx.clone()));
        // Pre-ref-index decoders (runtime and legacy fmt-1 codecs) refuse it as
        // an unknown format, the path that stalls an install with UpgradeRequired.
        let old = ManifestPayload::from_bytes(&fmt2).unwrap_err();
        assert!(old.is_unknown(), "{old}");
        let legacy = crate::snapshot::ManifestPayload::from_bytes(&fmt2).unwrap_err();
        assert!(legacy.is_unknown(), "{legacy}");
        // Malformed key 12.
        assert!(encode_manifest(&m, &[addr(2), addr(1)]).is_err());
        let too_many: Vec<B32> = (0..=MAX_REF_INDICES as u64).map(addr).collect();
        assert!(encode_manifest(&m, &too_many).is_err());
        let mut no_key = IndexedManifest {
            manifest: m.clone(),
            ref_indices: idx,
        }
        .to_cbor();
        if let Cbor::Map(v) = &mut no_key {
            v.pop();
        }
        let bytes = crate::cbor::encode(&no_key).unwrap();
        assert!(decode_manifest(&bytes).is_err(), "fmt 2 requires key 12");
        // A future format stays unknown.
        let mut f3 = m.to_cbor();
        if let Cbor::Map(v) = &mut f3 {
            v[0].1 = Cbor::Uint(3);
        }
        let e = decode_manifest(&crate::cbor::encode(&f3).unwrap()).unwrap_err();
        assert!(e.is_unknown());
    }

    #[test]
    fn refuses_malformed_indices() {
        assert!(ref_index_item(C, &[]).is_err());
        assert!(ref_index_item(C, &[addr(2), addr(1)]).is_err());
        assert!(ref_index_item(C, &[addr(1), addr(1)]).is_err());
        let too_many: Vec<B32> = (0..=MAX_REF_INDEX_ENTRIES as u64).map(addr).collect();
        assert!(ref_index_item(C, &too_many).is_err());
        let over: Vec<B32> = (0..(MAX_REF_INDICES * MAX_REF_INDEX_ENTRIES + 1) as u64)
            .map(addr)
            .collect();
        assert!(pack_ref_indices(C, &over).is_err());

        let ok = ref_index_item(C, &[addr(1)]).unwrap();
        let bytes = ok.to_bytes().unwrap();
        // Wrong address, wrong collection.
        assert!(open_ref_index(&C, &addr(0), &bytes).is_err());
        assert!(open_ref_index(&B16([1; 16]), &sha256(&bytes), &bytes).is_err());
        // Header fields an index must not carry.
        let mut signed = ok.clone();
        signed.signer = Some(B16([1; 16]));
        assert!(ref_index_addresses(&signed).is_err());
        let mut with_refs = ok.clone();
        with_refs.refs = Some(vec![addr(1)]);
        assert!(ref_index_addresses(&with_refs).is_err());
        // Ragged packing.
        let mut ragged = ok.clone();
        ragged.body = Bytes(
            RefIndexPayload {
                addresses: Bytes(vec![0; 33]),
            }
            .to_bytes()
            .unwrap(),
        );
        assert!(ref_index_addresses(&ragged).is_err());
        // Another kind.
        let mut chunk = ok;
        chunk.kind = ItemKind::Chunk;
        assert!(ref_index_addresses(&chunk).is_err());
    }
}
