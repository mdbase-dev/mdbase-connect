//! Original TaskNotes generator bytes over real Disposable SQLite and signed sync.
//! Exercises Replica admission/execution, not actual browser/OPFS/WASM codec or
//! native UI/CRUD qualification. Ordering uses the explicit reference policy.
use super::*;
use mdbn_core::views::bases::{DateGroupMode, NullOrder, OrderingCapture, StringOrder};
use r::replica::{BasesExecutionPolicies, BasesExecutionWindow, BasesReadRequest};
use std::collections::BTreeMap;

#[test]
fn large_bases_reads_and_windows_respect_app_parameter_limit() {
    let path = scratch("bases_app_parameter_limit").join("app.db");
    let service = log();
    let probe = Rc::new(Probe::default());
    let (mut app, session, _) = open(&path, probe.clone());
    settle(&mut app, &service);
    configure_resources(&mut app, session, &service);
    let source = "views:\n  - type: table\n    filters: \"note.status == 'open'\"\n    order: [file.name, note.priority]\n    sort: [{property: file.name, direction: ASC}]\n";
    submit(
        &mut app,
        session,
        vec![create(SOURCE_ID, SOURCE_PATH, source)],
        40,
    );
    settle(&mut app, &service);
    for start in (0u16..501).step_by(25) {
        let ops = (start..(start + 25).min(501))
            .map(|number| {
                let mut bytes = [64; 16];
                bytes[14..].copy_from_slice(&number.to_be_bytes());
                create(
                    B16(bytes),
                    &format!("tasks/{number:04}.md"),
                    &format!(
                        "---\nstatus: open\npriority: {}\ntags: [task, test]\n---\n",
                        number % 4
                    ),
                )
            })
            .collect();
        submit(
            &mut app,
            session,
            ops,
            41 + u8::try_from(start / 25).unwrap(),
        );
        settle(&mut app, &service);
    }
    probe.enforce_codec.set(true);
    let hints = BTreeMap::new();
    let mut full = Vec::new();
    for window in [
        None,
        Some(BasesExecutionWindow {
            offset: 0,
            limit: 501,
        }),
        Some(BasesExecutionWindow {
            offset: 97,
            limit: 250,
        }),
    ] {
        app.encode_indexed_bases_read_request(
            session,
            BasesReadRequest {
                selection: BasesViewSelection {
                    record: SOURCE_ID,
                    revision: w::hash::sha256(source.as_bytes()),
                    index: 0,
                },
                property_types: &hints,
                timezone: "UTC",
                window,
                row_properties: None,
            },
            |result| {
                let ids = result.rows.iter().map(|row| row.record).collect::<Vec<_>>();
                match window {
                    None => {
                        assert_eq!(ids.len(), 501);
                        full = ids;
                    }
                    Some(window) => assert_eq!(
                        ids,
                        full[window.offset as usize..(window.offset + window.limit) as usize]
                    ),
                }
                Ok(1)
            },
            |_, size| Ok(vec![0; size]),
        )
        .unwrap();
    }
}

