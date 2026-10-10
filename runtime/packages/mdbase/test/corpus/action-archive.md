---
kind: mdbase.contract
contract_type: action
id: example.archive
version: 2.0.0
name: Archive a record
input_schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [path]
    properties:
      path: { type: string }
      reason: { type: string, maxLength: 200 }
output_schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      archived_to: { type: string }
error_schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      code: { type: string, enum: [not_found, forbidden] }
provider_schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      folder: { type: string, default: "Archive" }
behavior:
  idempotent: true
  retries: 3
  timeout_ms: 1500
  side_effects: [moves_file, writes_frontmatter]
  notes:
    zed: last
    alpha: first
---
