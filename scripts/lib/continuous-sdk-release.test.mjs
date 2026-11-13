import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { baselineHistory, contentChanged, dependentPackages, failedPublisherRuns, inputChanged, listReservations, packageInputs, publicationBaseline, publicationState, publicationTag, provenanceSource, qualifyWorkspace, readReservation, reserve, runtimeQualified, sharesReservations, tagPublisher } from "../continuous-sdk-release.mjs";
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

test("failed or cancelled main and tag publisher attempts latch until explicit owner acknowledgement", () => {
  const runs = [
    { id: 1, head_branch: "main", event: "workflow_run", status: "completed", conclusion: "failure" },
    { id: 2, head_branch: "v0.1.0-beta.170", event: "workflow_dispatch", status: "completed", conclusion: "cancelled" },
    { id: 3, head_branch: "feature", event: "workflow_dispatch", status: "completed", conclusion: "failure" },
    { id: 4, head_branch: "main", event: "workflow_run", status: "completed", conclusion: "success" },
    { id: 5, head_branch: "main", event: "pull_request", status: "completed", conclusion: "failure" },
    { id: 7, head_branch: "main", event: "schedule", status: "completed", conclusion: "failure" },
    // A tag run in flight belongs to the other concurrency group; it is never redispatched.
    { id: 8, head_branch: "v0.1.0-beta.171", event: "workflow_dispatch", status: "in_progress", conclusion: null },
    { id: 9, head_branch: "v1.0.0", event: "workflow_dispatch", status: "completed", conclusion: "failure" },
    { id: 10, head_branch: "sdk-v0.1.0-beta.171", event: "workflow_dispatch", status: "completed", conclusion: "failure" }
  ];
  assert.deepEqual(failedPublisherRuns(runs, "6").map(item => item.id), [1, 2]);
  assert.deepEqual(failedPublisherRuns(runs, "6", "1").map(item => item.id), [2]);
  assert.deepEqual(failedPublisherRuns(runs, "6", "2"), []);
  assert.deepEqual(failedPublisherRuns(runs, "11", "2").map(item => item.id), [7]);
  assert.throws(() => failedPublisherRuns(runs, "6", "unknown"));
});

test("only the main coordinator or a dispatched v0.1.0-beta.N tag may plan", () => {
  assert.equal(publicationTag({ GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "schedule" }), null);
  assert.equal(publicationTag({ GITHUB_REF: "refs/tags/v0.1.0-beta.170", GITHUB_EVENT_NAME: "workflow_dispatch" }), "v0.1.0-beta.170");
  for (const env of [
    { GITHUB_REF: "refs/tags/v0.1.0-beta.170", GITHUB_EVENT_NAME: "push" },
    { GITHUB_REF: "refs/heads/release/production", GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_REF: "refs/tags/sdk-v0.1.0-beta.170", GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_REF: "refs/tags/v0.1.0-beta.0", GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_REF: "refs/tags/v1.0.0", GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_REF: undefined, GITHUB_EVENT_NAME: "workflow_dispatch" }
  ]) assert.throws(() => publicationTag(env), /main coordinator or on a dispatched release tag/);
});

const reservationApi = ({ type = "tag", target = commit, record = {} } = {}) => path => {
  if (path === "git/ref/tags/v0.1.0-beta.170") return { object: { type, sha: "d".repeat(40) } };
  if (path === `git/tags/${"d".repeat(40)}`) return { object: { type: "commit", sha: target },
    message: `${JSON.stringify({ schema: "mdbase-npm-release/1", kind: "workspace", commit, reserved_at: "2026-11-10T00:00:00.000Z", run_id: "1", ...record })}\n` };
  throw new Error(`unexpected read ${path}`);
};