#[test]
fn all_five_original_default_sources_execute_through_both_native_capture_paths() {
    let path = scratch("tentative-host-default-views").join("app.db");
    let service = log();
    let (mut app, session, _) = open(&path, Rc::new(Probe::default()));
    settle(&mut app, &service);
    configure_resources(&mut app, session, &service);
    // Exported without modification from taskNotesDefaultBaseSources(default
    // configuration) at TaskNotes 2ac754c6. Source is not adapted to admission.
    let fixture =
        mdbn_core::yaml::parse_value(include_str!("../fixtures/tasknotes-default-bases.json"))
            .unwrap()
            .unwrap();
    let sources = fixture.as_list().unwrap();
    assert_eq!(sources.len(), 5);
    submit(
        &mut app,
        session,
        sources
            .iter()
            .enumerate()
            .map(|(i, source)| {
                create(
                    B16([60 + u8::try_from(i).unwrap(); 16]),
                    source.get("path").unwrap().as_str().unwrap(),
                    source.get("document").unwrap().as_str().unwrap(),
                )
            })
            .collect(),
        25,
    );
    settle(&mut app, &service);
    let head = app.store().head().unwrap();
    assert_eq!(app.store().record_count().unwrap(), 5);
    let discovered = views(&mut app, session);
    assert_eq!(discovered.len(), 5);
    let hints = BTreeMap::new();
    for (i, source) in sources.iter().enumerate() {
        let id = B16([60 + u8::try_from(i).unwrap(); 16]);
        let path = source.get("path").unwrap().as_str().unwrap();
        let document = source.get("document").unwrap().as_str().unwrap();
        let name = source.get("name").unwrap().as_str().unwrap();
        let selection = BasesViewSelection {
            record: id,
            revision: w::hash::sha256(document.as_bytes()),
            index: 0,
        };
        assert!(
            discovered.iter().any(
                |(record, actual_path, revision, ordinal, actual_name)| *record == id
                    && actual_path == path
                    && *revision == selection.revision
                    && *ordinal == 0
                    && actual_name.as_deref() == Some(name)
            )
        );
        let read = app
            .encode_bases_view_source(session, selection, Some("UTC"), |_, result, _| {
                Ok(result.source.clone())
            })
            .unwrap();
        assert_eq!(read, document, "never rewrite the original source");
        let input = app
            .capture_bases_execution_inputs(selection, Some(&hints), Some("UTC"))
            .unwrap();
        let result = app
            .execute_captured_bases_view(
                input,
                BasesExecutionPolicies {
                    ordering: OrderingCapture {
                        nulls: NullOrder::Last,
                        strings: StringOrder::Utf16,
                    },
                    date_groups: DateGroupMode::Unavailable,
                    inventory_ties: true,
                },
                &|| false,
            )
            .unwrap();
        assert_eq!(result.view.record, id);
        assert_eq!(result.view.revision, selection.revision);
        assert_eq!(result.view.path, path);
        assert_eq!(result.view.name.as_deref(), Some(name));
        assert!(result.rows.is_empty() && result.groups.is_empty()); // Same empty-task scenario, not missing inventory.
        assert!(!result.columns.is_empty());
        for window in [
            None,
            Some(BasesExecutionWindow {
                offset: 0,
                limit: 200,
            }),
        ] {
            let encoded = app
                .encode_indexed_bases_read_request(
                    session,
                    BasesReadRequest {
                        selection,
                        property_types: &hints,
                        timezone: "UTC",
                        window,
                        row_properties: None,
                    },
                    |result| {
                        assert_eq!(result.view.record, id);
                        assert_eq!(result.view.path, path);
                        assert_eq!(result.view.revision, selection.revision);
                        assert_eq!(result.view.name.as_deref(), Some(name));
                        assert!(result.rows.is_empty() && result.groups.is_empty());
                        assert_eq!(result.window.is_some(), window.is_some());
                        Ok(1)
                    },
                    |_, size| Ok(vec![0; size]),
                )
                .unwrap();
            assert_eq!(encoded.len(), 1); // Checked callback, not production wire qualification.
        }
        assert_eq!(
            app.store().record(&id).unwrap().unwrap().doc.as_bytes(),
            document.as_bytes()
        );
        assert_eq!(app.store().head().unwrap(), head);
        assert_eq!(app.store().pending_count().unwrap(), 0);
    }
    assert_eq!(app.store().meta(meta_keys::KEYRING).unwrap(), None);
}

/// Record a document as a file edited on disk is: broken frontmatter is
/// recorded, not refused.
fn write_file(app: &mut App, session: SessionId, id: B16, path: &str, doc: &str, mutation: u8) {
    let receipts = app
        .submit(
            session,
            w::client::SubmitParams {
                ops: vec![Op::Document(w::intent::Document {
                    id,
                    base: None,
                    new: Some(w::intent::DocVersion {
                        path: path.into(),
                        doc: w::common::Text::Inline(doc.into()),
                    }),
                    if_revision: None,
                })],
                mutation_id: Some(B16([mutation; 16])),
                conflict_mode: None,
                timezone: None,
                allow_partial: None,
                mutation_ids: None,
                dry_run: None,
                include: None,
                wait: None,
                validation: Some(w::intent::Level::Off),
            },
        )
        .unwrap();
    for receipt in &receipts {
        assert!(receipt.problem.is_none(), "{:?}", receipt.problem);
    }
}

