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

test("previous-release fixture and its qualification tests trigger normal signed publication", async () => {
  const workflow = await readFile(resolve(repoRoot, ".github/workflows/publish-images.yml"), "utf8");
  const changeDetector = workflow.match(/if git diff --quiet "\$parent" "\$SOURCE_COMMIT" -- \\\n([\s\S]*?)\n          then/)?.[1];
  assert.ok(changeDetector, "normal main publication must inspect changed inputs");
  for (const path of [
    ".github/previous-release.env",
    "scripts/lib/upgrade-release-identity.test.mjs",
    "scripts/lib/upgrade-test-contract.test.mjs"
  ]) {
    assert.ok(changeDetector.split(/\\\n/).some(line => line.trim().replace(/ \\$/, "") === path),
      `${path} must trigger signed image/bundle publication`);
  }
  assert.match(workflow, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(workflow, /git rev-list -n 1 "\$RELEASE_TAG"/,
    "manual dispatch must retain its exact annotated-tag gate");
});

test("upgrade pins an exact versioned published fixture", async () => {
  const fixture = await readFile(
    resolve(repoRoot, ".github/previous-release.env"),
    "utf8"
  );
  assert.equal(fixture, `# Versioned published upgrade fixture; not the mutable newest-release pointer.
# Advance deliberately during release preparation; publication alone cannot invalidate CI.
MDBASE_CONNECT_PREVIOUS_RELEASE=v0.1.0-beta.108
MDBASE_CONNECT_PREVIOUS_RELEASE_COMMIT=2203976764fcd60511965e96fd397b19dd5ad3ef
MDBASE_CONNECT_PREVIOUS_SERVER_IMAGE=ghcr.io/mdbase-dev/mdbase-connect-server@sha256:b904ec55491b62d196eb64bdd693b792df56142b57b3ca135c81b23b47de7a2c
MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE=ghcr.io/mdbase-dev/mdbase-connect-hosted-provider@sha256:468cee0d411e0732cb23560f8567e99162c757bbea1dfef9a19fcc775c58e4b1
`);
});

test("both upgrade programs execute release and pulled-image verification", async () => {
  const helpers = await readFile(resolve(repoRoot, "test/upgrade/lib.sh"), "utf8");
  assert.match(helpers, /upgrade_verify_previous_release\(\)/);
  assert.match(helpers, /api\.github\.com\/repos\/mdbase-dev\/mdbase-connect\/releases\/tags\/\$release/);
  assert.doesNotMatch(helpers, /releases\?per_page|unique newest/);
  assert.match(helpers, /git -C "\$repo_root" ls-remote --exit-code --tags origin/);
  assert.match(helpers, /"refs\/tags\/\$release\^\{\}"/);
  assert.match(helpers, /upgrade_verify_previous_image\(\)/);
  assert.match(helpers, /docker image inspect "\$image"/);
  assert.match(helpers, /org\.opencontainers\.image\.source/);
  assert.match(helpers, /org\.opencontainers\.image\.revision/);

  const server = await readFile(resolve(repoRoot, "test/upgrade/server-from-previous"), "utf8");
  const serverRelease = server.indexOf('upgrade_verify_previous_release "$repo_root"');
  const serverPull = server.indexOf('docker pull "$MDBASE_CONNECT_PREVIOUS_SERVER_IMAGE"');
  const serverImage = server.indexOf('upgrade_verify_previous_image "$MDBASE_CONNECT_PREVIOUS_SERVER_IMAGE"');
  assert.ok(serverRelease >= 0 && serverRelease < serverImage, "server must verify the release before use");
  assert.ok(serverPull >= 0 && serverImage > serverPull, "server must inspect the image after pulling it");

  const provider = await readFile(resolve(repoRoot, "test/upgrade/provider-from-previous"), "utf8");
  const fixture = await readFile(resolve(repoRoot, "test/upgrade/provider-current.sh"), "utf8");
  const providerRelease = provider.indexOf('upgrade_verify_previous_release "$repo_root"');
  assert.ok(providerRelease >= 0 && providerRelease < provider.indexOf("\ncurrent_provider_run\n"),
    "provider must verify the release before starting its fixture");
  const cachedImage = fixture.indexOf('docker image inspect "$MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE"');
  const providerImage = fixture.indexOf('upgrade_verify_previous_image "$MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE"');
  assert.ok(cachedImage >= 0 && cachedImage < providerImage, "provider must verify its cached immutable image");
  const previous = provider.match(/^start_previous_provider\(\) \{\n([\s\S]*?)^\}/m)?.[1];
  assert.match(previous, /"\$MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE"/);
  assert.doesNotMatch(previous, /CANDIDATE_IMAGE|--entrypoint|--volume/);
  assert.doesNotMatch(provider + fixture, /^\s*MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE=/m);
});

test("upgrade shell programs are syntactically valid", async () => {
  for (const script of [
    "test/upgrade/lib.sh",
    "test/upgrade/server-from-previous",
    "test/upgrade/provider-from-previous",
    "test/upgrade/provider-current.sh"
  ]) {
    await execute("bash", ["-n", resolve(repoRoot, script)]);
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
