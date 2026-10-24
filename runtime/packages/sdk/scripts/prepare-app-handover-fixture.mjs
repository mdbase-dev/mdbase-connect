#!/usr/bin/env node
/** Carry the existing Replica test's public fixture into the native SDK smoke.
 * No CP, login, release trust or production policy authority. */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "../node_modules/esbuild/lib/main.js";
import { appPolicyPinsFixture } from "./app-policy-pins-fixture.mjs";

export function fixtureBytes(log) {
  const matches = [...log.matchAll(/^APP_HANDOVER_FIXTURE_HEX=(.*)$/gm)];
  assert.equal(matches.length, 1, "exactly one public Replica fixture required");
  assert.match(matches[0][1], /^[0-9a-f]+$/, "valid fixture hex required");
  assert.equal(matches[0][1].length % 2, 0, "whole fixture bytes required");
  return Buffer.from(matches[0][1], "hex");
}

async function main() {
  const [log, directory, extra] = process.argv.slice(2);
  assert(log && directory && !extra, "usage: prepare-app-handover-fixture.mjs test.log owned-output-directory");
  const fixture = fixtureBytes(await readFile(log, "utf8"));
  const out = resolve(directory);
  await mkdir(out, { recursive: true });
  const helpers = resolve(out, "fixture-helpers.mjs");
  await build({
    stdin: { contents: 'export { encode, decode } from "./src/cbor.ts"; export { ed25519 } from "@noble/curves/ed25519.js";', resolveDir: fileURLToPath(new URL("../", import.meta.url)) },
    bundle: true, platform: "node", format: "esm", outfile: helpers,
  });
  const { encode, decode, ed25519 } = await import(pathToFileURL(helpers).href);
  const root = decode(fixture).get(2);
  assert(root instanceof Uint8Array && root.length === 32, "public fixture root required");
  // Match testkit::SIGNED_CP_SEED (0x72). Take the ROOT from the original
  // emitted fixture rather than substituting a separately constructed witness.
  const pins = appPolicyPinsFixture(root, ed25519.getPublicKey(new Uint8Array(32).fill(0x72)), encode);
  await writeFile(resolve(out, "fixture.cbor"), fixture);
  await writeFile(resolve(out, "policy-pins.cbor"), pins);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
