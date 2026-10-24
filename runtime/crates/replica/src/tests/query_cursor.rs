//! MemStore has NO maintained index. Do not fabricate keyset continuations over
//! its whole-scan fallback; real indexed execution is covered with SQLite.
use crate::api::ClientApi;
use crate::fake::FakeLogService;
use crate::mem::MemStore;
use mdbn_wire::client::Include;
use mdbn_wire::common::Value;

fn include() -> Include {
    Include {
        effective: None,
        body: None,
        document: None,
        diagnostics: None,
    }
}
#[test]
fn memory_fallback_never_ignores_or_invents_a_cursor() {
    let service = FakeLogService::new();
    let mut node = super::engine::node(&service, 1, MemStore::new());
    node.pump();
    let original = Value::Map(vec![("limit".into(), Value::Int(1))]);
    let page = node.r.query(node.s, original.clone(), include()).unwrap();
    assert!(page.cursor.is_none());
    let mut fields = match original {
        Value::Map(fields) => fields,
        _ => unreachable!(),
    };
    fields.push((
        "cursor".into(),
        Value::Text("q1.00000000000000000000000000000000".into()),
    ));
    let err = node
        .r
        .query(node.s, Value::Map(fields), include())
        .unwrap_err();
    assert_eq!(err.problem().code, "invalid_request");
    assert_eq!(err.problem().reason.as_deref(), Some("cursor_expired"));
}
#[test]
fn malformed_or_subscription_cursor_is_an_explicit_error() {
    let service = FakeLogService::new();
    let mut node = super::engine::node(&service, 1, MemStore::new());
    node.pump();
    for value in [Value::Null, Value::Int(0), Value::Text("bad".into())] {
        let query = Value::Map(vec![
            ("limit".into(), Value::Int(1)),
            ("cursor".into(), value),
        ]);
        let err = node.r.query(node.s, query.clone(), include()).unwrap_err();
        assert_eq!(
            err.problem().reason.as_deref(),
            Some("invalid_query_cursor")
        );
        assert!(node.r.subscribe(node.s, query, include()).is_err());
    }
}
