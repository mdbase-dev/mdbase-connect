import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { mkdtemp, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  createFailureReport,
  createSuccessReport,
  deployDevelopmentEditor,
  developmentDeployments,
  parseWranglerDeploymentOutput,
  qualifyExactLabRelease,
  reservePrivateJsonReport,
  verifyExactDeployment
} from "./deploy-editor-dev.mjs";

const root = resolve(import.meta.dirname, "..");
const commit = "0123456789abcdef0123456789abcdef01234567";
const accountId = "a738af70299a1b59abd43fe1275f5892";
const deploymentId = "12345678-1234-4123-8123-123456789abc";
const deploymentUrl = `https://${deploymentId.slice(0, 8)}.mdbase-editor-lab.pages.dev`;
const wranglerArgs = wranglerArgsFor("/private/empty.env");

function wranglerArgsFor(emptyEnvironmentPath) {
  return [
    "pages",
    "deploy",
    "apps/editor/dist",
    "--project-name=mdbase-editor-lab",
    "--branch=candidate-b",
    `--commit-hash=${commit}`,
    "--commit-dirty=false",
    `--env-file=${emptyEnvironmentPath}`
  ];
}
const labEnvironment = Object.freeze({
  HOME: "/operator/home",
  PATH: process.env.PATH,
  MDBASE_ENV: "lab",
  MDBASE_LAB_RELEASE_MODE: "exact",
  MDBASE_LAB_EXPECTED_COMMIT: commit,
  VITE_MDBASE_BUILD_REVISION: commit,
  MDBASE_LAB_DEPLOYMENT_REPORT: "/tmp/mdbase-editor-test-report.json",
  CLOUDFLARE_ACCOUNT_ID: accountId,
  CLOUDFLARE_API_TOKEN: "test-secret-never-report",
  ARBITRARY_OPERATOR_VALUE: "must-not-propagate"
});

