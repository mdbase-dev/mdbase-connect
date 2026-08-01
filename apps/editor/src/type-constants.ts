export const NEW_TYPE_SOURCE = `---
kind: mdbase.type
name: new-type
version: 1
description: Describe when this type should be used.
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    additionalProperties: true
    properties:
      title:
        type: string
---
`;
