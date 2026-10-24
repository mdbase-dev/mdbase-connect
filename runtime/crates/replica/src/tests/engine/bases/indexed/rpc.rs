//! Actual Replica + Frames Bases reads, real crypto and projected source fixture.
use super::*;
use crate::{SessionAuth, SessionId, frames::Frames};
use mdbn_wire::{
    cbor::{self, Cbor},
    client::{ClientFrame, ClientRequest, ClientResponse, HelloParams},
    common::Version,
    schema::Wire,
};
fn field(value: &Cbor, key: u64) -> &Cbor {
    let Cbor::Map(fields) = value else {
        panic!("numeric map")
    };
    &fields
        .iter()
        .find(|(k, _)| *k == Cbor::Uint(key))
        .unwrap()
        .1
}
fn frame(id: u64, method: &str, params: Cbor) -> Vec<u8> {
    ClientFrame::Request(ClientRequest {
        id,
        method: method.into(),
        params,
    })
    .to_bytes()
    .unwrap()
}
fn rpc(
    r: &mut Replica<ProjectionStore>,
    frames: &mut Frames,
    session: SessionId,
    method: &str,
    params: Cbor,
) -> ClientResponse {
    frames.on_frame(r, session, &frame(1, method, params));
    frames
        .take_outgoing()
        .into_iter()
        .find_map(|(_, bytes)| {
            match ClientFrame::from_cbor(&cbor::decode(&bytes).unwrap()).unwrap() {
                ClientFrame::Response(response) if response.id == 1 => Some(response),
                _ => None,
            }
        })
        .unwrap()
}
fn params(bytes: Vec<u8>) -> Cbor {
    Cbor::Map(vec![(Cbor::Uint(0), Cbor::Bytes(bytes))])
}
fn list() -> Vec<u8> {
    cbor::encode(&Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Uint(1)),
        (Cbor::Uint(1), Cbor::Text("UTC".into())),
        (Cbor::Uint(2), Cbor::Uint(128)),
        (Cbor::Uint(3), Cbor::Null),
    ]))
    .unwrap()
}
fn approve(
    svc: &FakeLogService,
    a: &mut Node,
    grant: B16,
    key: [u8; 32],
    folders: Option<Vec<String>>,
) -> crate::testkit::TestControlPlane {
    let mut cp = crate::testkit::TestControlPlane::signed(COL);
    cp.append(
        svc,
        vec![mdbn_wire::policy::PolicyOp::Grant(
            mdbn_wire::policy::Grant {
                grant,
                installation: B16([0x56; 16]),
                app_id: "app".into(),
                account: crate::testkit::TEST_OWNER,
                capabilities: vec!["collection.read".into()],
                client_pk: B32(key),
                file_folders: None,
                folder_scoped: folders.as_ref().map(|_| true),
            },
        )],
    );
    settle(&mut [a]);
    a.r.approve_grant(a.s, grant, vec!["collection.read".into()], folders)
        .unwrap();
    settle(&mut [a]);
    cp
}
fn bytes(response: ClientResponse) -> Vec<u8> {
    assert!(response.problem.is_none(), "{:?}", response.problem);
    let Some(Cbor::Bytes(bytes)) = response.result else {
        panic!("bounded native bytes")
    };
    bytes
}
fn assert_same_read(actual: &[u8], expected: &[u8], clock_key: u64) {
    let actual = cbor::decode(actual).unwrap();
    let mut expected = cbor::decode(expected).unwrap();
    let actual_clock = field(&actual, clock_key);
    let expected_clock = field(&expected, clock_key);
    // Independent native READs advance the monotonic capture clock; compare
    // every other byte/field while checking (not masking) the expected advance.
    assert_eq!(
        i64::from_cbor(field(actual_clock, 0)).unwrap(),
        i64::from_cbor(field(expected_clock, 0)).unwrap() + 1
    );
    assert_eq!(field(actual_clock, 1), field(expected_clock, 1));
    assert_eq!(field(actual_clock, 2), field(expected_clock, 2));
    let Cbor::Map(fields) = &mut expected else {
        panic!("native map")
    };
    fields
        .iter_mut()
        .find(|(key, _)| *key == Cbor::Uint(clock_key))
        .unwrap()
        .1 = actual_clock.clone();
    assert_eq!(actual, expected);
}
fn open(r: &mut Replica<ProjectionStore>, frames: &mut Frames, auth: SessionAuth) -> SessionId {
    frames
        .hello(
            r,
            auth,
            &frame(
                0,
                "hello",
                HelloParams {
                    versions: vec![Version { major: 1, minor: 1 }],
                    client_name: "[test] Bases relay".into(),
                    client_version: "test".into(),
                    features: None,
                    timezone: Some("UTC".into()),
                }
                .to_cbor(),
            ),
        )
        .session
        .unwrap()
}
#[test]
fn authenticated_private_frames_discover_read_exact_source_and_execute_shared_native_codec() {
    let (svc, mut a, _) = configured();
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../data/bases-first-slice.json")).unwrap();
    let source = fixture["sources"][0]["source"].as_str().unwrap();
    a.create(11, "Views/actual.base", source);
    for (i, record) in fixture["records"].as_array().unwrap().iter().enumerate() {
        a.create(
            (i + 1) as u8,
            record["path"].as_str().unwrap(),
            record["source"].as_str().unwrap(),
        );
    }
    settle(&mut [&mut a]);
    a.clock.set(fixture["now_ms"].as_u64().unwrap());
    let grant = B16([0x51; 16]);
    let key = [0x61; 32];
    let mut cp = approve(&svc, &mut a, grant, key, None);
    let clock = a.clock.clone();
    let now = fixture["now_ms"].as_u64().unwrap();
    let mut r = projected(&svc, a);
    let mut frames = Frames::new();
    let session = open(
        &mut r,
        &mut frames,
        SessionAuth::Grant {
            grant,
            client_pk: key,
        },
    );
    // Discovery pages the primary universe; warm-execution-only instrumentation
    // is armed again before the independent execution READ.
    r.store().armed.set(false);
    clock.set(now);
    let expected = r.encode_app_bases_list_views(session, &list()).unwrap();
    clock.set(now);
    let reply = bytes(rpc(
        &mut r,
        &mut frames,
        session,
        "app_bases_list_views_v1",
        params(list()),
    ));
    assert_same_read(&reply, &expected, 2);
    let decoded = cbor::decode(&reply).unwrap();
    let Cbor::Array(views) = field(&decoded, 1) else {
        panic!("views")
    };
    assert!(!views.is_empty());
    assert_eq!(field(&decoded, 4), &Cbor::Null);
    let view = &views[0];
    let source_request = cbor::encode(&Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Uint(1)),
        (Cbor::Uint(1), field(view, 0).clone()),
        (Cbor::Uint(2), field(view, 2).clone()),
        (Cbor::Uint(3), field(view, 3).clone()),
        (Cbor::Uint(4), Cbor::Text("UTC".into())),
    ]))
    .unwrap();
    clock.set(now);
    let expected = r
        .encode_app_bases_read_view_source(session, &source_request)
        .unwrap();
    clock.set(now);
    let reply = bytes(rpc(
        &mut r,
        &mut frames,
        session,
        "app_bases_read_view_source_v1",
        params(source_request),
    ));
    assert_same_read(&reply, &expected, 3);
    assert_eq!(
        field(&cbor::decode(&reply).unwrap(), 2),
        &Cbor::Text(source.into())
    );
    let request = cbor::encode(&Cbor::Map(vec![
        (Cbor::Uint(0), field(view, 0).clone()),
        (Cbor::Uint(1), field(view, 2).clone()),
        (Cbor::Uint(2), field(view, 3).clone()),
        (
            Cbor::Uint(3),
            Cbor::Map(vec![
                (Cbor::Text("due".into()), Cbor::Text("date".into())),
                (Cbor::Text("scheduled".into()), Cbor::Text("date".into())),
            ]),
        ),
        (Cbor::Uint(4), Cbor::Text("UTC".into())),
        (
            Cbor::Uint(5),
            Cbor::Text("whole-view-synthetic-policy-reference-v1".into()),
        ),
        (
            Cbor::Uint(6),
            Cbor::Map(vec![
                (Cbor::Uint(0), Cbor::Uint(0)),
                (Cbor::Uint(1), Cbor::Uint(200)),
            ]),
        ),
    ]))
    .unwrap();
    r.store().armed.set(true);
    clock.set(now);
    let expected = r.encode_app_bases_execute(session, &request).unwrap();
    clock.set(now);
    let reply = bytes(rpc(
        &mut r,
        &mut frames,
        session,
        "app_bases_execute_v1",
        params(request),
    ));
    assert_same_read(&reply, &expected, 5);
    assert!(
        matches!(field(&cbor::decode(&reply).unwrap(),3),Cbor::Array(rows) if !rows.is_empty())
    );
    cp.append(
        &svc,
        vec![mdbn_wire::policy::PolicyOp::GrantRevoke(
            mdbn_wire::policy::GrantRevoke { grant },
        )],
    );
    r.store().armed.set(false);
    let mut log = svc.client(r.cfg.device_id);
    pump(&mut r, &mut log);
    // Revocation closes the original frame session and purges unsent results.
    // It is not a live session that can receive subsequent response frames.
    frames.pump(&mut r);
    assert_eq!(frames.take_closed(), vec![session]);
    let closed = frames
        .take_outgoing()
        .into_iter()
        .find_map(|(_, bytes)| {
            match ClientFrame::from_cbor(&cbor::decode(&bytes).unwrap()).unwrap() {
                ClientFrame::Push(push) if push.kind == "closed" => {
                    Some(mdbn_wire::client::Problem::from_cbor(&push.payload).unwrap())
                }
                _ => None,
            }
        })
        .unwrap();
    assert_eq!(closed.code, "unauthenticated");
    for method in [
        "app_bases_list_views_v1",
        "app_bases_read_view_source_v1",
        "app_bases_execute_v1",
    ] {
        frames.on_frame(&mut r, session, &frame(2, method, params(list())));
        assert!(frames.take_outgoing().is_empty());
    }
    assert_eq!(
        r.encode_app_bases_list_views(session, &list())
            .unwrap_err()
            .code(),
        Some(ErrorCode::Unauthenticated)
    );
    assert_eq!(
        r.encode_app_bases_read_view_source(session, &list())
            .unwrap_err()
            .code(),
        Some(ErrorCode::Unauthenticated)
    );
    assert_eq!(
        r.encode_app_bases_execute(session, &list())
            .unwrap_err()
            .code(),
        Some(ErrorCode::Unauthenticated)
    );
}
#[test]
fn empty_native_catalog_is_authoritative_but_bad_scope_and_malformed_reads_are_problems() {
    let (svc, mut a, _) = configured();
    let grant = B16([0x52; 16]);
    let key = [0x62; 32];
    approve(&svc, &mut a, grant, key, Some(vec!["photos".into()]));
    let mut r = projected(&svc, a);
    r.store().armed.set(false);
    let mut frames = Frames::new();
    let host = open(&mut r, &mut frames, SessionAuth::Host);
    let reply = bytes(rpc(
        &mut r,
        &mut frames,
        host,
        "app_bases_list_views_v1",
        params(list()),
    ));
    let decoded = cbor::decode(&reply).unwrap();
    assert_eq!(field(&decoded, 1), &Cbor::Array(vec![]));
    assert_eq!(field(&decoded, 4), &Cbor::Null);
    let narrow = open(
        &mut r,
        &mut frames,
        SessionAuth::Grant {
            grant,
            client_pk: key,
        },
    );
    for method in [
        "app_bases_list_views_v1",
        "app_bases_read_view_source_v1",
        "app_bases_execute_v1",
    ] {
        let reply = rpc(&mut r, &mut frames, narrow, method, params(list()));
        assert!(reply.result.is_none());
        let problem = reply.problem.unwrap();
        assert_eq!(problem.code, "forbidden");
        assert_eq!(
            problem.reason.as_deref(),
            Some("view_full_collection_required")
        );
        for invalid in [
            params(vec![]),
            params(vec![0; 128 * 1024 + 1]),
            params(vec![0xff]),
            Cbor::Map(vec![(Cbor::Uint(0), Cbor::Text("wrong type".into()))]),
            Cbor::Map(vec![
                (Cbor::Uint(0), Cbor::Bytes(list())),
                (Cbor::Uint(1), Cbor::Uint(host.0)),
            ]),
        ] {
            let reply = rpc(&mut r, &mut frames, host, method, invalid);
            assert!(reply.result.is_none());
            assert_eq!(reply.problem.unwrap().code, "invalid_request");
        }
    }
}
