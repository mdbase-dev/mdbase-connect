## Added

- SDK `readMany(paths, { revisions: false })` keeps read-only hydration in typed
  path queries, defaulting to 1,000-path batches without document discovery or
  separate type selection. Revision-bearing defaults are unchanged. Migration:
  replace hand-written body queries with this option (use `batchSize: 500` for
  Writer's existing payload size); retain the default for revision-safe editing.
  See `docs/sdk-query-helpers.md` for the result and error contracts.
- MCP `query_records` accepts capability-gated `output: "metadata"`;
  `list_changes` adds SDK-normalized `typed_events` alongside unchanged raw
  events. The MCP manifest and permissions remain unchanged, as does the
  record-only `read_record` tool. File stat is not exposed through MCP; no new
  consent or shared grant-model change is required.
