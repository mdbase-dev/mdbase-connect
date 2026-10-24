//! Native base/cutover append, find, log head, rebuild and read-new through the
//! actual Engine's log path: CAS conflicts, lost acknowledgements, foreign
//! runs and collections, concurrent writers and truncated or forged logs never
//! settle a result the log does not show.
use super::*;
use mdbn_wire::common::{B64, Bytes};
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::policy::{Freeze, MemberSet, MigrationCutover, PolicyOp, Role};

const FINAL_SESSION: [u8; 16] = [0x62; 16];

#[test]
fn multi_window_sections_and_streamed_attachment_install_and_compare() {
    for legacy in [
        super::windows::many_rows(),
        super::windows::bucket_stream_rows(),
    ]
    .into_iter()
    .chain(
        [
            (64 << 10) - 302,
            (64 << 10) - 301,
            64 << 10,
            93_655,
            1 << 20,
        ]
        .into_iter()
        .map(|size| {
            let mut l = legacy();
            l.records[0].2 = format!("\u{feff}{}", "x".repeat(size - 3));
            l
        }),
    ) {
        SEED.set(140);
        let mut r = run_legacy(legacy);
        r.reach_rebuild();
        r.compare(130);
        assert_eq!(r.d.test_checkpoint().step, Step::Shadowed);
        assert_eq!(
            r.d.test_checkpoint().state_digest,
            Some(expected_digest(&r.l))
        );
        for (n, path, doc) in &r.l.records {
            let installed =
                r.h.e
                    .replica()
                    .store()
                    .record(&B16(id(*n)))
                    .unwrap()
                    .unwrap();
            assert_eq!(&installed.path, path);
            assert_eq!(installed.doc.as_bytes(), doc.as_bytes());
        }
    }
}

thread_local! {
    static SEED: std::cell::Cell<u8> = const { std::cell::Cell::new(140) };
}

fn replica_id() -> [u8; 16] {
    id(0x72)
}

