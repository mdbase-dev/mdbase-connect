use super::*;
use crate::control::CollectionState;
use crate::testutil::TestDir;
use std::time::Instant;

async fn failed_host(
    daemon: &Daemon,
    folder: &TestDir,
) -> (Entry, Arc<crate::runtime::Runtime>, watch::Sender<bool>) {
    let value = daemon
        .add(AddCollection {
            initialize: false,
            path: folder.path().to_owned(),
            name: None,
            remove_legacy_identity: false,
        })
        .await
        .unwrap();
    let mut inner = daemon.inner.lock().await;
    let host = inner
        .hosts
        .iter_mut()
        .find(|h| h.entry().id == value["id"])
        .unwrap();
    host.barrier().unwrap().wait().await;
    assert!(host.is_serving());
    (
        host.entry().clone(),
        host.runtime().unwrap(),
        host.hold_integrity_stop(),
    )
}

// Drive the supervisor through any earlier registry wait. Once the host owns
// the stop, the test controls exactly when recovery can resume.
async fn wait_for_stop(d: &Daemon, recover: impl Future<Output = ()>) {
    let stopping = async {
        loop {
            if d.inner.lock().await.hosts[0].pending_stop().is_some() {
                return;
            }
            tokio::task::yield_now().await;
        }
    };
    tokio::select! {
        () = recover => panic!("recovery completed before stop release"),
        result = tokio::time::timeout(Duration::from_secs(2), stopping) =>
            result.expect("registry must be available during the stop"),
    }
}

async fn control(d: &Arc<Daemon>, method: &str) -> Value {
    let req = Request {
        v: PROTOCOL,
        id: 1,
        method: method.into(),
        params: json!({}),
    };
    tokio::time::timeout(
        Duration::from_secs(1),
        d.handle(&req, &mut ConnAuth::default()),
    )
    .await
    .unwrap_or_else(|_| panic!("{method} waited for the held stop"))
    .unwrap()
}

#[tokio::test]
async fn sync_recovery_keeps_control_reads_available_and_reopens_the_runtime() {
    let dir = TestDir::new("recovery");
    let folder = TestDir::new("recovery-folder");
    let d = paired_daemon(&dir).await;
    let (entry, old, release) = failed_host(&d, &folder).await;
    let now = Instant::now();
    d.recover_sync_hosts(now).await;
    let recover = d.recover_sync_hosts(now + Duration::from_secs(10));
    tokio::pin!(recover);
    wait_for_stop(&d, &mut recover).await;
    let list = control(&d, Method::COLLECTION_LIST).await;
    assert_eq!(list[0]["id"], entry.id);
    assert_eq!(list[0]["state"], "failed");
    assert_eq!(control(&d, Method::STATUS).await["collections"], list);

    let barrier = d.inner.lock().await.hosts[0].barrier().unwrap().wait();
    tokio::pin!(barrier);
    assert!(futures_util::poll!(&mut barrier).is_pending());
    release.send(true).unwrap();
    barrier.await;
    assert!(old.readiness().await.is_none());
    recover.await;
    let mut inner = d.inner.lock().await;
    let host = &mut inner.hosts[0];
    host.barrier().unwrap().wait().await;
    assert!(host.is_serving());
    assert!(!Arc::ptr_eq(&old, &host.runtime().unwrap()));
    host.close().await;
}

#[tokio::test]
async fn sync_recovery_honors_removal_and_same_id_registration() {
    for replace in [false, true] {
        let dir = TestDir::new("recovery-remove");
        let folder = TestDir::new("recovery-remove-folder");
        let d = paired_daemon(&dir).await;
        let (mut entry, old, release) = failed_host(&d, &folder).await;
        let now = Instant::now();
        d.recover_sync_hosts(now).await;
        let recover = d.recover_sync_hosts(now + Duration::from_secs(10));
        tokio::pin!(recover);
        wait_for_stop(&d, &mut recover).await;

        let remove = tokio::spawn({
            let d = d.clone();
            let id = entry.id.clone();
            async move { d.remove(&id).await }
        });
        assert_eq!(
            control(&d, Method::COLLECTION_LIST).await[0]["id"],
            entry.id
        );
        release.send(true).unwrap();
        remove.await.unwrap().unwrap();
        assert!(old.readiness().await.is_none());
        if replace {
            entry.paused = true;
            let mut inner = d.inner.lock().await;
            inner.registry.add(entry.clone()).unwrap();
            d.save_registry(&inner.registry).unwrap();
            d.authority.publish_registry(&inner.registry);
            inner
                .hosts
                .push(CollectionHost::open(entry.clone(), d.host_ctx()));
        }
        recover.await;
        let inner = d.inner.lock().await;
        assert_eq!(inner.hosts.len(), usize::from(replace));
        assert_eq!(inner.registry.get(&entry.id).is_some(), replace);
        if replace {
            assert_eq!(inner.hosts[0].state(), CollectionState::Paused);
            assert!(inner.hosts[0].runtime().is_none());
        }
    }
}

