#![allow(clippy::too_many_lines)]

//! Conventional-writer epoch reconciliation acceptance (Phase 5).
//!
//! Every scenario runs sequentially against one disposable PostgreSQL schema:
//! the durable epoch fence is authoritative, conventional writers retire rooms
//! transactionally, and stale epochs are denied everywhere without sleeps.

use super::batches::{
    CollaborationBatchContribution, CollaborationBatchInput, CollaborationBatchReceipt,
};
use super::phase3_batch_tests::NoopBlobStore;
use super::tickets::{CollaborationTicketRequest, IssuedCollaborationTicket};
use super::*;
use crate::provider::mutations::{commit_hosted_write_set_in, HostedWriteOrigin, HostedWriteSet};
use crate::provider::operation_reads::{load_direct_record, DirectRecordIdentity};
use crate::{RoomIdentity, COLLABORATION_PROFILE};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use futures_util::FutureExt;
use mdbase_connect_collaboration::MarkdownBodyDocument;
use mdbase_connect_protocol::{
    CollaborationAccess, ReplicaCollaborationCapability, SyncMutation, SyncMutationOperation,
    SyncMutationReceipt, SyncRecord, SyncReplicaMode, AUTHORITY_PROOF_VERSION,
};
use p256::ecdsa::{signature::Signer, Signature};
use sqlx::{AssertSqlSafe, PgPool};
use std::{collections::BTreeMap, sync::Arc};
use uuid::Uuid;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a disposable MDBASE_COLLABORATION_PHASE3_DATABASE_URL PostgreSQL database"]
async fn phase5_conventional_writer_reconcile_postgres() {
    let base = std::env::var("MDBASE_COLLABORATION_PHASE3_DATABASE_URL").expect("database URL");
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("phase5_reconcile_{}", Uuid::new_v4().simple());
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

struct Harness {
    provider: HostedProvider,
    data_key: [u8; 32],
    collection: Uuid,
    replica: Uuid,
    token: String,
    signing: p256::ecdsa::SigningKey,
    origin: &'static str,
}

impl Harness {
    fn pool(&self) -> &PgPool {
        &self.provider.pool
    }
}

async fn run(base: &str, schema: &str) {
    let separator = if base.contains('?') { '&' } else { '?' };
    let url = format!("{base}{separator}options=-c%20search_path%3D{schema}%2Cpublic");
    let crypto = ProviderCrypto::from_base64(&URL_SAFE_NO_PAD.encode([7_u8; 32])).unwrap();
    let provider = HostedProvider::connect(
        &url,
        crypto,
        ProviderLimits::default(),
        Arc::new(NoopBlobStore),
        None,
    )
    .await
    .unwrap();
    let account = Uuid::new_v4();
    let collection = Uuid::new_v4();
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
        .create_collection(account, collection, "mdbase", "Phase 5 reconcile", "UTC")
        .await
        .unwrap();
    let token = format!("phase5-{}", Uuid::new_v4());
    let signing = p256::ecdsa::SigningKey::random(&mut rand_core::OsRng);
    provider
        .register_replica(
            collection,
            RegisterReplica {
                replica_id: replica,
                name: "phase5 reconcile".into(),
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadWrite,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: vec![
                    "create".into(),
                    "read".into(),
                    "update".into(),
                    "delete".into(),
                ],
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: vec![2],
                file_capability: None,
                collaboration_capability: Some(ReplicaCollaborationCapability {
                    contract_version: 1,
                    profiles: vec![COLLABORATION_PROFILE.into()],
                    access: CollaborationAccess::ReadWrite,
                }),
                allowed_origin: Some("https://phase5.invalid".into()),
                proof_public_key: Some(
                    URL_SAFE_NO_PAD
                        .encode(signing.verifying_key().to_encoded_point(false).as_bytes()),
                ),
                grant_id: Some(Uuid::new_v4()),
                application_declaration_id: Some("dev.phase5.reconcile".into()),
                application_declaration_digest: Some(format!("sha256:{}", "a".repeat(64))),
                token: token.clone(),
                token_ttl_seconds: Some(3600),
            },
        )
        .await
        .unwrap();
    let mut tx = provider.pool.begin().await.unwrap();
    let wrapped: Vec<u8> =
        sqlx::query("SELECT wrapped_data_key FROM hosted_provider_collections WHERE id=$1")
            .bind(collection)
            .fetch_one(&mut *tx)
            .await
            .unwrap()
            .get("wrapped_data_key");
    let data_key = *provider.collection_key(collection, &wrapped).await.unwrap();
    tx.rollback().await.unwrap();
    let harness = Harness {
        provider,
        data_key,
        collection,
        replica,
        token,
        signing,
        origin: "https://phase5.invalid",
    };

    // Ordinary first: the record predates every room, and admission initializes
    // epoch 1 transactionally from the durable fence.
    let first = Uuid::new_v4();
    h_put(
        &harness,
        first,
        "notes/first.md",
        "---\ntitle: first\n---\n\nFirst body\n",
        None,
    )
    .await;
    assert_eq!(h_fence(harness.pool(), first).await, None);
    let issued = h_ticket(&harness, first, "notes/first.md", None).await;
    assert_eq!(issued.metadata.room.epoch, 1);
    assert_eq!(h_fence(harness.pool(), first).await, Some(1));
    assert!(h_document_active(harness.pool(), first, 1).await);
    assert_aggregates(harness.pool()).await;

    // Collaboration first: the room opens before any conventional writer has
    // touched the record since, and a durable CRDT commit must not self-bump
    // the fence.
    let second = Uuid::new_v4();
    h_put(
        &harness,
        second,
        "notes/second.md",
        "---\ntitle: second\n---\n\nSecond body\n",
        None,
    )
    .await;
    let opened = h_open_room(&harness, second, 1).await;
    assert_eq!(opened.identity.epoch, 1);
    let client_update = {
        let mut scratch = MarkdownBodyDocument::from_snapshot(
            &opened.document.snapshot_v1(),
            4 * 1024 * 1024,
            2 * 1024 * 1024,
        )
        .unwrap();
        scratch
            .apply_provider_body("\nSecond body\ncollaborative line\n", 2 * 1024 * 1024)
            .unwrap()
    };
    let mutation = Uuid::new_v4();
    let (receipts, accepted) = h_batch(&harness, second, 1, mutation, client_update.clone()).await;
    assert!(accepted);
    assert_eq!(receipts.len(), 1);
    assert_eq!(h_fence(harness.pool(), second).await, Some(1));
    assert_aggregates(harness.pool()).await;

    // Replay of the same durable contribution is idempotent and never bumps
    // the fence or the collection head.
    let head_after_commit = h_head(harness.pool()).await;
    let (replayed, accepted_replay) =
        h_batch(&harness, second, 1, mutation, client_update.clone()).await;
    assert!(!accepted_replay);
    assert_eq!(
        serde_json::to_value(&replayed).unwrap(),
        serde_json::to_value(&receipts).unwrap()
    );
    assert_eq!(h_fence(harness.pool(), second).await, Some(1));
    assert_eq!(h_head(harness.pool()).await, head_after_commit);

    // A conventional exact update of the collaborated record atomically
    // advances the fence and retires every old room, ticket, update, receipt.
    let second_revision = h_revision(harness.pool(), second).await;
    h_put(
        &harness,
        second,
        "notes/second.md",
        "---\ntitle: second\n---\n\nSecond body\nordinary pass\n",
        Some(second_revision),
    )
    .await;
    assert_eq!(h_fence(harness.pool(), second).await, Some(2));
    assert_room_fully_retired(harness.pool(), second).await;
    assert_aggregates(harness.pool()).await;

    // Requesting either the retired or a future epoch is denied, and no
    // document is resurrected.
    for attempted in [1_u64, 3] {
        let error = h_try_open_room(&harness, second, attempted).await;
        assert_eq!(error.code, "collaboration_epoch_stale");
    }

    // Rolling back a conventional writer must roll back the fence advance and
    // the retirement together.
    let head_before_rollback = h_head(harness.pool()).await;
    let mut rolled = harness.provider.pool.begin().await.unwrap();
    let (current, _, _): (SyncRecord, u64, chrono::DateTime<chrono::Utc>) = load_direct_record(
        &mut rolled,
        &harness.provider.crypto,
        &harness.data_key,
        harness.collection,
        DirectRecordIdentity::StableId(second),
    )
    .await
    .unwrap()
    .unwrap();
    let mut edited = current.clone();
    edited.body = "\nSecond body\nordinary pass\nrolled back line\n".into();
    let edited_document = format!("---\ntitle: second\n---\n{}", edited.body);
    edited.document = edited_document.clone();
    edited.revision = format!("hosted:rollback:{}", Uuid::new_v4());
    let collection_row = sqlx::query(
        "SELECT head, record_count, content_bytes, max_records, max_content_bytes,
                max_document_bytes, resource_revision, resources_ciphertext,
                active_projection_generation_id
         FROM hosted_provider_collections WHERE id = $1 AND state = 'active' FOR UPDATE",
    )
    .bind(harness.collection)
    .fetch_one(&mut *rolled)
    .await
    .unwrap();
    let _committed = commit_hosted_write_set_in(
        &mut rolled,
        &harness.provider,
        harness.collection,
        &harness.data_key,
        &collection_row,
        None,
        HostedWriteSet {
            origin: HostedWriteOrigin::Conventional,
            before_records: BTreeMap::from([(second, current)]),
            changed: vec![(second, Some(edited), Some(edited_document))],
            primary_record_id: second,
        },
        false,
    )
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT current_epoch FROM hosted_provider_collaboration_epoch_fences WHERE record_id=$1",
        )
        .bind(second)
        .fetch_one(&mut *rolled)
        .await
        .unwrap(),
        3,
        "fence advanced inside the open transaction"
    );
    drop(_committed);
    rolled.rollback().await.unwrap();
    assert_eq!(h_fence(harness.pool(), second).await, Some(2));
    assert_eq!(h_head(harness.pool()).await, head_before_rollback);

    // An ordinary body the collaboration profile cannot admit still commits;
    // the fenced epoch simply waits, and admission fails closed until the body
    // becomes representable again.
    let third = Uuid::new_v4();
    h_put(
        &harness,
        third,
        "notes/third.md",
        "---\ntitle: third\n---\n\nThird body\n",
        None,
    )
    .await;
    let third_room = h_open_room(&harness, third, 1).await;
    h_put(
        &harness,
        third,
        "notes/third.md",
        "---\ntitle: third\n---\r\n\r\nWindows\r\nlines\u{0}here\n",
        Some(third_room.record.revision.clone()),
    )
    .await;
    assert_eq!(h_fence(harness.pool(), third).await, Some(2));
    assert_room_fully_retired(harness.pool(), third).await;
    let admission = h_try_ticket(&harness, third, "notes/third.md").await;
    assert_eq!(admission.code, "invalid_collaboration_state");
    assert_eq!(h_fence(harness.pool(), third).await, Some(2));
    assert_room_fully_retired(harness.pool(), third).await;
    assert_aggregates(harness.pool()).await;

    // Deleting and recreating the same stable record id keeps the advanced
    // fence; nothing can reopen the retired epoch.
    let fourth = Uuid::new_v4();
    h_put(
        &harness,
        fourth,
        "notes/fourth.md",
        "---\ntitle: fourth\n---\n\nFourth body\n",
        None,
    )
    .await;
    let fourth_room = h_open_room(&harness, fourth, 1).await;
    h_delete(
        &harness,
        fourth,
        "notes/fourth.md",
        &fourth_room.record.revision,
    )
    .await;
    assert_eq!(h_fence(harness.pool(), fourth).await, Some(2));
    assert_room_fully_retired(harness.pool(), fourth).await;
    h_put(
        &harness,
        fourth,
        "notes/fourth.md",
        "---\ntitle: fourth\n---\n\nRecreated body\n",
        None,
    )
    .await;
    assert_eq!(h_fence(harness.pool(), fourth).await, Some(2));
    let recreated = h_ticket(&harness, fourth, "notes/fourth.md", None).await;
    assert_eq!(recreated.metadata.room.epoch, 2);
    let stale_request_error = h_try_ticket_epoch(&harness, fourth, "notes/fourth.md", 1).await;
    assert_eq!(stale_request_error.code, "collaboration_epoch_stale");

    // Collaborative work on the reopened room never moves the fence, and the
    // live session reauthorizes against fence, document, and record revision.
    let room_two = h_open_room(&harness, fourth, 2).await;
    let second_round = {
        let mut scratch = MarkdownBodyDocument::from_snapshot(
            &room_two.document.snapshot_v1(),
            4 * 1024 * 1024,
            2 * 1024 * 1024,
        )
        .unwrap();
        scratch
            .apply_provider_body("\nRecreated body\ncollab again\n", 2 * 1024 * 1024)
            .unwrap()
    };
    let (round_receipts, accepted_round) =
        h_batch(&harness, fourth, 2, Uuid::new_v4(), second_round.clone()).await;
    assert!(accepted_round);
    assert_eq!(round_receipts.len(), 1);
    assert_eq!(h_fence(harness.pool(), fourth).await, Some(2));
    harness
        .provider
        .reauthorize_collaboration_session(room_two.identity, harness.replica, 1)
        .await
        .unwrap();

    // A ticket minted for the current epoch becomes unconsumable once a
    // conventional writer advances the fence.
    let doomed = h_ticket(&harness, fourth, "notes/fourth.md", Some(2)).await;
    let current_revision = h_revision(harness.pool(), fourth).await;
    h_put(
        &harness,
        fourth,
        "notes/fourth.md",
        "---\ntitle: fourth\n---\n\nRecreated body\nordinary wins\n",
        Some(current_revision),
    )
    .await;
    assert_eq!(h_fence(harness.pool(), fourth).await, Some(3));
    assert!(harness
        .provider
        .consume_collaboration_ticket(&doomed.plaintext, Some(harness.origin))
        .await
        .is_err());
    assert_room_fully_retired(harness.pool(), fourth).await;

    // A stale epoch is denied for batches and live sessions alike.
    let stale_batch = harness
        .provider
        .commit_collaboration_batch(CollaborationBatchInput {
            collection_id: harness.collection,
            record_id: fourth,
            epoch: 2,
            contributions: vec![CollaborationBatchContribution {
                replica_id: harness.replica,
                expected_scope_epoch: 1,
                client_mutation_id: Uuid::new_v4(),
                update: second_round,
            }],
        })
        .await
        .unwrap_err();
    assert_eq!(stale_batch.code, "collaboration_epoch_stale");

    let stale_session =
        RoomIdentity::new(harness.collection, fourth, 2, COLLABORATION_PROFILE).unwrap();
    let session_error = harness
        .provider
        .reauthorize_collaboration_session(stale_session, harness.replica, 1)
        .await
        .unwrap_err();
    assert_eq!(session_error.code, "collaboration_scope_denied");

    // Stale conditional sync mutations keep their conflicted semantics.
    let conflict = h_put_conflicted(&harness, fourth, "notes/fourth.md", "stale-revision").await;
    assert!(matches!(conflict, SyncMutationReceipt::Conflicted { .. }));

    // The database itself rejects a stale-epoch document insert immediately.
    let fk_error = sqlx::query(
        "INSERT INTO hosted_provider_collaboration_documents
         (collection_id, record_id, collaboration_epoch, profile,
          snapshot_ciphertext, state_vector_ciphertext, materialized_revision)
         VALUES ($1,$2,$3,$4,$5,$6,'stale')",
    )
    .bind(harness.collection)
    .bind(fourth)
    .bind(2_i64)
    .bind(COLLABORATION_PROFILE)
    .bind([1_u8; 4].as_slice())
    .bind([2_u8; 4].as_slice())
    .execute(harness.pool())
    .await
    .unwrap_err();
    assert!(
        fk_error
            .as_database_error()
            .map(|error| error.is_foreign_key_violation())
            .unwrap_or(false),
        "expected FK rejection, got {fk_error}"
    );

    // Mutation replay through the ordinary path neither bumps the fence nor
    // the head.
    let replay_record = Uuid::new_v4();
    let replay_mutation = SyncMutation {
        mutation_id: Uuid::new_v4(),
        replica_id: harness.replica,
        scope_epoch: 1,
        operation: SyncMutationOperation::Put,
        record_id: replay_record,
        base_revision: None,
        path: Some("notes/replay.md".into()),
        document: Some("---\ntitle: replay\n---\n\nReplay body\n".into()),
        created_at: chrono::Utc::now().to_rfc3339(),
        causal_predecessor: None,
    };
    let first_receipt = harness
        .provider
        .mutate(
            harness.collection,
            &harness.token,
            replay_mutation.clone(),
            Some(harness.origin),
        )
        .await
        .unwrap();
    let head_after_first = h_head(harness.pool()).await;
    let replayed_receipt = harness
        .provider
        .mutate(
            harness.collection,
            &harness.token,
            replay_mutation,
            Some(harness.origin),
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&first_receipt).unwrap(),
        serde_json::to_value(&replayed_receipt).unwrap()
    );
    assert_eq!(h_head(harness.pool()).await, head_after_first);
    assert_eq!(h_fence(harness.pool(), replay_record).await, None);
    assert_aggregates(harness.pool()).await;

    harness.provider.pool.close().await;
}

