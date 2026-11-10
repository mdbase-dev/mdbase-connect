import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkoutPublicationSource, requireRuntimeCi, baselineHistory, contentChanged, dependentPackages, failedPublisherRuns, inputChanged, packageInputs, publicationBaseline, publicationState, provenanceSource, qualifyWorkspace } from "../continuous-sdk-release.mjs";
import { publicPackages } from "../public-packages.mjs";

const name = "@mdbase-dev/sdk";
const commit = "a".repeat(40);
const version = "0.1.0-beta.149";
const integrity = `sha512-${Buffer.from("b".repeat(128), "hex").toString("base64")}`;
const metadata = () => ({ name, "dist-tags": { next: "0.1.0-beta.9" }, versions: {
  "0.1.0-beta.9": { name, version: "0.1.0-beta.9", dist: { integrity } },
  [version]: { name, version, dist: { integrity } }
} });
const baseline = () => publicationBaseline(metadata(), { name }, "publish-sdk-npm.yml");
const statement = () => ({ predicateType: "https://slsa.dev/provenance/v1",
  subject: [{ name: `pkg:npm/%40mdbase-dev/sdk@${version}`, digest: { sha512: "b".repeat(128) } }],
  predicate: { buildDefinition: { externalParameters: { workflow: {
    repository: "https://github.com/mdbase-dev/mdbase-connect", path: ".github/workflows/publish-sdk-npm.yml", ref: `refs/tags/v${version}`
  } }, resolvedDependencies: [{ uri: `git+https://github.com/mdbase-dev/mdbase-connect@refs/tags/v${version}`, digest: { gitCommit: commit } }] } } });
const bundle = value => ({ dsseEnvelope: { payload: Buffer.from(JSON.stringify(value)).toString("base64") } });

test("package baselines use the highest immutable version, not dist-tag or package order", () => {
  assert.equal(baseline().version, version);
  assert.throws(() => publicationBaseline({ ...metadata(), name: "@other/sdk" }, { name }, "publish-sdk-npm.yml"));
  assert.throws(() => publicationBaseline({ name, versions: {} }, { name }, "publish-sdk-npm.yml"), /Bootstrap/);
  const stable = metadata();
  stable.versions["0.1.0"] = {};
  assert.throws(() => publicationBaseline(stable, { name }, "publish-sdk-npm.yml"), /release-owner review/);
});

