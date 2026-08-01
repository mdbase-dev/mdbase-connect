import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runStressCampaign } from "./functional-stress.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = join(repoRoot, "test-fixtures/stress-regressions");
const fixtureNames = (await readdir(fixtureRoot))
  .filter((name) => name.endsWith(".json"))
  .sort();

if (fixtureNames.length === 0) {
  throw new Error("No functional stress regression fixtures were found");
}

for (const name of fixtureNames) {
  const fixture = JSON.parse(await readFile(join(fixtureRoot, name), "utf8"));
  validateFixture(fixture, name);
  process.stdout.write(`replaying stress regression ${fixture.name}\n`);
  const campaign = await runStressCampaign({
    profile: fixture.profile ?? "quick",
    seed: fixture.seed,
    seeds: 1,
    transport: fixture.transport,
    steps: fixture.steps,
    clients: fixture.clients,
    initialRecords: fixture.initialRecords,
    faultRate: fixture.faultRate,
    checkpointEvery: fixture.checkpointEvery,
    mirrorEvery: fixture.mirrorEvery
  });
  for (const result of campaign.results) {
    const expected = fixture.expected?.[result.mode];
    if (!expected) continue;
    assert.equal(result.recordDigest, expected.recordDigest, `${fixture.name} record digest changed for ${result.mode}`);
    assert.equal(result.actionDigest, expected.actionDigest, `${fixture.name} action trace changed for ${result.mode}`);
  }
}
process.stdout.write(`stress regression replay passed (${fixtureNames.length} fixture${fixtureNames.length === 1 ? "" : "s"})\n`);

function validateFixture(fixture, name) {
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) throw new Error(`${name} must contain an object`);
  for (const field of ["name", "seed", "transport"]) {
    if (typeof fixture[field] !== "string" || !fixture[field]) throw new Error(`${name} requires ${field}`);
  }
  for (const field of ["steps", "clients", "initialRecords", "checkpointEvery", "mirrorEvery"]) {
    if (!Number.isSafeInteger(fixture[field]) || fixture[field] < (field === "mirrorEvery" ? 0 : 1)) {
      throw new Error(`${name} has invalid ${field}`);
    }
  }
  if (typeof fixture.faultRate !== "number" || fixture.faultRate < 0 || fixture.faultRate > 1) {
    throw new Error(`${name} has invalid faultRate`);
  }
  if (!["memory", "http", "both"].includes(fixture.transport)) {
    throw new Error(`${name} has invalid transport`);
  }
}
