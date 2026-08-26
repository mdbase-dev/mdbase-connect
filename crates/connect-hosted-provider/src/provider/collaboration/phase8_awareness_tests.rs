#![allow(clippy::too_many_lines)]

//! Phase 8 acceptance scenarios: strict sanitized awareness exchange, spoof
//! rejection, durability of all durable counters, removal on close/revocation/
//! expiry, multi-instance isolation with Hello advertisement and drain
//! teardown, and the migration 0044 backfill/ledger/rollback contract.

use super::phase7_drain_revoke_support::{
    assert_close_code_within, put_record, run_with_schema, CROSS_INSTANCE_CLOSE_DEADLINE,
};
use super::phase8_awareness_support::{
    awareness_update_frame, open_awareness_session, open_unsynced_session, provision_collection,
    raw_awareness_frame, recv_snapshot, register_collab_replica, shutdown_without_drain,
    start_instance, start_instance_with_limits, stop_instance,
};
use super::*;
use crate::http::collaboration_sessions::COLLABORATION_CLOSE_POLICY;
use crate::COLLABORATION_PROFILE;
use futures_util::{SinkExt, StreamExt};
use mdbase_connect_protocol::{AwarenessColor, AwarenessStatus, ServerAwarenessSnapshot};
use serde_json::json;
use std::str::FromStr;
use std::time::Duration;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;

const ORIGIN_A: &str = "https://phase8.invalid";

struct Replica {
    id: Uuid,
    token: String,
    signing: p256::ecdsa::SigningKey,
}

fn replica() -> Replica {
    Replica {
        id: Uuid::new_v4(),
        token: format!("phase8-awareness-{}", Uuid::new_v4()),
        signing: p256::ecdsa::SigningKey::random(&mut rand_core::OsRng),
    }
}

/// Durable collaboration state must be completely untouched by awareness
/// traffic. Captured after room admission, verified after everything.
async fn durable_snapshot(
    pool: &sqlx::PgPool,
    collection: Uuid,
    record: Uuid,
) -> (i64, String, i64, i64) {
    let row = sqlx::query(
        "SELECT c.head, r.revision, r.sequence AS record_sequence,
                COALESCE(d.current_sequence, 0) AS current_sequence
         FROM hosted_provider_collections c
         JOIN hosted_provider_records r
           ON r.collection_id = c.id AND r.record_id = $2
         LEFT JOIN hosted_provider_collaboration_documents d
           ON d.collection_id = c.id AND d.record_id = $2
          AND d.collaboration_epoch = 1 AND d.profile = $3
         WHERE c.id = $1",
    )
    .bind(collection)
    .bind(record)
    .bind(COLLABORATION_PROFILE)
    .fetch_one(pool)
    .await
    .unwrap();
    (
        row.get::<i64, _>("head"),
        row.get::<String, _>("revision"),
        row.get::<i64, _>("record_sequence"),
        row.get::<i64, _>("current_sequence"),
    )
}

/// Await a close code while tolerating interleaved snapshot frames.
async fn assert_close_ignoring_frames<S>(socket: &mut S, code: u16)
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let deadline = Duration::from_secs(5);
    loop {
        match timeout(deadline, socket.next()).await {
            Ok(Some(Ok(Message::Close(Some(frame))))) => {
                assert_eq!(u16::from(frame.code), code, "unexpected close code");
                return;
            }
            Ok(Some(Ok(Message::Binary(_)))) => continue,
            Ok(other) => panic!("expected close {code}, got {other:?}"),
            Err(_) => panic!("socket never received close {code}"),
        }
    }
}

