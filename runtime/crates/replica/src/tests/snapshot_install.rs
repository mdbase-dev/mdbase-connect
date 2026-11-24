//! Snapshot install batching: per-page control commits, bounded concurrent
//! chunk fetches staged in manifest order inside one deferred-durability window
//! per wave, and crash recovery during chunk staging.

use mdbn_wire::client::{IncidentKind, SubmitParams};
use mdbn_wire::common::{B16, B32, Bytes, Text};
use mdbn_wire::intent::{Create, Op, ResourcePut};
use mdbn_wire::log_service::{ReadResult, SeqItem};
use mdbn_wire::policy::{DeviceEnrol, DeviceKind, PolicyOp};

use super::engine::{COL, Node, node, settle};
use super::snapshot_trust::pointers;
use crate::Store;
use crate::api::ClientApi;
use crate::fake::FakeLogService;
use crate::log::{LogClient, LogError, LogErrorCode, LogPort, LogRequest, LogResponse};
use crate::mem::MemStore;
use crate::replica::TestInstall;
use crate::replica::snapshot::CHUNKS_IN_FLIGHT;
use crate::store::meta_keys;
use crate::testkit::{TEST_OWNER, TestControlPlane};

fn enrol_op(byte: u8) -> PolicyOp {
    PolicyOp::DeviceEnrol(DeviceEnrol {
        device: B16([byte; 16]),
        account: TEST_OWNER,
        kind: DeviceKind::Desktop,
        sign_pk: B32([byte; 32]),
        kem_pk: B32([byte.wrapping_add(1); 32]),
        noise_pk: B32([byte.wrapping_add(2); 32]),
        sas_commit: None,
        local_root: None,
    })
}

fn control_items(svc: &FakeLogService) -> Vec<SeqItem> {
    use mdbn_wire::envelope::Item;
    use mdbn_wire::schema::Wire;
    svc.items(&COL)
        .into_iter()
        .enumerate()
        .filter_map(|(i, raw)| {
            let item = Item::from_bytes(&raw).ok()?;
            item.kind.is_control().then_some(SeqItem {
                seq: i as u64 + 1,
                item: Bytes(raw),
            })
        })
        .collect()
}

fn submit(a: &mut Node, ops: Vec<Op>) {
    a.r.submit(
        a.s,
        SubmitParams {
            ops,
            mutation_id: None,
            conflict_mode: None,
            timezone: None,
            allow_partial: None,
            mutation_ids: None,
            dry_run: None,
            include: None,
            wait: None,
            validation: None,
        },
    )
    .expect("submit");
}

/// A multi-chunk collection with a resource catalog (so `Resources` must decode
/// before `Records` for `record_meta` to match) and enough record bytes to
/// split into multiple 512 KiB buckets (> 2 waves of `CHUNKS_IN_FLIGHT`).
fn multi_wave_snapshot(svc: &FakeLogService) -> Node {
    let mut a = node(svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    submit(
        &mut a,
        vec![
            Op::ResourcePut(ResourcePut {
                path: "mdbase.yaml".into(),
                doc: Text::Inline("spec_version: \"0.2.0\"\n".into()),
                base_revision: None,
                must_not_exist: None,
            }),
            Op::ResourcePut(ResourcePut {
                path: "_types/task.md".into(),
                doc: Text::Inline(
                    "---\nname: task\nmatch:\n  path_glob: \"tasks/**/*.md\"\nfields:\n  status:\n    type: string\n---\n"
                        .into(),
                ),
                base_revision: None,
                must_not_exist: None,
            }),
        ],
    );
    settle(&mut [&mut a]);
    let pad = "x".repeat(48 * 1024);
    for batch in 0..7u8 {
        let mut ops = Vec::new();
        for j in 0..10u8 {
            let n = batch * 10 + j + 1;
            ops.push(Op::Create(Create {
                id: B16([n; 16]),
                path: Some(format!("tasks/n{n:03}.md")),
                type_name: None,
                frontmatter: None,
                body: None,
                document: Some(Text::Inline(format!("---\nstatus: open-{n}\n---\n{pad}\n"))),
            }));
        }
        submit(&mut a, ops);
        settle(&mut [&mut a]);
    }
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a]);
    assert_eq!(a.r.stats.snapshots_built, 1);
    svc.compact(&COL, a.r.head().seq);
    a
}

