import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { publicPackages } from "./public-packages.mjs";
import { api, checkoutProductionCommit, contractSensitive, gh, git, nextBetaVersion, repository, requireGreenMain, requireRunning, verifyCompatibility } from "./lib/continuous-client-release.mjs";

const registry = "https://registry.npmjs.org";
const readJson = file => JSON.parse(readFileSync(file, "utf8"));
const sdk = { name: "@mdbase-dev/sdk", directory: "runtime/packages/sdk" };
const publisherWorkflow = env => env.GITHUB_WORKFLOW === "Publish source-built SDK" ? "publish-sdk-npm.yml" : "publish-npm.yml";

async function registryJson(path) {
  const response = await fetch(`${registry}/${path}`, { redirect: "error", cache: "no-store",
    headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  assert(response.ok, `npm registry read refused: HTTP ${response.status}`);
  return response.json();
}

export function publicationBaseline(metadata, item, workflow) {
  assert.equal(metadata.name, item.name);
  const versions = Object.keys(metadata.versions ?? {});
  assert(versions.length > 0, `Bootstrap ${item.name} before enabling trusted publishing.`);
  nextBetaVersion(versions);
  const betas = versions.filter(version => /^0\.1\.0-beta\.[1-9][0-9]*$/.test(version))
    .sort((left, right) => BigInt(left.split(".").at(-1)) < BigInt(right.split(".").at(-1)) ? -1 : 1);
  assert(betas.length > 0, "A provenance-qualified beta baseline is required.");
  const version = betas.at(-1);
  const entry = metadata.versions[version];
  assert.equal(entry.name, item.name);
  assert.equal(entry.version, version);
  assert.match(entry.dist?.integrity ?? "", /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  return { version, entry, workflow, versions };
}

export function provenanceSource(bundle, baseline, name) {
  const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf8"));
  assert.equal(statement.predicateType, "https://slsa.dev/provenance/v1");
  const subject = statement.subject;
  assert.equal(subject.length, 1);
  assert.equal(subject[0].name, `pkg:npm/${name.split("/").map(encodeURIComponent).join("/")}@${baseline.version}`);
  const integrity = Buffer.from(baseline.entry.dist.integrity.slice("sha512-".length), "base64").toString("hex");
  assert.equal(subject[0].digest.sha512, integrity);
  const definition = statement.predicate.buildDefinition;
  const workflow = definition.externalParameters.workflow;
  assert.equal(workflow.repository, `https://github.com/${repository}`);
  assert.equal(workflow.path, `.github/workflows/${baseline.workflow}`);
  assert(["refs/heads/main", `refs/tags/v${baseline.version}`].includes(workflow.ref));
  assert.equal(definition.resolvedDependencies.length, 1);
  const source = definition.resolvedDependencies[0];
  assert.equal(source.uri, `git+https://github.com/${repository}@${workflow.ref}`);
  assert.match(source.digest.gitCommit, /^[a-f0-9]{40}$/);
  return { commit: source.digest.gitCommit,
    identity: `https://github.com/${repository}/.github/workflows/${baseline.workflow}@${workflow.ref}` };
}

export async function provenSource(name, baseline, { readRegistry = registryJson, verifyBundle = verifyProvenanceBundle } = {}) {
  const attestations = await readRegistry(`-/npm/v1/attestations/${encodeURIComponent(name)}@${baseline.version}`);
  const proofs = attestations.attestations.filter(item => item.predicateType === "https://slsa.dev/provenance/v1");
  assert.equal(proofs.length, 1, "Exactly one npm provenance attestation is required.");
  const bundle = proofs[0].bundle;
  const source = provenanceSource(bundle, baseline, name);
  await verifyBundle(bundle, source);
  return source;
}

export async function verifyProvenanceBundle(bundle, source, verifier) {
  // Publish jobs install no workspace dependencies, so use the sigstore npm signs with.
  const npm = join(execFileSync("npm", ["root", "--global"], { encoding: "utf8" }).trim(), "npm/package.json");
  const verify = verifier ?? createRequire(npm)("sigstore").verify;
  // DSSE bundles use verify(bundle, options), not the detached-content overload.
  await verify(bundle, { certificateIssuer: "https://token.actions.githubusercontent.com",
    certificateIdentityURI: source.identity, tlogThreshold: 1, ctLogThreshold: 1, timeout: 15_000,
    retry: { retries: 0 } });
}

async function published(item, workflow) {
  const metadata = await registryJson(encodeURIComponent(item.name));
  const baseline = publicationBaseline(metadata, item, workflow);
  const source = await provenSource(item.name, baseline);
  git("fetch", "--no-tags", "origin", source.commit);
  git("merge-base", "--is-ancestor", source.commit, "HEAD");
  return { ...item, ...baseline, commit: source.commit };
}

export function contentChanged(path, before, after) {
  if (/(?:^|\/)(?:test|tests|__tests__)\//.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) return false;
  if (/(?:^|\/)package(?:-lock)?\.json$/.test(path)) {
    if (before === undefined || after === undefined) return true;
    const normalize = text => {
      const value = JSON.parse(text);
      delete value.version;
      if (value.packages?.[""]) delete value.packages[""].version;
      return JSON.stringify(value);
    };
    return normalize(before) !== normalize(after);
  }
  return true;
}

export function packageInputs(path, item, kind) {
  if (path.startsWith(`${item.directory}/`)) return true;
  if (["pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json"].includes(path)) return true;
  if (kind === "source") return /^(?:runtime\/(?:crates\/|Cargo\.|rust-toolchain|\.cargo\/|xtask\/|tools\/wasm\/)|config\/next-trust\/|config\/release-components|scripts\/(?:sdk-publication|publish-sdk-prerelease|lib\/sdk-publication))/.test(path);
  return /^(?:tsconfig[^/]*\.json|scripts\/public-packages\.mjs)$/.test(path);
}

// Whether a path changed between two commits as an input of a published package.
// Tests and version-only manifest edits never count.
export function inputChanged(path, item, kind, from, to, runGit = git) {
  if (!packageInputs(path, item, kind)) return false;
  if (!/(?:^|\/)package(?:-lock)?\.json$/.test(path)) return contentChanged(path);
  const readAt = commit => {
    try { return runGit("show", `${commit}:${path}`); }
    catch (error) { if (error.status === 128) return undefined; throw error; }
  };
  return contentChanged(path, readAt(from), readAt(to));
}

// npm refuses provenance that names any commit but this run's own. A run on a
// newer main still publishes when nothing between the production commit and it
// changes a published package's inputs or the server-facing contract: the
// production commit's qualified bytes are then exactly this commit's bytes.
// Any manifest change counts, even version-only, because packing names the
// qualified tarballs by the checked-out manifest version. Otherwise it stands
// down and leaves the selected source unpublished.
export function publicationCommit(production, run, packages, kind, runGit = git) {
  if (production === run) return run;
  try { runGit("merge-base", "--is-ancestor", production, run); }
  catch (error) { if (error.status === 1) return null; throw error; }
  const paths = runGit("diff", "--no-renames", "--name-only", "-z", production, run).split("\0").filter(Boolean);
  return paths.some(path => contractSensitive(path)
    || packages.some(item => packageInputs(path, item, kind) && contentChanged(path))) ? null : run;
}

// Main's Server CI reuses the merge queue's artifacts, so a new main commit
// qualifies within about a minute of landing; Runtime CI, which the source
// build also requires, takes up to about twenty. Wait boundedly for either.
export async function awaitMainCi(commit, { workflow = "server-ci.yml", events = ["push"], readApi = api,
  wait = ms => new Promise(done => setTimeout(done, ms)), attempts = 30, delay = 20_000 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const runs = readApi(`actions/workflows/${workflow}/runs?head_sha=${commit}&branch=main&per_page=100`).workflow_runs
      .filter(run => run.head_sha === commit && run.head_branch === "main" && events.includes(run.event)
        && run.path === `.github/workflows/${workflow}`);
    if (runs.some(run => run.status === "completed" && run.conclusion === "success")) return true;
    if (runs.length > 0 && runs.every(run => run.status === "completed")) return false;
    if (attempt >= attempts) return false;
    await wait(delay);
  }
}

// The qualifications the publish jobs re-check for the publishing commit.
export async function awaitPublicationCi(commit, kind, options = {}) {
  if (!await awaitMainCi(commit, options)) return false;
  return kind !== "source" || awaitMainCi(commit,
    { ...options, workflow: "runtime-ci.yml", events: ["push", "workflow_dispatch"], attempts: 75 });
}

export function dependentPackages(packages, changed) {
  const selected = new Set(changed);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const item of packages) {
      if (selected.has(item.name)) continue;
      if (Object.entries({ ...item.manifest.dependencies, ...item.manifest.optionalDependencies }).some(([name, specifier]) =>
        specifier.startsWith("workspace:") && selected.has(name))) {
        selected.add(item.name);
        expanded = true;
      }
    }
  }
  return packages.filter(item => selected.has(item.name));
}

export function failedPublisherRuns(runs, current, acknowledged = "") {
  assert(acknowledged === "" || /^[1-9][0-9]*$/.test(acknowledged), "Invalid acknowledged publication run.");
  return runs.filter(run => run.id < Number(current) && run.id > Number(acknowledged || 0)
    && run.head_branch === "main" && ["workflow_run", "workflow_dispatch", "schedule"].includes(run.event)
    && !["success", "skipped"].includes(run.conclusion));
}

function checkPriorAttempts(kind, env) {
  const workflow = kind === "source" ? "publish-sdk-npm.yml" : "publish-npm.yml";
  const runs = JSON.parse(gh("api", "--paginate", "--slurp", `repos/${repository}/actions/workflows/${workflow}/runs?branch=main&per_page=100`))
    .flatMap(page => page.workflow_runs);
  for (const run of failedPublisherRuns(runs, env.GITHUB_RUN_ID, env.PUBLICATION_ACKNOWLEDGED_RUN)) {
    const jobs = JSON.parse(gh("api", "--paginate", "--slurp", `repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`))
      .flatMap(page => page.jobs);
    const name = kind === "source" ? "Publish source-built SDK" : "Publish changed SDK packages";
    if (jobs.some(job => job.name === name && job.conclusion !== "skipped")) {
      throw new Error(`Publication run ${run.id} failed or has an unknown outcome; release-owner reconciliation and acknowledgement required.`);
    }
  }
}

export async function plan(kind, output, env = process.env) {
  assert(["source", "workspace"].includes(kind));
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.equal(git("rev-parse", "HEAD"), env.GITHUB_SHA);
  requireRunning(env.SDK_RELEASE_STOPPED);
  // Qualify the selection without step outputs; the publishing commit's own
  // qualification below names the artifacts that are packed.
  const { GITHUB_OUTPUT: _, ...quiet } = env;
  const production = await checkoutProductionCommit(env, { qualify: commit => requireGreenMain(commit, quiet) });
  const packages = kind === "source" ? [sdk] : await publicPackages();
  const equivalent = publicationCommit(production, env.GITHUB_SHA, packages, kind);
  let current = equivalent !== null;
  if (!current) console.log(`Selected ${production} is not this run's commit and differs in published inputs; publishing nothing.`);
  else if (equivalent !== production && !await awaitPublicationCi(equivalent, kind)) {
    current = false;
    console.log(`This run's ${equivalent} matches selected ${production} but its CI did not pass in time; publishing nothing.`);
  }
  const commit = current ? equivalent : production;
  git("checkout", "--detach", commit);
  if (current) requireGreenMain(commit, env);
  if (current && commit !== production) console.log(`Selected ${production}; this run's ${commit} has the same published inputs and contract, so it publishes as ${commit}.`);
  env = { ...env, GITHUB_SHA: commit };
  if (env.LIVE_PUBLICATION === "true") checkPriorAttempts(kind, env);
  const inventory = [];
  const changed = [];
  for (const item of packages) {
    const manifest = readJson(join(item.directory, "package.json"));
    const baseline = await published(item, kind === "source" ? "publish-sdk-npm.yml" : "publish-npm.yml");
    const paths = git("diff", "--no-renames", "--name-only", "-z", baseline.commit, env.GITHUB_SHA).split("\0").filter(Boolean);
    if (current && paths.some(path => inputChanged(path, item, kind, baseline.commit, env.GITHUB_SHA))) changed.push(item.name);
    inventory.push({ name: item.name, directory: item.directory, manifest, baseline: baseline.version,
      version: nextBetaVersion([...baseline.versions, manifest.version]) });
  }
  const selected = dependentPackages(inventory, changed).map(item => ({ name: item.name, directory: item.directory, version: item.version }));
  const result = { schema: 1, commit: env.GITHUB_SHA, kind, packages: selected,
    dependencies: Object.fromEntries(inventory.map(item => [item.name, selected.some(value => value.name === item.name) ? item.version : item.baseline])) };
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  if (kind === "workspace") result.compatibility = await qualifyWorkspace(output, env);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `commit=${commit}\nchanged=${selected.length > 0}\nversion=${selected[0]?.version ?? ""}\n`);
  console.log(JSON.stringify(result));
}

export async function qualifyWorkspace(planFile, env = process.env, verify = verifyCompatibility) {
  const record = readJson(planFile);
  assert.equal(record.commit, env.GITHUB_SHA);
  assert.equal(record.kind, "workspace");
  assert(["true", "false"].includes(env.LIVE_PUBLICATION), "Expected an explicit live-publication mode.");
  let compatibility;
  try {
    compatibility = { status: "passed", evidence: await verify(env) };
  } catch (error) {
    compatibility = { status: "blocked", error: error.message };
  }
  writeFileSync(planFile, `${JSON.stringify({ ...record, compatibility }, null, 2)}\n`);
  console.log(JSON.stringify({ compatibility }));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY,
    `## Workspace production compatibility: ${compatibility.status}\n\nAll workspace packages require the shared production proof; there are no exemptions.\n\n\`\`\`json\n${JSON.stringify(compatibility, null, 2)}\n\`\`\`\n`);
  if (env.LIVE_PUBLICATION === "true" && compatibility.status === "blocked") throw new Error(compatibility.error);
  return compatibility;
}

