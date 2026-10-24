//! Real Disposable SQLite, signed sync and pending local-view read regressions.
//! Transport replies are held; neither catch-up/readiness nor result rows are invented.
use super::*;
use mdbn_core::views::bases::{DateGroupMode, NullOrder, OrderingCapture, StringOrder};
use r::log::{LogPort, LogPush};
use r::replica::{BasesExecutionPolicies, BasesExecutionWindow, BasesReadRequest};
use std::collections::BTreeMap;
#[path = "local_queries.rs"]
mod queries;
#[path = "local_validation.rs"]
mod validation;

const VIEW: &str = "views:\n  - type: table\n    name: Tasks\n    filters: \"note.status == 'open'\"\n    order: [note.title]\n    sort: [{property: note.title, direction: ASC}]\n";
const TASK: &str = "---\nstatus: open\ntitle: Pending task\n---\n";
const TASK_ID: B16 = B16([32; 16]);
fn configured_local(name: &str) -> (App, SessionId, FakeLogService) {
    configured_source(name, VIEW)
}
fn configured_source(name: &str, source: &str) -> (App, SessionId, FakeLogService) {
    let service = log();
    let (mut app, session, _) = open(&scratch(name).join("app.db"), Rc::new(Probe::default()));
    settle(&mut app, &service);
    configure_resources(&mut app, session, &service);
    submit(
        &mut app,
        session,
        vec![create(SOURCE_ID, SOURCE_PATH, source)],
        40,
    );
    settle(&mut app, &service);
    (app, session, service)
}
fn selection() -> BasesViewSelection {
    BasesViewSelection {
        record: SOURCE_ID,
        revision: w::hash::sha256(VIEW.as_bytes()),
        index: 0,
    }
}
fn check_local_view(app: &mut App, session: SessionId, expected: &[(B16, &str, &str)]) {
    check_local_source(app, session, VIEW, expected);
}
fn check_local_source(
    app: &mut App,
    session: SessionId,
    source: &str,
    expected: &[(B16, &str, &str)],
) {
    check_local_source_summaries(app, session, source, expected, &[]);
}
fn check_local_source_summaries(
    app: &mut App,
    session: SessionId,
    source: &str,
    expected: &[(B16, &str, &str)],
    summaries: &[(String, mdbn_core::views::bases::RuntimeValue)],
) {
    let selected = BasesViewSelection {
        revision: w::hash::sha256(source.as_bytes()),
        ..selection()
    };
    let discovered = views(app, session);
    assert_eq!(discovered.len(), 1);
    assert_eq!(discovered[0].0, SOURCE_ID);
    assert_eq!(discovered[0].2, selected.revision);
    let read_source = app
        .encode_bases_view_source(session, selected, Some("UTC"), |_, read, _| {
            Ok(read.source.clone())
        })
        .unwrap();
    assert_eq!(read_source, source);
    let hints = BTreeMap::new();
    let input = app
        .capture_bases_execution_inputs(selected, Some(&hints), Some("UTC"))
        .unwrap();
    let result = app
        .execute_captured_bases_view(
            input,
            BasesExecutionPolicies {
                ordering: OrderingCapture {
                    nulls: NullOrder::Last,
                    strings: StringOrder::Utf16,
                },
                date_groups: DateGroupMode::Unavailable,
                inventory_ties: true,
            },
            &|| false,
        )
        .unwrap();
    let actual: Vec<_> = result
        .rows
        .iter()
        .map(|row| (row.record, row.path.as_str(), row.revision))
        .collect();
    let wanted: Vec<_> = expected
        .iter()
        .map(|(id, path, doc)| (*id, *path, w::hash::sha256(doc.as_bytes())))
        .collect();
    assert_eq!(actual, wanted);
    assert_eq!(result.summaries, summaries);
    let whole_groups = result
        .groups
        .iter()
        .map(|group| (&group.key, group.rows.len()))
        .collect::<Vec<_>>();
    for window in [
        None,
        Some(BasesExecutionWindow {
            offset: 0,
            limit: 20,
        }),
        Some(BasesExecutionWindow {
            offset: 1,
            limit: 1,
        }),
    ] {
        app.encode_indexed_bases_read_request(
            session,
            BasesReadRequest {
                selection: selected,
                property_types: &hints,
                timezone: "UTC",
                window,
            },
            |result| {
                assert_eq!(result.summaries, summaries);
                if let Some(placement) = &result.window {
                    assert_eq!(placement.total_rows as usize, wanted.len());
                    for (placement, group) in placement.groups.iter().zip(&result.groups) {
                        let (key, count) = whole_groups[placement.ordinal as usize];
                        assert_eq!(&group.key, key);
                        assert_eq!(placement.total_rows as usize, count);
                        assert!(
                            placement
                                .row_ordinals
                                .iter()
                                .all(|ordinal| (*ordinal as usize) < count)
                        );
                    }
                }
                let actual: Vec<_> = result
                    .rows
                    .iter()
                    .map(|row| (row.record, row.path.as_str(), row.revision))
                    .collect();
                let offset = window.map_or(0, |window| window.offset as usize);
                let limit = window.map_or(wanted.len(), |window| window.limit as usize);
                let expected: Vec<_> = wanted.iter().copied().skip(offset).take(limit).collect();
                assert_eq!(
                    actual, expected,
                    "indexed reads must show the same globally ordered local layer"
                );
                Ok(1)
            },
            |_, size| Ok(vec![0; size]),
        )
        .unwrap();
    }
}
#[test]
fn pending_create_is_visible_without_log_receipt_and_setup_stays_blocked() {
    let (mut app, session, service) = configured_local("bases-pending-create-read");
    check_local_view(&mut app, session, &[]);
    let head = app.head();
    submit(
        &mut app,
        session,
        vec![create(TASK_ID, "task.md", TASK)],
        41,
    );
    assert_eq!(app.store().pending_count().unwrap(), 1);
    assert!(
        app.store().record(&TASK_ID).unwrap().is_none(),
        "SQL still holds only confirmed records"
    );
    assert!(app.collection_setup_capture_fence(None).is_err());
    check_local_view(&mut app, session, &[(TASK_ID, "task.md", TASK)]);
    assert_eq!(app.head(), head);
    assert_eq!(app.store().pending_count().unwrap(), 1);
    assert!(app.store().pending_get(&B16([41; 16])).unwrap().is_some());
    settle(&mut app, &service);
    check_local_view(&mut app, session, &[(TASK_ID, "task.md", TASK)]);
}
#[test]
fn known_local_prefix_remains_readable_while_real_reconnect_catches_up() {
    let (mut app, session, service) = configured_local("bases-reconnect-local-prefix");
    submit(
        &mut app,
        session,
        vec![create(TASK_ID, "task.md", TASK)],
        41,
    );
    settle(&mut app, &service);
    check_local_view(&mut app, session, &[(TASK_ID, "task.md", TASK)]);
    let head = app.head();
    // Production transport lifecycle starts catch-up and queues head/read calls.
    // Hold those replies: this is not a test-only assignment to caught_up.
    app.on_log_push(LogPush::Reconnected);
    assert!(!app.take_log_calls().is_empty());
    assert!(app.collection_setup_capture_fence(None).is_err());
    check_local_view(&mut app, session, &[(TASK_ID, "task.md", TASK)]);
    assert_eq!(app.head(), head);
    assert_eq!(app.store().pending_count().unwrap(), 0);
}

