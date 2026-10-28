//! Actual original NativeStore pending capture, not a seeded PendingRow.
//! In-process initialize restart only. Full process/credential restart remains
//! a separate qualification gap. Busyfix owns the known-Frozen/holds control.
use super::*;
use crate::runtime::native_pending_fixture::{Ledger, Op, Reply, Scope};
use mdbn_replica::api::{SessionAuth, SessionId};
use mdbn_wire::Wire;
use mdbn_wire::cbor::Cbor;
use mdbn_wire::client::{
    ClientFrame, ClientRequest, ClientResponse, HelloParams, SubmitParams, WaitFor,
};
use mdbn_wire::common::{B16, Version};
use mdbn_wire::intent::{Create, Op as IntentOp};

fn mid() -> B16 {
    B16([1, 2, 3, 4, 5, 6, 0x70, 1, 0x80, 9, 10, 11, 12, 13, 14, 15])
}

fn original_scope(f: &CaptureFixture, entry: &crate::registry::Entry) -> Scope {
    let collection = B16(crate::attest::uuid_bytes(&entry.id).unwrap());
    let replica = B16(crate::attest::uuid_bytes(&entry.replica_id).unwrap());
    let device = B16(crate::attest::uuid_bytes(entry.device.as_deref().unwrap()).unwrap());
    let account = B16(crate::attest::uuid_bytes(entry.owner_account.as_deref().unwrap()).unwrap());
    let incarnation = f.daemon.authority.incarnation().unwrap();
    assert_eq!(incarnation.account, account);
    assert_eq!(incarnation.device, device);
    let source = f.daemon.authority.source(collection).unwrap();
    let epoch = incarnation.epoch;
    Scope {
        collection,
        replica,
        device,
        account,
        epoch,
        current: Arc::new(move |expected_account, expected_epoch| {
            source.active_account() == Some(expected_account)
                && source.authority_epoch() == Some(expected_epoch)
                && source.owner_identity().is_some_and(|o| {
                    o.collection == collection
                        && o.device == device
                        && o.account == expected_account
                })
        }),
    }
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

async fn response(
    out: &mut tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    id: u64,
) -> ClientResponse {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let bytes = out.recv().await.unwrap_or_else(|| {
                panic!("original native response channel closed for request {id}")
            });
            match ClientFrame::from_bytes(&bytes).unwrap() {
                ClientFrame::Response(r) if r.id == id => return r,
                ClientFrame::Push(_) => {}
                _ => panic!("unexpected original owner response"),
            }
        }
    })
    .await
    .expect("original native request response deadline")
}

struct QuarantinedSubmit {
    response: Option<ClientResponse>,
    closed: mdbn_wire::client::Problem,
}

// The native finalization fault closes the ORIGINAL caller and purges queued
// plaintext/ACKs. A bare EOF/timeout is never evidence of correct quarantine.
async fn quarantined_submit(
    out: &mut tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    id: u64,
) -> QuarantinedSubmit {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut response = None;
        let mut closed = None;
        while let Some(bytes) = out.recv().await {
            match ClientFrame::from_bytes(&bytes).unwrap() {
                ClientFrame::Response(r) if r.id == id => {
                    assert!(response.is_none(), "duplicate original response");
                    assert!(
                        r.result.is_none() && r.problem.is_some(),
                        "quarantine must not deliver a successful Pending/Confirmed ACK"
                    );
                    response = Some(r);
                }
                ClientFrame::Push(p) if p.kind == "closed" => {
                    assert!(closed.is_none(), "duplicate original close");
                    let problem = mdbn_wire::client::Problem::from_cbor(&p.payload).unwrap();
                    assert_eq!(problem.code, "unavailable");
                    closed = Some(problem);
                }
                ClientFrame::Push(_) => {
                    panic!(
                        "unsubscribed original caller received an unexpected queued plaintext push"
                    );
                }
                _ => panic!("unexpected original quarantined response"),
            }
        }
        QuarantinedSubmit {
            response,
            closed: closed.expect("EOF without a decoded native unavailable/closed is NOT proof"),
        }
    })
    .await
    .expect("original quarantine/transport-close deadline")
}

