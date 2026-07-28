use mdbase::Collection;
use mdbase_connect_protocol::{
    CollectionContractDescriptor, CollectionContractImplementationDescriptor,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;

#[derive(Debug, Error)]
#[error("{0}")]
pub struct ContractScopeError(pub String);

#[derive(Debug, Clone)]
pub struct ContractScope {
    pub contracts: Vec<CollectionContractDescriptor>,
    pub allowed_types: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContractSelector {
    pub id: String,
    pub version: String,
    pub type_name: Option<String>,
}

#[derive(Debug, Clone)]
struct SelectedContract {
    id: String,
    version: String,
    digest: String,
    implementation: CollectionContractImplementationDescriptor,
}

impl ContractScope {
    pub fn new(contracts: Vec<CollectionContractDescriptor>) -> Result<Self, ContractScopeError> {
        if contracts.is_empty() {
            return Err(error(
                "Contract-scoped grants must declare at least one required contract.",
            ));
        }
        let allowed_types = contracts
            .iter()
            .flat_map(|contract| contract.implementations.iter())
            .map(|implementation| implementation.type_name.to_lowercase())
            .collect::<BTreeSet<_>>();
        if allowed_types.is_empty() {
            return Err(error(
                "Contract-scoped grants must include at least one approved provider.",
            ));
        }
        Ok(Self {
            contracts,
            allowed_types,
        })
    }

    pub fn selector(&self, input: &Value) -> Result<Option<ContractSelector>, ContractScopeError> {
        let Some(value) = input.get("contract") else {
            return Ok(None);
        };
        let value = value
            .as_object()
            .ok_or_else(|| error("The contract selector must contain an exact id and version."))?;
        let id = value
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| error("The contract selector requires an id."))?;
        let version = value
            .get("version")
            .and_then(Value::as_str)
            .ok_or_else(|| error("The contract selector requires a version."))?;
        let type_name = value
            .get("type")
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_lowercase)
                    .ok_or_else(|| error("The contract selector type must be a string."))
            })
            .transpose()?;
        if value
            .keys()
            .any(|key| !matches!(key.as_str(), "id" | "version" | "type"))
        {
            return Err(error(
                "The contract selector accepts only id, version, and type.",
            ));
        }
        if !self
            .contracts
            .iter()
            .any(|contract| contract.id == id && contract.version == version)
        {
            return Err(error(format!(
                "Data contract '{id}' {version} is outside this application's approved scope."
            )));
        }
        Ok(Some(ContractSelector {
            id: id.to_string(),
            version: version.to_string(),
            type_name,
        }))
    }

    pub fn query_input(
        &self,
        input: &Value,
    ) -> Result<(Value, Option<ContractSelector>), ContractScopeError> {
        let selector = self.selector(input)?;
        let allowed_types = selector
            .as_ref()
            .map(|selector| self.selector_types(selector))
            .transpose()?
            .unwrap_or_else(|| self.allowed_types.clone());
        let mut scoped = input
            .as_object()
            .cloned()
            .ok_or_else(|| error("Scoped query input must be an object."))?;
        scoped.remove("contract");
        if scoped.keys().any(|key| {
            !matches!(
                key.as_str(),
                "types" | "limit" | "offset" | "frontmatter_mode"
            )
        }) {
            return Err(error(
                "Contract-scoped queries support provider selection and pagination only; filter normalized contract fields after retrieval.",
            ));
        }
        if let Some(requested) = scoped.get("types") {
            let requested = requested
                .as_array()
                .ok_or_else(|| error("Scoped query types must be a list."))?;
            if requested.is_empty() {
                scoped.insert(
                    "types".to_string(),
                    Value::Array(allowed_types.iter().cloned().map(Value::String).collect()),
                );
            } else {
                for type_name in requested {
                    let type_name = type_name
                        .as_str()
                        .ok_or_else(|| error("Scoped query type names must be strings."))?;
                    if !allowed_types.contains(&type_name.to_lowercase()) {
                        return Err(error(format!(
                            "Type '{type_name}' is outside the selected approved contract scope."
                        )));
                    }
                }
            }
        } else {
            scoped.insert(
                "types".to_string(),
                Value::Array(allowed_types.iter().cloned().map(Value::String).collect()),
            );
        }
        Ok((Value::Object(scoped), selector))
    }

    pub fn read_input(
        &self,
        input: &Value,
    ) -> Result<(Value, Option<ContractSelector>), ContractScopeError> {
        let selector = self.selector(input)?;
        Ok((without_selector(input), selector))
    }

    pub fn map_write_input(
        &self,
        input: &Value,
        create: bool,
    ) -> Result<(Value, ContractSelector), ContractScopeError> {
        let requested_type = input
            .get("type")
            .and_then(Value::as_str)
            .map(str::to_lowercase);
        let selector = self.selector(input)?;
        if let (Some(requested), Some(selected)) = (
            requested_type.as_deref(),
            selector
                .as_ref()
                .and_then(|selector| selector.type_name.as_deref()),
        ) {
            if requested != selected {
                return Err(error(
                    "The create type and contract selector type must identify the same provider.",
                ));
            }
        }
        let provider_types = requested_type
            .into_iter()
            .chain(
                selector
                    .as_ref()
                    .and_then(|selector| selector.type_name.clone()),
            )
            .collect::<BTreeSet<_>>();
        let selected = self.select(selector.as_ref(), &provider_types)?;
        let exact_selector = ContractSelector {
            id: selected.id.clone(),
            version: selected.version.clone(),
            type_name: Some(selected.implementation.type_name.to_lowercase()),
        };
        let mut mapped = without_selector(input)
            .as_object()
            .cloned()
            .unwrap_or_default();
        if create {
            mapped.insert(
                "type".to_string(),
                Value::String(selected.implementation.type_name.clone()),
            );
            if mapped.get("body").is_some() {
                return Err(error(
                    "Markdown bodies require explicit whole-record access.",
                ));
            }
            let contract_fields = mapped
                .get("frontmatter")
                .cloned()
                .unwrap_or_else(|| json!({}));
            mapped.insert(
                "frontmatter".to_string(),
                map_contract_fields(&contract_fields, &selected.implementation.fields)?,
            );
        } else {
            if ["body", "document", "frontmatter"]
                .iter()
                .any(|key| mapped.contains_key(*key))
            {
                return Err(error(
                    "Contract-scoped updates accept only mapped fields in patch.",
                ));
            }
            let contract_fields = mapped
                .remove("patch")
                .or_else(|| mapped.remove("fields"))
                .unwrap_or_else(|| json!({}));
            mapped.insert(
                "patch".to_string(),
                map_contract_fields(&contract_fields, &selected.implementation.fields)?,
            );
        }
        Ok((Value::Object(mapped), exact_selector))
    }

    pub fn identity_input(
        &self,
        input: &Value,
    ) -> Result<(Value, Option<ContractSelector>), ContractScopeError> {
        self.read_input(input)
    }

    pub fn project_result(
        &self,
        collection: &Collection,
        mut result: Value,
        selector: Option<&ContractSelector>,
    ) -> Result<Value, ContractScopeError> {
        if result.get("valid").and_then(Value::as_bool) == Some(false) {
            return Ok(result);
        }
        if let Some(rows) = result
            .pointer_mut("/result/results")
            .and_then(Value::as_array_mut)
        {
            for row in rows {
                self.project_record(collection, row, selector)?;
            }
            return Ok(result);
        }
        let Some(record) = result.get_mut("result") else {
            return Ok(result);
        };
        self.project_record(collection, record, selector)?;
        Ok(result)
    }

    pub fn authorize_record_result(
        &self,
        collection: &Collection,
        result: &Value,
        selector: Option<&ContractSelector>,
    ) -> Result<(), ContractScopeError> {
        self.project_result(collection, result.clone(), selector)
            .map(|_| ())
    }

    fn selector_types(
        &self,
        selector: &ContractSelector,
    ) -> Result<BTreeSet<String>, ContractScopeError> {
        let types = self
            .contracts
            .iter()
            .filter(|contract| contract.id == selector.id && contract.version == selector.version)
            .flat_map(|contract| contract.implementations.iter())
            .filter(|implementation| {
                selector
                    .type_name
                    .as_deref()
                    .is_none_or(|selected| implementation.type_name.eq_ignore_ascii_case(selected))
            })
            .map(|implementation| implementation.type_name.to_lowercase())
            .collect::<BTreeSet<_>>();
        if types.is_empty() {
            return Err(error(
                "The selected contract provider is outside this application's approved scope.",
            ));
        }
        Ok(types)
    }

    fn select(
        &self,
        selector: Option<&ContractSelector>,
        record_types: &BTreeSet<String>,
    ) -> Result<SelectedContract, ContractScopeError> {
        let mut candidates = self
            .contracts
            .iter()
            .filter(|contract| {
                selector.is_none_or(|selector| {
                    contract.id == selector.id && contract.version == selector.version
                })
            })
            .flat_map(|contract| {
                contract
                    .implementations
                    .iter()
                    .filter(|implementation| {
                        (record_types.is_empty()
                            || record_types.contains(&implementation.type_name.to_lowercase()))
                            && selector
                                .and_then(|selector| selector.type_name.as_deref())
                                .is_none_or(|selected| {
                                    implementation.type_name.eq_ignore_ascii_case(selected)
                                })
                    })
                    .map(|implementation| SelectedContract {
                        id: contract.id.clone(),
                        version: contract.version.clone(),
                        digest: contract.digest.clone(),
                        implementation: implementation.clone(),
                    })
            })
            .collect::<Vec<_>>();
        candidates.sort_by(|left, right| {
            (&left.id, &left.version, &left.implementation.type_name).cmp(&(
                &right.id,
                &right.version,
                &right.implementation.type_name,
            ))
        });
        match candidates.len() {
            1 => Ok(candidates.remove(0)),
            0 => Err(error(
                "The record does not provide the selected approved data contract.",
            )),
            _ => Err(error(
                "The record has multiple approved contract views. Repeat the operation with contract { id, version, type }.",
            )),
        }
    }

    fn project_record(
        &self,
        collection: &Collection,
        record: &mut Value,
        selector: Option<&ContractSelector>,
    ) -> Result<(), ContractScopeError> {
        let types = record
            .get("types")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_lowercase)
            .collect::<BTreeSet<_>>();
        let selected = self.select(selector, &types)?;
        let effective = record
            .get("effective_frontmatter")
            .or_else(|| record.get("frontmatter"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        let projected = collection.project_contract_type(
            &selected.implementation.type_name,
            &selected.id,
            &selected.version,
            &effective,
        );
        if !projected.valid {
            return Err(error(
                projected
                    .diagnostics
                    .first()
                    .map(|diagnostic| diagnostic.message.clone())
                    .unwrap_or_else(|| {
                        "The record does not satisfy its approved data contract.".into()
                    }),
            ));
        }

        let original = record.as_object().cloned().unwrap_or_default();
        let mut view = serde_json::Map::new();
        if let Some(path) = original.get("path").cloned() {
            view.insert("path".to_string(), path);
        }
        if let Some(file_path) = original
            .get("file")
            .and_then(|file| file.get("path"))
            .cloned()
        {
            view.insert("file".to_string(), json!({ "path": file_path }));
        }
        if let Some(revision) = original.get("revision").cloned() {
            view.insert("revision".to_string(), revision);
        }
        view.insert(
            "types".to_string(),
            Value::Array(vec![Value::String(
                selected.implementation.type_name.clone(),
            )]),
        );
        view.insert("frontmatter".to_string(), projected.view.clone());
        view.insert("effective_frontmatter".to_string(), projected.view);
        view.insert(
            "contract".to_string(),
            json!({
                "id": selected.id,
                "version": selected.version,
                "digest": selected.digest,
                "type": selected.implementation.type_name,
                "implementation_digest": selected.implementation.digest,
            }),
        );
        *record = Value::Object(view);
        Ok(())
    }
}

