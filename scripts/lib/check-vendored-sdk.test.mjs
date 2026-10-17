import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkWorkspace, sameNameCollisions } from "../check-vendored-sdk.mjs";

// Two vendored builds with the same name and version, as the MCP service and
// app-ui carry; only their contents tell them apart.
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "vendored-sdk-test-"));
  const tarball = (label) => {
    const staging = path.join(dir, `staging-${label}`, "package");
    mkdirSync(path.join(staging, "dist"), { recursive: true });
    mkdirSync(path.join(staging, "node_modules", "dep"), { recursive: true });
    writeFileSync(path.join(staging, "package.json"), JSON.stringify({ name: "@scope/sdk", version: "0.0.0" }));
    writeFileSync(path.join(staging, "dist", "index.js"), `export const build = ${JSON.stringify(label)};\n`);
    writeFileSync(path.join(staging, "node_modules", "dep", "index.js"), "// bundled dependency\n");
    const file = path.join(dir, `sdk-${label}.tgz`);
    execFileSync("tar", ["-czf", file, "-C", path.dirname(staging), "package"]);
    return { file, staging };
  };
  const a = tarball("a"), b = tarball("b");
  const workspace = (name, built) => {
    const ws = path.join(dir, name);
    mkdirSync(path.join(ws, "vendor"), { recursive: true });
    cpSync(built.file, path.join(ws, "vendor", "sdk.tgz"));
    writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name, dependencies: { "@scope/sdk": "file:vendor/sdk.tgz" } }));
    return ws;
  };
  const install = (where, built) => cpSync(built.staging, path.join(where, "node_modules", "@scope", "sdk"), { recursive: true });
  return { dir, a, b, mcp: workspace("mcp", a), ui: workspace("ui", b), install };
}

test("accepts a workspace that resolves its own vendored tarball", () => {
  const f = fixture();
  try {
    f.install(f.dir, f.b);
    f.install(f.mcp, f.a);
    assert.deepEqual(checkWorkspace(f.mcp), { checked: 1, failures: [] });
    assert.deepEqual(checkWorkspace(f.ui), { checked: 1, failures: [] });
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("rejects a workspace that resolves another workspace's hoisted copy", () => {
  const f = fixture();
  try {
    f.install(f.dir, f.b);
    const result = checkWorkspace(f.mcp);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /not this tarball .*differs dist\/index\.js/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("rejects a workspace whose vendored dependency is not installed", () => {
  const f = fixture();
  try {
    assert.match(checkWorkspace(f.mcp).failures[0], /not installed/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("refuses two different tarballs with one name and version", () => {
  const f = fixture();
  try {
    const [collision] = sameNameCollisions([f.mcp, f.ui]);
    assert.match(collision, /@scope\/sdk@0\.0\.0 is vendored as 2 different tarballs/);
    cpSync(f.a.file, path.join(f.ui, "vendor", "sdk.tgz"));
    assert.deepEqual(sameNameCollisions([f.mcp, f.ui]), []);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
