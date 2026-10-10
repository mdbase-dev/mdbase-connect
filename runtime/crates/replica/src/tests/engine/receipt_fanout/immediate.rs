//! Immediate durable receipt states, without asynchronous optimistic record views.
use super::*;

fn create_params(record: u8, path: &str) -> SubmitParams {
    SubmitParams {
        ops: vec![Op::Create(Create {
            id: B16([record; 16]),
            path: Some(path.into()),
            type_name: None,
            frontmatter: None,
            body: None,
            document: Some(Text::Inline("owned".into())),
        })],
        mutation_id: None,
        conflict_mode: None,
        timezone: None,
        allow_partial: None,
        mutation_ids: None,
        dry_run: None,
        include: None,
        wait: None,
    }
}

fn targets(a: &mut Node, mutation: B16, state: ReceiptState) -> Vec<SessionId> {
    a.r.take_pushes()
        .into_iter()
        .filter_map(|(session, push)| match push {
            Push::Receipt(receipt) if receipt.mutation == mutation && receipt.state == state => {
                assert!(
                    receipt.records.is_none(),
                    "pushes contain receipt metadata only"
                );
                Some(session)
            }
            _ => None,
        })
        .collect()
}

fn exact_targets(mut actual: Vec<SessionId>, expected: &[SessionId]) {
    let mut expected = expected.to_vec();
    actual.sort();
    expected.sort();
    assert_eq!(
        actual, expected,
        "exactly one receipt per eligible current session"
    );
}

#[test]
fn immediate_receipt_fanout_pending_and_rejected_use_persisted_owner_without_consuming_submitter() {
    let (_, mut a) = fixture();
    let host = a.s;
    let owner = granted(&mut a, B16([0x55; 16]), 0x57);
    let peer = granted(&mut a, B16([0x55; 16]), 0x57);
    let _other = granted(&mut a, B16([0x66; 16]), 0x67);
    a.r.take_pushes();
    let pending =
        a.r.submit(owner, create_params(10, "immediate.md"))
            .unwrap()
            .remove(0);
    assert_eq!(pending.state, ReceiptState::Pending);
    assert!(pending.records.is_some(), "RPC result remains unchanged");
    assert_eq!(a.r.submitted_by.get(&pending.mutation), Some(&owner));
    assert_eq!(
        a.r.store()
            .pending_get(&pending.mutation)
            .unwrap()
            .unwrap()
            .grant,
        Some(B16([0x55; 16]))
    );
    exact_targets(
        targets(&mut a, pending.mutation, ReceiptState::Pending),
        &[host, owner, peer],
    );
    assert_eq!(
        a.r.submitted_by.get(&pending.mutation),
        Some(&owner),
        "Hosted transient resolution still needs the original session"
    );
    let rejected =
        a.r.submit(owner, create_params(20, "immediate.md"))
            .unwrap()
            .remove(0);
    assert_eq!(rejected.state, ReceiptState::Rejected);
    let stored =
        a.r.store()
            .local_receipt(&rejected.mutation)
            .unwrap()
            .unwrap();
    assert_eq!(stored.state, ReceiptState::Rejected);
    assert_eq!(stored.grant, Some(B16([0x55; 16])));
    assert_eq!(stored.problem, rejected.problem);
    exact_targets(
        targets(&mut a, rejected.mutation, ReceiptState::Rejected),
        &[host, owner, peer],
    );
    assert_eq!(a.r.submitted_by.get(&pending.mutation), Some(&owner));
}

#[test]
fn immediate_receipt_fanout_write_only_owner_receives_pending_and_rejection_metadata() {
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
    let host = a.s;
    let owner = granted(&mut a, B16([0x77; 16]), 0x79);
    let peer = granted(&mut a, B16([0x77; 16]), 0x79);
    let _other = granted(&mut a, B16([0x66; 16]), 0x67);
    assert!(
        a.r.status(owner).is_err(),
        "write-only grant lacks read capability"
    );
    a.r.take_pushes();
    let pending =
        a.r.submit(owner, create_params(10, "write-only-immediate.md"))
            .unwrap()
            .remove(0);
    assert_eq!(pending.state, ReceiptState::Pending);
    exact_targets(
        targets(&mut a, pending.mutation, ReceiptState::Pending),
        &[host, owner, peer],
    );
    let rejected =
        a.r.submit(owner, create_params(20, "write-only-immediate.md"))
            .unwrap()
            .remove(0);
    assert_eq!(rejected.state, ReceiptState::Rejected);
    exact_targets(
        targets(&mut a, rejected.mutation, ReceiptState::Rejected),
        &[host, owner, peer],
    );
}

