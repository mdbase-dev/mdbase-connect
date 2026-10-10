//! The `Store` conformance suite.
//!
//! Every store runs it: `mdbn_replica::conformance::run(|| MyStore::new_empty())`.
//! Each check starts from a fresh, empty store and panics with the rule it found
//! broken. File-backed stores also need their own publish/observe tests; this suite
//! covers what every store shares.

use mdbn_wire::client::{Hold, HoldReason, ReceiptState};
use mdbn_wire::common::{B16, B32, DataMap, Hash, Uuid, Value};
use mdbn_wire::entry::{Conflict, ConflictKind, ConflictValue};
use mdbn_wire::intent::{
    BlobRef, ConflictMode, FileInclusion, MediaClass, Mutation, Op, OpClock, Source,
};
use mdbn_wire::snapshot::{EntityKind, TextOrBlob};

use crate::store::{
    AliasRow, Candidate, ConflictRow, FileLocal, FileRow, Head, LocalReceipt, Page, PendingRow,
    Prune, ReceiptRow, RecordMeta, RecordRow, Store, TailRow, TailStats, TombstoneLast,
    TombstoneRow, TransferRow, Tx, bucket16,
};

type Check = fn(&mut dyn Store);

/// Run every check against fresh stores from `make`.
pub fn run<S: Store>(mut make: impl FnMut() -> S) {
    let checks: &[(&str, Check)] = &[
        ("empty store", empty),
        ("records: put, lookup, move, delete", records),
        ("records: paging and buckets", record_pages),
        ("derived indexes follow puts and removals", indexes),
        ("candidates are a superset, in ID order", candidates),
        ("files", files),
        ("resources and settings", resources),
        ("tombstones and horizon pruning", tombstones),
        ("aliases and conflicts", aliases_conflicts),
        ("receipts", receipts),
        ("pending queue order and lookup", pending),
        ("pending queue at 10k rows", pending_many),
        ("clear_confirmed keeps local state", clear_confirmed),
        ("snapshot-install staging: put, swap, discard", staging),
        ("local receipts, holds, meta", local_state),
        ("transfers and blobs", transfers_blobs),
    ];
    for (name, check) in checks {
        eprintln!("store conformance: {name}");
        let mut s = make();
        check(&mut s);
        eprintln!("store conformance: {name}: ok");
    }
}

/// Run the lost-tail retention checks (`Store::tail`, `Store::own_retained`).
///
/// Separate from [`run`]: the trait's defaults retain nothing, so a store opts in
/// once it implements retention (lost-tail repair and retention contract).
pub fn run_tail<S: Store>(mut make: impl FnMut() -> S) {
    let checks: &[(&str, Check)] = &[
        ("tail: put, page, stats", tail_basics),
        ("tail: drop below and above, replace", tail_drops),
        (
            "tail: zero erasure sentinel and maximum bounds",
            retained_boundaries,
        ),
        ("tail: kept by clear_confirmed", tail_survives_clear),
        ("own-retained: put, page, drops", own_retained_basics),
        (
            "own-retained: confirm hands over from pending atomically",
            own_retained_handover,
        ),
        (
            "own-retained prunes with the tail in one commit",
            retained_prune_together,
        ),
    ];
    for (name, check) in checks {
        eprintln!("store conformance: {name}");
        let mut s = make();
        check(&mut s);
        eprintln!("store conformance: {name}: ok");
    }
}

fn tail_row(seq: u64, len: usize) -> TailRow {
    TailRow {
        seq,
        item: vec![u8::try_from(seq % 251).unwrap_or(0); len],
        applied_at: i64::try_from(seq).unwrap_or(0) * 1_000,
    }
}

fn tail_seqs(s: &dyn Store) -> Vec<u64> {
    s.tail(0, u32::MAX).unwrap().iter().map(|r| r.seq).collect()
}

fn tail_basics(s: &mut dyn Store) {
    assert!(s.tail(0, 10).unwrap().is_empty());
    assert_eq!(s.tail_stats().unwrap(), TailStats::default());
    commit(
        s,
        Tx {
            tail_put: (1..=5).map(|n| tail_row(n, 10 * n as usize)).collect(),
            ..Tx::default()
        },
    );
    assert_eq!(tail_seqs(s), vec![1, 2, 3, 4, 5], "seq order");
    let page: Vec<u64> = s.tail(2, 2).unwrap().iter().map(|r| r.seq).collect();
    assert_eq!(page, vec![3, 4], "paging after a seq");
    assert_eq!(s.tail(4, 1).unwrap()[0], tail_row(5, 50), "exact bytes");
    assert_eq!(
        s.tail_stats().unwrap(),
        TailStats {
            first: 1,
            last: 5,
            count: 5,
            bytes: 150
        }
    );
}