impl Run {
    /// The host re-observes the SAME target after the log moved (`abi.rs`
    /// `migration_target_fresh`); a target it cannot re-observe refuses.
    fn refresh(&mut self) -> bool {
        match self.h.e.refresh_native_target(&self.target) {
            Ok(fresh) => {
                self.target = fresh;
                true
            }
            Err(_) => false,
        }
    }
    fn log(&mut self) -> Result<B32, LedgerError> {
        if !self.refresh() {
            return Err(LedgerError::Refused);
        }
        self.d.settle_log(&self.p, &mut self.h.e, &self.target)
    }
    fn append(&mut self) -> Result<(B32, u64), LedgerError> {
        if !self.refresh() {
            return Err(LedgerError::Refused);
        }
        self.d
            .log_append(&self.p, &mut self.h.e, &self.target)
            .map(|o| (o.item, o.seq))
    }
    fn action(&mut self) -> Action {
        self.d.prepared_action(&self.p).unwrap().clone()
    }
    /// Prepare the next action. Every action id is unique (`mig_native_action`),
    /// and polls that only `Continue` draw no entropy, so ids come from one
    /// per-test counter above every seed the generation-0 setup used.
    #[track_caller]
    fn advance(&mut self, _seed: u8) {
        loop {
            let seed = SEED.get();
            SEED.set(seed.checked_add(1).expect("out of test seeds"));
            match self.d.prepare(&mut TestEntropy::new(seed)) {
                Err(LedgerError::Unsupported) => SEED.set(seed),
                other => {
                    self.p = other.unwrap().0;
                    return;
                }
            }
        }
    }
    /// Settle the pending log action and prepare the next.
    #[track_caller]
    fn settle(&mut self, seed: u8) {
        let result = self.log().unwrap();
        self.d.assert_settled(&self.p, result).unwrap();
        self.advance(seed);
    }
    #[track_caller]
    fn provider(&mut self, body: Vec<u8>, seed: u8) {
        self.d.settle_provider(&self.p, &body).unwrap();
        self.advance(seed);
    }
    #[track_caller]
    fn source(&mut self, body: Vec<u8>, seed: u8) {
        self.d.settle_source(&self.p, &body).unwrap();
        self.advance(seed);
    }
    /// Every generation-0 window and the finish settled, every sealed object
    /// in the log service: `AppendBase` pending. Returns the base refs.
    #[track_caller]
    fn reach_base(&mut self) -> Vec<B32> {
        let mut store = Objects::default();
        self.windows(&mut store, 90);
        let out = self
            .d
            .gen0_finish(&self.p, &mut self.h.e, &self.target)
            .unwrap();
        store.put(&out);
        let flags = store.result(self.c(), &out.verify);
        let result = self
            .d
            .settle_gen0(&self.p, &mut self.h.e, &self.target, &flags)
            .unwrap();
        self.d.assert_settled(&self.p, result).unwrap();
        for bytes in store.0.values() {
            self.svc.put_object(&self.c(), bytes.clone());
        }
        self.advance(120);
        assert!(matches!(self.action(), Action::AppendBase { .. }));
        out.verify
    }
    /// The base appended, installed and settled: `Rebuild` pending.
    #[track_caller]
    fn reach_rebuild(&mut self) -> u64 {
        self.reach_base();
        let (_, seq) = self.append().unwrap();
        self.h.pump(false);
        self.settle(124);
        assert_eq!(self.d.test_checkpoint().base_seq, Some(seq));
        assert!(matches!(self.action(), Action::Rebuild { at_least } if at_least == seq));
        seq
    }
    /// Rebuild and every page settled.
    #[track_caller]
    fn compare(&mut self, seed: u8) {
        self.settle(seed);
        let mut seed = seed + 1;
        while matches!(self.action(), Action::ReadNew { .. }) {
            self.settle(seed);
            seed += 1;
        }
    }
    /// From `Shadowed`: re-fence, drain, the final read, list and revoke the
    /// legacy replica: `AppendCutover` pending.
    #[track_caller]
    fn reach_revoked(&mut self) {
        let c = self.c();
        assert_eq!(self.action(), Action::Fence);
        let fence = enc(vec![
            Cbor::Uint(2),
            b(c.0),
            t("migrating"),
            b(RUN),
            t(STARTED),
            Cbor::Null,
            Cbor::Array(vec![]),
        ]);
        self.provider(fence, 150);
        assert_eq!(self.action(), Action::DrainStatus);
        let drain = enc(vec![
            Cbor::Uint(3),
            b(c.0),
            t("migrating"),
            b(RUN),
            Cbor::Uint(HEAD),
            t(STARTED),
            Cbor::Null,
            Cbor::Uint(0),
            Cbor::Uint(1),
            Cbor::Uint(0),
        ]);
        self.provider(drain, 152);
        assert!(matches!(
            self.action(),
            Action::OpenSource {
                generation: Generation::Final,
                ..
            }
        ));
        let opened = enc(vec![
            Cbor::Uint(0),
            b(c.0),
            t("migrating"),
            Cbor::Uint(HEAD),
            b(FINAL_SESSION),
            b(HOLD),
        ]);
        self.source(opened, 154);
        let l = legacy();
        let final_page = |table: &str, rows: Vec<Cbor>| {
            enc(vec![
                Cbor::Uint(1),
                b(c.0),
                Cbor::Uint(HEAD),
                b(FINAL_SESSION),
                t(table),
                Cbor::Null,
                Cbor::Array(rows),
                Cbor::Null,
            ])
        };
        let resources = final_page(
            "resources",
            l.resources
                .iter()
                .map(|(path, text)| page_row(None, path, text.as_bytes()))
                .collect(),
        );
        self.source(resources, 156);
        let records = final_page(
            "records",
            l.records
                .iter()
                .map(|(n, path, doc)| page_row(Some(id(*n)), path, doc.as_bytes()))
                .collect(),
        );
        self.source(records, 158);
        let files = final_page(
            "files",
            l.files
                .iter()
                .map(|(n, path, bytes)| page_row(Some(id(*n)), path, bytes))
                .collect(),
        );
        self.source(files, 160);
        assert_eq!(self.action(), Action::ListReplicas);
        let ids = || Cbor::Array(vec![b(replica_id())]);
        self.provider(enc(vec![Cbor::Uint(4), ids()]), 162);
        assert!(matches!(self.action(), Action::RevokeReplicas { .. }));
        self.d
            .settle_provider(&self.p, &enc(vec![Cbor::Uint(5), ids()]))
            .unwrap();
        assert_eq!(self.d.test_checkpoint().step, Step::Revoked);
    }
    fn reach_cutover(&mut self) {
        self.reach_revoked();
        self.advance(164);
        assert!(matches!(self.action(), Action::AppendCutover { s_final } if s_final == HEAD));
    }
    /// The control plane appends `migration-cutover` (the hosted Worker cannot
    /// sign policy) and the Engine applies it.
    fn cutover(&mut self, legacy: Uuid, revoked: Vec<Uuid>) -> u64 {
        let seq = self.cp.append(
            &self.svc,
            vec![
                PolicyOp::MigrationCutover(MigrationCutover {
                    legacy_collection: legacy,
                    revoked,
                    cutover_at: 1_700_000_100_000,
                }),
                PolicyOp::Freeze(Freeze {
                    frozen: false,
                    reason: None,
                }),
            ],
        );
        self.h.pump(false);
        seq
    }
    /// A harmless control item from the control plane.
    fn control(&mut self, n: u8) -> u64 {
        let seq = self.cp.append(
            &self.svc,
            vec![PolicyOp::MemberSet(MemberSet {
                account: B16(id(0xa0 + n)),
                role: Role::Viewer,
            })],
        );
        self.h.pump(false);
        seq
    }
    fn policy_cutover(&mut self) -> Option<u64> {
        assert!(self.refresh());
        self.h
            .e
            .replica()
            .hosted_migration_cutover(self.target.admission())
            .ok()
            .flatten()
            .map(|c| c.seq)
    }
}

