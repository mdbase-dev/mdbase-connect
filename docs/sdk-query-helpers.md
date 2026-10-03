# Client query helpers

These helpers use existing operations. Query/link helpers and readMany's legacy
path require no authority upgrade; revision-bearing readMany uses an explicitly
advertised extension of `read`. Collection semantics and authorization remain
owned by the authority.

## Page sizes, total caps and cancellation

`queryPages`, `queryAll` and `executeViewPages` accept `pageSize`, `firstPageSize`
and `maxResults`:

- `pageSize` sets the initial cursor page size, unless `firstPageSize` is explicit.
  `input.limit` is the final size fallback, **not a total-result limit**. With no
  explicit size the initial request remains 200 rows. Authorities may cap sizes.
- Cursor continuations omit `limit` and therefore use the initial pinned size.
  `firstPageSize: 50, pageSize: 1000` means 50-row cursor pages, **not** a ramp to
  1000. With legacy offset/snapshot paging only, subsequent requests use
  `pageSize` (default 1000). An iterator starting with an existing cursor cannot
  resize it. Cursor pages are always sequential, never prefetched in parallel.
- `maxResults` is an opt-in non-negative safe integer total delivery cap, counted
  from this invocation (after any initial offset/cursor). Zero makes no data
  requests. The last page is trimmed if necessary and the cursor is released.
  `loaded` counts delivered rows; `complete` means this iterator has finished,
  including at the cap. `meta.hasMore` and `meta.totalCount` remain authority
  facts, not counts/continuation promises for the capped iterator. `queryAll`
  preserves them and does not fabricate a total count for a capped partial scan.
  With a zero cap no authority metadata was requested.
- An aborted lifetime `signal` releases a paused iterator's latest cursor without
  requiring `next()` or `return()`. During an in-flight request, cleanup waits for
  settlement so it can release the rotated token. Abort stops further delivery;
  iterator calls then finish. `break`/`return()`, completion, and errors also
  release leases. Cleanup is best effort, once per owned token, independently
  budgeted, and does not delay delivery. Abandoning an iterator without abort,
  return, or completion still depends on the authority's lease expiry.
- `queryPages`/view pages use independent `pageTimeoutMs` budgets; `queryAll`
  shares one `timeoutMs` deadline across all pages. Cleanup never uses that
  expired deadline or the aborted data signal.

```ts
for await (const outcome of connection.queryPages(
  { types: ["note"], includeBody: false },
  { pageSize: 1000, maxResults: 2500, signal: lifetime.signal }
)) {
  if (!outcome.ok) throw new Error(outcome.problem.message);
  render(outcome.value.results);
}
```

**Migration:** TaskNotes can remove the explicit `pages.return()` abort workaround
in `src/application/view-query-session.ts` once it pins this SDK. Explicit return
for ordinary disposal remains valid. Consumers relying on adaptive cursor sizes
should remove their small `firstPageSize` and choose `pageSize` for the whole
scan. This replaces the SDK's continuation-limit/error-retry mechanism: even
newer authorities that support variable sizes are deliberately used in their
portable pinned-size mode. The existing automatic first-page cursor/legacy offset
fallback is unchanged; explicit cursor requests stay strict.

## `readMany(paths, options)` — negotiated revision-bearing batches

Available on both `MdbaseConnection<Frontmatter>` and
`MdbaseCollectionClient<Frontmatter>` (`/advanced`), with the same signature and
query-shaped result on both paths. By default it discovers `read-many-documents-v1` through
B1's connection-owned helper. Advertised producers receive bounded `read` requests
with `paths`; unsupported producers receive only the original escaped
`file.path in [...]` queries. No errors or query revision fields are support probes.
There is no document/contract/exact-source overload in this signature.

For read-only hydration, use `readMany(paths, { revisions: false, includeBody: true,
types: ["annotation"] })`. This skips document-feature discovery, preselection and
document reads even on upgraded authorities. Each batch is one escaped typed path
query (plus cursor continuations if the authority caps pages). Only `query` approval
is required. The default batch size is the query page ceiling, 1,000 paths; choose
`batchSize: 500` for a smaller payload. Ordering, duplicate identity, missing entries,
batch failures and the total cancellation budget are unchanged. Query rows may
still contain an authority revision, but this mode promises none: do not use it to
establish revision-safe write state.