fn tail_drops(s: &mut dyn Store) {
    commit(
        s,
        Tx {
            tail_put: (1..=6).map(|n| tail_row(n, 10)).collect(),
            ..Tx::default()
        },
    );
    // Pruning in the same commit as a new row.
    commit(
        s,
        Tx {
            tail_put: vec![tail_row(7, 10)],
            tail_drop_below: Some(3),
            ..Tx::default()
        },
    );
    assert_eq!(tail_seqs(s), vec![3, 4, 5, 6, 7]);
    // Rollback above 4, then a different item takes position 5 in the same commit.
    commit(
        s,
        Tx {
            tail_drop_above: Some(4),
            tail_put: vec![tail_row(5, 99)],
            ..Tx::default()
        },
    );
    assert_eq!(tail_seqs(s), vec![3, 4, 5]);
    assert_eq!(s.tail(4, 1).unwrap()[0].item.len(), 99, "replaced bytes");
    assert_eq!(
        s.tail_stats().unwrap(),
        TailStats {
            first: 3,
            last: 5,
            count: 3,
            bytes: 119
        }
    );
    // Replacing a row by seq keeps the byte count exact.
    commit(
        s,
        Tx {
            tail_put: vec![tail_row(5, 1)],
            ..Tx::default()
        },
    );
    assert_eq!(s.tail_stats().unwrap().bytes, 21);
    // An install drops everything.
    commit(
        s,
        Tx {
            tail_drop_above: Some(0),
            ..Tx::default()
        },
    );
    assert!(s.tail(0, 10).unwrap().is_empty());
    assert_eq!(s.tail_stats().unwrap(), TailStats::default());
}

fn retained_boundaries(s: &mut dyn Store) {
    commit(
        s,
        Tx {
            tail_put: vec![tail_row(1, 10)],
            own_retained_put: vec![(1, pending_row(1, 70))],
            ..Tx::default()
        },
    );
    let before = s.tail_stats().unwrap();
    // Backends may reject positions outside their integer representation, but a
    // rejected transaction must be atomic. Bounds themselves remain well-defined.
    if s.commit(Tx {
        tail_put: vec![tail_row(u64::MAX, 11)],
        own_retained_put: vec![(u64::MAX, pending_row(2, 71))],
        ..Tx::default()
    })
    .is_err()
    {
        assert_eq!(
            s.tail_stats().unwrap(),
            before,
            "rejected position cannot change tail accounting"
        );
        assert_eq!(
            s.own_retained(0, 10).unwrap(),
            vec![(1, pending_row(1, 70))]
        );
    } else {
        assert_eq!(s.tail_stats().unwrap().count, 2);
        assert_eq!(s.own_retained(0, 10).unwrap().len(), 2);
    }
    let tail = s.tail(0, 10).unwrap();
    let own = s.own_retained(0, 10).unwrap();
    let stats = s.tail_stats().unwrap();
    commit(
        s,
        Tx {
            tail_drop_above: Some(u64::MAX),
            own_retained_drop_above: Some(u64::MAX),
            ..Tx::default()
        },
    );
    assert_eq!(s.tail(0, 10).unwrap(), tail, "nothing is above MAX");
    assert_eq!(s.own_retained(0, 10).unwrap(), own, "own MAX is not pruned");
    assert_eq!(s.tail_stats().unwrap(), stats);
    assert!(
        s.tail(u64::MAX, 10).unwrap().is_empty(),
        "strict after bound"
    );
    assert!(
        s.own_retained(u64::MAX, 10).unwrap().is_empty(),
        "strict own after bound"
    );
    commit(
        s,
        Tx {
            tail_drop_above: Some(0),
            own_retained_drop_above: Some(0),
            ..Tx::default()
        },
    );
    // Zero is not a valid log position. Stores may reject it, but any accepted
    // row (including recovered/corrupt material) must obey the clear-all sentinel.
    if s.commit(Tx {
        tail_put: vec![tail_row(0, 12)],
        own_retained_put: vec![(0, pending_row(3, 72))],
        ..Tx::default()
    })
    .is_err()
    {
        assert_eq!(s.tail_stats().unwrap(), TailStats::default());
    } else {
        assert_eq!(s.tail_stats().unwrap().count, 1);
    }
    commit(
        s,
        Tx {
            tail_drop_above: Some(0),
            own_retained_drop_above: Some(0),
            ..Tx::default()
        },
    );
    assert_eq!(
        s.tail_stats().unwrap(),
        TailStats::default(),
        "Some(0) erases every accepted row"
    );
    assert!(s.tail(0, 10).unwrap().is_empty());
    assert!(s.own_retained(0, 10).unwrap().is_empty());
}

fn tail_survives_clear(s: &mut dyn Store) {
    commit(
        s,
        Tx {
            records_put: vec![record(1, "a.md", "a")],
            tail_put: vec![tail_row(1, 10)],
            own_retained_put: vec![(1, pending_row(1, 60))],
            ..Tx::default()
        },
    );
    commit(
        s,
        Tx {
            clear_confirmed: true,
            ..Tx::default()
        },
    );
    assert!(s.record(&id(1)).unwrap().is_none());
    assert_eq!(tail_seqs(s), vec![1], "tail is device-local");
    assert_eq!(s.own_retained(0, 10).unwrap().len(), 1);
}