// ---------------------------------------------------------------------------
// Scenario 1: two sessions exchange sanitized snapshots; read-only sessions
// participate; no durable state moves.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a disposable MDBASE_COLLABORATION_PHASE3_DATABASE_URL PostgreSQL database"]
async fn phase8_awareness_sanitized_exchange_postgres() {
    run_with_schema("phase8_exchange", |base, schema| async move {
        let instance = start_instance(&base, &schema).await;
        let http = reqwest::Client::new();

        let account = Uuid::new_v4();
        let collection = Uuid::new_v4();
        let record = Uuid::new_v4();
        provision_collection(&instance.provider, account, collection).await;

        let ada = replica();
        let grace = replica();
        register_collab_replica(
            &instance.provider,
            collection,
            ada.id,
            "Participant",
            AwarenessColor::Teal,
            SyncReplicaMode::ReadWrite,
            &ada.token,
            &ada.signing,
            ORIGIN_A,
        )
        .await;
        register_collab_replica(
            &instance.provider,
            collection,
            grace.id,
            "Participant",
            AwarenessColor::Rose,
            SyncReplicaMode::ReadOnly,
            &grace.token,
            &grace.signing,
            ORIGIN_A,
        )
        .await;
        put_record(
            &instance.provider,
            collection,
            &ada.token,
            ada.id,
            record,
            "notes/phase8.md",
            ORIGIN_A,
        )
        .await;

        let (mut socket_a, joined_a) = open_awareness_session(
            &instance,
            &http,
            collection,
            &ada.token,
            &ada.signing,
            ORIGIN_A,
            "notes/phase8.md",
            SyncReplicaMode::ReadWrite,
        )
        .await;
        let joined_a: ServerAwarenessSnapshot =
            joined_a.expect("join snapshot for the first member");
        assert!(
            joined_a.participants.is_empty(),
            "a socket must not receive itself"
        );

        let stalled = open_unsynced_session(
            &instance,
            &http,
            collection,
            &grace.token,
            &grace.signing,
            ORIGIN_A,
            "notes/phase8.md",
            SyncReplicaMode::ReadOnly,
        )
        .await;
        assert!(
            timeout(Duration::from_millis(300), recv_snapshot(&mut socket_a))
                .await
                .is_err(),
            "an authenticated but unsynced socket became visible"
        );
        drop(stalled);

        let (mut socket_b, joined_b) = open_awareness_session(
            &instance,
            &http,
            collection,
            &grace.token,
            &grace.signing,
            ORIGIN_A,
            "notes/phase8.md",
            SyncReplicaMode::ReadOnly,
        )
        .await;
        let joined_b = joined_b.expect("join snapshot includes existing members");
        assert_eq!(joined_b.participants.len(), 1);
        assert_eq!(joined_b.participants[0].name, "Participant 1");

        let observed_by_a = recv_snapshot(&mut socket_a).await;
        assert_eq!(observed_by_a.participants.len(), 1);
        assert_eq!(observed_by_a.participants[0].name, "Participant 2");

        let baseline = durable_snapshot(&instance.provider.pool, collection, record).await;

        // A valid awareness update from the READ-ONLY session rebroadcasts a
        // recipient-specific replacement without echoing either socket to itself.
        socket_b
            .send(Message::Binary(
                awareness_update_frame("active", json!([{"anchor": 3, "head": 9}]))
                    .encode()
                    .unwrap()
                    .into(),
            ))
            .await
            .unwrap();
        let seen_by_b = recv_snapshot(&mut socket_b).await;
        assert_eq!(seen_by_b.participants.len(), 1);
        assert_eq!(seen_by_b.participants[0].color, AwarenessColor::Teal);
        let seen_by_a = recv_snapshot(&mut socket_a).await;
        assert_eq!(seen_by_a.participants.len(), 1);
        let grace_on_a = seen_by_a
            .participants
            .iter()
            .find(|participant| participant.color == AwarenessColor::Rose)
            .expect("read-only collaborator visible to writer");
        assert_eq!(grace_on_a.status, AwarenessStatus::Active);
        assert_eq!(grace_on_a.selections.len(), 1);

        // No durable counter, head, revision, sequence, or storage byte moved.
        assert_eq!(
            baseline,
            durable_snapshot(&instance.provider.pool, collection, record).await
        );

        drop(socket_a);
        drop(socket_b);
        stop_instance(instance).await;
    })
    .await;
}

