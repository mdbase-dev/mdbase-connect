// Actual paused auxiliary/activation producers on separate empty local targets.
// Reuses the original authenticated cut bytes; no invented recovery authority.
import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export async function destinationAuxDenialCases({ base, token, transport, encode, decode, map, sha, h, freshTarget, restart, archive }) {
  // Qualify these races on the small complete inventory. The other three runtime
  // variants retain their original full recovery/resource assertions unchanged.
  if (['LOGSVC_COMPACTED_RESTORE','LOGSVC_REF_INDEX_RESTORE','LOGSVC_LARGE_RESTORE'].some(k => process.env[k] === '1')) return;
  const { c, actor, headerBytes, header, pages, items, objects, snapshots, refs, sealedObjects, finalHash } = archive;
  const digest = (domain, rows) => rows.reduce((root,row) => sha(Buffer.concat([root,encode(row)])),sha(Buffer.from(domain)));
  const itemRoot = digest('mdbase-next-backup/1/items',items.map(r => [r[0],sha(r[2])]));
  const objectRoot = digest('mdbase-next-backup/1/objects',[...objects].sort((a,b) => Buffer.compare(a[1],b[1])).map(r => r.slice(1,5)));
  const snapshotRows = [];
  for (const s of [...snapshots].sort((a,b) => b[0]-a[0])) {
    const edges = refs.filter(r => r[2]===1 && r[3]===s[0]).map(r => r[1]).sort(Buffer.compare);
    snapshotRows.push([...s.slice(0,4),s[4]===1,edges.length],...edges);
  }
  const plan = [1,header.get(9),header.get(3),header.get(4),header.get(5),itemRoot,objectRoot,digest('mdbase-next-backup/1/snapshots',snapshotRows)];
  const completion = map([[0,header.get(5)],[1,header.get(3)],[2,header.get(4)]]);
  const begin = map([[0,c],[1,headerBytes],[2,finalHash],[3,pages.length]]);
  const ok = frame => { assert.ok(frame.has(2),`RPC failure ${frame.get(3)?.get(0)}/${frame.get(3)?.get(1)}`); return frame.get(2); };
  const pathFor = method => method === 'collection_destination_close' ? '/v1/collection-destination-close' : '/v1/rpc';
  async function signed(method,params) {
    const body = encode(map([[0,0],[1,1],[2,method],[3,params]]));
    const nr = await fetch(`${base}/v1/nonce`); assert.equal(nr.status,200);
    const nonce = Buffer.from(await nr.text(),'hex');
    return {body,headers:{authorization:`Bearer ${token}`,'x-mdbase-nonce':nonce.toString('hex'),
      'x-mdbase-sig':sign(null,h('mdbase/v1/ls-http',Buffer.concat([
        Buffer.from(`${method}\0${pathFor(method)}\0`),params.get(0),sha(Buffer.from(token)),sha(body),nonce,
      ])),transport).toString('hex')}};
  }
  async function call(method,params) {
    const r = await fetch(`${base}${pathFor(method)}`,{method:'POST',...await signed(method,params),signal:AbortSignal.timeout(10000)});
    assert.equal(r.status,200); return decode(Buffer.from(await r.arrayBuffer()));
  }
  async function harness(path) {
    const r = await fetch(`${base}/__test/${path}`,{method:'POST',body:JSON.stringify({actor}),signal:AbortSignal.timeout(10000)});
    assert.equal(r.status,200); return path.endsWith('state') ? r.json() : r.text();
  }
  const genesis = items.find(r => r[0]===1);
  async function copyInventory() {
    for (const [r,bytes] of sealedObjects) ok(await call('import_object',map([[0,c],[1,r[1]],[2,r[2]],[3,bytes]])));
    for (let i=1;i<items.length;i+=16) ok(await call('import',map([[0,c],[1,items.slice(i,i+16).map(r => [r[0],r[2]])]])));
    for (const s of snapshots) ok(await call('import_snapshot',map([[0,c],[1,map([[0,s[0]],[1,s[1]],[2,s[2]],[3,s[3]],[4,s[4]===1]])],
      [2,refs.filter(r => r[2]===1 && r[3]===s[0]).map(r => r[1])]])));
  }
  for (const stage of ['begin','page','finish','live']) {
    await freshTarget();
    const imported = ok(await call('import',map([[0,c],[1,[[1,genesis[2]]]],[3,header.get(7)],[4,plan]])));
    assert.equal(imported.get(3),true);
    if (stage !== 'begin') {
      ok(await call('restore_aux_begin',begin));
      await copyInventory();
    }
    if (stage === 'finish' || stage === 'live') {
      for (const page of pages.slice(0,stage === 'live' ? pages.length : -1)) {
        ok(await call('restore_aux_page',map([[0,c],[1,page]])));
      }
    }
    const before = await harness('destination-state');
    const method = stage === 'begin' ? 'restore_aux_begin' : stage === 'live' ? 'import' : 'restore_aux_page';
    const params = stage === 'begin' ? begin : stage === 'live' ? map([[0,c],[1,[]],[2,completion]]) :
      map([[0,c],[1,stage === 'finish' ? pages.at(-1) : pages[0]]]);
    const request = await signed(method,params);
    const pending = fetch(`${base}/__test/floor-actor`,{method:'POST',body:JSON.stringify({actor,
      url:`https://do/v1/rpc?c=${actor}`,headers:request.headers,body:request.body.toString('base64'),fault:'pause',
      // Import's first floor read precedes begin(Write); its second is after
      // buffering final Live under the writer lock (service.rs import).
      pauseAt:stage === 'live' ? 2 : 1}),
      signal:AbortSignal.timeout(15000)}).then(async r => {
      assert.equal(r.status,200); const observed=await r.json(); assert.equal(observed.status,200);
      assert.equal(observed.calls,stage === 'live' ? 2 : 1); return decode(Buffer.from(observed.response));
    });
    pending.catch(() => {});
    try {
      let reached=false;
      for (let i=0;i<200;i++) {
        if ((await harness('floor-pause-state')).paused) { reached=true; break; }
        await delay(10);
      }
      assert.ok(reached,`${stage}: actual producer holds lock across real nil await`);
      assert.deepEqual(await harness('destination-state'),before);
      const deletion=sha(Buffer.concat([c,Buffer.from(`denial-${stage}`)])).subarray(0,16);
      const closing=ok(await call('collection_destination_close',map([[0,c],[1,1],[2,deletion],[3,(1n<<64n)-1n]])));
      assert.equal(closing.get(4),'log_sql_closing');
      assert.equal((await harness('floor-pause-state')).paused,true);
    } finally { await harness('resume-floor'); }
    const refused=await pending;
    assert.equal(refused.get(3)?.get(0),'unavailable');
    assert.equal(refused.get(3)?.get(1),'collection_destination_closing');
    const after=await harness('destination-state');
    assert.deepEqual({...after,denial:[]},before,`${stage}: no aux time/token/progress/accounting or final-Live mutation`);
    assert.equal(after.denial.length,1);
    await restart();
    assert.deepEqual(await harness('destination-state'),after);
    const retry=await call(method,params);
    assert.equal(retry.get(3)?.get(0),'unavailable');
    assert.equal(retry.get(3)?.get(1),'collection_destination_closing');
    assert.deepEqual(await harness('destination-state'),after,`${stage}: old backup/cut never replaces target denial`);
  }
  console.log('PASS: four actual writer-held nil-await races for valid aux begin/page/token finish/final Live, unchanged complete target SQL state, target denial preserved across restart/retry');
}
