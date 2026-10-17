//! Bounded continuation windows and AttachmentV1 streaming on the real engine.
use super::*;

fn path(value: String) -> &'static str {
    // Fixed test corpus; no production allocation/lifetime behaviour is modelled.
    Box::leak(value.into_boxed_str())
}

pub(super) fn many_rows() -> Legacy {
    Legacy {
        resources: (0..150)
            .map(|n| {
                (
                    path(format!("_types/t{n:03}.md")),
                    format!("---\nname: t{n:03}\n---\n"),
                )
            })
            .collect(),
        records: (1..=180)
            .map(|n| (n, path(format!("notes/{n:03}.md")), format!("# {n}\n")))
            .collect(),
        files: vec![],
    }
}

#[test]
fn row_bounded_resource_and_bucket_continuations_are_native_selected() {
    let mut r = run_legacy(many_rows());
    let mut store = Objects::default();
    let mut continuations = 0;
    let mut windows = 0;
    while !matches!(r.d.prepared_action(&r.p).unwrap(), Action::FinishGen0) {
        if matches!(
            r.d.prepared_action(&r.p).unwrap(),
            Action::ImportGen0 { after: Some(_), .. }
        ) {
            continuations += 1;
        }
        r.window(&mut store, 90 + windows);
        windows += 1;
    }
    assert_eq!(windows, 4);
    assert_eq!(continuations, 2);
    let out = r.d.gen0_finish(&r.p, &mut r.h.e, &r.target).unwrap();
    store.put(&out);
    r.d.settle_gen0(
        &r.p,
        &mut r.h.e,
        &r.target,
        &store.result(r.target.admission().collection(), &out.verify),
    )
    .unwrap();
    assert_eq!(
        r.d.test_checkpoint().state_digest,
        Some(expected_digest(&r.l))
    );
    assert_eq!(r.d.test_checkpoint().step, Step::BaseIntent);
}

#[test]
fn every_window_and_finish_boundary_with_a_pending_action_stops_after_crash() {
    for boundary in 0..=4 {
        let mut r = run_legacy(many_rows());
        let mut store = Objects::default();
        for i in 0..boundary {
            r.window(&mut store, 90 + i);
        }
        let pending = r.d.saved_pending().unwrap().unwrap();
        let settled = r.d.test_settled();
        let step = r.d.test_checkpoint().step;
        let mut resumed = JournalDriver::resume(
            r.d.into_index(),
            binding(&r.target),
            &mut TestEntropy::new(110),
        )
        .unwrap();
        assert_eq!(resumed.saved_pending().unwrap(), Some(pending));
        assert_eq!(resumed.test_settled(), settled);
        assert_eq!(resumed.test_checkpoint().step, step);
        assert!(matches!(
            resumed.prepare(&mut TestEntropy::new(111)),
            Err(LedgerError::OutstandingUnknown)
        ));
        assert_eq!(
            resumed
                .gen0_placement_input(&r.p, &mut r.h.e, &r.target)
                .err(),
            Some(LedgerError::Refused)
        );
    }
}

#[test]
fn objects_present_without_window_settlement_are_still_unknown_after_crash() {
    let mut r = run();
    let mut store = Objects::default();
    let out =
        r.d.gen0_window(
            &r.p,
            &mut r.h.e,
            &r.target,
            &window_input(r.target.admission().collection(), resource_rows(&r.l)),
        )
        .unwrap();
    store.put(&out);
    assert!(out.verify.iter().all(|a| store.0.contains_key(a)));
    let settled = r.d.test_settled();
    let mut resumed = JournalDriver::resume(
        r.d.into_index(),
        binding(&r.target),
        &mut TestEntropy::new(110),
    )
    .unwrap();
    assert_eq!(resumed.test_settled(), settled);
    assert!(matches!(
        resumed.prepare(&mut TestEntropy::new(111)),
        Err(LedgerError::OutstandingUnknown)
    ));
}

#[test]
fn empty_current_file_has_an_authenticated_chunk_and_manifest() {
    let mut l = legacy();
    l.files[0].2.clear();
    let mut r = run_legacy(l);
    let mut store = Objects::default();
    r.windows(&mut store, 90);
    let out = r.d.gen0_finish(&r.p, &mut r.h.e, &r.target).unwrap();
    store.put(&out);
    let flags = store.result(r.c(), &out.verify);
    r.d.settle_gen0(&r.p, &mut r.h.e, &r.target, &flags)
        .unwrap();
    assert_eq!(
        r.d.test_checkpoint().state_digest,
        Some(expected_digest(&r.l))
    );
}

