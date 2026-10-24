//! Adversarial legacy source open/page settlement over real SQLite: oversized,
//! replayed, reordered, foreign, closed-session and lost-acknowledgement pages
//! never settle, never write page metadata and never advance the Driver.
use super::provider_tests::{COLLECTION, drain, drain_of, fenced, next, settled_count};
use super::tests::{Sqlite, TestEntropy, binding};
use super::*;
use mdbn_migrate_portable::budget::{MAX_SOURCE_PAGE_BYTES, MAX_SOURCE_PAGE_ROWS};
use mdbn_migrate_portable::hosted_import::{Generation, Table};
use mdbn_wire::cbor::{Cbor, encode};

const HOLD: [u8; 16] = [0x44; 16];
const SESSION: [u8; 16] = [0x61; 16];
const HEAD: u64 = 42;

fn b(v: [u8; 16]) -> Cbor {
    Cbor::Bytes(v.to_vec())
}
fn t(v: &str) -> Cbor {
    Cbor::Text(v.into())
}
fn opt(v: Option<&str>) -> Cbor {
    v.map_or(Cbor::Null, t)
}
fn opened(
    collection: [u8; 16],
    state: &str,
    head: u64,
    session: [u8; 16],
    hold: [u8; 16],
) -> Vec<u8> {
    encode(&Cbor::Array(vec![
        Cbor::Uint(0),
        b(collection),
        t(state),
        Cbor::Uint(head),
        b(session),
        b(hold),
    ]))
    .unwrap()
}
#[derive(Clone)]
struct Row {
    id: Option<[u8; 16]>,
    path: String,
}
fn record(n: u8, path: &str) -> Row {
    Row {
        id: Some(id(n)),
        path: path.into(),
    }
}
fn resource(path: &str) -> Row {
    Row {
        id: None,
        path: path.into(),
    }
}
fn id(n: u8) -> [u8; 16] {
    let mut v = [0x10; 16];
    v[15] = n;
    v
}
fn key(n: u8) -> String {
    B16(id(n)).to_uuid_string()
}
/// A portable directory path of `len` bytes (segments of at most 200 bytes).
fn long_dir(len: usize) -> String {
    let mut out = String::new();
    while out.len() < len {
        if !out.is_empty() {
            out.push('/');
        }
        let take = (len - out.len()).min(200);
        out.push_str(&"d".repeat(take));
    }
    out
}
#[derive(Clone)]
struct Page {
    collection: [u8; 16],
    head: u64,
    session: [u8; 16],
    table: &'static str,
    after: Option<String>,
    rows: Vec<Row>,
    next: Option<String>,
}
fn page(table: &'static str, after: Option<String>, rows: Vec<Row>, next: Option<String>) -> Page {
    Page {
        collection: COLLECTION,
        head: HEAD,
        session: SESSION,
        table,
        after,
        rows,
        next,
    }
}
fn body(p: &Page) -> Vec<u8> {
    let rows = p
        .rows
        .iter()
        .map(|r| {
            Cbor::Array(vec![
                r.id.map_or(Cbor::Null, b),
                t(&r.path),
                Cbor::Bytes(vec![7; 32]),
                Cbor::Uint(r.path.len() as u64),
            ])
        })
        .collect();
    encode(&Cbor::Array(vec![
        Cbor::Uint(1),
        b(p.collection),
        Cbor::Uint(p.head),
        b(p.session),
        t(p.table),
        opt(p.after.as_deref()),
        Cbor::Array(rows),
        opt(p.next.as_deref()),
    ]))
    .unwrap()
}
fn placements(a: &mut JournalDriver<Sqlite>) -> i64 {
    a.spill
        .index_mut()
        .db
        .query_row("SELECT count(*) FROM mig_place WHERE g=0", [], |r| r.get(0))
        .unwrap()
}
/// A refused result leaves the pending outstanding, page metadata unwritten
/// and the checkpoint unchanged.
fn refused(a: &mut JournalDriver<Sqlite>, ticket: &PreparedAction, input: &[u8], e: LedgerError) {
    let settled = settled_count(a);
    let placed = placements(a);
    let checkpoint = a.spill.load().unwrap();
    assert_eq!(a.settle_source(ticket, input), Err(e));
    a.assert_prepared(ticket).unwrap();
    assert_eq!(a.saved_pending().unwrap().as_ref(), Some(ticket.data()));
    assert_eq!(settled_count(a), settled);
    assert_eq!(placements(a), placed);
    assert_eq!(a.spill.load().unwrap(), checkpoint);
}
/// Fence-first through drained `S_final` = 42; the S0 open is pending.
fn opening() -> (JournalDriver<Sqlite>, PreparedAction) {
    let mut a = fenced();
    let (d, _) = next(&mut a, 60);
    a.settle_provider(&d, &drain(&drain_of(HEAD, 0))).unwrap();
    let (o, action) = next(&mut a, 64);
    assert_eq!(
        action,
        Action::OpenSource {
            generation: Generation::S0,
            expect_head: Some(HEAD),
        }
    );
    (a, o)
}
/// The S0 read is open on SESSION; the resources page is pending.
fn reading() -> (JournalDriver<Sqlite>, PreparedAction) {
    let (mut a, o) = opening();
    let r = a
        .settle_source(&o, &opened(COLLECTION, "migrating", HEAD, SESSION, HOLD))
        .unwrap();
    a.assert_settled(&o, r).unwrap();
    let (p, action) = next(&mut a, 70);
    assert_eq!(
        action,
        Action::ReadPage {
            generation: Generation::S0,
            table: Table::Resources,
            cursor: None,
            max_rows: MAX_SOURCE_PAGE_ROWS,
            max_bytes: MAX_SOURCE_PAGE_BYTES,
        }
    );
    (a, p)
}
fn settle(a: &mut JournalDriver<Sqlite>, ticket: &PreparedAction, p: &Page) {
    let r = a.settle_source(ticket, &body(p)).unwrap();
    a.assert_settled(ticket, r).unwrap();
}

