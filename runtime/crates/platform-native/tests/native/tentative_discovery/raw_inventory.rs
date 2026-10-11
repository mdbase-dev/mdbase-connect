//! Primary raw inventory is independent of optional typed query projections.
use super::*;

#[test]
fn tentative_discovery_primary_inventory_with_clock_match_and_no_query_projection() {
    let path = scratch("tentative-primary-clock-inventory").join("app.db");
    let service = log();
    let (mut app, session, _) = open(&path, Rc::new(Probe::default()));
    settle(&mut app, &service);
    configure(&mut app, session, &service);
    submit(
        &mut app,
        session,
        vec![Op::ResourcePut(ResourcePut {
            path: "_types/overdue/1.md".into(),
            doc: "---\nkind: mdbase.type\nname: overdue\nversion: 1\nmatch:\n  expr: 'has(raw.due) && raw.due < today()'\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n".into(),
            base_revision: None,
            must_not_exist: None,
        })],
        91,
    );
    settle(&mut app, &service);
    // Optional ClockNone type indexing is intentionally invalidated. Neither
    // generic discovery nor an exact source READ may relabel it ready.
    let projection = app.store().query_projection_state().unwrap();
    assert!(projection.as_ref().is_none_or(|state| !state.ready));
    let head = app.store().head().unwrap();
    let before = app.store().pending_count().unwrap();
    let identities = views(&mut app, session);
    assert_eq!(identities.len(), 2);
    assert!(identities.iter().all(|view| view.0 == SOURCE_ID));
    let original = app
        .encode_bases_view_source(
            session,
            BasesViewSelection {
                record: SOURCE_ID,
                revision: w::hash::sha256(SOURCE.as_bytes()),
                index: 1,
            },
            Some("UTC"),
            |_, source, _| Ok(source.source.clone()),
        )
        .unwrap();
    assert_eq!(original, SOURCE);
    assert_eq!(app.store().head().unwrap(), head);
    assert_eq!(app.store().pending_count().unwrap(), before);
    assert_eq!(app.store().query_projection_state().unwrap(), projection);
    drop(app);
    let (mut reopened, session, _) = open(&path, Rc::new(Probe::default()));
    settle(&mut reopened, &service);
    assert_eq!(views(&mut reopened, session), identities);
    assert_eq!(reopened.store().head().unwrap(), head);
    assert!(
        reopened
            .store()
            .query_projection_state()
            .unwrap()
            .as_ref()
            .is_none_or(|state| !state.ready)
    );
}