fn read_result(svc: &FakeLogService, items: Vec<SeqItem>, more: bool) -> LogResponse {
    let (head, head_chain) = svc.head(&COL);
    LogResponse::Read(ReadResult {
        items,
        head,
        head_chain,
        retained_from: 1,
        behind: false,
        snapshot: None,
        more,
    })
}

/// Multi-page `Install::Control` commits once per page (not once per item),
/// keeps no partial state in memory or storage when a later item in page 2
/// fails, and resumes cleanly from the durable `policy.seq` after a crash
/// between pages.
#[test]
fn multi_page_control_install_commits_once_per_page_and_rolls_back_mid_page_failure() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    let mut cp = TestControlPlane::new(COL);
    for b in 201..=206u8 {
        cp.append(&svc, vec![enrol_op(b)]);
    }
    settle(&mut [&mut a]);
    a.create(1, "note.md", "hello");
    settle(&mut [&mut a]);
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a]);
    svc.compact(&COL, a.r.head().seq);

    let all_ctl = control_items(&svc);
    assert!(
        all_ctl.len() >= 8,
        "expected >= 8 control items, got {}",
        all_ctl.len()
    );
    let split = all_ctl.len() / 2;
    let page1 = all_ctl[..split].to_vec();
    let page2 = all_ctl[split..].to_vec();
    let page1_last = page1.last().unwrap().seq;
    let page2_first_dev = B16([201 + (split as u8 - 2); 16]);
    let genesis = mdbn_wire::hash::chain_hash(&svc.items(&COL)[0]);

    // 1. Happy two-page control install: exactly 1 commit per page, and
    //    `GetSnapshot` still follows after the last control page.
    {
        let mut c = node(&svc, 3, MemStore::new());
        c.r.cfg.expected_genesis = Some(genesis);
        let _ = c.r.take_log_calls();
        c.r.begin_install();
        let call1 = c.r.take_log_calls().pop().unwrap();
        let before = c.r.store().data().borrow().commits;
        c.r.on_log_reply(call1.id, Ok(read_result(&svc, page1.clone(), true)));
        assert_eq!(
            c.r.store().data().borrow().commits,
            before + 1,
            "page 1 ({} items) commits once",
            page1.len()
        );
        assert_eq!(c.r.policy.seq, page1_last);
        assert_eq!(c.r.genesis, Some(genesis));
        assert_eq!(
            c.r.store().meta(meta_keys::GENESIS).unwrap(),
            Some(genesis.0.to_vec())
        );

        let call2 = c.r.take_log_calls().pop().unwrap();
        assert!(matches!(
            call2.request,
            LogRequest::Read(ref p) if p.after == page1_last
        ));
        c.r.on_log_reply(call2.id, Ok(read_result(&svc, page2.clone(), false)));
        assert_eq!(
            c.r.store().data().borrow().commits,
            before + 2,
            "page 2 ({} items) commits once",
            page2.len()
        );
        assert_eq!(c.r.policy.seq, page2.last().unwrap().seq);
        assert!(matches!(c.r.install, Some(TestInstall::Pointer)));
        let next = c.r.take_log_calls();
        assert!(
            matches!(next.as_slice(), [call] if matches!(call.request, LogRequest::GetSnapshot { .. })),
            "GetSnapshot is preserved after control pages"
        );
    }

    // 2. Failure mid-page on page 2: item 0 of page 2 is valid and mutates
    //    in-memory policy, item 1 is corrupt. Neither RAM nor store keeps
    //    anything from page 2.
    {
        let mut c = node(&svc, 3, MemStore::new());
        c.r.cfg.expected_genesis = Some(genesis);
        let _ = c.r.take_log_calls();
        c.r.begin_install();
        let call1 = c.r.take_log_calls().pop().unwrap();
        c.r.on_log_reply(call1.id, Ok(read_result(&svc, page1.clone(), true)));

        let commits_after_p1 = c.r.store().data().borrow().commits;
        let stored_policy_p1 = c.r.store().meta(meta_keys::POLICY).unwrap().unwrap();
        let mem_policy_p1 = c.r.policy.clone();
        let keys_p1 = c.r.testing_epoch_keys();
        assert!(!mem_policy_p1.devices.contains_key(&page2_first_dev));

        let mut bad_page2 = page2.clone();
        bad_page2[1].item = Bytes(vec![0xff, 0x00, 0x01]);
        let call2 = c.r.take_log_calls().pop().unwrap();
        c.r.on_log_reply(call2.id, Ok(read_result(&svc, bad_page2, false)));

        assert!(!c.r.installing(), "install aborted on mid-page error");
        assert!(
            c.r.sync_status()
                .incidents
                .iter()
                .any(|i| i.kind == IncidentKind::Integrity)
        );
        assert_eq!(
            c.r.store().data().borrow().commits,
            commits_after_p1 + 1,
            "failed page 2 must not commit policy (only install_abort's Stage::Discard)"
        );
        assert_eq!(
            c.r.store().meta(meta_keys::POLICY).unwrap().unwrap(),
            stored_policy_p1,
            "stored policy stays at page 1"
        );
        assert_eq!(
            c.r.policy, mem_policy_p1,
            "in-memory policy has no partial state from page 2's first item"
        );
        assert_eq!(c.r.testing_epoch_keys(), keys_p1);
        assert!(c.r.install_points.is_empty());
        assert!(!c.r.requires_reopen(), "bad item rolled back cleanly");
    }

    // 3. Simulated crash between page 1 and page 2: reopen resumes from page 1's
    //    durable `policy.seq` and completes the install.
    {
        let mut c = node(&svc, 3, MemStore::new());
        c.r.cfg.expected_genesis = Some(genesis);
        let _ = c.r.take_log_calls();
        c.r.begin_install();
        let call1 = c.r.take_log_calls().pop().unwrap();
        c.r.on_log_reply(call1.id, Ok(read_result(&svc, page1.clone(), true)));
        assert_eq!(c.r.policy.seq, page1_last);
        assert_eq!(c.r.head().seq, 0);
        let persisted = c.r.into_store().data();

        let mut reopened = node(&svc, 3, MemStore::shared(persisted));
        reopened.r.cfg.expected_genesis = Some(genesis);
        assert_eq!(reopened.r.policy.seq, page1_last);
        assert_eq!(reopened.r.head().seq, 0);
        // Verify the restarted control read resumes after `page1_last`.
        let mut saw_resumed_control_read = false;
        for _ in 0..64 {
            for push in reopened.log.poll_pushes() {
                reopened.r.on_log_push(push);
            }
            for call in reopened.r.take_log_calls() {
                if let LogRequest::Read(ref p) = call.request
                    && p.kinds == Some(mdbn_wire::log_service::ReadKinds::Control)
                {
                    assert_eq!(p.after, page1_last);
                    saw_resumed_control_read = true;
                }
                let reply = reopened.log.call(call.request);
                reopened.r.on_log_reply(call.id, reply);
            }
            reopened.r.tick();
            if reopened.r.stats.snapshots_installed == 1 && reopened.r.head() == a.r.head() {
                break;
            }
        }
        assert!(saw_resumed_control_read);
        assert_eq!(reopened.r.stats.snapshots_installed, 1);
        assert_eq!(reopened.r.head(), a.r.head());
        assert_eq!(reopened.doc(1).as_deref(), Some("hello"));
    }
}

