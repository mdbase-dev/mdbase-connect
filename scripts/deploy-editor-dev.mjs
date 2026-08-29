import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertEditorManifest } from "../apps/editor/scripts/verify-deployment-manifest.mjs";
import { managedEnvironments, normalizedEndpointOrigin } from "./lib/managed-environments.mjs";

const wranglerVersion = "4.114.0";
const releaseMode = "exact";
const sourceRepository = "mdbase-dev/mdbase-connect";
const requestTimeoutMs = 10_000;
const inheritedCommandEnvironment = Object.freeze([
  "HOME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "LOGNAME",
  "CI",
  "COREPACK_HOME",
  "PNPM_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME"
]);

export const developmentDeployments = Object.freeze({
  lab: Object.freeze({
    ...managedEnvironments.lab,
    project: "mdbase-editor-lab",
    branch: "candidate-b",
    wranglerVersion
  }),
  staging: Object.freeze({
    ...managedEnvironments.staging,
    project: "mdbase-editor",
    branch: "staging",
    wranglerVersion
  })
});
export const developmentDeployment = developmentDeployments.lab;

const repoRoot = resolve(import.meta.dirname, "..");
assertDeploymentIsolation();

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await deployDevelopmentEditor(process.env);
}

export async function deployDevelopmentEditor(
  environment,
  run = runCommand,
  {
    capture = captureCommand,
    root = repoRoot,
    verify = verifyExactDeployment,
    reserveReport = reservePrivateJsonReport
  } = {}
) {
  const target = environment.MDBASE_ENV?.trim() || "lab";
  if (target !== "lab" && target !== "staging") {
    throw new Error("Development editor deployments are restricted to lab and staging.");
  }
  const deployment = developmentDeployments[target];
  const localLabMode = environment.MDBASE_LAB_LOCAL_MODE === "1";
  if (environment.MDBASE_LAB_LOCAL_MODE !== undefined && !localLabMode) {
    throw new Error("MDBASE_LAB_LOCAL_MODE must be 1 when supplied.");
  }
  const exactLabRelease = environment.MDBASE_LAB_RELEASE_MODE?.trim() === releaseMode;
  if (environment.MDBASE_LAB_RELEASE_MODE && !exactLabRelease) {
    throw new Error(`MDBASE_LAB_RELEASE_MODE must be ${releaseMode}.`);
  }
  if (localLabMode && environment.MDBASE_ENV?.trim() !== "lab") {
    throw new Error("Local LAB mode requires explicit MDBASE_ENV=lab.");
  }
  if (localLabMode && exactLabRelease) {
    throw new Error("Local LAB mode cannot be combined with exact LAB release mode.");
  }
  if (exactLabRelease && target !== "lab") {
    throw new Error("Exact LAB release mode requires MDBASE_ENV=lab.");
  }
  if (target === "lab" && !exactLabRelease && !localLabMode) {
    throw new Error(
      "LAB deployment requires MDBASE_LAB_RELEASE_MODE=exact or MDBASE_LAB_LOCAL_MODE=1."
    );
  }
  rejectTargetOverrides(environment, target, deployment, localLabMode);

  if (localLabMode) {
    return deployLocalLabEditor(environment, deployment, run, root);
  }
  if (!exactLabRelease) {
    return deployStagingEditor(environment, deployment, run, root);
  }

  const qualification = await qualifyExactLabRelease(environment, capture, root);
  const reportReservation = await reserveReport(qualification.reportPath, root);
  const manifestPath = resolve(root, "apps/editor/public/.well-known/mdbase-app.json");
  let stage = "source-manifest-read";
  let previousManifest;
  let wranglerDeployment;
  let wranglerEvidence;
  try {
    previousManifest = await readFile(manifestPath);
    const buildEnvironment = exactBuildEnvironment(environment, deployment, qualification.commit);

    stage = "dependency-install";
    await run("pnpm", ["install", "--frozen-lockfile"], buildEnvironment);
    stage = "package-build";
    await run("pnpm", ["build:packages"], buildEnvironment);
    stage = "editor-build";
    await run("pnpm", ["--filter", "mdbase-editor", "build"], buildEnvironment);
    stage = "local-manifest-verification";
    await run(
      "node",
      [
        "apps/editor/scripts/verify-deployment-manifest.mjs",
        "apps/editor/dist/.well-known/mdbase-app.json",
        `${deployment.editorOrigin}/`,
        deployment.connectOrigin
      ],
      buildEnvironment
    );

    stage = "wrangler-deploy";
    const wranglerResult = await runExactWranglerDeployment({
      capture,
      root,
      deployment,
      qualification,
      environment,
      reportReservation
    });
    wranglerDeployment = wranglerResult.deployment;
    wranglerEvidence = wranglerResult.evidence;
    stage = "remote-content-verification";
    const verification = await verify({
      directory: resolve(root, "apps/editor/dist"),
      origins: [wranglerDeployment.url, deployment.editorOrigin],
      canonicalOrigin: deployment.editorOrigin,
      connectOrigin: deployment.connectOrigin,
      buildRevision: qualification.commit,
      attempts: 61,
      delayMs: 5000,
      requestTimeoutMs
    });
    stage = "source-manifest-restore";
    await writeFile(manifestPath, previousManifest);
    previousManifest = undefined;

    stage = "success-report";
    await reportReservation.commit(createSuccessReport({
      qualification,
      deployment,
      wranglerDeployment,
      wranglerEvidence,
      verification
    }));
    console.log(`LAB editor deployed: ${deployment.editorOrigin}/`);
  } catch (error) {
    if (error.failureStage) stage = error.failureStage;
    if (error.wranglerEvidence) wranglerEvidence = error.wranglerEvidence;
    if (previousManifest !== undefined) {
      try {
        await writeFile(manifestPath, previousManifest);
      } catch {
        stage = "source-manifest-restore";
      }
    }
    try {
      await reportReservation.commit(createFailureReport({
        qualification,
        deployment,
        stage,
        wranglerDeployment,
        wranglerEvidence: wranglerEvidence ?? await reportReservation.wranglerEvidence()
      }));
    } catch (reportError) {
      throw new AggregateError([error, reportError], "LAB deployment failed and its reserved report could not be finalized.");
    }
    throw error;
  } finally {
    await reportReservation.close();
  }
}

