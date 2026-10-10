use super::*;
use mdbn_replica::store::{FileLocal, FileRow, TombstoneLast, TombstoneRow};
use mdbn_wire::{
    attachment::{AttachmentContentV1, AttachmentRefV1, FileContent},
    common::B32,
    intent::{BlobRef, MediaClass},
    snapshot::EntityKind,
    unindexed_markdown::{FileKindV1, UnindexedMarkdownPayloadV1},
};
fn native(n: u8, content: FileContent) -> FileRow {
    FileRow {
        id: id(u64::from(n)),
        path: format!("{n}.md"),
        path_key: format!("{n}.md"),
        content,
        kind: FileKindV1::UnindexedOversizedMarkdown,
        media: MediaClass::Other,
        modified_seq: 8,
        bucket: 0,
        local: FileLocal::Remote,
    }
}
#[test]
fn native_profiles_reopen_rename_tomb_and_confirmed_replacement_are_atomic() {
    let Some(c) = conn() else { return };
    let col = fresh();
    let mut s = PgStore::open(c.clone(), col).unwrap();
    let blob = FileContent::Blob(BlobRef {
        plain_hash: B32([1; 32]),
        size: 1048577,
        blob_id: B32([2; 32]),
        id_epoch: 1,
        part_size: 8388608,
    });
    let attachment = FileContent::AttachmentV1(AttachmentContentV1 {
        reference: AttachmentRefV1 {
            collection: col,
            key_epoch: 1,
            attachment_id: B32([3; 32]),
            manifest_cipher_hash: B32([4; 32]),
        },
        whole_plain_hash: B32([5; 32]),
        total_plain_bytes: 1048577,
    });
    let mut f = native(30, blob);
    let g = native(31, attachment);
    s.commit(Tx {
        files_put: vec![f.clone(), g.clone()],
        ..Tx::default()
    })
    .unwrap();
    drop(s);
    let mut s = PgStore::open(c.clone(), col).unwrap();
    assert_eq!(s.file(&f.id).unwrap(), Some(f.clone()));
    assert_eq!(s.file(&g.id).unwrap(), Some(g.clone()));
    f.path = "renamed.md".into();
    f.path_key = f.path.clone();
    s.commit(Tx {
        files_put: vec![f.clone()],
        ..Tx::default()
    })
    .unwrap();
    assert_eq!(s.file(&f.id).unwrap(), Some(f.clone()));
    let tomb = TombstoneRow {
        id: f.id,
        kind: EntityKind::File,
        path: f.path.clone(),
        path_key: f.path_key.clone(),
        last: TombstoneLast::UnindexedMarkdown(UnindexedMarkdownPayloadV1 {
            content: f.content.clone(),
        }),
        seq: 9,
        time: 11,
    };
    s.commit(Tx {
        files_del: vec![f.id],
        tombstones_put: vec![tomb.clone()],
        ..Tx::default()
    })
    .unwrap();
    assert!(s.file(&f.id).unwrap().is_none());
    assert_eq!(s.tombstone(&f.id).unwrap(), Some(tomb));
    // PgStore does not advertise persistent staging. Its shipped install gate
    // remains closed; qualify only an explicit atomic confirmed replacement.
    assert!(!s.stages());
    let mut invalid = f.clone();
    let FileContent::Blob(b) = &mut invalid.content else {
        panic!()
    };
    b.size = 1048576;
    assert!(
        s.commit(Tx {
            clear_confirmed: true,
            files_put: vec![invalid],
            ..Tx::default()
        })
        .is_err()
    );
    assert_eq!(s.file(&g.id).unwrap(), Some(g.clone()));
    s.commit(Tx {
        clear_confirmed: true,
        files_put: vec![f.clone()],
        ..Tx::default()
    })
    .unwrap();
    assert_eq!(s.file(&f.id).unwrap(), Some(f));
    assert!(s.file(&g.id).unwrap().is_none());
    PgStore::destroy(&c, &col).unwrap();
}
