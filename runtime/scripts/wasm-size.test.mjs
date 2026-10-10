import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, 'scripts/wasm-size.mjs');
function fixture(work) {
  const dir = mkdtempSync(join(root, '.wasm-size-test-'));
  try { work(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function report(dir, bytes, budget) {
  const wasm = join(dir, 'fixture.wasm'), config = join(dir, 'budget.json'), summary = join(dir, 'summary.md');
  writeFileSync(wasm, bytes);
  writeFileSync(config, JSON.stringify(budget));
  const result = spawnSync(process.execPath, [script, wasm, config], {
    encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return { stdout: result.stdout, summary: readFileSync(summary, 'utf8') };
}

test('raw/gzip/brotli sizes exceeding every legacy ceiling still report successfully', () => fixture(dir => {
  const bytes = Buffer.from('synthetic size-report regression; not an app build');
  const result = report(dir, bytes, { source: 'synthetic test', target: { raw: 1, gzip: 1, brotli: 1 }, ceiling: { raw: 1, gzip: 1, brotli: 1 } });
  const expected = {
    raw: bytes.length,
    gzip: gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }).length,
  };
  for (const [kind, size] of Object.entries(expected)) {
    assert.ok(size > 1);
    assert.match(result.stdout, new RegExp(`${kind}\\s+${size} B`));
    assert.ok(result.summary.includes(`| ${kind} | ${size} B |`));
  }
  assert.match(result.stdout, /report-only \(no size limit\)/);
  assert.match(result.summary, /not a CI gate/);
  assert.doesNotMatch(result.stdout + result.summary, /FAIL|over ceiling/);
}));

test('exceeding the former configured raw ceiling is not a failure', () => fixture(dir => {
  const budget = JSON.parse(readFileSync(join(root, 'tools/wasm/budget.json'), 'utf8'));
  assert.equal(budget.mode, 'report-only');
  assert.equal(budget.ceiling, undefined);
  const bytes = Buffer.alloc(budget.former_ceiling.raw + 1);
  assert.match(report(dir, bytes, budget).stdout, /raw\s+3300001 B/);
}));

test('reporting requires no target or ceiling metadata', () => fixture(dir => {
  assert.match(report(dir, Buffer.from([0, 97, 115, 109]), { source: 'measurement only' }).stdout, /report-only/);
}));

test('missing input artifacts remain IO failures, not fabricated measurements', () => fixture(dir => {
  const result = spawnSync(process.execPath, [script, join(dir, 'missing.wasm'), join(root, 'tools/wasm/budget.json')], {
    encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
}));