// ---------------------------------------------------------------------------
// Scenario 2: spoofed identity/text/path fields and invalid shapes close the
// session; valid over-rate frames are ignored and honest members are unaware.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a disposable MDBASE_COLLABORATION_PHASE3_DATABASE_URL PostgreSQL database"]
async fn phase8_awareness_spoof_rejection_postgres() {
    run_with_schema("phase8_spoof", |base, schema| async move {
        let instance = start_instance(&base, &schema).await;
        let http = reqwest::Client::new();

        let account = Uuid::new_v4();
        let collection = Uuid::new_v4();
        let record = Uuid::new_v4();
        provision_collection(&instance.provider, account, collection).await;

        let ada = replica();
        let grace = replica();
        register_collab_replica(
            &instance.provider,
            collection,
            ada.id,
            "Participant",
            AwarenessColor::Teal,
            SyncReplicaMode::ReadWrite,
            &ada.token,
            &ada.signing,
            ORIGIN_A,
        )
        .await;
        register_collab_replica(
            &instance.provider,
            collection,
            grace.id,
            "Participant",
            AwarenessColor::Rose,
            SyncReplicaMode::ReadOnly,
            &grace.token,
            &grace.signing,
            ORIGIN_A,
        )
        .await;
        put_record(
            &instance.provider,
            collection,
            &ada.token,
            ada.id,
            record,
            "notes/spoof.md",
            ORIGIN_A,
        )
        .await;

        let (mut survivor, _) =
            open_awareness_session(&instance, &http, collection, &ada.token, &ada.signing, ORIGIN_A, "notes/spoof.md", SyncReplicaMode::ReadWrite).await;

        for smuggled in [
            json!({"status": "active", "selections": [], "name": "Spoofed"}),
            json!({"status": "active", "selections": [], "color": "rose"}),
            json!({"status": "active", "selections": [], "email": "ada@example.invalid"}),
            json!({"status": "active", "selections": [], "user_id": Uuid::new_v4()}),
            json!({"status": "active", "selections": [], "replica_id": ada.id}),
            json!({"status": "active", "selections": [], "path": "/etc/passwd"}),
            json!({"status": "active", "selections": [], "text": "selected body bytes"}),
            json!({"status": "away", "selections": []}),
            json!({"status": null, "selections": []}),
            json!({"status": "active", "selections": [{"anchor": -1, "head": 0}]}),
            json!({"status": "active", "selections": [{"anchor": 4294967296_i64, "head": 0}]}),
            json!({"status": "active", "selections": [{"anchor": 0.5, "head": 0}]}),
            json!({"status": "active", "selections": [{"anchor": 0, "head": 0}, {"anchor": 0, "head": 0}]}),
            json!({"status": "active", "selections": [{"anchor": 0, "head": 0, "deep": {"deeper": [1]}}]}),
        ] {
            let (mut violator, _) =
                open_awareness_session(&instance, &http, collection, &ada.token, &ada.signing, ORIGIN_A, "notes/spoof.md", SyncReplicaMode::ReadWrite).await;
            violator
                .send(Message::Binary(
                    raw_awareness_frame(smuggled.clone(), Vec::new())
                        .encode()
                        .unwrap()
                        .into(),
                ))
                .await
                .unwrap();
            assert_close_ignoring_frames(&mut violator, COLLABORATION_CLOSE_POLICY).await;
        }

        // Non-empty payloads reject even when metadata is exact.
        let (mut payload_violator, _) =
            open_awareness_session(&instance, &http, collection, &ada.token, &ada.signing, ORIGIN_A, "notes/spoof.md", SyncReplicaMode::ReadWrite).await;
        payload_violator
            .send(Message::Binary(
                raw_awareness_frame(json!({"status": "active", "selections": []}), vec![0, 1, 2])
                    .encode()
                    .unwrap()
                    .into(),
            ))
            .await
            .unwrap();
        assert_close_ignoring_frames(&mut payload_violator, COLLABORATION_CLOSE_POLICY).await;

        // The spacing rule ignores a valid burst without refreshing presence
        // or sacrificing the durable session. A later spaced update is still
        // accepted, proving the connection remained usable.
        let (mut buster, _) =
            open_awareness_session(&instance, &http, collection, &ada.token, &ada.signing, ORIGIN_A, "notes/spoof.md", SyncReplicaMode::ReadWrite).await;
        buster.send(Message::Binary(
            awareness_update_frame("idle", json!([])).encode().unwrap().into(),
        )).await.unwrap();
        buster.send(Message::Binary(
            awareness_update_frame("active", json!([])).encode().unwrap().into(),
        )).await.unwrap();
        tokio::time::sleep(Duration::from_millis(130)).await;
        buster.send(Message::Binary(
            awareness_update_frame("active", json!([])).encode().unwrap().into(),
        )).await.unwrap();
        let _idle_view = recv_snapshot(&mut buster).await;
        let active_view = recv_snapshot(&mut buster).await;
        assert!(active_view.participants.iter().any(|participant| {
            participant.status == AwarenessStatus::Active
        }));

        // The honest member keeps working throughout; its view still shows a
        // single participant identity from registration, never spoofed names.
        let final_view = recv_snapshot(&mut survivor).await;
        assert!(!final_view.participants.is_empty());
        assert!(final_view
            .participants
            .iter()
            .all(|participant| participant.name.starts_with("Participant ")));

        drop(survivor);
        stop_instance(instance).await;
    })
    .await;
}