fn own_retained_basics(s: &mut dyn Store) {
    assert!(s.own_retained(0, 10).unwrap().is_empty());
    commit(
        s,
        Tx {
            own_retained_put: (1..=6).map(|n| (n * 10, pending_row(n, 100 + n))).collect(),
            ..Tx::default()
        },
    );
    let seqs = |s: &dyn Store| -> Vec<u64> {
        s.own_retained(0, u32::MAX)
            .unwrap()
            .iter()
            .map(|(q, _)| *q)
            .collect()
    };
    assert_eq!(seqs(s), vec![10, 20, 30, 40, 50, 60], "seq order");
    let page = s.own_retained(20, 2).unwrap();
    assert_eq!(page.len(), 2);
    assert_eq!(page[0], (30, pending_row(3, 103)), "exact rows");
    commit(
        s,
        Tx {
            own_retained_drop_below: Some(25),
            own_retained_drop_above: Some(50),
            ..Tx::default()
        },
    );
    assert_eq!(seqs(s), vec![30, 40, 50]);
}

fn retained_prune_together(s: &mut dyn Store) {
    commit(
        s,
        Tx {
            tail_put: (1..=4).map(|n| tail_row(n, 10)).collect(),
            own_retained_put: vec![(1, pending_row(1, 81)), (3, pending_row(2, 82))],
            ..Tx::default()
        },
    );
    // Retention pruning drops both sets below the same floor, atomically.
    commit(
        s,
        Tx {
            tail_put: vec![tail_row(5, 10)],
            tail_drop_below: Some(3),
            own_retained_drop_below: Some(3),
            ..Tx::default()
        },
    );
    assert_eq!(tail_seqs(s), vec![3, 4, 5]);
    let own: Vec<u64> = s
        .own_retained(0, 10)
        .unwrap()
        .iter()
        .map(|(q, _)| *q)
        .collect();
    assert_eq!(own, vec![3]);
    // Install, reset or revocation erases both.
    commit(
        s,
        Tx {
            tail_drop_above: Some(0),
            own_retained_drop_above: Some(0),
            ..Tx::default()
        },
    );
    assert!(s.tail(0, 10).unwrap().is_empty());
    assert!(s.own_retained(0, 10).unwrap().is_empty());
}

fn own_retained_handover(s: &mut dyn Store) {
    commit(
        s,
        Tx {
            pending_put: vec![pending_row(1, 70), pending_row(2, 71)],
            ..Tx::default()
        },
    );
    // The confirm commit: pending row out, own-retained row in, one unit.
    let row = s.pending_get(&id(70)).unwrap().unwrap();
    commit(
        s,
        Tx {
            head: Some(Head {
                seq: 9,
                chain: hash(9),
            }),
            pending_del: vec![id(70)],
            own_retained_put: vec![(9, row.clone())],
            tail_put: vec![tail_row(9, 10)],
            ..Tx::default()
        },
    );
    assert!(s.pending_get(&id(70)).unwrap().is_none());
    assert_eq!(s.pending_count().unwrap(), 1);
    assert_eq!(s.own_retained(0, 10).unwrap(), vec![(9, row.clone())]);
    // Rollback: the row returns to pending with its original order.
    commit(
        s,
        Tx {
            own_retained_drop_above: Some(8),
            tail_drop_above: Some(8),
            pending_put: vec![row],
            ..Tx::default()
        },
    );
    assert!(s.own_retained(0, 10).unwrap().is_empty());
    assert_eq!(
        s.pending(None, 1).unwrap()[0].order,
        1,
        "original capture order"
    );
}

/// A deterministic test ID.
pub fn id(n: u64) -> Uuid {
    let mut b = [0u8; 16];
    b[8..].copy_from_slice(&n.to_be_bytes());
    B16(b)
}

fn hash(n: u8) -> Hash {
    B32([n; 32])
}

fn commit(s: &mut dyn Store, tx: Tx) {
    s.commit(tx).expect("commit");
}

/// A record row for tests: path key is the lower-cased path.
pub fn record(n: u64, path: &str, doc: &str) -> RecordRow {
    let i = id(n);
    RecordRow {
        id: i,
        path: path.to_string(),
        path_key: path.to_lowercase(),
        doc: doc.to_string(),
        revision: mdbn_wire::hash::sha256(doc.as_bytes()),
        modified_seq: n,
        bucket: bucket16(&i),
        meta: RecordMeta::default(),
    }
}

fn mutation(n: u64) -> Mutation {
    Mutation {
        id: id(n),
        origin: id(999),
        base_seq: 0,
        clock: OpClock {
            instant: 1_000,
            tz: "UTC".into(),
            local_date: "1970-01-01".into(),
        },
        seed: hash(1),
        source: Source::Api,
        ops: vec![Op::Delete(mdbn_wire::intent::Delete {
            id: id(n + 1000),
            base_revision: None,
            if_revision: None,
        })],
        on_behalf: None,
        conflict_mode: Some(ConflictMode::Record),
        validated_at: None,
        room: None,
    }
}

/// A pending row for conformance checks.
pub fn pending_row(order: u64, m: u64) -> PendingRow {
    PendingRow {
        order,
        mutation: mutation(m).into(),
        effects: Vec::new(),
        touches: vec![format!("i:{m}")],
        grant: None,
        uploads: Vec::new(),
        refs: Vec::new(),
    }
}

