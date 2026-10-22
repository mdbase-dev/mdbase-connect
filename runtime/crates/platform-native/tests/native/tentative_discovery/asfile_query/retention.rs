//! Query-local retention is separate from cumulative source-copy admission.
use super::*;

#[test]
fn constant_selection_cannot_multiply_retained_values_past_budget() {
    let path = scratch("native-selection-retention-budget").join("state.db");
    let (mut app, session, _index) = open(&path, Rc::new(Probe::default()));
    let service = log();
    settle(&mut app, &service);
    let ops = (21..61)
        .map(|id| create(B16([id; 16]), &format!("Tasks/{id}.md"), "Small source\n"))
        .collect();
    submit(&mut app, session, ops, 47);
    settle(&mut app, &service);
    let expression = format!("'{}'", "x".repeat(30_000));
    let query = Value::Map(vec![(
        "select".into(),
        Value::List(vec![selection("constant", &expression)]),
    )]);
    let error = app.query(session, query, include()).unwrap_err();
    assert_eq!(error.code(), Some(ErrorCode::TooLarge));
    assert_eq!(
        error.problem().reason.as_deref(),
        Some("query_budget_exceeded")
    );
    assert_eq!(app.store().pending_count().unwrap(), 0);
}
