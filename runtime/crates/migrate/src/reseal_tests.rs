// Hosted adoption, the parts on main today: re-seal against a strict fake of the log
// service object API, generation 0, and shadow verify against `MemStore`. These are
// unit tests because `reseal` compiles only in the hosted service and under cfg(test).

use std::collections::BTreeMap;

use crate::gen0::{self, Gen0};
use crate::preflight;
use crate::reseal::{self, ObjectSource, SealKey};
use crate::shadow::{self, Difference, Expected};
use mdbn_legacy::hosted::source::Change;
use mdbn_legacy::hosted::{FileMeta, Record};
use mdbn_legacy::revision_of;
use mdbn_replica::crypto::blob::{check_blob, content_key, open_part, part_addresses};
use mdbn_replica::crypto::{Secret32, TestEntropy};
use mdbn_replica::mem::MemStore;
use mdbn_replica::store::{FileLocal, FileRow, Head, RecordMeta, RecordRow, Store, Tx, bucket16};

const CID: &str = "4c18af2e-b04a-4b77-b83e-493c3695962e";
const R1: &str = "0192f0c1-7e1a-7b3c-8d4e-000000000001";
const R2: &str = "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f"; // a v4 legacy ID
const F1: &str = "0192f0c1-7e1a-7b3c-8d4e-0000000000f1";
const F2: &str = "0192f0c1-7e1a-7b3c-8d4e-0000000000f2";

struct Objects(BTreeMap<String, Vec<u8>>, u32);
impl ObjectSource for Objects {
    fn get(&mut self, key: &str) -> Result<Vec<u8>, String> {
        self.1 += 1;
        self.0
            .get(key)
            .cloned()
            .ok_or_else(|| format!("no object {key}"))
    }
}

fn record(id: &str, path: &str, doc: &str) -> Record {
    Record {
        record_id: id.into(),
        path: path.into(),
        document: doc.into(),
        revision: revision_of(doc.as_bytes()),
    }
}

fn file(id: &str, path: &str, key: &str, bytes: &[u8]) -> FileMeta {
    FileMeta {
        file_id: id.into(),
        path: path.into(),
        content_digest: revision_of(bytes),
        size: bytes.len() as u64,
        object_key: key.into(),
        media_type: Some("image/png".into()),
        media_class: "image".into(),
    }
}

/// Install generation 0 into a store the way the replica's import will: confirmed
/// rows at head 0. (Only identity and content matter to shadow verify.)
fn install(store: &mut MemStore, g: &Gen0) {
    let tx = Tx {
        clear_confirmed: true,
        head: Some(Head::GENESIS),
        records_put: g
            .records
            .iter()
            .map(|r| RecordRow {
                id: r.id,
                path: r.path.clone(),
                path_key: r.path.to_lowercase(),
                doc: r.doc.clone(),
                revision: r.revision,
                modified_seq: 0,
                bucket: bucket16(&r.id),
                meta: RecordMeta::default(),
            })
            .collect(),
        files_put: g
            .files
            .iter()
            .map(|f| FileRow {
                kind: mdbn_wire::unindexed_markdown::FileKindV1::Ordinary,
                id: f.id,
                path: f.path.clone(),
                path_key: f.path.to_lowercase(),
                content: mdbn_wire::attachment::FileContent::Blob(f.blob.clone()),
                media: f.media,
                modified_seq: 0,
                mtime: None,
                bucket: bucket16(&f.id),
                local: FileLocal::Remote,
            })
            .collect(),
        resources_put: g.resources.clone(),
        ..Tx::default()
    };
    store.commit(tx).unwrap();
}

