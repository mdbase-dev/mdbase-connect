# SDK: testing an app

`@mdbase-dev/sdk/testing` gives an app's tests the real SDK client over an
in-memory replica, and a controllable `Mdbase`. No network, Worker or sign-in
is involved.

| Use | For |
|---|---|
| `createTestApp(options)` | Screens and flows: the `Mdbase` an app gets from `createMdbase`, started on a chosen screen, with real records behind it |
| `new MemoryReplica(options)` | Code that works on a collection client: records, queries, writes, change watches |

Neither is the replica. Queries are not planned, writes are not merged, and
contracts and types are not validated. Use them to test the app, and the LAB
for the system.

## A whole app

```ts
import { createTestApp } from "@mdbase-dev/sdk/testing";

const app = await createTestApp({
  phase: "signed_out",
  collections: [{ name: "Notes", records: [{ path: "hello.md", body: "Hi" }] }],
  messages,                       // the catalogue the app passes to createMdbase
});
render(<App mdbase={app.mdbase} />);

app.fail({ action: "authorize", outcome: "closed" });   // the next sign-in is closed
await app.mdbase.signIn();
app.set("ready");                                        // switch screens
app.replica().editElsewhere("hello.md", { body: "Changed on another device" });
await app.close();
```

- `phase` starts on `signed_out`, `choosing`, `opening`, `needs_setup`, `ready`,
  `second_tab`, `{ problem }` or `{ needsUnlock }`. `set` switches later.
- `fail` queues one fault for the next matching action: a declined or closed
  approval, a collection that fails to open, a wrong unlock secret, a setup
  that changed, or any `MdbaseError`.
- `replica(id)` and `client(id)` reach the records of a collection.
- `controls.observedActions()` lists what the app called.

## A collection client

```ts
import { MemoryReplica } from "@mdbase-dev/sdk/testing";

const replica = new MemoryReplica({ confirmDelayMs: 0 });
replica.seed({ path: "tasks/a.md", types: ["task"], frontmatter: { title: "A", meta: { tags: ["x"] } } });
const client = await replica.client();
```

`replica.client(options)` connects a client that does not reconnect; pass
`reconnect: {}` for one that does. `seed` and `editElsewhere` take plain
frontmatter, and the exact forms (`Float64`, `bigint`, a `Map`) where a test
needs them.

### What happens elsewhere

| Control | Effect |
|---|---|
| `editElsewhere`, `renameElsewhere`, `deleteElsewhere` | Another device changed a record; the change arrives confirmed |
| `hold(ref)`, `conflict(ref, …)` | The replica holds a record, or reports a field conflict |
| `setOnline(false)` | The sync service is unreachable; writes stay pending |
| `dropConnections()` | The link breaks; a reconnecting client comes back |

### Writes

| Control | Effect |
|---|---|
| `confirmDelayMs: null` and `confirmAll()` | Writes stay pending until the test confirms them |
| `stallConfirmations()` | Writes stay pending though the replica is online |
| `failNextWrite(problem)` | The next submit fails and captures nothing |
| `loseNextResponse()` | The next request runs but its reply is lost |
| `reject(mutation, problem)` | A pending write is refused at the head |

### Reads

| Control | Effect |
|---|---|
| `failNextRead(method, problem)` | The next request of that kind fails; the one after is answered |
| `pauseReads(method)` | Requests of that kind wait until the returned function is called |

`method` names the request: `"get"` (`get`, `find`, `readMany`), `"query"`
(`query`, `pages`, a record set's scan), `"changes"` (`changes`,
`watchChanges`), `"describe"`, and the resource, file, receipt, hold and
contract reads.

A change watch goes through all its states this way, with the real client:

```ts
const client = await replica.client({ reconnect: {} });
const release = replica.pauseReads("changes");
const watch = client.watchChanges(onChanges);   // "starting"
release();
await watch.ready;                              // "active"
replica.dropConnections();                      // "stale", then "active" again
replica.failNextRead("changes");
client.watchChanges(onChanges);                 // "failed"
```

## Types and contracts

`describe` answers from what the test declared:

```ts
const replica = new MemoryReplica({
  contracts: [{
    id: "tasks.task", version: "1.0.0", type: "task",
    fields: { title: "title", done: "status" },      // contract field → record field
    binding: { archive: { folder: "Archive" } },
    contractDigest: TASK_CONTRACT_DIGEST,
  }],
});
replica.seedType("task", { version: 2 });
```

- Each declared contract is listed in `contracts`, with its `path` (default
  `_contracts/<id>.md`), its digest and the types that implement it.
- Each type lists what it implements. If its type file has an `implements`
  list, the file's entries come first and give `fields` and `binding`, so a
  type file the app rewrites shows in the next `describe`. Declared contracts
  the file does not list follow.
- `getContract`, `queryContract` and contract writes map fields through the
  declared `fields`.

The replica reads frontmatter as one `key: JSON` line per field, which is what
`seedType` and its own writes produce. If the app writes type files or
`document`s as YAML, pass its parser:

```ts
new MemoryReplica({ parse: document => parseFrontmatter(document) });  // { frontmatter, body }
```

`describe` reports no collection settings unless the test gives some:

```ts
new MemoryReplica({ settings: { validation: "error" } });
```

## Queries

`where` is not evaluated unless the test passes an evaluator for the
expressions the app sends (`MemoryReplicaOptions.where`). `typing` does the
same for temporal hints.
