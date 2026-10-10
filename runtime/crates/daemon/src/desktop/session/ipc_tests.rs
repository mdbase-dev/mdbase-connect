//! Real local control sockets/pipes and daemon handlers, with fixture-only
//! in-memory credentials and a counted test confirmer. No native UI acceptance.

use super::*;
use crate::access::{AccessList, AccessState, CachedGrant};
use crate::confirm::{Answer, Confirmer};
use crate::secrets::{CONTROL_KEY, MemoryStore};
use crate::testutil::TestDir;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

fn profile(dir: &std::path::Path) -> Profile {
    let profile = Profile::isolated(dir).unwrap();
    // Unit-test cwd is this crate. Keep state absolute but socket names relative
    // to cwd: remote worktree prefixes exceed sockaddr_un's pathname limit.
    #[cfg(unix)]
    {
        let mut profile = profile;
        for endpoint in [&mut profile.control, &mut profile.replica] {
            if let crate::paths::Endpoint::Unix(path) = endpoint {
                *path = path
                    .strip_prefix(std::env::current_dir().unwrap())
                    .unwrap()
                    .to_owned();
            }
        }
        profile
    }
    #[cfg(not(unix))]
    profile
}

struct Counted {
    answer: Answer,
    calls: Arc<AtomicUsize>,
}

impl Confirmer for Counted {
    fn ask<'a>(
        &'a self,
        title: &'a str,
        message: &'a str,
    ) -> crate::session::BoxFuture<'a, Answer> {
        assert_eq!(title, "Approve app access");
        assert!(message.contains("Fixture app"));
        assert!(message.contains("App key:"));
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { self.answer })
    }
}

fn pending() -> AccessEntry {
    AccessEntry {
        grant: CachedGrant {
            grant: "11111111-1111-4111-8111-111111111111".to_owned(),
            account_id: None,
            collection: "22222222-2222-4222-8222-222222222222".to_owned(),
            app_id: "fixture.app".to_owned(),
            app_name: "Fixture app".to_owned(),
            client_pk: "11".repeat(32),
            capabilities: vec!["records.read".to_owned()],
            folders: None,
            legacy_only: false,
        },
        state: AccessState::PendingApproval,
        first_seen_ms: 1,
        generation: 1,
        acknowledged: false,
        delisted: false,
    }
}

struct Daemon {
    dir: TestDir,
    profile: Profile,
    keys: Arc<MemoryStore>,
    calls: Arc<AtomicUsize>,
    answer: Answer,
    task: Option<tokio::task::JoinHandle<Result<(), crate::server::RunError>>>,
}

impl Daemon {
    async fn new(answer: Answer) -> Self {
        let dir = TestDir::new("cp");
        let profile = profile(&dir.path().join("s"));
        crate::fsutil::ensure_private_dir(&profile.state_dir).unwrap();
        let list = AccessList {
            require_grant_approval: true,
            entries: vec![pending()],
            generation: 1,
            ..AccessList::default()
        };
        list.save(&profile.access_file()).unwrap();
        let mut daemon = Self {
            dir,
            profile,
            keys: Arc::new(MemoryStore::default()),
            calls: Arc::new(AtomicUsize::new(0)),
            answer,
            task: None,
        };
        daemon.start().await;
        daemon
    }

    async fn start(&mut self) {
        let profile = self.profile.clone();
        let keys = self.keys.clone();
        let confirmer = Counted {
            answer: self.answer,
            calls: self.calls.clone(),
        };
        assert!(self.task.is_none());
        self.task = Some(tokio::spawn(async move {
            crate::server::run_with(profile, Some(Box::new(keys)), Box::new(confirmer)).await
        }));
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if self.task.as_ref().unwrap().is_finished() {
                    panic!(
                        "daemon exited during startup: {:?}",
                        self.task.take().unwrap().await
                    );
                }
                if let Ok(readiness) = crate::client::ping(&self.profile.control).await
                    && readiness.ready
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("isolated daemon ready");
    }

