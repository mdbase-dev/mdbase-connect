use super::*;
use r::store::StoreError;
#[test]
fn mixed_record_keyset_pages_are_exact_repeatable_and_complete() {
    let (mut store, reads) = fixture("record-page-mixed");
    let mut rows = rows(37, 200);
    for (i, row) in rows.iter_mut().enumerate() {
        if i % 3 == 0 {
            row.doc = "é\0".repeat((1 << 20) / 3);
            row.revision = w::hash::sha256(row.doc.as_bytes());
        }
    }
    seed(&mut store, &rows);
    let mut after = None;
    let mut all = Vec::new();
    loop {
        let p = Page { after, limit: 7 };
        let page = store.records(p).unwrap();
        assert_eq!(store.records(p).unwrap(), page, "same page, same data");
        if page.is_empty() {
            break;
        }
        after = page.last().map(|r| r.id);
        all.extend(page);
    }
    assert_eq!(
        all, rows,
        "no skips or duplicates, including UTF8/NUL documents"
    );
    reads.borrow_mut().clear();
    assert!(
        store
            .records(Page {
                after: None,
                limit: 0
            })
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        reads.borrow().len(),
        1,
        "empty metadata needs no payload reads"
    );
}
#[test]
fn oversized_encoded_singleton_keeps_typed_full_without_retry() {
    // Synthetic invalid stored BLOB, not an admissible client document. The
    // transport must retain its old Full before decoding, never retry/skip it.
    let (store, reads) = fixture("record-page-oversized-encoded");
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
    assert!(matches!(
        store.records(Page {
            after: None,
            limit: 16
        }),
        Err(StoreError::Full)
    ));
    assert_eq!(reads.borrow().len(), 2);
}

#[test]
fn record_inventory_faults_are_typed_corrupt_without_retry() {
    let faults = [
        "DELETE FROM st_rec WHERE id=(SELECT min(id) FROM st_rec)",
        "UPDATE st_rec SET id=zeroblob(16) WHERE id=(SELECT min(id) FROM st_rec)",
        "UPDATE st_rec SET row=zeroblob(1) WHERE id=(SELECT min(id) FROM st_rec)",
        // Equal byte length, but payload has the wrong decoded record ID.
        "UPDATE st_rec SET row=(SELECT row FROM st_rec ORDER BY id DESC LIMIT 1) WHERE id=(SELECT min(id) FROM st_rec)",
        "INSERT INTO st_rec(id,path_key,bucket,row) SELECT x'00000000000000000000000000000002','new',0,row FROM st_rec ORDER BY id LIMIT 1",
    ];
    for (n, fault) in faults.iter().enumerate() {
        let (mut store, reads) = fixture(&format!("record-page-fault-{n}"));
        let mut rows = rows(3, 32);
        for (i, row) in rows.iter_mut().enumerate() {
            row.id = B16((1 + 2 * i as u128).to_be_bytes());
        }
        seed(&mut store, &rows);
        reads.borrow_mut().clear();
        store.index().borrow_mut().before_group = Some(fault);
        assert!(
            matches!(
                store.records(Page {
                    after: None,
                    limit: 16
                }),
                Err(StoreError::Corrupt(_))
            ),
            "{fault}"
        );
        assert_eq!(
            reads.borrow().len(),
            2,
            "one metadata + one rejected group, no retry"
        );
    }
}
