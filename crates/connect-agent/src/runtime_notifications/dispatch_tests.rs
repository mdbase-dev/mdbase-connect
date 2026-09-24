#[tokio::test]
async fn synchronous_control_does_not_depend_on_the_callers_tokio_executor() {
    let (state_dir, registry, grant) = timer_handle_fixture();
    let collection_id = grant.collection_id;
    let (_events, receiver) = tokio::sync::mpsc::channel(1);
    let (handle, worker) = start(state_dir.path(), registry, None, receiver);
    let (result, receive) = std::sync::mpsc::sync_channel(1);
    let caller = std::thread::spawn(move || {
        result
            .send(handle.operation(
                collection_id,
                grant,
                "reconcile_timers",
                json!({
                    "namespace":"control", "criterion_id":"task.reminder", "timers":[]
                }),
            ))
            .unwrap();
    });
    // Deliberately block this single-thread executor. Admission/control has its
    // own worker; no executor thread must be available to release this barrier.
    receive
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    caller.join().unwrap();
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn notification_worker_panic_is_visible_to_critical_worker_monitoring() {
    let task = worker::spawn(async { panic!("injected notification worker panic") });
    assert!(task.await.unwrap_err().is_panic());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_timer_commands_complete_while_notification_http_is_blocked() {
    let (state_dir, registry, grant) = timer_handle_fixture();
    let collection_id = grant.collection_id;
    let runtime_dir = state_dir.path().join("runtime");
    std::fs::create_dir_all(&runtime_dir).unwrap();
    let mut service = RuntimeNotificationService {
        runtime_dir,
        local_registry: registry.clone(),
        cloud: None,
        runtimes: HashMap::new(),
        dispatch: DispatchQueue::default(),
    };
    let catalog = compose_catalog(std::slice::from_ref(&grant), collection_id).unwrap();
    perform_timer_operation(service.runtime(collection_id).unwrap(), &catalog, &grant, "reconcile_timers", json!({
        "namespace":"due", "criterion_id":"task.reminder", "timers":[{
            "id":"blocked-signal", "fire_at":(chrono::Utc::now()-chrono::TimeDelta::seconds(1)).to_rfc3339()
        }]
    })).await.unwrap();
    drop(service);

    let gate = Arc::new((tokio::sync::Notify::new(), tokio::sync::Semaphore::new(0)));
    async fn blocked(
        State(gate): State<Arc<(tokio::sync::Notify, tokio::sync::Semaphore)>>,
        Json(_body): Json<Value>,
    ) -> Json<Value> {
        gate.0.notify_one();
        gate.1.acquire().await.unwrap().forget();
        Json(json!({"accepted":true,"duplicate":false}))
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/v1/connectors/notification-signals", post(blocked))
        .with_state(gate.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let (events, receiver) = tokio::sync::mpsc::channel(256);
    let (handle, worker) = start(
        state_dir.path(),
        registry,
        Some(CloudControlClient::new(
            format!("http://{address}"),
            "synthetic".into(),
        )),
        receiver,
    );
    tokio::time::timeout(Duration::from_secs(5), gate.0.notified())
        .await
        .unwrap();
    let operation = tokio::task::spawn_blocking(move || {
        handle.operation(
            collection_id,
            grant,
            "reconcile_timers",
            json!({
                "namespace":"control", "criterion_id":"task.reminder", "timers":[]
            }),
        )
    });
    // This is a causal assertion, not a sub-millisecond timing gate: the HTTP
    // response cannot complete at all until after the local command finishes.
    let completed = tokio::time::timeout(Duration::from_secs(2), operation).await;
    gate.1.add_permits(1);
    completed
        .expect("local control waited behind remote notification dispatch")
        .unwrap()
        .unwrap();
    worker.abort();
    let _ = worker.await;
    drop(events);
    server.abort();
}
