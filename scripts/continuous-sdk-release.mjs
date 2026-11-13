import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { publicPackages } from "./public-packages.mjs";
import { api, checkoutProductionCommit, gh, git, nextBetaVersion, repository, requireGreenMain, requireRunning, verifyCompatibility } from "./lib/continuous-client-release.mjs";

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
  return { ...item, ...baseline, commit: source.commit };
}

// Status 1 is a history relationship, not a broken git invocation (128).
export function baselineHistory(baseline, head, runGit = git) {
  const ancestor = (from, to) => {
    try { runGit("merge-base", "--is-ancestor", from, to); return true; }
    catch (error) {
      if (error.status === 1) return false;
      throw new Error("publication-ancestry-unavailable");
    }
  };
  if (ancestor(baseline, head)) return "contained";
  if (ancestor(head, baseline)) return "ahead";
  throw new Error("publication-baseline-diverged");
}

function summarizePackage(item, production, run, decision, env) {
  const line = `${item.name}: selected production ${production}; run ${run}; published baseline ${item.baseline.version} at ${item.baseline.commit}; ${decision}.`;
  console.log(line);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `- ${line}\n`);
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

// npm provenance names the commit its workflow run checked out. So a publisher
// never runs on main, whose tip outruns production: the main coordinator
// reserves an immutable annotated tag v<version> at the selected production
// commit and dispatches this workflow on it. The tag is the run's ref and commit,
// so standard provenance and every consumer's refs/tags/v<version> rule hold.
// A reservation names a version for a production commit, not a line: both lines
// allocate from one namespace, so whichever coordinator reserves first creates
// the tag and the other publishes from it. Each line's packages, provenance
// identity (its own workflow file) and GitHub release (`sdk-v*`) stay disjoint.
const reservationSchema = "mdbase-npm-release/1";
const releaseTag = /^v0\.1\.0-beta\.([1-9][0-9]*)$/;
const betaNumber = version => BigInt(/^0\.1\.0-beta\.([1-9][0-9]*)$/.exec(version)?.[1] ?? 0);
const above = (version, reference) => betaNumber(version) > betaNumber(reference);
const publisherFile = kind => kind === "source" ? "publish-sdk-npm.yml" : "publish-npm.yml";

// Null for the main coordinator; otherwise the reserved tag this publisher runs on.
export function publicationTag(env) {
  if (env.GITHUB_REF === "refs/heads/main") return null;
  const tag = env.GITHUB_REF?.startsWith("refs/tags/") ? env.GITHUB_REF.slice("refs/tags/".length) : "";
  assert(releaseTag.test(tag) && env.GITHUB_EVENT_NAME === "workflow_dispatch",
    "Publication runs only as the main coordinator or on a dispatched release tag.");
  return tag;
}

// The remote, protected tag is authoritative: annotated and at this exact commit.
export function readReservation(tag, commit, readApi = api) {
  assert.match(tag, releaseTag);
  const reference = readApi(`git/ref/tags/${tag}`);
  assert.equal(reference.object?.type, "tag", "Publication tags must be annotated reservations.");
  const object = readApi(`git/tags/${reference.object.sha}`);
  assert.equal(object.object?.type, "commit");
  assert.equal(object.object.sha, commit, "The publication tag must identify this exact commit.");
  const record = JSON.parse(object.message);
  assert.equal(record.schema, reservationSchema);
  assert(["source", "workspace"].includes(record.kind));
  assert.equal(record.commit, commit);
  return record;
}

// Every release tag (Desktop's, retired server trains' and these reservations)
// shares the v0.1.0-beta.N namespace, so allocation stays above all of them.
export function listReservations(commit, kinds, runGit = git) {
  runGit("fetch", "--no-tags", "origin", "refs/tags/v*:refs/tags/v*");
  const tags = runGit("for-each-ref", "--format=%(refname:short)%00%(objecttype)%00%(contents:subject)%00%(*objectname)", "refs/tags/v*")
    .split("\n").filter(Boolean).map(line => line.split("\0")).filter(([tag]) => releaseTag.test(tag));
  const reserved = tags.flatMap(([tag, type, subject, peeled]) => {
    if (type !== "tag" || !subject.startsWith(`{"schema":"${reservationSchema}"`)) return [];
    const record = JSON.parse(subject);
    return kinds.includes(record.kind) && record.commit === commit && peeled === commit ? [tag] : [];
  });
  return { versions: tags.map(([tag]) => tag.slice(1)),
    reserved: reserved.sort((left, right) => above(left.slice(1), right.slice(1)) ? -1 : 1) };
}

