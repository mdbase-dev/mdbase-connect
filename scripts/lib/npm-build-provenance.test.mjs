import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildPredicate, npmBuildStatement, publishArchive } from "./npm-build-provenance.mjs";
import { provenSource, provenanceSource } from "../continuous-sdk-release.mjs";

const source = "a".repeat(40);
const run = "b".repeat(40);
const version = "0.1.0-beta.168";
const env = workflow => ({ GITHUB_REPOSITORY: "mdbase-dev/mdbase-connect", GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: source, PUBLICATION_RUN_COMMIT: run, GITHUB_WORKFLOW: workflow,
  GITHUB_WORKFLOW_REF: `mdbase-dev/mdbase-connect/.github/workflows/${workflow === "Publish npm packages" ? "publish-npm.yml" : "publish-sdk-npm.yml"}@refs/heads/main`,
  RUNNER_ENVIRONMENT: "github-hosted", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
  GITHUB_REPOSITORY_ID: "456", GITHUB_REPOSITORY_OWNER_ID: "789" });
const bundle = statement => ({ dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } });

for (const [workflow, name, file] of [["Publish npm packages", "@mdbase-dev/ui", "publish-npm.yml"],
  ["Publish source-built SDK", "@mdbase-dev/sdk", "publish-sdk-npm.yml"]]) {
  test(`${workflow} signs production bytes and source while preserving the authenticated workflow identity`, async t => {
    const directory = mkdtempSync(join(tmpdir(), "npm-build-source-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const archive = join(directory, "package.tgz");
    const bytes = Buffer.from("qualified production package bytes");
    writeFileSync(archive, bytes);
    const statement = npmBuildStatement(archive, name, version, env(workflow));
    const definition = statement.predicate.buildDefinition;
    assert.equal(definition.resolvedDependencies[0].digest.gitCommit, run);
    assert.equal(definition.resolvedDependencies[0].uri, "git+https://github.com/mdbase-dev/mdbase-connect@refs/heads/main");
    assert.deepEqual(definition.externalParameters.source, { repository: "https://github.com/mdbase-dev/mdbase-connect", commit: source });
    assert.equal(definition.externalParameters.workflow.path, `.github/workflows/${file}`);
    assert.deepEqual(statement.predicate, buildPredicate(env(workflow)), "GitHub archive attestations use the same source binding");
    const baseline = { version, workflow: file, entry: { dist: { integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` } } };
    let verified = false;
    const proof = await provenSource(name, baseline, {
      readRegistry: async () => ({ attestations: [{ predicateType: statement.predicateType, bundle: bundle(statement) }] }),
      verifyBundle: async (signed, identity) => {
        assert.deepEqual(signed, bundle(statement));
        assert.equal(identity.identity, `https://github.com/mdbase-dev/mdbase-connect/.github/workflows/${file}@refs/heads/main`);
        verified = true;
      },
    });
    assert.equal(verified, true);
    assert.equal(proof.commit, source, "history and duplicate-publication checks use production, not the controller run");
    for (const mutate of [
      value => { value.predicate.buildDefinition.externalParameters.source.commit = "main"; },
      value => { value.predicate.buildDefinition.externalParameters.source.repository = "https://github.com/other/repo"; },
      value => { value.subject[0].digest.sha512 = "c".repeat(128); },
    ]) {
      const changed = structuredClone(statement);
      mutate(changed);
      assert.throws(() => provenanceSource(bundle(changed), baseline, name));
    }
    await assert.rejects(provenSource(name, baseline, {
      readRegistry: async () => ({ attestations: [{ predicateType: statement.predicateType, bundle: bundle(statement) }] }),
      verifyBundle: async () => { throw new Error("invalid signature"); },
    }), /invalid signature/);
    let published = 0;
    await publishArchive(archive, name, version, env(workflow), {
      sign: async (payload, type) => {
        assert.equal(type, "application/vnd.in-toto+json");
        assert.deepEqual(JSON.parse(payload), statement);
        return bundle(statement);
      },
      runNpm: (command, args, options) => {
        published++;
        assert.equal(command, "npm");
        assert.deepEqual(args, ["publish", archive, "--ignore-scripts", "--access", "public", "--registry",
          "https://registry.npmjs.org/", "--tag", "latest", "--provenance-file", `${archive}.sigstore.json`]);
        assert.equal(options.env.GITHUB_SHA, run);
        assert.deepEqual(JSON.parse(readFileSync(args.at(-1))), bundle(statement));
      },
    });
    assert.equal(published, 1);
    assert.equal(env(workflow).GITHUB_SHA, source);
  });
}

test("invalid workflow/source identities refuse before signing or publishing", () => {
  for (const change of [{ GITHUB_SHA: "main" }, { PUBLICATION_RUN_COMMIT: undefined },
    { GITHUB_REPOSITORY: "other/repo" }, { GITHUB_REF: "refs/heads/feature" },
    { GITHUB_WORKFLOW_REF: "unreviewed" }, { GITHUB_WORKFLOW: "other" }, { RUNNER_ENVIRONMENT: "self-hosted" }]) {
    assert.throws(() => buildPredicate({ ...env("Publish npm packages"), ...change }));
  }
});
