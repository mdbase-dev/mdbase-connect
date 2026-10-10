// Actual local nil actor / SQLite. No completed destinations or floor authority.
import assert from 'node:assert/strict';
import { sign, createPrivateKey, createPublicKey } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export async function collectionClosingCases({base,token,transport,encode,decode,map,sha,h,restart}) {
  const nil=Buffer.alloc(16), actor='00000000-0000-0000-0000-000000000000';
  const id=label => sha(Buffer.from(`nil-closing/${label}`)).subarray(0,16);
  const epoch=(1n<<64n)-1n;
  const method='registry_begin_collection_closing', path='/v1/registry-collection-closing';
  const params=(c,d=id('deletion'),e=epoch,v=1) => map([[0,nil],[1,v],[2,c],[3,d],[4,e]]);
  const floorParams=(c,d=id('deletion'),e=epoch) => map([[0,nil],[1,c],[2,d],[3,e]]);
  const pathFor=m => m===method ? path : '/v1/rpc';
  const key=label => createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),sha(Buffer.from(label))]),type:'pkcs8',format:'der'});
  const device=key('nil-closing/device'),issuer=key('conformance/issuer');
  const pk=k => createPublicKey(k).export({type:'spki',format:'der'}).subarray(-32);
  const claims=encode(map([[0,0],[1,id('device')],[2,pk(device)],[3,Date.now()+900000],[4,'mdbase-log'],[5,nil]]));
  const deviceToken=`${claims.toString('hex')}.${sign(null,h('mdbase/v1/ls-token',claims),issuer).toString('hex')}`;
  async function signed(m,p,deviceCaller=false,pth=pathFor(m)) {
    const body=encode(map([[0,0],[1,1],[2,m],[3,p]]));
    const nr=await fetch(`${base}/v1/nonce`);assert.equal(nr.status,200);
    const nonce=Buffer.from(await nr.text(),'hex'), bearer=deviceCaller ? deviceToken : token;
    return {body,headers:{authorization:`Bearer ${bearer}`,'x-mdbase-nonce':nonce.toString('hex'),
      'x-mdbase-sig':sign(null,h('mdbase/v1/ls-http',Buffer.concat([Buffer.from(`${m}\0${pth}\0`),p.get(0),sha(Buffer.from(bearer)),sha(body),nonce])),deviceCaller ? device : transport).toString('hex')}};
  }
  async function call(m,p,deviceCaller=false,request) {
    const r=await fetch(`${base}${pathFor(m)}`,{method:'POST',...(request??await signed(m,p,deviceCaller)),signal:AbortSignal.timeout(10000)});
    assert.equal(r.status,200);return decode(Buffer.from(await r.arrayBuffer()));
  }
  const ok=f => {assert.ok(f.has(2),`RPC failure ${f.get(3)?.get(0)}/${f.get(3)?.get(1)}`);return f.get(2)};
  const fail=(f,reason,code='unavailable') => {assert.equal(f.get(3)?.get(0),code);if(reason!==undefined)assert.equal(f.get(3)?.get(1),reason);return f.get(3)};
  async function harness(name,data={}) {
    const r=await fetch(`${base}/__test/${name}`,{method:'POST',body:JSON.stringify({actor,...data}),signal:AbortSignal.timeout(15000)});
    assert.equal(r.status,200,name);return name.endsWith('state') ? r.json() : r.text();
  }
  const inspect=c => harness('registry-closing-state',{target:c.toString('hex')});
  async function fault(name,m,p,extra={}) {
    const actualPath=extra.transportPath??pathFor(m);
    const request=await signed(m,p,false,actualPath);
    const r=await fetch(`${base}/__test/${name}`,{method:'POST',body:JSON.stringify({actor,url:`https://do${actualPath}?c=${actor}`,
      headers:request.headers,body:request.body.toString('base64'),...extra}),signal:AbortSignal.timeout(15000)});
    assert.equal(r.status,200);const observed=await r.json();assert.equal(observed.status,200);
    return {...observed,frame:decode(Buffer.from(observed.response))};
  }
  const c=id('closing-wins'),before=await inspect(c);
  fail(await call(method,params(c),true),'principal','forbidden');
  for(const p of [params(nil),params(c,nil),params(c,id('deletion'),0),params(c,id('deletion'),true),params(c,id('deletion'),epoch,2),map([...params(c),[5,1]]),map([[0,nil],[1,1],[2,c],[3,id('deletion')]]),map([[0,c],[1,1],[2,c],[3,id('deletion')],[4,epoch]])]) {
    fail(await call(method,p),'collection_closing_request','invalid');
  }
  const bad=await signed(method,params(c));bad.headers['x-mdbase-sig']='00'.repeat(64);
  fail(await call(method,params(c),false,bad),'possession','unauthenticated');
  const wrongPath=await signed(method,params(c),false,'/v1/rpc');
  fail(await call(method,params(c),false,wrongPath),'possession','unauthenticated');
  for(const [m,p,pth] of [[method,params(c),'/v1/rpc'],['registry_collection_deletion',map([[0,nil],[1,c]]),path],['collection_destination_close',map([[0,c],[1,1],[2,id('deletion')],[3,epoch]]),path]]) {
    assert.equal((await fetch(`${base}${pth}`,{method:'POST',...await signed(m,p,false,pth)})).status,400);
  }
  for(const [m,p,pth] of [[method,params(c),'/v1/rpc'],['registry_collection_deletion',map([[0,nil],[1,c]]),path]]) {
    fail((await fault('floor-actor',m,p,{transportPath:pth})).frame,undefined,'invalid');
  }
  const oversize=await signed(method,params(c));
  assert.equal((await fetch(`${base}${path}`,{method:'POST',headers:oversize.headers,body:Buffer.alloc(1025)})).status,413);
  assert.deepEqual(await inspect(c),before);

  async function paused(m,p) {
    const request=await signed(m,p);
    const pending=fetch(`${base}/__test/registry-pre-turn`,{method:'POST',body:JSON.stringify({actor,url:`https://do${pathFor(m)}?c=${actor}`,
      headers:request.headers,body:request.body.toString('base64')}),signal:AbortSignal.timeout(15000)}).then(async r => {
      assert.equal(r.status,200);const o=await r.json();assert.equal(o.status,200);return decode(Buffer.from(o.response));
    });
    pending.catch(()=>{});
    let reached=false;
    for(let i=0;i<200;i++) {if((await harness('registry-pause-state')).paused){reached=true;break}await delay(10)}
    assert.ok(reached,'real native request held before synchronous setter turn');
    return {pending};
  }
  // Closing wins before the first-floor request can enter its SQL turn. No
  // invented pause inside native transactionSync or completed-destination ACK.
  const {pending:floorPending}=await paused('registry_record_collection_deletion',floorParams(c));
  let closing;
  try {
    const overlaps=await Promise.all([call(method,params(c)),call(method,params(c))]);
    closing=ok(overlaps[0]);assert.deepEqual(ok(overlaps[1]),closing);
    assert.equal(closing.size,6);assert.equal(closing.get(0),1);assert.equal(closing.get(5),'registry_closing');
    assert.deepEqual([closing.get(1),closing.get(2),closing.get(3)],[c,id('deletion'),epoch]);
    assert.ok(Number.isSafeInteger(closing.get(4))&&closing.get(4)>0);
    assert.equal((await harness('registry-pause-state')).paused,true);
  } finally {await harness('resume-registry')}
  fail(await floorPending,'collection_closing_pending');
  const first=await inspect(c);
  assert.deepEqual(first.floor,[]);assert.deepEqual(first.revision,before.revision);
  assert.equal(first.closing.length,1);assert.equal(first.closing[0][4],'ffffffffffffffff');
  assert.deepEqual(ok(await call(method,params(c))),closing);
  for(const p of [params(c,id('other-deletion')),params(c,id('deletion'),1)]) {
    assert.deepEqual(fail(await call(method,p),'collection_closing_conflict','forbidden').get(4),closing);
  }
  fail(await call('registry_record_collection_deletion',floorParams(c)),'collection_closing_pending');
  assert.deepEqual(await inspect(c),first);
  await restart();
  assert.deepEqual(await inspect(c),first);assert.deepEqual(ok(await call(method,params(c))),closing);
  fail(await call('import',map([[0,c],[1,[]]])),'collection_deletion_floor_unavailable');
  assert.equal(ok(await call('registry_collection_deletion',map([[0,nil],[1,c]]))).get(2),null,
    'separately scoped historical floor status is not positive absence authority');

  // The other scheduling order: the floor's synchronous turn wins first.
  // A paused Closing request then refuses instead of retrospectively qualifying
  // that floor or starting/restarting a deletion clock.
  const old=id('floor-wins'),oldBefore=await inspect(old);
  const {pending:closePending}=await paused(method,params(old));let originalFloor;
  try {originalFloor=ok(await call('registry_record_collection_deletion',floorParams(old)))}
  finally {await harness('resume-registry')}
  fail(await closePending,'collection_closing_reconciliation_required');
  const oldAfter=await inspect(old);assert.deepEqual(oldAfter.closing,[]);assert.equal(oldAfter.floor.length,1);
  assert.notDeepEqual(oldAfter.revision,oldBefore.revision);
  assert.equal(BigInt(`0x${oldAfter.revision[0]}`),BigInt(`0x${oldBefore.revision[0]}`)+1n,'only the deliberate other-target floor advances the global revision');
  assert.deepEqual(ok(await call('registry_record_collection_deletion',floorParams(old))),originalFloor);
  fail(await call(method,params(old)),'collection_closing_reconciliation_required');
  assert.deepEqual(await inspect(old),oldAfter,'historical exact retry/begin refusal never mutate original floor/revision');
  await harness('registry-seed-legacy-closing',{target:old.toString('hex')});
  const legacyWithUnknown=await inspect(old);
  assert.deepEqual(ok(await call('registry_record_collection_deletion',floorParams(old))),originalFloor);
  fail(await call(method,params(old)),'collection_closing_reconciliation_required');
  fail(await call('registry_record_collection_deletion',floorParams(old,id('other-deletion'))),'collection_deletion_conflict','forbidden');
  assert.deepEqual(await inspect(old),legacyWithUnknown,'old-floor retry remains historical reconciliation even with malformed Closing present');

  const clockCases=[['nan',false],['positive-infinity',false],['negative-infinity',false],['negative',false],['zero',false],['negative-zero',false],['fractional',false],['positive-submillisecond',false],
    ['minimum',true,1],['ordinary',true,1792000000123],['max-minus-one',true,Number.MAX_SAFE_INTEGER-30001],['max',true,Number.MAX_SAFE_INTEGER-30000],
    ['max-plus-one',false],['safe-integer-max',false],['unsafe-integer',false],['i64-max-as-float',false],['boolean',false],['string',false]];
  for(const [label,accepted,start] of clockCases) {
    const target=id(`clock-${label}`),p=params(target),prior=await inspect(target);
    const result=await fault('registry-clock',method,p,{clock:label});assert.equal(result.clockCalls,1,'raw clock sampled inside first native Closing transaction');
    if(!accepted) {fail(result.frame);assert.deepEqual(await inspect(target),prior)}
    else {
      const reply=ok(result.frame);assert.equal(reply.get(4),start);assert.equal(reply.get(5),'registry_closing');
      const retained=await inspect(target),bytes=Buffer.alloc(8);bytes.writeBigInt64BE(BigInt(start));
      assert.equal(retained.closing[0][6],bytes.toString('hex'));assert.deepEqual(retained.revision,prior.revision);
      const retry=await fault('registry-clock',method,p,{clock:'nan'});
      assert.equal(retry.clockCalls,0,'exact retry must not sample a new native clock');assert.deepEqual(ok(retry.frame),reply);
      fail(await call('registry_record_collection_deletion',floorParams(target)),'collection_closing_pending');
      assert.deepEqual(await inspect(target),retained,'old/future/elapsed clock never permits a floor');
    }
  }
  const failed=id('failed-write'),failedBefore=await inspect(failed);
  fail((await fault('registry-clock',method,params(failed),{clock:'ordinary',failWrite:true})).frame);
  assert.deepEqual(await inspect(failed),failedBefore,'failed persistence commits neither start nor floor/revision');
  const lost=await signed(method,params(failed)),lostReply=await fetch(`${base}${path}`,{method:'POST',...lost});
  assert.equal(lostReply.status,200);await lostReply.arrayBuffer(); // discard application result
  const withoutAck=await inspect(failed);await restart();assert.deepEqual(await inspect(failed),withoutAck);
  fail(await call(method,params(failed),false,lost),'replay','unauthenticated');
  assert.equal(ok(await call(method,params(failed))).get(4),Number(BigInt(`0x${withoutAck.closing[0][6]}`)));
  for(const [m,p] of [[method,params(c)],['registry_record_collection_deletion',floorParams(id('read-fault'))]]) {
    fail((await fault('registry-read-fault',m,p)).frame,'collection_closing_unavailable');
  }
  assert.deepEqual(await inspect(c),{...first,revision:oldAfter.revision},
    'original Closing/floor unchanged; global revision accounts exactly for the deliberate other-target floor');
  for(const field of ['version','deletion','epoch','start']) {
    const target=id(`corrupt-${field}`);ok(await call(method,params(target)));
    await harness('registry-corrupt-closing',{target:target.toString('hex'),field});
    const corrupt=await inspect(target);
    fail(await call(method,params(target)),'collection_closing_unavailable');
    fail(await call('registry_record_collection_deletion',floorParams(target)),'collection_closing_pending');
    assert.deepEqual(await inspect(target),corrupt,'large malformed presence projects bounded fields, never repaired or treated as absence');
  }
  await restart();
  fail(await call(method,params(id('corrupt-version'))),'collection_closing_unavailable');
  console.log('PASS: actual nil Closing/floor pre-turn races in both orders, immutable historical floor retry, no new floor/revision, strict CP/transport/u64, all18 raw native-clock cases, original-start/no-resample, read/write/lost-reply/restart and bounded malformed projections; no receipt/elapsed completion');
}
