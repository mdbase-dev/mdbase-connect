#![allow(dead_code, unused_imports)]

mod support;
#[path = "support/test_postgres.rs"]
mod test_postgres;

use mdbase_connect_hosted_provider::{RegisterReplica, ReplicaPurpose};
use mdbase_connect_protocol::{DeleteFileRequest, DeleteFileRequestKind, SyncReplicaMode};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;
use support::FileLifecycleFixture;
use test_postgres::DisposablePostgres;
use uuid::Uuid;

const NOTE_TYPE: &str = r#"---
kind: mdbase.type
name: note
version: 1
match:
  path_glob: 'notes/*.md'
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      slug: {type: string}
      related: {type: string}
      document:
        type: object
        properties:
          file: {type: string}
collection:
  unique:
    - field: slug
      scope: collection
  links:
    related:
      validate_exists: true
    document.file:
      target_type: any
      validate_exists: true
---
"#;

const PAGE_TYPE: &str = r#"---
kind: mdbase.type
name: page
version: 1
match:
  path_glob: 'pages/*.md'
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      slug: {type: string}
---
"#;

async fn install_note_type(fixture: &FileLifecycleFixture) -> String {
    let token = format!("uniqueness-writer-{}", Uuid::new_v4());
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id: Uuid::now_v7(),
                name: "Uniqueness writer".to_string(),
                application_setup_evidence: None,
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadWrite,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: [
                    "assess_type_pack",
                    "apply_type_pack",
                    "create",
                    "update",
                    "validate",
                ]
                .into_iter()
                .map(str::to_string)
                .collect(),
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: Vec::new(),
                file_capability: None,
                allowed_origin: None,
                proof_public_key: None,
                grant_id: Some(Uuid::now_v7()),
                application_declaration_id: None,
                application_declaration_digest: None,
                token: token.clone(),
                token_ttl_seconds: Some(3600),
            },
        )
        .await
        .unwrap();
    let digest = |document: &str| format!("sha256:{:x}", Sha256::digest(document.as_bytes()));
    let pack = json!({
        "provision": {
            "manifest": {
                "kind": "mdbase.type-pack",
                "id": "test.hosted-write-validation",
                "version": "1.0.0",
                "resources": [{
                    "kind": "type",
                    "mode": "managed",
                    "source": "types/note.md",
                    "target": "_types/note.md",
                    "digest": digest(NOTE_TYPE)
                }, {
                    "kind": "type",
                    "mode": "managed",
                    "source": "types/page.md",
                    "target": "_types/page.md",
                    "digest": digest(PAGE_TYPE)
                }]
            },
            "resources": [
                {"source": "types/note.md", "document": NOTE_TYPE},
                {"source": "types/page.md", "document": PAGE_TYPE}
            ],
            "provides": []
        },
        "installed_by": "test.hosted-write-validation",
        "adopt_resources": {},
        "preserve_seed_targets": [],
        "target_overrides": {},
        "contract_setups": []
    });
    let assessment = operation(fixture, &token, "assess_type_pack", pack.clone()).await;
    assert_eq!(assessment["valid"], true, "{assessment}");
    let mut apply = pack;
    apply["expected_assessment_digest"] = assessment["result"]["assessment_digest"].clone();
    apply["allow_downgrade"] = json!(false);
    let applied = operation(fixture, &token, "apply_type_pack", apply).await;
    assert_eq!(applied["valid"], true, "{applied}");
    token
}

async fn operation(
    fixture: &FileLifecycleFixture,
    token: &str,
    operation: &str,
    input: Value,
) -> Value {
    fixture
        .provider
        .operation(
            fixture.collection_id,
            token,
            operation,
            Uuid::now_v7(),
            input,
            None,
        )
        .await
        .unwrap_or_else(|error| panic!("{operation} failed: {error:?}"))
}

async fn create_note(fixture: &FileLifecycleFixture, token: &str, path: &str, slug: &str) -> Value {
    operation(
        fixture,
        token,
        "create",
        json!({"path": path, "type": "note", "frontmatter": {"slug": slug}}),
    )
    .await
}

