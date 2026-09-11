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
MDBASE_CONNECT_PREVIOUS_RELEASE=v0.1.0-beta.96
MDBASE_CONNECT_PREVIOUS_RELEASE_COMMIT=56ed32ffde055d2ab2b22ff95722df8ef06bdb1d
MDBASE_CONNECT_PREVIOUS_SERVER_IMAGE=ghcr.io/mdbase-dev/mdbase-connect-server@sha256:84bb6bf960046d303a7333a3d52ffeeab96feb06a8b3d311a75ccd1f3af09b59
MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE=ghcr.io/mdbase-dev/mdbase-connect-hosted-provider@sha256:dbd58b57dc280d2ee1de5cac53e92e813be02f108de4c1327ee53ee2d363625d
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
    ["test/upgrade/retained-v2.sh", "MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE"]
  ]) {
    const program = await readFile(resolve(repoRoot, script), "utf8");
    const verifier = script.endsWith('retained-v2.sh')
      ? 'upgrade_verify_retained_v2_release' : 'upgrade_verify_previous_release';
    const releaseCheck = program.indexOf(`${verifier} "$repo_root"`);
    const imageCheck = program.indexOf(`upgrade_verify_previous_image "$${imageVariable}"`);
    assert.ok(releaseCheck >= 0 && releaseCheck < imageCheck, `${script} must verify the release before use`);
    if (script.endsWith('retained-v2.sh')) {
      const cachedImage = program.indexOf(`docker image inspect "$${imageVariable}"`);
      assert.ok(cachedImage >= 0 && cachedImage < imageCheck, 'provider must verify its cached immutable image');
      assert.match(program, /source "\$repo_root\/\.github\/retained-v2-predecessor\.env"/);
    } else {
      const pull = program.indexOf(`docker pull "$${imageVariable}"`);
      assert.ok(pull >= 0 && imageCheck > pull, `${script} must inspect the image after pulling it`);
    }
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
  const verificationHelper = program.match(/^verify_synthetic_projection\(\) \{\n([\s\S]*?)^\}/m)?.[1];
  assert.ok(verificationHelper, "projection diagnostic helper is missing");
  assert.deepEqual(
    verificationHelper.match(/run_projection_indexer\s+\S+/g),
    ["run_projection_indexer verify"],
    "the diagnostic helper must only run read-only verification"
  );
  assert.match(verificationHelper, /\.ok == true[\s\S]*\.command == "verify"[\s\S]*\(\.result\.collections \| length\) == 1[\s\S]*\.result\.collections\[0\]\.verified == true/);
  const firstProjectionCall = /(?:run_projection_indexer|verify_synthetic_projection)\s+/.exec(program.slice(writePhase));
  const firstProjectionWork = firstProjectionCall ? writePhase + firstProjectionCall.index : -1;
  const verify = program.indexOf("verify_synthetic_projection 'write-through without normalization'", readBack);
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
  assert.ok(
    program.indexOf("verify_synthetic_projection 'after final provider restart'", finalVerify) > finalVerify,
    "final restart verification must invoke the checked read-only helper"
  );
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
    "test/upgrade/provider-from-previous",
    "test/upgrade/provider-atomic-overlap.sh"
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

test("provider rollback uses the verified unchanged predecessor after existing replay assertions", async () => {
  const program = await readFile(resolve(repoRoot, "test/upgrade/provider-from-previous"), "utf8");
  const phases = [
    '[[ $changed_status == 409 ]]',
    "upgrade_phase 'rolling back only the image on the migrated 0041 database'",
    'upgrade_remove_container mdbase-provider-upgrade-candidate',
    'upgrade_verify_previous_image "$MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE"',
    'start_previous_provider mdbase-provider-previous-rollback false',
    "upgrade_phase 'registering new legacy application and mirror through predecessor HTTP'",
    "upgrade_phase 'narrowing predecessor policy with exact retry epoch checks'",
    'upgrade_remove_container mdbase-provider-previous-rollback',
    "upgrade_phase 'reupgrading predecessor-written NULL metadata without normalization'",
    'start_candidate_provider',
    'wait_candidate_recovery',
    "verify_synthetic_projection 'after predecessor writes and candidate reupgrade'",
    "printf 'Historical beta94 v1 prelude persisted-state path passed; not v2 rollback qualification."
  ];
  let position = -1;
  for (const phase of phases) {
    const next = program.indexOf(phase, position + 1);
    assert.ok(next > position, `missing or out-of-order rollback step: ${phase}`);
    position = next;
  }
  const previous = program.match(/^start_previous_provider\(\) \{\n([\s\S]*?)^\}/m)?.[1];
  assert.match(previous, /"\$MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE"/);
  assert.doesNotMatch(previous, /CANDIDATE_IMAGE|--entrypoint|--volume/);
  assert.doesNotMatch(program, /(?:ALTER|DROP|TRUNCATE)\s+(?:TABLE|COLUMN)|(?:INSERT INTO|UPDATE|DELETE FROM)\s+_sqlx_migrations/i);
  assert.doesNotMatch(program, /^\s*MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE=/m);
  assert.match(program, /rollback_ledger_before/);
  assert.match(program, /rollback_receipts_before/);
  assert.match(program, /SELECT to_jsonb\(j\) FROM hosted_provider_mutation_journal j ORDER BY replica_id, request_id/);
  assert.match(program, /sequential image rollback\/reupgrade, NOT concurrent rolling/);
  assert.match(program, /NOT signed candidate publication qualification/);
  assert.match(program, /NOT evidence of safe production rollback/);
});

test("predecessor HTTP probes retain legacy binding and NULL metadata semantics", async () => {
  const program = await readFile(resolve(repoRoot, "test/upgrade/provider-from-previous"), "utf8");
  const body = program.match(/^rollback_application_body\(\) \{\n([\s\S]*?)^\}/m)?.[1];
  assert.ok(body);
  assert.doesNotMatch(body, /application_semantic_version|application_setup_evidence/);
  assert.match(body, /allowed_types:\[\],contract_scope:\[\],full_collection:true/);
  assert.match(body, /allowed_origin:"https:\/\/example.test",proof_public_key:null/);
  assert.match(body, /application_declaration_id:"dev.mdbase.upgrade.rollback"/);
  assert.match(program, /for field in application_id declaration_digest/);
  assert.match(program, /\.error.code == "application_declaration_mismatch"/);
  assert.match(program, /\.result.valid == true/);
  assert.match(program, /\.application_semantic_version == \$semantics/);
  assert.match(program, /\.application_setup_evidence == null/);
  assert.match(program, /\.token_hash == \$token_hash/);
  assert.match(program, /rollback_assert_policy "\$rollback_application" 1/);
  assert.match(program, /rollback_assert_policy "\$rollback_narrowed" 2\n/);
  assert.equal((program.match(/rollback_assert_policy "\$rollback_narrowed" 2 1/g) ?? []).length, 2);
  assert.match(program, /UPGRADE_ROLLBACK_APPLICATION_TOKEN UPGRADE_ROLLBACK_MIRROR_TOKEN GITHUB_TOKEN/);
  assert.match(program, /text=\$\{text:0:8192\}/);
});

test("actual-binary overlap is clone-owned and observes atomicity before readiness", async () => {
  const program = await readFile(resolve(repoRoot, "test/upgrade/provider-from-previous"), "utf8");
  const overlap = await readFile(resolve(repoRoot, "test/upgrade/provider-atomic-overlap.sh"), "utf8");
  assert.ok(program.indexOf("\nprovider_atomic_overlap\n") > program.indexOf("predecessor_application_receipt=$("));
  assert.ok(program.indexOf("\nprovider_atomic_overlap\n") < program.indexOf("upgrade_phase 'writing predecessor-created"));
  assert.match(program, /local name=\$\{1:-mdbase-provider-upgrade-candidate\}/);
  assert.match(program, /local port=\$\{2:-\$UPGRADE_PROVIDER_PORT\}/);
  assert.match(overlap, /provider_atomic_overlap\(\) \(/);
  assert.match(overlap, /\[\[ \$DATABASE_URL == "\$expected" \]\]/);
  assert.match(overlap, /CREATE DATABASE \$db TEMPLATE mdbase_provider_upgrade/);
  assert.match(overlap, /trap overlap_cleanup EXIT/);
  assert.match(overlap, /DROP DATABASE \$db WITH \(FORCE\)/);
  assert.match(overlap, /for pid in "\$\{curls\[@\]\}"; do kill/);
  for (const name of ["candidate", "previous", "holder"]) {
    assert.ok(overlap.includes(`upgrade_remove_container "$${name}"`));
  }
  assert.match(overlap, /AFTER INSERT ON _sqlx_migrations/);
  assert.match(overlap, /IF NEW.version = 40 THEN/);
  assert.match(overlap, /pg_advisory_xact_lock\(194038, 41\)/);
  assert.match(overlap, /pg_locks[\s\S]*application_name='\$candidate'[\s\S]*NOT l.granted/);
  assert.match(overlap, /SELECT max\(version\) FROM _sqlx_migrations WHERE success'\) == 38/);
  assert.match(overlap, /Atomicity failure: external connection sees migration39\/40 before41/);
  assert.match(overlap, /application_setup_evidence','application_semantic_version/);
  assert.doesNotMatch(overlap, /(?:UPDATE|DELETE FROM|INSERT INTO)\s+_sqlx_migrations/i);
  assert.doesNotMatch(overlap, /--entrypoint|SKIP_|ALTER TABLE/);
  assert.match(overlap, /201:0/);
  assert.match(overlap, /000:28/);
  assert.match(overlap, /provider_database_timeout.*timeout_class == "lock"/);
  assert.match(overlap, /rollback_assert_policy "\$rollback_narrowed" 2/);
  assert.match(overlap, /rollback_receipt_inventory\) == "\$receipts"/);
  const success = overlap.indexOf("upgrade_phase 'releasing actual atomic38-to41");
  let position = success;
  for (const step of ["\n  overlap_hold", "\n  overlap_launch", "\n  overlap_release", "\n  overlap_join", " wait_candidate_provider"]) {
    const next = overlap.indexOf(step, position + 1);
    assert.ok(next > position, `successful overlap missing/out of order: ${step}`);
    position = next;
  }
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
