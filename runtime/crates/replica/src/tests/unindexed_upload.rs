use super::{engine::Node, unindexed_async::node};
use crate::{
    log::{LogPort, LogRequest, LogResponse},
    replica::{AttachmentSource, UnindexedUploadStatus},
    store::Store,
};
use mdbn_wire::schema::Wire;
use mdbn_wire::{
    common::{B16, Hash},
    envelope::ItemKind,
};
use std::{cell::RefCell, collections::BTreeMap, rc::Rc};
struct Source(Rc<RefCell<Vec<u8>>>);
impl AttachmentSource for Source {
    fn len(&self) -> u64 {
        self.0.borrow().len() as u64
    }
    fn read_at(&mut self, at: u64, buf: &mut [u8]) -> Result<(), String> {
        assert!(buf.len() <= 8 * 1048576);
        let v = self.0.borrow();
        buf.copy_from_slice(v.get(at as usize..at as usize + buf.len()).ok_or("short")?);
        Ok(())
    }
}
fn start(a: &mut Node) -> (B16, Rc<RefCell<Vec<u8>>>) {
    let source = Rc::new(RefCell::new(vec![b'x'; 1048577]));
    let p =
        a.r.prepare_unindexed_markdown_capture(
            B16([77; 16]),
            "large.md".into(),
            Box::new(Source(source.clone())),
        )
        .unwrap();
    (a.r.start_unindexed_markdown_upload(p).unwrap(), source)
}
fn drive(a: &mut Node, id: B16, lose_put: bool) -> (BTreeMap<Hash, Vec<u8>>, Vec<ItemKind>) {
    let mut objects = BTreeMap::new();
    let mut kinds = Vec::new();
    let mut lost = false;
    for _ in 0..32 {
        if !matches!(
            a.r.unindexed_markdown_upload_status(&id),
            Some(UnindexedUploadStatus::Uploading { .. })
        ) {
            break;
        }
        let calls = a.r.take_log_calls();
        for call in calls {
            let reply = match call.request {
                LogRequest::PutObject {
                    address,
                    kind,
                    bytes,
                    ..
                } => {
                    assert!(bytes.len() as u64 <= crate::attachments::MAX_SEALED_CHUNK);
                    objects.insert(address, bytes);
                    kinds.push(kind);
                    if lose_put && !lost {
                        lost = true;
                        Err(crate::log::LogError::Offline)
                    } else {
                        Ok(LogResponse::PutObject { existed: false })
                    }
                }
                LogRequest::HasObjects { addresses, .. } => Ok(LogResponse::HasObjects(
                    addresses.iter().map(|a| objects.contains_key(a)).collect(),
                )),
                _ => continue,
            };
            a.r.on_unindexed_upload_reply(id, call.id, reply);
        }
        a.clock.set(a.clock.get() + 10000);
        a.r.unindexed_upload_step();
    }
    (objects, kinds)
}
#[test]
fn public_capture_plans_critical_native_append_and_refuses_epoch_drift() {
    let mut a = node();
    let (id, _) = start(&mut a);
    drive(&mut a, id, false);
    let capsule = a.r.take_prepared_unindexed_upload(&id).unwrap();
    let receipt = a.r.capture_prepared_unindexed_upload(capsule).unwrap();
    let rows = a.r.store.pending(None, 16).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].mutation.id, receipt.mutation);
    assert_eq!(rows[0].refs.len(), 2);
    crate::replica::attachment_upload::check_row_refs(&rows[0]).unwrap();
    let mut malformed = rows[0].clone();
    malformed.refs.reverse();
    assert!(crate::replica::attachment_upload::check_row_refs(&malformed).is_err());
    malformed = rows[0].clone();
    malformed.refs.push(malformed.refs[0]);
    assert!(crate::replica::attachment_upload::check_row_refs(&malformed).is_err());
    malformed = rows[0].clone();
    malformed.refs.clear();
    assert!(crate::replica::attachment_upload::check_row_refs(&malformed).is_err());
    assert_eq!(rows[0].mutation.on_behalf, None);
    assert!(matches!(
        rows[0].mutation.ops[0],
        mdbn_wire::attachment_runtime_v1::Op::UnindexedMarkdownPut(_)
    ));
    assert!(a.r.store.file(&B16([77; 16])).unwrap().is_none());
    let calls = a.r.take_log_calls();
    let append = calls
        .iter()
        .find_map(|c| match &c.request {
            LogRequest::Append(p) => Some(p),
            _ => None,
        })
        .expect("native append queued");
    assert_eq!(append.items.len(), 1);
    let raw = &append.items[0].0;
    let item = mdbn_wire::envelope::Item::from_bytes(raw).unwrap();
    assert_eq!(item.refs.as_ref(), Some(&rows[0].refs));
    assert_eq!(item.signer, Some(a.r.cfg.device_id));
    let plain = a.r.sealer.open(&item, raw).unwrap();
    let payload = mdbn_wire::attachment_runtime_v1::EntryPayload::from_bytes(&plain).unwrap();
    assert_eq!(payload.mutation.id, receipt.mutation);
    assert!(matches!(
        payload.effects.as_slice(),
        [mdbn_wire::attachment_runtime_v1::Effect::PutUnindexedMarkdown(_)]
    ));
    let mut b = node();
    let (id, _) = start(&mut b);
    drive(&mut b, id, false);
    let capsule = b.r.take_prepared_unindexed_upload(&id).unwrap();
    b.r.policy.epoch += 1;
    assert!(b.r.capture_prepared_unindexed_upload(capsule).is_err());
    assert_eq!(b.r.store.pending_count().unwrap(), 0);
}
#[test]
fn stores_chunks_then_manifest_and_returns_capsule_without_capture() {
    let mut a = node();
    let head = a.r.store.head().unwrap();
    let (id, _) = start(&mut a);
    let (objects, kinds) = drive(&mut a, id, false);
    assert_eq!(kinds, vec![ItemKind::Chunk, ItemKind::Manifest]);
    assert_eq!(
        a.r.unindexed_markdown_upload_status(&id),
        Some(UnindexedUploadStatus::Prepared)
    );
    let capsule = a.r.take_prepared_unindexed_upload(&id).unwrap();
    assert_eq!(capsule.content().total_plain_bytes, 1048577);
    assert_eq!(capsule.refs().len(), 2);
    assert!(capsule.refs().windows(2).all(|w| w[0] < w[1]));
    assert!(capsule.refs().iter().all(|h| objects.contains_key(h)));
    a.r.recheck_prepared_unindexed_upload(&capsule).unwrap();
    struct Count(u64);
    impl crate::attachments::PlainSink for Count {
        fn write(&mut self, offset: u64, plain: &[u8]) -> Result<(), String> {
            assert_eq!(offset, self.0);
            assert!(plain.iter().all(|b| *b == b'x'));
            self.0 += plain.len() as u64;
            Ok(())
        }
    }
    let mut sink = Count(0);
    let mut reader = crate::replica::UnindexedSourceReader::new(
        &*a.r.sealer,
        mdbn_wire::attachment::FileContent::AttachmentV1(capsule.content().clone()),
        a.r.cfg.collection,
    )
    .unwrap();
    while let Some(need) = reader.need() {
        let address = match need {
            crate::replica::UnindexedSourceNeed::Attachment(
                crate::attachments::Need::Manifest { address }
                | crate::attachments::Need::Chunk { address, .. },
            ) => address,
            _ => panic!("wrong profile"),
        };
        reader
            .supply(&*a.r.sealer, objects.get(&address).unwrap(), &mut sink)
            .unwrap();
    }
    assert_eq!(reader.finish().unwrap().size(), 1048577);
    assert_eq!(sink.0, 1048577);
    assert_eq!(a.r.store.pending_count().unwrap(), 0);
    assert_eq!(a.r.store.head().unwrap(), head);
    assert!(a.r.store.file(&B16([77; 16])).unwrap().is_none());
}
#[test]
fn uncertain_put_is_probed_without_resealing_or_duplicate_write() {
    let mut a = node();
    let (id, _) = start(&mut a);
    let (objects, kinds) = drive(&mut a, id, true);
    assert_eq!(objects.len(), 2);
    assert_eq!(kinds, vec![ItemKind::Chunk, ItemKind::Manifest]);
    assert_eq!(
        a.r.unindexed_markdown_upload_status(&id),
        Some(UnindexedUploadStatus::Prepared)
    );
    assert_eq!(a.r.store.pending_count().unwrap(), 0);
}
#[test]
fn epoch_change_after_preparation_cannot_take_or_authorize_capsule() {
    let mut a = node();
    let (id, _) = start(&mut a);
    drive(&mut a, id, false);
    a.r.policy.epoch += 1;
    assert!(a.r.take_prepared_unindexed_upload(&id).is_err());
    assert_eq!(a.r.store.pending_count().unwrap(), 0);
}
#[test]
fn source_changed_after_preparation_before_read_is_refused() {
    let mut a = node();
    let source = Rc::new(RefCell::new(vec![b'x'; 1048577]));
    let p =
        a.r.prepare_unindexed_markdown_capture(
            B16([77; 16]),
            "large.md".into(),
            Box::new(Source(source.clone())),
        )
        .unwrap();
    source.borrow_mut()[0] = b'y';
    let id = a.r.start_unindexed_markdown_upload(p).unwrap();
    assert!(matches!(
        a.r.unindexed_markdown_upload_status(&id),
        Some(UnindexedUploadStatus::Failed(_))
    ));
    assert_eq!(a.r.store.pending_count().unwrap(), 0);
    assert!(
        !a.r.take_log_calls()
            .iter()
            .any(|c| matches!(c.request, LogRequest::PutObject { .. }))
    );
}
