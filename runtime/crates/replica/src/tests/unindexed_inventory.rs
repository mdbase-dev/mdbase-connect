use crate::{
    replica::unindexed_inventory::{Inventory, Roots},
    store::{ConflictRow, FileLocal, FileRow, Store, TombstoneLast, TombstoneRow, Tx},
};
use mdbn_wire::snapshot::EntityKind;
use mdbn_wire::{
    attachment::FileContent,
    attachment_runtime_v1 as rt,
    common::B16,
    intent::MediaClass,
    unindexed_markdown::{FileKindV1, UnindexedMarkdownPayloadV1},
};
fn file(c: FileContent) -> FileRow {
    FileRow {
        id: B16([1; 16]),
        path: "huge.md".into(),
        path_key: "huge.md".into(),
        content: c,
        kind: FileKindV1::UnindexedOversizedMarkdown,
        media: MediaClass::Other,
        modified_seq: 3,
        bucket: 0,
        local: FileLocal::Remote,
    }
}
#[test]
fn all_native_holder_and_conflict_sides_are_inventory_roots() {
    let mut a = super::unindexed_async::node();
    let plain = vec![b'a'; 1048577];
    let (c, _) = super::unindexed_async::contents(&mut a, &plain, false);
    let mut alt = c.clone();
    let FileContent::Blob(b) = &mut alt else {
        panic!()
    };
    b.blob_id.0[0] ^= 1;
    let mut ordinary = file(c.clone());
    ordinary.id = B16([9; 16]);
    ordinary.path = "ordinary.md".into();
    ordinary.path_key = ordinary.path.clone();
    ordinary.kind = FileKindV1::Ordinary;
    let FileContent::Blob(ordinary_blob) = &mut ordinary.content else {
        panic!()
    };
    ordinary_blob.blob_id.0[0] ^= 2;
    a.r.store
        .commit(Tx {
            files_put: vec![file(c.clone()), ordinary],
            tombstones_put: vec![TombstoneRow {
                id: B16([2; 16]),
                kind: EntityKind::File,
                path: "gone.md".into(),
                path_key: "gone.md".into(),
                last: TombstoneLast::UnindexedMarkdown(UnindexedMarkdownPayloadV1 {
                    content: c.clone(),
                }),
                seq: 4,
                time: 5,
            }],
            conflicts_put: vec![ConflictRow {
                mutation: B16([3; 16]),
                seq: 5,
                conflict: rt::Conflict {
                    kind: mdbn_wire::entry::ConflictKind::File,
                    id: B16([4; 16]),
                    field: None,
                    base: Some(rt::ConflictValue::UnindexedMarkdown(
                        UnindexedMarkdownPayloadV1 {
                            content: alt.clone(),
                        },
                    )),
                    kept: rt::ConflictValue::Legacy(mdbn_wire::entry::ConflictValue::Deleted),
                    lost: rt::ConflictValue::UnindexedMarkdown(UnindexedMarkdownPayloadV1 {
                        content: c,
                    }),
                },
            }],
            ..Tx::default()
        })
        .unwrap();
    let roots = Roots::collect(&a.r.store).unwrap();
    assert_eq!(roots.descriptors().count(), 2);
    let Inventory::Complete(refs) = a.r.native_snapshot_inventory(&roots).unwrap() else {
        panic!()
    };
    assert_eq!(refs.len(), 4);
    assert!(refs.windows(2).all(|w| w[0] < w[1]));
}
#[test]
fn blob_inventory_covers_all_parts_without_whole_plaintext_buffer() {
    let mut a = super::unindexed_async::node();
    let (c, objects) = super::unindexed_async::contents(&mut a, &vec![b'a'; 1048577], false);
    let mut roots = Roots::default();
    roots.add(&c).unwrap();
    let Inventory::Complete(refs) = a.r.native_snapshot_inventory(&roots).unwrap() else {
        panic!()
    };
    assert_eq!(refs, objects.keys().copied().collect::<Vec<_>>());
    let mut bad = c.clone();
    let FileContent::Blob(b) = &mut bad else {
        panic!()
    };
    b.id_epoch = 2;
    let mut roots = Roots::default();
    roots.add(&bad).unwrap();
    assert!(a.r.native_snapshot_inventory(&roots).is_err());
}
#[test]
fn attachment_inventory_cannot_substitute_a_declared_manifest_root() {
    let mut a = super::unindexed_async::node();
    let (c, objects) = super::unindexed_async::contents(&mut a, &vec![b'a'; 1048577], true);
    let mut roots = Roots::default();
    roots.add(&c).unwrap();
    let Inventory::Pending(pending) = a.r.native_snapshot_inventory(&roots).unwrap() else {
        panic!()
    };
    assert_eq!(pending.len(), 1);
    let FileContent::AttachmentV1(d) = &c else {
        panic!()
    };
    a.r.store
        .commit(Tx {
            meta: vec![
                crate::replica::attachment_inventory::inventory_meta_of_refs(
                    d.reference.manifest_cipher_hash,
                    &objects.keys().copied().collect::<Vec<_>>(),
                ),
            ],
            ..Tx::default()
        })
        .unwrap();
    let Inventory::Complete(refs) = a.r.native_snapshot_inventory(&roots).unwrap() else {
        panic!()
    };
    assert_eq!(refs, objects.keys().copied().collect::<Vec<_>>());
    let mut wrong = c.clone();
    let FileContent::AttachmentV1(d) = &mut wrong else {
        panic!()
    };
    d.reference.collection = B16([77; 16]);
    let mut roots = Roots::default();
    roots.add(&wrong).unwrap();
    assert!(a.r.native_snapshot_inventory(&roots).is_err());
}
