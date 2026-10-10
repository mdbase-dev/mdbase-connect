// Hermetic real-DO SQLite export qualification. No credentials or remote I/O.
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';

export async function backupCases({ base, token, transport, encode, decode, map, sha, h, restart, onArchive }) {
  const key = (label) => createPrivateKey({ key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'), sha(Buffer.from(label)),
  ]), type: 'pkcs8', format: 'der' });
  const pk = (key) => createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32);
  const root = key('conformance/root'), issuer = key('conformance/issuer');
  const deviceKey = key('backup-cut/device');
  const c = sha(Buffer.from('backup-cut/collection')).subarray(0, 16);
  const actor = c.toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  const owner = sha(Buffer.from('backup-cut/owner')).subarray(0, 16);
  const device = sha(Buffer.from('backup-cut/device-id')).subarray(0, 16);
  const rootId = sha(pk(root)).subarray(0, 16);
  const cert = map([[0, pk(transport)], [1, 0], [2, 2 ** 50], [3, rootId]]);
  cert.set(4, sign(null, h('mdbase/v1/cp-cert', encode(cert)), root));
  const claims = encode(map([[0, 0], [1, device], [2, pk(deviceKey)], [3, Date.now() + 900000], [4, 'mdbase-log'], [5, c]]));
  const deviceToken = `${claims.toString('hex')}.${sign(null, h('mdbase/v1/ls-token', claims), issuer).toString('hex')}`;
  const chain = (b) => h('mdbase/v1/chain', b);
  const signed = (item, key) => {
    item.set(12, sign(null, h('mdbase/v1/item-sig', encode(item)), key));
    return encode(item);
  };
  const policy = (seq, prev, ops) => signed(map([[0, 1], [1, 2], [2, c], [3, seq], [4, prev],
    [6, sha(pk(transport)).subarray(0, 16)], [11, encode(map([[0, 1], [1, cert], [2, seq], [3, ops]]))]]), transport);
  async function call(method, params, isDevice = false) {
    const body = encode(map([[0, 0], [1, 1], [2, method], [3, params]]));
    const nonce = Buffer.from(await (await fetch(`${base}/v1/nonce`)).text(), 'hex');
    const t = isDevice ? deviceToken : token;
    const sig = sign(null, h('mdbase/v1/ls-http', Buffer.concat([
      Buffer.from(`${method}\0/v1/rpc\0`), params.get(0), sha(Buffer.from(t)), sha(body), nonce,
    ])), isDevice ? deviceKey : transport);
    const response = await fetch(`${base}/v1/rpc`, { method: 'POST', body, headers: {
      authorization: `Bearer ${t}`, 'x-mdbase-nonce': nonce.toString('hex'), 'x-mdbase-sig': sig.toString('hex'),
    } });
    assert.equal(response.status, 200, `${method} transport`);
    return decode(Buffer.from(await response.arrayBuffer()));
  }
  const ok = (frame) => { assert.ok(frame.has(2), JSON.stringify([...frame.get(3) ?? []])); return frame.get(2); };
  const fail = (frame, reason) => assert.equal(frame.get(3)?.get(1), reason);
  const genesis = policy(1, Buffer.alloc(32), [map([[0, 1], [1, owner], [2, rootId], [3, 0]])]);
  ok(await call('create_log', map([[0, c], [1, genesis]])));
  const enrol = policy(2, chain(genesis), [map([[0, 2], [1, device], [2, owner], [3, 0],
    [4, pk(deviceKey)], [5, Buffer.alloc(32, 7)], [6, Buffer.alloc(32, 8)]])]);
  ok(await call('append', map([[0, c], [1, 2], [2, chain(genesis)], [3, [enrol]]])));
  const large=process.env.LOGSVC_LARGE_RESTORE==='1';
  const object = encode(map([[0, 1], [1, 18], [2, c], [5, 0], [7, Buffer.alloc(16, 7)], [11, Buffer.alloc(large ? Number(process.env.LOGSVC_RESTORE_OBJECT_BYTES ?? 9*1024*1024-256) : 64, 42)]]));
  const address = sha(object);
  async function sealed(a) {
    const result=ok(await call('get_object',map([[0,c],[1,a]])));
    if (result.has(0)) return result.get(0);
    const direct=result.get(1), url=new URL(direct.get(0));
    const response=await fetch(`${base}${url.pathname}${url.search}`,{headers:Object.fromEntries(direct.get(1))});
    assert.equal(response.status,200);
    const bytes=Buffer.from(await response.arrayBuffer());
    assert.deepEqual(sha(bytes),result.get(3));
    return bytes;
  }
  if (large) {
    assert.ok(object.length > 1024*1024 && object.length <= 9*1024*1024);
    console.log(`INFO large backup source: sealedBytes=${object.length}, importBodyBytes=${encode(map([[0,0],[1,1],[2,'import_object'],[3,map([[0,c],[1,address],[2,18],[3,object]])]])).length}`);
    const admitted=ok(await call('put_object',map([[0,c],[1,address],[2,18],[3,object.length],[4,address]]),true));
    assert.equal(admitted.get(0),1,'large source object uses native streamed staging upload');
    const direct=admitted.get(1), url=new URL(direct.get(0));
    const response=await fetch(`${base}${url.pathname}${url.search}`,{method:'PUT',body:object,headers:Object.fromEntries(direct.get(1))});
    assert.equal(response.status,200);
    ok(await call('commit_object',map([[0,c],[1,address],[2,18]]),true));
  } else ok(await call('put_object', map([[0, c], [1, address], [2, 18], [3, object.length], [4, address], [5, object]]), true));
  const indexed = process.env.LOGSVC_REF_INDEX_RESTORE === '1';
  const partAddresses = [address];
  // Cross both object and nonce page boundaries on the actual SQLite backend.
  for (let i = 0; i < 100; i++) {
    const extra = encode(map([[0, 1], [1, 18], [2, c], [5, 0], [7, Buffer.alloc(16, i)], [11, Buffer.alloc(64, i)]]));
    const a = sha(extra);
    partAddresses.push(a);
    ok(await call('put_object', map([[0, c], [1, a], [2, 18], [3, extra.length], [4, a], [5, extra]]), true));
  }
  // Retain one aged, committed orphan so the existing GC-fence assertion still
  // exercises a real destructive write, not a successful no-op GC.
  const indexedParts=partAddresses.slice(0,-1);
  let snapshotRefs = [address], objectCount = 102;
  if (indexed) {
    const chunks = [];
    for (let i=0;i<2;i++) {
      const bytes=encode(map([[0,1],[1,17],[2,c],[5,0],[7,Buffer.alloc(16,220+i)],[11,Buffer.alloc(64,220+i)]]));
      const a=sha(bytes); chunks.push(a);
      ok(await call('put_object',map([[0,c],[1,a],[2,17],[3,bytes.length],[4,a],[5,bytes]]),true));
    }
    const indices=[];
    for (const members of [indexedParts.slice(0,60),indexedParts.slice(40)]) {
      const sorted=[...members,...chunks].sort(Buffer.compare);
      const bytes=encode(map([[0,1],[1,19],[2,c],[11,encode(map([[0,1],[1,Buffer.concat(sorted)]]))]]));
      const a=sha(bytes); indices.push(a);
      ok(await call('put_object',map([[0,c],[1,a],[2,19],[3,bytes.length],[4,a],[5,bytes]]),true));
    }
    snapshotRefs=[...indices,chunks[0],address];
    objectCount+=4;
  }
  const manifest = signed(map([[0, 1], [1, 16], [2, c], [5, 0], [6, device],
    [7, Buffer.alloc(16, 1)], [9, snapshotRefs], [11, Buffer.alloc(64, 55)]]), deviceKey);
  const manifestAddress = sha(manifest);
  ok(await call('put_object', map([[0, c], [1, manifestAddress], [2, 16], [3, manifest.length], [4, manifestAddress], [5, manifest]]), true));
  ok(await call('put_snapshot', map([[0, c], [1, 2], [2, manifestAddress], [3, snapshotRefs]]), true));
  // Local test hook simulates elapsed object grace time before the cut is taken.
  assert.equal((await fetch(`${base}/__test/age-objects`, { method: 'POST', body: JSON.stringify({ actor }) })).status, 200);
  const compacted = process.env.LOGSVC_COMPACTED_RESTORE === '1';
  const seqId = seq => { const b=Buffer.alloc(16); b.writeUInt32BE(seq,12); return b; };
  const entry = (seq, prev) => signed(map([[0, 1], [1, 1], [2, c], [3, seq], [4, prev], [5, 0],
    [6, device], [7, seqId(seq)], [8, seqId(seq)], [9, [address]], [11, Buffer.alloc(64, seq)]]), deviceKey);
  const first = entry(3, chain(enrol));
  ok(await call('set_quota', map([[0, c], [1, [64*1024*1024, 100000, 100000000, 100000]]])));
  ok(await call('append', map([[0, c], [1, 3], [2, chain(enrol)], [3, [first]]]), true));
  const H = compacted ? 10035 : 35;
  let cutChain = chain(first);
  for (let seq = 4; seq <= H;) {
    const start=seq, previous=cutChain, batch=[];
    for (;seq<=H && batch.length<32;seq++) {
      const item=entry(seq,cutChain); batch.push(item); cutChain=chain(item);
    }
    ok(await call('append',map([[0,c],[1,start],[2,previous],[3,batch]]),true));
  }
  if (compacted) ok(await call('put_snapshot',map([[0,c],[1,H],[2,manifestAddress],[3,[address]]]),true));
  assert.equal((await fetch(`${base}/__test/age-aux-fixture`, { method: 'POST', body: JSON.stringify({ actor }) })).status, 200);
  if (compacted) {
    assert.equal(ok(await call('compact',map([[0,c]]))).get(0),36,'real native compaction preserves controls and removes old entries');
  }
  const retainedSeqs=Array.from({length:H},(_,i)=>i+1).filter(seq=>!compacted || seq<3 || seq>=36);
  // Permission checks are real device proof-of-possession, not a test bypass.
  fail(await call('backup_begin', map([[0, c]]), true), 'principal');
  const begun = ok(await call('backup_begin', map([[0, c]])));
  const headerBytes = begun.get(0), header = decode(headerBytes);
  assert.deepEqual(sha(headerBytes), begun.get(1));
  assert.equal(header.get(0), 'mdbase-next-backup/1');
  assert.equal(header.get(3), H);
  assert.deepEqual(header.get(4), cutChain);
  const session = header.get(2);
  fail(await call('backup_finish', map([[0, c], [1, session], [2, begun.get(1)]])), 'backup_incomplete');
  fail(await call('set_quota', map([[0, c], [1, [999999, 20, 100000, 20]]])), 'backup_lease');
  fail(await call('gc', map([[0, c]])), 'backup_lease');
  const orphanInventory = ok(await call('export_objects', map([[0, c]])));
  assert.equal(orphanInventory.get(0).length, objectCount, 'GC refusal leaves every committed object row intact');
  assert.deepEqual(await sealed(address), object, 'R2 bytes remain readable');
  const next = entry(H + 1, cutChain);
  ok(await call('append', map([[0, c], [1, H + 1], [2, cutChain], [3, [next]]]), true));
  assert.equal(ok(await call('head', map([[0, c]]))).get(0), H + 1, 'ordinary append remains available past cut');
  fail(await call('put_snapshot', map([[0, c], [1, H + 1], [2, manifestAddress], [3, [address]]]), true), 'backup_lease');
  const lateObject = encode(map([[0, 1], [1, 18], [2, c], [5, 0], [7, Buffer.alloc(16, 200)], [11, Buffer.alloc(64, 200)]]));
  const lateAddress = sha(lateObject);
  ok(await call('put_object', map([[0, c], [1, lateAddress], [2, 18], [3, lateObject.length], [4, lateAddress], [5, lateObject]]), true));
  fail(await call('backup_page', map([[0, c], [1, session], [2, 2], [3, begun.get(1)]])), 'backup_cursor');
  fail(await call('backup_page', map([[0, c], [1, session], [2, 1], [3, Buffer.alloc(32)]])), 'backup_cursor');
  let page = 1, previous = begun.get(1);
  const initial = ok(await call('backup_page', map([[0, c], [1, session], [2, page], [3, previous]])));
  const initialBody = decode(initial.get(0));
  assert.deepEqual(initialBody.get(7).map((row) => row[0]), retainedSeqs.slice(0,32), 'first item page has exactly 32 candidates');
  assert.equal(initialBody.get(9), H);
  await restart(); // Interrupted export: session and identical lost-response retry survive.
  const retry = ok(await call('backup_page', map([[0, c], [1, session], [2, page], [3, previous]])));
  assert.deepEqual(retry, initial);
  fail(await call('backup_page', map([[0, c], [1, session], [2, page], [3, Buffer.alloc(32)]])), 'backup_cursor');
  fail(await call('backup_page', map([[0, c], [1, session], [2, page]])), 'backup_hash');
  let lastPrevious = previous;
  previous = initial.get(1);
  const pages = [initial.get(0)];
  const sections = new Set([1]);
  const objects = [], tokens = [], nonces = [], snapshots = [], refs = [];
  const items = [...initialBody.get(7)];
  for (page = 2; page < 1000; page++) {
    const result = ok(await call('backup_page', map([[0, c], [1, session], [2, page], [3, previous]])));
    const bytes = result.get(0), body = decode(bytes);
    pages.push(bytes);
    assert.deepEqual(sha(bytes), result.get(1));
    assert.deepEqual(body.get(5), previous);
    assert.equal(body.get(4), page);
    assert.equal(body.get(9), H);
    sections.add(body.get(6));
    if (body.get(6) === 1) items.push(...body.get(7));
    if (body.get(6) === 2) snapshots.push(...body.get(7));
    if (body.get(6) === 3) refs.push(...body.get(7));
    if (body.get(6) === 4) objects.push(...body.get(7));
    if (body.get(6) === 5) tokens.push(...body.get(7));
    if (body.get(6) === 6) nonces.push(...body.get(7));
    assert.ok(body.get(7).length <= (body.get(6) === 1 ? 32 : 100));
    lastPrevious = previous;
    previous = result.get(1);
    if (body.get(6) === 6 && body.get(8)) break;
  }
  assert.deepEqual([...sections], [1, 2, 3, 4, 5, 6]);
  assert.equal(objects.length, objectCount);
  if (indexed) {
    const closure=refs.filter(r=>r[2]===1 && r[3]===2).map(r=>r[1]);
    assert.equal(closure.length,105,'overlapping ref-indices and direct duplicate produce unique complete closure');
    for (const a of indexedParts) assert.ok(closure.some(b=>a.equals(b)));
    assert.equal(objects.filter(r=>r[2]===19).length,2);
    assert.equal(objects.filter(r=>r[2]===17).length,2);
  }
  assert.equal(snapshots.length, compacted ? 2 : 1);
  assert.deepEqual(snapshots[0].slice(0, 3), [2, manifestAddress, device]);
  assert.ok(refs.some((row) => row[1].equals(manifestAddress) && row[2] === 1 && row[3] === 2));
  assert.ok(objects.some((row) => row[1].equals(address)));
  assert.ok(!objects.some((row) => row[1].equals(lateAddress)), 'object committed after cut is excluded');
  assert.equal(tokens.length, H - 2, 'idempotency token past H is excluded');
  assert.ok(tokens.every((row) => row[2] <= H));
  assert.deepEqual(items.map((row) => row[0]), retainedSeqs, 'complete item cut excludes append past H');
  assert.ok(nonces.length > 100, 'nonce cut traverses multiple bounded pages');
  if (compacted) assert.ok(tokens.some(row=>row[2]<36 && row[2]>=3),'source contains tokens for truly compacted positions');
  const sealedObjects = [];
  for (const row of objects) sealedObjects.push([row, await sealed(row[1])]);
  const finished = ok(await call('backup_finish', map([[0, c], [1, session], [2, previous]])));
  assert.equal(finished.get(3), H);
  assert.deepEqual(finished.get(7), previous);
  const archive = { c, actor, headerBytes, header, pages, items, objects, tokens, snapshots, refs, sealedObjects, finalHash: previous };
  // Recovery qualification runs while the preserved SOURCE is still Live and
  // the finished cut valid; its namespace is never reset/restored with target.
  if (onArchive) await onArchive(archive, async () => {
    ok(await call('append', map([[0,c],[1,H+1],[2,cutChain],[3,[next]]]), true));
  });
  ok(await call('set_quota', map([[0, c], [1, [999999, 20, 100000, 20]]])));
  // Current security mutations invalidate even FINISHED cuts, not only leases.
  const security = policy(H + 2, chain(next), [map([[0, 11], [1, true]])]);
  ok(await call('append', map([[0, c], [1, H + 2], [2, chain(next)], [3, [security]]])));
  fail(await call('backup_page', map([[0, c], [1, session], [2, page], [3, lastPrevious]])), 'backup_expired');
  fail(await call('backup_finish', map([[0, c], [1, session], [2, previous]])), 'backup_expired');
  ok(await call('backup_abort', map([[0, c], [1, session]])));
  const expiring = ok(await call('backup_begin', map([[0, c]])));
  const expiringHeader = decode(expiring.get(0));
  assert.equal((await fetch(`${base}/__test/expire-cut`, { method: 'POST', body: JSON.stringify({ actor }) })).status, 200);
  fail(await call('backup_page', map([[0, c], [1, expiringHeader.get(2)], [2, 1], [3, expiring.get(1)]])), 'backup_expired');
  fail(await call('backup_finish', map([[0, c], [1, expiringHeader.get(2)], [2, expiring.get(1)]])), 'backup_expired');
  const deleting = ok(await call('backup_begin', map([[0, c]])));
  const deletingHeader = decode(deleting.get(0));
  assert.ok(deletingHeader.get(6) > header.get(6));
  let deletionPage = 1, deletionPrevious = deleting.get(1), deletionLastPrevious;
  for (; deletionPage < 1000; deletionPage++) {
    deletionLastPrevious = deletionPrevious;
    const result = ok(await call('backup_page', map([[0, c], [1, deletingHeader.get(2)], [2, deletionPage], [3, deletionPrevious]])));
    deletionPrevious = result.get(1);
    const body = decode(result.get(0));
    if (body.get(6) === 6 && body.get(8)) break;
  }
  ok(await call('backup_finish', map([[0, c], [1, deletingHeader.get(2)], [2, deletionPrevious]])));
  const deletion = sha(Buffer.from('backup-cut/deletion')).subarray(0, 16);
  const epoch = (1n << 64n) - 1n;
  const floor = ok(await call('registry_record_collection_deletion', map([[0, Buffer.alloc(16)], [1, c], [2, deletion], [3, epoch]])));
  assert.deepEqual([floor.get(1), floor.get(2), floor.get(3)], [c, deletion, epoch]);
  const receipt = [1, c, deletion, epoch];
  const deleted = ok(await call('delete_log', map([[0, c], [1, deletion], [2, epoch]])));
  assert.equal(deleted.get(0), true);
  assert.deepEqual(deleted.get(1), receipt);
  fail(await call('backup_page', map([[0, c], [1, deletingHeader.get(2)], [2, deletionPage], [3, deletionLastPrevious]])), 'backup_expired');
  fail(await call('backup_finish', map([[0, c], [1, deletingHeader.get(2)], [2, deletionPrevious]])), 'backup_expired');
  fail(await call('backup_begin', map([[0, c]])), 'backup_state');
  console.log('PASS: DO cut export, append-through, quota fence, restart retry, bounded multi-page chain, security/deletion invalidation and expiry');
  return archive;
}