function wranglerOutput(overrides = {}) {
  const detail = {
    type: "pages-deploy-detailed",
    version: 1,
    pages_project: "mdbase-editor-lab",
    deployment_id: deploymentId,
    url: `${deploymentUrl}/`,
    alias: null,
    environment: "production",
    production_branch: "candidate-b",
    deployment_trigger: { metadata: { commit_hash: commit } },
    timestamp: "2026-08-29T00:00:00.000Z",
    ...overrides.detail
  };
  return [
    {
      type: "wrangler-session",
      version: 1,
      wrangler_version: "4.114.0",
      command_line_args: wranglerArgs,
      log_file_path: "/private/wrangler.log",
      timestamp: "2026-08-29T00:00:00.000Z",
      ...overrides.session
    },
    {
      type: "pages-deploy",
      version: 1,
      pages_project: detail.pages_project,
      deployment_id: detail.deployment_id,
      url: detail.url,
      timestamp: "2026-08-29T00:00:01.000Z",
      ...overrides.simple
    },
    detail
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

function successfulGitCapture(command, args) {
  if (command !== "git") throw new Error(`Unexpected command ${command}`);
  if (args[0] === "rev-parse") return commit;
  if (args[0] === "status") return "";
  if (args[0] === "remote") return "https://github.com/mdbase-dev/mdbase-connect.git\n";
  throw new Error(`Unexpected git command ${args.join(" ")}`);
}

test("pinned Wrangler CLI exposes the expected Pages contract and no JSON flag", () => {
  const version = spawnSync("pnpm", ["exec", "wrangler", "--version"], { cwd: root, encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /4\.114\.0/u);
  const help = spawnSync("pnpm", ["exec", "wrangler", "pages", "deploy", "--help"], { cwd: root, encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--commit-hash/u);
  assert.match(help.stdout, /--commit-dirty/u);
  assert.match(help.stdout, /--env-file/u);
  assert.doesNotMatch(help.stdout, /--json/u);
});

test("Wrangler NDJSON parser binds the production deployment to project, branch, commit, ID, and URL", () => {
  assert.deepEqual(parseWranglerDeploymentOutput(wranglerOutput(), {
    project: "mdbase-editor-lab",
    branch: "candidate-b",
    commit,
    wranglerArgs
  }), { id: deploymentId, url: deploymentUrl });

  const malformed = [
    "not-json\n",
    wranglerOutput({ detail: { pages_project: "mdbase-editor" } }),
    wranglerOutput({ detail: { environment: "preview" } }),
    wranglerOutput({ detail: { production_branch: "main" } }),
    wranglerOutput({ detail: { deployment_trigger: { metadata: { commit_hash: "f".repeat(40) } } } }),
    wranglerOutput({ detail: { deployment_id: "not-a-uuid", url: "https://not-a-uuid.mdbase-editor-lab.pages.dev/" } }),
    wranglerOutput({ detail: { url: "https://example.pages.dev/" } }),
    wranglerOutput({ simple: { deployment_id: "87654321-1234-4123-8123-123456789abc" } }),
    wranglerOutput({ session: { wrangler_version: "4.113.0" } }),
    wranglerOutput() + JSON.stringify({ type: "unexpected", version: 1 }) + "\n"
  ];
  for (const value of malformed) {
    assert.throws(() => parseWranglerDeploymentOutput(value, {
      project: "mdbase-editor-lab",
      branch: "candidate-b",
      commit,
      wranglerArgs
    }), /Wrangler/u);
  }
});

test("exact LAB release uses an explicit empty env file, installs first, and records bound success", async () => {
  const events = [];
  const fixtureRoot = await deployRootFixture();
  const reportDirectory = await mkdtemp(resolve(tmpdir(), "mdbase-success-report-"));
  const reportPath = resolve(reportDirectory, "success.json");
  const environment = { ...labEnvironment, MDBASE_LAB_DEPLOYMENT_REPORT: reportPath };
  await writeFile(resolve(fixtureRoot, ".env"), "POISON_FROM_REPOSITORY=1\nCLOUDFLARE_ACCOUNT_ID=wrong\n");
  await writeFile(resolve(fixtureRoot, ".env.local"), "CLOUDFLARE_API_TOKEN=poison\n");
  await deployDevelopmentEditor(environment, async (command, args, environment) => {
    events.push({ type: "run", command, args, environment });
  }, {
    capture: async (command, args, options) => {
      events.push({ type: "capture", command, args, options });
      if (command === "git") return successfulGitCapture(command, args);
      assert.deepEqual(args.slice(0, 2), ["exec", "wrangler"]);
      assert.equal(options.env.CLOUDFLARE_ACCOUNT_ID, accountId);
      assert.equal(options.env.CLOUDFLARE_API_TOKEN, labEnvironment.CLOUDFLARE_API_TOKEN);
      assert.equal(options.env.ARBITRARY_OPERATOR_VALUE, undefined);
      assert.equal(options.env.VITE_MDBASE_BUILD_REVISION, undefined);
      assert.equal(options.env.POISON_FROM_REPOSITORY, undefined);
      assert.equal(args.join(" ").includes("POISON_FROM_REPOSITORY"), false);
      assert.equal(args.join(" ").includes(".env.local"), false);
      const envFileArg = args.find((arg) => arg.startsWith("--env-file="));
      assert.ok(envFileArg);
      const emptyEnvironmentPath = envFileArg.slice("--env-file=".length);
      assert.equal(await readFile(emptyEnvironmentPath, "utf8"), "");
      assert.equal(emptyEnvironmentPath.startsWith(fixtureRoot), false);
      await writeFile(options.env.WRANGLER_OUTPUT_FILE_PATH, wranglerOutput({
        session: { command_line_args: args.slice(2) }
      }), { flag: "a" });
      return "human output discarded";
    },
    root: fixtureRoot,
    reserveReport: async (...args) => {
      events.push({ type: "reserve" });
      return reservePrivateJsonReport(...args);
    },
    verify: async (input) => {
      assert.deepEqual(input.origins, [deploymentUrl, "https://editor-lab.mdbase.dev"]);
      assert.equal(input.buildRevision, commit);
      return { assertions: { build_revision: true }, revision_evidence: { revision: commit } };
    }
  });

  assert.equal(events[0].type, "capture");
  assert.ok(events.findIndex(({ type }) => type === "reserve") < events.findIndex(({ type }) => type === "run"));
  const runs = events.filter(({ type }) => type === "run");
  assert.deepEqual(runs[0].args, ["install", "--frozen-lockfile"]);
  for (const { environment } of runs) {
    assert.equal(environment.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(environment.CLOUDFLARE_ACCOUNT_ID, undefined);
    assert.equal(environment.ARBITRARY_OPERATOR_VALUE, undefined);
    assert.equal(environment.VITE_MDBASE_BUILD_REVISION, commit);
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.status, "success");
  assert.equal(report.source.commit, commit);
  assert.deepEqual(report.deployment, { id: deploymentId, url: deploymentUrl });
  assert.equal(report.target.cloudflare_account_sha256, createHash("sha256").update(accountId).digest("hex"));
  assert.equal(JSON.stringify(report).includes(accountId), false);
  assert.equal(JSON.stringify(report).includes(labEnvironment.CLOUDFLARE_API_TOKEN), false);
  assert.equal(report.wrangler_evidence.file, "success.json.wrangler.ndjson");
  assert.equal((await stat(`${reportPath}.wrangler.ndjson`)).mode & 0o777, 0o600);
});

test("LAB target and account are static and target overrides fail before commands", async () => {
  assert.deepEqual(developmentDeployments.lab, {
    connectOrigin: "https://connect-lab.mdbase.dev",
    editorOrigin: "https://editor-lab.mdbase.dev",
    cloudflareAccountId: accountId,
    project: "mdbase-editor-lab",
    branch: "candidate-b",
    wranglerVersion: "4.114.0"
  });
  for (const environment of [
    { MDBASE_ENV: "lab" },
    { ...labEnvironment, CLOUDFLARE_ACCOUNT_ID: undefined },
    { ...labEnvironment, CLOUDFLARE_ACCOUNT_ID: "f".repeat(32) },
    { ...labEnvironment, MDBASE_CONNECT_URL: "https://connect-lab.mdbase.dev" },
    { ...labEnvironment, CLOUDFLARE_PAGES_PROJECT: "mdbase-editor-lab" },
    { ...labEnvironment, CLOUDFLARE_PAGES_BRANCH: "candidate-b" }
  ]) {
    let commands = 0;
    await assert.rejects(deployDevelopmentEditor(environment, async () => { commands += 1; }, {
      capture: async () => { commands += 1; }
    }), /release|account|overrides/iu);
    assert.equal(commands, 0);
  }
});

test("source qualification rejects dirty, wrong HEAD, wrong origin, and invalid report before mutation", async () => {
  const cases = [
    [{ ...labEnvironment, MDBASE_LAB_EXPECTED_COMMIT: "abc" }, successfulGitCapture, /40-hex/u],
    [{ ...labEnvironment, VITE_MDBASE_BUILD_REVISION: "f".repeat(40) }, successfulGitCapture, /must equal/u],
    [{ ...labEnvironment, MDBASE_LAB_DEPLOYMENT_REPORT: "relative.json" }, successfulGitCapture, /absolute/u],
    [labEnvironment, (command, args) => args[0] === "status" ? "?? untracked\n" : successfulGitCapture(command, args), /clean worktree/u],
    [labEnvironment, (command, args) => args[0] === "rev-parse" ? "f".repeat(40) : successfulGitCapture(command, args), /does not equal/u],
    [labEnvironment, (command, args) => args[0] === "remote" ? "https://github.com/other/repo.git\n" : successfulGitCapture(command, args), /origin/u]
  ];
  for (const [environment, capture, expected] of cases) {
    await assert.rejects(qualifyExactLabRelease(environment, capture, root), expected);
  }
});

test("report reservation keeps the final path absent and rejects existing evidence or sidecar replacement", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "mdbase-report-"));
  const path = resolve(directory, "report.json");
  await writeFile(path, "existing\n", { mode: 0o600 });
  await assert.rejects(reservePrivateJsonReport(path, root), /already exists/u);
  assert.equal(await readFile(path, "utf8"), "existing\n");

  const evidenceCollisionPath = resolve(directory, "evidence-collision.json");
  await writeFile(`${evidenceCollisionPath}.wrangler.ndjson`, "existing evidence\n", { mode: 0o600 });
  await assert.rejects(reservePrivateJsonReport(evidenceCollisionPath, root), /Wrangler evidence already exists/u);
  await assert.rejects(readFile(evidenceCollisionPath), /ENOENT/u);
  await assert.rejects(readFile(`${evidenceCollisionPath}.reserve`), /ENOENT/u);

  const reservedPath = resolve(directory, "reserved.json");
  const reservation = await reservePrivateJsonReport(reservedPath, root);
  await assert.rejects(readFile(reservedPath), /ENOENT/u);
  const sidecar = `${reservedPath}.reserve`;
  const displaced = `${sidecar}.displaced`;
  await rename(sidecar, displaced);
  await writeFile(sidecar, "impostor\n", { mode: 0o600 });
  await assert.rejects(reservation.commit({ status: "success" }), /reservation identity changed/u);
  await reservation.close();
  await assert.rejects(readFile(reservedPath), /ENOENT/u);
});

test("report publication is no-replace against a same-user race", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "mdbase-report-race-"));
  const path = resolve(directory, "report.json");
  let raced = false;
  const adapter = reportIo(directory, async (_temporaryPath, finalPath) => {
    if (!raced) {
      raced = true;
      await writeFile(finalPath, "competitor\n", { mode: 0o600 });
    }
  });
  const reservation = await reservePrivateJsonReport(path, root, adapter.io);
  await assert.rejects(reservation.commit({ status: "ours" }), /EEXIST/u);
  await reservation.close();
  assert.equal(await readFile(path, "utf8"), "competitor\n");
  assert.equal((await fs.readdir(directory)).some((name) => name.includes(".tmp-") || name.endsWith(".reserve")), false);
});

