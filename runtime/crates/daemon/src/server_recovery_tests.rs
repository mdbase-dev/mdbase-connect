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