async fn owner_session(
    f: &CaptureFixture,
) -> (SessionId, tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>) {
    // Host is the normal native owning app authority, not a forged application
    // grant / Native signature. No claim of Noise or remote key-delivery proof.
    let hello = HelloParams {
        versions: vec![Version { major: 1, minor: 2 }],
        client_name: "native-capture-fixture-owner".into(),
        client_version: "test".into(),
        features: None,
        timezone: None,
    };
    let (session, bytes, out) = f
        .runtime
        .hello(SessionAuth::Host, frame(1, "hello", hello.to_cbor()))
        .await
        .expect("original actor must answer owner hello");
    let ClientFrame::Response(r) = ClientFrame::from_bytes(&bytes).unwrap() else {
        panic!("hello response");
    };
    assert!(
        r.problem.is_none(),
        "ordinary owner hello refused: {:?}",
        r.problem
    );
    (session.expect("ordinary owner session"), out)
}

async fn actor_ledger(
    f: &CaptureFixture,
    target: B16,
) -> (
    Ledger,
    Option<mdbn_replica::store::PendingRow>,
    bool,
    u64,
    bool,
) {
    match f.runtime.capture_fixture(Op::Ledger(target)).await.unwrap() {
        Reply::Ledger {
            ledger,
            witness,
            lost_ack,
            aborts,
            reopen,
        } => (*ledger, witness.map(|r| *r), lost_ack, aborts, reopen),
        Reply::Done => panic!("native ledger reply"),
    }
}

fn disk_ledger(f: &CaptureFixture, target: B16) -> Ledger {
    // Runtime must already be joined. Exclusive index open is evidence of that,
    // not Replica::open (which would normally process original pending work).
    use mdbn_platform_native::SqliteIndex;
    use mdbn_store_file::index::IndexDurability;
    use mdbn_store_file::{SqlStore, SqlStoreLimits};
    let path = f
        .daemon
        .profile
        .state_dir
        .join("collections")
        .join(&f.id)
        .join("index.sqlite");
    let index = std::rc::Rc::new(std::cell::RefCell::new(
        SqliteIndex::open(path, IndexDurability::Durable).unwrap(),
    ));
    let store = SqlStore::open_with_limits(index, SqlStoreLimits::DESKTOP).unwrap();
    crate::runtime::native_pending_fixture::ledger(&store, target).unwrap()
}

