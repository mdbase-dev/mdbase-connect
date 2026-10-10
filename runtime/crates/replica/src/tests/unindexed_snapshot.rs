//! Guarded native snapshot build/install with production cryptography.
use super::{
    engine::Node,
    unindexed_async::{contents, node},
};
use crate::{
    log::{LogPort, LogRequest, LogResponse},
    replica::{
        append::Inflight,
        snapshot::{ControlPoint, Install},
    },
    store::{ConflictRow, FileLocal, FileRow, Head, Store, TombstoneLast, TombstoneRow, Tx},
};
use mdbn_wire::{
    attachment::FileContent,
    attachment_runtime_v1 as rt,
    common::{B16, B32, Hash},
    envelope::{Item, ItemKind},
    intent::MediaClass,
    log_service::SnapshotPointer,
    schema::Wire,
    snapshot::EntityKind,
    unindexed_markdown::{FileKindV1, UnindexedMarkdownPayloadV1},
};
use std::collections::BTreeMap;
type Objects = BTreeMap<Hash, Vec<u8>>;
fn file(id: u8, c: FileContent) -> FileRow {
    FileRow {
        id: B16([id; 16]),
        path: format!("native-{id}.md"),
        path_key: format!("native-{id}.md"),
        content: c,
        kind: FileKindV1::UnindexedOversizedMarkdown,
        media: MediaClass::Other,
        modified_seq: 1,
        bucket: crate::store::bucket16(&B16([id; 16])),
        local: FileLocal::Remote,
    }
}
pub(super) fn build(attachment: bool) -> (Node, rt::ManifestPayload, Hash, Objects) {
    build_source(attachment, &vec![b'x'; 1048577])
}
fn build_source(attachment: bool, plain: &[u8]) -> (Node, rt::ManifestPayload, Hash, Objects) {
    let mut a = node();
    let (c, mut objects) = contents(&mut a, plain, attachment);
    if let FileContent::AttachmentV1(ref d) = c {
        let refs = objects.keys().copied().collect::<Vec<_>>();
        a.r.store
            .commit(Tx {
                meta: vec![
                    crate::replica::attachment_inventory::inventory_meta_of_refs(
                        d.reference.manifest_cipher_hash,
                        &refs,
                    ),
                ],
                ..Tx::default()
            })
            .unwrap();
    }
    let p = UnindexedMarkdownPayloadV1 { content: c.clone() };
    a.r.store
        .commit(Tx {
            files_put: vec![file(61, c)],
            tombstones_put: vec![TombstoneRow {
                id: B16([62; 16]),
                kind: EntityKind::File,
                path: "gone.md".into(),
                path_key: "gone.md".into(),
                last: TombstoneLast::UnindexedMarkdown(p.clone()),
                seq: 1,
                time: 2,
            }],
            conflicts_put: vec![ConflictRow {
                mutation: B16([63; 16]),
                seq: 1,
                conflict: rt::Conflict {
                    id: B16([64; 16]),
                    kind: mdbn_wire::entry::ConflictKind::File,
                    field: None,
                    base: Some(rt::ConflictValue::UnindexedMarkdown(p.clone())),
                    kept: rt::ConflictValue::UnindexedMarkdown(p.clone()),
                    lost: rt::ConflictValue::UnindexedMarkdown(p),
                },
            }],
            ..Tx::default()
        })
        .unwrap();
    a.r.build_snapshot_now().unwrap();
    let mut manifest = None;
    for call in a.r.take_log_calls() {
        if let LogRequest::PutObject {
            address,
            bytes,
            kind,
            ..
        } = call.request
        {
            if kind == ItemKind::Manifest {
                let item = Item::from_bytes(&bytes).unwrap();
                let plain = a.r.sealer.open(&item, &bytes).unwrap();
                manifest = Some((rt::ManifestPayload::from_bytes(&plain).unwrap(), address));
            }
            objects.insert(address, bytes);
        }
    }
    let (m, h) = manifest.expect("guarded native manifest");
    (a, m, h, objects)
}
pub(super) fn receiver(a: &Node, m: &rt::ManifestPayload, h: Hash) -> Node {
    let mut b = node();
    b.r.head = Head {
        seq: 1,
        chain: B32([8; 32]),
    };
    b.r.store
        .commit(Tx {
            head: Some(b.r.head),
            clear_confirmed: true,
            ..Tx::default()
        })
        .unwrap();
    let mut policy = a.r.policy.clone();
    let id = a.r.sealer.public_identity().unwrap();
    policy.devices.get_mut(&id.device).unwrap().sign_pk = id.sign_pk;
    b.r.install_points = vec![ControlPoint { seq: 0, policy }];
    b.r.install = Some(Install::Manifest(SnapshotPointer {
        seq: m.seq,
        manifest: h,
        author: a.r.cfg.device_id,
        created_at: 2,
        endorsed: false,
    }));
    b
}
pub(super) fn reply_install(
    b: &mut Node,
    call: crate::log::LogCall,
    objects: &Objects,
    corrupt: bool,
) {
    let reply = match call.request {
        LogRequest::GetObject { address, .. } => {
            let mut bytes = objects[&address].clone();
            if corrupt {
                *bytes.last_mut().unwrap() ^= 1;
            }
            Ok(LogResponse::GetObject {
                size: bytes.len() as u64,
                checksum: mdbn_wire::hash::sha256(&bytes),
                bytes,
            })
        }
        LogRequest::Read(_) => {
            let Some(Install::Chain(_, m)) = &b.r.install else {
                panic!("not chain")
            };
            Ok(LogResponse::Read(mdbn_wire::log_service::ReadResult {
                head: m.seq,
                head_chain: m.chain,
                items: vec![],
                more: false,
                retained_from: 1,
                behind: false,
                snapshot: None,
            }))
        }
        _ => return,
    };
    let kind = b.r.inflight.remove(&call.id).unwrap();
    match kind {
        Inflight::InstallNative => b.r.on_native_install_reply(call.id, reply),
        Inflight::InstallText => b.r.on_snapshot_text_reply(call.id, reply),
        Inflight::Install => b.r.test_on_native_snapshot_reply(reply),
        _ => panic!("unexpected install call"),
    };
    b.r.retry_install();
}
fn reach_sources(b: &mut Node, objects: &Objects) -> crate::log::LogCall {
    for _ in 0..64 {
        for call in b.r.take_log_calls() {
            if matches!(b.r.inflight.get(&call.id), Some(Inflight::InstallNative)) {
                return call;
            }
            reply_install(b, call, objects, false);
        }
    }
    panic!("no native source read")
}
#[test]
fn sections12_13_cv6_full_sources_before_atomic_swap_and_local_proofs_excluded() {
    for attachment in [false, true] {
        let (a, m, h, objects) = build(attachment);
        assert!(
            m.sections
                .iter()
                .any(|s| s.kind == rt::SectionKind::UnindexedMarkdownFiles)
        );
        assert!(
            m.sections
                .iter()
                .any(|s| s.kind == rt::SectionKind::UnindexedMarkdownTombstones)
        );
        let mut b = receiver(&a, &m, h);
        b.r.test_on_native_snapshot_reply(Ok(LogResponse::GetObject {
            bytes: objects[&h].clone(),
            size: objects[&h].len() as u64,
            checksum: h,
        }));
        let source = reach_sources(&mut b, &objects);
        let old = b.r.store.head().unwrap();
        assert_eq!(old.seq, 1);
        assert!(b.r.store.file(&B16([61; 16])).unwrap().is_none());
        assert!(
            b.r.store
                .meta("replica.unindexed_byte_proofs")
                .unwrap()
                .is_none()
        );
        reply_install(&mut b, source, &objects, false);
        for _ in 0..16 {
            if !b.r.installing() {
                break;
            }
            for c in b.r.take_log_calls() {
                reply_install(&mut b, c, &objects, false);
            }
            b.r.retry_install();
        }
        assert!(!b.r.installing(), "{:?}", b.r.sync_status().incidents);
        assert_eq!(b.r.stats.snapshots_installed, 1);
        assert_eq!(b.r.head(), a.r.head());
        assert_eq!(
            crate::replica::state_digest(&b.r.store).unwrap(),
            m.state_digest
        );
        assert_eq!(
            b.r.store.file(&B16([61; 16])).unwrap().unwrap().kind,
            FileKindV1::UnindexedOversizedMarkdown
        );
        assert_eq!(
            b.r.store.tombstone(&B16([62; 16])).unwrap(),
            a.r.store.tombstone(&B16([62; 16])).unwrap()
        );
        assert_eq!(
            b.r.store.conflicts(None).unwrap(),
            a.r.store.conflicts(None).unwrap()
        );
        assert!(
            b.r.store
                .meta("replica.unindexed_byte_proofs")
                .unwrap()
                .is_some()
        );
        assert_eq!(
            crate::replica::state_digest(&a.r.store).unwrap(),
            crate::replica::state_digest(&b.r.store).unwrap()
        );
    }
}
#[test]
fn source_corruption_cleans_staging_and_keeps_confirmed_prefix_and_cache() {
    let (a, m, h, objects) = build(false);
    let mut b = receiver(&a, &m, h);
    let old = b.r.store.head().unwrap();
    b.r.test_on_native_snapshot_reply(Ok(LogResponse::GetObject {
        bytes: objects[&h].clone(),
        size: objects[&h].len() as u64,
        checksum: h,
    }));
    let source = reach_sources(&mut b, &objects);
    reply_install(&mut b, source, &objects, true);
    assert!(!b.r.installing());
    assert_eq!(b.r.store.head().unwrap(), old);
    assert!(b.r.store.file(&B16([61; 16])).unwrap().is_none());
    assert!(
        b.r.store
            .meta("replica.unindexed_byte_proofs")
            .unwrap()
            .is_none()
    );
}
#[test]
fn signed_manifest_missing_source_ref_is_refused_before_plain_source_fetch() {
    let (mut a, m, h, mut objects) = build(false);
    let old = objects[&h].clone();
    let mut item = Item::from_bytes(&old).unwrap();
    let plain = a.r.sealer.open(&item, &old).unwrap();
    let f = a.r.store.file(&B16([61; 16])).unwrap().unwrap();
    let FileContent::Blob(ref d) = f.content else {
        panic!()
    };
    let addr = a.r.sealer.blob_part_addresses(d).unwrap()[0];
    item.refs.as_mut().unwrap().retain(|h| *h != addr);
    a.r.sealer
        .seal_object(&mut item, &plain, true, true, &mut *a.r.host.entropy)
        .unwrap();
    let raw = item.to_bytes().unwrap();
    let h = mdbn_wire::hash::sha256(&raw);
    objects.insert(h, raw.clone());
    let mut b = receiver(&a, &m, h);
    let before = b.r.head();
    b.r.test_on_native_snapshot_reply(Ok(LogResponse::GetObject {
        size: raw.len() as u64,
        checksum: h,
        bytes: raw,
    }));
    for _ in 0..64 {
        if !b.r.installing() {
            break;
        }
        for c in b.r.take_log_calls() {
            assert!(!matches!(
                b.r.inflight.get(&c.id),
                Some(Inflight::InstallNative)
            ));
            reply_install(&mut b, c, &objects, false);
        }
    }
    assert!(!b.r.installing());
    assert_eq!(b.r.store.head().unwrap(), before);
    assert!(
        b.r.store
            .meta("replica.unindexed_byte_proofs")
            .unwrap()
            .is_none()
    );
}
#[test]
fn authenticated_invalid_utf8_never_creates_snapshot_byte_proof_or_holder() {
    let mut plain = vec![b'x'; 1048577];
    plain[0] = 0xff;
    let (a, m, h, objects) = build_source(false, &plain);
    let mut b = receiver(&a, &m, h);
    let old = b.r.head();
    b.r.test_on_native_snapshot_reply(Ok(LogResponse::GetObject {
        bytes: objects[&h].clone(),
        size: objects[&h].len() as u64,
        checksum: h,
    }));
    for _ in 0..64 {
        if !b.r.installing() {
            break;
        }
        for c in b.r.take_log_calls() {
            reply_install(&mut b, c, &objects, false);
        }
        b.r.retry_install();
    }
    assert!(!b.r.installing());
    assert_eq!(b.r.store.head().unwrap(), old);
    assert!(b.r.store.file(&B16([61; 16])).unwrap().is_none());
    assert!(
        b.r.store
            .meta("replica.unindexed_byte_proofs")
            .unwrap()
            .is_none()
    );
}
#[test]
fn unknown_swap_outcome_is_terminal_and_never_issues_cleanup_or_retry() {
    let (a, m, h, objects) = build(false);
    let mut b = receiver(&a, &m, h);
    b.r.test_on_native_snapshot_reply(Ok(LogResponse::GetObject {
        bytes: objects[&h].clone(),
        size: objects[&h].len() as u64,
        checksum: h,
    }));
    let source = reach_sources(&mut b, &objects);
    b.r.store.fail_after_head_commit(m.seq);
    reply_install(&mut b, source, &objects, false);
    for _ in 0..16 {
        if b.r.apply_fault {
            break;
        }
        for c in b.r.take_log_calls() {
            reply_install(&mut b, c, &objects, false);
        }
        b.r.retry_install();
    }
    assert!(b.r.apply_fault);
    assert_eq!(
        b.r.store.head().unwrap().seq,
        m.seq,
        "unknown swap landed atomically"
    );
    assert!(
        b.r.store
            .meta("replica.unindexed_byte_proofs")
            .unwrap()
            .is_some()
    );
    assert!(b.r.take_log_calls().is_empty());
    b.r.retry_install();
    assert!(b.r.take_log_calls().is_empty());
}
#[test]
fn late_generation_source_response_never_swaps_a_new_context() {
    let (a, m, h, objects) = build(false);
    let mut b = receiver(&a, &m, h);
    let old = b.r.store.head().unwrap();
    b.r.test_on_native_snapshot_reply(Ok(LogResponse::GetObject {
        bytes: objects[&h].clone(),
        size: objects[&h].len() as u64,
        checksum: h,
    }));
    let source = reach_sources(&mut b, &objects);
    b.r.store_generation += 1;
    reply_install(&mut b, source, &objects, false);
    assert!(!b.r.installing());
    assert_eq!(b.r.store.head().unwrap(), old);
    assert!(
        b.r.store
            .meta("replica.unindexed_byte_proofs")
            .unwrap()
            .is_none()
    );
}
