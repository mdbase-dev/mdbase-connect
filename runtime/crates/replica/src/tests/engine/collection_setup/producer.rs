//! Actual authenticated Frames producer negotiation and original-session setup.
use super::declared::{CLIENT, GRANT, declared_node};
use super::*;
use crate::Store;
fn producer_hello() -> HelloParams {
    HelloParams {
        versions: vec![mdbn_wire::common::Version { major: 1, minor: 1 }],
        client_name: "declared-setup-producer-test".into(),
        client_version: "1".into(),
        features: Some(vec!["declared-collection-setup-v1".into()]),
        timezone: None,
    }
}
#[test]
fn declared_setup_authenticated_producer_is_explicitly_negotiated() {
    let (_, mut a, _) = declared_node();
    let (_, hello) =
        a.r.hello(
            crate::api::SessionAuth::Grant {
                grant: GRANT,
                client_pk: CLIENT.0,
            },
            producer_hello(),
        )
        .unwrap();
    assert!(
        hello
            .features
            .iter()
            .any(|f| f == "declared-collection-setup-v1")
    );
    assert!(
        !hello
            .grant
            .capabilities
            .contains(&"definitions.manage".into())
    );
}
#[test]
fn declared_setup_authenticated_frames_assess_original_declaration_without_payload_authority() {
    use crate::frames::Frames;
    use mdbn_wire::{
        cbor::{self, Cbor},
        client::{ClientFrame, ClientRequest},
        schema::Wire,
    };
    let (_, mut a, _) = declared_node();
    let mut frames = Frames::new();
    let hello = ClientFrame::Request(ClientRequest {
        id: 0,
        method: "hello".into(),
        params: producer_hello().to_cbor(),
    })
    .to_bytes()
    .unwrap();
    let opened = frames.hello(
        &mut a.r,
        crate::api::SessionAuth::Grant {
            grant: GRANT,
            client_pk: CLIENT.0,
        },
        &hello,
    );
    let client = opened
        .session
        .expect("original authenticated grant session");
    frames.take_outgoing();
    // Version/action only: no manifest, grant, client key, source observations,
    // resource operations or owner authority may be supplied by the caller.
    let request = cbor::encode(&Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Uint(1)),
        (Cbor::Uint(1), Cbor::Text("assess".into())),
    ]))
    .unwrap();
    let frame = ClientFrame::Request(ClientRequest {
        id: 1,
        method: "app_collection_setup_v1".into(),
        params: Cbor::Map(vec![(Cbor::Uint(0), Cbor::Bytes(request))]),
    })
    .to_bytes()
    .unwrap();
    frames.on_frame(&mut a.r, client, &frame);
    let response = frames
        .take_outgoing()
        .into_iter()
        .find_map(|(_, bytes)| {
            match ClientFrame::from_cbor(&cbor::decode(&bytes).unwrap()).unwrap() {
                ClientFrame::Response(r) if r.id == 1 => Some(r),
                _ => None,
            }
        })
        .expect("one original-session assess response");
    assert!(response.problem.is_none(), "{:?}", response.problem);
    let Some(Cbor::Bytes(bytes)) = response.result else {
        panic!("bounded native setup reply")
    };
    assert!(bytes.len() <= 256 * 1024);
    let Cbor::Map(reply) = cbor::decode(&bytes).unwrap() else {
        panic!("versioned setup reply")
    };
    assert!(reply.contains(&(Cbor::Uint(1), Cbor::Text("review".into()))));
    assert!(
        a.r.store
            .resource("mdbase.provisions.yaml")
            .unwrap()
            .is_none()
    );
}

