import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  canonicalMutationInput,
  mutationFingerprint,
  mutationFingerprintTranscript
} from "../dist/index.js";

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/mutation-fingerprint-v1.json", import.meta.url),
  "utf8"
));

test("mutation fingerprint v1 matches the shared Rust and TypeScript fixtures", async () => {
  for (const value of fixture.cases) {
    assert.equal(canonicalMutationInput(value.input), value.canonical_input, value.name);
    assert.equal(
      Buffer.from(mutationFingerprintTranscript(value.operation, value.input)).toString("hex"),
      value.transcript_hex,
      value.name
    );
    assert.equal(await mutationFingerprint(value.operation, value.input), value.fingerprint, value.name);
  }
});

test("mutation fingerprints reject non-I-JSON and non-mutating operations", async () => {
  const invalid = [
    { value: { item: undefined }, pattern: /unsupported undefined/u },
    { value: { item: Number.NaN }, pattern: /finite/u },
    { value: { item: 1n }, pattern: /unsupported bigint/u },
    { value: { item: "\ud800" }, pattern: /lone surrogates/u },
    { value: [, "sparse"], pattern: /sparse/u }
  ];
  const cyclic = {};
  cyclic.self = cyclic;
  invalid.push({ value: cyclic, pattern: /cycles/u });

  for (const { value, pattern } of invalid) {
    assert.throws(() => mutationFingerprintTranscript("create", value), pattern);
  }
  await assert.rejects(mutationFingerprint("read", { path: "one.md" }), /not a canonical mutation/u);
  await assert.rejects(mutationFingerprint("sync", { action: "pull" }), /not a canonical mutation/u);
});