fn shadowed() -> Run {
    let mut r = run();
    r.reach_rebuild();
    r.compare(130);
    assert_eq!(r.d.test_checkpoint().step, Step::Shadowed);
    r
}

mod rollback_tests;

#[test]
fn retry_checks_the_actual_accepted_cutover_not_only_its_local_checkpoint() {
    let mut r = shadowed();
    r.reach_cutover();
    assert!(r.refresh());
    assert_eq!(
        r.d.restart_on_target(
            1,
            &binding(&r.target),
            &mut TestEntropy::new(210),
            &mut r.h.e,
            &r.target
        ),
        Err(LedgerError::OutstandingUnknown)
    );
    let c = r.c();
    r.cutover(c, vec![B16(replica_id())]);
    assert!(r.refresh());
    assert_eq!(
        r.d.restart_on_target(
            1,
            &binding(&r.target),
            &mut TestEntropy::new(210),
            &mut r.h.e,
            &r.target
        ),
        Err(LedgerError::Refused)
    );
}

#[test]
fn base_cutover_head_rebuilds_and_both_compares_settle_from_the_engine_to_route() {
    let mut r = run();
    let seq = r.reach_rebuild();
    let base =
        r.h.e
            .replica()
            .hosted_migration_installed_base(r.target.admission())
            .unwrap()
            .unwrap();
    assert_eq!(base.seq, seq);
    assert_eq!(base.legacy_collection, Some(r.c()));
    assert_eq!(base.source, mdbn_wire::snapshot::BaseSource::HostedImport);
    // The native cache pages reproduce the S0 placements' digest.
    r.compare(130);
    assert_eq!(r.d.test_checkpoint().step, Step::Shadowed);
    r.reach_cutover();
    // Nothing to settle until the control plane appends the cutover.
    let settled = r.d.test_settled();
    assert_eq!(r.log(), Err(LedgerError::Refused));
    r.unmoved(settled, Step::CutoverIntent);
    let c = r.c();
    let cut = r.cutover(c, vec![B16(replica_id())]);
    r.settle(170);
    assert_eq!(r.d.test_checkpoint().cutover_seq, Some(cut));
    // Fence-first: nothing to replay, barrier F is the head at or past it.
    assert_eq!(r.action(), Action::LogHead);
    r.settle(172);
    let cp = r.d.test_checkpoint();
    assert_eq!(cp.step, Step::Replayed);
    assert_eq!(cp.barrier_f, Some(cut));
    assert!(matches!(r.action(), Action::Rebuild { at_least } if at_least == cut));
    r.compare(174);
    assert!(matches!(
        r.action(),
        Action::Route { cutover_seq, barrier_f, .. } if cutover_seq == cut && barrier_f == cut
    ));
}

