//! Actual new-write API admission; synthetic planner/host, not crypto acceptance.
use mdbn_core::host::{Entropy, FixedClock};
use mdbn_core::intent::Mutation;
use mdbn_core::plan::{Effect, PlanOptions, Planned, Rejection};
use mdbn_core::state::StateView;
use mdbn_replica::api::{ClientApi, SessionAuth, SessionId};
use mdbn_replica::crypto::CsprngEntropy;
use mdbn_replica::log::EndpointId;
use mdbn_replica::mem::MemStore;
use mdbn_replica::plan::Planner;
use mdbn_replica::seal::KeyringSealer;
use mdbn_replica::store::Store;
use mdbn_replica::{DeviceSecrets, Host, Replica, ReplicaConfig, UtcOnly};
use mdbn_wire::client::{HelloParams, SubmitParams, SyncMode};
use mdbn_wire::common::{B16, Text, Version};
use mdbn_wire::intent::{Create, Op};
use std::cell::Cell;
use std::rc::Rc;
const MAX: usize = mdbn_core::plan::admission::SYNCED_RECORD_MAX_BYTES;
struct FixtureEntropy(Rc<Cell<usize>>);
impl Entropy for FixtureEntropy {
    fn fill(&mut self, buf: &mut [u8]) {
        self.0.set(self.0.get() + 1);
        buf.fill(7);
    }
}
impl CsprngEntropy for FixtureEntropy {}
struct SpyPlanner {
    calls: Rc<Cell<usize>>,
    generated: bool,
}
impl Planner for SpyPlanner {
    fn plan(
        &self,
        mutation: &Mutation,
        _: &dyn StateView,
        _: &PlanOptions,
    ) -> Result<Planned, Rejection> {
        self.calls.set(self.calls.get() + 1);
        let mut result = Planned::noop();
        // A second named partial group grows during planning; all original
        // generated fixtures retain their original behavior.
        if self.generated || mutation.id.0 == [91; 16] {
            for (id, doc) in [(1, "small".into()), (2, "x".repeat(MAX + 1))] {
                result.effects.push(Effect::PutRecord {
                    id: mdbn_core::ids::Uuid([id; 16]),
                    path: format!("{id}.md"),
                    doc,
                });
            }
        }
        Ok(result)
    }
}
type Counter = Rc<Cell<usize>>;
fn open(mode: SyncMode, generated: bool) -> (Replica<MemStore>, SessionId, Counter, Counter) {
    let calls = Rc::new(Cell::new(0));
    open_with_planner(
        mode,
        Box::new(SpyPlanner {
            calls: calls.clone(),
            generated,
        }),
        calls,
    )
}
fn open_with_planner(
    mode: SyncMode,
    planner: Box<dyn Planner>,
    calls: Counter,
) -> (Replica<MemStore>, SessionId, Counter, Counter) {
    let collection = B16([1; 16]);
    let device = B16([2; 16]);
    let entropy = Rc::new(Cell::new(0));
    let mut r = Replica::open(
        ReplicaConfig {
            collection,
            device_id: device,
            replica_id: B16([3; 16]),
            mode,
            log_endpoint: EndpointId(1),
            verify: false,
            runtime_version: "fixture".into(),
            trusted_roots: vec![],
            trusted_signers: vec![],
            e2e: false,
            user_enabled_cloud_copy: false,
            chosen_state: None,
            expected_genesis: None,
            policy_pins: None,
            key_grants_only: false,
        },
        MemStore::new(),
        planner,
        Box::new(KeyringSealer::new(collection, device, &[1; 32], &[2; 32])),
        Host {
            clock: Box::new(FixedClock(0)),
            entropy: Box::new(FixtureEntropy(entropy.clone())),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: [1; 32],
            kem_sk: [2; 32],
        },
    )
    .unwrap();
    let (session, _) = r
        .hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "admission-fixture".into(),
                client_version: "0".into(),
                features: None,
                timezone: None,
            },
        )
        .unwrap();
    (r, session, calls, entropy)
}
fn submit(documents: Vec<String>) -> SubmitParams {
    SubmitParams {
        ops: documents
            .into_iter()
            .enumerate()
            .map(|(i, doc)| {
                Op::Create(Create {
                    id: B16([i as u8 + 10; 16]),
                    path: Some(format!("{i}.md")),
                    type_name: None,
                    frontmatter: None,
                    body: None,
                    document: Some(Text::Inline(doc)),
                })
            })
            .collect(),
        mutation_id: None,
        mutation_ids: None,
        allow_partial: None,
        conflict_mode: None,
        timezone: None,
        dry_run: None,
        include: None,
        wait: None,
    }
}
#[test]
fn historical_oversized_records_remain_readable_and_a_smaller_new_document_can_replace_them() {
    use mdbn_replica::api::Target;
    use mdbn_replica::store::{RecordRow, Tx, bucket16};
    use mdbn_wire::client::Include;
    use mdbn_wire::intent::{DocVersion, Document};
    for mode in [SyncMode::Synced, SyncMode::LocalOnly] {
        let (mut r, session, _, _) = open_with_planner(
            mode,
            Box::new(mdbn_replica::plan::CorePlanner),
            Rc::new(Cell::new(0)),
        );
        let id = B16([44; 16]);
        let path = "archive.md";
        let source = "x".repeat(MAX + 1);
        // Seed accepted historical state directly: this fixture does not claim
        // log verification, a snapshot install, or physical-store persistence.
        MemStore::shared(r.store().data())
            .commit(Tx {
                records_put: vec![RecordRow {
                    id,
                    path: path.into(),
                    path_key: mdbn_core::paths::path_key(path),
                    revision: mdbn_wire::hash::sha256(source.as_bytes()),
                    doc: source.clone(),
                    modified_seq: 0,
                    bucket: bucket16(&id),
                    meta: Default::default(),
                }],
                ..Tx::default()
            })
            .unwrap();
        let include = Include {
            document: Some(true),
            effective: None,
            body: None,
            diagnostics: None,
        };
        let record = r.get(session, Target::Id(id), include.clone()).unwrap();
        assert_eq!(record.document, Some(source.clone()));
        let mut params = submit(vec![]);
        params.ops = vec![Op::Document(Document {
            id,
            base: Some(DocVersion {
                path: path.into(),
                doc: Text::Inline(source),
            }),
            new: Some(DocVersion {
                path: path.into(),
                doc: Text::Inline("reduced".into()),
            }),
            if_revision: None,
        })];
        let receipt = r.submit(session, params).unwrap();
        assert_ne!(receipt[0].state, mdbn_wire::client::ReceiptState::Rejected);
        assert_eq!(
            r.get(session, Target::Id(id), include).unwrap().document,
            Some("reduced".into())
        );
    }
}