async function deployLocalLabEditor(environment, deployment, run, root) {
  const revision = environment.MDBASE_LAB_LOCAL_REVISION?.trim() ?? "";
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error("MDBASE_LAB_LOCAL_REVISION must be a full lowercase 40-hex commit.");
  }
  if (environment.VITE_MDBASE_BUILD_REVISION?.trim() !== revision) {
    throw new Error("VITE_MDBASE_BUILD_REVISION must equal MDBASE_LAB_LOCAL_REVISION.");
  }
  if (
    environment.CLOUDFLARE_ACCOUNT_ID !== undefined
    && environment.CLOUDFLARE_ACCOUNT_ID.trim() !== deployment.cloudflareAccountId
  ) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID does not match the statically managed LAB account.");
  }

  const manifestPath = resolve(root, "apps/editor/public/.well-known/mdbase-app.json");
  const previousManifest = await readFile(manifestPath);
  let temporaryDirectory;
  const deploymentEnvironment = localLabBuildEnvironment(environment, deployment, revision);
  const wranglerCommandEnvironment = minimalEnvironment(environment, {
    CLOUDFLARE_ACCOUNT_ID: deployment.cloudflareAccountId,
    CLOUDFLARE_API_TOKEN: environment.CLOUDFLARE_API_TOKEN,
    WRANGLER_SEND_METRICS: "false"
  });
  try {
    await run("pnpm", ["install", "--frozen-lockfile"], deploymentEnvironment);
    await run("pnpm", ["build:packages"], deploymentEnvironment);
    await run("pnpm", ["--filter", "mdbase-editor", "build"], deploymentEnvironment);
    await run("node", [
      "apps/editor/scripts/verify-deployment-manifest.mjs",
      "apps/editor/dist/.well-known/mdbase-app.json",
      `${deployment.editorOrigin}/`,
      deployment.connectOrigin
    ], deploymentEnvironment);
    temporaryDirectory = await mkdtemp(resolve(tmpdir(), "mdbase-wrangler-local-"));
    await chmod(temporaryDirectory, 0o700);
    const emptyEnvironmentPath = resolve(temporaryDirectory, "empty.env");
    const emptyEnvironmentHandle = await open(emptyEnvironmentPath, "wx", 0o600);
    await emptyEnvironmentHandle.close();
    await run("pnpm", [
      "exec",
      "wrangler",
      "pages",
      "deploy",
      "apps/editor/dist",
      `--project-name=${deployment.project}`,
      `--branch=${deployment.branch}`,
      `--commit-hash=${revision}`,
      "--commit-dirty=true",
      `--env-file=${emptyEnvironmentPath}`
    ], wranglerCommandEnvironment);
    await run("node", [
      "apps/editor/scripts/verify-deployment-manifest.mjs",
      `${deployment.editorOrigin}/.well-known/mdbase-app.json`,
      `${deployment.editorOrigin}/`,
      deployment.connectOrigin
    ], {
      ...deploymentEnvironment,
      MDBASE_MANIFEST_VERIFY_ATTEMPTS: "12",
      MDBASE_MANIFEST_VERIFY_DELAY_MS: "5000"
    });
    await run("node", [
      "apps/editor/scripts/verify-deployment-assets.mjs",
      "apps/editor/dist/assets",
      `${deployment.editorOrigin}/`
    ], {
      ...deploymentEnvironment,
      MDBASE_ASSET_VERIFY_ATTEMPTS: "61",
      MDBASE_ASSET_VERIFY_DELAY_MS: "5000"
    });
  } finally {
    await writeFile(manifestPath, previousManifest);
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
  console.log(`LAB editor deployed: ${deployment.editorOrigin}/`);
}