fn replace(id: B16, path: &str, before: &str, after: &str) -> Op {
    Op::Document(w::intent::Document {
        id,
        base: Some(w::intent::DocVersion {
            path: path.into(),
            doc: w::common::Text::Inline(before.into()),
        }),
        new: Some(w::intent::DocVersion {
            path: path.into(),
            doc: w::common::Text::Inline(after.into()),
        }),
        if_revision: Some(w::hash::sha256(before.as_bytes())),
    })
}

#[test]
fn pending_edits_deletes_moves_and_creates_merge_before_global_sort_and_window() {
    const KEEP: &str = "---\nstatus: open\ntitle: A kept\n---\n";
    const DROP: &str = "---\nstatus: open\ntitle: B deleted\n---\n";
    const EDITED: &str = "---\nstatus: open\ntitle: 0 edited\n---\n";
    const CLOSED: &str = "---\nstatus: closed\ntitle: 0 edited\n---\n";
    let new = B16([31; 16]);
    let kept = B16([33; 16]);
    let deleted = B16([34; 16]);
    let (mut app, session, service) = configured_local("bases-pending-mutations-read");
    submit(
        &mut app,
        session,
        vec![
            create(TASK_ID, "task.md", TASK),
            create(kept, "kept.md", KEEP),
            create(deleted, "deleted.md", DROP),
        ],
        41,
    );
    settle(&mut app, &service);
    check_local_view(
        &mut app,
        session,
        &[
            (kept, "kept.md", KEEP),
            (deleted, "deleted.md", DROP),
            (TASK_ID, "task.md", TASK),
        ],
    );
    let head = app.head();
    submit(
        &mut app,
        session,
        vec![
            replace(TASK_ID, "task.md", TASK, EDITED),
            Op::Delete(w::intent::Delete {
                id: deleted,
                base_revision: Some(w::hash::sha256(DROP.as_bytes())),
                if_revision: Some(w::hash::sha256(DROP.as_bytes())),
            }),
            Op::Rename(w::intent::Rename {
                id: kept,
                from: "kept.md".into(),
                to: "moved.md".into(),
                update_refs: false,
                if_revision: Some(w::hash::sha256(KEEP.as_bytes())),
            }),
            create(new, "new.md", EDITED),
        ],
        42,
    );
    assert!(app.collection_setup_capture_fence(None).is_err());
    check_local_view(
        &mut app,
        session,
        &[
            (new, "new.md", EDITED),
            (TASK_ID, "task.md", EDITED),
            (kept, "moved.md", KEEP),
        ],
    );
    assert_eq!(app.store().record(&TASK_ID).unwrap().unwrap().doc, TASK);
    assert_eq!(app.store().record(&kept).unwrap().unwrap().path, "kept.md");
    assert!(app.store().record(&deleted).unwrap().is_some());
    assert!(app.store().record(&new).unwrap().is_none());
    let old = app
        .capture_bases_execution_inputs(selection(), Some(&BTreeMap::new()), Some("UTC"))
        .unwrap();
    submit(
        &mut app,
        session,
        vec![replace(TASK_ID, "task.md", EDITED, CLOSED)],
        43,
    );
    assert!(app.recheck_bases_execution_inputs(&old).is_err());
    check_local_view(
        &mut app,
        session,
        &[(new, "new.md", EDITED), (kept, "moved.md", KEEP)],
    );
    assert_eq!(app.head(), head);
    assert_eq!(app.store().pending_count().unwrap(), 2);
    for mutation in [42, 43] {
        assert!(
            app.store()
                .pending_get(&B16([mutation; 16]))
                .unwrap()
                .is_some()
        );
    }
    settle(&mut app, &service);
    check_local_view(
        &mut app,
        session,
        &[(new, "new.md", EDITED), (kept, "moved.md", KEEP)],
    );
}

