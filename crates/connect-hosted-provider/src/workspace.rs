use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
};

use mdbase::{runtime::CollectionSnapshot, v03::OperationResult, Collection};
use mdbase_connect_protocol::{
    ApplyCollectionSetupInput, ApplyTypePackInput, AssessCollectionSetupInput, AssessTypePackInput,
    SyncMutation, SyncMutationOperation, SyncRecord,
};
use mdbase_connect_runtime::contract_scope::{ContractScope, ContractSelector};
use serde_json::Value;
use tempfile::TempDir;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

mod resource_catalog;
mod support;
mod type_packs;
mod types;
use support::{operation_input, safe_path, write_document};
use type_packs::{engine_collection_setup, engine_contract_setup, engine_type_pack_provision};
pub use types::{Execution, StoredDocument};

pub struct WorkingSet {
    directory: TempDir,
    records_by_path: BTreeMap<String, Uuid>,
    paths_by_record_id: BTreeMap<Uuid, String>,
}

impl WorkingSet {
    pub fn materialize(
        resources: impl IntoIterator<Item = (String, String)>,
        records: impl IntoIterator<Item = StoredDocument>,
    ) -> ApiResult<Self> {
        let directory = tempfile::tempdir()?;
        for (path, document) in resources {
            write_document(directory.path(), &path, &document)?;
        }
        let mut records_by_path = BTreeMap::new();
        let mut paths_by_record_id = BTreeMap::new();
        for record in records {
            write_document(directory.path(), &record.path, &record.document)?;
            paths_by_record_id.insert(record.record_id, record.path.clone());
            records_by_path.insert(record.path, record.record_id);
        }
        Collection::open(directory.path()).map_err(|error| {
            ApiError::internal(format!(
                "The hosted collection working set is invalid: {error}"
            ))
        })?;
        Ok(Self {
            directory,
            records_by_path,
            paths_by_record_id,
        })
    }

    pub fn execute(&mut self, mutation: &SyncMutation) -> ApiResult<Execution> {
        let collection = Collection::open(self.directory.path()).map_err(|error| {
            ApiError::internal(format!(
                "The hosted collection working set is invalid: {error}"
            ))
        })?;
        let operations = collection.v03_operations().map_err(|diagnostic| {
            ApiError::internal(format!(
                "The hosted collection could not open: {}",
                diagnostic.message
            ))
        })?;
        let current_path = self.paths_by_record_id.get(&mutation.record_id).cloned();
        let (input, primary_before_path) = operation_input(mutation, current_path.as_deref())?;
        let operation = match mutation.operation {
            SyncMutationOperation::Create => "create",
            SyncMutationOperation::Update => "update",
            SyncMutationOperation::Rename => "rename",
            SyncMutationOperation::Delete => "delete",
        };
        // This workspace is already an isolated disposable stage backed by the
        // provider's database transaction. The provider invalidates the cache
        // before execution, so any rejected operation or failed commit forces
        // a fresh materialization from durable state.
        let envelope = operations.execute_staged_mutation(operation, &input);
        if !envelope.valid {
            return Ok(Execution {
                envelope,
                primary_record_id: mutation.record_id,
                changed: Vec::new(),
            });
        }

        let primary_after_path = match mutation.operation {
            SyncMutationOperation::Create => input.get("path").and_then(Value::as_str),
            SyncMutationOperation::Update => current_path.as_deref(),
            SyncMutationOperation::Rename => input.get("to").and_then(Value::as_str),
            SyncMutationOperation::Delete => None,
        };
        let mut affected = BTreeSet::new();
        if let Some(path) = primary_after_path {
            affected.insert((path.to_string(), mutation.record_id));
        }
        if let Some(references) = envelope
            .result
            .get("references_updated")
            .and_then(Value::as_array)
        {
            for reference in references {
                if let Some(path) = reference.get("path").and_then(Value::as_str) {
                    if let Some(record_id) = self.records_by_path.get(path) {
                        affected.insert((path.to_string(), *record_id));
                    }
                }
            }
        }

        let collection = Collection::open(self.directory.path()).map_err(|error| {
            ApiError::internal(format!(
                "The mutated hosted collection could not open: {error}"
            ))
        })?;
        let mut changed = Vec::new();
        if mutation.operation == SyncMutationOperation::Delete {
            changed.push((mutation.record_id, None, primary_before_path.clone()));
        }
        for (path, record_id) in affected {
            let snapshot = collection.snapshot_record(&path).map_err(|error| {
                ApiError::internal(format!(
                    "mdbase-rs accepted a mutation but could not snapshot its resulting record: {error}"
                ))
            })?;
            let record = SyncRecord {
                record_id,
                path: snapshot.path,
                revision: snapshot.revision,
                frontmatter: snapshot.frontmatter,
                body: snapshot.body,
                types: snapshot.types,
            };
            let document = snapshot.document;
            changed.push((record_id, Some(record), Some(document)));
        }
        changed.sort_by_key(|(record_id, _, _)| (*record_id != mutation.record_id, *record_id));
        for (record_id, after, _) in &changed {
            if let Some(previous_path) = self.paths_by_record_id.remove(record_id) {
                self.records_by_path.remove(&previous_path);
            }
            if let Some(record) = after {
                self.records_by_path.insert(record.path.clone(), *record_id);
                self.paths_by_record_id
                    .insert(*record_id, record.path.clone());
            }
        }
        Ok(Execution {
            envelope,
            primary_record_id: mutation.record_id,
            changed,
        })
    }

