// Local-only over-the-wire tests; no Cloudflare account or remote resources.
// Build the Worker first; LOGSVC_BENCH must be a freshly built/pulled binary.
import assert from 'node:assert/strict';
import { corsCases } from './cors-cases.mjs';
import { noncePiggybackCases } from './nonce-piggyback-cases.mjs';
import { createProxyFetch } from './proxy-fetch.mjs';
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
import { accessSync, constants, mkdirSync, mkdtempSync, openSync, closeSync, writeFileSync, readFileSync, readdirSync, appendFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

if (process.env.MDBN_REQUIRE_REAL_BACKENDS === '1') {
  assert.ok(process.env.LOGSVC_BENCH, 'LOGSVC_BENCH is required');
}
if (process.env.LOGSVC_BENCH) {
  accessSync(resolve(process.env.LOGSVC_BENCH), constants.X_OK);
} else {
  console.error('LOGSVC_BENCH not set: skipping DO conformance and push checks');
}

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
  // OBJECTS keeps regionless collections; regional collections use their own.
  r2_buckets: [{ binding: 'OBJECTS', bucket_name: 'logsvc-local-test' },
    { binding: 'OBJECTS_OC', bucket_name: 'logsvc-local-test-oc' },
    { binding: 'OBJECTS_WNAM', bucket_name: 'logsvc-local-test-wnam' }],
  analytics_engine_datasets: [{ binding: 'METRICS', dataset: 'logsvc_local_test' }],
  vars: { PUBLIC_BASE: base, INSECURE_TEST_KEYS: '1', DEBUG_HOOKS: '1', TESTKIT_CP: 'conformance',
    // A retained malformed legacy value must not disable any transport path.
    LOGSVC_CORS_ORIGINS: 'ignored: not an origin list',
    // Deployed configs set a default region: every collection created here is
    // regional, so uploads, commits and reads all go through the region's bucket.
    LOGSVC_DO_LOCATION_HINT: 'oc', LOGSVC_REGION_BUCKETS: 'oc=OBJECTS_OC,wnam=OBJECTS_WNAM' },
}));
let server;
let stateDirectory = resolve(dir, 'state');
// Local owned process-group metadata only, never argv/env/token/body dumps.
// Preserve evidence of PID replacement/exit or cgroup OOM instead of declaring
// every ProxyWorker disconnect a harmless retry. Unsupported hosts are explicit.
function processEvidence(phase) {
  const observation={event:'runtime_processes',phase,available:false,processes:[],oom:null};
  try {
    for(const name of readdirSync('/proc')) {
      if(!/^[0-9]+$/.test(name))continue;
      try {
        const stat=readFileSync(`/proc/${name}/stat`,'utf8');const end=stat.lastIndexOf(')');
        const fields=stat.slice(end+2).trim().split(/\s+/);
        if(Number(fields[2])!==server?.pid)continue;
        const comm=stat.slice(stat.indexOf('(')+1,end);
        observation.processes.push({pid:Number(name),kind:comm==='workerd'?'workerd':'harness',
          state:fields[0],startTicks:fields[19],rssPages:Number(fields[21])});
      }catch{/* An exiting owned child may disappear during observation. */}
    }
    observation.available=true;
    try {observation.oom=Object.fromEntries(readFileSync('/sys/fs/cgroup/memory.events','utf8').trim().split('\n')
      .filter(line=>/^oom(?:_kill|_group_kill)? /.test(line)).map(line=>{const [k,v]=line.split(/\s+/);return[k,Number(v)];}));}catch{/* cgroup unavailable. */}
  }catch{/* Non-Linux: no process observation claim. */}
  observation.processes.sort((a,b)=>a.pid-b.pid);
  const metadata=JSON.stringify(observation);
  appendFileSync(resolve(dir,'wrangler.log'),metadata+'\n');
  console.log(metadata); // Retain sanitized successful-run evidence too.
}
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
  const exited = child.exitCode === null ? once(child, 'exit') : Promise.resolve();
  if(child.exitCode===null)process.kill(-child.pid, 'SIGTERM');
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
  try { await exited; } finally {
    clearTimeout(timer);
    // Parent exit alone is not UserWorker/ProxyWorker process-group settlement.
    // This group was created by this harness's detached spawn, never a shared PID.
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if(error.code!=='ESRCH')throw error; }
    let settled=false;
    for(let i=0;i<100;i++){
      try {process.kill(-child.pid,0);}catch(error){if(error.code==='ESRCH'){settled=true;break;}throw error;}
      await delay(50);
    }
    if(!settled)throw new Error('owned wrangler process group did not settle');
  }
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
  processEvidence('before-benchmark');
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
    const push = spawn(resolve(process.env.LOGSVC_BENCH), ['--url', base, 'push', '--origin', 'http://127.0.0.1:48218'], { stdio: 'inherit' });
    const [pushStatus] = await once(push, 'exit');
    assert.equal(pushStatus, 0, 'DO push transport and revocation');
    processEvidence('after-benchmark');
    // Benchmark WebSocket/load and HTTP CORS probes must not share a warmed
    // dev ProxyWorker/UserWorker lifetime. Preserve the SAME SQLite/R2 directory
    // and restore mode, but give CORS fresh native/proxy processes, no retries.
    await stop();
    await start();
    processEvidence('fresh-cors-runtime');
    assert.equal((await fetch(`${base}/ready`)).status,200,'post-benchmark fresh SQL/R2/metrics readiness');
  }
  const transport = key('conformance/policy');
  const issuer = key('conformance/issuer');
  const pk = createPublicKey(transport).export({ type: 'spki', format: 'der' }).subarray(-32);
  const claims = encode(map([[0, 1], [2, pk], [3, Date.now() + 900000], [4, 'mdbase-log']]));
  const token = `${claims.toString('hex')}.${sign(null, h('mdbase/v1/ls-token', claims), issuer).toString('hex')}`;
  const c = Buffer.alloc(16, 0x7e);
  const cid = '7e7e7e7e-7e7e-7e7e-7e7e-7e7e7e7e7e7e';
  await corsCases({ base, token, transport, encode, decode, map, sha, h,
    fetch: createProxyFetch({base,logPath:resolve(dir,'wrangler.log')}) });
  if (process.env.LOGSVC_CORS_ONLY !== '1') {
  await noncePiggybackCases({ base, token, transport, issuer, encode, decode, map, sha, h });
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
  }
  passed = true;
} finally {
  processEvidence(passed?'complete':'failed');
  await stop(); closeSync(log);
  if (passed) rmSync(dir, { recursive: true });
  else console.error(`Runtime diagnostics retained in ${dir}`);
}