/// A replica that fences itself after a fault of its own storage is reopened at
/// once and serves again. It is never reported or retained as a sync
/// consistency failure.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_storage_fence_reopens_at_once_without_a_sync_failure() {
    use super::mirror_join_tests::{CP_LABEL, admin_log_rpc, create_log};
    use super::private_approval_tests::{collection_status, keys, open, pair, serve_connect};
    use crate::registry::Origin;
    use mdbn_log_server::{AnyService, Gateway};
    use mdbn_log_service::Service;
    use mdbn_log_service::mem::{MemBackend, MemObjects};
    use mdbn_log_service::testkit::ControlPlane;
    use mdbn_wire::common::{B16, B32, Bytes};
    use mdbn_wire::log_service::{AppendParams, HeadParams, HeadResult};
    use mdbn_wire::policy::{CState, DeviceEnrol, DeviceKind, Genesis, MemberSet, PolicyOp, Role};
    use mdbn_wire::schema::Wire;
    use tokio::net::TcpListener;

    let cp = ControlPlane::new(CP_LABEL);
    let log_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let log = format!("http://{}", log_listener.local_addr().unwrap());
    let log_server = tokio::spawn(mdbn_log_server::serve(
        Gateway::new(
            AnyService::Mem(Service::new(
                MemBackend::default(),
                MemObjects::default(),
                mdbn_log_server::testkit_config(CP_LABEL, &log),
            )),
            false,
        ),
        log_listener,
    ));
    let cp_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let trust = Arc::new(crate::trust::Trust {
        environment: crate::trust::Environment::Lab.name().into(),
        cp_origin: format!("http://{}", cp_listener.local_addr().unwrap()),
        log_origin: log.clone(),
        roots: vec![cp.root_pk().0],
        policy_pins: crate::trust::pins_for(
            cp.root_pk().0,
            cp.transport_key().verifying_key().to_bytes(),
        ),
    });
    let dir = TestDir::new("fence-reopen");
    let (collection, owner) = (B16(new_uuid_v7()), B16(new_uuid_v7()));
    let d = pair(&dir, &trust, owner).await;
    let device = keys(&d);
    let genesis = cp.policy_item(
        collection,
        1,
        B32([0; 32]),
        vec![
            PolicyOp::Genesis(Genesis {
                owner,
                root: mdbn_log_service::policy::key_id(&cp.root_pk()),
                state: CState::E2e,
            }),
            PolicyOp::MemberSet(MemberSet {
                account: owner,
                role: Role::Owner,
            }),
            PolicyOp::DeviceEnrol(DeviceEnrol {
                device: device.device,
                account: owner,
                kind: DeviceKind::Desktop,
                sign_pk: B32(device.sign_pk),
                kem_pk: B32(device.kem_pk),
                noise_pk: B32(device.noise_pk),
                sas_commit: None,
                local_root: None,
            }),
        ],
        1,
    );
    let pin = mdbn_wire::hash::chain_hash(&genesis);
    create_log(&log, &cp, collection, genesis).await;
    let cp_server = tokio::spawn(serve_connect(
        cp_listener,
        collection,
        [device, device],
        Arc::new(tokio::sync::Notify::new()),
    ));
    open(&d, collection, pin, Origin::Created).await;
    let ready = || async {
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                d.recover_sync_hosts(Instant::now()).await;
                let status = collection_status(&d).await;
                assert_ne!(status["state"], "failed", "{status}");
                assert_ne!(
                    status["reason"],
                    crate::collections::SYNC_INTEGRITY,
                    "{status}"
                );
                assert!(status["last_sync_failure"].is_null(), "{status}");
                if status["state"] == "ready" {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("the collection never served");
    };
    ready().await;
    let fenced = d.inner.lock().await.hosts[0].runtime().unwrap();

    // The next commit has an unknown outcome: applying the next log item fences
    // the replica (`apply_durability_unknown`), as a failing disk would.
    assert!(fenced.test_fail_unknown_commits(1).await);
    let head = HeadResult::from_cbor(
        &admin_log_rpc(
            &log,
            &cp,
            collection,
            "head",
            HeadParams { collection }.to_cbor(),
        )
        .await,
    )
    .unwrap();
    let item = cp.policy_item(
        collection,
        head.head + 1,
        head.head_chain,
        vec![PolicyOp::MemberSet(MemberSet {
            account: B16(new_uuid_v7()),
            role: Role::Viewer,
        })],
        mdbn_log_server::now_ms(),
    );
    admin_log_rpc(
        &log,
        &cp,
        collection,
        "append",
        AppendParams {
            collection,
            expect_seq: head.head + 1,
            expect_prev: head.head_chain,
            items: vec![Bytes(item)],
        }
        .to_cbor(),
    )
    .await;

    // Stopped, reopened and serving again, without ever failing.
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let current = d.inner.lock().await.hosts[0].runtime();
            if current.is_none_or(|rt| !Arc::ptr_eq(&rt, &fenced)) {
                return;
            }
            d.recover_sync_hosts(Instant::now()).await;
            let status = collection_status(&d).await;
            assert_ne!(status["state"], "failed", "{status}");
            assert!(status["last_sync_failure"].is_null(), "{status}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the fenced runtime was never reopened");
    assert!(
        fenced.readiness().await.is_none(),
        "the fenced runtime stopped"
    );
    ready().await;
    let reopened = d.inner.lock().await.hosts[0].runtime().unwrap();
    let (status, _, _, fence) = reopened.readiness().await.unwrap();
    assert_eq!(fence, None);
    assert!(
        status
            .incidents
            .iter()
            .all(|i| i.kind != mdbn_wire::client::IncidentKind::Integrity)
    );
    let failure = d
        .profile
        .state_dir
        .join("collections")
        .join(collection.to_uuid_string())
        .join("last-sync-failure.json");
    assert!(!failure.exists(), "no sync failure is retained");
    d.inner.lock().await.hosts[0].close().await;
    cp_server.abort();
    log_server.abort();
}
