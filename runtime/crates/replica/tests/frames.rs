//! The frame layer against a scripted `ClientApi`: dispatch, problems, pushes,
//! `wait: confirmed`, `await` with timeout, `cancel`, and fence callbacks.

use mdbn_replica::api::*;
use mdbn_replica::frames::Frames;
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::client::*;
use mdbn_wire::common::{B16, B32, DataMap, Hash, Uuid, Value};
use mdbn_wire::intent::{FileInclusion, MediaClass};
use mdbn_wire::policy::Role;
use mdbn_wire::schema::Wire;

fn uuid(n: u8) -> Uuid {
    B16([n; 16])
}

#[test]
fn bounded_file_chunk_encoder_preserves_existing_wire_bytes() {
    for count in [0, 1, 1 << 20] {
        let chunk = FileChunk {
            stream: (1 << 53) - 1,
            offset: u64::MAX - count as u64,
            bytes: mdbn_wire::common::Bytes(vec![0x65; count]),
            last: true,
        };
        let standard = ClientFrame::Push(ClientPush {
            kind: "file_chunk".into(),
            payload: chunk.to_cbor(),
        })
        .to_bytes()
        .unwrap();
        assert_eq!(mdbn_replica::frames::file_chunk_push(chunk), standard);
    }
}

#[test]
fn hosted_file_request_codec_preserves_ids_and_refuses_bad_ranges() {
    use mdbn_replica::frames::{FileReadRequest, file_read_request};
    let req = |method: &str, params: Cbor| {
        ClientFrame::Request(ClientRequest {
            id: 42,
            method: method.into(),
            params,
        })
        .to_bytes()
        .unwrap()
    };
    let frame = req(
        "read_file",
        Cbor::Map(vec![
            (Cbor::Uint(0), uuid(2).to_cbor()),
            (
                Cbor::Uint(1),
                Cbor::Array(vec![Cbor::Uint(4), Cbor::Uint(5)]),
            ),
        ]),
    );
    let (id, parsed) = file_read_request(&frame).unwrap();
    assert_eq!(id, 42);
    assert!(matches!(
        parsed.unwrap(),
        FileReadRequest::Read {
            target: Target::Id(_),
            range: Some((4, 5)),
            revision: None
        }
    ));
    let frame = req(
        "read_file",
        Cbor::Map(vec![
            (Cbor::Uint(0), uuid(2).to_cbor()),
            (Cbor::Uint(1), Cbor::Array(vec![Cbor::Uint(4)])),
        ]),
    );
    let (id, parsed) = file_read_request(&frame).unwrap();
    assert_eq!(id, 42);
    assert!(parsed.is_err());
    assert!(file_read_request(&req("status", Cbor::Null)).is_none());
}

fn status() -> SyncStatus {
    SyncStatus {
        resyncing: None,
        confirmed_head: None,
        mode: SyncMode::Synced,
        confirmed_through: 7,
        head_known: 7,
        pending: 0,
        oldest_pending: None,
        holds: 0,
        unresolved: 0,
        connection: Connection::Online,
        installing: None,
        incidents: vec![],
    }
}

fn record(id: Uuid) -> RecordView {
    RecordView {
        id,
        path: "a.md".into(),
        revision: B32([1; 32]),
        frontmatter: DataMap(vec![("status".into(), Value::Text("open".into()))]),
        effective: None,
        body: None,
        document: None,
        types: vec!["task".into()],
        state: RecordState {
            state: Confirmation::Confirmed,
            confirmed_seq: 7,
            hold: None,
            unresolved: None,
        },
        diagnostics: None,
        values: None,
    }
}

fn pending(m: Uuid) -> Receipt {
    Receipt {
        relocated_from: None,
        mutation: m,
        state: ReceiptState::Pending,
        seq: None,
        status: None,
        conflicts: None,
        records: None,
        problem: None,
        published: None,
    }
}

/// A scripted replica: answers a few methods, queues pushes the test asks for.
#[derive(Default)]
struct Mock {
    pushes: Vec<(SessionId, Push)>,
    receipts: Vec<Receipt>,
    submit_receipts: Option<Vec<Receipt>>,
    fence_results: Vec<(CallbackId, FenceResult)>,
    closed: Vec<SessionId>,
    next_session: u64,
    describe_empty: bool,
    query_calls: Vec<(Value, Include)>,
    resource_calls: Vec<ListResources>,
}

fn nyi<T>() -> ApiResult<T> {
    Err(ErrorCode::Unavailable.err_with_reason("not_implemented", "mock"))
}

