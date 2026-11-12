# SDK: read options

Every read on the client takes at most one trailing options object, as writes
already do. `signal` is always a field of it, and a read that returns records
takes `include` there too.

```ts
const note = await client.get(id, { include: { body: true }, signal });
const page = await client.query({ types: ["note"] }, { include: { body: true }, signal });
for await (const page of client.pages(query, { include, signal, onReset })) show(page.records);
const stop = client.watchChanges(batch => apply(batch), { cursor });
```

Two types name the common fields:

```ts
interface ReadOptions { signal?: AbortSignal }
interface RecordReadOptions extends ReadOptions { include?: Include }
```

## What changed

| Method | Before | Now |
|---|---|---|
| `get`, `find` | `(ref, include?, signal?)` | `(ref, { include?, signal? })` |
| `readMany` | `(refs, include?, signal?, { concurrency? })` | `(refs, { include?, signal?, concurrency? })` |
| `getContract` | `(ref, contract, signal?)` | `(ref, contract, { signal? })` |
| `query` | `(query, include?, signal?, { contract? })` | `(query, { include?, signal?, contract? })` |
| `pages`, `queryPages` | `(query, include?, signal?, { onReset? })` | `(query, { include?, signal?, onReset? })` |
| `live` | `(query, include?)` | `(query, { include? })` |
| `LiveQuery.setQuery` | `(query, include?)` | `(query, { include? })` |
| `changes` | `(cursor?, limit?, signal?)` | `({ cursor?, limit?, signal? })` |
| `watchChanges` | `(cursor, onChanges)` | `(onChanges, { cursor? })` |
| `validate` | `(refs?, signal?)` | `({ refs?, signal? })` |
| `describe` | `(signal)` or `(options)` | `({ definitions?, signal? })` |
| `describeTyping` | `(types, paths, signal?)` | `(types, paths, { signal? })` |
| `receipt` | `(mutation, signal?)` | `(mutation, { signal? })` |
| `awaitReceipt` | `(mutation, timeoutMs?, signal?)` | `(mutation, { timeoutMs?, signal? })` |
| `pendingWrites`, `listHolds`, `pendingDevices` | `(signal?)` | `({ signal? })` |
| `listConflicts` | `(record?, signal?)` | `({ record?, signal? })` |
| `appliedPrefix` | `(seq, signal?)` | `(seq, { signal? })` |
| `executeAppBases`, `listAppBasesViews`, `readAppBasesViewSource` | `(request, signal?)` | `(request, { signal? })` |
| `files.get`, `files.fetch` | `(file, signal?)` | `(file, { signal? })` |
| `resources.get` | `(path, signal?)` | `(path, { signal? })` |
| `views.list` | `(folder?, signal?)` | `({ folder?, signal? })` |
| `views.readSource` | `(source, signal?)` | `(source, { signal? })` |
| `accountKey.status` | `(signal?)` | `({ signal? })` |

Methods that already took one options object are unchanged: every write,
`settle`, `recordSet`, `backlinks`, `resolveLinks`, `queryContract` and
`executeAppBasesPages`.

## Migrating

There are no overloads, so TypeScript reports every call that passes the old
arguments. Two cases need a second look because they can compile:

- A call on an untyped value (`any`, or a test double). `get(id, { body: true })`
  there now asks for no body.
- `watchChanges` swapped its arguments. A cursor passed first is now treated as
  the callback.
