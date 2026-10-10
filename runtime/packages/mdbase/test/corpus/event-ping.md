---
kind: mdbase.contract
contract_type: event
id: example.ping
version: 0.1.0
name: Ping
data_schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [at]
    properties:
      at: { type: string, format: date-time }
      count: { type: integer, minimum: 0, default: 0 }
      tags: { type: array, items: { type: string }, uniqueItems: true }
source_schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      device: { type: string }
---
