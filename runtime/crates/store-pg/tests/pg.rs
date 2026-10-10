//! `PgStore` against real Postgres (no in-memory substitute). Set `MDBN_TEST_PG_URL`, e.g.
//! `host=127.0.0.1 port=55481 user=mdbn password=mdbn dbname=mdbn`. Without it the
//! tests print a notice and pass (CI sets it; see `.github/workflows/ci.yml`).
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

#[path = "pg/native.rs"]
mod native;
#[path = "pg/resource_list.rs"]
mod resource_list;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use mdbn_core::query::{Candidate as Core, CompareOp, FieldRef, Pruning};
use mdbn_core::value::Value as CoreValue;
use mdbn_replica::conformance::{self, id, record};
use mdbn_replica::store::{Page, Store, Tx};
use mdbn_store_pg::{PgConn, PgStore, SharedConn, is_fenced, migrate};
use mdbn_wire::common::{B16, DataMap, Uuid, Value};

fn url() -> Option<String> {
    std::env::var("MDBN_TEST_PG_URL").ok()
}

fn conn() -> Option<SharedConn> {
    let Some(url) = url() else {
        eprintln!("MDBN_TEST_PG_URL not set: skipping the Postgres store tests");
        return None;
    };
    let c = PgConn::connect(&url).expect("connect");
    migrate(c.borrow_mut().client()).expect("migrate");
    Some(c)
}

/// A collection ID unique to this test process and call.
fn fresh() -> Uuid {
    static N: AtomicU64 = AtomicU64::new(1);
    let mut b = [0u8; 16];
    b[..4].copy_from_slice(&std::process::id().to_be_bytes());
    b[4..8].copy_from_slice(
        &(std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos())
        .to_be_bytes(),
    );
    b[8..].copy_from_slice(&N.fetch_add(1, Ordering::SeqCst).to_be_bytes());
    B16(b)
}

fn all() -> Page {
    Page {
        after: None,
        limit: u32::MAX,
    }
}

#[test]
fn conforms() {
    let Some(c) = conn() else { return };
    let mut made = Vec::new();
    conformance::run(|| {
        let col = fresh();
        made.push(col);
        PgStore::open(c.clone(), col).expect("open")
    });
    for col in made {
        PgStore::destroy(&c, &col).expect("destroy");
    }
}

#[test]
fn migrate_is_idempotent() {
    let Some(c) = conn() else { return };
    migrate(c.borrow_mut().client()).expect("second migrate");
}

#[test]
fn a_new_owner_fences_the_old_one() {
    let Some(c) = conn() else { return };
    let col = fresh();
    let mut old = PgStore::open(c.clone(), col).unwrap();
    old.commit(Tx {
        records_put: vec![record(1, "a.md", "a")],
        ..Tx::default()
    })
    .unwrap();
    let mut new = PgStore::open(c.clone(), col).unwrap();
    assert!(new.epoch() > old.epoch());
    let err = old
        .commit(Tx {
            records_put: vec![record(2, "b.md", "b")],
            ..Tx::default()
        })
        .unwrap_err();
    assert!(is_fenced(&err), "{err}");
    assert!(
        new.record(&id(2)).unwrap().is_none(),
        "fenced commit wrote nothing"
    );
    new.commit(Tx {
        records_put: vec![record(2, "b.md", "b")],
        ..Tx::default()
    })
    .unwrap();
    assert_eq!(new.record_count().unwrap(), 2);
    PgStore::destroy(&c, &col).unwrap();
}

#[test]
fn collections_are_isolated() {
    let Some(c) = conn() else { return };
    let (a, b) = (fresh(), fresh());
    let mut sa = PgStore::open(c.clone(), a).unwrap();
    let sb = PgStore::open(c.clone(), b).unwrap();
    sa.commit(Tx {
        records_put: vec![record(1, "a.md", "a")],
        meta: vec![("k".into(), Some(vec![1]))],
        ..Tx::default()
    })
    .unwrap();
    assert_eq!(sb.record_count().unwrap(), 0);
    assert!(sb.record_at("a.md").unwrap().is_none());
    assert!(sb.meta("k").unwrap().is_none());
    PgStore::destroy(&c, &a).unwrap();
    assert!(PgStore::info(&c, &a).unwrap().is_none());
    assert!(PgStore::info(&c, &b).unwrap().is_some());
    PgStore::destroy(&c, &b).unwrap();
}

