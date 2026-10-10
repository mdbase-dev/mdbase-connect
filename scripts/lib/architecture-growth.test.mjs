import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { architectureBase, checkArchitectureGrowth, compareGrowth, declarations } from "./architecture-growth.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "connect-growth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = async (file, content) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  };
  git("init", "--initial-branch=main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await write("config/architecture-budgets.json", JSON.stringify({
    productionFileMaxLines: 3, productionFileBudgetsByPackage: { "packages/example": 1 },
    reviewBudgets: { productionFiles: 1, relativeImports: 0, workspacePackages: 1, rustPublicDeclarations: 0, typeScriptExportDeclarations: 1, mdbaseCollectionReferences: 0, typedCollectionReferences: 0 }
  }));
  await write("packages/example/package.json", '{"name":"example"}');
  await write("packages/example/src/a.ts", "export const a = 1;\n");
  await write("architecture.d/previous.json", JSON.stringify({ reason: "Previously approved growth cannot be reused.", growth: { typeScriptExportDeclarations: 100 } }));
  git("add", "."); git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  return { root, git, write, base };
}

test("archives over 64 MiB stream without weakening growth enforcement", async (t) => {
  const { root, git, write } = await fixture(t);
  await write("runtime/archive-padding.bin", Buffer.alloc(65 * 1024 * 1024));
  git("add", "."); git("commit", "-m", "large source archive");
  const base = git("rev-parse", "HEAD");
  assert.deepEqual((await checkArchitectureGrowth(root, base)).failures, []);
  await write("packages/example/src/a.ts", "export const a = 1; export const b = 2;\n");
  const result = await checkArchitectureGrowth(root, base);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /typeScriptExportDeclarations grew by 1.*declared allowance is 0/);
});

test("growth fails despite absolute headroom and cannot spend inherited declarations", async (t) => {
  const { root, write, base } = await fixture(t);
  await write("packages/example/src/a.ts", "export const a = 1; export const b = 2;\n");
  const result = await checkArchitectureGrowth(root, base);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /typeScriptExportDeclarations grew by 1.*declared allowance is 0/);
});

test("merge-group declarations add, use actual merge-base, and still enforce hard gates", async (t) => {
  const { root, git, write, base } = await fixture(t);
  git("checkout", "-b", "base-side");
  await write("packages/example/src/a.ts", "export const a = 1; export const unrelated = 2;\n");
  git("add", "."); git("commit", "-m", "unrelated base growth");
  const baseSide = git("rev-parse", "HEAD");
  git("checkout", "-b", "queue", base);
  await write("packages/example/src/a.ts", "export const a = 1; export const b = 2; export const c = 3;\n");
  for (const name of ["pr-one", "pr-two"]) await write(`architecture.d/${name}.json`, JSON.stringify({ reason: "A separate typed entry point is required for the consumer.", growth: { typeScriptExportDeclarations: 1 } }));
  git("add", "."); git("commit", "-m", "two queued changes");
  assert.deepEqual((await checkArchitectureGrowth(root, baseSide)).failures, []);
  await write("packages/example/src/a.ts", "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n// over limit\n");
  assert.ok((await checkArchitectureGrowth(root, baseSide)).failures.some((failure) => failure.includes("4 lines")));
});

test("existing declarations are immutable and malformed new files fail explicitly", async (t) => {
  const { root, write, base } = await fixture(t);
  await write("architecture.d/previous.json", JSON.stringify({ reason: "Changing an inherited allowance is not permitted.", growth: { typeScriptExportDeclarations: 200 } }));
  assert.ok((await checkArchitectureGrowth(root, base)).failures.some((failure) => failure.includes("immutable")));
  await write("architecture.d/new.json", JSON.stringify({ reason: "too short", growth: { productionFiles: 1 } }));
  await assert.rejects(declarations(root), /substantive justification/);
  await write("architecture.d/new.json", JSON.stringify({ reason: "A specific reviewed reason with sufficient detail.", growth: { productionFiles: -1 } }));
  await assert.rejects(declarations(root), /positive integer/);
  assert.equal(JSON.parse(await readFile(path.join(root, "architecture.d/previous.json"))).growth.typeScriptExportDeclarations, 200);
});

test("per-package counters prevent moving unreviewed growth across packages", () => {
  const base = { productionFiles: 2, "packages/a": 1, "packages/b": 1 };
  const head = { productionFiles: 2, "packages/a": 0, "packages/b": 2 };
  assert.match(compareGrowth(base, head, [])[0], /packages\/b grew by 1/);
  assert.deepEqual(compareGrowth(base, head, [{ name: "move.json", growth: { "packages/b": 1 } }]), []);
  assert.match(compareGrowth(base, head, [{ name: "bad.json", growth: { unknown: 1 } }])[0], /unknown architecture counter/);
});

test("CI requires an exact event base rather than silently disabling the gate", () => {
  assert.equal(architectureBase("unused", { GITHUB_ACTIONS: "true", ARCHITECTURE_BASE: "abc" }), "abc");
  assert.throws(() => architectureBase("unused", { GITHUB_ACTIONS: "true" }), /must set ARCHITECTURE_BASE/);
});
