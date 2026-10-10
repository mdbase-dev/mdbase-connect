//! Actual SQLite projections and the shipped replica/frame resource producer.
use super::*;
use mdbn_store_file::index::{IndexError, IndexInfo, StmtResult};
use mdbn_store_file::{
    SqlStore,
    testing::{replica as r, wire as w},
};
use r::api::{ClientApi, ListResources, SessionAuth};
use r::store::{BoundedResource, ResourcePathPage, StoreError};
use r::{DeviceSecrets, Host, Replica, ReplicaConfig, UtcOnly};
use w::client::{ClientFrame, ClientRequest, ClientResponse, HelloParams, SyncMode};
use w::common::{B16, B32, Version};
use w::{Cbor, Wire};

#[derive(Clone, Copy)]
enum Fault {
    Io,
    ExtraStatement,
    ExtraRow,
    Columns,
    MissingSource,
    OversizedCopy,
    ChangeHead,
}
#[derive(Default)]
struct Probe {
    refuse_unbounded: Cell<bool>,
    fault: Cell<Option<Fault>>,
    only_source_fault: Cell<bool>,
    path_reads: Cell<usize>,
    source_limits: RefCell<Vec<usize>>,
    projected_text_bytes: RefCell<Vec<usize>>,
}
struct Trace {
    inner: SqliteIndex,
    probe: Rc<Probe>,
}
impl IndexStorage for Trace {
    fn info(&self) -> IndexInfo {
        self.inner.info()
    }
    fn reset(&mut self) -> Result<(), IndexError> {
        self.inner.reset()
    }
    fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
        let bounded = batch
            .stmts
            .iter()
            .any(|s| s.sql.starts_with("SELECT CASE") && s.sql.contains("FROM st_res"));
        if self.probe.refuse_unbounded.get()
            && batch.stmts.iter().any(|s| {
                s.sql == "SELECT path, doc FROM st_res ORDER BY path"
                    || s.sql == "SELECT doc FROM st_res WHERE path = ?"
            })
        {
            return Err(IndexError::new(
                IndexErrorKind::Other,
                "unbounded resource read refused",
            ));
        }
        let source = bounded && batch.stmts[0].sql.contains("WHERE path = ?1");
        if bounded {
            if source {
                let SqlValue::Integer(limit) = batch.stmts[0].params[1] else {
                    panic!("copy limit")
                };
                self.probe.source_limits.borrow_mut().push(limit as usize);
            } else {
                self.probe.path_reads.set(self.probe.path_reads.get() + 1);
            }
        }
        let fault = if bounded && (source || !self.probe.only_source_fault.get()) {
            self.probe.fault.take()
        } else {
            None
        };
        if matches!(fault, Some(Fault::Io)) {
            return Err(IndexError::new(
                IndexErrorKind::Other,
                "injected bounded read fault",
            ));
        }
        let mut result = self.inner.run(batch)?;
        if source {
            self.probe.projected_text_bytes.borrow_mut().push(
                result
                    .iter()
                    .flat_map(|r| &r.values)
                    .map(|v| {
                        if let SqlValue::Text(t) = v {
                            t.len()
                        } else {
                            0
                        }
                    })
                    .sum(),
            );
        }
        match fault {
            Some(Fault::ExtraStatement) => result.push(StmtResult::default()),
            Some(Fault::ExtraRow) => {
                let extra = result[0].values.clone();
                result[0].values.extend(extra);
            }
            Some(Fault::Columns) => result[0].columns = 3,
            Some(Fault::MissingSource) => result[0].values.clear(),
            Some(Fault::OversizedCopy) => {
                result[0].values = vec![SqlValue::Integer(3), SqlValue::Text("bad copy".into())]
            }
            Some(Fault::ChangeHead) => {
                let head =
                    w::cbor::encode(&Cbor::Array(vec![Cbor::Uint(1), B32([9; 32]).to_cbor()]))
                        .unwrap();
                self.inner.run(&Batch {
                    mode: BatchMode::Transaction,
                    stmts: vec![Stmt::new(
                        "INSERT OR REPLACE INTO st_kv(k,v) VALUES ('head',?)",
                        vec![SqlValue::Blob(head)],
                    )],
                })?;
            }
            _ => {}
        }
        Ok(result)
    }
}
type Fixture = (SqlStore<Trace>, Rc<RefCell<Trace>>, Rc<Probe>);
fn fixture(name: &str, rows: Vec<(String, String)>) -> Fixture {
    let probe = Rc::new(Probe::default());
    let index = Rc::new(RefCell::new(Trace {
        inner: SqliteIndex::open(scratch(name).join("state.db"), IndexDurability::Durable).unwrap(),
        probe: probe.clone(),
    }));
    let mut store = SqlStore::open(index.clone()).unwrap();
    store
        .commit(Tx {
            resources_put: rows,
            ..Default::default()
        })
        .unwrap();
    (store, index, probe)
}
fn app(store: SqlStore<Trace>) -> Replica<SqlStore<Trace>> {
    Replica::open(
        ReplicaConfig {
            collection: B16([7; 16]),
            device_id: B16([101; 16]),
            replica_id: B16([1; 16]),
            mode: SyncMode::Synced,
            log_endpoint: r::log::EndpointId(1),
            verify: true,
            runtime_version: "resource-native-test".into(),
            trusted_roots: vec![r::testkit::signed_root()],
            trusted_signers: vec![],
            e2e: false,
            user_enabled_cloud_copy: false,
            chosen_state: None,
            expected_genesis: None,
            key_grants_only: false,
            policy_pins: None,
        },
        store,
        Box::new(r::plan::CorePlanner),
        Box::new(r::seal::KeyringSealer::new(
            B16([7; 16]),
            B16([101; 16]),
            &[0x31; 32],
            &[0x32; 32],
        )),
        Host {
            clock: Box::new(mdbn_core::host::FixedClock(1700000000000)),
            entropy: Box::new(r::crypto::TestEntropy::new(1)),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: [0x31; 32],
            kem_sk: [0x32; 32],
        },
    )
    .unwrap()
}
fn hello() -> HelloParams {
    HelloParams {
        versions: vec![Version { major: 1, minor: 0 }],
        client_name: "native-resource".into(),
        client_version: "1".into(),
        features: None,
        timezone: None,
    }
}
fn page<'a>(after: Option<&'a str>, prefix: Option<&'a str>, limit: u32) -> ResourcePathPage<'a> {
    ResourcePathPage {
        after,
        prefix,
        limit,
    }
}
fn framed_request(method: &str, params: Cbor) -> Vec<u8> {
    ClientFrame::Request(ClientRequest {
        id: 1,
        method: method.into(),
        params,
    })
    .to_bytes()
    .unwrap()
}
fn decode_response(bytes: &[u8]) -> ClientResponse {
    let frame = ClientFrame::from_cbor(&w::cbor::decode(bytes).unwrap()).unwrap();
    assert_eq!(frame.to_bytes().unwrap(), bytes);
    let ClientFrame::Response(response) = frame else {
        panic!("response")
    };
    response
}