fn all() -> Page {
    Page {
        after: None,
        limit: u32::MAX,
    }
}

fn empty(s: &mut dyn Store) {
    assert_eq!(
        s.head().unwrap(),
        Head::GENESIS,
        "a new store is at genesis"
    );
    assert_eq!(s.record_count().unwrap(), 0);
    assert_eq!(s.pending_count().unwrap(), 0);
    assert!(s.settings().unwrap().is_none());
    assert!(s.resources().unwrap().is_empty());
    assert!(s.meta("x").unwrap().is_none());
    commit(s, Tx::default());
    assert_eq!(
        s.head().unwrap(),
        Head::GENESIS,
        "an empty tx changes nothing"
    );
}

fn records(s: &mut dyn Store) {
    let head = Head {
        seq: 3,
        chain: hash(3),
    };
    commit(
        s,
        Tx {
            head: Some(head),
            records_put: vec![record(1, "A.md", "a"), record(2, "b.md", "b")],
            ..Tx::default()
        },
    );
    assert_eq!(s.head().unwrap(), head);
    assert_eq!(s.record(&id(1)).unwrap().unwrap().doc, "a");
    assert_eq!(
        s.record_at("a.md").unwrap(),
        Some(id(1)),
        "lookup by path key"
    );
    assert_eq!(
        s.record_at("A.md").unwrap(),
        None,
        "path keys compare bytewise"
    );
    assert_eq!(s.record_count().unwrap(), 2);
    // Move 1 to c.md and 2 into a.md in one tx.
    commit(
        s,
        Tx {
            records_put: vec![record(1, "c.md", "a2"), record(2, "a.md", "b")],
            ..Tx::default()
        },
    );
    assert_eq!(s.record_at("c.md").unwrap(), Some(id(1)));
    assert_eq!(
        s.record_at("a.md").unwrap(),
        Some(id(2)),
        "a freed path is reusable in the same tx"
    );
    assert_eq!(
        s.record_at("b.md").unwrap(),
        None,
        "the old path is released"
    );
    commit(
        s,
        Tx {
            records_del: vec![id(1)],
            ..Tx::default()
        },
    );
    assert!(s.record(&id(1)).unwrap().is_none());
    assert_eq!(s.record_at("c.md").unwrap(), None);
    assert_eq!(s.record_count().unwrap(), 1);
}

fn record_pages(s: &mut dyn Store) {
    let rows: Vec<RecordRow> = (1..=50)
        .map(|n| record(n, &format!("r{n}.md"), "x"))
        .collect();
    commit(
        s,
        Tx {
            records_put: rows.clone(),
            ..Tx::default()
        },
    );
    let mut got = Vec::new();
    let mut after = None;
    loop {
        let page = s.records(Page { after, limit: 7 }).unwrap();
        if page.is_empty() {
            break;
        }
        assert!(page.len() <= 7, "pages respect the limit");
        after = Some(page.last().unwrap().id);
        got.extend(page.into_iter().map(|r| r.id));
    }
    let mut want: Vec<Uuid> = rows.iter().map(|r| r.id).collect();
    want.sort();
    assert_eq!(got, want, "records() pages in ID order");
    // Buckets: the two halves of the bucket space partition the records.
    let lo = s.records_in_buckets(0..32768, all()).unwrap();
    let hi = s.records_in_buckets(32768..65536, all()).unwrap();
    assert_eq!(lo.len() + hi.len(), 50);
    assert!(lo.iter().all(|r| r.bucket < 32768));
    assert!(hi.iter().all(|r| r.bucket >= 32768));
    assert!(
        lo.windows(2).all(|w| w[0].id < w[1].id),
        "bucket scans are in ID order"
    );
}

fn indexes(s: &mut dyn Store) {
    let mut r = record(1, "a.md", "a");
    r.meta.links = vec!["k:b".into(), "k:c".into()];
    r.meta.unique = vec![("email".into(), "s:x@y".into())];
    let mut r2 = record(2, "b.md", "b");
    r2.meta.links = vec!["k:c".into()];
    commit(
        s,
        Tx {
            records_put: vec![r.clone(), r2],
            ..Tx::default()
        },
    );
    assert_eq!(s.referrers(&["k:c".into()]).unwrap(), vec![id(1), id(2)]);
    assert_eq!(
        s.referrers(&["k:b".into(), "k:c".into()]).unwrap(),
        vec![id(1), id(2)],
        "deduplicated"
    );
    assert_eq!(s.unique_holders("email", "s:x@y").unwrap(), vec![id(1)]);
    // Re-putting without the link drops it from the index.
    r.meta.links = vec!["k:b".into()];
    r.meta.unique = vec![];
    commit(
        s,
        Tx {
            records_put: vec![r],
            ..Tx::default()
        },
    );
    assert_eq!(s.referrers(&["k:c".into()]).unwrap(), vec![id(2)]);
    assert!(s.unique_holders("email", "s:x@y").unwrap().is_empty());
    commit(
        s,
        Tx {
            records_del: vec![id(1)],
            ..Tx::default()
        },
    );
    assert!(
        s.referrers(&["k:b".into()]).unwrap().is_empty(),
        "removal drops index entries"
    );
}