#[test]
fn fence_first_read_settles_open_and_pages_with_their_metadata() {
    let (mut a, p) = reading();
    settle(
        &mut a,
        &p,
        &page("resources", None, vec![resource("mdbase.yaml")], None),
    );
    let (p, action) = next(&mut a, 71);
    assert!(matches!(
        action,
        Action::ReadPage {
            table: Table::Records,
            cursor: None,
            ..
        }
    ));
    let first = vec![record(1, "notes/a.md"), record(2, "notes/b.md")];
    settle(&mut a, &p, &page("records", None, first, Some(key(2))));
    // Metadata committed together with the page's settlement.
    assert_eq!(placements(&mut a), 3);
    let (p, action) = next(&mut a, 72);
    assert_eq!(
        action,
        Action::ReadPage {
            generation: Generation::S0,
            table: Table::Records,
            cursor: Some(key(2)),
            max_rows: 64,
            max_bytes: 48 * 1024,
        }
    );
    settle(
        &mut a,
        &p,
        &page("records", Some(key(2)), vec![record(3, "c.md")], None),
    );
    let (p, _) = next(&mut a, 73);
    settle(
        &mut a,
        &p,
        &page("files", None, vec![record(9, "img.png")], None),
    );
    assert_eq!(placements(&mut a), 5);
    // The deferred pass and the read's finish are synchronous polls, not actions.
    let mut entropy = 80;
    let action = loop {
        match a.prepare(&mut TestEntropy(entropy)) {
            Err(LedgerError::Unsupported) => entropy += 1,
            other => break other.unwrap().1,
        }
        assert!(entropy < 90);
    };
    assert!(matches!(
        action,
        Action::ImportGen0 {
            bucket: None,
            after: None,
            ..
        }
    ));
}

#[test]
fn generic_settlement_refuses_source_results() {
    let (mut a, o) = opening();
    assert_eq!(
        a.settle(&o, Outcome::Opened { head: HEAD }),
        Err(LedgerError::Unsupported)
    );
    a.assert_prepared(&o).unwrap();
    a.settle_source(&o, &opened(COLLECTION, "migrating", HEAD, SESSION, HOLD))
        .unwrap();
    let (p, _) = next(&mut a, 70);
    let rows = Outcome::Page {
        rows: vec![],
        next: None,
    };
    assert_eq!(a.settle(&p, rows), Err(LedgerError::Unsupported));
    a.assert_prepared(&p).unwrap();
    // And the provider adapter never accepts a source result, nor the reverse.
    assert_eq!(
        a.settle_provider(&p, &body(&page("resources", None, vec![], None))),
        Err(LedgerError::Invalid)
    );
    assert_eq!(
        a.settle_source(&p, &drain(&drain_of(HEAD, 0))),
        Err(LedgerError::Invalid)
    );
}