impl ClientApi for Mock {
    fn hello(&mut self, auth: SessionAuth, p: HelloParams) -> ApiResult<(SessionId, HelloResult)> {
        if p.client_name == "refused" {
            return Err(ErrorCode::Forbidden.err("no"));
        }
        self.next_session += 1;
        let grant = match auth {
            SessionAuth::Host => None,
            SessionAuth::Grant { grant, .. } => Some(grant),
        };
        Ok((
            SessionId(self.next_session),
            HelloResult {
                version: p.versions[0],
                runtime_version: "test".into(),
                sem: mdbn_wire::common::Version { major: 1, minor: 0 },
                collection: uuid(9),
                grant: GrantInfo {
                    grant,
                    capabilities: vec!["collection.read".into()],
                    role: Role::Owner,
                },
                status: status(),
                features: vec![],
                head_witness: None,
            },
        ))
    }
    fn close(&mut self, s: SessionId) {
        self.closed.push(s);
    }
    fn describe(&mut self, _: SessionId) -> ApiResult<Describe> {
        Ok(Describe {
            spec_version: "0.3.0-rc.5".into(),
            types: if self.describe_empty {
                vec![]
            } else {
                vec![TypeSummary {
                    name: "task".into(),
                    path: "_types/task.md".into(),
                    implements: vec![ContractImplementation {
                        contract: "acme.task".into(),
                        version: "1.2.0".into(),
                        fields: mdbn_wire::common::DataMap(vec![(
                            "/done".into(),
                            "/completed".into(),
                        )]),
                        binding: Some(Value::Map(vec![(
                            "workspace".into(),
                            Value::Text("personal".into()),
                        )])),
                    }],
                }]
            },
            settings: Value::Map(vec![]),
            inclusion: FileInclusion {
                include: vec![MediaClass::Image],
                exclude: None,
                max_size: None,
            },
            issues: vec![],
            contracts: if self.describe_empty {
                vec![]
            } else {
                vec![ContractSummary {
                    id: "acme.task".into(),
                    version: "1.2.0".into(),
                    path: "_contracts/task.md".into(),
                    digest: mdbn_wire::common::B32([0x55; 32]),
                    contract_type: "record".into(),
                    implemented_by: vec!["task".into()],
                }]
            },
        })
    }
    fn get_resource(&mut self, _: SessionId, path: String) -> ApiResult<ResourceView> {
        Ok(ResourceView {
            path,
            revision: B32([8; 32]),
            size: 3,
            confirmed: true,
            text: "abc".into(),
        })
    }
    fn list_resources(&mut self, _: SessionId, params: ListResources) -> ApiResult<ResourceList> {
        self.resource_calls.push(params.clone());
        Ok(ResourceList {
            resources: vec![ResourceListEntry {
                path: "_types/task.md".into(),
                revision: B32([8; 32]),
                size: 3,
                confirmed: true,
                text: params.text.unwrap_or(false).then(|| "abc".into()),
            }],
            complete: true,
            cursor: None,
        })
    }
    fn get(&mut self, _: SessionId, t: Target, _: Include) -> ApiResult<RecordView> {
        match t {
            Target::Id(id) => Ok(record(id)),
            Target::Path(_) => Err(ErrorCode::NotFound.err("no such record")),
        }
    }
    fn query(&mut self, _: SessionId, query: Value, include: Include) -> ApiResult<QueryResult> {
        self.query_calls.push((query, include));
        nyi()
    }
    fn subscribe(&mut self, s: SessionId, _: Value, _: Include) -> ApiResult<u64> {
        self.pushes.push((
            s,
            Push::QueryUpdate(QueryUpdate {
                sub: 3,
                kind: UpdateKind::Snapshot,
                added: Some(vec![record(uuid(2))]),
                changed: None,
                removed: None,
                order: None,
                complete: true,
                as_of: 1,
                metadata: None,
            }),
        ));
        Ok(3)
    }
    fn unsubscribe(&mut self, _: SessionId, _: u64) -> ApiResult<()> {
        Ok(())
    }
    fn changes(
        &mut self,
        _: SessionId,
        _: Option<String>,
        _: Option<u32>,
        _: bool,
    ) -> ApiResult<ChangesResult> {
        nyi()
    }
    fn validate(
        &mut self,
        _: SessionId,
        _: Option<Vec<Target>>,
    ) -> ApiResult<Vec<(Uuid, Vec<Issue>)>> {
        nyi()
    }
    fn submit(&mut self, _: SessionId, p: SubmitParams) -> ApiResult<Vec<Receipt>> {
        let rs = self
            .submit_receipts
            .take()
            .unwrap_or_else(|| vec![pending(p.mutation_id.unwrap_or(uuid(5)))]);
        self.receipts.extend(rs.iter().cloned());
        Ok(rs)
    }
    fn receipt(&mut self, _: SessionId, m: Uuid) -> ApiResult<Receipt> {
        self.receipts
            .iter()
            .rev()
            .find(|r| r.mutation == m)
            .cloned()
            .ok_or_else(|| ErrorCode::NotFound.err("no such mutation"))
    }
    fn status(&mut self, _: SessionId) -> ApiResult<SyncStatus> {
        Ok(status())
    }
    fn subscribe_status(&mut self, _: SessionId) -> ApiResult<()> {
        Ok(())
    }
    fn list_holds(&mut self, _: SessionId) -> ApiResult<Vec<Hold>> {
        Ok(vec![])
    }
    fn subscribe_holds(&mut self, _: SessionId) -> ApiResult<()> {
        Ok(())
    }
    fn resolve_hold(&mut self, _: SessionId, _: Uuid, _: HoldResolution) -> ApiResult<Receipt> {
        nyi()
    }
    fn list_conflicts(&mut self, _: SessionId, _: Option<Uuid>) -> ApiResult<Vec<ConflictEntry>> {
        Ok(vec![])
    }
    fn subscribe_conflicts(&mut self, _: SessionId) -> ApiResult<()> {
        Ok(())
    }
    fn pending_devices(&mut self, _: SessionId) -> ApiResult<Vec<PendingDevice>> {
        nyi()
    }
    fn approve_device(&mut self, _: SessionId, _: Uuid, _: String) -> ApiResult<()> {
        nyi()
    }
    fn reject_device(&mut self, _: SessionId, _: Uuid) -> ApiResult<()> {
        nyi()
    }
    fn list_files(&mut self, _: SessionId, _: ListFiles) -> ApiResult<FileList> {
        nyi()
    }
    fn get_file(&mut self, _: SessionId, _: Target) -> ApiResult<FileView> {
        nyi()
    }
    fn open_upload(&mut self, _: SessionId, _: OpenUploadParams) -> ApiResult<OpenUploadResult> {
        nyi()
    }
    fn upload_chunk(&mut self, _: SessionId, _: UploadChunkParams) -> ApiResult<u64> {
        nyi()
    }
    fn commit_upload(&mut self, _: SessionId, _: Uuid) -> ApiResult<Receipt> {
        nyi()
    }
    fn abort_upload(&mut self, _: SessionId, _: Uuid) -> ApiResult<()> {
        nyi()
    }
    fn read_file(
        &mut self,
        _: SessionId,
        _: Target,
        _: Option<(u64, u64)>,
        _: Option<Hash>,
    ) -> ApiResult<(StreamId, FileView)> {
        nyi()
    }
    fn ack_chunks(&mut self, _: SessionId, _: StreamId, _: u64) -> ApiResult<()> {
        nyi()
    }
    fn fetch_file(&mut self, _: SessionId, _: Uuid) -> ApiResult<()> {
        nyi()
    }
    fn evict_file(&mut self, _: SessionId, _: Uuid) -> ApiResult<()> {
        nyi()
    }
    fn get_materialization(&mut self, _: SessionId) -> ApiResult<Materialization> {
        nyi()
    }
    fn set_materialization(&mut self, _: SessionId, _: Materialization) -> ApiResult<()> {
        nyi()
    }
    fn presence_join(&mut self, _: SessionId, _: Uuid, _: Value) -> ApiResult<()> {
        Ok(())
    }
    fn presence_update(&mut self, _: SessionId, _: Uuid, _: Value) -> ApiResult<()> {
        Ok(())
    }
    fn presence_leave(&mut self, _: SessionId, _: Uuid) -> ApiResult<()> {
        Ok(())
    }
    fn subscribe_presence(&mut self, _: SessionId, _: Uuid) -> ApiResult<()> {
        Ok(())
    }
    fn fence_report(&mut self, s: SessionId, editors: Vec<FenceEditor>) -> ApiResult<()> {
        // Ask the client to apply an edit to the first open file.
        if let Some(e) = editors.first() {
            self.pushes.push((
                s,
                Push::FenceApply {
                    id: CallbackId(77),
                    apply: FenceApply {
                        path: e.path.clone(),
                        base: e.buffer,
                        edits: vec![(0, 0, "x".into())],
                        expected: B32([3; 32]),
                    },
                },
            ));
        }
        Ok(())
    }
    fn fence_result(&mut self, _: SessionId, id: CallbackId, r: FenceResult) -> ApiResult<()> {
        self.fence_results.push((id, r));
        Ok(())
    }
    fn take_pushes(&mut self) -> Vec<(SessionId, Push)> {
        std::mem::take(&mut self.pushes)
    }
}

