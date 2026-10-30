#!/usr/bin/env node
/** Measurement-only actual PUBLIC SDK Blob READ composition. No seeded stores,
 * replay engine, invented Op14, AttachmentV1 relabel, sign-in or provider claim.
 * Parent supplies a fresh production runtime; this script does NOT build it.
 * Bundles current SDK source in memory for Chromium, using existing dependencies.
 * Usage (Node >=22.7 with TS parameter-property transformation):
 * RUNTIME_SOURCE_COMMIT=<40hex> PLAYWRIGHT_MODULE=/abs/playwright/index.mjs \
 * CHROMIUM_EXECUTABLE=/abs/chromium [SDK_NODE_MODULES=/abs/node_modules] \
 * node --experimental-transform-types packages/sdk/scripts/unindexed-client-read-browser.mjs \
 *   /abs/manifest.json /abs/runtime.wasm /abs/new-output
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {readFile, mkdir, open} from 'node:fs/promises';
import {resolve, dirname, join, isAbsolute} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHash, createPrivateKey, createPublicKey, verify} from 'node:crypto';

const MiB = 1024 * 1024, FRAME = MiB, BOOTSTRAP_EXCEPTION = 60.875 * MiB, READ_WASM_BOUND = 68 * MiB;
const project = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const [manifestPath, artifact, output] = process.argv.slice(2);
const report = {
  schema: 'mdbase-public-unindexed-client-read-browser/1', passed: false,
  manifestPath, runtimePath: artifact, runtimeSourceCommit: process.env.RUNTIME_SOURCE_COMMIT ?? null,
  limitBytes: 32 * MiB, budgetExceeded: null,
  bootstrapException: {authorizedBy: 'docs/contracts/oversized-markdown-bootstrap-memory.md', bytes: BOOTSTRAP_EXCEPTION, sqliteIncluded: true,
    scope: 'authenticated bootstrap only; not a measured or approved public-read ceiling'},
  readMeasurementAuthorization: 'Blob-only lease-bound one-part custody with the browser/native read exception in docs/contracts/unindexed-blob-read-custody.md; clean rerun serves favicon separately',
  readException: {authorizedBy: 'docs/contracts/unindexed-blob-read-custody.md', bytes: READ_WASM_BOUND,
    scope: 'One canonical 8MiB Blob read, browser runtime+SQLite WASM only; no Hosted-isolate/JS budget or scaling qualification',
    priorMeasuredBytes: 67.0625 * MiB, priorReceipt: 'product-a-public-read-browser-v2/report.json'},
  memoryMethod: 'One actual runtime/SQLite pair. WASM capacity and Worker/window JS used/backing are separate; no deduplicated JS sum, no forced GC, no whole-isolate/transient peak claim. Observer allocations are included.',
  screening: 'Binding browser/native read bound: runtime+SQLite WASM <=68MiB. Own-baseline growth remains reported without rounding away prior10.164271%. Runtime/SQLite and JS used/backing stay separate; JS is reported, not budgeted or added to WASM. Original32MiB design violation remains explicit.',
  coverage: {fullApplicationSignIn: false, managedProvider: false, lab: false, crossHostedRead: false,
    hostedAdmission: false, queuedCases: false, cancelNoLateBytes: false,
    note: 'One positive local-browser composition only; Rust security/cancel tests are separate evidence.'},
  forceGcBeforeSample: false,
  runtimeBuildProvenance: 'Caller-declared build source commit plus measured artifact SHA256; not an artifact attestation. Parent must supply the fresh Product A production runtime.',
  sdkBuffering: 'Application hashes/counts/wipes one chunk at a time; no whole-file accumulator. Production SDK ACKs on enqueue (not consumer pull), so its own queued chunks/observer scheduling are included, not hidden.',
  externalFrameScope: 'SDK request/response/push and HTTP CBOR RPC <=1MiB; whole-object Direct ciphertext body and internal transport normalization are not external protocol frames. No protocol changes.',
  design32MiBCompliance: 'not established; WASM-only budgetExceeded is a necessary lower-bound check, never a whole-browser pass',
};
let reportFile, server, context, closeHeapObserver;
const sha = bytes => createHash('sha256').update(bytes).digest();
const failure = error => ({message: String(error?.message ?? error), code: error?.code ?? null, reason: error?.reason ?? null});

// These functions become browser modules; imports are supplied in their module prefixes.
async function workerProgram() {
  const memories = new Map(), stages = [], waits = new Map();
  const native = {requests: {}, acknowledgements: 0, ackThrough: 0, chunks: 0, bytes: 0, last: 0, maxIncomingFrame: 0, maxOutgoingFrame: 0};
  let rt, state, pump, facade, plan, phase = 'bootstrap', sequence = 0, current = true, lastObservation;
  let driver = null, driving = null, driverError = null, driverTurns = 0;
  const check = (value, message) => { if (!value) throw Error(message); };
  const own = hex => Uint8Array.from(hex.match(/../g), byte => parseInt(byte, 16));
  const remember = instance => {
    const ex = instance?.exports;
    if (ex) for (const value of Object.values(ex)) if (value instanceof WebAssembly.Memory)
      memories.set(value, typeof ex.rt_app_open === 'function' ? 'runtime' : 'sqlite');
  };
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async (...args) => { const result = await instantiate(...args); remember(result.instance ?? result); return result; };
  const streaming = WebAssembly.instantiateStreaming;
  WebAssembly.instantiateStreaming = async (...args) => { const result = await streaming(...args); remember(result.instance ?? result); return result; };
  WebAssembly.Memory = new Proxy(WebAssembly.Memory, {construct(target, args, newTarget) {
    const memory = Reflect.construct(target, args, newTarget); memories.set(memory, 'imported'); return memory;
  }});
  function sample(stage) {
    check(stages.length < 4096, 'checkpoint bound exceeded');
    const rows = [...memories].map(([memory, kind]) => ({kind, bytes: memory.buffer.byteLength}));
    const sum = kind => rows.filter(row => row.kind === kind).reduce((n, row) => n + row.bytes, 0);
    const result = {stage, phase, memories: rows, runtimeBytes: sum('runtime'), sqliteBytes: sum('sqlite'),
      wasmBytes: rows.reduce((n, row) => n + row.bytes, 0)};
    stages.push(result);
    return result;
  }
  async function checkpoint(stage) {
    const row = sample(stage), id = ++sequence;
    let timer;
    const heap = new Promise((resolve, reject) => {
      timer = setTimeout(() => { waits.delete(id); reject(Error('heap phase ACK deadline')); }, 15000);
      waits.set(id, resolve);
    });
    postMessage({event: 'heap-phase', phase: id});
    try { row.jsHeap = await heap; } finally { clearTimeout(timer); waits.delete(id); }
    check(!row.jsHeap.failed, 'heap observation failed: ' + row.jsHeap.failed);
    if (phase === 'bootstrap') check(row.wasmBytes <= 60.875 * 1024 * 1024,
      'bootstrap exceeded recorded 60.875MiB exception; no larger case authorized');
    return row;
  }
  const summary = () => ({stages, native, driverTurns, driverError, status: lastObservation?.status, transportHealth: pump?.transportHealth});
  function drive() {
    if (driving) return driving;
    if (!current || !pump || driverError) return Promise.resolve();
    driving = (async () => {
      try {
        check(++driverTurns <= 6000, 'bounded active log drive exhausted');
        rt.tick(); await pump.pump();
        if (!current) return;
        rt.tick(); lastObservation = rt.observations();
        check(!lastObservation.requiresReopen, 'native requires reopen during SDK read');
      } catch (error) { if (current) driverError = String(error.message); }
    })().finally(() => { driving = null; });
    return driving;
  }
  async function openRuntime() {
    plan = await (await fetch('/plan.json')).json();
    await checkpoint('before-runtime-or-sqlite');
    const sqlite = await init({print: () => {}, printErr: () => {}, locateFile: name => '/sqlite/' + name});
    state = await openAppSahpoolIndex(sqlite, plan.scope);
    for (const [memory, kind] of memories) if (kind === 'imported') memories.set(memory, 'sqlite');
    await checkpoint('sqlite-open');
    const bridge = new AppBinaryIndexHost(state.index);
    const sql = {import: exports => appSqlHost(bridge, exports), fence: () => bridge.fence(), get needsRecovery() { return bridge.needsRecovery; }};
    rt = await AppWasmRuntime.create(await (await fetch('/app.wasm')).arrayBuffer(), sql);
    await checkpoint('runtime-created');
    check([...memories.values()].filter(kind => kind === 'runtime').length === 1 &&
      [...memories.values()].filter(kind => kind === 'sqlite').length === 1 && memories.size === 2,
      'expected exactly one runtime and one SQLite memory');
    const version = sqlite.version.libVersion.split('.').map(Number);
    rt.openAppConsuming({collection: plan.collection, replicaId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', deviceId: plan.owner.device,
      endpoint: 37, trustedRoots: [own(plan.rootPk)], policyPins: Uint8Array.from(atob(plan.pins), c => c.charCodeAt(0)),
      trustedSigners: [], expectedGenesis: 'sha256:' + plan.genesis, state: 'cloud_copy', cloudCopyOptIn: true,
      signSecretKey: own(plan.owner.sign_sk), kemSecretKey: own(plan.owner.kem_sk), opened: 'fresh',
      sqliteVersion: version[0] * 1000000 + version[1] * 1000 + version[2]});
    await checkpoint('native-open');
    const request = async (url, options) => {
      const source = plan.sourcePartAddresses.some(address => new URL(url).pathname === '/objects/' + address);
      if (source) await checkpoint('source-http-before');
      const response = await fetch(url, options);
      if (source) await checkpoint('source-http-headers');
      return response;
    };
    const transport = new AppHttpLogTransport({endpoint: 37, collection: plan.collection, origin: location.origin,
      directOrigins: [], isCurrent: () => current, accessToken: async () => plan.token, signLogProof: async proof => rt.signLogHttp(proof)},
      {allowLoopbackHttp: true, fetch: request});
    pump = rt.bindLogTransport(transport); // Binding alone does not autopump.
    let ready = false;
    for (let turn = 0; turn < 128; turn++) {
      rt.tick(); await pump.pump(); rt.tick();
      lastObservation = rt.observations(); await checkpoint('bootstrap-log-turn-' + turn);
      check(!lastObservation.requiresReopen, 'native requires reopen');
      if (initialSyncWait(lastObservation.status) === null && lastObservation.status.confirmedThrough >= plan.head) { ready = true; break; }
    }
    check(ready, 'authentic cold initial sync did not complete');
    await checkpoint('verified-cold-initial-sync');
    // Observe genuine facade frames, without editing/replaying them or holding plaintext.
    const observedRuntime = {connect(options) {
      const port = rt.connect(options);
      const wrapped = {onframe: null, onclose: null, close: () => port.close(), send(frame) {
        const size = encode(frame).byteLength;
        native.maxIncomingFrame = Math.max(native.maxIncomingFrame, size);
        check(size <= 1024 * 1024, 'external SDK request exceeds 1MiB');
        if (frame instanceof Map && frame.get(0) === 0) {
          const method = frame.get(2); native.requests[method] = (native.requests[method] ?? 0) + 1;
          if (method === 'ack_chunks') {
            const through = frame.get(3).get(1);
            check(through >= native.ackThrough && through <= plan.expected.size, 'ACK frontier invalid');
            native.ackThrough = through; native.acknowledgements++; sample('native-output-ack-' + native.acknowledgements);
          }
        }
        port.send(frame);
      }};
      port.onframe = frame => {
        const size = encode(frame).byteLength;
        native.maxOutgoingFrame = Math.max(native.maxOutgoingFrame, size);
        check(size <= 1024 * 1024, 'external SDK response/push exceeds 1MiB');
        if (frame instanceof Map && frame.get(0) === 2 && frame.get(1) === 'file_chunk') {
          const part = frame.get(2), bytes = part.get(2), offset = part.get(1), last = part.get(3);
          check(bytes instanceof Uint8Array && offset === native.bytes && !native.last, 'native output not contiguous');
          native.bytes += bytes.length; native.chunks++; native.last += last ? 1 : 0;
          check(native.bytes <= plan.expected.size && (!last || native.bytes === plan.expected.size), 'native premature last/overrun');
          sample('native-output-' + native.chunks);
        }
        wrapped.onframe?.(frame);
      };
      port.onclose = () => wrapped.onclose?.();
      return wrapped;
    }};
    const channel = new MessageChannel();
    facade = attachAppLocalFacade(observedRuntime, channel.port1, {...plan.scope, isCurrent: () => current}, () => { void drive(); });
    return {port: channel.port2, scope: plan.scope};
  }
  onmessage = async ({data}) => {
    if (data.op === 'heap-phase-ack') { waits.get(data.phase)?.(data.heap); return; }
    try {
      let value;
      if (data.op === 'open') {
        const opened = await openRuntime();
        postMessage({id: data.id, value: {scope: opened.scope}, port: opened.port}, [opened.port]); return;
      } else if (data.op === 'baseline') {
        await checkpoint('bootstrap-metadata-baseline'); value = summary();
      } else if (data.op === 'begin-read') {
        phase = 'read'; await checkpoint('before-sdk-files-read');
        // Explicit bounded active drive plus facade kicks: reads/ACKs can queue real log work.
        driver = setInterval(() => { void drive(); }, 20); value = true;
      } else if (data.op === 'chunk') {
        await checkpoint('sdk-output-and-ack-' + data.chunk); value = true;
      } else if (data.op === 'after-read') {
        await drive(); check(!driverError, driverError);
        await checkpoint('after-sdk-stream-last-and-file-promise'); value = summary();
      } else if (data.op === 'close') {
        clearInterval(driver); driver = null; current = false;
        facade?.close(); await pump?.close(); await driving;
        // pump.close drains in-flight transport work before runtime/SQL teardown.
        if (rt) check(await rt.close() === true, 'runtime clean close refused');
        state?.index.close(); await state?.pool.pauseVfs();
        phase = 'closed'; await checkpoint('after-read-and-close'); value = summary();
      } else throw Error('unknown diagnostic operation');
      postMessage({id: data.id, value});
    } catch (error) { postMessage({id: data.id, error: String(error.message), value: summary()}); }
  };
}

async function windowProgram() {
  const worker = new Worker('/worker.js', {type: 'module'});
  let id = 0, client, connector, reader, stream, latest = {}, result = {}, chunk = 0;
  worker.addEventListener('message', async ({data}) => {
    if (data.event !== 'heap-phase') return;
    let heap;
    try { heap = await window.__readHeapPhase(); } catch (error) { heap = {failed: String(error.message)}; }
    worker.postMessage({op: 'heap-phase-ack', phase: data.phase, heap});
  });
  const rpc = (op, more = {}) => new Promise((yes, no) => {
    const call = ++id;
    const done = () => { clearTimeout(timer); worker.removeEventListener('message', receive); worker.removeEventListener('error', errored); };
    const timer = setTimeout(() => { done(); no(Error('Worker deadline: ' + op)); }, 120000);
    const errored = event => { done(); no(Error('Worker error: ' + event.message)); };
    const receive = ({data}) => {
      if (data.id !== call) return;
      done(); if (data.value && typeof data.value === 'object') latest = data.value;
      if (data.error) no(Error(data.error)); else yes(data);
    };
    worker.addEventListener('message', receive); worker.addEventListener('error', errored);
    worker.postMessage({id: call, op, ...more});
  });
  const timeout = promise => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('bounded SDK operation deadline')), 120000); })])
      .finally(() => clearTimeout(timer));
  };
  try {
    const plan = await (await fetch('/plan.json')).json(), expected = plan.expected;
    const opened = await rpc('open');
    connector = appLocalConnector(opened.port, {...opened.value.scope, isCurrent: () => true});
    client = await timeout(MdbaseClient.connect({app: {name: 'public-unindexed-client-read-measurement', version: '1'}, connector, reconnect: false}));
    const checkFile = file => {
      if (!file || file.id !== expected.id || file.path !== expected.path || file.size !== expected.size ||
        file.digest !== 'sha256:' + expected.sha256 || file.contentProfile !== 'unindexed_markdown_blob')
        throw Error('genuine SDK FileView identity/path/size/hash/contentProfile differs');
      return {id: file.id, path: file.path, size: file.size, digest: file.digest, contentProfile: file.contentProfile};
    };
    const records = await timeout(client.query({limit: 1}, undefined, AbortSignal.timeout(120000)));
    if (records.records.length !== 0) throw Error('unindexed Markdown unexpectedly became query records');
    const metadata = checkFile(await timeout(client.files.get(expected.id, AbortSignal.timeout(120000))));
    result = {typedSdkMetadata: true, metadata, indexedRecordsBefore: 0};
    const baseline = (await rpc('baseline')).value;
    result.baseline = baseline.stages.at(-1);
    await (await fetch('/diagnostic-phase/read', {method: 'POST'})).text();
    await rpc('begin-read');
    stream = client.files.downloadStream(expected.id, {signal: AbortSignal.timeout(120000)});
    result.fileDownloadIssued = true;
    reader = stream.getReader();
    const hash = sha256.create(); let bytes = 0, maxChunkBytes = 0;
    for (;;) {
      // Never retain a whole file or a list of byte chunks. Hash/count one output, wipe, ACK checkpoint.
      const part = await timeout(reader.read());
      if (part.done) break;
      try {
        if (!(part.value instanceof Uint8Array) || !part.value.length || part.value.length > 1024 * 1024)
          throw Error('SDK output chunk outside bounded positive fragment');
        hash.update(part.value); bytes += part.value.length; maxChunkBytes = Math.max(maxChunkBytes, part.value.length);
        if (bytes > expected.size || ++chunk > 1024) throw Error('SDK output exceeded bounded case');
      } finally { part.value.fill(0); }
      // SDK ACK is generated by production Files; yielding also lets it reach native.
      await rpc('chunk', {chunk});
    }
    const completedFile = checkFile(await timeout(stream.file));
    const digest = Array.from(hash.digest(), b => b.toString(16).padStart(2, '0')).join('');
    if (bytes !== expected.size || digest !== expected.sha256) throw Error('incremental SDK source bytes/hash mismatch');
    const measured = (await rpc('after-read')).value;
    if (measured.native.last !== 1 || measured.native.bytes !== expected.size || measured.native.requests.read_file !== 1)
      throw Error('native full-source finish/last missing or duplicate read');
    const after = await timeout(client.query({limit: 1}, undefined, AbortSignal.timeout(120000)));
    if (after.records.length !== 0) throw Error('read unexpectedly indexed source');
    result = {...result, completedFile, bytes, sha256: digest, chunks: chunk, maxChunkBytes,
      indexedRecordsAfter: 0, sdkFilePromiseSucceeded: true, sdkStreamDone: true, nativeLastObserved: true, ...measured};
  } catch (error) { result = {...result, ...latest, failed: String(error.message)}; }
  finally {
    try { if (!result.sdkStreamDone) await reader?.cancel(); } catch (error) { result.cancelCleanupError = String(error.message); }
    reader?.releaseLock();
    try { client?.close(); connector?.close(); } catch (error) { result.failed ??= String(error.message); }
    try { const closed = (await rpc('close')).value; result = {...result, ...closed, cleanClose: true}; }
    catch (error) { result.failed ??= 'close: ' + error.message; result = {...result, ...latest}; }
    worker.terminate();
  }
  return result;
}

try {
  // Reserve create-only report BEFORE imports, manifest/dependency/runtime prerequisites.
  assert.ok(output, 'explicit manifest/runtime/output argv required (no report path available without output)');
  const out = resolve(output);
  await mkdir(out, {recursive: true});
  reportFile = await open(join(out, 'report.json'), 'wx');
  report.reportPath = join(out, 'report.json');
  assert.equal(process.argv.slice(2).length, 3, 'exactly manifest/runtime/output required');
  assert.ok(manifestPath && artifact && isAbsolute(manifestPath) && isAbsolute(artifact) && isAbsolute(output), 'explicit absolute manifest/runtime/output paths required');
  assert.match(process.env.RUNTIME_SOURCE_COMMIT ?? '', /^[a-f0-9]{40}$/, 'explicit runtime BUILD source commit required, not current checkout guess');
  for (const key of ['PLAYWRIGHT_MODULE', 'CHROMIUM_EXECUTABLE']) assert.ok(isAbsolute(process.env[key] ?? ''), key + ' absolute path required');
  assert.equal(process.env.FORCE_GC_CHECKPOINTS, undefined, 'forced GC prohibited for this diagnostic');
  assert.equal(process.env.OBSERVE_PART_SCALING, undefined, 'this is only the bounded single canonical 8MiB case');
  const dependencyRoot = resolve(process.env.SDK_NODE_MODULES ?? join(project, 'packages/sdk/node_modules'));
  const requireDependencies = createRequire(join(dependencyRoot, '__diagnostic__.cjs'));
  const {build} = requireDependencies(join(dependencyRoot, 'esbuild'));
  const {encode, decode} = await import('../src/cbor.ts');
  const {observeBrowserHeaps} = await import('./unindexed-client-read-heap.mjs');
  const fixtureRoot = dirname(manifestPath), manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  report.manifestSha256 = sha(manifestBytes).toString('hex');
  assert.equal(manifest.schema, 'mdbase-public-migrated-fixture/1');
  assert.equal(manifest.publicFixedTestValuesOnly, true);
  assert.equal(manifest.managedCompositionQualified, false);
  assert.equal(manifest.notes, undefined, 'no multi-note/replay surrogate');
  const expected = manifest.expected, sourcePartAddresses = expected.partAddresses;
  assert.equal(expected.kindName, 'unindexed-oversized-markdown');
  assert.equal(expected.contentProfile, 'canonical-blob', 'fixture Blob seal profile, not SDK FileView label');
  assert.equal(expected.size, 8 * MiB); assert.equal(expected.partSize, 8 * MiB);
  assert.equal(sourcePartAddresses.length, 1); assert.equal(manifest.source.bytes, expected.size);
  assert.equal(manifest.source.sha256, expected.sha256); assert.equal(manifest.source.recordId, expected.id); assert.equal(manifest.source.path, expected.path);
  report.expected = {...expected, sdkContentProfile: 'unindexed_markdown_blob'};
  async function checked(file) {
    const path = resolve(fixtureRoot, file.file);
    assert.ok(path.startsWith(fixtureRoot + '/'), 'fixture path escapes root');
    const bytes = await readFile(path);
    assert.equal(bytes.length, file.bytes); assert.equal(sha(bytes).toString('hex'), file.sha256);
    return bytes;
  }
  const original = JSON.parse(await checked(manifest.original)), trust = JSON.parse(await checked(manifest.trust));
  // Integrity checks happen in Node, outside measured browser, never seed the runtime.
  await checked(manifest.originalManifest); await checked(manifest.source);
  await checked(manifest.native.file); await checked(manifest.native.state); await checked(manifest.native.checkpoint);
  const items = await Promise.all(manifest.log.items.map(checked));
  const objects = new Map(manifest.objects.map(object => [object.address, object]));
  assert.equal(objects.size, manifest.objects.length);
  for (const object of objects.values()) await checked(object);
  for (const address of sourcePartAddresses) {
    const part = objects.get(address); assert.ok(part?.canonicalMarkdownPart && part.fileChunk);
    assert.equal(part.addressing, 'keyed-blob-part'); assert.equal(part.kind, 18);
  }
  const wasm = await readFile(artifact);
  report.runtimeSha256 = sha(wasm).toString('hex'); report.hostedFixtureWasmSha256 = manifest.hostedWasmSha256;
  // No runtime compilation. Only bundle existing current SDK/crypto source into a browser module.
  const helpers = (await build({stdin: {contents: `
    export {AppWasmRuntime} from './packages/sdk/src/app-host/wasm-runtime.ts';
    export {AppHttpLogTransport} from './packages/sdk/src/app-host/http-log.ts';
    export {attachAppLocalFacade,appLocalConnector} from './packages/sdk/src/app-host/local-facade.ts';
    export {initialSyncWait} from './packages/sdk/src/app-host/initial-sync.ts';
    export {MdbaseClient} from './packages/sdk/src/client.ts';
    export {AppBinaryIndexHost,appSqlHost,openAppSahpoolIndex} from './packages/sdk/src/app-storage/index.ts';
    export {sha256} from '@noble/hashes/sha2.js'; export {encode} from './packages/sdk/src/cbor.ts';`, resolveDir: project},
    nodePaths: [dependencyRoot], bundle: true, platform: 'browser', format: 'esm', write: false})).outputFiles[0].contents;
  const worker = `import init from '/sqlite/index.mjs';\nimport {AppWasmRuntime,AppHttpLogTransport,attachAppLocalFacade,AppBinaryIndexHost,appSqlHost,openAppSahpoolIndex,initialSyncWait,encode} from '/helpers.js';\n(${workerProgram.toString()})();`;
  const main = `import {MdbaseClient,appLocalConnector,sha256} from '/helpers.js';\nwindow.runClientRead=${windowProgram.toString()};`;
  const assets = new Map([['/helpers.js', ['text/javascript', helpers]], ['/worker.js', ['text/javascript', worker]],
    ['/main.js', ['text/javascript', main]], ['/app.wasm', ['application/wasm', wasm]]]);
  for (const name of ['index.mjs', 'sqlite3.wasm', 'sqlite3-opfs-async-proxy.js'])
    assets.set('/sqlite/' + name, [name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
      await readFile(join(dependencyRoot, '@sqlite.org/sqlite-wasm/dist', name))]);
  const token = 'public-unindexed-client-read-token', nonces = new Set(), leases = new Map();
  const counts = {rpc: [], direct: [], verifiedSignatures: 0, maxRpcRequestBytes: 0, maxRpcResponseBytes: 0, errors: []};
  report.transport = counts;
  let nonceId = 0, leaseId = 0, origin, httpPhase = 'bootstrap';
  const ownerKey = createPublicKey(createPrivateKey({key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(original.owner.sign_sk, 'hex')]), format: 'der', type: 'pkcs8'}));
  const plan = {collection: manifest.collection, owner: original.owner, rootPk: original.root_pk, pins: trust.pins,
    genesis: manifest.log.items[0].chainHash, head: manifest.log.head, expected, sourcePartAddresses, token,
    scope: {account: 'a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a0', installation: '88888888-8888-4888-8888-888888888888', collection: manifest.collection}};
  const reply = (res, bytes) => {
    assert.ok(bytes.length <= FRAME, 'external RPC response >1MiB');
    counts.maxRpcResponseBytes = Math.max(counts.maxRpcResponseBytes, bytes.length);
    res.setHeader('content-type', 'application/cbor'); res.end(bytes);
  };
  server = createServer(async (req, res) => {
    try {
      assert.ok(counts.rpc.length + counts.direct.length + nonceId < 4096, 'bounded fixture request count');
      res.setHeader('cross-origin-opener-policy', 'same-origin'); res.setHeader('cross-origin-embedder-policy', 'require-corp');
      const url = new URL(req.url, 'http://public-fixture');
      if (url.pathname === '/favicon.ico') {
        assert.equal(req.method, 'GET'); res.statusCode = 204; res.end(); return;
      }
      const asset = assets.get(url.pathname);
      if (asset) { res.setHeader('content-type', asset[0]); res.end(asset[1]); return; }
      if (url.pathname === '/plan.json') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(plan)); return; }
      if (url.pathname === '/diagnostic-phase/read') {
        assert.equal(req.method, 'POST'); assert.equal(httpPhase, 'bootstrap'); httpPhase = 'read'; res.end('read'); return;
      }
      if (url.pathname === '/v1/nonce') {
        const nonce = (++nonceId).toString(16).padStart(64, '0'); nonces.add(nonce); res.end(nonce); return;
      }
      if (url.pathname.startsWith('/objects/')) {
        assert.equal(req.method, 'GET');
        const address = url.pathname.slice(9), object = objects.get(address), lease = leases.get(url.searchParams.get('lease'));
        assert.ok(object && lease?.address === address && lease.expires > Date.now(), 'Direct GET must follow verified native-PoP get_object');
        let start = 0, end = object.bytes - 1;
        if (req.headers.range) {
          const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
          assert.ok(match, 'only exact bounded ranges'); start = Number(match[1]); end = Number(match[2]);
          assert.ok(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && end < object.bytes);
        }
        res.statusCode = req.headers.range ? 206 : 200;
        res.setHeader('content-length', String(end - start + 1));
        res.setHeader('x-amz-checksum-sha256', Buffer.from(object.sha256, 'hex').toString('base64'));
        if (req.headers.range) res.setHeader('content-range', `bytes ${start}-${end}/${object.bytes}`);
        const row = {phase: httpPhase, address, sourcePart: sourcePartAddresses.includes(address), offset: start,
          bytes: end - start + 1, servedBytes: 0, complete: false, range: req.headers.range ?? null, nativeProofRpc: lease.rpc};
        counts.direct.push(row);
        const input = createReadStream(join(fixtureRoot, object.file), {start, end, highWaterMark: 64 << 10});
        input.on('data', bytes => { row.servedBytes += bytes.length; });
        res.on('finish', () => { row.complete = row.servedBytes === row.bytes; });
        res.on('close', () => input.destroy());
        input.on('error', error => { counts.errors.push(failure(error)); res.destroy(error); });
        input.pipe(res); return;
      }
      if (url.pathname === '/') {
        res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>PUBLIC canonical Blob READ measurement</title><script type="module" src="/main.js"></script>'); return;
      }
      assert.equal(url.pathname, '/v1/rpc'); assert.equal(req.method, 'POST');
      const parts = []; let size = 0;
      for await (const part of req) { size += part.length; assert.ok(size <= FRAME); parts.push(part); }
      const raw = Buffer.concat(parts), q = decode(new Uint8Array(raw));
      assert.ok(q instanceof Map && q.size === 4 && q.get(0) === 0);
      const params = q.get(3), method = q.get(2), nonce = req.headers['x-mdbase-nonce'];
      assert.ok(params instanceof Map); assert.equal(req.headers.authorization, 'Bearer ' + token);
      assert.ok(typeof nonce === 'string' && nonces.delete(nonce), 'fresh one-use nonce required');
      assert.equal(Buffer.from(params.get(0)).toString('hex'), manifest.collection.replaceAll('-', ''));
      // Independent Node Ed25519 verification of the exact production HTTP PoP input.
      const tag = Buffer.from('mdbase/v1/ls-http'), zero = Buffer.alloc(1);
      const message = sha(Buffer.concat([Buffer.from([tag.length]), tag, Buffer.from(method), zero, Buffer.from('/v1/rpc'), zero,
        Buffer.from(params.get(0)), sha(Buffer.from(token)), sha(raw), Buffer.from(nonce, 'hex')]));
      assert.match(req.headers['x-mdbase-sig'] ?? '', /^[0-9a-f]{128}$/);
      assert.ok(verify(null, message, ownerKey, Buffer.from(req.headers['x-mdbase-sig'], 'hex')), 'native PoP did not verify');
      counts.verifiedSignatures++; counts.maxRpcRequestBytes = Math.max(counts.maxRpcRequestBytes, raw.length);
      const rpc = counts.rpc.length;
      counts.rpc.push({phase: httpPhase, method, requestBytes: raw.length,
        ...(method === 'get_object' ? {address: Buffer.from(params.get(1)).toString('hex'), range: params.get(2) ?? null} : {})});
      let result;
      if (method === 'head') result = new Map([[0, manifest.log.head], [1, Buffer.from(manifest.log.chainHash, 'hex')], [2, 1]]);
      else if (method === 'read') {
        const rows = []; let bytes = 0;
        for (let i = 0; i < items.length; i++) {
          if (i + 1 <= params.get(1) || (params.get(3) === 1 && ![2, 3, 4, 5, 6].includes(manifest.log.items[i].kind))) continue;
          if (rows.length && (rows.length >= params.get(2) || bytes + items[i].length > (params.get(4) ?? FRAME - 1024))) break;
          rows.push([i + 1, new Uint8Array(items[i])]); bytes += items[i].length;
        }
        result = new Map([[0, rows], [1, manifest.log.head], [2, Buffer.from(manifest.log.chainHash, 'hex')], [3, 1], [4, false], [6, rows.length > 0 && rows.at(-1)[0] < manifest.log.head]]);
      } else if (method === 'get_snapshot') result = new Map([[0, []]]);
      else if (method === 'subscribe') result = new Map([[0, manifest.log.head], [1, Buffer.from(manifest.log.chainHash, 'hex')]]);
      else if (method === 'get_object') {
        const address = Buffer.from(params.get(1)).toString('hex'), object = objects.get(address);
        assert.ok(object, 'object must belong to authentic migrated fixture');
        const range = params.get(2);
        if (range !== undefined) {
          assert.ok(Array.isArray(range) && range.length === 2);
          const [offset, length] = range;
          if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > object.bytes || length > object.bytes - offset || length > FRAME - 1024) {
            reply(res, encode(new Map([[0, 1], [1, q.get(1)], [3, new Map([[0, 'invalid'], [1, 'range']])]]))); return;
          }
          const body = Buffer.alloc(length), file = await open(join(fixtureRoot, object.file), 'r');
          try {
            let got = 0;
            while (got < length) { const read = await file.read(body, got, length - got, offset + got); assert.ok(read.bytesRead); got += read.bytesRead; }
          } finally { await file.close(); }
          counts.rpc[rpc].sourcePart = sourcePartAddresses.includes(address); counts.rpc[rpc].sourceBytes = length;
          result = new Map([[0, body], [2, object.bytes], [3, Buffer.from(object.sha256, 'hex')]]);
        } else {
          const lease = String(++leaseId), expires = Date.now() + 60000;
          leases.set(lease, {address, expires, rpc});
          result = new Map([[1, new Map([[0, origin + '/objects/' + address + '?lease=' + lease], [1, new Map()], [2, expires]])],
            [2, object.bytes], [3, Buffer.from(object.sha256, 'hex')]]);
        }
      } else throw Error('unexpected read-only production log method: ' + method);
      reply(res, encode(new Map([[0, 1], [1, q.get(1)], [2, result]])));
    } catch (error) {
      counts.errors.push(failure(error)); res.statusCode = 500; res.end('PUBLIC fixture protocol failure');
    }
  });
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  origin = 'http://127.0.0.1:' + server.address().port;
  const pw = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  const profile = join(out, 'profile'); await mkdir(profile); // Refuse a reused/warm browser profile.
  context = await pw.chromium.launchPersistentContext(profile, {headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE});
  const page = await context.newPage();
  closeHeapObserver = await observeBrowserHeaps(context, page, origin);
  await page.goto(origin); await page.waitForFunction(() => typeof window.runClientRead === 'function');
  const result = await page.evaluate(() => window.runClientRead());
  const stages = result.stages ?? [];
  Object.assign(report, result, {productionAppRuntime: stages.some(row => row.stage === 'runtime-created'),
    actualChromiumWorker: stages.length > 0, actualSqliteOpfs: stages.some(row => row.stage === 'sqlite-open'),
    productionSdkNativeOpenPath: result.typedSdkMetadata === true,
    productionAppHttpDirectTransport: counts.verifiedSignatures > 0 && counts.direct.length > 0,
    publicSyntheticAuthAndServices: true});
  report.phaseTables = Object.fromEntries(['bootstrap', 'read', 'closed'].map(phase => [phase, stages.filter(row => row.phase === phase)]));
  report.wasmCheckpointHighBytes = stages.length ? Math.max(...stages.map(row => row.wasmBytes)) : null;
  report.budgetExceeded = stages.length ? report.wasmCheckpointHighBytes > report.limitBytes : null;
  report.sourceHttp = Object.fromEntries(['bootstrap', 'read'].map(phase => {
    const direct = counts.direct.filter(row => row.phase === phase && row.sourcePart);
    const rangeRpc = counts.rpc.filter(row => row.phase === phase && row.sourcePart);
    return [phase, {directFetches: direct.length, completeDirectFetches: direct.filter(row => row.complete).length,
      servedCiphertextBytes: direct.reduce((n, row) => n + row.servedBytes, 0), exactRangeRpcFetches: rangeRpc.length,
      exactRangeRpcBytes: rangeRpc.reduce((n, row) => n + row.sourceBytes, 0), addresses: [...new Set(direct.map(row => row.address))]}];
  }));
  assert.equal(result.failed, undefined, result.failed);
  assert.equal(result.typedSdkMetadata, true); assert.equal(result.sdkFilePromiseSucceeded, true);
  assert.equal(result.sdkStreamDone, true); assert.equal(result.nativeLastObserved, true); assert.equal(result.cleanClose, true);
  assert.equal(counts.errors.length, 0, 'fixture/proof/frame error'); assert.equal(counts.verifiedSignatures, counts.rpc.length);
  for (const phase of ['bootstrap', 'read']) for (const address of sourcePartAddresses) {
    const gets = counts.direct.filter(row => row.phase === phase && row.address === address && row.complete);
    assert.ok(gets.some(row => row.offset === 0 && row.servedBytes === objects.get(address).bytes),
      phase + ' must actually fetch whole canonical ciphertext; no digest-only/cache surrogate');
  }
  const baseline = result.baseline;
  assert.ok(baseline?.jsHeap, 'missing independent pre-read baseline');
  const readStages = stages.filter(row => row.phase === 'read'), heapStages = readStages.filter(row => row.jsHeap);
  assert.ok(heapStages.length >= 3, 'missing repeated output/ACK heap checkpoints');
  const categories = {
    runtimeCapacity: row => row.runtimeBytes, sqliteCapacity: row => row.sqliteBytes, wasmCapacity: row => row.wasmBytes,
    workerJsUsed: row => row.jsHeap?.worker.usedSize, workerBacking: row => row.jsHeap?.worker.backingStorageSize,
    windowJsUsed: row => row.jsHeap?.window.usedSize, windowBacking: row => row.jsHeap?.window.backingStorageSize,
  };
  report.readScreens = Object.fromEntries(Object.entries(categories).map(([key, get]) => {
    const base = get(baseline), values = readStages.map(get).filter(Number.isFinite), high = Math.max(...values);
    assert.ok(Number.isFinite(base) && values.length, 'missing screening observation: ' + key);
    return [key, {baseline: base, checkpointHigh: high, growth: high - base, ratio: base ? high / base : null,
      ...(key === 'wasmCapacity' ? {thresholdBytes: READ_WASM_BOUND, passed: high <= READ_WASM_BOUND} : {})}];
  }));
  report.memoryScreenCategory = 'wasmCapacity';
  report.readWasmBoundPassed = report.wasmCheckpointHighBytes <= READ_WASM_BOUND;
  assert.ok(report.readScreens.wasmCapacity.passed && report.readWasmBoundPassed,
    'read WASM subtotal exceeds browser/native68MiB bound; stop/report, no additional run (original32MiB design budget remains exceeded)');
  report.passed = true;
} catch (error) { report.passed = false; report.failure = failure(error); }
finally {
  for (const [label, close] of [
    ['heapObserver', () => closeHeapObserver?.()], ['browser', () => context?.close()],
    ['fixtureHttp', () => server?.listening ? new Promise((yes, no) => { server.close(error => error ? no(error) : yes()); server.closeAllConnections(); }) : undefined],
  ]) {
    try { await close(); } catch (error) { report.passed = false; (report.cleanupErrors ??= []).push({label, ...failure(error)}); }
  }
  if (!report.passed) process.exitCode = 1;
  const json = JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n';
  if (reportFile) {
    try { await reportFile.writeFile(json); } catch (error) { process.exitCode = 1; console.error('create-only report write failed:', error.message); }
    finally { await reportFile.close(); }
  }
  console.log(json); // Also JSON on prerequisite failure, even if output cannot be reserved.
}