fn without_selector(input: &Value) -> Value {
    let mut input = input.as_object().cloned().unwrap_or_default();
    input.remove("contract");
    Value::Object(input)
}

fn map_contract_fields(
    contract_fields: &Value,
    mappings: &BTreeMap<String, String>,
) -> Result<Value, ContractScopeError> {
    let contract_fields = contract_fields
        .as_object()
        .ok_or_else(|| error("Contract fields must be an object."))?;
    let contract_fields = Value::Object(contract_fields.clone());
    ensure_only_mapped_contract_fields(&contract_fields, "", mappings)?;
    let mut record_fields = json!({});
    for (contract_field, record_field) in mappings {
        if let Some(value) = get_value_path(&contract_fields, contract_field) {
            set_value_path(&mut record_fields, record_field, value.clone())?;
        }
    }
    Ok(record_fields)
}

fn ensure_only_mapped_contract_fields(
    value: &Value,
    prefix: &str,
    mappings: &BTreeMap<String, String>,
) -> Result<(), ContractScopeError> {
    let Value::Object(fields) = value else {
        if prefix.is_empty() || !mappings.contains_key(prefix) {
            return Err(error(format!(
                "Contract field '{prefix}' is not mapped by the selected provider."
            )));
        }
        return Ok(());
    };
    if !prefix.is_empty() && mappings.contains_key(prefix) {
        return Ok(());
    }
    for (field, value) in fields {
        let path = if prefix.is_empty() {
            field.clone()
        } else {
            format!("{prefix}.{field}")
        };
        if !mappings.contains_key(&path)
            && !mappings
                .keys()
                .any(|candidate| candidate.starts_with(&format!("{path}.")))
        {
            return Err(error(format!(
                "Contract field '{path}' is not mapped by the selected provider."
            )));
        }
        ensure_only_mapped_contract_fields(value, &path, mappings)?;
    }
    Ok(())
}

