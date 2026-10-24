//! Ambiguity means the canonical configured-ID conflict, not duplicate stems.
use super::*;

#[test]
fn native_asfile_ambiguous_configured_id_stays_aligned_null() {
    let path = scratch("native-asfile-id-ambiguity").join("state.db");
    let (mut app, session, _index) = open(&path, Rc::new(Probe::default()));
    let service = log();
    settle(&mut app, &service);
    submit(
        &mut app,
        session,
        vec![
            Op::ResourcePut(ResourcePut {
                path: "mdbase.yaml".into(),
                doc: w::common::Text::Inline(
                    "spec_version: '0.3.0'\nsettings:\n  id_field: id\n".into(),
                ),
                base_revision: None,
                must_not_exist: None,
            }),
            create(
                B16([21; 16]),
                "Tasks/First.md",
                "---\nCrew Links:\n - '[[shared-id]]'\n - '[[People/Alex|Alias]]'\n---\n",
            ),
            create(
                B16([22; 16]),
                "People/Alex.md",
                "---\nid: shared-id\nname: Alex\n---\n",
            ),
            create(
                B16([23; 16]),
                "People/Sam.md",
                "---\nid: shared-id\nname: Sam\n---\n",
            ),
        ],
        46,
    );
    settle(&mut app, &service);
    let result = app.query(session, Value::Map(vec![
        ("where".into(), Value::Text("file.path == 'Tasks/First.md'".into())),
        ("select".into(), Value::List(vec![
            selection("raw", "raw['Crew Links']"),
            selection("targets", "raw['Crew Links'].map(l, l.asFile() == null ? null : l.asFile().file.path)"),
        ])),
    ]), include()).unwrap();
    let values = result.records[0].values.as_ref().unwrap();
    assert_eq!(
        values.get("raw"),
        Some(&Value::List(vec![
            Value::Text("[[shared-id]]".into()),
            Value::Text("[[People/Alex|Alias]]".into())
        ]))
    );
    assert_eq!(
        values.get("targets"),
        Some(&Value::List(vec![
            Value::Null,
            Value::Text("People/Alex.md".into())
        ]))
    );
}
