# SDK: record sets

`db.recordSet({ types?, include?, signal? })` is every record of the chosen
types (default: all of them), read completely once and then kept current. It is
the set an app lists, searches and renders from.

```ts
const notes = db.recordSet({ include: { effective: true } });
const stop = notes.subscribe((changes) => {
  const { records, state, problem } = notes.getSnapshot();   // same object until something changes
  for (const c of changes) {
    if (c.kind === "remove") closeTab(c.previous.id);
    else if (c.previous && c.previous.path !== c.record.path) renameTab(c.record);
  }
  render(records, state);
});
await notes.ready;        // first complete read; rejects if it fails for good
notes.get(id);            // one record of the set
notes.close();
```

| `state` | `records` | What the set is doing |
|---|---|---|
| `loading` | what has arrived so far | The first complete read, one page at a time. |
| `current` | complete | Following the change feed. |
| `stale` | the last complete read | Reconnecting, rereading, or retrying. It recovers by itself; `problem` says what it is waiting on. |
| `failed` | kept | It cannot continue (`problem`, for example access removed). `reload()` tries again. |
| `closed` | kept | |

The set reads in pages, so a collection of any size fits. After that it rereads
only the records the change feed names, and resumes the feed where it left off
after a dropped connection. It reads everything again only when the feed cannot
say what changed, when a great many records changed at once, or on `reload()`.
Every listener call says which records were put or removed, a rename being a
put whose `previous.path` differs.

The change feed reports record changes. It does not report a changed type
definition, so call `reload()` after one if you show `effective` values or
`types`.

`db.live(query)` is a different tool: one window of at most 1,000 records and
1 MiB, ordered and counted by the replica. Use it for "the 50 tasks due next",
not for a whole collection.