/// tasknotes-app ship cycle 2026-11-18 F1: one note whose frontmatter is not a
/// YAML mapping blanked every Bases view in a Cloud copy, because the raw
/// projection left it out and so never became ready. It is skipped instead,
/// confirmed or still pending, and the view reads its other records.
#[test]
fn an_unreadable_plain_note_does_not_stop_a_view_reading_its_records() {
    let path = scratch("bases_unreadable_plain_note").join("app.db");
    let service = log();
    let probe = Rc::new(Probe::default());
    let (mut app, session, index) = open(&path, probe.clone());
    settle(&mut app, &service);
    configure_resources(&mut app, session, &service);
    let source = "views:\n  - type: table\n    order: [file.name]\n    sort: [{property: file.name, direction: ASC}]\n";
    let task = B16([70; 16]);
    let invalid = "---\ntitle: Invalid frontmatter test\ntags: [unclosed\n---\n";
    submit(
        &mut app,
        session,
        vec![
            create(SOURCE_ID, SOURCE_PATH, source),
            create(task, "tasks/open.md", "---\nstatus: open\n---\n"),
        ],
        40,
    );
    write_file(
        &mut app,
        session,
        B16([71; 16]),
        "notes/invalid.md",
        invalid,
        41,
    );
    settle(&mut app, &service);
    assert!(app.store().record(&B16([71; 16])).unwrap().is_some());
    let hints = BTreeMap::new();
    let read = |app: &mut App, session: SessionId, step: &str| {
        let mut rows = Vec::new();
        app.encode_indexed_bases_read_request(
            session,
            BasesReadRequest {
                selection: BasesViewSelection {
                    record: SOURCE_ID,
                    revision: w::hash::sha256(source.as_bytes()),
                    index: 0,
                },
                property_types: &hints,
                timezone: "UTC",
                window: None,
                row_properties: None,
            },
            |result| {
                rows = result.rows.iter().map(|row| row.record).collect();
                Ok(1)
            },
            |_, size| Ok(vec![0; size]),
        )
        .unwrap_or_else(|error| panic!("{step}: {error:?}"));
        rows.sort();
        rows
    };
    // The unfiltered view lists every readable record, its own source too,
    // and never the unreadable notes.
    let mut readable = vec![SOURCE_ID, task];
    readable.sort();
    assert_eq!(read(&mut app, session, "confirmed"), readable, "confirmed");
    // A second unreadable note that has not synced yet is skipped the same way.
    write_file(
        &mut app,
        session,
        B16([72; 16]),
        "notes/pending.md",
        invalid,
        42,
    );
    assert_eq!(read(&mut app, session, "pending"), readable, "pending");
    settle(&mut app, &service);
    assert_eq!(read(&mut app, session, "synced"), readable, "synced");
    // A store the previous runtime settled left both notes out and stayed
    // unready. Its older projection version is rebuilt on the next open.
    raw(&index, "DELETE FROM st_qraw WHERE length(fields)=0", vec![]);
    raw(
        &index,
        "UPDATE st_qraw_state SET ready=0,version=version-1",
        vec![],
    );
    raw(
        &index,
        "INSERT OR REPLACE INTO st_kv(k,v) SELECT 'qraw_settled',generation FROM st_qraw_state",
        vec![],
    );
    drop(app);
    drop(index);
    let (mut app, session, _) = open(&path, probe);
    settle(&mut app, &service);
    assert_eq!(read(&mut app, session, "reopened"), readable, "reopened");
}

