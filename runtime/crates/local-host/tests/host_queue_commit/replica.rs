//! Joint REAL local-only Replica/FileStore/SQLite/physical IO qualification.
//! Not a signed-sync, TS HostLoop, Obsidian, app or power-loss proof.
use super::*;
use mdbn_local_host::{Identity, OsEntropy, SystemZones};
use mdbn_replica::api::{ClientApi, SessionAuth, Target};
use mdbn_replica::log::EndpointId;
use mdbn_replica::plan::CorePlanner;
use mdbn_replica::seal::KeyringSealer;
use mdbn_replica::{Host, Replica, ReplicaConfig};
use mdbn_wire::client::{HelloParams, Include, ReceiptState, SubmitParams, SyncMode};
use mdbn_wire::common::{DataMap, Text, Value, Version};
use mdbn_wire::intent::{Create, Op};
use std::future::Future;
use std::task::{Context, Waker};

fn drive_original<T>(
    future: impl Future<Output = T>,
    native: &NativePlatform,
    queue: &HostQueue,
    ids: &mut BTreeSet<OpId>,
) -> T {
    let mut future = std::pin::pin!(future);
    for _ in 0..4096 {
        match future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        {
            Poll::Ready(value) => return value,
            Poll::Pending => {
                let requests = queue.take_requests();
                assert_eq!(requests.len(), 1);
                let (id, op) = requests.into_iter().next().unwrap();
                assert!(ids.insert(id));
                for _ in 0..3 {
                    assert!(
                        future
                            .as_mut()
                            .poll(&mut Context::from_waker(Waker::noop()))
                            .is_pending()
                    );
                    assert!(queue.take_requests().is_empty());
                }
                queue.complete(id, physical(native, op));
            }
        }
    }
    panic!("original bounded physical startup future did not finish");
}
fn include() -> Include {
    Include {
        effective: None,
        body: Some(true),
        document: Some(true),
        diagnostics: Some(true),
    }
}
#[test]
fn real_queued_replica_rescan_admits_original_eight_then_original_mid_waits_for_physical_publication()
 {
    run_physical_startup_and_publication(false);
}
#[test]
fn real_queued_replica_refused_flush_keeps_original_mid_and_intent_without_published_confirmation()
{
    run_physical_startup_and_publication(true);
}
fn run_physical_startup_and_publication(refuse_flush: bool) {
    let (root, native, queue, store, index) = fixture_mode(true);
    let bundle: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../fixtures/reader-semantic-digests/bundle.json"
    ))
    .unwrap();
    let docs = bundle["resources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["path"].as_str().unwrap().to_owned(),
                r["document"].as_str().unwrap().to_owned(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(docs.len(), 8);
    for (path, document) in &docs {
        let path = root.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, document).unwrap();
    }
    let identity =
        Identity::load_or_create(&root.join(".mdbase/identity.json"), 1, &mut OsEntropy).unwrap();
    let cfg = ReplicaConfig {
        collection: identity.collection,
        replica_id: identity.replica_id,
        device_id: identity.device_id,
        mode: SyncMode::LocalOnly,
        log_endpoint: EndpointId(0),
        verify: false,
        runtime_version: env!("CARGO_PKG_VERSION").into(),
        trusted_roots: Vec::new(),
        e2e: false,
        trusted_signers: vec![identity.device_id],
        user_enabled_cloud_copy: false,
        chosen_state: None,
        expected_genesis: None,
        policy_pins: None,
        key_grants_only: false,
    };
    let sealer = KeyringSealer::new(
        identity.collection,
        identity.device_id,
        &identity.secrets.sign_sk,
        &identity.secrets.kem_sk,
    );
    let host = Host {
        clock: Box::new(FixedClock(NOW)),
        entropy: Box::new(OsEntropy),
        zones: Box::new(SystemZones::default()),
    };
    let mut replica = Replica::open(
        cfg,
        store,
        Box::new(CorePlanner),
        Box::new(sealer),
        host,
        identity.secrets.clone(),
    )
    .unwrap();
    let (session, _) = replica
        .hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "owned-queued-file-test".into(),
                client_version: "1".into(),
                features: None,
                timezone: None,
            },
        )
        .unwrap();
    let mut ids = BTreeSet::new();
    drive_original(replica.observe_async(None), &native, &queue, &mut ids).unwrap();
    assert_eq!(queue.in_flight(), 0);
    assert!(queue.take_requests().is_empty());
    let describe = replica.describe(session).unwrap();
    assert_eq!(describe.contracts.len(), 3, "{describe:?}");
    assert!(describe.issues.is_empty());
    let catalog =
        mdbn_core::types::Catalog::load(docs.iter().map(|(p, d)| (p.as_str(), d.as_str())));
    for contract in describe.contracts {
        let original = catalog
            .contracts()
            .iter()
            .find(|c| c.id == contract.id && c.version.to_string() == contract.version)
            .unwrap();
        assert_eq!(contract.digest.0, original.digest.0);
        assert!(!contract.implemented_by.is_empty());
    }
    for (path, doc) in &docs {
        let resource = replica.get_resource(session, path.clone()).unwrap();
        assert!(resource.confirmed);
        assert_eq!(resource.text, *doc);
        assert_eq!(resource.revision, revision(doc.as_bytes()));
        assert_eq!(std::fs::read(root.join(path)).unwrap(), doc.as_bytes());
    }
    assert!(replica.store_mut().take_publish_results().is_empty());
    let record_id = B16(mdbn_local_host::host::uuid_v7(NOW, &mut OsEntropy));
    let original_mid = B16(mdbn_local_host::host::uuid_v7(NOW, &mut OsEntropy));
    let receipts = replica
        .submit(
            session,
            SubmitParams {
                ops: vec![Op::Create(Create {
                    id: record_id,
                    path: Some("notes/original.md".into()),
                    type_name: None,
                    frontmatter: Some(DataMap(vec![(
                        "title".into(),
                        Value::Text("Original queued document".into()),
                    )])),
                    body: Some(Text::Inline("ORIGINAL physical publication body.\n".into())),
                    document: None,
                })],
                mutation_id: Some(original_mid),
                conflict_mode: None,
                timezone: None,
                allow_partial: None,
                mutation_ids: None,
                dry_run: None,
                include: None,
                wait: None,
            },
        )
        .unwrap();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].mutation, original_mid);
    let pending = replica.receipt(session, original_mid).unwrap();
    assert_ne!(
        pending.published,
        Some(mdbn_wire::client::PublishState::Published),
        "pending batch never certifies published"
    );
    assert!(!root.join("notes/original.md").exists());
    assert!(queue.take_requests().is_empty());
    assert!(replica.publish_waits_open() > 0);
    let mut intents = BTreeMap::new();
    let mut progress = replica.store_mut().start_progress();
    if refuse_flush {
        let mut refused = false;
        let mut terminal = false;
        for turn in 0..64 {
            match progress.poll(NOW + turn) {
                Poll::Ready(Err(StoreError::Full)) => {
                    terminal = true;
                    break;
                }
                Poll::Ready(other) => {
                    panic!("original flush failure cannot certify publication: {other:?}")
                }
                Poll::Pending => {
                    let requests = queue.take_requests();
                    assert_eq!(requests.len(), 1);
                    let (id, op) = requests.into_iter().next().unwrap();
                    assert!(ids.insert(id));
                    let journaled = audit_intents(&index, &mut intents);
                    if journaled == 0 {
                        assert!(intents.is_empty());
                        assert_eq!(
                            op,
                            FileOp::Stat {
                                path: mdbn_store_file::platform::RelPath::new("notes").unwrap()
                            },
                            "only ORIGINAL ancestor admission precedes intent allocation"
                        );
                    } else {
                        assert_eq!(journaled, 1);
                    }
                    for _ in 0..3 {
                        assert!(progress.poll(NOW + turn).is_pending());
                        assert!(queue.take_requests().is_empty());
                    }
                    if matches!(op, FileOp::Flush { .. }) {
                        assert!(!refused);
                        refused = true;
                        queue.complete(
                            id,
                            Err(FsError::new(
                                FsErrorKind::NoSpace,
                                "original publication flush refused",
                            )),
                        );
                    } else {
                        queue.complete(id, physical(&native, op));
                    }
                }
            }
        }
        assert!(refused && terminal);
        drop(progress);
        assert_eq!(intents.len(), 1);
        assert_eq!(audit_intents(&index, &mut intents), 1);
        assert!(replica.store_mut().take_publish_results().is_empty());
        replica.on_store_progress();
        if let Ok(receipt) = replica.receipt(session, original_mid) {
            assert_eq!(receipt.mutation, original_mid);
            assert_ne!(
                receipt.published,
                Some(mdbn_wire::client::PublishState::Published)
            );
        }
        assert!(replica.store().head().is_err());
        assert!(replica.publish_waits_open() > 0);
        assert_eq!(queue.in_flight(), 0);
        assert!(queue.take_requests().is_empty());
        assert_eq!(
            SqlStore::open(index.clone())
                .unwrap()
                .local_receipt(&original_mid)
                .unwrap()
                .unwrap()
                .mutation,
            original_mid
        );
        for (path, doc) in &docs {
            assert_eq!(std::fs::read(root.join(path)).unwrap(), doc.as_bytes());
        }
        return;
    }
    assert!(
        drive(
            &mut progress,
            &native,
            &queue,
            &index,
            &mut ids,
            &mut intents
        )
        .unwrap()
        .drifts
        .is_empty()
    );
    drop(progress);
    assert_eq!(intents.len(), 1);
    assert_eq!(audit_intents(&index, &mut intents), 0);
    // Exactly the existing engine hook consumes the ORIGINAL deferred outcome.
    replica.on_store_progress();
    let receipt = replica.receipt(session, original_mid).unwrap();
    assert_eq!(receipt.mutation, original_mid);
    assert_eq!(receipt.state, ReceiptState::Confirmed);
    assert_eq!(
        receipt.published,
        Some(mdbn_wire::client::PublishState::Published)
    );
    assert!(receipt.seq.is_none());
    let read = replica
        .get(session, Target::Id(record_id), include())
        .unwrap();
    assert_eq!(read.id, record_id);
    assert_eq!(read.path, "notes/original.md");
    assert_eq!(
        read.body.as_deref(),
        Some("ORIGINAL physical publication body.\n")
    );
    let document = read.document.as_ref().unwrap();
    assert_eq!(read.revision, revision(document.as_bytes()));
    assert_eq!(
        std::fs::read(root.join("notes/original.md")).unwrap(),
        document.as_bytes()
    );
    assert_eq!(replica.publish_waits_open(), 0);
    assert!(replica.store_mut().take_publish_results().is_empty());
    replica.on_store_progress();
    assert_eq!(
        replica.receipt(session, original_mid).unwrap(),
        receipt,
        "completion never replaces original receipt ownership"
    );
    for (path, doc) in &docs {
        assert_eq!(std::fs::read(root.join(path)).unwrap(), doc.as_bytes());
    }
    assert_eq!(queue.in_flight(), 0);
    assert!(queue.take_requests().is_empty());
}
