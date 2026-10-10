# The standalone mdbase library (Rust + JS)

Planned package shape: napi-rs for Node, WASM for the universal helpers, the five
`mdbn-*` crates published alongside `mdbase` as implementation details, with versions
starting at 0.5.0-rc.1. PR 1 (G6 helpers) is up; the Rust facade is next.

This replaces the standalone use of the old engines (`@callumalpass/mdbase` on npm,
`mdbase` 0.4.0-rc.4 on crates.io) with the new engine. Nothing here needs an
account, a daemon or sync. Same core, same file layer, same replica: a library
collection is a **local-only** replica (`SyncMode::LocalOnly`) over
`FileStore<NativePlatform, SqlStore<SqliteIndex>, SqlDiskDb<SqliteIndex>>`.

## Packages

| Artifact | Where | Publishes to | Depends on |
|---|---|---|---|
| crate `mdbase` | `crates/mdbase` | crates.io (name is free) | core, wire, replica, store-file, platform-native |
| crate `mdbase-wasm` → `mdbase-core.wasm` | `crates/mdbase-wasm` | never (ships inside the npm package) | core |
| crate `mdbase-node` (napi addon) | `crates/mdbase-node` | never (ships inside the npm package) | mdbase |
| npm `mdbase` | `packages/mdbase` | npm | nothing at runtime |

`mdbase` on npm has two entry points:

- `mdbase` — **universal helpers** (browser, Node, workers) over `mdbase-core.wasm`:
  digests, JSON Schema, config/types/catalog loading, pack assess/apply, record
  validation, query parsing. Pure functions over strings and JSON. This is gap **G6**
  and is what mdbase-reader and mdbase-writer need before ship.
- `mdbase/node` — the **engine**: `Collection.open/init`, typed CRUD, query, validate,
  links, changes, batch, over the native addon. Plus filesystem flavours of the
  helpers (`loadConfig(root)`, `loadTypes(root)`, `assessTypePack(root, …)`).

### Why napi-rs for Node and not `runtime.wasm` with a Node filesystem host

The task preferred a Node host modelled on the Obsidian `VaultPlatform`/host driver.
Today that is not buildable without owning other workstreams' code:

1. `runtime.wasm` opens `MemStore` only. It has no file, index, journal or fence
   imports (`crates/wasm/src/lib.rs:95-104`); the host-driver ABI exists only as a
   proposed interface, not an implemented synchronous host boundary.
2. `FileStore` cannot be driven through an async host queue yet: `run()` must resolve
   without a host round-trip or it returns `platform suspended`
   (`crates/store-file/src/store.rs:165`). A Node host would need a new
   synchronous-import ABI in the sdk-owned `crates/wasm`, under its size budget.
3. A TS `FilePlatform` on Node would be a second, weaker platform: no `renameat2`
   exchange, no `F_SETLEASE` other-holder probe, its own SQLite binding. The daemon,
   the CLI and the Rust crate all use `mdbn-platform-native`; the Node package should
   behave byte-for-byte like them.

napi-rs wraps the same `mdbase` crate, so Rust and JS share one implementation of
open/init, two-writer safety, publish, holds and receipts. The cost is prebuilt
binaries per platform (`@napi-rs/cli` + a release matrix; drafted, not run). If the
sync-import WASM ABI lands later, a WASM-backed `Collection` can sit behind the same
TS interface; the public API does not change.

The pure helpers go through WASM anyway, because reader/writer run in browsers.

## Two-writer safety

One host per folder per machine (`docs/contracts/replica-client-api.md` §13). Today
nothing in Rust enforces it for a folder: the daemon holds a per-profile
`daemon.lock`, Obsidian holds a Web Lock inside its own profile. The library adds a
**folder host lock**, and asks daemon and obsidian to honour it (exact deltas below):

- `<root>/.mdbase/host.lock`: an OS advisory lock (`flock` / `LockFileEx`) held for
  as long as a native host (library, daemon) has the folder open.