test("report publication fsyncs the directory after publish and cleanup", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "mdbase-report-success-"));
  const path = resolve(directory, "report.json");
  const adapter = reportIo(directory);
  const reservation = await reservePrivateJsonReport(path, root, adapter.io);
  await assert.rejects(readFile(path), /ENOENT/u);
  await writeFile(reservation.wranglerOutputPath, "structured output\n", { flag: "a" });
  const snapshot = await reservation.readWranglerEvidence();
  assert.equal(snapshot.evidence.sha256, createHash("sha256").update("structured output\n").digest("hex"));
  await reservation.commit({ status: "success" });
  await assert.rejects(reservation.commit({ status: "failure" }), /already finalized/u);
  await reservation.close();
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { status: "success" });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.ok(adapter.directorySyncs() >= 3);
  assert.deepEqual(adapter.syncEvents().slice(0, 2), ["wrangler-evidence", "directory"]);
  assert.deepEqual((await fs.readdir(directory)).sort(), ["report.json", "report.json.wrangler.ndjson"]);
});

test("deployment failure restores the manifest and atomically records a non-secret failure stage", async () => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), "mdbase-deploy-failure-"));
  const manifestPath = resolve(fixtureRoot, "apps/editor/public/.well-known/mdbase-app.json");
  await mkdir(resolve(manifestPath, ".."), { recursive: true });
  await writeFile(manifestPath, "original\n");
  let report;
  await assert.rejects(deployDevelopmentEditor(labEnvironment, async (_command, args) => {
    if (args.includes("mdbase-editor")) await writeFile(manifestPath, "generated\n");
    if (args[0] === "apps/editor/scripts/verify-deployment-manifest.mjs") throw new Error("private diagnostic");
  }, {
    root: fixtureRoot,
    capture: successfulGitCapture,
    reserveReport: async () => ({
      commit: async (value) => { report = value; },
      wranglerEvidence: async () => ({ file: "failure.json.wrangler.ndjson", sha256: createHash("sha256").update("").digest("hex"), bytes: 0 }),
      close: async () => undefined
    })
  }), /private diagnostic/u);
  assert.equal(await readFile(manifestPath, "utf8"), "original\n");
  assert.deepEqual(report.failure, { stage: "local-manifest-verification" });
  assert.equal(JSON.stringify(report).includes("private diagnostic"), false);
  assert.equal(JSON.stringify(report).includes(accountId), false);
});

