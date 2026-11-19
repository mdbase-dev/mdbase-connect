//! A type matched by expression keeps the typed query projection and views.
use super::*;
use r::replica::BasesReadRequest;
use std::collections::BTreeMap;

const TABLE: &str = "views:\n  - type: table\n    order: [file.name]\n";
const TABLE_ID: B16 = B16([14; 16]);

fn read(app: &mut App, session: SessionId) -> Vec<B16> {
    let hints = BTreeMap::new();
    let mut rows = Vec::new();
    app.encode_indexed_bases_read_request(
        session,
        BasesReadRequest {
            selection: BasesViewSelection {
                record: TABLE_ID,
                revision: w::hash::sha256(TABLE.as_bytes()),
                index: 0,
            },
            property_types: &hints,
            timezone: "UTC",
            window: None,
        },
        |result| {
            rows = result.rows.iter().map(|row| row.record).collect();
            Ok(1)
        },
        |_, size| Ok(vec![0; size]),
    )
    .unwrap_or_else(|error| panic!("view read: {error:?}"));
    rows.sort();
    rows
}

fn ready(app: &App) -> bool {
    app.store()
        .query_projection_state()
        .unwrap()
        .is_some_and(|state| state.ready)
        && app
            .store()
            .query_index_state()
            .unwrap()
            .is_some_and(|state| state.ready)
}

/// mdbase-connect#1717: a collection whose catalog held a `match.expr` type
/// never built its query or raw projection, so every Bases view refused with
/// `view_raw_projection_not_ready`, and no open rebuilt it.
#[test]
fn a_type_matched_by_expression_keeps_the_query_projection_and_views() {
    let path = scratch("tentative-match-expr-projection").join("app.db");
    let service = log();
    let (mut app, session, index) = open(&path, Rc::new(Probe::default()));
    settle(&mut app, &service);
    configure(&mut app, session, &service);
    submit(
        &mut app,
        session,
        vec![Op::ResourcePut(ResourcePut {
            path: "_types/overdue/1.md".into(),
            doc: "---\nkind: mdbase.type\nname: overdue\nversion: 1\nmatch:\n  expr: 'has(raw.due)'\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n".into(),
            base_revision: None,
            must_not_exist: None,
        })],
        91,
    );
    let due = B16([13; 16]);
    submit(
        &mut app,
        session,
        vec![
            create(due, "tasks/due.md", "---\ndue: 2026-11-20\n---\n"),
            create(TABLE_ID, "TaskNotes/Views/table.base", TABLE),
        ],
        92,
    );
    settle(&mut app, &service);
    assert!(ready(&app), "projections ready with a match.expr type");
    let mut expected = vec![SOURCE_ID, B16([12; 16]), due, TABLE_ID];
    expected.sort();
    assert_eq!(read(&mut app, session), expected);
    assert_eq!(views(&mut app, session).len(), 3);
    // The state an earlier runtime left: both projections emptied and never
    // rebuilt. The next open rebuilds them.
    for statement in [
        "UPDATE st_qraw_state SET ready=0,version=0",
        "DELETE FROM st_kv WHERE k='qraw_settled'",
        "DELETE FROM st_qraw",
        "DELETE FROM st_qrecord",
        "DELETE FROM st_field",
        "DELETE FROM st_qtype",
        "UPDATE st_qstate SET ready=0",
    ] {
        raw(&index, statement, vec![]);
    }
    drop(app);
    drop(index);
    let (mut reopened, session, _) = open(&path, Rc::new(Probe::default()));
    settle(&mut reopened, &service);
    assert!(ready(&reopened), "rebuilt on open");
    assert_eq!(read(&mut reopened, session), expected);
}