#[test]
fn reseal_gen0_and_shadow_verify() {
    let png = super::testing::noise(9 << 20, 1); // two parts: 8 MiB and 1 MiB
    let same = png.clone(); // identical content under another key: deduplicated
    let mut objects = Objects(
        BTreeMap::from([
            ("v1/blobs/c/a".to_owned(), png.clone()),
            ("v1/blobs/c/b".to_owned(), same),
        ]),
        0,
    );
    let files = vec![
        file(F1, "att/a.png", "v1/blobs/c/a", &png),
        file(F2, "att/copy.png", "v1/blobs/c/b", &png),
    ];
    let records = vec![
        record(R1, "notes/a.md", "# A\n"),
        record(R2, "notes/b.md", "---\ntitle: B\n---\n"),
    ];
    let resources = vec![("mdbase.yaml".to_owned(), b"spec_version: 0.2.0\n".to_vec())];
    // The driver order the types enforce: full preflight + rename step, then upload.
    let resolved = preflight::resolve(&resources, &records, &files).unwrap();
    assert!(resolved.renames().is_empty());

    let mut service = super::testing::StrictStore::default();
    let collection = crate::ids::uuid(CID).unwrap();
    let key = Secret32([4; 32]);
    let seal = SealKey {
        key: &key,
        epoch: 1,
        collection,
    };
    let mut entropy = TestEntropy::new(1);
    let (sealed, stats) =
        reseal::reseal_files(&resolved, &mut objects, &seal, &mut service, &mut entropy).unwrap();
    assert_eq!(stats.files, 2);
    assert_eq!(stats.parts, 4);
    assert_eq!(stats.uploaded, 2, "the identical file deduplicates");
    assert_eq!(stats.present, 2);
    // Parts over 1 MiB went through the direct transfer and commit, never inline.
    assert_eq!(service.inline_puts, 0);
    assert_eq!(service.direct_puts, stats.uploaded);

    // A resumed run uploads nothing.
    let (_, again) =
        reseal::reseal_files(&resolved, &mut objects, &seal, &mut service, &mut entropy).unwrap();
    assert_eq!(again.uploaded, 0);

    // The stored parts decrypt back to the original bytes.
    let blob = &sealed[F1];
    let stored: BTreeMap<_, _> = service.objects(&collection).into_iter().collect();
    let k_cid = content_key(&key, &collection);
    let mut plain = Vec::new();
    for (i, addr) in part_addresses(&k_cid, blob).unwrap().iter().enumerate() {
        plain.extend(open_part(&key, &collection, blob, i as u64, &stored[addr]).unwrap());
    }
    assert!(check_blob(blob, &plain));
    assert_eq!(plain, png);

    let g = gen0::build(CID, 42, &resources, &records, &files, &sealed).unwrap();
    assert_eq!(g.records.len(), 2);
    assert_eq!(
        g.records
            .iter()
            .find(|r| r.path == "notes/b.md")
            .unwrap()
            .id
            .to_uuid_string(),
        R2
    );

    let mut store = MemStore::new();
    install(&mut store, &g);
    let mut expected = Expected::from_gen0(&g);
    assert_eq!(shadow::verify(&expected, &store).unwrap(), vec![]);

    // The old system keeps serving: an edit, a delete and a new file after S0.
    let edited = record(R1, "notes/a.md", "# A edited\n");
    let changes = vec![
        Change::Record {
            sequence: 43,
            record_id: R1.into(),
            after: Some(edited.clone()),
        },
        Change::File {
            sequence: 44,
            file_id: F2.into(),
            after: None,
        },
    ];
    expected.apply(44, &changes, None).unwrap();
    let diffs = shadow::verify(&expected, &store).unwrap();
    let r1 = crate::ids::uuid(R1).unwrap();
    let f2 = crate::ids::uuid(F2).unwrap();
    assert_eq!(
        diffs,
        vec![Difference::RecordContent(r1), Difference::ExtraFile(f2)]
    );

    // A resource change without the resources at head is refused, not guessed.
    let res_change = vec![Change::Resource {
        sequence: 45,
        path: "mdbase.yaml".into(),
    }];
    assert!(expected.apply(45, &res_change, None).is_err());
}

#[test]
fn gen0_refuses_inconsistent_input() {
    let png = b"bytes".to_vec();
    let files = vec![file(F1, "att/a.png", "k", &png)];
    let records = vec![record(R1, "att/a.png", "# clash\n")];
    // A file that was never re-sealed.
    assert!(gen0::build(CID, 1, &[], &[], &files, &BTreeMap::new()).is_err());
    // A record and a file at one path.
    let mut service = super::testing::StrictStore::default();
    let collection = crate::ids::uuid(CID).unwrap();
    let key = Secret32([4; 32]);
    let seal = SealKey {
        key: &key,
        epoch: 1,
        collection,
    };
    let mut objects = Objects(BTreeMap::from([("k".to_owned(), png.clone())]), 0);
    let (sealed, _) = reseal::reseal_files(
        &preflight::resolve(&[], &[], &files).unwrap(),
        &mut objects,
        &seal,
        &mut service,
        &mut TestEntropy::new(2),
    )
    .unwrap();
    assert!(gen0::build(CID, 1, &[], &records, &files, &sealed).is_err());
    // A record whose revision doesn't match its document.
    let mut bad = record(R1, "notes/a.md", "# A\n");
    bad.document = "tampered".into();
    assert!(gen0::build(CID, 1, &[], &[bad], &[], &BTreeMap::new()).is_err());
    // A non-UTF-8 resource.
    assert!(
        gen0::build(
            CID,
            1,
            &[("x".into(), vec![0xff])],
            &[],
            &[],
            &BTreeMap::new()
        )
        .is_err()
    );
    // An R2 object that doesn't match its row is refused before sealing.
    let mut objects = Objects(BTreeMap::from([("k".to_owned(), b"other".to_vec())]), 0);
    assert!(
        reseal::reseal_files(
            &preflight::resolve(&[], &[], &files).unwrap(),
            &mut objects,
            &seal,
            &mut service,
            &mut TestEntropy::new(3)
        )
        .is_err()
    );
}

