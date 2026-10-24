//! The bounded inventory seams against real Postgres, never pg-mem.
use super::*;
use mdbn_replica::store::{BoundedResource, ResourcePathPage, StoreError};

#[test]
fn resource_pg_inventory_is_byte_ordered_isolated_and_source_projected() {
    let Some(conn) = conn() else { return };
    let (collection, other) = (fresh(), fresh());
    let mut store = PgStore::open(conn.clone(), collection).unwrap();
    let mut other_store = PgStore::open(conn.clone(), other).unwrap();
    store
        .commit(Tx {
            resources_put: vec![
                ("_types/a.md".into(), "é\n".into()),
                ("_types/b.md".into(), "".into()),
                ("_types/z.md".into(), "x".repeat((1 << 20) + 1)),
                ("_types/é.md".into(), "malformed orphan".into()),
                ("_types2/no.md".into(), "excluded".into()),
            ],
            ..Default::default()
        })
        .unwrap();
    other_store
        .commit(Tx {
            resources_put: vec![("_types/private.md".into(), "other collection".into())],
            ..Default::default()
        })
        .unwrap();
    let paths = |after, limit| {
        store.resource_paths_page(ResourcePathPage {
            after,
            prefix: Some("_types/"),
            limit,
        })
    };
    assert_eq!(paths(None, 2).unwrap(), vec!["_types/a.md", "_types/b.md"]);
    assert_eq!(
        paths(Some("_types/b.md"), 2).unwrap(),
        vec!["_types/z.md", "_types/é.md"]
    );
    assert!(paths(Some("_types/é.md"), 2).unwrap().is_empty());
    assert_eq!(
        store.resource_bounded("_types/a.md", 3).unwrap(),
        Some(BoundedResource {
            size: 3,
            text: Some("é\n".into()),
        })
    );
    assert_eq!(
        store.resource_bounded("_types/a.md", 2).unwrap(),
        Some(BoundedResource {
            size: 3,
            text: None,
        })
    );
    assert_eq!(
        store.resource_bounded("_types/b.md", 0).unwrap(),
        Some(BoundedResource {
            size: 0,
            text: Some("".into()),
        })
    );
    assert_eq!(
        store.resource_bounded("_types/z.md", 1 << 20).unwrap(),
        Some(BoundedResource {
            size: (1 << 20) + 1,
            text: None,
        })
    );
    assert_eq!(
        store.resource_bounded("_types/private.md", 1024).unwrap(),
        None
    );
    assert_eq!(paths(None, 130), Err(StoreError::Full));
    assert_eq!(
        store.resource_bounded("_types/a.md", (1 << 20) + 1),
        Err(StoreError::Full)
    );
    store
        .commit(Tx {
            resources_put: vec![("x".repeat(4097), "oversized path".into())],
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        store.resource_paths_page(ResourcePathPage {
            after: None,
            prefix: None,
            limit: 64
        }),
        Err(StoreError::Full)
    );
    PgStore::destroy(&conn, &collection).unwrap();
    PgStore::destroy(&conn, &other).unwrap();
}
