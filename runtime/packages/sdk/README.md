# @mdbase-dev/sdk

The TypeScript SDK for apps that read and write mdbase collections. It signs
the person in, opens the collection they choose, keeps it open and in sync, and
gives the app one connection for its records, files and people.

```ts
import { createMdbase } from "@mdbase-dev/sdk";

const mdbase = createMdbase(declaration);
mdbase.subscribe(() => render(mdbase.getSnapshot().phase));
await mdbase.start();
```

## Install

```sh
npm install --save-exact @mdbase-dev/sdk
```

Pin an exact version, not a range. The npm package trusts the production
service only. Staging and LAB builds use separate packages; see
[SDK publication](../../../docs/sdk-publication.md).

## Quick start

An app declares itself with its manifest, the `mdbase-app.json` it serves at
`/.well-known/`. The manifest names the app and what it asks for: the
contracts it uses, what it may do with records, and which file actions.
`@mdbase-dev/sdk/manifest` validates it at build time.

```ts
import { createMdbase, type MdbaseApplicationDeclaration } from "@mdbase-dev/sdk";
import manifest from "../public/.well-known/mdbase-app.json";

const declaration: MdbaseApplicationDeclaration = {
  id: manifest.id,
  name: manifest.name,
  origin: location.origin,
  environment: "production",
  manifest,
};

export const mdbase = createMdbase(declaration);
```

`mdbase.getSnapshot().phase` is the one state the app renders from. Switch on
`phase.kind`:

```tsx
function App() {
  const { phase, collections } = useSyncExternalStore(mdbase.subscribe, mdbase.getSnapshot);
  switch (phase.kind) {
    case "starting":
    case "opening":
      return <Loading />;
    case "signed_out":
      return <button onClick={() => mdbase.signIn()}>Sign in</button>;
    case "authorizing":
      return <p>Continue in the mdbase window.</p>;
    case "choosing":
      return <Chooser collections={collections} onOpen={(id) => mdbase.select(id)} onAdd={() => mdbase.addCollection()} />;
    case "needs_approval":
      return <button onClick={() => mdbase.approve(phase.collectionId)}>Allow access</button>;
    case "needs_unlock":
      return <Unlock onSubmit={(password) => mdbase.unlock(phase.collectionId, { password })} />;
    case "needs_setup":
      return <button onClick={() => mdbase.configure()}>Set up this collection</button>;
    case "ready":
    case "unsynced":
      return <Notes db={phase.connection.records} />;
    case "problem":
    case "unavailable":
      return <Problem problem={phase.problem} />;
    case "closed":
      return null;
  }
}

void mdbase.start();
```

`start` restores a signed-in device and opens the collection named in the URL
or the one last used. `signIn`, `addCollection` and `approve` open a Connect
window, so call them from a click.

### Phases

| `phase.kind` | The app shows | What moves it on |
|---|---|---|
| `starting` | Its own loading screen | The SDK |
| `signed_out` | A sign-in button; `phase.notice` when sign-in just ended | `mdbase.signIn()` |
| `authorizing` | "Continue in the mdbase window" | The person, in Connect |
| `choosing` | `snapshot.collections` and an "add" button | `mdbase.select(id)`, `mdbase.addCollection()` |
| `opening` | A loading screen; `phase.slow` after 15 seconds | The SDK |
| `needs_approval` | A request to allow this app | `mdbase.approve(phase.collectionId)` |
| `needs_unlock` | A password field when `phase.mode` is `password` | `mdbase.unlock(id, { password })` |
| `needs_setup` | What the app will add to the collection | `mdbase.configure()`, or `mdbase.setup.plan()` then `setup.apply(plan)` |
| `ready` | The app, using `phase.connection` | |
| `unsynced` | The app, on work kept only in this browser (the `unsynced` option) | `mdbase.signIn()`; then `mdbase.unsynced.planTransfer()` and `transfer(plan)` copy the work into the collection the person opens |
| `problem` | `phase.problem`: a title, a message and an action | The action |
| `unavailable` | `phase.problem`: the SDK cannot run here | |
| `closed` | Nothing; `mdbase.close()` was called | |