#[test]
fn actual_core_generated_frontmatter_is_charged_with_the_full_record_source() {
    let (mut r, session, _, _) = open_with_planner(
        SyncMode::Synced,
        Box::new(mdbn_replica::plan::CorePlanner),
        Rc::new(Cell::new(0)),
    );
    let mut params = submit(vec![String::new()]);
    let Op::Create(create) = &mut params.ops[0] else {
        unreachable!()
    };
    create.document = None;
    create.frontmatter = Some(mdbn_wire::common::DataMap(vec![(
        "title".into(),
        mdbn_wire::common::Value::Text("generated frontmatter bytes".into()),
    )]));
    create.body = Some(Text::Inline("x".repeat(MAX - 1)));
    let error = r.submit(session, params).unwrap_err();
    assert_eq!(error.problem().reason.as_deref(), Some("record_too_large"));
    assert_eq!(r.store().pending_count().unwrap(), 0);
    assert_eq!(r.store().record_count().unwrap(), 0);
}

#[test]
fn actual_core_accepts_a_full_record_source_at_the_boundary_for_capture() {
    let (mut r, session, _, _) = open_with_planner(
        SyncMode::Synced,
        Box::new(mdbn_replica::plan::CorePlanner),
        Rc::new(Cell::new(0)),
    );
    let id = B16([10; 16]);
    let prefix = format!("---\nid: {}\n---\n", id.to_uuid_string());
    let source = format!("{prefix}{}", "x".repeat(MAX - prefix.len()));
    assert_eq!(source.len(), MAX);
    let receipts = r.submit(session, submit(vec![source])).unwrap();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].state, mdbn_wire::client::ReceiptState::Pending);
    assert_eq!(r.store().pending_count().unwrap(), 1);
}

