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