/// Chunk fetches run up to `CHUNKS_IN_FLIGHT` (6) concurrently, out-of-order
/// replies are staged strictly in manifest order inside one deferred-durability
/// window per completed wave, and no window is ever left open across replies.
#[test]
fn out_of_order_chunk_replies_stage_in_manifest_order_with_one_window_per_wave() {
    let svc = FakeLogService::new();
    let a = multi_wave_snapshot(&svc);

    let mut c = node(&svc, 3, MemStore::new());
    let mut max_wave = 0usize;
    let mut chunk_waves = 0u64;
    let mut total_chunks = 0u64;
    let mut windows_before_chunks = None;
    let mut windows_after_chunks = None;

    for _ in 0..100 {
        for push in c.log.poll_pushes() {
            c.r.on_log_push(push);
        }
        let calls = c.r.take_log_calls();
        if calls.is_empty() {
            c.r.tick();
            if c.r.stats.snapshots_installed == 1 && c.r.head() == a.r.head() {
                break;
            }
            continue;
        }
        if matches!(c.r.install, Some(TestInstall::Chunks(_))) {
            if windows_before_chunks.is_none() {
                windows_before_chunks = Some(c.r.store().data().borrow().windows);
            }
            assert!(
                calls.len() <= CHUNKS_IN_FLIGHT,
                "at most {CHUNKS_IN_FLIGHT} chunks in flight, got {}",
                calls.len()
            );
            max_wave = max_wave.max(calls.len());
            chunk_waves += 1;
            total_chunks += calls.len() as u64;
            // Deliver this wave's replies in reverse order so later sections
            // (e.g. Records) arrive before earlier ones (Resources, Index).
            let mut responses: Vec<_> = calls
                .into_iter()
                .map(|call| {
                    let reply = c.log.call(call.request);
                    (call.id, reply)
                })
                .collect();
            responses.reverse();
            let win_start = c.r.store().data().borrow().windows;
            let len = responses.len();
            for (i, (id, reply)) in responses.into_iter().enumerate() {
                c.r.on_log_reply(id, reply);
                assert!(
                    !c.r.store().durability_deferred(),
                    "durability window must never remain open across replies"
                );
                let win_now = c.r.store().data().borrow().windows;
                if i + 1 < len {
                    assert_eq!(
                        win_now, win_start,
                        "wave stages only once all in-flight replies arrive"
                    );
                } else {
                    assert_eq!(
                        win_now,
                        (win_start.0 + 1, win_start.1 + 1),
                        "completed wave stages inside exactly one deferred-durability window"
                    );
                }
            }
            if !matches!(c.r.install, Some(TestInstall::Chunks(_))) {
                windows_after_chunks = Some(c.r.store().data().borrow().windows);
            }
        } else {
            for call in calls {
                let reply = c.log.call(call.request);
                c.r.on_log_reply(call.id, reply);
                assert!(!c.r.store().durability_deferred());
            }
        }
        c.r.tick();
        if c.r.stats.snapshots_installed == 1 && c.r.head() == a.r.head() {
            break;
        }
    }

    assert_eq!(max_wave, CHUNKS_IN_FLIGHT);
    assert!(
        total_chunks > CHUNKS_IN_FLIGHT as u64 * 2,
        "need multiple waves, got {total_chunks} chunks"
    );
    let before = windows_before_chunks.unwrap();
    let after = windows_after_chunks.unwrap();
    assert_eq!(after.0 - before.0, chunk_waves);
    assert_eq!(after.1 - before.1, chunk_waves);
    assert_eq!(chunk_waves, total_chunks.div_ceil(CHUNKS_IN_FLIGHT as u64));

    assert_eq!(c.r.stats.snapshots_installed, 1);
    assert_eq!(c.r.sync_status().incidents, vec![]);
    assert_eq!(c.r.head(), a.r.head());
    assert_eq!(
        crate::replica::state_digest(c.r.store()).unwrap(),
        crate::replica::state_digest(a.r.store()).unwrap()
    );
    // Every record's derived `meta` (types + effective fields) matches `a`,
    // proving `Resources` and `Index` were staged before `Records`.
    let a_recs = a.r.confirmed_records().unwrap();
    let c_recs = c.r.confirmed_records().unwrap();
    assert_eq!(c_recs.len(), 70);
    assert_eq!(c_recs, a_recs);
}