async function deployStagingEditor(environment, deployment, run, root) {
  const requestedOrigin = environment.MDBASE_CONNECT_URL?.trim()
    ? normalizedEndpointOrigin(environment.MDBASE_CONNECT_URL, "MDBASE_CONNECT_URL")
    : undefined;
  if (requestedOrigin && requestedOrigin !== deployment.connectOrigin) {
    throw new Error("MDBASE_CONNECT_URL does not match the staging environment.");
  }
  const manifestPath = resolve(root, "apps/editor/public/.well-known/mdbase-app.json");
  const previousManifest = await readFile(manifestPath);
  const deploymentEnvironment = {
    ...environment,
    MDBASE_ENV: "staging",
    VITE_MDBASE_ENV: "staging",
    MDBASE_EDITOR_ORIGIN: deployment.editorOrigin,
    MDBASE_EDITOR_BASE_PATH: "/",
    MDBASE_CONNECT_URL: deployment.connectOrigin,
    VITE_MDBASE_CONNECT_URL: deployment.connectOrigin
  };
  try {
    await run("pnpm", ["build:packages"], deploymentEnvironment);
    await run("pnpm", ["--filter", "mdbase-editor", "build"], deploymentEnvironment);
    await run("node", [
      "apps/editor/scripts/verify-deployment-manifest.mjs",
      "apps/editor/dist/.well-known/mdbase-app.json",
      `${deployment.editorOrigin}/`,
      deployment.connectOrigin
    ], deploymentEnvironment);
    await run("pnpm", [
      "exec",
      "wrangler",
      "pages",
      "deploy",
      "apps/editor/dist",
      `--project-name=${deployment.project}`,
      `--branch=${deployment.branch}`
    ], deploymentEnvironment);
    await run("node", [
      "apps/editor/scripts/verify-deployment-manifest.mjs",
      `${deployment.editorOrigin}/.well-known/mdbase-app.json`,
      `${deployment.editorOrigin}/`,
      deployment.connectOrigin
    ], {
      ...deploymentEnvironment,
      MDBASE_MANIFEST_VERIFY_ATTEMPTS: "12",
      MDBASE_MANIFEST_VERIFY_DELAY_MS: "5000"
    });
    await run("node", [
      "apps/editor/scripts/verify-deployment-assets.mjs",
      "apps/editor/dist/assets",
      `${deployment.editorOrigin}/`
    ], {
      ...deploymentEnvironment,
      MDBASE_ASSET_VERIFY_ATTEMPTS: "61",
      MDBASE_ASSET_VERIFY_DELAY_MS: "5000"
    });
  } finally {
    await writeFile(manifestPath, previousManifest);
  }
  console.log(`STAGING editor deployed: ${deployment.editorOrigin}/`);
}

export async function qualifyExactLabRelease(environment, capture, root = repoRoot) {
  const expected = environment.MDBASE_LAB_EXPECTED_COMMIT?.trim() ?? "";
  if (!/^[0-9a-f]{40}$/u.test(expected)) {
    throw new Error("MDBASE_LAB_EXPECTED_COMMIT must be a full lowercase 40-hex commit.");
  }
  if (environment.VITE_MDBASE_BUILD_REVISION?.trim() !== expected) {
    throw new Error("VITE_MDBASE_BUILD_REVISION must equal MDBASE_LAB_EXPECTED_COMMIT.");
  }
  if (environment.CLOUDFLARE_ACCOUNT_ID?.trim() !== managedEnvironments.lab.cloudflareAccountId) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID does not match the statically managed LAB account.");
  }
  const reportPath = environment.MDBASE_LAB_DEPLOYMENT_REPORT?.trim() ?? "";
  if (!reportPath || !isAbsolute(reportPath)) {
    throw new Error("MDBASE_LAB_DEPLOYMENT_REPORT must be a caller-supplied absolute path.");
  }
  if (isWithin(root, reportPath)) {
    throw new Error("MDBASE_LAB_DEPLOYMENT_REPORT must be outside the source repository.");
  }

  const guardEnvironment = minimalEnvironment(environment, {});
  const [headOutput, statusOutput, originOutput] = await Promise.all([
    capture("git", ["rev-parse", "HEAD"], { cwd: root, env: guardEnvironment }),
    capture("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, env: guardEnvironment }),
    capture("git", ["remote", "get-url", "origin"], { cwd: root, env: guardEnvironment, sensitiveOutput: true })
  ]);
  const head = headOutput.trim();
  if (head !== expected) throw new Error(`HEAD ${head || "<missing>"} does not equal the expected LAB commit.`);
  if (statusOutput.length !== 0) {
    throw new Error("Exact LAB release requires a clean worktree, including no untracked files.");
  }
  const repository = repositoryIdentity(originOutput.trim());
  if (repository !== sourceRepository) throw new Error(`origin must identify ${sourceRepository}.`);
  return { commit: expected, clean: true, repository, reportPath };
}