async fn h_head(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT head FROM hosted_provider_collections")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn h_fence(pool: &PgPool, record: Uuid) -> Option<i64> {
    sqlx::query_scalar(
        "SELECT f.current_epoch
         FROM hosted_provider_collaboration_epoch_fences f
         JOIN hosted_provider_collections c ON c.id = f.collection_id
         WHERE f.record_id = $1",
    )
    .bind(record)
    .fetch_optional(pool)
    .await
    .unwrap()
}

async fn h_document_active(pool: &PgPool, record: Uuid, epoch: i64) -> bool {
    sqlx::query_scalar::<_, Option<String>>(
        "SELECT d.state FROM hosted_provider_collaboration_epoch_fences f
         JOIN hosted_provider_collections c ON c.id = f.collection_id
         LEFT JOIN hosted_provider_collaboration_documents d
           ON d.collection_id = f.collection_id AND d.record_id = f.record_id
          AND d.collaboration_epoch = $2 AND d.profile = $3
         WHERE f.record_id = $1",
    )
    .bind(record)
    .bind(epoch)
    .bind(COLLABORATION_PROFILE)
    .fetch_one(pool)
    .await
    .unwrap()
    .as_deref()
        == Some("active")
}

/// Documents, updates, receipts, and tickets must all be gone together.
async fn assert_room_fully_retired(pool: &PgPool, record: Uuid) {
    let (docs, updates, receipts, tickets): (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM hosted_provider_collaboration_documents WHERE record_id=$1),
                (SELECT count(*) FROM hosted_provider_collaboration_updates WHERE record_id=$1),
                (SELECT count(*) FROM hosted_provider_collaboration_receipts WHERE record_id=$1),
                (SELECT count(*) FROM hosted_provider_collaboration_tickets WHERE record_id=$1)",
    )
    .bind(record)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!((docs, updates, receipts, tickets), (0, 0, 0, 0));
}

