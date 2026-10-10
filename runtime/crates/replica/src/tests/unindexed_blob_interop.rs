//! Valid signed Blob-profile interoperability through the normal receiver.
//! Fixture data keys are test-only; this does not add a native Blob producer API.
use super::engine::{COL, settle};
use super::unindexed_end_to_end::pair;
use crate::{
    crypto::{Secret32, blob::seal_blob},
    log::{LogClient, LogRequest, LogResponse},
    store::Store,
};
use mdbn_wire::{
    attachment::FileContent,
    common::{B16, Bytes},
    envelope::{Item, ItemKind},
    log_service::{AppendParams, AppendResult},
    schema::Wire,
    unindexed_markdown::FileKindV1,
};
#[test]
fn valid_signed_native_blob_profile_receives_and_survives_public_snapshot_build() {
    let (svc, mut a, mut b) = pair();
    let mut bytes = "---\r\ntitle: Blob\r\n---\r\n🪴\0exact\r\n"
        .as_bytes()
        .to_vec();
    bytes.resize(2_097_153, b'x');
    let epoch = a.r.policy.epoch;
    let keys = a.r.testing_epoch_keys();
    let key = &keys.iter().find(|(e, _)| *e == epoch).unwrap().1;
    let (blob, parts) = seal_blob(
        &Secret32(**key),
        epoch,
        &COL,
        &bytes,
        1_048_576,
        false,
        a.r.host.entropy.as_mut(),
    )
    .unwrap();
    let mut refs = parts.iter().map(|p| p.address).collect::<Vec<_>>();
    refs.sort();
    let mut log = svc.client(a.r.cfg.device_id);
    for part in parts {
        assert!(matches!(
            log.call(LogRequest::PutObject {
                collection: COL,
                address: part.address,
                kind: ItemKind::BlobPart,
                bytes: part.bytes
            }),
            Ok(LogResponse::PutObject { .. })
        ));
    }
    let mut p = super::unindexed_async::payload(FileContent::Blob(blob.clone()));
    p.mutation.base_seq = a.r.head().seq;
    let p = super::unindexed_async::planned(&a, p);
    let head = a.r.head();
    let mut item = Item {
        kind: ItemKind::Entry,
        collection: COL,
        seq: Some(head.seq + 1),
        prev: Some(head.chain),
        epoch: None,
        signer: Some(a.r.cfg.device_id),
        salt: None,
        idem: a.r.sealer.idem_token(&p.mutation.id),
        refs: Some(refs),
        stream: None,
        body: Bytes(Vec::new()),
        sig: None,
    };
    a.r.sealer
        .seal(
            &mut item,
            &p.to_bytes().unwrap(),
            false,
            a.r.host.entropy.as_mut(),
        )
        .unwrap();
    let reply = log.call(LogRequest::Append(AppendParams {
        collection: COL,
        expect_seq: head.seq + 1,
        expect_prev: head.chain,
        items: vec![Bytes(item.to_bytes().unwrap())],
    }));
    assert!(
        matches!(reply, Ok(LogResponse::Append(AppendResult::Appended(_)))),
        "{reply:?}"
    );
    settle(&mut [&mut a, &mut b]);
    let id = B16([52; 16]);
    for n in [&a, &b] {
        let f = n.r.store.file(&id).unwrap().unwrap();
        assert_eq!(f.kind, FileKindV1::UnindexedOversizedMarkdown);
        assert_eq!(f.content, FileContent::Blob(blob.clone()));
        assert!(n.r.store.record(&id).unwrap().is_none());
        assert!(n.r.store.tombstone(&id).unwrap().is_none());
        assert!(
            n.r.sync_status().incidents.is_empty(),
            "{:?}",
            n.r.sync_status().incidents
        );
    }
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.r.stats.snapshots_built, 1);
    assert_eq!(a.r.head(), b.r.head());
}