async function runExactWranglerDeployment({ capture, root, deployment, qualification, environment, reportReservation }) {
  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "mdbase-wrangler-env-"));
  await chmod(temporaryDirectory, 0o700);
  const emptyEnvironmentPath = resolve(temporaryDirectory, "empty.env");
  const emptyEnvironmentHandle = await open(emptyEnvironmentPath, "wx", 0o600);
  await emptyEnvironmentHandle.close();
  const args = [
    "exec",
    "wrangler",
    "pages",
    "deploy",
    "apps/editor/dist",
    `--project-name=${deployment.project}`,
    `--branch=${deployment.branch}`,
    `--commit-hash=${qualification.commit}`,
    "--commit-dirty=false",
    `--env-file=${emptyEnvironmentPath}`
  ];
  try {
    try {
      await capture("pnpm", args, {
        cwd: root,
        env: wranglerEnvironment(environment, reportReservation.wranglerOutputPath),
        sensitiveOutput: true
      });
    } catch (error) {
      error.failureStage = "wrangler-deploy";
      error.wranglerEvidence = await reportReservation.wranglerEvidence();
      throw error;
    }
    const snapshot = await reportReservation.readWranglerEvidence();
    try {
      const parsedDeployment = parseWranglerDeploymentOutput(snapshot.content.toString("utf8"), {
        project: deployment.project,
        branch: deployment.branch,
        commit: qualification.commit,
        wranglerArgs: args.slice(2)
      });
      return { deployment: parsedDeployment, evidence: snapshot.evidence };
    } catch (error) {
      error.failureStage = "wrangler-output-contract";
      error.wranglerEvidence = snapshot.evidence;
      throw error;
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function parseWranglerDeploymentOutput(output, expected) {
  const lines = output.split("\n").filter((line) => line.length > 0);
  let entries;
  try {
    entries = lines.map((line) => JSON.parse(line));
  } catch {
    throw new Error("Wrangler output file is not valid NDJSON.");
  }
  const sessions = entries.filter(({ type }) => type === "wrangler-session");
  const simple = entries.filter(({ type }) => type === "pages-deploy");
  const detailed = entries.filter(({ type }) => type === "pages-deploy-detailed");
  if (entries.length !== 3 || sessions.length !== 1 || simple.length !== 1 || detailed.length !== 1) {
    throw new Error("Wrangler output must contain exactly one matching session, simple deployment, and detailed deployment entry.");
  }
  const session = sessions[0];
  const summary = simple[0];
  const detail = detailed[0];
  if (session.version !== 1 || session.wrangler_version !== wranglerVersion) {
    throw new Error(`Wrangler session must identify version ${wranglerVersion}.`);
  }
  if (!Array.isArray(session.command_line_args) || session.command_line_args.join("\0") !== expected.wranglerArgs.join("\0")) {
    throw new Error("Wrangler session command does not match the qualified Pages deployment.");
  }
  if (detail.version !== 1 || detail.pages_project !== expected.project || detail.environment !== "production" || detail.production_branch !== expected.branch || detail.deployment_trigger?.metadata?.commit_hash !== expected.commit) {
    throw new Error("Wrangler detailed deployment does not match the qualified LAB target and commit.");
  }
  const id = detail.deployment_id;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id ?? "")) {
    throw new Error("Wrangler detailed deployment ID must be one UUID.");
  }
  const url = deploymentUrl(detail.url, id, expected.project);
  if (summary.version !== 1 || summary.pages_project !== expected.project || summary.deployment_id !== id || summary.url !== detail.url) {
    throw new Error("Wrangler simple deployment entry does not match its detailed entry.");
  }
  return { id, url };
}

