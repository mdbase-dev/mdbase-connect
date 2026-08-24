#![allow(clippy::too_many_lines)]

//! Phase 6 acceptance, part 1: transactional wakeup semantics.
//!
//! The private commit channel must carry exactly the metadata allowlist, be
//! visible only after the batch transaction commits, and stay silent for
//! rollbacks and all-replay batches.

use super::batches::{CollaborationBatchContribution, CollaborationBatchInput};
use super::phase3_batch_tests::NoopBlobStore;

use super::*;
use crate::{RoomIdentity, COLLABORATION_PROFILE};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use futures_util::FutureExt;
use mdbase_connect_collaboration::MarkdownBodyDocument;
use mdbase_connect_protocol::{
    AwarenessColor, CollaborationAccess, ReplicaAwarenessIdentity, ReplicaCollaborationCapability,
    SyncMutation, SyncMutationOperation, SyncReplicaMode,
};
use sqlx::postgres::PgListener;
use sqlx::AssertSqlSafe;
use std::{sync::Arc, time::Duration};
use uuid::Uuid;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a disposable MDBASE_COLLABORATION_PHASE3_DATABASE_URL PostgreSQL database"]
async fn phase6_commit_notice_transactional_semantics_postgres() {
    let base = std::env::var("MDBASE_COLLABORATION_PHASE3_DATABASE_URL").expect("database URL");
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("phase6_wake_{}", Uuid::new_v4().simple());
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

async fn run(base: &str, schema: &str) {
    let separator = if base.contains('?') { '&' } else { '?' };
    let url = format!("{base}{separator}options=-c%20search_path%3D{schema}%2Cpublic");
    let crypto = ProviderCrypto::from_base64(&URL_SAFE_NO_PAD.encode([7_u8; 32])).unwrap();
    let limits = ProviderLimits {
        hosted_collaboration_enabled: true,
        ..ProviderLimits::default()
    };
    let provider = HostedProvider::connect(&url, crypto, limits, Arc::new(NoopBlobStore), None)
        .await
        .unwrap();

    let account = Uuid::new_v4();
    let collection = Uuid::new_v4();
    let record = Uuid::new_v4();
    let replica = Uuid::new_v4();
    provider
        .upsert_account(
            account,
            1,
            ProviderAccountLimits {
                hosted_storage_bytes: 1 << 20,
                retained_file_bytes: 1 << 20,
                max_document_bytes: 1 << 20,
                max_single_file_bytes: 1 << 20,
                max_mirror_replicas_per_collection: 2,
                max_application_replicas_per_collection: 2,
                max_hosted_collections: 2,
                max_files_per_collection: 2,
            },
        )
        .await
        .unwrap();
    provider
        .create_collection(account, collection, "mdbase", "Phase 6 wake", "UTC")
        .await
        .unwrap();
    let signing = p256::ecdsa::SigningKey::random(&mut rand_core::OsRng);
    let token = format!("phase6-wake-{}", Uuid::new_v4());
    provider
        .register_replica(
            collection,
            RegisterReplica {
                replica_id: replica,
                name: "phase6 wake".into(),
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadWrite,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: vec!["create".into(), "read".into(), "update".into()],
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: vec![2],
                file_capability: None,

                awareness_identity: Some(ReplicaAwarenessIdentity {
                    name: "Participant".into(),
                    color: AwarenessColor::Slate,
                }),
                collaboration_capability: Some(ReplicaCollaborationCapability {
                    contract_version: 1,
                    profiles: vec![COLLABORATION_PROFILE.into()],
                    access: CollaborationAccess::ReadWrite,
                }),
                allowed_origin: Some("https://phase6.invalid".into()),
                proof_public_key: Some(
                    URL_SAFE_NO_PAD
                        .encode(signing.verifying_key().to_encoded_point(false).as_bytes()),
                ),
                grant_id: Some(Uuid::new_v4()),
                application_declaration_id: Some("dev.phase6.wake".into()),
                application_declaration_digest: Some(format!("sha256:{}", "a".repeat(64))),
                token: token.clone(),
                token_ttl_seconds: Some(3600),
            },
        )
        .await
        .unwrap();
    provider
        .mutate(
            collection,
            &token,
            SyncMutation {
                mutation_id: Uuid::new_v4(),
                replica_id: replica,
                scope_epoch: 1,
                operation: SyncMutationOperation::Put,
                record_id: record,
                base_revision: None,
                path: Some("notes/wake.md".into()),
                document: Some("---\ntitle: wake\n---\n\nWake body\n".into()),
                created_at: chrono::Utc::now().to_rfc3339(),
                causal_predecessor: None,
            },
            Some("https://phase6.invalid"),
        )
        .await
        .unwrap();
    let wrapped: Vec<u8> =
        sqlx::query_scalar("SELECT wrapped_data_key FROM hosted_provider_collections WHERE id=$1")
            .bind(collection)
            .fetch_one(&provider.pool)
            .await
            .unwrap();
    let data_key = *provider.collection_key(collection, &wrapped).await.unwrap();

    // Independent observer on its own connection.
    let mut observer = PgListener::connect(&url).await.unwrap();
    observer
        .listen(super::wakes::COLLABORATION_COMMIT_CHANNEL)
        .await
        .unwrap();

    let room = RoomIdentity::new(collection, record, 1, COLLABORATION_PROFILE).unwrap();

    // Open the room so the batch engine has durable state to append to.
    let mut setup = provider.pool.begin().await.unwrap();
    let opened = provider
        .load_collaboration_room_in(&mut setup, &data_key, room)
        .await
        .unwrap();
    setup.commit().await.unwrap();
    let mut scratch = MarkdownBodyDocument::from_snapshot(
        &opened.document.snapshot_v1(),
        4 * 1024 * 1024,
        2 * 1024 * 1024,
    )
    .unwrap();
    let accepted_update = scratch
        .apply_provider_body("\nWake body\nnotice line\n", 2 * 1024 * 1024)
        .unwrap();
    let mutation_one = Uuid::new_v4();
    let input_one = CollaborationBatchInput {
        collection_id: collection,
        record_id: record,
        epoch: 1,
        contributions: vec![CollaborationBatchContribution {
            replica_id: replica,
            expected_scope_epoch: 1,
            expected_token_hash: token_hash(&token).try_into().unwrap(),
            client_mutation_id: mutation_one,
            update: accepted_update.clone(),
        }],
    };

    // An in-flight accepted batch emits no notice until commit.
    let mut inflight = provider.pool.begin().await.unwrap();
    provider
        .commit_collaboration_batch_result_in(&mut inflight, input_one.clone())
        .await
        .unwrap();
    assert!(
        observer_try_recv(&mut observer).await.is_none(),
        "notification leaked before commit"
    );
    inflight.commit().await.unwrap();
    let notice = observer_try_recv(&mut observer)
        .await
        .expect("committed batch emitted no notice");
    assert_eq!(notice.channel(), super::wakes::COLLABORATION_COMMIT_CHANNEL);
    let payload = notice.payload();
    let value: serde_json::Value = serde_json::from_str(payload).expect("payload is strict JSON");
    let mut keys: Vec<_> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "collaboration_epoch",
            "collection_id",
            "profile",
            "record_id",
            "sequence"
        ],
        "notice payload carried fields beyond the metadata allowlist"
    );
    assert_eq!(value["collection_id"], collection.to_string());
    assert_eq!(value["record_id"], record.to_string());
    assert_eq!(value["collaboration_epoch"], 1);
    assert_eq!(value["profile"], COLLABORATION_PROFILE);
    assert_eq!(value["sequence"], 1);
    // Nothing identifying or content-bearing may appear anywhere in the
    // payload: not the mutation id, not the path, not any body text.
    assert!(!payload.contains(&mutation_one.to_string()));
    assert!(!payload.contains("notes/wake.md"));
    assert!(!payload.contains("Wake body"));
    assert!(!payload.contains("digest"));
    assert!(!payload.contains("revision"));
    assert!(!payload.contains("replica_id"));

    // A rolled-back batch emits nothing. The contribution is built from the
    // freshly committed state so only its rollback differs from a real batch.
    let mut fresh = provider.pool.begin().await.unwrap();
    let committed_room = provider
        .load_collaboration_room_in(&mut fresh, &data_key, room)
        .await
        .unwrap();
    fresh.commit().await.unwrap();
    let rollback_update = MarkdownBodyDocument::from_snapshot(
        &committed_room.document.snapshot_v1(),
        4 * 1024 * 1024,
        2 * 1024 * 1024,
    )
    .unwrap()
    .apply_provider_body(
        "\nWake body\nnotice line\nrolled back line\n",
        2 * 1024 * 1024,
    )
    .unwrap();
    let mut rolled_back = provider.pool.begin().await.unwrap();
    provider
        .commit_collaboration_batch_result_in(
            &mut rolled_back,
            CollaborationBatchInput {
                contributions: vec![CollaborationBatchContribution {
                    client_mutation_id: Uuid::new_v4(),
                    update: rollback_update,
                    ..input_one.contributions[0].clone()
                }],
                ..input_one.clone()
            },
        )
        .await
        .unwrap();
    rolled_back.rollback().await.unwrap();
    assert!(
        observer_try_recv(&mut observer).await.is_none(),
        "rollback emitted a notice"
    );

    // An all-replay committed batch emits nothing either.
    let mut replay = provider.pool.begin().await.unwrap();
    let (_, accepted_again) = provider
        .commit_collaboration_batch_result_in(&mut replay, input_one.clone())
        .await
        .unwrap();
    assert!(!accepted_again, "replay was treated as newly accepted");
    replay.commit().await.unwrap();
    assert!(
        observer_try_recv(&mut observer).await.is_none(),
        "replay emitted a notice"
    );

    provider.pool.close().await;
}

/// Non-blocking observation window for the independent listener.
async fn observer_try_recv(listener: &mut PgListener) -> Option<sqlx::postgres::PgNotification> {
    tokio::time::timeout(Duration::from_millis(400), listener.recv())
        .await
        .ok()?
        .ok()
}