#[test]
fn a_cutover_replayed_after_a_lost_acknowledgement_is_found_once_not_duplicated() {
    let mut r = shadowed();
    r.reach_cutover();
    let c = r.c();
    // The control plane lost the append's acknowledgement and re-sent it: a
    // second certified item is void ("already cut over"), never a second cutover.
    let first = r.cutover(c, vec![B16(replica_id())]);
    let replay = r.cutover(c, vec![B16(replica_id())]);
    assert_eq!(replay, first + 1);
    assert_eq!(r.h.e.replica().head().seq, replay);
    assert_eq!(r.policy_cutover(), Some(first));
    let result = r.log().unwrap();
    r.d.assert_settled(&r.p, result).unwrap();
    assert_eq!(r.d.test_checkpoint().cutover_seq, Some(first));
    // The host lost the settlement reply too: settling again finds nothing
    // pending and the original settlement reads back unchanged.
    assert!(r.log().is_err());
    r.d.assert_settled(&r.p, result).unwrap();
    r.advance(170);
    r.settle(172);
    assert_eq!(r.d.test_checkpoint().barrier_f, Some(replay));
}

#[test]
fn a_foreign_cutover_never_settles() {
    for (legacy, revoked) in [
        (Some(B16([0x0e; 16])), vec![B16(replica_id())]),
        (None, vec![B16(id(0x73))]),
        (None, vec![]),
    ] {
        let mut r = shadowed();
        r.reach_cutover();
        let legacy = legacy.unwrap_or(r.c());
        r.cutover(legacy, revoked);
        assert!(r.policy_cutover().is_some());
        let settled = r.d.test_settled();
        assert_eq!(r.log(), Err(LedgerError::Conflict));
        r.unmoved(settled, Step::CutoverIntent);
    }
}

#[test]
fn a_base_cas_conflict_goes_find_then_appends_a_new_item_and_never_resends_stale_bytes() {
    let mut r = run();
    r.reach_base();
    let (first, seq) = r.append().unwrap();
    // Another writer takes the base's position before the append lands.
    let other = r.control(1);
    assert_eq!(other, seq);
    let settled = r.d.test_settled();
    // The batch was refused (head moved): the position is provably not ours.
    r.settle(124);
    assert_eq!(r.d.test_settled(), settled + 1);
    assert_eq!(r.d.test_checkpoint().step, Step::BaseIntent);
    assert_eq!(r.action(), Action::FindBase);
    r.settle(126);
    assert!(matches!(r.action(), Action::AppendBase { .. }));
    // A new action seals a new item for the new position, once.
    let (second, seq2) = r.append().unwrap();
    assert_ne!(second, first);
    assert_eq!(seq2, seq + 1);
    assert_eq!(r.append(), Err(LedgerError::Conflict));
    r.h.pump(false);
    r.settle(128);
    assert_eq!(r.d.test_checkpoint().base_seq, Some(seq2));
}

#[test]
fn a_dropped_base_batch_resends_the_same_bytes_only_at_the_same_position() {
    let mut r = run();
    r.reach_base();
    let (first, seq) = r.append().unwrap();
    // A lying service claims the head moved without moving it: the batch is
    // dropped and nothing landed.
    for c in r.h.e.take_log_calls() {
        let reply = match c.request {
            LogRequest::Append(_) => Ok(mdbn_replica::log::LogResponse::Append(
                mdbn_wire::log_service::AppendResult::HeadMoved(
                    mdbn_wire::log_service::HeadMoved {
                        head: seq - 1,
                        head_chain: r.svc.head(&r.c()).1,
                    },
                ),
            )),
            other => r.h.log.call(other),
        };
        let _ = r.h.e.on_log_reply(c.id, reply);
    }
    r.h.pump(false);
    assert_eq!(r.svc.head(&r.c()).0, seq - 1);
    let settled = r.d.test_settled();
    // Not provably someone else's position: no Unknown.
    assert_eq!(r.log(), Err(LedgerError::Refused));
    r.unmoved(settled, Step::BaseIntent);
    let (again, at) = r.append().unwrap();
    assert_eq!((again, at), (first, seq));
    r.h.pump(false);
    r.settle(124);
    assert_eq!(r.d.test_checkpoint().base_seq, Some(seq));
}