fn candidates(s: &mut dyn Store) {
    let mut rows = Vec::new();
    for n in 1..=20u64 {
        let mut r = record(
            n,
            &format!("{}/{n}.md", if n % 2 == 0 { "even" } else { "odd" }),
            "x",
        );
        r.meta.types = vec![if n % 3 == 0 {
            "task".into()
        } else {
            "note".into()
        }];
        r.meta.effective = DataMap(vec![(
            "n".into(),
            Value::Int(i64::try_from(n % 4).unwrap()),
        )]);
        r.meta.tags = if n % 5 == 0 {
            vec!["five".into()]
        } else {
            vec![]
        };
        rows.push(r);
    }
    commit(
        s,
        Tx {
            records_put: rows.clone(),
            ..Tx::default()
        },
    );
    let cases = vec![
        Candidate::All,
        Candidate::None,
        Candidate::HasType("task".into()),
        Candidate::InFolder("even".into()),
        eq_n(1),
        Candidate::Not(Box::new(Candidate::HasType("task".into()))),
        Candidate::And(vec![
            Candidate::HasType("note".into()),
            Candidate::InFolder("odd".into()),
        ]),
        Candidate::Or(vec![eq_n(0), Candidate::HasType("task".into())]),
    ];
    for c in cases {
        let got = s.candidates(&c, all()).unwrap();
        assert!(got.windows(2).all(|w| w[0].id < w[1].id), "{c:?}: ID order");
        for r in &rows {
            if crate::mem::candidate_matches(&c, r) {
                assert!(
                    got.iter().any(|g| g.id == r.id),
                    "{c:?}: missing {:?} (must be a superset)",
                    r.id
                );
            }
        }
        // Paging composes.
        if let Some(first) = got.first() {
            let rest = s
                .candidates(
                    &c,
                    Page {
                        after: Some(first.id),
                        limit: u32::MAX,
                    },
                )
                .unwrap();
            assert_eq!(rest.len(), got.len() - 1, "{c:?}: paging");
        }
    }
}

fn eq_n(n: i64) -> Candidate {
    use mdbn_core::query::{CompareOp, FieldRef, Pruning};
    Candidate::Compare {
        field: FieldRef::Persisted(vec!["n".into()]),
        op: CompareOp::Eq,
        value: mdbn_core::value::Value::Int(n),
        pruning: Pruning::Exact,
    }
}

fn blob(n: u8, size: u64) -> BlobRef {
    BlobRef {
        plain_hash: hash(n),
        size,
        blob_id: hash(n + 100),
        id_epoch: 1,
        part_size: 8 << 20,
    }
}

fn files(s: &mut dyn Store) {
    let f = FileRow {
        kind: mdbn_wire::unindexed_markdown::FileKindV1::Ordinary,
        id: id(7),
        path: "img/a.png".into(),
        path_key: "img/a.png".into(),
        content: mdbn_wire::attachment::FileContent::Blob(blob(1, 10)),
        media: MediaClass::Image,
        modified_seq: 1,
        bucket: bucket16(&id(7)),
        local: FileLocal::Remote,
    };
    commit(
        s,
        Tx {
            files_put: vec![f.clone()],
            ..Tx::default()
        },
    );
    assert_eq!(s.file(&id(7)).unwrap(), Some(f.clone()));
    assert_eq!(s.file_at("img/a.png").unwrap(), Some(id(7)));
    assert_eq!(s.files(all()).unwrap().len(), 1);
    assert_eq!(s.files_in_buckets(0..65536, all()).unwrap().len(), 1);
    assert_eq!(
        s.record_at("img/a.png").unwrap(),
        None,
        "files and records are separate namespaces in the store"
    );
    commit(
        s,
        Tx {
            files_del: vec![id(7)],
            ..Tx::default()
        },
    );
    assert_eq!(s.file_at("img/a.png").unwrap(), None);
}

fn resources(s: &mut dyn Store) {
    commit(
        s,
        Tx {
            resources_put: vec![
                ("mdbase.yaml".into(), "a: 1\n".into()),
                ("_types/t.md".into(), "x".into()),
            ],
            settings: Some(FileInclusion {
                include: vec![MediaClass::Image],
                exclude: None,
                max_size: Some(5),
            }),
            ..Tx::default()
        },
    );
    assert_eq!(
        s.resource("mdbase.yaml").unwrap().as_deref(),
        Some("a: 1\n")
    );
    let rs = s.resources().unwrap();
    assert_eq!(rs[0].0, "_types/t.md", "resources by path, bytewise");
    assert_eq!(s.settings().unwrap().unwrap().max_size, Some(5));
    commit(
        s,
        Tx {
            resources_del: vec!["_types/t.md".into()],
            ..Tx::default()
        },
    );
    assert_eq!(s.resources().unwrap().len(), 1);
}

fn tomb(n: u64, path: &str, seq: u64, time: i64) -> TombstoneRow {
    TombstoneRow {
        id: id(n),
        kind: EntityKind::Record,
        path: path.into(),
        path_key: path.to_lowercase(),
        last: TombstoneLast::Doc("gone".into()),
        seq,
        time,
    }
}

