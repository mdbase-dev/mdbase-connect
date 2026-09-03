import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { availableTcpPort, poll } from "./test-runtime.mjs";

const execute = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../..");

test("upgrade workflows delegate scenario behavior to versioned test programs", async () => {
  const workflow = await readFile(
    resolve(repoRoot, ".github/workflows/server-ci.yml"),
    "utf8"
  );
  assert.match(workflow, /run: test\/upgrade\/server-from-previous/);
  assert.match(workflow, /run: test\/upgrade\/provider-from-previous/);
  assert.doesNotMatch(workflow, /node --input-type=module --eval/);
  assert.doesNotMatch(workflow, /INSERT INTO hosted_provider_/);
});

test("upgrade pins the exact immediate predecessor", async () => {
  const fixture = await readFile(
    resolve(repoRoot, ".github/previous-release.env"),
    "utf8"
  );
  assert.equal(fixture, `# Exact server image from the release immediately preceding this candidate.
# Update this file as part of each release-preparation change.
MDBASE_CONNECT_PREVIOUS_RELEASE=v0.1.0-beta.94
MDBASE_CONNECT_PREVIOUS_RELEASE_COMMIT=8d1b5fb1647edcadd716d4ee671f0ba04d34fa5e
MDBASE_CONNECT_PREVIOUS_SERVER_IMAGE=ghcr.io/mdbase-dev/mdbase-connect-server@sha256:f1243c22160489d5d9044df2a1a14e05b36e00f7d01aaeca865d797bdd31aa94
MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE=ghcr.io/mdbase-dev/mdbase-connect-hosted-provider@sha256:caf69fea20acf7da3dac91a9babbb175f4789c7455684664734956237cd7667c
`);
});

test("both upgrade programs execute release and pulled-image verification", async () => {
  const helpers = await readFile(resolve(repoRoot, "test/upgrade/lib.sh"), "utf8");
  assert.match(helpers, /upgrade_verify_previous_release\(\)/);
  assert.match(helpers, /api\.github\.com\/repos\/mdbase-dev\/mdbase-connect\/releases\?per_page=100/);
  assert.match(helpers, /git -C "\$repo_root" ls-remote --exit-code --tags origin/);
  assert.match(helpers, /"refs\/tags\/\$release\^\{\}"/);
  assert.match(helpers, /upgrade_verify_previous_image\(\)/);
  assert.match(helpers, /docker image inspect "\$image"/);
  assert.match(helpers, /org\.opencontainers\.image\.source/);
  assert.match(helpers, /org\.opencontainers\.image\.revision/);

  for (const [script, imageVariable] of [
    ["test/upgrade/server-from-previous", "MDBASE_CONNECT_PREVIOUS_SERVER_IMAGE"],
    ["test/upgrade/provider-from-previous", "MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE"]
  ]) {
    const program = await readFile(resolve(repoRoot, script), "utf8");
    const releaseCheck = program.indexOf('upgrade_verify_previous_release "$repo_root"');
    const pull = program.indexOf(`docker pull "$${imageVariable}"`);
    const imageCheck = program.indexOf(`upgrade_verify_previous_image "$${imageVariable}"`);
    assert.ok(releaseCheck >= 0 && releaseCheck < pull, `${script} must verify the release before use`);
    assert.ok(pull >= 0 && imageCheck > pull, `${script} must inspect the image after pulling it`);
  }
});

