import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { buildAppTrust } from "../../runtime/packages/sdk/scripts/build-app-trust.mjs";
import { checkedSdkAsset, exactSdkVersion, requireSdkPublicationReady, sdkPackages, sdkReleaseTag, sdkTarball, sdkTarget, validateSdkPublication } from "./sdk-publication.mjs";

const root = resolve(import.meta.dirname, "../..");
const contract = JSON.parse(readFileSync(join(root, "config/release-components.json"))).sdkPublication;
const clone = () => structuredClone(contract);

test("all three environment identities and reviewed trust bytes validate", () => {
  validateSdkPublication(contract, root);
  assert.equal(sdkTarget(contract, "production").package, "@mdbase-dev/sdk");
  for (const environment of [undefined, "local", "__proto__", "latest"]) {
    assert.throws(() => sdkTarget(contract, environment));
  }
});

test("publication requires explicit qualification", () => {
  assert.throws(() => requireSdkPublicationReady({ ...contract, ready: false }), /qualify/);
  assert.throws(() => requireSdkPublicationReady({ ready: "true" }));
  requireSdkPublicationReady({ ready: true });
});

test("cross-environment packages, trust swaps and caller-supplied roots fail closed", () => {
  for (const mutate of [
    value => { value.environments.production = value.environments.staging; },
    value => { value.environments.production.package = sdkPackages.lab; },
    value => { value.environments.production.sha256 = value.environments.lab.sha256; },
    value => { value.environments.production.cpOrigin = "https://attacker.invalid"; },
    value => { value.environments.production.trustedRoots = ["00".repeat(32)]; },
    value => { value.environments.production.sourceCommit = "00".repeat(20); },
    value => { value.environments.production.bytes += 1; },
    value => { value.environments.local = value.environments.lab; },
    value => { value.productionRegistry = "https://npm.pkg.github.com/"; },
    value => { value.prerelease.assets.production = "sdk-production.tgz"; },
    value => { value.prerelease.assets.staging = "sdk-lab.tgz"; },
    value => { value.prerelease.tagPrefix = "v"; },
    value => { value.prerelease.latest = true; },
  ]) {
    const value = clone();
    mutate(value);
    assert.throws(() => validateSdkPublication(value, root));
  }
});

