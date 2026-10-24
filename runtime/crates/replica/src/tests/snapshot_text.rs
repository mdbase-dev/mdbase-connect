use super::{
    engine::Node,
    unindexed_snapshot::{build, receiver, reply_install},
};
use crate::{
    log::{LogPort, LogRequest, LogResponse},
    replica::append::Inflight,
    store::{RecordRow, Store, Tx},
};
use mdbn_wire::{
    attachment_runtime_v1 as rt,
    common::{B16, Hash},
    envelope::{Item, ItemKind},
    schema::Wire,
    snapshot::{RecordRow as WRecordRow, TextOrBlob},
};
use std::collections::BTreeMap;
type Objects = BTreeMap<Hash, Vec<u8>>;
fn fixture(doc: &str, source: &[u8]) -> (Node, rt::ManifestPayload, Hash, Objects) {
    let (mut a, _, _, mut objects) = build(false);
    let id = B16([71; 16]);
    let path = "small.md".to_string();
    let catalog = mdbn_core::types::Catalog::load(std::iter::empty::<(&str, &str)>());
    a.r.store
        .commit(Tx {
            records_put: vec![RecordRow {
                id,
                path_key: path.clone(),
                path: path.clone(),
                doc: doc.into(),
                revision: mdbn_wire::hash::sha256(doc.as_bytes()),
                modified_seq: 1,
                bucket: crate::store::bucket16(&id),
                meta: crate::plan::record_meta(&catalog, &path, doc),
            }],
            ..Tx::default()
        })
        .unwrap();
    a.r.build = None;
    a.r.test_build_native_snapshot().unwrap();
    let mut manifest = None;
    for c in a.r.take_log_calls() {
        if let LogRequest::PutObject {
            address,
            bytes,
            kind,
            ..
        } = c.request
        {
            if kind == ItemKind::Manifest {
                manifest = Some(address)
            }
            objects.insert(address, bytes);
        }
    }
    let h = manifest.unwrap();
    let mut item = Item::from_bytes(&objects[&h]).unwrap();
    let plain = a.r.sealer.open(&item, &objects[&h]).unwrap();
    let mut m = rt::ManifestPayload::from_bytes(&plain).unwrap();
    let (blob, parts) =
        a.r.sealer
            .seal_bounded_record_source(source, &mut *a.r.host.entropy)
            .unwrap();
    let refs = parts.iter().map(|p| p.address).collect::<Vec<_>>();
    for p in parts {
        objects.insert(p.address, p.bytes);
    }
    for s in &mut m.sections {
        if s.kind == rt::SectionKind::Legacy(mdbn_wire::snapshot::SectionKind::Records) {
            for r in &mut s.chunks {
                let old = objects[&r.address].clone();
                let mut chunk_item = Item::from_bytes(&old).unwrap();
                let plain = a.r.sealer.open(&chunk_item, &old).unwrap();
                let mut chunk = rt::ChunkPayload::from_bytes(&plain).unwrap();
                let mut rows = chunk.rows_as::<WRecordRow>().unwrap();
                if !rows.iter().any(|r| r.id == id) {
                    continue;
                }
                for row in &mut rows {
                    if row.id == id {
                        row.doc = TextOrBlob::Blob(blob.clone());
                    }
                }
                chunk.rows = rows.iter().map(Wire::to_cbor).collect();
                let plain = chunk.to_bytes().unwrap();
                a.r.sealer
                    .seal_object(&mut chunk_item, &plain, true, false, &mut *a.r.host.entropy)
                    .unwrap();
                let raw = chunk_item.to_bytes().unwrap();
                let address = mdbn_wire::hash::sha256(&raw);
                item.refs.as_mut().unwrap().retain(|h| *h != r.address);
                item.refs.as_mut().unwrap().push(address);
                r.address = address;
                r.plain_hash = mdbn_wire::hash::sha256(&plain);
                r.plain_size = plain.len() as u64;
                objects.insert(address, raw);
            }
        }
    }
    item.refs.as_mut().unwrap().extend(refs);
    item.refs.as_mut().unwrap().sort();
    item.refs.as_mut().unwrap().dedup();
    a.r.sealer
        .seal_object(
            &mut item,
            &m.to_bytes().unwrap(),
            true,
            true,
            &mut *a.r.host.entropy,
        )
        .unwrap();
    let raw = item.to_bytes().unwrap();
    let h = mdbn_wire::hash::sha256(&raw);
    objects.insert(h, raw);
    (a, m, h, objects)
}
fn start(a: &Node, m: &rt::ManifestPayload, h: Hash, objects: &Objects) -> Node {
    let mut b = receiver(a, m, h);
    b.r.test_on_native_snapshot_reply(Ok(LogResponse::GetObject {
        size: objects[&h].len() as u64,
        checksum: h,
        bytes: objects[&h].clone(),
    }));
    b
}
fn finish(b: &mut Node, objects: &Objects, corrupt: bool) {
    for _ in 0..64 {
        if !b.r.installing() {
            return;
        }
        for c in b.r.take_log_calls() {
            let bad = corrupt && matches!(b.r.inflight.get(&c.id), Some(Inflight::InstallText));
            reply_install(b, c, objects, bad);
        }
        b.r.retry_install();
    }
    panic!("snapshot did not finish")
}
#[test]
fn exact_cap_blob_record_is_hydrated_staged_and_swapped_with_native_rows() {
    let mut bytes = "---\r\ntitle: 🪴\r\n---\r\nexact\0é\r\n"
        .as_bytes()
        .to_vec();
    bytes.resize(1048576, b'x');
    let doc = std::str::from_utf8(&bytes).unwrap();
    let (a, m, h, objects) = fixture(doc, &bytes);
    let mut b = start(&a, &m, h, &objects);
    finish(&mut b, &objects, false);
    assert_eq!(b.r.stats.snapshots_installed, 1);
    let r = b.r.store.record(&B16([71; 16])).unwrap().unwrap();
    assert_eq!(r.doc.as_bytes(), bytes);
    assert_eq!(r.path, "small.md");
    assert_eq!(
        crate::replica::state_digest(&b.r.store).unwrap(),
        m.state_digest
    );
}
#[test]
fn empty_blob_record_roundtrips_exactly() {
    let (a, m, h, objects) = fixture("", b"");
    let mut b = start(&a, &m, h, &objects);
    finish(&mut b, &objects, false);
    assert_eq!(b.r.stats.snapshots_installed, 1);
    assert_eq!(b.r.store.record(&B16([71; 16])).unwrap().unwrap().doc, "");
}
#[test]
fn record_source_corruption_and_authenticated_invalid_utf8_keep_old_prefix() {
    for invalid in [false, true] {
        let (a, m, h, objects) = fixture("doc", if invalid { &[0xff] } else { b"doc" });
        let mut b = start(&a, &m, h, &objects);
        let old = b.r.store.head().unwrap();
        finish(&mut b, &objects, !invalid);
        assert_eq!(b.r.stats.snapshots_installed, 0);
        assert_eq!(b.r.store.head().unwrap(), old);
        assert!(b.r.store.record(&B16([71; 16])).unwrap().is_none());
        assert!(b.r.store.file(&B16([61; 16])).unwrap().is_none());
    }
}
#[test]
fn record_source_old_generation_callback_cannot_authorize_swap() {
    let (a, m, h, objects) = fixture("doc", b"doc");
    let mut b = start(&a, &m, h, &objects);
    let old = b.r.store.head().unwrap();
    let mut found = false;
    for _ in 0..64 {
        for c in b.r.take_log_calls() {
            if matches!(b.r.inflight.get(&c.id), Some(Inflight::InstallText)) {
                b.r.store_generation += 1;
                found = true;
                reply_install(&mut b, c, &objects, false);
                break;
            }
            reply_install(&mut b, c, &objects, false);
        }
        if found {
            break;
        }
    }
    assert!(found);
    assert_eq!(b.r.stats.snapshots_installed, 0);
    assert_eq!(b.r.store.head().unwrap(), old);
    assert!(b.r.store.record(&B16([71; 16])).unwrap().is_none());
}
