#![allow(dead_code, unused_imports)]
mod support;
#[path = "support/test_postgres.rs"]
mod test_postgres;
use mdbase_connect_hosted_provider::{RegisterReplica, ReplicaPurpose};
use mdbase_connect_protocol::SyncReplicaMode;
use serde_json::{json, Value};
use support::FileLifecycleFixture;
use test_postgres::DisposablePostgres;
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn hosted_revisioned_documents_and_metadata_qualify_all_query_paths() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let token = format!("query-outputs-{}-{}", Uuid::new_v4(), Uuid::new_v4());
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id: Uuid::now_v7(),
                name: "Query output qualification".into(),
                application_setup_evidence: None,
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadWrite,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: [
                    "describe",
                    "read",
                    "query",
                    "create",
                    "update",
                    "create_view_source",
                    "execute_view",
                ]
                .into_iter()
                .map(str::to_string)
                .collect(),
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: vec![2],
                file_capability: None,
                allowed_origin: None,
                proof_public_key: None,
                grant_id: Some(Uuid::new_v4()),
                application_declaration_id: None,
                application_declaration_digest: None,
                token: token.clone(),
                token_ttl_seconds: Some(3600),
            },
        )
        .await
        .unwrap();
    let operation = |operation: &'static str, input: Value| {
        let (provider, token) = (&fixture.provider, token.clone());
        async move {
            provider
                .operation(
                    fixture.collection_id,
                    &token,
                    operation,
                    Uuid::now_v7(),
                    input,
                    None,
                )
                .await
                .unwrap()
        }
    };
    let description = operation("describe", json!({})).await;
    assert_eq!(
        description["authority_capabilities"],
        json!([
            "query-record-revisions-v1",
            "read-many-documents-v1",
            "query-metadata-v1"
        ])
    );
    for (path, rank) in [("a.md", 2), ("b.md", 1)] {
        let created = operation("create",json!({"path":path,"frontmatter":{"source":"book","rank":rank,"unused":"wide fields"},"body":"Unicode 🦀\n#tag\n"})).await;
        assert_eq!(created["valid"], true, "{created}");
    }
    // Exercise exact fallback first, then active projected page and residual paths.
    for projected in [false, true] {
        if projected {
            let generation = fixture
                .provider
                .start_projection_generation(fixture.collection_id)
                .await
                .unwrap();
            let mut complete = false;
            for _ in 0..16 {
                let batch = fixture
                    .provider
                    .advance_projection_generation(fixture.collection_id, generation.generation_id)
                    .await
                    .unwrap();
                if batch.generation.status == "complete" {
                    complete = true;
                    break;
                }
            }
            assert!(complete);
        }
        for query in [
            json!({}),
            json!({"select":["source","missing"]}),
            json!({"select":["projection.alias"],"projections":{"alias":{"expr":"source + '-resolved'"}},"where":"rank > 0"}),
            json!({"select":["file.tags"],"where":"file.hasTag('tag')","order_by":[{"field":"rank"}]}),
        ] {
            let normal = operation("query", query.clone()).await;
            let mut query = query;
            query["output"] = json!("metadata");
            let narrow = operation("query", query).await;
            assert_eq!(normal["valid"], true, "{normal}");
            assert_eq!(narrow["valid"], true, "{narrow}");
            serde_json::from_value::<mdbase_connect_protocol::QueryMetadataResult>(
                narrow["result"].clone(),
            )
            .unwrap();
            assert_eq!(narrow["result"]["output"], "metadata");
            let a = normal["result"]["results"].as_array().unwrap();
            let b = narrow["result"]["results"].as_array().unwrap();
            assert_eq!(a.len(), b.len());
            for (a, b) in a.iter().zip(b) {
                assert_eq!(
                    b.as_object()
                        .unwrap()
                        .keys()
                        .map(String::as_str)
                        .collect::<Vec<_>>(),
                    ["path", "revision", "types", "values"]
                );
                for key in ["path", "revision", "types"] {
                    assert_eq!(a[key], b[key]);
                }
                assert_eq!(a.get("values").cloned().unwrap_or(json!({})), b["values"]);
                let read = operation("read", json!({"path":b["path"]})).await;
                assert_eq!(b["revision"], read["result"]["revision"]);
            }
        }
    }
    let batch = operation(
        "read",
        json!({"paths":["a.md","missing.md","a.md"],"include_document":true}),
    )
    .await;
    serde_json::from_value::<mdbase_connect_protocol::ReadManyDocumentsResult>(
        batch["result"].clone(),
    )
    .unwrap();
    assert_eq!(batch["valid"], true, "{batch}");
    assert_eq!(batch["result"]["items"][0], batch["result"]["items"][2]);
    assert_eq!(batch["result"]["items"][1]["status"], "missing");
    let point = operation("read", json!({"path":"a.md","include_document":true})).await;
    assert_eq!(batch["result"]["items"][0]["record"], point["result"]);
    let omitted = operation("read", json!({"paths":["a.md"],"include_body":false})).await;
    assert!(omitted["result"]["items"][0]["record"]
        .get("body")
        .is_none());
    assert!(omitted["result"]["items"][0]["record"]
        .get("document")
        .is_none());
    let stale_revision = point["result"]["revision"].clone();
    operation("update", json!({"path":"a.md","body":"later"})).await;
    let later = operation("read", json!({"paths":["a.md"]})).await;
    assert_ne!(
        later["result"]["items"][0]["record"]["revision"],
        stale_revision
    );
    let stale = operation(
        "update",
        json!({"path":"a.md","body":"stale","if_revision":stale_revision}),
    )
    .await;
    assert_eq!(stale["valid"], false);
    let mut input = json!({"output":"metadata","pagination":"cursor","limit":1});
    let first = operation("query", input.clone()).await;
    input["cursor"] = first["result"]["meta"]["cursor"].clone();
    let mut wrong = input.clone();
    wrong.as_object_mut().unwrap().remove("output");
    assert!(fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "query",
            Uuid::now_v7(),
            wrong,
            None
        )
        .await
        .is_err());
    let second = operation("query", input).await;
    assert_eq!(second["result"]["output"], "metadata");
    operation(
        "query",
        json!({"release_cursor":first["result"]["meta"]["cursor"]}),
    )
    .await;
    // Hosted Base rows use mdbase-rs's same normal renderer, including revisions.
    let source = operation("create_view_source",json!({"path":"views/list.base","document":"views:\n  - type: table\n    name: List\n    filters: \"file.ext == 'md'\"\n"})).await;
    assert_eq!(source["valid"], true, "{source}");
    let base = operation(
        "execute_view",
        json!({"path":"views/list.base","view":"list"}),
    )
    .await;
    assert_eq!(base["valid"], true, "{base}");
    assert_eq!(base["result"]["results"].as_array().unwrap().len(), 2);
    for row in base["result"]["results"].as_array().unwrap() {
        assert!(row["revision"].as_str().unwrap().starts_with("sha256:"));
    }
    assert!(fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "query",
            Uuid::now_v7(),
            json!({"output":"metadata","include_body":true}),
            None
        )
        .await
        .is_err());
}
