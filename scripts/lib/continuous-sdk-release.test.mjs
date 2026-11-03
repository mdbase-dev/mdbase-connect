import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentChanged, dependentPackages, failedPublisherRuns, packageInputs, publicationBaseline, provenanceSource } from "../continuous-sdk-release.mjs";

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

test("automatic publishers keep isolated OIDC, source qualification and explicit dry-run dispatches", () => {
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
});