#[test]
fn synced_direct_source_refuses_whole_write_before_planner_entropy_or_capture() {
    let (mut r, session, calls, entropy) = open(SyncMode::Synced, false);
    let before = entropy.get();
    let e = r
        .submit(session, submit(vec!["safe".into(), "x".repeat(MAX + 1)]))
        .unwrap_err();
    assert_eq!(e.problem().reason.as_deref(), Some("record_too_large"));
    assert!(e.problem().message.contains("attachment"));
    assert_eq!(calls.get(), 0);
    assert_eq!(entropy.get(), before);
    assert_eq!(r.store().pending_count().unwrap(), 0);
    assert_eq!(
        r.store()
            .records(mdbn_replica::store::Page {
                after: None,
                limit: 10
            })
            .unwrap()
            .len(),
        0
    );
}
#[test]
fn generated_oversized_source_refuses_all_effects_before_capture() {
    let (mut r, session, calls, _) = open(SyncMode::Synced, true);
    let e = r
        .submit(session, submit(vec!["small input".into()]))
        .unwrap_err();
    assert_eq!(e.problem().reason.as_deref(), Some("record_too_large"));
    assert_eq!(calls.get(), 1);
    assert_eq!(r.store().pending_count().unwrap(), 0);
    assert!(
        r.store()
            .records(mdbn_replica::store::Page {
                after: None,
                limit: 10
            })
            .unwrap()
            .is_empty()
    );
}
#[test]
fn partial_generated_refusal_must_not_hide_an_already_captured_group() {
    use mdbn_wire::client::ReceiptState;
    let (mut r, session, calls, _) = open(SyncMode::Synced, false);
    let first = B16([90; 16]);
    let second = B16([91; 16]);
    let mut params = submit(vec!["first input".into(), "second input".into()]);
    params.allow_partial = Some(true);
    params.mutation_ids = Some(vec![first, second]);
    let result = r.submit(session, params.clone());
    assert_eq!(r.store().pending_count().unwrap(), 1);
    assert!(r.store().pending_get(&first).unwrap().is_some());
    assert!(r.store().pending_get(&second).unwrap().is_none());
    assert!(
        result.is_ok(),
        "a later per-group refusal must report, not hide, the first durable capture: {result:?}"
    );
    let receipts = result.unwrap();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0].mutation, first);
    assert_eq!(receipts[0].state, ReceiptState::Pending);
    assert_eq!(receipts[1].mutation, second);
    assert_eq!(receipts[1].state, ReceiptState::Rejected);
    assert_eq!(
        receipts[1].problem.as_ref().unwrap().reason.as_deref(),
        Some("record_too_large")
    );
    let plans = calls.get();
    let retried = r.submit(session, params).unwrap();
    assert_eq!(calls.get(), plans, "known receipts do not plan again");
    assert_eq!(retried[1], receipts[1]);
    assert_eq!(r.store().pending_count().unwrap(), 1);
}

#[test]
fn exact_source_boundary_reaches_planner_but_local_only_is_not_sync_gated() {
    for (mode, size) in [(SyncMode::Synced, MAX), (SyncMode::LocalOnly, MAX + 1)] {
        let (mut r, session, calls, _) = open(mode, false);
        r.submit(session, submit(vec!["x".repeat(size)])).unwrap();
        assert!(calls.get() > 0, "new source must reach the fixture planner");
    }
}
