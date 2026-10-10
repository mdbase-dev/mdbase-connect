// Local workerd/SQLite nil credential registry; no remote/provider operations.
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';

export async function registryBackupCases({ base, token, transport, encode, decode, map, sha, h, restart }) {
  const nil = Buffer.alloc(16);
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), sha(Buffer.from('registry-backup/device'))]), type: 'pkcs8', format: 'der' });
  const pk = (k) => createPublicKey(k).export({ type: 'spki', format: 'der' }).subarray(-32);
  const issuer = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), sha(Buffer.from('conformance/issuer'))]), type: 'pkcs8', format: 'der' });
  const claims = encode(map([[0, 0], [1, sha(Buffer.from('registry-backup/caller')).subarray(0, 16)], [2, pk(key)], [3, Date.now() + 900000], [4, 'mdbase-log'], [5, nil]]));
  const deviceToken = `${claims.toString('hex')}.${sign(null, h('mdbase/v1/ls-token', claims), issuer).toString('hex')}`;
  async function call(method, params, device = false) {
    const body = encode(map([[0, 0], [1, 1], [2, method], [3, params]]));
    const nonce = Buffer.from(await (await fetch(`${base}/v1/nonce`)).text(), 'hex');
    const t = device ? deviceToken : token;
    const c = params.get(0);
    const sig = sign(null, h('mdbase/v1/ls-http', Buffer.concat([Buffer.from(`${method}\0/v1/rpc\0`), c, sha(Buffer.from(t)), sha(body), nonce])), device ? key : transport);
    const response = await fetch(`${base}/v1/rpc`, { method: 'POST', body, headers: { authorization: `Bearer ${t}`, 'x-mdbase-nonce': nonce.toString('hex'), 'x-mdbase-sig': sig.toString('hex') } });
    assert.equal(response.status, 200, `${method} transport`);
    return decode(Buffer.from(await response.arrayBuffer()));
  }
  const ok = (f) => { assert.ok(f.has(2), JSON.stringify([...f.get(3) ?? []])); return f.get(2); };
  const fail = (f, reason) => assert.equal(f.get(3)?.get(1), reason);
  const devices = Array.from({ length: 205 }, (_, i) => sha(Buffer.from(`registry-backup/revoked-${i}`)).subarray(0, 16)).sort(Buffer.compare);
  for (let i = 0; i < devices.length; i += 100) {
    ok(await call('backup_registry_merge', map([[0, nil], [1, devices.slice(i, i + 100).map((d) => [d, 1000])]])));
  }
  fail(await call('backup_registry_begin', map([[0, nil]]), true), 'principal');
  fail(await call('backup_registry_begin', map([[0, devices[0]]])), 'registry_collection');
  fail(await call('backup_registry_merge', map([[0, nil], [1, [[devices[0], 1000], [Buffer.alloc(15), 1000]]]])), 'registry_rows');
  fail(await call('backup_registry_merge', map([[0, nil], [1, [[devices[1], 1000], [devices[0], 1000]]]])), 'registry_rows');
  fail(await call('backup_registry_merge', map([[0, nil], [1, [[nil, 1000]]]])), 'registry_rows');
  const begin = ok(await call('backup_registry_begin', map([[0, nil]])));
  const header = decode(begin.get(0));
  assert.equal(header.get(0), 'mdbase-next-credential-registry/1');
  assert.deepEqual(sha(begin.get(0)), begin.get(1));
  let page = 1, previous = begin.get(1);
  const session = header.get(2);
  fail(await call('backup_registry_finish', map([[0, nil], [1, session], [2, previous]])), 'registry_backup_state');
  const first = ok(await call('backup_registry_page', map([[0, nil], [1, session], [2, page], [3, previous]])));
  assert.equal(decode(first.get(0)).get(6).length, 100);
  await restart();
  assert.deepEqual(ok(await call('backup_registry_page', map([[0, nil], [1, session], [2, page], [3, previous]]))), first);
  fail(await call('backup_registry_page', map([[0, nil], [1, session], [2, page], [3, Buffer.alloc(32)]])), 'registry_backup_state');
  fail(await call('backup_registry_page', map([[0, nil], [1, session], [2, page]])), 'registry_hash');
  const all = [...decode(first.get(0)).get(6)];
  let lastPrevious = previous;
  previous = first.get(1);
  for (page = 2; page < 20; page++) {
    const reply = ok(await call('backup_registry_page', map([[0, nil], [1, session], [2, page], [3, previous]])));
    const body = decode(reply.get(0));
    assert.deepEqual(sha(reply.get(0)), reply.get(1));
    assert.deepEqual(body.get(5), previous);
    assert.equal(body.get(3), header.get(3));
    assert.ok(body.get(6).length <= 100);
    all.push(...body.get(6));
    lastPrevious = previous; previous = reply.get(1);
    if (body.get(7)) break;
  }
  assert.ok(page < 20);
  for (const d of devices) assert.ok(all.some((row) => row[0].equals(d) && row[1] === 1000));
  ok(await call('backup_registry_finish', map([[0, nil], [1, session], [2, previous]])));
  // An identical or newer-time archive merge cannot erase/advance old denial.
  ok(await call('backup_registry_merge', map([[0, nil], [1, [[devices[0], 2000]]]])));
  ok(await call('backup_registry_finish', map([[0, nil], [1, session], [2, previous]])));
  // A real new denial must proceed immediately and invalidate FINISHED cut.
  const late = sha(Buffer.from('registry-backup/late')).subarray(0, 16);
  ok(await call('backup_registry_merge', map([[0, nil], [1, [[late, 3000]]]])));
  fail(await call('backup_registry_page', map([[0, nil], [1, session], [2, page], [3, lastPrevious]])), 'registry_backup_state');
  fail(await call('backup_registry_finish', map([[0, nil], [1, session], [2, previous]])), 'registry_backup_state');
  const next = ok(await call('backup_registry_begin', map([[0, nil]])));
  assert.ok(decode(next.get(0)).get(3) > header.get(3));
  ok(await call('backup_registry_abort', map([[0, nil], [1, decode(next.get(0)).get(2)]])));
  await restart();
  const durable = ok(await call('backup_registry_begin', map([[0, nil]])));
  const restored = ok(await call('backup_registry_page', map([[0, nil], [1, decode(durable.get(0)).get(2)], [2, 1], [3, durable.get(1)]])));
  const original = decode(restored.get(0)).get(6).find((row) => row[0].equals(devices[0]));
  assert.equal(original?.[1], 1000, 'existing oldest denial survives merge/restart');
  ok(await call('backup_registry_abort', map([[0, nil], [1, decode(durable.get(0)).get(2)]])));
  const active = ok(await call('backup_registry_begin', map([[0, nil]])));
  const activeSession = decode(active.get(0)).get(2);
  const liveRevocation = sha(Buffer.from('registry-backup/live-revoke')).subarray(0, 16);
  ok(await call('revoke_device_credentials', map([[0, liveRevocation]])));
  fail(await call('backup_registry_page', map([[0, nil], [1, activeSession], [2, 1], [3, active.get(1)]])), 'registry_backup_state');
  ok(await call('backup_registry_abort', map([[0, nil], [1, activeSession]])));
  console.log('PASS: nil credential-registry bounded snapshot/restart/retry, denial-union merge and finished-cut invalidation (not collection freshness)');
}
