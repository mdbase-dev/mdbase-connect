import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateArchitecture } from "./architecture-check.mjs";

async function fixture(t, files) {
  const root = await mkdtemp(path.join(tmpdir(), "mdbase-connect-architecture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relative, source] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  return root;
}

test("accepts acyclic feature modules", async (t) => {
  const root = await fixture(t, {
    "packages/example/package.json": JSON.stringify({ name: "@mdbase/example" }),
    "packages/example/src/a.ts": "import { b } from './b.js';\nexport const a = b;\n",
    "packages/example/src/b.ts": "export const b = 1;\n"
  });

  assert.deepEqual(await evaluateArchitecture(root), []);
});

test("guards typed local runtime outcomes from OperationResult and record-pointer regressions", async (t) => {
  const root = await fixture(t, {
    "crates/connect-core/src/registry/runtime_operations.rs": [
      "fn adapter(value: &Typed) { value.to_v03(); }",
      "fn regression(value: &Value) { let _ = value.pointer(\"/result/frontmatter\"); }",
      "fn nested(value: &Execution) { let _ = value.result.result; }"
    ].join("\n"),
    "crates/connect-core/src/registry/runtime_executor.rs": "fn executor() {}\n"
  });

  const failures = await evaluateArchitecture(root);

  assert.ok(failures.some((failure) => failure.includes("record JSON-pointer inspection")));
  assert.ok(failures.some((failure) => failure.includes("deprecated nested OperationResult access")));
});

test("rejects relative source cycles including JavaScript extension mapping", async (t) => {
  const root = await fixture(t, {
    "services/example/src/a.ts": "export { b } from './b.js';\n",
    "services/example/src/b.ts": "import { a } from './a.js';\nexport const b = a;\n"
  });

  assert.deepEqual(await evaluateArchitecture(root), [
    "Relative import cycle: services/example/src/a.ts -> services/example/src/b.ts -> services/example/src/a.ts"
  ]);
});

test("ignores relative cycles that only test files close", async (t) => {
  const root = await fixture(t, {
    "services/example/src/a.ts": "export const a = 1;\n",
    "services/example/src/a.test.ts": "import { a } from './a.js';\n"
  });

  assert.deepEqual(await evaluateArchitecture(root), []);
});

test("rejects cycles between workspace packages", async (t) => {
  const root = await fixture(t, {
    "packages/a/package.json": JSON.stringify({ name: "@mdbase/a", dependencies: { "@mdbase/b": "workspace:*" } }),
    "packages/b/package.json": JSON.stringify({ name: "@mdbase/b", dependencies: { "@mdbase/a": "workspace:*" } })
  });

  assert.deepEqual(await evaluateArchitecture(root), [
    "Workspace package cycle: @mdbase/a -> @mdbase/b -> @mdbase/a"
  ]);
});

test("rejects direct canonical outcome construction and field access in production Rust", async (t) => {
  const root = await fixture(t, {
    "crates/example/src/lib.rs": [
      "fn wire() { let _ = CanonicalOperationValue::WireOnly(x); }",
      "fn literal() { let _ = CanonicalOperationOutcome { valid: true }; }",
      "fn field(operation: &Outcome) { let _ = operation.diagnostics; }"
    ].join("\n"),
    "crates/example/src/lib_tests.rs": "fn fixture() { let _ = CanonicalOperationValue::WireOnly(x); }\n"
  });

  assert.equal((await evaluateArchitecture(root)).length, 3);
});

test("guards the mdbase manifest boundary and compile-time projection version assertion", async (t) => {
  const providerGuard = [
    "const CONNECT_SEMANTIC_PROJECTION_FORMAT_VERSION: u32 = 6;",
    "const _: () = assert!(mdbase::runtime::SEMANTIC_PROJECTION_FORMAT_VERSION == CONNECT_SEMANTIC_PROJECTION_FORMAT_VERSION);"
  ].join("\n");
  const root = await fixture(t, {
    "Cargo.toml": "[workspace.dependencies]\nmdbase = { path = '../mdbase-rs', default-features = false }\n",
    "crates/connect-hosted-provider/Cargo.toml": "[package]\nname = 'provider'\nversion = '0.0.0'\n",
    "crates/connect-hosted-provider/src/provider.rs": providerGuard
  });

  assert.deepEqual(await evaluateArchitecture(root), []);

  await writeFile(
    path.join(root, "Cargo.toml"),
    "[workspace.dependencies]\nmdbase = { path = '../mdbase-rs', features = ['legacy-collection-mutation'] }\n"
  );
  await writeFile(path.join(root, "crates/connect-hosted-provider/src/provider.rs"), "const VERSION: u32 = 6;\n");
  assert.deepEqual(await evaluateArchitecture(root), [
    "Cargo.toml enables the legacy-collection-mutation feature.",
    "Cargo.toml mdbase dependency must set default-features = false.",
    "hosted provider must compile-assert the upstream semantic projection format."
  ]);
});
