//! Awareness admission limits must not terminate durable collaboration.

use super::phase7_drain_revoke_support::{put_record, run_with_schema};
use super::phase8_awareness_support::{
    open_awareness_session, provision_collection, recv_any_frame, register_collab_replica,
    start_instance, stop_instance,
};
use super::*;
use futures_util::SinkExt;
use mdbase_connect_protocol::{AwarenessColor, CollaborationFrame, CollaborationMessageKind};
use tokio_tungstenite::tungstenite::Message;

const ORIGIN: &str = "https://phase8-cap.invalid";

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a disposable MDBASE_COLLABORATION_PHASE3_DATABASE_URL PostgreSQL database"]
async fn replica_cap_preserves_durable_session_postgres() {
    run_with_schema("phase8_cap_durable", |base, schema| async move {
        let instance = start_instance(&base, &schema).await;
        let http = reqwest::Client::new();
        let collection = Uuid::new_v4();
        provision_collection(&instance.provider, Uuid::new_v4(), collection).await;
        let replica_id = Uuid::new_v4();
        let token = format!("phase8-cap-{}", Uuid::new_v4());
        let signing = p256::ecdsa::SigningKey::random(&mut rand_core::OsRng);
        register_collab_replica(
            &instance.provider,
            collection,
            replica_id,
            "Participant",
            AwarenessColor::Teal,
            SyncReplicaMode::ReadWrite,
            &token,
            &signing,
            ORIGIN,
        )
        .await;
        put_record(
            &instance.provider,
            collection,
            &token,
            replica_id,
            Uuid::new_v4(),
            "notes/cap.md",
            ORIGIN,
        )
        .await;

        let mut members = Vec::new();
        for _ in 0..4 {
            members.push(
                open_awareness_session(
                    &instance,
                    &http,
                    collection,
                    &token,
                    &signing,
                    ORIGIN,
                    "notes/cap.md",
                    SyncReplicaMode::ReadWrite,
                )
                .await
                .0,
            );
        }
        let (mut observer, snapshot) = open_awareness_session(
            &instance,
            &http,
            collection,
            &token,
            &signing,
            ORIGIN,
            "notes/cap.md",
            SyncReplicaMode::ReadWrite,
        )
        .await;
        assert_eq!(snapshot.unwrap().participants.len(), 4);

        let client = MarkdownBodyDocument::new("", 2 * 1024 * 1024).unwrap();
        observer
            .send(Message::Binary(
                CollaborationFrame {
                    kind: CollaborationMessageKind::SyncStep1,
                    metadata: Default::default(),
                    payload: client.state_vector_v1(),
                }
                .encode()
                .unwrap()
                .into(),
            ))
            .await
            .unwrap();
        loop {
            if recv_any_frame(&mut observer).await.kind == CollaborationMessageKind::SyncStep2 {
                break;
            }
        }

        drop(observer);
        drop(members);
        stop_instance(instance).await;
    })
    .await;
}
