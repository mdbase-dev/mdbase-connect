# SDK: one entry

`createMdbase(declaration, options)` is the only way to make the app's entry,
and `Mdbase` is the only interface it has. The inner `MdbaseApplication`
interface, the `MdbaseConnect` class and `mdbase.application` are gone.

```ts
import { createMdbase, type Mdbase, type MdbaseOptions, type MdbaseSnapshot } from "@mdbase-dev/sdk";

const mdbase: Mdbase = createMdbase(declaration, options);
```

## What changed

| Before | Now |
|---|---|
| `new MdbaseConnect(declaration, options).application()` | `createMdbase(declaration, options)` |
| `connect.connection(id)` | `mdbase.connection(id)` |
| `application.authorize(o)` | `mdbase.signIn(o)` |
| `application.approve(null, o)`, `addPrivateCollection(o)` | `mdbase.addCollection(o)` |
| `application.clearSelection(o)` | `mdbase.chooseAnother(o)` |
| `application.setup.apply(plan)` rejecting `setup_changed` or `outcome_unknown` | `mdbase.setup.apply(plan)` resolving `{ outcome: "changed" \| "unknown", snapshot }` |
| `application.openUnsynced`, `planUnsyncedTransfer`, `transferUnsynced`, `discardUnsynced` | `mdbase.unsynced.open`, `planTransfer`, `transfer`, `discard` |
| `mdbase.application` | removed; `Mdbase` has every method |
| `MdbaseConnectOptions` | `MdbaseOptions` |
| `MdbaseApplicationSnapshot` | `MdbaseSnapshot` (`phase`, `sync` and `links` always present) |
| `MdbaseApplication`, `MdbaseApplicationEntry`, `MdbaseApplicationSetup`, `MdbaseApplicationUnavailableError` | removed from the package's exports |

`chooseAnother` adds a history entry, so Back returns to the collection.
`clearSelection` replaced the current entry instead. No app used it.

Every method of `Mdbase` is always present. Where the SDK cannot run (no
Worker support, wrong origin) each asynchronous one rejects with code
`application_not_yet_available`, and the snapshot's `phase` says so. The
`unsynced` methods rejected with an `MdbaseError` of that reason before; they
now reject like the rest.

## Tests

`@mdbase-dev/sdk/testing` follows:

| Before | Now |
|---|---|
| `createApplicationFixture(o).entry.application()` | `createApplicationFixture(o).mdbase` |
| `fixture.entry.connection(id)` | `fixture.mdbase.connection(id)` |
| `createTestApp().entry`, `.application` | `createTestApp().mdbase` |
| `MdbaseApplicationSnapshot` for `initialSnapshot` and `publishSnapshot` | `ApplicationFixtureSnapshot` |
| fault `{ action: "applySetup", reason }` makes `setup.apply` reject | it makes `setup.apply` resolve `changed` or `unknown` |

The recorded action names are unchanged: `signIn` records `"authorize"` and
`addCollection` records `"approve"` with no collection. `"clearSelection"` is
removed.