#[test]
fn file_policy_bound_refuses_before_sealing_and_never_settles() {
    let (svc, cp, _, _) = fixture();
    let mut h = open(&svc);
    h.pump(false);
    let target = h.e.observe_native_target().unwrap();
    let l = legacy();
    let (d, p) = read_with(&mut h, &target, &l, Some((1 << 30) + 1));
    let mut r = Run {
        svc,
        cp,
        h,
        target,
        l,
        d,
        p,
    };
    let mut store = Objects::default();
    r.window(&mut store, 90);
    let settled = r.d.test_settled();
    let step = r.d.test_checkpoint().step;
    let input = file_chunk_input(r.c(), 9, 0, GIF);
    assert_eq!(
        r.d.gen0_file_chunk(&r.p, &mut r.h.e, &r.target, &input)
            .err(),
        Some(LedgerError::Unsupported)
    );
    r.unmoved(settled, step);
}

fn streamed() -> Run {
    let mut l = legacy();
    l.files[0].2 = vec![0x7b; (8 << 20) + 17];
    run_legacy(l)
}

#[test]
fn partial_stream_wrong_offset_identity_source_and_hash_never_stage_a_file() {
    let mut r = streamed();
    let mut store = Objects::default();
    r.window(&mut store, 90);
    let c = r.target.admission().collection();
    let settled = r.d.test_settled();
    let step = r.d.test_checkpoint().step;
    let bytes = r.l.files[0].2.clone();
    let first = file_chunk_input(c, 9, 0, &bytes[..8 << 20]);
    let out =
        r.d.gen0_file_chunk(&r.p, &mut r.h.e, &r.target, &first)
            .unwrap();
    assert_eq!(out.objects.len(), 1);
    assert!(out.verify.is_empty());
    store.put(&out);
    for bad in [
        first.clone(), // replayed offset zero
        file_chunk_input(c, 8, 8 << 20, &bytes[8 << 20..]),
        file_chunk_input(c, 9, (8 << 20) + 1, &bytes[8 << 20..]),
        file_chunk_input(B16([3; 16]), 9, 8 << 20, &bytes[8 << 20..]),
    ] {
        assert!(
            r.d.gen0_file_chunk(&r.p, &mut r.h.e, &r.target, &bad)
                .is_err()
        );
        r.unmoved(settled, step);
    }
    let mut wrong_source =
        mdbn_wire::cbor::decode(&file_chunk_input(c, 9, 8 << 20, &bytes[8 << 20..])).unwrap();
    let Cbor::Array(fields) = &mut wrong_source else {
        panic!()
    };
    fields[2] = b([0x62; 16]);
    assert_eq!(
        r.d.gen0_file_chunk(&r.p, &mut r.h.e, &r.target, &encode(&wrong_source).unwrap())
            .err(),
        Some(LedgerError::Conflict)
    );
    assert_eq!(
        r.d.gen0_window(
            &r.p,
            &mut r.h.e,
            &r.target,
            &window_input(c, record_rows(&r.l, 0, 0))
        )
        .err(),
        Some(LedgerError::Conflict)
    );
    r.unmoved(settled, step);
    // Exact size but incorrect final bytes: whole hash refuses and aborts custody.
    let wrong_hash = file_chunk_input(c, 9, 8 << 20, &[0x19; 17]);
    assert_eq!(
        r.d.gen0_file_chunk(&r.p, &mut r.h.e, &r.target, &wrong_hash)
            .err(),
        Some(LedgerError::Conflict)
    );
    r.unmoved(settled, step);
    assert!(
        r.d.gen0_window(
            &r.p,
            &mut r.h.e,
            &r.target,
            &window_input(c, record_rows(&r.l, 0, 0))
        )
        .is_err()
    );
}

#[test]
fn partial_stream_crash_never_becomes_a_completed_file() {
    let mut r = streamed();
    let mut store = Objects::default();
    r.window(&mut store, 90);
    let input = file_chunk_input(
        r.target.admission().collection(),
        9,
        0,
        &r.l.files[0].2[..8 << 20],
    );
    let out =
        r.d.gen0_file_chunk(&r.p, &mut r.h.e, &r.target, &input)
            .unwrap();
    store.put(&out);
    let settled = r.d.test_settled();
    let mut resumed = JournalDriver::resume(
        r.d.into_index(),
        binding(&r.target),
        &mut TestEntropy::new(110),
    )
    .unwrap();
    assert_eq!(resumed.test_settled(), settled);
    assert!(matches!(
        resumed.prepare(&mut TestEntropy::new(111)),
        Err(LedgerError::OutstandingUnknown)
    ));
}

