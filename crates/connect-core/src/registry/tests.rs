use super::*;
use std::sync::{Arc, Barrier};
use std::thread;
use tempfile::tempdir;

mod authority;
mod collections;
mod file_sync;
mod operations;
mod scope;
mod security_state;

fn signed_test_grant(_registry: &CollectionRegistry, operations: Vec<String>) -> GrantPolicy {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/test/fixtures/application-authorization-v2.json"
    ))
    .unwrap();
    let binding: mdbase_connect_protocol::ApplicationAuthorizationBinding =
        serde_json::from_value(fixture["binding"].clone()).unwrap();
    let proof = mdbase_connect_protocol::ApplicationAuthorizationProof {
        binding: binding.clone(),
        signature: fixture["signature"].as_str().unwrap().to_string(),
    };
    proof.verify().unwrap();
    let connector_id = Uuid::parse_str("01977777-7777-7777-8777-777777777777").unwrap();
    GrantPolicy {
        id: Uuid::new_v4(),
        application_id: binding.application_id,
        collection_id: binding.collection_id.unwrap(),
        operations,
        scope: GrantScope::full_collection(),
        application_name: "Test application".to_string(),
        application_distribution: "web".to_string(),
        application_homepage: "https://app.example".to_string(),
        application_project_url: None,
        application_origin: "https://app.example".to_string(),
        application_icon: None,
        collection_name: "Test collection".to_string(),
        notification_criteria: Vec::new(),
        created_at: "2026-08-02T00:00:00Z".to_string(),
        encryption: Some(mdbase_connect_protocol::GrantEncryption {
            protocol_version: mdbase_connect_protocol::ENCRYPTED_RELAY_PROTOCOL_VERSION,
            suite: mdbase_connect_protocol::RELAY_ENCRYPTION_SUITE.to_string(),
            key_id: "key-1".to_string(),
            scope_epoch: 1,
            connector_id,
            collection_id: binding.collection_id.unwrap(),
            application_agreement_public_key: binding.grant_agreement_public_key,
            connector_agreement_public_key: binding.grant_signing_public_key.clone(),
        }),
        file_capability: binding.requested_files.map(|files| {
            mdbase_connect_protocol::FileCapability {
                kind: mdbase_connect_protocol::FileCapabilityKind::Files,
                protocol_version: mdbase_connect_protocol::FILE_PROTOCOL_VERSION,
                actions: files.actions,
                scope: files.scope,
            }
        }),
        application_authorization: proof,
    }
}

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

fn work_item_provision() -> (ApplicationRequirements, TypePackProvision) {
    let contract = r#"---
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
"#;
    let requirement = ContractRequirement {
        id: "example.work-item".to_string(),
        version: "1.0.0".to_string(),
        digest: mdbase::data_contracts::data_contract_digest(
            &serde_yaml::from_str::<serde_json::Value>(
                contract
                    .strip_prefix("---\n")
                    .and_then(|value| value.strip_suffix("---\n"))
                    .expect("contract fixture has frontmatter fences"),
            )
            .expect("contract fixture is valid YAML"),
        ),
    };
    let starter = r#"---
kind: mdbase.type
name: work_item
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [title]
    additionalProperties: true
    properties:
      title: { type: string }
      status: { type: string }
implements:
  - contract: example.work-item
    version: 1.0.0
    fields:
      title: title
      status: status
---
"#;
    let resources = [
        (
            "contract.md",
            "_contracts/example.work-item.md",
            "contract",
            contract,
        ),
        ("starter.md", "_types/work_item.md", "type", starter),
    ];
    let provision = TypePackProvision {
        manifest: mdbase_connect_protocol::TypePackManifest {
            kind: "mdbase.type-pack".to_string(),
            id: "example.work-items".to_string(),
            version: "1.0.0".to_string(),
            name: Some("Work items".to_string()),
            description: None,
            resources: resources
                .iter()
                .map(|(source, target, kind, document)| {
                    mdbase_connect_protocol::TypePackManifestResource {
                        kind: (*kind).to_string(),
                        mode: if *kind == "type" { "seed" } else { "managed" }.to_string(),
                        source: (*source).to_string(),
                        target: (*target).to_string(),
                        digest: format!("sha256:{:x}", Sha256::digest(document.as_bytes())),
                    }
                })
                .collect(),
            extensions: Default::default(),
        },
        resources: resources
            .iter()
            .map(
                |(source, _, _, document)| mdbase_connect_protocol::TypePackSourceResource {
                    source: (*source).to_string(),
                    document: (*document).to_string(),
                },
            )
            .collect(),
        provides: vec![requirement.clone()],
    };
    (
        ApplicationRequirements {
            contracts: vec![requirement],
            access: Some(mdbase_connect_protocol::ApplicationAccess::Contract),
            collection_kind: None,
            files: None,
        },
        provision,
    )
}