test("successful upload with invalid NDJSON preserves private raw evidence and a digest-only failure marker", async () => {
  const fixtureRoot = await deployRootFixture();
  const reportDirectory = await mkdtemp(resolve(tmpdir(), "mdbase-raw-evidence-"));
  const reportPath = resolve(reportDirectory, "failure.json");
  const environment = { ...labEnvironment, MDBASE_LAB_DEPLOYMENT_REPORT: reportPath };
  const raw = Buffer.from("not-json-private-output\n");
  await assert.rejects(deployDevelopmentEditor(environment, async () => undefined, {
    root: fixtureRoot,
    capture: async (command, args, options) => {
      if (command === "git") return successfulGitCapture(command, args);
      await writeFile(options.env.WRANGLER_OUTPUT_FILE_PATH, raw, { flag: "a" });
      return "";
    }
  }), /valid NDJSON/u);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.deepEqual(report.failure, { stage: "wrangler-output-contract" });
  assert.equal(report.deployment, undefined);
  assert.equal(JSON.stringify(report).includes(raw.toString("utf8").trim()), false);
  assert.equal(report.wrangler_evidence.sha256, createHash("sha256").update(raw).digest("hex"));
  const rawPath = resolve(reportDirectory, report.wrangler_evidence.file);
  assert.deepEqual(await readFile(rawPath), raw);
  assert.equal((await stat(rawPath)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(reportDirectory)).sort(), ["failure.json", "failure.json.wrangler.ndjson"].sort());
});

