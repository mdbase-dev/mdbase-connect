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
test('separates consent from cold records and measures every opening stage mark', async () => {
  const {measuredStages} = await import('./results.mjs');
  const observation = {timeOrigin: 100000, endedAt: 65000, ttfb: 70, fcp: 300, lcp: 900, firstRecords: 64000,
    opening: [
      {stage: 'joining', at: 3500}, {stage: 'opening_store', at: 5000}, {stage: 'connecting_log', at: 6000},
      {stage: 'syncing', at: 7500}, {stage: 'waiting_for_key', at: 8000}, {stage: 'loading_snapshot', at: 12000},
      {stage: 'replaying', at: 18000}, {stage: 'verifying_read', at: 60000}, {stage: 'checking_setup', at: 61000},
      {stage: 'unknown/secret', at: 61500},
    ],
    marks: {requested: 2000, approved: 4050, ready: 62000}, firstQuery: 62500};
  const cold = measuredStages(observation, 104000);
  assert.deepEqual(cold, {
    ttfb: 70, consent: 4000, first_records: 60000, fcp: 300, lcp: 900,
    joining: 1000, opening_store: 1000, connecting_log: 1500, syncing: 500,
    key_wait: 4000, snapshot: 6000, apply: 42000, verifying_read: 1000, checking_setup: 1000,
    open_first_records: 62000, open_approved: 2050, open_ready: 60000, render: 2000, first_query: 60500,
  });
  const payload = result('editor.1k.cold', [{revision: 'abc123', stages: cold}], at);
  assert.equal(payload.status, 'operational');
  assert.equal(payload.stages.length, 19);
  const warm = measuredStages({...observation, firstRecords: 2500, opening: [], marks: {}}, undefined);
  assert.equal(warm.first_records, 2500);
  assert.equal('consent' in warm, false);
});
test('opening stage marks clip to approval start and first records, and sum repeated visits', async () => {
  const {measuredStages} = await import('./results.mjs');
  const stages = measuredStages({timeOrigin: 100000, endedAt: 20000, ttfb: 70, fcp: 300, lcp: 900, firstRecords: null,
    opening: [
      {stage: 'joining', at: 500},
      {stage: 'waiting_for_key', at: 1000}, {stage: 'replaying', at: 5000},
      {stage: 'waiting_for_key', at: 10000}, {stage: 'replaying', at: 12000},
    ], marks: {}}, 102000);
  assert.equal('joining' in stages, false);
  assert.equal(stages.key_wait, 5000);
  assert.equal(stages.apply, 13000);
  assert.equal('first_records' in stages, false);
  const clipped = measuredStages({timeOrigin: 100000, endedAt: 20000, ttfb: 70, fcp: 300, lcp: 900, firstRecords: 15000,
    opening: [{stage: 'checking_setup', at: 10000}, {stage: 'syncing', at: 16000}], marks: {}}, 102000);
  assert.equal(clipped.checking_setup, 5000);
  assert.equal('syncing' in clipped, false);
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
