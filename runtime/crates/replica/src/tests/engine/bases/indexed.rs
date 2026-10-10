use super::*;
use crate::replica::{BasesExecutionPolicies, BasesExecutionResult, BasesViewSelection};
use crate::store_query::{QueryProjectionRow, RawField};
use mdbn_core::doc::Document;
use mdbn_core::views::bases::{
    BasesDisplayCell, DateGroupMode, NullOrder, OrderingCapture, StringOrder, WorkBudget,
    capture_source_tags,
};
use std::collections::BTreeMap;
mod publication;
mod scaling;
mod store;
mod windows;
use store::ProjectionStore;
fn policies() -> BasesExecutionPolicies {
    BasesExecutionPolicies {
        ordering: OrderingCapture {
            nulls: NullOrder::Last,
            strings: StringOrder::Utf16,
        },
        date_groups: DateGroupMode::Unavailable,
        inventory_ties: true,
    }
}
fn selection(source: &str, index: u32) -> BasesViewSelection {
    BasesViewSelection {
        record: B16([11; 16]),
        revision: mdbn_wire::hash::sha256(source.as_bytes()),
        index,
    }
}
fn pump(r: &mut Replica<ProjectionStore>, log: &mut FakeLog) {
    use crate::log::LogClient;
    for _ in 0..20 {
        let session = r.bind_authenticated_log(r.log_endpoint(), COL).unwrap();
        for push in log.poll_pushes() {
            r.on_authenticated_log_push(&session, |_| Ok(push)).unwrap();
        }
        for (call, scope) in r.take_authenticated_log_calls(&session).unwrap() {
            let reply = log.call(call.request);
            r.on_authenticated_log_reply(scope, move |_, _| reply)
                .unwrap();
        }
        r.tick();
    }
}
fn projected(svc: &FakeLogService, a: Node) -> Replica<ProjectionStore> {
    let context =
        a.r.query_context
            .clone()
            .expect("real resource-derived R6 context");
    let cfg = a.r.cfg.clone();
    let clock = a.clock.clone();
    let mut log = svc.client(cfg.device_id);
    let inner = a.r.into_store();
    let head = inner.head().unwrap();
    let mut raw = BTreeMap::new();
    let mut maps = BTreeMap::new();
    let mut after = None;
    loop {
        let page = inner
            .records(crate::store::Page { after, limit: 128 })
            .unwrap();
        if page.is_empty() {
            break;
        }
        for row in page {
            after = Some(row.id);
            let doc = Document::parse_at(&row.path, &row.doc);
            maps.insert(row.id, doc.frontmatter().clone());
            raw.insert(
                row.id,
                QueryProjectionRow {
                    id: row.id,
                    path: row.path,
                    source_sha: row.revision,
                    source_bytes: row.doc.len() as u64,
                    fields: Vec::<RawField>::new(),
                    tags: capture_source_tags(&doc, &mut WorkBudget::new()).unwrap(),
                },
            );
        }
    }
    let store = ProjectionStore {
        inner,
        generation: context.generation(),
        head,
        raw: Rc::new(raw),
        maps: Rc::new(maps),
        selected: B16([11; 16]),
        reads: Rc::new(Cell::new(0)),
        pages: Rc::new(Cell::new(0)),
        fail_page: Rc::new(Cell::new(usize::MAX)),
        ready: Rc::new(Cell::new(true)),
        armed: Rc::new(Cell::new(false)),
    };
    let mut r = Replica::open(
        cfg,
        store,
        Box::new(crate::CorePlanner),
        Box::new(crate::seal::KeyringSealer::new(
            COL,
            B16([101; 16]),
            &[0x31; 32],
            &[0x32; 32],
        )),
        Host {
            clock: Box::new(TestClock(clock)),
            entropy: Box::new(crate::crypto::TestEntropy::new(1)),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: [1; 32],
            kem_sk: [1; 32],
        },
    )
    .unwrap();
    pump(&mut r, &mut log);
    // The test backend carries exact materialized data from the same confirmed
    // resource-derived generation. Authority/keys/head come from normal reopen
    // and authenticated fake log transport, not a constructed admission token.
    r.query_context = Some(context);
    r.collection_setup_capture_fence(None).unwrap();
    r.store().armed.set(true);
    r
}
fn output(result: &BasesExecutionResult) -> serde_json::Value {
    serde_json::json!({"rows":result.rows.iter().map(|row|serde_json::json!({"id":row.record.0,"path":row.path,"sha":row.revision.0,"cells":row.cells.iter().map(|cell|match cell {BasesDisplayCell::Value(value)=>serde_json::json!({"value":serde_json::from_str::<serde_json::Value>(&value.to_plain().to_json()).unwrap()}),BasesDisplayCell::Unavailable {code,detail}=>serde_json::json!({"code":code,"detail":detail})}).collect::<Vec<_>>()})).collect::<Vec<_>>(),"groups":result.groups.iter().map(|group|serde_json::json!({"key":serde_json::from_str::<serde_json::Value>(&group.key.to_plain().to_json()).unwrap(),"rows":group.rows})).collect::<Vec<_>>()})
}
#[test]
fn actual_signed_actor_streams_all_five_unchanged_views_with_exact_residual_cells_and_groups() {
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("../../data/bases-first-slice.json")).unwrap();
    for view in expected["views"].as_array().unwrap() {
        let (svc, mut a, _) = configured();
        let source = expected["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|source| source["command"] == view["command"])
            .unwrap()["source"]
            .as_str()
            .unwrap();
        a.create(11, "Views/actual.base", source);
        for (i, record) in expected["records"].as_array().unwrap().iter().enumerate() {
            a.create(
                (i + 1) as u8,
                record["path"].as_str().unwrap(),
                record["source"].as_str().unwrap(),
            );
        }
        settle(&mut [&mut a]);
        a.clock.set(expected["now_ms"].as_u64().unwrap());
        let hints = BTreeMap::from_iter([
            ("due".into(), "date".into()),
            ("scheduled".into(), "date".into()),
        ]);
        let selected = selection(source, view["index"].as_u64().unwrap() as u32);
        let input =
            a.r.capture_bases_execution_inputs(selected, Some(&hints), Some("UTC"))
                .unwrap();
        let baseline =
            a.r.execute_captured_bases_view(input, policies(), &|| false)
                .unwrap();
        let mut r = projected(&svc, a);
        let result = r
            .execute_indexed_bases_view(selected, Some(&hints), Some("UTC"), policies(), &|| false)
            .unwrap();
        assert_eq!(output(&result), output(&baseline), "{}", view["name"]);
        assert_eq!(r.store().reads.get(), 2);
        assert_eq!(r.store().pages.get(), 1);
    }
}
#[test]
fn unsupported_backend_or_dynamic_requirements_refuse_without_source_inventory() {
    let (_, mut a, source) = configured();
    a.create(11, "Views/task.base", &source);
    settle(&mut [&mut a]);
    let error =
        a.r.execute_indexed_bases_view(
            selection(&source, 0),
            Some(&BTreeMap::new()),
            Some("UTC"),
            policies(),
            &|| false,
        )
        .err()
        .unwrap();
    assert_eq!(error.code(), Some(ErrorCode::InvalidRequest));
    assert!(
        error
            .to_string()
            .contains("view_raw_projection_unavailable")
    );
    let (svc, mut a, _) = configured();
    let source = "views:\n  - type: table\n    name: Dynamic\n    filters: 'note[file.name]'\n    order: [file.name]\n";
    a.create(11, "Views/dynamic.base", source);
    settle(&mut [&mut a]);
    let mut r = projected(&svc, a);
    let error = r
        .execute_indexed_bases_view(
            selection(source, 0),
            Some(&BTreeMap::new()),
            Some("UTC"),
            policies(),
            &|| false,
        )
        .err()
        .unwrap();
    assert_eq!(error.code(), Some(ErrorCode::InvalidRequest));
    assert!(
        error
            .to_string()
            .contains("raw_property_projection_unqualified")
    );
    assert_eq!(r.store().pages.get(), 0);
    assert_eq!(r.store().reads.get(), 1);
}
