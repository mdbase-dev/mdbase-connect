import {test} from 'node:test';
import assert from 'node:assert/strict';
import {median, result} from './results.mjs';
const at = '2026-11-16T16:30:00.000Z';
const sample = (value, revision = 'abc123') => ({revision, stages: {ttfb: value / 2, first_records: value}, heap_bytes: 1024});
test('reports per-stage medians without raw sample or heap data in ingestion', () => {
  const payload = result('editor.100.cold', [sample(100), sample(900), sample(300)], at);
  assert.equal(payload.duration_ms, 300);
  assert.deepEqual(payload.stages, [
    {name: 'ttfb', status: 'operational', duration_ms: 150},
    {name: 'first_records', status: 'operational', duration_ms: 300},
  ]);
  assert.equal(payload.status, 'operational');
  assert.equal(payload.checked_at, at);
  assert.equal(JSON.stringify(payload).includes('heap'), false);
  assert.equal(median([2, 1, 4, 3]), 3);
});
test('a failed sample cannot become an operational median', () => {
  const payload = result('writer.1k.warm', [sample(100), {revision: 'abc123', stages: {}, error: {stage: 'auth', code: 'auth_expired'}}], at);
  assert.equal(payload.status, 'failed');
  assert.deepEqual(payload.error, {stage: 'auth', code: 'auth_expired'});
  assert.equal(payload.stages.find(stage => stage.name === 'first_records').status, 'failed');
  assert.equal(payload.duration_ms, 0);
});
test('never combines different served revisions as one operational measurement', () => {
  const payload = result('tasknotes.10k.cold', [sample(10), sample(20, 'def456')], at);
  assert.equal(payload.status, 'failed');
  assert.equal(payload.revision, 'mixed');
  assert.equal(payload.error.code, 'revision_changed');
});
test('rejects tokens that could disclose identifiers or URLs', () => {
  assert.throws(() => result('https://example.invalid', [sample(10)], at), /invalid_result_token/);
  assert.throws(() => result('editor.100.cold', [sample(10, 'secret/path')], at), /invalid_result_token/);
});
test('retains page-load measurements when first records times out', () => {
  const payload = result('editor.10k.cold', [{revision: 'abc123', stages: {ttfb: 50, fcp: 200, lcp: 350}, error: {stage: 'first_records', code: 'timeout'}}], at);
  assert.equal(payload.status, 'failed');
  assert.deepEqual(payload.stages, [
    {name: 'ttfb', status: 'operational', duration_ms: 50},
    {name: 'fcp', status: 'operational', duration_ms: 200},
    {name: 'lcp', status: 'operational', duration_ms: 350},
    {name: 'first_records', status: 'failed', duration_ms: 0},
  ]);
});
test('separates consent from cold records while paint remains navigation-relative', async () => {
  const {measuredStages} = await import('./results.mjs');
  const observation = {timeOrigin: 100000, endedAt: 65000, ttfb: 70, fcp: 300, lcp: 900, firstRecords: 64000,
    opening: [{name: 'key_wait', at: 3500}, {name: 'snapshot', at: 12000}, {name: 'apply', at: 18000}, {name: null, at: 62000}],
    marks: {requested: 2000, approved: 4050, ready: 62000}, firstQuery: 62500};
  assert.deepEqual(measuredStages(observation, 104000), {
    ttfb: 70, consent: 4000, first_records: 60000, fcp: 300, lcp: 900,
    key_wait: 8000, snapshot: 6000, apply: 44000,
    open_first_records: 62000, open_approved: 2050, open_ready: 60000, render: 2000, first_query: 60500,
  });
  const warm = measuredStages({...observation, firstRecords: 2500, opening: [], marks: {}}, undefined);
  assert.equal(warm.first_records, 2500);
  assert.equal('consent' in warm, false);
});
test('opening status intervals include repeated phases without claiming a full SDK trace', async () => {
  const {measuredStages} = await import('./results.mjs');
  const stages = measuredStages({timeOrigin: 100000, endedAt: 20000, ttfb: 70, fcp: 300, lcp: 900, firstRecords: null,
    opening: [{name: 'key_wait', at: 1000}, {name: 'apply', at: 5000}, {name: 'key_wait', at: 10000}, {name: 'apply', at: 12000}], marks: {}}, 102000);
  assert.equal(stages.key_wait, 5000);
  assert.equal(stages.apply, 13000);
  assert.equal('first_records' in stages, false);
});
test('setup and skipped warm cells have distinct failures and a nonempty stage list', () => {
  for (const [stage, code] of [['setup', 'setup_required'], ['first_records', 'cold_incomplete']]) {
    const payload = result('writer.10k.warm', [{revision: 'abc123', stages: {}, error: {stage, code}}], at);
    assert.equal(payload.status, 'failed');
    assert.equal(payload.error.code, code);
    assert.equal(payload.stages.length, 1);
    assert.equal(payload.duration_ms, 0);
  }
});
