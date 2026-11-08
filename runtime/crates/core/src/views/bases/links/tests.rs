use super::super::{
    Bindings, CapturedFile, CapturedFileBindings, DateGroupMode, NullOrder, OrderingCapture,
    Profile, Program, RuntimeValue, StringOrder, TypedSortRow, order_typed_rows, partition_typed,
};
use super::*;
use crate::ids::Uuid;
use crate::plan::Effect;
use crate::state::MemState;
use crate::value::{Map, Value};
use std::collections::BTreeMap;

const ORDERING: OrderingCapture = OrderingCapture {
    nulls: NullOrder::Last,
    strings: StringOrder::Utf16,
};

fn state(files: &[&str]) -> MemState {
    let mut state = MemState::new();
    for (index, path) in files.iter().enumerate() {
        let mut id = [0; 16];
        id[0] = index as u8 + 1;
        state.apply_effect(&Effect::PutRecord {
            id: Uuid(id),
            path: (*path).to_owned(),
            doc: "body\n".to_owned(),
        });
    }
    state
}

fn eval(
    source: &str,
    path: &str,
    property: Value,
    state: &MemState,
    memo: &BasesLinkMemo,
) -> Result<RuntimeValue, EvaluationFailure> {
    let mut budget = WorkBudget::new();
    let mut note = Map::new();
    note.insert("projects", property);
    let file = CapturedFile::new(path, Some(1), None, None, &mut budget)?;
    let file = CapturedFileBindings::capture(&file, None, &mut budget)?;
    Program::compile_with_profile(source, &BTreeMap::new(), Profile::TaskSlice1)
        .unwrap()
        .evaluate(
            Bindings::raw(&note)
                .with_file(file)
                .with_links(BasesLinks::new(state, memo)),
            &mut budget,
        )
}

/// Spellings Obsidian treats as links with no file behind them. The port has
/// no identity for these, so they refuse rather than join an invented group.
fn refused(text: &Value) -> bool {
    matches!(
        text.as_str(),
        Some("[[a]] and [[b]]" | "[[#head]]" | "[[]]" | "[[ P ]]")
    )
}

/// Obsidian collates with a locale and merges "" with an empty link; the
/// reference profile orders by UTF-16, so grouped rows are what must agree.
fn check_run(run: &Value) {
    let files = run.get("files").unwrap().as_list().unwrap();
    let files = files
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect::<Vec<_>>();
    let state = state(&files);
    let memo = BasesLinkMemo::default();
    let mut names = Vec::new();
    let mut values = Vec::new();
    for (name, spelled) in run.get("notes").unwrap().as_map().unwrap().iter() {
        let result = eval(
            "note[\"projects\"]",
            &format!("{name}.md"),
            spelled.clone(),
            &state,
            &memo,
        );
        if refused(spelled) {
            assert_eq!(
                result,
                Err(EvaluationFailure::UnsupportedConstruct("link_property")),
                "{spelled:?}"
            );
            continue;
        }
        names.push(name);
        values.push(result.unwrap());
    }
    let groups =
        partition_typed(&values, DateGroupMode::Unavailable, &mut WorkBudget::new()).unwrap();
    let mut actual = groups
        .iter()
        .map(|g| {
            let mut rows = g.rows.iter().map(|i| names[*i]).collect::<Vec<_>>();
            rows.sort_unstable();
            rows
        })
        .collect::<Vec<_>>();
    actual.sort();
    let mut observed = run
        .get("groups")
        .unwrap()
        .as_list()
        .unwrap()
        .iter()
        .map(|rows| {
            let mut rows = rows
                .as_list()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap())
                .filter(|name| names.contains(name))
                .collect::<Vec<_>>();
            rows.sort_unstable();
            rows
        })
        .filter(|rows| !rows.is_empty())
        .collect::<Vec<_>>();
    observed.sort();
    assert_eq!(actual, observed);
}

#[test]
fn groups_match_the_native_link_oracle() {
    let oracle = crate::yaml::parse_value(include_str!(
        "../../../../../../conformance/oracle/obsidian-1.12.7/links.observed.json"
    ))
    .unwrap()
    .unwrap();
    for run in oracle.get("runs").unwrap().as_list().unwrap() {
        check_run(run);
    }
}

