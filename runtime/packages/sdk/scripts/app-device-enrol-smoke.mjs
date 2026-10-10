#!/usr/bin/env node
/** Actual source SDK/WASM/CSPRNG/WebCrypto/SQLite plus ACTUAL Connect routes,
 * authentication, migrations and receiver. Private PostgreSQL CP + loopback only.
 * PUBLIC native fixture supplies genuine collection pins; no policy activation,
 * OPFS/platform persistent custody, live account/login or durability acceptance. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync,mkdirSync,symlinkSync,existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "../node_modules/esbuild/lib/main.js";
const [artifact,fixtureFile,connectCheckout,policyPinsFile]=process.argv.slice(2);
if(!artifact||!fixtureFile||!connectCheckout||!policyPinsFile)throw Error("explicit app artifact, PUBLIC signed fixture, owned Connect checkout and matching public PolicyPins CBOR required");
const policyPins=new Uint8Array(readFileSync(policyPinsFile));
const cp=resolve(connectCheckout),out=new URL("../../../target/app-device-smoke/",import.meta.url);mkdirSync(out,{recursive:true});
const deps=new URL("node_modules",out);if(!existsSync(deps))symlinkSync(resolve(cp,"services/server/node_modules"),deps,"dir");
await build({stdin:{contents:'export * from "./src/app-host/index.ts"; export * from "./src/cbor.ts"; export {uuid,hash} from "./src/codec.ts"; export * from "../obsidian-runtime/src/index/appIndexHost.ts";',resolveDir:new URL("../",import.meta.url).pathname},bundle:true,platform:"node",format:"esm",outfile:new URL("sdk.mjs",out).pathname});
await build({stdin:{contents:`export {openDatabase} from ${JSON.stringify(resolve(cp,"services/server/src/db.ts"))};export {runControlPlaneMigrations} from ${JSON.stringify(resolve(cp,"services/server/src/migrations.ts"))};export {registerNextDeviceRoutes} from ${JSON.stringify(resolve(cp,"services/server/src/features/next/device-routes.ts"))};export {tokenHash} from ${JSON.stringify(resolve(cp,"services/server/src/security.ts"))};export {default as Fastify} from "fastify";`,resolveDir:resolve(cp,"services/server")},bundle:true,packages:"external",platform:"node",format:"esm",outfile:new URL("cp.mjs",out).pathname});
const {AppWasmRuntime,AppCpDeviceRegistration,AppWebNoiseCustody,AppBinaryIndexHost,appSqlHost,uuid,hash,decode}=await import(new URL("sdk.mjs",out));
const {openDatabase,runControlPlaneMigrations,registerNextDeviceRoutes,tokenHash,Fastify}=await import(new URL("cp.mjs",out));
const fixture=decode(readFileSync(fixtureFile)),wasm=readFileSync(artifact),collection=uuid.dec(fixture.get(0)),deviceId=uuid.dec(fixture.get(1));
const databaseUrl=process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
if(!databaseUrl || process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL!=="I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS")throw Error("explicit isolated PostgreSQL test URL/approval required (memory bytea is NOT key-custody qualification)");
const testUrl=new URL(databaseUrl);if(!["127.0.0.1","localhost","[::1]"].includes(testUrl.hostname)||!/test/i.test(testUrl.pathname))throw Error("private loopback test database only");
const pool=await openDatabase(databaseUrl);await runControlPlaneMigrations(pool,{lock:true,directory:resolve(cp,"services/server/migrations")});
const app=Fastify({logger:false});registerNextDeviceRoutes(app,{db:pool,log:{controlItemAt:async()=>{throw Error("no policy/approval acceptance in registration smoke");}}});
const connectorId=randomUUID(),bearer=`public-native-cp-fixture-${randomUUID()}`,installationId=randomUUID();
await pool.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Native fixture')",[connectorId,`${connectorId}@example.test`]);
await pool.query("INSERT INTO connectors(id,user_id,name,token_hash,relay_generation) VALUES($1,$2,'Native fixture',$3,1)",[connectorId,connectorId,tokenHash(bearer)]);
const db=new DatabaseSync(":memory:"),v=db.prepare("SELECT sqlite_version() AS v").get().v.split(".").map(Number),sqliteVersion=v[0]*1_000_000+v[1]*1_000+v[2];let turns=0,registeredBody;
const sqlBackend={needsRecovery:false,fence(){this.needsRecovery=true;},run(batch,limits){++turns;const tx=batch.mode==="Transaction";if(tx)db.exec("BEGIN IMMEDIATE");try{let rows=0;const results=batch.stmts.map(({sql,params})=>{const s=db.prepare(sql);s.setReadBigInts(true);const args=params.map(v=>v.kind==="Null"?null:v.value),names=s.columns().map(c=>c.name);if(!names.length){const r=s.run(...args);return{columns:0,values:[],changes:BigInt(r.changes),lastInsertRowid:BigInt(r.lastInsertRowid)};}assert(names.length<=limits.maxColumns);const values=[];for(const row of s.iterate(...args)){assert(++rows<=limits.maxRows);for(const name of names){const value=row[name];values.push(value===null?{kind:"Null"}:typeof value==="bigint"?{kind:"Integer",value}:typeof value==="number"?{kind:"Real",value}:typeof value==="string"?{kind:"Text",value}:{kind:"Blob",value:new Uint8Array(value)});}}return{columns:names.length,values,changes:0n,lastInsertRowid:0n};});if(tx)db.exec("COMMIT");return results;}catch(e){if(tx){try{db.exec("ROLLBACK");}catch{}}this.fence();throw e;}}};
const bridge=new AppBinaryIndexHost(sqlBackend),sql={import:exports=>appSqlHost(bridge,exports),fence:()=>bridge.fence(),get needsRecovery(){return bridge.needsRecovery;}};
const encrypted=new Map(),key=await crypto.subtle.generateKey({name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
const protectedStore={read:async ns=>encrypted.get(ns)??null,compareAndSet:async(ns,expected,bytes)=>{const old=encrypted.get(ns)??null;const same=old===null?expected===null:expected!==null&&old.length===expected.length&&old.every((b,i)=>b===expected[i]);if(!same)return false;encrypted.set(ns,new Uint8Array(bytes));return true;}};
let rt,warm,reg;
try {
  await app.listen({host:"127.0.0.1",port:0});const origin=`http://127.0.0.1:${app.server.address().port}`;
  const kind=process.env.MDBASE_APP_FIXTURE_KIND??"app-runtime";assert(["mobile","app-runtime"].includes(kind));const session={connectorId,deviceId,installationId,cpOrigin:origin,kind,isCurrent:()=>true,connectorBearer:async()=>bearer},signal=new AbortController().signal;
  const vault=new AppWebNoiseCustody(session,key,protectedStore);assert.equal(await vault.restore({signal}),null);
  rt=await AppWasmRuntime.createDevice(wasm);const signSecretKey=Buffer.alloc(32,1),kemSecretKey=Buffer.alloc(32,1);
  const custody=rt.openDeviceConsuming({pin:session,signSecretKey,kemSecretKey,opened:{mode:"fresh"}});assert(signSecretKey.every(b=>b===0)&&kemSecretKey.every(b=>b===0));assert.equal(turns,0);assert.throws(()=>rt.connect());assert.throws(()=>rt.observations());assert.notDeepEqual(custody.noisePublicKey,custody.kemPublicKey);
  reg=new AppCpDeviceRegistration(rt,session,custody,vault,{allowLoopbackHttp:true,fetch:async(url,init)=>{if(new URL(url).pathname==="/v1/next/devices")registeredBody=JSON.parse(init.body);return fetch(url,init);}});
  const receipt=await reg.register({signal});const row=(await pool.query("SELECT connector_id,kind,sign_pk,kem_pk,noise_pk FROM next_devices WHERE id=$1",[deviceId])).rows[0];assert.equal(row.connector_id,connectorId);assert.equal(row.kind,kind);for(const [col,k]of[["sign_pk","signPublicKey"],["kem_pk","kemPublicKey"],["noise_pk","noisePublicKey"]])assert.deepEqual(new Uint8Array(row[col]),receipt[k]);assert.equal(turns,0);
  const replay=await app.inject({method:"POST",url:"/v1/next/devices",headers:{authorization:`Bearer ${bearer}`},payload:registeredBody});assert.equal(replay.statusCode,400);assert.equal(replay.json().error.code,"challenge_invalid");
  const badOwner=await app.inject({method:"POST",url:"/v1/next/devices/challenge",headers:{authorization:"Bearer foreign-fixture"}});assert.equal(badOwner.statusCode,401);
  // Genuine PUBLIC fixture root/genesis only. NO private-enrol/SAS or signed
  // policy acceptance for the newly generated Noise identity is asserted.
  const metadata={collection,replicaId:"01010101-0101-0101-0101-010101010101",deviceId,endpoint:37,trustedRoots:[fixture.get(2)],policyPins,trustedSigners:[],expectedGenesis:hash.dec(fixture.get(3)),state:"cloud_copy",cloudCopyOptIn:true,opened:"fresh",sqliteVersion};
  rt.adoptDevice(metadata,sql);assert(turns>0);assert.throws(()=>rt.signCpEnrol(new Uint8Array(32)));assert.equal(await rt.close(),true);rt=null;
  // Async outer unwrap BEFORE sync native device restore; protected actual
  // registration receipt allows offline adoption without a challenge/network.
  const restored=await vault.restore({signal});assert(restored.receipt);warm=await AppWasmRuntime.createDevice(wasm);const before=turns;
  const again=warm.openDeviceConsuming({pin:session,signSecretKey:Buffer.alloc(32,1),kemSecretKey:Buffer.alloc(32,1),opened:{mode:"existing",envelope:restored.envelope}});assert.equal(turns,before);assert.deepEqual(again.noisePublicKey,custody.noisePublicKey);assert.deepEqual(again.envelope,custody.envelope);warm.acknowledgeDeviceRegistration(restored.receipt);warm.adoptDevice({...metadata,opened:"existing"},sql);assert.equal(await warm.close(),true);warm=null;
  assert(!db.prepare("SELECT k FROM st_meta").all().some(r=>/keyring/i.test(r.k)));
  console.log(JSON.stringify({actualSdk:true,actualAppWasm:true,registeredKind:kind,nativeIndependentNoise:true,actualWebCryptoOuterWrap:true,actualConnectAuthenticationRoutesMigrations:true,actualPostgresReceiver:true,actualCpEnrolReceiver:true,oneUseChallenge:true,foreignCredentialRefused:true,actualSqlite:sqliteVersion,turns,metadataOnlyAdoption:true,offlineReceiptReopen:true,noiseIdentityPreserved:true,keyringPersisted:false,platformPersistenceQualified:false,policyEnrolmentQualified:false,providerActivationQualified:false}));
} finally {if(warm)await warm.close();if(rt)await rt.close();await app.close();await pool.end();db.close();}
