use super::*;
use serde_json::{json, Map};

pub(super) fn resources() -> Vec<(String, String)> {
    let mut resources: Vec<(String, String)> = crate::template::resources("mdbase", "UTC")
        .unwrap()
        .documents
        .into_iter()
        .map(|resource| (resource.path.to_string(), resource.document.to_string()))
        .collect();
    resources.push((
        "_types/task.md".to_string(),
        r#"---
kind: mdbase.type
name: task
version: 1
description: A generic work item.
collection:
  path:
    folder: tasks
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, title]
    additionalProperties: true
    properties:
      type: { const: task }
      title: { type: string, minLength: 1 }
      status: { enum: [open, done] }
---
"#
        .to_string(),
    ));
    resources
}

#[test]
fn executes_create_through_the_canonical_engine() {
    let mut workspace = WorkingSet::materialize(resources(), []).unwrap();
    let record_id = Uuid::new_v4();
    let execution = workspace
        .execute_semantic(
            record_id,
            "create",
            &Map::from_iter([
                ("path".to_string(), json!("tasks/first.md")),
                (
                    "frontmatter".to_string(),
                    json!({"type": "task", "title": "First"}),
                ),
                ("body".to_string(), json!("Body")),
                ("types".to_string(), json!(["task"])),
            ]),
        )
        .unwrap();
    assert!(execution.envelope.valid);
    assert_eq!(execution.changed.len(), 1);
    assert_eq!(execution.changed[0].1.as_ref().unwrap().types, ["task"]);
    assert!(execution.changed[0]
        .2
        .as_ref()
        .unwrap()
        .contains("title: First"));
}

#[test]
fn creates_and_updates_opaque_markdown_records_losslessly() {
    let record_id = Uuid::new_v4();
    let original = "---\ntitle: [unterminated\n---\nOriginal body";
    let mut workspace = WorkingSet::materialize(resources(), []).unwrap();
    let created = workspace
        .execute_sync(&SyncMutation {
            mutation_id: Uuid::new_v4(),
            replica_id: Uuid::new_v4(),
            scope_epoch: 1,
            operation: SyncMutationOperation::Put,
            record_id,
            base_revision: None,
            path: Some("opaque.md".to_string()),
            document: Some(original.to_string()),
            created_at: "2026-07-21T00:00:00Z".to_string(),
            causal_predecessor: None,
        })
        .unwrap();

    assert!(created.envelope.valid, "{:?}", created.envelope.diagnostics);
    let created_record = created.changed[0].1.as_ref().unwrap();
    assert!(created_record.frontmatter.is_empty());
    assert_eq!(created_record.body, original);
    assert_eq!(created.changed[0].2.as_deref(), Some(original));

    let replacement = "---\ntitle: [still broken\n---\nReplacement body";
    let updated = workspace
        .execute_sync(&SyncMutation {
            mutation_id: Uuid::new_v4(),
            replica_id: Uuid::new_v4(),
            scope_epoch: 1,
            operation: SyncMutationOperation::Put,
            record_id,
            base_revision: Some(created_record.revision.clone()),
            path: Some("opaque.md".to_string()),
            document: Some(replacement.to_string()),
            created_at: "2026-07-21T00:00:01Z".to_string(),
            causal_predecessor: None,
        })
        .unwrap();

    assert!(updated.envelope.valid, "{:?}", updated.envelope.diagnostics);
    assert_eq!(updated.changed[0].1.as_ref().unwrap().body, replacement);
    assert_eq!(updated.changed[0].2.as_deref(), Some(replacement));
}

#[test]
fn sync_move_preserves_every_document_byte_and_never_rewrites_references() {
    let source_id = Uuid::new_v4();
    let reference_id = Uuid::new_v4();
    let source = "---\ntype: task\ntitle: Source\n---\nSource body\n";
    let reference = "---\ntype: task\ntitle: Reference\n---\nSee [[tasks/source]].\n";
    let mut workspace = WorkingSet::materialize(
        resources(),
        [
            StoredDocument {
                record_id: source_id,
                path: "tasks/source.md".to_string(),
                document: source.to_string(),
            },
            StoredDocument {
                record_id: reference_id,
                path: "tasks/reference.md".to_string(),
                document: reference.to_string(),
            },
        ],
    )
    .unwrap();
    let moved = workspace
        .execute_sync(&SyncMutation {
            mutation_id: Uuid::new_v4(),
            replica_id: Uuid::new_v4(),
            scope_epoch: 1,
            operation: SyncMutationOperation::Move,
            record_id: source_id,
            base_revision: Some("checked-by-authority".to_string()),
            path: Some("archive/source.md".to_string()),
            document: None,
            created_at: "2026-07-21T00:00:00Z".to_string(),
            causal_predecessor: None,
        })
        .unwrap();

    assert_eq!(moved.changed.len(), 1);
    assert_eq!(moved.changed[0].2.as_deref(), Some(source));
    assert_eq!(
        workspace.resource_document("tasks/reference.md").unwrap(),
        reference
    );
}

