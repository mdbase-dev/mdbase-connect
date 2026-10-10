use super::*;
#[test]
fn optional_window_shared_bytes_and_placements_preserve_absent_full_shape() {
    use mdbn_replica::replica::{BasesGroupPlacement, BasesWindowInfo};
    let fixture = mdbn_core::yaml::parse_value(include_str!(
        "../../../../../conformance/views/bases-app-window-codec.json"
    ))
    .unwrap()
    .unwrap();
    for (index, case) in fixture
        .get("cases")
        .unwrap()
        .as_list()
        .unwrap()
        .iter()
        .enumerate()
    {
        let requested = BasesExecutionWindow {
            offset: if index == 0 { 0 } else { 2 },
            limit: 200,
        };
        let request =
            Request::decode(&hex(case.get("request_hex").unwrap().as_str().unwrap())).unwrap();
        assert_eq!(request.window, Some(requested));
        let mut output = result();
        if index != 0 {
            output.rows.clear();
            output.groups.clear();
        }
        output.window = Some(BasesWindowInfo {
            request: requested,
            total_rows: 1,
            groups: if index == 0 {
                vec![BasesGroupPlacement {
                    ordinal: 0,
                    total_rows: 1,
                    row_ordinals: vec![0],
                }]
            } else {
                vec![]
            },
        });
        assert_eq!(
            encode(&output).unwrap(),
            hex(case.get("success_hex").unwrap().as_str().unwrap())
        );
    }
    assert!(
        Request::decode(&hex(super::tests::fixture()
            .get("request_hex")
            .unwrap()
            .as_str()
            .unwrap()))
        .unwrap()
        .window
        .is_none()
    );
}
#[test]
fn window_bounds_shape_and_group_ordinals_refuse_without_cap_lift() {
    use mdbn_replica::replica::{BasesGroupPlacement, BasesWindowInfo};
    let data = fixture();
    let Cbor::Map(mut request) =
        cbor::decode(&hex(data.get("request_hex").unwrap().as_str().unwrap())).unwrap()
    else {
        panic!("map")
    };
    request.push((
        Cbor::Uint(6),
        Cbor::Map(vec![
            (Cbor::Uint(0), Cbor::Uint(0)),
            (Cbor::Uint(1), Cbor::Uint(0)),
        ]),
    ));
    assert!(Request::decode(&cbor::encode(&Cbor::Map(request.clone())).unwrap()).is_err());
    for limit in [65_537, u64::MAX] {
        request.last_mut().unwrap().1 = Cbor::Map(vec![
            (Cbor::Uint(0), Cbor::Uint(0)),
            (Cbor::Uint(1), Cbor::Uint(limit)),
        ]);
        assert!(Request::decode(&cbor::encode(&Cbor::Map(request.clone())).unwrap()).is_err());
    }
    let mut output = result();
    output.window = Some(BasesWindowInfo {
        request: BasesExecutionWindow {
            offset: 0,
            limit: 200,
        },
        total_rows: 1,
        groups: vec![BasesGroupPlacement {
            ordinal: 0,
            total_rows: 1,
            row_ordinals: vec![0],
        }],
    });
    assert!(encode(&output).is_ok());
    output.window.as_mut().unwrap().groups[0].row_ordinals[0] = 1;
    assert!(encode(&output).is_err());
    output.window.as_mut().unwrap().groups[0]
        .row_ordinals
        .clear();
    assert!(encode(&output).is_err());
    output.window.as_mut().unwrap().total_rows = 65_537;
    assert!(encode(&output).is_err());
}
use mdbn_core::{
    value::Value,
    views::bases::{
        BasesTimezone, DateValue, DurationValue, EvaluatedDate, EvaluatedDuration, WorkBudget,
    },
};
use mdbn_replica::replica::{
    BasesExecutionGroup, BasesExecutionRow, BasesImplementationDescriptor, BasesViewDescriptor,
};
fn fixture() -> Value {
    mdbn_core::yaml::parse_value(include_str!(
        "../../../../../conformance/views/bases-app-codec.json"
    ))
    .unwrap()
    .unwrap()
}
fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
fn cell(name: &str) -> BasesDisplayCell {
    let value = match name {
        "null" => RuntimeValue::Null,
        "boolean" => RuntimeValue::Bool(true),
        "number" => RuntimeValue::Number(1.25),
        "negative-zero" => RuntimeValue::Number(-0.0),
        "text" => RuntimeValue::String("hello".into()),
        "date-utc" | "date-fixed" | "date-named" | "date-alias" => {
            let zone = match name {
                "date-utc" => "UTC",
                "date-fixed" => "+05:45",
                "date-named" => "America/New_York",
                _ => "US/Eastern",
            };
            let mut work = WorkBudget::new();
            let zone = BasesTimezone::capture(zone, &mut work).unwrap();
            RuntimeValue::Date(
                EvaluatedDate::new(
                    DateValue::parse("2026-06-10", zone, &mut work).unwrap(),
                    &mut work,
                )
                .unwrap(),
            )
        }
        "duration" => {
            let mut work = WorkBudget::new();
            RuntimeValue::Duration(
                EvaluatedDuration::new(DurationValue::parse("1h", &mut work).unwrap(), &mut work)
                    .unwrap(),
            )
        }
        "list" => RuntimeValue::List(vec![
            RuntimeValue::Null,
            RuntimeValue::Bool(true),
            RuntimeValue::String("x".into()),
        ]),
        "map" => RuntimeValue::Object(BTreeMap::from([
            ("a".into(), RuntimeValue::Null),
            ("b".into(), RuntimeValue::String("x".into())),
        ])),
        "error" => RuntimeValue::Error("source error".into()),
        "unavailable" => {
            return BasesDisplayCell::Unavailable {
                code: "view_metadata_unavailable",
                detail: "file_tasks_unqualified",
            };
        }
        "nonfinite" => RuntimeValue::Number(f64::INFINITY),
        _ => panic!("unknown fixed fixture case"),
    };
    BasesDisplayCell::Value(value)
}
fn result() -> BasesExecutionResult {
    let data = fixture();
    let cases = data.get("cells").unwrap().as_list().unwrap();
    BasesExecutionResult {
        window: None,
        view: BasesViewDescriptor {
            record: B16([0x11; 16]),
            path: "TaskNotes/Views/example.base".into(),
            revision: B32([0x22; 32]),
            index: 3,
            name: Some("Example".into()),
            view_type: "table".into(),
            implementations: vec![BasesImplementationDescriptor {
                type_name: "obsidian_base".into(),
                version: "1".into(),
                contract_digest: B32([0x44; 32]),
                implementation_digest: B32([0x55; 32]),
            }],
        },
        clock: mdbn_core::intent::OpClock {
            instant_ms: 1781075828070,
            tz: "UTC".into(),
            local_date: "2026-06-10".into(),
        },
        collection_revision: B32([0x33; 32]),
        columns: (0..cases.len())
            .map(|i| PropertySelector::Note(format!("col{i}")))
            .collect(),
        unavailable_columns: vec![(13, "file_tasks_unqualified")],
        rows: vec![BasesExecutionRow {
            record: B16([0x66; 16]),
            path: "Tasks/example.md".into(),
            revision: B32([0x77; 32]),
            cells: cases
                .iter()
                .map(|v| cell(v.get("case").unwrap().as_str().unwrap()))
                .collect(),
        }],
        groups: vec![BasesExecutionGroup {
            key: RuntimeValue::String("open".into()),
            rows: vec![0],
        }],
    }
}
#[test]
fn shared_native_bytes_cover_all_cell_tags_and_authoritative_zone_aliases() {
    for case in fixture().get("cells").unwrap().as_list().unwrap() {
        let mut writer = Writer {
            output: Some(vec![]),
            size: 0,
        };
        writer
            .cell(&cell(case.get("case").unwrap().as_str().unwrap()))
            .unwrap();
        let expected = hex(case.get("hex").unwrap().as_str().unwrap());
        assert_eq!(writer.output.unwrap(), expected, "{:?}", case.get("case"));
        assert!(cbor::decode(&expected).is_ok());
    }
}
#[test]
fn exact_request_success_and_direct_problem_clock_grammar_match_shared_bytes() {
    let data = fixture();
    let request =
        Request::decode(&hex(data.get("request_hex").unwrap().as_str().unwrap())).unwrap();
    assert_eq!(request.selection.record, B16([0x11; 16]));
    assert_eq!(request.selection.revision, B32([0x22; 32]));
    assert_eq!(request.selection.index, 3);
    assert_eq!(request.zone, "UTC");
    assert_eq!(
        request.hints,
        BTreeMap::from([
            ("due".into(), "date".into()),
            ("scheduled".into(), "date".into())
        ])
    );
    let encoded = encode(&result()).unwrap();
    assert_eq!(
        encoded,
        hex(data.get("success_hex").unwrap().as_str().unwrap())
    );
    let Cbor::Map(success) = cbor::decode(&encoded).unwrap() else {
        panic!("success map")
    };
    assert!(!success.iter().any(|(k, _)| *k == Cbor::Uint(7)));
    let clock = success.iter().find(|(k, _)| *k == Cbor::Uint(5)).unwrap();
    let clock = mdbn_wire::intent::OpClock::from_cbor(&clock.1).unwrap();
    assert_eq!(clock.instant, 1781075828070);
    assert_eq!(clock.local_date, "2026-06-10");
    let bytes = refusal(invalid().into_problem());
    assert_eq!(
        bytes,
        hex(data.get("refusal_hex").unwrap().as_str().unwrap())
    );
    let Cbor::Map(refused) = cbor::decode(&bytes).unwrap() else {
        panic!("refusal map")
    };
    assert_eq!(refused.len(), 2);
    let problem = mdbn_wire::client::Problem::from_cbor(&refused[1].1).unwrap();
    assert_eq!(problem.code, "invalid_request");
    assert_eq!(problem.reason.as_deref(), Some("invalid_bases_request"));
}
#[test]
fn unknown_profile_duplicate_hints_shape_and_bounds_refuse_before_capture() {
    let data = fixture();
    let valid = hex(data.get("request_hex").unwrap().as_str().unwrap());
    assert!(Request::decode(&valid).is_ok());
    let Cbor::Map(map) = cbor::decode(&valid).unwrap() else {
        panic!("map")
    };
    for (key, replacement) in [
        (5, Cbor::Text("native-unproven".into())),
        (
            3,
            Cbor::Map(vec![
                (Cbor::Text("due".into()), Cbor::Text("date".into())),
                (Cbor::Text("due".into()), Cbor::Text("link".into())),
            ]),
        ),
        (3, Cbor::Array(vec![])),
        (2, Cbor::Uint(u64::MAX)),
        (4, Cbor::Text("x".repeat(129))),
    ] {
        let mut modified = map.clone();
        modified
            .iter_mut()
            .find(|(k, _)| *k == Cbor::Uint(key))
            .unwrap()
            .1 = replacement;
        // Duplicate-key encoding itself is rejected by the canonical codec.
        if let Ok(bytes) = cbor::encode(&Cbor::Map(modified)) {
            assert!(Request::decode(&bytes).is_err());
        }
    }
    assert!(Request::decode(&vec![0; MAX_REQUEST + 1]).is_err());
    let mut trailing = valid;
    trailing.push(0);
    assert!(Request::decode(&trailing).is_err());
}
#[test]
fn bounded_preflight_is_whole_refusal_not_partial_or_larger_frame() {
    let mut value = RuntimeValue::Null;
    for _ in 0..33 {
        value = RuntimeValue::List(vec![value]);
    }
    for value in [
        value,
        RuntimeValue::List(vec![RuntimeValue::Null; MAX_ITEMS + 1]),
        RuntimeValue::String("x".repeat(MAX_TEXT + 1)),
    ] {
        let mut writer = Writer {
            output: None,
            size: 0,
        };
        assert!(writer.value(&value, 1).is_err());
        assert!(writer.output.is_none());
    }
    let mut output = result();
    output.columns = vec![PropertySelector::Note("big".into())];
    output.unavailable_columns.clear();
    output.groups.clear();
    output.rows = (0..5000)
        .map(|_| BasesExecutionRow {
            record: B16([0x66; 16]),
            path: "Tasks/example.md".into(),
            revision: B32([0x77; 32]),
            cells: vec![BasesDisplayCell::Value(RuntimeValue::String(
                "x".repeat(MAX_TEXT),
            ))],
        })
        .collect();
    assert_eq!(
        encode(&output).unwrap_err().problem().reason.as_deref(),
        Some("view_codec_budget")
    );
    output.rows.truncate(1);
    output.rows[0].cells.clear();
    assert!(
        encode(&output).is_err(),
        "column shape mismatch must suppress all output"
    );
}
#[test]
fn unavailable_not_null_maps_sorted_and_nonfinite_is_explicit_error_data() {
    assert_eq!(
        column_name(&PropertySelector::Note("a.b\"c".into())),
        "note[\"a.b\\\"c\"]"
    );
    for number in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let mut writer = Writer {
            output: Some(vec![]),
            size: 0,
        };
        writer.value(&RuntimeValue::Number(number), 1).unwrap();
        assert_eq!(
            cbor::decode(&writer.output.unwrap()).unwrap(),
            Cbor::Array(vec![Cbor::Uint(8), Cbor::Text("non_finite_number".into())])
        );
    }
}
