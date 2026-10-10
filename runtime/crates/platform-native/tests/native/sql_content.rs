//! Actual SQL persistence of typed descriptors; NOT manifest/provider verification.
use super::*;
use mdbn_store_file::testing::replica::{
    conformance::id,
    store::{FileLocal, FileRow, Page, TombstoneLast, TombstoneRow},
};
use mdbn_store_file::{
    SqlStore,
    testing::{AttachmentContentV1, AttachmentRefV1, BlobRef, FileContent, MediaClass},
};

#[test]
fn typed_file_and_tombstone_descriptors_survive_replace_delete_and_reopen() {
    let dir = scratch("typed-file-content");
    let db = dir.join("state.db");
    let open = || {
        SqlStore::open(Rc::new(RefCell::new(
            SqliteIndex::open(&db, IndexDurability::Durable).unwrap(),
        )))
        .unwrap()
    };
    let blob = BlobRef {
        plain_hash: revision(b"legacy plain"),
        size: 12,
        blob_id: revision(b"legacy id"),
        id_epoch: 1,
        part_size: 1024,
    };
    let content = AttachmentContentV1 {
        reference: AttachmentRefV1 {
            collection: id(999),
            key_epoch: 1,
            attachment_id: revision(b"opaque attachment id"),
            manifest_cipher_hash: revision(b"complete sealed manifest"),
        },
        whole_plain_hash: revision(b"whole plain hash"),
        total_plain_bytes: 1 << 30,
    };
    let legacy = FileRow {
        kind: mdbn_store_file::testing::FileKindV1::Ordinary,
        id: id(1),
        path: "legacy.bin".into(),
        path_key: "legacy.bin".into(),
        content: FileContent::Blob(blob.clone()),
        media: MediaClass::Other,
        modified_seq: 3,
        bucket: 0,
        local: FileLocal::Remote,
    };
    let attachment = FileRow {
        kind: mdbn_store_file::testing::FileKindV1::Ordinary,
        id: id(2),
        path: "large.bin".into(),
        path_key: "large.bin".into(),
        content: FileContent::AttachmentV1(content.clone()),
        media: MediaClass::Other,
        modified_seq: 4,
        bucket: 1,
        local: FileLocal::Remote,
    };
    let mut store = open();
    store
        .commit(Tx {
            files_put: vec![legacy.clone(), attachment.clone()],
            ..Tx::default()
        })
        .unwrap();
    drop(store);
    let mut store = open();
    assert_eq!(store.file(&legacy.id).unwrap(), Some(legacy.clone()));
    assert_eq!(
        store.file(&attachment.id).unwrap(),
        Some(attachment.clone())
    );
    assert_eq!(store.file_at("large.bin").unwrap(), Some(attachment.id));
    assert_eq!(
        store
            .files(Page {
                after: None,
                limit: 10
            })
            .unwrap(),
        vec![legacy.clone(), attachment.clone()]
    );
    let mut replaced = attachment.clone();
    let mut rekeyed = content.clone();
    rekeyed.reference.key_epoch = 2;
    rekeyed.reference.manifest_cipher_hash = revision(b"new complete sealed manifest");
    replaced.content = FileContent::AttachmentV1(rekeyed.clone());
    replaced.path = "moved.bin".into();
    replaced.path_key = "moved.bin".into();
    replaced.modified_seq = 5;
    store
        .commit(Tx {
            files_put: vec![replaced.clone()],
            ..Tx::default()
        })
        .unwrap();
    drop(store);
    let mut store = open();
    assert_eq!(store.file(&attachment.id).unwrap(), Some(replaced.clone()));
    assert_eq!(store.file_at("large.bin").unwrap(), None);
    assert_eq!(store.file_at("moved.bin").unwrap(), Some(attachment.id));
    let tomb = |f: &FileRow, last: TombstoneLast| TombstoneRow {
        id: f.id,
        kind: mdbn_store_file::testing::FileEntityKind::File,
        path: f.path.clone(),
        path_key: f.path_key.clone(),
        last,
        seq: 6,
        time: 123,
    };
    let legacy_tomb = tomb(&legacy, TombstoneLast::Blob(blob));
    let attachment_tomb = tomb(&replaced, TombstoneLast::Attachment(rekeyed));
    store
        .commit(Tx {
            files_del: vec![legacy.id, attachment.id],
            tombstones_put: vec![legacy_tomb.clone(), attachment_tomb.clone()],
            ..Tx::default()
        })
        .unwrap();
    drop(store);
    let store = open();
    assert_eq!(store.file(&legacy.id).unwrap(), None);
    assert_eq!(store.file(&attachment.id).unwrap(), None);
    assert_eq!(store.tombstone(&legacy.id).unwrap(), Some(legacy_tomb));
    assert_eq!(
        store.tombstone(&attachment.id).unwrap(),
        Some(attachment_tomb)
    );
}

