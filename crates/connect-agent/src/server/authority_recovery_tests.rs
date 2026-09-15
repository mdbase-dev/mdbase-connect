use super::*;
use axum::{
    http::StatusCode,
    routing::{post, put},
    Json, Router,
};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use uuid::Uuid;

const TASK_DOCUMENT: &str =
    "---\nid: 77777777-7777-4777-8777-777777777777\n---\n# [test] Keep this task\n";

// A real local registry and transfer command, with only the remote HTTP boundary
// fault-injected. No direct writes to the fence/database and no live accounts.
struct TransferFixture {
    root: tempfile::TempDir,
    collection_id: Uuid,
    transfer_id: Uuid,
    url: String,
    completions: Arc<AtomicUsize>,
    complete_ok: Arc<AtomicBool>,
    remote_state: Arc<AtomicUsize>,
    cancel_status: Arc<AtomicUsize>,
    cancellations: Arc<AtomicUsize>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for TransferFixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl TransferFixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let registry = CollectionRegistry::open(root.path().join("state")).unwrap();
        let collection = registry
            .create(root.path().join("Tasks"), Some("[test] issue 345"), "UTC")
            .unwrap();
        std::fs::write(root.path().join("Tasks/task.md"), TASK_DOCUMENT).unwrap();
        let collection_id = collection.id;
        let transfer_id = Uuid::new_v4();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let import_url = url.clone();
        let remote_state = Arc::new(AtomicUsize::new(0));
        let begin_state = remote_state.clone();
        let manifest = Arc::new(std::sync::Mutex::new(serde_json::Value::Null));
        let begin_manifest = manifest.clone();
        let completions = Arc::new(AtomicUsize::new(0));
        let calls = completions.clone();
        let complete_ok = Arc::new(AtomicBool::new(false));
        let allow_complete = complete_ok.clone();
        let cancel_status = Arc::new(AtomicUsize::new(200));
        let status = cancel_status.clone();
        let cancellations = Arc::new(AtomicUsize::new(0));
        let cancel_calls = cancellations.clone();
        let app = Router::new()
            .route("/v1/connectors/collections/{id}/authority-transfers", post(move || {
                let url = import_url.clone();
                let remote_state = begin_state.load(Ordering::SeqCst);
                let manifest = begin_manifest.lock().unwrap().clone();
                async move {
                    if remote_state != 0 {
                        return Json(serde_json::json!({"transfer": {
                            "id": transfer_id, "collection_id": collection_id,
                            "state": if remote_state == 1 { "activating" } else { "completed" },
                            "authority_epoch": 2, "manifest_digest": manifest["manifest_digest"],
                            "source_revision": manifest["source_revision"], "final_head": manifest["source_head"]
                        }}));
                    }
                    Json(serde_json::json!({
                    "transfer": {"id": transfer_id, "collection_id": collection_id, "state": "prepared", "authority_epoch": 2},
                    "import": {"import_id": transfer_id, "manifest_url": format!("{url}/manifest"),
                        "records_url": format!("{url}/records"), "files_url": format!("{url}/files"),
                        "finalize_url": format!("{url}/finalize"), "access_token": "test-import"}
                })) }
            }))
            .route("/manifest", put(move |Json(value): Json<serde_json::Value>| {
                *manifest.lock().unwrap() = value;
                async { Json(serde_json::json!({"ok": true})) }
            }))
            .route("/records", put(|| async { Json(serde_json::json!({"ok": true})) }))
            .route("/finalize", post(|| async { Json(serde_json::json!({"ok": true})) }))
            .route("/v1/connectors/authority-transfers/{id}/complete", post(move || {
                calls.fetch_add(1, Ordering::SeqCst);
                let ok = allow_complete.load(Ordering::SeqCst);
                async move {
                    if ok {
                        (StatusCode::OK, Json(serde_json::json!({"status": "completed", "collection_id": collection_id, "authority_epoch": 2})))
                    } else {
                        (StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({"error": {"message": "[test] completion unavailable"}})))
                    }
                }
            }))
            .route("/v1/connectors/authority-transfers/{id}", axum::routing::delete(move || {
                cancel_calls.fetch_add(1, Ordering::SeqCst);
                let status = StatusCode::from_u16(status.load(Ordering::SeqCst) as u16).unwrap();
                async move { (status, Json(serde_json::json!({"ok": status.is_success(), "error": {"message": "[test] cancellation not confirmed"}}))) }
            }));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            root,
            collection_id,
            transfer_id,
            url,
            completions,
            complete_ok,
            remote_state,
            cancel_status,
            cancellations,
            server,
        }
    }

    fn state(&self) -> Arc<AgentState> {
        let registry = CollectionRegistry::open(self.root.path().join("state")).unwrap();
        let watcher = CollectionWatchService::start(registry.clone());
        Arc::new(AgentState::new(registry, watcher, Some(self.cloud())))
    }

    fn cloud(&self) -> CloudControlClient {
        CloudControlClient::new(self.url.clone(), "test-connector".to_string())
    }

    async fn transfer(&self, state: &Arc<AgentState>) -> ControlResponse {
        state
            .execute(ControlRequest::new(
                ControlCommand::CollectionTransferAuthority(
                    mdbase_connect_protocol::CollectionAuthorityTransferParams {
                        collection_id: self.collection_id,
                        target: AuthorityTarget::Remote,
                    },
                ),
            ))
            .await
    }

    async fn strand(&self) {
        let response = self.transfer(&self.state()).await;
        assert!(!response.ok);
        assert!(response
            .error
            .unwrap()
            .message
            .contains("outcome-uncertain"));
        assert_eq!(self.completions.load(Ordering::SeqCst), 3);
    }

    async fn assert_blocked(&self, state: &Arc<AgentState>) {
        for command in [
            ControlCommand::CollectionSetEnabled(
                mdbase_connect_protocol::CollectionEnabledParams {
                    collection_id: self.collection_id,
                    enabled: false,
                },
            ),
            ControlCommand::CollectionRemove(mdbase_connect_protocol::CollectionIdParams {
                collection_id: self.collection_id,
            }),
        ] {
            let response = state.execute(ControlRequest::new(command)).await;
            assert!(!response.ok);
            let error = response.error.unwrap();
            assert!(error.message.contains("is fencing mutations"), "{error:?}");
            assert!(error.message.contains(&self.transfer_id.to_string()));
        }
        assert_eq!(state.registry.list().unwrap().len(), 1);
        let manager = MirrorManager::open(
            &self.root.path().join("state"),
            state.registry.clone(),
            Some(self.cloud()),
            None,
        )
        .unwrap();
        let params = serde_json::from_value(serde_json::json!({
            "collection_id": Uuid::new_v4(), "path": self.root.path().join("Tasks"), "mode": "read_write"
        })).unwrap();
        let error = manager.add(params).await.unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Mirror folder overlaps a computer-owned collection"),
            "{error}"
        );
    }
}

