use super::*;
use r::api::ContractQuery;
use r::log::{LogPort, LogPush};
use r::replica::BasesReadRequest;
use std::collections::BTreeSet;
use w::common::Value;

const VIEW: &str =
    "views:\n  - type: table\n    filters: \"note.status == 'open'\"\n    order: [file.name]\n";

fn record_id(number: u32) -> B16 {
    B16(u128::from(number).to_be_bytes())
}

fn include() -> w::client::Include {
    w::client::Include {
        effective: None,
        body: None,
        document: None,
        diagnostics: None,
    }
}

#[test]
fn a_large_import_keeps_views_and_typed_cursor_pages_available_without_reopen() {
    let service = log();
    let dir = scratch("large-import-views-and-pages");
    let (mut writer, author, _) = open(&dir.join("writer.db"), Rc::new(Probe::default()));
    settle(&mut writer, &service);
    let mut resources = resource_ops();
    for (path, source) in [
        (
            "_contracts/source.md",
            "---\nkind: mdbase.contract\ncontract_type: record\nid: dev.mdbase.reader.source\nversion: 1.0.0\nrecord_schema:\n  dialect: json-schema-2020-12\n  value: {type: object, properties: {status: {type: string}}}\n---\n",
        ),
        (
            "_types/source.md",
            "---\nkind: mdbase.type\nname: reader-source\nmatch: {path_glob: 'sources/*.md'}\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object, properties: {status: {type: string}}}\nimplements:\n  - contract: dev.mdbase.reader.source\n    version: '1.0.0'\n    fields: {'/status': '/status'}\n---\n",
        ),
    ] {
        resources.push(Op::ResourcePut(ResourcePut {
            path: path.into(),
            doc: source.into(),
            base_revision: None,
            must_not_exist: None,
        }));
    }
    submit(&mut writer, author, resources, 21);
    settle(&mut writer, &service);
    submit(
        &mut writer,
        author,
        vec![create(SOURCE_ID, SOURCE_PATH, VIEW)],
        22,
    );
    settle(&mut writer, &service);
    let (mut app, session, _) = open(&dir.join("app.db"), Rc::new(Probe::default()));
    settle(&mut app, &service);
    for (mutation, range) in [(23, 1..=312), (24, 313..=1000)] {
        let ops = range
            .map(|number| {
                create(
                    record_id(number),
                    &format!("sources/{number:04}.md"),
                    "---\nstatus: open\n---\n",
                )
            })
            .collect();
        let previous = app.head().seq;
        submit(&mut writer, author, ops, mutation);
        settle(&mut writer, &service);
        let (head, head_chain) = service.head(&COLLECTION);
        app.on_log_push(LogPush::Head {
            collection: COLLECTION,
            head,
            head_chain,
        });
        settle(&mut app, &service);
        assert_eq!(app.head().seq, previous + 1);
    }
    let expected: BTreeSet<_> = (1..=1000).map(record_id).collect();
    app.encode_indexed_bases_read_request(
        session,
        BasesReadRequest {
            selection: BasesViewSelection {
                record: SOURCE_ID,
                revision: w::hash::sha256(VIEW.as_bytes()),
                index: 0,
            },
            property_types: &Default::default(),
            timezone: "UTC",
            window: None,
        },
        |result| {
            assert_eq!(
                result
                    .rows
                    .iter()
                    .map(|row| row.record)
                    .collect::<BTreeSet<_>>(),
                expected
            );
            Ok(0)
        },
        |_, _| Ok(vec![]),
    )
    .unwrap();

    let types = (
        "types".into(),
        Value::List(vec![Value::Text("reader-source".into())]),
    );
    let unbounded = app
        .query(session, Value::Map(vec![types.clone()]), include())
        .unwrap_err();
    assert_eq!(
        unbounded.problem().reason.as_deref(),
        Some("query_budget_exceeded")
    );
    let exact = app
        .query(
            session,
            Value::Map(vec![
                types.clone(),
                (
                    "where".into(),
                    Value::Text("file.path == 'sources/0999.md'".into()),
                ),
                ("limit".into(), Value::Int(1)),
            ]),
            include(),
        )
        .unwrap();
    assert!(
        exact
            .records
            .iter()
            .map(|record| record.id)
            .eq([record_id(999)])
    );
    for contract in [true, false] {
        let mut cursor = None;
        let mut seen = BTreeSet::new();
        loop {
            let page = if contract {
                let result = app
                    .query_contract(
                        session,
                        ContractQuery {
                            contract: "dev.mdbase.reader.source".into(),
                            version: "1.0.0".into(),
                            limit: 128,
                            cursor,
                            where_: None,
                        },
                    )
                    .unwrap();
                assert!(
                    result.records.iter().map(|row| row.id).eq(result
                        .page
                        .records
                        .iter()
                        .map(|row| row.id))
                );
                result.page
            } else {
                let mut query = vec![types.clone(), ("limit".into(), Value::Int(500))];
                if let Some(token) = cursor {
                    query.push(("cursor".into(), Value::Text(token)));
                }
                app.query(session, Value::Map(query), include()).unwrap()
            };
            assert!(
                page.complete
                    && !page.records.is_empty()
                    && page.records.len() <= if contract { 128 } else { 500 }
            );
            assert!(page.records.iter().all(|record| seen.insert(record.id)));
            cursor = page.cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(seen, expected);
    }
}