/// A transient error on one chunk inside an out-of-order wave stages the ready
/// prefix, buffers the later chunks, retries only the failed chunk on tick, and
/// finishes with the exact snapshot state.
#[test]
fn transient_chunk_error_mid_wave_retries_cleanly_with_out_of_order_replies() {
    let svc = FakeLogService::new();
    let a = multi_wave_snapshot(&svc);

    let mut c = node(&svc, 3, MemStore::new());
    let mut injected = false;
    for _ in 0..100 {
        for push in c.log.poll_pushes() {
            c.r.on_log_push(push);
        }
        let calls = c.r.take_log_calls();
        if matches!(c.r.install, Some(TestInstall::Chunks(_))) && !injected && calls.len() >= 3 {
            injected = true;
            // Fail chunk index 1 transiently, deliver remaining replies out of order.
            let mut responses: Vec<_> = calls
                .into_iter()
                .enumerate()
                .map(|(pos, call)| {
                    let reply = if pos == 1 {
                        Err(LogError::code(LogErrorCode::Unavailable))
                    } else {
                        c.log.call(call.request)
                    };
                    (call.id, reply)
                })
                .collect();
            responses.reverse();
            for (id, reply) in responses {
                c.r.on_log_reply(id, reply);
                assert!(!c.r.store().durability_deferred());
            }
            // Chunk 0 staged, chunks 2..6 remain buffered, chunk 1 awaits tick retry.
            assert_eq!(c.r.install_status().unwrap().0, 1);
            assert!(c.r.take_log_calls().is_empty(), "retry waits for tick");
            c.r.tick();
            // Retry queues failed chunk 1 plus 1 new slot (chunk 6) -> 2 calls,
            // keeping total buffered + in-flight == CHUNKS_IN_FLIGHT.
            let retry_calls = c.r.take_log_calls();
            assert_eq!(retry_calls.len(), 2);
            for call in retry_calls.into_iter().rev() {
                let reply = c.log.call(call.request);
                c.r.on_log_reply(call.id, reply);
            }
            // All 6 (1..=6) staged together once retry wave completed.
            assert_eq!(c.r.install_status().unwrap().0, 7);
            continue;
        }
        for call in calls {
            let reply = c.log.call(call.request);
            c.r.on_log_reply(call.id, reply);
        }
        c.r.tick();
        if c.r.stats.snapshots_installed == 1 && c.r.head() == a.r.head() {
            break;
        }
    }

    assert!(injected);
    assert_eq!(c.r.stats.snapshots_installed, 1);
    assert_eq!(c.r.sync_status().incidents, vec![]);
    assert_eq!(c.r.head(), a.r.head());
    assert_eq!(
        c.r.confirmed_records().unwrap(),
        a.r.confirmed_records().unwrap()
    );
}