#[test]
fn adapts_sync_update_patches_for_the_supported_v03_engine() {
    let record_id = Uuid::new_v4();
    let mut workspace = WorkingSet::materialize(resources(), []).unwrap();
    let created = workspace
        .execute_semantic(
            record_id,
            "create",
            &Map::from_iter([
                ("path".to_string(), json!("tasks/update.md")),
                (
                    "frontmatter".to_string(),
                    json!({"type": "task", "title": "Update", "status": "open"}),
                ),
                ("body".to_string(), json!("")),
                ("types".to_string(), json!(["task"])),
            ]),
        )
        .unwrap();
    let revision = created.changed[0].1.as_ref().unwrap().revision.clone();

    let updated = workspace
        .execute_semantic(
            record_id,
            "update",
            &Map::from_iter([
                ("patch".to_string(), json!({"status": "done"})),
                ("if_revision".to_string(), json!(revision)),
            ]),
        )
        .unwrap();

    assert!(updated.envelope.valid);
    assert_eq!(
        updated.changed[0]
            .1
            .as_ref()
            .unwrap()
            .frontmatter
            .get("status"),
        Some(&json!("done"))
    );
}

#[test]
fn keeps_record_and_path_indexes_consistent_across_mutations() {
    let record_id = Uuid::new_v4();
    let mut workspace = WorkingSet::materialize(resources(), []).unwrap();
    let created = workspace
        .execute_semantic(
            record_id,
            "create",
            &Map::from_iter([
                ("path".to_string(), json!("tasks/indexed.md")),
                (
                    "frontmatter".to_string(),
                    json!({"type": "task", "title": "Indexed"}),
                ),
                ("body".to_string(), json!("")),
                ("types".to_string(), json!(["task"])),
            ]),
        )
        .unwrap();
    let created_revision = created.changed[0].1.as_ref().unwrap().revision.clone();
    assert_eq!(
        workspace.records_by_path.get("tasks/indexed.md"),
        Some(&record_id)
    );
    assert_eq!(
        workspace
            .paths_by_record_id
            .get(&record_id)
            .map(String::as_str),
        Some("tasks/indexed.md")
    );

    let renamed = workspace
        .execute_semantic(
            record_id,
            "rename",
            &Map::from_iter([
                ("path".to_string(), json!("archive/indexed.md")),
                ("if_revision".to_string(), json!(created_revision)),
                ("update_refs".to_string(), json!(false)),
            ]),
        )
        .unwrap();
    let renamed_revision = renamed.changed[0].1.as_ref().unwrap().revision.clone();
    assert!(!workspace.records_by_path.contains_key("tasks/indexed.md"));
    assert_eq!(
        workspace.records_by_path.get("archive/indexed.md"),
        Some(&record_id)
    );
    assert_eq!(
        workspace
            .paths_by_record_id
            .get(&record_id)
            .map(String::as_str),
        Some("archive/indexed.md")
    );

    let deleted = workspace
        .execute_semantic(
            record_id,
            "delete",
            &Map::from_iter([("if_revision".to_string(), json!(renamed_revision))]),
        )
        .unwrap();
    assert!(deleted.envelope.valid, "{:?}", deleted.envelope.diagnostics);
    assert!(!workspace.records_by_path.contains_key("archive/indexed.md"));
    assert!(!workspace.paths_by_record_id.contains_key(&record_id));
}

#[test]
fn reads_and_replaces_exact_markdown_documents() {
    let record_id = Uuid::new_v4();
    let original =
            "\u{feff}---\r\ntype: task\r\ntitle: \"Exact title\" # keep this\r\ncustom: null\r\n---\r\nBody  \r\n";
    let mut workspace = WorkingSet::materialize(
        resources(),
        [StoredDocument {
            record_id,
            path: "tasks/exact.md".to_string(),
            document: original.to_string(),
        }],
    )
    .unwrap();

    let read = workspace
        .read_operation(
            "read",
            &json!({"path": "tasks/exact.md", "include_document": true}),
        )
        .unwrap();
    assert!(read.valid, "{:?}", read.diagnostics);
    assert_eq!(read.result["document"], json!(original));
    let revision = read.result["revision"].as_str().unwrap().to_string();

    let replacement =
            "---\r\ntype: task\r\ntitle: 'Replacement'\r\ncustom: null # persisted null\r\n---\r\nNew body\r\n";
    let updated = workspace
        .execute_semantic(
            record_id,
            "update",
            &Map::from_iter([
                ("document".to_string(), json!(replacement)),
                ("if_revision".to_string(), json!(revision)),
            ]),
        )
        .unwrap();

    assert!(updated.envelope.valid, "{:?}", updated.envelope.diagnostics);
    assert_eq!(updated.envelope.result["document"], json!(replacement));
    assert_eq!(updated.changed[0].2.as_deref(), Some(replacement));
    assert_eq!(
        updated.changed[0]
            .1
            .as_ref()
            .unwrap()
            .frontmatter
            .get("custom"),
        Some(&Value::Null)
    );
}

