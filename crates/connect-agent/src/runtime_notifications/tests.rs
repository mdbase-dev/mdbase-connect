use super::*;
use axum::{extract::State, routing::post, Json, Router};
use mdbase_connect_protocol::{
    ApplicationAccess, ContractRequirement, GrantPolicy, GrantScope, NotificationCriterion,
    NotificationPresentation, RuntimeExpression,
};
use mdbase_connect_runtime::{
    RECORD_MODIFIED_EVENT_DIGEST, RECORD_MODIFIED_EVENT_ID, TIMER_EVENT_DIGEST,
};
use rusqlite::Connection;
use serde_json::json;
use tempfile::tempdir;

#[test]
fn local_notification_runtime_upgrades_unversioned_state() {
    let state_dir = tempdir().unwrap();
    let runtime_dir = state_dir.path().join("runtime");
    std::fs::create_dir_all(&runtime_dir).unwrap();
    let registry = CollectionRegistry::open(state_dir.path()).unwrap();
    let collection_id = registry
        .create(
            state_dir.path().join("collection"),
            Some("Temporal"),
            "Australia/Melbourne",
        )
        .unwrap()
        .id;
    let path = runtime_dir.join(format!("{collection_id}.sqlite"));
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "
            CREATE TABLE runtime_events (
                cursor INTEGER PRIMARY KEY AUTOINCREMENT,
                source_runtime TEXT NOT NULL,
                event_id TEXT NOT NULL,
                envelope_json TEXT NOT NULL,
                received_at TEXT NOT NULL,
                UNIQUE(source_runtime, event_id)
            );
            ",
        )
        .unwrap();
    drop(connection);

    let mut service = RuntimeNotificationService {
        runtime_dir,
        local_registry: registry,
        cloud: None,
        runtimes: HashMap::new(),
    };
    service.runtime(collection_id).unwrap();
    drop(service);

    let connection = Connection::open(path).unwrap();
    let version = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
        .unwrap();
    assert_eq!(version, mdbase_runtime::SQLITE_SCHEMA_VERSION);
}

#[tokio::test]
async fn recovery_keeps_idle_registered_collections_cold() {
    let state_dir = tempdir().unwrap();
    let runtime_dir = state_dir.path().join("runtime");
    std::fs::create_dir_all(&runtime_dir).unwrap();
    let registry = CollectionRegistry::open(state_dir.path()).unwrap();
    for index in 0..12 {
        registry
            .create(
                state_dir.path().join(format!("collection-{index}")),
                Some(&format!("Collection {index}")),
                "UTC",
            )
            .unwrap();
    }
    let mut service = RuntimeNotificationService {
        runtime_dir: runtime_dir.clone(),
        local_registry: registry,
        cloud: None,
        runtimes: HashMap::new(),
    };

    service.recover().await;

    assert!(service.runtimes.is_empty());
    assert_eq!(std::fs::read_dir(runtime_dir).unwrap().count(), 0);
}

#[test]
fn compiled_workflows_keep_record_data_out_of_action_input() {
    let grant = GrantSummary {
        contracts: mdbase_connect_protocol::ConnectContractRequirements::current(true),
        id: Uuid::new_v4(),
        application_id: Uuid::new_v4(),
        application_declaration_id: "dev.mdbase.test".to_string(),
        application_manifest_digest: "00".repeat(32),
        application_name: "Tasks".to_string(),
        application_distribution: "web".to_string(),
        application_homepage: "https://tasks.example".to_string(),
        application_project_url: None,
        application_origin: Some("https://tasks.example".to_string()),
        application_icon: None,
        collection_id: Uuid::new_v4(),
        collection_name: "Private".to_string(),
        operations: vec!["changes".to_string()],
        scope: GrantScope {
            contracts: Vec::new(),
            access: ApplicationAccess::Contract,
        },
        notification_criteria: vec![NotificationCriterion {
            id: "task.ready".to_string(),
            event: ContractRequirement {
                id: RECORD_MODIFIED_EVENT_ID.to_string(),
                version: "1.0.0".to_string(),
                digest: RECORD_MODIFIED_EVENT_DIGEST.to_string(),
            },
            r#if: Some(RuntimeExpression {
                expression: "event.data.changed_fields.size() > 0".to_string(),
            }),
            debounce: Some("1s".to_string()),
            minimum_interval: None,
            presentation: NotificationPresentation {
                title: "A task changed".to_string(),
                body: None,
                tag: None,
            },
        }],
        created_at: "2026-07-24T00:00:00Z".to_string(),
        encryption: None,
        file_capability: None,
    };
    let catalog = compose_catalog(std::slice::from_ref(&grant), grant.collection_id).unwrap();
    let workflow = &catalog.admission().workflows()[0];
    let input = workflow.pointer("/steps/0/input").unwrap();
    let encoded = serde_json::to_string(input).unwrap();
    assert!(!encoded.contains("path"));
    assert!(!encoded.contains("frontmatter"));
    assert_eq!(workflow.pointer("/triggers/0/debounce"), Some(&json!("1s")));
}