async fn in_process_restart(
    f: &CaptureFixture,
    expected: &crate::registry::Entry,
    before: &Ledger,
) {
    let original_identity = f.daemon.identity.get().unwrap().public();
    let original_incarnation = f.daemon.authority.incarnation().unwrap();
    let original_cloud = std::fs::read(f.daemon.profile.cloud_file()).unwrap();
    let original_account = std::fs::read(f.daemon.profile.account_file()).unwrap();
    close_fixture(f).await;
    let mut restarted = daemon(&f._profile);
    {
        let d = Arc::get_mut(&mut restarted).unwrap();
        d.identity = Default::default();
        // Reuse the ORIGINAL credential backend. A fresh MemoryStore would be a
        // new owner, not a restart of this source. Do NOT pair/publish again.
        d.secrets = f.daemon.secrets.clone();
        d.trust = f.daemon.trust.clone();
    }
    initialize(restarted.clone()).await;
    let mut ready = restarted.readiness.subscribe();
    tokio::time::timeout(Duration::from_secs(10), ready.wait_for(|r| r.ready))
        .await
        .expect("in-process daemon initialize deadline")
        .unwrap();
    assert_eq!(
        restarted.identity.get().unwrap().public(),
        original_identity
    );
    assert_eq!(
        restarted.authority.incarnation(),
        Some(original_incarnation)
    );
    assert_eq!(
        std::fs::read(restarted.profile.cloud_file()).unwrap(),
        original_cloud
    );
    assert_eq!(
        std::fs::read(restarted.profile.account_file()).unwrap(),
        original_account
    );
    let mut inner = restarted.inner.lock().await;
    let entry = inner.registry.get(&f.id).unwrap();
    assert!(entry.paused);
    assert_eq!(entry.id, expected.id);
    assert_eq!(entry.replica_id, expected.replica_id);
    assert_eq!(entry.owner_account, expected.owner_account);
    assert_eq!(entry.device, expected.device);
    assert_eq!(entry.mode, crate::registry::SyncMode::Local);
    let host = inner
        .hosts
        .iter_mut()
        .find(|h| h.entry().id == f.id)
        .unwrap();
    assert!(host.entry().paused && !host.is_serving() && host.runtime().is_none());
    host.refresh();
    assert!(host.entry().paused && !host.is_serving() && host.runtime().is_none());
    drop(inner);
    assert!(restarted.serving(&f.id).await.is_err());
    assert_eq!(disk_ledger(f, mid()), *before);
    assert_no_collection_bootstrap(f);
    let mut inner = restarted.inner.lock().await;
    for host in &mut inner.hosts {
        host.close().await;
    }
    drop(inner);
    restarted.shutdown.send_replace(true);
    if let Some(task) = restarted.account.lock().unwrap().relay.take() {
        task.abort();
    }
    if let Some(link) = restarted.link.lock().unwrap().take() {
        link.stop();
    }
}