test("runtime bytes cannot substitute a new WASM under the committed integrity pin", () => {
  const directory = mkdtempSync(join(root, ".sdk-publication-test-"));
  try {
    const file = join(directory, "runtime.wasm");
    const bytes = Buffer.from("synthetic runtime");
    writeFileSync(file, bytes);
    const pin = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    assert.deepEqual(checkedSdkAsset(file, pin), bytes);
    writeFileSync(file, Buffer.from("synthetic runtimE"));
    assert.throws(() => checkedSdkAsset(file, pin), /SHA-256 mismatch/);
    writeFileSync(file, "short");
    assert.throws(() => checkedSdkAsset(file, pin), /byte length mismatch/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("canonical trust generator emits one fixed environment, never a runtime selector", async () => {
  const directory = mkdtempSync(join(root, ".sdk-publication-test-"));
  try {
    const pin = contract.environments.production;
    const asset = JSON.parse(readFileSync(join(root, "config/next-trust/production.json")));
    const normalized = {
      schema: "mdbn-trust/normalized/1", environment: "production",
      control_plane_origin: pin.cpOrigin, log_origin: pin.logOrigin, asset_sha256: pin.sha256,
      source: asset.source, roots: asset.roots.map(value => value.public_key), policy_pins_cbor_hex: "01",
    };
    const verifier = join(directory, "synthetic-verifier");
    writeFileSync(verifier, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(normalized))});\n`, { mode: 0o700 });
    const output = join(directory, "packaged-trust.mjs");
    buildAppTrust({ ...pin, environment: "production", asset: join(root, "config/next-trust/production.json"), verifier, output });
    const { appReleaseTrust } = await import(pathToFileURL(output));
    const release = appReleaseTrust();
    assert.equal(release.environment, "production");
    assert(Object.isFrozen(release));
    const source = readFileSync(output, "utf8");
    for (const environment of ["staging", "lab"]) {
      const other = JSON.parse(readFileSync(join(root, "config/next-trust", `${environment}.json`)));
      assert(!source.includes(other.roots[0].public_key));
      assert(!source.includes(contract.environments[environment].cpOrigin));
      assert.throws(() => buildAppTrust({ ...contract.environments[environment], environment,
        asset: "unused", verifier, output: join(directory, `${environment}.mjs`) }));
    }
    assert.deepEqual(appReleaseTrust({ environment: "lab", trustedRoots: [] }), release);
    release.trustedRoots[0].fill(0);
    assert.equal(Buffer.from(appReleaseTrust().trustedRoots[0]).toString("hex"), normalized.roots[0]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy archive publisher rejects SDKs and paths outside runtime/npm", async () => {
  const { checkLegacyArchive } = await import("../sdk-publication.mjs");
  for (const file of ["../sdk.tgz", "/sdk.tgz", "runtime/npm/../sdk.tgz"]) {
    assert.throws(() => checkLegacyArchive(file));
  }
  for (const packageName of Object.values(sdkPackages)) {
    mkdirSync(join(root, "runtime/npm"), { recursive: true });
    const directory = mkdtempSync(join(root, "runtime/npm/.sdk-publication-test-"));
    const archive = `runtime/npm/sdk-publication-test-${packageName.split("/")[1]}.tgz`;
    try {
      writeFileSync(join(directory, "package.json"), JSON.stringify({ name: packageName }));
      execFileSync("tar", ["-czf", join(root, archive), "--transform=s,^,package/,", "-C", directory, "package.json"]);
      assert.throws(() => checkLegacyArchive(archive), /SDK archives cannot use/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(join(root, archive), { force: true });
    }
  }
});

test("fixed prerelease identities keep production out of release assets", () => {
  assert.equal(sdkReleaseTag(contract, "0.0.1-next.0"), "sdk-v0.0.1-next.0");
  assert.equal(sdkTarball(contract, "production"), "sdk-production.tgz");
  assert.equal(sdkTarball(contract, "staging"), "sdk-staging.tgz");
  assert.equal(sdkTarball(contract, "lab"), "sdk-lab.tgz");
  assert.throws(() => sdkTarball(contract, "local"));
});

test("production dependency admission rejects all aliases, URLs, tarballs and mutable versions", () => {
  assert.equal(exactSdkVersion("0.0.1-next.0"), "0.0.1-next.0");
  for (const specifier of [undefined, "latest", "next", "^0.0.1", "~0.0.1", "*", "0.0.1 || 0.0.2",
    "npm:@mdbase-dev/sdk-staging@0.0.1-next.0", "npm:@mdbase-dev/sdk@0.0.1-next.0",
    "https://github.com/mdbase-dev/mdbase-connect/releases/download/sdk-v0.0.1-next.0/sdk-staging.tgz",
    "https://registry.npmjs.org/@mdbase-dev/sdk/-/sdk-0.0.1-next.0.tgz", "file:vendor/sdk.tgz", "./sdk.tgz", "workspace:*", "01.0.0", "0.0.1\n", " 0.0.1"]) {
    assert.throws(() => exactSdkVersion(specifier));
  }
});

test("workflow builds all variants once, isolates both publisher credentials and defaults to dry-run", () => {
  const workflow = readFileSync(join(root, ".github/workflows/publish-sdk-npm.yml"), "utf8");
  assert.match(workflow, /dry_run:[\s\S]*?default: true/);
  assert.match(workflow, /production_verified_commit:/);
  assert.match(workflow, /group: sdk-publication-\$\{\{ \(github.event_name == 'workflow_dispatch' && !inputs.dry_run\) && 'live' \|\| github.ref \}\}/);
  assert.match(workflow, /cancel-in-progress: \$\{\{ github.event_name != 'workflow_dispatch' \|\| inputs.dry_run \}\}/);
  for (const path of ["runtime/crates/**", "runtime/Cargo.toml", "runtime/Cargo.lock",
    "runtime/rust-toolchain.toml", "runtime/.cargo/**", "runtime/xtask/**", "runtime/tools/wasm/**"]) {
    assert(workflow.includes(`      - ${path}\n`), `source-build trigger missing ${path}`);
  }
  assert.equal(workflow.match(/startsWith\(github\.ref, 'refs\/tags\/v0\.1\.0-beta\.'\)/g).length, 3);
  assert.match(workflow, /cargo build --locked --release -p mdbn-trust/);
  assert.match(workflow, /cargo xtask wasm-app/);
  assert.match(workflow, /verify-qualified-commit/);
  assert.match(workflow, /--workflow runtime-ci.yml/);
  const [build, publishers] = workflow.split("\n  publish:\n");
  const [publish, internal] = publishers.split("\n  attest-internal:\n");
  const [attest, release] = internal.split("\n  publish-internal:\n");
  assert(!build.includes("id-token: write"));
  assert(!build.includes("contents: write"));
  assert(!workflow.includes("inputs.environment"));
  assert.equal(workflow.match(/cargo xtask wasm-app/g).length, 1);
  assert.match(build, /sdk-publication.mjs pack-all/);
  assert.match(build, /sdk-prerelease.test.mjs/);
  assert.match(publish, /!inputs.dry_run/);
  assert.match(publish, /environment: npm-sdk/);
  assert.match(publish, /sdk-publication.mjs ready/);
  assert.match(publish, /sdk-publication.mjs verify-npm/);
  assert.match(publish, /scripts\/verify-client-publication.mjs/);
  assert.match(publish, /PRODUCTION_VERIFIED_COMMIT: \$\{\{ inputs.production_verified_commit \}\}/);
  assert.match(publish, /NODE_AUTH_TOKEN: \$\{\{ secrets.NPM_SDK_BOOTSTRAP_TOKEN \}\}/);
  assert(!build.includes("NPM_SDK_BOOTSTRAP_TOKEN"));
  assert.match(publish, /npm publish "\$RUNNER_TEMP\/sdk-packages\/sdk-production.tgz"/);
  assert.match(publish, /--registry https:\/\/registry.npmjs.org\/ --tag next --provenance/);
  assert(!publish.includes("contents: write"));
  assert(!publish.includes("*.tgz"));
  assert.match(attest, /id-token: write/);
  assert.match(attest, /attestations: write/);
  assert(!attest.includes("contents: write"));
  for (const environment of ["staging", "lab"]) {
    assert.match(attest, new RegExp(`subject-path: .*sdk-${environment}\\.tgz`));
    assert(attest.includes(`sdk-${environment}.tgz.sigstore.json`));
  }
  assert.match(release, /needs: \[attest-internal, publish\]/);
  assert.match(release, /contents: write/);
  assert(!release.includes("id-token:"));
  assert(!release.includes("attestations:"));
  assert.match(release, /!inputs.dry_run/);
  assert.match(release, /node scripts\/publish-sdk-prerelease.mjs/);
  for (const job of [attest, release]) {
    assert(!job.includes("registry-url:"));
    assert(!job.includes("npm publish"));
    assert(!job.includes("NPM_TOKEN"));
    assert(!job.includes("NODE_AUTH_TOKEN"));
  }
  assert(!workflow.includes("npm.pkg.github.com"));
  assert(!workflow.includes("MDBASE_SDK_APPLICATION_INPUTS"));
});
