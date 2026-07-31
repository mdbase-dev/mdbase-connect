use super::*;
use mdbase_connect_protocol::{
    ContractRequirement, TypePackManifest, TypePackManifestResource, TypePackSourceResource,
};

fn work_item_provision() -> TypePackProvision {
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
---
"#;
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
implements:
  - contract: example.work-item
    version: 1.0.0
    fields:
      title: title
---
"#;
    let definitions = [
        (
            "contract.md",
            "_contracts/example.work-item.md",
            "contract",
            contract,
        ),
        ("starter.md", "_types/work_item.md", "type", starter),
    ];
    TypePackProvision {
        manifest: TypePackManifest {
            kind: "mdbase.type-pack".to_string(),
            id: "example.work-items".to_string(),
            version: "1.0.0".to_string(),
            name: Some("Work items".to_string()),
            description: None,
            resources: definitions
                .iter()
                .map(
                    |(source, target, kind, document)| TypePackManifestResource {
                        kind: (*kind).to_string(),
                        source: (*source).to_string(),
                        target: (*target).to_string(),
                        digest: format!("sha256:{:x}", Sha256::digest(document.as_bytes())),
                    },
                )
                .collect(),
            extensions: Default::default(),
        },
        resources: definitions
            .iter()
            .map(|(source, _, _, document)| TypePackSourceResource {
                source: (*source).to_string(),
                document: (*document).to_string(),
            })
            .collect(),
        provides: vec![ContractRequirement {
            id: "example.work-item".to_string(),
            version: "1.0.0".to_string(),
        }],
    }
}

#[test]
fn maps_hosted_contracts_to_revisioned_existing_types() {
    let workspace = WorkingSet::materialize(super::tests::resources(), []).unwrap();
    let (types, _) = workspace.type_resources().unwrap();
    let task = types
        .iter()
        .find(|candidate| candidate.name == "task")
        .unwrap();
    let setup = ContractSetupChoice {
        contract: ContractRequirement {
            id: "example.work-item".to_string(),
            version: "1.0.0".to_string(),
        },
        mode: ContractSetupMode::Existing {
            type_name: "task".to_string(),
            type_revision: task.revision.clone().unwrap(),
            fields: [("title".to_string(), "title".to_string())]
                .into_iter()
                .collect(),
            binding: None,
        },
    };
    let provision = work_item_provision();
    let installed = workspace
        .install_type_packs_with_contract_setups(
            std::slice::from_ref(&provision),
            std::slice::from_ref(&setup),
        )
        .unwrap();
    assert!(installed.valid, "{:?}", installed.diagnostics);
    assert!(workspace.resource_document("_types/work_item.md").is_err());
    let task_document = workspace.resource_document("_types/task.md").unwrap();
    assert!(task_document.contains("contract: example.work-item"));
    let (_, contracts) = workspace.type_resources().unwrap();
    assert_eq!(contracts[0].implementations[0].type_name, "task");
    let retried = workspace
        .install_type_packs_with_contract_setups(
            std::slice::from_ref(&provision),
            std::slice::from_ref(&setup),
        )
        .unwrap();
    assert!(retried.valid, "{:?}", retried.diagnostics);
    assert!(retried.result["resources"]
        .as_array()
        .unwrap()
        .iter()
        .all(|resource| resource["action"] == "unchanged"));
}