#[tokio::test]
async fn issue_345_failed_transfer_survives_restart_and_blocks_folder_reuse() {
    let fixture = TransferFixture::new().await;
    fixture.strand().await;
    // Open a fresh registry/agent as after restarting the application.
    fixture.assert_blocked(&fixture.state()).await;
}

#[tokio::test]
async fn issue_345_resume_prepared_transfer_after_restart() {
    let fixture = TransferFixture::new().await;
    fixture.strand().await;
    fixture.complete_ok.store(true, Ordering::SeqCst);
    let state = fixture.state();
    let response = fixture.transfer(&state).await;
    assert!(response.ok, "{response:?}");
    assert_eq!(fixture.cancellations.load(Ordering::SeqCst), 0);
    assert!(!state.registry.get(fixture.collection_id).unwrap().enabled);
    assert_eq!(
        mdbase_connect_core::mirror_collection_id(&fixture.root.path().join("Tasks")).unwrap(),
        Some(fixture.collection_id)
    );
}

#[tokio::test]
async fn issue_345_resume_activating_or_completed_transfer_after_restart() {
    for remote_state in [1, 2] {
        let fixture = TransferFixture::new().await;
        fixture.strand().await;
        fixture.remote_state.store(remote_state, Ordering::SeqCst);
        fixture.complete_ok.store(true, Ordering::SeqCst);
        let state = fixture.state();
        let response = fixture.transfer(&state).await;
        assert!(response.ok, "{response:?}");
        assert_eq!(fixture.cancellations.load(Ordering::SeqCst), 0);
        assert!(!state.registry.get(fixture.collection_id).unwrap().enabled);
        assert_eq!(
            mdbase_connect_core::mirror_collection_id(&fixture.root.path().join("Tasks")).unwrap(),
            Some(fixture.collection_id)
        );
    }
}

