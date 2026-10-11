//! Actual native SQL/Frames boundaries on isolated test authorities.
use super::*;
use w::cbor::{self, Cbor};
use w::client::{ClientFrame, ClientRequest, QueryResult};
use w::schema::Wire;

#[test]
fn byte_account_denial_precedes_target_blob_copy_and_does_not_fence_original_store() {
    let path = scratch("native-asfile-byte-preflight").join("state.db");
    let probe = Rc::new(Probe::default());
    let (mut app, session, _index) = open(&path, probe.clone());
    let service = log();
    settle(&mut app, &service);
    let target = format!("---\nname: Alex\n---\n{}", "x".repeat(400_000));
    submit(
        &mut app,
        session,
        vec![
            create(
                B16([21; 16]),
                "Tasks/First.md",
                "---\nassignee: '[[People/Alex]]'\n---\n",
            ),
            create(B16([22; 16]), "People/Alex.md", &target),
        ],
        43,
    );
    settle(&mut app, &service);
    let before = probe.record_blob_reads.get();
    let result = app.query(
        session,
        Value::Map(vec![
            (
                "where".into(),
                Value::Text("file.path == 'Tasks/First.md'".into()),
            ),
            (
                "select".into(),
                Value::List(vec![selection(
                    "target",
                    "raw.assignee.asFile() == null ? null : raw.assignee.asFile().file.path",
                )]),
            ),
        ]),
        include(),
    );
    let error = result.unwrap_err();
    assert_eq!(
        error.problem().reason.as_deref(),
        Some("query_budget_exceeded")
    );
    // One task, two admitted target copies (~800 KiB). The next 400 KiB target
    // reread is denied by metadata size BEFORE its BLOB SELECT reaches SQLite.
    assert_eq!(probe.record_blob_reads.get() - before, 3);
    assert_eq!(app.store().pending_count().unwrap(), 0);
    assert!(app.query(session, Value::Map(vec![]), include()).is_ok());
}

#[test]
fn pending_original_layer_projects_without_claiming_confirmation() {
    let path = scratch("native-asfile-pending-layer").join("state.db");
    let (mut app, session, _index) = open(&path, Rc::new(Probe::default()));
    let service = log();
    settle(&mut app, &service);
    submit(
        &mut app,
        session,
        vec![
            create(
                B16([21; 16]),
                "Tasks/First.md",
                "---\nassignee: '[[People/Alex]]'\n---\n",
            ),
            create(B16([22; 16]), "People/Alex.md", "---\nname: Alex\n---\n"),
        ],
        44,
    );
    let query = Value::Map(vec![
        (
            "where".into(),
            Value::Text("file.path == 'Tasks/First.md'".into()),
        ),
        (
            "select".into(),
            Value::List(vec![selection("target", "raw.assignee.asFile().file.path")]),
        ),
    ]);
    let pending = app.query(session, query.clone(), include()).unwrap();
    assert_eq!(
        pending.records[0].state.state,
        w::client::Confirmation::Pending
    );
    assert_eq!(
        pending.records[0].values.as_ref().unwrap().get("target"),
        Some(&Value::Text("People/Alex.md".into()))
    );
    settle(&mut app, &service);
    let confirmed = app.query(session, query, include()).unwrap();
    assert_eq!(confirmed.records[0].id, pending.records[0].id);
    assert_eq!(
        confirmed.records[0].state.state,
        w::client::Confirmation::Confirmed
    );
    assert!(confirmed.records[0].state.confirmed_seq > 0);
}

fn request(id: u64, method: &str, params: Cbor) -> Vec<u8> {
    ClientFrame::Request(ClientRequest {
        id,
        method: method.into(),
        params,
    })
    .to_bytes()
    .unwrap()
}

#[test]
fn actual_frames_query_delivers_native_columns_and_values_and_closed_session_is_refused() {
    let path = scratch("native-asfile-frames").join("state.db");
    let (mut app, setup_session, _index) = open(&path, Rc::new(Probe::default()));
    let service = log();
    settle(&mut app, &service);
    submit(
        &mut app,
        setup_session,
        vec![
            create(
                B16([21; 16]),
                "Tasks/First.md",
                "---\nassignee: '[[People/Alex|Alias]]'\n---\n",
            ),
            create(B16([22; 16]), "People/Alex.md", "---\nname: Alex\n---\n"),
        ],
        45,
    );
    settle(&mut app, &service);
    app.close(setup_session);
    // One Frames session on the SAME actual SQLite engine and test authority.
    let mut frames = r::frames::Frames::new();
    let opened = frames.hello(
        &mut app,
        SessionAuth::Host,
        &request(
            0,
            "hello",
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "native-frames".into(),
                client_version: "test".into(),
                features: None,
                timezone: Some("UTC".into()),
            }
            .to_cbor(),
        ),
    );
    let session = opened.session.unwrap();
    frames.take_outgoing();
    let query = Value::Map(vec![
        (
            "where".into(),
            Value::Text("file.path == 'Tasks/First.md'".into()),
        ),
        (
            "select".into(),
            Value::List(vec![
                selection("raw", "raw.assignee"),
                selection("target", "raw.assignee.asFile().file.path"),
            ]),
        ),
    ]);
    let bytes = request(
        1,
        "query",
        Cbor::Map(vec![(Cbor::Uint(0), query.to_cbor())]),
    );
    frames.on_frame(&mut app, session, &bytes);
    let outgoing = frames.take_outgoing();
    let response = outgoing
        .iter()
        .map(|(_, bytes)| ClientFrame::from_cbor(&cbor::decode(bytes).unwrap()).unwrap())
        .find_map(|frame| match frame {
            ClientFrame::Response(response) if response.id == 1 => Some(response),
            _ => None,
        })
        .unwrap();
    assert!(response.problem.is_none());
    let result = QueryResult::from_cbor(&response.result.unwrap()).unwrap();
    assert_eq!(result.columns, Some(vec!["raw".into(), "target".into()]));
    let values = result.records[0].values.as_ref().unwrap();
    assert_eq!(
        values.get("raw"),
        Some(&Value::Text("[[People/Alex|Alias]]".into()))
    );
    assert_eq!(
        values.get("target"),
        Some(&Value::Text("People/Alex.md".into()))
    );
    frames.close(&mut app, session);
    assert!(app.query(session, query, include()).is_err());
}