    async fn shutdown(&mut self) {
        let mut client = connect(&self.profile, self.keys.as_ref()).await.unwrap();
        client
            .call(Method::SHUTDOWN, serde_json::json!({}))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(15), self.task.take().unwrap())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }

    fn subscribe(&self) -> (watch::Receiver<Snapshot>, tokio::task::JoinHandle<()>) {
        let (sender, receiver) = watch::channel(Snapshot::default());
        let task = tokio::spawn(subscribe_with(
            self.profile.clone(),
            sender,
            Box::new(self.keys.clone()),
        ));
        (receiver, task)
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

async fn until(
    receiver: &mut watch::Receiver<Snapshot>,
    condition: impl Fn(&Snapshot) -> bool,
) -> Snapshot {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let current = receiver.borrow_and_update().clone();
            if condition(&current) {
                break current;
            }
            receiver.changed().await.unwrap();
        }
    })
    .await
    .expect("companion snapshot condition")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_subscription_clears_on_disconnect_and_reopens_same_profile() {
    let mut daemon = Daemon::new(Answer::No).await;
    let (mut receiver, task) = daemon.subscribe();
    let initial = until(&mut receiver, |state| state.model.connected()).await;
    assert_eq!(initial.model.rows().len(), 1);
    assert_eq!(initial.notice_sequence, 1);
    assert!(initial.model.review(&pending().grant.grant).is_some());
    daemon.shutdown().await;
    let offline = until(&mut receiver, |state| !state.model.connected()).await;
    assert!(offline.model.rows().is_empty());
    assert!(offline.model.review(&pending().grant.grant).is_none());
    daemon.start().await;
    let reopened = until(&mut receiver, |state| state.model.connected()).await;
    assert_eq!(reopened.model.rows()[0].grant, pending().grant.grant);
    assert!(reopened.notice_sequence > initial.notice_sequence);
    drop(receiver);
    tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap();
    assert!(
        crate::client::ping(&daemon.profile.control)
            .await
            .unwrap()
            .ready,
        "closing companion must not stop the daemon"
    );
    daemon.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn review_cannot_replace_the_daemon_answer_or_live_lease() {
    for (answer, reason) in [
        (Answer::No, "not_confirmed"),
        (Answer::Unavailable, "confirmation_unavailable"),
        (Answer::Yes, "consent_changed"),
    ] {
        let mut daemon = Daemon::new(answer).await;
        let (mut receiver, task) = daemon.subscribe();
        let snapshot = until(&mut receiver, |state| state.model.connected()).await;
        let request = snapshot.model.review(&pending().grant.grant).unwrap();
        match request_review_with(&daemon.profile, &request, daemon.keys.as_ref()).await {
            Err(ClientError::Remote(error)) => assert_eq!(error.reason.as_deref(), Some(reason)),
            other => panic!("unexpected native gate result: {other:?}"),
        }
        assert_eq!(
            daemon.calls.load(Ordering::SeqCst),
            1,
            "exactly one daemon-owned prompt"
        );
        // Even the fixture's Yes cannot restore a cached lease across startup.
        let current = entries(&daemon.profile, daemon.keys.as_ref())
            .await
            .unwrap();
        assert_eq!(current[0].state, AccessState::PendingApproval);
        assert!(!current[0].acknowledged);
        drop(receiver);
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            daemon.calls.load(Ordering::SeqCst),
            1,
            "no automatic dialog retry"
        );
        daemon.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_and_foreign_credentials_never_publish_or_prompt() {
    let mut daemon = Daemon::new(Answer::Yes).await;
    let empty = MemoryStore::default();
    let foreign = MemoryStore::default();
    foreign.set(CONTROL_KEY, &[91; 32]).unwrap();
    let mut model = CompanionModel::default();
    model.replace(&[pending()]);
    let request = model.review(&pending().grant.grant).unwrap();
    for keys in [&empty, &foreign] {
        let (sender, receiver) = watch::channel(Snapshot::default());
        let mut state = Snapshot::default();
        assert!(
            connected(&daemon.profile, keys, &sender, &mut state)
                .await
                .is_err()
        );
        assert!(!receiver.has_changed().unwrap());
        assert!(!receiver.borrow().model.connected());
        assert!(receiver.borrow().model.rows().is_empty());
        assert!(
            request_review_with(&daemon.profile, &request, keys)
                .await
                .is_err()
        );
        assert_eq!(daemon.calls.load(Ordering::SeqCst), 0);
    }
    assert!(
        empty.get(CONTROL_KEY).unwrap().is_none(),
        "client must not mint a host key"
    );
    assert_eq!(
        entries(&daemon.profile, daemon.keys.as_ref())
            .await
            .unwrap()[0]
            .state,
        AccessState::PendingApproval
    );
    daemon.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_selected_profile_never_falls_back_to_a_running_daemon() {
    let mut daemon = Daemon::new(Answer::No).await;
    let profile = profile(&daemon.dir.path().join("absent"));
    let (sender, mut receiver) = watch::channel(Snapshot::default());
    let task = tokio::spawn(subscribe_with(
        profile.clone(),
        sender,
        Box::new(daemon.keys.clone()),
    ));
    tokio::time::timeout(Duration::from_secs(2), receiver.changed())
        .await
        .unwrap()
        .unwrap();
    assert!(!receiver.borrow().model.connected());
    assert!(receiver.borrow().model.rows().is_empty());
    assert!(!profile.state_dir.exists());
    assert!(
        crate::client::ping(&daemon.profile.control)
            .await
            .unwrap()
            .ready
    );
    drop(receiver);
    tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap();
    daemon.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn periodic_refresh_observes_locally_revoked_grants_without_an_access_push() {
    let mut daemon = Daemon::new(Answer::No).await;
    let (mut receiver, task) = daemon.subscribe();
    until(&mut receiver, |state| state.model.connected()).await;
    let mut client = connect(&daemon.profile, daemon.keys.as_ref())
        .await
        .unwrap();
    client
        .call(
            Method::ACCESS_REVOKE,
            serde_json::json!({"grant": pending().grant.grant}),
        )
        .await
        .unwrap();
    let revoked = until(&mut receiver, |state| {
        state
            .model
            .rows()
            .first()
            .is_some_and(|row| row.state == AccessState::RevokedLocally)
    })
    .await;
    assert!(revoked.model.review(&pending().grant.grant).is_none());
    assert_eq!(daemon.calls.load(Ordering::SeqCst), 0);
    drop(receiver);
    tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap();
    daemon.shutdown().await;
}