#[tokio::test]
async fn issue_345_cancel_distinguishes_legacy_and_invalid_collection_inputs() {
    for case in [
        "spec_0_2_0",
        "spec_0_2_1",
        "spec_2_0_0",
        "malformed_config",
        "malformed_record",
        "invalid_record",
        "invalid_type",
    ] {
        let fixture = TransferFixture::new().await;
        fixture.strand().await;
        let root = fixture.root.path().join("Tasks");
        match case {
            "spec_0_2_0" => {
                std::fs::write(root.join("mdbase.yaml"), "spec_version: 0.2.0\n").unwrap()
            }
            "spec_0_2_1" => {
                std::fs::write(root.join("mdbase.yaml"), "spec_version: 0.2.1\n").unwrap()
            }
            "spec_2_0_0" => {
                std::fs::write(root.join("mdbase.yaml"), "spec_version: 2.0.0\n").unwrap()
            }
            "malformed_config" => {
                std::fs::write(root.join("mdbase.yaml"), "spec_version: [\n").unwrap()
            }
            "malformed_record" => std::fs::write(
                root.join("task.md"),
                "---\ntitle: [\n---\n# [test] malformed\n",
            )
            .unwrap(),
            "invalid_record" => {
                std::fs::create_dir_all(root.join("_types")).unwrap();
                std::fs::write(
                    root.join("_types/task.md"),
                    "---\nname: task\nfields:\n  count: { type: integer, required: true }\n---\n",
                )
                .unwrap();
                std::fs::write(
                    root.join("task.md"),
                    "---\ntype: task\ncount: not-a-number\n---\n# [test] invalid field\n",
                )
                .unwrap();
            }
            "invalid_type" => {
                std::fs::create_dir_all(root.join("_types")).unwrap();
                std::fs::write(root.join("_types/task.md"), "---\nname: task\nfields:\n  broken: { type: string, computed: 'title +' }\n---\n").unwrap();
            }
            _ => unreachable!(),
        }
        let config_before = std::fs::read(root.join("mdbase.yaml")).unwrap();
        let record_before = std::fs::read(root.join("task.md")).unwrap();
        let state = fixture.state();
        let response = state
            .cancel_authority_transfer(fixture.collection_id, fixture.transfer_id)
            .await;
        assert_eq!(fixture.cancellations.load(Ordering::SeqCst), 1);
        let expected_error = match case {
            "spec_2_0_0" => Some("Unsupported spec version: 2.0.0"),
            "malformed_config" => Some("Configuration error:"),
            "invalid_type" => Some("Computed field 'broken' is invalid"),
            _ => None,
        };
        let fenced = state
            .registry
            .get(fixture.collection_id)
            .unwrap()
            .authority_transfer
            .is_some();
        assert_eq!(fenced, expected_error.is_some(), "{case}: {response:?}");
        match expected_error {
            Some(expected) => {
                let error = response.unwrap_err().to_string();
                assert!(error.contains(expected), "{case}: {error}");
                assert!(
                    !error.contains("No such file or directory"),
                    "{case}: {error}"
                );
            }
            None => {
                response.unwrap();
            }
        }
        assert_eq!(
            std::fs::read(root.join("mdbase.yaml")).unwrap(),
            config_before
        );
        assert_eq!(std::fs::read(root.join("task.md")).unwrap(), record_before);
    }
}

