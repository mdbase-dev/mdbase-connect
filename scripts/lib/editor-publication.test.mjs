import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backendFacingInputs, verifyEditorBuildInputs, verifyEditorSource, main } from "../verify-editor-publication.mjs";
import { readProductionRelease, verifyProductionReadiness } from "../verify-client-publication.mjs";

const sha = "a".repeat(40);
const source = { event: "workflow_dispatch", ref: "refs/heads/main", repository: "mdbase-dev/mdbase-connect", sha, head: sha };
test("independent Editor source is an exact main dispatch, never a PR, tag or supplied backend override", () => {
  verifyEditorSource(source);
  for (const change of [
    { event: "push" }, { event: "pull_request" }, { ref: "refs/heads/feature" },
    { ref: "refs/tags/v0.1.0-beta.99" }, { sha: "short" }, { sha: undefined },
    { head: "b".repeat(40) }, { repository: "other/repository" },
    { verifiedCommit: sha }
  ]) assert.throws(() => verifyEditorSource({ ...source, ...change }));
});

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), "editor-publication-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Publication test"]);
  git(["config", "user.email", "test@example.invalid"]);
  const write = (path, text) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const commit = () => { git(["add", "."]); git(["commit", "-m", "test"]); return git(["rev-parse", "HEAD"]); };
  write("apps/editor/src/App.tsx", "initial UI");
  write("packages/client/src/client.ts", "released SDK");
  const backend = commit();
  return { root, git, write, commit, backend };
}

test("a distinct Editor commit can reuse released inputs without a new backend release", (t) => {
  const r = repository(t);
  r.write("apps/editor/src/App.tsx", "new UI");
  r.write("packages/ui/src/style.css", "new shared presentation");
  const editor = r.commit();
  assert.notEqual(editor, r.backend);
  verifyEditorBuildInputs(r.backend, editor, r.git);
  verifyEditorBuildInputs(r.backend, r.backend, r.git);
});

test("actual Git diffs reject changed SDK, protocol, management, dependencies, build and manifest inputs", async (t) => {
  const files = [
    "packages/client/new.ts", "packages/protocol/new.ts", "packages/management/new.ts",
    "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", "tsconfig.base.json", ".env.production",
    "apps/editor/package.json", "apps/editor/vite.config.ts", "apps/editor/tsconfig.json", "apps/editor/tsconfig.extra.json", "apps/editor/.env.production",
    "apps/editor/scripts/write-manifest.mjs", "apps/editor/public/.well-known/mdbase-app.json"
  ];
  for (const file of files) await t.test(file, (t) => {
    const r = repository(t);
    r.write(file, "changed input");
    assert.throws(() => verifyEditorBuildInputs(r.backend, r.commit(), r.git), /coordinated tagged release/);
  });
});

test("renaming an SDK input outside the protected tree does not hide its deletion", (t) => {
  const r = repository(t);
  r.git(["mv", "packages/client/src/client.ts", "apps/editor/src/moved.ts"]);
  assert.throws(() => verifyEditorBuildInputs(r.backend, r.commit(), r.git), /coordinated tagged release/);
});

test("older, divergent, missing and malformed release commits fail closed", (t) => {
  const r = repository(t);
  r.write("apps/editor/src/App.tsx", "new UI");
  const next = r.commit();
  assert.throws(() => verifyEditorBuildInputs(next, r.backend, r.git));
  assert.throws(() => verifyEditorBuildInputs("b".repeat(40), next, r.git));
  assert.throws(() => verifyEditorBuildInputs("--help", next, r.git));
  r.git(["checkout", "--detach", r.backend]);
  r.write("apps/editor/src/App.tsx", "divergent UI");
  assert.throws(() => verifyEditorBuildInputs(next, r.commit(), r.git));
});

