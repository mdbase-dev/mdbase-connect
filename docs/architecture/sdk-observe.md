# SDK live queries

`connection.observe(query, options)` (also `MdbaseCollectionClient.observe`) replaces
consumer-owned progressive loads, change workers, path batching, reset/reconnect
queues, generations and local-write fences. It is an ephemeral query replica, not
an offline mirror or a transaction. Existing one-shot query/watch APIs remain.

## API

```ts
const live = connection.observe({ types: ["note"], frontmatterMode: "both" }, {
  signal: lifetime.signal, firstPageSize: 200, pageSize: 1000,
  coalesceMs: 50, maxPendingPaths: 1000
});
const unsubscribe = live.subscribe((snapshot, delta) => render(snapshot, delta));
const initial = await live.ready; // ConnectOutcome<void>; check ok
live.getSnapshot();              // stable until publication, usable by React
live.subscribeChanges(change => handleDomainEvent(change)); // typed SDK events
await live.hydrate();            // upgrade to bodies, progressively; same owner
await live.refresh();            // explicit reconciliation / error recovery
const write = live.optimistic([queryRow], [previousPath]);
// Execute the app's own revision-checked write:
write.commit();                  // accepted; queue coalesced confirmation
// or write.rollback();           // discard only this token, not newer edits
unsubscribe(); live.close();     // or abort the lifetime signal
```

Snapshots have `records`, `state` (`loading`, `ready`, `error`, `closed`), local
`generation`, optional `total`, `problem` and `watchStatus`. Deltas contain
`reason`, `upserts`, and `removed` paths; they are relative to the immediately
preceding publication, not a durable log. Snapshots, deltas and nested rows are
frozen copies. Unchanged rows retain identity. Subscribers receive future
publications; obtain current state with `getSnapshot`. Retaining history is the
subscriber's responsibility.

`mode: "manual"` makes **no changes or watch requests**. Call `refresh` on
visibility, explicit refresh or an app-owned timer. It deliberately performs a
full query, rather than claiming a resumable cursor on authorities without watch.

## Membership, ordering and consistency

- Capture a change cursor **before** the initial/replacement scan; then watch
  from that cursor. Changes occurring during pages or hydration are caught up.
  No arithmetic cursor-gap inference: cursors are authority tokens. Explicit
  `gap`, unknown events, expired cursors and schema/config/contract/view events
  replace the scan and restart watch from a newly captured baseline.
- Initial rows follow authority page order. Unordered live queries retain
  existing positions and append new paths; rename is removal plus upsert.
  Ordered/offset, selected/projected and contract queries reconcile by
  full query: targeted reads cannot establish global positions or view values.
  Aggregate queries and externally owned continuation tokens are rejected.
  `limit` is a page size, as in `queryPages`, not a total result cap.
- Predicates/context may depend on *other* records. They default to full-query
  invalidation. `invalidation: "paths"` is an explicit caller assertion that
  membership depends only on the changed record (for example a local title
  predicate); `"collection"` forces full invalidation even for type-only queries.
  The SDK never evaluates CEL, types, contracts or mdbase semantics locally.
- Initial loads, refreshes and body hydration use full-row `queryPages` directly,
  honoring the query's page limit. Qualified full-row queries already carry exact
  source revisions (`query-record-revisions-v1`); no document reread is needed.
- Targeted discovery applies the original criteria AND the changed-path scope.
  `query-metadata-v1` enables narrow membership pages for change deltas only;
  otherwise ordinary queries are used explicitly.
  The metadata pass selects authority-derived file tags/links/embeds, which
  document batches omit. These are preserved without client-side Markdown parsing.
  Metadata discovery explicitly requests generation-pinned cursor pages. Legacy
  offset-only scans with no cursor/snapshot token reload on structural events:
  deleting a row during offset paging could otherwise skip an unchanged row.
  `readMany` hydrates matching paths (requiring existing query and read approval),
  selecting revision-bearing documents only
  with `read-many-documents-v1`. No support is inferred from an operation error.
  Metadata pages and subsequent documents are not one authority transaction:
  revisions belong to their own reads; watch catch-up supplies eventual convergence.
- Pages are progressive and may span revisions. `ready` means a scan completed,
  **not** that the watch has reached a globally atomic high-water mark. If the
  initial scan is superseded by refresh/hydration, the same `ready` promise follows
  its replacement, without waiting for a retired request to settle. Hydration
  retains previous rows until replacement pages arrive, then installs the final
  membership. A refresh replaces partial rows progressively. Stable cursor pages
  retain the existing SDK's generation-pinned guarantees, not a reusable body token.

