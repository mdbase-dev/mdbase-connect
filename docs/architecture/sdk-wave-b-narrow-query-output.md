# Wave B B2: Narrow query output

Status: proposed; depends on [B1](sdk-wave-b-capability-negotiation.md) and
[B3 revisions](sdk-wave-b-query-revisions.md). Baseline/provenance: B1.

## Current behaviour with evidence

- Protocol `packages/protocol/src/index.ts::QueryRecord` and client
  `src/operation-types.ts::QueryRecord` hold `values` alongside full frontmatter;
  `src/collection-client.ts` forwards `select`/`projections`, then reconstructs rows.
- Local `crates/connect-core/src/registry/operations.rs` delegates native queries;
  shared mdbase-rs `src/query/canonical/result.rs::serialize_candidate` always
  emits selected frontmatter mode and file facts, adding values when select exists.
  Computation/projection ownership belongs there, not in a client strip adapter.
- Hosted `crates/connect-hosted-provider/src/provider/operation_queries/query_top_k.rs:272–280`
  emits effective frontmatter **and** values for Base rows. All canonical,
  projected, residual and exact fallback producers need the same output contract.
- `sdk-bench.md §2`: synthetic 30k-row select added 1.38 MB instead of omitting
  fields. It measures SDK/wire overhead, not live-provider performance. Writer
  comment/annotation indexes, Reader path lookups, TaskNotes summaries and editor
  list pass transfer more fields than some uses need (consumer surveys).

## Proposed protocol/API

Keep native default and existing select/projections semantics. Advertise
`query-metadata-v1` only when B3 guarantees record revisions. New opt-in input:

```json
{"types":["annotation"],"output":"metadata","select":["source","projection.resolved"],"projections":{"resolved":{"expr":"source.asFile().file.path"}},"pagination":"cursor","limit":200}
```

Existing query envelope/paging/count/diagnostics remain, with `output:"metadata"`
in the result envelope and record rows **only**:

```json
{"path":"annotations/a.md","types":["annotation"],"revision":"sha256:…","values":{"source":"[[book]]","resolved":"sources/book.md"}}
```

Optional `contract` identity is retained for contract queries (B5). No `file`,
frontmatter, effective_frontmatter, body or document member; absence is not an empty
map/body. `values:{}` when select is absent; an explicitly empty select remains
invalid under today's schema. Use existing selected-value keys, projection aliases
and missing-value rules. Select `file.mtime` etc. explicitly if
needed. Metadata means a narrow envelope, not a ban on explicitly selected data:
native approved queries can select a large value/body expression and still cost
bytes. Existing evaluation/byte/traversal budgets apply.

Reject `include_body:true` with this mode rather than silently ignoring it. Native
`frontmatter_mode` may still select evaluation representation as today; it cannot
force frontmatter into this envelope. Output mode is pinned into cursor state and
cannot change on continuation/release. Filtering, ordering, grouping and counts
must be identical to the corresponding ordinary query; no new fields alias on the
wire (`select` already expresses requested values). SDK `query`/`queryPages` accept `output:"metadata"`; their overloads discriminate
narrow rows from normal QueryRecord. A partial row cannot satisfy a full note/document.

mdbase-rs owns the output request, typed narrow result and rendering, including
hosted plans. Connect wires/authenticates and stores the mode in existing cursor
state. Query output shaping must happen at the authority before JSON/encryption;
client stripping alone is not a transfer optimization. Narrow output must not
require full-document hydration unless predicates/computed values actually need it.

## Compatibility, approval and migration

B1 positive feature evidence selects the new input. On old authorities, consumers
use the existing SDK ordinary query (no `output` key), preserving select/projections
and its legacy QueryRecord type. They may discard unneeded fields locally, but must
not cast that result to the revision-required narrow type. A later point read's token
cannot be attached to earlier query values. Keep Wave A summaries for legacy discovery;
use B3's bounded point-read document fallback when a revision is actually needed.
Explicit metadata-mode SDK calls require support and fail before dispatch if absent;
consumer discovery branches implement the old-behaviour fallback, not error retries.
Remove these branches for Writer/Reader/TaskNotes/editor and MCP only under B1's
minimum-authority gate. This retains two existing request choices, not a second query
renderer or a dishonest bandwidth/coherence guarantee.

- Writer: `backend/connect.ts` comment/annotation/index discovery selects just
  source/reply/identity values; replace full-row assumptions, keep compiler indexes.
- Reader: `annotation-query.ts`, `repository-client.ts` path/ID lookups become
  narrow; library lists still select CSL/document metadata and candidate-validation
  fields rather than incorrectly turning them into paths-only rows.
- TaskNotes: select the fields required by its configured task model, recurrence
  and sort/search policy; avoid declaring a full index complete with missing fields.
- Editor: introduce a partial list summary before changing `gateway.ts::list` /
  `completeSummary`; retain full property/body hydration and honest search readiness.
- MCP: opt-in output tool parameter, default unchanged; normalize fallback with the
  same wire contract, not a private resolver. Obsidian sync is unaffected.

No new approval: `query` stays the exact operation. Transfer minimization is not
least-privilege authority (ADR 0012). Contract filtering/selected values are bounded
by B5's semantic language; no post-query stripping can cure an unauthorized predicate
side channel. Roots and payloads never enter control-plane logs/storage.

## Tests and size

M, 4–7 engineer-days after B3. Differential normal/narrow membership/order/count
for local and every hosted execution path; exact absent-key assertions; computed,
null/missing, invalid rows, group-only and projection-alias cases; cursor mode pinning
and cleanup; bytes/cancellation budgets and old-authority fallback calls. Bench
sdk-review's 30k/50k wide rows, real authority serialization and encrypted payloads;
record bytes, calls, CPU and browser long tasks separately. Require measurable wire
reduction for the same selected semantics, not an unexecuted speedup promise.
