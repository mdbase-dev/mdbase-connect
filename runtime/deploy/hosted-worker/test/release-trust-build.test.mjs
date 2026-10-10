// BUILD wrapper/alias contract. Stub verifier tests delegation/arguments only;
// cryptographic signed-asset verification is the shared mdbn-trust crate's job.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { decode } from "../../../packages/sdk/src/cbor.ts";
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(root, "../..");
const fixture = JSON.parse(readFileSync(new URL("./fixtures/public-genesis.json", import.meta.url)));

test("fixed deploy alias refuses missing verified module; shared build is create-only and context-bound", async () => {
  // Owned repository-local temp workspace, not /tmp; no deploy/provider effects.
  const d = mkdtempSync(join(root, ".trust-build-test-"));
  try {
    const sdk = join(d, "packages/sdk/scripts"), worker = join(d, "deploy/hosted-worker");
    mkdirSync(sdk, {recursive: true}); mkdirSync(worker, {recursive: true});
    writeFileSync(join(sdk, "build-app-trust.mjs"), readFileSync(join(repo, "packages/sdk/scripts/build-app-trust.mjs")));
    const script = join(worker, "build-release-trust.mjs");
    writeFileSync(script, readFileSync(join(root, "build-release-trust.mjs")));
    const normalized = { schema: "mdbn-trust/normalized/1", environment: "lab", control_plane_origin: "https://cp.test", log_origin: "https://log.test",
      asset_sha256: "aa".repeat(32), source: { repository: "mdbase-dev/mdbase-connect", commit: "bb".repeat(20), version: "unit" },
      roots: decode(new Uint8Array(Buffer.from(fixture.pins, "base64")))[0].map(r => Buffer.from(r[1]).toString("hex")),
      policy_pins_cbor_hex: Buffer.from(fixture.pins, "base64").toString("hex") };
    const verifier = join(d, "verifier.mjs"), argsFile = join(d, "args.json");
    writeFileSync(verifier, `#!/usr/bin/env node\nimport{writeFileSync}from"node:fs";writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(process.argv.slice(2)));console.log(${JSON.stringify(JSON.stringify(normalized))});\n`);
    chmodSync(verifier, 0o700);
    const args = [script, "--verifier", verifier, "--asset", join(d, "public.asset"), "--sha256", normalized.asset_sha256, "--environment", "lab",
      "--cp-origin", "https://cp.test", "--log-origin", "https://log.test", "--source-commit", normalized.source.commit, "--source-version", "unit"];
    const output = join(worker, ".generated/release-trust.ts");
    const entry = join(d, "entry.ts"); writeFileSync(entry, 'import{appReleaseTrust}from"#hosted-release-trust";export const context=appReleaseTrust();');
    const bundle = () => build({entryPoints: [entry], bundle: true, write: false, platform: "neutral", alias: {"#hosted-release-trust": output}, logLevel: "silent"});
    await assert.rejects(bundle(), "missing artifact must not fall back to source DENY module or unsigned roots");
    const bad = [...args]; bad[bad.indexOf("--environment") + 1] = "production";
    assert.notEqual(spawnSync(process.execPath, bad, {encoding: "utf8"}).status, 0);
    assert.equal(existsSync(output), false, "wrong context produces no release");
    assert.equal(spawnSync(process.execPath, args, {encoding: "utf8"}).status, 0);
    const passed = JSON.parse(readFileSync(argsFile));
    assert.equal(passed[0], "verify"); assert.equal(passed[passed.indexOf("--environment") + 1], "lab");
    assert.equal(passed[passed.indexOf("--sha256") + 1], normalized.asset_sha256);
    const original = readFileSync(output);
    assert.notEqual(spawnSync(process.execPath, args, {encoding: "utf8"}).status, 0, "no overwrite");
    assert.deepEqual(readFileSync(output), original);
    const compiled = await bundle();
    assert.match(compiled.outputFiles[0].text, /https:\/\/cp\.test/);
    assert.match(readFileSync(join(root, "wrangler.jsonc"), "utf8"), /"#hosted-release-trust": "\.\/\.generated\/release-trust\.ts"/);
  } finally { rmSync(d, {recursive: true, force: true}); }
});
