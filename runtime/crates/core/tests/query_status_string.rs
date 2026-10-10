//! String predicate oracle on the actual Core memory state.
use mdbn_core::ids::Uuid;
use mdbn_core::query::{self, Query, QueryEnv};
use mdbn_core::state::{MemState, StateView};

#[test]
fn open_frontmatter_matches_string_predicates_with_numeric_control() {
    let mut s = MemState::new();
    s.insert_resource("mdbase.yaml", "spec_version: '0.3.0'\n");
    s.insert_resource("_types/task.md","---\nkind: mdbase.type\nname: task\nmatch:\n  path_glob: 'tasks/*.md'\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n");
    let open = Uuid([1; 16]);
    let closed = Uuid([2; 16]);
    s.insert_record(
        open,
        "tasks/open.md",
        "---\nstatus: open\npriority: 7\n---\nOpen task\n",
    );
    s.insert_record(
        closed,
        "tasks/closed.md",
        "---\nstatus: closed\npriority: 3\n---\nClosed task\n",
    );
    assert!(s.catalog().is_valid());
    let env = QueryEnv {
        now_ms: 0,
        tz: "UTC".into(),
        today: "1970-01-01".into(),
    };
    for expr in [
        "status == \"open\"",
        "record.status == \"open\"",
        "record['status'] == \"open\"",
        "raw.status == \"open\"",
        "priority == 7",
    ] {
        let q = Query {
            where_: Some(expr.into()),
            ..Query::default()
        };
        let plan = query::compile(&q, &s.catalog()).expect("actual Core compilation");
        let result = query::execute(&plan, &s, &env).expect("actual Core execution");
        assert_eq!(result.ids, vec![open], "{expr}");
    }
}
