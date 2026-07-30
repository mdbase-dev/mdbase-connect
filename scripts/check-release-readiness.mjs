#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { evaluateReleaseReadiness } from "./lib/release-readiness.mjs";

const manifestPath = new URL("../config/release-readiness.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const stable = process.argv.includes("--stable");
const result = evaluateReleaseReadiness(manifest, { stable });

for (const failure of result.failures) console.error(`- ${failure}`);
if (result.failures.length > 0) {
  process.exitCode = 1;
} else if (result.incomplete.length > 0) {
  console.log(
    `Release-readiness manifest is valid; ${result.incomplete.length} stable gate(s) ` +
    "remain intentionally open during beta."
  );
  for (const gate of result.incomplete) {
    console.log(`- ${gate.id}: ${gate.title} (${gate.owner})`);
  }
} else {
  console.log("Every release-readiness gate is complete and evidenced.");
}