#[test]
fn small_parts_go_inline_large_ones_direct() {
    let small = b"tiny attachment".to_vec();
    let big = super::testing::noise(3 << 20, 2);
    let files = vec![
        file(F1, "att/small.bin", "k1", &small),
        file(F2, "att/big.bin", "k2", &big),
    ];
    let mut objects = Objects(
        BTreeMap::from([("k1".to_owned(), small), ("k2".to_owned(), big)]),
        0,
    );
    let mut service = super::testing::StrictStore::default();
    let collection = crate::ids::uuid(CID).unwrap();
    let key = Secret32([4; 32]);
    let seal = SealKey {
        key: &key,
        epoch: 1,
        collection,
    };
    let (_, stats) = reseal::reseal_files(
        &preflight::resolve(&[], &[], &files).unwrap(),
        &mut objects,
        &seal,
        &mut service,
        &mut TestEntropy::new(9),
    )
    .unwrap();
    assert_eq!(stats.uploaded, 2);
    assert_eq!((service.inline_puts, service.direct_puts), (1, 1));
}

/// A legacy document over the synced-record cap is sealed from the H2 read (no old
/// object), imported as a file at the same path with the record's ID, verified by the
/// shadow, and reported. Nothing is dropped or truncated.
#[test]
fn oversize_document_is_sealed_and_imported_as_a_file() {
    use crate::gen0::{IMPORTED_AS_FILE_REASON, MAX_RECORD_DOCUMENT_BYTES};
    let body = String::from_utf8(super::testing::noise(MAX_RECORD_DOCUMENT_BYTES, 3))
        .unwrap_or_else(|e| {
            // Noise is not UTF-8; use its hex instead (2 MiB, still a legal document).
            e.into_bytes().iter().map(|b| format!("{b:02x}")).collect()
        });
    let big = record(R1, "notes/big.md", &body);
    assert!(big.document.len() > MAX_RECORD_DOCUMENT_BYTES);
    let small = record(R2, "notes/small.md", "# small\n");
    let resolved = preflight::resolve(&[], &[big.clone(), small.clone()], &[]).unwrap();

    let mut service = super::testing::StrictStore::default();
    let collection = crate::ids::uuid(CID).unwrap();
    let key = Secret32([5; 32]);
    let seal = SealKey {
        key: &key,
        epoch: 1,
        collection,
    };
    let mut entropy = TestEntropy::new(2);
    // A document whose revision is not its digest stops the collection before sealing.
    let mut tampered = big.clone();
    tampered.document.push('!');
    let bad = preflight::resolve(&[], &[tampered], &[]).unwrap();
    assert!(reseal::reseal_oversize_records(&bad, &seal, &mut service, &mut entropy).is_err());
    assert_eq!(service.inline_puts + service.direct_puts, 0);

    let (sealed, stats) =
        reseal::reseal_oversize_records(&resolved, &seal, &mut service, &mut entropy).unwrap();
    assert_eq!(stats.files, 1, "only the oversize document is sealed");
    assert_eq!(stats.bytes, big.document.len() as u64);
    assert_eq!(sealed.len(), 1);
    assert!(sealed.contains_key(R1));
    // The stored parts decrypt back to the exact document bytes.
    let blob = &sealed[R1];
    let stored: BTreeMap<_, _> = service.objects(&collection).into_iter().collect();
    let k_cid = content_key(&key, &collection);
    let mut plain = Vec::new();
    for (i, addr) in part_addresses(&k_cid, blob).unwrap().iter().enumerate() {
        plain.extend(open_part(&key, &collection, blob, i as u64, &stored[addr]).unwrap());
    }
    assert!(check_blob(blob, &plain));
    assert_eq!(plain, big.document.as_bytes());

    let g = gen0::build(CID, 1, &[], resolved.records(), &[], &sealed).unwrap();
    assert_eq!(g.records.len(), 1);
    assert_eq!(g.records[0].id.to_uuid_string(), R2);
    assert_eq!(g.files.len(), 1);
    assert_eq!(g.files[0].id.to_uuid_string(), R1);
    assert_eq!(g.files[0].path, "notes/big.md");
    assert_eq!(g.imported_as_files.len(), 1);
    assert_eq!(g.imported_as_files[0].reason(), IMPORTED_AS_FILE_REASON);

    let mut store = MemStore::new();
    install(&mut store, &g);
    let expected = Expected::from_gen0(&g);
    assert_eq!(shadow::verify(&expected, &store).unwrap(), vec![]);
}

