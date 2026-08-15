use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
};

use mdbase::{runtime::CollectionSnapshot, v03::OperationResult, Collection};
use mdbase_connect_protocol::{
    ApplyCollectionSetupInput, ApplyTypePackInput, AssessCollectionSetupInput, AssessTypePackInput,
    SyncMutation, SyncMutationOperation, SyncRecord,
};
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

    pub fn snapshot_records(&self) -> ApiResult<Vec<SyncRecord>> {
        let collection = Collection::open(self.directory.path()).map_err(|error| {
            ApiError::internal(format!(
                "The hosted collection working set is invalid: {error}"
            ))
        })?;
        self.records_by_path
            .iter()
            .map(|(path, record_id)| {
                let snapshot = collection.snapshot_record(path).map_err(|error| {
                    ApiError::internal(format!(
                        "The hosted collection could not snapshot {path}: {error}"
                    ))
                })?;
                Ok(SyncRecord {
                    record_id: *record_id,
                    path: snapshot.path,
                    document: snapshot.document,
                    revision: snapshot.revision,
                    frontmatter: snapshot.frontmatter,
                    body: snapshot.body,
                    types: snapshot.types,
                })
            })
            .collect()
    }

    pub fn execute_semantic(
        &mut self,
        record_id: Uuid,
        operation: &str,
        source: &serde_json::Map<String, Value>,
    ) -> ApiResult<Execution> {
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
        let current_path = self.paths_by_record_id.get(&record_id).cloned();
        let (input, primary_before_path) =
            operation_input(operation, source, current_path.as_deref())?;
        // This workspace is already an isolated disposable stage backed by the
        // provider's database transaction. The provider invalidates the cache
        // before execution, so any rejected operation or failed commit forces
        // a fresh materialization from durable state.
        let envelope = operations.execute_staged_mutation(operation, &input);
        if !envelope.valid {
            return Ok(Execution {
                envelope,
                primary_record_id: record_id,
                changed: Vec::new(),
            });
        }

        let primary_after_path = match operation {
            "create" => input.get("path").and_then(Value::as_str),
            "update" => current_path.as_deref(),
            "rename" => input.get("to").and_then(Value::as_str),
            "delete" => None,
            _ => None,
        };
        let mut affected = BTreeSet::new();
        if let Some(path) = primary_after_path {
            affected.insert((path.to_string(), record_id));
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
        if operation == "delete" {
            changed.push((record_id, None, primary_before_path.clone()));
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
                document: snapshot.document.clone(),
                revision: snapshot.revision,
                frontmatter: snapshot.frontmatter,
                body: snapshot.body,
                types: snapshot.types,
            };
            let document = snapshot.document;
            changed.push((record_id, Some(record), Some(document)));
        }
        changed.sort_by_key(|(changed_id, _, _)| (*changed_id != record_id, *changed_id));
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
            primary_record_id: record_id,
            changed,
        })
    }

    /// Apply a replication write as exact storage, without semantic reference rewrites.
    pub fn execute_sync(&mut self, mutation: &SyncMutation) -> ApiResult<Execution> {
        let current_path = self.paths_by_record_id.get(&mutation.record_id).cloned();
        let mut changed = Vec::new();
        match mutation.operation {
            SyncMutationOperation::Put => {
                let path = mutation.path.as_deref().ok_or_else(|| {
                    ApiError::bad_request("invalid_mutation", "Put mutation path is required.")
                })?;
                let document = mutation.document.as_deref().ok_or_else(|| {
                    ApiError::bad_request("invalid_mutation", "Put mutation document is required.")
                })?;
                if current_path
                    .as_deref()
                    .is_some_and(|current| current != path)
                {
                    return Err(ApiError::bad_request(
                        "put_path_mismatch",
                        "Move a record separately before replacing its document.",
                    ));
                }
                if self
                    .records_by_path
                    .get(path)
                    .is_some_and(|record_id| *record_id != mutation.record_id)
                {
                    return Err(ApiError::conflict(
                        "record_path_conflict",
                        "Another hosted record already uses the destination path.",
                    ));
                }
                write_document(self.directory.path(), path, document)?;
                let snapshot = Collection::open(self.directory.path())
                    .map_err(|error| {
                        ApiError::internal(format!(
                            "The hosted collection could not reopen: {error}"
                        ))
                    })?
                    .snapshot_record(path)
                    .map_err(|error| {
                        ApiError::bad_request(
                            "invalid_record",
                            format!("The exact Markdown document is not a valid record: {error}"),
                        )
                    })?;
                let record = SyncRecord {
                    record_id: mutation.record_id,
                    path: snapshot.path,
                    document: snapshot.document.clone(),
                    revision: snapshot.revision,
                    frontmatter: snapshot.frontmatter,
                    body: snapshot.body,
                    types: snapshot.types,
                };
                changed.push((mutation.record_id, Some(record), Some(snapshot.document)));
            }
            SyncMutationOperation::Move => {
                let from = current_path.as_deref().ok_or_else(|| {
                    ApiError::not_found("record_not_found", "The hosted record does not exist.")
                })?;
                let to = mutation.path.as_deref().ok_or_else(|| {
                    ApiError::bad_request("invalid_mutation", "Move mutation path is required.")
                })?;
                if self
                    .records_by_path
                    .get(to)
                    .is_some_and(|record_id| *record_id != mutation.record_id)
                {
                    return Err(ApiError::conflict(
                        "record_path_conflict",
                        "Another hosted record already uses the destination path.",
                    ));
                }
                let source = safe_path(self.directory.path(), from)?;
                let target = safe_path(self.directory.path(), to)?;
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::rename(source, target)?;
                let snapshot = Collection::open(self.directory.path())
                    .map_err(|error| {
                        ApiError::internal(format!(
                            "The hosted collection could not reopen: {error}"
                        ))
                    })?
                    .snapshot_record(to)
                    .map_err(|error| {
                        ApiError::bad_request(
                            "invalid_record_path",
                            format!("The destination is not a valid record path: {error}"),
                        )
                    })?;
                let record = SyncRecord {
                    record_id: mutation.record_id,
                    path: snapshot.path,
                    document: snapshot.document.clone(),
                    revision: snapshot.revision,
                    frontmatter: snapshot.frontmatter,
                    body: snapshot.body,
                    types: snapshot.types,
                };
                changed.push((mutation.record_id, Some(record), Some(snapshot.document)));
            }
            SyncMutationOperation::Delete => {
                let path = current_path.as_deref().ok_or_else(|| {
                    ApiError::not_found("record_not_found", "The hosted record does not exist.")
                })?;
                fs::remove_file(safe_path(self.directory.path(), path)?)?;
                changed.push((mutation.record_id, None, Some(path.to_string())));
            }
        }
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
            envelope: OperationResult {
                valid: true,
                result: serde_json::json!({}),
                diagnostics: Vec::new(),
            },
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
mod tests;