/// A missing chunk (`NotFound`) mid-wave cancels the remaining in-flight chunk
/// calls so their late replies are ignored as stale and fallback to the older
/// snapshot succeeds cleanly.
#[test]
fn missing_chunk_mid_wave_cancels_siblings_and_falls_back_cleanly() {
    let svc = FakeLogService::new();
    let mut a = multi_wave_snapshot(&svc);
    let older = a.r.head().seq;
    let before_objs: Vec<B32> = svc.objects(&COL).into_iter().map(|(h, _)| h).collect();
    a.create(99, "tasks/extra.md", "---\nstatus: extra\n---\nextra\n");
    settle(&mut [&mut a]);
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a]);
    let ptrs = pointers(&svc);
    assert_eq!(ptrs.len(), 2);
    let newest_chunk = svc
        .objects(&COL)
        .into_iter()
        .map(|(h, _)| h)
        .find(|h| !before_objs.contains(h) && *h != ptrs[0].manifest)
        .unwrap();
    svc.forget_object(&COL, &newest_chunk);
    svc.compact(&COL, older);

    let mut c = node(&svc, 3, MemStore::new());
    let mut deferred_late: Vec<(crate::log::CallId, crate::log::LogReply)> = Vec::new();
    for _ in 0..120 {
        for push in c.log.poll_pushes() {
            c.r.on_log_push(push);
        }
        let calls = c.r.take_log_calls();
        if matches!(c.r.install, Some(TestInstall::Chunks(_))) && c.r.stats.snapshot_fallbacks == 0
        {
            let mut responses: Vec<_> = calls
                .into_iter()
                .map(|call| {
                    let reply = c.log.call(call.request);
                    (call.id, reply)
                })
                .collect();
            // If this wave hits the missing chunk, deliver the NotFound FIRST and
            // hold the sibling replies to deliver later after fallback starts!
            if let Some(pos) = responses
                .iter()
                .position(|(_, r)| matches!(r, Err(e) if e.object_missing()))
            {
                let (bad_id, bad_reply) = responses.remove(pos);
                c.r.on_log_reply(bad_id, bad_reply);
                assert_eq!(c.r.stats.snapshot_fallbacks, 1);
                assert!(matches!(c.r.install, Some(TestInstall::Manifest(_))));
                deferred_late.extend(responses);
                // Deliver stale replies from the aborted wave while Manifest is in flight!
                for (late_id, late_reply) in deferred_late.drain(..) {
                    c.r.on_log_reply(late_id, late_reply);
                }
                assert!(
                    matches!(c.r.install, Some(TestInstall::Manifest(_))),
                    "stale sibling chunk replies must not interfere with fallback manifest"
                );
                continue;
            }
            for (id, reply) in responses {
                c.r.on_log_reply(id, reply);
            }
        } else {
            for call in calls {
                let reply = c.log.call(call.request);
                c.r.on_log_reply(call.id, reply);
            }
        }
        c.r.tick();
        if c.r.stats.snapshots_installed == 1 && c.r.head() == a.r.head() {
            break;
        }
    }

    assert_eq!(c.r.stats.snapshot_fallbacks, 1);
    assert_eq!(c.r.stats.snapshots_installed, 1);
    assert_eq!(c.r.sync_status().incidents, vec![]);
    assert_eq!(c.r.head(), a.r.head());
    assert_eq!(
        c.r.confirmed_records().unwrap(),
        a.r.confirmed_records().unwrap()
    );
}