## Fencing, errors and backpressure

Every reload aborts the preceding query and watch. Results from a retired
request cannot install rows, remove overlays, or publish an error. Closing aborts
both and clears timers/listeners. Cancellation returns `operation_cancelled`;
requests inherit SDK budgets and cursor cleanup. Reconnect uses the existing
watch retry policy and saved cursor. Permanent failures publish `error` and a
problem; targeted failures retain previous rows (never reinterpret errors as
missing). Failures abort the generation's watch/rereads and clear queued work,
with a closed watch status; unrelated successful paths cannot clear the problem.
Initial failures may leave explicit partial rows. Recovery is an explicit full
scan via `refresh`, not a silent stale-success fallback.

One fixed-window timer and one drain own remote rereads. Repeated paths coalesce;
a change during a read schedules a follow-up. `readMany` owns its bounded batches
(default four concurrent batches). A pending-path bound (default 1000) triggers
full reconciliation instead of discarding events. Subscriber callbacks are
synchronous: consumers must keep them short and not throw. There is no buffered
snapshot/delta history. Storage is O(current rows + one reload's rows + pending
paths + active overlays), and transient publication work is O(current rows).
Progressive pages grow a private scan map and publish immutable array prefixes;
page deltas contain only that page's visible rows, not a repeated full-prefix diff.
JSON containers are copied/frozen in one traversal without recopying strings.
One-page read-ahead overlaps transport with publication; it uses the same abort
signal and closes its iterator on completion, cancellation or error. The frozen
snapshot itself is the publication baseline, not a second persistent row map.
A full collection/body observer intentionally retains the full result; there is
no implicit LRU that would silently change membership. Applications bound their
query scope and the number/lifetime of outstanding local writes.

Overlays are token-owned and outlive older reads. `commit` marks accepted writes;
only a read begun after acceptance can retire that token. Watched commits always
queue coalesced confirmation, even if their echo was already reconciled; stopped
observers retain accepted overlays for the explicit replacement scan. A qualified metadata
revision matching a complete accepted row avoids a redundant document reread,
while still checking membership and refreshing derived file metadata. A newer
overlay always wins. Uncommitted overlays remain until rollback/acceptance/close. The caller
supplies query-shaped rows and executes writes; the SDK does not infer optimistic
query membership or compare opaque revisions as clocks. Legacy echoes without
revisions are confirmed by targeted reads, not skipped. Manual observers retire
accepted overlays on their next refresh.

## Consumer boundaries

The editor's index controller is now presentation-only; structural reconciliation
and its separate mutation overlay are deleted. Its remaining observation effect
refreshes **open editing sessions**, schema UI, file descriptors and browser
previews, not query membership. When there is no remembered note, a single
`query({ orderBy: [{ field: "file.mtime", direction: "desc" }], limit: 1 })`
selects the startup note in parallel with the observer and description. This
preserves newest-note startup without imposing globally invalidating ordering
on the live query. The former first-page startup promise is deleted. A stopped
generation shows `Sync stopped` and connection retry, not `Connected` alongside
`Retry notes`. Lazy body hydration, search/backlinks, navigation,
Markdown drafts, recovery and conflicts remain app policies. File inventory is
not a record query: retain its `files.list` ownership rather than masquerading
file descriptors as records. Preview opens use capability-gated `files.stat`
(the SDK owns legacy folder-list fallback) before downloading the exact revision.

Writer: replace `flushChanges/drainChanges/fullReconcile` with a type-scoped
observer. Apply `delta.upserts/removed` to existing source/comment/annotation
buckets and compiler worker deltas; retain PathIndex and contract field mapping.
Keep body observers scoped to selected sources and keep record leases/drafts.
Use accepted-write overlays rather than mutation-epoch caches. Recreate typed
observers when fresh schema/contract mappings change their implementing types.
Benchmark before adoption: Writer's existing narrow selected projections retain
less data than full observer rows, and selected queries currently fully invalidate.

TaskNotes: use manual observers per implementing type and call `refresh` from its
existing visibility/online/60-second lifecycle. Remove query cursor catch-up and
write trackers only if full-refresh cost is acceptable, or use a foreground-only
watch with the existing polling cadence. Otherwise retain incremental catch-up
until the SDK supports manual incremental polling. Recreate scopes on binding
changes; retain task models, recurrence
indexes, saved-view paging, document LRU, task RMW locks and exact receipt review.
This first manual API reloads rather than polling changes incrementally; an
always-on watch is opt-in, never a mobile background requirement. Do not migrate
an incremental consumer to full scans merely to claim fewer app lines.
