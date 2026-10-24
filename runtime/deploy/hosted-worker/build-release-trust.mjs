#!/usr/bin/env node
/** BUILD ONLY. Authenticate release context independently BEFORE this command.
 * Reuses the ONE shared mdbn-trust verifier/build consumer; no asset parser,
 * crypto verifier, network, default authority, runtime selector or overwrite.
 * Wrangler's fixed alias requires this generated module for any deploy build. */
import { buildAppTrust } from "../../packages/sdk/scripts/build-app-trust.mjs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const names = { "--verifier": "verifier", "--asset": "asset", "--sha256": "sha256", "--environment": "environment", "--cp-origin": "cpOrigin", "--log-origin": "logOrigin", "--source-commit": "sourceCommit", "--source-version": "sourceVersion", "--now-ms": "nowMs" };
try {
  const args = process.argv.slice(2), options = {};
  if (args.length % 2) throw new Error();
  for (let i = 0; i < args.length; i += 2) {
    const key = names[args[i]];
    if (!key || Object.hasOwn(options, key)) throw new Error();
    options[key] = key === "nowMs" ? Number(args[i + 1]) : args[i + 1];
  }
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), ".generated");
  mkdirSync(directory, { recursive: true });
  console.log(JSON.stringify(buildAppTrust({ ...options, output: resolve(directory, "release-trust.ts") })));
} catch {
  console.error("hosted release trust build refused");
  process.exitCode = 1;
}