// A tag run executes the publisher workflow committed at the tag. Transition
// guard: until production contains tag publication, a reservation would only
// yield a run that skips every job. Remove once production contains it.
export function tagPublisher(kind, commit, runGit = git) {
  return runGit("show", `${commit}:.github/workflows/${publisherFile(kind)}`)
    .includes("github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/tags/v0.1.0-beta.')");
}

// A tag run executes the planner committed at its tag, which before shared
// reservations required a tag of its own line. Transition guard: until
// production contains shared reservations, never publish from the other line's
// tag. Remove once production contains them.
export function sharesReservations(commit, runGit = git) {
  return runGit("show", `${commit}:scripts/continuous-sdk-release.mjs`).includes("export function readReservation(tag, commit, ");
}

// One read: the coordinator reserves only commits whose exact Runtime CI passed.
export function runtimeQualified(commit, readApi = api) {
  return readApi(`actions/workflows/runtime-ci.yml/runs?head_sha=${commit}&branch=main&per_page=100`).workflow_runs
    .some(run => run.head_sha === commit && run.head_branch === "main" && ["push", "workflow_dispatch"].includes(run.event)
      && run.path === ".github/workflows/runtime-ci.yml" && run.status === "completed" && run.conclusion === "success");
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

// Coordinator and tag runs are separate concurrency groups, so an unfinished
// tag run is in flight, not an unknown outcome; its tag is never redispatched.
export function failedPublisherRuns(runs, current, acknowledged = "") {
  assert(acknowledged === "" || /^[1-9][0-9]*$/.test(acknowledged), "Invalid acknowledged publication run.");
  return runs.filter(run => run.id < Number(current) && run.id > Number(acknowledged || 0)
    && (run.head_branch === "main" || releaseTag.test(run.head_branch ?? ""))
    && ["workflow_run", "workflow_dispatch", "schedule"].includes(run.event)
    && run.status === "completed" && !["success", "skipped"].includes(run.conclusion));
}

function checkPriorAttempts(kind, env) {
  const workflow = publisherFile(kind);
  // Main runs hold the pre-tag history; every tag run is a dispatch.
  const runs = new Map(["branch=main", "event=workflow_dispatch"].flatMap(filter =>
    JSON.parse(gh("api", "--paginate", "--slurp", `repos/${repository}/actions/workflows/${workflow}/runs?${filter}&per_page=100`))
      .flatMap(page => page.workflow_runs)).map(run => [run.id, run]));
  for (const run of failedPublisherRuns([...runs.values()], env.GITHUB_RUN_ID, env.PUBLICATION_ACKNOWLEDGED_RUN)) {
    const jobs = JSON.parse(gh("api", "--paginate", "--slurp", `repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`))
      .flatMap(page => page.jobs);
    const name = kind === "source" ? "Publish source-built SDK" : "Publish changed SDK packages";
    if (jobs.some(job => job.name === name && job.conclusion !== "skipped")) {
      throw new Error(`Publication run ${run.id} failed or has an unknown outcome; release-owner reconciliation and acknowledgement required.`);
    }
  }
}

// On main this coordinates: it selects the production commit, decides what
// changed and, live, records the tag to reserve. On a reserved tag it plans the
// publication of that tag's own commit at the tag's version.
export async function plan(kind, output, env = process.env, {
  selectProduction = checkoutProductionCommit, qualify = requireGreenMain, readPublished = published,
  reservation = readReservation, reservations = listReservations, runtimeCi = runtimeQualified, publisherAt = tagPublisher,
  sharedAt = sharesReservations,
  checkAttempts = checkPriorAttempts, verify = verifyCompatibility
} = {}) {
  assert(["source", "workspace"].includes(kind));
  assert.equal(env.GITHUB_REPOSITORY, repository);
  const tag = publicationTag(env);
  assert.equal(git("rev-parse", "HEAD"), env.GITHUB_SHA);
  requireRunning(env.SDK_RELEASE_STOPPED);
  const run = env.GITHUB_SHA;
  const live = env.LIVE_PUBLICATION === "true";
  let commit = run;
  if (tag) {
    reservation(tag, commit);
    // Exact Server CI qualification; its step output names the artifacts packed.
    qualify(commit, env);
  } else {
    const { GITHUB_OUTPUT: _, ...quiet } = env;
    commit = await selectProduction(env, { qualify: sha => qualify(sha, quiet) });
  }
  env = { ...env, GITHUB_SHA: commit };
  const packages = kind === "source" ? [sdk] : await publicPackages();
  const inventory = [];
  const changed = [];
  for (const item of packages) {
    const manifest = readJson(join(item.directory, "package.json"));
    const baseline = await readPublished(item, publisherFile(kind));
    let history;
    try { history = baselineHistory(baseline.commit, commit); }
    catch (error) { history = error.message; }
    const paths = history === "contained" ? git("diff", "--no-renames", "--name-only", "-z", baseline.commit, commit).split("\0").filter(Boolean) : [];
    if (paths.some(path => inputChanged(path, item, kind, baseline.commit, commit))) changed.push(item.name);
    inventory.push({ name: item.name, directory: item.directory, manifest, baseline, history });
  }
  const summarize = decision => { for (const item of inventory) summarizePackage(item, commit, run, decision(item), env); };
  const invalidHistory = inventory.find(item => !["contained", "ahead"].includes(item.history));
  if (invalidHistory) {
    summarize(() => `blocked: ${invalidHistory.history}`);
    throw new Error(invalidHistory.history);
  }
  // Never repack older source through dependency expansion while any package's
  // verified baseline is ahead of the selected source. Reconcile the line once
  // production catches up, retaining the existing highest-version baselines.
  const ahead = inventory.find(item => item.history === "ahead");
  let chosen = ahead ? [] : dependentPackages(inventory, changed);
  const predatesTags = !tag && chosen.length > 0 && !publisherAt(kind, commit);
  const waitingForRuntime = !tag && !predatesTags && kind === "source" && chosen.length > 0 && !runtimeCi(commit);
  if (predatesTags || waitingForRuntime) chosen = [];
  // One version per tag: every package a tag publishes carries the tag's version,
  // above every version any of these packages has published.
  const lineVersions = inventory.flatMap(item => [...item.baseline.versions, item.manifest.version]);
  let reserving;
  if (!tag && chosen.length) {
    const shared = sharedAt(commit);
    const { versions, reserved } = reservations(commit, shared ? ["source", "workspace"] : [kind]);
    const reuse = reserved.find(item => !lineVersions.some(version => above(version, item.slice(1))));
    reserving = { ...(reuse ? { tag: reuse, existing: true } : { tag: `v${nextBetaVersion([...lineVersions, ...versions])}`, existing: false }), shared };
  }
  const version = (tag ?? reserving?.tag)?.slice(1);
  const superseded = tag && chosen.find(item => item.baseline.versions.some(value => above(value, version)));
  if (superseded) {
    summarize(() => "blocked: publication-version-superseded");
    throw new Error("publication-version-superseded");
  }
  const selected = chosen.map(item => ({ name: item.name, directory: item.directory, version }));
  const result = { schema: 1, commit, kind, packages: selected, ...(tag ? { tag } : {}), ...(reserving ? { reservation: reserving } : {}),
    dependencies: Object.fromEntries(inventory.map(item => [item.name, selected.some(value => value.name === item.name) ? version : item.baseline.version])) };
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  let blocked;
  let gate = "publication-prior-attempt-unreconciled";
  try {
    if (selected.length && live) checkAttempts(kind, env);
    gate = "production-compatibility-unproven";
    if (selected.length && kind === "workspace") result.compatibility = await qualifyWorkspace(output, env, verify);
  } catch {
    blocked = gate;
  }
  summarize(item => {
    if (blocked || result.compatibility?.status === "blocked") return `blocked: ${blocked ?? "production-compatibility-unproven"}`;
    if (ahead) return `nothing to publish; waiting for production to reach commit ${ahead.baseline.commit}`;
    if (predatesTags) return `nothing to publish; waiting for production to contain tag publication (${commit} predates it)`;
    if (waitingForRuntime) return `nothing to publish; waiting for successful Runtime CI of commit ${commit}`;
    if (!selected.some(value => value.name === item.name)) return "nothing to publish";
    if (tag) return `publishing ${version} from ${commit}${live ? "" : " (dry run)"}`;
    return `${live ? (reserving.existing ? "dispatching reserved" : "reserving") : "would reserve"} ${reserving.tag} at ${commit} to publish ${version}`;
  });
  if (blocked) throw new Error(blocked);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `commit=${commit}\nchanged=${Boolean(tag) && selected.length > 0}\npublish=${Boolean(tag) && selected.length > 0 && live}\nreserve=${!tag && selected.length > 0 && live}\nversion=${version ?? ""}\n`);
  console.log(JSON.stringify(result));
}