#[test]
fn bases_row_properties_projects_effective_fields_and_types_for_windowed_unwindowed_and_pending() {
    let path = scratch("bases_row_properties_e2e").join("app.db");
    let service = log();
    let (mut app, session, _) = open(&path, Rc::new(Probe::default()));
    settle(&mut app, &service);
    configure_resources(&mut app, session, &service);
    // Add a task type with a read default (`status: open`) so we verify effective
    // frontmatter and catalog `types` match `get(..., { effective: true })`.
    let task_type = "---\nkind: mdbase.type\nname: task\nversion: 1\nmatch:\n  where:\n    type: task\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      title: { type: string }\n      status: { type: string }\n      priority: { type: string }\n      due: { type: string }\ncollection:\n  read_defaults:\n    status: open\n---\n";
    let receipts = app
        .submit(
            session,
            w::client::SubmitParams {
                ops: vec![Op::ResourcePut(w::intent::ResourcePut {
                    path: "_types/task.md".into(),
                    doc: w::common::Text::Inline(task_type.into()),
                    base_revision: None,
                    must_not_exist: None,
                })],
                mutation_id: Some(B16([0x88; 16])),
                conflict_mode: None,
                timezone: None,
                allow_partial: None,
                mutation_ids: None,
                dry_run: None,
                include: None,
                wait: None,
                validation: None,
            },
        )
        .unwrap();
    assert!(receipts[0].problem.is_none(), "{receipts:?}");
    settle(&mut app, &service);

    let view_source = "filters:\n  and:\n    - 'type == \"task\"'\nviews:\n  - type: table\n    name: Tasks\n    order: [file.name]\n    sort: [{property: file.name, direction: ASC}]\n";
    let t1 = B16([0x91; 16]);
    let t2 = B16([0x92; 16]);
    let t3 = B16([0x93; 16]);
    submit(
        &mut app,
        session,
        vec![
            create(SOURCE_ID, SOURCE_PATH, view_source),
            create(
                t1,
                "tasks/01.md",
                "---\ntype: task\ntitle: Defaulted\npriority: high\nnoise: should-not-appear\n---\nBody text\n",
            ),
            create(
                t2,
                "tasks/02.md",
                "---\ntype: task\ntitle: Explicit\nstatus: done\ndue: 2026-12-01\n---\n",
            ),
        ],
        50,
    );
    settle(&mut app, &service);
    // Add a pending task (unconfirmed in layer) to verify both confirmed and pending rows.
    submit(
        &mut app,
        session,
        vec![create(
            t3,
            "tasks/03.md",
            "---\ntype: task\ntitle: Pending\npriority: low\n---\n",
        )],
        51,
    );

    let hints = BTreeMap::new();
    let requested = vec![
        "title".to_owned(),
        "status".to_owned(),
        "priority".to_owned(),
        "due".to_owned(),
    ];
    let selection = BasesViewSelection {
        record: SOURCE_ID,
        revision: w::hash::sha256(view_source.as_bytes()),
        index: 0,
    };
    let include_eff = w::client::Include {
        effective: Some(true),
        body: None,
        document: None,
        diagnostics: None,
    };
    for window in [
        None,
        Some(BasesExecutionWindow {
            offset: 0,
            limit: 2,
        }),
        Some(BasesExecutionWindow {
            offset: 2,
            limit: 2,
        }),
    ] {
        // Test through the full wire codec (`encode_app_bases_execute`) as well.
        let mut req_map = vec![
            (
                w::Cbor::Uint(0),
                w::Cbor::Bytes(selection.record.0.to_vec()),
            ),
            (
                w::Cbor::Uint(1),
                w::Cbor::Bytes(selection.revision.0.to_vec()),
            ),
            (w::Cbor::Uint(2), w::Cbor::Uint(u64::from(selection.index))),
            (w::Cbor::Uint(3), w::Cbor::Map(vec![])),
            (w::Cbor::Uint(4), w::Cbor::Text("UTC".into())),
            (
                w::Cbor::Uint(5),
                w::Cbor::Text("whole-view-synthetic-policy-reference-v1".into()),
            ),
        ];
        if let Some(w) = window {
            req_map.push((
                w::Cbor::Uint(6),
                w::Cbor::Map(vec![
                    (w::Cbor::Uint(0), w::Cbor::Uint(u64::from(w.offset))),
                    (w::Cbor::Uint(1), w::Cbor::Uint(u64::from(w.limit))),
                ]),
            ));
        }
        req_map.push((
            w::Cbor::Uint(7),
            w::Cbor::Array(requested.iter().map(|k| w::Cbor::Text(k.clone())).collect()),
        ));
        let req_bytes = w::cbor::encode(&w::Cbor::Map(req_map)).unwrap();
        let reply = app.encode_app_bases_execute(session, &req_bytes).unwrap();
        let w::Cbor::Map(fields) = w::cbor::decode(&reply).unwrap() else {
            panic!("expected CBOR map");
        };
        let (_, w::Cbor::Array(wire_rows)) =
            fields.iter().find(|(k, _)| *k == w::Cbor::Uint(3)).unwrap()
        else {
            panic!("rows");
        };
        let (_, w::Cbor::Array(wire_props)) = fields
            .iter()
            .find(|(k, _)| *k == w::Cbor::Uint(10))
            .unwrap()
        else {
            panic!("row_properties key 10");
        };
        assert_eq!(wire_rows.len(), wire_props.len());
        // Verify exact parity with `get(id, { include: { effective: true } })`
        // via direct `encode_indexed_bases_read_request` inspection too.
        let mut expected_rows = Vec::new();
        app.encode_indexed_bases_read_request(
            session,
            BasesReadRequest {
                selection,
                property_types: &hints,
                timezone: "UTC",
                window,
                row_properties: Some(&requested),
            },
            |result| {
                let rp = result.row_properties.as_ref().unwrap();
                assert_eq!(rp.len(), result.rows.len());
                for (row, props) in result.rows.iter().zip(rp) {
                    expected_rows.push((row.record, props.types.clone(), props.properties.clone()));
                }
                Ok(1)
            },
            |_, size| Ok(vec![0; size]),
        )
        .unwrap();
        assert_eq!(expected_rows.len(), wire_rows.len());
        for (id, types, props) in expected_rows {
            let got = app
                .get(session, r::api::Target::Id(id), include_eff.clone())
                .unwrap();
            assert_eq!(types, got.types);
            let eff = got.effective.unwrap();
            for name in &requested {
                assert_eq!(
                    props.get(name),
                    eff.get(name),
                    "property `{name}` must match get(effective: true)"
                );
            }
            assert!(
                props.get("noise").is_none(),
                "unrequested property must be omitted"
            );
            // Defaulted `status: open` must be materialized for t1 and t3.
            if id == t1 || id == t3 {
                assert_eq!(
                    props.get("status"),
                    Some(&w::common::Value::Text("open".into()))
                );
            }
        }
    }
}

