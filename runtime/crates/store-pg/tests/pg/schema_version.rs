//! Isolated schemas in the disposable integration-test database; never public.
use super::*;
use mdbn_store_pg::schema;

fn isolated() -> Option<(SharedConn, String)> {
    let Some(url) = url() else {
        // CI sets MDBN_TEST_PG_REQUIRED so a missing database fails instead of passing.
        assert!(
            std::env::var_os("MDBN_TEST_PG_REQUIRED").is_none(),
            "MDBN_TEST_PG_REQUIRED is set but MDBN_TEST_PG_URL is not"
        );
        eprintln!("MDBN_TEST_PG_URL not set: skipping schema migration integration test");
        return None;
    };
    let conn = PgConn::connect(&url).unwrap();
    let name = format!("migration_{}", fresh().to_hex());
    conn.borrow_mut()
        .client()
        .batch_execute(&format!("CREATE SCHEMA {name}; SET search_path TO {name}"))
        .unwrap();
    Some((conn, name))
}
fn cleanup(conn: SharedConn, name: String) {
    conn.borrow_mut()
        .client()
        .batch_execute(&format!("DROP SCHEMA {name} CASCADE"))
        .unwrap();
}

#[test]
fn fresh_and_unversioned_schema_preserve_rows_and_adopt_v1() {
    let Some((conn, name)) = isolated() else {
        return;
    };
    assert_eq!(schema::current(conn.borrow_mut().client()).unwrap(), None);
    migrate(conn.borrow_mut().client()).unwrap();
    let col = fresh();
    let mut store = PgStore::open(conn.clone(), col).unwrap();
    let row = record(1, "a.md", "original");
    store
        .commit(Tx {
            records_put: vec![row.clone()],
            ..Tx::default()
        })
        .unwrap();
    conn.borrow_mut()
        .client()
        .batch_execute("DROP TABLE rs_schema")
        .unwrap();
    migrate(conn.borrow_mut().client()).unwrap();
    assert_eq!(
        schema::current(conn.borrow_mut().client()).unwrap(),
        Some(1)
    );
    assert_eq!(store.record(&row.id).unwrap(), Some(row));
    migrate(conn.borrow_mut().client()).unwrap();
    drop(store);
    cleanup(conn, name);
}

#[test]
fn newer_schema_refuses_migration_and_open_without_fencing_owner_or_changing_data() {
    let Some((conn, name)) = isolated() else {
        return;
    };
    migrate(conn.borrow_mut().client()).unwrap();
    let col = fresh();
    let mut store = PgStore::open(conn.clone(), col).unwrap();
    let epoch = store.epoch();
    let row = record(1, "saved.md", "preserve");
    store
        .commit(Tx {
            records_put: vec![row.clone()],
            ..Tx::default()
        })
        .unwrap();
    conn.borrow_mut()
        .client()
        .batch_execute("UPDATE rs_schema SET version=2")
        .unwrap();
    let err = migrate(conn.borrow_mut().client()).unwrap_err();
    assert!(err.to_string().contains("newer"), "{err}");
    let err = PgStore::open(conn.clone(), col).unwrap_err();
    assert!(err.to_string().contains("upgrade"), "{err}");
    assert_eq!(
        schema::current(conn.borrow_mut().client()).unwrap(),
        Some(2)
    );
    assert_eq!(PgStore::info(&conn, &col).unwrap().unwrap().epoch, epoch);
    assert_eq!(store.record(&row.id).unwrap(), Some(row));
    drop(store);
    cleanup(conn, name);
}
