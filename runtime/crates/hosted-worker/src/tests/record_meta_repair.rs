use super::*;
use crate::migration_action_ledger::tests::Sqlite;
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
            must_not_exist: Some(true),
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
    assert_eq!(
        host.e.take_repair_boundary().unwrap().finished,
        Some((0, 0))
    );
    host.pump(false);
    let (session, _) = host.e.hello(None, &hello());
    let mut passes = 0;
    for id in 1..=53 {
        host.e.tick(host.clock.get() as i64, false);
        host.pump(false);
        host.e.poll();
        let frame = match id {
            1..=48 => submit(id, &format!("tasks/{id}.md")),
            49..=52 => resource(id, &format!("_types/unused-{id}.json"), "{}"),
            _ => resource(
                id,
                "_types/task.md",
                "---\nkind: mdbase.type\nname: task\nmatch: {path_glob: 'tasks/*.md'}\nschema: {dialect: json-schema-2020-12, value: {type: object}}\n---\n",
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
                    passes += usize::from(boundary.started);
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