#[tokio::test]
async fn private_watcher_event_becomes_only_an_opaque_cloud_signal() {
    let state_dir = tempdir().unwrap();
    let registry = CollectionRegistry::open(state_dir.path()).unwrap();
    let collection = registry
        .create(
            state_dir.path().join("collection"),
            Some("Private notes"),
            "UTC",
        )
        .unwrap();
    let grant_id = Uuid::new_v4();
    let application_id = Uuid::new_v4();
    let connector_id = Uuid::new_v4();
    let connector = mdbase_connect_protocol::crypto::RelayIdentity::generate();
    let application = mdbase_connect_protocol::crypto::RelayIdentity::generate();
    let operations = vec!["changes".to_string()];
    let encryption = mdbase_connect_protocol::GrantEncryption {
        protocol_version: mdbase_connect_protocol::GRANT_ENCRYPTION_PROTOCOL_VERSION,
        suite: mdbase_connect_protocol::RELAY_ENCRYPTION_SUITE.to_string(),
        key_id: "notification-test".to_string(),
        scope_epoch: 1,
        connector_id,
        collection_id: collection.id,
        application_agreement_public_key: application.public_key(),
        connector_agreement_public_key: connector.public_key(),
    };
    let security = crate::test_support::application_security(
        crate::test_support::TestApplicationSecurityParams {
            application_id,
            authorization_id: Uuid::new_v4(),
            collection_id: collection.id,
            operations: &operations,
            distribution: "web",
            grant_agreement_public_key: application.public_key(),
            file_capability: None,
        },
    );
    registry
        .replace_grants(&[GrantPolicy {
            id: grant_id,
            application_id,
            collection_id: collection.id,
            operations,
            scope: GrantScope::full_collection(),
            application_name: "Tasks".to_string(),
            application_distribution: "web".to_string(),
            application_homepage: "https://tasks.example".to_string(),
            application_project_url: None,
            application_origin: "https://tasks.example".to_string(),
            application_icon: None,
            collection_name: "Private notes".to_string(),
            notification_criteria: vec![
                NotificationCriterion {
                    id: "task.ready".to_string(),
                    event: ContractRequirement {
                        id: RECORD_MODIFIED_EVENT_ID.to_string(),
                        version: "1.0.0".to_string(),
                        digest: RECORD_MODIFIED_EVENT_DIGEST.to_string(),
                    },
                    r#if: None,
                    debounce: None,
                    minimum_interval: None,
                    presentation: NotificationPresentation {
                        title: "A task changed".to_string(),
                        body: None,
                        tag: None,
                    },
                },
                NotificationCriterion {
                    id: "reminder.due".to_string(),
                    event: ContractRequirement {
                        id: TIMER_EVENT_ID.to_string(),
                        version: "1.0.0".to_string(),
                        digest: TIMER_EVENT_DIGEST.to_string(),
                    },
                    r#if: None,
                    debounce: None,
                    minimum_interval: None,
                    presentation: NotificationPresentation {
                        title: "A reminder is due".to_string(),
                        body: None,
                        tag: None,
                    },
                },
            ],
            created_at: "2026-07-24T00:00:00Z".to_string(),
            encryption: Some(encryption),
            file_capability: None,
            application_authorization: security.proof,
        }])
        .unwrap();

    let (signals, mut signal_rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    async fn receive(
        State(signals): State<tokio::sync::mpsc::UnboundedSender<Value>>,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        signals.send(body).unwrap();
        Json(json!({"accepted": true, "duplicate": false}))
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/v1/connectors/notification-signals", post(receive))
                .with_state(signals),
        )
        .await
        .unwrap();
    });
    let mut service = RuntimeNotificationService {
        runtime_dir: state_dir.path().join("runtime"),
        local_registry: registry,
        cloud: Some(CloudControlClient::new(
            format!("http://{address}"),
            "connector-token".to_string(),
        )),
        runtimes: HashMap::new(),
    };
    std::fs::create_dir_all(&service.runtime_dir).unwrap();
    service
        .handle_event(CollectionRuntimeEvent {
            collection_id: collection.id,
            cursor: 9,
            event: mdbase::watch::WatchEvent {
                event_type: RECORD_MODIFIED_EVENT_ID.to_string(),
                sequence: 4,
                occurred_at: "2026-07-24T00:00:00Z".to_string(),
                payload: json!({
                    "path": "private/medical-note.md",
                    "before": {"status": "open", "secret": "never-upload"},
                    "changed_fields": ["status"],
                    "after": {"status": "ready", "secret": "never-upload"},
                    "previous_revision": "rev-1",
                    "revision": "rev-2",
                    "previous_types": ["task"],
                    "types": ["task"]
                }),
            },
        })
        .await
        .unwrap();
    let signal = tokio::time::timeout(Duration::from_secs(1), signal_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(signal["grant_id"], json!(grant_id));
    assert_eq!(signal["criterion_id"], json!("task.ready"));
    assert_eq!(signal["cursor"], json!("9"));
    assert!(signal["signal_id"]
        .as_str()
        .is_some_and(|value| value.starts_with("inv_")));
    let encoded = serde_json::to_string(&signal).unwrap();
    assert!(!encoded.contains("medical-note"));
    assert!(!encoded.contains("never-upload"));

    let timer_grant = service
        .local_registry
        .grant_context(grant_id)
        .unwrap()
        .unwrap();
    {
        let catalog = compose_catalog(std::slice::from_ref(&timer_grant), collection.id).unwrap();
        let runtime = service.runtime(collection.id).unwrap();
        perform_timer_operation(
            runtime,
            &catalog,
            &timer_grant,
            "put_timer",
            json!({
                "namespace": "reminders",
                "criterion_id": "reminder.due",
                "timer": {
                    "id": "private-reminder",
                    "fire_at": (chrono::Utc::now() - chrono::TimeDelta::seconds(1)).to_rfc3339(),
                    "data": {"private": "timer-state-stays-local"}
                }
            }),
        )
        .await
        .unwrap();
    }
    let runtime_dir = service.runtime_dir.clone();
    let local_registry = service.local_registry.clone();
    let cloud = service.cloud.clone();
    drop(service);
    let mut service = RuntimeNotificationService {
        runtime_dir,
        local_registry,
        cloud,
        runtimes: HashMap::new(),
    };
    service.recover().await;
    assert!(
        service.runtimes.is_empty(),
        "completed notification work should release its runtime"
    );
    let timer_signal = tokio::time::timeout(Duration::from_secs(1), signal_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(timer_signal["grant_id"], json!(grant_id));
    assert_eq!(timer_signal["criterion_id"], json!("reminder.due"));
    let encoded = serde_json::to_string(&timer_signal).unwrap();
    assert!(!encoded.contains("private-reminder"));
    assert!(!encoded.contains("timer-state-stays-local"));

    let timer_grant = service
        .local_registry
        .grant_context(grant_id)
        .unwrap()
        .unwrap();
    {
        let catalog = compose_catalog(std::slice::from_ref(&timer_grant), collection.id).unwrap();
        let runtime = service.runtime(collection.id).unwrap();
        perform_timer_operation(
            runtime,
            &catalog,
            &timer_grant,
            "put_timer",
            json!({
                "namespace": "reminders",
                "criterion_id": "reminder.due",
                "timer": {
                    "id": "revoked-reminder",
                    "fire_at": (chrono::Utc::now() - chrono::TimeDelta::seconds(1)).to_rfc3339(),
                    "data": {}
                }
            }),
        )
        .await
        .unwrap();
    }
    service.local_registry.replace_grants(&[]).unwrap();
    service.recover().await;
    assert!(
        tokio::time::timeout(Duration::from_millis(100), signal_rx.recv())
            .await
            .is_err(),
        "a revoked grant's due timer must be cancelled before recovery dispatch"
    );
    let timers = service
        .runtime(collection.id)
        .unwrap()
        .timers(&format!("connect:{grant_id}:"))
        .await
        .unwrap();
    assert!(timers
        .iter()
        .any(|timer| matches!(timer.status, mdbase_runtime::TimerStatus::Cancelled)));
    assert!(timers.iter().all(|timer| matches!(
        timer.status,
        mdbase_runtime::TimerStatus::Cancelled | mdbase_runtime::TimerStatus::Fired
    )));

    service
        .local_registry
        .set_enabled(collection.id, false)
        .unwrap();
    service
        .handle_event(CollectionRuntimeEvent {
            collection_id: collection.id,
            cursor: 10,
            event: mdbase::watch::WatchEvent {
                event_type: RECORD_MODIFIED_EVENT_ID.to_string(),
                sequence: 5,
                occurred_at: "2026-07-24T00:01:00Z".to_string(),
                payload: json!({
                    "path": "private/medical-note.md",
                    "before": {"status": "ready"},
                    "changed_fields": ["status"],
                    "after": {"status": "done"},
                    "previous_revision": "rev-2",
                    "revision": "rev-3",
                    "previous_types": ["task"],
                    "types": ["task"]
                }),
            },
        })
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), signal_rx.recv())
            .await
            .is_err(),
        "disabled collections must not dispatch notification signals"
    );
    server.abort();
    let _ = server.await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn timer_handle_reconciles_through_the_running_local_authority() {
    let state_dir = tempdir().unwrap();
    let registry = CollectionRegistry::open(state_dir.path()).unwrap();
    let collection = registry
        .create(state_dir.path().join("collection"), Some("Tasks"), "UTC")
        .unwrap();
    let grant_id = Uuid::new_v4();
    let application_id = Uuid::new_v4();
    let connector_id = Uuid::new_v4();
    let connector = mdbase_connect_protocol::crypto::RelayIdentity::generate();
    let application = mdbase_connect_protocol::crypto::RelayIdentity::generate();
    let operations = vec!["reconcile_timers".to_string()];
    let encryption = mdbase_connect_protocol::GrantEncryption {
        protocol_version: mdbase_connect_protocol::GRANT_ENCRYPTION_PROTOCOL_VERSION,
        suite: mdbase_connect_protocol::RELAY_ENCRYPTION_SUITE.to_string(),
        key_id: "timer-test".to_string(),
        scope_epoch: 1,
        connector_id,
        collection_id: collection.id,
        application_agreement_public_key: application.public_key(),
        connector_agreement_public_key: connector.public_key(),
    };
    let security = crate::test_support::application_security(
        crate::test_support::TestApplicationSecurityParams {
            application_id,
            authorization_id: Uuid::new_v4(),
            collection_id: collection.id,
            operations: &operations,
            distribution: "web",
            grant_agreement_public_key: application.public_key(),
            file_capability: None,
        },
    );
    registry
        .replace_grants(&[GrantPolicy {
            id: grant_id,
            application_id,
            collection_id: collection.id,
            operations,
            scope: GrantScope::full_collection(),
            application_name: "Tasks".to_string(),
            application_distribution: "web".to_string(),
            application_homepage: "https://tasks.example".to_string(),
            application_project_url: None,
            application_origin: "https://tasks.example".to_string(),
            application_icon: None,
            collection_name: "Tasks".to_string(),
            notification_criteria: vec![NotificationCriterion {
                id: "task.reminder".to_string(),
                event: ContractRequirement {
                    id: TIMER_EVENT_ID.to_string(),
                    version: "1.0.0".to_string(),
                    digest: format!("sha256:{}", "0".repeat(64)),
                },
                r#if: None,
                debounce: None,
                minimum_interval: None,
                presentation: NotificationPresentation {
                    title: "Task reminder".to_string(),
                    body: None,
                    tag: None,
                },
            }],
            created_at: "2026-07-25T00:00:00Z".to_string(),
            encryption: Some(encryption),
            file_capability: None,
            application_authorization: security.proof,
        }])
        .unwrap();
    let grant = registry.grant_context(grant_id).unwrap().unwrap();
    let (events, event_rx) = tokio::sync::mpsc::unbounded_channel();
    let (timers, task) = start(state_dir.path(), registry.clone(), None, event_rx);
    let operation_timers = timers.clone();
    let result = tokio::task::spawn_blocking(move || {
        operation_timers.operation(
            collection.id,
            grant,
            "reconcile_timers",
            json!({
                "namespace": "task-reminders",
                "criterion_id": "task.reminder",
                "timers": [{
                    "id": "task-a:reminder-a",
                    "fire_at": "2099-07-26T00:00:00Z"
                }]
            }),
        )
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result["timers"][0]["id"], "task-a:reminder-a");
    registry.replace_grants(&[]).unwrap();
    assert!(registry.grant_context(grant_id).unwrap().is_none());
    let cancelled = tokio::task::spawn_blocking(move || timers.cleanup_orphaned_timers())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(cancelled, 1);
    drop(events);
    task.abort();
    let _ = task.await;
}
