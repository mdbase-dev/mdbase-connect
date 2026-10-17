//! Adversarial Connect/provider result settlement over real SQLite: forged,
//! foreign, stale and replayed bodies, lost commit acknowledgement and
//! negative-to-positive upgrades never settle or advance the Driver.
use super::provider::{self, Bound};
use super::tests::{Sqlite, TestEntropy, backup, binding, open};
use super::*;
use mdbn_wire::cbor::{Cbor, encode};

pub(super) const COLLECTION: [u8; 16] = [1; 16];
const OWNER: [u8; 16] = [2; 16];
const RUN: [u8; 16] = [0x51; 16];
const STARTED: &str = "2026-10-12T08:00:00.000000Z";

fn b(v: [u8; 16]) -> Cbor {
    Cbor::Bytes(v.to_vec())
}
fn t(v: &str) -> Cbor {
    Cbor::Text(v.into())
}
fn ids(v: &[[u8; 16]]) -> Cbor {
    Cbor::Array(v.iter().map(|i| b(*i)).collect())
}
fn enc(v: Vec<Cbor>) -> Vec<u8> {
    encode(&Cbor::Array(v)).unwrap()
}

#[derive(Clone)]
struct View {
    account: [u8; 16],
    backend: &'static str,
    cohort: Option<&'static str>,
    released: bool,
    started: bool,
    excluded: bool,
    paused: bool,
    hosted: Vec<[u8; 16]>,
    unsettled: Vec<[u8; 16]>,
    cut_over: Vec<[u8; 16]>,
}
fn view() -> View {
    View {
        account: OWNER,
        backend: "legacy",
        cohort: Some("lab-run-1"),
        released: true,
        started: true,
        excluded: false,
        paused: false,
        hosted: vec![COLLECTION, [9; 16]],
        unsettled: vec![],
        cut_over: vec![],
    }
}
fn account(v: &View) -> Vec<u8> {
    enc(vec![
        Cbor::Uint(1),
        b(v.account),
        t(v.backend),
        v.cohort.map_or(Cbor::Null, t),
        Cbor::Bool(v.released),
        Cbor::Bool(v.started),
        Cbor::Bool(v.excluded),
        Cbor::Bool(v.paused),
        ids(&v.hosted),
        ids(&v.unsettled),
        ids(&v.cut_over),
    ])
}
fn fence(collection: [u8; 16], run: [u8; 16], started: &str) -> Vec<u8> {
    enc(vec![
        Cbor::Uint(2),
        b(collection),
        t("migrating"),
        b(run),
        t(started),
        Cbor::Null,
        Cbor::Array(vec![]),
    ])
}
#[derive(Clone)]
pub(super) struct Drain {
    collection: [u8; 16],
    state: &'static str,
    run: Option<([u8; 16], &'static str)>,
    head: u64,
    retain: Option<&'static str>,
    in_flight: u64,
    unresolved: u64,
}
pub(super) fn drain_of(head: u64, in_flight: u64) -> Drain {
    Drain {
        collection: COLLECTION,
        state: "migrating",
        run: Some((RUN, STARTED)),
        head,
        retain: None,
        in_flight,
        unresolved: in_flight + 1,
    }
}
pub(super) fn drain(d: &Drain) -> Vec<u8> {
    let (m, s) = d
        .run
        .map_or((Cbor::Null, Cbor::Null), |(m, s)| (b(m), t(s)));
    enc(vec![
        Cbor::Uint(3),
        b(d.collection),
        t(d.state),
        m,
        Cbor::Uint(d.head),
        s,
        d.retain.map_or(Cbor::Null, t),
        Cbor::Uint(d.in_flight),
        Cbor::Uint(d.unresolved),
        Cbor::Uint(0),
    ])
}
fn cutover(collection: [u8; 16], account: [u8; 16]) -> Vec<u8> {
    enc(vec![Cbor::Uint(6), b(collection), b(account)])
}

pub(super) fn settled_count(a: &mut JournalDriver<Sqlite>) -> i64 {
    a.spill
        .index_mut()
        .db
        .query_row(
            "SELECT count(*) FROM mig_native_action WHERE settled=1",
            [],
            |r| r.get(0),
        )
        .unwrap()
}
/// A refused result leaves the original pending outstanding and unwritten.
fn refused(a: &mut JournalDriver<Sqlite>, ticket: &PreparedAction, input: &[u8], e: LedgerError) {
    let settled = settled_count(a);
    let checkpoint = a.spill.load().unwrap();
    assert_eq!(a.settle_provider(ticket, input), Err(e));
    a.assert_prepared(ticket).unwrap();
    assert_eq!(a.saved_pending().unwrap().as_ref(), Some(ticket.data()));
    assert_eq!(settled_count(a), settled);
    assert_eq!(a.spill.load().unwrap(), checkpoint);
}
pub(super) fn next(a: &mut JournalDriver<Sqlite>, entropy: u8) -> (PreparedAction, Action) {
    a.prepare(&mut TestEntropy(entropy)).unwrap()
}

/// Backup through the provider path; creation through the private native
/// target hook (its own tests cover the positive H1 verifier).
fn created() -> JournalDriver<Sqlite> {
    let mut a = open();
    let (h0, _) = next(&mut a, 20);
    a.settle_provider(&h0, &backup(0x44)).unwrap();
    assert_eq!(
        a.driver.checkpoint().backup_hold.as_deref(),
        Some("44444444-4444-4444-4444-444444444444")
    );
    let (h1, action) = next(&mut a, 30);
    assert_eq!(action, Action::CreateCollection);
    let outcome = Outcome::Created { verified: true };
    let result = codec::outcome(&action, &outcome).unwrap();
    a.settle_checked(&h1, outcome, result).unwrap();
    assert_eq!(a.driver.checkpoint().step, Step::Created);
    a
}
pub(super) fn fenced() -> JournalDriver<Sqlite> {
    let mut a = created();
    let (gate, action) = next(&mut a, 40);
    assert_eq!(action, Action::MayFence);
    a.settle_provider(&gate, &account(&view())).unwrap();
    assert!(a.driver.checkpoint().fenced);
    let (f, action) = next(&mut a, 50);
    assert_eq!(action, Action::Fence);
    a.settle_provider(&f, &fence(COLLECTION, RUN, STARTED))
        .unwrap();
    a
}

#[test]
fn fence_first_backup_gate_fence_and_drain_settle_from_connect_bodies() {
    let mut a = fenced();
    let (d, action) = next(&mut a, 60);
    assert_eq!(action, Action::DrainStatus);
    // Connect's drained rule is in_flight == 0; retained evidence may remain.
    let result = a.settle_provider(&d, &drain(&drain_of(42, 2))).unwrap();
    a.assert_settled(&d, result).unwrap();
    assert_eq!(a.driver.checkpoint().s_final, None);
    // Wait(Draining) is a poll result, not an action: nothing is saved for it.
    assert_eq!(
        a.prepare(&mut TestEntropy(61)).err(),
        Some(LedgerError::Unsupported)
    );
    // The host's loop reads why: wait, then poll again.
    assert_eq!(a.idle(), super::Idle::WaitDraining);
    // The RAM drain marker is gone, so the idempotent fence repeats first and
    // must observe the SAME provider run.
    let (f, action) = next(&mut a, 62);
    assert_eq!(action, Action::Fence);
    assert_eq!(a.idle(), super::Idle::None);
    a.settle_provider(&f, &fence(COLLECTION, RUN, STARTED))
        .unwrap();
    let (d, action) = next(&mut a, 63);
    assert_eq!(action, Action::DrainStatus);
    a.settle_provider(&d, &drain(&drain_of(42, 0))).unwrap();
    assert_eq!(a.driver.checkpoint().s_final, Some(42));
    assert!(a.saved_pending().unwrap().is_none());
    let (_, action) = next(&mut a, 64);
    assert!(matches!(
        action,
        Action::OpenSource {
            expect_head: Some(42),
            ..
        }
    ));
}

#[test]
fn generic_settlement_refuses_every_provider_result() {
    let mut a = open();
    let (h0, _) = next(&mut a, 20);
    let hold = Outcome::Backup {
        hold: "44444444-4444-4444-4444-444444444444".into(),
    };
    assert_eq!(a.settle(&h0, hold), Err(LedgerError::Unsupported));
    a.assert_prepared(&h0).unwrap();
    let mut a = created();
    let (gate, _) = next(&mut a, 40);
    assert_eq!(
        a.settle(&gate, Outcome::MayFence(true)),
        Err(LedgerError::Unsupported)
    );
    a.settle_provider(&gate, &account(&view())).unwrap();
    let (f, _) = next(&mut a, 50);
    assert_eq!(a.settle(&f, Outcome::Ok), Err(LedgerError::Unsupported));
    a.settle_provider(&f, &fence(COLLECTION, RUN, STARTED))
        .unwrap();
    let (d, _) = next(&mut a, 60);
    assert_eq!(
        a.settle(
            &d,
            Outcome::Drain {
                pending: 0,
                head: 1
            }
        ),
        Err(LedgerError::Unsupported)
    );
    a.assert_prepared(&d).unwrap();
    assert!(a.driver.checkpoint().s_final.is_none());
}

#[test]
fn forged_wrong_kind_and_malformed_bodies_never_settle() {
    let mut a = created();
    let (gate, _) = next(&mut a, 40);
    // Well-formed bodies for a different action are forged for this one.
    for wrong in [
        fence(COLLECTION, RUN, STARTED),
        drain(&drain_of(1, 0)),
        backup(0x44),
        cutover(COLLECTION, OWNER),
        enc(vec![Cbor::Uint(4), ids(&[])]),
        enc(vec![Cbor::Uint(5), ids(&[])]),
    ] {
        refused(&mut a, &gate, &wrong, LedgerError::Conflict);
    }
    let mut extra = account(&view());
    extra.push(0);
    let mut unsorted = view();
    unsorted.hosted = vec![[9; 16], COLLECTION];
    let mut duplicate = view();
    duplicate.hosted = vec![COLLECTION, COLLECTION];
    let mut nil = view();
    nil.account = [0; 16];
    let mut outside = view();
    outside.unsettled = vec![[7; 16]];
    let mut huge = view();
    huge.hosted = (0..1001u16)
        .map(|i| {
            let mut id = [0x10; 16];
            id[..2].copy_from_slice(&i.to_be_bytes());
            id
        })
        .collect();
    let mut backend = view();
    backend.backend = "Legacy";
    for bad in [
        vec![],
        extra,
        account(&unsorted),
        account(&duplicate),
        account(&nil),
        account(&outside),
        account(&huge),
        account(&backend),
        vec![0xa0],
        enc(vec![Cbor::Uint(99), b(OWNER)]),
        enc(vec![Cbor::Uint(1), b(OWNER)]),
        vec![0x80; MAX_CHECKPOINT],
    ] {
        refused(&mut a, &gate, &bad, LedgerError::Invalid);
    }
    a.settle_provider(&gate, &account(&view())).unwrap();
    let (f, _) = next(&mut a, 50);
    let restored = enc(vec![
        Cbor::Uint(2),
        b(COLLECTION),
        t("migrating"),
        b(RUN),
        t(STARTED),
        Cbor::Null,
        ids(&[[8; 16]]),
    ]);
    let retained = enc(vec![
        Cbor::Uint(2),
        b(COLLECTION),
        t("migrating"),
        b(RUN),
        t(STARTED),
        t(STARTED),
        Cbor::Array(vec![]),
    ]);
    let active = enc(vec![
        Cbor::Uint(2),
        b(COLLECTION),
        t("active"),
        b(RUN),
        t(STARTED),
        Cbor::Null,
        Cbor::Array(vec![]),
    ]);
    for bad in [
        restored,
        retained,
        active,
        fence(COLLECTION, [0; 16], STARTED),
        fence(COLLECTION, RUN, ""),
        fence(COLLECTION, RUN, "2026-10-12 08:00"),
        fence(COLLECTION, RUN, &"9".repeat(65)),
    ] {
        refused(&mut a, &f, &bad, LedgerError::Invalid);
    }
    a.settle_provider(&f, &fence(COLLECTION, RUN, STARTED))
        .unwrap();
    let (d, _) = next(&mut a, 60);
    let mut over = drain_of(1, 3);
    over.unresolved = 2;
    let mut far = drain_of(MAX_SEQ + 1, 0);
    far.unresolved = 0;
    let mut half = drain_of(1, 0);
    let half_bytes = {
        half.run = None;
        let mut v = drain(&half);
        // migration id present, started_at null
        let mut fields = match mdbn_wire::cbor::decode(&v).unwrap() {
            Cbor::Array(f) => f,
            _ => unreachable!(),
        };
        fields[3] = b(RUN);
        v = enc(fields);
        v
    };
    for bad in [drain(&over), drain(&far), half_bytes] {
        refused(&mut a, &d, &bad, LedgerError::Invalid);
    }
}

#[test]
fn foreign_collection_owner_and_provider_run_refuse() {
    let mut a = created();
    let (gate, _) = next(&mut a, 40);
    let mut other_owner = view();
    other_owner.account = [3; 16];
    let mut not_listed = view();
    not_listed.hosted = vec![[9; 16]];
    for foreign in [account(&other_owner), account(&not_listed)] {
        refused(&mut a, &gate, &foreign, LedgerError::Conflict);
    }
    a.settle_provider(&gate, &account(&view())).unwrap();
    let (f, _) = next(&mut a, 50);
    refused(
        &mut a,
        &f,
        &fence([3; 16], RUN, STARTED),
        LedgerError::Conflict,
    );
    a.settle_provider(&f, &fence(COLLECTION, RUN, STARTED))
        .unwrap();
    let (d, _) = next(&mut a, 60);
    let mut wrong = vec![];
    for change in 0..7 {
        let mut x = drain_of(5, 0);
        match change {
            0 => x.collection = [3; 16],
            // Stale: rolled back to active, or already past the cutover.
            1 => {
                x.state = "active";
                x.run = None;
            }
            2 => x.state = "migrated",
            3 => x.retain = Some(STARTED),
            // A later provider run (unfenced and re-fenced in between).
            4 => x.run = Some(([0x52; 16], STARTED)),
            5 => x.run = Some((RUN, "2026-10-12T09:00:00.000000Z")),
            _ => x.run = None,
        }
        wrong.push(drain(&x));
    }
    for body in wrong {
        refused(&mut a, &d, &body, LedgerError::Conflict);
    }
    // The idempotent fence repeats; a different provider run must not be adopted.
    a.settle_provider(&d, &drain(&drain_of(5, 1))).unwrap();
    assert!(a.prepare(&mut TestEntropy(61)).is_err());
    let (f, action) = next(&mut a, 62);
    assert_eq!(action, Action::Fence);
    refused(
        &mut a,
        &f,
        &fence(COLLECTION, [0x52; 16], STARTED),
        LedgerError::Conflict,
    );
    refused(
        &mut a,
        &f,
        &fence(COLLECTION, RUN, "2026-10-12T09:00:00.000000Z"),
        LedgerError::Conflict,
    );
    a.settle_provider(&f, &fence(COLLECTION, RUN, STARTED))
        .unwrap();
}

#[test]
fn replayed_result_and_settled_negative_cannot_become_positive() {
    let negatives: [fn(&mut View); 8] = [
        |v| v.paused = true,
        |v| v.released = false,
        |v| v.started = false,
        |v| v.excluded = true,
        |v| v.cohort = None,
        |v| v.backend = "next",
        |v| v.unsettled = vec![COLLECTION],
        |v| v.cut_over = vec![COLLECTION],
    ];
    for negative in negatives {
        let mut a = created();
        let (gate, _) = next(&mut a, 40);
        let mut v = view();
        negative(&mut v);
        let no = a.settle_provider(&gate, &account(&v)).unwrap();
        assert_eq!(
            no,
            codec::provider_outcome(&Action::MayFence, &Outcome::MayFence(false), vec![]).unwrap()
        );
        assert!(!a.driver.checkpoint().fenced);
        // Upgrading the SAME settled ticket, or replaying either body, refuses.
        assert_eq!(
            a.settle_provider(&gate, &account(&view())),
            Err(LedgerError::Refused)
        );
        assert_eq!(
            a.settle_provider(&gate, &account(&v)),
            Err(LedgerError::Refused)
        );
        a.assert_settled(&gate, no).unwrap();
        assert!(!a.driver.checkpoint().fenced);
        // Only a fresh poll after the wait asks again, under a new identity.
        assert_eq!(
            a.prepare(&mut TestEntropy(41)).err(),
            Some(LedgerError::Unsupported)
        );
        assert_eq!(a.idle(), super::Idle::WaitPaused);
        let (again, action) = next(&mut a, 42);
        assert_eq!(action, Action::MayFence);
        assert_ne!(again.data().action, gate.data().action);
        assert_eq!(again.data().sequence, gate.data().sequence + 1);
        assert_eq!(
            a.settle_provider(&gate, &account(&view())),
            Err(LedgerError::Refused)
        );
        a.settle_provider(&again, &account(&view())).unwrap();
        assert!(a.driver.checkpoint().fenced);
    }
    // A settled not-drained answer cannot be upgraded to drained either.
    let mut a = fenced();
    let (d, _) = next(&mut a, 60);
    let busy = a.settle_provider(&d, &drain(&drain_of(42, 1))).unwrap();
    assert_eq!(
        a.settle_provider(&d, &drain(&drain_of(42, 0))),
        Err(LedgerError::Refused)
    );
    a.assert_settled(&d, busy).unwrap();
    assert_eq!(a.driver.checkpoint().s_final, None);
}

#[test]
fn lost_settlement_ack_keeps_original_settlement_and_fence_binding() {
    let mut a = created();
    let (gate, _) = next(&mut a, 40);
    a.test_lose_settlement();
    assert_eq!(
        a.settle_provider(&gate, &account(&view())),
        Err(LedgerError::StorageUnknown)
    );
    // Poisoned: no output, no second settlement from this instance.
    assert_eq!(
        a.settle_provider(&gate, &account(&view())),
        Err(LedgerError::Refused)
    );
    assert!(a.prepare(&mut TestEntropy(41)).is_err());
    let mut a = JournalDriver::resume(a.into_index(), binding(), &mut TestEntropy(70)).unwrap();
    assert!(a.saved_pending().unwrap().is_none());
    assert!(a.driver.checkpoint().fenced);
    let (f, action) = next(&mut a, 50);
    assert_eq!(action, Action::Fence);
    a.test_lose_settlement();
    assert_eq!(
        a.settle_provider(&f, &fence(COLLECTION, RUN, STARTED)),
        Err(LedgerError::StorageUnknown)
    );
    let mut a = JournalDriver::resume(a.into_index(), binding(), &mut TestEntropy(80)).unwrap();
    // The fence's RAM drain marker died with the instance: fence again, and
    // the landed-but-unacknowledged fence still binds the provider run.
    let (f, action) = next(&mut a, 51);
    assert_eq!(action, Action::Fence);
    refused(
        &mut a,
        &f,
        &fence(COLLECTION, [0x52; 16], STARTED),
        LedgerError::Conflict,
    );
    a.settle_provider(&f, &fence(COLLECTION, RUN, STARTED))
        .unwrap();
    let (d, _) = next(&mut a, 52);
    let mut other = drain_of(7, 0);
    other.run = Some(([0x52; 16], STARTED));
    refused(&mut a, &d, &drain(&other), LedgerError::Conflict);
    a.settle_provider(&d, &drain(&drain_of(7, 0))).unwrap();
    assert_eq!(a.driver.checkpoint().s_final, Some(7));
}

// The later H8/H10 actions need the import path to be reachable natively, so
// their binding is checked directly against the adapter.
fn bound() -> Bound {
    Bound {
        collection: B16(COLLECTION),
        owner: B16(OWNER),
    }
}
fn adapt(action: &Action, input: &[u8], fence: Option<&B32>) -> Result<Outcome> {
    provider::outcome(action, provider::decode(input)?, &bound(), fence).map(|(o, _)| o)
}
fn fence_digest() -> B32 {
    codec::provider_outcome(&Action::Fence, &Outcome::Ok, vec![b(RUN), t(STARTED)]).unwrap()
}

#[test]
fn replicas_revoke_and_route_bind_exact_sets_and_run_identity() {
    let f = fence_digest();
    let (r1, r2, r3) = ([0x21; 16], [0x22; 16], [0x23; 16]);
    let list = enc(vec![Cbor::Uint(4), ids(&[r1, r2])]);
    assert_eq!(
        adapt(&Action::ListReplicas, &list, Some(&f)),
        Ok(Outcome::Replicas {
            ids: vec![B16(r1).to_uuid_string(), B16(r2).to_uuid_string()]
        })
    );
    assert_eq!(
        adapt(&Action::ListReplicas, &list, None),
        Err(LedgerError::Conflict)
    );
    let asked = Action::RevokeReplicas {
        ids: vec![B16(r2).to_uuid_string(), B16(r1).to_uuid_string()],
    };
    let revoked = |v: &[[u8; 16]]| enc(vec![Cbor::Uint(5), ids(v)]);
    assert_eq!(
        adapt(&asked, &revoked(&[r1, r2]), Some(&f)),
        Ok(Outcome::Ok)
    );
    for partial in [&[r1][..], &[r1, r2, r3][..], &[][..], &[r2, r3][..]] {
        assert_eq!(
            adapt(&asked, &revoked(partial), Some(&f)),
            Err(LedgerError::Conflict)
        );
    }
    assert_eq!(
        adapt(&asked, &revoked(&[r1, r2]), None),
        Err(LedgerError::Conflict)
    );
    assert_eq!(
        adapt(&asked, &revoked(&[r2, r1]), Some(&f)),
        Err(LedgerError::Invalid)
    );
    let route = Action::Route {
        s_final: 7,
        cutover_seq: 9,
        barrier_f: 11,
        final_digest: B32([5; 32]),
    };
    assert_eq!(
        adapt(&route, &cutover(COLLECTION, OWNER), Some(&f)),
        Ok(Outcome::Ok)
    );
    for (c, o, prior) in [
        ([3; 16], OWNER, Some(&f)),
        (COLLECTION, [3; 16], Some(&f)),
        (COLLECTION, OWNER, None),
    ] {
        assert_eq!(
            adapt(&route, &cutover(c, o), prior),
            Err(LedgerError::Conflict)
        );
    }
    // A route body is not a revoke, list, fence or drain result.
    for action in [
        &Action::ListReplicas,
        &asked,
        &Action::Fence,
        &Action::DrainStatus,
    ] {
        assert_eq!(
            adapt(action, &cutover(COLLECTION, OWNER), Some(&f)),
            Err(LedgerError::Conflict)
        );
    }
    // Rollback stays unsupported here.
    for action in [Action::Unfence, Action::Unrevoke { ids: vec![] }] {
        assert_eq!(
            adapt(&action, &revoked(&[r1]), Some(&f)),
            Err(LedgerError::Conflict)
        );
    }
}

#[test]
fn drain_counts_every_in_flight_row_as_pending() {
    // The provider counts a terminal failed notification run with no lease as
    // in flight; native follows Connect's drained rule and keeps waiting.
    let f = fence_digest();
    assert_eq!(
        adapt(&Action::DrainStatus, &drain(&drain_of(3, 1)), Some(&f)),
        Ok(Outcome::Drain {
            pending: 1,
            head: 3
        })
    );
    assert_eq!(
        adapt(&Action::DrainStatus, &drain(&drain_of(3, 0)), None),
        Err(LedgerError::Conflict)
    );
}