test("candidate writes predecessor state before explicit projection work", async () => {
  const program = await readFile(
    resolve(repoRoot, "test/upgrade/provider-from-previous"),
    "utf8"
  );
  const writePhase = program.indexOf(
    "upgrade_phase 'writing predecessor-created persisted state before projection rebuild'"
  );
  const write = program.indexOf('"$(exact_mutation_body "$previous_revision")"', writePhase);
  const readBack = program.indexOf("pre_rebuild_snapshot=$(provider_get", write);
  const firstProjectionWork = program.indexOf("run_projection_indexer ", writePhase);
  const verify = program.indexOf("run_projection_indexer verify", readBack);
  const recovery = program.indexOf("upgrade_phase 'requiring candidate recovery readiness'", verify);
  const finalVerify = program.indexOf(
    "upgrade_phase 'verifying projections after final provider restart'",
    recovery
  );
  assert.ok(writePhase >= 0 && write > writePhase, "pre-rebuild write is missing");
  assert.ok(readBack > write, "exact read-back must follow the pre-rebuild write");
  assert.ok(verify > readBack, "read-only projection verification must remain post-write");
  assert.ok(recovery > verify, "notification recovery must follow projection verification");
  assert.ok(finalVerify > recovery, "projection verification must run again after final restart");
  assert.match(program, /\.status == "ready"[\s\S]*\.notifications\.configured == true[\s\S]*\.notifications\.recovery == "ok"[\s\S]*\.projections\.degraded_collections == 0/);
  assert.equal(
    firstProjectionWork,
    verify,
    "no explicit projection command may precede the write/read-back"
  );
  assert.doesNotMatch(program, /run_projection_indexer cutover/);
  assert.doesNotMatch(program, /finalize-hosted-query-admission\.sql/);
});

test("upgrade shell programs are syntactically valid", async () => {
  for (const script of [
    "test/upgrade/lib.sh",
    "test/upgrade/server-from-previous",
    "test/upgrade/provider-from-previous"
  ]) {
    await execute("bash", ["-n", resolve(repoRoot, script)]);
  }
});

test("previous-provider fixture preserves a canonical notification authority", async () => {
  const fixture = await readFile(
    resolve(repoRoot, "test/upgrade/provider-notification.sql"),
    "utf8"
  );
  assert.doesNotMatch(fixture, /INSERT INTO hosted_provider_collections/);
  assert.match(fixture, /INSERT INTO hosted_provider_notification_grants/);
  assert.match(fixture, /"application_declaration_id":"legacy\.unbound\./);
  assert.match(fixture, /"application_manifest_digest":"sha256:[0-9a-f]{64}"/);
  assert.match(fixture, /"authorization_binding":5/);
  assert.match(fixture, /mdbase\.runtime\.timer\.fired/);
  assert.match(fixture, /"version":"1\.0\.0"/);
  assert.match(
    fixture,
    /ARRAY\[\]::text\[\],[\s\S]*?'\[\]'::jsonb,[\s\S]*?true,[\s\S]*?da324885/
  );
  assert.doesNotMatch(fixture, /full-collection-false application/);
  assert.doesNotMatch(fixture, /allowed-types application/);
  assert.doesNotMatch(fixture, /contract-scope application/);
});

test("provider upgrade proves exact application replay without canonical writes", async () => {
  const program = await readFile(
    resolve(repoRoot, "test/upgrade/provider-from-previous"),
    "utf8"
  );
  assert.match(program, /predecessor_application_receipt=\$\(provider_application_operation/);
  assert.match(program, /replayed_application_receipt == "\$predecessor_application_receipt"/);
  assert.match(program, /query_canonical_authority_inventory/);
  assert.match(program, /changed_status == 409/);
  assert.match(program, /mutation_request_conflict/);
  assert.doesNotMatch(program, /hosted_provider_retired_replay_credentials/);
  assert.doesNotMatch(program, /invalid_replica_token/);
});

test("S3 readiness fixture serves a scoped empty bucket listing", async (context) => {
  const port = await availableTcpPort();
  const child = execFile(
    process.execPath,
    [resolve(repoRoot, "test/upgrade/r2-readiness-stub.mjs")],
    { env: { ...process.env, R2_STUB_PORT: String(port) } }
  );
  context.after(() => child.kill("SIGTERM"));

  const response = await poll(
    () => fetch(`http://127.0.0.1:${port}`).catch(() => undefined),
    "S3 readiness fixture did not start",
    40,
    25
  );
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /<Name>upgrade-canary<\/Name>/);
  assert.match(body, /<Prefix>v1\/<\/Prefix>/);
  assert.match(body, /<KeyCount>0<\/KeyCount>/);
});