fn tombstones(s: &mut dyn Store) {
    commit(
        s,
        Tx {
            tombstones_put: vec![
                tomb(1, "a.md", 10, 100),
                tomb(2, "a.md", 20, 200),
                tomb(3, "b.md", 30, 50),
            ],
            ..Tx::default()
        },
    );
    assert_eq!(s.tombstone(&id(1)).unwrap().unwrap().seq, 10);
    assert_eq!(s.tombstones_at("a.md").unwrap().len(), 2);
    // Prune: seq < 25 AND time < 150 -> only 1 goes (2 is too recent in time, 3 in seq).
    commit(
        s,
        Tx {
            prune: Some(Prune {
                seq_floor: 25,
                time_floor: 150,
            }),
            ..Tx::default()
        },
    );
    assert!(
        s.tombstone(&id(1)).unwrap().is_none(),
        "pruned: below both floors"
    );
    assert!(
        s.tombstone(&id(2)).unwrap().is_some(),
        "kept: newer than the time floor"
    );
    assert!(
        s.tombstone(&id(3)).unwrap().is_some(),
        "kept: above the seq floor"
    );
    assert_eq!(s.tombstones_at("a.md").unwrap().len(), 1);
    commit(
        s,
        Tx {
            tombstones_del: vec![id(2)],
            ..Tx::default()
        },
    );
    assert_eq!(s.tombstones(all()).unwrap().len(), 1);
}

fn conflict(m: u64, rec: u64) -> ConflictRow {
    ConflictRow {
        mutation: id(m),
        seq: m,
        conflict: Conflict {
            kind: ConflictKind::Field,
            id: id(rec),
            field: Some("status".into()),
            base: None,
            kept: ConflictValue::Missing,
            lost: ConflictValue::Deleted,
        }
        .into(),
    }
}

fn aliases_conflicts(s: &mut dyn Store) {
    commit(
        s,
        Tx {
            aliases_put: vec![
                AliasRow {
                    path: "Old.md".into(),
                    path_key: "old.md".into(),
                    record: id(1),
                },
                AliasRow {
                    path: "b.md".into(),
                    path_key: "b.md".into(),
                    record: id(2),
                },
            ],
            conflicts_put: vec![conflict(10, 1), conflict(11, 1), conflict(12, 2)],
            ..Tx::default()
        },
    );
    assert_eq!(s.alias("old.md").unwrap(), Some(id(1)));
    commit(
        s,
        Tx {
            aliases_put: vec![AliasRow {
                path: "OLD.md".into(),
                path_key: "old.md".into(),
                record: id(3),
            }],
            conflicts_del: vec![(id(10), id(1))],
            ..Tx::default()
        },
    );
    assert_eq!(
        s.alias("old.md").unwrap(),
        Some(id(3)),
        "a later alias replaces"
    );
    assert_eq!(s.aliases().unwrap().len(), 2);
    assert_eq!(s.conflict_count().unwrap(), 2);
    assert_eq!(s.conflicts(Some(&id(1))).unwrap().len(), 1);
    assert_eq!(
        s.conflicts(None).unwrap()[0].mutation,
        id(11),
        "ordered by (mutation, id)"
    );
}

fn receipts(s: &mut dyn Store) {
    let rows: Vec<ReceiptRow> = (1..=5)
        .map(|n| ReceiptRow {
            mutation: id(n),
            seq: n * 10,
            time: i64::try_from(n).unwrap() * 100,
        })
        .collect();
    commit(
        s,
        Tx {
            receipts_put: rows,
            ..Tx::default()
        },
    );
    assert_eq!(s.receipt(&id(3)).unwrap().unwrap().seq, 30);
    assert_eq!(
        s.receipts(Some(id(2)), 2)
            .unwrap()
            .iter()
            .map(|r| r.mutation)
            .collect::<Vec<_>>(),
        vec![id(3), id(4)]
    );
    commit(
        s,
        Tx {
            prune: Some(Prune {
                seq_floor: 35,
                time_floor: 250,
            }),
            ..Tx::default()
        },
    );
    assert!(s.receipt(&id(2)).unwrap().is_none());
    assert!(
        s.receipt(&id(3)).unwrap().is_some(),
        "time 300 is above the floor"
    );
    assert_eq!(s.receipts(None, 100).unwrap().len(), 3);
}

fn pending(s: &mut dyn Store) {
    commit(
        s,
        Tx {
            pending_put: vec![pending_row(3, 30), pending_row(1, 10), pending_row(2, 20)],
            ..Tx::default()
        },
    );
    let orders: Vec<u64> = s
        .pending(None, 10)
        .unwrap()
        .iter()
        .map(|p| p.order)
        .collect();
    assert_eq!(orders, vec![1, 2, 3], "capture order");
    assert_eq!(
        s.pending(Some(1), 1).unwrap()[0].order,
        2,
        "paging after an order"
    );
    assert_eq!(s.pending_get(&id(20)).unwrap().unwrap().order, 2);
    // Replace a row (rebase updates effects) by order.
    let mut r = pending_row(2, 20);
    r.touches = vec!["i:new".into()];
    commit(
        s,
        Tx {
            pending_put: vec![r],
            pending_del: vec![id(10)],
            ..Tx::default()
        },
    );
    assert_eq!(s.pending_count().unwrap(), 2);
    assert_eq!(
        s.pending_get(&id(20)).unwrap().unwrap().touches,
        vec!["i:new".to_string()]
    );
    assert!(s.pending_get(&id(10)).unwrap().is_none());
}

