//! Trusted preparation checks stored identity and preserves failures without writes.
use super::{attachment_upload::attach_node, engine::settle};
use crate::{
    Store,
    fake::FakeLogService,
    replica::{AttachmentSource, UnindexedCaptureTarget},
    store::{FileLocal, FileRow, Tx},
};
use mdbn_wire::{
    attachment::FileContent,
    common::{B16, B32},
    hash::sha256,
    intent::{BlobRef, MediaClass},
    unindexed_markdown::{FileKindV1, UnindexedMarkdownPayloadV1},
};
struct Source(Vec<u8>);
impl AttachmentSource for Source {
    fn len(&self) -> u64 {
        self.0.len() as u64
    }
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<(), String> {
        let i = offset as usize;
        buf.copy_from_slice(&self.0[i..i + buf.len()]);
        Ok(())
    }
}
fn source() -> Box<dyn AttachmentSource> {
    Box::new(Source(vec![b'x'; 2_000_000]))
}
fn content() -> FileContent {
    FileContent::Blob(BlobRef {
        plain_hash: sha256(&vec![b'x'; 2_000_000]),
        size: 2_000_000,
        blob_id: B32([2; 32]),
        id_epoch: 1,
        part_size: 8_388_608,
    })
}
#[test]
fn create_proof_and_descriptor_binding_do_not_capture_or_acknowledge() {
    let svc = FakeLogService::new();
    let mut n = attach_node(&svc, 1);
    settle(&mut [&mut n]);
    let id = B16([17; 16]);
    let mut p =
        n.r.prepare_unindexed_markdown_capture(id, "notes/new.md".into(), source())
            .unwrap();
    assert_eq!(p.target(), &UnindexedCaptureTarget::Create);
    assert_eq!(p.size(), 2_000_000);
    assert_eq!(p.plain_hash(), content().plain_hash());
    let mut range = vec![0; 2_000_000];
    p.source_mut().read_at(0, &mut range).unwrap();
    assert!(matches!(
        p.operation(content()).unwrap(),
        mdbn_wire::attachment_runtime_v1::Op::UnindexedMarkdownPut(_)
    ));
    let mut wrong = content();
    let FileContent::Blob(b) = &mut wrong else {
        panic!()
    };
    b.plain_hash = B32([99; 32]);
    assert!(p.operation(wrong).is_err());
    assert!(n.r.store.file(&id).unwrap().is_none());
    assert!(n.r.store.pending(None, 16).unwrap().is_empty());
    n.r.policy.frozen = true;
    assert!(n.r.recheck_unindexed_markdown_capture(&p).is_err());
}
#[test]
fn authoritative_kind_and_same_hash_reseal_are_full_cas_not_extension_override() {
    let svc = FakeLogService::new();
    let mut n = attach_node(&svc, 1);
    settle(&mut [&mut n]);
    let id = B16([18; 16]);
    let mut row = FileRow {
        kind: FileKindV1::Ordinary,
        id,
        path: "notes/same.md".into(),
        path_key: "notes/same.md".into(),
        content: content(),
        media: MediaClass::Other,
        modified_seq: 1,
        bucket: 0,
        local: FileLocal::Remote,
    };
    n.r.store
        .commit(Tx {
            files_put: vec![row.clone()],
            ..Tx::default()
        })
        .unwrap();
    assert!(
        n.r.prepare_unindexed_markdown_capture(id, row.path.clone(), source())
            .is_err()
    );
    row.kind = FileKindV1::UnindexedOversizedMarkdown;
    n.r.store
        .commit(Tx {
            files_put: vec![row.clone()],
            ..Tx::default()
        })
        .unwrap();
    let p =
        n.r.prepare_unindexed_markdown_capture(id, row.path.clone(), source())
            .unwrap();
    assert_eq!(
        p.target(),
        &UnindexedCaptureTarget::Replace(UnindexedMarkdownPayloadV1 {
            content: row.content.clone()
        })
    );
    let FileContent::Blob(b) = &mut row.content else {
        panic!()
    };
    b.id_epoch += 1;
    b.blob_id = B32([19; 32]);
    n.r.store
        .commit(Tx {
            files_put: vec![row],
            ..Tx::default()
        })
        .unwrap();
    assert!(n.r.recheck_unindexed_markdown_capture(&p).is_err());
}
#[test]
fn whole_generation_catalog_path_and_health_changes_refuse_prepared_capture() {
    let svc = FakeLogService::new();
    let mut n = attach_node(&svc, 1);
    settle(&mut [&mut n]);
    let id = B16([20; 16]);
    for path in ["../unsafe.md", "file.bin", "mdbase.yaml"] {
        assert!(
            n.r.prepare_unindexed_markdown_capture(id, path.into(), source())
                .is_err()
        );
    }
    let p =
        n.r.prepare_unindexed_markdown_capture(id, "notes/new.md".into(), source())
            .unwrap();
    n.r.store_generation += 1;
    assert!(n.r.recheck_unindexed_markdown_capture(&p).is_err());
    n.r.store_generation -= 1;
    n.r.pending_keys.insert(999, vec!["r:schema.yaml".into()]);
    assert!(n.r.recheck_unindexed_markdown_capture(&p).is_err());
    n.r.pending_keys.clear();
    n.r.store
        .commit(Tx {
            resources_put: vec![("schema.yaml".into(), "types: {}\n".into())],
            ..Tx::default()
        })
        .unwrap();
    assert!(n.r.recheck_unindexed_markdown_capture(&p).is_err());
    n.r.caught_up = false;
    assert!(
        n.r.prepare_unindexed_markdown_capture(id, "notes/other.md".into(), source())
            .is_err()
    );
}

#[test]
fn live_record_source_cas_and_kind_bind_same_id_and_exact_path() {
    use crate::store::{RecordMeta, RecordRow};
    let svc = FakeLogService::new();
    let mut n = attach_node(&svc, 1);
    settle(&mut [&mut n]);
    let id = B16([21; 16]);
    let doc = "old body\n".to_string();
    let mut row = RecordRow {
        id,
        path: "notes/current.md".into(),
        path_key: "notes/current.md".into(),
        revision: sha256(doc.as_bytes()),
        doc,
        modified_seq: 1,
        bucket: 0,
        meta: RecordMeta::default(),
    };
    n.r.store
        .commit(Tx {
            records_put: vec![row.clone()],
            ..Tx::default()
        })
        .unwrap();
    let p =
        n.r.prepare_unindexed_markdown_capture(id, row.path.clone(), source())
            .unwrap();
    assert_eq!(p.target(), &UnindexedCaptureTarget::Record(row.revision));
    assert!(matches!(
        p.operation(content()).unwrap(),
        mdbn_wire::attachment_runtime_v1::Op::RecordToUnindexedMarkdown(_)
    ));
    assert!(
        n.r.prepare_unindexed_markdown_capture(id, "notes/moved.md".into(), source())
            .is_err()
    );
    row.doc = "concurrent edit\n".into();
    row.revision = sha256(row.doc.as_bytes());
    n.r.store
        .commit(Tx {
            records_put: vec![row],
            ..Tx::default()
        })
        .unwrap();
    assert!(n.r.recheck_unindexed_markdown_capture(&p).is_err());
}
