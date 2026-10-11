//! Actual AppSql capture, original journal recovery and frame dispatch. No
//! synthetic inventory, browser/process durability or log authority is inferred.
use super::*;
use r::store::Store;
use w::client::{ClientFrame, ClientRequest, ReceiptState};
use w::{Cbor, Wire};

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
fn native_pending_inventory_reads_real_capture_without_writes_then_original_ack_removes_it() {
    let path = scratch("native-pending-inventory").join("app.db");
    let probe = Rc::new(Probe::default());
    let (mut app, session, index) = open(&path, probe.clone());
    let service = log();
    settle(&mut app, &service);
    assert!(app.list_pending(session, None).unwrap().pending.is_empty());
    submit(
        &mut app,
        session,
        vec![create(B16([71; 16]), "original.md", "Original bytes\n")],
        72,
    );
    let original = app.store().pending_get(&B16([72; 16])).unwrap().unwrap();
    let before = probe.transactions.get();
    let head = app.head();
    let page = app.list_pending(session, None).unwrap();
    assert_eq!(page.pending.len(), 1);
    assert!(page.next.is_none());
    let entry = &page.pending[0];
    assert_eq!(entry.receipt.mutation, original.mutation.id);
    assert_eq!(entry.receipt.state, ReceiptState::Pending);
    assert_eq!(entry.captured, original.mutation.clock.instant);
    assert_eq!(entry.ops, original.mutation.ops);
    assert_eq!(probe.transactions.get(), before, "inventory is read-only");
    assert_eq!(app.head(), head);
    assert_eq!(
        app.store().pending_get(&original.mutation.id).unwrap(),
        Some(original.clone())
    );

    let mut frames = r::frames::Frames::new();
    let hello = HelloParams {
        versions: vec![Version { major: 1, minor: 0 }],
        client_name: "pending-test".into(),
        client_version: "1".into(),
        features: None,
        timezone: None,
    };
    let session2 = frames
        .hello(
            &mut app,
            SessionAuth::Host,
            &request(1, "hello", hello.to_cbor()),
        )
        .session
        .unwrap();
    frames.on_frame(
        &mut app,
        session2,
        &request(2, "list_pending", Cbor::Map(vec![])),
    );
    let responses = frames.take_outgoing();
    let (_, bytes) = responses.iter().find(|(_, bytes)| matches!(ClientFrame::from_bytes(bytes), Ok(ClientFrame::Response(ref response)) if response.id == 2)).unwrap();
    let ClientFrame::Response(response) = ClientFrame::from_bytes(bytes).unwrap() else {
        panic!("response")
    };
    assert!(response.problem.is_none());
    let Cbor::Map(fields) = response.result.unwrap() else {
        panic!("page")
    };
    let Cbor::Array(entries) = &fields
        .iter()
        .find(|(key, _)| *key == Cbor::Uint(0))
        .unwrap()
        .1
    else {
        panic!("entries")
    };
    assert_eq!(entries.len(), 1);
    let Cbor::Map(fields) = &entries[0] else {
        panic!("entry")
    };
    let raw = &fields
        .iter()
        .find(|(key, _)| *key == Cbor::Uint(2))
        .unwrap()
        .1;
    assert_eq!(
        Vec::<w::attachment_runtime_v1::Op>::from_cbor(raw).unwrap(),
        original.mutation.ops
    );
    assert_eq!(probe.transactions.get(), before);
    frames.on_frame(
        &mut app,
        session2,
        &request(
            3,
            "list_pending",
            Cbor::Map(vec![(Cbor::Uint(1), Cbor::Uint(999))]),
        ),
    );
    let replies = frames.take_outgoing();
    let ClientFrame::Response(refused) = ClientFrame::from_bytes(&replies[0].1).unwrap() else {
        panic!("refusal")
    };
    assert_eq!(refused.problem.unwrap().code, "invalid_request");
    probe.fail_read.set(true);
    assert_eq!(
        app.list_pending(session, None).unwrap_err().code(),
        Some(ErrorCode::Unavailable)
    );
    assert!(
        app.store().pending_get(&original.mutation.id).is_err(),
        "the actual SQL adapter fences after the read fault"
    );
    assert_eq!(
        app.list_pending(session, None).unwrap_err().code(),
        Some(ErrorCode::Unavailable)
    );
    assert_eq!(probe.transactions.get(), before);

    // Genuine native SQL reopen before driving the original append; no new MID.
    drop(app);
    drop(index);
    let (mut app, session, _) = open(&path, probe);
    assert_eq!(
        app.list_pending(session, None).unwrap().pending[0]
            .receipt
            .mutation,
        original.mutation.id
    );
    assert_eq!(
        app.list_pending(session, None).unwrap().pending[0].ops,
        original.mutation.ops
    );
    settle(&mut app, &service);
    assert_eq!(
        app.receipt(session, original.mutation.id).unwrap().state,
        ReceiptState::Confirmed
    );
    assert!(app.list_pending(session, None).unwrap().pending.is_empty());
}

#[test]
fn native_pending_inventory_pages_after_preceding_rows_confirm_and_refuses_foreign_cursor() {
    let (mut app, session, _) = open(
        &scratch("native-pending-pages").join("app.db"),
        Rc::default(),
    );
    let service = log();
    settle(&mut app, &service);
    for id in 1..=65u8 {
        submit(
            &mut app,
            session,
            vec![create(
                B16([id; 16]),
                &format!("pending-{id}.md"),
                "pending",
            )],
            id,
        );
    }
    let page = app.list_pending(session, None).unwrap();
    assert_eq!(page.pending.len(), 64);
    let cursor = page.next.unwrap();
    assert!(
        !page
            .pending
            .iter()
            .any(|entry| entry.receipt.mutation == cursor)
    );
    let hello = HelloParams {
        versions: vec![Version { major: 1, minor: 0 }],
        client_name: "another-session".into(),
        client_version: "1".into(),
        features: None,
        timezone: None,
    };
    let other = app.hello(SessionAuth::Host, hello).unwrap().0;
    assert_eq!(
        app.list_pending(other, Some(cursor)).unwrap_err().code(),
        Some(ErrorCode::InvalidRequest)
    );
    assert_eq!(
        app.list_pending(session, Some(cursor)).unwrap().pending[0]
            .receipt
            .mutation,
        B16([65; 16])
    );
    settle(&mut app, &service);
    assert!(
        app.list_pending(session, Some(cursor))
            .unwrap()
            .pending
            .is_empty()
    );
    app.close(session);
    assert_eq!(
        app.list_pending(session, Some(cursor)).unwrap_err().code(),
        Some(ErrorCode::Unauthenticated)
    );
}