#[test]
fn a_base_append_with_a_lost_reply_resends_the_same_bytes_and_lands_once() {
    let mut r = run();
    r.reach_base();
    let (_, seq) = r.append().unwrap();
    // The service appends; the reply is lost.
    for c in r.h.e.take_log_calls() {
        let append = matches!(c.request, LogRequest::Append(_));
        let reply = r.h.log.call(c.request);
        let reply = if append {
            Err(LogError::NoResponse)
        } else {
            reply
        };
        let _ = r.h.e.on_log_reply(c.id, reply);
    }
    assert_eq!(r.svc.head(&r.c()).0, seq);
    let settled = r.d.test_settled();
    assert_eq!(r.log(), Err(LedgerError::Refused));
    r.unmoved(settled, Step::BaseIntent);
    // Not dropped, so the adapter never resends or reseals by itself.
    assert!(r.append().is_err());
    assert_eq!(r.svc.head(&r.c()).0, seq);
    // The replica's own retry carries the same bytes: one base, at `seq`.
    r.h.clock.set(r.h.clock.get() + 5_000);
    r.h.pump(false);
    assert_eq!(r.svc.head(&r.c()).0, seq);
    r.settle(124);
    assert_eq!(r.d.test_checkpoint().base_seq, Some(seq));
}

#[test]
fn a_base_whose_refs_are_missing_is_stale_and_restarts_the_import() {
    let mut r = run();
    r.reach_base();
    let Action::AppendBase { manifest, .. } = r.action() else {
        panic!()
    };
    r.svc.forget_object(&r.c(), &manifest);
    r.append().unwrap();
    r.h.pump(false);
    r.settle(124);
    let cp = r.d.test_checkpoint();
    assert_ne!(cp.step, Step::BaseIntent);
    assert_eq!(cp.base_seq, None);
    assert_eq!(cp.manifest, None);
}

#[test]
fn a_foreign_base_at_the_position_is_unknown_then_never_found() {
    let mut r = run();
    let refs = r.reach_base();
    let Action::AppendBase {
        manifest,
        state_digest,
    } = r.action()
    else {
        panic!()
    };
    // A base for another legacy collection, sealed by the same device for the
    // same position, wins the race at the service.
    assert!(r.refresh());
    let foreign =
        r.h.e
            .migration_gen0_replica(&r.target)
            .unwrap()
            .hosted_migration_base_seal(
                r.target.admission(),
                manifest,
                state_digest,
                B16([0x0e; 16]),
                refs,
            )
            .unwrap();
    let (_, seq) = r.append().unwrap();
    assert_eq!(foreign.seq(), seq);
    r.svc.push_raw(&r.c(), foreign.bytes().to_vec());
    r.h.pump(false);
    assert!(r.refresh());
    let installed =
        r.h.e
            .replica()
            .hosted_migration_installed_base(r.target.admission())
            .unwrap()
            .unwrap();
    assert_eq!(installed.legacy_collection, Some(B16([0x0e; 16])));
    r.settle(124);
    assert_eq!(r.action(), Action::FindBase);
    let settled = r.d.test_settled();
    assert_eq!(r.log(), Err(LedgerError::Conflict));
    r.unmoved(settled, Step::BaseIntent);
    // And no second base can be sealed over it.
    assert!(r.append().is_err());
}

/// The host resets the cache and reopens an empty Engine before a rebuild;
/// settle `Rebuild` against that Engine and its fresh observation.
fn rebuild_with_fresh_engine(r: &mut Run) -> Result<B32, LedgerError> {
    let mut fresh = open(&r.svc);
    fresh.pump(false);
    let Ok(target) = fresh.e.observe_native_target() else {
        return Err(LedgerError::Refused);
    };
    r.d.settle_log(&r.p, &mut fresh.e, &target)
}

