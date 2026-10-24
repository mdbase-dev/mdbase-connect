//! Legacy documents over the synced-record cap are imported as attachment-backed files
//! at the same path, bytes exact, and reported; never dropped, truncated or indexed
//! Oversized documents remain available as files without indexing.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, missing_docs)]

use std::collections::BTreeMap;

use mdbn_legacy::hosted::source::Change;
use mdbn_legacy::hosted::{FileMeta, Record};
use mdbn_legacy::revision_of;
use mdbn_migrate::gen0::{self, IMPORTED_AS_FILE_REASON, MAX_RECORD_DOCUMENT_BYTES};
use mdbn_migrate::shadow::Expected;
use mdbn_migrate::{Error, ids};
use mdbn_wire::common::B32;
use mdbn_wire::intent::{BlobRef, MediaClass};

const CID: &str = "4c18af2e-b04a-4b77-b83e-493c3695962e";
const R1: &str = "0192f0c1-7e1a-7b3c-8d4e-000000000001";
const R2: &str = "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
const F1: &str = "0192f0c1-7e1a-7b3c-8d4e-0000000000f1";

fn record(id: &str, path: &str, len: usize) -> Record {
    const HEADER: &str = "---\ntitle: big\n---\n";
    let document = format!("{HEADER}{}", "x".repeat(len - HEADER.len()));
    assert_eq!(document.len(), len);
    Record {
        record_id: id.into(),
        path: path.into(),
        revision: revision_of(document.as_bytes()),
        document,
    }
}

/// A sealed blob for `doc` as `reseal_oversize_records` would produce (identity only).
fn blob_for(doc: &str) -> BlobRef {
    BlobRef {
        plain_hash: ids::revision(&revision_of(doc.as_bytes())).unwrap(),
        size: doc.len() as u64,
        blob_id: B32([7; 32]),
        id_epoch: 1,
        part_size: 8 << 20,
    }
}

#[test]
fn a_document_over_the_cap_becomes_a_file_at_the_same_path_and_is_reported() {
    let big = record(R1, "notes/big.md", MAX_RECORD_DOCUMENT_BYTES + 1);
    let fits = record(R2, "notes/fits.md", MAX_RECORD_DOCUMENT_BYTES);
    let both = [fits.clone(), big.clone()];
    let mut oversize = gen0::oversize_records(&both);
    assert_eq!(oversize.next().map(|r| r.record_id.as_str()), Some(R1));
    assert!(oversize.next().is_none());

    let sealed = BTreeMap::from([(R1.to_owned(), blob_for(&big.document))]);
    let g = gen0::build(CID, 9, &[], &[big.clone(), fits.clone()], &[], &sealed).unwrap();
    // Exactly 1 MiB still indexes as a record; one byte more is a file.
    assert_eq!(g.records.len(), 1);
    assert_eq!(g.records[0].id.to_uuid_string(), R2);
    assert_eq!(g.records[0].doc, fits.document);
    assert_eq!(g.files.len(), 1);
    let f = &g.files[0];
    assert_eq!(
        f.id.to_uuid_string(),
        R1,
        "the legacy record ID is the file ID"
    );
    assert_eq!(f.path, "notes/big.md", "same path");
    assert_eq!(f.blob.size, big.document.len() as u64);
    assert_eq!(f.blob.plain_hash, ids::revision(&big.revision).unwrap());
    assert_eq!(f.media, MediaClass::Other);
    // The per-account report entry.
    assert_eq!(g.imported_as_files.len(), 1);
    let e = &g.imported_as_files[0];
    assert_eq!(e.id, f.id);
    assert_eq!(e.path, "notes/big.md");
    assert_eq!(e.bytes, MAX_RECORD_DOCUMENT_BYTES as u64 + 1);
    assert_eq!(e.reason(), IMPORTED_AS_FILE_REASON);
    assert_eq!(e.reason(), "imported as file: too large to index");
    assert!(
        !format!("{e:?}").contains("big.md"),
        "report Debug never prints names"
    );
    // Shadow verify expects it as a file with the same identity and digest.
    let x = Expected::from_gen0(&g);
    assert!(!x.records.contains_key(&f.id));
    assert_eq!(
        x.files[&f.id],
        ("notes/big.md".to_owned(), f.blob.plain_hash)
    );
}