    pub fn snapshot(&self) -> ApiResult<CollectionSnapshot> {
        Collection::open(self.directory.path())
            .map_err(|error| {
                ApiError::bad_request(
                    "invalid_authority_snapshot",
                    format!("The imported collection could not open: {error}"),
                )
            })?
            .snapshot()
            .map_err(|error| {
                ApiError::bad_request(
                    "invalid_authority_snapshot",
                    format!("The imported collection is invalid: {error}"),
                )
            })
    }

    pub fn read_operation(&self, operation: &str, input: &Value) -> ApiResult<OperationResult> {
        let collection = Collection::open(self.directory.path()).map_err(|error| {
            ApiError::internal(format!(
                "The hosted collection working set is invalid: {error}"
            ))
        })?;
        let operations = collection.v03_operations().map_err(|diagnostic| {
            ApiError::internal(format!(
                "The hosted collection could not open: {}",
                diagnostic.message
            ))
        })?;
        match operation {
            "read" => Ok(operations.read(input)),
            "read_type" => Ok(operations.read_type(input)),
            "query" => Ok(operations.query(input)),
            "list_views" => Ok(operations.list_views(input)),
            "execute_view" => Ok(operations.execute_view(input)),
            "read_view_source" => Ok(operations.read_view_source(input)),
            "validate" => Ok(operations.validate(input)),
            "assess_type_pack" => {
                let request = serde_json::from_value::<AssessTypePackInput>(input.clone())
                    .map_err(|error| {
                        ApiError::bad_request(
                            "invalid_type_pack",
                            format!("The type-pack assessment is invalid: {error}"),
                        )
                    })?;
                self.assess_type_pack(&request)
            }
            "assess_collection_setup" => {
                let request = serde_json::from_value::<AssessCollectionSetupInput>(input.clone())
                    .map_err(|error| {
                    ApiError::bad_request(
                        "invalid_collection_setup",
                        format!("The collection setup assessment is invalid: {error}"),
                    )
                })?;
                self.assess_collection_setup(&request)
            }
            "delete" if input.get("dry_run").and_then(Value::as_bool) == Some(true) => {
                Ok(operations.delete(input))
            }
            "rename" if input.get("dry_run").and_then(Value::as_bool) == Some(true) => {
                Ok(operations.rename(input))
            }
            _ => Err(ApiError::bad_request(
                "unsupported_operation",
                "The hosted provider does not support that read operation.",
            )),
        }
    }

