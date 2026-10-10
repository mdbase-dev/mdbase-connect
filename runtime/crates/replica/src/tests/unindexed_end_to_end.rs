//! Public native APIs and actual signed receiving, no private apply/capture hooks.
use super::engine::{COL, Node, node_with, settle};
use crate::{
    crypto::{hpke::KemKeyPair, recovery::RecoveryKey, sign::DeviceSigner},
    fake::FakeLogService,
    log::LogPort,
    mem::MemStore,
    replica::{AttachmentSource, UnindexedUploadStatus},
    seal::KeyringSealer,
    store::{Page, Store},
};
use mdbn_wire::{
    common::{B16, B32},
    envelope::{Item, ItemKind},
    policy::{CState, DeviceEnrol, DeviceKind, PolicyOp},
    schema::Wire,
    unindexed_markdown::FileKindV1,
};
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
pub(super) fn pair() -> (FakeLogService, Node, Node) {
    let svc = FakeLogService::new();
    let mut cp = crate::testkit::TestControlPlane::signed(COL);
    let (ask, akem) = ([0x31; 32], [0x32; 32]);
    let (bsk, bkem) = ([0x41; 32], [0x42; 32]);
    cp.genesis_with_keys(&svc, CState::E2e, B16([101; 16]), &ask, &akem);
    let mut a = node_with(
        &svc,
        1,
        MemStore::new(),
        vec![],
        Some(Box::new(KeyringSealer::new(
            COL,
            B16([101; 16]),
            &ask,
            &akem,
        ))),
    );
    a.r.planner = Box::new(crate::plan::CorePlanner);
    settle(&mut [&mut a]);
    let r = RecoveryKey::generate(&mut crate::crypto::TestEntropy::new(90));
    let rk = r.derive(&COL);
    cp.append(
        &svc,
        vec![PolicyOp::DeviceEnrol(DeviceEnrol {
            device: rk.device,
            account: crate::testkit::TEST_OWNER,
            kind: DeviceKind::Recovery,
            sign_pk: B32(rk.signer.public()),
            kem_pk: B32(rk.kem.pk),
            noise_pk: B32([0; 32]),
            sas_commit: None,
            local_root: None,
        })],
    );
    settle(&mut [&mut a]);
    a.r.key_account_key_device(&rk).unwrap();
    settle(&mut [&mut a]);
    cp.append(
        &svc,
        vec![PolicyOp::DeviceEnrol(DeviceEnrol {
            device: B16([102; 16]),
            account: crate::testkit::TEST_OWNER,
            kind: DeviceKind::Desktop,
            sign_pk: B32(DeviceSigner::from_seed(&bsk).public()),
            kem_pk: B32(KemKeyPair::from_secret(&bkem).pk),
            noise_pk: B32([9; 32]),
            sas_commit: None,
            local_root: None,
        })],
    );
    let mut b = node_with(
        &svc,
        2,
        MemStore::new(),
        vec![],
        Some(Box::new(KeyringSealer::new(
            COL,
            B16([102; 16]),
            &bsk,
            &bkem,
        ))),
    );
    b.r.planner = Box::new(crate::plan::CorePlanner);
    settle(&mut [&mut a, &mut b]);
    b.r.self_grant_with_account_key(r.derive(&COL)).unwrap();
    settle(&mut [&mut a, &mut b]);
    assert!(a.r.caught_up && b.r.caught_up);
    assert!(b.r.account_key_unlock_state().unwrap());
    (svc, a, b)
}
#[test]
fn public_native_attachment_capture_signed_other_replica_reverse_blob_text_and_snapshot() {
    let (svc, mut a, mut b) = pair();
    let id = B16([61; 16]);
    let path = "large.md".to_string();
    let mut bytes = "---\r\ntitle: 🪴\r\n---\r\nexact\0é\r\n"
        .as_bytes()
        .to_vec();
    bytes.resize(2097153, b'x');
    let proof =
        a.r.prepare_unindexed_markdown_capture(id, path.clone(), Box::new(Source(bytes.clone())))
            .unwrap();
    let upload = a.r.start_unindexed_markdown_upload(proof).unwrap();
    settle(&mut [&mut a, &mut b]);
    assert_eq!(
        a.r.unindexed_markdown_upload_status(&upload),
        Some(UnindexedUploadStatus::Prepared)
    );
    let p = a.r.take_prepared_unindexed_upload(&upload).unwrap();
    let refs = p.refs().to_vec();
    let receipt = a.r.capture_prepared_unindexed_upload(p).unwrap();
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.r.store.pending_count().unwrap(), 0);
    for n in [&a, &b] {
        let f = n.r.store.file(&id).unwrap().unwrap();
        assert_eq!(f.path, path);
        assert_eq!(f.kind, FileKindV1::UnindexedOversizedMarkdown);
        assert_eq!(f.content.size(), bytes.len() as u64);
        assert!(n.r.store.record(&id).unwrap().is_none());
        assert_eq!(n.r.head(), a.r.head());
        assert!(
            n.r.sync_status().incidents.is_empty(),
            "{:?}",
            n.r.sync_status().incidents
        );
    }
    let raw = svc
        .items(&COL)
        .into_iter()
        .find(|raw| {
            Item::from_bytes(raw).is_ok_and(|i| {
                i.kind == ItemKind::Entry && i.idem == a.r.sealer.idem_token(&receipt.mutation)
            })
        })
        .unwrap();
    let item = Item::from_bytes(&raw).unwrap();
    assert_eq!(item.refs.as_ref(), Some(&refs));
    assert!(crate::crypto::sign::verify_item(
        &DeviceSigner::from_seed(&[0x31; 32]).public(),
        &item
    ));
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.r.stats.snapshots_built, 1);
    let mut small = "---\r\ntitle: preserved\r\n---\r\n🪴\0é\r\n"
        .as_bytes()
        .to_vec();
    small.resize(1048576, b'y');
    let proof =
        a.r.prepare_unindexed_markdown_reindex(id, path.clone(), Box::new(Source(small.clone())))
            .unwrap();
    let upload = a.r.start_unindexed_markdown_reindex_upload(proof).unwrap();
    settle(&mut [&mut a, &mut b]);
    let p = a.r.take_prepared_unindexed_reindex_upload(&upload).unwrap();
    let refs = p.refs().to_vec();
    let receipt = a.r.capture_prepared_unindexed_reindex_upload(p).unwrap();
    settle(&mut [&mut a, &mut b]);
    for n in [&a, &b] {
        assert!(n.r.store.file(&id).unwrap().is_none());
        assert_eq!(
            n.r.store.record(&id).unwrap().unwrap().doc.as_bytes(),
            small
        );
        assert!(n.r.store.tombstone(&id).unwrap().is_none());
        assert_eq!(n.r.head(), a.r.head());
        assert!(
            n.r.sync_status().incidents.is_empty(),
            "{:?}",
            n.r.sync_status().incidents
        );
    }
    let raw = svc
        .items(&COL)
        .into_iter()
        .find(|raw| {
            Item::from_bytes(raw).is_ok_and(|i| {
                i.kind == ItemKind::Entry && i.idem == a.r.sealer.idem_token(&receipt.mutation)
            })
        })
        .unwrap();
    assert!(raw.len() < 1048576);
    assert_eq!(Item::from_bytes(&raw).unwrap().refs, Some(refs));
    // The real producer accepts the cap-bound record without an injected Blob row.
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.r.stats.snapshots_built, 2);
    // Op15 preserves the same record ID/path and consumes the complete current prior.
    let proof =
        a.r.prepare_unindexed_markdown_capture(id, path.clone(), Box::new(Source(bytes.clone())))
            .unwrap();
    let upload = a.r.start_unindexed_markdown_upload(proof).unwrap();
    settle(&mut [&mut a, &mut b]);
    let p = a.r.take_prepared_unindexed_upload(&upload).unwrap();
    a.r.capture_prepared_unindexed_upload(p).unwrap();
    settle(&mut [&mut a, &mut b]);
    for n in [&a, &b] {
        assert!(n.r.store.record(&id).unwrap().is_none());
        assert_eq!(
            n.r.store.file(&id).unwrap().unwrap().kind,
            FileKindV1::UnindexedOversizedMarkdown
        );
        assert!(n.r.store.tombstone(&id).unwrap().is_none());
    }
    // Empty reverse text is valid, including normal signed receiving on the other device.
    let proof =
        a.r.prepare_unindexed_markdown_reindex(id, path.clone(), Box::new(Source(Vec::new())))
            .unwrap();
    let upload = a.r.start_unindexed_markdown_reindex_upload(proof).unwrap();
    settle(&mut [&mut a, &mut b]);
    let p = a.r.take_prepared_unindexed_reindex_upload(&upload).unwrap();
    a.r.capture_prepared_unindexed_reindex_upload(p).unwrap();
    settle(&mut [&mut a, &mut b]);
    assert!(b.r.store.file(&id).unwrap().is_none());
    assert_eq!(b.r.store.record(&id).unwrap().unwrap().doc, "");
    assert!(b.r.store.tombstone(&id).unwrap().is_none());
    assert!(
        b.r.sync_status().incidents.is_empty(),
        "{:?}",
        b.r.sync_status().incidents
    );
    assert_eq!(
        a.r.store
            .records(Page {
                after: None,
                limit: 1024
            })
            .unwrap()
            .len(),
        1
    );
}