function deploymentUrl(value, id, project) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Wrangler detailed deployment URL is invalid.");
  }
  const expectedHost = `${id.slice(0, 8)}.${project}.pages.dev`;
  if (url.protocol !== "https:" || url.username || url.password || url.hostname !== expectedHost || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Wrangler deployment URL is not bound to its deployment ID and Pages project.");
  }
  return url.origin;
}

export async function verifyExactDeployment({
  directory,
  origins,
  canonicalOrigin,
  connectOrigin,
  buildRevision,
  attempts = 1,
  delayMs = 0,
  requestTimeoutMs: timeoutMs = requestTimeoutMs,
  fetchImplementation = fetch,
  cacheKey = () => randomUUID(),
  delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}) {
  const { files, controls } = await deploymentFiles(directory);
  if (files.length === 0) throw new Error(`No deployment files found in ${directory}.`);
  const manifestEntry = files.find(({ path }) => path === ".well-known/mdbase-app.json");
  if (!manifestEntry) throw new Error("Local deployment is missing .well-known/mdbase-app.json.");
  const expectedHomepage = `${canonicalOrigin}/`;
  const localManifest = parseManifest(manifestEntry.content, "Local");
  assertEditorManifest(localManifest, expectedHomepage, connectOrigin);
  const revisionPaths = files.filter(({ content }) => content.includes(buildRevision)).map(({ path }) => path);
  if (revisionPaths.length === 0) throw new Error("Local deployment content does not contain the exact build revision.");
  const headerPolicy = validateControlFiles(controls);

  const results = [];
  for (const origin of origins) {
    let failure;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const verified = [];
        const deployedContent = new Map();
        for (const file of files) {
          const remotePath = remoteDeploymentPath(file.path);
          const url = new URL(remotePath, `${origin}/`);
          url.searchParams.set("deployment-check", cacheKey(attempt, origin, file.path));
          const actual = await withRequestDeadline(fetchImplementation, url, timeoutMs, async (response) => {
            if (!response.ok) throw new Error(`${file.path} at ${origin} returned HTTP ${response.status}.`);
            const finalUrl = new URL(response.url || url);
            if (finalUrl.origin !== origin || finalUrl.pathname !== remotePath) {
              throw new Error(`${file.path} escaped the expected deployment origin or path.`);
            }
            assertRemoteHeaders(response.headers, file.path, headerPolicy);
            return Buffer.from(await response.arrayBuffer());
          });
          if (!actual.equals(file.content)) throw new Error(`${file.path} at ${origin} does not match local deployment content.`);
          deployedContent.set(file.path, actual);
          verified.push({ path: file.path, remote_path: remotePath, sha256: sha256(actual), bytes: actual.length });
        }
        const remoteManifest = parseManifest(deployedContent.get(manifestEntry.path), "Remote");
        assertEditorManifest(remoteManifest, expectedHomepage, connectOrigin);
        const remoteRevisionPaths = revisionPaths.filter((path) => deployedContent.get(path)?.includes(buildRevision));
        if (remoteRevisionPaths.length !== revisionPaths.length) throw new Error(`Remote deployment at ${origin} does not contain revision ${buildRevision}.`);
        results.push({ origin, files: verified });
        failure = undefined;
        break;
      } catch (error) {
        failure = error;
        if (attempt < attempts) await delay(delayMs);
      }
    }
    if (failure) throw failure;
  }
  return {
    assertions: {
      homepage: true,
      redirect: true,
      connect_origin: true,
      build_revision: true,
      exact_content: true,
      immutable_origin: origins[0],
      canonical_origin: origins[1]
    },
    revision_evidence: { revision: buildRevision, paths: revisionPaths },
    control_files: controls.map(({ path, content }) => ({ path, sha256: sha256(content), bytes: content.length })),
    deployments: results
  };
}

function remoteDeploymentPath(localPath) {
  if (localPath === "index.html") return "/";
  if (localPath.endsWith(".html")) {
    throw new Error(`Unsupported implicit Pages HTML route ${localPath}.`);
  }
  return `/${localPath.split("/").map(encodeURIComponent).join("/")}`;
}

async function withRequestDeadline(fetchImplementation, url, timeoutMs, consume) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImplementation(url, { cache: "no-store", redirect: "follow", signal: controller.signal });
    return await consume(response);
  } finally {
    clearTimeout(timer);
  }
}