export function prepareSource(planFile, env = process.env) {
  const record = readJson(planFile);
  assert.equal(record.commit, env.GITHUB_SHA);
  assert.equal(record.kind, "source");
  assert.equal(record.packages.length, 1);
  assert.equal(record.packages[0].name, sdk.name);
  const version = record.packages[0].version;
  assert.match(version, /^0\.1\.0-beta\.[1-9][0-9]*$/);
  for (const path of ["package.json", `${sdk.directory}/package.json`]) {
    const manifest = readJson(path);
    manifest.version = version;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

export function packWorkspace(planFile, input, output, env = process.env) {
  const record = readJson(planFile);
  assert.equal(record.commit, env.GITHUB_SHA);
  assert.equal(record.kind, "workspace");
  mkdirSync(output, { recursive: true });
  for (const item of record.packages) {
    const source = readJson(join(item.directory, "package.json"));
    assert.equal(item.name, source.name);
    const filename = `${item.name.replace(/^@/, "").replace("/", "-")}-${source.version}.tgz`;
    const directory = join(output, item.name.replace(/^@/, "").replace("/", "-"));
    mkdirSync(directory);
    execFileSync("tar", ["-xzf", join(input, filename), "-C", directory]);
    const path = join(directory, "package/package.json");
    const manifest = readJson(path);
    assert.equal(manifest.name, item.name);
    assert.equal(manifest.version, source.version);
    manifest.version = item.version;
    manifest.mdbaseRelease = { commit: record.commit };
    for (const section of ["dependencies", "optionalDependencies"]) {
      for (const name of Object.keys(manifest[section] ?? {})) {
        if (record.dependencies[name]) manifest[section][name] = record.dependencies[name];
      }
    }
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", resolve(output)], { cwd: join(directory, "package"), stdio: "inherit" });
  }
}

export async function compatible(env = process.env) {
  requireRunning(env.SDK_RELEASE_STOPPED);
  assert(["Publish source-built SDK", "Publish npm packages"].includes(env.GITHUB_WORKFLOW));
  assert.equal(api(`actions/workflows/${publisherWorkflow(env)}`).state, "active", "Client publication workflow has been stopped.");
  return verifyCompatibility(env);
}

export async function publishWorkspace(planFile, directory, env = process.env) {
  const record = readJson(planFile);
  assert.equal(record.commit, env.GITHUB_SHA);
  assert.equal(record.kind, "workspace");
  for (const item of record.packages) {
    await compatible(env);
    if (await publicationState(item.name, item.version, env) === "published") continue;
    const filename = `${item.name.replace(/^@/, "").replace("/", "-")}-${item.version}.tgz`;
    const archive = resolve(directory, filename);
    const manifest = JSON.parse(execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" }));
    assert.equal(manifest.name, item.name);
    assert.equal(manifest.version, item.version);
    assert.equal(manifest.mdbaseRelease.commit, env.GITHUB_SHA);
    execFileSync("npm", ["publish", archive, "--ignore-scripts", "--access", "public", "--registry", `${registry}/`, "--tag", "latest", "--provenance"], { stdio: "inherit" });
  }
}

// A run queued behind another for the same commit can plan while npm still
// hides the version. Only 404 may publish, and only this commit's verified
// provenance may stand down; anything else stays for owner review.
export async function publicationState(name, version, env = process.env, prove = provenSource) {
  assert.match(name, /^@mdbase-dev\/[a-z0-9-]+$/);
  assert.match(version, /^0\.1\.0-beta\.[1-9][0-9]*$/);
  assert.match(env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/);
  const response = await fetch(`${registry}/${encodeURIComponent(name)}/${version}`, {
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return "absent";
  assert.equal(response.status, 200, `Expected npm version absence or proven publication; HTTP ${response.status} requires owner review.`);
  const entry = await response.json();
  assert.equal(entry.name, name);
  assert.equal(entry.version, version);
  const source = await prove(name, { version, entry, workflow: publisherWorkflow(env) });
  assert.equal(source.commit, env.GITHUB_SHA, `${name}@${version} came from another commit; owner review required.`);
  return "published";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "plan") await plan(...args);
  else if (command === "prepare-source") prepareSource(...args);
  else if (command === "pack-workspace") packWorkspace(...args);
  else if (command === "publish-workspace") await publishWorkspace(...args);
  else if (command === "compatible") await compatible();
  else if (command === "publication-state") {
    const state = await publicationState(...args);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `state=${state}\n`);
    console.log(`${args[0]}@${args[1]}: ${state}`);
  } else throw new Error("Expected plan, prepare-source, pack-workspace, publish-workspace, compatible or publication-state.");
}
