use super::*;
use mdbase_connect_protocol::{
    ContractRequirement, ContractSetupChoice, ContractSetupMode, TypePackManifest,
    TypePackManifestResource, TypePackProvision, TypePackSourceResource,
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
                        mode: if *kind == "type" { "seed" } else { "managed" }.to_string(),
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
            digest: format!("sha256:{:x}", Sha256::digest(contract.as_bytes())),
        }],
    }
}

#[test]
fn maps_hosted_contracts_to_revisioned_existing_types() {
    let workspace = WorkingSet::materialize(super::tests::resources(), []).unwrap();
    let provision = work_item_provision();
    let (types, _) = workspace.type_resources().unwrap();
    let task = types
        .iter()
        .find(|candidate| candidate.name == "task")
        .unwrap();
    let setup = ContractSetupChoice {
        contract: ContractRequirement {
            id: "example.work-item".to_string(),
            version: "1.0.0".to_string(),
            digest: provision.provides[0].digest.clone(),
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
    let assessment = workspace
        .assess_type_pack(&AssessTypePackInput {
            provision: provision.clone(),
            installed_by: "dev.mdbase.tests".to_string(),
            adopt_resources: BTreeMap::new(),
            preserve_seed_targets: ["_types/work_item.md".to_string()].into_iter().collect(),
            target_overrides: BTreeMap::new(),
            contract_setups: vec![setup.clone()],
        })
        .unwrap();
    let installed = workspace
        .apply_type_pack(&ApplyTypePackInput {
            provision: provision.clone(),
            installed_by: "dev.mdbase.tests".to_string(),
            adopt_resources: BTreeMap::new(),
            preserve_seed_targets: ["_types/work_item.md".to_string()].into_iter().collect(),
            target_overrides: BTreeMap::new(),
            contract_setups: vec![setup.clone()],
            expected_assessment_digest: assessment.result["assessment_digest"]
                .as_str()
                .unwrap()
                .to_string(),
            allow_downgrade: false,
        })
        .unwrap();
    assert!(installed.valid, "{:?}", installed.diagnostics);
    assert!(workspace.resource_document("_types/work_item.md").is_err());
    let task_document = workspace.resource_document("_types/task.md").unwrap();
    assert!(task_document.contains("contract: example.work-item"));
    let (_, contracts) = workspace.type_resources().unwrap();
    assert_eq!(contracts[0].implementations[0].type_name, "task");
    let retried = workspace
        .assess_type_pack(&AssessTypePackInput {
            provision,
            installed_by: "dev.mdbase.tests".to_string(),
            adopt_resources: BTreeMap::new(),
            preserve_seed_targets: ["_types/work_item.md".to_string()].into_iter().collect(),
            target_overrides: BTreeMap::new(),
            contract_setups: vec![setup],
        })
        .unwrap();
    assert!(retried.valid, "{:?}", retried.diagnostics);
    assert!(retried.result["contract_setups"]["resources"]
        .as_array()
        .unwrap()
        .is_empty());
}
