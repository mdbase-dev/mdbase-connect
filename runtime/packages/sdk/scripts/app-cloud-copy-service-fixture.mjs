/** Owned LOCAL TEST service participant. Same native Replica/sealer over real
 * SQLite and authenticated PG log; NOT hosted Worker/KMS/deployment proof.
 * No injected epoch keys, synthetic policy, receipt or unconditional signer. */
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
export async function openNativeServiceFixture({sdk, wasm, service, collection, expectedGenesis, roots, policyPins, log, logOrigin}) {
  const db = new DatabaseSync(':memory:');
  const backend = {
    needsRecovery: false,
    fence() {this.needsRecovery = true;},
    run(batch, limits) {
      const tx = batch.mode === 'Transaction';
      if(tx) db.exec('BEGIN IMMEDIATE');
      try {
        let rows = 0;
        const result = batch.stmts.map(({sql, params}) => {
          const stmt = db.prepare(sql); stmt.setReadBigInts(true);
          const args = params.map(v => v.kind === 'Null' ? null : v.value), names = stmt.columns().map(c => c.name);
          if(!names.length) {const r = stmt.run(...args);return {columns:0,values:[],changes:BigInt(r.changes),lastInsertRowid:BigInt(r.lastInsertRowid)};}
          assert(names.length <= limits.maxColumns); const values = [];
          for(const row of stmt.iterate(...args)) {assert(++rows <= limits.maxRows);for(const name of names) {const v=row[name];values.push(v===null?{kind:'Null'}:typeof v==='bigint'?{kind:'Integer',value:v}:typeof v==='number'?{kind:'Real',value:v}:typeof v==='string'?{kind:'Text',value:v}:{kind:'Blob',value:new Uint8Array(v)});}}
          return {columns:names.length,values,changes:0n,lastInsertRowid:0n};
        });
        if(tx) db.exec('COMMIT'); return result;
      } catch(error) {if(tx) {try {db.exec('ROLLBACK');}catch {}} this.fence();throw error;}
    },
  };
  const bridge = new sdk.AppBinaryIndexHost(backend), sql = {import:x=>sdk.appSqlHost(bridge,x),fence:()=>bridge.fence(),get needsRecovery(){return bridge.needsRecovery;}};
  const rt = await sdk.AppWasmRuntime.create(wasm, sql);
  let pump, current = true;
  try {
    const v = db.prepare('SELECT sqlite_version() AS v').get().v.split('.').map(Number);
    rt.openAppConsuming({collection,replicaId:randomUUID(),deviceId:service.deviceId,endpoint:37,trustedRoots:roots,policyPins,trustedSigners:[],expectedGenesis,state:'cloud_copy',cloudCopyOptIn:true,signSecretKey:service.signSecret.slice(),kemSecretKey:service.kemSecret.slice(),opened:'fresh',sqliteVersion:v[0]*1000000+v[1]*1000+v[2]});
    const token = log.mintToken({device:service.deviceId,signPublicKey:service.signPublic,collection,expiresAt:Date.now()+3600000});
    const authority = {endpoint:37,collection,origin:logOrigin,directOrigins:[],isCurrent:()=>current,accessToken:async()=>token,signLogProof:async proof=>rt.signLogHttp(proof)};
    const transport = new sdk.AppHttpLogTransport(authority,{allowLoopbackHttp:true});
    pump = rt.bindLogTransport(transport);
    const drive = async () => {
      for(let turn=0;turn<8;turn++) {rt.tick();await pump.pump();}
      assert.equal(rt.observations().requiresReopen,false);
    };
    await drive();
    return {drive,observations:()=>rt.observations(),close:async()=>{current=false;await pump.close();rt.close();db.close();}};
  } catch(error) {current=false;await pump?.close();rt.close();db.close();throw error;}
}
