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
