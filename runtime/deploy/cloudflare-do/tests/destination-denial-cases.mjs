// Actual local workerd/SQLite only. Local Closing is NOT a full fence receipt.
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export async function destinationDenialCases({ base, token, transport, encode, decode, map, sha, h, restart }) {
  const id = label => sha(Buffer.from(`destination-denial/${label}`)).subarray(0, 16);
  const c = id('collection'), deletion = id('deletion'), nil = Buffer.alloc(16);
  const epoch = (1n << 64n) - 1n;
  const actorName = b => {
    const s = b.toString('hex');
    return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
  };
  const actor = actorName(c);
  const privateKey = label => createPrivateKey({ key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'), sha(Buffer.from(label)),
  ]), type: 'pkcs8', format: 'der' });
  const pk = k => createPublicKey(k).export({ type: 'spki', format: 'der' }).subarray(-32);
  const root = privateKey('conformance/root'), issuer = privateKey('conformance/issuer');
  const device = privateKey('destination-denial/device');
  const claims = encode(map([[0,0],[1,id('device')],[2,pk(device)],[3,Date.now()+900000],[4,'mdbase-log'],[5,c]]));
  const deviceToken = `${claims.toString('hex')}.${sign(null,h('mdbase/v1/ls-token',claims),issuer).toString('hex')}`;
  const pathFor = method => method === 'collection_destination_close' ? '/v1/collection-destination-close' : '/v1/rpc';
  async function signed(method, params, asDevice = false, path = pathFor(method)) {
    const body = encode(map([[0,0],[1,1],[2,method],[3,params]]));
    const nr = await fetch(`${base}/v1/nonce`); assert.equal(nr.status, 200);
    const nonce = Buffer.from(await nr.text(), 'hex');
    const bearer = asDevice ? deviceToken : token;
    const digest = h('mdbase/v1/ls-http',Buffer.concat([
      Buffer.from(`${method}\0${path}\0`), params.get(0), sha(Buffer.from(bearer)), sha(body), nonce,
    ]));
    return { body, headers: { authorization: `Bearer ${bearer}`, 'x-mdbase-nonce':nonce.toString('hex'),
      'x-mdbase-sig':sign(null,digest,asDevice ? device : transport).toString('hex') } };
  }
  async function call(method, params, asDevice = false, override) {
    const request = override ?? await signed(method, params, asDevice);
    const r = await fetch(`${base}${pathFor(method)}`, { method:'POST', ...request, signal: AbortSignal.timeout(10000) });
    assert.equal(r.status,200,method);
    return decode(Buffer.from(await r.arrayBuffer()));
  }
  const ok = frame => { assert.ok(frame.has(2), `RPC failure ${frame.get(3)?.get(0)}/${frame.get(3)?.get(1)}`); return frame.get(2); };
  const fail = (frame, code, reason) => {
    assert.equal(frame.get(3)?.get(0),code); assert.equal(frame.get(3)?.get(1),reason);
    return frame.get(3);
  };
  const close = (d = deletion, e = epoch, target = c, version = 1) => map([[0,target],[1,version],[2,d],[3,e]]);
  async function harness(path, target = actor) {
    const r = await fetch(`${base}/__test/${path}`, { method:'POST', body:JSON.stringify({actor:target}), signal:AbortSignal.timeout(10000) });
    assert.equal(r.status,200,path);
    return path.endsWith('state') ? r.json() : r.text();
  }
  async function genesis(target) {
    const rootId = sha(pk(root)).subarray(0,16);
    const cert = map([[0,pk(transport)],[1,0],[2,2**50],[3,rootId]]);
    cert.set(4,sign(null,h('mdbase/v1/cp-cert',encode(cert)),root));
    const payload = encode(map([[0,1],[1,cert],[2,1],[3,[map([[0,1],[1,id('owner')],[2,rootId],[3,0]])]]]));
    const item = map([[0,1],[1,2],[2,target],[3,1],[4,Buffer.alloc(32)],[6,sha(pk(transport)).subarray(0,16)],[11,payload]]);
    item.set(12,sign(null,h('mdbase/v1/item-sig',encode(item)),transport));
    return encode(item);
  }
  ok(await call('create_log',map([[0,c],[1,await genesis(c)]])));
  const quota = map([[0,c],[1,[999999,100,100000,100]]]);
  ok(await call('set_quota',quota));
  const initial = await harness('destination-state');
  assert.deepEqual(initial.denial,[]);
  fail(await call('collection_destination_close',close(),true),'forbidden','principal');
  const badPossession = await signed('collection_destination_close',close());
  badPossession.headers['x-mdbase-sig'] = '00'.repeat(64);
  fail(await call('collection_destination_close',close(),false,badPossession),'unauthenticated','possession');
  for (const params of [close(nil),close(deletion,0),close(deletion,true),close(deletion,epoch,c,2),
    map([...close(),[4,1]]),map([[0,c],[1,1],[2,deletion]]),close(deletion,epoch,nil)]) {
    fail(await call('collection_destination_close',params),'invalid','collection_destination_close_request');
  }
  // Both transports reject method/path substitution. A valid small close body
  // cannot turn the denial-only route into ordinary RPC dispatch.
  for (const [method,params,path] of [
    ['collection_destination_close',close(),'/v1/rpc'],
    ['set_quota',quota,'/v1/collection-destination-close'],
  ]) {
    const request = await signed(method,params,false,path);
    assert.equal((await fetch(`${base}${path}`,{method:'POST',...request})).status,400);
  }
  const oversized = await signed('collection_destination_close',close());
  assert.equal((await fetch(`${base}/v1/collection-destination-close`,{method:'POST',headers:oversized.headers,body:Buffer.alloc(1025)})).status,413);
  for (const [actorTarget,expectedForwarding] of [[undefined,0],[actor,0]]) {
    const r = await fetch(`${base}/__test/ingress`,{method:'POST',body:JSON.stringify({
      actor:actorTarget,url:`https://worker/v1/collection-destination-close${actorTarget ? `?c=${actorTarget}` : ''}`,
      headers:oversized.headers,size:1024,errorAt:0,
    })});
    assert.equal(r.status,200); const rejected = await r.json();
    assert.equal(rejected.status,400,'close-only native BYOB reader error refuses before SQL');
    assert.equal(rejected.forwarded,expectedForwarding);
  }
  async function fault(path,method,params,target=actor,extraHeaders={},transportPath=pathFor(method)) {
    const request = await signed(method,params,false,transportPath);
    const r = await fetch(`${base}/__test/${path}`,{method:'POST',body:JSON.stringify({actor:target,
      url:`https://do${transportPath}?c=${target}`,headers:{...request.headers,...extraHeaders},body:request.body.toString('base64')})});
    assert.equal(r.status,200); const observed = await r.json();
    assert.equal(observed.status,200); return decode(Buffer.from(observed.response));
  }
  for (const [method,params,path] of [
    ['collection_destination_close',close(),'/v1/rpc'],['set_quota',quota,'/v1/collection-destination-close'],
  ]) fail(await fault('floor-actor',method,params,actor,{},path),'invalid','collection_destination_close_transport');
  const wrongPathSignature=await signed('collection_destination_close',close(),false,'/v1/rpc');
  fail(await call('collection_destination_close',close(),false,wrongPathSignature),'unauthenticated','possession');
  // A real existing actor refuses a CP-signed payload for a different actor.
  fail(await fault('floor-actor','collection_destination_close',close(deletion,epoch,id('foreign'))),'invalid','collection_destination_close_request');
  assert.deepEqual(await harness('destination-state'),initial,'invalid/unauthorized close leaves all SQL state unchanged');

  // The real Rust producer owns its writer lock and has buffered changed quota.
  // Hold its actual absent nil reply. Close runs as a separate authenticated RPC
  // and must finish without the producer waking or releasing that lock.
  const pendingRequest = await signed('set_quota',map([[0,c],[1,[888888,101,100001,101]]]));
  const pending = fetch(`${base}/__test/floor-actor`, { method:'POST', body:JSON.stringify({
    actor, url:`https://do/v1/rpc?c=${actor}`, headers:pendingRequest.headers,
    body:pendingRequest.body.toString('base64'), fault:'pause',
  }), signal:AbortSignal.timeout(15000) }).then(async r => {
    assert.equal(r.status,200); const observed = await r.json();
    assert.equal(observed.status,200); assert.equal(observed.calls,1);
    return decode(Buffer.from(observed.response));
  });
  // Attach a rejection handler immediately; assertions below still await it.
  pending.catch(() => {});
  let closing;
  try {
    let reached = false;
    for (let i=0;i<200;i++) {
      if ((await harness('floor-pause-state')).paused) { reached = true; break; }
      await delay(10);
    }
    assert.ok(reached,'actual producer paused at nil reply while holding writer lock');
    assert.deepEqual(await harness('destination-state'),initial,'prepared quota has not committed');
    const overlappingPositive = await signed('set_quota',quota);
    assert.equal((await fetch(`${base}/v1/rpc`,{method:'POST',...overlappingPositive})).status,503,
      'paused producer retains original ingress reservation; ordinary admission not weakened');
    const overlappingCloses = await Promise.all([
      call('collection_destination_close',close()),call('collection_destination_close',close()),
    ]);
    closing = ok(overlappingCloses[0]);
    assert.deepEqual(ok(overlappingCloses[1]),closing,'overlapping authenticated close retries preserve first tuple without producer cooperation');
    assert.equal(closing.size,5); assert.equal(closing.get(0),1);
    assert.deepEqual([closing.get(1),closing.get(2),closing.get(3),closing.get(4)],
      [c,deletion,epoch,'log_sql_closing']);
    assert.equal((await harness('floor-pause-state')).paused,true,'close never waits for producer cooperation');
  } finally { await harness('resume-floor'); }
  fail(await pending,'unavailable','collection_destination_closing');
  const denied = await harness('destination-state');
  assert.deepEqual({...denied,denial:[]},initial,'late positive/mixed quota+Notify commits nothing');
  assert.deepEqual(denied.denial, [['01',c.toString('hex'),deletion.toString('hex'),'ffffffffffffffff']]);
  assert.deepEqual(ok(await call('collection_destination_close',close())),closing);
  for (const params of [close(id('other-deletion')),close(deletion,1)]) {
    assert.deepEqual(fail(await call('collection_destination_close',params),'forbidden','collection_destination_close_conflict').get(4),closing);
  }
  for (const [method,params] of [
    ['set_quota',quota],
    ['restore_aux_begin',map([[0,c]])],['restore_aux_page',map([[0,c]])],
  ]) fail(await call(method,params),'unavailable','collection_destination_closing');
  assert.deepEqual(await harness('destination-state'),denied);
  const floor = ok(await call('registry_collection_deletion',map([[0,nil],[1,c]])));
  assert.equal(floor.get(2),null,'local Closing does not insert an independent floor');
  const status = ok(await call('log_terminal_status',map([[0,c]])));
  assert.equal(status.get(2),1,'local Closing is not durable Gone/Deleted');
  await restart();
  assert.deepEqual(await harness('destination-state'),denied,'nondisposable denial survives actual restart');
  assert.deepEqual(ok(await call('collection_destination_close',close())),closing);
  fail(await call('set_quota',quota),'unavailable','collection_destination_closing');
  for (const [method,params] of [
    ['collection_destination_close',close()],['set_quota',quota],['restore_aux_begin',map([[0,c]])],
  ]) fail(await fault('destination-read-fault',method,params),'unavailable','collection_destination_denial_unavailable');
  assert.deepEqual(await harness('destination-state'),denied,'read/schema fault never removes or replaces original denial');

  // Failed persistence produces no successful local Closing. Exact retry after
  // fault removal may establish the first identity, then survive a lost reply.
  const failedTarget=id('write-failed'), failedActor=actorName(failedTarget);
  const failedClose=close(id('write-failed-deletion'),1,failedTarget);
  const writeError=await fault('destination-write-fault','collection_destination_close',failedClose,failedActor);
  assert.equal(writeError.get(3)?.get(0),'unavailable');
  assert.deepEqual((await harness('destination-state',failedActor)).denial,[]);
  const lostRequest=await signed('collection_destination_close',failedClose);
  const lostReply=await fetch(`${base}/v1/collection-destination-close`,{method:'POST',...lostRequest});
  assert.equal(lostReply.status,200); await lostReply.arrayBuffer(); // deliberately no application decode/ACK
  const durableWithoutAck=await harness('destination-state',failedActor);
  assert.equal(durableWithoutAck.denial.length,1);
  await restart();
  assert.deepEqual(await harness('destination-state',failedActor),durableWithoutAck);
  fail(await call('collection_destination_close',failedClose,false,lostRequest),'unauthenticated','replay');
  const reconciled=ok(await call('collection_destination_close',failedClose));
  assert.deepEqual([reconciled.get(1),reconciled.get(2),reconciled.get(3),reconciled.get(4)],
    [failedTarget,failedClose.get(2),1,'log_sql_closing']);

  // An already-present malformed latch must deny, never be treated as absence
  // or silently replaced by the otherwise valid first tuple.
  await harness('corrupt-destination-denial');
  const corrupted = await harness('destination-state');
  fail(await call('set_quota',quota),'unavailable','collection_destination_closing');
  fail(await call('restore_aux_begin',map([[0,c]])),'unavailable','collection_destination_closing');
  fail(await call('collection_destination_close',close()),'unavailable','collection_destination_denial_unavailable');
  assert.deepEqual(await harness('destination-state'),corrupted);
  await restart();
  assert.deepEqual(await harness('destination-state'),corrupted);
  fail(await call('set_quota',quota),'unavailable','collection_destination_closing');

  // Closing before genesis is also permanent. No new empty log or floor.
  const absent = id('absent'), absentActor = actorName(absent);
  ok(await call('collection_destination_close',close(id('absent-deletion'),1,absent)));
  fail(await call('create_log',map([[0,absent],[1,await genesis(absent)]])),'unavailable','collection_destination_closing');
  assert.deepEqual((await harness('destination-state',absentActor)).meta,[]);
  assert.equal(ok(await call('registry_collection_deletion',map([[0,nil],[1,absent]]))).get(2),null);
  // Denial-only terminal cleanup is still available and cannot remove a latch.
  // These are explicit existing fixture floor operations, NOT a latch receipt
  // consumed as a complete floor prerequisite.
  ok(await call('registry_record_collection_deletion',map([[0,nil],[1,c],[2,deletion],[3,epoch]])));
  ok(await call('delete_log',map([[0,c],[1,deletion],[2,epoch]])));
  assert.deepEqual((await harness('destination-state')).denial,corrupted.denial);
  await restart();
  assert.deepEqual((await harness('destination-state')).denial,corrupted.denial);
  console.log('PASS: actual destination SQL Closing without producer lock/ACK, retained admission bounds, strict transport/CP/shape/u64/first identity, late mixed-write and aux refusal, read/write faults, lost reply, corrupt presence, pre-genesis/terminal cleanup and restart; no aggregate fence claim');
}