Qualified document reads require existing `read` approval. If `types` is supplied,
query preselection evaluates membership on the authority before reading matching
paths; it also requires `query`. Selection and hydration are separate reads, not
one pinned snapshot. The SDK does not copy type semantics, interpret wikilinks,
normalize paths, resolve IDs or map contract fields. Semantic-only grants may
reject raw queries/reads; there is no silent contract or permission fallback.

```ts
const outcome = await connection.readMany(paths, {
  includeBody: true,
  frontmatterMode: "both",
  types: ["reader-annotation"],
  batchSize: 100,
  concurrency: 4,
  signal: lifetime.signal,
  timeoutMs: 20_000
});
if (!outcome.ok) throw new Error(outcome.problem.message);
for (const entry of outcome.value.results) {
  if (entry.status === "found") useRecord(entry.record);
  else if (entry.status === "missing") removeFromIndex(entry.path);
  else report(outcome.value.errors.find(error => error.batch === entry.batch)!.failure.problem);
}
```

Contract:

- One result per input path in input order, including duplicates. Unique paths
  are queried once; duplicate found entries share the same record object. No
  request is made for empty input. Paths are compared exactly as supplied.
- `found` contains a typed `ReadManyRecord<Frontmatter>` with
  frontmatter/file/types and optional body. Qualified document batches supply an
  exact-source `revision`; legacy query rows may omit it. `includeBody` defaults
  false and `frontmatterMode` defaults effective, retaining query semantics.
  Persisted/effective/both controls which returned frontmatter members are
  exposed, not their evaluation. These projections are not full record documents
  or exact Markdown; use point `read()` for those.
- `missing` means no matching row under the supplied `types` and grant. It does
  not prove deletion outside that selection.
- `error` references a zero-based batch in `errors`. Transport, authorization,
  capacity or malformed-response failures cover all unique paths in that batch;
  partial data is never mistaken for missing records. This also applies when any
  legacy query page fails. Native semantic item failures cover only their failed
  paths, preserving other found/missing items. Their diagnostic codes/messages
  and paths are in `failure.problem.details.diagnostics`; several item errors
  share one batch failure. Other batches continue. A successful outer outcome
  can contain errors; callers must check them. Admission discovery failures stay
  outer failures; discovery failure after selection is a batch failure. Neither
  is evidence for a legacy fallback.
- `batchSize` defaults to 100, or 1,000 with `revisions:false` (valid range 1..1000); qualified document reads cap
  each request at the wire maximum of 100. `concurrency` defaults to 4 (1..4).
  Only independent batches overlap; query cursors remain serial. Support is
  rechecked from connection-lifetime evidence at every admission, including
  after route/authorization changes. `latestWins` is rejected because sibling
  batches would cancel one another. Identical page requests are never coalesced
  as reusable cursors. An 8-MiB document-response capacity failure remains
  explicit; choose smaller batches rather than silently truncating or probing.
- One total `timeoutMs` budget covers queued batches and all their pages.
  Cancellation/timeout stops launching batches and returns an outer failure,
  not a partially successful/missing result. Successful batch diagnostics are
  combined in batch order; failed batch diagnostics stay on their failure.
- Independent batches are **not** one atomic collection snapshot. Concurrent
  edits can be observed at different generations across batches.

**Read-only migration:** Writer can replace its hand-written 500-path body queries
(commit `7e95c9b`, `apps/writer/src/backend`) with `readMany(paths, { revisions: false,
includeBody: true, types, batchSize: 500 })`, checking both the outer outcome and
batch errors. A 300-path typed hydration fits one query instead of three 100-path
selection queries plus three document reads. This is an explicit read-only choice,
not an old-authority fallback; editing callers should retain the default.

**Migration:** `ReadManyRecord.revision?: string` remains optional because the
same signature must work with late-updated connectors. Qualified batches always
return it from the same version as their content. File mtime/size are not tokens;
none is synthesized, and there are no hidden per-path reads. Writer, Reader,
TaskNotes and editor may remove redundant revision hydration on the qualified
path, but retain it for legacy rows without revisions. Check support/revision
before deleting those fallbacks; B1 removal requires the coordinator's minimum
supported authority/provider, all consumer pins, and closed N-1/rollback and
connection-cache windows. Standalone providers without a discovery callback
remain conservative legacy providers.

