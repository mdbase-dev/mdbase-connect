import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { publicPackages } from "./public-packages.mjs";
import { api, gh, git, nextBetaVersion, repository, requireGreenMain, requireRunning, verifyCompatibility } from "./lib/continuous-client-release.mjs";

const registry = "https://registry.npmjs.org";
const readJson = file => JSON.parse(readFileSync(file, "utf8"));
const sdk = { name: "@mdbase-dev/sdk", directory: "runtime/packages/sdk" };

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

async function published(item, workflow) {
  const metadata = await registryJson(encodeURIComponent(item.name));
  const baseline = publicationBaseline(metadata, item, workflow);
  const attestations = await registryJson(`-/npm/v1/attestations/${encodeURIComponent(item.name)}@${baseline.version}`);
  const proofs = attestations.attestations.filter(item => item.predicateType === "https://slsa.dev/provenance/v1");
  assert.equal(proofs.length, 1, "Exactly one npm provenance attestation is required.");
  const bundle = proofs[0].bundle;
  const source = provenanceSource(bundle, baseline, item.name);
  const { verify } = createRequire(new URL("../apps/desktop/package.json", import.meta.url))("sigstore");
  await verify(bundle, undefined, { certificateIssuer: "https://token.actions.githubusercontent.com",
    certificateIdentityURI: source.identity, tlogThreshold: 1, ctLogThreshold: 1, timeout: 15_000,
    retry: { retries: 0 } });
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
  git("fetch", "--no-tags", "origin", "main:refs/remotes/origin/main");
  const current = git("rev-parse", "origin/main") === env.GITHUB_SHA;
  requireGreenMain(env.GITHUB_SHA);
  if (env.LIVE_PUBLICATION === "true") checkPriorAttempts(kind, env);
  const packages = kind === "source" ? [sdk] : await publicPackages();
  const inventory = [];
  const changed = [];
  for (const item of packages) {
    const manifest = readJson(join(item.directory, "package.json"));
    const baseline = await published(item, kind === "source" ? "publish-sdk-npm.yml" : "publish-npm.yml");
    const paths = git("diff", "--no-renames", "--name-only", "-z", baseline.commit, env.GITHUB_SHA).split("\0").filter(Boolean);
    const readAt = (commit, path) => {
      try { return git("show", `${commit}:${path}`); }
      catch (error) { if (error.status === 128) return undefined; throw error; }
    };
    if (current && paths.some(path => {
      if (!packageInputs(path, item, kind)) return false;
      if (!/(?:^|\/)package(?:-lock)?\.json$/.test(path)) return contentChanged(path);
      return contentChanged(path, readAt(baseline.commit, path), readAt(env.GITHUB_SHA, path));
    })) changed.push(item.name);
    inventory.push({ name: item.name, directory: item.directory, manifest, baseline: baseline.version,
      version: nextBetaVersion([...baseline.versions, manifest.version]) });
  }
  const selected = dependentPackages(inventory, changed).map(item => ({ name: item.name, directory: item.directory, version: item.version }));
  const result = { schema: 1, commit: env.GITHUB_SHA, kind, packages: selected,
    dependencies: Object.fromEntries(inventory.map(item => [item.name, selected.some(value => value.name === item.name) ? item.version : item.baseline])) };
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `changed=${selected.length > 0}\nversion=${selected[0]?.version ?? ""}\n`);
  console.log(JSON.stringify(result));
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
  const workflow = env.GITHUB_WORKFLOW === "Publish source-built SDK" ? "publish-sdk-npm.yml" : "publish-npm.yml";
  assert.equal(api(`actions/workflows/${workflow}`).state, "active", "Client publication workflow has been stopped.");
  return verifyCompatibility(env);
}

export async function publishWorkspace(planFile, directory, env = process.env) {
  const record = readJson(planFile);
  assert.equal(record.commit, env.GITHUB_SHA);
  assert.equal(record.kind, "workspace");
  for (const item of record.packages) {
    await compatible(env);
    await requireUnpublished(item.name, item.version);
    const filename = `${item.name.replace(/^@/, "").replace("/", "-")}-${item.version}.tgz`;
    const archive = resolve(directory, filename);
    const manifest = JSON.parse(execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" }));
    assert.equal(manifest.name, item.name);
    assert.equal(manifest.version, item.version);
    assert.equal(manifest.mdbaseRelease.commit, env.GITHUB_SHA);
    execFileSync("npm", ["publish", archive, "--ignore-scripts", "--access", "public", "--registry", `${registry}/`, "--tag", "next", "--provenance"], { stdio: "inherit" });
  }
}

export async function requireUnpublished(name, version) {
  assert.match(name, /^@mdbase-dev\/[a-z0-9-]+$/);
  assert.match(version, /^0\.1\.0-beta\.[1-9][0-9]*$/);
  const response = await fetch(`${registry}/${encodeURIComponent(name)}/${version}`, {
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 404, `Expected proven npm version absence; HTTP ${response.status} requires owner review.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "plan") await plan(...args);
  else if (command === "prepare-source") prepareSource(...args);
  else if (command === "pack-workspace") packWorkspace(...args);
  else if (command === "publish-workspace") await publishWorkspace(...args);
  else if (command === "compatible") await compatible();
  else if (command === "unpublished") await requireUnpublished(...args);
  else throw new Error("Expected plan, prepare-source, pack-workspace, publish-workspace, compatible or unpublished.");
}