test("Wrangler nonzero retains partial structured output evidence", async () => {
  const fixtureRoot = await deployRootFixture();
  const reportDirectory = await mkdtemp(resolve(tmpdir(), "mdbase-wrangler-nonzero-"));
  const reportPath = resolve(reportDirectory, "failure.json");
  const environment = { ...labEnvironment, MDBASE_LAB_DEPLOYMENT_REPORT: reportPath };
  const partial = Buffer.from(`${JSON.stringify({ type: "wrangler-session", version: 1 })}\n`);
  await assert.rejects(deployDevelopmentEditor(environment, async () => undefined, {
    root: fixtureRoot,
    capture: async (command, _args, options) => {
      if (command === "git") return successfulGitCapture(command, _args);
      await writeFile(options.env.WRANGLER_OUTPUT_FILE_PATH, partial, { flag: "a" });
      throw new Error("wrangler nonzero");
    }
  }), /wrangler nonzero/u);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.deepEqual(report.failure, { stage: "wrangler-deploy" });
  assert.equal(report.wrangler_evidence.sha256, createHash("sha256").update(partial).digest("hex"));
  assert.deepEqual(await readFile(resolve(reportDirectory, report.wrangler_evidence.file)), partial);
});

test("post-parse verification failure retains crash-durable deployment identity", async () => {
  const fixtureRoot = await deployRootFixture();
  const reportDirectory = await mkdtemp(resolve(tmpdir(), "mdbase-post-parse-"));
  const reportPath = resolve(reportDirectory, "failure.json");
  const environment = { ...labEnvironment, MDBASE_LAB_DEPLOYMENT_REPORT: reportPath };
  await assert.rejects(deployDevelopmentEditor(environment, async () => undefined, {
    root: fixtureRoot,
    capture: async (command, args, options) => {
      if (command === "git") return successfulGitCapture(command, args);
      await writeFile(options.env.WRANGLER_OUTPUT_FILE_PATH, wranglerOutput({
        session: { command_line_args: args.slice(2) }
      }), { flag: "a" });
      return "";
    },
    verify: async () => { throw new Error("verification failed"); }
  }), /verification failed/u);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.deepEqual(report.failure, { stage: "remote-content-verification" });
  assert.deepEqual(report.deployment, { id: deploymentId, url: deploymentUrl });
  const evidencePath = resolve(reportDirectory, report.wrangler_evidence.file);
  const evidence = await readFile(evidencePath, "utf8");
  assert.equal(report.wrangler_evidence.sha256, createHash("sha256").update(evidence).digest("hex"));
  const recovered = evidence.trim().split("\n").map((line) => JSON.parse(line));
  const detailed = recovered.find(({ type }) => type === "pages-deploy-detailed");
  assert.equal(detailed.deployment_id, deploymentId);
  assert.equal(detailed.url, `${deploymentUrl}/`);
  assert.equal(detailed.deployment_trigger.metadata.commit_hash, commit);
  assert.equal((await stat(evidencePath)).mode & 0o777, 0o600);
});

