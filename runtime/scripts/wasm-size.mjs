// Reports runtime/app WASM sizes (raw / gzip -9 / brotli q11).
// Standalone app size is informational, never a CI size gate.
// Usage: node scripts/wasm-size.mjs <runtime.wasm> <budget.json>
import { appendFileSync, readFileSync } from 'node:fs';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const [wasmPath, budgetPath] = process.argv.slice(2);
const bytes = readFileSync(wasmPath);
const budget = JSON.parse(readFileSync(budgetPath, 'utf8'));
const sizes = {
  raw: bytes.length,
  gzip: gzipSync(bytes, { level: 9 }).length,
  brotli: brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  }).length,
};
const rows = [];
for (const k of ['raw', 'gzip', 'brotli']) {
  rows.push(`| ${k} | ${sizes[k]} B |`);
  console.log(`${k.padEnd(6)} ${String(sizes[k]).padStart(9)} B  report-only (no size limit)`);
}
const md = [
  '## WASM size report (after wasm-opt -Oz)',
  '',
  '| | size |',
  '|---|---:|',
  ...rows,
  '',
  'Report-only: standalone app bundle/WASM size is not a CI gate.',
  `Measurement context: ${budget.source}`,
  '',
].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
