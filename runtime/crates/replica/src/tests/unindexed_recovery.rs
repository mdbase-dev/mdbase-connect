//! Signed public native producer APIs plus the actual lost-tail probe/fallback.
//! No fabricated Resurrect stage or private apply/capture hooks; FakeLog only.
use super::{
    engine::{COL, settle},
    unindexed_end_to_end::pair,
};
use crate::{
    log::{LogClient, LogPort, LogPush},
    replica::AttachmentSource,
    store::Store,
};
use mdbn_wire::common::B16;
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
#[test]
fn verified_fallback_replays_native_full_source_and_reverse_text_before_resurrection() {
    for reverse in [false, true] {
        let (svc, mut a, mut b) = pair();
        let id = B16([61; 16]);
        let p =
            a.r.prepare_unindexed_markdown_capture(
                id,
                "source.md".into(),
                Box::new(Source(vec![b'x'; 1_048_577])),
            )
            .unwrap();
        let u = a.r.start_unindexed_markdown_upload(p).unwrap();
        settle(&mut [&mut a, &mut b]);
        let p = a.r.take_prepared_unindexed_upload(&u).unwrap();
        a.r.capture_prepared_unindexed_upload(p).unwrap();
        settle(&mut [&mut a, &mut b]);
        let doc = vec![b'y'; 1_048_576];
        if reverse {
            let p =
                a.r.prepare_unindexed_markdown_reindex(
                    id,
                    "source.md".into(),
                    Box::new(Source(doc.clone())),
                )
                .unwrap();
            let u = a.r.start_unindexed_markdown_reindex_upload(p).unwrap();
            settle(&mut [&mut a, &mut b]);
            let p = a.r.take_prepared_unindexed_reindex_upload(&u).unwrap();
            a.r.capture_prepared_unindexed_reindex_upload(p).unwrap();
            settle(&mut [&mut a, &mut b]);
        }
        let common = svc.head(&COL).0;
        let lost = a.create(62, "lost.md", "acknowledged");
        assert!(lost.problem.is_none(), "{:?}", lost.problem);
        settle(&mut [&mut a]);
        assert!(a.r.store.receipt(&lost.mutation).unwrap().is_some());
        assert_eq!(b.r.head().seq, common);
        let _ = LogClient::poll_pushes(&mut b.log);
        svc.lose_tail(&COL, svc.head(&COL).0 - common);
        let gap = b.create(63, "gap.md", "other history");
        assert!(gap.problem.is_none(), "{:?}", gap.problem);
        settle(&mut [&mut b]);
        a.r.on_log_push(LogPush::Reconnected);
        settle(&mut [&mut a, &mut b]);
        assert_eq!(
            a.r.repair_status(),
            None,
            "reverse={reverse}: {:?}",
            a.r.sync_status()
        );
        assert_eq!(a.r.repair_stats().rolled_back, 1);
        assert_eq!(a.r.repair_stats().resurrected, 1);
        assert!(a.r.resurrected.is_empty());
        assert_eq!(a.r.head(), b.r.head());
        assert!(a.r.store.receipt(&lost.mutation).unwrap().unwrap().seq > common + 1);
        for n in [&a, &b] {
            assert_eq!(n.doc(62).as_deref(), Some("acknowledged"));
            assert_eq!(n.doc(63).as_deref(), Some("other history"));
            assert_eq!(n.r.stats.verify_mismatch, 0);
            assert!(n.r.apply_blocked.is_none());
            if reverse {
                assert!(n.r.store.file(&id).unwrap().is_none());
                assert_eq!(n.r.store.record(&id).unwrap().unwrap().doc.as_bytes(), doc);
            } else {
                let file = n.r.store.file(&id).unwrap().unwrap();
                assert_eq!(
                    file.kind,
                    mdbn_wire::unindexed_markdown::FileKindV1::UnindexedOversizedMarkdown
                );
                assert!(n.r.store.record(&id).unwrap().is_none());
            }
        }
    }
}