#[test]
fn pending_selected_source_uses_actual_revision_and_invalidates_old_discovery_cut() {
    let (mut app, session, service) = configured_local("bases-pending-source-cas");
    submit(
        &mut app,
        session,
        vec![create(TASK_ID, "task.md", TASK)],
        41,
    );
    settle(&mut app, &service);
    let old = app
        .capture_bases_execution_inputs(selection(), Some(&BTreeMap::new()), Some("UTC"))
        .unwrap();
    let changed = VIEW.replace("name: Tasks", "name: Renamed");
    submit(
        &mut app,
        session,
        vec![replace(SOURCE_ID, SOURCE_PATH, VIEW, &changed)],
        42,
    );
    assert!(app.recheck_bases_execution_inputs(&old).is_err());
    let encoded = Cell::new(false);
    assert!(
        app.encode_bases_view_source(session, selection(), Some("UTC"), |_, _, _| {
            encoded.set(true);
            Ok(())
        })
        .is_err()
    );
    assert!(
        !encoded.get(),
        "obsolete confirmed-source CAS must not publish"
    );
    check_local_source(&mut app, session, &changed, &[(TASK_ID, "task.md", TASK)]);
    assert_eq!(app.store().record(&SOURCE_ID).unwrap().unwrap().doc, VIEW);
    assert_eq!(app.store().pending_count().unwrap(), 1);
    assert!(app.collection_setup_capture_fence(None).is_err());
}
