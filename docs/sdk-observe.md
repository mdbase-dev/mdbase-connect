# Observe a live record query

`connection.observe(query, options)` owns progressive loading, watch catch-up,
coalesced authority-side membership checks and `readMany`, reset/gap reloads,
request generations and cancellation. It returns frozen snapshots/deltas, not
a durable replica. The same API is available on `MdbaseCollectionClient`.

```ts
const live = connection.observe({ types: ["note"], frontmatterMode: "both" }, {
  signal: lifetime.signal
});
const stop = live.subscribe((snapshot, delta) => render(snapshot, delta));
const initial = await live.ready; // check initial.ok
const current = live.getSnapshot();
await live.hydrate();            // opt into progressively loaded bodies
await live.refresh();            // explicit refresh / recovery after an error
stop(); live.close();
```

`subscribeChanges` exposes the existing typed events for domain effects.
`optimistic(upserts, removed)` returns token-owned `commit()`/`rollback()` hooks;
execute revision-checked writes yourself, commit only after acceptance. A matching
qualified metadata revision avoids a document reread; membership and derived file
links/tags/embeds are still queried at the authority. Incomplete caller rows and
legacy authorities are confirmed with reads. Newer local overlays survive older
remote work. In watch mode, acceptance queues confirmation even if the echo
already finished; manual mode confirms accepted overlays on its next full scan.

Manual observers use `{ mode: "manual" }` and perform no watch/changes requests;
refresh from your visibility/timer policy. Refresh currently scans again, rather
than doing incremental cursor polling.

Initial loads, refreshes and body hydration use full-row query pages directly.
Full-row queries carry exact source revisions on qualified authorities; no initial
metadata discovery or document rereads are needed. Metadata membership and
revision-bearing document batches are reserved for change deltas and explicitly
capability-gated; these document reads require existing query **and read** approval.
Older authorities use ordinary queries, never error probing. The observer retains
authority-computed file links, embeds and tags: it does not parse Markdown itself.
Ordered, offset, selected/projected and contract queries reload on changes.
`limit` is a page size, not a result cap. Predicates and context default to
collection invalidation; use `invalidation: "paths"` only for criteria whose
membership depends on the changed record alone.

`ready` follows the active initial scan through refresh/hydration supersession;
closing before completion cancels it. It does not mean an atomic watch high-water
mark. A failed read or permanent watch failure stops that generation and exposes
`state: "error"`, its problem, and a closed watch status. Unrelated changes cannot
clear the error or leave an unnoticed stale path: call `refresh()` to reconcile
fully and restart the watch. Failed reads are never treated as deletions.
The full result set is retained; benchmark your query scope and body requirements.

Migration: replace collection load/watch/reset workers with one observer; consume
`delta.upserts` and `delta.removed` in existing domain indexes. Keep drafts,
record sessions, domain mapping/search, browser file caches and offline mirrors.
See [consistency, ownership and consumer sketches](architecture/sdk-observe.md).