/// Collection and account aggregates always equal the ciphertext-derived sum.
async fn assert_aggregates(pool: &PgPool) {
    let row: (i64, i64, i64) = sqlx::query_as(
        "SELECT COALESCE((
             SELECT sum(octet_length(d.snapshot_ciphertext) + octet_length(d.state_vector_ciphertext)
                    + COALESCE((SELECT sum(octet_length(u.update_ciphertext)) FROM hosted_provider_collaboration_updates u WHERE u.collection_id=d.collection_id AND u.record_id=d.record_id AND u.collaboration_epoch=d.collaboration_epoch AND u.profile=d.profile),0)
                    + COALESCE((SELECT sum(octet_length(r.receipt_ciphertext)) FROM hosted_provider_collaboration_receipts r WHERE r.collection_id=d.collection_id AND r.record_id=d.record_id AND r.collaboration_epoch=d.collaboration_epoch AND r.profile=d.profile),0))::bigint
             FROM hosted_provider_collaboration_documents d), 0),
            (SELECT collaboration_bytes FROM hosted_provider_collections LIMIT 1),
            (SELECT live_collaboration_bytes FROM hosted_provider_accounts LIMIT 1)",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    let (derived, collection_total, account_total) = row;
    assert_eq!(collection_total, derived, "collection aggregate drifted");
    assert_eq!(account_total, derived, "account aggregate drifted");
}