/// A simulated crash mid-way through chunk staging (after earlier waves have
/// written to the staging tables and while a later wave is half-buffered) leaves
/// confirmed state untouched; reopening discards stale staging tables via
/// `Stage::Discard` and completes the install cleanly.
#[test]
fn simulated_crash_during_chunk_staging_restarts_cleanly() {
    let svc = FakeLogService::new();
    let a = multi_wave_snapshot(&svc);

    // Run until wave 1 & wave 2 have staged into staging tables and wave 3 is
    // half-delivered, then crash (drop replica, preserve store).
    let mut c = node(&svc, 3, MemStore::new());
    let mut waves_done = 0u32;
    let mut crashed = false;
    for _ in 0..100 {
        for push in c.log.poll_pushes() {
            c.r.on_log_push(push);
        }
        let calls = c.r.take_log_calls();
        if matches!(c.r.install, Some(TestInstall::Chunks(_))) {
            if waves_done == 2 {
                // Deliver only half of wave 3, then simulate crash!
                let half = calls.len() / 2;
                for call in calls.into_iter().take(half) {
                    let reply = c.log.call(call.request);
                    c.r.on_log_reply(call.id, reply);
                }
                crashed = true;
                break;
            }
            for call in calls {
                let reply = c.log.call(call.request);
                c.r.on_log_reply(call.id, reply);
            }
            waves_done += 1;
        } else {
            for call in calls {
                let reply = c.log.call(call.request);
                c.r.on_log_reply(call.id, reply);
            }
        }
        c.r.tick();
    }

    assert!(crashed);
    assert!(!c.r.store().durability_deferred());
    assert!(
        c.r.store().staged_rows() > 0,
        "earlier waves wrote into staging tables"
    );
    assert_eq!(c.r.head().seq, 0, "confirmed head untouched before swap");
    assert!(
        c.r.confirmed_records().unwrap().is_empty(),
        "confirmed state untouched before swap"
    );

    let persisted = c.r.into_store().data();
    // Reopen fresh replica over the crashed store.
    let mut restarted = node(&svc, 3, MemStore::shared(persisted));
    assert_eq!(restarted.r.head().seq, 0);
    assert!(restarted.r.confirmed_records().unwrap().is_empty());
    assert!(
        restarted.r.store().staged_rows() > 0,
        "stale staged rows sit on disk until the new install discards them"
    );

    settle(&mut [&mut restarted]);
    assert_eq!(restarted.r.stats.snapshots_installed, 1);
    assert_eq!(restarted.r.sync_status().incidents, vec![]);
    assert_eq!(restarted.r.head(), a.r.head());
    assert_eq!(restarted.r.store().staged_rows(), 0);
    assert_eq!(
        restarted.r.confirmed_records().unwrap(),
        a.r.confirmed_records().unwrap()
    );
}