#[test]
fn mutation_preflights_leave_the_hosted_working_set_unchanged() {
    let workspace = WorkingSet::materialize(
        resources(),
        [
            StoredDocument {
                record_id: Uuid::new_v4(),
                path: "tasks/target.md".to_string(),
                document: "---\ntype: task\ntitle: Target\nstatus: open\n---\nTarget body.\n"
                    .to_string(),
            },
            StoredDocument {
                record_id: Uuid::new_v4(),
                path: "tasks/ref.md".to_string(),
                document: "---\ntype: task\ntitle: Ref\nstatus: open\n---\nSee [[tasks/target]].\n"
                    .to_string(),
            },
        ],
    )
    .unwrap();

    let rename = workspace
        .read_operation(
            "rename",
            &json!({
                "from": "tasks/target.md",
                "to": "archive/target.md",
                "update_refs": true,
                "dry_run": true
            }),
        )
        .unwrap();
    assert!(rename.valid, "{:?}", rename.diagnostics);
    assert_eq!(rename.result["would_rename"], json!(true));
    assert_eq!(
        rename.result["references_affected"][0]["path"],
        json!("tasks/ref.md")
    );

    let deletion = workspace
        .read_operation(
            "delete",
            &json!({
                "path": "tasks/target.md",
                "check_backlinks": true,
                "dry_run": true
            }),
        )
        .unwrap();
    assert!(deletion.valid, "{:?}", deletion.diagnostics);
    assert_eq!(deletion.result["deleted"], json!(false));
    assert_eq!(
        deletion.result["broken_links"][0]["path"],
        json!("tasks/ref.md")
    );
    assert!(
        workspace
            .read_operation("read", &json!({"path": "tasks/target.md"}))
            .unwrap()
            .valid
    );
    assert!(
        !workspace
            .read_operation("read", &json!({"path": "archive/target.md"}))
            .unwrap()
            .valid
    );
}

#[test]
fn rejects_paths_that_could_escape_the_working_set() {
    let mut workspace = WorkingSet::materialize(resources(), []).unwrap();
    let mutation = SyncMutation {
        mutation_id: Uuid::new_v4(),
        replica_id: Uuid::new_v4(),
        scope_epoch: 1,
        operation: SyncMutationOperation::Put,
        record_id: Uuid::new_v4(),
        base_revision: None,
        path: Some("../escape.md".to_string()),
        document: Some("---\ntype: task\ntitle: Escape\n---\n".to_string()),
        created_at: "2026-07-21T00:00:00Z".to_string(),
        causal_predecessor: None,
    };
    let error = workspace.execute_sync(&mutation).unwrap_err();
    assert_eq!(error.code, "invalid_path");
}

#[test]
fn reads_creates_and_updates_type_resources() {
    let workspace = WorkingSet::materialize(resources(), []).unwrap();
    let task = workspace
        .read_operation("read_type", &json!({"name": "task"}))
        .unwrap();
    assert!(task.valid);
    let task_revision = task.result["revision"].as_str().unwrap();
    let updated = workspace
        .type_operation(
            "update_type",
            &json!({
                "name": "task",
                "if_revision": task_revision,
                "document": task.result["document"].as_str().unwrap().replace(
                    "A generic work item.",
                    "An updated task."
                )
            }),
        )
        .unwrap();
    assert!(updated.valid, "{:?}", updated.diagnostics);

    let created = workspace
            .type_operation(
                "create_type",
                &json!({
                    "document": "---\nkind: mdbase.type\nname: project\nversion: 1\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      title: { type: string }\n---\n"
                }),
            )
            .unwrap();
    assert!(created.valid, "{:?}", created.diagnostics);
    let (types, _) = workspace.type_resources().unwrap();
    assert!(types.iter().any(|definition| definition.name == "project"));
}

#[test]
fn reads_creates_updates_and_deletes_saved_view_resources() {
    let workspace = WorkingSet::materialize(resources(), []).unwrap();
    let document = r#"---
type: view
id: task.views
version: 1
name: Task views
query: {}
views:
  - id: all
    name: All tasks
---
"#;
    let created = workspace
        .view_source_operation(
            "create_view_source",
            &json!({ "path": "views/tasks.md", "document": document }),
        )
        .unwrap();
    assert!(created.valid, "{:?}", created.diagnostics);
    let revision = created.result["revision"].as_str().unwrap();

    let read = workspace
        .read_operation("read_view_source", &json!({ "path": "views/tasks.md" }))
        .unwrap();
    assert_eq!(read.result["document"], document);

    let updated = workspace
        .view_source_operation(
            "update_view_source",
            &json!({
                "path": "views/tasks.md",
                "if_revision": revision,
                "document": document.replace("All tasks", "Open tasks"),
            }),
        )
        .unwrap();
    assert!(updated.valid, "{:?}", updated.diagnostics);
    let deleted = workspace
        .view_source_operation(
            "delete_view_source",
            &json!({
                "path": "views/tasks.md",
                "if_revision": updated.result["revision"],
            }),
        )
        .unwrap();
    assert!(deleted.valid, "{:?}", deleted.diagnostics);
}
