# mdbase query format

`query_records` takes the query members directly as arguments, alongside
`connection_id`. Use only the supported members below.

```json
{
  "connection_id": "…",
  "types": ["task"],
  "timezone": "Australia/Melbourne",
  "where": "status != \"done\" && due != null && due >= today().addDays(1 - today().dayOfWeek()) && due < today().addDays(8 - today().dayOfWeek())",
  "select": ["title", "due", "priority"],
  "order_by": [{ "field": "due", "direction": "asc" }],
  "limit": 20
}
```

## Members

| Member | Meaning |
| --- | --- |
| `types` | Only records of these types (OR). Omit for all records. |
| `where` | CEL expression; a record is included only when it is `true`. |
| `projections` | Named computed values: `{ "is_overdue": { "expr": "…" } }`, used as `projection.is_overdue`. |
| `select` | Result fields. A string selects a field, `file.<name>` or `projection.<name>`. An object `{ "name", "expr", "label" }` computes a value. |
| `order_by` | List of `{ "field", "direction": "asc" \| "desc" }`. Nulls sort last when ascending. |
| `group_by` | Same shape as `order_by`; groups the whole filtered result. |
| `summaries` | `{ "field", "function", "name" }`, for example `function: "sum"` or `"count"`. |
| `summary_functions` | Named custom functions: `{ "completion_rate": { "expr": "values.size() == 0 ? 0 : values.filter(v, v).size() * 100 / values.size()" } }`. |
| `limit`, `offset` | Page size and offset, applied after filtering and sorting. |
| `pagination`, `cursor` | `"cursor"` for stable paging through large results. |
| `include_body` | Include each record's markdown body. |
| `frontmatter_mode` | `"effective"` (default), `"persisted"`, or `"both"`. |
| `output` | `"metadata"` requests paths, types, revisions and selected values on supporting authorities. Use `read_record` before editing. |
| `snapshot` | Opaque snapshot value returned by a supporting authority; do not invent it. |
| `contract` | Optional data-contract query; inspect the collection's supported contracts before using it. |
| `context` | `{ "this": { "path": "…" } }` binds one record as `this` in expressions. |

Every result includes `file.path`. Use it with `read_record` and the write tools.
The example uses Monday through Sunday for "this week", not the next seven
days. Confirm a different week boundary when the user's intent calls for one.

## Expressions (CEL)

Fields are top-level identifiers. A missing field is `null`.

| Need | Expression |
| --- | --- |
| Equality, comparison | `status == "open" && priority >= 3` |
| Missing or empty | `due == null`, `has(raw.due)` (persisted at all) |
| Dates (date fields are `YYYY-MM-DD` strings) | `due < today()`, `due <= today().addDays(7)`, `created >= today().addMonths(-1)` |
| Date-time fields (timestamps) | `updated > now() - duration("24h")`, `startOfDay(due) < now()` |
| Calendar parts | `due.dayOfWeek() == 1`, `today().daysUntil(due) <= 3` |
| Text contains, case-insensitive | `title.lower().contains("passport")` |
| Body search | `file.body.lower().contains("budget")` |
| List membership | `"urgent" in tags`, `tags.exists(t, t.startsWith("home/"))` |
| Folder | `file.inFolder("projects")` |
| Tags | `file.hasTag("review")` |
| Links | `file.hasLink(link("[[people/alice]]"))`, `project != null && project.asFile() != null && project.asFile().status == "active"` |
| Ternary | `due == null ? "Unscheduled" : string(due)` |
| Nested with default | `metadata.?owner.orValue("unassigned") == "alice"` |

Strings use double quotes inside the expression, so escape them in JSON.
`today()` returns a date string and `now()` a timestamp; both use the query
`timezone`, then the collection's timezone. Use the date methods (`addDays`,
`addMonths`) for calendar spans and `duration("…h")` only with timestamps.
Comparing a date string with a timestamp is an error: convert one side with
`date(now())` or `startOfDay(due)`.

Which helpers are available depends on the collection; `describe_collection`
lists its supported capabilities. If a query fails with `invalid_query`, read
the error message, fix the expression, and try again once before asking the
user.