#[test]
fn links_stay_written_text_and_answer_only_observed_questions() {
    let state = state(&["folder/P.md"]);
    let memo = BasesLinkMemo::default();
    let property = || Value::string("[[P#head|alias]]");
    let run = |source: &str, value: Value| eval(source, "a.md", value, &state, &memo);
    let link = run("note[\"projects\"]", property()).unwrap();
    assert_eq!(link.to_plain(), Value::string("[[P#head|alias]]"));
    assert_eq!(
        run("note[\"projects\"].isEmpty()", property()),
        Ok(RuntimeValue::Bool(false))
    );
    assert_eq!(
        run("note[\"projects\"].isType(\"link\")", property()),
        Ok(RuntimeValue::Bool(true))
    );
    assert_eq!(
        run("note[\"projects\"].toString()", property()),
        Ok(RuntimeValue::String("[[P#head|alias]]".into()))
    );
    assert_eq!(
        run("if(note[\"projects\"], 1, 2)", property()),
        Ok(RuntimeValue::Number(1.0))
    );
    let listed = || Value::List(vec![property(), Value::string("plain")]);
    assert_eq!(
        run("note[\"projects\"].length", listed()),
        Ok(RuntimeValue::Number(2.0))
    );
    assert_eq!(
        run("note[\"projects\"].isEmpty()", listed()),
        Ok(RuntimeValue::Bool(false))
    );
    for source in [
        "note[\"projects\"] == \"[[P]]\"",
        "note[\"projects\"] != \"[[P]]\"",
        "\"x\" + note[\"projects\"]",
        "note[\"projects\"] + 1",
        "-note[\"projects\"]",
        "note[\"projects\"] > 1",
        "note[\"projects\"].length",
        "note[\"projects\"].contains(\"P\")",
        "\"P\".contains(note[\"projects\"])",
        "duration(note[\"projects\"])",
        "number(note[\"projects\"])",
        "file.inFolder(note[\"projects\"])",
    ] {
        assert_eq!(
            run(source, property()),
            Err(EvaluationFailure::UnsupportedConstruct("link_property")),
            "{source}"
        );
    }
    for source in [
        "note[\"projects\"].contains(\"[[P]]\")",
        "note[\"projects\"].join(\",\")",
        "note[\"projects\"].map(value)",
        "note[\"projects\"].toString()",
        "note[\"projects\"][0]",
    ] {
        assert_eq!(
            run(source, listed()),
            Err(EvaluationFailure::UnsupportedConstruct("link_property")),
            "{source}"
        );
    }
}

#[test]
fn ambiguous_links_render_but_refuse_to_join_a_group_or_order() {
    // Only path-key-equivalent winners survive every tiebreaker.
    let state = state(&["a/P.md", "A/P.md"]);
    let memo = BasesLinkMemo::default();
    let value = eval(
        "note[\"projects\"]",
        "n.md",
        Value::string("[[P]]"),
        &state,
        &memo,
    )
    .unwrap();
    let RuntimeValue::Link(link) = &value else {
        panic!("{value:?}")
    };
    assert_eq!(link.source(), "[[P]]");
    let keys = [value.clone()];
    assert_eq!(
        partition_typed(&keys, DateGroupMode::Unavailable, &mut WorkBudget::new()).err(),
        Some(EvaluationFailure::MetadataUnavailable("link_resolution"))
    );
    let row = [TypedSortRow { keys: &keys }];
    assert!(
        order_typed_rows(
            &row,
            &[crate::views::bases::SortDirection::Asc],
            ORDERING,
            &mut WorkBudget::new()
        )
        .is_err()
    );
}

#[test]
fn the_same_spelling_groups_by_the_file_each_source_folder_reaches() {
    let state = state(&["a/P.md", "b/P.md"]);
    let memo = BasesLinkMemo::default();
    let value = |path| {
        eval(
            "note[\"projects\"]",
            path,
            Value::string("[[P]]"),
            &state,
            &memo,
        )
        .unwrap()
    };
    let keys = [value("a/n.md"), value("b/n.md"), value("a/m.md")];
    let groups =
        partition_typed(&keys, DateGroupMode::Unavailable, &mut WorkBudget::new()).unwrap();
    assert_eq!(
        groups.iter().map(|g| g.rows.clone()).collect::<Vec<_>>(),
        vec![vec![0, 2], vec![1]]
    );
}

#[test]
fn memo_reuses_a_resolution_and_stays_inside_its_ceiling() {
    let state = state(&["folder/P.md"]);
    let memo = BasesLinkMemo::default();
    for path in ["a.md", "b.md", "c.md"] {
        eval(
            "note[\"projects\"]",
            path,
            Value::string("[[P]]"),
            &state,
            &memo,
        )
        .unwrap();
    }
    assert_eq!(memo.resolved.borrow().len(), 1);
    memo.bytes.set(MAX_BASES_LINK_MEMO_BYTES);
    eval(
        "note[\"projects\"]",
        "a.md",
        Value::string("[[folder/P]]"),
        &state,
        &memo,
    )
    .unwrap();
    assert_eq!(memo.resolved.borrow().len(), 1);
}

#[test]
fn unbound_rows_still_refuse_link_properties() {
    let mut note = Map::new();
    note.insert("projects", Value::string("[[P]]"));
    assert_eq!(
        Program::compile_with_profile("note[\"projects\"]", &BTreeMap::new(), Profile::TaskSlice1)
            .unwrap()
            .evaluate(Bindings::raw(&note), &mut WorkBudget::new()),
        Err(EvaluationFailure::UnsupportedConstruct("link_property"))
    );
}

#[test]
fn only_spellings_with_an_exact_round_trip_are_link_values() {
    for text in [
        "[[P]]",
        "[[P#h]]",
        "[[P|a]]",
        "[[a/P.md#h|b|c]]",
        "[[Person [draft]]]",
    ] {
        assert!(property_link(text).is_some(), "{text}");
    }
    for text in [
        "[[]]",
        "[[#head]]",
        "[[ P ]]",
        "[[P ]]",
        "[[a]] and [[b]]",
        "[[https://example.com]]",
    ] {
        assert!(property_link(text).is_none(), "{text}");
    }
}