#[test]
fn immediate_receipt_fanout_host_capture_never_broadcasts_to_grants() {
    let (_, mut a) = fixture();
    let host = a.s;
    let peer = a.r.hello(SessionAuth::Host, sec047_app_hello()).unwrap().0;
    let _grant = granted(&mut a, B16([0x55; 16]), 0x57);
    let _other = granted(&mut a, B16([0x66; 16]), 0x67);
    a.r.take_pushes();
    let pending =
        a.r.submit(host, create_params(10, "host-immediate.md"))
            .unwrap()
            .remove(0);
    assert_eq!(pending.state, ReceiptState::Pending);
    exact_targets(
        targets(&mut a, pending.mutation, ReceiptState::Pending),
        &[host, peer],
    );
}

#[test]
fn immediate_receipt_fanout_dry_runs_and_known_id_retries_do_not_invent_state_changes() {
    let (_, mut a) = fixture();
    let initial_head = a.r.head().seq;
    let owner = granted(&mut a, B16([0x55; 16]), 0x57);
    a.r.take_pushes();
    let mut dry = create_params(10, "dry-immediate.md");
    dry.dry_run = Some(true);
    let preview = a.r.submit(owner, dry).unwrap().remove(0);
    assert_eq!(preview.state, ReceiptState::Pending);
    assert!(!a.r.receipt_exists(&preview.mutation).unwrap());
    assert!(targets(&mut a, preview.mutation, ReceiptState::Pending).is_empty());
    let pending =
        a.r.submit(owner, create_params(20, "retry-immediate.md"))
            .unwrap()
            .remove(0);
    a.r.take_pushes();
    let mut retry = create_params(21, "must-not-plan.md");
    retry.mutation_id = Some(pending.mutation);
    let retried = a.r.submit(owner, retry.clone()).unwrap().remove(0);
    assert_eq!(retried.state, ReceiptState::Pending);
    assert_eq!(a.r.sync_status().pending, 1);
    assert_eq!(a.r.submitted_by.get(&pending.mutation), Some(&owner));
    assert!(targets(&mut a, pending.mutation, ReceiptState::Pending).is_empty());
    settle(&mut [&mut a]);
    a.r.take_pushes();
    assert_eq!(
        a.r.submit(owner, retry).unwrap()[0].state,
        ReceiptState::Confirmed
    );
    assert!(targets(&mut a, pending.mutation, ReceiptState::Confirmed).is_empty());
    let mut dry = create_params(30, "retry-immediate.md");
    dry.dry_run = Some(true);
    let preview = a.r.submit(owner, dry).unwrap().remove(0);
    assert_eq!(preview.state, ReceiptState::Rejected);
    assert!(!a.r.receipt_exists(&preview.mutation).unwrap());
    assert!(targets(&mut a, preview.mutation, ReceiptState::Rejected).is_empty());
    let rejected =
        a.r.submit(owner, create_params(31, "retry-immediate.md"))
            .unwrap()
            .remove(0);
    assert_eq!(rejected.state, ReceiptState::Rejected);
    a.r.take_pushes();
    let mut retry = create_params(32, "must-not-plan-rejection.md");
    retry.mutation_id = Some(rejected.mutation);
    assert_eq!(
        a.r.submit(owner, retry).unwrap()[0].state,
        ReceiptState::Rejected
    );
    assert!(targets(&mut a, rejected.mutation, ReceiptState::Rejected).is_empty());
    assert_eq!(
        a.r.head().seq,
        initial_head + 1,
        "exactly one captured entry, no retry append"
    );
}

