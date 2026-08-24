#![allow(clippy::too_many_lines)]

//! Phase 6 acceptance, part 2: two provider instances against one PostgreSQL
//! database delivering ordered durable room updates over local sockets.
//!
//! Sequential scenarios: cross-instance convergence, duplicate/reversed/
//! high-water notices, missed terminal notification recovery through listener
//! reconciliation and the bounded sweep, compaction-gap snapshot fallback,
//! malformed and content-bearing notices without allocation or leakage,
//! conventional epoch retirement, and clean runtime shutdown.

use super::batches::{CollaborationBatchContribution, CollaborationBatchInput};
use super::phase3_batch_tests::NoopBlobStore;
use super::*;
use crate::{app, AppState, RoomIdentity, COLLABORATION_PROFILE};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::{FutureExt, SinkExt, StreamExt};
use mdbase_connect_collaboration::MarkdownBodyDocument;
use mdbase_connect_protocol::{
    CollaborationAccess, CollaborationFrame, CollaborationMessageKind,
    ReplicaCollaborationCapability, SyncMutation, SyncMutationOperation, SyncReplicaMode,
    AUTHORITY_PROOF_VERSION,
};
use p256::ecdsa::{signature::Signer, Signature};
use reqwest::header::{HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE, ORIGIN};
use sqlx::AssertSqlSafe;
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_tungstenite::{
    connect_async, tungstenite::client::IntoClientRequest, tungstenite::Message,
};
use uuid::Uuid;