fn get_value_path<'a>(value: &'a Value, field_path: &str) -> Option<&'a Value> {
    field_path
        .split('.')
        .try_fold(value, |current, segment| current.get(segment))
}

fn set_value_path(
    target: &mut Value,
    field_path: &str,
    value: Value,
) -> Result<(), ContractScopeError> {
    let mut current = target;
    let mut segments = field_path.split('.').peekable();
    while let Some(segment) = segments.next() {
        if segments.peek().is_none() {
            current
                .as_object_mut()
                .ok_or_else(|| {
                    error(format!(
                        "Mapped record field '{field_path}' conflicts with another field."
                    ))
                })?
                .insert(segment.to_string(), value);
            return Ok(());
        }
        let object = current.as_object_mut().ok_or_else(|| {
            error(format!(
                "Mapped record field '{field_path}' conflicts with another field."
            ))
        })?;
        current = object
            .entry(segment.to_string())
            .or_insert_with(|| json!({}));
    }
    Ok(())
}

fn error(message: impl Into<String>) -> ContractScopeError {
    ContractScopeError(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unmapped_write_fields() {
        let scope = ContractScope::new(vec![CollectionContractDescriptor {
            id: "example.task".into(),
            version: "1.0.0".into(),
            digest: format!("sha256:{}", "0".repeat(64)),
            schema: json!({"type": "object"}),
            binding_schema: None,
            implementations: vec![CollectionContractImplementationDescriptor {
                type_name: "task".into(),
                type_version: 1,
                type_path: None,
                digest: format!("sha256:{}", "1".repeat(64)),
                fields: BTreeMap::from([("title".into(), "summary".into())]),
                binding: None,
            }],
        }])
        .unwrap();
        let error = scope
            .map_write_input(
                &json!({
                    "type": "task",
                    "frontmatter": {"title": "Allowed", "secret": "Denied"}
                }),
                true,
            )
            .unwrap_err();
        assert!(error.to_string().contains("secret"));
    }
}
