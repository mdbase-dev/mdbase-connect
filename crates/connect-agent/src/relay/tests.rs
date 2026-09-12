use super::*;

#[tokio::test]
async fn queued_control_rejects_replaced_policy() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (policy, applied) = tokio::sync::watch::channel((1, true));
    let (_session, open) = tokio::sync::watch::channel(());
    let slots = Arc::new(tokio::sync::Semaphore::new(1));
    let held = slots.clone().acquire_owned().await.unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let dispatch = dispatch_control(applied, 1, slots.clone(), open, move || {
        counter.fetch_add(1, Ordering::SeqCst);
        Some(())
    });
    tokio::pin!(dispatch);
    assert!(futures_util::poll!(&mut dispatch).is_pending());
    policy.send_replace((2, true));
    drop(held);
    let result = dispatch.await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(result, None);
    assert_eq!(slots.available_permits(), 1);
}

#[tokio::test]
async fn queued_control_rejects_disconnected_session_after_reconnect() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (_policy, applied) = tokio::sync::watch::channel((1, true));
    let (session, open) = tokio::sync::watch::channel(());
    let slots = Arc::new(tokio::sync::Semaphore::new(1));
    let held = slots.clone().acquire_owned().await.unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let dispatch = dispatch_control(applied.clone(), 1, slots.clone(), open, move || {
        counter.fetch_add(1, Ordering::SeqCst);
        Some(())
    });
    tokio::pin!(dispatch);
    assert!(futures_util::poll!(&mut dispatch).is_pending());
    drop(session);
    let (_new_session, new_open) = tokio::sync::watch::channel(());
    drop(held);
    let result = dispatch.await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(result, None);
    assert_eq!(slots.available_permits(), 1);
    let counter = calls.clone();
    assert_eq!(
        dispatch_control(applied, 1, slots.clone(), new_open, move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Some(42)
        })
        .await
        .unwrap(),
        Some(42)
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(slots.available_permits(), 1);
}

#[tokio::test]
async fn control_session_cancellation_settles_without_queue_progress() {
    for waiting_for_policy in [true, false] {
        let (_policy, applied) = tokio::sync::watch::channel((1, !waiting_for_policy));
        let (session, open) = tokio::sync::watch::channel(());
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        let held = slots.clone().acquire_owned().await.unwrap();
        let dispatch = dispatch_control(
            applied,
            if waiting_for_policy { 2 } else { 1 },
            slots.clone(),
            open,
            || -> Option<()> { panic!("cancelled control entered handler") },
        );
        tokio::pin!(dispatch);
        assert!(futures_util::poll!(&mut dispatch).is_pending());
        drop(session);
        assert!(matches!(
            futures_util::poll!(&mut dispatch),
            std::task::Poll::Ready(Ok(None))
        ));
        drop(held);
        assert_eq!(slots.available_permits(), 1);
    }
}

#[test]
fn control_rechecks_at_blocking_pool_entry() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let runtime = tokio::runtime::Builder::new_current_thread()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    runtime.block_on(async {
        for disconnect in [false, true] {
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let blocker = tokio::task::spawn_blocking(move || {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            });
            started_rx.await.unwrap();
            let (policy, applied) = tokio::sync::watch::channel((1, true));
            let (session, open) = tokio::sync::watch::channel(());
            let slots = Arc::new(tokio::sync::Semaphore::new(1));
            let calls = Arc::new(AtomicUsize::new(0));
            let counter = calls.clone();
            let dispatch = dispatch_control(applied, 1, slots.clone(), open, move || {
                counter.fetch_add(1, Ordering::SeqCst);
                Some(())
            });
            tokio::pin!(dispatch);
            assert!(futures_util::poll!(&mut dispatch).is_pending());
            assert_eq!(slots.available_permits(), 0);
            if disconnect {
                drop(session);
            } else {
                policy.send_replace((1, false));
            }
            release_tx.send(()).unwrap();
            let result = dispatch.await.unwrap();
            blocker.await.unwrap();
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            assert_eq!(result, None);
            assert_eq!(slots.available_permits(), 1);
        }
    });
}

#[tokio::test]
async fn control_rejects_closed_semaphore_and_unusable_policy() {
    let (_session, open) = tokio::sync::watch::channel(());
    let (policy, applied) = tokio::sync::watch::channel((1, false));
    let slots = Arc::new(tokio::sync::Semaphore::new(1));
    assert_eq!(
        dispatch_control(
            applied.clone(),
            1,
            slots.clone(),
            open.clone(),
            || -> Option<()> { panic!("unusable policy entered handler") }
        )
        .await
        .unwrap(),
        None
    );
    policy.send_replace((1, true));
    slots.close();
    assert_eq!(
        dispatch_control(applied, 1, slots.clone(), open, || -> Option<()> {
            panic!("closed semaphore entered handler")
        })
        .await
        .unwrap(),
        None
    );
    assert_eq!(slots.available_permits(), 1);
}

#[test]
fn maps_http_server_to_websocket_relay() {
    assert_eq!(
        websocket_url("https://connect.example/base")
            .unwrap()
            .as_str(),
        "wss://connect.example/v1/relay"
    );
}

#[tokio::test]
async fn policy_barrier_orders_generations_and_fails_closed() {
    let (sender, receiver) = tokio::sync::watch::channel((0_u64, false));
    assert!(!wait_for_policy(receiver.clone(), 0).await.unwrap());
    let waiting = tokio::spawn(wait_for_policy(receiver.clone(), 2));
    sender.send_replace((1, true));
    tokio::task::yield_now().await;
    assert!(!waiting.is_finished());
    sender.send_replace((2, true));
    assert!(waiting.await.unwrap().unwrap());

    let failed = tokio::spawn(wait_for_policy(receiver, 3));
    sender.send_replace((3, false));
    assert!(!failed.await.unwrap().unwrap());
}

