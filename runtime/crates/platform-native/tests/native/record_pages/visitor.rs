use super::*;
use r::store::StoreError;
use std::ops::ControlFlow;

// The oracle keeps ordinary owned pages; only scalar metadata survives visits.
fn projection(row: RecordRow) -> (B16, String, w::common::B32, usize) {
    (row.id, row.path, row.revision, row.doc.len())
}

#[test]
fn record_visit_matches_independent_memstore_pages_with_utf8_and_nul() {
    let (mut store, reads) = fixture("record-visit-pages");
    let mut data = rows(37, 137);
    for (i, row) in data.iter_mut().enumerate() {
        if i % 3 == 0 {
            row.doc = "é\0".repeat((1 << 20) / 3);
            row.revision = w::hash::sha256(row.doc.as_bytes());
        }
    }
    let mut oracle = MemStore::new();
    seed(&mut oracle, &data);
    seed(&mut store, &data);
    let mut after = None;
    let mut count = 0;
    loop {
        let p = Page { after, limit: 7 };
        let expected = oracle
            .records(p)
            .unwrap()
            .into_iter()
            .map(projection)
            .collect::<Vec<_>>();
        let mut actual = Vec::new();
        assert_eq!(
            store
                .records_visit(p, &mut |row| {
                    actual.push(projection(row));
                    ControlFlow::<()>::Continue(())
                })
                .unwrap(),
            ControlFlow::Continue(())
        );
        assert_eq!(actual, expected);
        let mut default_visited = Vec::new();
        assert_eq!(
            oracle
                .records_visit(p, &mut |row| {
                    default_visited.push(projection(row));
                    ControlFlow::<()>::Continue(())
                })
                .unwrap(),
            ControlFlow::Continue(())
        );
        assert_eq!(default_visited, expected);
        if actual.is_empty() {
            break;
        }
        count += actual.len();
        after = actual.last().map(|row| row.0);
    }
    assert_eq!(count, data.len());
    reads.borrow_mut().clear();
    assert_eq!(
        store
            .records_visit(
                Page {
                    after: None,
                    limit: 0
                },
                &mut |_| -> ControlFlow<()> { panic!("zero-limit page must never call visitor") }
            )
            .unwrap(),
        ControlFlow::Continue(())
    );
    assert_eq!(reads.borrow().len(), 1);
}

#[test]
fn record_visit_caller_break_stops_before_another_payload_group() {
    let (mut store, reads) = fixture("record-visit-break");
    seed(&mut store, &rows(121, 68000));
    reads.borrow_mut().clear();
    let mut count = 0;
    let outcome = store
        .records_visit(
            Page {
                after: None,
                limit: 1024,
            },
            &mut |row| {
                count += 1;
                assert_eq!(row.id, B16(1_u128.to_be_bytes()));
                ControlFlow::Break("caller-stop")
            },
        )
        .unwrap();
    assert_eq!(outcome, ControlFlow::Break("caller-stop"));
    assert_eq!(count, 1);
    assert_eq!(
        reads.borrow().len(),
        2,
        "metadata plus first group; no further hydration"
    );
}

#[test]
fn record_visit_inventory_faults_are_typed_corrupt_without_callbacks_or_retry() {
    let faults = [
        "DELETE FROM st_rec WHERE id=(SELECT min(id) FROM st_rec)",
        "UPDATE st_rec SET id=zeroblob(16) WHERE id=(SELECT min(id) FROM st_rec)",
        "UPDATE st_rec SET row=zeroblob(1) WHERE id=(SELECT min(id) FROM st_rec)",
        "UPDATE st_rec SET row=(SELECT row FROM st_rec ORDER BY id DESC LIMIT 1) WHERE id=(SELECT min(id) FROM st_rec)",
        "INSERT INTO st_rec(id,path_key,bucket,row) SELECT x'00000000000000000000000000000002','new',0,row FROM st_rec ORDER BY id LIMIT 1",
    ];
    for (i, fault) in faults.iter().enumerate() {
        let (mut store, reads) = fixture(&format!("record-visit-fault-{i}"));
        let mut data = rows(3, 32);
        for (i, row) in data.iter_mut().enumerate() {
            row.id = B16((1 + 2 * i as u128).to_be_bytes());
        }
        seed(&mut store, &data);
        reads.borrow_mut().clear();
        store.index().borrow_mut().before_group = Some(fault);
        let mut visits = 0;
        let result = store.records_visit(
            Page {
                after: None,
                limit: 16,
            },
            &mut |_| {
                visits += 1;
                ControlFlow::<()>::Continue(())
            },
        );
        assert!(matches!(result, Err(StoreError::Corrupt(_))), "{fault}");
        assert_eq!(visits, 0);
        assert_eq!(reads.borrow().len(), 2);
    }
}

#[test]
fn record_visit_invalid_oversized_singleton_keeps_full_and_never_calls_visitor() {
    let (store, reads) = fixture("record-visit-full");
    store
        .index()
        .borrow_mut()
        .inner
        .run(&Batch {
            mode: BatchMode::Autocommit,
            stmts: vec![Stmt::new(
                "INSERT INTO st_rec VALUES(zeroblob(16),'oversized',0,zeroblob(4194304))",
                vec![],
            )],
        })
        .unwrap();
    reads.borrow_mut().clear();
    let mut visits = 0;
    let result = store.records_visit(
        Page {
            after: None,
            limit: 16,
        },
        &mut |_| {
            visits += 1;
            ControlFlow::<()>::Continue(())
        },
    );
    assert!(matches!(result, Err(StoreError::Full)));
    assert_eq!(visits, 0);
    assert_eq!(reads.borrow().len(), 2);
}