#[test]
fn open_refuses_foreign_collection_hold_head_state_and_wrong_kind() {
    let (mut a, o) = opening();
    for wrong in [
        opened([3; 16], "migrating", HEAD, SESSION, HOLD),
        // Not the hold this run settled: another backup's read.
        opened(COLLECTION, "migrating", HEAD, SESSION, [0x45; 16]),
        // Legacy moved while fenced, or the read was not taken fenced.
        opened(COLLECTION, "migrating", HEAD + 1, SESSION, HOLD),
        opened(COLLECTION, "active", HEAD, SESSION, HOLD),
        body(&page("resources", None, vec![], None)),
    ] {
        refused(&mut a, &o, &wrong, LedgerError::Conflict);
    }
    for malformed in [
        opened(COLLECTION, "migrated", HEAD, SESSION, HOLD),
        opened(COLLECTION, "migrating", HEAD, [0; 16], HOLD),
        opened(COLLECTION, "migrating", 1 << 53, SESSION, HOLD),
        vec![],
    ] {
        refused(&mut a, &o, &malformed, LedgerError::Invalid);
    }
    a.settle_source(&o, &opened(COLLECTION, "migrating", HEAD, SESSION, HOLD))
        .unwrap();
}

#[test]
fn oversized_pages_refuse_by_rows_or_bytes() {
    let (mut a, p) = reading();
    settle(
        &mut a,
        &p,
        &page("resources", None, vec![resource("mdbase.yaml")], None),
    );
    let (p, _) = next(&mut a, 71);
    // 65 rows: one over the row bound even though tiny.
    let rows: Vec<Row> = (1..=65).map(|n| record(n, &format!("r{n}.md"))).collect();
    let over = page("records", None, rows.clone(), Some(key(65)));
    refused(&mut a, &p, &body(&over), LedgerError::Invalid);
    // 64 rows whose whole mirror is one byte over 48 KiB.
    let fit = |pad: usize| -> Page {
        let rows = (1..=64)
            .map(|n| record(n, &format!("{}/{n:02}.md", long_dir(pad))))
            .collect();
        page("records", None, rows, Some(key(64)))
    };
    let mut pad = 1;
    while body(&fit(pad + 1)).len() <= MAX_SOURCE_PAGE_BYTES {
        pad += 1;
    }
    let mut bytes = fit(pad);
    let len = body(&bytes).len();
    assert!(len <= MAX_SOURCE_PAGE_BYTES && len > MAX_SOURCE_PAGE_BYTES - 64);
    let mut overflow = bytes.clone();
    overflow.rows[0]
        .path
        .push_str(&"x".repeat(MAX_SOURCE_PAGE_BYTES + 1 - len));
    assert_eq!(body(&overflow).len(), MAX_SOURCE_PAGE_BYTES + 1);
    refused(&mut a, &p, &body(&overflow), LedgerError::Invalid);
    // The largest page Connect's bounds admit settles with all its metadata in
    // the one atomic capture: 64 rows, a whole mirror at the 48 KiB bound.
    bytes.next = Some(key(64));
    settle(&mut a, &p, &bytes);
    assert_eq!(placements(&mut a), 65);
}