#[test]
fn a_fresh_engine_rebuilds_from_an_intact_log() {
    let mut r = run();
    let seq = r.reach_rebuild();
    let result = rebuild_with_fresh_engine(&mut r).unwrap();
    r.d.assert_settled(&r.p, result).unwrap();
    assert_eq!(r.d.test_checkpoint().base_seq, Some(seq));
}

#[test]
fn rebuild_refuses_a_truncated_or_forged_log() {
    for forge in [false, true] {
        let mut r = run();
        let seq = r.reach_rebuild();
        let c = r.c();
        // The base is gone from the log the rebuild reads.
        r.svc.lose_tail(&c, 1);
        if forge {
            // A forged base in its place.
            let (_, chain) = r.svc.head(&c);
            let forged = Item {
                kind: ItemKind::Base,
                collection: c,
                seq: Some(seq),
                prev: Some(chain),
                epoch: Some(1),
                signer: Some(B16([0x99; 16])),
                salt: None,
                idem: None,
                refs: Some(vec![B32([1; 32])]),
                stream: None,
                body: Bytes(vec![1, 2, 3]),
                sig: Some(B64([0; 64])),
            };
            r.svc.push_raw(&c, forged.to_bytes().unwrap());
        } else {
            // And the head moved past where it was.
            r.control(2);
            assert!(r.svc.head(&c).0 >= seq);
        }
        let settled = r.d.test_settled();
        assert!(rebuild_with_fresh_engine(&mut r).is_err());
        assert_eq!(r.d.test_settled(), settled);
        assert_eq!(r.d.test_checkpoint().step, Step::BaseAppended);
        r.d.assert_prepared(&r.p).unwrap();
    }
}

#[test]
fn rebuild_is_refused_before_saving_unless_the_engine_opened_empty() {
    let mut r = run();
    r.reach_base();
    r.append().unwrap();
    r.h.pump(false);
    let result = r.log().unwrap();
    r.d.assert_settled(&r.p, result).unwrap();
    let settled = r.d.test_settled();
    let gate = |a: &Action| !matches!(a, Action::Rebuild { .. });
    assert_eq!(
        r.d.prepare_gated(&mut TestEntropy::new(124), &gate).err(),
        Some(LedgerError::Refused)
    );
    assert_eq!(r.d.saved_pending().unwrap(), None);
    assert_eq!(r.d.test_settled(), settled);
    // An open gate prepares the same rebuild.
    let (p, a) =
        r.d.prepare_gated(&mut TestEntropy::new(125), &|_| true)
            .unwrap();
    assert!(matches!(a, Action::Rebuild { .. }));
    r.p = p;
    r.settle(126);
}

#[test]
fn read_new_refuses_every_page_once_another_writer_changed_content() {
    let mut r = run();
    r.reach_rebuild();
    r.settle(130);
    assert!(matches!(r.action(), Action::ReadNew { cursor: None }));
    // A control item since the rebuild changes no live entity: pages go on.
    r.control(3);
    r.settle(131);
    assert!(matches!(r.action(), Action::ReadNew { cursor: Some(_) }));
    // Another writer's entry lands: a mixed read could falsely match.
    let c = r.c();
    let (seq, chain) = r.svc.head(&c);
    let entry = Item {
        kind: ItemKind::Entry,
        collection: c,
        seq: Some(seq + 1),
        prev: Some(chain),
        epoch: Some(1),
        signer: Some(B16([0x99; 16])),
        salt: None,
        idem: None,
        refs: None,
        stream: None,
        body: Bytes(vec![1, 2, 3]),
        sig: Some(B64([0; 64])),
    };
    r.svc.push_raw(&c, entry.to_bytes().unwrap());
    r.control(4);
    let settled = r.d.test_settled();
    assert!(r.log().is_err());
    assert_eq!(r.d.test_settled(), settled);
    assert_eq!(r.d.test_checkpoint().step, Step::BaseAppended);
}

