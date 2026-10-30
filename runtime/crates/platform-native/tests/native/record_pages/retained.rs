//! Retained-state regressions: real SQLite and unchanged binary codec.
use super::*;
use r::store::{AliasRow, ConflictRow, TombstoneLast, TombstoneRow};
use w::attachment_runtime_v1 as rt;
use w::common::Text;
use w::schema::Wire;

#[test]
fn retained_deleted_documents_preserve_page_and_state_digest() {
    let (mut store, _) = fixture("retained-tombstones");
    let mut oracle = MemStore::new();
    let tombs: Vec<_> = rows(121, 68_000)
        .into_iter()
        .map(|r| TombstoneRow {
            id: r.id,
            kind: w::snapshot::EntityKind::Record,
            path: r.path,
            path_key: r.path_key,
            last: TombstoneLast::Doc(r.doc),
            seq: 1,
            time: 0,
        })
        .collect();
    for row in &tombs {
        let tx = Tx {
            tombstones_put: vec![row.clone()],
            ..Default::default()
        };
        oracle.commit(tx.clone()).unwrap();
        store.commit(tx).unwrap();
    }
    let expected = r::replica::state_digest(&oracle).unwrap();
    eprintln!("retained tombstone same-data oracle: {expected:?}");
    assert_eq!(r::replica::state_digest(&store).unwrap(), expected);
    store.index().borrow_mut().sql_calls = 0;
    assert_eq!(
        store
            .tombstones(Page {
                after: None,
                limit: 1024
            })
            .unwrap(),
        tombs
    );
    let calls = store.index().borrow().sql_calls;
    eprintln!("retained tombstone Page1024 SQL round trips: {calls}");
    assert_eq!(calls, 6);
}
#[test]
fn large_legal_conflict_sides_preserve_inventory_filter_and_digest() {
    let (mut store, _) = fixture("retained-conflict-sides");
    let mut oracle = MemStore::new();
    let mut conflicts = Vec::new();
    for (i, mut row) in rows(32, 68_000).into_iter().enumerate() {
        row.doc = "k".repeat(68_000);
        row.revision = w::hash::sha256(row.doc.as_bytes());
        let side = |text: char| {
            rt::ConflictValue::Legacy(w::entry::ConflictValue::Text(Text::Inline(
                text.to_string().repeat(68_000),
            )))
        };
        let conflict = ConflictRow {
            mutation: B16((1000 + i as u128).to_be_bytes()),
            seq: i as u64 + 1,
            conflict: rt::Conflict {
                id: row.id,
                kind: w::entry::ConflictKind::Body,
                field: None,
                base: Some(side('b')),
                kept: side('k'),
                lost: side('l'),
            },
        };
        assert_eq!(
            rt::Conflict::from_cbor(&conflict.conflict.to_cbor()).unwrap(),
            conflict.conflict
        );
        let tx = Tx {
            records_put: vec![row],
            conflicts_put: vec![conflict.clone()],
            ..Default::default()
        };
        oracle.commit(tx.clone()).unwrap();
        store.commit(tx).unwrap();
        conflicts.push(conflict);
    }
    let expected = r::replica::state_digest(&oracle).unwrap();
    eprintln!("large-conflict same-data oracle: {expected:?};32 conflicts x3x68000B text sides");
    store.index().borrow_mut().sql_calls = 0;
    assert_eq!(store.conflicts(None).unwrap(), conflicts);
    let calls = store.index().borrow().sql_calls;
    eprintln!("large-conflict inventory SQL round trips: {calls}");
    assert_eq!(calls, 6);
    assert_eq!(
        store.conflicts(Some(&conflicts[7].conflict.id)).unwrap(),
        vec![conflicts[7].clone()]
    );
    assert_eq!(r::replica::state_digest(&store).unwrap(), expected);
}
#[test]
fn legal_max_length_aliases_at_observed_record_max_preserve_order_and_digest() {
    let (mut store, _) = fixture("retained-aliases-4073");
    let mut oracle = MemStore::new();
    let rows = rows(4073, 32);
    let aliases: Vec<_> = rows
        .iter()
        .enumerate()
        .map(|(i, row)| {
            let segment = if i % 2 == 0 { "A" } else { "a" }.repeat(120);
            let prefix = format!("{segment}/").repeat(7);
            let suffix = format!("{i:05}.md");
            let path = format!(
                "{prefix}{}{suffix}",
                "x".repeat(1024 - prefix.len() - suffix.len())
            );
            assert_eq!(path.len(), mdbn_core::paths::MAX_PATH_BYTES);
            mdbn_core::paths::check_path(&path).unwrap();
            AliasRow {
                path_key: mdbn_core::paths::path_key(&path),
                path,
                record: row.id,
            }
        })
        .collect();
    for (rs, als) in rows.chunks(64).zip(aliases.chunks(64)) {
        let tx = Tx {
            records_put: rs.to_vec(),
            aliases_put: als.to_vec(),
            ..Default::default()
        };
        oracle.commit(tx.clone()).unwrap();
        store.commit(tx).unwrap();
    }
    let mut expected_aliases = aliases;
    expected_aliases.sort_by(|a, b| a.path.cmp(&b.path).then(a.path_key.cmp(&b.path_key)));
    let expected = r::replica::state_digest(&oracle).unwrap();
    eprintln!(
        "alias same-data oracle: {expected:?};4073 live records/one1024-byte legal alias each"
    );
    store.index().borrow_mut().sql_calls = 0;
    assert_eq!(store.aliases().unwrap(), expected_aliases);
    let calls = store.index().borrow().sql_calls;
    eprintln!("4073 max-path aliases SQL round trips: {calls}");
    assert_eq!(calls, 33);
    assert_eq!(r::replica::state_digest(&store).unwrap(), expected);
}
