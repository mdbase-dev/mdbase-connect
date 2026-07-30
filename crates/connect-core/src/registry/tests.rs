use super::*;
use std::sync::{Arc, Barrier};
use std::thread;
use tempfile::tempdir;

mod authority;
mod collections;
mod operations;
mod scope;
mod security_state;

fn mark_mirror(root: &Path, collection_id: Uuid) {
    let directory = root.join(MIRROR_MARKER_DIRECTORY);
    fs::create_dir_all(&directory).unwrap();
    fs::write(
        directory.join(MIRROR_MARKER_FILE),
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "role": "mirror",
            "collection_id": collection_id,
        }))
        .unwrap(),
    )
    .unwrap();
}

fn write_work_item_contract(root: &Path) {
    fs::write(
        root.join("_contracts/example.work-item.md"),
        r#"---
kind: mdbase.contract
contract_type: record
id: example.work-item
version: 1.0.0
record_schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [title]
    additionalProperties: false
    properties:
      title: { type: string }
      status: { type: string }
---
"#,
    )
    .unwrap();
}

fn work_item_scope(registry: &CollectionRegistry, collection_id: Uuid) -> GrantScope {
    let description = registry.describe(collection_id).unwrap();
    let contract = description
        .contracts
        .into_iter()
        .find(|contract| contract.id == "example.work-item")
        .expect("example.work-item is advertised");
    GrantScope {
        contracts: vec![contract],
        access: mdbase_connect_protocol::ApplicationAccess::Contract,
    }
}

fn unavailable_contract_scope() -> GrantScope {
    GrantScope {
        contracts: vec![CollectionContractDescriptor {
            contract_type: "record".to_string(),
            id: "some.app".to_string(),
            version: "1.0.0".to_string(),
            digest: format!("sha256:{}", "0".repeat(64)),
            schema: json!({"type": "object"}),
            binding_schema: None,
            implementations: Vec::new(),
        }],
        access: mdbase_connect_protocol::ApplicationAccess::Contract,
    }
}
