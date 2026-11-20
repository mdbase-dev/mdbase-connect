use super::*;
use crate::migration_action_ledger::tests::Sqlite;
use mdbn_replica::replica::HostedRepairStart;
use mdbn_replica::store::{Tx, meta_keys};
use mdbn_store_file::{LogCache, SqlStoreLimits};
use mdbn_wire::intent::ResourcePut;
use std::cell::RefCell;

fn resource(id: u64, path: &str, source: &str) -> Vec<u8> {
    submit_op(
        id,
        Op::ResourcePut(ResourcePut {
            path: path.into(),
            doc: Text::Inline(source.into()),
            base_revision: None,
            must_not_exist: None,
        }),
    )
}

#[test]
fn hosted_alarm_repair_passes_follow_catalog_inputs() {
    exercise_repair(false);
}

#[test]
fn hosted_alarm_repair_resumes_at_the_same_head_after_eviction() {
    exercise_repair(true);
}

#[test]
fn verify_only_and_idle_alarm_write_budget() {
    let svc = world();
    let index = Rc::new(RefCell::new(Sqlite::new()));
    let cache = || LogCache::open(index.clone(), SqlStoreLimits::default()).unwrap();
    let mut host = open_store(&svc, cache(), 2);
    host.e.take_repair_boundary();
    host.pump_pushless();
    let catalog = mdbn_core::types::Catalog::empty();
    let mut seed = cache();
    for batch in 0..25 {
        seed.commit(mdbn_replica::store::Tx {
            records_put: (batch * 250 + 1..=((batch + 1) * 250).min(6205))
                .map(|id| {
                    let mut row =
                        mdbn_replica::conformance::record(id, &format!("{id}.md"), "hello");
                    row.meta = mdbn_replica::plan::record_meta(&catalog, &row.path, &row.doc);
                    row
                })
                .collect(),
            ..Default::default()
        })
        .unwrap();
    }
    let (session, _) = host.e.hello(None, &hello());
    host.e.frame(session, &resource(1, "_types/task.md", "---\nkind: mdbase.type\nname: task\nschema: {dialect: json-schema-2020-12, value: {type: object}}\n---\n"));
    host.pump_pushless();
    let changes = || index.borrow().db.total_changes();
    let mut alarms = 0;
    let mut starts = Vec::new();
    let mut visits = None;
    let interrupted_stamp = seed.meta(meta_keys::RECORD_META).unwrap();
    let mut interrupted_cursor = None;
    let begin = changes();
    let mut peak = 0;
    while !host.e.serving() {
        let before = changes();
        host.e.tick(host.clock.get() as i64, false);
        if let Some(boundary) = host.e.take_repair_boundary() {
            starts.extend(boundary.started);
            visits = boundary.finished;
        }
        if alarms == 0 {
            interrupted_cursor = seed.meta(meta_keys::HOSTED_RECORD_META_CURSOR).unwrap();
            assert!(interrupted_cursor.is_some());
        }
        host.pump_pushless();
        peak = peak.max(changes() - before);
        alarms += 1;
        assert!(alarms <= 4);
    }
    assert_eq!(starts, [HostedRepairStart::CatalogChanged]);
    assert_eq!(visits, Some((6205, 0)));
    let before = changes();
    host.e.tick(host.clock.get() as i64, false);
    let tick = changes() - before;
    host.e.retire_log();
    assert!(host.e.bind_log(COL));
    host.pump_pushless();
    let idle = changes() - before;
    eprintln!(
        "verify: alarms={alarms} total={} peak={peak}; idle tick={tick} incl refresh/pump={idle}",
        before - begin
    );
    assert_eq!((alarms, before - begin, peak, idle), (4, 5, 2, 0));

    let prior_head = host.e.applied_head();
    host.e.frame(session, &submit(2, "later.md"));
    host.pump_pushless();
    assert_eq!(host.e.applied_head().0, prior_head.0 + 1);
    assert_ne!(host.e.applied_head().1, prior_head.1);
    host.e.tick(host.clock.get() as i64, false);
    assert!(host.e.serving() && host.e.take_repair_boundary().is_none());
    drop(host);

    // Recovery fixture: a checkpoint produced at the previous real head, with
    // the ordinary record and complete log/policy state from the later head.
    seed.commit(Tx {
        meta: vec![
            (
                meta_keys::HOSTED_RECORD_META_CURSOR.into(),
                interrupted_cursor,
            ),
            (meta_keys::RECORD_META.into(), interrupted_stamp),
        ],
        ..Tx::default()
    })
    .unwrap();
    let mut resumed = open_store(&svc, cache(), 2);
    assert!(resumed.e.take_repair_boundary().is_none());
    let mut writer = open_with_entropy(&svc, 7);
    for _ in 0..4 {
        writer.pump(false);
        writer.e.tick(writer.clock.get() as i64, false);
    }
    assert!(writer.e.serving());
    let (peer_session, _) = writer.e.hello(None, &hello());
    writer
        .e
        .frame(peer_session, &submit(3, "while-repairing.md"));
    writer.pump(false);
    assert_eq!(writer.e.applied_head().0, prior_head.0 + 2);
    resumed.pump(false);
    assert_eq!(resumed.e.applied_head().0, prior_head.0 + 1);
    for _ in 0..2 {
        resumed.e.tick(resumed.clock.get() as i64, false);
    }
    let finish = resumed.e.take_repair_boundary().unwrap();
    assert_eq!(finish.started, None);
    assert_eq!(finish.finished, Some((6206, 0)));
    assert_eq!(resumed.e.replica().stats.reindexed, 6206 - 2048);
    resumed.pump(false);
    assert_eq!(resumed.e.applied_head(), writer.e.applied_head());
    assert!(resumed.e.serving() && resumed.e.take_repair_boundary().is_none());
}