    pub fn project_contract_result(
        &self,
        scope: &ContractScope,
        envelope: OperationResult,
        selector: Option<&ContractSelector>,
    ) -> ApiResult<Value> {
        let collection = Collection::open(self.directory.path()).map_err(|error| {
            ApiError::internal(format!(
                "The hosted contract projection registry is invalid: {error}"
            ))
        })?;
        scope
            .project_result(
                &collection,
                serde_json::to_value(envelope).map_err(|error| {
                    ApiError::internal(format!(
                        "Hosted operation could not serialize before projection: {error}"
                    ))
                })?,
                selector,
            )
            .map_err(|error| ApiError::forbidden("scope_denied", error.to_string()))
    }

    pub fn view_source_operation(
        &self,
        operation: &str,
        input: &Value,
    ) -> ApiResult<OperationResult> {
        let collection = Collection::open(self.directory.path()).map_err(|error| {
            ApiError::internal(format!(
                "The hosted collection working set is invalid: {error}"
            ))
        })?;
        let operations = collection.v03_operations().map_err(|diagnostic| {
            ApiError::internal(format!(
                "The hosted collection could not open: {}",
                diagnostic.message
            ))
        })?;
        match operation {
            "create_view_source" => Ok(operations.create_view_source(input)),
            "update_view_source" => Ok(operations.update_view_source(input)),
            "delete_view_source" => Ok(operations.delete_view_source(input)),
            _ => Err(ApiError::bad_request(
                "unsupported_operation",
                "The hosted provider does not support that saved-view source operation.",
            )),
        }
    }

    pub fn type_operation(&self, operation: &str, input: &Value) -> ApiResult<OperationResult> {
        let collection = Collection::open(self.directory.path()).map_err(|error| {
            ApiError::internal(format!(
                "The hosted collection working set is invalid: {error}"
            ))
        })?;
        let operations = collection.v03_operations().map_err(|diagnostic| {
            ApiError::internal(format!(
                "The hosted collection could not open: {}",
                diagnostic.message
            ))
        })?;
        match operation {
            "create_type" => Ok(operations.create_type(input)),
            "update_type" => Ok(operations.update_type(input)),
            _ => Err(ApiError::bad_request(
                "unsupported_operation",
                "The hosted provider does not support that type operation.",
            )),
        }
    }

    pub fn assess_type_pack(&self, input: &AssessTypePackInput) -> ApiResult<OperationResult> {
        let collection = Collection::open(self.directory.path()).map_err(|error| {
            ApiError::internal(format!(
                "The hosted collection working set is invalid: {error:?}"
            ))
        })?;
        let provision = engine_type_pack_provision(&input.provision)?;
        let contract_setups = input
            .contract_setups
            .iter()
            .map(engine_contract_setup)
            .collect();
        Ok(collection.assess_type_pack(
            &provision,
            &mdbase::v03::TypePackAssessmentOptions {
                installed_by: input.installed_by.clone(),
                adopt_resources: input.adopt_resources.clone(),
                preserve_seed_targets: input.preserve_seed_targets.clone(),
                target_overrides: input.target_overrides.clone(),
                contract_setups,
            },
        ))
    }

    pub fn apply_type_pack(&self, input: &ApplyTypePackInput) -> ApiResult<OperationResult> {
        let collection = Collection::open(self.directory.path()).map_err(|error| {
            ApiError::internal(format!(
                "The hosted collection working set is invalid: {error:?}"
            ))
        })?;
        let provision = engine_type_pack_provision(&input.provision)?;
        let contract_setups = input
            .contract_setups
            .iter()
            .map(engine_contract_setup)
            .collect();
        Ok(collection.apply_type_pack(
            &provision,
            &mdbase::v03::TypePackApplyOptions {
                installed_by: input.installed_by.clone(),
                expected_assessment_digest: input.expected_assessment_digest.clone(),
                allow_downgrade: input.allow_downgrade,
                adopt_resources: input.adopt_resources.clone(),
                preserve_seed_targets: input.preserve_seed_targets.clone(),
                target_overrides: input.target_overrides.clone(),
                contract_setups,
            },
        ))
    }