test("a publisher runs only on an annotated reservation, by either line, at its own commit", () => {
  assert.equal(readReservation("v0.1.0-beta.170", commit, reservationApi()).commit, commit);
  assert.equal(readReservation("v0.1.0-beta.170", commit, reservationApi({ record: { kind: "source" } })).commit, commit);
  assert.throws(() => readReservation("v0.1.0-beta.170", commit, reservationApi({ type: "commit" })), /annotated/);
  assert.throws(() => readReservation("v0.1.0-beta.170", commit, reservationApi({ target: "b".repeat(40) })), /exact commit/);
  assert.throws(() => readReservation("v0.1.0-beta.170", commit, reservationApi({ record: { kind: "desktop" } })));
  assert.throws(() => readReservation("v0.1.0-beta.170", commit, reservationApi({ record: { commit: "b".repeat(40) } })));
  assert.throws(() => readReservation("v0.1.0-beta.170", commit, reservationApi({ record: { schema: "mdbase-desktop-release/1" } })));
});

test("reservations are read from protected annotated tags and allocation sees every release tag", context => {
  const directory = mkdtempSync(join(tmpdir(), "publication-reservations-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const real = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: "pipe" }).trim();
  real("init", "-b", "main");
  real("config", "user.email", "test@example.invalid");
  real("config", "user.name", "Publication test");
  real("commit", "--allow-empty", "-qm", "one");
  const first = real("rev-parse", "HEAD");
  real("commit", "--allow-empty", "-qm", "two");
  const second = real("rev-parse", "HEAD");
  const record = (kind, target) => JSON.stringify({ schema: "mdbase-npm-release/1", kind, commit: target, reserved_at: "2026-11-10T00:00:00.000Z", run_id: "1" });
  real("tag", "-a", "v0.1.0-beta.160", "-m", JSON.stringify({ schema: "mdbase-desktop-release/1", commit: second }), second);
  real("tag", "v0.1.0-beta.161", second);
  real("tag", "-a", "v0.1.0-beta.170", "-m", record("workspace", second), second);
  real("tag", "-a", "v0.1.0-beta.172", "-m", record("workspace", second), second);
  real("tag", "-a", "v0.1.0-beta.171", "-m", record("source", second), second);
  real("tag", "-a", "v0.1.0-beta.173", "-m", record("workspace", second), first);
  real("tag", "-a", "sdk-v0.1.0-beta.174", "-m", record("workspace", second), second);
  const fetched = [];
  const runGit = (...args) => args[0] === "fetch" ? (fetched.push(args), "") : real(...args);
  const found = listReservations(second, ["source", "workspace"], runGit);
  assert.deepEqual(fetched, [["fetch", "--no-tags", "origin", "refs/tags/v*:refs/tags/v*"]]);
  assert.deepEqual(found.reserved, ["v0.1.0-beta.172", "v0.1.0-beta.171", "v0.1.0-beta.170"],
    "highest first; both lines' reservations of this commit, never other commits, mismatched peels or other schemas");
  assert.deepEqual(found.versions.sort(), ["0.1.0-beta.160", "0.1.0-beta.161", "0.1.0-beta.170", "0.1.0-beta.171", "0.1.0-beta.172", "0.1.0-beta.173"]);
  assert.deepEqual(listReservations(first, ["source", "workspace"], runGit).reserved, [], "a tag record naming another commit than its peel is no reservation");
  assert.deepEqual(listReservations(second, ["source"], runGit).reserved, ["v0.1.0-beta.171"], "a commit that predates shared reservations reuses only its own line's tags");
});

test("tag publication starts once the production commit's own publisher accepts tag runs", () => {
  const show = text => (...args) => {
    assert.deepEqual(args, ["show", `${commit}:.github/workflows/publish-sdk-npm.yml`]);
    return text;
  };
  assert.equal(tagPublisher("source", commit, show("    if: github.ref == 'refs/heads/main'\n")), false);
  for (const name of ["publish-npm", "publish-sdk-npm"]) {
    const current = readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
    assert.equal(tagPublisher(name === "publish-npm" ? "workspace" : "source", commit, () => current), true, name);
  }
});

test("the other line's tag is shared once the production commit's own planner accepts it", () => {
  const show = text => (...args) => {
    assert.deepEqual(args, ["show", `${commit}:scripts/continuous-sdk-release.mjs`]);
    return text;
  };
  assert.equal(sharesReservations(commit, show("export function readReservation(tag, kind, commit, readApi = api) {\n")), false);
  const current = readFileSync(new URL("../continuous-sdk-release.mjs", import.meta.url), "utf8");
  assert.equal(sharesReservations(commit, show(current)), true);
});

test("the coordinator reserves only commits whose exact Runtime CI passed", () => {
  const run = (change = {}) => ({ head_sha: commit, head_branch: "main", event: "push", path: ".github/workflows/runtime-ci.yml", status: "completed", conclusion: "success", ...change });
  assert.equal(runtimeQualified(commit, () => ({ workflow_runs: [run()] })), true);
  assert.equal(runtimeQualified(commit, () => ({ workflow_runs: [run({ event: "workflow_dispatch" })] })), true);
  for (const change of [{ conclusion: "failure" }, { status: "in_progress", conclusion: null }, { event: "pull_request" },
    { head_sha: "b".repeat(40) }, { head_branch: "feature" }, { path: ".github/workflows/server-ci.yml" }]) {
    assert.equal(runtimeQualified(commit, () => ({ workflow_runs: [run(change)] })), false, JSON.stringify(change));
  }
});

test("the coordinator creates the protected tag, then dispatches the publisher on it", context => {
  const directory = mkdtempSync(join(tmpdir(), "publication-reserve-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const planFile = join(directory, "plan.json");
  const env = { GITHUB_REPOSITORY: "mdbase-dev/mdbase-connect", GITHUB_REF: "refs/heads/main", GITHUB_RUN_ID: "77", SDK_RELEASE_STOPPED: "false" };
  const write = (existing, change = {}) => writeFileSync(planFile, JSON.stringify({ schema: 1, kind: "workspace", commit,
    packages: [{ name: "@mdbase-dev/ui", directory: "packages/app-ui", version: "0.1.0-beta.170" }],
    reservation: { tag: "v0.1.0-beta.170", existing }, ...change }));
  const harness = ({ runs = [], state = "active" } = {}) => {
    const calls = [];
    const reservations = reservationApi();
    return { calls, options: {
      readApi: path => {
        if (path === "actions/workflows/publish-npm.yml") return { state };
        if (path.startsWith("actions/workflows/publish-npm.yml/runs?branch=v0.1.0-beta.170&")) return { workflow_runs: runs };
        return reservations(path);
      },
      writeApi: (path, body) => { calls.push(["write", path, body]); return { sha: "e".repeat(40) }; },
      dispatch: (workflow, tag) => calls.push(["dispatch", workflow, tag])
    } };
  };
  write(false);
  const fresh = harness();
  reserve(planFile, env, fresh.options);
  assert.deepEqual(fresh.calls.map(call => call.slice(0, 2)), [["write", "git/tags"], ["write", "git/refs"], ["dispatch", "publish-npm.yml"]]);
  const [tagObject, reference, dispatch] = fresh.calls;
  assert.deepEqual({ ...tagObject[2], message: undefined }, { tag: "v0.1.0-beta.170", object: commit, type: "commit", message: undefined });
  assert.deepEqual({ ...JSON.parse(tagObject[2].message), reserved_at: undefined },
    { schema: "mdbase-npm-release/1", kind: "workspace", commit, reserved_at: undefined, run_id: "77" });
  assert.match(tagObject[2].message, /^\{"schema":"mdbase-npm-release\/1"/, "one-line record, schema first, for for-each-ref subjects");
  assert.deepEqual(reference[2], { ref: "refs/tags/v0.1.0-beta.170", sha: "e".repeat(40) });
  assert.equal(dispatch[2], "v0.1.0-beta.170");

  write(true);
  const run = change => ({ head_branch: "v0.1.0-beta.170", path: ".github/workflows/publish-npm.yml", status: "completed", conclusion: "failure", ...change });
  const inFlight = harness({ runs: [run({ status: "queued", conclusion: null })] });
  assert.match(reserve(planFile, env, inFlight.options), /in progress/);
  assert.deepEqual(inFlight.calls, [], "a reservation in flight is never redispatched");
  const retry = harness({ runs: [run()] });
  reserve(planFile, env, retry.options);
  assert.deepEqual(retry.calls, [["dispatch", "publish-npm.yml", "v0.1.0-beta.170"]], "an unpublished reservation is redispatched without a new tag");
  assert.throws(() => reserve(planFile, env, harness({ runs: [run({ conclusion: "success" })] }).options), /publication-reservation-unconsumed/);

  write(false);
  assert.throws(() => reserve(planFile, env, harness({ state: "disabled_manually" }).options), /stopped/);
  assert.throws(() => reserve(planFile, { ...env, GITHUB_REF: "refs/tags/v0.1.0-beta.170" }, harness().options));
  assert.throws(() => reserve(planFile, { ...env, SDK_RELEASE_STOPPED: "true" }, harness().options), /stopped/);
  write(false, { packages: [{ name: "@mdbase-dev/ui", directory: "packages/app-ui", version: "0.1.0-beta.171" }] });
  assert.throws(() => reserve(planFile, env, harness().options));
  write(false, { packages: [] });
  assert.throws(() => reserve(planFile, env, harness().options));
});

for (const [kind, workflow, other] of [["source", "publish-sdk-npm.yml", "workspace"], ["workspace", "publish-npm.yml", "source"]]) {
  test(`a ${kind} coordinator that loses the tag race to the ${other} line at the same commit publishes from that tag`, context => {
    const directory = mkdtempSync(join(tmpdir(), "publication-race-"));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const planFile = join(directory, "plan.json");
    writeFileSync(planFile, JSON.stringify({ schema: 1, kind, commit,
      packages: [{ name: "@mdbase-dev/sdk", directory: "runtime/packages/sdk", version: "0.1.0-beta.170" }],
      reservation: { tag: "v0.1.0-beta.170", existing: false, shared: true } }));
    const env = { GITHUB_REPOSITORY: "mdbase-dev/mdbase-connect", GITHUB_REF: "refs/heads/main", GITHUB_RUN_ID: "77", SDK_RELEASE_STOPPED: "false" };
    const lost = ({ existing, runs = [] }) => {
      const calls = [];
      const reservations = existing ? reservationApi({ ...existing, record: { kind: other, ...existing.record } }) : () => { throw new Error("HTTP 404"); };
      return { calls, options: {
        readApi: path => {
          if (path === `actions/workflows/${workflow}`) return { state: "active" };
          if (path.startsWith(`actions/workflows/${workflow}/runs?branch=v0.1.0-beta.170&`)) return { workflow_runs: runs };
          return reservations(path);
        },
        writeApi: (path, body) => {
          calls.push(["write", path]);
          if (path === "git/refs") throw new Error("gh: Reference already exists (HTTP 422)");
          return { sha: "e".repeat(40) };
        },
        dispatch: (name, tag) => calls.push(["dispatch", name, tag])
      } };
    };
    const joined = lost({ existing: {} });
    assert.match(reserve(planFile, env, joined.options), /joined the existing reservation and dispatched/);
    assert.deepEqual(joined.calls, [["write", "git/tags"], ["write", "git/refs"], ["dispatch", workflow, "v0.1.0-beta.170"]]);
    const inFlight = lost({ existing: {}, runs: [{ head_branch: "v0.1.0-beta.170", path: `.github/workflows/${workflow}`, status: "queued", conclusion: null }] });
    assert.match(reserve(planFile, env, inFlight.options), /in progress/);
    assert.deepEqual(inFlight.calls.filter(call => call[0] === "dispatch"), []);
    assert.throws(() => reserve(planFile, env, lost({ existing: { target: "b".repeat(40) } }).options), /not a reservation of .*exact commit/,
      "a tag at another commit is never adopted");
    assert.throws(() => reserve(planFile, env, lost({ existing: { type: "commit" } }).options), /not a reservation of .*annotated/,
      "a lightweight tag is never adopted");
    assert.throws(() => reserve(planFile, env, lost({ existing: { record: { commit: "b".repeat(40) } } }).options), /not a reservation of/);
    const plan = JSON.parse(readFileSync(planFile, "utf8"));
    writeFileSync(planFile, JSON.stringify({ ...plan, reservation: { ...plan.reservation, shared: false } }));
    const predates = lost({ existing: {} });
    assert.throws(() => reserve(planFile, env, predates.options), new RegExp(`${other} line's reservation and .* predates shared reservations`),
      "a production commit whose own planner requires its line's tag never publishes from the other line's tag");
    assert.deepEqual(predates.calls.filter(call => call[0] === "dispatch"), []);
    const own = lost({ existing: { record: { kind } } });
    assert.match(reserve(planFile, env, own.options), /joined the existing reservation/, "its own line's tag is always this reservation");
    writeFileSync(planFile, JSON.stringify(plan));
    const absent = lost({});
    assert.throws(() => reserve(planFile, env, absent.options), error => error.cause?.message.includes("Reference already exists"),
      "a ref failure without a matching tag keeps its cause and dispatches nothing");
    assert.deepEqual(absent.calls.filter(call => call[0] === "dispatch"), []);
  });
}

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

test("publisher jobs run only on reserved tags and build, pack and publish the run's own commit", () => {
  for (const [name, jobs] of [["publish-npm", ["pack", "publish"]], ["publish-sdk-npm", ["publish", "attest-internal", "publish-internal"]]]) {
    const workflow = readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
    assert.doesNotMatch(workflow, /CLIENT_RELEASE_COMMIT|export GITHUB_SHA|ref: \$\{\{ needs\.plan\.outputs\.commit/,
      "the tag is the run's commit; nothing may substitute another source");
    for (const job of jobs) {
      const block = workflow.split(`\n  ${job}:\n`)[1].split(/\n  [a-z][a-z-]*:\n/)[0];
      assert.match(block, /if: startsWith\(github\.ref, 'refs\/tags\/v0\.1\.0-beta\.'\) && needs\.plan\.outputs\.changed == 'true'/, `${name} ${job}`);
    }
    const reserving = workflow.split("\n  reserve:\n")[1].split(/\n  [a-z][a-z-]*:\n/)[0];
    assert.match(reserving, /if: github\.ref == 'refs\/heads\/main' && needs\.plan\.outputs\.reserve == 'true'/);
    assert.match(reserving, /actions: write\n      contents: write/);
    assert.doesNotMatch(reserving, /pnpm|id-token|environment:/, "the tag-writing job installs no dependencies and holds no publisher identity");
  }
  const sdk = readFileSync(new URL("../../.github/workflows/publish-sdk-npm.yml", import.meta.url), "utf8");
  const build = sdk.split("\n  build:\n")[1].split(/\n  [a-z][a-z-]*:\n/)[0];
  assert.match(build, /needs\.plan\.outputs\.changed == 'true'/, "only a tag plan reports changes, so only a tag run builds for release");
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
    assert.match(workflow, /continuous-sdk-release\.mjs compatible/);
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
  const future = save();
  writeFileSync(join(directory, "README.md"), "off-axis successor\n");
  const successor = save();
  git("checkout", "-qb", "diverged", base);
  writeFileSync(join(directory, "peer.txt"), "diverged\n");
  const diverged = save();
  const program = new URL("../continuous-sdk-release.mjs", import.meta.url).href;
  // tag: plan as the publisher dispatched on that reservation; otherwise as the
  // main coordinator whose own (main tip) commit is run.
  const execute = ({ kind, baselineCommit = production, run = production, selected = production, tag, published = [version],
    tags = ["0.1.0-beta.161"], reserved = [], runtime = true, tagReady = true, reservation = true, shared = true, compatibility = true, live = "true", aheadUi = false, priorFailure = false }) => {
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
  qualify: sha => { if (sha !== process.env.GITHUB_SHA && sha !== selected) throw new Error('wrong qualification'); },
  readPublished: async item => ({ version: ${JSON.stringify(published.at(-1))}, versions: ${JSON.stringify(published)},
    commit: ${JSON.stringify(aheadUi)} && item.name === '@mdbase-dev/ui' ? ${JSON.stringify(future)} : ${JSON.stringify(baselineCommit)} }),
  reservation: (tag, sha) => {
    if (!${JSON.stringify(reservation)} || tag !== ${JSON.stringify(tag ?? null)} || sha !== process.env.GITHUB_SHA) throw new Error('RAW-RESERVATION');
  },
  sharedAt: sha => { if (sha !== selected) throw new Error('wrong shared-reservation commit'); return ${JSON.stringify(shared)}; },
  reservations: (sha, kinds) => {
    if (sha !== selected) throw new Error('reservations read for the wrong commit');
    if (JSON.stringify(kinds) !== ${JSON.stringify(JSON.stringify(shared ? ["source", "workspace"] : [kind]))}) throw new Error('wrong reservation lines');
    return { versions: ${JSON.stringify(tags)}, reserved: ${JSON.stringify(reserved)} };
  },
  runtimeCi: sha => { if (sha !== selected) throw new Error('wrong runtime commit'); return ${JSON.stringify(runtime)}; },
  publisherAt: (kind, sha) => { if (sha !== selected) throw new Error('wrong publisher commit'); return ${JSON.stringify(tagReady)}; },
  checkAttempts: () => { if (${JSON.stringify(priorFailure)}) throw new Error('RAW-PRIOR-ATTEMPT-STDERR'); },
  verify: async () => {
    if (!${JSON.stringify(compatibility)}) throw new Error('RAW-COMPATIBILITY-STDERR');
    return { candidate: process.env.GITHUB_SHA };
  }
});`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: directory, encoding: "utf8",
      env: { ...process.env, GITHUB_REPOSITORY: "mdbase-dev/mdbase-connect", GITHUB_REF: tag ? `refs/tags/${tag}` : "refs/heads/main",
        GITHUB_EVENT_NAME: tag ? "workflow_dispatch" : "schedule",
        GITHUB_SHA: run, LIVE_PUBLICATION: live, SDK_RELEASE_STOPPED: "false", GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary } });
    return { ...result, summary: existsSync(summary) ? readFileSync(summary, "utf8") : "",
      output: existsSync(output) ? readFileSync(output, "utf8") : "",
      plan: existsSync(planFile) ? JSON.parse(readFileSync(planFile, "utf8")) : undefined };
  };
  return { execute, base, production, future, successor, diverged };
}

for (const kind of ["source", "workspace"]) {
  test(`${kind} coordinator selects production, reserves one tag version and never waits for its own main commit`, async context => {
    const { execute, base, production, future, successor, diverged } = plannerFixture(context);
    const names = kind === "source" ? [name] : (await publicPackages()).map(item => item.name);
    const check = (result, decision, selected = production, run = successor) => {
      for (const item of names) {
        assert(result.summary.includes(`${item}: selected production ${selected}; run ${run}; published baseline `), result.summary);
      }
      assert.match(result.summary, decision);
      assert(result.stdout.includes(result.summary.split("\n").find(line => line.startsWith("- @")).slice(2)), "same diagnostic appears in log and summary");
      assert.doesNotMatch(result.stdout + result.stderr + result.summary, /RAW-|Command failed|waiting for production to reach commit [a-f0-9]{40}; /);
    };
    // Main has moved past production (run = successor): the coordinator plans production itself.
    const reserving = execute({ kind, baselineCommit: base, run: successor });
    assert.equal(reserving.status, 0, reserving.stderr);
    assert.equal(reserving.plan.commit, production);
    assert.deepEqual(reserving.plan.reservation, { tag: "v0.1.0-beta.162", existing: false, shared: true }, "above every package and release tag version");
    assert.deepEqual(reserving.plan.packages.map(item => [item.name, item.version]), names.map(item => [item, "0.1.0-beta.162"]));
    assert.equal(reserving.plan.tag, undefined);
    assert.match(reserving.output, /^commit=[a-f0-9]{40}\nchanged=false\npublish=false\nreserve=true\nversion=0\.1\.0-beta\.162\n$/);
    assert(reserving.output.startsWith(`commit=${production}\n`));
    check(reserving, new RegExp(`reserving v0\\.1\\.0-beta\\.162 at ${production} to publish 0\\.1\\.0-beta\\.162`));

    const above = execute({ kind, baselineCommit: base, run: successor, tags: ["0.1.0-beta.170"], published: ["0.1.0-beta.9", "0.1.0-beta.180"] });
    assert.deepEqual(above.plan.reservation, { tag: "v0.1.0-beta.181", existing: false, shared: true });
    const tagged = execute({ kind, baselineCommit: base, run: successor, tags: ["0.1.0-beta.190"] });
    assert.deepEqual(tagged.plan.reservation, { tag: "v0.1.0-beta.191", existing: false, shared: true }, "Desktop and retired server tags share the namespace");

    const reuse = execute({ kind, baselineCommit: base, run: successor, tags: ["0.1.0-beta.200"], reserved: ["v0.1.0-beta.200", "v0.1.0-beta.170"] });
    assert.deepEqual(reuse.plan.reservation, { tag: "v0.1.0-beta.200", existing: true, shared: true });
    const predatesShared = execute({ kind, baselineCommit: base, run: successor, shared: false, tags: ["0.1.0-beta.200"], reserved: ["v0.1.0-beta.200"] });
    assert.equal(predatesShared.status, 0, predatesShared.stderr);
    assert.deepEqual(predatesShared.plan.reservation, { tag: "v0.1.0-beta.200", existing: true, shared: false },
      "a commit that predates shared reservations reads only its own line's tags");
    check(reuse, /dispatching reserved v0\.1\.0-beta\.200 at /);
    const stale = execute({ kind, baselineCommit: base, run: successor, published: ["0.1.0-beta.201"], tags: ["0.1.0-beta.200"], reserved: ["v0.1.0-beta.200"] });
    assert.deepEqual(stale.plan.reservation, { tag: "v0.1.0-beta.202", existing: false, shared: true }, "a reservation below a published version is never reused");

    const dry = execute({ kind, baselineCommit: base, run: successor, live: "false", priorFailure: true });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.output, /changed=false\npublish=false\nreserve=false\n/);
    check(dry, /would reserve v0\.1\.0-beta\.162 at /);

    for (const run of [production, successor]) {
      const ahead = execute({ kind, baselineCommit: future, run, compatibility: false, priorFailure: true });
      assert.equal(ahead.status, 0, ahead.stderr);
      assert.deepEqual(ahead.plan.packages, []);
      assert.equal(ahead.plan.compatibility, undefined);
      assert.equal(ahead.plan.reservation, undefined);
      assert.match(ahead.output, /changed=false\npublish=false\nreserve=false\n/);
      check(ahead, new RegExp(`nothing to publish; waiting for production to reach commit ${future}\\.`), production, run);
    }
    const divergence = execute({ kind, baselineCommit: diverged });
    assert.equal(divergence.status, 1);
    assert.equal(divergence.plan, undefined);
    assert.equal(divergence.output, "");
    check(divergence, /blocked: publication-baseline-diverged/, production, production);

    const invalid = execute({ kind, baselineCommit: "0".repeat(40) });
    assert.equal(invalid.status, 1);
    check(invalid, /blocked: publication-ancestry-unavailable/, production, production);
    assert.doesNotMatch(invalid.stdout + invalid.stderr, /fatal:/, "real Git stderr must stay captured");

    const empty = execute({ kind, run: successor, compatibility: false, priorFailure: true });
    assert.equal(empty.status, 0, empty.stderr);
    check(empty, /nothing to publish\./);
    assert.match(empty.output, /changed=false\npublish=false\nreserve=false\nversion=\n/);

    const caughtUp = execute({ kind, baselineCommit: production, selected: future, run: successor });
    assert.equal(caughtUp.plan.commit, future);
    assert.deepEqual(caughtUp.plan.packages.map(item => item.name), names, "promotion releases the previously pending inputs");
    assert.match(caughtUp.output, /reserve=true/);

    const prior = execute({ kind, baselineCommit: base, run: successor, priorFailure: true });
    assert.equal(prior.status, 1);
    check(prior, /blocked: publication-prior-attempt-unreconciled/);

    // A source plan waiting for Runtime CI selects nothing, so it reaches neither gate.
    const runtime = execute({ kind, baselineCommit: base, run: successor, runtime: false,
      compatibility: kind === "workspace", priorFailure: kind === "source" });
    assert.equal(runtime.status, 0, runtime.stderr);
    if (kind === "source") {
      assert.deepEqual(runtime.plan.packages, []);
      assert.match(runtime.output, /reserve=false/);
      check(runtime, new RegExp(`nothing to publish; waiting for successful Runtime CI of commit ${production}`));
    } else {
      assert.equal(runtime.plan.packages.length, names.length, "workspace packages do not need Runtime CI");
    }

    const predates = execute({ kind, baselineCommit: base, run: successor, tagReady: false, compatibility: false, priorFailure: true });
    assert.equal(predates.status, 0, predates.stderr);
    assert.deepEqual(predates.plan.packages, []);
    assert.equal(predates.plan.reservation, undefined, "never reserve a tag whose publisher would skip every job");
    check(predates, new RegExp(`waiting for production to contain tag publication \\(${production} predates it\\)`));

    if (kind === "workspace") {
      const mixed = execute({ kind, baselineCommit: base, aheadUi: true, run: successor, compatibility: false, priorFailure: true });
      assert.equal(mixed.status, 0, mixed.stderr);
      assert.deepEqual(mixed.plan.packages, [], "dependency expansion must never repack source behind a baseline");
      check(mixed, new RegExp(`waiting for production to reach commit ${future}`));
      for (const live of ["true", "false"]) {
        const blocked = execute({ kind, baselineCommit: base, run: successor, compatibility: false, live });
        assert.equal(blocked.status, live === "true" ? 1 : 0, blocked.stderr);
        check(blocked, /blocked: production-compatibility-unproven/);
        assert.equal(blocked.plan.compatibility.status, "blocked");
        assert.match(blocked.output, live === "true" ? /^$/ : /reserve=false/, "an incompatible selection reserves nothing");
      }
    }
  });

  test(`${kind} tag run publishes its own commit at the tag's version`, async context => {
    const { execute, base, production, future } = plannerFixture(context);
    const names = kind === "source" ? [name] : (await publicPackages()).map(item => item.name);
    const tag = "v0.1.0-beta.170";
    const publishing = execute({ kind, tag, baselineCommit: base, selected: "unused", runtime: false });
    assert.equal(publishing.status, 0, publishing.stderr);
    assert.equal(publishing.plan.commit, production);
    assert.equal(publishing.plan.tag, tag);
    assert.equal(publishing.plan.reservation, undefined);
    assert.deepEqual(publishing.plan.packages.map(item => [item.name, item.version]), names.map(item => [item, "0.1.0-beta.170"]));
    assert.equal(publishing.output, `commit=${production}\nchanged=true\npublish=true\nreserve=false\nversion=0.1.0-beta.170\n`);
    assert.match(publishing.summary, new RegExp(`publishing 0\\.1\\.0-beta\\.170 from ${production}`));

    const done = execute({ kind, tag, baselineCommit: production, published: ["0.1.0-beta.170"], selected: "unused" });
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(done.plan.packages, [], "a rerun after publication has nothing left to publish");
    assert.match(done.output, /changed=false\npublish=false/);

    const superseded = execute({ kind, tag, baselineCommit: base, published: ["0.1.0-beta.171"], selected: "unused" });
    assert.equal(superseded.status, 1);
    assert.match(superseded.summary, /blocked: publication-version-superseded/);
    assert.equal(superseded.plan, undefined);

    const ahead = execute({ kind, tag, baselineCommit: future, selected: "unused" });
    assert.equal(ahead.status, 0, ahead.stderr);
    assert.deepEqual(ahead.plan.packages, []);

    const forged = execute({ kind, tag, baselineCommit: base, reservation: false, selected: "unused" });
    assert.equal(forged.status, 1);
    assert.equal(forged.plan, undefined);
    assert.equal(forged.output, "");

    const prior = execute({ kind, tag, baselineCommit: base, priorFailure: true, selected: "unused" });
    assert.equal(prior.status, 1);
    assert.match(prior.summary, /blocked: publication-prior-attempt-unreconciled/);
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