#[tokio::test]
async fn issue_345_confirmed_cancel_with_missing_source_remains_fenced() {
    for missing_folder in [false, true] {
        let fixture = TransferFixture::new().await;
        fixture.strand().await;
        let original = fixture.root.path().join(if missing_folder {
            "Tasks"
        } else {
            "Tasks/mdbase.yaml"
        });
        let saved = fixture.root.path().join("saved-source");
        std::fs::rename(&original, &saved).unwrap();
        // Only temporary test data is moved. Reopen the daemon to avoid a cached runtime.
        let state = fixture.state();
        for expected_calls in 1..=2 {
            let error = state
                .cancel_authority_transfer(fixture.collection_id, fixture.transfer_id)
                .await
                .unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("Filesystem error: No such file or directory"),
                "{error}"
            );
            assert_eq!(fixture.cancellations.load(Ordering::SeqCst), expected_calls);
            assert_eq!(
                state
                    .registry
                    .get(fixture.collection_id)
                    .unwrap()
                    .authority_transfer
                    .unwrap()
                    .transfer_id,
                fixture.transfer_id
            );
        }
        std::fs::rename(&saved, &original).unwrap();
        state
            .cancel_authority_transfer(fixture.collection_id, fixture.transfer_id)
            .await
            .unwrap();
        assert_eq!(fixture.cancellations.load(Ordering::SeqCst), 3);
        assert!(state
            .registry
            .get(fixture.collection_id)
            .unwrap()
            .authority_transfer
            .is_none());
        assert_eq!(
            std::fs::read_to_string(fixture.root.path().join("Tasks/task.md")).unwrap(),
            TASK_DOCUMENT
        );
    }
}

#[tokio::test]
async fn issue_345_cancel_after_remote_success_before_local_restart() {
    let fixture = TransferFixture::new().await;
    fixture.strand().await;
    // Simulate a successful remote cancellation followed by a process crash
    // before the local fence can be cleared. Recovery repeats that exact DELETE.
    fixture
        .cloud()
        .cancel_remote_authority_transfer(fixture.transfer_id)
        .await
        .unwrap();
    let state = fixture.state();
    fixture.assert_blocked(&state).await;
    let response = state
        .cancel_authority_transfer(fixture.collection_id, fixture.transfer_id)
        .await;
    assert!(response.is_ok(), "{response:?}");
    assert_eq!(fixture.cancellations.load(Ordering::SeqCst), 2);
    state.registry.remove(fixture.collection_id).unwrap();
}

#[tokio::test]
async fn issue_345_cancel_requires_confirmation_then_allows_removal_without_deleting_files() {
    let fixture = TransferFixture::new().await;
    fixture.strand().await;
    let state = fixture.state();
    let cancel = |transfer_id| {
        ControlRequest::new(ControlCommand::CollectionCancelAuthorityTransfer(
            mdbase_connect_protocol::CollectionAuthorityTransferRecoveryParams {
                collection_id: fixture.collection_id,
                transfer_id,
            },
        ))
    };
    let mismatch = state.execute(cancel(Uuid::new_v4())).await;
    assert!(!mismatch.ok);
    assert_eq!(fixture.cancellations.load(Ordering::SeqCst), 0);
    // Revoked credentials, unknown outcome and activation-in-progress must all
    // preserve the fence, rather than treating any HTTP response as success.
    for status in [401, 404, 503, 409] {
        fixture.cancel_status.store(status, Ordering::SeqCst);
        assert!(!state.execute(cancel(fixture.transfer_id)).await.ok);
        fixture.assert_blocked(&state).await;
    }
    fixture.cancel_status.store(200, Ordering::SeqCst);
    let response = state.execute(cancel(fixture.transfer_id)).await;
    assert!(response.ok, "{response:?}");
    assert!(state
        .registry
        .get(fixture.collection_id)
        .unwrap()
        .authority_transfer
        .is_none());
    state
        .registry
        .set_enabled(fixture.collection_id, false)
        .unwrap();
    state.registry.remove(fixture.collection_id).unwrap();
    assert!(state.registry.list().unwrap().is_empty());
    assert!(fixture.root.path().join("Tasks/mdbase.yaml").is_file());
    assert_eq!(
        std::fs::read_to_string(fixture.root.path().join("Tasks/task.md")).unwrap(),
        TASK_DOCUMENT
    );
}