#[tokio::test]
async fn dropping_policy_worker_guard_prevents_connected_after_blocking_apply() {
    let connected = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let worker_connected = connected.clone();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
    let guard = AbortOnDrop(tokio::spawn(async move {
        tokio::task::spawn_blocking(move || {
            let _ = started_tx.send(());
            release_rx.recv().unwrap();
            let _ = finished_tx.send(());
        })
        .await
        .unwrap();
        worker_connected.store(true, std::sync::atomic::Ordering::Release);
    }));

    started_rx.await.unwrap();
    drop(guard);
    release_tx.send(()).unwrap();
    finished_rx.await.unwrap();
    tokio::task::yield_now().await;
    assert!(!connected.load(std::sync::atomic::Ordering::Acquire));
}

#[test]
fn overload_rejections_preserve_request_identity() {
    let request_id = uuid::Uuid::new_v4();
    let request = RelayMessage::OperationRequest {
        protocol_version: mdbase_connect_protocol::OPERATION_TRANSPORT_PROTOCOL_VERSION,
        request_id,
        grant_id: uuid::Uuid::new_v4(),
        collection_id: uuid::Uuid::new_v4(),
        application_id: uuid::Uuid::new_v4(),
        operation: "read".to_string(),
        input: serde_json::json!({}),
    };
    assert!(matches!(
        relay_operation_rejection(&request, "connector_busy", "busy"),
        Some(RelayMessage::OperationResponse {
            request_id: returned,
            problem: Some(problem),
            ..
        }) if returned == request_id && problem.code == "connector_busy"
    ));
}

#[test]
fn execution_deadlines_report_durable_mutations_as_unknown() {
    let request_id = uuid::Uuid::new_v4();
    let encrypted = RelayMessage::EncryptedOperationRequest {
        envelope: mdbase_connect_protocol::EncryptedRelayEnvelope {
            protocol_version: mdbase_connect_protocol::OPERATION_TRANSPORT_PROTOCOL_VERSION,
            suite: "P256-HKDF-SHA256-AES256GCM".to_string(),
            request_id,
            grant_id: uuid::Uuid::new_v4(),
            application_id: uuid::Uuid::new_v4(),
            connector_id: uuid::Uuid::new_v4(),
            collection_id: uuid::Uuid::new_v4(),
            operation: "create".to_string(),
            scope_epoch: 1,
            key_id: "deadline-test".to_string(),
            counter: "1".to_string(),
            deadline_unix_ms: Some(1),
            ciphertext: "ciphertext".to_string(),
        },
    };
    let timeout = RelayTimeoutRequest::from_message(&encrypted).unwrap();
    assert!(matches!(
        relay_operation_timeout(&timeout, true),
        Some(RelayMessage::EncryptedOperationRejected {
            request_id: returned,
            problem,
            ..
        }) if returned == request_id
            && problem.code == "operation_outcome_unknown"
            && problem.operation_outcome == Some(ConnectOperationOutcome::Unknown)
            && problem.details == Some(serde_json::json!({ "request_id": request_id }))
    ));
}

#[test]
fn conservative_admission_does_not_make_encrypted_reads_outcome_unknown() {
    for operation in ["sync", "file_control"] {
        let request_id = uuid::Uuid::new_v4();
        let encrypted = RelayMessage::EncryptedOperationRequest {
            envelope: mdbase_connect_protocol::EncryptedRelayEnvelope {
                protocol_version: mdbase_connect_protocol::OPERATION_TRANSPORT_PROTOCOL_VERSION,
                suite: "P256-HKDF-SHA256-AES256GCM".to_string(),
                request_id,
                grant_id: uuid::Uuid::new_v4(),
                application_id: uuid::Uuid::new_v4(),
                connector_id: uuid::Uuid::new_v4(),
                collection_id: uuid::Uuid::new_v4(),
                operation: operation.to_string(),
                scope_epoch: 1,
                key_id: "deadline-test".to_string(),
                counter: "1".to_string(),
                deadline_unix_ms: Some(1),
                ciphertext: "ciphertext".to_string(),
            },
        };
        let timeout = RelayTimeoutRequest::from_message(&encrypted).unwrap();
        assert!(matches!(
            relay_operation_timeout(&timeout, false),
            Some(RelayMessage::EncryptedOperationRejected {
                request_id: returned,
                problem,
                ..
            }) if returned == request_id
                && problem.code == "operation_cancelled"
                && problem.operation_outcome == Some(ConnectOperationOutcome::NotSent)
        ));
    }
}

#[test]
fn execution_deadlines_cancel_reads_as_not_sent() {
    let request_id = uuid::Uuid::new_v4();
    let request = RelayMessage::OperationRequest {
        protocol_version: mdbase_connect_protocol::OPERATION_TRANSPORT_PROTOCOL_VERSION,
        request_id,
        grant_id: uuid::Uuid::new_v4(),
        collection_id: uuid::Uuid::new_v4(),
        application_id: uuid::Uuid::new_v4(),
        operation: "query".to_string(),
        input: serde_json::json!({}),
    };
    let timeout = RelayTimeoutRequest::from_message(&request).unwrap();
    assert!(matches!(
        relay_operation_timeout(&timeout, false),
        Some(RelayMessage::OperationResponse {
            request_id: returned,
            problem: Some(problem),
            ..
        }) if returned == request_id
            && problem.code == "operation_cancelled"
            && problem.operation_outcome == Some(ConnectOperationOutcome::NotSent)
    ));
}
