//! Stored kind is authoritative; never inferred from a filename or descriptor.
use crate::{
    Store,
    mem::MemStore,
    plan::StoreView,
    store::{FileLocal, FileRow, TombstoneLast, TombstoneRow, Tx},
};
use mdbn_core::{
    intent::FileKind,
    state::{StateView, Tombstone},
    types::Catalog,
};
use mdbn_wire::{
    attachment::FileContent,
    common::{B16, B32},
    intent::{BlobRef, MediaClass},
    snapshot::EntityKind,
    unindexed_markdown::{FileKindV1, UnindexedMarkdownPayloadV1},
};
use std::sync::Arc;

#[test]
fn base_view_and_tombstones_preserve_stored_kind_under_identical_paths_and_content() {
    let content = FileContent::Blob(BlobRef {
        plain_hash: B32([1; 32]),
        size: 2_000_000,
        blob_id: B32([2; 32]),
        id_epoch: 1,
        part_size: 8_388_608,
    });
    for (wire_kind, core_kind) in [
        (FileKindV1::Ordinary, FileKind::Ordinary),
        (
            FileKindV1::UnindexedOversizedMarkdown,
            FileKind::UnindexedOversizedMarkdown,
        ),
    ] {
        let row = FileRow {
            kind: wire_kind,
            id: B16([3; 16]),
            path: "same.md".into(),
            path_key: "same.md".into(),
            content: content.clone(),
            media: MediaClass::Other,
            modified_seq: 1,
            bucket: 0,
            local: FileLocal::Remote,
        };
        let mut store = MemStore::new();
        store
            .commit(Tx {
                files_put: vec![row.clone()],
                ..Tx::default()
            })
            .unwrap();
        let view = StoreView::new(&store, Arc::new(Catalog::empty()));
        assert_eq!(
            view.file(&crate::convert::uuid(&row.id)).unwrap().kind,
            core_kind
        );
        let last = TombstoneLast::from_file(&row).unwrap();
        if wire_kind == FileKindV1::UnindexedOversizedMarkdown {
            assert_eq!(
                last,
                TombstoneLast::UnindexedMarkdown(UnindexedMarkdownPayloadV1 {
                    content: content.clone()
                })
            );
        }
        store
            .commit(Tx {
                files_del: vec![row.id],
                tombstones_put: vec![TombstoneRow {
                    id: row.id,
                    kind: EntityKind::File,
                    path: row.path,
                    path_key: row.path_key,
                    last,
                    seq: 2,
                    time: 0,
                }],
                ..Tx::default()
            })
            .unwrap();
        let view = StoreView::new(&store, Arc::new(Catalog::empty()));
        let Some(Tombstone::File { kind, .. }) = view.tombstone(&crate::convert::uuid(&row.id))
        else {
            panic!("file tombstone")
        };
        assert_eq!(kind, core_kind);
    }
}