use mdbn_wire::cbor::{self, Cbor};
pub(super) fn call(
    a: &mut Node,
    session: crate::api::SessionId,
    action: &str,
    fields: Vec<(u64, Cbor)>,
) -> crate::api::ApiResult<Cbor> {
    let mut input = vec![
        (Cbor::Uint(0), Cbor::Uint(1)),
        (Cbor::Uint(1), Cbor::Text(action.into())),
    ];
    input.extend(fields.into_iter().map(|(k, v)| (Cbor::Uint(k), v)));
    let bytes =
        a.r.app_collection_setup(session, &cbor::encode(&Cbor::Map(input)).unwrap())?;
    Ok(cbor::decode(&bytes).unwrap())
}
pub(super) fn get(value: &Cbor, key: u64) -> Cbor {
    let Cbor::Map(fields) = value else {
        panic!("numeric reply")
    };
    fields
        .iter()
        .find(|(k, _)| *k == Cbor::Uint(key))
        .unwrap()
        .1
        .clone()
}
pub(super) fn client(a: &mut Node) -> crate::api::SessionId {
    a.r.hello(
        crate::api::SessionAuth::Grant {
            grant: GRANT,
            client_pk: CLIENT.0,
        },
        producer_hello(),
    )
    .unwrap()
    .0
}
#[test]
fn producer_drives_authenticated_sources_then_atomic_apply_and_original_receipt() {
    let (_, mut a, _) = declared_node();
    let document = "views: []\r\n";
    super::capture::upload(&mut a, 7, "views/source.base", document.as_bytes());
    let client = client(&mut a);
    let pending = call(&mut a, client, "assess", vec![]).unwrap();
    assert_eq!(get(&pending, 1), Cbor::Text("pending".into()));
    let ticket = get(&pending, 2);
    settle(&mut [&mut a]);
    let review = call(&mut a, client, "poll", vec![(2, ticket.clone())]).unwrap();
    assert_eq!(get(&review, 1), Cbor::Text("review".into()));
    assert_eq!(get(&review, 3), Cbor::Text("setup_required".into()));
    let mid = B16([0x71; 16]);
    let response = call(
        &mut a,
        client,
        "apply",
        vec![
            (2, ticket.clone()),
            (3, Cbor::Bytes(mid.0.to_vec())),
            (4, get(&review, 4)),
            (5, get(&review, 5)),
        ],
    )
    .unwrap();
    assert_eq!(get(&response, 1), Cbor::Text("receipt".into()));
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.store.record(&B16([7; 16])).unwrap().unwrap().doc,
        document
    );
    assert!(
        a.r.store
            .resource("mdbase.provisions.yaml")
            .unwrap()
            .is_some()
    );
    assert_eq!(
        a.r.receipt(client, mid).unwrap().state,
        mdbn_wire::client::ReceiptState::Confirmed
    );
    assert!(call(&mut a, client, "poll", vec![(2, ticket)]).is_err());
    let current = call(&mut a, client, "assess", vec![]).unwrap();
    assert_eq!(get(&current, 3), Cbor::Text("ready".into()));
}
#[test]
fn producer_rejects_payload_authority_and_another_original_session() {
    let (_, mut a, source) = declared_node();
    let first = client(&mut a);
    let second = client(&mut a);
    assert_eq!(
        call(
            &mut a,
            first,
            "assess",
            vec![(9, Cbor::Text("replacement manifest".into()))]
        )
        .unwrap_err()
        .code(),
        Some(ErrorCode::InvalidRequest)
    );
    let review = call(&mut a, first, "assess", vec![]).unwrap();
    let ticket = get(&review, 2);
    assert_eq!(
        call(&mut a, second, "poll", vec![(2, ticket.clone())])
            .unwrap_err()
            .code(),
        Some(ErrorCode::NotFound)
    );
    source.borrow_mut().as_mut().unwrap().generation += 1;
    assert!(call(&mut a, first, "poll", vec![(2, ticket)]).is_err());
    assert!(
        a.r.store
            .resource("mdbase.provisions.yaml")
            .unwrap()
            .is_none()
    );
}
#[test]
fn producer_cancelled_source_keeps_its_original_transport_slot_until_reply() {
    let (_, mut a, _) = declared_node();
    super::capture::upload(&mut a, 7, "views/source.base", b"views: []\n");
    let first = client(&mut a);
    let pending = call(&mut a, first, "assess", vec![]).unwrap();
    let ticket = get(&pending, 2);
    call(&mut a, first, "cancel", vec![(2, ticket)]).unwrap();
    assert_eq!(
        call(&mut a, first, "assess", vec![]).unwrap_err().code(),
        Some(ErrorCode::RateLimited)
    );
    settle(&mut [&mut a]);
    assert!(call(&mut a, first, "assess", vec![]).is_ok());
    assert!(a.r.store.record(&B16([7; 16])).unwrap().is_none());
    assert!(
        a.r.store
            .resource("mdbase.provisions.yaml")
            .unwrap()
            .is_none()
    );
}

#[test]
fn producer_rejects_changed_digest_without_any_resource_prefix() {
    let (service, mut a, _) = declared_node();
    let client = client(&mut a);
    let review = call(&mut a, client, "assess", vec![]).unwrap();
    let before = service.head(&COL);
    let error = call(
        &mut a,
        client,
        "apply",
        vec![
            (2, get(&review, 2)),
            (3, Cbor::Bytes(vec![0x72; 16])),
            (4, get(&review, 4)),
            (5, Cbor::Bytes(vec![0; 32])),
        ],
    )
    .unwrap_err();
    assert_eq!(error.code(), Some(ErrorCode::Conflict));
    settle(&mut [&mut a]);
    assert_eq!(service.head(&COL), before);
    assert!(
        a.r.store
            .resource("mdbase.provisions.yaml")
            .unwrap()
            .is_none()
    );
}
#[test]
fn producer_unknown_capture_fences_original_mid_without_resubmission() {
    for durable in [false, true] {
        let (service, mut a, _) = declared_node();
        let client = client(&mut a);
        let review = call(&mut a, client, "assess", vec![]).unwrap();
        let before = service.head(&COL);
        if durable {
            a.r.store.fail_after_commit(1);
        } else {
            a.r.store.fail_unknown_commits(1);
        }
        let fields = vec![
            (2, get(&review, 2)),
            (3, Cbor::Bytes(vec![0x73; 16])),
            (4, get(&review, 4)),
            (5, get(&review, 5)),
        ];
        let error = call(&mut a, client, "apply", fields.clone()).unwrap_err();
        assert_eq!(error.problem().code, "outcome_unknown");
        assert!(a.r.apply_fault);
        assert!(call(&mut a, client, "apply", fields).is_err());
        settle(&mut [&mut a]);
        assert_eq!(service.head(&COL), before);
        assert!(
            a.r.store
                .resource("mdbase.provisions.yaml")
                .unwrap()
                .is_none()
        );
    }
}
