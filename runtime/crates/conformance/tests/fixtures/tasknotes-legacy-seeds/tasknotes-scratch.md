---
kind: mdbase.type
name: tasknotes-scratch
version:
  2
description: A working outline managed by TaskNotes.
match:
  where:
    type:
      eq: tasknotes-scratch
schema:
  dialect: json-schema-2020-12
  value:
    $schema: https://json-schema.org/draft/2020-12/schema
    additionalProperties: true
    properties:
      dateConverted:
        format: date-time
        type: string
      dateCreated:
        format: date-time
        type: string
      dateModified:
        format: date-time
        type: string
      id:
        minLength: 1
        type: string
      state:
        enum:
        - active
        - converted
      title:
        type: string
    required:
    - id
    - state
    - dateCreated
    - dateModified
    type: object
collection:
  path:
    folder: scratchpads
    template: "{{title}}"
  display:
    name_field: title
  unique:
    - field: id
      scope: type
lifecycle:
  on_create:
    set:
      id:
        uuid: true
      dateCreated:
        now: true
      dateModified:
        now: true
  on_update:
    set:
      dateModified:
        now: true
---
# TaskNotes scratchpad

Scratchpads are Markdown outlines. Checkbox items are draft tasks, plain
bullets are notes, and links point to TaskNotes created from the outline.