    pub fn assess_collection_setup(
        &self,
        input: &AssessCollectionSetupInput,
    ) -> ApiResult<OperationResult> {
        let collection = Collection::open(self.directory.path()).map_err(|error| {
            ApiError::internal(format!(
                "The hosted collection working set is invalid: {error:?}"
            ))
        })?;
        Ok(collection.assess_collection_setup(&engine_collection_setup(input)?))
    }

    pub fn apply_collection_setup(
        &self,
        input: &ApplyCollectionSetupInput,
    ) -> ApiResult<OperationResult> {
        let collection = Collection::open(self.directory.path()).map_err(|error| {
            ApiError::internal(format!(
                "The hosted collection working set is invalid: {error:?}"
            ))
        })?;
        Ok(collection.apply_collection_setup(
            &engine_collection_setup(&input.setup)?,
            &mdbase::v03::CollectionSetupApplyOptions {
                expected_assessment_digest: input.expected_assessment_digest.clone(),
                expected_collection_revision: input.expected_collection_revision.clone(),
                expected_provision_digest: input.expected_provision_digest.clone(),
                allow_type_pack_downgrades: input.allow_type_pack_downgrades.clone(),
            },
        ))
    }

    pub fn resource_document(&self, path: &str) -> ApiResult<String> {
        fs::read_to_string(safe_path(self.directory.path(), path)?).map_err(Into::into)
    }
}