fn pending_many(s: &mut dyn Store) {
    let rows: Vec<PendingRow> = (1..=10_000).map(|n| pending_row(n, n)).collect();
    commit(
        s,
        Tx {
            pending_put: rows,
            ..Tx::default()
        },
    );
    for n in (1..=10_000).step_by(997) {
        commit(
            s,
            Tx {
                pending_del: vec![id(n)],
                pending_put: vec![pending_row(10_000 + n, 20_000 + n)],
                ..Tx::default()
            },
        );
    }
    assert_eq!(s.pending_count().unwrap(), 10_000);
    assert_eq!(s.pending(None, 1).unwrap()[0].order, 2);
    assert_eq!(s.pending_get(&id(20_001)).unwrap().unwrap().order, 10_001);
}

fn clear_confirmed(s: &mut dyn Store) {
    commit(
        s,
        Tx {
            records_put: vec![record(1, "a.md", "a")],
            receipts_put: vec![ReceiptRow {
                mutation: id(1),
                seq: 1,
                time: 1,
            }],
            pending_put: vec![pending_row(1, 50)],
            meta: vec![("k".into(), Some(vec![1]))],
            ..Tx::default()
        },
    );
    commit(
        s,
        Tx {
            clear_confirmed: true,
            records_put: vec![record(2, "b.md", "b")],
            ..Tx::default()
        },
    );
    assert!(
        s.record(&id(1)).unwrap().is_none(),
        "confirmed state dropped"
    );
    assert!(s.record_at("a.md").unwrap().is_none());
    assert!(
        s.record(&id(2)).unwrap().is_some(),
        "puts after the clear apply"
    );
    assert!(s.receipt(&id(1)).unwrap().is_none());
    assert_eq!(s.pending_count().unwrap(), 1, "pending kept");
    assert_eq!(s.meta("k").unwrap(), Some(vec![1]), "meta kept");
}

/// Snapshot-install staging (`Tx::stage`, `snapshot.md` §8), for stores whose
/// [`Store::stages`] is true: staged confirmed rows are invisible, the rest of a
/// staging transaction applies, a swap replaces ALL confirmed state (records,
/// files, resources, settings, tombstones, aliases, conflicts, receipts) and
/// empties the staging area, and a discard empties it. Local state (pending,
/// meta) is never touched by either.
fn staging(s: &mut dyn Store) {
    use crate::store::Stage;
    if !s.stages() {
        return;
    }
    let file = |n: u64, path: &str| FileRow {
        kind: mdbn_wire::unindexed_markdown::FileKindV1::Ordinary,
        id: id(n),
        path: path.into(),
        path_key: path.into(),
        content: mdbn_wire::attachment::FileContent::Blob(blob(n as u8, 10)),
        media: MediaClass::Image,
        modified_seq: 1,
        bucket: bucket16(&id(n)),
        local: FileLocal::Remote,
    };
    commit(
        s,
        Tx {
            records_put: vec![record(1, "old.md", "old")],
            files_put: vec![file(2, "old.png")],
            resources_put: vec![("mdbase.yaml".into(), "v: 1".into())],
            tombstones_put: vec![tomb(3, "gone.md", 1, 1)],
            receipts_put: vec![ReceiptRow {
                mutation: id(4),
                seq: 1,
                time: 1,
            }],
            pending_put: vec![pending_row(5, 50)],
            ..Tx::default()
        },
    );
    // Two staged chunks; their meta applies at once, their rows do not.
    commit(
        s,
        Tx {
            stage: Stage::Put,
            records_put: vec![record(11, "a.md", "a")],
            resources_put: vec![("mdbase.yaml".into(), "v: 2".into())],
            meta: vec![("install".into(), Some(vec![1]))],
            ..Tx::default()
        },
    );
    commit(
        s,
        Tx {
            stage: Stage::Put,
            records_put: vec![record(12, "b.md", "b")],
            files_put: vec![file(13, "new.png")],
            tombstones_put: vec![tomb(14, "was.md", 2, 2)],
            receipts_put: vec![ReceiptRow {
                mutation: id(15),
                seq: 2,
                time: 2,
            }],
            ..Tx::default()
        },
    );
    assert!(
        s.record(&id(11)).unwrap().is_none(),
        "staged rows invisible"
    );
    assert!(s.record(&id(1)).unwrap().is_some());
    assert_eq!(s.resource("mdbase.yaml").unwrap().as_deref(), Some("v: 1"));
    assert_eq!(s.meta("install").unwrap(), Some(vec![1]));
    // Swap: confirmed state is exactly the staged state; the rest applies.
    commit(
        s,
        Tx {
            stage: Stage::Swap,
            head: Some(Head {
                seq: 9,
                chain: mdbn_wire::common::B32([9; 32]),
            }),
            meta: vec![("install".into(), None)],
            ..Tx::default()
        },
    );
    let paths: Vec<String> = s
        .records(all())
        .unwrap()
        .into_iter()
        .map(|r| r.path)
        .collect();
    assert_eq!(paths, vec!["a.md", "b.md"]);
    assert_eq!(s.record_at("b.md").unwrap(), Some(id(12)));
    assert!(s.record_at("old.md").unwrap().is_none());
    assert!(s.file(&id(2)).unwrap().is_none());
    assert_eq!(s.file_at("new.png").unwrap(), Some(id(13)));
    assert_eq!(s.resource("mdbase.yaml").unwrap().as_deref(), Some("v: 2"));
    assert!(s.tombstone(&id(3)).unwrap().is_none());
    assert!(s.tombstone(&id(14)).unwrap().is_some());
    assert!(s.receipt(&id(4)).unwrap().is_none());
    assert!(s.receipt(&id(15)).unwrap().is_some());
    assert_eq!(s.head().unwrap().seq, 9);
    assert_eq!(s.meta("install").unwrap(), None);
    assert_eq!(s.pending_count().unwrap(), 1, "pending kept");
    // The swap emptied the staging area: staging again starts from nothing.
    commit(
        s,
        Tx {
            stage: Stage::Put,
            records_put: vec![record(21, "c.md", "c")],
            ..Tx::default()
        },
    );
    commit(
        s,
        Tx {
            stage: Stage::Discard,
            ..Tx::default()
        },
    );
    commit(
        s,
        Tx {
            stage: Stage::Swap,
            ..Tx::default()
        },
    );
    assert_eq!(
        s.records(all()).unwrap().len(),
        0,
        "discarded, then empty swap"
    );
    assert!(s.record(&id(21)).unwrap().is_none());
    assert_eq!(s.pending_count().unwrap(), 1, "pending kept");
}

