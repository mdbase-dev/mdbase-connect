import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const manifestPath = path.join(repositoryRoot, "config/security-audit-package.json");
const requiredBoundaryIds = [
  "application-authorization",
  "first-contact-sas",
  "relay-encryption",
  "local-policy",
  "control-plane-policy",
  "hosted-encryption",
  "managed-key-wrapping",
  "release-integrity"
];
const requiredLimitationIds = [
  "independent-audit-pending",
  "endpoint-compromise",
  "control-plane-metadata",
  "standard-hosted-provider-trust",
  "human-sas-comparison",
  "no-key-transparency",
  "render-static-aws-credentials",
  "single-relay-broker",
  "complete-recovery-drill-pending",
  "platform-signing-pending",
  "single-operator-recovery"
];

async function manifest() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

function referencedPaths(value) {
  return value.trustBoundaries.flatMap((boundary) => [
    ...boundary.sources,
    ...boundary.tests,
    ...boundary.fixtures
  ]);
}

test("labels the package as internal preparation, not an independent audit", async () => {
  const value = await manifest();

  assert.equal(value.schemaVersion, 1);
  assert.equal(value.status, "internal-preparation");
  assert.equal(value.independentReview, false);
  assert.match(value.scope.excluded.join(" "), /independent security assessment/i);
});

test("covers every required trust boundary exactly once", async () => {
  const value = await manifest();
  const actual = value.trustBoundaries.map((boundary) => boundary.id);

  assert.equal(new Set(actual).size, actual.length);
  assert.deepEqual([...actual].sort(), [...requiredBoundaryIds].sort());
  for (const boundary of value.trustBoundaries) {
    assert.ok(boundary.authority.length >= 40, `${boundary.id} needs an authority statement`);
    assert.ok(boundary.sources.length > 0, `${boundary.id} needs source references`);
    assert.ok(boundary.tests.length > 0, `${boundary.id} needs test references`);
  }
});

test("keeps every repository reference relative, contained, and present", async () => {
  const value = await manifest();

  for (const relative of referencedPaths(value)) {
    assert.equal(path.isAbsolute(relative), false, `${relative} must be relative`);
    assert.equal(relative.split(/[\\/]/u).includes(".."), false, `${relative} must be contained`);
    const resolved = path.resolve(repositoryRoot, relative);
    assert.equal(
      resolved.startsWith(`${repositoryRoot}${path.sep}`),
      true,
      `${relative} must resolve inside the repository`
    );
    assert.equal((await stat(resolved)).isFile(), true, `${relative} must be a file`);
  }
});

test("records the known limitations required for accurate security claims", async () => {
  const value = await manifest();
  const actual = value.knownLimitations.map((limitation) => limitation.id);

  assert.equal(new Set(actual).size, actual.length);
  for (const required of requiredLimitationIds) {
    assert.ok(actual.includes(required), `missing limitation ${required}`);
  }
  assert.ok(value.reproduction.includes("cargo test --workspace"));
  assert.ok(value.reproduction.includes("pnpm e2e:relay"));
  assert.ok(value.reproduction.includes("pnpm e2e:provider"));
});

test("contains references and descriptions, never credential-shaped values", async () => {
  const source = await readFile(manifestPath, "utf8");

  assert.doesNotMatch(source, /AKIA[0-9A-Z]{16}/u);
  assert.doesNotMatch(source, /-----BEGIN (?:EC |RSA |OPENSSH )?PRIVATE KEY-----/u);
  assert.doesNotMatch(source, /\b(?:access|secret)[_-]?key\s*[=:]\s*["'][^"']+/iu);
});
