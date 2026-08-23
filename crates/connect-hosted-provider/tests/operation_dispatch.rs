#![allow(dead_code, unused_imports)]

mod support;

use mdbase_connect_hosted_provider::{RegisterReplica, ReplicaPurpose};
use mdbase_connect_protocol::SyncReplicaMode;
use serde_json::json;
use support::FileLifecycleFixture;
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires a clean MDBASE_PROJECTION_DATABASE_URL disposable PostgreSQL database"]
async fn assess_collection_setup_dispatch_rejects_mismatched_declaration() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let replica_id = Uuid::now_v7();
    let token = format!("setup-assessment-{}-{}", Uuid::new_v4(), Uuid::new_v4());
    let declaration_id = "dev.mdbase.tasks";
    let declaration_digest = format!("sha256:{}", "a".repeat(64));
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id,
                name: "Tasks application".to_string(),
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadWrite,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: vec!["assess_collection_setup".to_string()],
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: vec![2],
                file_capability: None,
                collaboration_capability: None,
                allowed_origin: Some("https://tasks.example".to_string()),
                proof_public_key: None,
                grant_id: Some(Uuid::new_v4()),
                application_declaration_id: Some(declaration_id.to_string()),
                application_declaration_digest: Some(declaration_digest.clone()),
                token: token.clone(),
                token_ttl_seconds: Some(3600),
            },
        )
        .await
        .expect("application replica is registered");

    let mismatched_digest = format!("sha256:{}", "b".repeat(64));
    for (application_id, digest) in [
        ("dev.mdbase.other", declaration_digest.as_str()),
        (declaration_id, mismatched_digest.as_str()),
    ] {
        let error = fixture
            .provider
            .operation(
                fixture.collection_id,
                &token,
                "assess_collection_setup",
                Uuid::now_v7(),
                json!({
                    "application_id": application_id,
                    "declaration_digest": digest,
                    "requirements": { "configuration": [] },
                    "provisions": { "configuration": [], "type_packs": [] }
                }),
                Some("https://tasks.example"),
            )
            .await
            .expect_err("mismatched declaration is rejected before assessment");
        assert_eq!(error.code, "application_declaration_mismatch");
    }
}