- `<root>/.mdbase/host.json`: `{ "host": "daemon" | "obsidian" | "library",
  "pid"?, "device"?, "since": <unix ms>, "heartbeat": <unix ms>, "connect"?: { … } }`,
  written by whoever hosts; Obsidian (no `flock` on mobile) refreshes `heartbeat`
  every 15 s while hosting.

The lock is the only exclusion; the descriptor is diagnostics:
heartbeats and Web Locks have races, and absence must never authorise a
takeover. The lock file is a stable inode that is never unlinked or recreated,
root-confined, opened without following symlinks; the descriptor is written
atomically (temp + rename), bounded in size and carries no secrets or selectors.
A native host takes the lock after its eligibility checks and before any root
mutation, and keeps it through drain, stop and join.

`Collection::open` then:

1. takes `host.lock`. If it is held, reads `host.json` and fails with
   `Error::AlreadyHosted { host: Daemon | Library, .. }` whose message says what to do
   ("the mdbase daemon hosts this folder; connect through it with
   `Collection::connect` / `mdbase/node` `connectDaemon()`, or open read-only with
   `OpenOptions::read_only()`");
2. if the lock is free but a `host.json` from another host exists, fails with
   `AlreadyHosted { host: Obsidian, stale: bool }` whether or not its heartbeat is
   fresh (a stale or absent heartbeat is not permission; a paused
   mobile host may still own the folder). `OpenOptions::take_over()` is the explicit
   override, and the shared lease/generation protocol under development
   replaces this rule when it lands;
3. otherwise writes its own `host.json` and opens. `open_read_only()` takes no lock
   and makes **no** write at all: it does not open `FileStore` (whose open creates
   metadata) but scans the folder with the core and answers reads from that
   snapshot.

Routing through the daemon: `mdbase/node` already can, via `@mdbase-dev/sdk`'s
`ipcConnector` (Noise IK over `replica.sock`); a `Collection.connect()` wrapper lands
in the Node package PR. Rust routing needs `mdbn-noise` and an IPC client; it is a
follow-up after the daemon's replica endpoint is live.

**Delta for daemon:** take `.mdbase/host.lock` (shared helper in `mdbase::host_lock`,
or copy; ~60 lines) and write `host.json {host:"daemon"}` when `CollectionHost`
links the replica. **Delta for obsidian:** write/refresh `host.json
{host:"obsidian"}` while holding the Web Lock, delete on `closeHost`. Neither blocks
the library PRs; until they land the library only protects against itself.

Record IDs are per replica (§11.2). A folder opened by the library and later adopted
by the daemon gets new IDs; paths and bytes are unchanged. The library stores its
replica state under `<root>/.mdbase/library/` (SQLite index + journal), never in user
files.

## Shared local-host composition (`crates/local-host`, `mdbn-local-host`)

The library uses one composition of the local stack, shared by the `mdbase` crate
and the daemon's runtime, so internals (query driver, attachments, record caps) move
in one place. The library owns `crates/local-host`; the daemon depends on it through
the `RULES` edge `mdbn-daemon → mdbn-local-host`.

- `LocalStore::open(root, StoreOptions) -> FileStore<NativePlatform, SqlStore<SqliteIndex>, SqlDiskDb<SqliteIndex>>`:
  the one native store construction. The daemon wraps it in its keychain
  middleware (`KeychainKeyring<FileStore<…>>`) and opens a synced replica; the
  library opens a local-only one. Neither strips the other's layers.
- `LocalReplica::open(store, ReplicaOptions { mode, grant_source, sealer, host })`
  and `drive()`/`rescan()`/`next_wakeup()`/`close()`: the local-only drive loop.
  The daemon keeps its own actor/stop-drain loop and calls the same pieces.
- `host_lock::{HostLock, Descriptor}` as above. Portable/constrained defaults;
  the native host selects the desktop profile explicitly.
- `EditorFence` is a slot (`NoFence` for the library); it cannot waive a fence the
  daemon requires.

## Rust API sketch (`mdbase`)

```rust
use mdbase::{Collection, Query, Order, Error};

fn main() -> Result<(), Error> {
    let col = Collection::open("./notes")?;                     // or Collection::init("./notes")?
    // Collection::builder("./notes").read_only().timezone("Australia/Melbourne").open()?

    let task = col.create("tasks/write-docs.md")
        .frontmatter(serde_json::json!({ "type": "task", "status": "open" }))
        .body("Write the docs.\n")
        .commit()?;                                             // Record { path, id, revision, frontmatter, body, type_name, issues }

    let rec = col.get("tasks/write-docs.md")?;                  // Option<Record>
    let page = col.query(
        Query::of_type("task").filter("status == 'open'").order_by("created", Order::Desc).limit(50)
    )?;                                                         // Page { records, cursor, complete }

    col.update(&task.path).set("status", "done").if_revision(&task.revision).commit()?;
    col.rename("tasks/write-docs.md", "tasks/done/write-docs.md")?;
    col.delete("tasks/done/write-docs.md")?;

    let issues = col.validate()?;                               // Vec<Issue>, whole collection
    let issues = col.validate_path("tasks/x.md")?;
    let catalog = col.catalog();                                // &Catalog: types(), type_named(), contracts(), settings(), issues()
    let links = col.links("tasks/x.md")?;                       // Links { outgoing, backlinks }

    col.batch()                                                 // one mutation, one receipt
        .create("a.md").frontmatter(..).done()
        .update("b.md").set("x", 1).done()
        .commit()?;

    col.rescan()?;                                              // pick up outside edits now
    for change in col.changes_since(cursor)? { .. }             // Change { kind, path, id, revision }
    #[cfg(feature = "watch")]
    for change in col.watch()? { .. }                           // blocking iterator over file events → changes

    for hold in col.holds()? { col.resolve_hold(hold.id, Resolution::KeepDisk)?; }
    Ok(())
}
```

- One `Error` enum: `NotACollection { root, help }`, `AlreadyHosted { host, help }`,
  `ReadOnly`, `Rejected(Vec<Issue>)`, `Conflict { path, expected, actual }`,
  `NotFound { path }`, `InvalidPath { path, reason }`, `Query(QueryError)`,
  `Io { path, source }`, `Store(..)`. Every variant's `Display` ends with what to do.
  `Result<T> = Result<T, Error>`.
- Builders where a request has optional parts (`create`, `update`, `query`, `batch`,
  `Collection::builder`); plain methods elsewhere.
- Features: `watch` (adds `notify`), `serde` on by default. No `unsafe`.
- Re-exports: `mdbase::core` (= `mdbn_core`: `Catalog`, `TypeDef`, `Issue`, contracts,
  packs, jsonschema) for the pure helpers natively.

## TS API sketch (`mdbase`)

```ts
import { Collection, MdbaseError } from "mdbase/node";

const col = await Collection.open("./notes");                   // or Collection.init("./notes", { name: "Notes" })
try {
  const task = await col.create({ path: "tasks/write-docs.md", frontmatter: { type: "task", status: "open" }, body: "Write the docs.\n" });
  const rec  = await col.get("tasks/write-docs.md");            // Record | null
  const page = await col.query({ types: ["task"], where: "status == 'open'", orderBy: [["created", "desc"]], limit: 50 });
  await col.update("tasks/write-docs.md", { set: { status: "done" }, ifRevision: task.revision });
  await col.rename("tasks/write-docs.md", "tasks/done/write-docs.md");
  await col.delete("tasks/done/write-docs.md");
  const issues = await col.validate();                          // Issue[]
  const catalog = col.catalog();                                // { types, typeNamed(), contracts, settings, issues }
  const links = await col.links("tasks/x.md");
  await col.batch([{ create: { path: "a.md", frontmatter: {} } }, { update: { path: "b.md", set: { x: 1 } } }]);
  for await (const change of col.changes({ since })) { … }    // AsyncIterable<Change>; col.watch() for live
} catch (e) {
  if (e instanceof MdbaseError && e.code === "already_hosted") console.error(e.help);
} finally {
  await col.close();
}

// Universal helpers (work in the browser too)
import { contractDigest, implementationDigest, compileSchema, loadCatalog, assessTypePack, applyTypePack, validateRecord, parseQuery } from "mdbase";
const digest = contractDigest(frontmatterOfContractFile);      // "sha256:…", resolved wrappers as the registry does
const catalog = loadCatalog({ "mdbase.yaml": cfgText, "_types/task.md": typeText });
const schema = compileSchema(doc, "#"); schema.validate(instance) // Issue[]
```

- Async everywhere on `mdbase/node` (napi runs the engine off the event loop);
  helpers are synchronous (WASM, no I/O).
- Errors: `class MdbaseError extends Error { code: ErrorCode; help: string; details?: unknown }`
  with a string-literal union `ErrorCode`, same names as the Rust variants in snake_case.
- Generated `.d.ts` for the addon (napi) plus hand-written public types; the napi
  surface is internal and not exported.

## Cross-engine digest test

`packages/mdbase/test/digest-parity.test.ts` runs the old engine (`@callumalpass/mdbase`
0.3.0-rc.9, devDependency) and the new helpers on the same inputs and asserts equal
`dataContractDigest`s and pack manifest digests: the vendored spec contract and
fixtures (`conformance/spec/examples/v0.3/**/_contracts/*.md`,
`conformance/spec/tests/v0.3/fixtures/data-contracts/*`), the fixture-expected
digests from `data-contracts.yaml`, and a local corpus of inline-schema contracts of
every contract type. `ref` wrappers are resolved before hashing, as both registries do.
Known, documented divergences (not tested for equality): `+build` metadata in
versions, `collection.display` in implementation digests, assessment digests.

## Compatibility and versions

- Rust crate and npm package share one version line, starting at **0.5.0-rc.1**
  (crates.io `mdbase` is free; the old Rust engine stopped at 0.4.0-rc.4 and the old
  TS engine at 0.3.0-rc.9, so 0.5 is above both).
- Semver on the public API of `mdbase` (Rust) and `mdbase` (npm). crates.io only
  accepts registry dependencies, so publishing `mdbase` also publishes the five
  crates it is composed of (`mdbn-core`, `mdbn-wire`, `mdbn-replica`,
  `mdbn-store-file`, `mdbn-platform-native`) at the same version, with `=`-pinned
  dependencies between them; their APIs are not semver-stable and say so in their
  docs. Every other crate stays `publish = false`. For now,
  the workspace keeps `publish = false` everywhere and the release script
  (`scripts/release/publish.sh`, draft) flips it on the release branch only.
- On-disk state under `.mdbase/library/` is versioned by a `schema` row; a newer
  library migrates it, an older one refuses with `StateNewer { help }`.
- WASM: `mdbase-core.wasm` is embedded in the npm package with its SHA-256 and the
  core's `sem` version; the loader refuses a mismatched build.

## PR plan

1. **G6 helpers** (`crates/mdbase-wasm`, `packages/mdbase` universal entry, parity
   test, CI job). Ship-critical. No other workstream's paths except one `RULES` row,
   one README row and one xtask subcommand. **Done**: 11 Rust tests (spec digest
   fixtures), 21 TS tests (8 cross-engine parity cases over the spec corpus and a
   local corpus of record/event/action contracts). `mdbase-core.wasm` is 1.02 MB
   raw / 444 KB gzip.
2. **Rust facade** (`crates/mdbase`): open/init, host lock, CRUD, query, validate,
   catalog, links, batch, changes, holds; examples; clean-install test.
3. **Node engine** (`crates/mdbase-node`, `mdbase/node`): napi addon, TS wrapper,
   `connectDaemon`, examples, clean-install test.
4. **Packaging prep**: versions, licences, release workflow drafts (no publish).