const SWEEP: Duration = Duration::from_millis(150);

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a disposable MDBASE_COLLABORATION_PHASE3_DATABASE_URL PostgreSQL database"]
async fn phase6_multi_instance_catchup_postgres() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let base = std::env::var("MDBASE_COLLABORATION_PHASE3_DATABASE_URL").expect("database URL");
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("phase6_mi_{}", Uuid::new_v4().simple());
    sqlx::query(AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
        .execute(&admin)
        .await
        .unwrap();
    let result = std::panic::AssertUnwindSafe(run(&base, &schema))
        .catch_unwind()
        .await;
    sqlx::query(AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE")))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

struct Instance {
    provider: HostedProvider,
    state: AppState,
    address: SocketAddr,
    stop_server: tokio::sync::oneshot::Sender<()>,
    server: JoinHandle<()>,
}

async fn start_instance(base: &str, schema: &str, compaction_threshold: u64) -> Instance {
    let separator = if base.contains('?') { '&' } else { '?' };
    let url = format!("{base}{separator}options=-c%20search_path%3D{schema}%2Cpublic");
    let crypto = ProviderCrypto::from_base64(&URL_SAFE_NO_PAD.encode([7_u8; 32])).unwrap();
    let limits = ProviderLimits {
        hosted_collaboration_enabled: true,
        collaboration: CollaborationLimits {
            compaction_threshold,
            ..CollaborationLimits::default()
        },
        ..ProviderLimits::default()
    };
    let provider = HostedProvider::connect(&url, crypto, limits, Arc::new(NoopBlobStore), None)
        .await
        .unwrap();
    let state = AppState::new(
        provider.clone(),
        "phase6-internal-token-0123456789012345678",
    )
    .unwrap();
    // Fail-closed startup with a fast bounded sweep for acceptance timing.
    state
        .start_collaboration_wake_runtime_with_sweep(SWEEP)
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop_server, stop_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn({
        let state = state.clone();
        async move {
            axum::serve(listener, app(state))
                .with_graceful_shutdown(async {
                    let _ = stop_rx.await;
                })
                .await
                .unwrap();
        }
    });
    Instance {
        provider,
        state,
        address,
        stop_server,
        server,
    }
}

async fn run(base: &str, schema: &str) {
    let instance_a = start_instance(base, schema, 2).await;
    let instance_b = start_instance(base, schema, 100).await;
    let http_a = reqwest::Client::new();
    let http_b = reqwest::Client::new();

    let account = Uuid::new_v4();
    let collection = Uuid::new_v4();
    let record = Uuid::new_v4();
    let replica_a = Uuid::new_v4();
    let replica_b = Uuid::new_v4();
    let origin = "https://phase6.invalid";
    instance_a
        .provider
        .upsert_account(
            account,
            1,
            ProviderAccountLimits {
                hosted_storage_bytes: 1 << 20,
                retained_file_bytes: 1 << 20,
                max_document_bytes: 1 << 20,
                max_single_file_bytes: 1 << 20,
                max_mirror_replicas_per_collection: 4,
                max_application_replicas_per_collection: 4,
                max_hosted_collections: 2,
                max_files_per_collection: 2,
            },
        )
        .await
        .unwrap();
    instance_a
        .provider
        .create_collection(account, collection, "mdbase", "Phase 6 multi", "UTC")
        .await
        .unwrap();

    // Two independent replicas, one primary per instance.
    let signing_a = p256::ecdsa::SigningKey::random(&mut rand_core::OsRng);
    let signing_b = p256::ecdsa::SigningKey::random(&mut rand_core::OsRng);
    let token_a = format!("phase6-a-{}", Uuid::new_v4());
    let token_b = format!("phase6-b-{}", Uuid::new_v4());
    register_collab_replica(
        &instance_a.provider,
        collection,
        replica_a,
        "phase6.a",
        &token_a,
        &signing_a,
        origin,
    )
    .await;
    register_collab_replica(
        &instance_a.provider,
        collection,
        replica_b,
        "phase6.b",
        &token_b,
        &signing_b,
        origin,
    )
    .await;

    instance_a
        .provider
        .mutate(
            collection,
            &token_a,
            SyncMutation {
                mutation_id: Uuid::new_v4(),
                replica_id: replica_a,
                scope_epoch: 1,
                operation: SyncMutationOperation::Put,
                record_id: record,
                base_revision: None,
                path: Some("notes/mi.md".into()),
                document: Some("---\ntitle: mi\n---\n\nBase body\n".into()),
                created_at: chrono::Utc::now().to_rfc3339(),
                causal_predecessor: None,
            },
            Some(origin),
        )
        .await
        .unwrap();

    let wrapped: Vec<u8> =
        sqlx::query_scalar("SELECT wrapped_data_key FROM hosted_provider_collections WHERE id=$1")
            .bind(collection)
            .fetch_one(&instance_a.provider.pool)
            .await
            .unwrap();
    let data_key = *instance_a
        .provider
        .collection_key(collection, &wrapped)
        .await
        .unwrap();
    let room = RoomIdentity::new(collection, record, 1, COLLABORATION_PROFILE).unwrap();
    let ws_url = format!("ws://{}/v1/collaboration", instance_b.address);
    let ticket_path = format!("/v1/authorities/{collection}/collaboration/tickets");

    // --- Scenario 2: client A commits via instance A, client B on instance B
    // converges through the durable catch-up path after row visibility.
    let mut a = ws(
        &format!("ws://{}/v1/collaboration", instance_a.address),
        origin,
    )
    .await;
    let mut b = ws(&ws_url, origin).await;
    let ticket_a = ticket_http(
        &http_a,
        instance_a.address,
        &ticket_path,
        br#"{"path":"notes/mi.md","profile":"markdown-body-yjs-v13","mode":"read_write"}"#,
        origin,
        &token_a,
        &signing_a,
    )
    .await;
    let ticket_b = ticket_http(
        &http_b,
        instance_b.address,
        &ticket_path,
        br#"{"path":"notes/mi.md","profile":"markdown-body-yjs-v13","mode":"read_write"}"#,
        origin,
        &token_b,
        &signing_b,
    )
    .await;
    authenticate(&mut a, &ticket_a).await;
    authenticate(&mut b, &ticket_b).await;
    assert_eq!(
        recv_frame(&mut a).await.kind,
        CollaborationMessageKind::Hello
    );
    assert_eq!(
        recv_frame(&mut b).await.kind,
        CollaborationMessageKind::Hello
    );

    let mut client_b = MarkdownBodyDocument::new("", 2 * 1024 * 1024).unwrap();
    let sync_frame = CollaborationFrame {
        kind: CollaborationMessageKind::SyncStep1,
        metadata: Default::default(),
        payload: client_b.state_vector_v1(),
    }
    .encode()
    .unwrap();
    a.send(Message::Binary(sync_frame.clone().into()))
        .await
        .unwrap();
    assert_eq!(
        recv_frame(&mut a).await.kind,
        CollaborationMessageKind::SyncStep2
    );
    b.send(Message::Binary(sync_frame.into())).await.unwrap();
    let baseline = recv_frame(&mut b).await;
    assert_eq!(baseline.kind, CollaborationMessageKind::SyncStep2);
    client_b
        .apply_update_v1(&baseline.payload, 2 * 1024 * 1024, 2 * 1024 * 1024)
        .unwrap();
    assert_eq!(client_b.body(), "\nBase body\n");

    let update_one = build_next_update(
        &instance_a.provider,
        &data_key,
        room,
        "\nBase body\nline one\n",
    )
    .await;
    let mutation_one = Uuid::new_v4();
    let update_frame = CollaborationFrame {
        kind: CollaborationMessageKind::Update,
        metadata: serde_json::json!({"client_mutation_id": mutation_one, "profile": COLLABORATION_PROFILE, "epoch": 1}).as_object().unwrap().clone(),
        payload: update_one.clone(),
    }
    .encode()
    .unwrap();
    a.send(Message::Binary(update_frame.clone().into()))
        .await
        .unwrap();
    let ack = recv_frame(&mut a).await;
    assert_eq!(ack.kind, CollaborationMessageKind::Acknowledged);
    // Delivery must observe the committed rows: poll visibility on instance
    // B's own pool, then require the frame.
    wait_for_receipts(&instance_b.provider.pool, collection, record, 1).await;
    let pushed = recv_frame(&mut b).await;
    assert_eq!(pushed.kind, CollaborationMessageKind::Update);
    client_b
        .apply_update_v1(&pushed.payload, 2 * 1024 * 1024, 2 * 1024 * 1024)
        .unwrap();
    assert_eq!(client_b.body(), "\nBase body\nline one\n");

    // Replays stay silent end to end: no second push reaches B.
    a.send(Message::Binary(update_frame.into())).await.unwrap();
    assert_eq!(
        recv_frame(&mut a).await.kind,
        CollaborationMessageKind::Acknowledged
    );
    assert!(timeout_short(recv_frame_inner(&mut b)).await.is_none());

    // --- Scenario 3: duplicate, reversed, and high-water notices deliver each
    // sequence exactly once, in order.
    instance_b
        .state
        .stop_collaboration_wake_runtime(Duration::from_secs(5))
        .await;
    let update_two = build_next_update(
        &instance_a.provider,
        &data_key,
        room,
        "\nBase body\nline one\nline two\n",
    )
    .await;
    commit_batch(
        &instance_a.provider,
        &token_a,
        collection,
        record,
        replica_a,
        Uuid::new_v4(),
        update_two,
    )
    .await;
    let update_three = build_next_update(
        &instance_a.provider,
        &data_key,
        room,
        "\nBase body\nline one\nline two\nline three\n",
    )
    .await;
    commit_batch(
        &instance_a.provider,
        &token_a,
        collection,
        record,
        replica_a,
        Uuid::new_v4(),
        update_three,
    )
    .await;
    wait_for_current_sequence(&instance_b.provider.pool, collection, record, 3).await;
    // High-water first, then stale and duplicated marks: coalescing plus the
    // durable cursor must yield exactly sequences 2 then 3.
    instance_b.state.collaboration_wakes().wake(&room, 3).await;
    instance_b.state.collaboration_wakes().wake(&room, 2).await;
    instance_b.state.collaboration_wakes().wake(&room, 3).await;
    let two = recv_frame(&mut b).await;
    let three = recv_frame(&mut b).await;
    assert_eq!(two.kind, CollaborationMessageKind::Update);
    assert_eq!(three.kind, CollaborationMessageKind::Update);
    client_b
        .apply_update_v1(&two.payload, 2 * 1024 * 1024, 2 * 1024 * 1024)
        .unwrap();
    client_b
        .apply_update_v1(&three.payload, 2 * 1024 * 1024, 2 * 1024 * 1024)
        .unwrap();
    assert_eq!(
        client_b.body(),
        "\nBase body\nline one\nline two\nline three\n"
    );
    assert!(
        timeout_short(recv_frame_inner(&mut b)).await.is_none(),
        "duplicate notice redelivered"
    );

    // --- Scenario 4: a missed terminal notification is recovered by listener
    // reconciliation, and the periodic sweep never duplicates delivery.
    let update_four = build_next_update(
        &instance_a.provider,
        &data_key,
        room,
        "\nBase body\nline one\nline two\nline three\nline four\n",
    )
    .await;
    commit_batch(
        &instance_a.provider,
        &token_a,
        collection,
        record,
        replica_a,
        Uuid::new_v4(),
        update_four,
    )
    .await;
    wait_for_current_sequence(&instance_b.provider.pool, collection, record, 4).await;
    tokio::time::sleep(SWEEP * 3).await;
    assert!(
        timeout_short(recv_frame_inner(&mut b)).await.is_none(),
        "delivery progressed without a listener"
    );
    // Restarting the listener reconciles every active room, including the one
    // whose terminal notice was lost.
    instance_b
        .state
        .start_collaboration_wake_runtime_with_sweep(SWEEP)
        .await
        .unwrap();
    let four = recv_frame(&mut b).await;
    assert_eq!(four.kind, CollaborationMessageKind::Update);
    client_b
        .apply_update_v1(&four.payload, 2 * 1024 * 1024, 2 * 1024 * 1024)
        .unwrap();
    assert_eq!(
        client_b.body(),
        "\nBase body\nline one\nline two\nline three\nline four\n"
    );
    // Several sweeps with no new commits produce no duplicate frames.
    tokio::time::sleep(SWEEP * 5).await;
    assert!(timeout_short(recv_frame_inner(&mut b)).await.is_none());

    // --- Scenario 5: a cursor behind compaction falls back to the snapshot.
    let (snapshot_sequence, current_sequence): (i64, i64) = sqlx::query_as(
        "SELECT snapshot_sequence, current_sequence FROM hosted_provider_collaboration_documents
         WHERE collection_id=$1 AND record_id=$2 AND collaboration_epoch=1 AND profile=$3",
    )
    .bind(collection)
    .bind(record)
    .bind(COLLABORATION_PROFILE)
    .fetch_one(&instance_b.provider.pool)
    .await
    .unwrap();
    // Compaction must have deleted the covered update rows while advancing
    // the snapshot; the snapshot itself remains the full Yjs state.
    let retained_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_collaboration_updates
         WHERE collection_id=$1 AND record_id=$2 AND collaboration_epoch=1 AND profile=$3",
    )
    .bind(collection)
    .bind(record)
    .bind(COLLABORATION_PROFILE)
    .fetch_one(&instance_b.provider.pool)
    .await
    .unwrap();
    assert!(
        snapshot_sequence > 0 && snapshot_sequence <= current_sequence && retained_rows < current_sequence,
        "expected compacted history, got snapshot={snapshot_sequence} current={current_sequence} rows={retained_rows}"
    );
    let mut late = ws(&ws_url, origin).await;
    let late_ticket = ticket_http(
        &http_b,
        instance_b.address,
        &ticket_path,
        br#"{"path":"notes/mi.md","profile":"markdown-body-yjs-v13","mode":"read_write"}"#,
        origin,
        &token_b,
        &signing_b,
    )
    .await;
    authenticate(&mut late, &late_ticket).await;
    assert_eq!(
        recv_frame(&mut late).await.kind,
        CollaborationMessageKind::Hello
    );
    // Prove the durable delivery primitive rebuilds a zero cursor from the
    // compacted full-state snapshot. The socket still follows the protocol and
    // completes SyncStep1 before it may receive later wake deliveries.
    let fallback = instance_b
        .provider
        .collaboration_catch_up(room, 0, WAKE_RECONCILE)
        .await
        .unwrap();
    assert!(!fallback.is_empty());
    assert_eq!(
        fallback[0].sequence,
        u64::try_from(snapshot_sequence).unwrap()
    );
    let fallback_frames = fallback.len();
    let mut fallback_client = MarkdownBodyDocument::new("", 2 * 1024 * 1024).unwrap();
    for item in fallback {
        fallback_client
            .apply_update_v1(&item.plaintext, 2 * 1024 * 1024, 2 * 1024 * 1024)
            .unwrap();
    }
    assert_eq!(
        fallback_client.body(),
        "\nBase body\nline one\nline two\nline three\nline four\n"
    );

    let mut late_client = MarkdownBodyDocument::new("", 2 * 1024 * 1024).unwrap();
    late.send(Message::Binary(
        CollaborationFrame {
            kind: CollaborationMessageKind::SyncStep1,
            metadata: Default::default(),
            payload: late_client.state_vector_v1(),
        }
        .encode()
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();
    let late_sync = recv_frame(&mut late).await;
    assert_eq!(late_sync.kind, CollaborationMessageKind::SyncStep2);
    late_client
        .apply_update_v1(&late_sync.payload, 2 * 1024 * 1024, 2 * 1024 * 1024)
        .unwrap();

    let update_five = build_next_update(
        &instance_a.provider,
        &data_key,
        room,
        "\nBase body\nline one\nline two\nline three\nline four\ncompacted line\n",
    )
    .await;
    commit_batch(
        &instance_a.provider,
        &token_a,
        collection,
        record,
        replica_a,
        Uuid::new_v4(),
        update_five,
    )
    .await;
    let frame = recv_frame(&mut late).await;
    assert_eq!(frame.kind, CollaborationMessageKind::Update);
    late_client
        .apply_update_v1(&frame.payload, 2 * 1024 * 1024, 2 * 1024 * 1024)
        .unwrap();
    assert_eq!(
        late_client.body(),
        "\nBase body\nline one\nline two\nline three\nline four\ncompacted line\n"
    );
    assert!(fallback_frames >= 1, "expected a compacted snapshot item");
    let _ = late.close(None).await;
    // The long-lived socket also converges through its own durable path;
    // consume that delivery before the negative assertions below.
    let five_on_b = recv_frame(&mut b).await;
    assert_eq!(five_on_b.kind, CollaborationMessageKind::Update);
    client_b
        .apply_update_v1(&five_on_b.payload, 2 * 1024 * 1024, 2 * 1024 * 1024)
        .unwrap();
    assert_eq!(
        client_b.body(),
        "\nBase body\nline one\nline two\nline three\nline four\ncompacted line\n"
    );
    tokio::time::sleep(SWEEP * 3).await;
    assert!(timeout_short(recv_frame_inner(&mut b)).await.is_none());

    // --- Scenario 7: malformed, content-bearing, unknown-profile, and
    // unknown-room notices cannot allocate or leak; the healthy room continues.
    let rooms_before = instance_b.state.collaboration_wakes().active_rooms().await;
    let channel = super::wakes::COLLABORATION_COMMIT_CHANNEL;
    let garbage: Vec<String> = vec![
        "not-json-at-all".into(),
        format!(
            "{{\"collection_id\":\"{collection}\",\"record_id\":\"{record}\",\"collaboration_epoch\":1,\"profile\":\"{COLLABORATION_PROFILE}\",\"sequence\":999,\"digest\":\"sha256:x\",\"payload\":\"body bytes\",\"path\":\"notes/mi.md\"}}"
        ),
        format!(
            "{{\"collection_id\":\"{collection}\",\"record_id\":\"{record}\",\"collaboration_epoch\":1,\"profile\":\"unknown-profile\",\"sequence\":9}}"
        ),
        format!(
            "{{\"collection_id\":\"{collection}\",\"record_id\":\"{record}\",\"collaboration_epoch\":1,\"profile\":\"{COLLABORATION_PROFILE}\",\"sequence\":0}}"
        ),
        // Valid allowlist but a room with no local subscribers.
        format!(
            "{{\"collection_id\":\"{}\",\"record_id\":\"{}\",\"collaboration_epoch\":1,\"profile\":\"{COLLABORATION_PROFILE}\",\"sequence\":5}}",
            collection,
            Uuid::new_v4()
        ),
    ];
    for payload in &garbage {
        sqlx::query("SELECT pg_notify($1, $2)")
            .bind(channel)
            .bind(payload)
            .execute(&instance_b.provider.pool)
            .await
            .unwrap();
    }
    tokio::time::sleep(SWEEP * 4).await;
    assert!(
        timeout_short(recv_frame_inner(&mut b)).await.is_none(),
        "garbage notice reached a socket"
    );
    assert_eq!(
        instance_b.state.collaboration_wakes().active_rooms().await,
        rooms_before,
        "garbage notices changed hub allocation"
    );
    let update_six = build_next_update(
        &instance_a.provider,
        &data_key,
        room,
        "\nBase body\nline one\nline two\nline three\nline four\ncompacted line\nsurvivor line\n",
    )
    .await;
    commit_batch(
        &instance_a.provider,
        &token_a,
        collection,
        record,
        replica_a,
        Uuid::new_v4(),
        update_six,
    )
    .await;
    let six = recv_frame(&mut b).await;
    assert_eq!(six.kind, CollaborationMessageKind::Update);
    client_b
        .apply_update_v1(&six.payload, 2 * 1024 * 1024, 2 * 1024 * 1024)
        .unwrap();
    assert_eq!(
        client_b.body(),
        "\nBase body\nline one\nline two\nline three\nline four\ncompacted line\nsurvivor line\n"
    );

    // --- Scenario 6: conventional epoch retirement prevents stale delivery.
    let revision: String = sqlx::query_scalar(
        "SELECT revision FROM hosted_provider_records WHERE collection_id=$1 AND record_id=$2",
    )
    .bind(collection)
    .bind(record)
    .fetch_one(&instance_b.provider.pool)
    .await
    .unwrap();
    instance_a
        .provider
        .mutate(
            collection,
            &token_a,
            SyncMutation {
                mutation_id: Uuid::new_v4(),
                replica_id: replica_a,
                scope_epoch: 1,
                operation: SyncMutationOperation::Put,
                record_id: record,
                base_revision: Some(revision),
                path: Some("notes/mi.md".into()),
                document: Some("---\ntitle: mi\n---\n\nBase body\nordinary writer wins\n".into()),
                created_at: chrono::Utc::now().to_rfc3339(),
                causal_predecessor: None,
            },
            Some(origin),
        )
        .await
        .unwrap();
    let stale_error = instance_b
        .provider
        .collaboration_catch_up(room, 0, u64::MAX)
        .await
        .unwrap_err();
    assert_eq!(stale_error.code, "collaboration_epoch_stale");
    // Waking the retired room ends the live session without any delivery.
    instance_b.state.collaboration_wakes().wake(&room, 99).await;
    assert_closed_without_binary(&mut b).await;

    // Readmission happens at the advanced epoch only.
    let readmission = ticket_json(
        &http_b,
        instance_b.address,
        &ticket_path,
        br#"{"path":"notes/mi.md","profile":"markdown-body-yjs-v13","mode":"read_write"}"#,
        origin,
        &token_b,
        &signing_b,
    )
    .await;
    assert_eq!(readmission["epoch"], 2);
    let _ = a.close(None).await;
    let _ = b.close(None).await;

    // --- Scenario 8: runtime stop joins the listener and sweep cleanly.
    assert!(
        instance_b
            .state
            .stop_collaboration_wake_runtime(Duration::from_secs(5))
            .await
    );
    assert!(
        instance_b
            .state
            .stop_collaboration_wake_runtime(Duration::from_secs(5))
            .await
    );
    assert!(
        instance_a
            .state
            .stop_collaboration_wake_runtime(Duration::from_secs(5))
            .await
    );

    let _ = instance_a.stop_server.send(());
    let _ = instance_b.stop_server.send(());
    timeout(Duration::from_secs(5), instance_a.server)
        .await
        .unwrap()
        .unwrap();
    timeout(Duration::from_secs(5), instance_b.server)
        .await
        .unwrap()
        .unwrap();
    instance_a.provider.pool.close().await;
    instance_b.provider.pool.close().await;
}

async fn register_collab_replica(
    provider: &HostedProvider,
    collection: Uuid,
    replica_id: Uuid,
    name: &str,
    token: &str,
    signing: &p256::ecdsa::SigningKey,
    origin: &str,
) {
    provider
        .register_replica(
            collection,
            RegisterReplica {
                replica_id,
                name: name.into(),
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadWrite,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: vec!["create".into(), "read".into(), "update".into()],
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: vec![2],
                file_capability: None,
                collaboration_capability: Some(ReplicaCollaborationCapability {
                    contract_version: 1,
                    profiles: vec![COLLABORATION_PROFILE.into()],
                    access: CollaborationAccess::ReadWrite,
                }),
                allowed_origin: Some(origin.into()),
                proof_public_key: Some(
                    URL_SAFE_NO_PAD
                        .encode(signing.verifying_key().to_encoded_point(false).as_bytes()),
                ),
                grant_id: Some(Uuid::new_v4()),
                application_declaration_id: Some(name.into()),
                application_declaration_digest: Some(format!("sha256:{}", "a".repeat(64))),
                token: token.to_owned(),
                token_ttl_seconds: Some(3600),
            },
        )
        .await
        .unwrap();
}

async fn build_next_update(
    provider: &HostedProvider,
    data_key: &[u8; 32],
    room: RoomIdentity,
    new_body: &str,
) -> Vec<u8> {
    let mut transaction = provider.pool.begin().await.unwrap();
    let opened = provider
        .load_collaboration_room_in(&mut transaction, data_key, room)
        .await
        .unwrap();
    transaction.commit().await.unwrap();
    MarkdownBodyDocument::from_snapshot(
        &opened.document.snapshot_v1(),
        4 * 1024 * 1024,
        2 * 1024 * 1024,
    )
    .unwrap()
    .apply_provider_body(new_body, 2 * 1024 * 1024)
    .unwrap()
}

#[allow(clippy::too_many_arguments)]
async fn commit_batch(
    provider: &HostedProvider,
    token: &str,
    collection: Uuid,
    record: Uuid,
    replica: Uuid,
    mutation: Uuid,
    update: Vec<u8>,
) {
    let mut transaction = provider.pool.begin().await.unwrap();
    let (_, accepted) = provider
        .commit_collaboration_batch_result_in(
            &mut transaction,
            CollaborationBatchInput {
                collection_id: collection,
                record_id: record,
                epoch: 1,
                contributions: vec![CollaborationBatchContribution {
                    replica_id: replica,
                    expected_scope_epoch: 1,
                    expected_token_hash: token_hash(token).try_into().unwrap(),
                    client_mutation_id: mutation,
                    update,
                }],
            },
        )
        .await
        .unwrap();
    transaction.commit().await.unwrap();
    assert!(accepted, "scenario batches must be freshly accepted");
}

async fn wait_for_receipts(pool: &sqlx::PgPool, collection: Uuid, record: Uuid, expected: i64) {
    for _ in 0..100 {
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM hosted_provider_collaboration_receipts
             WHERE collection_id=$1 AND record_id=$2",
        )
        .bind(collection)
        .bind(record)
        .fetch_one(pool)
        .await
        .unwrap();
        if count >= expected {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("durable rows never became visible to the second instance");
}

async fn wait_for_current_sequence(
    pool: &sqlx::PgPool,
    collection: Uuid,
    record: Uuid,
    expected: i64,
) {
    for _ in 0..100 {
        let sequence: Option<i64> = sqlx::query_scalar(
            "SELECT current_sequence FROM hosted_provider_collaboration_documents
             WHERE collection_id=$1 AND record_id=$2 AND profile=$3",
        )
        .bind(collection)
        .bind(record)
        .bind(COLLABORATION_PROFILE)
        .fetch_optional(pool)
        .await
        .unwrap();
        if sequence >= Some(expected) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("committed collaboration sequence never became visible");
}

async fn recv_frame_inner(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> CollaborationFrame {
    let message = socket.next().await.unwrap().unwrap();
    CollaborationFrame::decode(message.into_data().as_ref()).unwrap()
}

async fn timeout_short<T>(future: impl std::future::Future<Output = T>) -> Option<T> {
    tokio::time::timeout(Duration::from_millis(400), future)
        .await
        .ok()
}

async fn ws(
    url: &str,
    origin: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let mut request = url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert(ORIGIN, HeaderValue::from_str(origin).unwrap());
    let (socket, _) = connect_async(request).await.unwrap();
    socket
}

async fn authenticate(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    ticket: &str,
) {
    socket
        .send(Message::Binary(
            CollaborationFrame {
                kind: CollaborationMessageKind::Authenticate,
                metadata: serde_json::json!({"ticket": ticket})
                    .as_object()
                    .unwrap()
                    .clone(),
                payload: Vec::new(),
            }
            .encode()
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
}

async fn recv_frame(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> CollaborationFrame {
    let message = tokio::time::timeout(Duration::from_secs(4), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    CollaborationFrame::decode(message.into_data().as_ref()).unwrap()
}

async fn assert_closed_without_binary(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) {
    match tokio::time::timeout(Duration::from_secs(2), socket.next()).await {
        Ok(None | Some(Ok(Message::Close(_)))) => {}
        Ok(Some(Ok(other))) => panic!("unexpected post-retirement message: {other:?}"),
        Ok(Some(Err(_))) => {}
        Err(_) => panic!("retired collaboration socket remained open"),
    }
}

#[allow(clippy::too_many_arguments)]
async fn ticket_http(
    client: &reqwest::Client,
    address: SocketAddr,
    path: &str,
    body: &[u8],
    origin: &str,
    token: &str,
    signing: &p256::ecdsa::SigningKey,
) -> String {
    ticket_json(client, address, path, body, origin, token, signing).await["ticket"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[allow(clippy::too_many_arguments)]
async fn ticket_json(
    client: &reqwest::Client,
    address: SocketAddr,
    path: &str,
    body: &[u8],
    origin: &str,
    token: &str,
    signing: &p256::ecdsa::SigningKey,
) -> serde_json::Value {
    let nonce = Uuid::new_v4();
    let mut proof = AuthorityRequestProof {
        version: AUTHORITY_PROOF_VERSION,
        timestamp: chrono::Utc::now().timestamp(),
        nonce,
        signature: String::new(),
        method: "POST".into(),
        target: path.to_owned(),
        body: body.to_vec(),
    };
    let signature: Signature = signing.sign(authority_proof_message(token, &proof).as_bytes());
    proof.signature = URL_SAFE_NO_PAD.encode(signature.to_bytes());
    let response = client
        .post(format!("http://{address}{path}"))
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .header(ORIGIN, origin)
        .header(CONTENT_TYPE, "application/json")
        .header(
            HeaderName::from_static(mdbase_connect_protocol::AUTHORITY_PROOF_VERSION_HEADER),
            proof.version.to_string(),
        )
        .header(
            HeaderName::from_static(mdbase_connect_protocol::AUTHORITY_PROOF_TIMESTAMP_HEADER),
            proof.timestamp.to_string(),
        )
        .header(
            HeaderName::from_static(mdbase_connect_protocol::AUTHORITY_PROOF_NONCE_HEADER),
            proof.nonce.to_string(),
        )
        .header(
            HeaderName::from_static(mdbase_connect_protocol::AUTHORITY_PROOF_SIGNATURE_HEADER),
            proof.signature,
        )
        .body(body.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::CREATED);
    response.json::<serde_json::Value>().await.unwrap()
}
