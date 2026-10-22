//! Local-cut catalogue, publication and pending-source budget regressions.
use super::*;

#[test]
fn pending_type_removal_is_not_confirmed_catalogue_discovery() {
    let (mut app, session, _) = configured_local("bases-pending-type-removal");
    check_local_view(&mut app, session, &[]);
    let head = app.head();
    submit(
        &mut app,
        session,
        vec![Op::ResourceDelete(w::intent::ResourceDelete {
            path: "_types/base.md".into(),
            base_revision: None,
        })],
        42,
    );
    assert!(views(&mut app, session).is_empty());
    assert!(
        app.capture_bases_discovery(Some("UTC"))
            .unwrap()
            .views()
            .is_empty()
    );
    let encoded = Cell::new(false);
    assert!(
        app.encode_bases_view_source(session, selection(), Some("UTC"), |_, _, _| {
            encoded.set(true);
            Ok(())
        })
        .is_err()
    );
    assert!(!encoded.get());
    assert!(app.collection_setup_capture_fence(None).is_err());
    assert_eq!(app.head(), head);
    assert_eq!(app.store().pending_count().unwrap(), 1);
}

#[test]
fn local_write_during_source_encoding_suppresses_obsolete_output() {
    let (mut app, session, _) = configured_local("bases-pending-publication-cut");
    submit(
        &mut app,
        session,
        vec![create(TASK_ID, "task.md", TASK)],
        41,
    );
    let head = app.head();
    let encoded = Cell::new(false);
    let result = app.encode_bases_view_source(session, selection(), Some("UTC"), |app, _, _| {
        encoded.set(true);
        submit(
            app,
            session,
            vec![create(B16([33; 16]), "second.md", TASK)],
            42,
        );
        Ok(vec![1])
    });
    assert!(encoded.get(), "exercise the final publication fence");
    assert!(
        result.is_err(),
        "the old local cut must not escape as success"
    );
    assert_eq!(app.head(), head);
    assert_eq!(app.store().pending_count().unwrap(), 2);
}

#[test]
fn locally_refused_large_source_is_not_an_admitted_source_or_sql_corruption() {
    let (mut app, session, _) = configured_local("bases-pending-source-budget");
    let source = format!("{VIEW}\n# {}\n", "x".repeat(600 * 1024));
    let id = B16([35; 16]);
    submit(
        &mut app,
        session,
        vec![create(id, "large.base", &source)],
        42,
    );
    // The actual planner refuses this source locally; do not invent a pending
    // row or source witness from an RPC-level reply.
    assert_eq!(app.store().pending_count().unwrap(), 0);
    assert!(app.store().fenced().is_none());
    let selected = BasesViewSelection {
        record: id,
        revision: w::hash::sha256(source.as_bytes()),
        index: 0,
    };
    let encoded = Cell::new(false);
    let error = app
        .encode_bases_view_source(session, selected, Some("UTC"), |_, _, _| {
            encoded.set(true);
            Ok(())
        })
        .unwrap_err();
    // A selected-source miss must refuse before hydrate, not fence healthy SQL.
    assert_eq!(error.code(), Some(ErrorCode::Conflict));
    assert!(!encoded.get());
    assert!(app.store().fenced().is_none());
    assert_eq!(app.store().pending_count().unwrap(), 0);
    assert_eq!(app.store().record(&SOURCE_ID).unwrap().unwrap().doc, VIEW);
    check_local_view(&mut app, session, &[]);
}
