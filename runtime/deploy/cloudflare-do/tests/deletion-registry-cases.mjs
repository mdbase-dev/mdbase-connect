// Offline workerd/SQLite only. Permanent floors are NOT a serving lease.
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';

export async function deletionRegistryCases({ base, token, transport, encode, decode, map, sha, h, restart }) {
  const nil = Buffer.alloc(16);
  const id = (label) => sha(Buffer.from(`deletion-registry/${label}`)).subarray(0, 16);
  const c = id('collection'); const deletion = id('deletion');
  const privateKey = (label) => createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), sha(Buffer.from(label))]), type: 'pkcs8', format: 'der' });
  const deviceKey = privateKey('deletion-registry/device');
  const issuer = privateKey('conformance/issuer');
  const pk = createPublicKey(deviceKey).export({ type: 'spki', format: 'der' }).subarray(-32);
  const claims = encode(map([[0, 0], [1, id('caller')], [2, pk], [3, Date.now() + 900000], [4, 'mdbase-log'], [5, nil]]));
  const deviceToken = `${claims.toString('hex')}.${sign(null, h('mdbase/v1/ls-token', claims), issuer).toString('hex')}`;
  async function call(method, params, device = false) {
    const body = encode(map([[0, 0], [1, 1], [2, method], [3, params]]));
    const nonceResponse = await fetch(`${base}/v1/nonce`);
    assert.equal(nonceResponse.status, 200);
    const nonce = Buffer.from(await nonceResponse.text(), 'hex');
    const bearer = device ? deviceToken : token;
    const sig = sign(null, h('mdbase/v1/ls-http', Buffer.concat([Buffer.from(`${method}\0/v1/rpc\0`), params.get(0), sha(Buffer.from(bearer)), sha(body), nonce])), device ? deviceKey : transport);
    const response = await fetch(`${base}/v1/rpc`, { method: 'POST', body, headers: { authorization: `Bearer ${bearer}`, 'x-mdbase-nonce': nonce.toString('hex'), 'x-mdbase-sig': sig.toString('hex') } });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    return { frame: decode(bytes), bytes };
  }
  const ok = ({ frame }) => { assert.ok(frame.has(2), 'expected successful RPC'); return frame.get(2); };
  const fail = ({ frame }, code, reason) => { assert.equal(frame.get(3)?.get(0), code); assert.equal(frame.get(3)?.get(1), reason); return frame.get(3); };
  const write = (target = c, d = deletion, epoch = 1) => map([[0, nil], [1, target], [2, d], [3, epoch]]);
  const scan = (after = null, generation = null) => map([[0, nil], [1, after], [2, generation]]);
  const read = (target = c) => map([[0, nil], [1, target]]);
  const empty = ok(await call('registry_collection_deletions', scan()));
  assert.equal(empty.get(1), 0);
  assert.deepEqual(empty.get(2), []);
  assert.equal(empty.get(3), null);
  assert.equal(empty.get(4), true);
  assert.equal(ok(await call('registry_collection_deletion', read())).get(2), null);
  fail(await call('registry_record_collection_deletion', write(), true), 'forbidden', 'principal');
  for (const malformed of [write(nil), write(c, nil), write(c, deletion, 0), map([...write(), [4, 1]])]) {
    fail(await call('registry_record_collection_deletion', malformed), 'invalid', 'collection_deletion_request');
  }
  fail(await call('registry_record_collection_deletion', map([[0, c], [1, c], [2, deletion], [3, 1]])), 'invalid', 'collection_deletion_request');
  assert.equal(ok(await call('registry_collection_deletions', scan())).get(1), 0, 'refusals have no durable floor effect');
  const maximumEpoch = (1n << 64n) - 1n;
  const first = ok(await call('registry_record_collection_deletion', write(c, deletion, maximumEpoch)));
  assert.equal(first.size, 5);
  assert.equal(first.get(3), maximumEpoch);
  assert.equal(first.get(4), 1);
  assert.deepEqual(ok(await call('registry_record_collection_deletion', write(c, deletion, maximumEpoch))), first);
  for (const conflict of [write(c, id('other-deletion'), maximumEpoch), write(c, deletion, 1)]) {
    const error = fail(await call('registry_record_collection_deletion', conflict), 'forbidden', 'collection_deletion_conflict');
    assert.deepEqual(error.get(4), first, 'first immutable record is returned in details');
  }
  await restart();
  const restored = ok(await call('registry_collection_deletion', read()));
  assert.deepEqual(restored.get(2), [c, deletion, maximumEpoch]);
  assert.equal(restored.get(3), 1);
  // Credential mutation and consumed HTTP nonces never change deletion revision.
  ok(await call('revoke_device_credentials', map([[0, id('revoked-device')]])));
  assert.equal(ok(await call('registry_collection_deletions', scan())).get(1), 1);
  for (let i = 0; i < 129; i++) ok(await call('registry_record_collection_deletion', write(id(`collection-${i}`), id(`deletion-${i}`), i + 1)));
  const page1 = await call('registry_collection_deletions', scan());
  assert.ok(page1.bytes.length <= 32768);
  const p = ok(page1);
  assert.equal(p.get(1), 130);
  assert.equal(p.get(2).length, 128);
  assert.equal(p.get(4), false);
  const cursor = p.get(3);
  await restart();
  const page2 = ok(await call('registry_collection_deletions', scan(cursor, 130)));
  assert.equal(page2.get(2).length, 2);
  assert.equal(page2.get(4), true);
  const all = [...p.get(2), ...page2.get(2)];
  assert.equal(all.length, 130);
  for (let i = 1; i < all.length; i++) assert.ok(Buffer.compare(all[i - 1][0], all[i][0]) < 0);
  const finalCursor = page2.get(3);
  const done = ok(await call('registry_collection_deletions', scan(finalCursor, 130)));
  assert.deepEqual(done.get(2), []);
  assert.equal(done.get(4), true);
  fail(await call('registry_collection_deletions', scan(cursor)), 'invalid', 'collection_deletion_request');
  // A new floor is never delayed by a scan; even a terminal scan is invalidated.
  ok(await call('registry_record_collection_deletion', write(id('late-collection'), id('late-deletion'), 99)));
  fail(await call('registry_collection_deletions', scan(cursor, 130)), 'unavailable', 'collection_deletion_floor_unavailable');
  fail(await call('registry_collection_deletions', scan(finalCursor, 130)), 'unavailable', 'collection_deletion_floor_unavailable');
  assert.equal(ok(await call('registry_collection_deletions', scan())).get(1), 131);
  console.log('PASS: immutable deletion floor, full-u64 epoch, typed conflict, actual nil/CP/shape refusal, restart, bounded generation-stable keyset pages and post-terminal drift');
}
