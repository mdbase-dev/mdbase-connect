// Actual local workerd/SQLite: the nil registry is off the append path. A slow
// registry read never holds the collection's writer lock, a warm actor appends
// without asking the registry at all, and a floor or Closing row recorded while
// an actor's read is in flight, or while the registry fences it, still refuses
// that actor's publication.
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export async function registryOffAppendCases({ base, token, transport, encode, decode, map, sha, h }) {
  const key = label => createPrivateKey({ key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'), sha(Buffer.from(label)),
  ]), type: 'pkcs8', format: 'der' });
  const pk = k => createPublicKey(k).export({ type: 'spki', format: 'der' }).subarray(-32);
  const id = label => sha(Buffer.from(`registry-off-append/${label}`)).subarray(0, 16);
  const uuid = b => b.toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  const root = key('conformance/root'), issuer = key('conformance/issuer');
  const deviceKey = key('registry-off-append/device');
  const owner = id('owner'), device = id('device'), nil = Buffer.alloc(16);
  const rootId = sha(pk(root)).subarray(0, 16);
  const cert = map([[0, pk(transport)], [1, 0], [2, 2 ** 50], [3, rootId]]);
  cert.set(4, sign(null, h('mdbase/v1/cp-cert', encode(cert)), root));
  const chain = b => h('mdbase/v1/chain', b);
  const signed = (item, k) => {
    item.set(12, sign(null, h('mdbase/v1/item-sig', encode(item)), k));
    return encode(item);
  };
  const seqId = seq => { const b = Buffer.alloc(16); b.writeUInt32BE(seq, 12); return b; };

  async function request(method, params, bearer, k, path = '/v1/rpc') {
    const body = encode(map([[0, 0], [1, 1], [2, method], [3, params]]));
    const nr = await fetch(`${base}/v1/nonce`); assert.equal(nr.status, 200);
    const nonce = Buffer.from(await nr.text(), 'hex');
    const sig = sign(null, h('mdbase/v1/ls-http', Buffer.concat([
      Buffer.from(`${method}\0${path}\0`), params.get(0), sha(Buffer.from(bearer)), sha(body), nonce,
    ])), k);
    return { body, headers: { authorization: `Bearer ${bearer}`, 'x-mdbase-nonce': nonce.toString('hex'),
      'x-mdbase-sig': sig.toString('hex') } };
  }
  async function cp(method, params, path = '/v1/rpc') {
    const r = await fetch(`${base}${path}`, { method: 'POST', ...await request(method, params, token, transport, path),
      signal: AbortSignal.timeout(10000) });
    assert.equal(r.status, 200, method);
    return decode(Buffer.from(await r.arrayBuffer()));
  }
  const ok = frame => { assert.ok(frame.has(2), `RPC failure ${frame.get(3)?.get(0)}/${frame.get(3)?.get(1)}`); return frame.get(2); };
  const refusal = frame => [frame.get(3)?.get(0), frame.get(3)?.get(1)];
  const unknownFloor = ['unavailable', 'collection_deletion_floor_unavailable'];
  const recordFloor = c => cp('registry_record_collection_deletion', map([[0, nil], [1, c], [2, id('deletion')], [3, 1]]));

  // One live collection: genesis, an enrolled device, one device entry.
  async function open(label) {
    const c = id(label), actor = uuid(c);
    const claims = encode(map([[0, 0], [1, device], [2, pk(deviceKey)], [3, Date.now() + 900000], [4, 'mdbase-log'], [5, c]]));
    const deviceToken = `${claims.toString('hex')}.${sign(null, h('mdbase/v1/ls-token', claims), issuer).toString('hex')}`;
    const policy = (seq, prev, ops) => signed(map([[0, 1], [1, 2], [2, c], [3, seq], [4, prev],
      [6, sha(pk(transport)).subarray(0, 16)], [11, encode(map([[0, 1], [1, cert], [2, seq], [3, ops]]))]]), transport);
    const entry = (seq, prev) => signed(map([[0, 1], [1, 1], [2, c], [3, seq], [4, prev], [5, 0],
      [6, device], [7, seqId(seq)], [8, seqId(seq)], [11, Buffer.alloc(32, seq)]]), deviceKey);
    async function call(method, params, isDevice, timeout = 10000) {
      if (!isDevice) return cp(method, params);
      const r = await fetch(`${base}/v1/rpc`, { method: 'POST', ...await request(method, params, deviceToken, deviceKey),
        signal: AbortSignal.timeout(timeout) });
      assert.equal(r.status, 200, method);
      return decode(Buffer.from(await r.arrayBuffer()));
    }
    // The request runs inside the actor with its nil-registry floor reads
    // routed through the test seam: `pause` holds the first read's genuine reply.
    async function seamed(method, params, isDevice, seam) {
      const { body, headers } = isDevice ? await request(method, params, deviceToken, deviceKey)
        : await request(method, params, token, transport);
      const r = await fetch(`${base}/__test/floor-actor`, { method: 'POST', body: JSON.stringify({
        actor, url: `https://do/v1/rpc?c=${actor}`, headers, body: body.toString('base64'), ...seam,
      }), signal: AbortSignal.timeout(20000) });
      assert.equal(r.status, 200);
      const observed = await r.json();
      assert.equal(observed.status, 200);
      return { calls: observed.calls, frame: decode(Buffer.from(observed.response)) };
    }
    async function harness(path) {
      const r = await fetch(`${base}/__test/${path}`, { method: 'POST', body: JSON.stringify({ actor }),
        signal: AbortSignal.timeout(10000) });
      assert.equal(r.status, 200, path);
      return path.endsWith('state') ? r.json() : r.text();
    }
    async function until(state, what) {
      for (let i = 0; i < 300; i++) {
        if ((await harness(state)).paused) return;
        await delay(10);
      }
      assert.fail(what);
    }
    const genesis = policy(1, Buffer.alloc(32), [map([[0, 1], [1, owner], [2, rootId], [3, 0]])]);
    ok(await call('create_log', map([[0, c], [1, genesis]])));
    const enrol = policy(2, chain(genesis), [map([[0, 2], [1, device], [2, owner], [3, 0],
      [4, pk(deviceKey)], [5, Buffer.alloc(32, 7)], [6, Buffer.alloc(32, 8)]])]);
    ok(await call('append', map([[0, c], [1, 2], [2, chain(genesis)], [3, [enrol]]])));
    const log = { c, call, seamed, harness, until, seq: 3, prev: chain(enrol) };
    // The next entry's append params; `commit` advances the head after success.
    log.next = () => {
      const item = entry(log.seq, log.prev);
      return { params: map([[0, c], [1, log.seq], [2, log.prev], [3, [item]]]),
        commit: () => { log.seq += 1; log.prev = chain(item); } };
    };
    log.append = async timeout => {
      const n = log.next();
      ok(await call('append', n.params, true, timeout));
      n.commit();
    };
    await log.append();
    return log;
  }

  const a = await open('collection');
  // 1. Warm actor: appends take no registry round trip at all, so holding the
  // registry's reply cannot delay them.
  for (let i = 0; i < 5; i++) {
    const n = a.next();
    const warm = await a.seamed('append', n.params, true, { fault: 'pause', fence: false });
    ok(warm.frame);
    assert.equal(warm.calls, 0, 'a warm actor appends without asking the registry');
    n.commit();
  }
  console.log('PASS: warm actor appends with no nil-registry read');

  // 2. Cold actor, slow registry: one writer's floor read is held indefinitely.
  // Other writers still append promptly; before this change the held read kept
  // the collection's writer lock and every append behind it waited.
  const quota = c => map([[0, c], [1, [999999, 100, 100000, 100]]]);
  const held = a.seamed('set_quota', quota(a.c), false, { fault: 'pause' });
  held.catch(() => {});
  try {
    await a.until('floor-pause-state', 'the seamed request never reached its registry read');
    const started = Date.now();
    for (let i = 0; i < 20; i++) await a.append(3000);
    const elapsed = Date.now() - started;
    assert.equal((await a.harness('floor-pause-state')).paused, true, 'the slow read is still held');
    console.log(`INFO 20 appends in ${elapsed} ms while a writer's registry read was held`);
  } finally { await a.harness('resume-floor'); }
  const resumed = await held;
  ok(resumed.frame);
  assert.ok(resumed.calls >= 1);
  await a.append();
  console.log('PASS: a held nil-registry read stalls no other append');

  // 3. A floor recorded while an actor's read is in flight voids that read's
  // absent answer; the actor publishes nothing afterwards.
  const before = await a.harness('destination-state');
  const racing = a.next();
  const raced = a.seamed('append', racing.params, true, { fault: 'pause' });
  raced.catch(() => {});
  try {
    await a.until('floor-pause-state', 'the seamed request never reached its registry read');
    const floor = ok(await recordFloor(a.c));
    assert.deepEqual([floor.get(1), floor.get(2), floor.get(3)], [a.c, id('deletion'), 1]);
  } finally { await a.harness('resume-floor'); }
  // Voided read: unknown, or Gone once the registry's deletion notice cached the floor.
  const voided = refusal((await raced).frame);
  assert.ok([unknownFloor, ['gone', 'collection_deletion_floor']].some(r => r.join() === voided.join()),
    `the in-flight absent answer did not publish, got ${voided}`);
  assert.deepEqual((await a.harness('destination-state')).items, before.items, 'no item after the floor');
  assert.deepEqual(refusal(await a.call('append', racing.params, true)), ['gone', 'collection_deletion_floor']);
  assert.deepEqual(refusal(await a.call('set_quota', quota(a.c))), ['gone', 'collection_deletion_floor']);
  console.log('PASS: a floor recorded during an in-flight read refuses that write and every later one');

  // 4. While the registry fences an actor (fence applied, insert not yet
  // made), a fresh read must not learn absence: the registry refuses it.
  const b = await open('fenced');
  await b.harness('arm-fence-pause');
  const fencing = recordFloor(b.c);
  fencing.catch(() => {});
  let during;
  try {
    await b.until('fence-pause-state', 'the registry never fenced the actor');
    const n = b.next();
    during = await b.call('append', n.params, true);
    assert.deepEqual(refusal(during), unknownFloor, 'no absence is learnt while the fence is outstanding');
  } finally { await b.harness('resume-fence'); }
  ok(await fencing);
  assert.deepEqual(refusal(await b.call('append', b.next().params, true)), ['gone', 'collection_deletion_floor']);
  console.log('PASS: a read during the registry fence learns no absence; the floor then refuses');

  // 5. Closing fences a warm actor too: its next publication refuses.
  const d = await open('closing');
  await d.append();
  ok(await cp('registry_begin_collection_closing', map([[0, nil], [1, 1], [2, d.c], [3, id('deletion')], [4, 1]]),
    '/v1/registry-collection-closing'));
  assert.deepEqual(refusal(await d.call('append', d.next().params, true)), unknownFloor);
  assert.deepEqual(refusal(await d.call('set_quota', quota(d.c))), unknownFloor);
  console.log('PASS: Closing on a warm actor refuses its next publication');
}