function validateControlFiles(controls) {
  const unsupported = controls.filter(({ path }) => !["_headers", "_redirects"].includes(path));
  if (unsupported.length > 0) throw new Error(`Unsupported Pages control file ${unsupported[0].path}.`);
  const redirects = controls.find(({ path }) => path === "_redirects");
  if (redirects && redirects.content.toString("utf8").split("\n").some((line) => line.trim() && !line.trim().startsWith("#"))) {
    throw new Error("LAB deployment does not allow Pages redirect rules.");
  }
  const headers = controls.find(({ path }) => path === "_headers");
  if (!headers) throw new Error("Local deployment is missing the required _headers policy.");
  const sections = parseHeadersFile(headers.content.toString("utf8"));
  const global = sections.get("/*");
  const manifest = sections.get("/.well-known/mdbase-app.json");
  const assets = sections.get("/assets/*");
  const requiredGlobal = new Map([
    ["strict-transport-security", "max-age=31536000; includeSubDomains"],
    ["x-content-type-options", "nosniff"],
    ["x-frame-options", "DENY"],
    ["referrer-policy", "strict-origin-when-cross-origin"],
    ["permissions-policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()"]
  ]);
  for (const [name, value] of requiredGlobal) {
    if (global?.get(name) !== value) throw new Error(`_headers must define exact ${name}.`);
  }
  const csp = global?.get("content-security-policy");
  if (!csp || !csp.includes("default-src 'self'") || !csp.includes("frame-ancestors 'none'")) {
    throw new Error("_headers must define the expected Content-Security-Policy.");
  }
  if (manifest?.get("cache-control") !== "no-store") throw new Error("Manifest must use Cache-Control: no-store.");
  if (assets?.get("cache-control") !== "public, max-age=0, must-revalidate") {
    throw new Error("Assets must use the expected revalidation cache policy.");
  }
  return { global: new Map([...requiredGlobal, ["content-security-policy", csp]]), manifest, assets };
}

function parseHeadersFile(source) {
  const sections = new Map();
  let current;
  for (const rawLine of source.split("\n")) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    if (!/^\s/u.test(rawLine)) {
      const route = rawLine.trim();
      if (sections.has(route)) throw new Error(`_headers contains duplicate route ${route}.`);
      current = new Map();
      sections.set(route, current);
      continue;
    }
    const separator = rawLine.indexOf(":");
    if (!current || separator < 0) throw new Error("_headers contains malformed syntax.");
    const name = rawLine.slice(0, separator).trim().toLowerCase();
    if (current.has(name)) throw new Error(`_headers contains duplicate header ${name}.`);
    current.set(name, rawLine.slice(separator + 1).trim());
  }
  return sections;
}

function assertRemoteHeaders(headers, path, policy) {
  for (const [name, expected] of policy.global) {
    if (headers.get(name) !== expected) throw new Error(`${path} is missing expected ${name}.`);
  }
  if (path === ".well-known/mdbase-app.json" && headers.get("cache-control") !== policy.manifest.get("cache-control")) {
    throw new Error("Remote manifest cache policy does not match _headers.");
  }
  if (path.startsWith("assets/") && headers.get("cache-control") !== policy.assets.get("cache-control")) {
    throw new Error("Remote asset cache policy does not match _headers.");
  }
}

export function createSuccessReport({ qualification, deployment, wranglerDeployment, wranglerEvidence, verification }) {
  return {
    format: "mdbase-editor-lab-deployment/v1",
    status: "success",
    environment: "lab",
    source: { repository: qualification.repository, commit: qualification.commit, clean: qualification.clean },
    target: reportTarget(deployment),
    deployment: wranglerDeployment,
    wrangler_evidence: wranglerEvidence,
    verification
  };
}

export function createFailureReport({ qualification, deployment, stage, wranglerDeployment, wranglerEvidence }) {
  return {
    format: "mdbase-editor-lab-deployment/v1",
    status: "failure",
    environment: "lab",
    source: { repository: qualification.repository, commit: qualification.commit, clean: qualification.clean },
    target: reportTarget(deployment),
    ...(wranglerDeployment ? { deployment: wranglerDeployment } : {}),
    wrangler_evidence: wranglerEvidence,
    failure: { stage }
  };
}

function reportTarget(deployment) {
  return {
    project: deployment.project,
    branch: deployment.branch,
    editor_origin: deployment.editorOrigin,
    connect_origin: deployment.connectOrigin,
    cloudflare_account_sha256: sha256(managedEnvironments.lab.cloudflareAccountId)
  };
}

const reportFileSystem = Object.freeze({ open, stat, lstat, link, unlink });