fn capture_fault(a: &Node, case: u8) {
    match case {
        0 => a.r.store.fail_commits(1),
        1 => a.r.store.fail_unknown_commits(1),
        2 => a.r.store.fail_after_commit(1),
        _ => unreachable!(),
    }
}
#[test]
fn public_native_capture_known_abort_vs_unknown_durability_preserves_pending_ownership() {
    for case in 0..3 {
        let (_svc, mut a, mut b) = pair();
        let id = B16([72; 16]);
        let bytes = vec![b'x'; 1_048_577];
        let proof =
            a.r.prepare_unindexed_markdown_capture(
                id,
                "fault.md".into(),
                Box::new(Source(bytes.clone())),
            )
            .unwrap();
        let upload = a.r.start_unindexed_markdown_upload(proof).unwrap();
        settle(&mut [&mut a, &mut b]);
        let p = a.r.take_prepared_unindexed_upload(&upload).unwrap();
        let head = a.r.head();
        let order = a.r.next_order;
        capture_fault(&a, case);
        assert!(a.r.capture_prepared_unindexed_upload(p).is_err());
        assert_eq!(a.r.head(), head);
        assert_eq!(a.r.next_order, order);
        assert!(a.r.store.file(&id).unwrap().is_none());
        let pending = a.r.store.pending(None, 100).unwrap();
        assert_eq!(pending.len(), usize::from(case == 2));
        assert_eq!(a.r.requires_reopen(), case != 0);
        assert!(
            a.r.take_log_calls().is_empty(),
            "no signed append after uncertain persistence"
        );
        if case == 0 {
            let proof = a
                .r
                .prepare_unindexed_markdown_capture(id, "fault.md".into(), Box::new(Source(bytes)))
                .unwrap();
            let upload = a.r.start_unindexed_markdown_upload(proof).unwrap();
            settle(&mut [&mut a, &mut b]);
            let p = a.r.take_prepared_unindexed_upload(&upload).unwrap();
            a.r.capture_prepared_unindexed_upload(p).unwrap();
            settle(&mut [&mut a, &mut b]);
            assert_eq!(a.r.head(), b.r.head());
            assert!(a.r.store.file(&id).unwrap().is_some());
        } else {
            assert!(
                a.r.prepare_unindexed_markdown_capture(
                    id,
                    "fault.md".into(),
                    Box::new(Source(bytes))
                )
                .is_err()
            );
            assert!(a.r.build_snapshot_now().is_err());
            settle(&mut [&mut a, &mut b]);
            assert_eq!(a.r.head(), head);
            assert_eq!(
                a.r.store.pending(None, 100).unwrap(),
                pending,
                "no retry or cleanup of possibly landed ownership"
            );
        }
    }
}
#[test]
fn public_reverse_capture_unknown_durability_never_cleans_landed_blob_pending() {
    for case in 0..3 {
        let (_svc, mut a, mut b) = pair();
        let id = B16([73; 16]);
        let proof =
            a.r.prepare_unindexed_markdown_capture(
                id,
                "reverse-fault.md".into(),
                Box::new(Source(vec![b'x'; 1_048_577])),
            )
            .unwrap();
        let upload = a.r.start_unindexed_markdown_upload(proof).unwrap();
        settle(&mut [&mut a, &mut b]);
        let p = a.r.take_prepared_unindexed_upload(&upload).unwrap();
        a.r.capture_prepared_unindexed_upload(p).unwrap();
        settle(&mut [&mut a, &mut b]);
        let before = a.r.store.file(&id).unwrap().unwrap();
        let head = a.r.head();
        let order = a.r.next_order;
        let proof =
            a.r.prepare_unindexed_markdown_reindex(
                id,
                "reverse-fault.md".into(),
                Box::new(Source(vec![])),
            )
            .unwrap();
        let upload = a.r.start_unindexed_markdown_reindex_upload(proof).unwrap();
        settle(&mut [&mut a, &mut b]);
        let p = a.r.take_prepared_unindexed_reindex_upload(&upload).unwrap();
        capture_fault(&a, case);
        assert!(a.r.capture_prepared_unindexed_reindex_upload(p).is_err());
        assert_eq!(a.r.requires_reopen(), case != 0);
        assert_eq!(a.r.head(), head);
        assert_eq!(a.r.next_order, order);
        assert_eq!(a.r.store.file(&id).unwrap(), Some(before));
        assert!(a.r.store.record(&id).unwrap().is_none());
        let pending = a.r.store.pending(None, 100).unwrap();
        assert_eq!(pending.len(), usize::from(case == 2));
        if case == 2 {
            assert_eq!(pending[0].uploads.len(), 1);
            assert!(!pending[0].refs.is_empty());
        }
        assert!(a.r.take_log_calls().is_empty());
        settle(&mut [&mut a, &mut b]);
        assert_eq!(a.r.store.pending(None, 100).unwrap(), pending);
    }
}