async fn h_revision(pool: &PgPool, record: Uuid) -> String {
    sqlx::query_scalar("SELECT revision FROM hosted_provider_records WHERE record_id = $1")
        .bind(record)
        .fetch_one(pool)
        .await
        .unwrap()
}

fn h_mutation(
    harness: &Harness,
    record: Uuid,
    path: &str,
    document: &str,
    base_revision: Option<String>,
) -> SyncMutation {
    SyncMutation {
        mutation_id: Uuid::new_v4(),
        replica_id: harness.replica,
        scope_epoch: 1,
        operation: SyncMutationOperation::Put,
        record_id: record,
        base_revision,
        path: Some(path.into()),
        document: Some(document.into()),
        created_at: chrono::Utc::now().to_rfc3339(),
        causal_predecessor: None,
    }
}

async fn h_put(
    harness: &Harness,
    record: Uuid,
    path: &str,
    document: &str,
    base_revision: Option<String>,
) -> SyncRecord {
    let mutation = h_mutation(harness, record, path, document, base_revision);
    match harness
        .provider
        .mutate(
            harness.collection,
            &harness.token,
            mutation,
            Some(harness.origin),
        )
        .await
        .unwrap()
    {
        SyncMutationReceipt::Applied { record, .. } => record.unwrap(),
        other => panic!("expected applied put, got {other:?}"),
    }
}