// The coordinator's only mutations: create the reserved annotated tag (protected
// against update and deletion) and dispatch this workflow on it. Creating the ref
// is the reservation's compare-and-set: when the other line's coordinator planned
// concurrently and created the same tag first, a tag at this exact commit is this
// reservation too; a tag anywhere else refuses. A reserved tag whose run of this
// workflow is in flight is left alone; one whose run ended unpublished is
// redispatched, unless that run succeeded, which needs review.
export function reserve(planFile, env = process.env, { readApi = api, writeApi = postApi,
  dispatch = (workflow, tag) => gh("workflow", "run", workflow, "--repo", repository, "--ref", tag, "-f", "dry_run=false") } = {}) {
  requireRunning(env.SDK_RELEASE_STOPPED);
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.match(env.GITHUB_RUN_ID ?? "", /^[1-9][0-9]*$/);
  const record = readJson(planFile);
  assert(["source", "workspace"].includes(record.kind));
  assert.match(record.commit, /^[a-f0-9]{40}$/);
  assert(record.packages.length > 0);
  const { tag } = record.reservation;
  let { existing } = record.reservation;
  assert.match(tag, releaseTag);
  assert(record.packages.every(item => `v${item.version}` === tag));
  const workflow = publisherFile(record.kind);
  assert.equal(readApi(`actions/workflows/${workflow}`).state, "active", "Client publication workflow has been stopped.");
  if (!existing) {
    const object = writeApi("git/tags", { tag, object: record.commit, type: "commit",
      message: JSON.stringify({ schema: reservationSchema, kind: record.kind, commit: record.commit,
        reserved_at: new Date().toISOString(), run_id: env.GITHUB_RUN_ID }) });
    try {
      writeApi("git/refs", { ref: `refs/tags/${tag}`, sha: object.sha });
    } catch (error) {
      let found;
      try { found = readReservation(tag, record.commit, readApi); }
      catch (mismatch) { throw new Error(`${tag} was not created and is not a reservation of ${record.commit}: ${mismatch.message}`, { cause: error }); }
      if (found.kind !== record.kind && record.reservation.shared !== true) {
        throw new Error(`${tag} is the ${found.kind} line's reservation and ${record.commit} predates shared reservations.`, { cause: error });
      }
      existing = true;
    }
  }
  if (existing) {
    readReservation(tag, record.commit, readApi);
    const runs = readApi(`actions/workflows/${workflow}/runs?branch=${tag}&event=workflow_dispatch&per_page=100`).workflow_runs
      .filter(run => run.head_branch === tag && run.path === `.github/workflows/${workflow}`);
    if (runs.some(run => run.status !== "completed")) return reported(env, `${tag}: publication in progress; nothing dispatched.`);
    if (runs.some(run => run.conclusion === "success")) throw new Error("publication-reservation-unconsumed");
  }
  dispatch(workflow, tag);
  return reported(env, `${tag}: ${!existing ? "reserved and dispatched" : record.reservation.existing ? "redispatched" : "joined the existing reservation and dispatched"} ${workflow} at ${record.commit}.`);
}

