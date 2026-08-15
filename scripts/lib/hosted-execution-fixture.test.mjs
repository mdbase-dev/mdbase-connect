import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  fixtureRecord,
  generateHostedFixture,
  HOSTED_FIXTURE_TIERS
} from "./hosted-execution-fixture.mjs";

test("hosted fixture records are deterministic and cover consumer shapes", () => {
  assert.deepEqual(HOSTED_FIXTURE_TIERS, [100, 10_000, 100_000, 1_000_000]);
  assert.deepEqual(fixtureRecord(42), fixtureRecord(42));
  assert.equal(fixtureRecord(0).shape, "tasknotes");
  assert.equal(fixtureRecord(5).shape, "literature");
  assert.equal(fixtureRecord(7).shape, "editor");
  assert.equal(fixtureRecord(9).shape, "pickle");
  assert.match(fixtureRecord(7).document, /\[\[notes\/note-/);
});

test("small NDJSON fixture records its byte distribution and synthetic boundary", async () => {
  const parent = await mkdtemp(join(tmpdir(), "mdbase-hosted-fixture-test-"));
  const output = join(parent, "fixture");
  const manifest = await generateHostedFixture({ records: 100, output });
  assert.equal(manifest.records, 100);
  assert.deepEqual(manifest.shapes, {
    tasknotes: 50,
    literature: 20,
    editor: 20,
    pickle: 10
  });
  assert.equal(manifest.synthetic, true);
  assert.ok(manifest.documentBytes.p99 >= manifest.documentBytes.p50);
  const lines = (await readFile(join(output, "records.ndjson"), "utf8"))
    .trim()
    .split("\n");
  assert.equal(lines.length, 100);
  assert.equal(JSON.parse(lines[0]).record_id, fixtureRecord(0).record_id);
});
