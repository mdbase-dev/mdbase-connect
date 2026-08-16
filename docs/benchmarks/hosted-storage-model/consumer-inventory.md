# Consumer query and mutation inventory

Status: frozen from source inspection on 2026-08-16. Paths are repository-relative
to `/home/calluma/projects`. Production call sites are distinguished from local or
test-only semantics.

## TaskNotes

`tasknotes-app/src/storage/mdbase-repository.ts:1003-1043` reloads the connected
cache with type-scoped, `includeBody: true`, effective-frontmatter queries in
1,000-row snapshot-pinned offset pages. Local list/search then filters the complete
body-bearing cache by status, archive, title/body/tags/contexts/projects and related
task fields.

The same repository performs a selective completion query at lines 261-341 using a
path/basename/title substring OR, path order, and at least 48 results; executes saved
views with a 2,000 limit at lines 647-693; and queries scratchpads with persisted
frontmatter and bodies at lines 888-907.

The TaskNotes Obsidian runtime (`tasknotes/src/api/runtime-api.ts:914-1043`) is a
local-cache semantic source, not a hosted SDK call. It supplies real predicates:
nested all/any/not, equality/membership/existence/range operations, status,
priority, tags, contexts, projects, dependency relationships, dates, archive,
recurrence, custom properties, sorting, grouping, pagination, and task statistics.
`mdbase-tasknotes/src/commands/list.ts:14-174` confirms task type/status/priority/tag/
due/overdue/order/limit shapes; some recurring and overdue filtering occurs after a
provider limit and can underfill a page.

Writes in TaskNotes app are revision-checked create/update/delete/rename operations
wrapped by durable mutation recovery. Body, frontmatter, dependency, recurrence,
reminder, time-entry, archive/path, and batch update shapes are active. The Obsidian
runtime itself has no public optimistic-revision field and is compatibility evidence
rather than hosted transaction evidence.

## Reader / literature

`mdbase-reader/packages/connect/src/source-repository.ts:36-86` queries the source
contract with effective frontmatter and offset/page iteration. Reading status and
text search are currently client-side; a provider page may therefore underfill the
visible result. Saved-view serialization maps status, document format, tags, and
title/authors/published/reading-status ordering in
`apps/reader/src/mdbase-library-views.ts:114-196`.

Exact source open/edit resolves the path then reads the whole document. Body,
reading state, citation metadata, and annotation-embed updates preserve revision
and unknown nested fields (`source-repository.ts:88-207`). Source import scans all
sources for a document revision, uploads files, creates exact Markdown, and recovers
unknown outcomes (`source-imports.ts:41-137`).

`content-search-repository.ts:20-47` is the principal broad body workload:
`file.body.lower().contains(...)`, 500 then 1,000 row pages, metadata results only,
and complete-page consumption. Annotation discovery scans the annotation contract,
groups by source, then performs exact body reads with concurrency four
(`annotation-repository.ts:149-198`). Annotation create/update/delete requires body,
selectors, revision, backlink preflight, and exact relationships.

## Editor

`mdbase-editor/src/gateway.ts:150-197` deliberately splits a full metadata index
from body hydration. The first query returns every record ordered by `file.mtime`
descending, first page 200 then 1,000, with both persisted and effective
frontmatter. Hydration repeats at the same snapshot with bodies.

Interactive search is local fuzzy/token search over title, filename, path, metadata,
and body (`src/note-search.ts:33-104`), not a server full-text query. Exact read,
create/update, rename/delete preflight, reference rewrite, type/view operations,
watch/reconnect, progress, cancellation, and unknown-mutation recovery are active
gateway behaviors (`gateway.ts:200-410`).

## Pickle

The Rust CLI (`pickle/src/collection.rs:90-397`) creates request Markdown with rich
body/frontmatter/context/metadata/attachments and performs broad request/response
scans for dedupe, exact-ID lookup, inbox state, response joins, conflicts, and event
generation. Inbox order is `created_at` descending; pending/answered/conflict state
is derived from linked-response multiplicity. Status filtering often occurs after
hydration.

The Obsidian service (`pickle-obsidian/src/collectionService.ts:211-415`) queries
typed requests with bodies and separately scans records for response-link counts.
Response create/update permits schema-driven nested values and attachments.
`mdbase-connect/packages/pickle/src/index.ts:226-442` confirms the hosted generic SDK
request/response body queries and unknown-mutation recovery.

Pickle's scanned synthetic event IDs are not durable collection cursors. The
benchmark records this behavior but does not invent a new cursor protocol.

## MCP and generic SDK

The benchmark-freeze revision exposed only offset/limit MCP queries. The selected
production implementation now exposes selection, grouping, summaries,
contract/frontmatter mode, cursor pagination, snapshot input, explicit cursor
release, abort propagation, exact body opt-in, mutation IDs, and retry receipts in
`mdbase-connect/services/mcp/src/mcp.ts`. The frozen benchmark measurements retain
the earlier shape for historical comparability; staging acceptance uses the current
advertised schema and must not infer a missing production capability from that
prototype inventory.

The public SDK query surface includes selective metadata, broad type pagination,
body predicates without returning bodies, body-bearing pages, bounded order/top-K,
group/count/summary, projections/context, exact reads, revision-safe mutations,
preflight/reference operations, cancellation, and request-ID recovery. Relevant
sources include `packages/client/test/public-api/exports.ts:32-43`,
`packages/client/src/query-pagination.ts`, `packages/client/src/operation-types.ts`,
and mdbase-rs `tests/v03_query_profile.rs:175-286`.

Workout is included as generic SDK evidence: `workout_tracker/src/lib/connect-api.ts`
uses broad contract scans up to 20,000 and client-side ordering/statistics; tests
exercise five cold contract scans, three parallel scans, coalesced cancellation,
and mutation recovery.

## Frozen response distinctions

- Metadata: path, type set, file facts, effective frontmatter, and—where Editor or
  generic SDK requests it—persisted frontmatter.
- Body pages: metadata plus body.
- Exact reads/writes: exact document, body, persisted/effective frontmatter, type
  set, file facts, and revision.
- Saved views/groups: ordered records plus total/has-more and exact group keys,
  counts, and summaries.
- Pickle/Reader joins: relationship targets and bodies are required; status is not
  safely reducible to a stale type hint.

No inspected repository contains production-scale checked-in data. All scale
fixtures in this benchmark are deterministic synthetic extrapolations from these
observed shapes.
