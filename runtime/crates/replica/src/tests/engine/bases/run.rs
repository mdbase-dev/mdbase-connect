use super::*;
use crate::replica::{BasesExecutionPolicies, BasesViewSelection};
use mdbn_core::views::bases::{
    BasesDisplayCell, DateGroupMode, NullOrder, OrderingCapture, RuntimeValue, StringOrder,
};
use std::collections::BTreeMap;
fn reference() -> serde_json::Value {
    serde_json::from_str(include_str!("../../data/bases-first-slice.json")).unwrap()
}
fn policies() -> BasesExecutionPolicies {
    BasesExecutionPolicies {
        ordering: OrderingCapture {
            nulls: NullOrder::Last,
            strings: StringOrder::Utf16,
        },
        date_groups: DateGroupMode::Unavailable,
        inventory_ties: true,
    }
}
fn select(id: u8, source: &str, index: u32) -> BasesViewSelection {
    BasesViewSelection {
        record: B16([id; 16]),
        revision: mdbn_wire::hash::sha256(source.as_bytes()),
        index,
    }
}
fn plain(value: &RuntimeValue) -> serde_json::Value {
    serde_json::from_str(&value.to_plain().to_json()).unwrap()
}
#[test]
fn signed_replica_executes_all_five_unchanged_tasknotes_sources_against_independent_clock_sets_order_groups_cells()
 {
    let expected = reference();
    for view in expected["views"].as_array().unwrap() {
        let (_, mut a, _) = configured();
        let source = expected["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["command"] == view["command"])
            .unwrap()["source"]
            .as_str()
            .unwrap();
        a.create(11, "Views/actual.base", source);
        for (index, record) in expected["records"].as_array().unwrap().iter().enumerate() {
            a.create(
                (index + 1) as u8,
                record["path"].as_str().unwrap(),
                record["source"].as_str().unwrap(),
            );
        }
        settle(&mut [&mut a]);
        a.clock.set(expected["now_ms"].as_u64().unwrap());
        let hints = BTreeMap::from_iter([
            ("due".into(), "date".into()),
            ("scheduled".into(), "date".into()),
        ]);
        let inputs =
            a.r.capture_bases_execution_inputs(
                select(11, source, view["index"].as_u64().unwrap() as u32),
                Some(&hints),
                Some("UTC"),
            )
            .unwrap();
        assert_eq!(
            inputs.clock().instant_ms,
            expected["now_ms"].as_i64().unwrap()
        );
        let result =
            a.r.execute_captured_bases_view(inputs, policies(), &|| false)
                .unwrap_or_else(|e| panic!("{}: {e}", view["name"]));
        assert_eq!(
            result.view.revision,
            mdbn_wire::hash::sha256(source.as_bytes())
        );
        let ids = result
            .rows
            .iter()
            .map(|row| expected["records"][(row.record.0[0] - 1) as usize]["id"].clone())
            .collect::<Vec<_>>();
        assert_eq!(
            serde_json::json!(ids),
            view["matched"],
            "{} order",
            view["name"]
        );
        assert_eq!(result.unavailable_columns, vec![(11, "file_field")]);
        for (row, want) in result.rows.iter().zip(view["rows"].as_array().unwrap()) {
            let cells = row
                .cells
                .iter()
                .map(|c| match c {
                    BasesDisplayCell::Value(value) => serde_json::json!({"value":plain(value)}),
                    BasesDisplayCell::Unavailable { code, detail } => {
                        assert_eq!(*code, "view_metadata_unavailable");
                        serde_json::json!({"unavailable":detail})
                    }
                })
                .collect::<Vec<_>>();
            assert_eq!(
                serde_json::json!(cells),
                want["cells"],
                "{} cells",
                view["name"]
            );
        }
        assert_eq!(
            serde_json::json!(
                result
                    .groups
                    .iter()
                    .map(|g| serde_json::json!({"key":plain(&g.key),"rows":g.rows}))
                    .collect::<Vec<_>>()
            ),
            view["groups"]
        );
        assert_eq!(a.doc(11).as_deref(), Some(source));
    }
}
#[test]
fn link_valued_tasknotes_display_slots_do_not_poison_all_five_views() {
    let expected = reference();
    for view in expected["views"].as_array().unwrap() {
        let (_, mut a, _) = configured();
        let source = expected["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|source| source["command"] == view["command"])
            .unwrap()["source"]
            .as_str()
            .unwrap();
        a.create(11, "Views/actual.base", source);
        for (index, record) in expected["records"].as_array().unwrap().iter().enumerate() {
            let raw = record["source"].as_str().unwrap().replacen("---\n", "---\nprojects: ['[[Work#heading|alias]]']\ncontexts: ['[[Office]]']\nblockedBy: '[[Other task]]'\n", 1);
            a.create((index + 1) as u8, record["path"].as_str().unwrap(), &raw);
        }
        settle(&mut [&mut a]);
        a.clock.set(expected["now_ms"].as_u64().unwrap());
        let hints = BTreeMap::from_iter([
            ("due".into(), "date".into()),
            ("scheduled".into(), "date".into()),
        ]);
        let input =
            a.r.capture_bases_execution_inputs(
                select(11, source, view["index"].as_u64().unwrap() as u32),
                Some(&hints),
                Some("UTC"),
            )
            .unwrap();
        let result =
            a.r.execute_captured_bases_view(input, policies(), &|| false)
                .unwrap();
        let ids = result
            .rows
            .iter()
            .map(|row| expected["records"][(row.record.0[0] - 1) as usize]["id"].clone())
            .collect::<Vec<_>>();
        assert_eq!(serde_json::json!(ids), view["matched"]);
        for row in result.rows {
            for index in [4, 5, 7] {
                assert!(matches!(
                    row.cells[index],
                    BasesDisplayCell::Unavailable {
                        code: "view_unsupported_construct",
                        detail: "link_property"
                    }
                ));
            }
            assert!(matches!(row.cells[0], BasesDisplayCell::Value(_)));
        }
    }
}

#[test]
fn display_link_interim_mask_does_not_hide_semantic_link_use_or_nonmatches() {
    for source in [
        "filters: projects.isEmpty()\nviews: [{type: table, order: [projects]}]\n",
        "views: [{type: table, order: [projects], sort: [{column: projects}]}]\n",
        "views: [{type: table, order: [projects], groupBy: {property: projects}}]\n",
        "filters: 'false'\nviews: [{type: table, order: [projects]}]\n",
    ] {
        let (_, mut a, _) = configured();
        a.create(11, "View.base", source);
        a.create(1, "Task.md", "---\nprojects: '[[Work]]'\n---\n");
        settle(&mut [&mut a]);
        let input =
            a.r.capture_bases_execution_inputs(
                select(11, source, 0),
                Some(&BTreeMap::new()),
                Some("UTC"),
            )
            .unwrap();
        let result =
            a.r.execute_captured_bases_view(input, policies(), &|| false);
        if source.starts_with("filters: 'false'") {
            assert!(result.unwrap().rows.is_empty());
        } else {
            assert!(result.is_err());
        }
    }
}

#[test]
fn all_five_unchanged_sources_accept_inline_tags_and_heading_links() {
    let expected = reference();
    for view in expected["views"].as_array().unwrap() {
        let (_, mut a, _) = configured();
        let source = expected["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|source| source["command"] == view["command"])
            .unwrap()["source"]
            .as_str()
            .unwrap();
        a.create(11, "Views/actual.base", source);
        for (index, record) in expected["records"].as_array().unwrap().iter().enumerate() {
            let raw = format!(
                "{}\nBody #other [[note#heading]]",
                record["source"].as_str().unwrap()
            );
            a.create((index + 1) as u8, record["path"].as_str().unwrap(), &raw);
        }
        settle(&mut [&mut a]);
        a.clock.set(expected["now_ms"].as_u64().unwrap());
        let hints = BTreeMap::from_iter([
            ("due".into(), "date".into()),
            ("scheduled".into(), "date".into()),
        ]);
        let input =
            a.r.capture_bases_execution_inputs(
                select(11, source, view["index"].as_u64().unwrap() as u32),
                Some(&hints),
                Some("UTC"),
            )
            .unwrap();
        let result =
            a.r.execute_captured_bases_view(input, policies(), &|| false)
                .unwrap();
        assert_eq!(
            result.rows.len(),
            view["matched"].as_array().unwrap().len(),
            "{}",
            view["name"]
        );
    }
}
fn simple(source: &str) -> Node {
    let (_, mut a, _) = configured();
    a.create(11, "View.base", source);
    a.create(
        1,
        "Task.md",
        "---\nstatus: open\n---\n```\n#still-unqualified-rich-markdown\n```",
    );
    settle(&mut [&mut a]);
    a
}
#[test]
fn unavailable_display_slots_execute_but_semantic_or_formula_use_refuses_before_rows() {
    let source = "views: [{type: table, order: [status, file.tasks, file.ctime, file.tags], sort: [{column: status}]}]\n";
    let mut a = simple(source);
    let input = a
        .r
        .capture_bases_execution_inputs(select(11, source, 0), Some(&BTreeMap::new()), Some("UTC"))
        .unwrap();
    let result =
        a.r.execute_captured_bases_view(input, policies(), &|| false)
            .unwrap();
    assert_eq!(
        result.unavailable_columns,
        vec![
            (1, "file_field"),
            (2, "file_time_not_captured"),
            (3, "file_tags_not_captured")
        ]
    );
    for source in [
        "filters: false && file.tasks\nviews: [{type: table, order: [status]}]\n",
        "formulas: {x: file.tasks}\nviews: [{type: table, order: [status], sort: [{column: formula.x}]}]\n",
        "views: [{type: table, order: [status], groupBy: {property: file.ctime}}]\n",
    ] {
        let mut a = simple(source);
        let input =
            a.r.capture_bases_execution_inputs(
                select(11, source, 0),
                Some(&BTreeMap::new()),
                Some("UTC"),
            )
            .unwrap();
        assert!(
            a.r.execute_captured_bases_view(input, policies(), &|| false)
                .is_err()
        );
    }
}
#[test]
fn semantic_errors_cancellation_sticky_budget_and_missing_policy_suppress_whole_result() {
    for source in [
        "filters: date('not-a-date').isTruthy()\nviews: [{type: table, order: [status]}]\n",
        "views: [{type: table, order: [status]}]\n",
    ] {
        let mut a = simple(source);
        let input =
            a.r.capture_bases_execution_inputs(
                select(11, source, 0),
                Some(&BTreeMap::new()),
                Some("UTC"),
            )
            .unwrap();
        assert!(
            a.r.execute_captured_bases_view(input, policies(), &|| true)
                .is_err()
        );
        if source.starts_with("filters") {
            let input =
                a.r.capture_bases_execution_inputs(
                    select(11, source, 0),
                    Some(&BTreeMap::new()),
                    Some("UTC"),
                )
                .unwrap();
            assert!(
                a.r.execute_captured_bases_view(input, policies(), &|| false)
                    .is_err()
            );
        }
        let mut input =
            a.r.capture_bases_execution_inputs(
                select(11, source, 0),
                Some(&BTreeMap::new()),
                Some("UTC"),
            )
            .unwrap();
        input.exhaust_for_test();
        assert!(
            a.r.execute_captured_bases_view(input, policies(), &|| false)
                .is_err()
        );
        let input =
            a.r.capture_bases_execution_inputs(
                select(11, source, 0),
                Some(&BTreeMap::new()),
                Some("UTC"),
            )
            .unwrap();
        let mut policy = policies();
        policy.inventory_ties = false;
        assert!(
            a.r.execute_captured_bases_view(input, policy, &|| false)
                .is_err()
        );
    }
}
