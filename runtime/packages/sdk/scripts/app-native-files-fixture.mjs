/** Owned Node-only native Files composition, not browser/OS/power-loss evidence. */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

export async function qualifyNativeFiles({creator, joining, service, sdk}) {
  const actors = [creator, joining];
  const turn = async () => {
    await service.drive();
    for (const actor of actors) {actor.rt.tick(); await actor.pump.pump();}
    await delay(0);
  };
  const settled = async (operation, label) => {
    let done = false, result, error;
    operation.then(value => {result = value; done = true;}, reason => {error = reason; done = true;});
    const deadline = Date.now() + 120000;
    while (!done && Date.now() < deadline) await turn();
    assert(done, `${label} did not settle within its bound`);
    if (error) {console.error(JSON.stringify({nativeFilesFailedAt:label,code:error.code,reason:error.reason})); throw error;}
    return result;
  };
  // Genuine roster/key-grant producer must catch up before attempting writes.
  for (let i=0;i<8;i++) await turn();
  const sqlMtime = (actor, id) => {
    const row = actor.db.prepare('SELECT row FROM st_file').all()
      .map(({row}) => sdk.decode(new Uint8Array(row)))
      .find(row => Buffer.from(row[0]).toString('hex') === id.replaceAll('-', ''));
    assert(row, 'actual native SQLite file row missing');
    assert.equal(row.length, 9, 'captured native file must persist optional mtime');
    return Number(row[8]);
  };
  const read = async (actor, id, size, digest) => {
    const stream = actor.client.files.downloadStream(id, {signal:AbortSignal.timeout(120000)});
    const reader = stream.getReader(), hash = createHash('sha256');
    let bytes = 0;
    for (;;) {
      const {done, value} = await settled(reader.read(), 'native ID read');
      if (done) break;
      assert(value.byteLength <= (1 << 20), 'native file frame exceeded fragment bound');
      hash.update(value); bytes += value.byteLength;
    }
    const view = await stream.file;
    assert.equal(view.id, id); assert.equal(bytes, size);
    assert.equal(hash.digest('hex'), digest);
    return view;
  };
  const block = new Uint8Array(1 << 20).fill(0x5a);
  for (const size of [0, (8 << 20) + 31]) {
    const source = size === 0 ? new Blob([]) : new Blob([...Array(8).fill(block), block.subarray(0, 31)]);
    const hasher = createHash('sha256');
    for (let offset = 0; offset < size; offset += block.length) hasher.update(block.subarray(0, Math.min(block.length, size-offset)));
    const initialRows = creator.db.prepare('SELECT COUNT(*) AS n FROM st_file').get().n;
    const digest = hasher.digest('hex'), transfer = randomUUID(), mutation = randomUUID();
    const path = `files/owned-native-${transfer}.bin`;
    const open = sdk.wire.openUploadParams.enc({transfer,path,size,digest:`sha256:${digest}`,mutationId:mutation});
    const opened = await settled(creator.client.call('open_upload', open, {codec:sdk.wire.openUploadResult}), 'zero-prefix open');
    assert.equal(opened.transfer, transfer); assert(opened.fileId);
    assert.deepEqual(opened.received, []);
    const zeroPending = await settled(creator.client.pendingWrites(), 'zero-prefix pending inventory');
    assert(!zeroPending.some(row => row.receipt.mutation === mutation), 'opaque upload pointer is not a PendingRow');
    assert.equal(creator.db.prepare('SELECT COUNT(*) AS n FROM st_file').get().n, initialRows);
    // Restart the actual native runtime, reauthenticate original encrypted custody,
    // and reopen the same real SQLite store. Not an OS/power-loss restart.
    await creator.reopenFiles();
    for (let i=0;i<8;i++) await turn();
    const resumed = await settled(creator.client.call('open_upload', open, {codec:sdk.wire.openUploadResult}), 'cold zero-prefix resume');
    assert.equal(resumed.fileId, opened.fileId); assert.equal(resumed.expiresAt, opened.expiresAt);
    assert.deepEqual(resumed.received, []);
    const write = await settled(creator.client.files.upload(path, source, {transferId:transfer,mutationId:mutation,signal:AbortSignal.timeout(120000)}), 'SDK FileWrite');
    assert.equal(write.fileId, opened.fileId); assert.equal(write.receipt.mutation, mutation);
    const confirmed = await settled(write.confirmed, 'actual native confirmation');
    assert.equal(confirmed.mutation, mutation); assert.equal(confirmed.state, 'confirmed');
    assert.equal(confirmed.status, 'applied');
    const own = await settled(creator.client.files.get(write.fileId), 'native FileView');
    assert.equal(own.id, opened.fileId); assert.equal(own.size, size); assert(Number.isSafeInteger(own.mtime));
    assert.equal(sqlMtime(creator, write.fileId), own.mtime);
    await read(creator, write.fileId, size, digest);
    // This bounded HTTP carrier has no live LOG notification subscription.
    // Explicit authenticated cold reopen exercises fresh native tail replay;
    // it is not qualification of warm notification delivery.
    await joining.reopenFiles();
    for (let i=0;i<8;i++) await turn();
    assert(joining.rt.observations().status.confirmedThrough >= confirmed.seq, `joining native replica did not apply the actual file receipt position: ${JSON.stringify(joining.rt.observations())}`);
    const joined = await read(joining, write.fileId, size, digest);
    assert.equal(joined.mtime, own.mtime);
    await creator.reopenFiles();
    for (let i=0;i<8;i++) await turn();
    const recovered = await settled(creator.client.files.upload(path, source, {transferId:transfer,mutationId:mutation,signal:AbortSignal.timeout(120000)}), 'captured SDK retry');
    assert.equal(recovered.fileId, write.fileId); assert.equal(recovered.receipt.mutation, mutation);
    const recoveredReceipt = await settled(recovered.confirmed, 'original captured outcome');
    assert.equal(recoveredReceipt.seq, confirmed.seq);
    const after = await settled(creator.client.files.get(write.fileId), 'cold FileView');
    assert.equal(after.mtime, own.mtime); assert.equal(sqlMtime(creator, write.fileId), own.mtime);
    const capturedPending = await settled(creator.client.pendingWrites(), 'captured pending inventory');
    assert(!capturedPending.some(row => row.receipt.mutation === mutation), 'captured reference is not a settled mutation inventory row');
    assert.equal(creator.db.prepare('SELECT COUNT(*) AS n FROM st_file').get().n, initialRows + 1);
    console.log(JSON.stringify({nativeFilesQualified:true,size,fileId:write.fileId,mutation,seq:confirmed.seq,mtime:own.mtime,scope:'process-only SDK identity/bytes/mtime/recovery interop',source:'built-SDK-native-WASM-NodeSQLite-native-MemBackend-LS-real-CP-PG',durableLog:false,physicalDelivery:false,browser:false,powerLoss:false}));
  }
}