async fn original_native_capture(lose_capture_ack: bool) {
    let f = capture_fixture(if lose_capture_ack {
        "native-capture-ack-lost"
    } else {
        "native-capture-pending"
    })
    .await;
    let original = f
        .daemon
        .inner
        .lock()
        .await
        .registry
        .get(&f.id)
        .unwrap()
        .clone();
    let scope = original_scope(&f, &original);
    let (baseline, witness, lost, _, reopen) = actor_ledger(&f, mid()).await;
    assert!(
        !reopen,
        "fixture must start with a healthy original native engine"
    );
    assert!(
        baseline.pending.is_empty() && baseline.receipt.is_none() && witness.is_none() && !lost
    );
    let (session, mut out) = owner_session(&f).await;
    // Ordinary owner pending API BEFORE the real fault, proving this is not an
    // already-refused/different-account fixture. No API inventory manufactured.
    assert!(
        f.runtime
            .frame(session, frame(2, "list_pending", Cbor::Map(vec![])))
    );
    let pending = response(&mut out, 2).await;
    assert!(pending.problem.is_none() && pending.result.is_some());
    for wrong in 0..5 {
        let mut mismatch = scope.clone();
        match wrong {
            0 => mismatch.collection = B16([0; 16]),
            1 => mismatch.replica = B16([0; 16]),
            2 => mismatch.device = B16([0; 16]),
            3 => mismatch.account = B16([0; 16]),
            _ => mismatch.epoch += 1,
        }
        assert!(
            f.runtime
                .capture_fixture(Op::Arm {
                    scope: mismatch,
                    target: mid(),
                    lose_capture_ack,
                })
                .await
                .is_err(),
            "wrong original scope must not install any hook"
        );
    }
    assert_eq!(actor_ledger(&f, mid()).await.0, baseline);
    assert!(matches!(
        f.runtime
            .capture_fixture(Op::Arm {
                scope: scope.clone(),
                target: mid(),
                lose_capture_ack,
            })
            .await
            .unwrap(),
        Reply::Done
    ));
    let params = SubmitParams {
        ops: vec![IntentOp::Create(Create {
            id: B16([1, 2, 3, 4, 5, 6, 0x70, 2, 0x80, 9, 10, 11, 12, 13, 14, 16]),
            path: Some("native-original-pending.md".into()),
            type_name: None,
            frontmatter: None,
            body: None,
            document: Some(mdbn_wire::common::Text::Inline(
                "---\ntitle: Original pending\n---\nActual native owner edit\n".into(),
            )),
        })],
        mutation_id: Some(mid()),
        wait: Some(WaitFor::Pending),
        conflict_mode: None,
        timezone: None,
        allow_partial: None,
        mutation_ids: None,
        dry_run: None,
        include: None,
    };
    assert!(
        f.runtime
            .frame(session, frame(3, "submit", params.to_cbor()))
    );
    // This seam deliberately faults finalization BEFORE the native ACK can
    // leave the original actor. Do not invent successful Pending acknowledgment.
    let submit = quarantined_submit(&mut out, 3).await;
    if let Some(response) = &submit.response {
        assert!(response.result.is_none() && response.problem.is_some());
    }
    let (captured, witness, lost, aborts, reopen) = actor_ledger(&f, mid()).await;
    assert_eq!(
        submit.closed.reason.as_deref(),
        Some(if reopen {
            "apply_reopen_required"
        } else {
            "apply_recovering"
        }),
        "decoded native closure must match the actual original Replica recovery state"
    );
    let row = witness.expect("MUST be an actual durable original Replica capture");
    assert_eq!(lost, lose_capture_ack);
    if !lose_capture_ack {
        assert!(aborts > 0, "original local finalize was really attempted");
    }
    assert_eq!(row.mutation.id, mid());
    assert_eq!(row.mutation.origin, scope.replica);
    assert_eq!(row.grant, row.mutation.on_behalf);
    assert!(
        row.grant.is_none(),
        "native Host owner row is not an application grant"
    );
    assert_eq!(captured.pending, vec![(mid(), row.to_bytes())]);
    assert_eq!(captured.head, baseline.head);
    assert_eq!(captured.identity, baseline.identity);
    assert_eq!(
        captured.receipt, baseline.receipt,
        "do not manufacture an Unknown/rejected receipt"
    );
    let pending_path = f.folder.path().join("native-original-pending.md");
    // Native pending capture may optimistically publish bytes. Preserve exactly
    // what THIS original engine produced, not an invented absent-file outcome.
    let pending_bytes = std::fs::read(&pending_path).ok();
    if let Some(bytes) = &pending_bytes {
        assert_eq!(
            bytes,
            b"---\ntitle: Original pending\n---\nActual native owner edit\n"
        );
    }
    let error = f
        .daemon
        .enable_sync(EnableSync {
            collection: f.id.clone(),
            mode: None,
            accept_takeover_holds: false,
        })
        .await
        .unwrap_err();
    assert_eq!(error.code, "invalid_request");
    assert_eq!(error.reason.as_deref(), Some("source_capture_incomplete"));
    assert_eq!(
        f.runtime.capture_fixture_frozen(),
        Some(None),
        "actual original Freeze must refuse"
    );
    assert_retained_capture(&f, &original).await;
    assert_eq!(
        disk_ledger(&f, mid()),
        captured,
        "all original durable ownership survives stop"
    );
    assert_eq!(std::fs::read(&pending_path).ok(), pending_bytes);
    assert!(
        !f.runtime
            .frame(session, frame(4, "submit", params.to_cbor())),
        "stopped original writer cannot be reused"
    );
    let saved = Registry::load(&f.daemon.profile.registry_file()).unwrap();
    assert!(saved.get(&f.id).unwrap().paused);
    in_process_restart(&f, &original, &captured).await;
    assert_eq!(std::fs::read(&pending_path).ok(), pending_bytes);
}

#[tokio::test]
async fn actual_native_owner_pending_capture_is_retained_stopped_through_initialize_restart() {
    original_native_capture(false).await;
}

#[tokio::test]
async fn actual_native_owner_lost_storage_capture_ack_preserves_original_unknown_attempt() {
    original_native_capture(true).await;
}

// Deliberately no full process/crash + credential-backend restart claim, no
// remote append denial/outcome, signed app grant, Native Noise or live root proof.
