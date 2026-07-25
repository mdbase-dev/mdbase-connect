use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
};

use mdbase::{
    v03::{Diagnostic, OperationResult},
    Collection,
};
use mdbase_connect_protocol::{SyncMutation, SyncMutationOperation, SyncRecord};
use serde_json::{json, Map, Value};
use tempfile::TempDir;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

#[derive(Debug, Clone)]
pub struct StoredDocument {
    pub record_id: Uuid,
    pub path: String,
    pub document: String,
}

pub struct WorkingSet {
    directory: TempDir,
    records_by_path: BTreeMap<String, Uuid>,
}

#[derive(Debug)]
pub struct Execution {
    pub envelope: OperationResult,
    pub primary_record_id: Uuid,
    pub changed: Vec<(Uuid, Option<SyncRecord>, Option<String>)>,
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
        for record in records {
            write_document(directory.path(), &record.path, &record.document)?;
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
        let current_path = self
            .records_by_path
            .iter()
            .find_map(|(path, id)| (*id == mutation.record_id).then(|| path.clone()));
        let (input, primary_before_path) = operation_input(mutation, current_path.as_deref())?;
        let envelope = match mutation.operation {
            SyncMutationOperation::Create => operations.create(&input),
            SyncMutationOperation::Update => operations.update(&input),
            SyncMutationOperation::Rename => operations.rename(&input),
            SyncMutationOperation::Delete => operations.delete(&input),
        };
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
        let operations = collection.v03_operations().map_err(|diagnostic| {
            ApiError::internal(format!(
                "The mutated hosted collection could not open: {}",
                diagnostic.message
            ))
        })?;
        let mut changed = Vec::new();
        if mutation.operation == SyncMutationOperation::Delete {
            changed.push((mutation.record_id, None, primary_before_path.clone()));
        }
        for (path, record_id) in affected {
            let read = operations.read(&json!({ "path": path }));
            if !read.valid {
                return Err(ApiError::internal(
                    "mdbase-rs accepted a mutation but could not read its resulting record.",
                ));
            }
            let record = sync_record(record_id, &read.result)?;
            let document = fs::read_to_string(safe_path(self.directory.path(), &record.path)?)?;
            changed.push((record_id, Some(record), Some(document)));
        }
        changed.sort_by_key(|(record_id, _, _)| (*record_id != mutation.record_id, *record_id));
        for (record_id, after, _) in &changed {
            self.records_by_path
                .retain(|_, candidate| candidate != record_id);
            if let Some(record) = after {
                self.records_by_path.insert(record.path.clone(), *record_id);
            }
        }
        Ok(Execution {
            envelope,
            primary_record_id: mutation.record_id,
            changed,
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
            // Query execution remains entirely in mdbase-rs. Its v0.3 query
            // facade is newer than the minimum path dependency supported by
            // the hosted build, so only the common legacy envelope is adapted
            // at this storage boundary.
            "query" => Ok(query_result(&collection, input)),
            "list_views" => Ok(operations.list_views(input)),
            "execute_view" => Ok(operations.execute_view(input)),
            "read_view_source" => Ok(operations.read_view_source(input)),
            "validate" => Ok(operations.validate(input)),
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

    pub fn resource_document(&self, path: &str) -> ApiResult<String> {
        fs::read_to_string(safe_path(self.directory.path(), path)?).map_err(Into::into)
    }

    pub fn type_resources(
        &self,
    ) -> ApiResult<(
        Vec<mdbase_connect_protocol::CollectionTypeDescriptor>,
        Vec<mdbase_connect_protocol::CollectionContractDescriptor>,
    )> {
        let report = mdbase::v03::inspect_collection(self.directory.path());
        if !report.valid {
            return Err(ApiError::internal(
                report
                    .diagnostics
                    .first()
                    .map(|diagnostic| diagnostic.message.clone())
                    .unwrap_or_else(|| "The hosted type registry is invalid.".to_string()),
            ));
        }
        let mut types = Vec::new();
        let mut contracts = Vec::new();
        for type_file in report.types {
            let description = type_file
                .frontmatter
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string);
            let collection = type_file.frontmatter.get("collection").cloned();
            let lifecycle = type_file.frontmatter.get("lifecycle").cloned();
            let extensions = type_file
                .frontmatter
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(key, _)| key.starts_with("x-"))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<Map<_, _>>();
            for (extension, configuration) in &extensions {
                let Some(id) = configuration.get("contract").and_then(Value::as_str) else {
                    continue;
                };
                contracts.push(mdbase_connect_protocol::CollectionContractDescriptor {
                    id: id.to_string(),
                    version: configuration
                        .get("version")
                        .and_then(Value::as_u64)
                        .unwrap_or(1),
                    type_name: type_file.name.clone(),
                    extension: extension.clone(),
                    configuration: configuration.clone(),
                });
            }
            types.push(mdbase_connect_protocol::CollectionTypeDescriptor {
                name: type_file.name,
                version: type_file.version,
                description,
                path: Some(type_file.path),
                definition: type_file
                    .frontmatter
                    .as_object()
                    .cloned()
                    .map(Value::Object),
                schema: type_file.schema,
                collection,
                lifecycle,
                extensions,
            });
        }
        types.sort_by(|left, right| left.name.cmp(&right.name));
        contracts.sort_by(|left, right| {
            (&left.id, left.version, &left.type_name).cmp(&(
                &right.id,
                right.version,
                &right.type_name,
            ))
        });
        Ok((types, contracts))
    }

    pub fn classify_records(
        &self,
        records: &[(Uuid, String, Map<String, Value>)],
    ) -> ApiResult<BTreeMap<Uuid, Vec<String>>> {
        let collection = Collection::open(self.directory.path()).map_err(|error| {
            ApiError::internal(format!(
                "The hosted collection working set is invalid: {error}"
            ))
        })?;
        Ok(records
            .iter()
            .map(|(id, path, frontmatter)| {
                (
                    *id,
                    collection
                        .determine_types_for_path(&Value::Object(frontmatter.clone()), Some(path)),
                )
            })
            .collect())
    }
}

fn query_result(collection: &Collection, input: &Value) -> OperationResult {
    let legacy = collection.query(input);
    let mut result = legacy.as_object().cloned().unwrap_or_default();
    let diagnostic = result.get("error").map(|error| {
        let code = error
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("query_failed");
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("The hosted query failed.");
        Diagnostic::error(code, message, None)
    });
    for key in ["valid", "error", "issues", "validation", "warnings"] {
        result.remove(key);
    }
    if input.get("include_body").and_then(Value::as_bool) != Some(true) {
        if let Some(records) = result.get_mut("results").and_then(Value::as_array_mut) {
            for record in records {
                if let Some(object) = record.as_object_mut() {
                    object.remove("body");
                }
            }
        }
    }
    OperationResult {
        valid: diagnostic.is_none(),
        result: Value::Object(result),
        diagnostics: diagnostic.into_iter().collect(),
    }
}

fn operation_input(
    mutation: &SyncMutation,
    current_path: Option<&str>,
) -> ApiResult<(Value, Option<String>)> {
    let value = Value::Object(mutation.input.clone());
    match mutation.operation {
        SyncMutationOperation::Create => {
            let path = required_string(&value, "path")?;
            safe_relative(path)?;
            let mut input = mutation.input.clone();
            input.remove("types");
            Ok((Value::Object(input), None))
        }
        SyncMutationOperation::Update => {
            let path = current_path.ok_or_else(|| {
                ApiError::not_found("record_not_found", "The hosted record does not exist.")
            })?;
            let mut input = mutation.input.clone();
            // Connect exposes `patch`; the embedded Collection API consumes
            // the equivalent `fields` object. Keep that translation isolated
            // at this engine adapter.
            if let Some(patch) = input.remove("patch") {
                input.insert("fields".to_string(), patch);
            }
            input.insert("path".to_string(), Value::String(path.to_string()));
            if let Some(revision) = &mutation.base_revision {
                input.insert("if_revision".to_string(), Value::String(revision.clone()));
            }
            Ok((Value::Object(input), Some(path.to_string())))
        }
        SyncMutationOperation::Rename => {
            let from = current_path.ok_or_else(|| {
                ApiError::not_found("record_not_found", "The hosted record does not exist.")
            })?;
            let to = required_string(&value, "path")?;
            safe_relative(to)?;
            let mut input = Map::from_iter([
                ("from".to_string(), Value::String(from.to_string())),
                ("to".to_string(), Value::String(to.to_string())),
                ("update_refs".to_string(), Value::Bool(true)),
            ]);
            if let Some(revision) = &mutation.base_revision {
                input.insert("if_revision".to_string(), Value::String(revision.clone()));
            }
            Ok((Value::Object(input), Some(from.to_string())))
        }
        SyncMutationOperation::Delete => {
            let path = current_path.ok_or_else(|| {
                ApiError::not_found("record_not_found", "The hosted record does not exist.")
            })?;
            let mut input = Map::from_iter([("path".to_string(), Value::String(path.to_string()))]);
            if let Some(revision) = &mutation.base_revision {
                input.insert("if_revision".to_string(), Value::String(revision.clone()));
            }
            Ok((Value::Object(input), Some(path.to_string())))
        }
    }
}

fn sync_record(record_id: Uuid, result: &Value) -> ApiResult<SyncRecord> {
    let path = required_string(result, "path")?.to_string();
    safe_relative(&path)?;
    let revision = required_string(result, "revision")?.to_string();
    let frontmatter = result
        .get("raw_frontmatter")
        .or_else(|| result.get("frontmatter"))
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| ApiError::internal("mdbase-rs returned invalid record frontmatter."))?;
    let body = result
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let types = result
        .get("types")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    Ok(SyncRecord {
        record_id,
        path,
        revision,
        frontmatter,
        body,
        types,
    })
}

fn required_string<'a>(value: &'a Value, field: &str) -> ApiResult<&'a str> {
    value.get(field).and_then(Value::as_str).ok_or_else(|| {
        ApiError::bad_request(
            "invalid_mutation",
            format!("Hosted mutation input requires {field}."),
        )
    })
}

fn write_document(root: &Path, relative: &str, document: &str) -> ApiResult<()> {
    let path = safe_path(root, relative)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, document)?;
    Ok(())
}

fn safe_path(root: &Path, relative: &str) -> ApiResult<PathBuf> {
    safe_relative(relative)?;
    Ok(root.join(relative))
}

fn safe_relative(relative: &str) -> ApiResult<()> {
    let path = Path::new(relative);
    if relative.is_empty()
        || relative.contains('\\')
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir
                    | Component::CurDir
                    | Component::RootDir
                    | Component::Prefix(_)
            )
        })
    {
        return Err(ApiError::bad_request(
            "invalid_path",
            "Hosted record paths must be safe collection-relative paths.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resources() -> Vec<(String, String)> {
        let mut resources: Vec<(String, String)> = crate::template::resources("mdbase")
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