#[cfg(test)]
mod contract_setup_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Map};

    pub(super) fn resources() -> Vec<(String, String)> {
        let mut resources: Vec<(String, String)> = crate::template::resources("mdbase", "UTC")
            .unwrap()
            .1
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
        let mutation = SyncMutation {
            mutation_id: Uuid::new_v4(),
            replica_id: Uuid::new_v4(),
            scope_epoch: 1,
            operation: SyncMutationOperation::Create,
            record_id: Uuid::new_v4(),
            base_revision: None,
            input: Map::from_iter([
                ("path".to_string(), json!("tasks/first.md")),
                (
                    "frontmatter".to_string(),
                    json!({"type": "task", "title": "First"}),
                ),
                ("body".to_string(), json!("Body")),
                ("types".to_string(), json!(["task"])),
            ]),
            created_at: "2026-07-21T00:00:00Z".to_string(),
            causal_predecessor: None,
        };
        let execution = workspace.execute(&mutation).unwrap();
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
        let replica_id = Uuid::new_v4();
        let original = "---\ntitle: [unterminated\n---\nOriginal body";
        let mut workspace = WorkingSet::materialize(resources(), []).unwrap();
        let created = workspace
            .execute(&SyncMutation {
                mutation_id: Uuid::new_v4(),
                replica_id,
                scope_epoch: 1,
                operation: SyncMutationOperation::Create,
                record_id,
                base_revision: None,
                input: Map::from_iter([
                    ("path".to_string(), json!("opaque.md")),
                    ("frontmatter".to_string(), json!({})),
                    ("body".to_string(), json!(original)),
                ]),
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
            .execute(&SyncMutation {
                mutation_id: Uuid::new_v4(),
                replica_id,
                scope_epoch: 1,
                operation: SyncMutationOperation::Update,
                record_id,
                base_revision: Some(created_record.revision.clone()),
                input: Map::from_iter([
                    ("patch".to_string(), json!({})),
                    ("body".to_string(), json!(replacement)),
                ]),
                created_at: "2026-07-21T00:00:01Z".to_string(),
                causal_predecessor: None,
            })
            .unwrap();

        assert!(updated.envelope.valid, "{:?}", updated.envelope.diagnostics);
        assert_eq!(updated.changed[0].1.as_ref().unwrap().body, replacement);
        assert_eq!(updated.changed[0].2.as_deref(), Some(replacement));
    }

    #[test]
    fn adapts_sync_update_patches_for_the_supported_v03_engine() {
        let record_id = Uuid::new_v4();
        let replica_id = Uuid::new_v4();
        let mut workspace = WorkingSet::materialize(resources(), []).unwrap();
        let created = workspace
            .execute(&SyncMutation {
                mutation_id: Uuid::new_v4(),
                replica_id,
                scope_epoch: 1,
                operation: SyncMutationOperation::Create,
                record_id,
                base_revision: None,
                input: Map::from_iter([
                    ("path".to_string(), json!("tasks/update.md")),
                    (
                        "frontmatter".to_string(),
                        json!({"type": "task", "title": "Update", "status": "open"}),
                    ),
                    ("body".to_string(), json!("")),
                    ("types".to_string(), json!(["task"])),
                ]),
                created_at: "2026-07-21T00:00:00Z".to_string(),
                causal_predecessor: None,
            })
            .unwrap();
        let revision = created.changed[0].1.as_ref().unwrap().revision.clone();

        let updated = workspace
            .execute(&SyncMutation {
                mutation_id: Uuid::new_v4(),
                replica_id,
                scope_epoch: 1,
                operation: SyncMutationOperation::Update,
                record_id,
                base_revision: Some(revision),
                input: Map::from_iter([("patch".to_string(), json!({"status": "done"}))]),
                created_at: "2026-07-21T00:00:01Z".to_string(),
                causal_predecessor: None,
            })
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
        let replica_id = Uuid::new_v4();
        let mut workspace = WorkingSet::materialize(resources(), []).unwrap();
        let created = workspace
            .execute(&SyncMutation {
                mutation_id: Uuid::new_v4(),
                replica_id,
                scope_epoch: 1,
                operation: SyncMutationOperation::Create,
                record_id,
                base_revision: None,
                input: Map::from_iter([
                    ("path".to_string(), json!("tasks/indexed.md")),
                    (
                        "frontmatter".to_string(),
                        json!({"type": "task", "title": "Indexed"}),
                    ),
                    ("body".to_string(), json!("")),
                    ("types".to_string(), json!(["task"])),
                ]),
                created_at: "2026-07-21T00:00:00Z".to_string(),
                causal_predecessor: None,
            })
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
            .execute(&SyncMutation {
                mutation_id: Uuid::new_v4(),
                replica_id,
                scope_epoch: 1,
                operation: SyncMutationOperation::Rename,
                record_id,
                base_revision: Some(created_revision),
                input: Map::from_iter([("path".to_string(), json!("archive/indexed.md"))]),
                created_at: "2026-07-21T00:00:01Z".to_string(),
                causal_predecessor: None,
            })
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
            .execute(&SyncMutation {
                mutation_id: Uuid::new_v4(),
                replica_id,
                scope_epoch: 1,
                operation: SyncMutationOperation::Delete,
                record_id,
                base_revision: Some(renamed_revision),
                input: Map::new(),
                created_at: "2026-07-21T00:00:02Z".to_string(),
                causal_predecessor: None,
            })
            .unwrap();
        assert!(deleted.envelope.valid, "{:?}", deleted.envelope.diagnostics);
        assert!(!workspace.records_by_path.contains_key("archive/indexed.md"));
        assert!(!workspace.paths_by_record_id.contains_key(&record_id));
    }

    #[test]
    fn reads_and_replaces_exact_markdown_documents() {
        let record_id = Uuid::new_v4();
        let replica_id = Uuid::new_v4();
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
            .execute(&SyncMutation {
                mutation_id: Uuid::new_v4(),
                replica_id,
                scope_epoch: 1,
                operation: SyncMutationOperation::Update,
                record_id,
                base_revision: Some(revision),
                input: Map::from_iter([("document".to_string(), json!(replacement))]),
                created_at: "2026-07-21T00:00:01Z".to_string(),
                causal_predecessor: None,
            })
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
                    document:
                        "---\ntype: task\ntitle: Ref\nstatus: open\n---\nSee [[tasks/target]].\n"
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
            operation: SyncMutationOperation::Create,
            record_id: Uuid::new_v4(),
            base_revision: None,
            input: Map::from_iter([
                ("path".to_string(), json!("../escape.md")),
                (
                    "frontmatter".to_string(),
                    json!({"type": "task", "title": "Escape"}),
                ),
            ]),
            created_at: "2026-07-21T00:00:00Z".to_string(),
            causal_predecessor: None,
        };
        let error = workspace.execute(&mutation).unwrap_err();
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
}
