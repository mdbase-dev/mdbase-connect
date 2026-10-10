// Local-only over-the-wire tests; no Cloudflare account or remote resources.
// Build the Worker first; LOGSVC_BENCH must be a freshly built/pulled binary.
import assert from 'node:assert/strict';
import { ingressCases } from './ingress-cases.mjs';
import { sec061Cases } from './sec061-cases.mjs';
import { directGetCases } from './direct-get-cases.mjs';
import { backupCases } from './backup-cases.mjs';
import { restoreAuxCases } from './restore-aux-cases.mjs';
import { registryBackupCases } from './registry-backup-cases.mjs';
import { deletionRegistryCases } from './deletion-registry-cases.mjs';
import { collectionDeletionCases } from './collection-deletion-cases.mjs';
import { destinationDenialCases } from './destination-denial-cases.mjs';
import { destinationAuxDenialCases } from './destination-aux-denial-cases.mjs';
import { collectionClosingCases } from './collection-closing-cases.mjs';
import WebSocket from 'ws';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, openSync, closeSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const port = Number(process.env.LOGSVC_TEST_PORT ?? 18787);
const inspector = Number(process.env.LOGSVC_TEST_INSPECTOR_PORT ?? 19229);
const base = `http://127.0.0.1:${port}`;
const sha = (b) => createHash('sha256').update(b).digest();
const h = (tag, b) => sha(Buffer.concat([Buffer.from([tag.length]), Buffer.from(tag), b]));
const key = (label) => createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), sha(Buffer.from(label))]),
  type: 'pkcs8', format: 'der',
});