#[test]
fn resource_sqlite_path_and_source_projection_are_bounded_byte_exact() {
    let (store, _, probe) = fixture(
        "resource-bounded-sql",
        vec![
            ("_types/a.md".into(), "é\n".into()),
            ("_types/b.md".into(), "".into()),
            ("_types/z.md".into(), "x".repeat((1 << 20) + 1)),
            ("_types/é.md".into(), "orphan".into()),
            ("_types2/no.md".into(), "excluded".into()),
        ],
    );
    probe.refuse_unbounded.set(true);
    assert_eq!(
        store
            .resource_paths_page(page(None, Some("_types/"), 2))
            .unwrap(),
        vec!["_types/a.md", "_types/b.md"]
    );
    assert_eq!(
        store
            .resource_paths_page(page(Some("_types/b.md"), Some("_types/"), 2))
            .unwrap(),
        vec!["_types/z.md", "_types/é.md"]
    );
    assert_eq!(
        store
            .resource_paths_page(page(Some("_types/é.md"), Some("_types/"), 2))
            .unwrap(),
        Vec::<String>::new()
    );
    assert_eq!(
        store.resource_bounded("_types/a.md", 3).unwrap(),
        Some(BoundedResource {
            size: 3,
            text: Some("é\n".into())
        })
    );
    assert_eq!(
        store.resource_bounded("_types/a.md", 2).unwrap(),
        Some(BoundedResource {
            size: 3,
            text: None
        })
    );
    assert_eq!(
        store.resource_bounded("_types/b.md", 0).unwrap(),
        Some(BoundedResource {
            size: 0,
            text: Some("".into())
        })
    );
    assert_eq!(
        store.resource_bounded("_types/z.md", 1 << 20).unwrap(),
        Some(BoundedResource {
            size: (1 << 20) + 1,
            text: None
        })
    );
    assert_eq!(
        *probe.projected_text_bytes.borrow(),
        vec![3, 0, 0, 0],
        "SQL projects oversize text to NULL before owning it"
    );
    assert_eq!(
        store.resource_bounded("_types/missing.md", 3).unwrap(),
        None
    );
    for limit in [0, 130] {
        assert_eq!(
            store.resource_paths_page(page(None, None, limit)),
            Err(StoreError::Full)
        );
    }
    assert_eq!(
        store.resource_bounded("_types/a.md", (1 << 20) + 1),
        Err(StoreError::Full)
    );
}