#[test]
fn immediate_receipt_fanout_certified_abort_emits_neither_pending_nor_immediate_rejection() {
    let (_, mut a) = fixture();
    a.create(10, "existing-immediate.md", "existing");
    settle(&mut [&mut a]);
    let owner = granted(&mut a, B16([0x55; 16]), 0x57);
    a.r.take_pushes();
    for (record, path, mid) in [
        (20, "new-aborted.md", 0xe1),
        (21, "existing-immediate.md", 0xe2),
    ] {
        let mutation = B16([mid; 16]);
        let mut params = create_params(record, path);
        params.mutation_id = Some(mutation);
        a.r.store().fail_commits(1);
        assert!(a.r.submit(owner, params).is_err());
        assert!(a.r.store().pending_get(&mutation).unwrap().is_none());
        assert!(a.r.store().local_receipt(&mutation).unwrap().is_none());
        assert!(!a.r.submitted_by.contains_key(&mutation));
        assert!(
            a.r.take_pushes()
                .iter()
                .all(|(_, push)| !matches!(push, Push::Receipt(r) if r.mutation == mutation))
        );
    }
}

#[test]
fn immediate_receipt_fanout_partial_record_admission_rejection_is_post_commit_and_scoped() {
    let (_, mut a) = fixture();
    // Use canonical Core frontmatter/body composition, not the small engine planner.
    a.r.planner = Box::new(crate::plan::CorePlanner);
    let host = a.s;
    let owner = granted(&mut a, B16([0x55; 16]), 0x57);
    let peer = granted(&mut a, B16([0x55; 16]), 0x57);
    let _other = granted(&mut a, B16([0x66; 16]), 0x67);
    a.r.take_pushes();
    let mut params = create_params(10, "oversized-immediate.md");
    let Op::Create(create) = &mut params.ops[0] else {
        unreachable!()
    };
    // Each direct source fits; only the complete planned document exceeds the cap.
    create.document = None;
    create.body = Some(Text::Inline(
        "x".repeat(mdbn_core::intent::RECORD_SOURCE_CAP_BYTES as usize - 64),
    ));
    create.frontmatter = Some(mdbn_wire::common::DataMap(vec![(
        "note".into(),
        mdbn_wire::common::Value::Text("y".repeat(128)),
    )]));
    params.allow_partial = Some(true);
    let rejected = a.r.submit(owner, params.clone()).unwrap().remove(0);
    assert_eq!(rejected.state, ReceiptState::Rejected);
    assert_eq!(
        rejected.problem.as_ref().unwrap().reason.as_deref(),
        Some("record_too_large"),
        "unexpected planner refusal: {:?}",
        rejected.problem
    );
    assert!(
        a.r.store()
            .pending_get(&rejected.mutation)
            .unwrap()
            .is_none()
    );
    let stored =
        a.r.store()
            .local_receipt(&rejected.mutation)
            .unwrap()
            .unwrap();
    assert_eq!(stored.grant, Some(B16([0x55; 16])));
    assert_eq!(stored.state, ReceiptState::Rejected);
    assert_eq!(stored.problem, rejected.problem);
    assert_eq!(a.r.sync_status().pending, 0);
    exact_targets(
        targets(&mut a, rejected.mutation, ReceiptState::Rejected),
        &[host, owner, peer],
    );

    let mut retry = params.clone();
    retry.mutation_ids = Some(vec![rejected.mutation]);
    assert_eq!(
        a.r.submit(owner, retry).unwrap()[0].state,
        ReceiptState::Rejected
    );
    assert!(targets(&mut a, rejected.mutation, ReceiptState::Rejected).is_empty());
    let mut dry = params.clone();
    dry.dry_run = Some(true);
    let preview = a.r.submit(owner, dry).unwrap().remove(0);
    assert_eq!(preview.state, ReceiptState::Rejected);
    assert_eq!(
        preview.problem.as_ref().unwrap().reason.as_deref(),
        Some("record_too_large")
    );
    assert!(!a.r.receipt_exists(&preview.mutation).unwrap());
    assert!(targets(&mut a, preview.mutation, ReceiptState::Rejected).is_empty());

    let aborted = B16([0xe3; 16]);
    params.mutation_ids = Some(vec![aborted]);
    a.r.store().fail_commits(1);
    assert!(a.r.submit(owner, params).is_err());
    assert!(!a.r.receipt_exists(&aborted).unwrap());
    assert!(!a.r.submitted_by.contains_key(&aborted));
    assert!(targets(&mut a, aborted, ReceiptState::Rejected).is_empty());
}