// ---------------------------------------------------------------------------
// Scenario 3: presence ends on orderly close, revocation, and expiry.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a disposable MDBASE_COLLABORATION_PHASE3_DATABASE_URL PostgreSQL database"]
async fn phase8_awareness_leave_revoke_expiry_postgres() {
    run_with_schema("phase8_leave", |base, schema| async move {
        // Two-second visible TTL so expiry is observable quickly.
        let instance = start_instance_with_limits(
            &base,
            &schema,
            ProviderLimits {
                hosted_collaboration_enabled: true,
                collaboration: CollaborationLimits {
                    awareness_ttl_seconds: 2,
                    ..CollaborationLimits::default()
                },
                ..ProviderLimits::default()
            },
        )
        .await;
        let http = reqwest::Client::new();

        let account = Uuid::new_v4();
        let collection = Uuid::new_v4();
        let record = Uuid::new_v4();
        provision_collection(&instance.provider, account, collection).await;

        let ada = replica();
        let grace = replica();
        let heidi = replica();
        register_collab_replica(
            &instance.provider,
            collection,
            ada.id,
            "Participant",
            AwarenessColor::Teal,
            SyncReplicaMode::ReadWrite,
            &ada.token,
            &ada.signing,
            ORIGIN_A,
        )
        .await;
        register_collab_replica(
            &instance.provider,
            collection,
            grace.id,
            "Participant",
            AwarenessColor::Rose,
            SyncReplicaMode::ReadOnly,
            &grace.token,
            &grace.signing,
            ORIGIN_A,
        )
        .await;
        register_collab_replica(
            &instance.provider,
            collection,
            heidi.id,
            "Participant",
            AwarenessColor::Blue,
            SyncReplicaMode::ReadOnly,
            &heidi.token,
            &heidi.signing,
            ORIGIN_A,
        )
        .await;
        put_record(
            &instance.provider,
            collection,
            &ada.token,
            ada.id,
            record,
            "notes/leave.md",
            ORIGIN_A,
        )
        .await;

        let (observer, _) = open_awareness_session(
            &instance,
            &http,
            collection,
            &ada.token,
            &ada.signing,
            ORIGIN_A,
            "notes/leave.md",
            SyncReplicaMode::ReadWrite,
        )
        .await;
        // The observer stays visible by sending identical awareness updates:
        // each refreshes its lease without rebroadcasting, so any snapshot it
        // receives is a real membership event.
        let (mut observer_sink, mut observer_stream) = observer.split();
        let keep_alive = tokio::spawn(async move {
            let frame = awareness_update_frame("active", json!([]));
            loop {
                if observer_sink
                    .send(Message::Binary(frame.encode().unwrap().into()))
                    .await
                    .is_err()
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        });

        // Heidi leaves by closing her socket: removal plus rebroadcast.
        let (heidi_socket, _) = open_awareness_session(
            &instance,
            &http,
            collection,
            &heidi.token,
            &heidi.signing,
            ORIGIN_A,
            "notes/leave.md",
            SyncReplicaMode::ReadOnly,
        )
        .await;
        let observed = recv_snapshot(&mut observer_stream).await;
        assert_eq!(observed.participants.len(), 1);
        drop(heidi_socket);
        let observed = recv_snapshot(&mut observer_stream).await;
        assert!(observed.participants.is_empty());

        // Grace is revoked: target-close removes her presence immediately.
        let (mut grace_socket, _) = open_awareness_session(
            &instance,
            &http,
            collection,
            &grace.token,
            &grace.signing,
            ORIGIN_A,
            "notes/leave.md",
            SyncReplicaMode::ReadOnly,
        )
        .await;
        let observed = recv_snapshot(&mut observer_stream).await;
        assert_eq!(observed.participants.len(), 1);
        instance.provider.revoke_replica(grace.id).await.unwrap();
        // Her session closes on its next server-driven reauthorization...
        assert_close_code_within(
            &mut grace_socket,
            COLLABORATION_CLOSE_POLICY,
            CROSS_INSTANCE_CLOSE_DEADLINE,
        )
        .await;
        // ...and her presence disappears from the room.
        let observed = recv_snapshot(&mut observer_stream).await;
        assert!(observed.participants.is_empty());

        // Silent goes quiet. Its lease refreshes only from activity, so its
        // visibility lapses within TTL + one sweep even though its socket
        // stays open.
        let silent = replica();
        register_collab_replica(
            &instance.provider,
            collection,
            silent.id,
            "Participant",
            AwarenessColor::Slate,
            SyncReplicaMode::ReadOnly,
            &silent.token,
            &silent.signing,
            ORIGIN_A,
        )
        .await;
        let (silent_socket, _) = open_awareness_session(
            &instance,
            &http,
            collection,
            &silent.token,
            &silent.signing,
            ORIGIN_A,
            "notes/leave.md",
            SyncReplicaMode::ReadOnly,
        )
        .await;
        let observed = recv_snapshot(&mut observer_stream).await;
        assert_eq!(observed.participants.len(), 1);

        // Silent goes quiet. Within TTL + one sweep its visibility lapses even
        // though its socket remains open.
        timeout(Duration::from_secs(10), async {
            loop {
                let observed = recv_snapshot(&mut observer_stream).await;
                if observed.participants.is_empty() {
                    return;
                }
            }
        })
        .await
        .expect("expired participant was never removed");
        drop(silent_socket);
        keep_alive.abort();

        stop_instance(instance).await;
    })
    .await;
}

// ---------------------------------------------------------------------------
// Scenario 4: two instances on one database do not exchange presence, Hello
// always advertises provider_instance scope, and drain ends all awareness.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a disposable MDBASE_COLLABORATION_PHASE3_DATABASE_URL PostgreSQL database"]
async fn phase8_awareness_multi_instance_isolation_postgres() {
    run_with_schema("phase8_isolation", |base, schema| async move {
        let instance_a = start_instance(&base, &schema).await;
        let instance_b = start_instance(&base, &schema).await;
        let http = reqwest::Client::new();

        let account = Uuid::new_v4();
        let collection = Uuid::new_v4();
        let record = Uuid::new_v4();
        provision_collection(&instance_a.provider, account, collection).await;

        let ada = replica();
        let grace = replica();
        register_collab_replica(
            &instance_a.provider,
            collection,
            ada.id,
            "Participant",
            AwarenessColor::Teal,
            SyncReplicaMode::ReadWrite,
            &ada.token,
            &ada.signing,
            ORIGIN_A,
        )
        .await;
        register_collab_replica(
            &instance_a.provider,
            collection,
            grace.id,
            "Participant",
            AwarenessColor::Rose,
            SyncReplicaMode::ReadOnly,
            &grace.token,
            &grace.signing,
            ORIGIN_A,
        )
        .await;
        put_record(
            &instance_a.provider,
            collection,
            &ada.token,
            ada.id,
            record,
            "notes/isolation.md",
            ORIGIN_A,
        )
        .await;

        // Each instance stores only its own member for the same room, while
        // recipient snapshots correctly exclude that socket itself.
        let (mut socket_a, joined_a) = open_awareness_session(
            &instance_a,
            &http,
            collection,
            &ada.token,
            &ada.signing,
            ORIGIN_A,
            "notes/isolation.md",
            SyncReplicaMode::ReadWrite,
        )
        .await;
        let joined_a = joined_a.expect("join snapshot");
        assert!(joined_a.participants.is_empty());

        let (mut socket_b, joined_b) = open_awareness_session(
            &instance_b,
            &http,
            collection,
            &grace.token,
            &grace.signing,
            ORIGIN_A,
            "notes/isolation.md",
            SyncReplicaMode::ReadOnly,
        )
        .await;
        let joined_b = joined_b.expect("join snapshot");
        assert!(joined_b.participants.is_empty());

        // No cross-instance rebroadcasts arrive: a quiet second passes with no
        // frames on either socket.
        let leak = timeout(Duration::from_millis(700), async {
            tokio::select! {
                message = socket_a.next() => format!("instance A received: {message:?}"),
                message = socket_b.next() => format!("instance B received: {message:?}"),
            }
        })
        .await
        .ok();
        if let Some(leak) = leak {
            panic!("cross-instance presence leaked: {leak}");
        }

        // Draining instance A removes every trace of awareness there while
        // instance B keeps serving its own membership.
        instance_a.state.begin_collaboration_session_drain();
        assert!(
            instance_a
                .state
                .finish_collaboration_session_drain(Duration::from_secs(5))
                .await
        );
        assert_eq!(instance_a.state.awareness_participant_count(), 0);
        assert_eq!(instance_b.state.awareness_participant_count(), 1);

        // B can still update its own presence; its recipient snapshot remains
        // empty because no peer exists on that provider instance.
        socket_b
            .send(Message::Binary(
                awareness_update_frame("active", json!([{"anchor": 0, "head": 1}]))
                    .encode()
                    .unwrap()
                    .into(),
            ))
            .await
            .unwrap();
        let observed = recv_snapshot(&mut socket_b).await;
        assert!(observed.participants.is_empty());

        drop(socket_a);
        drop(socket_b);
        // Instance A already drained; finish teardown without draining again.
        shutdown_without_drain(instance_a).await;
        stop_instance(instance_b).await;
    })
    .await;
}

// ---------------------------------------------------------------------------
// Scenario 5: migration 0044 backfills a safe generic identity for existing
// rows, keeps ordinary replicas unaffected, records the ledger entry, and
// stays compatible with the previous binary's INSERT shape.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a disposable MDBASE_COLLABORATION_PHASE3_DATABASE_URL PostgreSQL database"]
async fn phase8_awareness_migrations0044_0045_postgres() {
    use futures_util::FutureExt;

    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let base = std::env::var("MDBASE_COLLABORATION_PHASE3_DATABASE_URL").expect("database URL");
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("phase8_migrations0044_0045_{}", Uuid::new_v4().simple());
    sqlx::query(AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
        .execute(&admin)
        .await
        .unwrap();
    let result = std::panic::AssertUnwindSafe(async {
        let options = sqlx::postgres::PgConnectOptions::from_str(&base)
            .unwrap()
            .options([("search_path", format!("{schema},public"))]);
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .acquire_timeout(Duration::from_secs(10))
            .connect_with(options)
            .await
            .unwrap();
        let migrator = sqlx::migrate!("./migrations");

        // Apply the chain exactly through 0043: the shape an older provider
        // binary runs against in production.
        assert!(migrator.version_exists(43));
        assert!(migrator.version_exists(44));
        assert!(migrator.version_exists(45));
        migrator.run_to(43, &pool).await.unwrap();
        let applied: Vec<i64> =
            sqlx::query("SELECT version FROM _sqlx_migrations ORDER BY version")
                .fetch_all(&pool)
                .await
                .unwrap()
                .into_iter()
                .map(|row| row.get::<i64, _>("version"))
                .collect();
        assert!(!applied.contains(&44), "run_to applied beyond 0043");

        // Seed rows using only columns that existed before 0044.
        let account = Uuid::new_v4();
        let collection = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO hosted_provider_accounts
               (id, entitlement_revision, max_live_storage_bytes,
                max_retained_file_bytes, max_document_bytes, max_single_file_bytes,
                max_mirror_replicas_per_collection, max_application_replicas_per_collection,
                max_collections, max_files_per_collection, max_collaboration_bytes)
             VALUES ($1, 1, 1048576, 1048576, 1048576, 1048576, 4, 4, 2, 2, 1048576)",
        )
        .bind(account)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO hosted_provider_collections
               (id, account_id, template, display_name, timezone, state,
                spec_version, resource_revision, wrapped_data_key,
                resources_ciphertext, max_records, max_content_bytes,
                max_document_bytes, max_mirror_replicas, max_application_replicas,
                max_files, max_file_bytes, max_stored_file_bytes,
                max_single_file_bytes, max_collaboration_bytes)
             VALUES ($1, $2, 'mdbase', 'Phase 8 migration', 'UTC', 'active',
                     'v1', 'rev-0', $3, $4, 10000, 1048576, 1048576, 4, 4,
                     2, 1048576, 1048576, 1048576, 1048576)",
        )
        .bind(collection)
        .bind(account)
        .bind(vec![0_u8; 32])
        .bind(vec![0_u8; 16])
        .execute(&pool)
        .await
        .unwrap();
        let collab_replica = Uuid::new_v4();
        let ordinary_replica = Uuid::new_v4();
        for (replica_id, collab) in [(collab_replica, true), (ordinary_replica, false)] {
            let capability: Option<Value> = if collab {
                Some(json!({"contract_version": 1, "profiles": [COLLABORATION_PROFILE], "access": "read_write"}))
            } else {
                None
            };
            let grant_id = Uuid::new_v4();
            let operations: Vec<String> = if collab {
                vec!["read".into(), "update".into()]
            } else {
                vec!["read".into()]
            };
            sqlx::query(
                "INSERT INTO hosted_provider_replicas
                   (id, collection_id, name, purpose, mode, allowed_operations,
                    full_collection, contract_scope, grant_id,
                    application_declaration_id, application_declaration_digest,
                    allowed_origin, proof_public_key, collaboration_capability,
                    token_hash)
                 VALUES ($1, $2, $3, 'application', 'read_write', $4,
                         true, '[]'::jsonb, $5, 'phase8.app',
                         $6, 'https://phase8.invalid', $7, $8::jsonb, $9)",
            )
            .bind(replica_id)
            .bind(collection)
            .bind(if collab { "legacy collab replica" } else { "ordinary replica" })
            .bind(operations)
            .bind(grant_id)
            .bind(format!("sha256:{}", "a".repeat(64)))
            .bind(format!("p256:{}", "a".repeat(40)))
            .bind(capability)
            .bind(Uuid::new_v4().as_bytes().to_vec())
            .execute(&pool)
            .await
            .unwrap();
        }

        // Apply immutable 0044 first, then simulate the immediately preceding
        // awareness-enabled binary storing a bounded profile name.
        migrator.run_to(44, &pool).await.unwrap();
        sqlx::query(
            "UPDATE hosted_provider_replicas SET awareness_name = 'Legacy Profile' WHERE id = $1",
        )
        .bind(collab_replica)
        .execute(&pool)
        .await
        .unwrap();

        // Follow-up 0045 sanitizes that stored PII before enforcing the exact
        // generic-name invariant.
        migrator.run(&pool).await.unwrap();

        // The ledger recorded both immutable migrations with their checksums.
        let ledger: Vec<(i64, Vec<u8>)> = sqlx::query_as(
            "SELECT version, checksum FROM _sqlx_migrations ORDER BY version",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        for version in [44_i64, 45_i64] {
            let applied = ledger
                .iter()
                .find(|(applied, _)| *applied == version)
                .unwrap_or_else(|| panic!("migration {version} missing from the ledger"));
            let expected_checksum: &[u8] = &migrator
                .iter()
                .find(|migration| migration.version == version)
                .unwrap()
                .checksum;
            assert_eq!(applied.1.as_slice(), expected_checksum);
        }

        // Existing rows carry the safe generic identity: no user, replica,
        // grant, session, account, or record identifier.
        for replica_id in [collab_replica, ordinary_replica] {
            let row: (String, String) = sqlx::query_as(
                "SELECT awareness_name, awareness_color FROM hosted_provider_replicas WHERE id = $1",
            )
            .bind(replica_id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(row.0, "Participant");
            assert_eq!(row.1, "slate");
        }

        // Rollback compatibility: the previously live binary inserts replicas
        // without awareness columns; column defaults keep that path valid.
        sqlx::query(
            "INSERT INTO hosted_provider_replicas
               (id, collection_id, name, purpose, mode, allowed_operations, token_hash)
             VALUES ($1, $2, 'old binary insert', 'mirror', 'read_only', '{}', $3)",
        )
        .bind(Uuid::new_v4())
        .bind(collection)
        .bind(Uuid::new_v4().as_bytes().to_vec())
        .execute(&pool)
        .await
        .unwrap();

        // The identity CHECKs reject profile-like names and malformed values
        // at the database too.
        let profile_name = sqlx::query(
            "UPDATE hosted_provider_replicas SET awareness_name = 'Profile Name' WHERE collection_id = $1",
        )
        .bind(collection)
        .execute(&pool)
        .await;
        assert!(profile_name.is_err());
        let bad_color = sqlx::query(
            "UPDATE hosted_provider_replicas SET awareness_color = 'crimson' WHERE collection_id = $1",
        )
        .bind(collection)
        .execute(&pool)
        .await;
        assert!(bad_color.is_err(), "non-palette color accepted");
        let padded_name = sqlx::query(
            "UPDATE hosted_provider_replicas SET awareness_name = ' padded name' WHERE collection_id = $1",
        )
        .bind(collection)
        .execute(&pool)
        .await;
        assert!(padded_name.is_err(), "padded name accepted");
        let oversized = sqlx::query(
            "UPDATE hosted_provider_replicas SET awareness_name = repeat('x', 101) WHERE collection_id = $1",
        )
        .bind(collection)
        .execute(&pool)
        .await;
        assert!(oversized.is_err(), "oversized name accepted");

        // A pre-0044 ordinary replica remains idempotently registerable after
        // the generic backfill. Simulate that stored shape against the real
        // provider path rather than comparing raw SQL only.
        let retry_instance = start_instance(&base, &schema).await;
        let retry_replica = RegisterReplica {
            replica_id: Uuid::new_v4(),
            name: "ordinary retry".into(),
            purpose: ReplicaPurpose::Mirror,
            mode: SyncReplicaMode::ReadOnly,
            allowed_types: Vec::new(),
            contract_scope: Vec::new(),
            full_collection: false,
            allowed_operations: Vec::new(),
            operation_transport_protocol: None,
            operation_transport_recovery_protocols: Vec::new(),
            file_capability: None,
            collaboration_capability: None,
            awareness_identity: None,
            allowed_origin: None,
            proof_public_key: None,
            grant_id: None,
            application_declaration_id: None,
            application_declaration_digest: None,
            token: format!("phase8-ordinary-retry-{}", Uuid::new_v4()),
            token_ttl_seconds: Some(3600),
        };
        retry_instance
            .provider
            .register_replica(collection, retry_replica.clone())
            .await
            .unwrap();
        sqlx::query(
            "UPDATE hosted_provider_replicas SET awareness_name = 'Participant', awareness_color = 'slate' WHERE id = $1",
        )
        .bind(retry_replica.replica_id)
        .execute(&retry_instance.provider.pool)
        .await
        .unwrap();
        retry_instance
            .provider
            .register_replica(collection, retry_replica)
            .await
            .expect("ordinary replica retry conflicted with generic backfill");
        stop_instance(retry_instance).await;

        // Re-running the full chain is a no-op.
        migrator.run(&pool).await.unwrap();
        pool.close().await;
    })
    .catch_unwind()
    .await;
    sqlx::query(AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE")))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
    if let Err(payload) = result {
        std::panic::resume_unwind(payload);
    }
}