async fn set_slug(fixture: &FileLifecycleFixture, token: &str, path: &str, slug: &str) -> Value {
    operation(
        fixture,
        token,
        "update",
        json!({"path": path, "patch": {"slug": slug}}),
    )
    .await
}

fn assert_rejected(result: &Value, code: &str, mentioning: &str) {
    assert_eq!(result["valid"], false, "{result}");
    let diagnostics = result["diagnostics"].as_array().unwrap();
    assert!(
        diagnostics.iter().any(|diagnostic| {
            diagnostic["code"] == code
                && diagnostic["message"]
                    .as_str()
                    .is_some_and(|message| message.contains(mentioning))
        }),
        "{result}"
    );
}

fn assert_duplicate(result: &Value, other_path: &str) {
    assert_rejected(result, "duplicate_value", other_path);
}

async fn head(fixture: &FileLifecycleFixture) -> i64 {
    sqlx::query_scalar("SELECT head FROM hosted_provider_collections WHERE id = $1")
        .bind(fixture.collection_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap()
}

/// Links, cross-type uniqueness and no-op updates, with or without a current
/// projection answering the write's lookups.
async fn assert_links_scopes_and_no_ops(fixture: &FileLifecycleFixture, token: &str, tag: &str) {
    let target = format!("notes/{tag}-target.md");
    let created = create_note(fixture, token, &target, &format!("{tag}-target")).await;
    assert_eq!(created["valid"], true, "{created}");
    let link = |name: &str| format!("[[notes/{tag}-{name}]]");
    let source = |related: String| {
        json!({
            "path": format!("notes/{tag}-source.md"),
            "type": "note",
            "frontmatter": {"slug": format!("{tag}-source"), "related": related}
        })
    };
    assert_rejected(
        &operation(fixture, token, "create", source(link("missing"))).await,
        "link_not_found",
        &format!("{tag}-missing"),
    );
    let linked = operation(fixture, token, "create", source(link("target"))).await;
    assert_eq!(linked["valid"], true, "{linked}");

    // `scope: collection` compares notes with pages, which declare no rule.
    let page = operation(
        fixture,
        token,
        "create",
        json!({"path": format!("pages/{tag}.md"), "type": "page", "frontmatter": {"slug": format!("{tag}-page")}}),
    )
    .await;
    assert_eq!(page["valid"], true, "{page}");
    assert_duplicate(
        &create_note(
            fixture,
            token,
            &format!("notes/{tag}-copy.md"),
            &format!("{tag}-page"),
        )
        .await,
        &format!("pages/{tag}.md"),
    );

    let before = head(fixture).await;
    let unchanged = set_slug(fixture, token, &target, &format!("{tag}-target")).await;
    assert_eq!(unchanged["valid"], true, "{unchanged}");
    assert_eq!(unchanged["result"]["path"], target, "{unchanged}");
    assert_eq!(head(fixture).await, before);
}

async fn projection_is_current(fixture: &FileLifecycleFixture) -> bool {
    sqlx::query(
        "SELECT active_projection_generation_id IS NOT NULL AND active_projection_head = head
         FROM hosted_provider_collections WHERE id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap()
    .get::<Option<bool>, _>(0)
    .unwrap_or(false)
}

async fn complete_projection(fixture: &FileLifecycleFixture) {
    let generation = fixture
        .provider
        .start_projection_generation(fixture.collection_id)
        .await
        .unwrap();
    for _ in 0..64 {
        let batch = match fixture
            .provider
            .advance_projection_generation(fixture.collection_id, generation.generation_id)
            .await
        {
            Ok(batch) => batch,
            // Type-pack installation also schedules recovery. Its projection
            // worker can race this driver; retry only the declared DB conflict.
            Err(error) if error.code == "provider_database_retryable" => {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
            Err(error) => panic!("projection advance failed: {error:?}"),
        };
        if batch.generation.status == "complete" {
            return;
        }
    }
    panic!("the projection generation did not complete");
}

async fn record_count(fixture: &FileLifecycleFixture) -> i64 {
    sqlx::query_scalar("SELECT record_count FROM hosted_provider_collections WHERE id = $1")
        .bind(fixture.collection_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap()
}

/// Reader-like nested links to attachments, including unpublished and deleted
/// files. Run through both exact fallback and current projections.
async fn assert_attachment_links(fixture: &FileLifecycleFixture, token: &str, tag: &str) {
    let source_path = format!("notes/{tag}-source.md");
    let source = create_note(fixture, token, &source_path, &format!("{tag}-source")).await;
    assert_eq!(source["valid"], true, "{source}");
    for extension in ["html", "pdf", "epub"] {
        let file_path = format!("files/reader/{tag}/document.{extension}");
        let note_path = format!("notes/{tag}-{extension}.md");
        let input = json!({"path": note_path, "type": "note", "frontmatter": {
            "slug": format!("{tag}-{extension}"), "related": format!("[[{source_path}]]"),
            "document": {"file": format!("../{file_path}")}
        }});
        let transfer = fixture
            .stage_upload(&file_path, b"attachment bytes are not records")
            .await;
        let before = head(fixture).await;
        assert_rejected(
            &operation(fixture, token, "create", input.clone()).await,
            "link_not_found",
            &file_path,
        );
        assert_eq!(
            head(fixture).await,
            before,
            "an open upload is not an existing file"
        );
        let file = fixture
            .provider
            .commit_file_upload(
                fixture.collection_id,
                &fixture.token,
                FileLifecycleFixture::commit_request(transfer),
                None,
            )
            .await
            .unwrap()
            .file;
        let created = operation(fixture, token, "create", input).await;
        assert_eq!(created["valid"], true, "{created}");
        let updated = operation(
            fixture,
            token,
            "update",
            json!({"path": note_path, "patch": {"title": "Edited"}}),
        )
        .await;
        assert_eq!(updated["valid"], true, "{updated}");
        let validated = operation(fixture, token, "validate", json!({"path": note_path})).await;
        assert_eq!(validated["valid"], true, "{validated}");
        assert!(
            validated["diagnostics"].as_array().unwrap().is_empty(),
            "{validated}"
        );
        fixture
            .provider
            .delete_file(
                fixture.collection_id,
                &fixture.token,
                DeleteFileRequest {
                    protocol_version: 1,
                    message_type: DeleteFileRequestKind::DeleteFile,
                    mutation_id: Uuid::now_v7(),
                    file_id: file.file_id,
                    if_revision: file.revision,
                    path: file.path,
                },
                None,
            )
            .await
            .unwrap();
        let before = head(fixture).await;
        let rejected = operation(
            fixture,
            token,
            "update",
            json!({"path": note_path, "patch": {"title": "Must not save"}}),
        )
        .await;
        assert_rejected(&rejected, "link_not_found", &file_path);
        assert_eq!(head(fixture).await, before);
        let invalid = operation(fixture, token, "validate", json!({"path": note_path})).await;
        assert_rejected(&invalid, "link_not_found", &file_path);
    }
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn attachment_link_evidence_is_collection_scoped_and_keeps_original_paths() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let other = FileLifecycleFixture::new(database.url()).await;
    let token = install_note_type(&fixture).await;
    let path = "files/OnlyHere.HTML";
    let transfer = other.stage_upload(path, b"other collection").await;
    other
        .provider
        .commit_file_upload(
            other.collection_id,
            &other.token,
            FileLifecycleFixture::commit_request(transfer),
            None,
        )
        .await
        .unwrap();
    let input = |path: &str| {
        json!({"path": "notes/scoped.md", "type": "note",
        "frontmatter": {"document": {"file": path}}})
    };
    assert_rejected(
        &operation(&fixture, &token, "create", input(path)).await,
        "link_not_found",
        path,
    );
    let transfer = fixture.stage_upload(path, b"this collection").await;
    fixture
        .provider
        .commit_file_upload(
            fixture.collection_id,
            &fixture.token,
            FileLifecycleFixture::commit_request(transfer),
            None,
        )
        .await
        .unwrap();
    // File stat's portable aliases are not canonical record-link paths.
    assert_rejected(
        &operation(&fixture, &token, "create", input("files/onlyhere.html")).await,
        "link_not_found",
        "files/onlyhere.html",
    );
    let valid = operation(&fixture, &token, "create", input(path)).await;
    assert_eq!(valid["valid"], true, "{valid}");
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn hosted_writes_and_validation_resolve_committed_attachment_links() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let token = install_note_type(&fixture).await;
    assert!(!projection_is_current(&fixture).await);
    assert_attachment_links(&fixture, &token, "exact-files").await;
    complete_projection(&fixture).await;
    assert!(projection_is_current(&fixture).await);
    assert_attachment_links(&fixture, &token, "indexed-files").await;
    assert!(projection_is_current(&fixture).await);
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn writes_without_a_current_projection_reject_duplicate_unique_values() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let token = install_note_type(&fixture).await;
    assert!(!projection_is_current(&fixture).await);

    let first = create_note(&fixture, &token, "notes/a.md", "same").await;
    assert_eq!(first["valid"], true, "{first}");
    assert_duplicate(
        &create_note(&fixture, &token, "notes/b.md", "same").await,
        "notes/a.md",
    );

    let other = create_note(&fixture, &token, "notes/c.md", "other").await;
    assert_eq!(other["valid"], true, "{other}");
    assert_duplicate(
        &set_slug(&fixture, &token, "notes/c.md", "same").await,
        "notes/a.md",
    );

    // A record's own value is not a conflict.
    let own_value = operation(
        &fixture,
        &token,
        "update",
        json!({"path": "notes/a.md", "patch": {"slug": "same", "title": "A"}}),
    )
    .await;
    assert_eq!(own_value["valid"], true, "{own_value}");
    assert_eq!(record_count(&fixture).await, 2);
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn writes_with_a_current_projection_reject_duplicate_unique_values() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let token = install_note_type(&fixture).await;
    let first = create_note(&fixture, &token, "notes/a.md", "same").await;
    assert_eq!(first["valid"], true, "{first}");
    complete_projection(&fixture).await;
    assert!(projection_is_current(&fixture).await);

    assert_duplicate(
        &create_note(&fixture, &token, "notes/b.md", "same").await,
        "notes/a.md",
    );

    // Records written after indexing are found through their live projection.
    let later = create_note(&fixture, &token, "notes/c.md", "later").await;
    assert_eq!(later["valid"], true, "{later}");
    assert!(projection_is_current(&fixture).await);
    assert_duplicate(
        &create_note(&fixture, &token, "notes/d.md", "later").await,
        "notes/c.md",
    );
    assert_duplicate(
        &set_slug(&fixture, &token, "notes/a.md", "later").await,
        "notes/c.md",
    );

    // A value released by an update can be taken by another record.
    let released = set_slug(&fixture, &token, "notes/c.md", "moved").await;
    assert_eq!(released["valid"], true, "{released}");
    let reused = create_note(&fixture, &token, "notes/e.md", "later").await;
    assert_eq!(reused["valid"], true, "{reused}");
    assert_eq!(record_count(&fixture).await, 3);
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn writes_check_required_links_scopes_and_accept_no_op_updates() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let token = install_note_type(&fixture).await;
    assert!(!projection_is_current(&fixture).await);
    assert_links_scopes_and_no_ops(&fixture, &token, "exact").await;
    complete_projection(&fixture).await;
    assert!(projection_is_current(&fixture).await);
    assert_links_scopes_and_no_ops(&fixture, &token, "indexed").await;
    assert!(projection_is_current(&fixture).await);
}