#[test]
fn log_results_refuse_a_foreign_run_or_engine_and_generic_settlement() {
    let mut r = run();
    r.reach_base();
    // Another run's ledger over the same target holds none of this run's
    // actions; a target observed by another Engine is not this Engine's.
    let mut other =
        JournalDriver::resume(Sqlite::new(), binding(&r.target), &mut TestEntropy::new(99))
            .unwrap();
    assert!(other.log_append(&r.p, &mut r.h.e, &r.target).is_err());
    assert!(other.settle_log(&r.p, &mut r.h.e, &r.target).is_err());
    let mut engine = open(&r.svc);
    engine.pump(false);
    let foreign = engine.e.observe_native_target().unwrap();
    assert!(r.d.log_append(&r.p, &mut r.h.e, &foreign).is_err());
    for outcome in [
        Outcome::Appended { seq: 4 },
        Outcome::Unknown,
        Outcome::Stale,
        Outcome::Found { seq: Some(4) },
        Outcome::Rebuilt { head: 4 },
        Outcome::Head { seq: 4 },
    ] {
        assert!(r.d.settle(&r.p, outcome).is_err());
    }
    let (_, seq) = r.append().unwrap();
    r.h.pump(false);
    assert!(r.d.settle_log(&r.p, &mut r.h.e, &foreign).is_err());
    assert!(other.settle_log(&r.p, &mut r.h.e, &r.target).is_err());
    assert!(r.d.settle(&r.p, Outcome::Appended { seq }).is_err());
    r.settle(124);
}

#[test]
fn a_base_append_whose_refs_were_lost_to_eviction_is_stale_and_costs_one_attempt() {
    let mut r = run();
    let mut store = Objects::default();
    r.windows(&mut store, 90);
    let out = r.d.gen0_finish(&r.p, &mut r.h.e, &r.target).unwrap();
    store.put(&out);
    let flags = store.result(r.c(), &out.verify);
    let result =
        r.d.settle_gen0(&r.p, &mut r.h.e, &r.target, &flags)
            .unwrap();
    r.d.assert_settled(&r.p, result).unwrap();
    for bytes in store.0.values() {
        r.svc.put_object(&r.c(), bytes.clone());
    }
    let before = r.d.test_checkpoint();
    assert_eq!(before.step, Step::BaseIntent);
    // Evicted before the AppendBase was prepared: the finish's refs are gone.
    let index = std::mem::replace(
        &mut r.d,
        JournalDriver::resume(Sqlite::new(), binding(&r.target), &mut TestEntropy::new(98))
            .unwrap(),
    )
    .into_index();
    r.d = JournalDriver::resume(index, binding(&r.target), &mut TestEntropy::new(99)).unwrap();
    r.advance(121);
    assert!(matches!(r.action(), Action::FindBase));
    r.settle(122);
    assert!(matches!(r.action(), Action::AppendBase { .. }));
    // Nothing can be sealed without the refs; nothing was sent.
    assert_eq!(r.append(), Err(LedgerError::Conflict));
    let head = r.svc.head(&r.c());
    r.settle(123);
    assert_eq!(r.svc.head(&r.c()), head);
    let cp = r.d.test_checkpoint();
    assert_eq!(cp.manifest, None);
    assert_eq!(cp.base_seq, None);
    // The S0 re-read counts against the restart limit.
    assert!(matches!(r.action(), Action::OpenSource { .. }));
    assert_eq!(r.d.test_checkpoint().attempts, before.attempts + 1);
}

#[test]
fn a_base_append_with_refs_in_ram_never_settles_stale_before_sending() {
    let mut r = run();
    r.reach_base();
    // Refs present and nothing sent: no evidence either way, so it refuses.
    assert!(r.log().is_err());
    let (_, seq) = r.append().unwrap();
    r.h.pump(false);
    r.settle(124);
    assert_eq!(r.d.test_checkpoint().base_seq, Some(seq));
}

#[test]
fn the_retained_action_fields_and_idle_reasons_are_exported() {
    let mut r = run();
    r.reach_base();
    let fields = r.d.prepared_fields(&r.p).unwrap();
    let Ok(mdbn_wire::cbor::Cbor::Array(v)) = mdbn_wire::cbor::decode(&fields) else {
        panic!()
    };
    assert_eq!(v[0], mdbn_wire::cbor::Cbor::Uint(6));
    assert_eq!(v.len(), 3);
    // An outstanding action is classified, never re-polled.
    assert!(r.d.prepare(&mut TestEntropy::new(200)).is_err());
    assert_eq!(
        r.d.idle(),
        crate::migration_action_ledger::Idle::Outstanding
    );
}
