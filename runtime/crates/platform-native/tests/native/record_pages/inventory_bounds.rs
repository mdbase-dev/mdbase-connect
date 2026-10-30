use super::*;
use r::store::{AliasRow, ConflictRow, StoreError, TombstoneLast, TombstoneRow};
use w::{attachment_runtime_v1 as rt, common::Text};
fn conflict(m: u128, id: B16) -> ConflictRow {
    let side =
        |s: &str| rt::ConflictValue::Legacy(w::entry::ConflictValue::Text(Text::Inline(s.into())));
    ConflictRow {
        mutation: B16(m.to_be_bytes()),
        seq: m as u64,
        conflict: rt::Conflict {
            id,
            kind: w::entry::ConflictKind::Body,
            field: None,
            base: Some(side("base")),
            kept: side("kept"),
            lost: side("lost"),
        },
    }
}
#[test]
fn composite_conflict_cursor_crosses_metadata_pages_without_skips() {
    let (mut store, _) = fixture("conflict-metadata-keyset");
    let mut oracle = MemStore::new();
    let mut conflicts: Vec<_> = (0..1100)
        .map(|i| conflict(1000 + i / 11, B16((1 + i % 11).to_be_bytes())))
        .collect();
    conflicts.sort_by_key(|r| (r.mutation, r.conflict.id));
    for chunk in conflicts.chunks(64) {
        let tx = Tx {
            conflicts_put: chunk.to_vec(),
            ..Default::default()
        };
        store.commit(tx.clone()).unwrap();
        oracle.commit(tx).unwrap();
    }
    assert_eq!(store.conflicts(None).unwrap(), conflicts);
    assert_eq!(
        r::replica::state_digest(&store).unwrap(),
        r::replica::state_digest(&oracle).unwrap()
    );
}
#[test]
fn retained_inventory_faults_are_corrupt_without_retry() {
    // Deliberate same-owner invariant violations, never competing user edits.
    let faults = [
        (
            "tomb",
            "DELETE FROM st_tomb WHERE id=(SELECT min(id) FROM st_tomb)",
        ),
        (
            "tomb",
            "UPDATE st_tomb SET row=(SELECT row FROM st_tomb ORDER BY id DESC LIMIT 1) WHERE id=(SELECT min(id) FROM st_tomb)",
        ),
        (
            "alias",
            "DELETE FROM st_alias WHERE path_key=(SELECT min(path_key) FROM st_alias)",
        ),
        (
            "alias",
            "UPDATE st_alias SET row=(SELECT row FROM st_alias ORDER BY path_key DESC LIMIT 1) WHERE path_key=(SELECT min(path_key) FROM st_alias)",
        ),
        (
            "conflict",
            "DELETE FROM st_conflict WHERE m=(SELECT min(m) FROM st_conflict)",
        ),
        (
            "conflict",
            "UPDATE st_conflict SET row=(SELECT row FROM st_conflict ORDER BY m DESC LIMIT 1) WHERE m=(SELECT min(m) FROM st_conflict)",
        ),
    ];
    for (n, (kind, sql)) in faults.into_iter().enumerate() {
        let (mut store, _) = fixture(&format!("retained-invariant-{n}"));
        let rows = rows(2, 32);
        let tx = Tx {
            tombstones_put: rows
                .iter()
                .map(|r| TombstoneRow {
                    id: r.id,
                    kind: w::snapshot::EntityKind::Record,
                    path: r.path.clone(),
                    path_key: r.path_key.clone(),
                    last: TombstoneLast::Doc(r.doc.clone()),
                    seq: 1,
                    time: 0,
                })
                .collect(),
            aliases_put: rows
                .iter()
                .map(|r| AliasRow {
                    path: r.path.clone(),
                    path_key: r.path_key.clone(),
                    record: r.id,
                })
                .collect(),
            conflicts_put: rows
                .iter()
                .enumerate()
                .map(|(i, r)| conflict(1000 + i as u128, r.id))
                .collect(),
            ..Default::default()
        };
        store.commit(tx).unwrap();
        {
            let index = store.index();
            let mut index = index.borrow_mut();
            index.before_group = Some(sql);
            index.payload_reads = 0;
        }
        let error = match kind {
            "tomb" => store
                .tombstones(Page {
                    after: None,
                    limit: 1024,
                })
                .unwrap_err(),
            "alias" => store.aliases().unwrap_err(),
            "conflict" => store.conflicts(None).unwrap_err(),
            _ => unreachable!(),
        };
        assert!(matches!(error, StoreError::Corrupt(_)), "{sql}: {error:?}");
        assert_eq!(store.index().borrow().payload_reads, 1, "no retry/fallback");
    }
}
