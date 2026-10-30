import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildAppTrust } from "../runtime/packages/sdk/scripts/build-app-trust.mjs";
import { readPackagedSqlite } from "../runtime/packages/sdk/scripts/build-application-assets.mjs";
import { checkedSdkAsset, requireSdkPublicationReady, sdkPackages, sdkTarget, validateSdkPublication } from "./lib/sdk-publication.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdk = join(root, "runtime/packages/sdk");
const readJson = file => JSON.parse(readFileSync(file, "utf8"));
const publication = () => readJson(join(root, "config/release-components.json")).sdkPublication;

export async function verifySdkDirectory(directory, environment, sourceCommit) {
  const contract = publication();
  validateSdkPublication(contract, root);
  const pin = sdkTarget(contract, environment);
  const manifest = readJson(join(directory, "package.json"));
  assert.equal(manifest.name, pin.package);
  assert.equal(manifest.version, readJson(join(sdk, "package.json")).version);
  assert.equal(manifest.dependencies["@mdbase-dev/connect-protocol"],
    readJson(join(sdk, "package.json")).dependencies["@mdbase-dev/connect-protocol"]);
  assert(manifest.bundleDependencies.includes("@mdbase-dev/connect-protocol"));
  const provenance = readJson(join(directory, "dist/native/provenance.json"));
  assert.equal(provenance.schema, "mdbase-sdk/npm-publication/1");
  assert.equal(provenance.commit, sourceCommit);
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(provenance.environment, environment);
  assert.deepEqual(provenance.trust, pin);
  const pins = readJson(join(sdk, "src/application/asset-pins.json"));
  assert.deepEqual(provenance.runtime, pins.runtime);
  checkedSdkAsset(join(directory, "dist/native/runtime.wasm"), pins.runtime);
  checkedSdkAsset(join(directory, "dist/native/sqlite3.wasm"), pins.sqlite);
  checkedSdkAsset(join(directory, "dist/native/sqlite3.js"), pins.sqlite.initializer);
  const trustFile = join(directory, "dist/application/packaged-trust.js");
  assert.deepEqual(readFileSync(trustFile), readFileSync(join(sdk, "dist/application/packaged-trust.js")),
    "packed trust module differs from the canonical build output");
  const module = await import(pathToFileURL(trustFile));
  const release = module.appReleaseTrust();
  assert.equal(release.environment, environment);
  assert.equal(release.assetSha256, pin.sha256);
  assert.equal(release.cpOrigin, pin.cpOrigin);
  assert.equal(release.logOrigin, pin.logOrigin);
  assert.equal(release.source.commit, pin.sourceCommit);
  assert.equal(release.source.version, pin.sourceVersion);
  assert.deepEqual(module.appReleaseTrust({ trustedRoots: [], environment: "lab" }), release);
  const roots = release.trustedRoots.map(value => Buffer.from(value).toString("hex"));
  const asset = readJson(join(root, "config/next-trust", `${environment}.json`));
  assert.deepEqual(roots, asset.roots.map(value => value.public_key));
  for (const other of Object.keys(sdkPackages).filter(value => value !== environment)) {
    const otherAsset = readJson(join(root, "config/next-trust", `${other}.json`));
    assert(!otherAsset.roots.some(value => roots.includes(value.public_key)));
  }
}

async function buildSdk(environment) {
  const contract = publication();
  validateSdkPublication(contract, root);
  const pin = sdkTarget(contract, environment);
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(commit, process.env.GITHUB_SHA, "SDK build must identify the checked-out workflow commit");
  const manifest = readJson(join(sdk, "package.json"));
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.notEqual(manifest.version, "0.0.0", "assign a new immutable SDK version before cutting a release");
  const pins = readJson(join(sdk, "src/application/asset-pins.json"));
  const runtime = checkedSdkAsset(join(root, "runtime/target/wasm/app-runtime.wasm"), pins.runtime);
  const sqlite = readPackagedSqlite();
  const dist = join(sdk, "dist");
  rmSync(dist, { recursive: true, force: true });
  execFileSync("npm", ["exec", "--", "tsc", "-p", "tsconfig.build.json"], { cwd: sdk, stdio: "inherit" });
  const generated = join(dist, "application/packaged-trust.mjs");
  buildAppTrust({ ...pin, environment,
    asset: join(root, "config/next-trust", `${environment}.json`),
    verifier: join(root, "runtime/target/release/mdbn-trust"), output: generated });
  renameSync(generated, join(dist, "application/packaged-trust.js"));
  mkdirSync(join(dist, "native"), { recursive: true });
  writeFileSync(join(dist, "native/runtime.wasm"), runtime);
  writeFileSync(join(dist, "native/sqlite3.wasm"), sqlite.wasm);
  writeFileSync(join(dist, "native/sqlite3.js"), sqlite.initializer);
  writeFileSync(join(dist, "native/provenance.json"), JSON.stringify({
    schema: "mdbase-sdk/npm-publication/1", commit, environment, trust: pin, runtime: pins.runtime,
  }, null, 2) + "\n");
  manifest.name = pin.package;
  writeFileSync(join(sdk, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  execFileSync("npm", ["run", "build:browser"], { cwd: sdk, stdio: "inherit" });
  await verifySdkDirectory(sdk, environment, commit);
}

export function checkLegacyArchive(archive) {
  assert.match(archive, /^runtime\/npm\/[A-Za-z0-9._-]+\.tgz$/);
  const manifest = JSON.parse(execFileSync("tar", ["-xOf", join(root, archive), "package/package.json"], { encoding: "utf8" }));
  assert(["@mdbase-dev/obsidian-runtime", "mdbase"].includes(manifest.name),
    "SDK archives cannot use the legacy archive publisher; use publish-sdk-npm.yml");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, environment, directory, commit] = process.argv.slice(2);
  if (command === "check") validateSdkPublication(publication(), root);
  else if (command === "ready") requireSdkPublicationReady(publication());
  else if (command === "build") await buildSdk(environment);
  else if (command === "verify") await verifySdkDirectory(resolve(directory), environment, commit);
  else if (command === "legacy-archive") checkLegacyArchive(environment);
  else throw new Error("Expected check, ready, build, verify or legacy-archive");
}
