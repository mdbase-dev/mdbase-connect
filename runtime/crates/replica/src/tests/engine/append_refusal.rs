use super::*;
use crate::log::{LogClient, LogError, LogErrorCode, LogPush, LogRequest};
use crate::store::{Store, Tx};
use mdbn_wire::log_service::{LsError, LsFrame, LsResponse};
use mdbn_wire::schema::Wire;

#[test]
fn invalid_append_parks_the_original_and_reports_a_durable_failed_change() {
    let service = FakeLogService::new();
    let mut device = node(&service, 1, MemStore::new());
    settle(&mut [&mut device]);
    let receipt = device.create(31, "refused.md", "irreplaceable local text");
    let original = device
        .r
        .store()
        .pending_get(&receipt.mutation)
        .unwrap()
        .unwrap();
    let calls = device.r.take_log_calls();
    let append = calls
        .into_iter()
        .find(|call| matches!(call.request, LogRequest::Append(_)))
        .unwrap();
    let refusal = |id| {
        LsFrame::Response(LsResponse {
            id,
            result: None,
            error: Some(LsError {
                code: LogErrorCode::Invalid.as_str().into(),
                reason: Some("shape".into()),
                retry_after_ms: Some(1),
                message: None,
                details: None,
            }),
        })
        .to_bytes()
        .unwrap()
    };
    assert!(crate::log_codec::reply(append.id, "append", &refusal(0)).is_err());
    device.r.on_log_reply(append.id, Err(LogError::NoResponse));
    device.clock.set(device.clock.get() + 1_000);
    device.r.tick();
    let retry = device
        .r
        .take_log_calls()
        .into_iter()
        .find(|call| matches!(call.request, LogRequest::Append(_)))
        .unwrap();
    assert_eq!(retry.request, append.request);
    let reply = crate::log_codec::reply(retry.id, "append", &refusal(retry.id.0)).unwrap();
    device.r.on_log_reply(retry.id, reply);
    let failed = device.r.receipt(device.s, receipt.mutation).unwrap();
    assert_eq!(failed.state, ReceiptState::Rejected);
    assert_eq!(
        failed.problem.as_ref().unwrap().reason.as_deref(),
        Some("append_refused")
    );
    assert_eq!(
        failed.problem.as_ref().unwrap().recovery,
        mdbn_wire::client::Recovery::ContactSupport
    );
    assert_eq!(
        device.r.list_pending(device.s, None).unwrap().pending[0].receipt,
        failed
    );
    assert_eq!(
        device
            .r
            .store()
            .pending_get(&receipt.mutation)
            .unwrap()
            .unwrap(),
        original
    );
    for _ in 0..5 {
        device.clock.set(device.clock.get() + 1_000);
        device.r.tick();
        device.r.on_log_push(LogPush::Reconnected);
        for call in device.r.take_log_calls() {
            assert!(
                !matches!(call.request, LogRequest::Append(_)),
                "permanent refusal was resent"
            );
            let reply = device.log.call(call.request);
            device.r.on_log_reply(call.id, reply);
        }
    }
    device
        .r
        .store_mut()
        .commit(Tx {
            local_receipts_prune: Some(i64::MAX),
            ..Tx::default()
        })
        .unwrap();
    let store = device.r.into_store();
    let mut device = node(&service, 1, store);
    settle(&mut [&mut device]);
    assert_eq!(
        device.r.receipt(device.s, receipt.mutation).unwrap(),
        failed
    );
    assert_eq!(
        device
            .r
            .store()
            .pending_get(&receipt.mutation)
            .unwrap()
            .unwrap(),
        original
    );
    assert_eq!(service.head(&COL).0, device.r.head().seq);
    assert!(
        device
            .r
            .take_log_calls()
            .iter()
            .all(|call| !matches!(call.request, LogRequest::Append(_)))
    );
}