async fn h_delete(harness: &Harness, record: Uuid, path: &str, base_revision: &str) {
    let mutation = SyncMutation {
        mutation_id: Uuid::new_v4(),
        replica_id: harness.replica,
        scope_epoch: 1,
        operation: SyncMutationOperation::Delete,
        record_id: record,
        base_revision: Some(base_revision.into()),
        path: Some(path.into()),
        document: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        causal_predecessor: None,
    };
    match harness
        .provider
        .mutate(
            harness.collection,
            &harness.token,
            mutation,
            Some(harness.origin),
        )
        .await
        .unwrap()
    {
        SyncMutationReceipt::Applied { .. } => {}
        other => panic!("expected applied delete, got {other:?}"),
    }
}

async fn h_put_conflicted(
    harness: &Harness,
    record: Uuid,
    path: &str,
    stale_revision: &str,
) -> SyncMutationReceipt {
    let mutation = h_mutation(
        harness,
        record,
        path,
        "---\ntitle: fourth\n---\n\nNever applied\n",
        Some(stale_revision.into()),
    );
    harness
        .provider
        .mutate(
            harness.collection,
            &harness.token,
            mutation,
            Some(harness.origin),
        )
        .await
        .unwrap()
}

async fn h_ticket(
    harness: &Harness,
    record: Uuid,
    path: &str,
    epoch: Option<u64>,
) -> IssuedCollaborationTicket {
    h_try_issue(harness, record, path, epoch).await.unwrap()
}