test("local LAB mode accepts a dirty checkout and deploys only the fixed LAB target", async () => {
  const fixtureRoot = await deployRootFixture();
  const manifestPath = resolve(fixtureRoot, "apps/editor/public/.well-known/mdbase-app.json");
  const calls = [];
  const environment = {
    HOME: "/operator/home",
    PATH: process.env.PATH,
    MDBASE_ENV: "lab",
    MDBASE_LAB_LOCAL_MODE: "1",
    MDBASE_LAB_LOCAL_REVISION: commit,
    VITE_MDBASE_BUILD_REVISION: commit,
    CLOUDFLARE_API_TOKEN: "local-test-token",
    RENDER_API_KEY: "must-not-reach-builds",
    VITE_UNEXPECTED_SECRET: "must-not-reach-builds"
  };
  await deployDevelopmentEditor(environment, async (command, args, commandEnvironment) => {
    calls.push({ command, args, environment: commandEnvironment });
    if (args.includes("mdbase-editor")) await writeFile(manifestPath, "generated-from-dirty-checkout\n");
  }, {
    root: fixtureRoot,
    capture: async () => { throw new Error("local LAB must not inspect git, origin, GitHub, or CI"); },
    reserveReport: async () => { throw new Error("local LAB must not reserve a qualification report"); }
  });

  assert.equal(await readFile(manifestPath, "utf8"), "original\n");
  assert.deepEqual(calls.slice(0, 4).map(({ command, args }) => [command, ...args.slice(0, 2)]), [
    ["pnpm", "install", "--frozen-lockfile"],
    ["pnpm", "build:packages"],
    ["pnpm", "--filter", "mdbase-editor"],
    ["node", "apps/editor/scripts/verify-deployment-manifest.mjs", "apps/editor/dist/.well-known/mdbase-app.json"]
  ]);
  const deploy = calls.find(({ args }) => args.includes("wrangler"));
  assert.ok(deploy);
  assert.ok(deploy.args.includes("--project-name=mdbase-editor-lab"));
  assert.ok(deploy.args.includes("--branch=candidate-b"));
  assert.ok(deploy.args.includes(`--commit-hash=${commit}`));
  assert.ok(deploy.args.includes("--commit-dirty=true"));
  assert.ok(deploy.args.some((argument) => argument.startsWith("--env-file=/") && argument.endsWith("/empty.env")));
  assert.equal(deploy.environment.CLOUDFLARE_ACCOUNT_ID, accountId);
  assert.equal(deploy.environment.CLOUDFLARE_API_TOKEN, "local-test-token");
  assert.equal(deploy.environment.RENDER_API_KEY, undefined);
  assert.equal(deploy.environment.VITE_UNEXPECTED_SECRET, undefined);
  const build = calls.find(({ args }) => args[0] === "build:packages");
  assert.equal(build.environment.MDBASE_EDITOR_ORIGIN, "https://editor-lab.mdbase.dev");
  assert.equal(build.environment.MDBASE_CONNECT_URL, "https://connect-lab.mdbase.dev");
  assert.equal(build.environment.VITE_MDBASE_BUILD_REVISION, commit);
  assert.equal(build.environment.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(build.environment.RENDER_API_KEY, undefined);
  assert.equal(build.environment.VITE_UNEXPECTED_SECRET, undefined);
  assert.ok(calls.find(({ args }) => args.includes("https://editor-lab.mdbase.dev/.well-known/mdbase-app.json")));
  assert.ok(calls.find(({ args }) => args.includes("apps/editor/scripts/verify-deployment-assets.mjs")));
});

test("local LAB mode rejects revision, release, account, environment, and target overrides before commands", async () => {
  const base = {
    MDBASE_ENV: "lab",
    MDBASE_LAB_LOCAL_MODE: "1",
    MDBASE_LAB_LOCAL_REVISION: commit,
    VITE_MDBASE_BUILD_REVISION: commit
  };
  const cases = [
    { ...base, MDBASE_LAB_LOCAL_REVISION: "short" },
    { ...base, VITE_MDBASE_BUILD_REVISION: "f".repeat(40) },
    { ...base, MDBASE_LAB_RELEASE_MODE: "exact" },
    { ...base, MDBASE_ENV: "staging" },
    { ...base, MDBASE_ENV: "production" },
    { ...base, VITE_MDBASE_ENV: "staging" },
    { ...base, MDBASE_EDITOR_ORIGIN: "https://editor-staging.mdbase.dev" },
    { ...base, MDBASE_CONNECT_URL: "https://connect-staging.mdbase.dev" },
    { ...base, CLOUDFLARE_PAGES_PROJECT: "mdbase-editor" },
    { ...base, CLOUDFLARE_PAGES_BRANCH: "main" },
    { ...base, CLOUDFLARE_ACCOUNT_ID: "f".repeat(32) },
    { ...base, MDBASE_LAB_DEPLOYMENT_REPORT: "/tmp/not-used.json" },
    { ...base, MDBASE_LAB_EXPECTED_COMMIT: commit },
    { ...base, MDBASE_LAB_LOCAL_MODE: "true" },
    { ...base, MDBASE_LAB_LOCAL_MODE: " 1 " },
    { ...base, MDBASE_ENV: undefined }
  ];
  for (const environment of cases) {
    let commands = 0;
    await assert.rejects(deployDevelopmentEditor(environment, async () => { commands += 1; }, {
      capture: async () => { commands += 1; }
    }), /LAB|revision|account|overrides|restricted/iu);
    assert.equal(commands, 0);
  }
});

test("staging remains explicit, pinned, and outside LAB release mode", async () => {
  const calls = [];
  await deployDevelopmentEditor({ MDBASE_ENV: "staging" }, async (command, args, environment) => calls.push({ command, args, environment }));
  const deploy = calls.find(({ args }) => args.includes("wrangler"));
  assert.deepEqual(deploy.args.slice(0, 4), ["exec", "wrangler", "pages", "deploy"]);
  assert.ok(deploy.args.includes("--project-name=mdbase-editor"));
  assert.ok(deploy.args.includes("--branch=staging"));
  await assert.rejects(deployDevelopmentEditor({ MDBASE_ENV: "staging", MDBASE_LAB_RELEASE_MODE: "exact" }), /requires MDBASE_ENV=lab/u);
});

test("exact verifier checks immutable and canonical bytes, revision, headers, and excludes control files", async () => {
  const fixture = await deploymentFixture();
  const requested = [];
  const result = await verifyExactDeployment({
    ...fixture.options,
    fetchImplementation: fixture.fetch(requested)
  });
  assert.deepEqual(result.assertions, {
    homepage: true,
    redirect: true,
    connect_origin: true,
    build_revision: true,
    exact_content: true,
    immutable_origin: deploymentUrl,
    canonical_origin: "https://editor-lab.mdbase.dev"
  });
  assert.deepEqual(result.revision_evidence, { revision: commit, paths: ["assets/main.js"] });
  assert.deepEqual(result.deployments.map(({ origin }) => origin), [deploymentUrl, "https://editor-lab.mdbase.dev"]);
  assert.equal(requested.some((path) => path === "/_headers" || path === "/_redirects"), false);
  assert.equal(requested.filter((path) => path === "/").length, 2);
  assert.equal(requested.includes("/index.html"), false);
  for (const deployment of result.deployments) {
    assert.deepEqual(deployment.files.find(({ path }) => path === "index.html").remote_path, "/");
  }
  assert.deepEqual(result.control_files.map(({ path }) => path), ["_headers", "_redirects"]);
});

test("exact verifier rejects unconfigured implicit HTML routes", async () => {
  const fixture = await deploymentFixture();
  await writeFile(resolve(fixture.options.directory, "about.html"), "<!doctype html>\n");
  await assert.rejects(verifyExactDeployment({
    ...fixture.options,
    fetchImplementation: fixture.fetch([])
  }), /Unsupported implicit Pages HTML route/u);
});

test("exact verifier retries a mixed canonical rollout but rejects persistent stale or redirected origins", async () => {
  const mixed = await deploymentFixture({ canonicalStaleAttempts: 1 });
  let delays = 0;
  await verifyExactDeployment({
    ...mixed.options,
    attempts: 2,
    delayMs: 1,
    delay: async () => { delays += 1; },
    fetchImplementation: mixed.fetch([])
  });
  assert.equal(delays, 1);

  for (const fixture of [
    await deploymentFixture({ immutableStalePath: ".well-known/mdbase-app.json" }),
    await deploymentFixture({ immutableStalePath: "assets/main.js" }),
    await deploymentFixture({ canonicalStaleAttempts: 3 }),
    await deploymentFixture({ redirectEscape: true }),
    await deploymentFixture({ missingHeader: "content-security-policy" })
  ]) {
    await assert.rejects(verifyExactDeployment({
      ...fixture.options,
      attempts: 2,
      delay: async () => undefined,
      fetchImplementation: fixture.fetch([])
    }), /does not match|escaped|missing expected/u);
  }
});

test("exact verifier enforces whole-response deadlines and bounded retries", async () => {
  for (const phase of ["fetch", "body"]) {
    const fixture = await deploymentFixture();
    const ordinaryFetch = fixture.fetch([]);
    let requests = 0;
    let delays = 0;
    await assert.rejects(verifyExactDeployment({
      ...fixture.options,
      attempts: 2,
      requestTimeoutMs: 5,
      delay: async () => { delays += 1; },
      fetchImplementation: async (url, { signal }) => {
        requests += 1;
        if (phase === "fetch") {
          return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true }));
        }
        const response = await ordinaryFetch(url);
        response.arrayBuffer = async () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true }));
        return response;
      }
    }), /deadline/u);
    assert.equal(requests, 2);
    assert.equal(delays, 1);
  }
});

