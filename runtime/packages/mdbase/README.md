# mdbase

Universal WebAssembly helpers for mdbase: contract digests, JSON Schema
validation, catalog loading, record validation, query checking and type packs.
Pure functions over strings and JSON, with no runtime dependencies.

Version 0.5.0 ships these helpers only. They run the same Rust core as the mdbase
daemon, CLI and Obsidian plugin, through `wasm/mdbase-core.wasm` included in this
package. Use them in browsers, workers or Node ≥ 20; they do not open collections
or read and write your records. This replaces standalone helper use of
`@callumalpass/mdbase`.

## Quickstart

```sh
npm install mdbase
```

```ts
import { contractDigest, loadCatalog, validateRecord } from "mdbase";

const contract = await contractDigest({
  frontmatter: {
    kind: "mdbase.contract",
    contract_type: "record",
    id: "example.note",
    version: "1.0.0",
    record_schema: {
      dialect: "json-schema-2020-12",
      value: { type: "object", required: ["title"], properties: { title: { type: "string" } } },
    },
  },
});
console.log(contract.digest);

const resources = {
  "mdbase.yaml": 'spec_version: "0.3.0"\n',
  "_types/note.md": `---
kind: mdbase.type
name: note
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [title]
    properties:
      title: {type: string}
---
`,
};
const catalog = await loadCatalog(resources);
console.log(catalog.valid, catalog.types.map((type) => type.name));

const result = await validateRecord({
  resources,
  path: "notes/hello.md",
  source: "---\ntype: note\ntitle: Hello\n---\nA Markdown note.\n",
});
console.log(result.types, result.issues);
```

Every function is `async` (the engine loads on first use) and throws
`MdbaseError` with a stable `code`, a `message` and a `help` line:

```ts
import { contractDigest, MdbaseError } from "mdbase";
try {
  await contractDigest("---\nkind: not-a-contract\n---\n");
} catch (e) {
  if (e instanceof MdbaseError && e.code === "invalid_data_contract") console.error(e.message, e.help);
}
```

## Loading the WebAssembly module

By default the helpers load `wasm/mdbase-core.wasm` from this package with
`new URL("../wasm/mdbase-core.wasm", import.meta.url)`: Node reads it from disk,
browsers fetch it. Bundlers may relocate JavaScript, so explicitly include the
exported WASM asset. For example, with Vite:

```ts
import { init } from "mdbase";
import wasmUrl from "mdbase/wasm/mdbase-core.wasm?url";

await init({ wasm: fetch(wasmUrl) });
```

Alternatively, copy `wasm/mdbase-core.wasm` to your static assets and pass its
URL or response to `init`. Node callers can supply bytes:

```ts
import { readFile } from "node:fs/promises";
import { init } from "mdbase";

await init({ wasm: await readFile(new URL(import.meta.resolve("mdbase/wasm/mdbase-core.wasm"))) });
```

`init` also accepts a `WebAssembly.Module`, a URL or a byte array. The WASM module
has no imports: core helpers never read a clock, entropy or the file system.

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
  write instead of writing them, so you decide how. First call `assessTypePack`
  with `{pack: {manifest, sources}, resources, options}`; when `applicable` is
  true, pass the same inputs and `expectedDigest: assessment.assessment_digest`
  to `applyTypePack`. Synced consumers submit the returned `ops` together as **one atomic
  mutation** through their existing held SDK client. These are the core's
  original ordered `resource_put`/`resource_delete` operations, including
  `baseRevision` and `mustNotExist` guards and the lock update. Do not reconstruct
  operations from `writes`/`deletes`: a snapshot diff loses the guards (and
  unchanged effects). A current pack returns an empty `ops` list. A stale
  assessment fails with `concurrent_modification`; explicitly re-assess rather
  than dropping guards or overwriting. Assessment/diff output is not a receipt
  or proof that any remote mutation was confirmed.

## Compatibility

- The npm helper API starts at 0.5.0; Rust workspace versions are independent.
- Use the `mdbase-core.wasm` shipped with this package. The loader refuses a
  module with an incompatible ABI (`wasm_incompatible`).
- Supported spec version: 0.3.0.

## Development

```sh
cd runtime
npm ci --prefix tools/wasm
cargo xtask mdbase-wasm
cd packages/mdbase
npm ci
npm run typecheck
npm test -- test/helpers.test.ts test/digest-parity.test.ts
npm run build
node scripts/clean-install.mjs
```

The Rust side is `runtime/crates/mdbase-wasm`, the JSON ABI over
`runtime/crates/core`. Maintainer architecture and planned library work are
documented in [the repository](https://github.com/mdbase-dev/mdbase-connect/blob/main/runtime/docs/library/README.md).