#[test]
fn out_of_order_replayed_and_malformed_pages_refuse() {
    let (mut a, p) = reading();
    settle(
        &mut a,
        &p,
        &page("resources", None, vec![resource("mdbase.yaml")], None),
    );
    let (p1, _) = next(&mut a, 71);
    let first = page(
        "records",
        None,
        vec![record(1, "a.md"), record(2, "b.md")],
        Some(key(2)),
    );
    let mut wrong_table = first.clone();
    wrong_table.table = "files";
    refused(&mut a, &p1, &body(&wrong_table), LedgerError::Conflict);
    // A page for a later cursor before the first page (skipped/reordered).
    let later = page("records", Some(key(2)), vec![record(3, "c.md")], None);
    refused(&mut a, &p1, &body(&later), LedgerError::Conflict);
    settle(&mut a, &p1, &first);
    // The settled ticket cannot settle again, even with the same page.
    assert_eq!(
        a.settle_source(&p1, &body(&first)),
        Err(LedgerError::Refused)
    );
    let (p2, _) = next(&mut a, 72);
    // Replaying the first page against the next request names the wrong cursor.
    refused(&mut a, &p2, &body(&first), LedgerError::Conflict);
    for malformed in [
        // Rows at or before the request cursor overlap the previous page.
        page("records", Some(key(2)), vec![record(2, "b.md")], None),
        page("records", Some(key(2)), vec![record(1, "a.md")], None),
        // Not ascending, or duplicated, inside the page.
        page(
            "records",
            Some(key(2)),
            vec![record(4, "d.md"), record(3, "c.md")],
            Some(key(3)),
        ),
        page(
            "records",
            Some(key(2)),
            vec![record(3, "c.md"), record(3, "d.md")],
            Some(key(3)),
        ),
        // `next` must be the last row; an empty page always ends the table.
        page(
            "records",
            Some(key(2)),
            vec![record(3, "c.md")],
            Some(key(4)),
        ),
        page("records", Some(key(2)), vec![], Some(key(2))),
        // A record row without an ID, or a resource row with one.
        page("records", Some(key(2)), vec![resource("c.md")], None),
        // A non-canonical cursor.
        page(
            "records",
            Some(key(2).replace('-', "")),
            vec![record(3, "c.md")],
            None,
        ),
    ] {
        refused(&mut a, &p2, &body(&malformed), LedgerError::Invalid);
    }
    settle(
        &mut a,
        &p2,
        &page("records", Some(key(2)), vec![record(3, "c.md")], None),
    );
    assert_eq!(placements(&mut a), 4);
}

#[test]
fn resource_pages_refuse_duplicates_and_the_cursor_row() {
    let (mut a, p) = reading();
    let first = page(
        "resources",
        None,
        vec![resource("mdbase.yaml")],
        Some("mdbase.yaml".into()),
    );
    settle(&mut a, &p, &first);
    let (p2, action) = next(&mut a, 71);
    assert!(matches!(
        action,
        Action::ReadPage {
            table: Table::Resources,
            ..
        }
    ));
    let after = Some("mdbase.yaml".to_string());
    for malformed in [
        page(
            "resources",
            after.clone(),
            vec![resource("mdbase.yaml")],
            None,
        ),
        page(
            "resources",
            after.clone(),
            vec![resource("a.base"), resource("a.base")],
            None,
        ),
        page(
            "resources",
            after.clone(),
            vec![record(1, "types/t.md")],
            None,
        ),
    ] {
        refused(&mut a, &p2, &body(&malformed), LedgerError::Invalid);
    }
    refused(&mut a, &p2, &body(&first), LedgerError::Conflict);
    settle(
        &mut a,
        &p2,
        &page("resources", after, vec![resource("types/task.md")], None),
    );
    // The resource window resolves on its last page, inside that capture.
    assert_eq!(placements(&mut a), 2);
}

#[test]
fn pages_from_a_foreign_source_or_run_refuse() {
    let (mut a, p) = reading();
    let good = page("resources", None, vec![resource("mdbase.yaml")], None);
    let mut foreign = vec![];
    for change in 0..3 {
        let mut x = good.clone();
        match change {
            0 => x.collection = [3; 16],
            1 => x.head = HEAD + 1,
            _ => x.session = [0x62; 16],
        }
        foreign.push(body(&x));
    }
    for wrong in foreign {
        refused(&mut a, &p, &wrong, LedgerError::Conflict);
    }
    // A new open is not a page result.
    refused(
        &mut a,
        &p,
        &opened(COLLECTION, "migrating", HEAD, SESSION, HOLD),
        LedgerError::Conflict,
    );
    settle(&mut a, &p, &good);
}

