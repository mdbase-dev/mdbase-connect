import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { buildAppTrust } from "../../runtime/packages/sdk/scripts/build-app-trust.mjs";
import { checkedSdkAsset, requireSdkPublicationReady, sdkPackages, sdkTarget, validateSdkPublication } from "./sdk-publication.mjs";

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

test("publication remains explicitly blocked pending the separate port", () => {
  assert.throws(() => requireSdkPublicationReady(contract), /port the outstanding/);
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

test("workflow builds only main source, isolates credentials and defaults to dry-run", () => {
  const workflow = readFileSync(join(root, ".github/workflows/publish-sdk-npm.yml"), "utf8");
  assert.match(workflow, /dry_run:[\s\S]*?default: true/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /cargo build --locked --release -p mdbn-trust/);
  assert.match(workflow, /cargo xtask wasm-app/);
  assert.match(workflow, /verify-qualified-commit/);
  assert.match(workflow, /--workflow runtime-ci.yml/);
  const [build, publish] = workflow.split("\n  publish:\n");
  assert(!build.includes("id-token: write"));
  assert.match(publish, /!inputs.dry_run/);
  assert.match(publish, /environment: npm-sdk/);
  assert.match(publish, /sdk-publication.mjs ready/);
  assert.match(publish, /--ignore-scripts --access public --tag next --provenance/);
  assert(!workflow.includes("MDBASE_SDK_APPLICATION_INPUTS"));
});