#[test]
fn unindexed_kind_full_descriptor_and_tombstone_survive_real_sqlite_reopen() {
    use mdbn_store_file::testing::{FileKindV1, UnindexedMarkdownPayloadV1};
    let dir = scratch("unindexed-file-kind");
    let db = dir.join("state.db");
    let open = || {
        SqlStore::open(Rc::new(RefCell::new(
            SqliteIndex::open(&db, IndexDurability::Durable).unwrap(),
        )))
        .unwrap()
    };
    let blob = BlobRef {
        plain_hash: revision(b"large source"),
        size: 2_000_000,
        blob_id: revision(b"opaque legacy identifier"),
        id_epoch: 1,
        part_size: 8_388_608,
    };
    let mut file = FileRow {
        kind: FileKindV1::UnindexedOversizedMarkdown,
        id: id(11),
        path: "notes/large.md".into(),
        path_key: "notes/large.md".into(),
        content: FileContent::Blob(blob),
        media: MediaClass::Other,
        modified_seq: 3,
        bucket: 0,
        local: FileLocal::Remote,
    };
    let mut store = open();
    store
        .commit(Tx {
            files_put: vec![file.clone()],
            ..Tx::default()
        })
        .unwrap();
    drop(store);
    let mut store = open();
    assert_eq!(store.file(&file.id).unwrap(), Some(file.clone()));
    file.content = FileContent::AttachmentV1(AttachmentContentV1 {
        reference: AttachmentRefV1 {
            collection: id(999),
            key_epoch: 2,
            attachment_id: revision(b"opaque attachment"),
            manifest_cipher_hash: revision(b"resealed full manifest"),
        },
        whole_plain_hash: revision(b"large source"),
        total_plain_bytes: 2_000_000,
    });
    file.path = "notes/moved.md".into();
    file.path_key = file.path.clone();
    store
        .commit(Tx {
            files_put: vec![file.clone()],
            ..Tx::default()
        })
        .unwrap();
    drop(store);
    let mut store = open();
    assert_eq!(store.file(&file.id).unwrap(), Some(file.clone()));
    assert_eq!(store.file_at("notes/large.md").unwrap(), None);
    let tomb = TombstoneRow {
        id: file.id,
        kind: mdbn_store_file::testing::FileEntityKind::File,
        path: file.path,
        path_key: file.path_key,
        last: TombstoneLast::UnindexedMarkdown(UnindexedMarkdownPayloadV1 {
            content: file.content,
        }),
        seq: 6,
        time: 123,
    };
    store
        .commit(Tx {
            files_del: vec![file.id],
            tombstones_put: vec![tomb.clone()],
            ..Tx::default()
        })
        .unwrap();
    drop(store);
    let store = open();
    assert_eq!(store.file(&file.id).unwrap(), None);
    assert_eq!(store.tombstone(&file.id).unwrap(), Some(tomb));
}
