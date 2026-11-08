---
kind: mdbase.type
name: tasknotes-scratch-image
version:
  2
description: An independent image card in the TaskNotes Scratchpad feed.
match:
  where:
    type:
      eq: tasknotes-scratch-image
schema:
  dialect: json-schema-2020-12
  value:
    $schema: https://json-schema.org/draft/2020-12/schema
    additionalProperties: true
    properties:
      caption:
        type: string
      dateCreated:
        format: date-time
        type: string
      dateModified:
        format: date-time
        type: string
      digest:
        pattern: ^sha256:[0-9a-f]{64}$
        type: string
      file:
        minLength: 1
        type: string
      height:
        minimum: 1
        type: integer
      id:
        minLength: 1
        type: string
      mediaType:
        pattern: ^image/
        type: string
      size:
        minimum: 0
        type: integer
      width:
        minimum: 1
        type: integer
    required:
    - id
    - dateCreated
    - dateModified
    - file
    - digest
    - size
    - mediaType
    type: object
collection:
  path:
    folder: TaskNotes/Scratchpad/Image Metadata
    template: "{{id}}"
  unique:
    - field: id
      scope: type
---
# TaskNotes Scratchpad image

This metadata record places one independently stored collection image in the
Scratchpad feed. Removing this record does not remove the referenced file.