function reported(env, line) {
  console.log(line);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `- ${line}\n`);
  return line;
}

function postApi(path, body) {
  return JSON.parse(execFileSync("gh", ["api", "--method", "POST", `repos/${repository}/${path}`, "--input", "-"],
    { input: JSON.stringify(body), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }));
}

export async function qualifyWorkspace(planFile, env = process.env, verify = verifyCompatibility) {
  const record = readJson(planFile);
  assert.equal(record.commit, env.GITHUB_SHA);
  assert.equal(record.kind, "workspace");
  assert(["true", "false"].includes(env.LIVE_PUBLICATION), "Expected an explicit live-publication mode.");
  let compatibility;
  try {
    compatibility = { status: "passed", evidence: await verify(env) };
  } catch {
    compatibility = { status: "blocked", error: "production-compatibility-unproven" };
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
  else if (command === "reserve") reserve(...args);
  else if (command === "prepare-source") prepareSource(...args);
  else if (command === "pack-workspace") packWorkspace(...args);
  else if (command === "publish-workspace") await publishWorkspace(...args);
  else if (command === "compatible") await compatible();
  else if (command === "publication-state") {
    const state = await publicationState(...args);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `state=${state}\n`);
    console.log(`${args[0]}@${args[1]}: ${state}`);
  } else throw new Error("Expected plan, reserve, prepare-source, pack-workspace, publish-workspace, compatible or publication-state.");
}
