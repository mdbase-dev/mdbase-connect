---
name: mdbase-frontends
description: Build a page, site, dashboard, form or small app on top of an mdbase collection, such as a task board, reading-list tracker or habit log. Use when the user wants an interface for viewing or editing their mdbase records rather than a one-off answer.
---

# Building interfaces on mdbase collections

An interface built on mdbase reads and writes records through the mdbase
tools at run time. The collection's type definitions are its schema: derive
the interface from them instead of guessing fields from a few sample records.
Follow the `mdbase-collections` skill for tool usage, query syntax and write
rules; this skill covers what is different when building an interface.

## Before building

1. Call `list_connections` and confirm with the user which collection the
   interface is for.
2. Call `describe_collection`, then `read_type` for each type the interface
   shows or edits. Note each field's type, whether it is required, enum
   values, defaults and link targets.
3. Run one small `query_records` (`limit` around 5) to see real values, then
   agree the scope with the user: which types, which fields, read-only or
   editable, and any filters or grouping.

## Mapping types to UI

Types validate frontmatter with JSON Schema (`schema.value.properties`) and
declare link fields under `collection.links`.

| Schema | Display | Input |
| --- | --- | --- |
| `type: string` | text | text input; textarea for long text |
| `enum: [...]` | badge | select with exactly the enum values |
| `type: integer` or `number` | right-aligned number | number input honouring `minimum` and `maximum` |
| `type: boolean` | check mark | checkbox |
| `format: date` | formatted date | date input, saved as `YYYY-MM-DD` |
| `format: date-time` | formatted date and time | datetime input, saved with an offset |
| `type: array` | chips | multi-select or tag input |
| field in `collection.links` | link text that opens the target record | picker fed by a query on its `target_type`, saved as `[[path]]` |
| record body | rendered markdown | markdown textarea |

Fields in the schema's `required` list must be required in forms. Use `file.path` as the stable key
for each record; titles are not unique.

## Run-time rules

- **Never hard-code a `connection_id`.** Each person who uses the interface
  has their own connection, with its own ID. At start-up call
  `list_connections` and select the collection by its name; if it is missing,
  show a "Connect collection" action that calls `add_connection` and opens the
  returned link.
- **Do filtering, sorting and grouping in the query**, with `where`,
  `order_by`, `group_by` and `summaries`, rather than downloading everything
  and filtering in the page. Use `select` to fetch only the fields shown.
  Page through large collections with cursor pagination.
- **Edits must be revision-checked.** Query results do not carry revisions, so
  call `read_record` when the user opens a record for editing, keep its
  `revision`, and pass it as `if_revision`. On a conflict, reload the
  record, show the user the current values, and let them re-apply their edit.
- **Show validation errors next to the field they name.** The collection
  validates every write, so the interface does not need to duplicate every
  rule, but it should prevent obvious errors such as missing required fields.
- **Refresh after writes** from the tool result, or re-query, so the interface
  shows what was actually saved.
- Use `list_changes` with the last change cursor to refresh only what changed,
  passing it as `after`, when the interface stays open for a long time. If
  `reset` is true, re-query the displayed state before continuing from the
  returned cursor; do not treat an invalid cursor as no changes.

## Do not

- Do not copy record contents into the page source as static data; the
  interface must read live records.
- Do not create or modify types to suit the interface. If a field the user
  wants does not exist, tell them and ask before using `create_type` or
  `update_type`.
- Do not offer delete or bulk-edit actions unless the user asked for them, and
  confirm each one before running it.
