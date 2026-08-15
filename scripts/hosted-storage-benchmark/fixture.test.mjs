import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { fixtureRecord, fixtureResources, generateBenchmarkFixture } from "./fixture.mjs";

test("fixture mix, documents, and semantic seeds are deterministic", () => {
  assert.deepEqual(fixtureRecord(42), fixtureRecord(42));
  assert.equal(fixtureRecord(0).shape, "tasknotes-task");
  assert.equal(fixtureRecord(35).shape, "reader-source");
  assert.equal(fixtureRecord(50).shape, "reader-annotation");
  assert.equal(fixtureRecord(60).shape, "editor-note");
  assert.equal(fixtureRecord(70).shape, "pickle-request");
  assert.equal(fixtureRecord(80).shape, "pickle-response");
  assert.match(fixtureRecord(9973).body, /selective-body-needle/);
  assert.equal(fixtureRecord(35).projection.persisted_frontmatter.id, "src_0000000");
  assert.equal(fixtureRecord(35).projection.persisted_frontmatter.kind, "article");
  assert.equal(fixtureRecord(50).projection.persisted_frontmatter.source, "[[src_0000008]]");
  assert.equal(fixtureRecord(50).projection.persisted_frontmatter.annotation_type, "highlight");
  assert.equal(fixtureRecord(183).projection.persisted_frontmatter.type, "pickle_response_ack");
  assert.equal(fixtureRecord(183).projection.persisted_frontmatter.request,
    `[[${fixtureRecord(179).path.replace(/\.md$/, "")}]]`);
  const readerType = fixtureResources(1).find(({ path }) => path === "_types/reader-source.md");
  assert.match(readerType.document, /fields_present/);
  assert.match(readerType.document, /"kind"/);
});

test("generator freezes exact selectivity and result digests", async () => {
  const output = join(await mkdtemp(join(tmpdir(), "hosted-storage-fixture-")), "fixture");
  const manifest = await generateBenchmarkFixture({
    output,
    records: 100,
    workloadContractPath: resolve(
      import.meta.dirname,
      "../../docs/benchmarks/hosted-storage-model/workload-contract.json"
    ),
    fixtureContractPath: resolve(
      import.meta.dirname,
      "../../docs/benchmarks/hosted-storage-model/fixture-contract.json"
    )
  });
  assert.equal(manifest.records, 100);
  assert.equal(Object.values(manifest.shapes).reduce((sum, value) => sum + value, 0), 100);
  assert.equal(manifest.synthetic, true);
  assert.ok(manifest.projectionEnvelopeBytes.maximum <= 262_144);
  assert.equal(manifest.resources.rebuildCatalogRevision.startsWith("sha256:"), true);
  const expected = JSON.parse(await readFile(join(output, "expected-results.json"), "utf8"));
  assert.equal(expected.schemaVersion, 2);
  assert.equal(expected.workloads["sdk.cancel_broad_body_scan"].canonicalOutcome, "success");
  assert.ok(expected.workloads["sdk.cancel_broad_body_scan"].acceptableRunOutcomes.includes("cancelled"));
  assert.match(expected.workloads["editor.metadata_index"].orderedRecordIdsDigest, /^sha256:/);
  assert.equal(expected.workloads["pickle.pending_inbox"].providerScans.length, 2);
  assert.equal(expected.workloads["reader.body_search_common"].providerScans[0].rows, 20);
});