test("success and failure reports bind Q and hashed account identity without raw account output", () => {
  const qualification = { commit, clean: true, repository: "mdbase-dev/mdbase-connect" };
  const deployment = developmentDeployments.lab;
  const success = createSuccessReport({
    qualification,
    deployment,
    wranglerDeployment: { id: deploymentId, url: deploymentUrl },
    wranglerEvidence: { file: "report.json.wrangler.ndjson", sha256: "a".repeat(64), bytes: 10 },
    verification: { revision_evidence: { revision: commit } }
  });
  const failure = createFailureReport({
    qualification,
    deployment,
    stage: "remote-content-verification",
    wranglerDeployment: { id: deploymentId, url: deploymentUrl },
    wranglerEvidence: { file: "report.json.wrangler.ndjson", sha256: "a".repeat(64), bytes: 10 }
  });
  assert.equal(success.source.commit, commit);
  assert.equal(success.deployment.id, deploymentId);
  assert.equal(success.verification.revision_evidence.revision, commit);
  assert.equal(success.target.cloudflare_account_sha256, createHash("sha256").update(accountId).digest("hex"));
  assert.deepEqual(failure.deployment, { id: deploymentId, url: deploymentUrl });
  assert.equal(failure.wrangler_evidence.sha256, "a".repeat(64));
  assert.equal(JSON.stringify([success, failure]).includes(accountId), false);
});