/// A transaction holding one collection's lock must not block another collection's
/// commit: there is no global lock on the write path.
#[test]
fn no_global_lock() {
    let Some(c) = conn() else { return };
    let url = url().unwrap();
    let (a, b) = (fresh(), fresh());
    let _sa = PgStore::open(c.clone(), a).unwrap();
    let info = PgStore::info(&c, &a).unwrap().unwrap();

    // A second session takes collection A's row lock and keeps its transaction open.
    let mut holder = postgres::Client::connect(&url, postgres::NoTls).unwrap();
    let mut t = holder.transaction().unwrap();
    t.query(
        "SELECT 1 FROM rs_collections WHERE k = $1 FOR UPDATE",
        &[&info.key],
    )
    .unwrap();

    // Collection B commits on another connection, with a lock timeout so a wait
    // fails the test instead of hanging it.
    let cb = PgConn::connect(&url).unwrap();
    cb.borrow_mut()
        .client()
        .batch_execute("SET lock_timeout = '2s'")
        .unwrap();
    let mut sb = PgStore::open(cb.clone(), b).unwrap();
    let rows: Vec<_> = (1..=100)
        .map(|n| record(n, &format!("{n}.md"), "x"))
        .collect();
    let started = Instant::now();
    sb.commit(Tx {
        records_put: rows,
        ..Tx::default()
    })
    .expect("commit of B while A is locked");
    assert!(started.elapsed().as_secs() < 2);
    t.rollback().unwrap();
    PgStore::destroy(&c, &a).unwrap();
    PgStore::destroy(&c, &b).unwrap();
}

/// Bulk path: a snapshot-sized install commits in a bounded number of statements.
#[test]
fn bulk_install() {
    let Some(c) = conn() else { return };
    let col = fresh();
    let mut s = PgStore::open(c.clone(), col).unwrap();
    let n = 20_000u64;
    let rows: Vec<_> = (1..=n)
        .map(|i| {
            let mut r = record(
                i,
                &format!("notes/{i}.md"),
                &format!("---\nn: {i}\n---\nbody {i}\n"),
            );
            r.meta.types = vec!["note".into()];
            r.meta.effective = DataMap(vec![("n".into(), Value::Int(i64::try_from(i).unwrap()))]);
            r.meta.links = vec![format!("k:{}", i % 100)];
            r
        })
        .collect();
    let started = Instant::now();
    s.commit(Tx {
        clear_confirmed: true,
        records_put: rows,
        ..Tx::default()
    })
    .unwrap();
    let took = started.elapsed();
    eprintln!("bulk install of {n} records: {took:?}");
    assert_eq!(s.record_count().unwrap(), n);
    assert_eq!(s.referrers(&["k:7".into()]).unwrap().len(), 200);
    let mut seen = 0u64;
    for k in 0..16u32 {
        seen += s
            .records_in_buckets(k << 12..(k + 1) << 12, all())
            .unwrap()
            .len() as u64;
    }
    assert_eq!(seen, n, "buckets partition the records");
    assert!(took.as_secs() < 60, "bulk install took {took:?}");
    PgStore::destroy(&c, &col).unwrap();
}

fn cmp(field: &str, op: CompareOp, value: CoreValue, pruning: Pruning) -> Core {
    Core::Compare {
        field: FieldRef::Persisted(vec![field.into()]),
        op,
        value,
        pruning,
    }
}

/// Core-B's candidate IR: every pushdown is a superset, and exact ones are exact.
#[test]
fn core_candidates() {
    let Some(c) = conn() else { return };
    let col = fresh();
    let mut s = PgStore::open(c.clone(), col).unwrap();
    // Record n: folder a/ or b/, type Task or Note, status text, n int, tags list.
    let mut rows = Vec::new();
    for n in 1..=12u64 {
        let folder = if n % 2 == 0 { "a" } else { "b" };
        let mut r = record(n, &format!("{folder}/x{n}.md"), "x");
        r.meta.types = vec![if n % 3 == 0 { "Task" } else { "Note" }.into()];
        let mut fields = vec![
            (
                "status".to_string(),
                Value::Text(if n % 4 == 0 { "done" } else { "open" }.into()),
            ),
            ("n".to_string(), Value::Int(i64::try_from(n).unwrap())),
            ("due".to_string(), Value::Text(format!("2026-10-{n:02}"))),
            (
                "tags".to_string(),
                Value::List(vec![Value::Text(format!("t{}", n % 3))]),
            ),
        ];
        if n == 12 {
            // A float equal to an int literal must not be pruned by `n == 5`-style terms.
            fields[1].1 = Value::Float(5.0);
            // A non-ISO due date stays a candidate for date comparisons.
            fields[2].1 = Value::Text("next week".into());
        }
        r.meta.effective = DataMap(fields);
        rows.push(r);
    }
    s.commit(Tx {
        records_put: rows,
        ..Tx::default()
    })
    .unwrap();
    let got = |q: &Core| -> (Vec<u64>, bool) {
        let (rows, exact) = s.candidates_exact(q, all()).unwrap();
        (
            rows.iter()
                .map(|r| u64::from_be_bytes(r.id.0[8..].try_into().unwrap()))
                .collect(),
            exact,
        )
    };
    let has = |v: &[u64], want: &[u64]| want.iter().all(|w| v.contains(w));

    let (v, _) = got(&Core::HasType("task".into()));
    assert!(has(&v, &[3, 6, 9, 12]), "{v:?}");

    let (v, exact) = got(&Core::InFolder("a".into()));
    assert_eq!(v, vec![2, 4, 6, 8, 10, 12]);
    assert!(exact);

    let (v, exact) = got(&cmp(
        "status",
        CompareOp::Eq,
        CoreValue::Text("done".into()),
        Pruning::Exact,
    ));
    assert_eq!(v, vec![4, 8, 12]);
    assert!(exact);

    let (v, _) = got(&cmp("n", CompareOp::Eq, CoreValue::Int(5), Pruning::Exact));
    assert!(
        has(&v, &[5, 12]),
        "int literal keeps the equal float: {v:?}"
    );

    let (v, _) = got(&cmp("n", CompareOp::Gt, CoreValue::Int(9), Pruning::Exact));
    assert!(has(&v, &[10, 11]), "{v:?}");
    assert!(!v.contains(&1));

    let (v, exact) = got(&cmp(
        "tags",
        CompareOp::Contains,
        CoreValue::Text("t0".into()),
        Pruning::Exact,
    ));
    assert_eq!(v, vec![3, 6, 9, 12]);
    assert!(exact);

    let (v, _) = got(&cmp(
        "due",
        CompareOp::Lt,
        CoreValue::Text("2026-10-03".into()),
        Pruning::IsoDate,
    ));
    assert!(has(&v, &[1, 2, 12]), "non-ISO stays a candidate: {v:?}");
    assert!(!v.contains(&5));

    let (v, exact) = got(&Core::Not(Box::new(Core::InFolder("a".into()))));
    assert_eq!(v, vec![1, 3, 5, 7, 9, 11]);
    assert!(exact);

    let (v, exact) = got(&Core::Not(Box::new(Core::HasType("task".into()))));
    assert_eq!(v.len(), 12, "inexact terms are never negated");
    assert!(!exact);

    let (v, _) = got(&Core::And(vec![
        Core::InFolder("a".into()),
        cmp(
            "status",
            CompareOp::In,
            CoreValue::List(vec![CoreValue::Text("done".into())]),
            Pruning::Exact,
        ),
    ]));
    assert_eq!(v, vec![4, 8, 12]);

    let (v, _) = got(&cmp("n", CompareOp::Ne, CoreValue::Int(1), Pruning::Exact));
    assert_eq!(v.len(), 12, "unsupported ops stay a superset");
    PgStore::destroy(&c, &col).unwrap();
}

