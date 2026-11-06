//! Record capture time (`replica-client-api.md` §3.1): the mutation clock of the
//! last byte change, identical on every replica and across a snapshot install.

use mdbn_wire::client::{Include, ReceiptState, SubmitParams};
use mdbn_wire::common::{B16, Text};
use mdbn_wire::intent::{DocVersion, Document, Op};

use super::engine::{Node, node, settle};
use crate::Store;
use crate::api::{ClientApi, Target};
use crate::fake::FakeLogService;
use crate::mem::MemStore;

const ID: u8 = 21;

fn submit(a: &mut Node, op: Op) {
    a.clock.set(a.clock.get() + 60_000);
    let receipts =
        a.r.submit(
            a.s,
            SubmitParams {
                ops: vec![op],
                mutation_id: None,
                conflict_mode: None,
                timezone: None,
                allow_partial: None,
                mutation_ids: None,
                dry_run: None,
                include: None,
                wait: None,
            },
        )
        .expect("submit");
    assert_eq!(
        receipts[0].state,
        ReceiptState::Pending,
        "{:?}",
        receipts[0]
    );
}

fn put(a: &mut Node, path: &str, doc: &str) {
    let base = stored(a).map(|r| DocVersion {
        path: r.path,
        doc: Text::Inline(r.doc),
    });
    submit(
        a,
        Op::Document(Document {
            id: B16([ID; 16]),
            base,
            new: Some(DocVersion {
                path: path.into(),
                doc: Text::Inline(doc.into()),
            }),
            if_revision: None,
        }),
    );
}

fn stored(a: &Node) -> Option<crate::store::RecordRow> {
    a.r.store().record(&B16([ID; 16])).unwrap()
}

fn time(a: &Node) -> Option<i64> {
    stored(a).unwrap().mtime
}

fn view_time(a: &mut Node) -> Option<i64> {
    let s = a.s;
    let include = Include {
        effective: None,
        body: None,
        document: None,
        diagnostics: None,
    };
    a.r.get(s, Target::Id(B16([ID; 16])), include)
        .unwrap()
        .mtime
}

#[test]
fn every_replica_stamps_the_writers_clock_and_only_byte_changes_move_it() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);

    a.clock.set(a.clock.get() + 60_000);
    let created = a.clock.get() as i64;
    a.create(ID, "a.md", "one");
    settle(&mut [&mut a, &mut b]);
    assert_eq!(time(&a), Some(created));
    assert_eq!(time(&b), Some(created), "the signed clock, not B's");
    assert_eq!(view_time(&mut a), Some(created));

    put(&mut a, "b.md", "one");
    settle(&mut [&mut a, &mut b]);
    assert_eq!(stored(&a).unwrap().path, "b.md");
    assert_eq!(time(&a), Some(created), "a move keeps the time");
    assert_eq!(time(&b), Some(created));

    put(&mut a, "b.md", "two");
    let edited = a.clock.get() as i64;
    assert_eq!(view_time(&mut a), Some(created), "pending shows confirmed");
    settle(&mut [&mut a, &mut b]);
    assert_eq!(time(&a), Some(edited));
    assert_eq!(time(&b), Some(edited));
    assert_eq!(view_time(&mut a), Some(edited));

    put(&mut a, "b.md", "two");
    settle(&mut [&mut a, &mut b]);
    assert_eq!(time(&a), Some(edited), "identical bytes keep the time");
}

#[test]
fn snapshot_install_keeps_the_time_a_tail_entry_then_moves_it() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    a.create(ID, "a.md", "one");
    settle(&mut [&mut a]);
    let created = time(&a);
    assert!(created.is_some());
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a]);
    svc.compact(&super::engine::COL, a.r.head().seq);

    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.r.stats.snapshots_installed, 1);
    assert_eq!(time(&b), created);

    put(&mut a, "a.md", "two");
    settle(&mut [&mut a, &mut b]);
    assert_ne!(time(&a), created);
    assert_eq!(time(&b), time(&a));
}
