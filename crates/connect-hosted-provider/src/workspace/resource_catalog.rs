use std::collections::BTreeMap;

use mdbase::Collection;
use mdbase_connect_protocol::{
    CollectionContractDescriptor, CollectionContractImplementationDescriptor,
    CollectionTypeDescriptor,
};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::WorkingSet;
use crate::error::{ApiError, ApiResult};

impl WorkingSet {
    pub fn type_resources(
        &self,
    ) -> ApiResult<(
        Vec<CollectionTypeDescriptor>,
        Vec<CollectionContractDescriptor>,
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
            types.push(CollectionTypeDescriptor {
                name: type_file.name,
                version: type_file.version,
                description,
                revision: std::fs::read(self.directory.path().join(&type_file.path))
                    .ok()
                    .map(|bytes| format!("sha256:{:x}", Sha256::digest(&bytes))),
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
        let registry = Collection::open(self.directory.path()).map_err(|error| {
            ApiError::internal(format!(
                "The hosted data contract registry is invalid: {error}"
            ))
        })?;
        let mut contracts: Vec<CollectionContractDescriptor> = registry
            .list_data_contracts()
            .into_iter()
            .filter_map(|definition| {
                let implementations = registry
                    .get_data_contract_implementations(&definition.id, &definition.version)
                    .into_iter()
                    .map(
                        |implementation| CollectionContractImplementationDescriptor {
                            type_name: implementation.type_name,
                            type_version: implementation.type_version,
                            type_path: implementation.source_path,
                            digest: implementation.implementation_digest,
                            fields: implementation.fields,
                            binding: implementation.binding,
                        },
                    )
                    .collect::<Vec<_>>();
                (!implementations.is_empty()).then_some(CollectionContractDescriptor {
                    implementations,
                    contract_type: definition.contract_type,
                    id: definition.id,
                    version: definition.version,
                    digest: definition.digest,
                    schema: definition
                        .record_schema
                        .expect("record implementations require record_schema"),
                    binding_schema: definition.binding_schema,
                })
            })
            .collect();
        types.sort_by(|left, right| left.name.cmp(&right.name));
        contracts
            .sort_by(|left, right| (&left.id, &left.version).cmp(&(&right.id, &right.version)));
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