fn local_state(s: &mut dyn Store) {
    let lr = LocalReceipt {
        mutation: id(1),
        state: ReceiptState::Rejected,
        seq: None,
        status: None,
        conflicts: vec![],
        problem: Some(crate::api::ErrorCode::Conflict.problem("x")),
        resolved_at: 100,
        grant: None,
    };
    let hold = Hold {
        id: id(2),
        path: "a.md".into(),
        reason: HoldReason::Conflict,
        since: 5,
        base: None,
        mine: TextOrBlob::Text("mine".into()),
        theirs: Some(TextOrBlob::Text("theirs".into())),
        saves: 1,
    };
    commit(
        s,
        Tx {
            local_receipts_put: vec![lr.clone()],
            holds_put: vec![hold.clone()],
            meta: vec![("a".into(), Some(vec![1, 2])), ("b".into(), Some(vec![]))],
            ..Tx::default()
        },
    );
    assert_eq!(s.local_receipt(&id(1)).unwrap(), Some(lr));
    assert_eq!(s.hold(&id(2)).unwrap(), Some(hold));
    assert_eq!(s.holds().unwrap().len(), 1);
    assert_eq!(
        s.meta("b").unwrap(),
        Some(vec![]),
        "empty values are values"
    );
    commit(
        s,
        Tx {
            local_receipts_prune: Some(101),
            holds_del: vec![id(2)],
            meta: vec![("a".into(), None)],
            ..Tx::default()
        },
    );
    assert!(s.local_receipt(&id(1)).unwrap().is_none());
    assert!(s.holds().unwrap().is_empty());
    assert!(s.meta("a").unwrap().is_none());
}

fn transfers_blobs(s: &mut dyn Store) {
    let t = TransferRow {
        id: id(1),
        path: "a.bin".into(),
        size: 3,
        digest: None,
        file: None,
        if_revision: None,
        mutation: None,
        chunk_size: 1 << 20,
        received: [0u64].into_iter().collect(),
        expires_at: 10,
        grant: None,
    };
    commit(
        s,
        Tx {
            transfers_put: vec![t.clone()],
            transfer_chunks: vec![(id(1), 0, vec![1, 2, 3])],
            blob_parts: vec![(hash(9), 0, vec![1, 2]), (hash(9), 2, vec![3, 4])],
            ..Tx::default()
        },
    );
    assert_eq!(s.transfer(&id(1)).unwrap(), Some(t));
    assert_eq!(s.transfer_chunk(&id(1), 0).unwrap(), Some(vec![1, 2, 3]));
    assert_eq!(s.blob_size(&hash(9)).unwrap(), Some(4));
    assert_eq!(s.blob_read(&hash(9), 1, 2).unwrap(), vec![2, 3]);
    commit(
        s,
        Tx {
            transfers_del: vec![id(1)],
            blobs_del: vec![hash(9)],
            ..Tx::default()
        },
    );
    assert!(s.transfer(&id(1)).unwrap().is_none());
    assert!(
        s.transfer_chunk(&id(1), 0).unwrap().is_none(),
        "chunks go with the transfer"
    );
    assert!(s.blob_size(&hash(9)).unwrap().is_none());
}