/// Pre-history segments seal in order, each validated first; a misordered segment
/// stops the import before anything is uploaded for it.
#[test]
fn prehistory_segments_seal_in_order_and_decrypt_back() {
    use mdbn_migrate_portable::prehistory::{
        ArchiveSource, RecordVersion, SegmentBuilder, decode_segment,
    };
    let cid = crate::ids::uuid(CID).unwrap();
    let mut b = SegmentBuilder::new(cid, 3, ArchiveSource::HostedProvider, 200);
    let mut segments = Vec::new();
    for seq in 1..=3u64 {
        let v = RecordVersion {
            record_id: crate::ids::uuid(R1).unwrap(),
            sequence: seq,
            revision: revision_of(b"x"),
            path: Some("notes/a.md".into()),
            document: Some("x".repeat(120)),
            created_at: 1_790_000_000_000,
            deleted: false,
        };
        if let Some(s) = b.push_record(v).unwrap() {
            segments.push(s);
        }
    }
    let (last, n) = b.finish().unwrap();
    segments.push(last);
    assert_eq!(n as usize, segments.len());
    assert!(segments.len() >= 2);

    let mut service = super::testing::StrictStore::default();
    let key = Secret32([6; 32]);
    let seal = SealKey {
        key: &key,
        epoch: 1,
        collection: cid,
    };
    let mut entropy = TestEntropy::new(3);
    // Out of order: refused before any upload.
    let swapped: Vec<Vec<u8>> = segments.iter().rev().cloned().collect();
    assert!(reseal::reseal_prehistory(&swapped, &seal, &mut service, &mut entropy).is_err());
    assert_eq!(service.inline_puts + service.direct_puts, 0);

    let (blobs, stats) =
        reseal::reseal_prehistory(&segments, &seal, &mut service, &mut entropy).unwrap();
    assert_eq!(blobs.len(), segments.len());
    assert_eq!(stats.files as usize, segments.len());
    let stored: BTreeMap<_, _> = service.objects(&cid).into_iter().collect();
    let k_cid = content_key(&key, &cid);
    for (blob, plain) in blobs.iter().zip(&segments) {
        let mut got = Vec::new();
        for (i, addr) in part_addresses(&k_cid, blob).unwrap().iter().enumerate() {
            got.extend(open_part(&key, &cid, blob, i as u64, &stored[addr]).unwrap());
        }
        assert!(check_blob(blob, &got));
        assert_eq!(&got, plain);
        assert!(decode_segment(&got).is_ok());
    }
}