#[test]
fn incompatible_checkpoint_restarts_once_with_reason() {
    let svc = world();
    let index = Rc::new(RefCell::new(Sqlite::new()));
    let cache = || LogCache::open(index.clone(), SqlStoreLimits::default()).unwrap();
    cache()
        .commit(Tx {
            meta: vec![(
                meta_keys::HOSTED_RECORD_META_CURSOR.into(),
                Some(vec![0; 104]),
            )],
            ..Tx::default()
        })
        .unwrap();
    let mut host = open_store(&svc, cache(), 2);
    let event = host.e.take_repair_boundary().unwrap();
    assert_eq!(
        (event.started, event.finished),
        (Some(HostedRepairStart::CursorInvalid), Some((0, 0)))
    );
    drop(host);
    assert!(
        open_store(&svc, cache(), 2)
            .e
            .take_repair_boundary()
            .is_none()
    );
}

fn exercise_repair(evict: bool) {
    let svc = world();
    let index = Rc::new(RefCell::new(Sqlite::new()));
    let reopen = || {
        open_store(
            &svc,
            LogCache::open(index.clone(), SqlStoreLimits::default()).unwrap(),
            2,
        )
    };
    let mut host = reopen();
    let first = host.e.take_repair_boundary().unwrap();
    assert_eq!(
        (first.started, first.finished),
        (Some(HostedRepairStart::FirstOpen), Some((0, 0)))
    );
    host.pump(false);
    let (mut session, _) = host.e.hello(None, &hello());
    let mut passes = 0;
    for id in 1..=55 {
        host.e.tick(host.clock.get() as i64, false);
        host.pump(false);
        host.e.poll();
        let frame = match id {
            1..=48 => submit(id, &format!("tasks/{id}.md")),
            49..=52 => resource(id, &format!("_types/unused-{id}.json"), "{}"),
            53 => resource(
                id,
                "_types/task.md",
                "---\nkind: mdbase.type\nname: task\nmatch: {path_glob: 'tasks/*.md'}\nschema: {dialect: json-schema-2020-12, value: {type: object}}\n---\n",
            ),
            54 => submit(id, "tasks/later.md"),
            _ => resource(
                id,
                "_types/task.md",
                "---\nkind: mdbase.type\nname: task\nmatch: {path_glob: 'tasks/*.md'}\nschema: {dialect: json-schema-2020-12, value: {type: object, description: 'Validation only'}}\n---\n",
            ),
        };
        let prior_head = host.e.applied_head().0;
        host.e.frame(session, &frame);
        host.pump(false);
        assert_eq!(
            host.e.applied_head().0,
            prior_head + 1,
            "input {id}: {:?}",
            host.e.poll()
        );
        let head = host.e.applied_head();
        let before = index.borrow().db.total_changes();
        assert_eq!(host.e.serving(), id != 53);
        if !host.e.serving() {
            let mut finishes = 0;
            for slice in 0..8 {
                host.e.tick(host.clock.get() as i64, false);
                if let Some(boundary) = host.e.take_repair_boundary() {
                    assert_eq!(boundary.applied_seq, head.0);
                    passes += usize::from(boundary.started.is_some());
                    if let Some(counts) = boundary.finished {
                        assert_eq!(counts, (48, 48));
                        finishes += 1;
                    }
                }
                if evict && slice == 0 {
                    assert_eq!(host.e.replica().stats.reindexed, 8);
                    drop(host);
                    host = reopen();
                    host.e.tick(host.clock.get() as i64, true);
                    assert_eq!(host.e.replica().stats.reindexed, 8);
                    assert!(host.e.take_repair_boundary().is_none());
                }
                host.pump(false);
                assert_eq!(host.e.applied_head(), head);
                if host.e.serving() {
                    break;
                }
            }
            assert_eq!(finishes, 1);
            if evict {
                session = host.e.hello(None, &hello()).0;
            }
        } else {
            assert!(host.e.take_repair_boundary().is_none());
            host.e.tick(host.clock.get() as i64, false);
            assert_eq!(index.borrow().db.total_changes(), before);
        }
        assert!(host.e.serving());
    }
    assert_eq!(passes, 1);
    assert_eq!(
        host.e
            .replica()
            .store()
            .record(&B16([48; 16]))
            .unwrap()
            .unwrap()
            .meta
            .types,
        ["task"]
    );
    drop(host);
    let mut warm = reopen();
    warm.e.tick(warm.clock.get() as i64, true);
    warm.pump(false);
    assert!(warm.e.serving());
    assert_eq!(warm.e.replica().stats.reindexed, 0);
}
