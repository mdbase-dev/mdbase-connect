import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildReleaseBundle,
  githubMatrix,
  validateReleaseBundle,
  validateReleaseComponents,
} from "./release-components.mjs";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const contract = JSON.parse(await readFile(
  path.join(root, "config/release-components.json"), "utf8"));
const commit = "a".repeat(40);
const digest = (character) => `sha256:${character.repeat(64)}`;
const records = contract.components.map((component, index) => ({
  component: component.id,
  commit,
  image: `${component.image}@${digest(String(index + 1))}`,
}));
const metadata = {
  commit,
  version: "0.1.0-beta.99",
  mdbaseRsRevision: "b".repeat(40),
  qualificationRunId: 10,
  qualificationRunAttempt: 1,
  publicationRunId: 11,
  publicationRunAttempt: 2,
};

const clone = (value) => structuredClone(value);

test("the checked-in release component contract is valid", async () => {
  assert.deepEqual(await validateReleaseComponents(contract, { root }), []);
  assert.deepEqual(githubMatrix(contract).include.map(({ component }) => component),
    ["connect", "hosted-provider", "mcp", "client"]);
});

test("contract validation rejects duplicates, unknown fields, and missing client", async () => {
  const invalid = clone(contract);
  invalid.components[0].unexpected = true;
  invalid.components[1].id = invalid.components[0].id;
  invalid.components = invalid.components.filter(({ id }) => id !== "client");
  const failures = await validateReleaseComponents(invalid, { root });
  assert(failures.some((failure) => failure.includes("unknown field unexpected")));
  assert(failures.some((failure) => failure.includes("duplicate component connect")));
  assert(failures.some((failure) => failure.includes("required component client is missing")));
});

test("bundle generation requires exactly every contract component", () => {
  assert.throws(() => buildReleaseBundle(contract, records.slice(0, -1), metadata),
    /required component record client is missing/);
  assert.throws(() => buildReleaseBundle(contract,
    [...records, { component: "unknown", commit, image: `ghcr.io/mdbase-dev/unknown@${digest("f")}` }],
    metadata), /unknown component record unknown/);
});

test("bundle generation rejects mutable, wrong-repository, and wrong-commit records", () => {
  for (const image of [
    "ghcr.io/mdbase-dev/mdbase-connect-server:latest",
    `ghcr.io/mdbase-dev/wrong@${digest("f")}`,
  ]) {
    const invalid = clone(records);
    invalid[0].image = image;
    assert.throws(() => buildReleaseBundle(contract, invalid, metadata),
      /invalid image identity/);
  }
  const invalid = clone(records);
  invalid[0].commit = "c".repeat(40);
  assert.throws(() => buildReleaseBundle(contract, invalid, metadata),
    /different source commit/);
});

test("a generated bundle validates and identity drift is rejected", () => {
  const bundle = buildReleaseBundle(contract, records, metadata);
  assert.deepEqual(validateReleaseBundle(contract, bundle), []);

  bundle.publication.workflow = "other.yml";
  bundle.components[0].platform = "linux/arm64";
  const failures = validateReleaseBundle(contract, bundle);
  assert(failures.includes("publication workflow is invalid"));
  assert(failures.some((failure) => failure.includes("metadata does not match")));
});