Never attach a preselection/query token to subsequent body data. If discovery and
hydration differ, install the returned content and revision together, invalidate
derived indexes and re-evaluate membership as needed. A source token does not
certify schema/default/computed-value freshness; semantic caches also require
catalog invalidation. Keep TaskNotes' RMW locks and bounded cache, and editor's
open-session write queues. `read()` remains necessary for exact Markdown or a
full `RecordDocument`; a readMany projection must not be cast into one.

## `linksTo(field, path, { multiple? })`

Exported from `@mdbase-dev/connect`. Returns a CEL `where` string for **server-side**
resolution. `field` is one literal top-level effective-frontmatter key, not a CEL
expression or dotted field selector; punctuation, reserved names, quotes and
Unicode are escaped via `record["..."]`. `path` is the exact canonical
collection-relative target path, including its extension; it is compared, not
resolved or normalized. Scalar link fields are the default; `{multiple: true}`
uses `exists()` for a declared link list. A wrong field shape is an authority
query error/diagnostic, not a client coercion. Missing/null fields, null list
members, and unresolved targets do not match. Use this with raw queries;
semantic contract queries do not allow a CEL `where` filter.

```ts
const where = linksTo("source", "sources/book.md");
const assigned = linksTo("assigned people", "people/alice.md", { multiple: true });
await connection.query({ types: ["annotation"], where });
```

The helper guards membership/nulls, calls `asFile()`, and compares
`.file.path`. It is not textual `contains()`, a client-side resolver, or a
backlink index. The source of resolution is the record being evaluated, **not**
the target path or the application's current folder. Authority link rules apply:

- Wikilink aliases and fragments do not change the record target. Explicit
  `./`/`../` targets resolve from the source folder; root-relative targets resolve
  from the collection root. Markdown/bare-path links use the containing folder.
  Extensionless paths use the authority's record-extension rules.
- Simple wikilinks use configured IDs before filenames when `settings.id_field`
  is explicitly configured; v0.3 does not fall back to titles. Simple-name
  matching is case-insensitive; the final resolved path comparison is exact.
- Resolution is collection-wide, not restricted to the query's `types`, selected
  source subset, or app cache. Stored declared links retain their authority
  target-type constraints and use the stored graph's resolution. These rules
  do not broaden an application's grant; the authority owns traversal access.
- Duplicate basenames are not automatically unresolved. Current Rust resolution
  prefers the source directory, then the shallowest path (fewest segments), then
  lexical path order. Ambiguous configured IDs are unresolved, rather than
  falling through to a basename. Runtime/producer version determines resolution;
  this helper never copies those algorithms into the client.

**Consumer differences:** Writer's installed JS resolver probe
(`apps/writer/src/backend/query-capabilities.test.ts`) found collection-wide,
shortest/lexical basename selection (`[[book]]` picked `notes/book.md` over
`sources/book.md`; `[[duplicate]]` picked `other/duplicate.md`). Writer instead
scopes candidates to sources and reports duplicate-basename ambiguity. Its
installed `@callumalpass/mdbase` rc.5 query engine also does not register CEL
`asFile()`, even though its standalone `LinkResolver` resolves links. That
producer cannot use this helper merely by upgrading Connect's client. Rust
Connect authorities already expose `asFile()`. No error-triggered resolver
fallback or portable client resolver is provided here.

Reader can replace its guarded scalar predicate, but must retain its legacy
bare-ID acceptance path. TaskNotes can replace its declared-assignee-list
predicate with `{multiple: true}` and keep its index-aligned projection logic.
Writer must choose authority semantics deliberately rather than treating this
helper as equivalent to its compiler's `PathIndex`.

## Ownership / review budget

Three small modules replace repeated concepts at real boundaries: a shared
cursor lease/size implementation for query and view iterators, one independent
path-batch scheduler, and escaped authority predicate construction. The old
adaptive continuation retry and duplicated paging-size utilities are deleted.
The architecture inventory accounts for three production modules, eight imports
and thirteen TypeScript declarations; the 1,000-line production ceiling and
public API entry-point boundaries remain unchanged. No protocol operations,
capabilities, persisted state, cached payloads or local resolver are added.
