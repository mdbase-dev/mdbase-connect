#![allow(clippy::too_many_lines)]

use super::batches::{CollaborationBatchContribution, CollaborationBatchInput};
use super::tickets::CollaborationTicketRequest;
use super::*;
use crate::{BlobByteStream, PresignedPart, RoomIdentity, UploadedPart, COLLABORATION_PROFILE};
use async_trait::async_trait;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use futures_util::{stream, FutureExt};
use mdbase_connect_collaboration::MarkdownBodyDocument;
use mdbase_connect_protocol::{
    CollaborationAccess, ReplicaCollaborationCapability, SyncMutation, SyncMutationOperation,
    SyncReplicaMode, AUTHORITY_PROOF_VERSION,
};
use p256::ecdsa::{signature::Signer, Signature};
use sqlx::AssertSqlSafe;
use std::{collections::BTreeMap, sync::Arc};
use uuid::Uuid;

#[derive(Clone, Default)]
pub(super) struct NoopBlobStore;
#[async_trait]
impl BlobStore for NoopBlobStore {
    fn upload_part_size(&self) -> u64 {
        5 * 1024 * 1024
    }
    fn download_part_size(&self) -> u64 {
        5 * 1024 * 1024
    }
    async fn ready(&self) -> ApiResult<()> {
        Ok(())
    }
    async fn create_multipart(&self, _: &str) -> ApiResult<String> {
        Ok("noop".into())
    }
    async fn presign_put(&self, _: &str, _: u64) -> ApiResult<PresignedPart> {
        Ok(part())
    }
    async fn presign_part(&self, _: &str, _: &str, _: i32, _: u64) -> ApiResult<PresignedPart> {
        Ok(part())
    }
    async fn complete_multipart(&self, _: &str, _: &str, _: &[UploadedPart]) -> ApiResult<()> {
        Ok(())
    }
    async fn list_multipart_parts(&self, _: &str, _: &str) -> ApiResult<Vec<UploadedPart>> {
        Ok(Vec::new())
    }
    async fn abort_multipart(&self, _: &str, _: &str) -> ApiResult<()> {
        Ok(())
    }
    async fn object_exists(&self, _: &str) -> ApiResult<bool> {
        Ok(false)
    }
    async fn copy(&self, _: &str, _: &str) -> ApiResult<()> {
        Ok(())
    }
    async fn verify_object(&self, _: &str, _: u64, _: &str) -> ApiResult<()> {
        Ok(())
    }
    async fn read_range(&self, _: &str, _: u64, _: u64) -> ApiResult<BlobByteStream> {
        Ok(Box::pin(stream::empty()))
    }
    async fn delete(&self, _: &str) -> ApiResult<()> {
        Ok(())
    }
}
fn part() -> PresignedPart {
    PresignedPart {
        method: "PUT".into(),
        url: "https://invalid".into(),
        headers: BTreeMap::new(),
        expires_at: chrono::Utc::now(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a disposable MDBASE_COLLABORATION_PHASE3_DATABASE_URL PostgreSQL database"]
async fn phase3_batch_engine_postgres() {
    let base = std::env::var("MDBASE_COLLABORATION_PHASE3_DATABASE_URL").expect("database URL");
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("phase3_batch_{}", Uuid::new_v4().simple());
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
    let mut limits = ProviderLimits::default();
    limits.collaboration.ticket_ttl_seconds = 1;
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
        .create_collection(account, collection, "mdbase", "Phase 3", "UTC")
        .await
        .unwrap();
    let token = format!("phase3-{}", Uuid::new_v4());
    let signing = p256::ecdsa::SigningKey::random(&mut rand_core::OsRng);
    provider
        .register_replica(
            collection,
            RegisterReplica {
                replica_id: replica,
                name: "phase3 test app".into(),
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
                allowed_origin: Some("https://phase3.invalid".into()),
                proof_public_key: Some(
                    URL_SAFE_NO_PAD
                        .encode(signing.verifying_key().to_encoded_point(false).as_bytes()),
                ),
                grant_id: Some(Uuid::new_v4()),
                application_declaration_id: Some("dev.phase3.batch".into()),
                application_declaration_digest: Some(format!("sha256:{}", "a".repeat(64))),
                token: token.clone(),
                token_ttl_seconds: Some(3600),
            },
        )
        .await
        .unwrap();
    let document = "---\ntitle: \"Δ Unicode\"\ntags: [é]\n---\n\nBody — 初めまして\n";
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
                path: Some("notes/é.md".into()),
                document: Some(document.into()),
                created_at: chrono::Utc::now().to_rfc3339(),
                causal_predecessor: None,
            },
            Some("https://phase3.invalid"),
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
    let key = provider.collection_key(collection, &wrapped).await.unwrap();
    let room = provider
        .load_collaboration_room_in(
            &mut tx,
            &key,
            RoomIdentity::new(collection, record, 1, COLLABORATION_PROFILE).unwrap(),
        )
        .await
        .unwrap();
    let mut edited = MarkdownBodyDocument::from_snapshot(
        &room.document.snapshot_v1(),
        4 * 1024 * 1024,
        2 * 1024 * 1024,
    )
    .unwrap();
    let update = edited
        .apply_provider_body("Body — 初めまして\n追加された本文 🌍\n", 2 * 1024 * 1024)
        .unwrap();
    let mutation = Uuid::new_v4();
    let receipt = provider
        .commit_collaboration_batch_in(
            &mut tx,
            CollaborationBatchInput {
                collection_id: collection,
                record_id: record,
                epoch: 1,
                contributions: vec![CollaborationBatchContribution {
                    replica_id: replica,
                    expected_scope_epoch: 1,
                    client_mutation_id: mutation,
                    update: update.clone(),
                }],
            },
        )
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(receipt.len(), 1);
    assert_eq!(receipt[0].sequence, 1);
    let retry = {
        let mut tx = provider.pool.begin().await.unwrap();
        let r = provider
            .commit_collaboration_batch_in(
                &mut tx,
                CollaborationBatchInput {
                    collection_id: collection,
                    record_id: record,
                    epoch: 1,
                    contributions: vec![CollaborationBatchContribution {
                        replica_id: replica,
                        expected_scope_epoch: 1,
                        client_mutation_id: mutation,
                        update: update.clone(),
                    }],
                },
            )
            .await
            .unwrap();
        tx.commit().await.unwrap();
        r
    };
    assert_eq!(retry, receipt);
    let mut next = provider.pool.begin().await.unwrap();
    let reloaded = provider
        .load_collaboration_room_in(
            &mut next,
            &key,
            RoomIdentity::new(collection, record, 1, COLLABORATION_PROFILE).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        reloaded.record.document,
        "---\ntitle: \"Δ Unicode\"\ntags: [é]\n---\nBody — 初めまして\n追加された本文 🌍\n"
    );
    assert_eq!(
        reloaded.document.body(),
        "Body — 初めまして\n追加された本文 🌍\n"
    );
    next.rollback().await.unwrap();
    let (head, changes, updates, receipts): (i64, i64, i64, i64) = sqlx::query_as("SELECT c.head, (SELECT count(*) FROM hosted_provider_changes WHERE collection_id=$1), (SELECT count(*) FROM hosted_provider_collaboration_updates WHERE collection_id=$1), (SELECT count(*) FROM hosted_provider_collaboration_receipts WHERE collection_id=$1) FROM hosted_provider_collections c WHERE c.id=$1").bind(collection).fetch_one(&provider.pool).await.unwrap();
    assert_eq!((head, changes, updates, receipts), (2, 2, 1, 1));
    let (revision, versions, update_bytes, receipt_bytes): (String, i64, i32, i32) = sqlx::query_as("SELECT r.revision, (SELECT count(*) FROM hosted_provider_record_versions WHERE collection_id=$1 AND record_id=$2), (SELECT octet_length(update_ciphertext) FROM hosted_provider_collaboration_updates WHERE collection_id=$1 AND record_id=$2), (SELECT octet_length(receipt_ciphertext) FROM hosted_provider_collaboration_receipts WHERE collection_id=$1 AND record_id=$2) FROM hosted_provider_records r WHERE r.collection_id=$1 AND r.record_id=$2").bind(collection).bind(record).fetch_one(&provider.pool).await.unwrap();
    assert!(!revision.is_empty());
    assert_eq!(versions, 2);
    assert!(update_bytes > 0 && receipt_bytes > 0);
    let update_constraints: Vec<String> = sqlx::query_scalar(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='hosted_provider_collaboration_updates'::regclass AND contype='u' ORDER BY conname",
    )
    .fetch_all(&provider.pool)
    .await
    .unwrap();
    assert!(update_constraints.iter().any(|definition| definition == "UNIQUE (collection_id, record_id, collaboration_epoch, profile, replica_id, client_mutation_id)"), "constraints: {update_constraints:?}");
    assert!(!update_constraints.iter().any(|definition| definition.contains("update_digest") || definition == "UNIQUE (collection_id, record_id, collaboration_epoch, profile, client_mutation_id)"), "constraints: {update_constraints:?}");
    let same_update = {
        let mut tx = provider.pool.begin().await.unwrap();
        let r = provider
            .commit_collaboration_batch_in(
                &mut tx,
                CollaborationBatchInput {
                    collection_id: collection,
                    record_id: record,
                    epoch: 1,
                    contributions: vec![CollaborationBatchContribution {
                        replica_id: replica,
                        expected_scope_epoch: 1,
                        client_mutation_id: Uuid::new_v4(),
                        update: update.clone(),
                    }],
                },
            )
            .await
            .unwrap();
        tx.commit().await.unwrap();
        r
    };
    assert_eq!(same_update.len(), 1);
    assert_eq!(same_update[0].sequence, 2);
    let after_same: (i64, i64, i64, i64) = sqlx::query_as("SELECT c.head, (SELECT count(*) FROM hosted_provider_changes WHERE collection_id=$1), (SELECT count(*) FROM hosted_provider_collaboration_updates WHERE collection_id=$1), (SELECT count(*) FROM hosted_provider_collaboration_receipts WHERE collection_id=$1) FROM hosted_provider_collections c WHERE c.id=$1").bind(collection).fetch_one(&provider.pool).await.unwrap();
    assert_eq!(after_same, (2, 2, 2, 2));
    let rollback_before = after_same;
    let mut rolled = provider.pool.begin().await.unwrap();
    provider
        .commit_collaboration_batch_in(
            &mut rolled,
            CollaborationBatchInput {
                collection_id: collection,
                record_id: record,
                epoch: 1,
                contributions: vec![CollaborationBatchContribution {
                    replica_id: replica,
                    expected_scope_epoch: 1,
                    client_mutation_id: Uuid::new_v4(),
                    update: update.clone(),
                }],
            },
        )
        .await
        .unwrap();
    rolled.rollback().await.unwrap();
    let rollback_after: (i64, i64, i64, i64) = sqlx::query_as("SELECT c.head, (SELECT count(*) FROM hosted_provider_changes WHERE collection_id=$1), (SELECT count(*) FROM hosted_provider_collaboration_updates WHERE collection_id=$1), (SELECT count(*) FROM hosted_provider_collaboration_receipts WHERE collection_id=$1) FROM hosted_provider_collections c WHERE c.id=$1").bind(collection).fetch_one(&provider.pool).await.unwrap();
    assert_eq!(rollback_after, rollback_before);
    let conflict = {
        let mut tx = provider.pool.begin().await.unwrap();
        let e = provider
            .commit_collaboration_batch_in(
                &mut tx,
                CollaborationBatchInput {
                    collection_id: collection,
                    record_id: record,
                    epoch: 1,
                    contributions: vec![CollaborationBatchContribution {
                        replica_id: replica,
                        expected_scope_epoch: 1,
                        client_mutation_id: mutation,
                        update: vec![1, 2, 3],
                    }],
                },
            )
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        e
    };
    assert_eq!(conflict.code, "collaboration_mutation_id_conflict");
    let denied = {
        let mut tx = provider.pool.begin().await.unwrap();
        let e = provider
            .commit_collaboration_batch_in(
                &mut tx,
                CollaborationBatchInput {
                    collection_id: collection,
                    record_id: record,
                    epoch: 1,
                    contributions: vec![CollaborationBatchContribution {
                        replica_id: replica,
                        expected_scope_epoch: 2,
                        client_mutation_id: Uuid::new_v4(),
                        update,
                    }],
                },
            )
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        e
    };
    assert_eq!(denied.code, "scope_epoch_stale");

    let plain_record = Uuid::new_v4();
    provider
        .mutate(
            collection,
            &token,
            SyncMutation {
                mutation_id: Uuid::new_v4(),
                replica_id: replica,
                scope_epoch: 1,
                operation: SyncMutationOperation::Put,
                record_id: plain_record,
                base_revision: None,
                path: Some("notes/plain.md".into()),
                document: Some("plain body\n".into()),
                created_at: chrono::Utc::now().to_rfc3339(),
                causal_predecessor: None,
            },
            Some("https://phase3.invalid"),
        )
        .await
        .unwrap();
    let head_before_boundary_attempt: i64 =
        sqlx::query_scalar("SELECT head FROM hosted_provider_collections WHERE id=$1")
            .bind(collection)
            .fetch_one(&provider.pool)
            .await
            .unwrap();
    let mut boundary_tx = provider.pool.begin().await.unwrap();
    let plain_room = provider
        .load_collaboration_room_in(
            &mut boundary_tx,
            &key,
            RoomIdentity::new(collection, plain_record, 1, COLLABORATION_PROFILE).unwrap(),
        )
        .await
        .unwrap();
    let mut boundary_client = MarkdownBodyDocument::from_snapshot(
        &plain_room.document.snapshot_v1(),
        4 * 1024 * 1024,
        2 * 1024 * 1024,
    )
    .unwrap();
    let boundary_update = boundary_client
        .apply_provider_body("---\ntitle: now metadata\n---\nbody\n", 2 * 1024 * 1024)
        .unwrap();
    let boundary_error = provider
        .commit_collaboration_batch_in(
            &mut boundary_tx,
            CollaborationBatchInput {
                collection_id: collection,
                record_id: plain_record,
                epoch: 1,
                contributions: vec![CollaborationBatchContribution {
                    replica_id: replica,
                    expected_scope_epoch: 1,
                    client_mutation_id: Uuid::new_v4(),
                    update: boundary_update,
                }],
            },
        )
        .await
        .unwrap_err();
    assert_eq!(
        boundary_error.code,
        "collaboration_frontmatter_boundary_changed"
    );
    boundary_tx.rollback().await.unwrap();
    let boundary_state: (i64, i64) = sqlx::query_as("SELECT head, (SELECT count(*) FROM hosted_provider_collaboration_receipts WHERE collection_id=$1 AND record_id=$2) FROM hosted_provider_collections WHERE id=$1")
        .bind(collection)
        .bind(plain_record)
        .fetch_one(&provider.pool)
        .await
        .unwrap();
    assert_eq!(boundary_state, (head_before_boundary_attempt, 0));

    let ticket_request = CollaborationTicketRequest {
        path: "notes/é.md".into(),
        profile: COLLABORATION_PROFILE.into(),
        mode: crate::CollaborationMode::ReadWrite,
        epoch: Some(1),
    };
    let issued = provider
        .issue_collaboration_ticket(
            collection,
            &token,
            ticket_request.clone(),
            Some("https://phase3.invalid"),
            Some(&signed_proof(&signing, &token)),
        )
        .await
        .unwrap();
    assert_eq!(issued.metadata.room.record_id, record);
    assert!(provider
        .consume_collaboration_ticket(&issued.plaintext, Some("https://wrong.invalid"))
        .await
        .is_err());
    let consumed = provider
        .consume_collaboration_ticket(&issued.plaintext, Some("https://phase3.invalid"))
        .await
        .unwrap();
    assert_eq!(consumed.metadata.room, issued.metadata.room);
    assert!(provider
        .consume_collaboration_ticket(&issued.plaintext, Some("https://phase3.invalid"))
        .await
        .is_err());

    let raced = provider
        .issue_collaboration_ticket(
            collection,
            &token,
            ticket_request.clone(),
            Some("https://phase3.invalid"),
            Some(&signed_proof(&signing, &token)),
        )
        .await
        .unwrap();
    let (first, second) = tokio::join!(
        provider.consume_collaboration_ticket(&raced.plaintext, Some("https://phase3.invalid")),
        provider.consume_collaboration_ticket(&raced.plaintext, Some("https://phase3.invalid"))
    );
    assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);

    let expired = provider
        .issue_collaboration_ticket(
            collection,
            &token,
            ticket_request.clone(),
            Some("https://phase3.invalid"),
            Some(&signed_proof(&signing, &token)),
        )
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
    assert!(provider
        .consume_collaboration_ticket(&expired.plaintext, Some("https://phase3.invalid"))
        .await
        .is_err());

    let stale_scope = provider
        .issue_collaboration_ticket(
            collection,
            &token,
            ticket_request.clone(),
            Some("https://phase3.invalid"),
            Some(&signed_proof(&signing, &token)),
        )
        .await
        .unwrap();
    sqlx::query("UPDATE hosted_provider_replicas SET scope_epoch=scope_epoch+1 WHERE id=$1")
        .bind(replica)
        .execute(&provider.pool)
        .await
        .unwrap();
    assert!(provider
        .consume_collaboration_ticket(&stale_scope.plaintext, Some("https://phase3.invalid"))
        .await
        .is_err());

    let rotated = provider
        .issue_collaboration_ticket(
            collection,
            &token,
            ticket_request.clone(),
            Some("https://phase3.invalid"),
            Some(&signed_proof(&signing, &token)),
        )
        .await
        .unwrap();
    let rotated_token = format!("phase3-rotated-{}", Uuid::new_v4());
    provider
        .rotate_replica_token(replica, &rotated_token, Some(3600))
        .await
        .unwrap();
    assert!(provider
        .consume_collaboration_ticket(&rotated.plaintext, Some("https://phase3.invalid"))
        .await
        .is_err());

    let revoked = provider
        .issue_collaboration_ticket(
            collection,
            &rotated_token,
            ticket_request,
            Some("https://phase3.invalid"),
            Some(&signed_proof(&signing, &rotated_token)),
        )
        .await
        .unwrap();
    provider.revoke_replica(replica).await.unwrap();
    assert!(provider
        .consume_collaboration_ticket(&revoked.plaintext, Some("https://phase3.invalid"))
        .await
        .is_err());
}

fn signed_proof(signing: &p256::ecdsa::SigningKey, token: &str) -> AuthorityRequestProof {
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
