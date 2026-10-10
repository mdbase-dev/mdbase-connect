//! Durable receipt ownership outlives the connection that submitted a mutation.
use super::*;
use crate::store::Store;

#[path = "receipt_fanout/immediate.rs"]
mod immediate;

fn granted(a: &mut Node, grant: B16, pk: u8) -> SessionId {
    a.r.hello(
        SessionAuth::Grant {
            grant,
            client_pk: [pk; 32],
        },
        sec047_app_hello(),
    )
    .unwrap()
    .0
}

fn fixture_with_cp() -> (FakeLogService, Node, crate::testkit::TestControlPlane) {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut cp = crate::testkit::TestControlPlane::new(COL);
    for (g, pk) in [(0x55, 0x57), (0x66, 0x67)] {
        cp.approved_grant(
            &svc,
            B16([g; 16]),
            [pk; 32],
            &["collection.read", "records.create"],
            None,
            B16([101; 16]),
        );
    }
    settle(&mut [&mut a]);
    (svc, a, cp)
}

fn fixture() -> (FakeLogService, Node) {
    let (svc, a, _) = fixture_with_cp();
    (svc, a)
}

fn confirmed_after_connection_loss(reopen: bool) {
    let (svc, mut a) = fixture();
    let host = a.s;
    let origin = granted(&mut a, B16([0x55; 16]), 0x57);
    a.s = origin;
    let receipt = a.create(10, "fanout.md", "owned");
    assert_eq!(receipt.state, ReceiptState::Pending);
    a.r.close(origin);
    if reopen {
        a = node(&svc, 1, a.r.into_store());
    } else {
        a.s = host;
    }
    let owner = granted(&mut a, B16([0x55; 16]), 0x57);
    let owner2 = granted(&mut a, B16([0x55; 16]), 0x57);
    let other = granted(&mut a, B16([0x66; 16]), 0x67);
    let host = a.s;
    a.r.take_pushes();
    settle(&mut [&mut a]);
    let targets: Vec<_> = a.r.take_pushes().into_iter().filter_map(|(s, p)| {
        matches!(p, Push::Receipt(r) if r.mutation == receipt.mutation && r.state == ReceiptState::Confirmed)
            .then_some(s)
    }).collect();
    for expected in [host, owner, owner2] {
        assert_eq!(
            targets.iter().filter(|s| **s == expected).count(),
            1,
            "one confirmation per current authorized session, reopen={reopen}"
        );
    }
    assert!(
        !targets.contains(&other),
        "another grant cannot receive this receipt"
    );
    assert_eq!(targets.len(), 3);
    assert_eq!(
        a.r.receipt(owner, receipt.mutation).unwrap().state,
        ReceiptState::Confirmed
    );
    assert_eq!(
        a.r.receipt(other, receipt.mutation).unwrap_err().code(),
        Some(ErrorCode::NotFound)
    );
}

#[test]
fn receipt_fanout_rejection_after_reopen_uses_persisted_owner() {
    let (svc, mut a) = fixture();
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut b]);
    let origin = granted(&mut a, B16([0x55; 16]), 0x57);
    a.s = origin;
    let pending = a.create(10, "collision.md", "original");
    b.create(20, "collision.md", "winner");
    settle(&mut [&mut b]);
    a = node(&svc, 1, a.r.into_store());
    let owner = granted(&mut a, B16([0x55; 16]), 0x57);
    let other = granted(&mut a, B16([0x66; 16]), 0x67);
    settle(&mut [&mut a]);
    let targets: Vec<_> = a.r.take_pushes().into_iter().filter_map(|(s, p)| {
        matches!(p, Push::Receipt(r) if r.mutation == pending.mutation && r.state == ReceiptState::Rejected)
            .then_some(s)
    }).collect();
    assert!(
        targets.contains(&a.s),
        "host receives the durable rejection"
    );
    assert!(
        targets.contains(&owner),
        "reconnected owner receives rejection"
    );
    assert!(!targets.contains(&other));
    assert_eq!(
        a.r.receipt(owner, pending.mutation).unwrap().state,
        ReceiptState::Rejected
    );
}

#[test]
fn receipt_fanout_rechecks_serving_account_when_draining_queued_output() {
    let (svc, mut a, mut cp) = fixture_with_cp();
    let owner = granted(&mut a, B16([0x55; 16]), 0x57);
    let host = a.s;
    a.s = owner;
    let pending = a.create(10, "queued.md", "owned");
    settle(&mut [&mut a]);
    // Leave the confirmed push queued, then revoke the serving device rather
    // than the grant: the session's grant itself is still present in policy.
    cp.revoke(&svc, B16([101; 16]));
    settle(&mut [&mut a]);
    assert!(
        !a.r.policy.devices[&B16([101; 16])].active,
        "fresh CP revocation applied"
    );
    assert!(
        a.r.policy.effective_grant(&B16([0x55; 16])).is_some(),
        "the grant itself remains active"
    );
    let targets: Vec<_> =
        a.r.take_pushes()
            .into_iter()
            .filter_map(|(s, p)| {
                matches!(p, Push::Receipt(r) if r.mutation == pending.mutation).then_some(s)
            })
            .collect();
    assert!(
        !targets.contains(&owner),
        "receipt output rechecks current serving authority"
    );
    assert!(
        targets.contains(&host),
        "hosting app retains its own output"
    );
}

#[test]
fn receipt_fanout_write_only_owner_can_receive_its_outcome() {
    let (svc, mut a, mut cp) = fixture_with_cp();
    cp.approved_grant(
        &svc,
        B16([0x77; 16]),
        [0x79; 32],
        &["records.create"],
        None,
        B16([101; 16]),
    );
    settle(&mut [&mut a]);
    let origin = granted(&mut a, B16([0x77; 16]), 0x79);
    let host = a.s;
    a.s = origin;
    let pending = a.create(10, "write-only.md", "owned");
    a.r.close(origin);
    a.s = host;
    let owner = granted(&mut a, B16([0x77; 16]), 0x79);
    assert!(
        a.r.status(owner).is_err(),
        "this grant lacks read capability"
    );
    settle(&mut [&mut a]);
    assert!(a.r.take_pushes().iter().any(|(s, p)| *s == owner
        && matches!(p, Push::Receipt(r) if r.mutation == pending.mutation && r.state == ReceiptState::Confirmed)));
}

#[test]
fn receipt_fanout_certified_abort_does_not_consume_submitter_or_emit_outcome() {
    let (_, mut a) = fixture();
    let owner = granted(&mut a, B16([0x55; 16]), 0x57);
    a.s = owner;
    let pending = a.create(10, "abort.md", "owned");
    a.r.take_pushes();
    a.r.store().fail_commits(1);
    assert!(
        a.r.resolve_rejected(vec![(
            pending.mutation,
            Some(B16([0x55; 16])),
            ErrorCode::Conflict.problem("test rejection")
        )])
        .is_err()
    );
    assert_eq!(a.r.submitted_by.get(&pending.mutation), Some(&owner));
    assert!(
        a.r.store()
            .pending_get(&pending.mutation)
            .unwrap()
            .is_some()
    );
    assert!(
        a.r.take_pushes()
            .iter()
            .all(|(_, p)| !matches!(p, Push::Receipt(r) if r.mutation == pending.mutation))
    );
}

#[test]
fn receipt_fanout_after_reconnect_uses_persisted_owner() {
    confirmed_after_connection_loss(false);
}

#[test]
fn receipt_fanout_after_reopen_uses_persisted_owner() {
    confirmed_after_connection_loss(true);
}
