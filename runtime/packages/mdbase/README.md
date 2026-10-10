# mdbase

The mdbase engine for JavaScript. One package, two entry points:

| Import | What | Runs where |
|---|---|---|
| `mdbase` | **Universal helpers**: contract digests, JSON Schema validation, catalog (config, types, contracts) loading, record validation, query checking, type packs. Pure functions over strings and JSON. | Browsers, workers, Node ≥ 20, Deno, Bun |
| `mdbase/node` | **Collections on disk**: `Collection.open`, typed CRUD, queries, validation, links, changes. | Node ≥ 20 |

Both are the same Rust engine that powers the mdbase daemon, the CLI and the
Obsidian plugin (`crates/core` in [mdbase-connect](https://github.com/mdbase-dev/mdbase-connect)),
so digests, validation and query semantics are identical everywhere. The
helpers run it as WebAssembly (`mdbase-core.wasm`, shipped in this package).

## Quickstart

```sh
npm install mdbase
```

```ts
import { contractDigest, loadCatalog, validateRecord, assessTypePack, applyTypePack } from "mdbase";

// Stable digests (spec 05A), byte-identical to the Rust engine.
const contract = await contractDigest(await fs.readFile("_contracts/tasknotes.task.md", "utf8"));
contract.digest; // "sha256:a49d2513…"

// The catalog: mdbase.yaml + _types/* + _contracts/*, keyed by resource path.
const catalog = await loadCatalog({
  "mdbase.yaml": await fs.readFile("mdbase.yaml", "utf8"),
  "_types/task.md": await fs.readFile("_types/task.md", "utf8"),
});
catalog.types.map((t) => t.name); // ["task"]

// Validate one record.
const { issues } = await validateRecord({ resources, path: "tasks/a.md", source });

// Install a type pack in two steps: assess (read-only), then apply with the assessment digest.
const a = await assessTypePack({ pack: { manifest, sources }, resources, options: { installed_by: "dev.example.app" } });
if (a.applicable) {
  const r = await applyTypePack({ pack: { manifest, sources }, resources, options, expectedDigest: a.assessment_digest });
  for (const w of r.writes) await fs.writeFile(w.path, w.document); // includes mdbase.lock.yaml
}
```

Every function is `async` (the engine loads on first use) and throws
`MdbaseError` with a stable `code`, a `message` and a `help` line:

```ts
import { MdbaseError } from "mdbase";
try {
  await contractDigest(text);
} catch (e) {
  if (e instanceof MdbaseError && e.code === "invalid_data_contract") console.error(e.message, e.help);
}
```

## Collections on Node

```ts
import { Collection } from "mdbase/node";

const col = await Collection.open("./notes");                 // or Collection.init("./notes", { name: "Notes" })

const task = await col.create({
  path: "tasks/write-docs.md",
  frontmatter: { type: "task", status: "open" },
  body: "Write the docs.\n",
});
const open = await col.query({ types: ["task"], where: "status == 'open'", order_by: [{ field: "created", direction: "desc" }], limit: 50 });

await col.update(task, { set: { status: "done" }, ifRevision: task.revision });   // optimistic concurrency
await col.rename("tasks/write-docs.md", "tasks/done/write-docs.md");
await col.delete("tasks/done/write-docs.md");

await col.batch([                                              // one atomic mutation
  { op: "create", path: "a.md", frontmatter: { title: "A" } },
  { op: "update", target: "b.md", set: { done: true } },
]);

for (const { path, issues } of await col.validate()) console.log(path, issues);
const { outgoing, backlinks } = await col.links("tasks/x.md");
const since = await col.changes();                            // a cursor; pass it back later
await col.rescan();                                           // pick up edits other programs made
await col.close();
```

`mdbase/node` runs the same Rust engine as the Rust crate and the daemon, in a
native addon on a thread per collection; every method is `async` and never
blocks the event loop. Files stay plain Markdown; the engine keeps its index
under `<root>/.mdbase/library/`. One process hosts a folder at a time: if the
mdbase daemon, Obsidian or another process has it, `open` throws
`MdbaseError` with `code: "already_hosted"` and `details.host`.

Prebuilt addons ship for Linux x64/arm64 (glibc), macOS x64/arm64 and Windows
x64. Elsewhere, build it with `cargo build --profile node-release -p mdbase-node`
and set `MDBASE_NATIVE` to the library's path.

Talking to a running daemon instead (apps that share a folder with it) goes
through `@mdbase-dev/sdk`'s `ipcConnector`; a `connectDaemon()` shortcut lands
once that package is published.

## Loading the WebAssembly module

By default the helpers load `wasm/mdbase-core.wasm` from this package with
`new URL("../wasm/mdbase-core.wasm", import.meta.url)`: Node reads it from disk,
browsers fetch it, and bundlers that understand that pattern (Vite, esbuild,
webpack 5) ship it as an asset. If yours does not, or you want to control
loading, call `init` once:

```ts
import { init } from "mdbase";
await init({ wasm: fetch("/static/mdbase-core.wasm") });        // a Response
await init({ wasm: await readFile("mdbase-core.wasm") });        // bytes
await init({ wasm: new URL("https://cdn.example/mdbase-core.wasm") });
```

The module is about 1.0 MB raw / 0.45 MB gzip. It has no imports: the helpers
never read a clock, entropy or the file system.

## API

| Function | Returns | Old `@callumalpass/mdbase` equivalent |
|---|---|---|
| `contractDigest(text \| {source, path?, resources?} \| {frontmatter, …})` | `Contract` with `digest` | `dataContractDigest` (+ the registry's `ref` resolution) |
| `implementationDigest({contract, type, resources?})` | `Implementation` with `digest`, `contract_digest` | `DataContractRegistry` (implementation digests) |
| `loadCatalog(resources)` | `Catalog` (`valid`, `settings`, `types`, `contracts`, `implementations`, `issues`) | `loadConfig` + `loadTypes` + `DataContractRegistry.load` |
| `getType(resources, name)` | `TypeDefinition \| undefined` | `getType` |
| `validateRecord({resources, path, source})` | `{issues, types}` | `validateJsonSchemaFrontmatter` and friends |
| `validateSchema({schema, entry?, instance})` | `{valid, issues}` | Ajv |
| `checkQuery(query, resources?)` | `{valid, types}` or throws `invalid_query` | `validateCanonicalQueryInput` |
| `loadPack({manifest, sources})` | `Pack` | — |
| `parseLock(text)` | `Lock` | — |
| `assessTypePack({pack, resources, options})` | `Assessment` | `assessTypePack` |
| `applyTypePack({pack, resources, options, expectedDigest})` | `{assessment, ops, writes, deletes}` | `applyTypePack` (which wrote files itself) |
| `info()` | engine ABI, version, semantics version, supported spec versions | — |

Result shapes use the spec's snake_case member names and match the Rust crate.
`resources` is always `{ [resourcePath]: fileText }` with paths relative to the
collection root (`mdbase.yaml`, `_types/task.md`).

### Differences from `@callumalpass/mdbase`

- `contractDigest` resolves `ref` wrappers (you pass the referenced files in
  `resources`); the old standalone function hashed unresolved wrappers unless
  the registry had resolved them first.
- Versions with `+build` metadata are digested without it (spec 05A); the old
  engine hashed the raw string.
- Implementation digests omit `collection.display` (spec 05A); the old engine
  included it.
- `settings.validation` defaults to `error` (spec 04); the old engine defaulted
  to `warn`. Only spec `0.3.0` is accepted.
- The helpers never touch the file system. `applyTypePack` returns the files to
  write instead of writing them, so you decide how (and `mdbase/node` does it
  for you). Synced consumers submit the returned `ops` together as **one atomic
  mutation** through their existing held SDK client. These are the core's
  original ordered `resource_put`/`resource_delete` operations, including
  `baseRevision` and `mustNotExist` guards and the lock update. Do not reconstruct
  operations from `writes`/`deletes`: a snapshot diff loses the guards (and
  unchanged effects). A current pack returns an empty `ops` list. A stale
  assessment fails with `concurrent_modification`; explicitly re-assess rather
  than dropping guards or overwriting. Assessment/diff output is not a receipt
  or proof that any remote mutation was confirmed.

## Compatibility

- This package and the `mdbase` Rust crate share one version line. The public
  API of both follows semver from 0.5.0.
- `mdbase-core.wasm` is matched to the package version; the loader refuses a
  module with another ABI major (`wasm_incompatible`).
- Supported spec version: 0.3.0.

## Development

```sh
cargo xtask mdbase-wasm      # build wasm/mdbase-core.wasm (needs `npm ci --prefix tools/wasm`)
npm run build:native         # build native/mdbase.<platform>.node (cargo, node-release profile)
npm ci && npm test           # helpers, spec digests, digest parity with @callumalpass/mdbase, the Node collection
node scripts/clean-install.mjs   # pack and consume from a fresh npm project
```

The Rust side is `crates/mdbase-wasm` (the JSON ABI over `crates/core`) and
`crates/mdbase-node` (napi-rs over `crates/mdbase`).
