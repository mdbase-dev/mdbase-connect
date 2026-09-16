#!/usr/bin/env node
// Synthetic materialization microbenchmark: no real files or user collections.
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { MirrorMaterializer } from '../packages/sync/dist/mirror-materializer.js';
const digest = value => createHash('sha256').update(value).digest('hex');
for (const mode of ['read_only', 'read_write']) {
  for (const identical of [true, false]) {
    const state = { protocol_version: 1, replica_id: 'fixture', scope_epoch: 1, cursor: 0, records: {} };
    const files = new Map();
    const records = Array.from({length: 1000}, (_, i) => ({record_id: `record-${i}`, path: `${i}.md`, revision: 'next', frontmatter: {}, body: '', types: [], document: 'x'.repeat(4096)}));
    for (const record of records) {
      const prior = identical ? record.document : 'previous';
      files.set(record.path, prior);
      state.records[record.record_id] = {path: record.path, revision: 'prior', hash: digest(prior)};
    }
    let reads = 0, writes = 0, hashes = 0;
    const fs = {
      async read(path) { reads++; return files.get(path) ?? null; },
      async write(path, value) { writes++; files.set(path, value); },
    };
    const materializer = new MirrorMaterializer(fs, {digest(value) { hashes++; return digest(value); }}, mode);
    const started = performance.now();
    for (const record of records) await materializer.put(state, record, { inspectionPreflighted: true });
    const elapsed_ms = performance.now() - started;
    for (const record of records) {
      assert.equal(files.get(record.path), record.document);
      assert.equal(state.records[record.record_id].revision, 'next');
    }
    console.log('FILE_IO_BENCH ' + JSON.stringify({name:'markdown_materialization',parameters:{mode, identical, records:records.length}, elapsed_ms, work:{reads,writes,hashes}}));
  }
}
