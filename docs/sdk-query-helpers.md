# Client query helpers

These helpers use existing query operations; no authority/protocol upgrade is required.
Collection semantics and authorization remain owned by the authority.

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

## `readMany(paths, options)` — stage 1

Available on both `MdbaseConnection<Frontmatter>` and
`MdbaseCollectionClient<Frontmatter>` (`/advanced`). It performs exact raw-path
queries using escaped `file.path in [...]` CEL. It does not interpret wikilinks,
normalize paths, resolve IDs, map contract fields, or circumvent query grants.
A semantic-only grant may reject these raw queries; there is no silent contract
fallback.

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
- `found` contains a typed `ReadManyRecord<Frontmatter>` with the query's
  frontmatter/file/types and optional body. `includeBody` defaults to the
  authority's query default (omitted); `frontmatterMode` is effective, persisted,
  or both, exactly as for `query`. These are not exact Markdown documents.
- `missing` means no matching row under the supplied `types` and grant. It does
  not prove deletion outside that selection.
- `error` references a zero-based batch in `errors`, each containing the queried
  unique paths and the original typed failure/diagnostics. If any page fails,
  the entire batch is an error, including paths already seen on earlier pages;
  partial data is never mistaken for missing records. Other batches continue.
  A successful outer outcome can contain batch errors; callers must check them.
- `batchSize` defaults to 100 (valid range 1..1000); `concurrency` defaults to 4
  (1..4). Only independent batches overlap; each batch drains its cursor serially.
  `latestWins` coordination is rejected because sibling batches would cancel
  one another. Identical page requests are never coalesced as reusable cursors.
- One total `timeoutMs` budget covers queued batches and all their pages.
  Cancellation/timeout stops launching batches and returns an outer failure,
  not a partially successful/missing result. Successful batch diagnostics are
  combined in batch order; failed batch diagnostics stay on their failure.
- Independent batches are **not** one atomic collection snapshot. Concurrent
  edits can be observed at different generations across batches.

**Revision information today:** `ReadManyRecord.revision?: string` is absent on
current query authorities. File `mtime`/size are metadata, not revisions. No
revision is synthesized and no hidden per-path `read()` is issued. Continue to
use `read()` for authoritative revisions, exact Markdown, and conditional writes.
The signature/result envelope reserves optional revision information so a future
negotiated revision-bearing authority implementation can replace path queries
without changing caller signatures. Stage 2 protocol/capability work is deferred.
In particular, Reader cannot yet delete revision-bearing hydration; TaskNotes
must keep its editing revision re-read. Writer/TaskNotes/Reader can replace only
revisionless path-query builders/batch loops now.

## `linksTo(field, path, { multiple? })`

Exported from `@mdbase-dev/connect`. Returns a CEL `where` string for **server-side**
resolution. `field` is one literal top-level effective-frontmatter key, not a CEL
expression or dotted field selector; punctuation, reserved names, quotes and
Unicode are escaped via `record["..."]`. `path` is the exact canonical
collection-relative target path, including its extension; it is compared, not
resolved or normalized. Scalar link fields are the default; `{multiple: true}`
uses `exists()` for a declared link list. A wrong field shape is an authority
query error/diagnostic, not a client coercion. Missing/null fields, null list
members, and unresolved targets do not match.

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