async fn h_try_issue(
    harness: &Harness,
    _record: Uuid,
    path: &str,
    epoch: Option<u64>,
) -> ApiResult<IssuedCollaborationTicket> {
    harness
        .provider
        .issue_collaboration_ticket(
            harness.collection,
            &harness.token,
            CollaborationTicketRequest {
                path: path.into(),
                profile: COLLABORATION_PROFILE.into(),
                mode: crate::CollaborationMode::ReadWrite,
                epoch,
            },
            Some(harness.origin),
            Some(&h_signed_proof(&harness.signing, &harness.token)),
        )
        .await
}

async fn h_try_ticket(harness: &Harness, record: Uuid, path: &str) -> ApiError {
    match h_try_issue(harness, record, path, None).await {
        Ok(_) => panic!("ticket issuance unexpectedly succeeded"),
        Err(error) => error,
    }
}

async fn h_try_ticket_epoch(harness: &Harness, record: Uuid, path: &str, epoch: u64) -> ApiError {
    match h_try_issue(harness, record, path, Some(epoch)).await {
        Ok(_) => panic!("ticket issuance unexpectedly succeeded"),
        Err(error) => error,
    }
}

async fn h_open_room(harness: &Harness, record: Uuid, epoch: u64) -> CollaborationRoom {
    let mut tx = harness.provider.pool.begin().await.unwrap();
    let room = harness
        .provider
        .load_collaboration_room_in(
            &mut tx,
            &harness.data_key,
            RoomIdentity::new(harness.collection, record, epoch, COLLABORATION_PROFILE).unwrap(),
        )
        .await
        .unwrap();
    tx.commit().await.unwrap();
    room
}