/// Both historical digests and bytes survive with only the imported GC roots.
#[test]
fn retained_two_version_file_keeps_digests_and_bytes_after_gc() {
    use crate::prehistory::{build_segments, seal_retained_history};
    use mdbn_legacy::hosted::FileVersion;
    use mdbn_migrate_portable::prehistory::decode_segment;

    let old = b"old attachment bytes".to_vec();
    let current = b"new attachment bytes\0\xff".to_vec();
    let versions: Vec<_> = [(&old, "old-object"), (&current, "current-object")]
        .into_iter()
        .enumerate()
        .map(|(index, (bytes, object))| FileVersion {
            file_id: F1.into(),
            sequence: index as u64 + 1,
            revision: format!("legacy-version-{}", index + 1),
            created_at_ms: index as i64 + 1,
            deleted: false,
            path: Some(format!("att/version-{}.bin", index + 1)),
            content_digest: Some(revision_of(bytes)),
            size: Some(bytes.len() as u64),
            object_key: Some(object.into()),
            media_type: None,
            media_class: None,
        })
        .collect();
    let segments = build_segments(
        CID,
        2,
        100,
        Vec::<crate::Result<mdbn_legacy::hosted::RecordVersion>>::new(),
        versions.iter().cloned().map(Ok),
    )
    .unwrap();
    let cid = crate::ids::uuid(CID).unwrap();
    let key = Secret32([7; 32]);
    let seal = SealKey {
        key: &key,
        epoch: 1,
        collection: cid,
    };
    let mut source = Objects(
        BTreeMap::from([
            ("old-object".into(), old.clone()),
            ("current-object".into(), current.clone()),
        ]),
        0,
    );
    let mut service = super::testing::StrictStore::default();
    let archive = seal_retained_history(
        &segments,
        &versions,
        100,
        &mut source,
        &seal,
        &mut service,
        &mut TestEntropy::new(17),
    )
    .unwrap();
    assert_eq!(source.1, 2, "read each version's exact old object");
    let mut stored: BTreeMap<_, _> = service.objects(&cid).into_iter().collect();
    // Model blind GC: ciphertext cannot reveal the nested version blob refs.
    stored.retain(|address, _| archive.refs.contains(address));
    let content_key = content_key(&key, &cid);
    let open = |blob: &mdbn_wire::intent::BlobRef| {
        let mut bytes = Vec::new();
        for (index, address) in part_addresses(&content_key, blob)
            .unwrap()
            .iter()
            .enumerate()
        {
            bytes.extend(open_part(&key, &cid, blob, index as u64, &stored[address]).unwrap());
        }
        assert!(check_blob(blob, &bytes));
        bytes
    };
    let files: Vec<_> = archive
        .prehistory
        .iter()
        .flat_map(|blob| decode_segment(&open(blob)).unwrap().files)
        .collect();
    assert_eq!(files.len(), 2);
    for ((version, expected), legacy) in files.iter().zip([old, current]).zip(&versions) {
        assert_eq!(version.revision, legacy.revision);
        assert_eq!(version.sequence, legacy.sequence);
        assert_eq!(version.file_id.to_uuid_string(), legacy.file_id);
        assert_eq!(version.path, legacy.path);
        assert_eq!(version.size, legacy.size);
        assert_eq!(version.created_at, legacy.created_at_ms);
        assert_eq!(version.deleted, legacy.deleted);
        assert_eq!(
            version.content_digest,
            Some(mdbn_wire::hash::sha256(&expected))
        );
        let blob = version.content.as_ref().expect("old bytes retained");
        assert_eq!(blob.plain_hash, version.content_digest.unwrap());
        assert_eq!(open(blob), expected);
        assert!(
            part_addresses(&content_key, blob)
                .unwrap()
                .iter()
                .all(|part| archive.refs.contains(part))
        );
    }
}

#[test]
fn retained_version_refuses_missing_or_current_bytes_and_reads_no_deleted_object() {
    use crate::prehistory::seal_file_version;
    use mdbn_legacy::hosted::FileVersion;

    let row = FileVersion {
        file_id: F1.into(),
        sequence: 1,
        revision: "original-v1".into(),
        created_at_ms: 3,
        deleted: false,
        path: Some("att/original.bin".into()),
        size: Some(4),
        content_digest: Some(revision_of(b"old!")),
        object_key: Some("original-object".into()),
        media_type: None,
        media_class: None,
    };
    let key = Secret32([8; 32]);
    let seal = SealKey {
        key: &key,
        epoch: 1,
        collection: crate::ids::uuid(CID).unwrap(),
    };
    for objects in [
        BTreeMap::new(),
        BTreeMap::from([("original-object".into(), b"new!".to_vec())]),
    ] {
        let mut source = Objects(objects, 0);
        let mut store = super::testing::StrictStore::default();
        assert!(
            seal_file_version(
                &row,
                2,
                &mut source,
                &seal,
                &mut store,
                &mut TestEntropy::new(19)
            )
            .is_err()
        );
        assert_eq!(source.1, 1);
        assert_eq!(store.inline_puts + store.direct_puts, 0);
    }
    let deleted = FileVersion {
        sequence: 2,
        revision: "original-deletion".into(),
        deleted: true,
        path: None,
        size: None,
        content_digest: None,
        object_key: None,
        ..row.clone()
    };
    let mut source = Objects(BTreeMap::new(), 0);
    let mut store = super::testing::StrictStore::default();
    let retained = seal_file_version(
        &deleted,
        2,
        &mut source,
        &seal,
        &mut store,
        &mut TestEntropy::new(23),
    )
    .unwrap();
    assert!(retained.version.deleted);
    assert_eq!(retained.version.revision, deleted.revision);
    assert!(retained.version.content.is_none());
    assert!(retained.refs.is_empty());
    assert_eq!(source.1, 0);
    assert_eq!(store.inline_puts + store.direct_puts, 0);
    for bad in [
        FileVersion {
            sequence: 3,
            ..row.clone()
        },
        FileVersion {
            object_key: Some("wrong-deleted-object".into()),
            ..deleted
        },
    ] {
        assert!(
            seal_file_version(
                &bad,
                2,
                &mut source,
                &seal,
                &mut store,
                &mut TestEntropy::new(29)
            )
            .is_err()
        );
    }
    assert_eq!(
        source.1, 0,
        "reject malformed metadata before reading old objects"
    );
}
