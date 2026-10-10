use super::{attachment_upload::attach_node, engine::Node};
use crate::{
    fake::FakeLogService,
    replica::AttachmentSource,
    store::{FileLocal, FileRow, Store, Tx},
};
use mdbn_wire::{
    attachment::FileContent,
    common::{B16, B32},
    intent::{BlobRef, MediaClass},
    unindexed_markdown::FileKindV1,
};
struct Source(Vec<u8>);
impl AttachmentSource for Source {
    fn len(&self) -> u64 {
        self.0.len() as u64
    }
    fn read_at(&mut self, o: u64, b: &mut [u8]) -> Result<(), String> {
        assert_eq!(o, 0);
        assert!(b.len() <= 1048576);
        b.copy_from_slice(&self.0);
        Ok(())
    }
}
fn node() -> (Node, FileRow) {
    let mut n = attach_node(&FakeLogService::new(), 1);
    let f = FileRow {
        id: B16([61; 16]),
        path: "large.md".into(),
        path_key: "large.md".into(),
        kind: FileKindV1::UnindexedOversizedMarkdown,
        content: FileContent::Blob(BlobRef {
            plain_hash: B32([3; 32]),
            size: 2000000,
            blob_id: B32([4; 32]),
            id_epoch: 1,
            part_size: 8388608,
        }),
        media: MediaClass::Other,
        modified_seq: 1,
        bucket: 0,
        local: FileLocal::Remote,
    };
    n.r.store
        .commit(Tx {
            files_put: vec![f.clone()],
            ..Tx::default()
        })
        .unwrap();
    (n, f)
}
#[test]
fn reverse_cap_boundary_and_exact_bytes_prepare_without_capture() {
    let (n, f) = node();
    let head = n.r.store.head().unwrap();
    for size in [0, 1, 1048576] {
        let p =
            n.r.prepare_unindexed_markdown_reindex(
                f.id,
                f.path.clone(),
                Box::new(Source(vec![b'x'; size])),
            )
            .unwrap();
        assert_eq!(p.size(), size as u64);
        n.r.recheck_unindexed_markdown_reindex(&p).unwrap();
        let mdbn_wire::attachment_runtime_v1::Op::UnindexedMarkdownToRecord(o) = p.operation()
        else {
            panic!()
        };
        assert_eq!(o.prior.content, f.content);
        assert_eq!(o.doc, mdbn_wire::common::Text::Inline("x".repeat(size)));
    }
    assert_eq!(n.r.store.head().unwrap(), head);
    assert_eq!(n.r.store.pending_count().unwrap(), 0);
    assert_eq!(n.r.store.file(&f.id).unwrap(), Some(f));
}
#[test]
fn oversized_and_invalid_utf8_and_ordinary_holder_refuse() {
    let (mut n, mut f) = node();
    assert!(
        n.r.prepare_unindexed_markdown_reindex(
            f.id,
            f.path.clone(),
            Box::new(Source(vec![b'x'; 1048577]))
        )
        .is_err()
    );
    assert!(
        n.r.prepare_unindexed_markdown_reindex(f.id, f.path.clone(), Box::new(Source(vec![0xff])))
            .is_err()
    );
    f.kind = FileKindV1::Ordinary;
    n.r.store
        .commit(Tx {
            files_put: vec![f.clone()],
            ..Tx::default()
        })
        .unwrap();
    assert!(
        n.r.prepare_unindexed_markdown_reindex(f.id, f.path, Box::new(Source(b"doc".to_vec())))
            .is_err()
    );
    assert_eq!(n.r.store.pending_count().unwrap(), 0);
}
#[test]
fn reverse_source_bridge_is_data_only_and_rechecks_holder() {
    let (_, mut f) = node();
    let mut n = super::unindexed_async::node();
    n.r.store
        .commit(Tx {
            files_put: vec![f.clone()],
            ..Tx::default()
        })
        .unwrap();
    let head = n.r.store.head().unwrap();
    let bytes = "---\r\ntitle: exact\r\n---\r\n🪴\0é".as_bytes();
    let p = n
        .r
        .prepare_unindexed_markdown_reindex(f.id, f.path.clone(), Box::new(Source(bytes.to_vec())))
        .unwrap();
    let (source, parts) = n.r.seal_unindexed_markdown_reindex_source(&p).unwrap();
    assert_eq!(source.size, bytes.len() as u64);
    assert_eq!(source.plain_hash, mdbn_wire::hash::sha256(bytes));
    assert_eq!(
        &*n.r
            .sealer
            .open_blob_part(&source, 0, &parts[0].bytes, 1048576)
            .unwrap(),
        bytes
    );
    assert_eq!(n.r.store.head().unwrap(), head);
    assert_eq!(n.r.store.pending_count().unwrap(), 0);
    assert_eq!(n.r.store.file(&f.id).unwrap(), Some(f.clone()));
    f.path = "renamed.md".into();
    f.path_key = f.path.clone();
    n.r.store
        .commit(Tx {
            files_put: vec![f],
            ..Tx::default()
        })
        .unwrap();
    assert!(n.r.seal_unindexed_markdown_reindex_source(&p).is_err());
    assert_eq!(n.r.store.pending_count().unwrap(), 0);
}
#[test]
fn full_prior_epoch_reseal_and_health_change_cannot_reuse_reverse_proof() {
    let (mut n, mut f) = node();
    let p = n
        .r
        .prepare_unindexed_markdown_reindex(f.id, f.path.clone(), Box::new(Source(b"doc".to_vec())))
        .unwrap();
    n.r.policy.frozen = true;
    assert!(n.r.recheck_unindexed_markdown_reindex(&p).is_err());
    n.r.policy.frozen = false;
    let FileContent::Blob(b) = &mut f.content else {
        panic!()
    };
    b.id_epoch += 1;
    b.blob_id = B32([5; 32]);
    n.r.store
        .commit(Tx {
            files_put: vec![f],
            ..Tx::default()
        })
        .unwrap();
    assert!(n.r.recheck_unindexed_markdown_reindex(&p).is_err());
    assert_eq!(n.r.store.pending_count().unwrap(), 0);
}