async function deployRootFixture() {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), "mdbase-deploy-root-"));
  const manifestPath = resolve(fixtureRoot, "apps/editor/public/.well-known/mdbase-app.json");
  await mkdir(resolve(manifestPath, ".."), { recursive: true });
  await writeFile(manifestPath, "original\n");
  return fixtureRoot;
}

function reportIo(directory, beforeLink = async () => undefined) {
  let syncCount = 0;
  const syncEvents = [];
  const io = {
    stat: fs.stat,
    lstat: fs.lstat,
    unlink: fs.unlink,
    async link(source, target) {
      await beforeLink(source, target);
      await fs.link(source, target);
    },
    async open(path, ...args) {
      const handle = await fs.open(path, ...args);
      if (path === directory && args[0] === "r") {
        return {
          stat: () => handle.stat(),
          async sync() {
            syncCount += 1;
            syncEvents.push("directory");
            await handle.sync();
          },
          close: () => handle.close()
        };
      }
      if (path.endsWith(".wrangler.ndjson")) {
        return {
          stat: () => handle.stat(),
          read: (...readArgs) => handle.read(...readArgs),
          async sync() {
            syncEvents.push("wrangler-evidence");
            await handle.sync();
          },
          close: () => handle.close()
        };
      }
      return handle;
    }
  };
  return { io, directorySyncs: () => syncCount, syncEvents: () => syncEvents };
}

async function deploymentFixture({ immutableStalePath = null, canonicalStaleAttempts = 0, redirectEscape = false, missingHeader = null } = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), "mdbase-editor-dist-"));
  const canonicalOrigin = "https://editor-lab.mdbase.dev";
  const connectOrigin = "https://connect-lab.mdbase.dev";
  const callback = new URL(`${canonicalOrigin}/`);
  callback.searchParams.set("server", connectOrigin);
  const manifest = {
    homepage: `${canonicalOrigin}/`,
    redirect_uris: [`${canonicalOrigin}/`, callback.href],
    requirements: {
      access: "full_collection",
      capabilities: { required: ["files.list", "files.read"] },
      files: { actions: ["list", "read"], scope: { kind: "collection" } }
    }
  };
  const csp = "default-src 'self'; frame-ancestors 'none'";
  const headersText = `/*\n  Strict-Transport-Security: max-age=31536000; includeSubDomains\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: camera=(), geolocation=(), microphone=(), payment=(), usb=()\n  Content-Security-Policy: ${csp}\n\n/.well-known/mdbase-app.json\n  Cache-Control: no-store\n\n/assets/*\n  Cache-Control: public, max-age=0, must-revalidate\n`;
  const files = new Map([
    [".well-known/mdbase-app.json", Buffer.from(`${JSON.stringify(manifest)}\n`)],
    ["assets/main.js", Buffer.from(`globalThis.revision="${commit}";\n`)],
    ["index.html", Buffer.from("<!doctype html>\n")],
    ["_headers", Buffer.from(headersText)],
    ["_redirects", Buffer.from("# no redirects\n")]
  ]);
  for (const [path, content] of files) {
    const target = resolve(directory, path);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  let canonicalFailuresRemaining = canonicalStaleAttempts;
  return {
    options: {
      directory,
      origins: [deploymentUrl, canonicalOrigin],
      canonicalOrigin,
      connectOrigin,
      buildRevision: commit,
      requestTimeoutMs: 100,
      cacheKey: () => "fixed"
    },
    fetch: (requested) => async (url) => {
      const remotePath = decodeURIComponent(url.pathname);
      const path = remotePath === "/" ? "index.html" : remotePath.slice(1);
      requested.push(remotePath);
      const content = files.get(path);
      const globalHeaders = {
        "strict-transport-security": "max-age=31536000; includeSubDomains",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "strict-origin-when-cross-origin",
        "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
        "content-security-policy": csp
      };
      if (path === ".well-known/mdbase-app.json") globalHeaders["cache-control"] = "no-store";
      if (path.startsWith("assets/")) globalHeaders["cache-control"] = "public, max-age=0, must-revalidate";
      if (missingHeader) delete globalHeaders[missingHeader];
      let body = content;
      if (url.origin === deploymentUrl && immutableStalePath === path) body = Buffer.concat([body, Buffer.from("stale")]);
      if (url.origin === canonicalOrigin && canonicalFailuresRemaining > 0) {
        canonicalFailuresRemaining -= 1;
        body = Buffer.concat([body, Buffer.from("stale")]);
      }
      return {
        ok: true,
        status: 200,
        url: redirectEscape ? `https://escape.example${remotePath}` : `${url.origin}${remotePath}`,
        headers: new Headers(globalHeaders),
        arrayBuffer: async () => body
      };
    }
  };
}