#[test]
fn lost_page_ack_restarts_the_read_and_closes_its_old_session() {
    let (mut a, p) = reading();
    settle(
        &mut a,
        &p,
        &page("resources", None, vec![resource("mdbase.yaml")], None),
    );
    let (p1, _) = next(&mut a, 71);
    let first = page("records", None, vec![record(1, "a.md")], Some(key(1)));
    a.test_lose_settlement();
    assert_eq!(
        a.settle_source(&p1, &body(&first)),
        Err(LedgerError::StorageUnknown)
    );
    // Poisoned: no output, no second settlement and no new action from it.
    assert_eq!(
        a.settle_source(&p1, &body(&first)),
        Err(LedgerError::Refused)
    );
    assert!(a.prepare(&mut TestEntropy(72)).is_err());
    let mut a = JournalDriver::resume(a.into_index(), binding(), &mut TestEntropy(90)).unwrap();
    // The page landed with its metadata, but the read's RAM died with the
    // instance: the read restarts from a fresh open and clears its tables.
    assert!(a.saved_pending().unwrap().is_none());
    assert_eq!(placements(&mut a), 2);
    let attempts = a.driver.checkpoint().attempts;
    let (o, action) = next(&mut a, 91);
    assert!(matches!(
        action,
        Action::OpenSource {
            expect_head: Some(HEAD),
            ..
        }
    ));
    assert_eq!(a.driver.checkpoint().attempts, attempts + 1);
    assert_eq!(placements(&mut a), 0);
    // The old session's next page is not an open.
    let stale = page("records", Some(key(1)), vec![record(2, "b.md")], None);
    refused(&mut a, &o, &body(&stale), LedgerError::Conflict);
    let renewed = [0x62; 16];
    a.settle_source(&o, &opened(COLLECTION, "migrating", HEAD, renewed, HOLD))
        .unwrap();
    let (p, _) = next(&mut a, 92);
    // The closed session's pages never settle the new read, even when their
    // table and cursor match its request.
    let old = page("resources", None, vec![resource("mdbase.yaml")], None);
    refused(&mut a, &p, &body(&old), LedgerError::Conflict);
    let mut fresh = old.clone();
    fresh.session = renewed;
    settle(&mut a, &p, &fresh);
    let (p1, _) = next(&mut a, 93);
    let mut first = first;
    refused(&mut a, &p1, &body(&first), LedgerError::Conflict);
    first.session = renewed;
    settle(&mut a, &p1, &first);
    assert_eq!(placements(&mut a), 2);
}

#[test]
fn a_page_after_the_read_finished_refuses() {
    let (mut a, p) = reading();
    let resources = page("resources", None, vec![resource("mdbase.yaml")], None);
    settle(&mut a, &p, &resources);
    let (p, _) = next(&mut a, 71);
    let records = page("records", None, vec![record(1, "a.md")], None);
    settle(&mut a, &p, &records);
    let (p, _) = next(&mut a, 72);
    let files = page("files", None, vec![record(9, "img.png")], None);
    settle(&mut a, &p, &files);
    let mut entropy = 80;
    let (gen0, _) = loop {
        match a.prepare(&mut TestEntropy(entropy)) {
            Err(LedgerError::Unsupported) => entropy += 1,
            other => break other.unwrap(),
        }
    };
    // The source is done: no page, replayed or new, settles the next action.
    for late in [
        body(&files),
        body(&page(
            "files",
            Some(key(9)),
            vec![record(10, "z.png")],
            None,
        )),
        opened(COLLECTION, "migrating", HEAD, SESSION, HOLD),
    ] {
        refused(&mut a, &gen0, &late, LedgerError::Conflict);
    }
}

#[test]
fn the_largest_admitted_page_of_deferred_rows_settles_in_one_capture() {
    let (mut a, p) = reading();
    settle(
        &mut a,
        &p,
        &page("resources", None, vec![resource("mdbase.yaml")], None),
    );
    let (p, _) = next(&mut a, 71);
    // Non-portable names wait for the deferred pass: each stages its original
    // and its target path, the most metadata a row can stage.
    let fit = |pad: usize| -> Page {
        let rows = (1..=64)
            .map(|n| record(n, &format!("{}/why{n:02}?.md", long_dir(pad))))
            .collect();
        page("records", None, rows, Some(key(64)))
    };
    let mut pad = 1;
    while body(&fit(pad + 1)).len() <= MAX_SOURCE_PAGE_BYTES {
        pad += 1;
    }
    let max = fit(pad);
    assert!(body(&max).len() > MAX_SOURCE_PAGE_BYTES - 64);
    settle(&mut a, &p, &max);
    let deferred: i64 = a
        .spill
        .index_mut()
        .db
        .query_row("SELECT count(*) FROM mig_deferred WHERE g=0", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(deferred, 64);
}