export async function reservePrivateJsonReport(path, root = repoRoot, io = reportFileSystem) {
  if (!isAbsolute(path) || isWithin(root, path)) throw new Error("Deployment report path must be absolute and outside the source repository.");
  const parent = dirname(path);
  const parentStat = await io.stat(parent);
  const parentLinkStat = await io.lstat(parent);
  if (parentLinkStat.isSymbolicLink() || !parentStat.isDirectory() || parentStat.uid !== process.getuid() || (parentStat.mode & 0o022) !== 0) {
    throw new Error("Deployment report parent must be a real operator-owned directory without group/world write access.");
  }
  const wranglerOutputPath = `${path}.wrangler.ndjson`;
  await assertPathAbsent(io, path, "Deployment report already exists.");
  await assertPathAbsent(io, wranglerOutputPath, "Wrangler evidence already exists.");
  const parentHandle = await io.open(parent, "r");
  const parentIdentity = await parentHandle.stat();
  const sidecarPath = `${path}.reserve`;
  let sidecarHandle;
  try {
    sidecarHandle = await io.open(sidecarPath, "wx", 0o600);
  } catch (error) {
    await parentHandle.close();
    throw error;
  }
  const sidecarIdentity = await sidecarHandle.stat();
  let wranglerOutputHandle;
  try {
    wranglerOutputHandle = await io.open(wranglerOutputPath, "wx+", 0o600);
    await wranglerOutputHandle.sync();
    await parentHandle.sync();
  } catch (error) {
    if (wranglerOutputHandle) {
      await wranglerOutputHandle.close();
      await io.unlink(wranglerOutputPath);
    }
    await sidecarHandle.close();
    await io.unlink(sidecarPath);
    await parentHandle.sync();
    await parentHandle.close();
    throw error;
  }
  let sidecarPresent = true;
  let committed = false;

  async function readWranglerEvidence() {
    await wranglerOutputHandle.sync();
    const identity = await wranglerOutputHandle.stat();
    const content = Buffer.alloc(identity.size);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await wranglerOutputHandle.read(content, offset, content.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== content.length) throw new Error("Could not read complete Wrangler evidence.");
    return {
      content,
      evidence: { file: basename(wranglerOutputPath), sha256: sha256(content), bytes: content.length }
    };
  }

  return {
    wranglerOutputPath,
    readWranglerEvidence,
    async wranglerEvidence() {
      return (await readWranglerEvidence()).evidence;
    },
    async commit(value) {
      if (committed) throw new Error("Deployment report reservation is already finalized.");
      await assertDirectoryIdentity(io, parent, parentIdentity);
      const currentSidecar = await io.lstat(sidecarPath);
      if (!currentSidecar.isFile() || currentSidecar.dev !== sidecarIdentity.dev || currentSidecar.ino !== sidecarIdentity.ino) {
        throw new Error("Deployment report reservation identity changed.");
      }
      const temporaryPath = `${path}.tmp-${randomUUID()}`;
      let temporaryPresent = false;
      try {
        const temporary = await io.open(temporaryPath, "wx", 0o600);
        temporaryPresent = true;
        try {
          await temporary.writeFile(`${JSON.stringify(value, null, 2)}\n`);
          await temporary.sync();
        } finally {
          await temporary.close();
        }
        await io.link(temporaryPath, path);
        await parentHandle.sync();
        await io.unlink(temporaryPath);
        temporaryPresent = false;
        await io.unlink(sidecarPath);
        sidecarPresent = false;
        await parentHandle.sync();
        committed = true;
      } finally {
        if (temporaryPresent) {
          try {
            await io.unlink(temporaryPath);
            await parentHandle.sync();
          } catch {
            // Preserve the primary publication failure; close() still cleans the reservation.
          }
        }
      }
    },
    async close() {
      await wranglerOutputHandle.sync();
      await wranglerOutputHandle.close();
      await sidecarHandle.close();
      if (sidecarPresent) {
        try {
          const current = await io.lstat(sidecarPath);
          if (current.dev === sidecarIdentity.dev && current.ino === sidecarIdentity.ino) {
            await io.unlink(sidecarPath);
            await parentHandle.sync();
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      await parentHandle.close();
    }
  };
}

async function assertPathAbsent(io, path, message) {
  try {
    await io.lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(message);
}

async function assertDirectoryIdentity(io, path, identity) {
  const current = await io.stat(path);
  if (current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error("Deployment report parent identity changed after reservation.");
  }
}

function localLabBuildEnvironment(environment, deployment, revision) {
  return minimalEnvironment(environment, {
    MDBASE_ENV: "lab",
    VITE_MDBASE_ENV: "lab",
    MDBASE_EDITOR_ORIGIN: deployment.editorOrigin,
    MDBASE_EDITOR_BASE_PATH: "/",
    MDBASE_CONNECT_URL: deployment.connectOrigin,
    VITE_MDBASE_CONNECT_URL: deployment.connectOrigin,
    VITE_MDBASE_BUILD_REVISION: revision
  });
}

function exactBuildEnvironment(environment, deployment, commit) {
  return minimalEnvironment(environment, {
    MDBASE_ENV: "lab",
    VITE_MDBASE_ENV: "lab",
    MDBASE_EDITOR_ORIGIN: deployment.editorOrigin,
    MDBASE_EDITOR_BASE_PATH: "/",
    MDBASE_CONNECT_URL: deployment.connectOrigin,
    VITE_MDBASE_CONNECT_URL: deployment.connectOrigin,
    VITE_MDBASE_BUILD_REVISION: commit
  });
}

function wranglerEnvironment(environment, outputPath) {
  return minimalEnvironment(environment, {
    CLOUDFLARE_ACCOUNT_ID: managedEnvironments.lab.cloudflareAccountId,
    CLOUDFLARE_API_TOKEN: environment.CLOUDFLARE_API_TOKEN,
    WRANGLER_OUTPUT_FILE_PATH: outputPath,
    WRANGLER_SEND_METRICS: "false"
  });
}

function minimalEnvironment(source, additions) {
  const result = {};
  for (const name of inheritedCommandEnvironment) {
    if (source[name] !== undefined) result[name] = source[name];
  }
  for (const [name, value] of Object.entries(additions)) {
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function rejectTargetOverrides(environment, target, deployment, localLabMode = false) {
  const forbidden = ["CLOUDFLARE_PAGES_PROJECT", "CLOUDFLARE_PAGES_BRANCH", "MDBASE_EDITOR_ORIGIN", "MDBASE_EDITOR_BASE_PATH"];
  if (target === "lab") forbidden.push("MDBASE_CONNECT_URL", "VITE_MDBASE_CONNECT_URL");
  if (localLabMode) forbidden.push("VITE_MDBASE_ENV", "MDBASE_LAB_EXPECTED_COMMIT", "MDBASE_LAB_DEPLOYMENT_REPORT");
  const supplied = forbidden.filter((name) => environment[name] !== undefined);
  if (supplied.length > 0) throw new Error(`${target.toUpperCase()} deployment target overrides are forbidden: ${supplied.join(", ")}.`);
  if (!deployment.project || !deployment.branch || !deployment.editorOrigin || !deployment.connectOrigin) {
    throw new Error(`${target.toUpperCase()} deployment target is not statically configured.`);
  }
}

function assertDeploymentIsolation() {
  const lab = developmentDeployments.lab;
  const staging = developmentDeployments.staging;
  const production = { ...managedEnvironments.production, project: "mdbase-editor", branch: "main" };
  for (const [name, other] of [["staging", staging], ["production", production]]) {
    for (const property of ["branch", "editorOrigin", "connectOrigin"]) {
      if (lab[property] === other[property]) throw new Error(`LAB ${property} must be disjoint from ${name}.`);
    }
    if (lab.project === other.project) throw new Error(`LAB Pages project must be disjoint from ${name}.`);
  }
}

function repositoryIdentity(value) {
  return new Map([
    ["https://github.com/mdbase-dev/mdbase-connect.git", sourceRepository],
    ["https://github.com/mdbase-dev/mdbase-connect", sourceRepository],
    ["git@github.com:mdbase-dev/mdbase-connect.git", sourceRepository],
    ["ssh://git@github.com/mdbase-dev/mdbase-connect.git", sourceRepository]
  ]).get(value) ?? null;
}

async function deploymentFiles(directory) {
  const files = [];
  const controls = [];
  async function walk(current, prefix) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = resolve(current, entry.name);
      if (entry.isDirectory()) await walk(absolute, path);
      else if (entry.isFile()) {
        const target = path === "_headers" || path === "_redirects" ? controls : files;
        target.push({ path, content: await readFile(absolute) });
      } else throw new Error(`Deployment contains unsupported filesystem entry ${path}.`);
    }
  }
  await walk(directory, "");
  return { files, controls };
}

function parseManifest(content, label) {
  try {
    return JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error(`${label} deployment manifest is not valid JSON.`);
  }
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function isWithin(root, path) {
  const fromRoot = relative(resolve(root), resolve(path));
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== "..");
}

async function runCommand(command, args, env) {
  await spawnCommand(command, args, { cwd: repoRoot, env, capture: false });
}

async function captureCommand(command, args, { cwd = repoRoot, env = process.env } = {}) {
  return spawnCommand(command, args, { cwd, env, capture: true });
}

async function spawnCommand(command, args, { cwd, env, capture }) {
  const child = spawn(command, args, { cwd, env, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
  const stdout = [];
  if (capture) {
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.resume();
  }
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => {
      if (signal) rejectExit(new Error(`${command} was stopped by ${signal}.`));
      else resolveExit(code);
    });
  });
  if (exitCode !== 0) throw new Error(`${command} ${args.join(" ")} exited with code ${exitCode}.`);
  return capture ? Buffer.concat(stdout).toString("utf8") : undefined;
}
