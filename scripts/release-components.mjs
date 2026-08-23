#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildReleaseBundle,
  githubMatrix,
  readComponentRecords,
  validateReleaseBundle,
  validateReleaseComponents,
} from "./lib/release-components.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const contract = JSON.parse(await readFile(
  path.join(root, "config/release-components.json"), "utf8"));
const failures = await validateReleaseComponents(contract, { root });
if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
  if (["--github-matrix", "--check"].includes(arg)) args.set(arg, true);
  else args.set(arg, process.argv[++index]);
}

if (args.has("--github-matrix")) {
  process.stdout.write(`${JSON.stringify(githubMatrix(contract))}\n`);
} else if (args.has("--build-bundle")) {
  const packageManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const records = await readComponentRecords(path.resolve(args.get("--components-dir")));
  const bundle = buildReleaseBundle(contract, records, {
    commit: args.get("--commit"),
    version: packageManifest.version,
    mdbaseRsRevision: (await readFile(
      path.join(root, "deploy/docker/mdbase-rs-revision"), "utf8")).trim(),
    qualificationRunId: Number(args.get("--qualification-run-id")),
    qualificationRunAttempt: Number(args.get("--qualification-run-attempt")),
    publicationRunId: Number(args.get("--publication-run-id")),
    publicationRunAttempt: Number(args.get("--publication-run-attempt")),
  });
  const bundleFailures = validateReleaseBundle(contract, bundle);
  if (bundleFailures.length > 0) throw new Error(bundleFailures.join("\n"));
  await writeFile(path.resolve(args.get("--build-bundle")),
    `${JSON.stringify(bundle, null, 2)}\n`);
} else {
  console.log(`Release component contract is valid (${contract.components.length} components).`);
}
