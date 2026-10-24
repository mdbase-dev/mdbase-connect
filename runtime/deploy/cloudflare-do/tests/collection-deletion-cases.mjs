// Actual LOCAL workerd/SQLite + nil LOG authority. No serving or erasure proof.
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';

export async function collectionDeletionCases({ base, token, transport, encode, decode, map, sha, h, restart }) {
  const id = (label) => sha(Buffer.from(`terminal-deletion/${label}`)).subarray(0, 16);
  const nil = Buffer.alloc(16), c = id('collection'), deletion = id('deletion');
  const epoch = (1n << 64n) - 1n;
  const key = (label) => createPrivateKey({ key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'), sha(Buffer.from(label)),
  ]), type: 'pkcs8', format: 'der' });
  const pk = (k) => createPublicKey(k).export({ type: 'spki', format: 'der' }).subarray(-32);
  const root = key('conformance/root'), issuer = key('conformance/issuer'), deviceKey = key('terminal-deletion/device');
  const deviceClaims = encode(map([[0, 0], [1, id('device')], [2, pk(deviceKey)], [3, Date.now() + 900000], [4, 'mdbase-log'], [5, c]]));
  const deviceToken = `${deviceClaims.toString('hex')}.${sign(null, h('mdbase/v1/ls-token', deviceClaims), issuer).toString('hex')}`;
  const rootId = sha(pk(root)).subarray(0, 16);
  const cert = map([[0, pk(transport)], [1, 0], [2, 2 ** 50], [3, rootId]]);
  cert.set(4, sign(null, h('mdbase/v1/cp-cert', encode(cert)), root));
  const payload = encode(map([[0, 1], [1, cert], [2, 1], [3, [map([[0, 1], [1, id('owner')], [2, rootId], [3, 0]])]]]));
  const item = map([[0, 1], [1, 2], [2, c], [3, 1], [4, Buffer.alloc(32)], [6, sha(pk(transport)).subarray(0, 16)], [11, payload]]);
  item.set(12, sign(null, h('mdbase/v1/item-sig', encode(item)), transport));
  const genesis = encode(item);
  async function call(method, params, device = false, floorFault) {
    const body = encode(map([[0, 0], [1, 1], [2, method], [3, params]]));
    const nonceResponse = await fetch(`${base}/v1/nonce`);
    assert.equal(nonceResponse.status, 200);
    const nonce = Buffer.from(await nonceResponse.text(), 'hex');
    const bearer = device ? deviceToken : token;
    const sig = sign(null, h('mdbase/v1/ls-http', Buffer.concat([
      Buffer.from(`${method}\0/v1/rpc\0`), params.get(0), sha(Buffer.from(bearer)), sha(body), nonce,
    ])), device ? deviceKey : transport);
    const headers = { authorization: `Bearer ${bearer}`, 'x-mdbase-nonce': nonce.toString('hex'), 'x-mdbase-sig': sig.toString('hex') };
    if (floorFault) {
      if (floorFault.carryWork !== undefined) Object.assign(headers, {
        'x-logsvc-decode-nodes': '0', 'x-logsvc-decode-work': String(floorFault.carryWork),
        'x-logsvc-decode-depth': '0',
      });
      const hex = params.get(0).toString('hex');
      const actor = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
      const response = await fetch(`${base}/__test/floor-actor`, { method: 'POST',
        body: JSON.stringify({ actor, url: `https://do/v1/rpc?c=${actor}`, headers,
          body: body.toString('base64'), ...floorFault }),
      });
      assert.equal(response.status, 200);
      const observed = await response.json();
      if (floorFault.inspectResponse) return { ...observed,
        frame: observed.status === 200 ? decode(Buffer.from(observed.response)) : null };
      assert.equal(observed.status, 200);
      assert.ok(observed.calls > 0, 'actual backend-owned nil lookup must hit the fault seam');
      return decode(Buffer.from(observed.response));
    }
    const response = await fetch(`${base}/v1/rpc`, { method: 'POST', body, headers });
    assert.equal(response.status, 200, `${method} transport`);
    return decode(Buffer.from(await response.arrayBuffer()));
  }
  const ok = (frame) => { assert.ok(frame.has(2), `RPC failure: ${JSON.stringify([...frame.get(3) ?? []], (_, v) => typeof v === 'bigint' ? String(v) : v)}`); return frame.get(2); };
  const fail = (frame, code, reason) => { const error = frame.get(3); assert.equal(error?.get(0), code); assert.equal(error?.get(1), reason); return error; };
  const status = (target = c) => call('log_terminal_status', map([[0, target]]));
  const request = (d = deletion, e = epoch, target = c) => map([[0, target], [1, d], [2, e]]);
  const record = (target = c, d = deletion, e = epoch) => call('registry_record_collection_deletion', map([[0, nil], [1, target], [2, d], [3, e]]));
  const receipt = [1, c, deletion, epoch];
  const assertStatus = async (expected, terminal = null, target = c) => {
    const result = ok(await status(target));
    assert.equal(result.size, 4); assert.equal(result.get(0), 1);
    assert.deepEqual(result.get(1), target); assert.equal(result.get(2), expected); assert.deepEqual(result.get(3), terminal);
  };
  await assertStatus(0);
  ok(await call('create_log', map([[0, c], [1, genesis]])));
  await assertStatus(1);
  fail(await call('delete_log', request()), 'unavailable', 'collection_deletion_floor_unavailable');
  await assertStatus(1);
  for (const malformed of [map([[0, c]]), request(nil), request(deletion, 0), request(deletion, true), map([...request(), [3, 1]])]) {
    fail(await call('delete_log', malformed), 'invalid', 'collection_deletion_request');
  }
  fail(await call('delete_log', request(), true), 'forbidden', 'principal');
  fail(await call('log_terminal_status', map([[0, c]]), true), 'forbidden', 'principal');
  await assertStatus(1);
  // Fault the actual backend-owned producer response at DoTxn::commit, after
  // quota metadata has been buffered. Every unknown must retain ALL SQL state.
  const actorHex = c.toString('hex');
  const actor = `${actorHex.slice(0,8)}-${actorHex.slice(8,12)}-${actorHex.slice(12,16)}-${actorHex.slice(16,20)}-${actorHex.slice(20)}`;
  const inspect = async () => {
    const response = await fetch(`${base}/__test/aux-state`, { method: 'POST', body: JSON.stringify({ actor }) });
    assert.equal(response.status, 200); return response.json();
  };
  const quota = map([[0,c],[1,[999999,100,100000,100]]]);
  ok(await call('set_quota', quota, false, { fault: 'actual' }));
  const beforeFaults = await inspect();
  const replies = [
    ['wrong-version', [2,c,null]], ['wrong-outer-collection', [1,id('foreign'),null]],
    ['wrong-inner-collection', [1,c,[1,id('foreign'),deletion,epoch]]],
    ['nil-inner-collection', [1,c,[1,nil,deletion,epoch]]],
    ['nil-deletion', [1,c,[1,c,nil,epoch]]], ['zero-epoch', [1,c,[1,c,deletion,0]]],
    ['bool-epoch', [1,c,[1,c,deletion,true]]], ['wrong-record-version', [1,c,[2,c,deletion,epoch]]],
    ['extra-field', [1,c,null,1]], ['map-not-array', map([[0,1],[1,c],[2,null]])],
  ].map(([label,value]) => ({ label, fault: 'bytes', reply: encode(value).toString('base64') }));
  const malformed = [
    { label: 'unreachable', fault: 'unreachable' }, { label: 'non200', fault: 'status' },
    { label: 'empty', fault: 'empty' },
    { label: 'oversize-before-decode', fault: 'bytes', reply: Buffer.alloc(1025).toString('base64') },
    { label: 'trailing-byte', fault: 'bytes', reply: Buffer.concat([encode([1,c,null]),Buffer.from([0])]).toString('base64') },
    { label: 'truncated', fault: 'bytes', reply: Buffer.from([0x83,1]).toString('base64') },
    { label: 'no-BYOB', fault: 'default-reader', reply: encode([1,c,null]).toString('base64') },
    ...replies,
  ];
  for (const fixture of malformed) {
    fail(await call('set_quota', map([[0,c],[1,[888888,101,100001,101]]]), false, fixture),
      'unavailable', 'collection_deletion_floor_unavailable');
    assert.deepEqual(await inspect(), beforeFaults, `${fixture.label}: no buffered SQL/meta/quota publication`);
  }
  ok(await call('set_quota', quota)); // seam restored; genuine nil absence still works.
  assert.deepEqual(await inspect(), beforeFaults);
  console.log(`PASS: ${malformed.length} actual DoTxn nil producer unknown/malformed/non-BYOB/cap refusals preserve SQL/meta/quota`);
  // Find the exact work boundary without assuming authentication/projection sizes.
  // Only resource-restricting carry is varied; every call still uses genuine CP
  // authentication and the actual nil authority. At most 27 bounded local probes.
  const maxWork = 64 * 1024 * 1024;
  const probe = (remaining) => call('set_quota', quota, false, {
    fault: 'actual', carryWork: maxWork - remaining, inspectResponse: true,
  });
  let low = 1, high = maxWork;
  for (let step = 0; step < 27 && low < high; step++) {
    const middle = Math.floor((low + high) / 2);
    const observed = await probe(middle);
    if (observed.frame?.has(2)) high = middle; else low = middle + 1;
    assert.deepEqual(await inspect(), beforeFaults, 'budget probe retains exact quota/meta');
  }
  assert.equal(low, high);
  assert.ok(high > 1);
  const exhausted = await probe(high - 1);
  assert.equal(exhausted.status, 200);
  assert.equal(exhausted.calls, 1, 'shared refusal occurs at the real DoTxn floor reply');
  fail(exhausted.frame, 'unavailable', 'collection_deletion_floor_unavailable');
  assert.deepEqual(await inspect(), beforeFaults, 'no quota/meta publication after floor budget refusal');
  console.log('PASS: actual DoTxn floor decoder preserves forwarded shared work budget before SQL publication');
  const first = ok(await record());
  assert.deepEqual([first.get(1), first.get(2), first.get(3)], [c, deletion, epoch]);
  // Independent floor alone must stop positive writes while collection stays Live.
  await assertStatus(1);
  fail(await call('create_log', map([[0, c], [1, genesis]])), 'gone', 'collection_deletion_floor');
  fail(await call('set_quota', map([[0, c], [1, [999999, 100, 100000, 100]]])), 'gone', 'collection_deletion_floor');
  fail(await call('import', map([[0, c], [1, []]])), 'gone', 'collection_deletion_floor');
  fail(await call('import_object', map([[0, c], [1, Buffer.alloc(32)], [2, 18], [3, Buffer.alloc(0)]])), 'gone', 'collection_deletion_floor');
  fail(await call('import_snapshot', map([[0, c], [1, 1], [2, Buffer.alloc(32)], [3, []]])), 'gone', 'collection_deletion_floor');
  await assertStatus(1);
  for (const conflict of [request(id('other-deletion')), request(deletion, 1)]) {
    assert.deepEqual(fail(await call('delete_log', conflict), 'forbidden', 'collection_deletion_conflict').get(4), receipt);
  }
  const deleted = ok(await call('delete_log', request()));
  assert.equal(deleted.size, 2); assert.equal(deleted.get(0), true); assert.deepEqual(deleted.get(1), receipt);
  await assertStatus(3, receipt);
  assert.deepEqual(ok(await call('delete_log', request())), deleted);
  await restart();
  await assertStatus(3, receipt);
  assert.deepEqual(ok(await call('delete_log', request())), deleted);
  const floorAfterRestart = ok(await call('registry_collection_deletion', map([[0, nil], [1, c]])));
  assert.deepEqual(floorAfterRestart.get(2), [c, deletion, epoch]);
  const absent = id('absent');
  ok(await record(absent, id('absent-deletion'), 1));
  fail(await call('delete_log', request(id('absent-deletion'), 1, absent)), 'not_found', undefined);
  await assertStatus(0, null, absent); // Deletion never creates an empty actor log.
  console.log('PASS: actual nil floor getter, strict typed Gone/status/full-u64/conflicts/retry/restart, floor-only publication refusal and absent-log noncreation');
}
