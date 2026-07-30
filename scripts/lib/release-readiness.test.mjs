import assert from "node:assert/strict";
import test from "node:test";
import { evaluateReleaseReadiness } from "./release-readiness.mjs";

function manifest(gates) {
  return { schemaVersion: 1, gates };
}

function gate(overrides = {}) {
  return {
    id: "independent-review",
    title: "Independent review",
    owner: "Security owner",
    status: "required",
    evidence: [],
    notes: "Review the security boundary.",
    ...overrides
  };
}

test("accepts a documented open gate for a beta release", () => {
  const result = evaluateReleaseReadiness(manifest([gate()]));

  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.incomplete.map((item) => item.id), ["independent-review"]);
});

test("blocks a stable release while any gate is open", () => {
  const result = evaluateReleaseReadiness(manifest([gate()]), { stable: true });

  assert.deepEqual(result.failures, [
    "Stable release is blocked by 1 incomplete readiness gate(s): independent-review"
  ]);
});

test("requires evidence before a gate can be complete", () => {
  const result = evaluateReleaseReadiness(
    manifest([gate({ status: "complete" })]),
    { stable: true }
  );

  assert.deepEqual(result.failures, [
    "gates[0] cannot be complete without evidence."
  ]);
});

test("accepts an evidenced stable release", () => {
  const result = evaluateReleaseReadiness(
    manifest([
      gate({
        status: "complete",
        evidence: ["docs/reviews/2026-07-30-cryptography.md"]
      })
    ]),
    { stable: true }
  );

  assert.deepEqual(result, { failures: [], incomplete: [] });
});

test("rejects duplicate, invalid, and unowned gates", () => {
  const result = evaluateReleaseReadiness(
    manifest([
      gate({ id: "Not Valid", owner: "" }),
      gate({ id: "duplicate" }),
      gate({ id: "duplicate" })
    ])
  );

  assert.deepEqual(result.failures, [
    "gates[0].id must be a lowercase kebab-case identifier.",
    "gates[0].owner is required.",
    "Release-readiness gate ID duplicate is duplicated."
  ]);
});