pub(super) fn bucket_stream_rows() -> Legacy {
    let mut l = legacy();
    l.records = (1..=60)
        .map(|n| {
            (
                n,
                path(format!("notes/{n:03}.md")),
                format!("# {n}\n{}", "r".repeat(12 << 10)),
            )
        })
        .collect();
    l.files[0].0 = 240; // A different entity ID from every record.
    l.files[0].2 = vec![0x9e; (8 << 20) + 17];
    l
}

#[test]
fn byte_bounded_windows_cross_buckets_and_stream_file_chunks_then_finish() {
    let mut r = run_legacy(bucket_stream_rows());
    let mut store = Objects::default();
    let mut windows = 0;
    let mut saw_continuation = false;
    while !matches!(r.d.prepared_action(&r.p).unwrap(), Action::FinishGen0) {
        saw_continuation |= matches!(
            r.d.prepared_action(&r.p).unwrap(),
            Action::ImportGen0 { after: Some(_), .. }
        );
        r.window(&mut store, 90 + windows);
        windows += 1;
    }
    assert!(saw_continuation);
    assert!(windows > 4);
    assert!(store.0.values().any(|bytes| bytes.len() > 1 << 20));
    let out = r.d.gen0_finish(&r.p, &mut r.h.e, &r.target).unwrap();
    store.put(&out);
    r.d.settle_gen0(
        &r.p,
        &mut r.h.e,
        &r.target,
        &store.result(r.target.admission().collection(), &out.verify),
    )
    .unwrap();
    assert_eq!(
        r.d.test_checkpoint().state_digest,
        Some(expected_digest(&r.l))
    );
}

#[test]
fn a_near_limit_text_row_remains_supported_with_charged_framing() {
    let mut l = legacy();
    l.records[0].2 = "x".repeat(60 << 10);
    let mut r = run_legacy(l);
    let mut store = Objects::default();
    r.windows(&mut store, 90);
    let out = r.d.gen0_finish(&r.p, &mut r.h.e, &r.target).unwrap();
    store.put(&out);
    let flags = store.result(r.c(), &out.verify);
    r.d.settle_gen0(&r.p, &mut r.h.e, &r.target, &flags)
        .unwrap();
    assert_eq!(
        r.d.test_checkpoint().state_digest,
        Some(expected_digest(&r.l))
    );
}

#[test]
fn old_limit_and_native_record_cap_seal_in_isolated_windows() {
    for size in [
        (64 << 10) - 302,
        (64 << 10) - 301,
        64 << 10,
        93_655,
        1 << 20,
    ] {
        let mut l = legacy();
        l.records[0].2 = format!("\u{feff}{}", "x".repeat(size - 3));
        assert_eq!(l.records[0].2.len(), size);
        let mut r = run_legacy(l);
        let mut store = Objects::default();
        r.windows(&mut store, 90);
        let out = r.d.gen0_finish(&r.p, &mut r.h.e, &r.target).unwrap();
        store.put(&out);
        let flags = store.result(r.c(), &out.verify);
        r.d.settle_gen0(&r.p, &mut r.h.e, &r.target, &flags)
            .unwrap();
        assert_eq!(
            r.d.test_checkpoint().state_digest,
            Some(expected_digest(&r.l))
        );
    }
}

#[test]
fn isolated_record_uploaded_without_settlement_stays_unknown_after_crash() {
    let mut l = legacy();
    l.records[0].2 = "x".repeat(1 << 20);
    let mut r = run_legacy(l);
    let mut store = Objects::default();
    r.window(&mut store, 90);
    // Hash bucket may have empty windows before this record.
    loop {
        let selected =
            r.d.gen0_placement_input(&r.p, &mut r.h.e, &r.target)
                .unwrap();
        let Cbor::Array(fields) = mdbn_wire::cbor::decode(&selected).unwrap() else {
            panic!()
        };
        let Cbor::Array(rows) = &fields[0] else {
            panic!()
        };
        if rows
            .iter()
            .any(|row| matches!(row, Cbor::Array(f) if f[1] == t(&key(1))))
        {
            break;
        }
        r.window(&mut store, 91);
    }
    let input = window_input(r.c(), vec![(b(id(1)), r.l.records[0].2.clone())]);
    let out =
        r.d.gen0_window(&r.p, &mut r.h.e, &r.target, &input)
            .unwrap();
    store.put(&out);
    let settled = r.d.test_settled();
    let mut resumed = JournalDriver::resume(
        r.d.into_index(),
        binding(&r.target),
        &mut TestEntropy::new(110),
    )
    .unwrap();
    assert_eq!(resumed.test_settled(), settled);
    assert!(matches!(
        resumed.prepare(&mut TestEntropy::new(111)),
        Err(LedgerError::OutstandingUnknown)
    ));
}
