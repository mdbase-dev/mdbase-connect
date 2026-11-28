//! One busy collection does not hold up the grant feed or control reads
//! (a parked background open, a parked collection actor).
use super::*;
use crate::testutil::TestDir;

/// A paired daemon serving one added local collection.
async fn serving(dir: &TestDir, folder: &TestDir) -> Arc<Daemon> {
    let d = paired_daemon(dir).await;
    d.add(AddCollection {
        initialize: false,
        path: folder.path().to_owned(),
        name: None,
        remove_legacy_identity: false,
    })
    .await
    .unwrap();
    let barrier = d.inner.lock().await.hosts[0].barrier().unwrap();
    barrier.wait().await;
    assert!(d.inner.lock().await.hosts[0].is_serving());
    d
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_renewal_commits_during_a_parked_open_and_a_revocation_waits_for_it() {
    let (dir, folder) = (
        TestDir::new("stall-feed"),
        TestDir::new("stall-feed-folder"),
    );
    let d = serving(&dir, &folder).await;
    d.commit_control_plane_feed(&snapshot(1), &grants(Some(grant(1))))
        .await
        .unwrap();
    let release = d.inner.lock().await.hosts[0].hold_open();

    // The same grants with a later lease: nothing to re-check, no waiting.
    tokio::time::timeout(
        Duration::from_secs(1),
        d.commit_control_plane_feed(&snapshot(2), &grants(Some(grant(1)))),
    )
    .await
    .expect("a renewal waited for a collection to finish opening")
    .unwrap();
    assert_eq!(
        d.inner
            .lock()
            .await
            .access
            .feed_cursor
            .as_ref()
            .unwrap()
            .sequence,
        2
    );

    // A revocation is acknowledged only after every runtime re-checked.
    let revoke = tokio::spawn({
        let d = d.clone();
        async move {
            d.commit_control_plane_feed(&snapshot(3), &grants(None))
                .await
        }
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!revoke.is_finished(), "a revocation skipped the barrier");
    assert!(
        d.inner.lock().await.access.entries.is_empty(),
        "the revocation is published before the barrier"
    );
    release.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(5), revoke)
        .await
        .expect("the barrier released")
        .unwrap()
        .unwrap();
    d.inner.lock().await.hosts[0].close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn status_and_list_answer_while_a_serving_actor_is_parked() {
    let (dir, folder) = (
        TestDir::new("stall-status"),
        TestDir::new("stall-status-folder"),
    );
    let d = serving(&dir, &folder).await;
    let runtime = d.inner.lock().await.hosts[0].runtime().unwrap();
    let parked = runtime.test_park();

    let status = tokio::spawn({
        let d = d.clone();
        async move { d.status().await }
    });
    // Meanwhile the registry lock is free for everyone else.
    for _ in 0..10 {
        drop(
            tokio::time::timeout(Duration::from_millis(200), d.inner.lock())
                .await
                .expect("status held the daemon lock across an actor wait"),
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let status = tokio::time::timeout(Duration::from_secs(8), status)
        .await
        .expect("status waited on a parked collection")
        .unwrap();
    let collection = &status.collections[0];
    assert!(collection.sync.is_none());
    assert!(
        collection
            .notices
            .iter()
            .any(|n| n.code == crate::collections::NOT_RESPONDING),
        "{:?}",
        collection.notices
    );

    let req = Request {
        v: PROTOCOL,
        id: 1,
        method: Method::COLLECTION_LIST.into(),
        params: json!({}),
    };
    let list = tokio::time::timeout(
        Duration::from_secs(5),
        d.handle(&req, &mut ConnAuth::default()),
    )
    .await
    .expect("collection.list waited on a parked collection")
    .unwrap();
    assert_eq!(
        list[0]["notices"],
        serde_json::to_value(&collection.notices).unwrap()
    );

    drop(parked);
    let status = d.status().await;
    assert!(status.collections[0].sync.is_some());
    d.inner.lock().await.hosts[0].close().await;
}