fn smap(e: Vec<(u64, Cbor)>) -> Cbor {
    Cbor::Map(e.into_iter().map(|(k, v)| (Cbor::Uint(k), v)).collect())
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

fn frames_out(f: &mut Frames) -> Vec<ClientFrame> {
    f.take_outgoing()
        .into_iter()
        .map(|(_, b)| ClientFrame::from_cbor(&cbor::decode(&b).unwrap()).unwrap())
        .collect()
}

fn open() -> (Mock, Frames, SessionId) {
    let mut api = Mock::default();
    let mut f = Frames::new();
    let hello = HelloParams {
        versions: vec![mdbn_wire::common::Version { major: 1, minor: 0 }],
        client_name: "t".into(),
        client_version: "0".into(),
        features: None,
        timezone: None,
    };
    let out = f.hello(
        &mut api,
        SessionAuth::Host,
        &request(0, "hello", hello.to_cbor()),
    );
    let s = out.session.expect("session");
    match ClientFrame::from_cbor(&cbor::decode(&out.response).unwrap()).unwrap() {
        ClientFrame::Response(r) => {
            assert_eq!(r.id, 0);
            let h = HelloResult::from_cbor(&r.result.unwrap()).unwrap();
            assert_eq!(h.collection, uuid(9));
        }
        other => panic!("{other:?}"),
    }
    (api, f, s)
}

fn response(fr: &ClientFrame) -> &ClientResponse {
    match fr {
        ClientFrame::Response(r) => r,
        other => panic!("expected a response, got {other:?}"),
    }
}

#[test]
fn hello_refused_is_a_problem_response() {
    let mut api = Mock::default();
    let mut f = Frames::new();
    let hello = HelloParams {
        versions: vec![mdbn_wire::common::Version { major: 1, minor: 0 }],
        client_name: "refused".into(),
        client_version: "0".into(),
        features: None,
        timezone: None,
    };
    let out = f.hello(
        &mut api,
        SessionAuth::Host,
        &request(0, "hello", hello.to_cbor()),
    );
    assert!(out.session.is_none());
    let fr = ClientFrame::from_cbor(&cbor::decode(&out.response).unwrap()).unwrap();
    assert_eq!(response(&fr).problem.as_ref().unwrap().code, "forbidden");
}

#[test]
fn first_request_must_be_hello() {
    let mut api = Mock::default();
    let mut f = Frames::new();
    let out = f.hello(
        &mut api,
        SessionAuth::Host,
        &request(0, "describe", Cbor::Null),
    );
    assert!(out.session.is_none());
    let fr = ClientFrame::from_cbor(&cbor::decode(&out.response).unwrap()).unwrap();
    assert_eq!(
        response(&fr).problem.as_ref().unwrap().code,
        "unauthenticated"
    );
}

#[test]
fn dispatches_reads_and_maps_errors() {
    let (mut api, mut f, s) = open();
    f.on_frame(
        &mut api,
        s,
        &request(1, "get", smap(vec![(0, uuid(4).to_cbor())])),
    );
    f.on_frame(
        &mut api,
        s,
        &request(2, "get", smap(vec![(0, Cbor::Text("x.md".into()))])),
    );
    f.on_frame(&mut api, s, &request(3, "nope", Cbor::Null));
    f.on_frame(&mut api, s, &request(4, "get", Cbor::Text("bad".into())));
    f.on_frame(&mut api, s, &request(5, "describe", Cbor::Null));
    let out = frames_out(&mut f);
    assert_eq!(out.len(), 5);
    let r = RecordView::from_cbor(response(&out[0]).result.as_ref().unwrap()).unwrap();
    assert_eq!(r.id, uuid(4));
    assert_eq!(
        response(&out[1]).problem.as_ref().unwrap().code,
        "not_found"
    );
    let p = response(&out[2]).problem.as_ref().unwrap();
    assert_eq!(
        (p.code.as_str(), p.reason.as_deref()),
        ("invalid_request", Some("unknown_method"))
    );
    assert_eq!(
        response(&out[3]).problem.as_ref().unwrap().code,
        "invalid_request"
    );
    assert!(response(&out[4]).result.is_some());
}

#[test]
fn query_rejects_unknown_params_before_evaluation() {
    for key in [2, 3, u64::MAX] {
        let (mut api, mut f, s) = open();
        let query = Value::Map(vec![("type".into(), Value::Text("task".into()))]);
        f.on_frame(
            &mut api,
            s,
            &request(
                1,
                "query",
                smap(vec![
                    (0, query.to_cbor()),
                    (key, Cbor::Text("acme.task".into())),
                ]),
            ),
        );
        let out = frames_out(&mut f);
        assert_eq!(out.len(), 1);
        let reply = response(&out[0]);
        assert!(reply.result.is_none());
        let problem = reply.problem.as_ref().unwrap();
        assert_eq!(problem.code, "invalid_request");
        assert_eq!(problem.reason.as_deref(), Some("unknown_param"));
        assert!(
            api.query_calls.is_empty(),
            "unknown filter must not be ignored"
        );
    }
}

#[test]
fn query_known_params_still_reach_the_existing_evaluator() {
    for explicit_include in [false, true] {
        let (mut api, mut f, s) = open();
        let query = Value::Map(vec![("type".into(), Value::Text("task".into()))]);
        let include = Include {
            effective: None,
            body: explicit_include.then_some(true),
            document: None,
            diagnostics: None,
        };
        let mut params = vec![(0, query.to_cbor())];
        if explicit_include {
            params.push((1, include.to_cbor()));
        }
        f.on_frame(&mut api, s, &request(1, "query", smap(params)));
        let out = frames_out(&mut f);
        assert_eq!(out.len(), 1);
        assert_eq!(api.query_calls, vec![(query, include)]);
        // The scripted evaluator's ordinary refusal proves dispatch reached it.
        let problem = response(&out[0]).problem.as_ref().unwrap();
        assert_eq!(problem.code, "unavailable");
        assert_eq!(problem.reason.as_deref(), Some("not_implemented"));
    }
}

#[test]
fn resource_frame_emits_exact_existing_sdk_source_shape() {
    let (mut api, mut f, s) = open();
    f.on_frame(
        &mut api,
        s,
        &request(
            1,
            "get_resource",
            smap(vec![(0, Cbor::Text("_types/task.md".into()))]),
        ),
    );
    let replies = f.take_outgoing();
    assert_eq!(replies.len(), 1);
    let fixture = include_str!("../../../conformance/resources/get.hex").trim();
    assert_eq!(
        replies[0]
            .1
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>(),
        fixture
    );
    let frame = ClientFrame::from_cbor(&cbor::decode(&replies[0].1).unwrap()).unwrap();
    let ClientFrame::Response(reply) = frame else {
        panic!("response expected")
    };
    assert_eq!(
        reply.result,
        Some(smap(vec![
            (0, Cbor::Text("_types/task.md".into())),
            (1, B32([8; 32]).to_cbor()),
            (2, Cbor::Uint(3)),
            (3, Cbor::Uint(0)),
            (4, Cbor::Text("abc".into())),
        ]))
    );
    for params in [
        Cbor::Null,
        smap(vec![]),
        smap(vec![(0, Cbor::Uint(1))]),
        smap(vec![
            (0, Cbor::Text("mdbase.yaml".into())),
            (1, Cbor::Bool(true)),
        ]),
    ] {
        f.on_frame(&mut api, s, &request(2, "get_resource", params));
        let replies = f.take_outgoing();
        let ClientFrame::Response(reply) =
            ClientFrame::from_cbor(&cbor::decode(&replies[0].1).unwrap()).unwrap()
        else {
            panic!("response expected")
        };
        assert!(reply.result.is_none());
        assert_eq!(reply.problem.unwrap().code, "invalid_request");
    }
}

#[test]
fn list_resource_dispatch_defaults_options_and_rejections_are_typed() {
    let (mut api, mut f, s) = open();
    for (params, want) in [
        (smap(vec![]), ListResources::default()),
        (
            smap(vec![
                (0, Cbor::Text("_types".into())),
                (1, Cbor::Bool(true)),
                (2, Cbor::Text("r1.00000000000000000000000000000000".into())),
                (3, Cbor::Uint(7)),
            ]),
            ListResources {
                folder: Some("_types".into()),
                text: Some(true),
                cursor: Some("r1.00000000000000000000000000000000".into()),
                limit: Some(7),
            },
        ),
    ] {
        f.on_frame(&mut api, s, &request(1, "list_resources", params));
        let out = frames_out(&mut f);
        assert_eq!(api.resource_calls.last(), Some(&want));
        let result = response(&out[0]).result.as_ref().unwrap();
        let mut row = vec![
            (0, Cbor::Text("_types/task.md".into())),
            (1, B32([8; 32]).to_cbor()),
            (2, Cbor::Uint(3)),
            (3, Cbor::Uint(0)),
        ];
        if want.text.unwrap_or(false) {
            row.push((4, Cbor::Text("abc".into())));
        }
        assert_eq!(
            result,
            &smap(vec![
                (0, Cbor::Array(vec![smap(row)])),
                (1, Cbor::Bool(true))
            ])
        );
    }
    let before = api.resource_calls.len();
    for (params, code, reason) in [
        (Cbor::Null, "invalid_request", "invalid_resource_params"),
        (
            smap(vec![(4, Cbor::Uint(1))]),
            "invalid_request",
            "unknown_param",
        ),
        (
            Cbor::Map(vec![(
                Cbor::Text("folder".into()),
                Cbor::Text("_types".into()),
            )]),
            "invalid_request",
            "unknown_param",
        ),
        (
            smap(vec![(0, Cbor::Null)]),
            "invalid_request",
            "invalid_resource_params",
        ),
        (
            smap(vec![(1, Cbor::Uint(1))]),
            "invalid_request",
            "invalid_resource_params",
        ),
        (
            smap(vec![(2, Cbor::Bool(false))]),
            "invalid_request",
            "invalid_resource_params",
        ),
        (
            smap(vec![(3, Cbor::Bool(true))]),
            "invalid_request",
            "invalid_resource_params",
        ),
        (
            smap(vec![(3, Cbor::Uint(0))]),
            "invalid_request",
            "invalid_resource_params",
        ),
        (
            smap(vec![(3, Cbor::Uint(129))]),
            "too_large",
            "resource_budget_exceeded",
        ),
        (
            smap(vec![(3, Cbor::Uint(u64::MAX))]),
            "too_large",
            "resource_budget_exceeded",
        ),
        (
            smap(vec![(0, Cbor::Text("x".repeat(4097)))]),
            "too_large",
            "resource_budget_exceeded",
        ),
        (
            smap(vec![(2, Cbor::Text("x".repeat(4097)))]),
            "too_large",
            "resource_budget_exceeded",
        ),
    ] {
        f.on_frame(&mut api, s, &request(2, "list_resources", params));
        let out = frames_out(&mut f);
        let problem = response(&out[0]).problem.as_ref().unwrap();
        assert_eq!(problem.code, code);
        assert_eq!(problem.reason.as_deref(), Some(reason));
        assert_eq!(
            api.resource_calls.len(),
            before,
            "invalid params reached producer"
        );
    }
}

#[test]
fn describe_emits_required_contracts_and_type_maps() {
    let (mut api, mut f, s) = open();
    f.on_frame(&mut api, s, &request(1, "describe", Cbor::Null));
    let out = frames_out(&mut f);
    let result = response(&out[0]).result.as_ref().unwrap();
    let Cbor::Map(fields) = result else {
        panic!("describe must be a map")
    };
    assert!(
        fields.iter().any(|(key, _)| *key == Cbor::Uint(5)),
        "required contracts key5"
    );
    let types = &fields
        .iter()
        .find(|(key, _)| *key == Cbor::Uint(1))
        .unwrap()
        .1;
    let Cbor::Array(types) = types else {
        panic!("types must be an array")
    };
    assert!(
        matches!(&types[0], Cbor::Map(_)),
        "types must contain TypeSummary maps, not names"
    );
}

#[test]
fn describe_empty_catalog_keeps_required_arrays() {
    let (mut api, mut f, s) = open();
    api.describe_empty = true;
    f.on_frame(&mut api, s, &request(1, "describe", Cbor::Null));
    let out = frames_out(&mut f);
    let Cbor::Map(fields) = response(&out[0]).result.as_ref().unwrap() else {
        panic!("describe must be a map")
    };
    for key in [1, 5] {
        assert_eq!(
            fields
                .iter()
                .find(|(k, _)| *k == Cbor::Uint(key))
                .unwrap()
                .1,
            Cbor::Array(vec![])
        );
    }
}

#[test]
fn describe_frame_matches_shared_sdk_fixture() {
    let (mut api, mut f, s) = open();
    f.on_frame(&mut api, s, &request(1, "describe", Cbor::Null));
    let out = frames_out(&mut f);
    let hex = include_str!("../../../conformance/describe/populated.hex").trim();
    let bytes: Vec<u8> = hex
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect();
    assert_eq!(
        cbor::encode(response(&out[0]).result.as_ref().unwrap()).unwrap(),
        bytes
    );
}

#[test]
fn subscribe_answers_then_pushes_the_snapshot() {
    let (mut api, mut f, s) = open();
    f.on_frame(
        &mut api,
        s,
        &request(1, "subscribe", smap(vec![(0, Cbor::Map(vec![]))])),
    );
    let out = frames_out(&mut f);
    assert_eq!(out.len(), 2);
    assert_eq!(
        response(&out[0]).result,
        Some(smap(vec![(0, Cbor::Uint(3))]))
    );
    match &out[1] {
        ClientFrame::Push(p) => {
            assert_eq!(p.kind, "query_update");
            assert_eq!(QueryUpdate::from_cbor(&p.payload).unwrap().sub, 3);
        }
        other => panic!("{other:?}"),
    }
}

fn submit_params(m: Uuid, wait: Option<WaitFor>) -> Cbor {
    SubmitParams {
        ops: vec![mdbn_wire::intent::Op::Delete(mdbn_wire::intent::Delete {
            id: uuid(4),
            base_revision: None,
            if_revision: None,
        })],
        mutation_id: Some(m),
        conflict_mode: None,
        timezone: None,
        allow_partial: None,
        mutation_ids: None,
        dry_run: None,
        include: None,
        wait,
    }
    .to_cbor()
}

fn confirmed(m: Uuid) -> Receipt {
    Receipt {
        state: ReceiptState::Confirmed,
        seq: Some(8),
        status: Some(mdbn_wire::entry::Status::Applied),
        ..pending(m)
    }
}

#[test]
fn wait_confirmed_holds_the_response_until_the_receipt_settles() {
    let (mut api, mut f, s) = open();
    f.on_frame(
        &mut api,
        s,
        &request(
            1,
            "submit",
            submit_params(uuid(6), Some(WaitFor::Confirmed)),
        ),
    );
    assert!(frames_out(&mut f).is_empty(), "held");
    api.receipts.push(confirmed(uuid(6)));
    api.pushes.push((s, Push::Receipt(confirmed(uuid(6)))));
    f.pump(&mut api);
    let out = frames_out(&mut f);
    // The receipt push, then the held response.
    assert_eq!(out.len(), 2);
    let r = Vec::<Receipt>::from_cbor(response(&out[1]).result.as_ref().unwrap()).unwrap();
    assert_eq!(r[0].state, ReceiptState::Confirmed);
}

#[test]
fn wait_published_and_confirmation_are_independent() {
    for published_first in [false, true] {
        let (mut api, mut f, s) = open();
        let mut r = pending(uuid(6));
        r.published = Some(PublishState::Publishing);
        api.submit_receipts = Some(vec![r]);
        f.on_frame(
            &mut api,
            s,
            &request(
                1,
                "submit",
                submit_params(uuid(6), Some(WaitFor::Published)),
            ),
        );
        f.on_frame(
            &mut api,
            s,
            &request(2, "await", smap(vec![(0, uuid(6).to_cbor())])),
        );
        assert!(frames_out(&mut f).is_empty());
        let mut intermediate = if published_first {
            pending(uuid(6))
        } else {
            confirmed(uuid(6))
        };
        intermediate.published = Some(if published_first {
            PublishState::Published
        } else {
            PublishState::Publishing
        });
        api.receipts.push(intermediate.clone());
        api.pushes.push((s, Push::Receipt(intermediate.clone())));
        f.pump(&mut api);
        let out = frames_out(&mut f);
        assert_eq!(out.len(), 2, "only one criterion is satisfied");
        assert!(matches!(out[0], ClientFrame::Push(_)));
        assert_eq!(response(&out[1]).id, if published_first { 1 } else { 2 });
        if published_first {
            let rs = Vec::<Receipt>::from_cbor(response(&out[1]).result.as_ref().unwrap()).unwrap();
            assert_eq!(rs, vec![intermediate]);
        } else {
            let rc = Receipt::from_cbor(response(&out[1]).result.as_ref().unwrap()).unwrap();
            assert_eq!(rc, intermediate);
        }
        let mut final_receipt = confirmed(uuid(6));
        final_receipt.published = Some(PublishState::Published);
        api.receipts.push(final_receipt.clone());
        api.pushes.push((s, Push::Receipt(final_receipt)));
        f.pump(&mut api);
        let out = frames_out(&mut f);
        assert_eq!(out.len(), 2);
        assert!(matches!(out[0], ClientFrame::Push(_)));
        assert_eq!(response(&out[1]).id, if published_first { 2 } else { 1 });
    }
}

#[test]
fn wait_published_returns_immediately_for_final_or_absent_publication() {
    for state in [
        ReceiptState::Pending,
        ReceiptState::Confirmed,
        ReceiptState::Rejected,
        ReceiptState::Unknown,
    ] {
        for published in [
            None,
            Some(PublishState::Published),
            Some(PublishState::NotPublished),
            Some(PublishState::Publishing),
        ] {
            if matches!(state, ReceiptState::Pending | ReceiptState::Confirmed)
                && published == Some(PublishState::Publishing)
            {
                continue;
            }
            let (mut api, mut f, s) = open();
            let r = Receipt {
                state,
                published,
                ..pending(uuid(6))
            };
            api.submit_receipts = Some(vec![r.clone()]);
            f.on_frame(
                &mut api,
                s,
                &request(
                    1,
                    "submit",
                    submit_params(uuid(6), Some(WaitFor::Published)),
                ),
            );
            let out = frames_out(&mut f);
            assert_eq!(out.len(), 1, "{state:?} {published:?}");
            let rs = Vec::<Receipt>::from_cbor(response(&out[0]).result.as_ref().unwrap()).unwrap();
            assert_eq!(rs, vec![r]);
        }
    }
}

#[test]
fn wait_published_waits_for_every_receipt_and_preserves_order() {
    let (mut api, mut f, s) = open();
    let mut first = pending(uuid(6));
    first.published = Some(PublishState::Publishing);
    let mut second = confirmed(uuid(7));
    second.published = Some(PublishState::Publishing);
    api.submit_receipts = Some(vec![first.clone(), second.clone()]);
    f.on_frame(
        &mut api,
        s,
        &request(
            1,
            "submit",
            submit_params(uuid(6), Some(WaitFor::Published)),
        ),
    );
    assert!(frames_out(&mut f).is_empty());
    first.published = Some(PublishState::Published);
    api.pushes.push((s, Push::Receipt(first.clone())));
    f.pump(&mut api);
    let out = frames_out(&mut f);
    assert_eq!(out.len(), 1);
    assert!(matches!(out[0], ClientFrame::Push(_)));
    first = confirmed(uuid(6));
    first.published = Some(PublishState::Published);
    api.pushes.push((s, Push::Receipt(first.clone())));
    f.pump(&mut api);
    let out = frames_out(&mut f);
    assert_eq!(out.len(), 1, "another mutation is still publishing");
    assert!(matches!(out[0], ClientFrame::Push(_)));
    second.published = Some(PublishState::NotPublished);
    api.pushes.push((s, Push::Receipt(second.clone())));
    f.pump(&mut api);
    let out = frames_out(&mut f);
    assert_eq!(out.len(), 2);
    let rs = Vec::<Receipt>::from_cbor(response(&out[1]).result.as_ref().unwrap()).unwrap();
    assert_eq!(rs, vec![first, second]);
}

#[test]
fn wait_published_settles_on_nonpublication_or_rejection() {
    for state in [
        ReceiptState::Pending,
        ReceiptState::Confirmed,
        ReceiptState::Rejected,
        ReceiptState::Unknown,
    ] {
        let (mut api, mut f, s) = open();
        let mut r = pending(uuid(6));
        r.published = Some(PublishState::Publishing);
        api.submit_receipts = Some(vec![r.clone()]);
        f.on_frame(
            &mut api,
            s,
            &request(
                1,
                "submit",
                submit_params(uuid(6), Some(WaitFor::Published)),
            ),
        );
        assert!(frames_out(&mut f).is_empty());
        r.state = state;
        r.published = if matches!(state, ReceiptState::Pending | ReceiptState::Confirmed) {
            Some(PublishState::NotPublished)
        } else {
            None
        };
        api.pushes.push((s, Push::Receipt(r.clone())));
        f.pump(&mut api);
        let out = frames_out(&mut f);
        assert_eq!(out.len(), 2);
        let rs = Vec::<Receipt>::from_cbor(response(&out[1]).result.as_ref().unwrap()).unwrap();
        assert_eq!(rs, vec![r]);
    }
}

#[test]
fn wait_published_keeps_the_timeout_cancel_and_close_bounds() {
    use mdbn_replica::frames::MAX_HOLD_MS;
    for action in ["timeout", "cancel", "close"] {
        let (mut api, mut f, s) = open();
        let mut r = pending(uuid(6));
        r.published = Some(PublishState::Publishing);
        api.submit_receipts = Some(vec![r.clone()]);
        f.on_frame(
            &mut api,
            s,
            &request(
                1,
                "submit",
                submit_params(uuid(6), Some(WaitFor::Published)),
            ),
        );
        assert!(frames_out(&mut f).is_empty());
        match action {
            "timeout" => {
                f.tick(&mut api, 100);
                f.tick(&mut api, 100 + MAX_HOLD_MS - 1);
                assert!(frames_out(&mut f).is_empty());
                f.tick(&mut api, 100 + MAX_HOLD_MS);
                let out = frames_out(&mut f);
                assert_eq!(out.len(), 1);
                let rs =
                    Vec::<Receipt>::from_cbor(response(&out[0]).result.as_ref().unwrap()).unwrap();
                assert_eq!(rs, vec![r.clone()]);
            }
            "cancel" => {
                f.on_frame(
                    &mut api,
                    s,
                    &request(2, "cancel", smap(vec![(0, Cbor::Uint(1))])),
                );
                let out = frames_out(&mut f);
                assert_eq!(out.len(), 2);
                assert_eq!(response(&out[0]).id, 1);
                assert_eq!(
                    response(&out[0]).problem.as_ref().unwrap().code,
                    "cancelled"
                );
                assert_eq!(response(&out[1]).id, 2);
            }
            "close" => {
                f.close(&mut api, s);
                assert_eq!(f.take_closed(), vec![s]);
            }
            _ => unreachable!(),
        }
        r.published = Some(PublishState::Published);
        api.pushes.push((s, Push::Receipt(r)));
        f.pump(&mut api);
        let out = frames_out(&mut f);
        assert!(
            out.iter().all(|fr| !matches!(fr, ClientFrame::Response(_))),
            "no second response after {action}"
        );
    }
}

#[test]
fn submit_without_wait_returns_pending_now() {
    let (mut api, mut f, s) = open();
    f.on_frame(
        &mut api,
        s,
        &request(1, "submit", submit_params(uuid(6), None)),
    );
    let out = frames_out(&mut f);
    let r = Vec::<Receipt>::from_cbor(response(&out[0]).result.as_ref().unwrap()).unwrap();
    assert_eq!(r[0].state, ReceiptState::Pending);
}

#[test]
fn await_times_out_with_the_pending_receipt_and_can_be_cancelled() {
    let (mut api, mut f, s) = open();
    f.tick(&mut api, 1_000);
    f.on_frame(
        &mut api,
        s,
        &request(1, "submit", submit_params(uuid(6), None)),
    );
    frames_out(&mut f);
    f.on_frame(
        &mut api,
        s,
        &request(
            2,
            "await",
            smap(vec![(0, uuid(6).to_cbor()), (1, Cbor::Uint(500))]),
        ),
    );
    f.on_frame(
        &mut api,
        s,
        &request(3, "await", smap(vec![(0, uuid(6).to_cbor())])),
    );
    assert!(frames_out(&mut f).is_empty());
    f.tick(&mut api, 1_499);
    assert!(frames_out(&mut f).is_empty());
    f.tick(&mut api, 1_500);
    let out = frames_out(&mut f);
    assert_eq!(response(&out[0]).id, 2);
    assert_eq!(
        Receipt::from_cbor(response(&out[0]).result.as_ref().unwrap())
            .unwrap()
            .state,
        ReceiptState::Pending
    );
    f.on_frame(
        &mut api,
        s,
        &request(4, "cancel", smap(vec![(0, Cbor::Uint(3))])),
    );
    let out = frames_out(&mut f);
    assert_eq!(response(&out[0]).id, 3);
    assert_eq!(
        response(&out[0]).problem.as_ref().unwrap().code,
        "cancelled"
    );
    assert_eq!(response(&out[1]).id, 4);
}

#[test]
fn fence_apply_round_trips_as_a_replica_request() {
    let (mut api, mut f, s) = open();
    let report = smap(vec![(
        0,
        Cbor::Array(vec![smap(vec![
            (0, Cbor::Text("a.md".into())),
            (1, Cbor::Bool(false)),
            (2, B32([2; 32]).to_cbor()),
        ])]),
    )]);
    f.on_frame(&mut api, s, &request(1, "fence_report", report));
    let out = frames_out(&mut f);
    let req = out
        .iter()
        .find_map(|fr| match fr {
            ClientFrame::Request(r) => Some(r.clone()),
            _ => None,
        })
        .expect("fence_apply request");
    assert_eq!(req.method, "fence_apply");
    let answer = ClientFrame::Response(ClientResponse {
        id: req.id,
        result: Some(smap(vec![
            (0, Cbor::Uint(2)),
            (1, Cbor::Text("buf".into())),
        ])),
        problem: None,
    })
    .to_bytes()
    .unwrap();
    f.on_frame(&mut api, s, &answer);
    assert_eq!(
        api.fence_results,
        vec![(CallbackId(77), FenceResult::BufferChanged("buf".into()))]
    );
}

#[test]
fn closing_quarantines_already_serialized_but_unsent_plaintext() {
    let (mut api, mut f, s) = open();
    f.on_frame(
        &mut api,
        s,
        &request(1, "get", smap(vec![(0, uuid(4).to_cbor())])),
    );
    f.on_frame(
        &mut api,
        s,
        &request(2, "subscribe", smap(vec![(0, Cbor::Map(vec![]))])),
    );
    // Both a private reply and query snapshot are already in Frames' out buffer.
    let other = f
        .hello(
            &mut api,
            SessionAuth::Host,
            &request(
                0,
                "hello",
                HelloParams {
                    versions: vec![mdbn_wire::common::Version { major: 1, minor: 0 }],
                    client_name: "other".into(),
                    client_version: "0".into(),
                    features: None,
                    timezone: None,
                }
                .to_cbor(),
            ),
        )
        .session
        .unwrap();
    assert_ne!(other, s);
    f.on_frame(
        &mut api,
        other,
        &request(3, "get", smap(vec![(0, uuid(5).to_cbor())])),
    );
    api.pushes.push((
        s,
        Push::Closed(
            ErrorCode::Unavailable
                .problem_with_reason("apply_recovering", "reconnect after recovery"),
        ),
    ));
    f.pump(&mut api);
    // Duplicate close calls / queued closed pushes cannot delete the final closed
    // frame, nor enqueue it a second time after the session has been removed.
    f.close(&mut api, s);
    api.pushes
        .push((s, Push::Closed(ErrorCode::Unavailable.problem("duplicate"))));
    f.pump(&mut api);
    assert_eq!(f.take_closed(), vec![s]);
    assert!(f.take_closed().is_empty());
    let out = f.take_outgoing();
    assert_eq!(
        out.len(),
        2,
        "only target closed and unrelated reply remain"
    );
    let target: Vec<_> = out.iter().filter(|(id, _)| *id == s).collect();
    assert_eq!(target.len(), 1);
    assert!(
        matches!(ClientFrame::from_cbor(&cbor::decode(&target[0].1).unwrap()).unwrap(), ClientFrame::Push(p) if p.kind == "closed")
    );
    assert_eq!(out.iter().filter(|(id, _)| *id == other).count(), 1);
    assert_eq!(api.closed, vec![s]);
}

#[test]
fn explicit_and_malformed_close_purge_unsent_data() {
    for malformed in [false, true] {
        let (mut api, mut f, s) = open();
        f.on_frame(
            &mut api,
            s,
            &request(1, "get", smap(vec![(0, uuid(4).to_cbor())])),
        );
        if malformed {
            f.on_frame(&mut api, s, &[0xff]);
        } else {
            f.close(&mut api, s);
        }
        assert!(frames_out(&mut f).is_empty());
        assert_eq!(f.take_closed(), vec![s]);
    }
}

#[test]
fn closed_push_is_forwarded_and_closes_the_session() {
    let (mut api, mut f, s) = open();
    api.pushes.push((
        s,
        Push::Closed(ErrorCode::Unauthenticated.problem("grant revoked")),
    ));
    f.pump(&mut api);
    let out = frames_out(&mut f);
    match &out[0] {
        ClientFrame::Push(p) => assert_eq!(p.kind, "closed"),
        other => panic!("{other:?}"),
    }
    assert_eq!(f.take_closed(), vec![s]);
    assert_eq!(api.closed, vec![s]);
    // Frames for a closed session are ignored.
    f.on_frame(&mut api, s, &request(9, "describe", Cbor::Null));
    assert!(frames_out(&mut f).is_empty());
}

#[test]
fn a_malformed_frame_closes_the_session() {
    let (mut api, mut f, s) = open();
    f.on_frame(&mut api, s, &[0xff]);
    assert_eq!(f.take_closed(), vec![s]);
}

#[test]
fn held_requests_answer_by_the_hold_limit_even_without_a_receipt_push() {
    use mdbn_replica::frames::MAX_HOLD_MS;
    let (mut api, mut f, s) = open();
    // Not ticked yet: the hold starts at the first tick.
    f.on_frame(
        &mut api,
        s,
        &request(
            1,
            "submit",
            submit_params(uuid(6), Some(WaitFor::Confirmed)),
        ),
    );
    f.on_frame(
        &mut api,
        s,
        &request(2, "await", smap(vec![(0, uuid(6).to_cbor())])),
    );
    assert!(frames_out(&mut f).is_empty());
    f.tick(&mut api, 10_000);
    f.tick(&mut api, 10_000 + MAX_HOLD_MS - 1);
    assert!(frames_out(&mut f).is_empty());
    f.tick(&mut api, 10_000 + MAX_HOLD_MS);
    let out = frames_out(&mut f);
    assert_eq!(out.len(), 2);
    let r = Vec::<Receipt>::from_cbor(response(&out[0]).result.as_ref().unwrap()).unwrap();
    assert_eq!(r[0].state, ReceiptState::Pending);
    let r = Receipt::from_cbor(response(&out[1]).result.as_ref().unwrap()).unwrap();
    assert_eq!(r.state, ReceiptState::Pending);
}

/// Plain `submit` keeps refusing attachment ops (`intent.md` §3.11): its legacy
/// op union rejects FileAttach13 as an unknown critical variant before the
/// replica sees the request, so nothing is planned or recorded. Uploads go
/// through the dedicated upload API, never a caller-built manifest.
#[test]
fn plain_submit_refuses_file_attach_as_upgrade_required() {
    use mdbn_wire::attachment::{AttachmentContentV1, AttachmentRefV1, FileAttach};
    use mdbn_wire::attachment_runtime_v1::Op as RuntimeOp;
    let (mut api, mut f, s) = open();
    let attach = RuntimeOp::FileAttach(FileAttach {
        id: uuid(4),
        path: "assets/big.bin".into(),
        content: AttachmentContentV1 {
            reference: AttachmentRefV1 {
                collection: uuid(9),
                key_epoch: 1,
                attachment_id: B32([8; 32]),
                manifest_cipher_hash: B32([9; 32]),
            },
            whole_plain_hash: B32([10; 32]),
            total_plain_bytes: 50_000_000,
        },
        if_revision: None,
        base: None,
    });
    let params = smap(vec![
        (0, Cbor::Array(vec![attach.to_cbor()])),
        (1, uuid(6).to_cbor()),
    ]);
    f.on_frame(&mut api, s, &request(1, "submit", params));
    let out = frames_out(&mut f);
    let problem = response(&out[0]).problem.as_ref().expect("refused");
    assert_eq!(problem.code, "upgrade_required");
    assert!(api.receipts.is_empty(), "the replica never saw the submit");
}
