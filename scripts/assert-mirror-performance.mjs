#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
// Security preflight adds bounded temporary state that the pre-transformation
// baseline did not retain: snapshot identity and document checks, complete
// durable path-alias validation, and target-indexed incremental-page checks.
const validationHeapAllowanceMiB = Object.freeze({
  // Exact-document reconciliation now retains a content-free action plan
  // alongside the validated snapshot until apply completes. This bounds the
  // plan itself without relaxing filesystem writes or checkpoints.
  read_only_initial: 75,
  // No-op reads revalidate the complete durable physical-path set so a
  // tampered checkpoint cannot reintroduce case or Unicode aliases.
  read_only_noop: 22,
  // Incremental pages preflight the complete durable path index before
  // applying their first event; projected changes remain bounded by page size.
  read_only_incremental: 50,
  read_write_initial: 60,
  read_write_noop: 28
});
// The same complete physical-path validation adds bounded CPU work while
// preserving the pre-hardening timing baseline as the comparison point.
const validationWallAllowanceMs = Object.freeze({
  // Planning sorts and fingerprints every reviewable action. Applying the
  // inspected payload reuses the same snapshot/pages, so transport and file
  // I/O ceilings remain at their pre-plan baseline.
  read_only_initial: 600,
  read_only_noop: 100,
  read_only_incremental: 140,
  read_write_initial: 480,
  read_write_noop: 80
});
// Effectful plan-only batches persist prepared intent before their first
// mutation and publish the checkpoint afterward. Receive-only initialization
// also rechecks each planned vacancy immediately before materialization.
const validationReadAllowance = Object.freeze({
  read_only_initial: 10_000,
  read_only_incremental: 200
});
const validationCheckpointAllowance = Object.freeze({
  read_only_initial: 1,
  read_only_incremental: 1
});
const baseline = JSON.parse(await readFile(
  new URL("./mirror-profile-baseline.json", import.meta.url),
  "utf8"
));
const baselineNodeMajor = baseline.runtime.node.match(/^v(\d+)\./)?.[1];
const currentNodeMajor = process.versions.node.split(".")[0];
assert(
  baselineNodeMajor === currentNodeMajor,
  `mirror baseline requires Node ${baselineNodeMajor}; running Node ${currentNodeMajor}`
);
assert(
  baseline.runtime.platform === `${process.platform}-${process.arch}`,
  `mirror baseline requires ${baseline.runtime.platform}; running ${process.platform}-${process.arch}`
);
const { records, changes, rounds, snapshot_page_size: pageSize } = baseline.parameters;
const { stdout } = await run(process.execPath, [
  "--expose-gc",
  "scripts/mirror-profile.mjs",
  "--records", String(records),
  "--changes", String(changes),
  "--rounds", String(rounds),
  "--page-size", String(pageSize),
  "--adapter", "both"
], {
  cwd: new URL("..", import.meta.url),
  maxBuffer: 16 * 1024 * 1024
});
const profile = JSON.parse(stdout);
const medians = profileMedians(profile.samples);

for (const [scenario, before] of Object.entries(baseline.medians)) {
  const current = medians[`node_${scenario}`];
  assert(current, `missing Node profile scenario ${scenario}`);
  assert(
    current.wall_ms <= before.wall_ms * 1.15
      + (validationWallAllowanceMs[scenario] ?? 0),
    `${scenario} wall time regressed: ${current.wall_ms}ms versus ${before.wall_ms}ms`
  );
  assert(
    current.peak_heap_delta_mib <= before.peak_heap_delta_mib * 1.15
      + (validationHeapAllowanceMiB[scenario] ?? 0),
    `${scenario} heap regressed: ${current.peak_heap_delta_mib}MiB versus ${before.peak_heap_delta_mib}MiB`
  );
  assert(
    current.fs_reads <= before.fs_reads + (validationReadAllowance[scenario] ?? 0),
    `${scenario} added unbounded filesystem reads`
  );
  assert(current.fs_writes <= before.fs_writes, `${scenario} added filesystem writes`);
  assert(
    current.state_writes <= before.state_writes + (validationCheckpointAllowance[scenario] ?? 0),
    `${scenario} added unbounded state checkpoints`
  );

  const portable = medians[`portable_${scenario}`];
  assert(portable, `missing portable profile scenario ${scenario}`);
  assert(
    portable.wall_ms <= current.wall_ms * 2.25,
    `${scenario} portable runtime exceeds 2.25x Node wall time`
  );
  assert(
    portable.peak_heap_delta_mib <= current.peak_heap_delta_mib * 3,
    `${scenario} portable runtime exceeds 3x Node peak heap`
  );
  assert(portable.fs_reads === current.fs_reads, `${scenario} adapter filesystem reads differ`);
  assert(portable.fs_writes === current.fs_writes, `${scenario} adapter filesystem writes differ`);
  assert(portable.state_writes === current.state_writes, `${scenario} adapter checkpoints differ`);
}

process.stdout.write(`${JSON.stringify({
  performance_ok: true,
  parameters: profile.parameters,
  validation_heap_allowance_mib: validationHeapAllowanceMiB,
  validation_wall_allowance_ms: validationWallAllowanceMs,
  validation_read_allowance: validationReadAllowance,
  validation_checkpoint_allowance: validationCheckpointAllowance,
  medians
}, null, 2)}\n`);

function profileMedians(samples) {
  const grouped = new Map();
  for (const sample of samples) {
    const group = grouped.get(sample.name) ?? [];
    group.push(sample);
    grouped.set(sample.name, group);
  }
  return Object.fromEntries([...grouped].map(([name, group]) => [
    name,
    Object.fromEntries([
      "wall_ms",
      "peak_heap_delta_mib",
      "fs_reads",
      "fs_writes",
      "state_writes"
    ].map((field) => [field, median(group.map((sample) => sample[field]))]))
  ]));
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