#[test]
fn keyring_stays_in_memory() {
    use mdbn_replica::store::meta_keys::KEYRING;
    let Some(c) = conn() else { return };
    let col = fresh();
    let mut s = PgStore::open(c.clone(), col).unwrap();
    s.commit(Tx {
        meta: vec![
            (KEYRING.into(), Some(b"secret".to_vec())),
            ("other".into(), Some(vec![1])),
        ],
        ..Tx::default()
    })
    .unwrap();
    assert_eq!(s.meta(KEYRING).unwrap(), Some(b"secret".to_vec()));
    let n: i64 = c
        .borrow_mut()
        .client()
        .query_one(
            "SELECT count(*) FROM rs_meta m JOIN rs_collections k ON k.k = m.c \
             WHERE k.id = $1 AND m.key = $2",
            &[&col.0.as_slice(), &KEYRING],
        )
        .unwrap()
        .get(0);
    assert_eq!(n, 0, "the keyring reached Postgres");
    let reopened = PgStore::open(c.clone(), col).unwrap();
    assert_eq!(reopened.meta(KEYRING).unwrap(), None, "not persisted");
    assert_eq!(reopened.meta("other").unwrap(), Some(vec![1]));
    PgStore::destroy(&c, &col).unwrap();
}

/// Several processes migrating a fresh database at once serialise instead of
/// deadlocking. Runs in a private schema so the tables are new.
#[test]
fn concurrent_migrations_serialise() {
    let Some(url) = url() else {
        eprintln!("MDBN_TEST_PG_URL not set: skipping");
        return;
    };
    let schema = format!(
        "mig_{}_{}",
        std::process::id(),
        fresh().0[8..]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    );
    let mut admin = postgres::Client::connect(&url, postgres::NoTls).unwrap();
    admin
        .batch_execute(&format!("CREATE SCHEMA {schema}"))
        .unwrap();
    for round in 0..3 {
        if round > 0 {
            admin
                .batch_execute(&format!(
                    "DROP SCHEMA {schema} CASCADE; CREATE SCHEMA {schema}"
                ))
                .unwrap();
        }
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let (url, schema) = (url.clone(), schema.clone());
                std::thread::spawn(move || {
                    let mut cfg: postgres::Config = url.parse().unwrap();
                    cfg.options(&format!("-c search_path={schema}"));
                    let mut c = cfg.connect(postgres::NoTls).unwrap();
                    migrate(&mut c)
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap().expect("concurrent migrate");
        }
        let v: i32 = admin
            .query_one(&format!("SELECT max(version) FROM {schema}.rs_schema"), &[])
            .unwrap()
            .get(0);
        assert_eq!(v, mdbn_store_pg::schema::SCHEMA_VERSION);
    }
    admin
        .batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
        .unwrap();
}
