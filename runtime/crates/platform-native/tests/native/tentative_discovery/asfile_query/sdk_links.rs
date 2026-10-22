//! Exact SDK-generated query fixture evaluated by the actual original native
//! SQLite/TentativeStore producer, not a second CEL compiler or SDK resolver.
use super::*;
use w::schema::Wire;

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    let Value::Map(fields) = value else {
        panic!("fixture map")
    };
    &fields.iter().find(|(name, _)| name == key).unwrap().1
}
fn text(value: &Value) -> &str {
    let Value::Text(value) = value else {
        panic!("fixture text")
    };
    value
}
fn strings(values: &[&str]) -> Value {
    Value::List(
        values
            .iter()
            .map(|value| Value::Text((*value).into()))
            .collect(),
    )
}

#[test]
fn sdk_record_links_exact_generated_query_shapes_match_native_projection() {
    let hex = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/sdk/test/fixtures/native-record-links-query.hex"
    ))
    .trim();
    let bytes = (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap())
        .collect::<Vec<_>>();
    let fixture = Value::from_cbor(&w::cbor::decode(&bytes).unwrap()).unwrap();
    let Value::List(cases) = field(&fixture, "cases") else {
        panic!("fixture cases")
    };
    assert_eq!(cases.len(), 9);
    let path = scratch("sdk-record-links-exact-native-query").join("state.db");
    let (mut app, session, _index) = open(&path, Rc::new(Probe::default()));
    let service = log();
    settle(&mut app, &service);
    submit(
        &mut app,
        session,
        vec![
            create(B16([21; 16]), "People/Alex.md", "---\nname: Alex\n---\n"),
            create(
                B16([22; 16]),
                "Tasks/List.md",
                "---\nCrew Links: ['[[People/Alex|Alias]]', '[[Missing]]', '[[People/Alex|Alias]]']\n---\n",
            ),
            create(
                B16([23; 16]),
                "Tasks/Scalar.md",
                "---\nCrew Links: '[[People/Alex|Alias]]'\n---\n",
            ),
            create(
                B16([24; 16]),
                "Tasks/Null.md",
                "---\nCrew Links: null\n---\n",
            ),
            create(B16([25; 16]), "Tasks/Absent.md", "---\nother: value\n---\n"),
            create(
                B16([26; 16]),
                "Tasks/Empty.md",
                "---\nCrew Links: []\n---\n",
            ),
            create(
                B16([27; 16]),
                "Tasks/Flat.md",
                "---\ncrew.links: '[[People/Alex|Alias]]'\ncrew: {links: '[[Wrong]]'}\n---\n",
            ),
            create(
                B16([28; 16]),
                "Tasks/Quoted'☃.md",
                "---\n'Crew\"\\Links☃': '[[People/Alex|Alias]]'\n---\n",
            ),
            create(
                B16([29; 16]),
                "Tasks/Invalid.md",
                "---\nCrew Links: ['[[People/Alex]]', 42]\n---\n",
            ),
        ],
        45,
    );
    settle(&mut app, &service);
    // Establish the fixture write set actually landed before evaluating CEL;
    // canonical paths reject double quotes (all creates are one atomic intent).
    let source = app
        .query(
            session,
            Value::Map(vec![(
                "where".into(),
                Value::Text("file.path == 'Tasks/List.md'".into()),
            )]),
            include(),
        )
        .unwrap();
    assert_eq!(
        source.records.len(),
        1,
        "confirmed fixture source must exist"
    );
    for case in cases {
        let name = text(field(case, "name"));
        let result = app
            .query(session, field(case, "query").clone(), include())
            .unwrap();
        assert!(result.complete, "{name}");
        assert!(result.cursor.is_none(), "{name}");
        assert_eq!(
            result.columns,
            Some(vec!["raw".into(), "paths".into()]),
            "{name}"
        );
        if name == "missing" {
            assert!(result.records.is_empty());
            continue;
        }
        assert_eq!(result.records.len(), 1, "{name}");
        assert_eq!(result.records[0].path, text(field(case, "path")), "{name}");
        let values = result.records[0].values.as_ref().unwrap();
        if name == "invalid" {
            assert_eq!(values.get("paths"), Some(&Value::Null));
            assert!(
                result
                    .diagnostics
                    .as_ref()
                    .unwrap()
                    .iter()
                    .any(|issue| issue.code == "expression_evaluation_error")
            );
            continue;
        }
        assert!(
            result.diagnostics.as_ref().is_none_or(Vec::is_empty),
            "{name}: expression diagnostics"
        );
        let (raw, paths) = match name {
            "list" => (
                strings(&[
                    "[[People/Alex|Alias]]",
                    "[[Missing]]",
                    "[[People/Alex|Alias]]",
                ]),
                Value::List(vec![
                    Value::Text("People/Alex.md".into()),
                    Value::Null,
                    Value::Text("People/Alex.md".into()),
                ]),
            ),
            "scalar" | "flat" | "quoted" => (
                Value::Text("[[People/Alex|Alias]]".into()),
                strings(&["People/Alex.md"]),
            ),
            "null" | "absent" => (Value::Null, strings(&[])),
            "empty" => (strings(&[]), strings(&[])),
            _ => panic!("unexpected fixture case"),
        };
        assert_eq!(values.get("raw"), Some(&raw), "{name}");
        assert_eq!(values.get("paths"), Some(&paths), "{name}");
    }
    assert_eq!(app.store().pending_count().unwrap(), 0);
}
