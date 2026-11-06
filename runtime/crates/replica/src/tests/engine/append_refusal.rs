use super::*;
use crate::log::{LogClient, LogError, LogErrorCode, LogRequest};
use crate::store::Store;

fn refusal(retry_after_ms: Option<u64>) -> Result<crate::log::LogResponse, LogError> {
    Err(LogError::Service {
        code: LogErrorCode::Invalid,
        reason: Some("cbor_alloc".into()),
        retry_after_ms,
        missing: vec![],
    })
}

fn refuse(device: &mut Node) -> usize {
    let calls = device.r.take_log_calls();
    let append = calls
        .into_iter()
        .find(|call| matches!(call.request, LogRequest::Append(_)))
        .unwrap();
    let LogRequest::Append(params) = append.request else {
        unreachable!()
    };
    device.r.on_log_reply(append.id, refusal(None));
    params.items.len()
}

#[test]
fn refused_batch_stays_pending_and_retries_in_order_with_bounded_backoff() {
    let service = FakeLogService::new();
    let mut device = node(&service, 1, MemStore::new());
    settle(&mut [&mut device]);
    device.r.caught_up = false;
    let first = device.create(31, "first.md", "original one");
    let second = device.create(32, "second.md", "original two");
    device.r.caught_up = true;
    device.r.pump();
    let original = device.r.store().pending(None, 64).unwrap();
    assert_eq!(refuse(&mut device), 2);
    let third = device.create(33, "third.md", "original three");
    assert_eq!(device.r.sync_status().pending, 3);
    for (index, wait) in [
        1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 90_000,
    ]
    .into_iter()
    .enumerate()
    {
        let (deadline, _) = device.r.append_retry.unwrap();
        assert_eq!(deadline - device.clock.get() as i64, wait);
        for receipt in [&first, &second, &third] {
            assert_eq!(
                device.r.receipt(device.s, receipt.mutation).unwrap().state,
                ReceiptState::Pending
            );
            assert!(
                device
                    .r
                    .store()
                    .local_receipt(&receipt.mutation)
                    .unwrap()
                    .is_none()
            );
        }
        assert_eq!(
            &device.r.store().pending(None, 64).unwrap()[..2],
            original.as_slice()
        );
        let incident = device
            .r
            .sync_status()
            .incidents
            .into_iter()
            .find(|incident| incident.kind == mdbn_wire::client::IncidentKind::Integrity)
            .unwrap();
        assert!(
            matches!(incident.details, Some(mdbn_wire::common::Value::Map(details)) if details.contains(&("reason".into(), mdbn_wire::common::Value::Text("cbor_alloc".into()))))
        );
        device.r.on_log_push(crate::log::LogPush::Reconnected);
        device.clock.set(deadline as u64 - 1);
        settle(&mut [&mut device]);
        assert!(
            device
                .r
                .take_log_calls()
                .iter()
                .all(|call| !matches!(call.request, LogRequest::Append(_)))
        );
        device.clock.set(deadline as u64);
        device.r.tick();
        let calls = device.r.take_log_calls();
        let append = calls
            .into_iter()
            .find(|call| matches!(call.request, LogRequest::Append(_)))
            .unwrap();
        if index == 8 {
            let reply = device.log.call(append.request);
            device.r.on_log_reply(append.id, reply);
        } else {
            device
                .r
                .on_log_reply(append.id, refusal((index == 7).then_some(90_000)));
        }
    }
    settle(&mut [&mut device]);
    assert_eq!(device.r.sync_status().pending, 0);
    assert!(device.r.sync_status().incidents.is_empty());
    let mut sequences = Vec::new();
    for receipt in [first, second, third] {
        let receipt = device.r.receipt(device.s, receipt.mutation).unwrap();
        assert_eq!(receipt.state, ReceiptState::Confirmed);
        sequences.push(receipt.seq.unwrap());
    }
    assert!(sequences.windows(2).all(|window| window[0] < window[1]));
}

#[test]
fn refusal_does_not_freeze_replanning_or_later_writes_after_a_peer_create() {
    let service = FakeLogService::new();
    let mut device = node(&service, 1, MemStore::new());
    let mut peer = node(&service, 2, MemStore::new());
    settle(&mut [&mut device, &mut peer]);
    let original = device.create(31, "shared.md", "local");
    refuse(&mut device);
    peer.create(32, "shared.md", "peer confirmed");
    settle(&mut [&mut peer, &mut device]);
    assert_eq!(device.doc(32).as_deref(), Some("peer confirmed"));
    assert!(device.doc(31).is_none());
    assert_eq!(
        device.r.receipt(device.s, original.mutation).unwrap().state,
        ReceiptState::Pending
    );
    device.create(33, "later.md", "later write");
    device.clock.set(device.clock.get() + 1_000);
    settle(&mut [&mut peer, &mut device]);
    assert_eq!(
        device.r.receipt(device.s, original.mutation).unwrap().state,
        ReceiptState::Rejected
    );
    assert_eq!(device.r.sync_status().pending, 0);
    assert_eq!(peer.doc(33).as_deref(), Some("later write"));
}
