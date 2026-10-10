use super::*;
use mdbn_wire::{
    common::B16,
    intent::{BlobRef, MediaClass},
    unindexed_markdown::{FileKindV1, UnindexedMarkdownPayloadV1},
};
fn row() -> FileRow {
    FileRow {
        id: B16([1; 16]),
        path: "large.md".into(),
        path_key: "large.md".into(),
        content: FileContent::Blob(BlobRef {
            plain_hash: B32([2; 32]),
            size: 2000000,
            blob_id: B32([3; 32]),
            id_epoch: 1,
            part_size: 8388608,
        }),
        kind: FileKindV1::Ordinary,
        media: MediaClass::Other,
        modified_seq: 9,
        bucket: 0,
        local: FileLocal::Remote,
    }
}
fn hex(h: Hash) -> String {
    h.0.iter().map(|b| format!("{b:02x}")).collect()
}
#[test]
fn ordinary_digest_keeps_exact_seven_component_golden() {
    let f = row();
    let mut x = DigestIndex::default();
    x.file(&f).unwrap();
    let old = Cbor::Array(vec![
        Cbor::Array(vec![]),
        Cbor::Array(vec![]),
        Cbor::Array(vec![Cbor::Array(vec![
            f.id.to_cbor(),
            f.path.to_cbor(),
            f.content.plain_hash().to_cbor(),
        ])]),
        Cbor::Array(vec![]),
        crate::convert::winclusion(&Default::default()).to_cbor(),
        Cbor::Array(vec![]),
        Cbor::Array(vec![]),
    ]);
    assert_eq!(
        x.digest(),
        mdbn_wire::hash::h("mdbase/v1/state-digest", &enc(&old))
    );
    assert_eq!(
        hex(x.digest()),
        "ca00a5b12dd0bd1fd28826747e30e7b2acd9032ac16f17cdceadb3e84f32fb1f"
    );
}
fn index(f: &FileRow) -> DigestIndex {
    let mut x = DigestIndex::default();
    x.file(f).unwrap();
    x
}
#[test]
fn native_digest_binds_complete_live_tomb_and_cv6_rows_golden() {
    let mut f = row();
    let ordinary = index(&f).digest();
    f.kind = FileKindV1::UnindexedOversizedMarkdown;
    let mut x = index(&f);
    assert_ne!(ordinary, x.digest());
    let p = UnindexedMarkdownPayloadV1 {
        content: f.content.clone(),
    };
    x.tombstone(&TombstoneRow {
        id: B16([4; 16]),
        kind: EntityKind::File,
        path: "gone.md".into(),
        path_key: "gone.md".into(),
        last: TombstoneLast::UnindexedMarkdown(p.clone()),
        seq: 8,
        time: 17,
    })
    .unwrap();
    x.conflict(&ConflictRow {
        mutation: B16([5; 16]),
        seq: 9,
        conflict: rt::Conflict {
            kind: mdbn_wire::entry::ConflictKind::File,
            id: B16([6; 16]),
            field: None,
            base: Some(rt::ConflictValue::UnindexedMarkdown(p.clone())),
            kept: rt::ConflictValue::Legacy(mdbn_wire::entry::ConflictValue::Deleted),
            lost: rt::ConflictValue::UnindexedMarkdown(p),
        },
    });
    assert_eq!(
        hex(x.digest()),
        "ecc85f0f1c336d1180147a7bcdaee46a34fbf1df6d57fce407a4b4a20ff27707"
    );
    let before = x.digest();
    let FileContent::Blob(b) = &mut f.content else {
        panic!()
    };
    b.id_epoch = 2;
    b.blob_id = B32([7; 32]);
    let mut changed = index(&f);
    changed.native_tombs = x.native_tombs.clone();
    changed.tombs = x.tombs.clone();
    changed.native_conflicts = x.native_conflicts.clone();
    changed.conflicts = x.conflicts.clone();
    assert_ne!(before, changed.digest());
    let mut changed = x.clone();
    let key = *changed.native_tombs.keys().next().unwrap();
    if let Some(Cbor::Array(v)) = changed.native_tombs.get_mut(&key) {
        v[5] = Cbor::Uint(18);
    };
    assert_ne!(before, changed.digest());
    let mut changed = x.clone();
    let key = *changed.native_conflicts.keys().next().unwrap();
    if let Some(Cbor::Array(v)) = changed.native_conflicts.get_mut(&key) {
        v[1] = Cbor::Uint(10);
    };
    assert_ne!(before, changed.digest());
}
#[test]
fn staged_index_and_store_digest_agree_with_native_kind() {
    let mut f = row();
    f.kind = FileKindV1::UnindexedOversizedMarkdown;
    let mut store = crate::mem::MemStore::new();
    store
        .commit(Tx {
            files_put: vec![f.clone()],
            ..Tx::default()
        })
        .unwrap();
    assert_eq!(state_digest(&store).unwrap(), index(&f).digest());
}
