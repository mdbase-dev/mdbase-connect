// Isolated fresh local workerd/SQLite/R2 recovery; no account/LAB/provider I/O.
import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
export async function restoreAuxCases({ base, token, transport, encode, decode, map, sha, h, restart, freshTarget, archive, appendRecovered }) {
  const { c, actor, headerBytes, header, pages, items, objects, snapshots, refs, sealedObjects, tokens, finalHash } = archive;
  async function call(method, params) {
    const body = encode(map([[0,0],[1,1],[2,method],[3,params]]));
    const nonce = Buffer.from(await (await fetch(`${base}/v1/nonce`)).text(),'hex');
    const collection = params.get(0);
    const sig = sign(null,h('mdbase/v1/ls-http',Buffer.concat([Buffer.from(`${method}\0/v1/rpc\0`),collection,sha(Buffer.from(token)),sha(body),nonce])),transport);
    const response = await fetch(`${base}/v1/rpc`,{method:'POST',body,headers:{authorization:`Bearer ${token}`,'x-mdbase-nonce':nonce.toString('hex'),'x-mdbase-sig':sig.toString('hex')}});
    assert.equal(response.status,200); return decode(Buffer.from(await response.arrayBuffer()));
  }
  const ok = f => { assert.ok(f.has(2),JSON.stringify([...f.get(3) ?? []])); return f.get(2); };
  const fail = (f,reason) => assert.equal(f.get(3)?.get(1),reason);
  const digest = (domain,rows) => rows.reduce((root,row)=>sha(Buffer.concat([root,encode(row)])),sha(Buffer.from(domain)));
  const itemRoot = digest('mdbase-next-backup/1/items',items.map(r=>[r[0],sha(r[2])]));
  const objectRoot = digest('mdbase-next-backup/1/objects',[...objects].sort((a,b)=>Buffer.compare(a[1],b[1])).map(r=>r.slice(1,5)));
  const snapshotRows = [];
  for (const s of [...snapshots].sort((a,b)=>b[0]-a[0])) {
    const edges = refs.filter(r=>r[2]===1 && r[3]===s[0]).map(r=>r[1]).sort(Buffer.compare);
    snapshotRows.push([...s.slice(0,4),s[4]===1,edges.length],...edges);
  }
  const snapshotRoot = digest('mdbase-next-backup/1/snapshots',snapshotRows);
  const plan = [1,header.get(9),header.get(3),header.get(4),header.get(5),itemRoot,objectRoot,snapshotRoot];
  const completion = map([[0,header.get(5)],[1,header.get(3)],[2,header.get(4)]]);
  const begin = (expectedHash=finalHash, expectedPages=pages.length) => call('restore_aux_begin',map([[0,c],[1,headerBytes],[2,expectedHash],[3,expectedPages]]));
  const apply = b => call('restore_aux_page',map([[0,c],[1,b]]));
  const inspect = async () => (await fetch(`${base}/__test/aux-state`,{method:'POST',body:JSON.stringify({actor})})).json();
  const genesis = items.find(r=>r[0]===1);
  async function seedGenesis() {
    await freshTarget();
    const first = ok(await call('import',map([[0,c],[1,[[1,genesis[2]]]],[3,header.get(7)],[4,plan]])));
    assert.equal(first.get(3),true,'require strict ACK before auxiliary begin/copy');
  }
  let lostLargeReply = false;
  async function copyInventory() {
    const withheld=process.env.LOGSVC_REF_INDEX_RESTORE==='1' ? sealedObjects.find(([r])=>r[2]===19) : undefined;
    for (const pair of sealedObjects) {
      if (pair===withheld) continue;
      const [r,bytes]=pair;
      const params=map([[0,c],[1,r[1]],[2,r[2]],[3,bytes]]);
      const reply=await call('import_object',params);
      if (bytes.length > 4*1024*1024 && !lostLargeReply) {
        // Deliberately discard the successful application ACK; only durable
        // target state is available after the process restarts.
        const committed=await inspect();
        assert.ok(committed.objects.some(row=>row[0]===r[1].toString('hex')));
        await restart();
        ok(await call('import_object',params));
        assert.deepEqual(await inspect(),committed,'retry must preserve first commit and not double-account');
        lostLargeReply=true;
        console.log(`PASS: lost near-9MiB object commit reply/restart/exact retry (${bytes.length} sealed bytes)`);
      } else ok(reply);

    }
    for (let i=1;i<items.length;i+=16) ok(await call('import',map([[0,c],[1,items.slice(i,i+16).map(r=>[r[0],r[2]])]])));
    if (withheld) {
      const s=snapshots[0], beforeSnapshot=await inspect();
      const edges=refs.filter(r=>r[2]===1 && r[3]===s[0]).map(r=>r[1]);
      const denied=await call('import_snapshot',map([[0,c],[1,map([[0,s[0]],[1,s[1]],[2,s[2]],[3,s[3]],[4,s[4]===1]])],[2,edges]]));
      assert.equal(denied.get(3)?.get(0),'refs_missing','partial ref-index copy must not register snapshot');
      assert.deepEqual(await inspect(),beforeSnapshot,'missing-ref snapshot refusal is atomic');
      const [r,bytes]=withheld;
      ok(await call('import_object',map([[0,c],[1,r[1]],[2,r[2]],[3,bytes]])));
    }
    for (const s of snapshots) {
      const edges = refs.filter(r=>r[2]===1 && r[3]===s[0]).map(r=>r[1]);
      ok(await call('import_snapshot',map([[0,c],[1,map([[0,s[0]],[1,s[1]],[2,s[2]],[3,s[3]],[4,s[4]===1]])],[2,edges]])));
    }
  }
  for (const [expectedHash,expectedPages] of [[Buffer.alloc(32),pages.length],[finalHash,pages.length+1]]) {
    await seedGenesis();
    ok(await begin(expectedHash,expectedPages));
    await copyInventory();
    for (const bytes of pages.slice(0,-1)) ok(await apply(bytes));
    const beforeFinal = await inspect();
    fail(await apply(pages.at(-1)),'restore_aux');
    assert.deepEqual(await inspect(),beforeFinal,'bad authenticated completion cannot replace tokens or advance progress');
    fail(await call('import',map([[0,c],[1,[]],[2,completion]])),'restore_aux_incomplete');
    await restart();
    fail(await apply(pages.at(-1)),'restore_aux');
    assert.deepEqual(await inspect(),beforeFinal,'completion refusal survives restart');
    fail(await begin(),'restore_aux');
  }
  console.log('PASS: incorrect auxiliary completion hash/page refuses atomically across restart and cannot reset binding');
  const largeObject=sealedObjects.find(([,bytes])=>bytes.length>4*1024*1024);
  if (largeObject) {
    await seedGenesis(); ok(await begin());
    const [row,bytes]=largeObject, params=map([[0,c],[1,row[1]],[2,row[2]],[3,bytes]]);
    ok(await call('import_object',params));
    // Registry-first typed Gone interleaves after publication, before activation.
    // This is not an effect-time lease or the independent nil-floor await race.
    const deletion=sha(Buffer.concat([c,Buffer.from('partial-near9-deletion')])).subarray(0,16);
    const epoch=(1n<<64n)-1n;
    const floor=ok(await call('registry_record_collection_deletion',map([[0,Buffer.alloc(16)],[1,c],[2,deletion],[3,epoch]])));
    assert.deepEqual([floor.get(1),floor.get(2),floor.get(3)],[c,deletion,epoch]);
    const deleted=ok(await call('delete_log',map([[0,c],[1,deletion],[2,epoch]])));
    assert.deepEqual(deleted.get(1),[1,c,deletion,epoch]);
    await restart();
    const gone=await inspect();
    const floorGone=f=>{ assert.equal(f.get(3)?.get(0),'gone'); fail(f,'collection_deletion_floor'); };
    floorGone(await call('import_object',params));
    assert.equal((await begin()).get(3)?.get(0),'gone');
    assert.equal((await apply(pages[0])).get(3)?.get(0),'gone');
    floorGone(await call('import',map([[0,c],[1,[]],[2,completion]])));
    assert.deepEqual(await inspect(),gone,'Gone must permanently prevent publication/progress/activation');
    console.log('PASS: Gone during partial near-9MiB restore survives restart and denies object retry/auxiliary continuation/activation');
  }
  await seedGenesis();
  const begun = ok(await begin());
  await restart();
  assert.deepEqual(ok(await begin()),begun,'lost begin ACK survives restart');
  fail(await call('restore_aux_begin',map([[0,c],[1,headerBytes],[2,Buffer.alloc(32)],[3,pages.length]])),'restore_aux');
  await copyInventory();
  fail(await call('import',map([[0,c],[1,[]],[2,completion]])),'restore_aux_incomplete');
  const before = await inspect();
  // The first row is valid, the second mismatches exact already-verified bytes;
  // no first-row time mutation or progress may escape the failed whole batch.
  const malformed = decode(pages[0]);
  const rows = malformed.get(7).map(r=>[...r]);
  rows[0][3]=1;rows[1][2]=Buffer.alloc(3);malformed.set(7,rows);
  fail(await apply(encode(malformed)),'restore_aux');
  assert.deepEqual(await inspect(),before);
  fail(await apply(pages[1]),'restore_aux');
  const accepted = ok(await apply(pages[0]));
  await restart();
  assert.deepEqual(ok(await apply(pages[0])),accepted,'exact lost-response retry survives restart');
  assert.deepEqual(ok(await begin()),accepted,'same begin returns durable progress without resetting');
  const wrongPrevious = decode(pages[1]);wrongPrevious.set(5,Buffer.alloc(32));
  fail(await apply(encode(wrongPrevious)),'restore_aux');
  for (const bytes of pages.slice(1,-1)) ok(await apply(bytes));
  fail(await call('import',map([[0,c],[1,[]],[2,completion]])),'restore_aux_incomplete');
  ok(await apply(pages.at(-1)));
  const restored = await inspect();
  assert.ok(restored.tokens.every(r=>r[2] < Date.now()),'expired source tokens must NOT gain fresh TTL');
  assert.deepEqual(restored.items,items.map(r=>[r[0],r[3]]));
  assert.deepEqual(restored.objects,[...objects].sort((a,b)=>Buffer.compare(a[1],b[1])).map(r=>[r[1].toString('hex'),r[5]]));
  assert.deepEqual(restored.tokens,[...tokens].sort((a,b)=>Buffer.compare(a[1],b[1])).map(r=>[r[1].toString('hex'),r[2],r[3]]));
  const done = ok(await call('import',map([[0,c],[1,[]],[2,completion]])));
  assert.equal(done.get(2),true);assert.equal(done.get(3),true);
  await restart();
  assert.equal((await inspect()).aux.length,0,'auxiliary staging cleared atomically with Live');
  assert.equal(ok(await call('head',map([[0,c]]))).get(0),header.get(3));
  for (const [r,bytes] of sealedObjects) {
    const reply = ok(await call('get_object',map([[0,c],[1,r[1]]])));
    if (reply.has(0)) assert.deepEqual(reply.get(0),bytes);
    else {
      const direct=reply.get(1),url=new URL(direct.get(0));
      const response=await fetch(`${base}${url.pathname}${url.search}`,{headers:Object.fromEntries(direct.get(1))});
      assert.equal(response.status,200);
      const restoredBytes=Buffer.from(await response.arrayBuffer());
      assert.deepEqual(restoredBytes,bytes); assert.deepEqual(sha(restoredBytes),reply.get(3));
    }
  }
  fail(await begin(),'restore_aux');
  await appendRecovered();
  assert.equal(ok(await call('head',map([[0,c]]))).get(0),header.get(3)+1,'ordinary device writes remain usable after staging clears');
  console.log('PASS: strict fresh-DO signed replay/object/snapshot/ref recovery, original times+token expiry, auxiliary activation fence, atomic refusal and restart retry');
}
