#![allow(clippy::too_many_lines)]

//! Phase 7 acceptance scenarios: graceful drain racing an in-flight update
//! (including pre-authentication sockets and refused admissions), local and
//! cross-instance revocation, rotation, and capability downgrade detection,
//! and admission suspension with lane cleanup.

use super::batches::{CollaborationBatchContribution, CollaborationBatchInput};
use super::phase7_drain_revoke_support::{
    assert_close_code, assert_close_code_within, open_synced_session, provision_collection,
    put_record, recv_frame, recv_frame_inner, register_collab_replica, run_with_schema,
    start_instance, stop_instance, ticket_body, timeout_short, update_frame, ws,
    CROSS_INSTANCE_CLOSE_DEADLINE, LOCAL_CLOSE_DEADLINE,
};
use super::*;
use crate::{RoomIdentity, COLLABORATION_PROFILE};
use futures_util::SinkExt;
use mdbase_connect_protocol::CollaborationMessageKind;
use reqwest::header::{HeaderValue, AUTHORIZATION, CONTENT_TYPE, ORIGIN};
use std::time::Duration;
use tokio::time::timeout;
use tokio_tungstenite::{
    connect_async, tungstenite::client::IntoClientRequest, tungstenite::Message,
};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Scenario 1: graceful drain races an in-flight update.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a disposable MDBASE_COLLABORATION_PHASE3_DATABASE_URL PostgreSQL database"]
async fn phase7_graceful_drain_race_postgres() {
    run_with_schema("phase7_drain", |base, schema| async move {
        const INTERNAL: &str = "phase7-drain-internal-token-01234567890";
        let instance = start_instance(&base, &schema, INTERNAL).await;
        let http = reqwest::Client::new();

        let collection = Uuid::new_v4();
        let record = Uuid::new_v4();
        let replica = Uuid::new_v4();
        let origin = "https://phase7.invalid";
        let signing = p256::ecdsa::SigningKey::random(&mut rand_core::OsRng);
        let token = format!("phase7-drain-{}", Uuid::new_v4());
        provision_collection(&instance.provider, Uuid::new_v4(), collection).await;
        register_collab_replica(
            &instance.provider,
            collection,
            replica,
            "phase7.drain",
            &token,
            &signing,
            origin,
        )
        .await;
        put_record(
            &instance.provider,
            collection,
            &token,
            replica,
            record,
            "notes/race.md",
            origin,
        )
        .await;

        let ws_url = format!("ws://{}/v1/collaboration", instance.address);
        let ticket_path = format!("/v1/authorities/{collection}/collaboration/tickets");

        // A connected-but-unauthenticated socket must be drained like any
        // other, without ever touching the database.
        let mut preauth = ws(&ws_url, origin).await;

        let (mut session, client) =
            open_synced_session(&instance, &http, &token, &signing, origin, &ticket_path, "notes/race.md").await;

        // Block the batch engine on the durable document row so the update arm
        // is provably mid-commit when drain begins. The update bytes are built
        // first because building them loads the same locked room state.
        let mutation = Uuid::new_v4();
        let update =
            build_next_update(&instance.provider, collection, record, "\nBase body\nrace\n").await;
        let mut blocker = instance.provider.pool.begin().await.unwrap();
        sqlx::query(
            "SELECT collection_id FROM hosted_provider_collaboration_documents
             WHERE collection_id=$1 AND record_id=$2 AND collaboration_epoch=1 AND profile=$3
             FOR UPDATE",
        )
        .bind(collection)
        .bind(record)
        .bind(COLLABORATION_PROFILE)
        .execute(&mut *blocker)
        .await
        .unwrap();

        session
            .send(Message::Binary(update_frame(mutation, update).into()))
            .await
            .unwrap();
        // Wait on the runtime's guard rather than a timing guess: once this is
        // one, the frame passed the atomic drain gate and the blocked batch is
        // owned by the session.
        timeout(Duration::from_secs(5), async {
            while instance.state.collaboration_in_flight_updates() != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("update guard was not acquired");

        // Drain begins while the batch is in flight.
        instance.state.begin_collaboration_session_drain();
        let drainer_state = instance.state.clone();
        let drainer = tokio::spawn(async move {
            drainer_state
                .finish_collaboration_session_drain(Duration::from_secs(10))
                .await
        });
        // Nothing may reach the socket while the started batch is unfinished:
        // no acknowledgement, no close.
        if let Some(message) = timeout_short(recv_frame_inner(&mut session)).await {
            panic!("draining interrupted an in-flight update: {message:?}");
        }
        // Pre-authentication sockets receive the going-away close immediately.
        assert_close_code(
            &mut preauth,
            crate::http::collaboration_sessions::COLLABORATION_CLOSE_GOING_AWAY,
        )
        .await;

        // Unblocking lets the already-started update finish, acknowledge, and
        // only then close with 1001.
        blocker.commit().await.unwrap();
        let ack = recv_frame(&mut session).await;
        assert_eq!(ack.kind, CollaborationMessageKind::Acknowledged);
        assert_eq!(
            ack.metadata
                .get("client_mutation_id")
                .and_then(Value::as_str),
            Some(mutation.to_string().as_str())
        );
        assert_close_code(
            &mut session,
            crate::http::collaboration_sessions::COLLABORATION_CLOSE_GOING_AWAY,
        )
        .await;

        // Every socket exited and every in-flight update finished: drained.
        let drained = timeout(Duration::from_secs(5), drainer)
            .await
            .expect("drain future")
            .expect("join");
        assert!(drained);
        assert_eq!(
            instance.state.collaboration_session_phase(),
            crate::http::collaboration_sessions::CollaborationSessionPhase::Drained
        );
        assert_eq!(instance.state.collaboration_tracked_sockets(), 0);
        let durable: (i64, i64) = sqlx::query_as(
            "SELECT (SELECT count(*) FROM hosted_provider_collaboration_updates WHERE collection_id=$1 AND record_id=$2),
                    (SELECT count(*) FROM hosted_provider_collaboration_receipts WHERE collection_id=$1 AND record_id=$2)",
        )
        .bind(collection)
        .bind(record)
        .fetch_one(&instance.provider.pool)
        .await
        .unwrap();
        assert_eq!(durable, (1, 1), "the finished update must stay committed");
        drop(client);

        // After drain: tickets and upgrades are rejected outright.
        let response = http
            .post(format!("http://{}{ticket_path}", instance.address))
            .header(AUTHORIZATION, format!("Bearer {token}"))
            .header(ORIGIN, origin)
            .header(CONTENT_TYPE, "application/json")
            .body(ticket_body("notes/race.md"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            response.json::<Value>().await.unwrap()["error"]["code"],
            "collaboration_draining"
        );
        let mut late_upgrade = ws_url
            .clone()
            .into_client_request()
            .unwrap();
        late_upgrade
            .headers_mut()
            .insert(ORIGIN, HeaderValue::from_static(origin));
        match connect_async(late_upgrade).await {
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                assert_eq!(response.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
            }
            other => panic!("upgrade succeeded after drain: {other:?}"),
        }

        stop_instance(instance).await;
    })
    .await;
}

// ---------------------------------------------------------------------------
// Scenario 2: revocation, rotation, and capability downgrade.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a disposable MDBASE_COLLABORATION_PHASE3_DATABASE_URL PostgreSQL database"]
async fn phase7_revocation_rotation_downgrade_postgres() {
    run_with_schema("phase7_revoke", |base, schema| async move {
        const INTERNAL: &str = "phase7-revoke-internal-token-0123456789";
        let instance_a = start_instance(&base, &schema, INTERNAL).await;
        let instance_b = start_instance(&base, &schema, INTERNAL).await;
        let http = reqwest::Client::new();

        let collection = Uuid::new_v4();
        let record = Uuid::new_v4();
        let replica_a = Uuid::new_v4();
        let replica_b = Uuid::new_v4();
        let replica_c = Uuid::new_v4();
        let origin = "https://phase7.invalid";
        let signing_a = p256::ecdsa::SigningKey::random(&mut rand_core::OsRng);
        let signing_b = p256::ecdsa::SigningKey::random(&mut rand_core::OsRng);
        let signing_c = p256::ecdsa::SigningKey::random(&mut rand_core::OsRng);
        let token_a = format!("phase7-a-{}", Uuid::new_v4());
        let token_b = format!("phase7-b-{}", Uuid::new_v4());
        let token_c = format!("phase7-c-{}", Uuid::new_v4());
        provision_collection(&instance_a.provider, Uuid::new_v4(), collection).await;
        register_collab_replica(
            &instance_a.provider,
            collection,
            replica_a,
            "phase7.a",
            &token_a,
            &signing_a,
            origin,
        )
        .await;
        register_collab_replica(
            &instance_a.provider,
            collection,
            replica_b,
            "phase7.b",
            &token_b,
            &signing_b,
            origin,
        )
        .await;
        register_collab_replica(
            &instance_a.provider,
            collection,
            replica_c,
            "phase7.c",
            &token_c,
            &signing_c,
            origin,
        )
        .await;
        put_record(
            &instance_a.provider,
            collection,
            &token_a,
            replica_a,
            record,
            "notes/revoke.md",
            origin,
        )
        .await;

        let ticket_path = format!("/v1/authorities/{collection}/collaboration/tickets");

        // Revocation, local: the session on the revoking instance is
        // target-closed right after the internal handler commits.
        let (mut local, _) = open_synced_session(
            &instance_a,
            &http,
            &token_a,
            &signing_a,
            origin,
            &ticket_path,
            "notes/revoke.md",
        )
        .await;
        // Revocation, cross-instance: a second session for the same replica on
        // the other instance converges through periodic reauthorization.
        let (mut remote, _) = open_synced_session(
            &instance_b,
            &http,
            &token_a,
            &signing_a,
            origin,
            &ticket_path,
            "notes/revoke.md",
        )
        .await;

        let revoke_response = http
            .delete(format!(
                "http://{}/internal/v1/replicas/{replica_a}",
                instance_a.address
            ))
            .header(AUTHORIZATION, format!("Bearer {INTERNAL}"))
            .send()
            .await
            .unwrap();
        assert_eq!(revoke_response.status(), reqwest::StatusCode::NO_CONTENT);

        let started = std::time::Instant::now();
        assert_close_code_within(
            &mut local,
            crate::http::collaboration_sessions::COLLABORATION_CLOSE_POLICY,
            LOCAL_CLOSE_DEADLINE,
        )
        .await;
        assert_close_code_within(
            &mut remote,
            crate::http::collaboration_sessions::COLLABORATION_CLOSE_POLICY,
            CROSS_INSTANCE_CLOSE_DEADLINE,
        )
        .await;
        assert!(
            started.elapsed() <= CROSS_INSTANCE_CLOSE_DEADLINE,
            "cross-instance revocation exceeded the four-second bound"
        );

        // Rotation: the live session is bound to the consumed credential
        // fingerprint, so rotating the replica token closes it without any
        // scope bump.
        let (mut rotated, _) = open_synced_session(
            &instance_b,
            &http,
            &token_b,
            &signing_b,
            origin,
            &ticket_path,
            "notes/revoke.md",
        )
        .await;
        let rotated_token = format!("phase7-b-rotated-{}", Uuid::new_v4());
        // Committed via instance A while the session lives on instance B.
        instance_a
            .provider
            .rotate_replica_token(replica_b, &rotated_token, Some(3600))
            .await
            .unwrap();

        // The durable batch boundary rejects updates from the stale session
        // deterministically: the stored hash no longer matches the binding.
        let stale_hash = token_hash(&token_b).try_into().unwrap();
        let stale_input = single_input(
            collection,
            record,
            replica_b,
            1,
            stale_hash,
            Uuid::new_v4(),
            b"not-even-applied".to_vec(),
        );
        let error = instance_b
            .provider
            .commit_collaboration_batch(stale_input)
            .await
            .unwrap_err();
        assert_eq!(error.code, "collaboration_scope_denied");

        assert_close_code_within(
            &mut rotated,
            crate::http::collaboration_sessions::COLLABORATION_CLOSE_POLICY,
            CROSS_INSTANCE_CLOSE_DEADLINE,
        )
        .await;

        // The fresh credential still authorizes the same durable boundary.
        let fresh_hash = token_hash(&rotated_token).try_into().unwrap();
        let update = build_next_update(
            &instance_a.provider,
            collection,
            record,
            "\nBase body\nafter rotation\n",
        )
        .await;
        let (_, accepted) = instance_b
            .provider
            .commit_collaboration_batch(single_input(
                collection,
                record,
                replica_b,
                1,
                fresh_hash,
                Uuid::new_v4(),
                update,
            ))
            .await
            .unwrap();
        assert!(accepted, "the rotated credential must remain authorized");

        // Downgrade: removing the collaboration capability ends the session
        // cross-instance within the periodic reauthorization bound.
        let (mut downgraded, _) = open_synced_session(
            &instance_b,
            &http,
            &token_c,
            &signing_c,
            origin,
            &ticket_path,
            "notes/revoke.md",
        )
        .await;
        let public_key_c =
            URL_SAFE_NO_PAD.encode(signing_c.verifying_key().to_encoded_point(false).as_bytes());
        instance_a
            .provider
            .update_application_replica(
                replica_c,
                UpdateApplicationReplica {
                    grant_id: grant_of(&instance_a.provider.pool, replica_c).await,
                    mode: SyncReplicaMode::ReadWrite,
                    allowed_types: Vec::new(),
                    contract_scope: Vec::new(),
                    full_collection: true,
                    allowed_operations: vec!["create".into(), "read".into(), "update".into()],
                    operation_transport_protocol: 3,
                    operation_transport_recovery_protocols: vec![2],
                    file_capability: None,
                    awareness_identity: None,
                    collaboration_capability: None,
                    allowed_origin: Some(origin.into()),
                    proof_public_key: Some(public_key_c),
                    application_declaration_id: "phase7.c".into(),
                    application_declaration_digest: format!("sha256:{}", "a".repeat(64)),
                },
            )
            .await
            .unwrap();
        assert_close_code_within(
            &mut downgraded,
            crate::http::collaboration_sessions::COLLABORATION_CLOSE_POLICY,
            CROSS_INSTANCE_CLOSE_DEADLINE,
        )
        .await;

        stop_instance(instance_a).await;
        stop_instance(instance_b).await;
    })
    .await;
}

async fn grant_of(pool: &PgPool, replica_id: Uuid) -> Uuid {
    sqlx::query_scalar("SELECT grant_id FROM hosted_provider_replicas WHERE id=$1")
        .bind(replica_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

fn single_input(
    collection: Uuid,
    record: Uuid,
    replica: Uuid,
    epoch: u64,
    token_hash: [u8; 32],
    mutation: Uuid,
    update: Vec<u8>,
) -> CollaborationBatchInput {
    CollaborationBatchInput {
        collection_id: collection,
        record_id: record,
        epoch,
        contributions: vec![CollaborationBatchContribution {
            replica_id: replica,
            expected_scope_epoch: 1,
            expected_token_hash: token_hash,
            client_mutation_id: mutation,
            update,
        }],
    }
}

async fn build_next_update(
    provider: &HostedProvider,
    collection: Uuid,
    record: Uuid,
    new_body: &str,
) -> Vec<u8> {
    let wrapped: Vec<u8> =
        sqlx::query_scalar("SELECT wrapped_data_key FROM hosted_provider_collections WHERE id=$1")
            .bind(collection)
            .fetch_one(&provider.pool)
            .await
            .unwrap();
    let data_key = *provider.collection_key(collection, &wrapped).await.unwrap();
    let room = RoomIdentity::new(collection, record, 1, COLLABORATION_PROFILE).unwrap();
    let mut transaction = provider.pool.begin().await.unwrap();
    let opened = provider
        .load_collaboration_room_in(&mut transaction, &data_key, room)
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

// ---------------------------------------------------------------------------
// Scenario 3: admission suspension and lane cleanup.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a disposable MDBASE_COLLABORATION_PHASE3_DATABASE_URL PostgreSQL database"]
async fn phase7_admission_suspension_cleanup_postgres() {
    run_with_schema("phase7_admission", |base, schema| async move {
        const INTERNAL: &str = "phase7-admission-internal-token-01234567";
        let instance = start_instance(&base, &schema, INTERNAL).await;
        let http = reqwest::Client::new();

        let collection = Uuid::new_v4();
        let record = Uuid::new_v4();
        let replica = Uuid::new_v4();
        let origin = "https://phase7.invalid";
        let signing = p256::ecdsa::SigningKey::random(&mut rand_core::OsRng);
        let token = format!("phase7-adm-{}", Uuid::new_v4());
        provision_collection(&instance.provider, Uuid::new_v4(), collection).await;
        register_collab_replica(
            &instance.provider,
            collection,
            replica,
            "phase7.admission",
            &token,
            &signing,
            origin,
        )
        .await;
        put_record(
            &instance.provider,
            collection,
            &token,
            replica,
            record,
            "notes/admission.md",
            origin,
        )
        .await;
        let ticket_path = format!("/v1/authorities/{collection}/collaboration/tickets");

        let idle_in_transaction = |pool: &PgPool| {
            let pool = pool.clone();
            async move {
                let (count,): (i64,) = sqlx::query_as(
                    "SELECT count(*) FROM pg_stat_activity WHERE state = 'idle in transaction'",
                )
                .fetch_one(&pool)
                .await
                .unwrap();
                count
            }
        };
        let baseline = idle_in_transaction(&instance.provider.pool).await;

        let (mut session, _) = open_synced_session(
            &instance,
            &http,
            &token,
            &signing,
            origin,
            &ticket_path,
            "notes/admission.md",
        )
        .await;

        // Suspend operation admission in the shared runtime control row.
        sqlx::query(
            "UPDATE hosted_provider_runtime_control SET query_admission_suspended=true WHERE singleton=true",
        )
        .execute(&instance.provider.pool)
        .await
        .unwrap();

        // HTTP tickets fail closed at the admission middleware...
        let response = http
            .post(format!("http://{}{ticket_path}", instance.address))
            .header(AUTHORIZATION, format!("Bearer {token}"))
            .header(ORIGIN, origin)
            .header(CONTENT_TYPE, "application/json")
            .body(ticket_body("notes/admission.md"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            response.json::<Value>().await.unwrap()["error"]["code"],
            "hosted_query_admission_suspended"
        );
        // ...and the live session closes as temporarily unavailable after a
        // bounded retry, rather than misreporting suspension as revocation.
        assert_close_code_within(
            &mut session,
            crate::http::collaboration_sessions::COLLABORATION_CLOSE_INTERNAL,
            CROSS_INSTANCE_CLOSE_DEADLINE,
        )
        .await;

        // Unsuspending restores admission; lanes must have been fully
        // released along the way (no idle-in-transaction leak).
        sqlx::query(
            "UPDATE hosted_provider_runtime_control SET query_admission_suspended=false WHERE singleton=true",
        )
        .execute(&instance.provider.pool)
        .await
        .unwrap();

        // open_synced_session itself proves recovery: ticket consumption
        // (a lane) succeeds again and SyncStep2 returns a durable diff.
        let (mut recovered, recovered_client) = open_synced_session(
            &instance,
            &http,
            &token,
            &signing,
            origin,
            &ticket_path,
            "notes/admission.md",
        )
        .await;
        drop(recovered_client);
        let _ = recovered.close(None).await;

        // Final cleanup: drain quiesces the registry, and every admission lane
        // transaction is gone from the database.
        instance.state.begin_collaboration_session_drain();
        assert!(instance
            .state
            .finish_collaboration_session_drain(Duration::from_secs(5))
            .await);
        assert_eq!(instance.state.collaboration_tracked_sockets(), 0);
        let mut leaked = idle_in_transaction(&instance.provider.pool).await;
        for _ in 0..100 {
            if leaked <= baseline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            leaked = idle_in_transaction(&instance.provider.pool).await;
        }
        assert!(
            leaked <= baseline,
            "admission lanes leaked {leaked} idle-in-transaction connections (baseline {baseline})"
        );

        stop_instance(instance).await;
    })
    .await;
}