async fn h_try_open_room(harness: &Harness, record: Uuid, epoch: u64) -> ApiError {
    let mut tx = harness.provider.pool.begin().await.unwrap();
    let error = match harness
        .provider
        .load_collaboration_room_in(
            &mut tx,
            &harness.data_key,
            RoomIdentity::new(harness.collection, record, epoch, COLLABORATION_PROFILE).unwrap(),
        )
        .await
    {
        Ok(_) => panic!("room load unexpectedly succeeded"),
        Err(error) => error,
    };
    tx.rollback().await.unwrap();
    error
}
async fn h_batch(
    harness: &Harness,
    record: Uuid,
    epoch: u64,
    client_mutation_id: Uuid,
    update: Vec<u8>,
) -> (Vec<CollaborationBatchReceipt>, bool) {
    let mut tx = harness.provider.pool.begin().await.unwrap();
    let result = harness
        .provider
        .commit_collaboration_batch_result_in(
            &mut tx,
            CollaborationBatchInput {
                collection_id: harness.collection,
                record_id: record,
                epoch,
                contributions: vec![CollaborationBatchContribution {
                    replica_id: harness.replica,
                    expected_scope_epoch: 1,
                    client_mutation_id,
                    update,
                }],
            },
        )
        .await
        .unwrap();
    tx.commit().await.unwrap();
    result
}

fn h_signed_proof(signing: &p256::ecdsa::SigningKey, token: &str) -> AuthorityRequestProof {
    let mut proof = AuthorityRequestProof {
        version: AUTHORITY_PROOF_VERSION,
        timestamp: chrono::Utc::now().timestamp(),
        nonce: Uuid::new_v4(),
        signature: String::new(),
        method: "POST".into(),
        target: "/v1/authorities/example/collaboration/tickets".into(),
        body: br#"{"profile":"markdown-body-yjs-v13"}"#.to_vec(),
    };
    let signature: Signature = signing.sign(authority_proof_message(token, &proof).as_bytes());
    proof.signature = URL_SAFE_NO_PAD.encode(signature.to_bytes());
    proof
}
