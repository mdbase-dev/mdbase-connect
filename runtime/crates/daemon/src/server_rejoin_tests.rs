//! Cloud remove/rejoin through the daemon and a real loopback log.
use super::*;

impl CloudFixture {
    async fn restart(&mut self, dir: &crate::testutil::TestDir) {
        let mut restarted = daemon(dir);
        let d = Arc::get_mut(&mut restarted).unwrap();
        d.identity = Default::default();
        d.secrets = self.d.secrets.clone();
        d.trust = self.d.trust.clone();
        initialize(restarted.clone()).await;
        assert_eq!(
            restarted.identity.get().unwrap().public(),
            self.d.identity.get().unwrap().public()
        );
        self.d = restarted;
    }

    fn join_request(folder: &std::path::Path, recover_removed: bool) -> JoinCollection {
        JoinCollection {
            collection: HOSTED.into(),
            path: folder.into(),
            private: false,
            name: None,
            recover_removed,
        }
    }

    async fn download(&self, folder: &std::path::Path, recover_removed: bool) -> String {
        self.d
            .join(Self::join_request(folder, recover_removed))
            .await
            .unwrap();
        let status = self
            .d
            .settled_status(HOSTED, Duration::from_secs(30))
            .await
            .unwrap();
        assert_eq!(
            status.state,
            crate::control::CollectionState::Ready,
            "{status:?}"
        );
        for (_, path, document) in hosted_mirror::server_records() {
            assert_eq!(
                std::fs::read(folder.join(path)).unwrap(),
                document.as_bytes(),
                "{path}"
            );
        }
        self.d
            .inner
            .lock()
            .await
            .registry
            .get(HOSTED)
            .unwrap()
            .replica_id
            .clone()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cloud_rejoin_replays_after_interrupted_remove_and_join() {
    let dir = crate::testutil::TestDir::new("rejoin");
    let folders = crate::testutil::TestDir::new("rejoin-files");
    let mut f = cloud_fixture(&dir, &folders).await;
    f.connect.enrolments.store(1, Ordering::SeqCst);
    let old = folders.path().join("original");
    let fresh = folders.path().join("fresh");
    std::fs::create_dir(&old).unwrap();
    std::fs::create_dir(&fresh).unwrap();
    let original = f.download(&old, false).await;
    let private = f.d.profile.collection_dir(HOSTED);
    let archive = private.with_file_name(format!("{HOSTED}.removed-{original}"));

    let mut old_grant = grant(1);
    old_grant.collection = HOSTED.into();
    f.d.apply_control_plane_grants(HOSTED, &[old_grant], u64::MAX)
        .await
        .unwrap();
    let prior_access = std::fs::read(f.d.profile.access_file()).unwrap();
    // Fail registry publication. The registration and its entire store stay paired.
    let tmp =
        f.d.profile
            .state_dir
            .join(format!(".collections.json.tmp-{}", std::process::id()));
    std::fs::create_dir(&tmp).unwrap();
    assert!(f.d.remove(HOSTED).await.is_err());
    assert_eq!(
        Registry::load(&f.d.profile.registry_file())
            .unwrap()
            .get(HOSTED)
            .unwrap()
            .replica_id,
        original
    );
    assert!(private.join("index.sqlite").is_file() && !archive.exists());
    assert_eq!(
        std::fs::read(f.d.profile.access_file()).unwrap(),
        prior_access
    );
    std::fs::remove_dir(tmp).unwrap();
    f.restart(&dir).await;
    f.d.remove(HOSTED).await.unwrap();
    assert_eq!(
        Registry::load(&f.d.profile.registry_file())
            .unwrap()
            .removed_cloud_replicas[HOSTED],
        original
    );

    // A crash immediately after unregister can leave the old grant file on disk.
    std::fs::write(f.d.profile.access_file(), &prior_access).unwrap();
    f.restart(&dir).await;
    std::fs::write(old.join("kept-local.md"), b"original folder only").unwrap();
    // Interrupt after preserving the store and writing sync.json, before the new
    // registration commits. Retry against that on-disk state (no second archive).
    let journal = crate::adopt::Journal::path(private.parent().unwrap(), HOSTED);
    std::fs::create_dir(&journal).unwrap();
    assert!(
        f.d.join(CloudFixture::join_request(&fresh, false))
            .await
            .is_err()
    );
    assert!(archive.join("index.sqlite").is_file());
    assert!(private.join("sync.json").is_file());
    assert!(!private.join("index.sqlite").exists());
    assert!(
        Registry::load(&f.d.profile.registry_file())
            .unwrap()
            .get(HOSTED)
            .is_none()
    );
    std::fs::remove_dir(journal).unwrap();
    f.restart(&dir).await;
    assert_ne!(f.download(&fresh, false).await, original);
    assert!(f.d.inner.lock().await.access.list(Some(HOSTED)).is_empty());
    assert!(!fresh.join("kept-local.md").exists());
    assert_eq!(
        std::fs::read(old.join("kept-local.md")).unwrap(),
        b"original folder only"
    );
    for (_, path, document) in hosted_mirror::server_records() {
        assert_eq!(std::fs::read(old.join(path)).unwrap(), document.as_bytes());
    }
    assert!(
        Registry::load(&f.d.profile.registry_file())
            .unwrap()
            .removed_cloud_replicas
            .is_empty()
    );
    f.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cloud_rejoin_recovers_a_legacy_store_but_refuses_a_foreign_replica_of_the_same_collection()
{
    let dir = crate::testutil::TestDir::new("old-rejoin");
    let folders = crate::testutil::TestDir::new("old-rejoin-files");
    let f = cloud_fixture(&dir, &folders).await;
    f.connect.enrolments.store(1, Ordering::SeqCst);
    let old = folders.path().join("original");
    let fresh = folders.path().join("fresh");
    std::fs::create_dir(&old).unwrap();
    std::fs::create_dir(&fresh).unwrap();
    let original = f.download(&old, false).await;
    f.d.remove(HOSTED).await.unwrap();
    // A different recorded replica cannot be overridden even with a local
    // keyring generation and explicit confirmation.
    f.d.inner
        .lock()
        .await
        .registry
        .removed_cloud_replicas
        .insert(HOSTED.into(), CONNECTOR.into());
    let err =
        f.d.join(CloudFixture::join_request(&fresh, true))
            .await
            .unwrap_err();
    assert_eq!(err.reason.as_deref(), Some("foreign_replica_store"));
    // Exact registry shape left by remove in v0.1.8–v0.1.20.
    std::fs::write(
        f.d.profile.registry_file(),
        br#"{"schema_version":1,"collections":[]}"#,
    )
    .unwrap();
    f.d.inner.lock().await.registry = Registry::load(&f.d.profile.registry_file()).unwrap();
    let private = f.d.profile.collection_dir(HOSTED);
    let saved = private.with_extension("saved");
    let foreign = folders.path().join("hosted-state");
    f.hosted_rt.stop().await;
    std::fs::rename(&private, &saved).unwrap();
    std::fs::rename(&foreign, &private).unwrap();
    std::fs::copy(saved.join("sync.json"), private.join("sync.json")).unwrap();
    for confirm in [false, true] {
        let err =
            f.d.join(CloudFixture::join_request(&fresh, confirm))
                .await
                .unwrap_err();
        assert_eq!(err.reason.as_deref(), Some("foreign_replica_store"));
        assert!(private.join("index.sqlite").is_file());
        assert!(
            Registry::load(&f.d.profile.registry_file())
                .unwrap()
                .get(HOSTED)
                .is_none()
        );
    }
    std::fs::rename(&private, foreign).unwrap();
    std::fs::rename(saved, &private).unwrap();
    let err =
        f.d.join(CloudFixture::join_request(&fresh, false))
            .await
            .unwrap_err();
    assert_eq!(err.reason.as_deref(), Some("confirm_removed_cloud_copy"));
    assert!(err.message.contains("--recover-removed"));
    assert_ne!(f.download(&fresh, true).await, original);
    assert!(
        private
            .with_file_name(format!("{HOSTED}.removed-{original}"))
            .join("index.sqlite")
            .is_file()
    );
    f.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cloud_rejoin_after_removing_an_older_failed_registration() {
    let dir = crate::testutil::TestDir::new("failed-rejoin");
    let folders = crate::testutil::TestDir::new("failed-rejoin-files");
    let mut f = cloud_fixture(&dir, &folders).await;
    f.connect.enrolments.store(1, Ordering::SeqCst);
    let old = folders.path().join("original");
    let failed = folders.path().join("failed");
    let fresh = folders.path().join("fresh");
    for path in [&old, &failed, &fresh] {
        std::fs::create_dir(path).unwrap();
    }
    let original = f.download(&old, false).await;
    let mut registry = Registry::load(&f.d.profile.registry_file()).unwrap();
    f.d.remove(HOSTED).await.unwrap();
    // A pre-fix join published this new registration but could never open the
    // store. Its ID must not become evidence against the real legacy copy.
    let entry = registry.get_mut(HOSTED).unwrap();
    entry.replica_id = secrets::new_uuid().unwrap();
    entry.root = failed;
    registry.save(&f.d.profile.registry_file()).unwrap();
    f.restart(&dir).await;
    let status =
        f.d.settled_status(HOSTED, Duration::from_secs(30))
            .await
            .unwrap();
    assert_eq!(status.reason.as_deref(), Some("open_failed"));
    f.d.remove(HOSTED).await.unwrap();
    assert!(
        Registry::load(&f.d.profile.registry_file())
            .unwrap()
            .removed_cloud_replicas
            .is_empty()
    );
    assert_ne!(f.download(&fresh, true).await, original);
    f.stop().await;
}
