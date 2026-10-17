// [Sec] Piggybacked next nonce (x-mdbase-next-nonce) through the real outer
// Worker, actor and SQLite. The piggybacked nonce is minted exactly like
// GET /v1/nonce: stateless, unbound, 60 s, single use per collection actor.
// Binding to a device/session/collection comes from the signature, which these
// cases try to transplant. Replay protection must be exactly as strong.
import assert from 'node:assert/strict';
import { createHmac, createPrivateKey, createPublicKey, sign } from 'node:crypto';

export async function noncePiggybackCases({ base, token, transport, issuer, encode, decode, map, sha, h, fetch = globalThis.fetch }) {
  const c = Buffer.alloc(16, 0x6e), other = Buffer.alloc(16, 0x6f);
  const frame = (id, coll = c) => encode(map([[0, 0], [1, id], [2, 'head'], [3, map([[0, coll]])]]));
  const sig = (key, tok, body, nonce, coll = c) => sign(null, h('mdbase/v1/ls-http', Buffer.concat([
    Buffer.from('head\0/v1/rpc\0'), coll, sha(Buffer.from(tok)), sha(body), nonce])), key).toString('hex');
  async function rpc(tok, nonce, s, body) {
    const r = await fetch(`${base}/v1/rpc`, { method: 'POST', body, headers: {
      authorization: `Bearer ${tok}`, 'x-mdbase-nonce': nonce.toString('hex'), 'x-mdbase-sig': s } });
    assert.equal(r.status, 200);
    const next = r.headers.get('x-mdbase-next-nonce');
    assert.match(next, /^[0-9a-f]{64}$/, 'every signed-RPC response carries a next nonce');
    const err = decode(Buffer.from(await r.arrayBuffer())).get(3);
    return { next: Buffer.from(next, 'hex'), code: err.get(0), reason: err.get(1) };
  }
  // `not_found` (no genesis) means authentication passed and dispatch ran.
  const call = async (tok, key, nonce, id, coll = c) => { const b = frame(id, coll); return rpc(tok, nonce, sig(key, tok, b, nonce, coll), b); };
  const seed = Buffer.from(await (await fetch(`${base}/v1/nonce`)).text(), 'hex');
  const first = await call(token, transport, seed, 1);
  assert.equal(first.code, 'not_found');

  // 1. The piggybacked nonce authenticates the next call, once.
  const piggy = first.next;
  assert.notDeepEqual(piggy, seed);
  const used = await call(token, transport, piggy, 2);
  assert.equal(used.code, 'not_found', 'piggybacked nonce is accepted like a GET /v1/nonce one');
  assert.notDeepEqual(used.next, piggy, 'each response mints a fresh nonce');
  // 2. Replay: the identical captured request, and a fresh signature over it.
  const replayBody = frame(2);
  let r = await rpc(token, piggy, sig(transport, token, replayBody, piggy), replayBody);
  assert.deepEqual([r.code, r.reason], ['unauthenticated', 'replay']);
  r = await call(token, transport, piggy, 3);
  assert.deepEqual([r.code, r.reason], ['unauthenticated', 'replay'], 'a nonce is single use even for its holder');

  // 3. Another device/session. Device B has its own valid token and key.
  const keyB = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), sha(Buffer.from('nonce-piggyback/device-b'))]), type: 'pkcs8', format: 'der' });
  const pkB = createPublicKey(keyB).export({ type: 'spki', format: 'der' }).subarray(-32);
  const claimsB = encode(map([[0, 1], [2, pkB], [3, Date.now() + 900000], [4, 'mdbase-log']]));
  const tokenB = `${claimsB.toString('hex')}.${sign(null, h('mdbase/v1/ls-token', claimsB), issuer).toString('hex')}`;
  const forA = used.next, bodyA = frame(4), sigA = sig(transport, token, bodyA, forA);
  // A's signed request presented under B's token: possession fails, nonce survives.
  r = await rpc(tokenB, forA, sigA, bodyA);
  assert.deepEqual([r.code, r.reason], ['unauthenticated', 'possession']);
  // A's request transplanted to another collection: the signature binds it.
  r = await rpc(token, forA, sigA, frame(4, other));
  assert.deepEqual([r.code, r.reason], ['unauthenticated', 'possession']);
  // B signing with B's key over A's token: possession fails.
  r = await rpc(token, forA, sig(keyB, token, bodyA, forA), bodyA);
  assert.deepEqual([r.code, r.reason], ['unauthenticated', 'possession']);
  // A's own request still succeeds: failed transplants did not consume it.
  r = await rpc(token, forA, sigA, bodyA);
  assert.equal(r.code, 'not_found');
  // Once A used it, B cannot reuse it with B's own valid signature either.
  r = await call(tokenB, keyB, forA, 5);
  assert.deepEqual([r.code, r.reason], ['unauthenticated', 'replay']);
  // Nonces are bearer-less challenges, exactly as GET /v1/nonce: an unused one
  // seen by B lets B make B's OWN signed call, never act as A.
  r = await call(tokenB, keyB, r.next, 6);
  assert.equal(r.code, 'not_found');

  // 4. Expired, future-dated and foreign-secret nonces (test-only secret).
  const secret = sha(Buffer.from('conformance/url-secret'));
  const mint = (ms, key = secret) => { const n = Buffer.alloc(32); n.writeBigUInt64BE(BigInt(ms)); n.fill(7, 8, 16);
    createHmac('sha256', key).update(n.subarray(0, 16)).digest().copy(n, 16, 0, 16); return n; };
  r = await call(token, transport, mint(Date.now() - 1000), 7);
  assert.equal(r.code, 'not_found', 'forger agrees with the server');
  for (const [n, why] of [[mint(Date.now() - 61000), 'expired'], [mint(Date.now() + 30000), 'future'], [mint(Date.now(), sha(Buffer.from('other/url-secret'))), 'foreign secret']]) {
    r = await call(token, transport, n, 8);
    assert.deepEqual([r.code, r.reason], ['unauthenticated', 'nonce'], why);
  }

  // 5. Concurrent use race: one nonce, many validly signed distinct requests.
  const race = r.next;
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => call(token, transport, race, 100 + i)));
  assert.equal(results.filter(x => x.code === 'not_found').length, 1, 'exactly one concurrent use wins');
  assert.ok(results.filter(x => x.code !== 'not_found').every(x => x.code === 'unauthenticated' && x.reason === 'replay'));
  console.log('PASS nonce piggyback: next nonce on RPC responses; replay, cross-device/collection transplant, expiry and concurrent race all refused');
}