/// Microbenchmark comparing 10k-note warm reads:
/// 1) Bases 200-row window with projected `row_properties` (1 call) vs
///    Bases 200-row window + 200 `get(id, { effective: true })` calls.
/// 2) Ordered `query_contract` top-50 (1 call) vs full contract paging at 128 (~79 calls).
#[test]
#[ignore]
fn perf_10k_bases_window_and_ordered_contract_query_microbenchmark() {
    use std::time::Instant;
    let path = scratch("perf_10k_step4a").join("app.db");
    let service = log();
    let (mut app, session, _) = open(&path, Rc::new(Probe::default()));
    settle(&mut app, &service);
    configure_resources(&mut app, session, &service);

    let contract_doc = "---\nkind: mdbase.contract\ncontract_type: record\nid: dev.mdbase.writer.manuscript\nversion: 1.0.0\nrecord_schema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    required: [title]\n    properties:\n      title: { type: string }\n      date: { type: string }\n      status: { type: string }\n---\n";
    let type_doc = "---\nkind: mdbase.type\nname: task\nversion: 1\nmatch:\n  where:\n    type: task\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      title: { type: string }\n      status: { type: string, default: open }\n      priority: { type: string }\n      due: { type: string }\n      scheduled: { type: string }\n      date: { type: string }\n      projects: { type: array }\n      contexts: { type: array }\nimplements:\n  - contract: dev.mdbase.writer.manuscript\n    version: 1.0.0\n    fields:\n      '/title': '/title'\n      '/date': '/date'\n      '/status': '/status'\n---\n";
    let res = app
        .submit(
            session,
            w::client::SubmitParams {
                ops: vec![
                    Op::ResourcePut(w::intent::ResourcePut {
                        path: "_contracts/manuscript.md".into(),
                        doc: w::common::Text::Inline(contract_doc.into()),
                        base_revision: None,
                        must_not_exist: None,
                    }),
                    Op::ResourcePut(w::intent::ResourcePut {
                        path: "_types/task.md".into(),
                        doc: w::common::Text::Inline(type_doc.into()),
                        base_revision: None,
                        must_not_exist: None,
                    }),
                ],
                mutation_id: Some(B16([0xaa; 16])),
                conflict_mode: None,
                timezone: None,
                allow_partial: None,
                mutation_ids: None,
                dry_run: None,
                include: None,
                wait: None,
                validation: None,
            },
        )
        .unwrap();
    assert!(res.iter().all(|r| r.problem.is_none()), "{res:?}");
    settle(&mut app, &service);

    let view_source = "filters:\n  and:\n    - 'type == \"task\"'\nviews:\n  - type: table\n    name: All Tasks\n    order: [status, priority, due, file.name]\n    sort: [{property: due, direction: DESC}]\n";
    submit(
        &mut app,
        session,
        vec![create(SOURCE_ID, SOURCE_PATH, view_source)],
        1,
    );
    let total = 10_000u32;
    for batch in 0..(total / 250) {
        let ops = (0..250u32)
            .map(|j| {
                let i = batch * 250 + j + 1;
                let mut id_bytes = [0u8; 16];
                id_bytes[0] = 0x55;
                id_bytes[12..16].copy_from_slice(&i.to_be_bytes());
                let day = (i % 28) + 1;
                let month = ((i / 28) % 12) + 1;
                let year = 2020 + ((i / 336) % 7);
                let status = if i % 4 == 0 { "done" } else { "open" };
                let priority = ["low", "normal", "high"][(i % 3) as usize];
                let doc = format!(
                    "---\ntype: task\ntitle: \"Task {i:05}\"\nstatus: {status}\npriority: {priority}\ndue: \"{year:04}-{month:02}-{day:02}\"\nscheduled: \"{year:04}-{month:02}-{day:02}\"\ndate: \"{year:04}-{month:02}-{day:02}\"\nprojects: [\"[[Project A]]\"]\ncontexts: [\"work\"]\n---\nBody paragraph for task {i:05} with realistic markdown body content.\n"
                );
                create(B16(id_bytes), &format!("tasks/task-{i:05}.md"), &doc)
            })
            .collect();
        let mut mid = [0u8; 16];
        mid[0] = 0xbb;
        mid[12..16].copy_from_slice(&(batch + 2).to_be_bytes());
        let receipts = app
            .submit(
                session,
                w::client::SubmitParams {
                    ops,
                    mutation_id: Some(B16(mid)),
                    conflict_mode: None,
                    timezone: None,
                    allow_partial: None,
                    mutation_ids: None,
                    dry_run: None,
                    include: None,
                    wait: None,
                    validation: None,
                },
            )
            .unwrap();
        assert!(receipts.iter().all(|r| r.problem.is_none()));
        settle(&mut app, &service);
    }

    let selection = BasesViewSelection {
        record: SOURCE_ID,
        revision: w::hash::sha256(view_source.as_bytes()),
        index: 0,
    };
    let row_props: Vec<String> = vec![
        "title".into(),
        "status".into(),
        "priority".into(),
        "due".into(),
        "scheduled".into(),
        "projects".into(),
        "contexts".into(),
    ];
    let make_req = |with_props: bool| {
        let mut m = vec![
            (
                w::Cbor::Uint(0),
                w::Cbor::Bytes(selection.record.0.to_vec()),
            ),
            (
                w::Cbor::Uint(1),
                w::Cbor::Bytes(selection.revision.0.to_vec()),
            ),
            (w::Cbor::Uint(2), w::Cbor::Uint(0)),
            (w::Cbor::Uint(3), w::Cbor::Map(vec![])),
            (w::Cbor::Uint(4), w::Cbor::Text("UTC".into())),
            (
                w::Cbor::Uint(5),
                w::Cbor::Text("whole-view-synthetic-policy-reference-v1".into()),
            ),
            (
                w::Cbor::Uint(6),
                w::Cbor::Map(vec![
                    (w::Cbor::Uint(0), w::Cbor::Uint(0)),
                    (w::Cbor::Uint(1), w::Cbor::Uint(200)),
                ]),
            ),
        ];
        if with_props {
            m.push((
                w::Cbor::Uint(7),
                w::Cbor::Array(row_props.iter().map(|s| w::Cbor::Text(s.clone())).collect()),
            ));
        }
        w::cbor::encode(&w::Cbor::Map(m)).unwrap()
    };
    let req_old = make_req(false);
    let req_new = make_req(true);
    let include_eff = w::client::Include {
        effective: Some(true),
        body: None,
        document: None,
        diagnostics: None,
    };

    // Warm up SQLite page cache once.
    let _ = app.encode_app_bases_execute(session, &req_new).unwrap();

    let iters = 5usize;
    let mut old_bases_ms = Vec::new();
    let mut old_gets_ms = Vec::new();
    let mut new_bases_ms = Vec::new();
    for _ in 0..iters {
        let t0 = Instant::now();
        let reply = app.encode_app_bases_execute(session, &req_old).unwrap();
        let t1 = Instant::now();
        let w::Cbor::Map(fields) = w::cbor::decode(&reply).unwrap() else {
            panic!()
        };
        let (_, w::Cbor::Array(rows)) =
            fields.iter().find(|(k, _)| *k == w::Cbor::Uint(3)).unwrap()
        else {
            panic!()
        };
        assert_eq!(rows.len(), 200);
        for row in rows {
            let w::Cbor::Array(cols) = row else { panic!() };
            let w::Cbor::Bytes(id_bytes) = &cols[0] else {
                panic!()
            };
            let id = B16(id_bytes.as_slice().try_into().unwrap());
            let _ = app
                .get(session, r::api::Target::Id(id), include_eff.clone())
                .unwrap();
        }
        let t2 = Instant::now();
        old_bases_ms.push((t1 - t0).as_secs_f64() * 1000.0);
        old_gets_ms.push((t2 - t1).as_secs_f64() * 1000.0);

        let t3 = Instant::now();
        let reply_new = app.encode_app_bases_execute(session, &req_new).unwrap();
        let t4 = Instant::now();
        let w::Cbor::Map(fields_new) = w::cbor::decode(&reply_new).unwrap() else {
            panic!()
        };
        let (_, w::Cbor::Array(props_new)) = fields_new
            .iter()
            .find(|(k, _)| *k == w::Cbor::Uint(10))
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(props_new.len(), 200);
        new_bases_ms.push((t4 - t3).as_secs_f64() * 1000.0);
    }

    // 2) queryContract: 1 ordered top-50 call vs full 10k scan at pageSize 128.
    let order = Some(w::common::Value::List(vec![w::common::Value::Map(vec![
        ("field".into(), w::common::Value::Text("date".into())),
        ("direction".into(), w::common::Value::Text("desc".into())),
    ])]));
    let mut cq_old_ms = Vec::new();
    let mut cq_new_ms = Vec::new();
    let mut old_pages = 0usize;
    for _ in 0..3 {
        let t0 = Instant::now();
        let mut cursor = None;
        let mut pages = 0usize;
        let mut count = 0usize;
        loop {
            let p = app
                .query_contract(
                    session,
                    r::api::ContractQuery {
                        contract: "dev.mdbase.writer.manuscript".into(),
                        version: "1.0.0".into(),
                        limit: 128,
                        cursor,
                        where_: None,
                        order_by: None,
                    },
                )
                .unwrap();
            pages += 1;
            count += p.records.len();
            cursor = p.page.cursor;
            if cursor.is_none() {
                break;
            }
        }
        let t1 = Instant::now();
        assert_eq!(count, total as usize);
        old_pages = pages;
        cq_old_ms.push((t1 - t0).as_secs_f64() * 1000.0);

        let t2 = Instant::now();
        let top50 = app
            .query_contract(
                session,
                r::api::ContractQuery {
                    contract: "dev.mdbase.writer.manuscript".into(),
                    version: "1.0.0".into(),
                    limit: 50,
                    cursor: None,
                    where_: None,
                    order_by: order.clone(),
                },
            )
            .unwrap();
        let t3 = Instant::now();
        assert_eq!(top50.records.len(), 50);
        cq_new_ms.push((t3 - t2).as_secs_f64() * 1000.0);
    }

    let median = |v: &mut Vec<f64>| {
        v.sort_by(|a, b| a.total_cmp(b));
        v[v.len() / 2]
    };
    let b_old = median(&mut old_bases_ms);
    let g_old = median(&mut old_gets_ms);
    let b_new = median(&mut new_bases_ms);
    let c_old = median(&mut cq_old_ms);
    let c_new = median(&mut cq_new_ms);
    eprintln!(
        "BENCH_10K bases_window_200: old_bases={b_old:.2}ms + 200_gets={g_old:.2}ms (total={:.2}ms, 201 calls) vs new_1call_row_props={b_new:.2}ms (1 call)",
        b_old + g_old
    );
    eprintln!(
        "BENCH_10K query_contract_10k: old_full_scan_128={c_old:.2}ms ({old_pages} calls) vs new_ordered_top50={c_new:.2}ms (1 call)"
    );
}