// The small canonical CBOR subset needed for these independent auth probes.
function prefix(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n <= 255) return Buffer.from([(major << 5) | 24, n]);
  if (n <= 65535) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  if (n <= 0xffffffff) { const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b; }
  const b = Buffer.alloc(9); b[0] = (major << 5) | 27; b.writeBigUInt64BE(BigInt(n), 1); return b;
}
function encode(v) {
  if (v === null) return Buffer.from([0xf6]);
  if (typeof v === 'bigint') {
    assert.ok(v >= 0n && v <= (1n << 64n) - 1n);
    if (v <= BigInt(Number.MAX_SAFE_INTEGER)) return prefix(0, Number(v));
    const b = Buffer.alloc(9); b[0] = 27; b.writeBigUInt64BE(v, 1); return b;
  }
  if (typeof v === 'boolean') return Buffer.from([v ? 0xf5 : 0xf4]);
  if (typeof v === 'number') return prefix(0, v);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([prefix(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([prefix(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([prefix(4, v.length), ...v.map(encode)]);
  if (v instanceof Map) return Buffer.concat([prefix(5, v.size), ...[...v].flatMap(([k, x]) => [encode(k), encode(x)])]);
  throw new Error('unsupported test CBOR');
}
function decode(bytes) {
  let i = 0;
  function value() {
    const tag = bytes[i++]; const major = tag >> 5; const a = tag & 31;
    let n = a;
    if (a === 24) n = bytes[i++];
    else if (a === 25) { n = bytes.readUInt16BE(i); i += 2; }
    else if (a === 26) { n = bytes.readUInt32BE(i); i += 4; }
    else if (a === 27) {
      const wide = bytes.readBigUInt64BE(i); i += 8;
      if (major === 0 && wide > BigInt(Number.MAX_SAFE_INTEGER)) return wide;
      assert.ok(wide <= BigInt(Number.MAX_SAFE_INTEGER), 'bounded length/non-u64 response');
      n = Number(wide);
    }
    else assert.ok(a < 24, 'no indefinite CBOR');
    if (major === 0) return n;
    if (major === 1) return -1 - n;
    if (major === 2 || major === 3) { const b = bytes.subarray(i, i += n); return major === 2 ? b : b.toString(); }
    if (major === 4) return Array.from({ length: n }, value);
    if (major === 5) { const m = new Map(); for (let j = 0; j < n; j++) m.set(value(), value()); return m; }
    if (major === 7 && a === 20) return false;
    if (major === 7 && a === 21) return true;
    if (major === 7 && a === 22) return null;
    throw new Error(`unsupported response CBOR ${tag}`);
  }
  const v = value(); assert.equal(i, bytes.length); return v;
}
const map = (entries) => new Map(entries);
mkdirSync('.wrangler', { recursive: true });
const dir = mkdtempSync(resolve('.wrangler/runtime-test-'));
const log = openSync(resolve(dir, 'wrangler.log'), 'a');
const config = resolve(dir, 'wrangler.json');
// Separate config without a custom build: compilation has already run remotely.
writeFileSync(config, JSON.stringify({
  name: 'mdbase-next-logsvc-local-test',
  main: resolve('tests/ingress-worker.mjs'),
  compatibility_date: '2026-10-04',
  durable_objects: { bindings: [{ name: 'LOG', class_name: 'LogCollection' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['LogCollection'] }],
  r2_buckets: [{ binding: 'OBJECTS', bucket_name: 'logsvc-local-test' }],
  analytics_engine_datasets: [{ binding: 'METRICS', dataset: 'logsvc_local_test' }],
  vars: { PUBLIC_BASE: base, INSECURE_TEST_KEYS: '1', DEBUG_HOOKS: '1', TESTKIT_CP: 'conformance' },
}));
let server;
let stateDirectory = resolve(dir, 'state');
async function start() {
  server = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev',
    '--config', config, '--local', '--ip', '127.0.0.1', '--port', String(port),
    '--inspector-port', String(inspector), '--persist-to', stateDirectory,
    '--show-interactive-dev-session=false'], {
    detached: true, stdio: ['ignore', log, log], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  for (let i = 0; i < 150; i++) {
    assert.equal(server.exitCode, null, `wrangler exited; see ${dir}/wrangler.log`);
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await delay(100);
  }
  throw new Error(`wrangler readiness timeout; see ${dir}/wrangler.log`);
}
async function stop() {
  if (!server) return;
  const child = server; server = undefined;
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  process.kill(-child.pid, 'SIGTERM');
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
  try { await exited; } finally { clearTimeout(timer); }
}
async function rpc(headers, body) {
  const response = await fetch(`${base}/v1/rpc`, { method: 'POST', headers, body });
  assert.equal(response.status, 200);
  return decode(Buffer.from(await response.arrayBuffer())).get(3);
}
let passed = false;
try {
  await start();
  assert.equal((await fetch(`${base}/ready`)).status, 200, 'SQL/R2/metrics readiness');
  if (process.env.LOGSVC_BENCH) {
    const bench = spawn(resolve(process.env.LOGSVC_BENCH), ['--url', base, 'conformance', '--hooks'], { stdio: 'inherit' });
    const [status] = await once(bench, 'exit');
    assert.equal(status, 0, 'DO conformance');
    const text = readFileSync(resolve(dir, 'wrangler.log'), 'utf8');
    const repairs = text.split('\n').filter((line) => line.includes('"event":"service_lost_tail"'));
    assert.ok(repairs.length > 0, 'repair signal is logged');
    for (const line of repairs) {
      assert.ok(!line.includes('"collection"') && !line.includes('"uploader"'), 'no IDs in repair logs');
    }
    assert.ok(!text.includes('logsvc_metrics_write_failed'), 'local Analytics Engine writes succeed');
    console.log('PASS: repair log privacy and Analytics Engine binding');
  }
  const transport = key('conformance/policy');
  const issuer = key('conformance/issuer');
  const pk = createPublicKey(transport).export({ type: 'spki', format: 'der' }).subarray(-32);
  const claims = encode(map([[0, 1], [2, pk], [3, Date.now() + 900000], [4, 'mdbase-log']]));
  const token = `${claims.toString('hex')}.${sign(null, h('mdbase/v1/ls-token', claims), issuer).toString('hex')}`;
  const c = Buffer.alloc(16, 0x7e);
  const cid = '7e7e7e7e-7e7e-7e7e-7e7e-7e7e7e7e7e7e';
  await collectionDeletionCases({ base, token, transport, encode, decode, map, sha, h,
    restart: async () => { await stop(); await start(); } });
  await destinationDenialCases({ base, token, transport, encode, decode, map, sha, h,
    restart: async () => { await stop(); await start(); } });
  await collectionClosingCases({ base, token, transport, encode, decode, map, sha, h,
    restart: async () => { await stop(); await start(); } });
  await ingressCases({base,token,transport,c,cid,encode,map,sha,h});
  await backupCases({ base, token, transport, encode, decode, map, sha, h,
    restart: async () => { await stop(); await start(); },
    onArchive: async (archive, appendRecovered) => {
      const sourceState = stateDirectory;
      let targetNumber = 0;
      try {
        const recovery = { base, token, transport, encode, decode, map, sha, h, archive, appendRecovered,
          restart: async () => { await stop(); await start(); },
          freshTarget: async () => { await stop(); stateDirectory = resolve(dir,`empty-recovery-target-${targetNumber++}`); await start(); } };
        await restoreAuxCases(recovery);
        await destinationAuxDenialCases(recovery);
      } finally { await stop(); stateDirectory = sourceState; await start(); }
    } });
  await registryBackupCases({ base, token, transport, encode, decode, map, sha, h,
    restart: async () => { await stop(); await start(); } });
  // Registry enumeration fixtures start in a separate local namespace: earlier
  // conformance/deletion cases legitimately left permanent floors in the source.
  // Preserve that namespace intact; never erase its independent denial authority.
  const registrySourceState = stateDirectory;
  try {
    await stop(); stateDirectory = resolve(dir, 'independent-registry-fixture'); await start();
    await deletionRegistryCases({ base, token, transport, encode, decode, map, sha, h,
      restart: async () => { await stop(); await start(); } });
  } finally { await stop(); stateDirectory = registrySourceState; await start(); }
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/v1/ws?c=${cid}`);
  const upgraded = once(socket, 'upgrade');
  await once(socket, 'open');
  const [upgrade] = await upgraded;
  const wsNonce = Buffer.from(upgrade.headers['x-mdbase-nonce'], 'hex');
  let nextId = 1;
  async function wsCall(method, params) {
    const id = nextId++;
    const response = once(socket, 'message');
    socket.send(encode(map([[0, 0], [1, id], [2, method], [3, params]])));
    const [bytes] = await response;
    const frame = decode(Buffer.from(bytes));
    assert.equal(frame.get(1), id);
    return frame;
  }
  try {
    const hello = await wsCall('hello', map([[0, [1, 0]], [1, token], [3,
      sign(null, h('mdbase/v1/ls-hello', Buffer.concat([wsNonce, Buffer.from(token)])), transport)]]));
    assert.ok(hello.has(2), 'control-plane hello');
    const wrongActor = await wsCall('head', map([[0, Buffer.alloc(16, 0x7f)]]));
    assert.equal(wrongActor.get(3).get(0), 'forbidden');
    assert.equal(wrongActor.get(3).get(1), 'actor_collection', 'no cross-actor requests before genesis');
    const rightActor = await wsCall('head', map([[0, c]]));
    assert.equal(rightActor.get(3).get(0), 'not_found');
  } finally {
    socket.terminate();
  }
  console.log('PASS: WebSocket collection routing before genesis');
  const body = encode(map([[0, 0], [1, 1], [2, 'head'], [3, map([[0, c]])]]));
  const nonce = Buffer.from(await (await fetch(`${base}/v1/nonce`)).text(), 'hex');
  assert.equal(nonce.length, 32);
  const digest = h('mdbase/v1/ls-http', Buffer.concat([
    Buffer.from('head\0/v1/rpc\0'), c, sha(Buffer.from(token)), sha(body), nonce,
  ]));
  const headers = { authorization: `Bearer ${token}`, 'x-mdbase-nonce': nonce.toString('hex'),
    'x-mdbase-sig': sign(null, digest, transport).toString('hex') };
  // Invalid possession must not poison a valid nonce.
  const invalid = await rpc({ ...headers, 'x-mdbase-sig': '00'.repeat(64) }, body);
  assert.equal(invalid.get(1), 'possession');
  const first = await rpc(headers, body);
  assert.equal(first.get(0), 'not_found', 'authenticated request consumes nonce even on service error');
  const replay = await rpc(headers, body);
  assert.equal(replay.get(1), 'replay');
  await stop();
  await start();
  assert.equal((await fetch(`${base}/ready`)).status, 200, 'readiness after restart');
  // Restart is deliberately within the nonce lifetime. Same persisted SQLite.
  assert.ok(Date.now() - Number(nonce.readBigUInt64BE(0)) < 60000);
  const restarted = await rpc(headers, body);
  assert.equal(restarted.get(0), 'unauthenticated');
  assert.equal(restarted.get(1), 'replay', 'used nonce survives actor/runtime restart');
  console.log('PASS: HTTPS possession, single use, and replay rejection after restart');
  await sec061Cases({base,token,transport,sha,h});
  await directGetCases({base,encode,map,sha});
  passed = true;
} finally {
  await stop(); closeSync(log);
  if (passed) rmSync(dir, { recursive: true });
  else console.error(`Runtime diagnostics retained in ${dir}`);
}