#[test]
fn resource_sqlite_strict_reports_faults_and_oversized_paths_fail_closed() {
    let (store, index, probe) = fixture(
        "resource-strict-sql",
        vec![("_types/a.md".into(), "abc".into())],
    );
    for fault in [Fault::Io, Fault::ExtraStatement, Fault::Columns] {
        probe.fault.set(Some(fault));
        assert!(store.resource_paths_page(page(None, None, 1)).is_err());
    }
    probe.fault.set(Some(Fault::ExtraRow));
    assert!(store.resource_paths_page(page(None, None, 1)).is_err());
    for fault in [
        Fault::Io,
        Fault::ExtraStatement,
        Fault::ExtraRow,
        Fault::Columns,
        Fault::OversizedCopy,
    ] {
        probe.fault.set(Some(fault));
        assert!(store.resource_bounded("_types/a.md", 3).is_err());
    }
    index
        .borrow_mut()
        .inner
        .run(&Batch {
            mode: BatchMode::Transaction,
            stmts: vec![Stmt::new(
                "INSERT INTO st_res(path,doc) VALUES (?,?)",
                vec![
                    SqlValue::Text("x".repeat(4097)),
                    SqlValue::Text("abc".into()),
                ],
            )],
        })
        .unwrap();
    assert_eq!(
        store.resource_paths_page(page(None, None, 3)),
        Err(StoreError::Full)
    );
}

