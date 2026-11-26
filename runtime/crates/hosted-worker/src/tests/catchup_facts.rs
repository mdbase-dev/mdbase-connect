//! connect#1850: the LAB catch-up diagnostics describe a wake that stops behind
//! the log on the per-tick apply budget, before the enrolment applies, then the
//! tick that catches up and grants.
use super::*;
use crate::runtime::CatchupFacts;
use mdbn_wire::envelope::{Item, KeyGrantPayload};

const JOINING: B16 = B16([0x5e; 16]);

fn key_grants_to(svc: &FakeLogService, device: B16) -> usize {
    svc.items(&COL)
        .iter()
        .filter_map(|raw| Item::from_bytes(raw).ok())
        .filter(|i| i.kind == ItemKind::KeyGrant)
        .filter(|i| KeyGrantPayload::from_bytes(&i.body.0).is_ok_and(|g| g.recipient == device))
        .count()
}

/// One note per submit, with ids unique past 255.
fn create(i: u64) -> Vec<u8> {
    let mut id = [0x0c; 16];
    id[8..].copy_from_slice(&i.to_be_bytes());
    let mut mutation = [0xa7; 16];
    mutation[8..].copy_from_slice(&i.to_be_bytes());
    let p = SubmitParams {
        ops: vec![Op::Create(Create {
            id: B16(id),
            path: Some(format!("notes/{i}.md")),
            type_name: None,
            frontmatter: None,
            body: None,
            document: Some(Text::Inline(format!("note {i}"))),
        })],
        mutation_id: Some(B16(mutation)),
        conflict_mode: None,
        timezone: None,
        allow_partial: None,
        mutation_ids: None,
        dry_run: None,
        include: None,
        wait: None,
        validation: None,
    };
    request(i + 1, "submit", p.to_cbor())
}

#[test]
fn catchup_facts_show_a_wake_stopped_behind_the_log_with_a_grant_waiting() {
    let (svc, mut cp) = world_with_cp();
    let mut h = open(&svc);
    h.pump_pushless();
    assert!(h.e.serving());
    let idle = h.e.catchup_facts();
    assert_eq!(idle.applied, svc.head(&COL).0);
    assert!(idle.caught_up && !idle.grant_waiting && !idle.grant_due);

    // Another writer seeds more log items than one tick may apply.
    let mut writer = open_with_entropy(&svc, 7);
    for _ in 0..8 {
        writer.pump(false);
        writer.e.tick(writer.clock.get() as i64, false);
    }
    let (session, _) = writer.e.hello(None, &hello());
    for i in 0..60 {
        writer.e.frame(session, &create(i));
        writer.pump(false);
    }
    cp.enrol(
        &svc,
        TestDevice {
            device: JOINING,
            account: TEST_OWNER,
            kind: DeviceKind::Desktop,
        },
    );
    let log_head = svc.head(&COL).0;
    assert!(
        log_head - idle.applied > 16,
        "a backlog over one tick's budget"
    );

    // The Worker's activation: re-subscribe and sync, with no tick.
    h.e.retire_log();
    assert!(h.e.bind_log(COL));
    h.pump_pushless();
    let CatchupFacts {
        applied,
        head_known,
        caught_up,
        grant_waiting,
        grant_due,
    } = h.e.catchup_facts();
    assert_eq!(head_known, log_head, "the wake heard the log head");
    assert!(applied < head_known && !caught_up, "stopped behind the log");
    assert_eq!(
        applied, 16,
        "one tick's apply budget since open: no tick has run"
    );
    assert!(
        !grant_waiting && !grant_due,
        "the enrolment is still behind the backlog, so no grant is visible yet"
    );
    assert_eq!(key_grants_to(&svc, JOINING), 0);
    assert!(!h.e.serving());

    // The next warm alarm catches up and grants.
    h.clock.set(h.clock.get() + 1_000);
    h.e.tick(h.clock.get() as i64, false);
    h.pump_pushless();
    assert_eq!(key_grants_to(&svc, JOINING), 1);
    let done = h.e.catchup_facts();
    assert!(done.caught_up && !done.grant_waiting && !done.grant_due);
    assert_eq!(done.applied, svc.head(&COL).0);
}