test("provenance binds package SRI, repository, workflow, ref and full source identity", () => {
  assert.equal(provenanceSource(bundle(statement()), baseline(), name).commit, commit);
  for (const mutate of [
    value => { value.subject[0].digest.sha512 = "c".repeat(128); },
    value => { value.subject[0].name = "pkg:npm/%40other/sdk@1.0.0"; },
    value => { value.predicate.buildDefinition.externalParameters.workflow.repository = "https://github.com/other/repo"; },
    value => { value.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/other.yml"; },
    value => { value.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/unreviewed"; },
    value => { value.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "main"; }
  ]) {
    const value = statement();
    mutate(value);
    assert.throws(() => provenanceSource(bundle(value), baseline(), name));
  }
});

test("version-only prep and tests do not republish; shipped source and dependency changes do", () => {
  assert.equal(contentChanged("packages/client/src/index.test.ts"), false);
  assert.equal(contentChanged("packages/client/test/index.mjs"), false);
  assert.equal(contentChanged("packages/client/README.md"), true);
  assert.equal(contentChanged("package.json", '{"version":"1","scripts":{"build":"x"}}', '{"version":"2","scripts":{"build":"x"}}'), false);
  assert.equal(contentChanged("package.json", '{"version":"1","scripts":{"build":"x"}}', '{"version":"2","scripts":{"build":"y"}}'), true);
  assert.equal(contentChanged("packages/client/package.json", '{"version":"1","dependencies":{"a":"1"}}', '{"version":"2","dependencies":{"a":"1"}}'), false);
  assert.equal(contentChanged("packages/client/package.json", '{"version":"1","dependencies":{"a":"1"}}', '{"version":"2","dependencies":{"a":"2"}}'), true);
  assert.equal(contentChanged("runtime/packages/sdk/package-lock.json", '{"version":"1","packages":{"":{"version":"1"}}}', '{"version":"2","packages":{"":{"version":"2"}}}'), false);
  assert.equal(contentChanged("runtime/packages/sdk/package.json", undefined, '{}'), true);
  assert.equal(packageInputs("services/server/src/main.ts", { directory: "packages/client" }, "workspace"), false);
  assert.equal(packageInputs("packages/client/src/index.ts", { directory: "packages/client" }, "workspace"), true);
  assert.equal(packageInputs("config/next-trust/production.json", { directory: "runtime/packages/sdk" }, "source"), true);
  assert.equal(packageInputs("runtime/crates/wire/src/lib.rs", { directory: "runtime/packages/sdk" }, "source"), true);
});

test("dependent packages republish transitively when their shipped exact dependency changes", () => {
  const packages = [
    { name: "protocol", manifest: {} },
    { name: "client", manifest: { dependencies: { protocol: "workspace:*" } } },
    { name: "devkit", manifest: { dependencies: { client: "workspace:*" } } },
    { name: "unrelated", manifest: { peerDependencies: { protocol: "*" } } },
    { name: "optional", manifest: { optionalDependencies: { devkit: "workspace:*" } } }
  ];
  assert.deepEqual(dependentPackages(packages, ["protocol"]).map(item => item.name), ["protocol", "client", "devkit", "optional"]);
  assert.deepEqual(dependentPackages(packages, ["client"]).map(item => item.name), ["client", "devkit", "optional"]);
  assert.deepEqual(dependentPackages(packages, []), []);
});

test("failed or cancelled main publisher attempts latch until explicit owner acknowledgement", () => {
  const runs = [
    { id: 1, head_branch: "main", event: "workflow_run", conclusion: "failure" },
    { id: 2, head_branch: "main", event: "workflow_run", conclusion: "cancelled" },
    { id: 3, head_branch: "feature", event: "workflow_dispatch", conclusion: "failure" },
    { id: 4, head_branch: "main", event: "workflow_run", conclusion: "success" },
    { id: 5, head_branch: "main", event: "pull_request", conclusion: "failure" },
    { id: 7, head_branch: "main", event: "schedule", conclusion: "failure" },
    { id: 8, head_branch: "main", event: "schedule", conclusion: null }
  ];
  assert.deepEqual(failedPublisherRuns(runs, "6").map(item => item.id), [1, 2]);
  assert.deepEqual(failedPublisherRuns(runs, "6", "1").map(item => item.id), [2]);
  assert.deepEqual(failedPublisherRuns(runs, "6", "2"), []);
  assert.deepEqual(failedPublisherRuns(runs, "9", "2").map(item => item.id), [7, 8]);
  assert.throws(() => failedPublisherRuns(runs, "6", "unknown"));
});

test("every workspace package, including UI, locales and unknown packages, requires production proof", async context => {
  const directory = mkdtempSync(join(tmpdir(), "workspace-compatibility-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const planFile = join(directory, "plan.json");
  const summary = join(directory, "summary.md");
  for (const item of [...await publicPackages(), { name: "@mdbase-dev/new-package", directory: "packages/new-package" }]) {
    for (const live of ["true", "false"]) {
      const record = { schema: 1, kind: "workspace", commit, packages: [{ ...item, version }] };
      writeFileSync(planFile, JSON.stringify(record));
      let calls = 0;
      const env = { GITHUB_SHA: commit, LIVE_PUBLICATION: live, GITHUB_STEP_SUMMARY: summary };
      const error = "Production does not contain this client's server-facing contract: packages/protocol/src/auth.ts";
      const result = qualifyWorkspace(planFile, env, async actual => {
        assert.equal(actual, env);
        calls++;
        throw new Error(error);
      });
      if (live === "true") await assert.rejects(result, /production-compatibility-unproven/);
      else assert.deepEqual(await result, { status: "blocked", error: "production-compatibility-unproven" });
      assert.equal(calls, 1, item.name);
      assert.deepEqual(JSON.parse(readFileSync(planFile, "utf8")), { ...record, compatibility: { status: "blocked", error: "production-compatibility-unproven" } });
    }
  }
  assert.match(readFileSync(summary, "utf8"), /Workspace production compatibility: blocked/);
});

test("workspace plans retain exact successful proof and fail closed on unavailable evidence or invalid identity/mode", async context => {
  const directory = mkdtempSync(join(tmpdir(), "workspace-compatibility-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const planFile = join(directory, "plan.json");
  const record = { schema: 1, kind: "workspace", commit, packages: [] };
  const evidence = { candidate: commit, production: "b".repeat(40), reason: "production-contains-candidate",
    provider: "c".repeat(40), providerReason: "unchanged-contract-axis" };
  for (const live of ["true", "false"]) {
    writeFileSync(planFile, JSON.stringify(record));
    const env = { GITHUB_SHA: commit, LIVE_PUBLICATION: live };
    assert.deepEqual(await qualifyWorkspace(planFile, env, async () => evidence), { status: "passed", evidence });
    assert.deepEqual(JSON.parse(readFileSync(planFile, "utf8")).compatibility, { status: "passed", evidence });
    for (const message of ["Canonical production Connect is not ready.", "fetch failed", "Invalid release tag object.", "ancestry status 128"]) {
      const result = qualifyWorkspace(planFile, env, async () => { throw new Error(message); });
      if (live === "true") await assert.rejects(result, { message: "production-compatibility-unproven" });
      else assert.deepEqual(await result, { status: "blocked", error: "production-compatibility-unproven" });
    }
  }
  for (const change of [{ GITHUB_SHA: "b".repeat(40) }, { LIVE_PUBLICATION: undefined }, { LIVE_PUBLICATION: "False" }]) {
    await assert.rejects(qualifyWorkspace(planFile, { GITHUB_SHA: commit, LIVE_PUBLICATION: "true", ...change },
      async () => assert.fail("invalid source/mode must not read production")));
  }
});

test("workspace plan and mutation boundary use the real shared proof against both production identities", context => {
  const directory = mkdtempSync(join(tmpdir(), "workspace-compatibility-boundary-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const planFile = join(directory, "plan.json");
  const marker = join(directory, "npm-called");
  const program = new URL("../continuous-sdk-release.mjs", import.meta.url).href;
  for (const [tool, source] of Object.entries({
    git: `const args = process.argv.slice(2);
if (args[0] === "rev-parse") console.log(process.env.GITHUB_SHA);
else if (args[0] === "merge-base" && args[1] === "--is-ancestor" && args[3] !== "origin/main") process.exit(1);
else if (args[0] === "diff") console.log(args[4] === process.env.BLOCKED_COMMIT ? process.env.CONTRACT_PATH : "docs/releasing.md");`,
    gh: `const path = process.argv.at(-1);
if (path.includes("actions/workflows/")) console.log(JSON.stringify({ state: "active" }));
else if (path.includes("git/ref/tags/")) console.log(JSON.stringify({ object: { type: "tag", sha: "d".repeat(40) } }));
else if (path.includes("git/tags/")) console.log(JSON.stringify({ object: { type: "commit", sha: "c".repeat(40) } }));
else throw new Error("Unexpected API read: " + path);`,
    npm: `require("node:fs").writeFileSync(process.env.NPM_MARKER, "called"); process.exit(99);`
  })) {
    const path = join(directory, tool);
    writeFileSync(path, `#!/usr/bin/env node\n${source}\n`);
    chmodSync(path, 0o755);
  }
  const script = `import { qualifyWorkspace, publishWorkspace } from ${JSON.stringify(program)};
globalThis.fetch = async url => {
  let body;
  if (url === "https://connect.mdbase.dev/health") body = { ok: true, service: "mdbase-connect", revision: "b".repeat(40), environment: "production", public_origin: "https://connect.mdbase.dev", protocol_version: 1, capabilities: ["application-authorization-v2-issuance"] };
  else if (url === "https://connect.mdbase.dev/ready") body = { ok: true, service: "mdbase-connect" };
  else if (url === "https://sync.mdbase.dev/ready") body = { status: "ready", provider: { version: "0.1.0-beta.152", revision: "c".repeat(40), capabilities: ["application-authorization-v2-issuance"] }, notifications: { recovery: "ok", consecutive_failures: 0 } };
  else if (url === "https://mcp.mdbase.dev/health") body = { ok: true, service: "mdbase-mcp", revision: "b".repeat(40) };
  else throw new Error("Unexpected network read: " + url);
  return { ok: true, json: async () => body };
};
if (process.env.TEST_COMMAND === "plan") await qualifyWorkspace(process.env.PLAN_FILE);
else await publishWorkspace(process.env.PLAN_FILE, process.env.ARCHIVE_DIRECTORY);`;
  for (const blocked of ["b".repeat(40), "c".repeat(40)]) {
    for (const path of ["packages/client/src/index.ts", "packages/protocol/src/auth.ts", "packages/sync/src/index.ts",
      "pnpm-lock.yaml", "config/next-trust/production.json", "new-contract/source.ts"]) {
      for (const [command, live] of [["plan", "true"], ["plan", "false"], ["publish", "true"]]) {
        const record = { schema: 1, kind: "workspace", commit, packages: [{ name: "@mdbase-dev/connect", version }],
          compatibility: { status: "passed", evidence: { candidate: commit } } };
        writeFileSync(planFile, JSON.stringify(record));
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8",
          env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, GITHUB_REPOSITORY: "mdbase-dev/mdbase-connect",
            GITHUB_SHA: commit, GITHUB_WORKFLOW: "Publish npm packages", SDK_RELEASE_STOPPED: "false", LIVE_PUBLICATION: live,
            TEST_COMMAND: command, PLAN_FILE: planFile, ARCHIVE_DIRECTORY: directory, BLOCKED_COMMIT: blocked,
            CONTRACT_PATH: path, NPM_MARKER: marker, GITHUB_STEP_SUMMARY: "" } });
        assert.equal(result.status, live === "true" ? 1 : 0, result.stderr);
        if (command === "plan") {
          assert.match(result.stdout + result.stderr, /production-compatibility-unproven/);
          assert(!(result.stdout + result.stderr).includes(path), "planner diagnostics are fixed text");
        } else {
          assert.match(result.stdout + result.stderr, /Production does not contain this client's server-facing contract/);
          assert((result.stdout + result.stderr).includes(path));
        }
        assert.equal(existsSync(marker), false, "incompatible source must never reach npm");
        if (command === "plan") assert.equal(JSON.parse(readFileSync(planFile, "utf8")).compatibility.status, "blocked");
      }
    }
  }
});

test("workspace packing preserves qualified files, changes only metadata, and pins published dependencies", async context => {
  const { packWorkspace } = await import("../continuous-sdk-release.mjs");
  const directory = mkdtempSync(join(tmpdir(), "continuous-npm-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  const input = join(directory, "input");
  mkdirSync(join(source, "package/dist"), { recursive: true });
  mkdirSync(input);
  const actual = JSON.parse(readFileSync(new URL("../../packages/client/package.json", import.meta.url), "utf8"));
  const manifest = { name: actual.name, version: actual.version, files: ["dist"], dependencies: { "@mdbase-dev/connect-protocol": actual.version } };
  writeFileSync(join(source, "package/package.json"), JSON.stringify(manifest));
  writeFileSync(join(source, "package/dist/index.js"), "export const qualified = true;\n");
  execFileSync("tar", ["-czf", join(input, `mdbase-dev-connect-${actual.version}.tgz`), "-C", source, "package"]);
  const record = { schema: 1, commit, kind: "workspace", packages: [{ name: actual.name, directory: "packages/client", version: "0.1.0-beta.999" }], dependencies: { "@mdbase-dev/connect-protocol": "0.1.0-beta.998" } };
  const plan = join(directory, "plan.json");
  writeFileSync(plan, JSON.stringify(record));
  const output = join(directory, "output");
  packWorkspace(plan, input, output, { GITHUB_SHA: commit });
  const archive = join(output, "mdbase-dev-connect-0.1.0-beta.999.tgz");
  const packed = JSON.parse(execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" }));
  assert.equal(packed.version, "0.1.0-beta.999");
  assert.equal(packed.dependencies["@mdbase-dev/connect-protocol"], "0.1.0-beta.998");
  assert.equal(packed.mdbaseRelease.commit, commit);
  assert.equal(execFileSync("tar", ["-xOf", archive, "package/dist/index.js"], { encoding: "utf8" }), "export const qualified = true;\n");
});

test("all SDK consumers pin the selected source", () => {
  const source = readFileSync(new URL("../continuous-sdk-release.mjs", import.meta.url), "utf8");
  assert.match(source, /const production = await selectProduction\(env\)/);
  assert.match(source, /qualify\(commit, env\)/);
  assert.match(source, /qualifyRuntime\(commit\)/);
  assert.match(source, /env = \{ \.\.\.env, GITHUB_SHA: commit \}/);
  assert.match(source, /commit=\$\{commit\}/);
  for (const [name, jobs] of [["publish-npm", ["pack", "publish"]], ["publish-sdk-npm", ["build", "publish", "publish-internal"]]]) {
    const workflow = readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
    assert.match(workflow, /commit: \$\{\{ steps.plan.outputs.commit \}\}/);
    for (const job of jobs) {
      const block = workflow.split(`\n  ${job}:\n`)[1].split(/\n  [a-z][a-z-]*:\n/)[0];
      assert.match(block, /CLIENT_RELEASE_COMMIT: \$\{\{ needs.plan.outputs.commit/);
      assert.match(block, /ref: \$\{\{ needs.plan.outputs.commit/);
      // Every shell command must bind source-sensitive legacy scripts, version
      // stamping, compatibility checks, tags and npm provenance to the plan.
      for (const step of block.split(/\n      - /).filter(step => /\brun:/.test(step))) {
        assert.match(step, /run: \|\n          export GITHUB_SHA="\$CLIENT_RELEASE_COMMIT"/);
      }
    }
  }
});

function fakeGit({ ancestor = true, paths = [], files = {} } = {}) {
  return (...args) => {
    if (args[0] === "merge-base") {
      if (ancestor) return "";
      throw Object.assign(new Error("not an ancestor"), { status: 1 });
    }
    if (args[0] === "diff") return paths.map(path => `${path}\0`).join("");
    if (args[0] === "show") {
      if (args[1] in files) return files[args[1]];
      throw Object.assign(new Error("missing"), { status: 128 });
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

test("publication selects the exact production tree without falling back to another green commit", async () => {
  const production = "a".repeat(40);
  const env = { GITHUB_REPOSITORY: "mdbase-dev/mdbase-connect", GITHUB_REF: "refs/heads/main" };
  const calls = [];
  const options = { readProduction: async () => ({ sha: production }), runGit: (...args) => { calls.push(args); return ""; } };
  assert.equal(await checkoutPublicationSource(env, options), production);
  assert.deepEqual(calls.at(-1), ["checkout", "--detach", production]);
  assert(calls.some(args => JSON.stringify(args) === JSON.stringify(["merge-base", "--is-ancestor", production, "origin/main"])));
  await assert.rejects(checkoutPublicationSource(env, { ...options, readProduction: async () => ({ sha: "main" }) }));
  for (const status of [1, 128]) {
    await assert.rejects(checkoutPublicationSource(env, { ...options, runGit: (...args) => {
      if (args[0] === "merge-base") throw Object.assign(new Error("unavailable"), { status });
    } }));
  }
});

test("production requires its own successful main-push Runtime CI without waiting for the newer run", () => {
  const sha = "c".repeat(40);
  const success = { head_sha: sha, head_branch: "main", event: "push", path: ".github/workflows/runtime-ci.yml",
    status: "completed", conclusion: "success" };
  const read = runs => path => {
    assert(path.includes(`head_sha=${sha}&event=push&branch=main`));
    return { workflow_runs: runs };
  };
  requireRuntimeCi(sha, read([success]));
  for (const change of [{ head_sha: "b".repeat(40) }, { head_branch: "feature" }, { event: "pull_request" },
    { event: "workflow_dispatch" }, { path: ".github/workflows/server-ci.yml" },
    { status: "in_progress", conclusion: null }, { conclusion: "failure" }]) {
    assert.throws(() => requireRuntimeCi(sha, read([{ ...success, ...change }])), /publication-runtime-ci-unqualified/);
  }
  assert.throws(() => requireRuntimeCi(sha, read([])), /publication-runtime-ci-unqualified/);
});

test("version-only manifest edits are not input changes when deciding what to publish", () => {
  const item = { name, directory: "packages/sdk" };
  const path = "packages/sdk/package.json";
  const files = { [`a:${path}`]: '{"name":"x","version":"1"}', [`b:${path}`]: '{"name":"x","version":"2"}' };
  assert.equal(inputChanged(path, item, "workspace", "a", "b", fakeGit({ files })), false);
  files[`b:${path}`] = '{"name":"x","version":"2","main":"y"}';
  assert.equal(inputChanged(path, item, "workspace", "a", "b", fakeGit({ files })), true);
  assert.equal(inputChanged("packages/sdk/new/package.json", item, "workspace", "a", "b", fakeGit({ files })), true);
  assert.equal(inputChanged("apps/editor/src/a.ts", item, "workspace", "a", "b", fakeGit()), false);
});

test("automatic publishers keep isolated OIDC, source qualification and explicit dry-run dispatches", () => {
  const publisher = readFileSync(new URL("../continuous-sdk-release.mjs", import.meta.url), "utf8");
  assert.match(publisher, /if \(selected.length && kind === "workspace"\) result.compatibility = await qualifyWorkspace\(output, env, verify\)/);
  assert.match(publisher, /qualifyWorkspace\(planFile, env = process.env, verify = verifyCompatibility\)/);
  assert.match(publisher, /for \(const item of record.packages\) \{\s+await compatible\(env\)/);
  for (const name of ["publish-npm", "publish-sdk-npm"]) {
    const workflow = readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
    assert.match(workflow, /workflow_run:/);
    assert.match(workflow, /dry_run:[\s\S]*default: true/);
    assert.match(workflow, /verify-qualified-commit/);
    assert.match(workflow, /continuous-sdk-release\.mjs"? compatible/);
    assert.match(workflow, /id-token: write/);
    assert.match(workflow, /SDK_RELEASE_STOPPED/);
    assert.doesNotMatch(workflow, /production_verified_commit|PRODUCTION_VERIFIED_COMMIT|NODE_AUTH_TOKEN/);
    assert.match(workflow, /github\.event\.workflow_run\.event == 'push'/);
    assert.match(workflow, /cancel-in-progress: \$\{\{ github.event_name == 'pull_request' \}\}/);
  }
  const runtime = readFileSync(new URL("../../.github/workflows/runtime-ci.yml", import.meta.url), "utf8");
  const mainPush = runtime.split("  push:\n")[1].split("  workflow_dispatch:")[0];
  assert.match(mainPush, /branches: \[main\]/);
  assert.doesNotMatch(mainPush, /paths(?:-ignore)?:/);
});

test("a run queued behind the same commit's publication stands down; other outcomes stay for review", async t => {
  const name = "@mdbase-dev/sdk";
  const version = "0.1.0-beta.154";
  const commit = "091d912babeacbba88661f7ce4b96081658376af";
  const env = { GITHUB_SHA: commit, GITHUB_WORKFLOW: "Publish source-built SDK" };
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const registry = status => { globalThis.fetch = async () => ({ status, json: async () => ({ name, version }) }); };
  const proving = source => async (_, baseline) => {
    assert.equal(baseline.workflow, "publish-sdk-npm.yml");
    return { commit: source };
  };

  // Run 41902147578 planned on a 404, then its recheck read 200 for run 41901606853's publication.
  registry(200);
  assert.equal(await publicationState(name, version, env, proving(commit)), "published");
  registry(404);
  assert.equal(await publicationState(name, version, env, async () => assert.fail("absence needs no proof")), "absent");

  registry(200);
  await assert.rejects(publicationState(name, version, env, proving("a".repeat(40))), /another commit/);
  await assert.rejects(publicationState(name, version, env, async () => { throw new Error("Exactly one npm provenance attestation is required."); }), /provenance/);
  for (const status of [401, 403, 429, 500, 503]) {
    registry(status);
    await assert.rejects(publicationState(name, version, env, proving(commit)), new RegExp(`HTTP ${status} requires owner review`));
  }
});

function plannerFixture(context) {
  const directory = mkdtempSync(join(tmpdir(), "publication-history-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Publication test");
  const directories = ["packages/protocol", "packages/client", "packages/devkit", "packages/app-ui", "packages/i18n", "runtime/packages/sdk"];
  for (const path of ["package.json", ...directories.map(directory => `${directory}/package.json`)]) {
    mkdirSync(join(directory, path, ".."), { recursive: true });
    const manifest = JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));
    writeFileSync(join(directory, path), JSON.stringify(manifest));
  }
  const save = () => { git("add", "."); git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
  const base = save();
  // Shared inputs exercise every workspace package and source-SDK dependency.
  writeFileSync(join(directory, "pnpm-lock.yaml"), "production\n");
  const production = save();
  writeFileSync(join(directory, "pnpm-lock.yaml"), "future\n");
  for (const path of ["packages/app-ui/package.json", "runtime/packages/sdk/package.json"]) {
    const manifest = JSON.parse(readFileSync(join(directory, path), "utf8"));
    writeFileSync(join(directory, path), JSON.stringify({ ...manifest, version: "0.1.0-beta.999" }));
  }
  const future = save();
  writeFileSync(join(directory, "README.md"), "off-axis successor\n");
  const successor = save();
  git("checkout", "-qb", "diverged", base);
  writeFileSync(join(directory, "peer.txt"), "diverged\n");
  const diverged = save();
  const program = new URL("../continuous-sdk-release.mjs", import.meta.url).href;
  const execute = ({ kind, baselineCommit = production, run = production, selected = production, ci = true, compatibility = true, live = "true", aheadUi = false, priorFailure = false }) => {
    git("checkout", "--detach", run);
    const summary = join(directory, "summary.md");
    const output = join(directory, "outputs");
    const planFile = join(directory, "plan.json");
    for (const file of [summary, output, planFile]) rmSync(file, { force: true });
    const script = `import { plan } from ${JSON.stringify(program)};
const selected = ${JSON.stringify(selected)};
await plan(${JSON.stringify(kind)}, ${JSON.stringify(planFile)}, process.env, {
  selectProduction: async () => {
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['checkout', '--detach', selected], { stdio: 'pipe' });
    return selected;
  },
  qualify: (sha, env) => { if (sha !== selected || env.GITHUB_SHA !== selected) throw new Error('wrong qualification'); },
  qualifyRuntime: sha => { if (sha !== selected || !${JSON.stringify(ci)}) throw new Error('publication-runtime-ci-unqualified'); },
  readPublished: async item => ({ version: ${JSON.stringify(version)}, versions: [${JSON.stringify(version)}],
    commit: ${JSON.stringify(aheadUi)} && item.name === '@mdbase-dev/ui' ? ${JSON.stringify(future)} : ${JSON.stringify(baselineCommit)} }),
  checkAttempts: () => { if (${JSON.stringify(priorFailure)}) throw new Error('RAW-PRIOR-ATTEMPT-STDERR'); },
  verify: async () => {
    if (!${JSON.stringify(compatibility)}) throw new Error('RAW-COMPATIBILITY-STDERR');
    return { candidate: process.env.GITHUB_SHA };
  }
});`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: directory, encoding: "utf8",
      env: { ...process.env, GITHUB_REPOSITORY: "mdbase-dev/mdbase-connect", GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: run, LIVE_PUBLICATION: live, SDK_RELEASE_STOPPED: "false", GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary } });
    return { ...result, summary: existsSync(summary) ? readFileSync(summary, "utf8") : "",
      output: existsSync(output) ? readFileSync(output, "utf8") : "",
      plan: existsSync(planFile) ? JSON.parse(readFileSync(planFile, "utf8")) : undefined };
  };
  return { execute, base, production, future, successor, diverged };
}

for (const kind of ["source", "workspace"]) {
  test(`${kind} planner handles ahead, divergent and pending histories with bounded per-package summaries`, async context => {
    const { execute, base, production, future, successor, diverged } = plannerFixture(context);
    const names = kind === "source" ? [name] : (await publicPackages()).map(item => item.name);
    const check = (result, decision, run = production) => {
      for (const item of names) {
        assert(result.summary.includes(`${item}: selected production ${production}; run ${run}; published baseline ${version} at `), result.summary);
      }
      assert.match(result.summary, decision);
      assert(result.stdout.includes(result.summary.split("\n").find(line => line.startsWith("- @")).slice(2)), "same diagnostic appears in log and summary");
      assert.doesNotMatch(result.stdout + result.stderr + result.summary, /RAW-|Command failed/);
    };
    for (const run of [production, future]) {
      const ahead = execute({ kind, baselineCommit: future, run, compatibility: false, priorFailure: true });
      assert.equal(ahead.status, 0, ahead.stderr);
      assert.deepEqual(ahead.plan.packages, []);
      assert.equal(ahead.plan.compatibility, undefined);
      assert.match(ahead.output, /changed=false\npublish=false/);
      check(ahead, new RegExp(`published baseline is ahead of production ${production}`), run);
    }
    const divergence = execute({ kind, baselineCommit: diverged });
    assert.equal(divergence.status, 1);
    assert.equal(divergence.plan, undefined);
    assert.equal(divergence.output, "");
    check(divergence, /blocked: publication-baseline-diverged/);

    const invalid = execute({ kind, baselineCommit: "0".repeat(40) });
    assert.equal(invalid.status, 1);
    check(invalid, /blocked: publication-ancestry-unavailable/);
    assert.doesNotMatch(invalid.stdout + invalid.stderr, /fatal:/, "real Git stderr must stay captured");

    // Main can keep changing published inputs while the production train runs.
    const pending = execute({ kind, baselineCommit: base, run: future });
    assert.equal(pending.status, 0, pending.stderr);
    assert.equal(pending.plan.commit, production);
    assert.deepEqual(pending.plan.packages.map(item => item.name), names);
    assert(pending.plan.packages.every(item => item.version !== "0.1.0-beta.1000"), "version allocation must use production's manifests");
    check(pending, new RegExp(`publishing production ${production} as 0\\.1\\.0-beta\\.`), future);
    assert.match(pending.output, new RegExp(`commit=${production}\\nchanged=true\\npublish=true`));
    assert.doesNotMatch(pending.summary, /waiting for production to reach|waiting for successful qualification/);

    const currentBaseline = execute({ kind, run: future, compatibility: false, priorFailure: true });
    assert.equal(currentBaseline.status, 0, currentBaseline.stderr);
    assert.deepEqual(currentBaseline.plan.packages, []);
    check(currentBaseline, /nothing to publish/, future);

    const containedRun = execute({ kind, run: base, baselineCommit: base });
    assert.equal(containedRun.status, 0, containedRun.stderr);
    assert.equal(containedRun.plan.commit, production);
    assert.deepEqual(containedRun.plan.packages.map(item => item.name), names);

    const empty = execute({ kind, compatibility: false, priorFailure: true });
    assert.equal(empty.status, 0, empty.stderr);
    check(empty, /nothing to publish/);
    assert.match(empty.output, /changed=false\npublish=false/);

    const publishing = execute({ kind, baselineCommit: base });
    assert.equal(publishing.status, 0, publishing.stderr);
    assert.deepEqual(publishing.plan.packages.map(item => item.name), names);
    check(publishing, /publishing production .* as 0\.1\.0-beta\./);
    assert.match(publishing.output, /changed=true\npublish=true/);

    const caughtUp = execute({ kind, baselineCommit: production, selected: future, run: future });
    assert.equal(caughtUp.status, 0, caughtUp.stderr);
    assert.equal(caughtUp.plan.commit, future);
    assert.deepEqual(caughtUp.plan.packages.map(item => item.name), names, "promotion releases the previously pending inputs");
    assert.match(caughtUp.output, /changed=true\npublish=true/);

    const equivalent = execute({ kind, baselineCommit: production, selected: future, run: successor });
    assert.equal(equivalent.status, 0, equivalent.stderr);
    assert.equal(equivalent.plan.commit, future, "even equivalent newer runs publish exactly production");
    assert.deepEqual(equivalent.plan.packages.map(item => item.name), names);
    assert.match(equivalent.output, /changed=true\npublish=true/);

    const ci = execute({ kind, baselineCommit: base, run: future, ci: false });
    assert.equal(ci.status, 1);
    assert.equal(ci.plan, undefined);
    assert.equal(ci.output, "");
    assert.match(ci.stderr, /publication-runtime-ci-unqualified/);

    const prior = execute({ kind, baselineCommit: base, priorFailure: true });
    assert.equal(prior.status, 1);
    check(prior, /blocked: publication-prior-attempt-unreconciled/);

    if (kind === "workspace") {
      const mixed = execute({ kind, baselineCommit: base, aheadUi: true, compatibility: false, priorFailure: true });
      assert.equal(mixed.status, 0, mixed.stderr);
      assert.deepEqual(mixed.plan.packages, [], "dependency expansion must never repack source behind a baseline");
      check(mixed, new RegExp(`published baseline is ahead of production ${production}`));
      for (const live of ["true", "false"]) {
        const blocked = execute({ kind, baselineCommit: base, compatibility: false, live });
        assert.equal(blocked.status, live === "true" ? 1 : 0, blocked.stderr);
        check(blocked, /blocked: production-compatibility-unproven/);
        assert.equal(blocked.plan.compatibility.status, "blocked");
      }
    }
  });
}

test("ancestry invocation failures are named and never interpreted as an ahead baseline", () => {
  for (const failAt of [1, 2]) {
    let calls = 0;
    assert.throws(() => baselineHistory("a".repeat(40), "b".repeat(40), () => {
      calls++;
      throw Object.assign(new Error("RAW-GIT-STDERR"), { status: calls === failAt ? 128 : 1 });
    }), { message: "publication-ancestry-unavailable" });
    assert.equal(calls, failAt);
  }
});