#[test]
fn resource_native_replica_pages_and_frame_roundtrip_use_actual_tracked_source() {
    let (store, _, probe) = fixture(
        "resource-native-frames",
        vec![
            ("_types/task.md".into(), "abc".into()),
            ("mdbase.yaml".into(), "malformed config".into()),
        ],
    );
    let mut replica = app(store);
    probe.refuse_unbounded.set(true);
    let mut frames = r::frames::Frames::new();
    let opened = frames.hello(
        &mut replica,
        SessionAuth::Host,
        &framed_request("hello", hello().to_cbor()),
    );
    let session = opened.session.unwrap();
    let request = ListResources {
        text: Some(true),
        limit: Some(1),
        ..Default::default()
    };
    let first = replica.list_resources(session, request.clone()).unwrap();
    assert_eq!(first.resources[0].path, "_types/task.md");
    assert_eq!(first.resources[0].text.as_deref(), Some("abc"));
    assert_eq!(first.resources[0].revision, w::hash::sha256(b"abc"));
    assert!(!first.complete && first.cursor.is_some());
    let last = replica
        .list_resources(
            session,
            ListResources {
                cursor: first.cursor.clone(),
                ..request
            },
        )
        .unwrap();
    assert!(last.complete && last.cursor.is_none());
    assert_eq!(last.resources[0].path, "mdbase.yaml");
    let params = Cbor::Map(vec![
        (Cbor::Uint(1), Cbor::Bool(true)),
        (Cbor::Uint(3), Cbor::Uint(1)),
    ]);
    frames.on_frame(
        &mut replica,
        session,
        &framed_request("list_resources", params),
    );
    let outgoing = frames.take_outgoing();
    assert_eq!(outgoing.len(), 1);
    let response = decode_response(&outgoing[0].1);
    assert!(response.problem.is_none());
    let Cbor::Map(fields) = response.result.unwrap() else {
        panic!("resource list")
    };
    assert_eq!(fields[1], (Cbor::Uint(1), Cbor::Bool(false)));
    let (Cbor::Uint(2), Cbor::Text(cursor)) = &fields[2] else {
        panic!("live cursor")
    };
    assert!(cursor.starts_with("r1."));
    let native_hex = |bytes: &[u8]| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    println!("RESOURCE_NATIVE_PAGE_HEX={}", native_hex(&outgoing[0].1));
    // Feed the ORIGINAL framed page's actual opaque cursor back to the SAME
    // live session, preserving folder/text/limit. Not a codec-authored handle.
    let continuation = Cbor::Map(vec![
        (Cbor::Uint(1), Cbor::Bool(true)),
        (Cbor::Uint(2), Cbor::Text(cursor.clone())),
        (Cbor::Uint(3), Cbor::Uint(1)),
    ]);
    frames.on_frame(
        &mut replica,
        session,
        &framed_request("list_resources", continuation),
    );
    let terminal = frames.take_outgoing();
    assert_eq!(terminal.len(), 1);
    let response = decode_response(&terminal[0].1);
    assert!(response.problem.is_none());
    let Cbor::Map(terminal_fields) = response.result.unwrap() else {
        panic!("resource list")
    };
    assert_eq!(terminal_fields.len(), 2);
    assert_eq!(terminal_fields[1], (Cbor::Uint(1), Cbor::Bool(true)));
    let Cbor::Array(rows) = &terminal_fields[0].1 else {
        panic!("resource rows")
    };
    let Cbor::Map(row) = &rows[0] else {
        panic!("resource row")
    };
    assert_eq!(row[0], (Cbor::Uint(0), Cbor::Text("mdbase.yaml".into())));
    assert_eq!(
        row[1],
        (
            Cbor::Uint(1),
            w::hash::sha256(b"malformed config").to_cbor()
        )
    );
    assert_eq!(
        row[4],
        (Cbor::Uint(4), Cbor::Text("malformed config".into()))
    );
    println!(
        "RESOURCE_NATIVE_TERMINAL_HEX={}",
        native_hex(&terminal[0].1)
    );
    // A separate complete selection on this same actual fixture/session also
    // exercises the contract's single-row terminal vector (_types/task.md).
    frames.on_frame(
        &mut replica,
        session,
        &framed_request(
            "list_resources",
            Cbor::Map(vec![
                (Cbor::Uint(0), Cbor::Text("_types".into())),
                (Cbor::Uint(1), Cbor::Bool(true)),
                (Cbor::Uint(3), Cbor::Uint(1)),
            ]),
        ),
    );
    let complete = frames.take_outgoing();
    assert_eq!(complete.len(), 1);
    let response = decode_response(&complete[0].1);
    assert!(response.problem.is_none());
    let Cbor::Map(complete_fields) = response.result.unwrap() else {
        panic!("resource list")
    };
    assert_eq!(complete_fields.len(), 2);
    assert_eq!(complete_fields[1], (Cbor::Uint(1), Cbor::Bool(true)));
    println!(
        "RESOURCE_NATIVE_COMPLETE_HEX={}",
        native_hex(&complete[0].1)
    );
    assert_eq!(
        native_hex(&complete[0].1),
        include_str!("../../../../conformance/resources/list-complete.hex").trim()
    );
    // The contract page fixture expressly uses a nonlive cursor. Normalize ONLY
    // that value for the golden comparison; independent consumers receive the
    // untouched actual emitted page/terminal HEX above, including the live token.
    let mut golden_page = decode_response(&outgoing[0].1);
    let Some(Cbor::Map(golden_fields)) = &mut golden_page.result else {
        panic!("resource list")
    };
    let cursor_field = golden_fields
        .iter_mut()
        .find(|(key, _)| *key == Cbor::Uint(2))
        .unwrap();
    cursor_field.1 = Cbor::Text("resource-fixture-next".into());
    assert_eq!(
        native_hex(&ClientFrame::Response(golden_page).to_bytes().unwrap()),
        include_str!("../../../../conformance/resources/list-page.hex").trim()
    );
    assert!(!probe.source_limits.borrow().is_empty());
}

#[test]
fn resource_native_replica_postread_head_and_source_failures_discard_the_whole_page() {
    for (name, fault) in [
        ("missing", Fault::MissingSource),
        ("head", Fault::ChangeHead),
        ("io", Fault::Io),
    ] {
        let (store, _, probe) = fixture(
            &format!("resource-producer-{name}"),
            vec![("_types/task.md".into(), "abc".into())],
        );
        let mut replica = app(store);
        let session = replica.hello(SessionAuth::Host, hello()).unwrap().0;
        // Fault the source read, not the path page.
        probe.only_source_fault.set(true);
        probe.fault.set(Some(fault));
        let error = replica
            .list_resources(
                session,
                ListResources {
                    text: Some(true),
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert_eq!(
            error.problem().reason.as_deref(),
            Some(if name == "head" {
                "cursor_stale"
            } else {
                "resource_inventory_unavailable"
            })
        );
    }
}
