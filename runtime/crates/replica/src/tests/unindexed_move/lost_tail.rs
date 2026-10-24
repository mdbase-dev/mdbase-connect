//! Genuine signed acknowledged move loss, verified prefix probing and fallback.
//! The log is the deterministic FakeLogService, not a deployed provider.
use super::super::engine::COL;
use super::*;
use crate::log::{LogClient, LogPush};
use mdbn_wire::unindexed_markdown::FileKindV1;

#[test]
fn acknowledged_native_move_lost_tail_restores_exact_sealed_bytes_once() {
    let (svc, mut a, mut b) = pair();
    let id = native(&mut a, &mut b);
    let prior = a.r.store.file(&id).unwrap().unwrap().content;
    a.r.test_capture_native_move(id, "before.md", "after.md")
        .unwrap();
    let pending = a.r.store.pending(None, 10).unwrap().remove(0);
    settle(&mut [&mut a, &mut b]);
    let before = svc.items(&COL);
    let head = a.r.head();
    let receipt = a.r.store.receipt(&pending.mutation.id).unwrap().unwrap();
    assert_eq!(receipt.seq, head.seq);
    assert!(
        a.r.store
            .pending_get(&pending.mutation.id)
            .unwrap()
            .is_none()
    );
    svc.lose_tail(&COL, 1);
    a.r.on_log_push(LogPush::Reconnected);
    settle(&mut [&mut a, &mut b]);
    assert_eq!(svc.items(&COL), before);
    assert_eq!(a.r.head(), head);
    assert_eq!(b.r.head(), head);
    assert_eq!(a.r.repair_stats().reappended, 1);
    assert_eq!(a.r.repair_stats().fallback, 0);
    assert_eq!(
        a.r.store.receipt(&pending.mutation.id).unwrap(),
        Some(receipt)
    );
    for n in [&a, &b] {
        let file = n.r.store.file(&id).unwrap().unwrap();
        assert_eq!(file.path, "after.md");
        assert_eq!(file.kind, FileKindV1::UnindexedOversizedMarkdown);
        assert_eq!(file.content, prior);
        assert_eq!(n.r.stats.verify_mismatch, 0);
    }
}

#[test]
fn acknowledged_native_move_overwritten_gap_follows_current_source_and_verifies() {
    for changed_source in [false, true] {
        let (svc, mut a, mut b) = pair();
        let id = native(&mut a, &mut b);
        let common = svc.head(&COL).0;
        a.r.test_capture_native_move(id, "before.md", "after.md")
            .unwrap();
        let pending = a.r.store.pending(None, 10).unwrap().remove(0);
        settle(&mut [&mut a]); // B never sees the acknowledged move.
        let lost_head = a.r.head();
        assert_eq!(lost_head.seq, common + 1);
        assert!(a.r.store.receipt(&pending.mutation.id).unwrap().is_some());
        assert_eq!(b.r.head().seq, common, "B did not apply the lost move");
        // B was offline; discard the now-stale notification of A's lost head.
        let _ = LogClient::poll_pushes(&mut b.log);
        svc.lose_tail(&COL, 1);
        if changed_source {
            let proof =
                b.r.prepare_unindexed_markdown_capture(
                    id,
                    "before.md".into(),
                    Box::new(Source(vec![b'y'; 1_048_578])),
                )
                .unwrap();
            let upload = b.r.start_unindexed_markdown_upload(proof).unwrap();
            settle(&mut [&mut b]);
            let prepared = b.r.take_prepared_unindexed_upload(&upload).unwrap();
            b.r.capture_prepared_unindexed_upload(prepared).unwrap();
        } else {
            b.r.test_capture_native_move(id, "before.md", "current.md")
                .unwrap();
            b.r.pump();
        }
        settle(&mut [&mut b]);
        let current = b.r.store.file(&id).unwrap().unwrap().content;
        assert_ne!(b.r.head().chain, lost_head.chain);
        a.r.on_log_push(LogPush::Reconnected);
        settle(&mut [&mut a, &mut b]);
        let remaining_calls = a.r.take_log_calls();
        assert_eq!(
            a.r.repair_status(),
            None,
            "source={changed_source} head={:?} status={:?} reopen={} blocked={:?} stalled={:?} calls={:?}",
            a.r.head(),
            a.r.sync_status(),
            a.r.requires_reopen(),
            a.r.apply_blocked,
            a.r.stalled,
            remaining_calls
        );
        assert_eq!(a.r.repair_stats().fallback, 1);
        assert_eq!(a.r.repair_stats().resurrected, 1);
        assert!(
            a.r.resurrected.is_empty(),
            "source={changed_source} status={:?} caught={} policy={:?} pending={:?}",
            a.r.sync_status(),
            a.r.caught_up,
            a.r.policy,
            a.r.store.pending_get(&pending.mutation.id).unwrap()
        );
        assert!(
            a.r.store
                .pending_get(&pending.mutation.id)
                .unwrap()
                .is_none()
        );
        let receipt =
            a.r.store
                .receipt(&pending.mutation.id)
                .unwrap()
                .expect("acknowledged move relocated");
        assert!(receipt.seq > common + 1);
        for n in [&a, &b] {
            let file = n.r.store.file(&id).unwrap().unwrap();
            assert_eq!(file.path, "after.md");
            assert_eq!(file.kind, FileKindV1::UnindexedOversizedMarkdown);
            assert_eq!(file.content, current);
            assert_eq!(n.r.stats.verify_mismatch, 0);
            assert_eq!(n.r.head(), a.r.head());
        }
    }
}
