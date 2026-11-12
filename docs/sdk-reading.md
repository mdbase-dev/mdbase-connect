# SDK: read helpers and query cursors

## Shared read helpers

```ts
const records = await db.readMany(refs, {
  include: { effective: true },
  signal,
  concurrency: 8,
});
for await (const page of db.queryPages(query, { include, signal })) {
  displayPage(page); // retains complete/asOf/diagnostics, not only records
}
```

`readMany(refs, { include?, signal?, concurrency? })` makes ordinary `get` calls and
returns genuine `RecordView` values in input order. Duplicate selections retain
separate calls and output slots. Up to 1000 selections are allowed; concurrency
is an integer 1..16 (default 8). Path selectors must be nonempty and at most
4096 UTF-8 bytes. UUIDs (including a supplied view's UUID), paths, Include and
concurrency are captured before the first await. A view's old path/revision is
not asserted current and a partial input is never promoted to a native witness.

Missing/refused/error reads fail the entire batch with the first observed error,
not omitted rows or partial success. Scheduling stops; already-started reads
settle before that error is delivered. The original signal fences dispatch and
final delivery, including late backend replies. There is no helper-level retry,
refresh, fallback, replacement identity or cancellation of the caller's signal;
the ordinary SDK `get` transport policy is unchanged. Request/in-flight bounds
are not a peak-heap or returned-byte budget. Use explicit Include and bounded
selections when hydrating bodies/documents. Multiple gets are **not a single
native snapshot**; callers still check identity/source-revision witnesses.

`queryPages(query, { include?, signal?, onReset? })` delegates **exactly** to `pages`
and returns the same whole-page iterator. No records are flattened and no reset
is added. Root exports `readMany(client, ...)`, `queryPages(client, ...)` and
`ReadManyOptions` are also available.

## Query cursor resets

`pages(query, { include?, signal?, onReset? })` repeats the original query with the
replica's opaque cursor. By default, typed `invalid_request/fix_request` reasons
`cursor_expired` and `cursor_stale` are thrown unchanged. There is no offset
fallback or automatic mixing of already-yielded pages with a fresh query.

To opt in to **one restart per iterator**, clear your accumulated/displayed
paging state in the awaited `onReset` callback:

```ts
for await (const page of db.pages(query, {
  include,
  signal,
  onReset: async ({ reason, pagesYielded, signal }) => {
    await clearDisplayedPages(); // completes BEFORE the fresh first-page RPC
  },
})) {
  displayPage(page);
}
```

Reset clears all earlier pages even if expiry keeps the same `asOf`. The SDK
strips the cursor and preserves the captured original offset, limit, query and
include on restart. Callback failure, cancellation, or a second cursor refusal
stops the iterator. Malformed/foreign/conflicting cursors, READ denial and other
errors never trigger this callback. Native cursor lifetime/clock/head guarantees
remain the replica's responsibility; these SDK tests do not qualify that producer.