#[test]
fn an_unsealed_or_mismatched_oversize_document_stops_the_collection() {
    let big = record(R1, "notes/big.md", MAX_RECORD_DOCUMENT_BYTES + 1);
    // Not sealed: nothing may be dropped, so the build fails rather than skipping it.
    let err = gen0::build(
        CID,
        1,
        &[],
        std::slice::from_ref(&big),
        &[],
        &BTreeMap::new(),
    )
    .unwrap_err();
    assert!(matches!(err, Error::Invalid(_)), "{err}");
    assert!(err.to_string().contains(R1));
    assert!(!err.to_string().contains("title"), "no content in errors");
    // Sealed from different bytes.
    let other = record(R2, "notes/other.md", MAX_RECORD_DOCUMENT_BYTES + 2);
    let wrong = BTreeMap::from([(R1.to_owned(), blob_for(&other.document))]);
    let err = gen0::build(CID, 1, &[], std::slice::from_ref(&big), &[], &wrong).unwrap_err();
    assert!(matches!(err, Error::Invalid(_)), "{err}");
    // Sealed with the right digest but a different size.
    let mut short = blob_for(&big.document);
    short.size -= 1;
    let err = gen0::build(
        CID,
        1,
        &[],
        &[big],
        &[],
        &BTreeMap::from([(R1.to_owned(), short)]),
    )
    .unwrap_err();
    assert!(matches!(err, Error::Invalid(_)), "{err}");
}

#[test]
fn ids_stay_unique_across_records_files_and_documents_imported_as_files() {
    let big = record(R1, "notes/big.md", MAX_RECORD_DOCUMENT_BYTES + 1);
    let dup = FileMeta {
        file_id: R1.into(),
        path: "att/dup.bin".into(),
        content_digest: revision_of(b""),
        size: 0,
        object_key: "legacy/private-object-key".into(),
        media_type: None,
        media_class: "other".into(),
    };
    let sealed = BTreeMap::from([(R1.to_owned(), blob_for(&big.document))]);
    let err = gen0::build(CID, 1, &[], &[big], &[dup], &sealed).unwrap_err();
    assert!(err.to_string().contains("duplicate id"), "{err}");
    let _ = F1;
}

#[test]
fn shadow_expectation_follows_the_cap_across_legacy_changes() {
    let small = record(R1, "notes/a.md", 100);
    let g = gen0::build(
        CID,
        1,
        &[],
        std::slice::from_ref(&small),
        &[],
        &BTreeMap::new(),
    )
    .unwrap();
    let mut x = Expected::from_gen0(&g);
    let id = ids::uuid(R1).unwrap();
    assert!(x.records.contains_key(&id));

    // Grows over the cap after S0: expected as a file now, not a record.
    let grown = record(R1, "notes/a.md", MAX_RECORD_DOCUMENT_BYTES + 1);
    x.apply(
        2,
        &[Change::Record {
            sequence: 2,
            record_id: R1.into(),
            after: Some(grown.clone()),
        }],
        None,
    )
    .unwrap();
    assert!(!x.records.contains_key(&id));
    assert_eq!(
        x.files[&id],
        (
            "notes/a.md".to_owned(),
            ids::revision(&grown.revision).unwrap()
        )
    );

    // Shrinks back: a record again, no stale file expectation.
    x.apply(
        3,
        &[Change::Record {
            sequence: 3,
            record_id: R1.into(),
            after: Some(small.clone()),
        }],
        None,
    )
    .unwrap();
    assert!(!x.files.contains_key(&id));
    assert_eq!(
        x.records[&id],
        (
            "notes/a.md".to_owned(),
            ids::revision(&small.revision).unwrap()
        )
    );

    // Deleted while over the cap: gone from both.
    x.apply(
        4,
        &[Change::Record {
            sequence: 4,
            record_id: R1.into(),
            after: Some(grown),
        }],
        None,
    )
    .unwrap();
    x.apply(
        5,
        &[Change::Record {
            sequence: 5,
            record_id: R1.into(),
            after: None,
        }],
        None,
    )
    .unwrap();
    assert!(!x.records.contains_key(&id) && !x.files.contains_key(&id));
    assert_eq!(x.legacy_seq, 5);
}
