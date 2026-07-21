use mdbase_connect_protocol::{
    CollectionContractDescriptor, CollectionTypeDescriptor, SyncCollectionResources,
};
use serde_json::{json, Map};

use crate::error::{ApiError, ApiResult};

#[derive(Debug, Clone)]
pub struct ResourceDocument {
    pub path: &'static str,
    pub kind: &'static str,
    pub revision: &'static str,
    pub document: &'static str,
}

pub fn resources(template: &str) -> ApiResult<(SyncCollectionResources, Vec<ResourceDocument>)> {
    match template {
        "tasknotes" => Ok(tasknotes()),
        _ => Err(ApiError::bad_request(
            "unsupported_template",
            "The hosted provider does not support that collection template.",
        )),
    }
}

fn tasknotes() -> (SyncCollectionResources, Vec<ResourceDocument>) {
    let contract = json!({
        "contract": "tasknotes.task",
        "version": 1,
        "field_roles": { "title": "title", "status": "status" },
        "status": { "completed_values": ["done"], "default": "open" }
    });
    let mut extensions = Map::new();
    extensions.insert("x-tasknotes".to_string(), contract.clone());
    let resources = SyncCollectionResources {
        revision: "tasknotes-template:1".to_string(),
        spec_version: "0.3.0".to_string(),
        types: vec![CollectionTypeDescriptor {
            name: "task".to_string(),
            version: Some(1),
            description: Some("A TaskNotes-compatible task.".to_string()),
            path: Some("_types/task.md".to_string()),
            definition: None,
            schema: json!({
                "type": "object",
                "required": ["type", "title"],
                "additionalProperties": true,
                "properties": {
                    "type": { "const": "task" },
                    "title": { "type": "string", "minLength": 1 },
                    "status": { "enum": ["open", "done"] }
                }
            }),
            collection: Some(json!({ "path": { "folder": "tasks" } })),
            lifecycle: None,
            extensions,
        }],
        contracts: vec![CollectionContractDescriptor {
            id: "tasknotes.task".to_string(),
            version: 1,
            type_name: "task".to_string(),
            extension: "x-tasknotes".to_string(),
            configuration: contract,
        }],
        documents: Vec::new(),
    };
    let documents = vec![
        ResourceDocument {
            path: "mdbase.yaml",
            kind: "configuration",
            revision: "tasknotes-config:1",
            document: "spec_version: 0.3.0\nsettings:\n  types_folder: _types\n  default_validation: error\n",
        },
        ResourceDocument {
            path: "_types/task.md",
            kind: "type",
            revision: "tasknotes-type:1",
            document: r#"---
kind: mdbase.type
name: task
version: 1
description: A TaskNotes-compatible task.
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
x-tasknotes:
  contract: tasknotes.task
  version: 1
  field_roles: { title: title, status: status }
  status: { completed_values: [done], default: open }
---
"#,
        },
    ];
    (resources, documents)
}
