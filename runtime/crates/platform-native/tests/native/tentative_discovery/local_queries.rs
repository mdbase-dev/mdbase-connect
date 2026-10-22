//! Actual SQLite/signed-sync generic renderer and source query-cap regressions.
use super::*;
use mdbn_core::views::bases::RuntimeValue;

#[test]
fn native_summaries_include_all_filtered_pending_and_confirmed_matches_before_limit_and_window() {
    let source = VIEW.replace("type: table", "type: opaqueGrid").replace("name: Tasks\n", "name: Tasks\n    limit: 2\n    groupBy: {property: note.status, direction: ASC}\n    summaries:\n      - {field: note.title, function: count, name: all}\n      - {field: note.points, function: average, name: average}\n      - {field: note.title, function: custom, name: first}\n    summary_functions: {custom: 'values[0]'}\n");
    let (mut app, session, service) = configured_source("bases-generic-native-summaries", &source);
    let a = "---\nstatus: open\ntitle: A\npoints: 1\n---\n";
    let b = "---\nstatus: open\ntitle: B\npoints: 2\n---\n";
    let z = "---\nstatus: open\ntitle: Z\npoints: 3\n---\n";
    let closed = "---\nstatus: closed\ntitle: 0\npoints: 1000\n---\n";
    let ids = [B16([31; 16]), B16([32; 16]), B16([33; 16]), B16([34; 16])];
    submit(
        &mut app,
        session,
        vec![
            create(ids[0], "z.md", z),
            create(ids[1], "a.md", a),
            create(ids[2], "b.md", b),
            create(ids[3], "closed.md", closed),
        ],
        41,
    );
    let summaries = [
        ("all".into(), RuntimeValue::Number(3.0)),
        ("average".into(), RuntimeValue::Number(2.0)),
        ("first".into(), RuntimeValue::String("A".into())),
    ];
    check_local_source_summaries(
        &mut app,
        session,
        &source,
        &[(ids[1], "a.md", a), (ids[2], "b.md", b)],
        &summaries,
    );
    assert_eq!(app.store().pending_count().unwrap(), 1);
    settle(&mut app, &service);
    check_local_source_summaries(
        &mut app,
        session,
        &source,
        &[(ids[1], "a.md", a), (ids[2], "b.md", b)],
        &summaries,
    );
    let changed = "---\nstatus: open\ntitle: 0 edited\npoints: 9\n---\n";
    submit(
        &mut app,
        session,
        vec![replace(ids[0], "z.md", z, changed)],
        42,
    );
    check_local_source_summaries(
        &mut app,
        session,
        &source,
        &[(ids[0], "z.md", changed), (ids[1], "a.md", a)],
        &[
            ("all".into(), RuntimeValue::Number(3.0)),
            ("average".into(), RuntimeValue::Number(4.0)),
            ("first".into(), RuntimeValue::String("0 edited".into())),
        ],
    );
    assert_eq!(app.store().record(&ids[0]).unwrap().unwrap().doc, z);
    assert_eq!(app.store().pending_count().unwrap(), 1);
}

#[test]
fn summary_evaluation_failure_suppresses_the_whole_native_result_and_codec() {
    let source = VIEW.replace("name: Tasks\n", "name: Tasks\n    summaries: [{field: note.title, function: broken, name: first}]\n    summary_functions: {broken: 'values[999]'}\n");
    let (mut app, session, _service) = configured_source("bases-generic-summary-refusal", &source);
    submit(
        &mut app,
        session,
        vec![create(TASK_ID, "task.md", TASK)],
        41,
    );
    let selected = BasesViewSelection {
        revision: w::hash::sha256(source.as_bytes()),
        ..selection()
    };
    let hints = BTreeMap::new();
    let input = app
        .capture_bases_execution_inputs(selected, Some(&hints), Some("UTC"))
        .unwrap();
    assert!(
        app.execute_captured_bases_view(
            input,
            BasesExecutionPolicies {
                ordering: OrderingCapture {
                    nulls: NullOrder::Last,
                    strings: StringOrder::Utf16
                },
                date_groups: DateGroupMode::Unavailable,
                inventory_ties: true,
            },
            &|| false
        )
        .is_err()
    );
    for window in [
        None,
        Some(BasesExecutionWindow {
            offset: 0,
            limit: 1,
        }),
    ] {
        assert!(
            app.encode_indexed_bases_read_request(
                session,
                BasesReadRequest {
                    selection: selected,
                    property_types: &hints,
                    timezone: "UTC",
                    window,
                },
                |_| panic!("bad reduction must never reach measurement"),
                |_, _| panic!("bad reduction must never reach encoding")
            )
            .is_err()
        );
    }
    assert_eq!(app.store().pending_count().unwrap(), 1);
    assert!(app.store().record(&TASK_ID).unwrap().is_none());
}
#[test]
fn zero_source_limit_is_empty_even_though_summaries_cover_matches() {
    let source = VIEW.replace(
        "name: Tasks\n",
        "name: Tasks\n    limit: 0\n    summaries: {note.title: Count}\n",
    );
    let (mut app, session, _service) = configured_source("bases-generic-zero-limit", &source);
    submit(
        &mut app,
        session,
        vec![create(TASK_ID, "task.md", TASK)],
        41,
    );
    check_local_source_summaries(
        &mut app,
        session,
        &source,
        &[],
        &[("note.title".into(), RuntimeValue::Number(1.0))],
    );
}

#[test]
fn generic_renderer_and_opaque_metadata_limit_after_global_order_before_window() {
    let source = VIEW.replace("type: table", "type: externalTimeline")
        .replace("name: Tasks\n", "name: Tasks\n    limit: 2\n    customPresentation: {nested: [true, 7, 'opaque']}\n    options: {unregisteredKey: {mode: custom}}\n");
    let (mut app, session, service) = configured_source("bases-generic-query-limit", &source);
    let a = "---\nstatus: open\ntitle: A\n---\n";
    let b = "---\nstatus: open\ntitle: B\n---\n";
    let z = "---\nstatus: open\ntitle: Z\n---\n";
    let ids = [B16([31; 16]), B16([32; 16]), B16([33; 16])];
    submit(
        &mut app,
        session,
        vec![
            create(ids[0], "z.md", z),
            create(ids[1], "a.md", a),
            create(ids[2], "b.md", b),
        ],
        41,
    );
    // Exercise the actual pending layer as well as confirmed SQLite rows.
    check_local_source(
        &mut app,
        session,
        &source,
        &[(ids[1], "a.md", a), (ids[2], "b.md", b)],
    );
    assert_eq!(app.store().pending_count().unwrap(), 1);
    settle(&mut app, &service);
    check_local_source(
        &mut app,
        session,
        &source,
        &[(ids[1], "a.md", a), (ids[2], "b.md", b)],
    );
}