The phase stays `ready` while the collection is checked again or meets a
problem that clears by itself; `phase.rechecking` and `phase.problem` say so.
Going offline does not change the phase. [Status](#status) reports it.

## Records

`phase.connection.records` is the collection client. Values are plain JSON.

```ts
const db = phase.connection.records;

const note = await db.get({ path: "notes/hello.md" }, { include: { body: true } });
const { records } = await db.query({ types: ["note"], where: 'status == "open"', limit: 50 });

const created = db.create({ type: "note", path: "notes/new.md", frontmatter: { title: "New" }, body: "" });
const updated = db.update(note, { patch: { status: "done" } });
```

A write resolves as soon as it is kept on the device. `settle` waits for the
answer the person cares about, and reads the record back:

```ts
const saved = await db.settle(updated, { read: { include: { body: true } } });
switch (saved.outcome) {
  case "confirmed":       // the sync service has it
  case "saved_on_device": // kept here; it syncs when the service can be reached
  case "conflicted":      // confirmed, but a concurrent change won for some values
    render(saved.record);
    break;
  case "rejected":        // not saved
    show(describeError(saved.problem));
    break;
  case "unknown":         // it may have been saved; settle(saved.mutationId) asks again
    remember(saved.mutationId);
}
```

For a list the app keeps on screen, a record set reads every record of the
chosen types once and then follows changes, from this device or another:

```ts
const notes = db.recordSet({ types: ["note"] });
notes.subscribe(() => render(notes.getSnapshot().records));
await notes.ready;
```

Guides: [writes](../../../docs/sdk-writes.md),
[record sets](../../../docs/sdk-record-sets.md),
[reading and queries](../../../docs/sdk-reading.md),
[values](../../../docs/sdk-values.md),
[editing one record](../../../docs/sdk-record-editing.md).

## Status

`snapshot.sync` is the one status to show for the open collection: saved,
saving, offline, reconnecting, or needing the person. The app does not combine
network state and pending writes itself.

```ts
const { sync } = mdbase.getSnapshot();
if (sync?.state === "saved") allowClose();
```

See [sync status](../../../docs/sdk-sync-status.md).

## Problems

Every problem the SDK reports has a title, a message and an action to branch
on. `phase.problem` is already described. For an error the app catches:

```ts
import { describeError } from "@mdbase-dev/sdk";

try {
  await db.get(id);
} catch (error) {
  const problem = describeError(error);   // null for a cancellation
  if (problem) show(problem.title, problem.message);
}
```

Pass `messages` to `createMdbase` and `describeError` to put the copy in the
person's language; see [problem copy](../../../docs/sdk-problem-copy.md).

## Testing

`@mdbase-dev/sdk/testing` runs the app against an in-memory collection, with no
network, Worker or sign-in:

```ts
import { createTestApp } from "@mdbase-dev/sdk/testing";

const app = await createTestApp({
  phase: "ready",
  collections: [{ name: "Notes", records: [{ path: "hello.md", body: "Hi" }] }],
});
render(<App mdbase={app.mdbase} />);
```

See [testing an app](../../../docs/sdk-testing.md).

## Where the app runs

| Environment | Guide |
|---|---|
| A web app | This page, then [opening a cloud copy](../../../docs/sdk-opening.md) and [build environments and localhost](../../../docs/sdk-environments.md) |
| A browser extension, or several bundles on one origin | [Shared session](../../../docs/sdk-shared-session.md) |
| A native shell | [Native shells](../../../docs/sdk-native-shells.md) |
| A document embedded in another app | [Running inside another app's document](../../../docs/sdk-native-shells.md#running-inside-another-apps-document) |
| A page without a bundler | [Classic-script bundle](../../../docs/sdk-browser-bundle.md) |
| A server, a CLI, or a plugin with its own connection | [Bringing your own connection](../../../docs/sdk-thin-client.md) |

## More

| Topic | Page |
|---|---|
| Private collections | [sdk-private-collections.md](../../../docs/sdk-private-collections.md) |
| File access and asking for more | [sdk-access.md](../../../docs/sdk-access.md) |
| Collection setup, deletion and type packs | [sdk-collection-setup.md](../../../docs/sdk-collection-setup.md) |
| Several vaults on one origin | [sdk-multiple-vaults.md](../../../docs/sdk-multiple-vaults.md) |
| Validation and definition errors | [sdk-validation.md](../../../docs/sdk-validation.md) |
| Saved views | [sdk-saved-views.md](../../../docs/sdk-saved-views.md) |
| People and contracts | [sdk-people.md](../../../docs/sdk-people.md) |
| Read options | [sdk-read-options.md](../../../docs/sdk-read-options.md) |
| Feature negotiation | [sdk-features.md](../../../docs/sdk-features.md) |
| Which entry to import | [sdk-entries.md](../../../docs/sdk-entries.md) |

## Entries

| Import | For |
|---|---|
| `@mdbase-dev/sdk` | An app: `createMdbase` and the collection API |
| `@mdbase-dev/sdk/thin-client` | Code that makes its own connection: `connect` and the transports |
| `@mdbase-dev/sdk/testing` | Tests: `createTestApp`, `MemoryReplica` |
| `@mdbase-dev/sdk/describe` | `describeError` alone, for a page that does not load the SDK |
| `@mdbase-dev/sdk/manifest` | Build scripts: validate `mdbase-app.json` |
| `@mdbase-dev/sdk/browser` | The classic-script bundle |

The package has other entries for hosts and build tools. The layout table in
[sdk-development.md](../../../docs/sdk-development.md) lists them.

## Working on this package

Source layout and checks: [sdk-development.md](../../../docs/sdk-development.md).
