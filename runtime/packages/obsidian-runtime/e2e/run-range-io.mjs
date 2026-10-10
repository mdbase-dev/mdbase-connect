// Native IO/allocation probe ONLY, not attachment sync, crypto or root qualification.
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ATTACHMENT_RANGE_BYTES, BoundedRangeSource, nodeRangeBackend } from "../dist/node.js";
const here = dirname(fileURLToPath(import.meta.url));
const work = join(here, ".work/range-io");
await mkdir(work, { recursive: true });
const run = await mkdtemp(join(work, "[test]-"));
const size = 500 * 1024 * 1024;
const baseline = process.memoryUsage();
const peak = { ...baseline };
function sample() {
  const current = process.memoryUsage();
  for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], current[key]);
}
const file = await open(join(run, "fixture.bin"), "wx+");
let source;
let result;
try {
  await file.truncate(size);
  const backend = nodeRangeBackend(file);
  let maxReadRequest = 0;
  source = await BoundedRangeSource.open({ ...backend, readInto: async (offset, target) => {
    maxReadRequest = Math.max(maxReadRequest, target.length);
    sample();
    const count = await backend.readInto(offset, target);
    sample();
    return count;
  } });
  const hash = createHash("sha256");
  const zero = new Uint8Array(1024 * 1024);
  const expected = createHash("sha256");
  for (let i = 0; i < 500; i++) expected.update(zero);
  sample();
  let bytes = 0;
  for (let offset = 0; offset < size; offset += ATTACHMENT_RANGE_BYTES) {
    const lease = await source.readAt(offset, ATTACHMENT_RANGE_BYTES);
    sample();
    bytes += lease.bytes.length;
    hash.update(lease.bytes);
    lease.release();
    sample();
  }
  const digest = hash.digest("hex");
  const verified = bytes === size && digest === expected.digest("hex");
  result = { scope: "native-range-io-only", fixture: "500MiB sparse zero file", verified, bytes, sha256: digest,
    maxReadRequest, baseline, observedPeak: peak,
    note: "process peaks include runtime/GC; no JS+WASM/crypto/daemon/hosted streaming budget qualification" };
  await source.close();
} finally {
  if (source) await source.close(); else await file.close();
  await rm(join(run, "fixture.bin"), { force: true });
}
await writeFile(join(run, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ...result, evidence: join(run, "result.json") }));
if (!result?.verified) process.exitCode = 1;