test("production observation identifies the backend, while coordinated publication still requires exact identity", async () => {
  const version = "0.1.0-beta.99";
  const values = [
    { ok: true, service: "mdbase-connect", revision: sha, environment: "production", public_origin: "https://connect.mdbase.dev", protocol_version: 1, capabilities: ["application-authorization-v2-issuance"] },
    { ok: true, service: "mdbase-connect" },
    { status: "ready", provider: { version, capabilities: ["application-authorization-v2-issuance"] }, notifications: { recovery: "ok", consecutive_failures: 0 } },
    { ok: true, service: "mdbase-mcp", revision: sha }
  ];
  const fetch = () => { let i = 0; return async () => ({ ok: true, json: async () => values[i++] }); };
  assert.deepEqual(await readProductionRelease(fetch()), { sha, version });
  await assert.rejects(verifyProductionReadiness("b".repeat(40), version, fetch()));
  await assert.rejects(verifyProductionReadiness(sha, "0.1.0-beta.98", fetch()));
});

test("executable guard checks the real source tree and remote tag before permitting independent publication", async (t) => {
  const r = repository(t);
  r.write("apps/editor/src/App.tsx", "independent UI change");
  const editor = r.commit();
  r.git(["update-ref", "refs/remotes/origin/main", editor]);
  const bin = mkdtempSync(join(tmpdir(), "editor-publication-tools-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const tagSha = "c".repeat(40);
  const version = "0.1.0-beta.99";
  const gh = join(bin, "gh");
  writeFileSync(gh, `#!/usr/bin/env node
const path = process.argv[3];
const records = ${JSON.stringify({
    [`repos/mdbase-dev/mdbase-connect/git/ref/tags/v${version}`]: { ref: `refs/tags/v${version}`, object: { type: "tag", sha: tagSha } },
    [`repos/mdbase-dev/mdbase-connect/git/tags/${tagSha}`]: { tag: `v${version}`, object: { type: "commit", sha: r.backend } }
  })};
if (process.argv[2] !== 'api' || !records[path]) process.exit(1);
console.log(JSON.stringify(records[path]));
`);
  chmodSync(gh, 0o700);
  const values = [
    { ok: true, service: "mdbase-connect", revision: r.backend, environment: "production", public_origin: "https://connect.mdbase.dev", protocol_version: 1, capabilities: ["application-authorization-v2-issuance"] },
    { ok: true, service: "mdbase-connect" },
    { status: "ready", provider: { version, capabilities: ["application-authorization-v2-issuance"] }, notifications: { recovery: "ok", consecutive_failures: 0 } },
    { ok: true, service: "mdbase-mcp", revision: r.backend }
  ];
  const env = { GITHUB_SHA: editor, GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: source.repository };
  const before = { cwd: process.cwd(), path: process.env.PATH, fetch: globalThis.fetch, log: console.log };
  let requests = 0;
  try {
    process.chdir(r.root);
    process.env.PATH = `${bin}:${before.path}`;
    globalThis.fetch = async () => ({ ok: true, json: async () => values[requests++ % 4] });
    console.log = () => {};
    await main(env);
    assert.equal(requests, 4);
    r.write("apps/editor/src/App.tsx", "dirty source");
    await assert.rejects(main(env), /unchanged tracked source/);
    assert.equal(requests, 4);
    r.git(["restore", "apps/editor/src/App.tsx"]);
    r.git(["update-ref", "refs/remotes/origin/main", r.backend]);
    await assert.rejects(main(env));
    assert.equal(requests, 4);
    r.git(["update-ref", "refs/remotes/origin/main", editor]);
    writeFileSync(gh, '#!/usr/bin/env node\nconsole.log("{}")\n');
    await assert.rejects(main(env), /annotated release tag/);
  } finally {
    process.chdir(before.cwd);
    process.env.PATH = before.path;
    globalThis.fetch = before.fetch;
    console.log = before.log;
  }
});

test("guard orchestration binds main ancestry, clean source and the live annotated backend tag", () => {
  const script = readFileSync(new URL("../verify-editor-publication.mjs", import.meta.url), "utf8");
  assert.match(script, /"merge-base", "--is-ancestor", sha, "origin\/main"/);
  assert.match(script, /"status", "--porcelain", "--untracked-files=no"/);
  assert.match(script, /verifyRemotePublicationTag\(\{ \.\.\.release, ref:/);
  assert.match(script, /verifyEditorBuildInputs\(release.sha, sha\)/);
  assert.ok(script.indexOf("verifyEditorSource({", script.indexOf("export async function main")) < script.indexOf("const release = await readProductionRelease()"));
  assert.ok(backendFacingInputs.includes("packages/client"));
});
