#!/usr/bin/env node

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
}

const runId = option("--run-id");
const output = resolve(option("--output"));
const container = option("--container");
const prefix = `hs_${runId.replaceAll("-", "_")}`;
const cells = [
  ["records-10000", "A", "records_10000_a"],
  ["records-10000", "B-no-gin", "records_10000_b_no_gin"],
  ["records-10000", "B-gin", "records_10000_b_gin"],
  ["records-10000", "C-no-gin", "records_10000_c_no_gin"],
  ["records-10000", "C-gin", "records_10000_c_gin"],
  ["records-100000", "A", "records_100000_a"],
  ["records-100000", "B-no-gin", "records_100000_b_no_gin"],
  ["records-100000", "B-gin", "records_100000_b_gin"],
  ["records-100000", "C-no-gin", "records_100000_c_no_gin"],
  ["records-100000", "C-gin", "records_100000_c_gin"],
  ["canonical-1gib", "A", "canonical_1gib_a"],
  ["canonical-1gib", "B-no-gin", "canonical_1gib_b_no_gin"],
  ["canonical-1gib", "B-gin", "canonical_1gib_b_gin"],
  ["canonical-1gib", "C-no-gin", "canonical_1gib_c_no_gin"],
  ["canonical-1gib", "C-gin", "canonical_1gib_c_gin"],
];

function measure(database) {
  return new Promise((resolveMeasure, reject) => {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const child = spawn("docker", [
      "exec", container, "pg_dump", "-U", "postgres", "-Fc", "--compress=none", database,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0;
    let stderr = "";
    child.stdout.on("data", (chunk) => { bytes += chunk.length; });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`pg_dump ${database} exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolveMeasure({
        database,
        started_at: startedAt,
        elapsed_ms: performance.now() - started,
        bytes,
        command: ["docker", "exec", container, "pg_dump", "-U", "postgres", "-Fc", "--compress=none", database],
      });
    });
  });
}

const samples = [];
for (const [tier, variant, suffix] of cells) {
  const measurement = await measure(`${prefix}_${suffix}`);
  samples.push({ tier, variant, ...measurement });
  console.error(JSON.stringify({ tier, variant, bytes: measurement.bytes, elapsed_ms: measurement.elapsed_ms }));
}

await writeFile(output, `${JSON.stringify({
  schema_version: 1,
  run_id: runId,
  measurement: "final-state uncompressed PostgreSQL custom-format backup stream bytes",
  compression: "none",
  timing_note: "Supplemental read-only measurement after the frozen scenario completed; original raw backup samples used pg_dump custom-format default compression and remain preserved.",
  samples,
}, null, 2)}\n`);
