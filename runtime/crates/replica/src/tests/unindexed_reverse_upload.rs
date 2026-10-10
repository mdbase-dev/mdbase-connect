use super::{
    engine::Node,
    unindexed_async::{contents, node},
};
use crate::{
    file_source::{FileSourceReader, SourceNeed},
    log::{LogError, LogPort, LogRequest, LogResponse},
    replica::{AttachmentSource, UnindexedUploadStatus},
    store::{FileLocal, FileRow, Store, Tx},
};
use mdbn_wire::{
    attachment::FileContent,
    attachment_runtime_v1 as rt,
    common::{B16, Hash, Text},
    entry::{TextDef, TextDefForm},
    envelope::{Item, ItemKind},
    intent::MediaClass,
    schema::Wire,
    unindexed_markdown::FileKindV1,
};
use std::collections::BTreeMap;
struct Source(Vec<u8>);
impl AttachmentSource for Source {
    fn len(&self) -> u64 {
        self.0.len() as u64
    }
    fn read_at(&mut self, o: u64, b: &mut [u8]) -> Result<(), String> {
        b.copy_from_slice(&self.0[o as usize..o as usize + b.len()]);
        Ok(())
    }
}
fn start(a: &mut Node, bytes: &[u8]) -> (B16, FileRow) {
    let (content, _) = contents(a, &vec![b'x'; 1048577], false);
    let f = FileRow {
        id: B16([61; 16]),
        path: "large.md".into(),
        path_key: "large.md".into(),
        content,
        kind: FileKindV1::UnindexedOversizedMarkdown,
        media: MediaClass::Other,
        modified_seq: 1,
        bucket: 0,
        local: FileLocal::Remote,
    };
    a.r.store
        .commit(Tx {
            files_put: vec![f.clone()],
            ..Tx::default()
        })
        .unwrap();
    let proof = a
        .r
        .prepare_unindexed_markdown_reindex(f.id, f.path.clone(), Box::new(Source(bytes.to_vec())))
        .unwrap();
    (
        a.r.start_unindexed_markdown_reindex_upload(proof).unwrap(),
        f,
    )
}
fn drive(a: &mut Node, id: B16, lose: bool) -> (BTreeMap<Hash, Vec<u8>>, usize, usize) {
    let mut objects = BTreeMap::new();
    let mut puts = 0;
    let mut probes = 0;
    let mut lost = false;
    for _ in 0..32 {
        if !matches!(
            a.r.unindexed_markdown_reindex_upload_status(&id),
            Some(UnindexedUploadStatus::Uploading { .. })
        ) {
            break;
        }
        for c in a.r.take_log_calls() {
            let reply = match c.request {
                LogRequest::PutObject {
                    address,
                    bytes,
                    kind,
                    ..
                } => {
                    assert_eq!(kind, ItemKind::BlobPart);
                    puts += 1;
                    objects.insert(address, bytes);
                    if lose && !lost {
                        lost = true;
                        Err(LogError::NoResponse)
                    } else {
                        Ok(LogResponse::PutObject { existed: false })
                    }
                }
                LogRequest::HasObjects { addresses, .. } => {
                    probes += 1;
                    Ok(LogResponse::HasObjects(
                        addresses.iter().map(|h| objects.contains_key(h)).collect(),
                    ))
                }
                _ => continue,
            };
            a.r.on_log_reply(c.id, reply);
        }
        a.clock.set(a.clock.get() + 10000);
        a.r.unindexed_reverse_upload_step();
    }
    (objects, puts, probes)
}
#[test]
fn native_holder_reverse_exact_cap_emits_blob_table_gc_refs_and_other_replica_reads_identically() {
    let mut a = node();
    let mut bytes = "---\r\ntitle: exact\r\n---\r\n🪴\0é\r\n"
        .as_bytes()
        .to_vec();
    bytes.resize(1048576, b'x');
    let head = a.r.store.head().unwrap();
    let (id, f) = start(&mut a, &bytes);
    let (objects, puts, _) = drive(&mut a, id, false);
    assert_eq!(puts, 1);
    assert_eq!(
        a.r.unindexed_markdown_reindex_upload_status(&id),
        Some(UnindexedUploadStatus::Prepared)
    );
    assert_eq!(a.r.store.pending_count().unwrap(), 0);
    let p = a.r.take_prepared_unindexed_reindex_upload(&id).unwrap();
    let refs = p.refs().to_vec();
    let receipt =
        a.r.test_capture_prepared_unindexed_reindex_upload(p)
            .unwrap();
    let row = a.r.store.pending_get(&receipt.mutation).unwrap().unwrap();
    assert_eq!(row.refs, refs);
    assert_eq!(row.uploads.len(), 1);
    assert_eq!(a.r.store.file(&f.id).unwrap(), Some(f));
    assert_eq!(a.r.store.head().unwrap(), head);
    let append =
        a.r.take_log_calls()
            .into_iter()
            .find_map(|c| {
                if let LogRequest::Append(p) = c.request {
                    Some(p)
                } else {
                    None
                }
            })
            .expect("queued critical signed entry");
    assert_eq!(append.items.len(), 1);
    let raw = &append.items[0].0;
    assert!(raw.len() < 1048576);
    let item = Item::from_bytes(raw).unwrap();
    assert_eq!(item.refs.as_ref(), Some(&refs));
    assert!(crate::crypto::sign::verify_item(
        &a.r.sealer.public_identity().unwrap().sign_pk.0,
        &item
    ));
    let mut other = node();
    other.r.cfg.device_id = B16([102; 16]);
    let mut keys = crate::crypto::keys::Keyring::new();
    keys.insert(1, crate::crypto::Secret32([9; 32]));
    let keybytes = keys.to_bytes();
    let mut saved = zeroize::Zeroizing::new((keybytes.len() as u64).to_be_bytes().to_vec());
    saved.extend_from_slice(&keybytes);
    let mut sealer = crate::seal::KeyringSealer::new(
        other.r.cfg.collection,
        other.r.cfg.device_id,
        &[20; 32],
        &[21; 32],
    );
    crate::seal::Sealer::import(&mut sealer, &saved).unwrap();
    crate::seal::Sealer::set_epoch(&mut sealer, 1);
    other.r.sealer = Box::new(sealer);
    assert_ne!(
        other.r.sealer.public_identity().unwrap().device,
        a.r.sealer.public_identity().unwrap().device
    );
    let plain = other.r.sealer.open(&item, raw).unwrap();
    let payload = rt::EntryPayload::from_bytes(&plain).unwrap();
    let [rt::Op::UnindexedMarkdownToRecord(op)] = payload.mutation.ops.as_slice() else {
        panic!()
    };
    assert_eq!(op.doc, Text::Index(0));
    assert!(
        payload
            .effects
            .iter()
            .any(|e| matches!(e,rt::Effect::ReindexUnindexedMarkdown(e) if e.doc==Text::Index(0)))
    );
    let [TextDef::Form(TextDefForm::Blob(t))] = payload.texts.as_ref().unwrap().as_slice() else {
        panic!()
    };
    assert_eq!(t.blob.size, 1048576);
    let mut reader =
        FileSourceReader::new(&*other.r.sealer, FileContent::Blob(t.blob.clone()), 1048576)
            .unwrap();
    while let Some(need) = reader.need().unwrap() {
        let SourceNeed::BlobPart { address, .. } = need else {
            panic!()
        };
        assert!(refs.contains(&address));
        reader
            .supply(&*other.r.sealer, need, &objects[&address])
            .unwrap();
    }
    let authenticated = reader.finish().unwrap();
    assert_eq!(authenticated.bytes(), bytes);
    assert_eq!(
        authenticated.descriptor(),
        &FileContent::Blob(t.blob.clone())
    );
}
#[test]
fn reverse_unknown_put_probes_exact_address_without_resealing() {
    let mut a = node();
    let (id, _) = start(&mut a, b"exact\r\n");
    let (objects, puts, probes) = drive(&mut a, id, true);
    assert_eq!(objects.len(), 1);
    assert_eq!(puts, 1);
    assert_eq!(probes, 2);
    assert_eq!(
        a.r.unindexed_markdown_reindex_upload_status(&id),
        Some(UnindexedUploadStatus::Prepared)
    );
    assert_eq!(a.r.store.pending_count().unwrap(), 0);
}
#[test]
fn reverse_declared_ref_is_not_complete_closure_and_cancel_has_no_mutation() {
    let mut a = node();
    let (id, _) = start(&mut a, b"doc");
    for _ in 0..8 {
        for call in a.r.take_log_calls() {
            let reply = match call.request {
                LogRequest::PutObject { .. } => Ok(LogResponse::PutObject { existed: false }),
                LogRequest::HasObjects { addresses, .. } => {
                    Ok(LogResponse::HasObjects(vec![false; addresses.len()]))
                }
                _ => continue,
            };
            a.r.on_log_reply(call.id, reply);
        }
        if !matches!(
            a.r.unindexed_markdown_reindex_upload_status(&id),
            Some(UnindexedUploadStatus::Uploading { .. })
        ) {
            break;
        }
    }
    assert!(
        matches!(a.r.unindexed_markdown_reindex_upload_status(&id),Some(UnindexedUploadStatus::Failed(ref p)) if p.reason.as_deref()==Some("refs_missing"))
    );
    assert!(a.r.take_prepared_unindexed_reindex_upload(&id).is_err());
    assert_eq!(a.r.store.pending_count().unwrap(), 0);
    let mut b = node();
    let (id, _) = start(&mut b, b"doc");
    b.r.cancel_unindexed_markdown_reindex_upload(&id);
    assert!(b.r.unindexed_markdown_reindex_upload_status(&id).is_none());
    assert_eq!(b.r.store.pending_count().unwrap(), 0);
}
#[test]
fn reverse_take_and_capture_recheck_epoch_and_full_holder() {
    let mut a = node();
    let (id, mut f) = start(&mut a, b"doc");
    drive(&mut a, id, false);
    let p = a.r.take_prepared_unindexed_reindex_upload(&id).unwrap();
    f.path = "renamed.md".into();
    f.path_key = f.path.clone();
    a.r.store
        .commit(Tx {
            files_put: vec![f],
            ..Tx::default()
        })
        .unwrap();
    assert!(
        a.r.test_capture_prepared_unindexed_reindex_upload(p)
            .is_err()
    );
    assert_eq!(a.r.store.pending_count().unwrap(), 0);
    let mut b = node();
    let (id, _) = start(&mut b, b"doc");
    drive(&mut b, id, false);
    b.r.policy.epoch += 1;
    assert!(b.r.take_prepared_unindexed_reindex_upload(&id).is_err());
    assert_eq!(b.r.store.pending_count().unwrap(), 0);
}
