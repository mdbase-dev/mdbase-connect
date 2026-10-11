// Actual isolated workerd/WASM/SQLite/storage.sync source mechanics. PUBLIC
// synthetic CPP transport + H0 checkpoint DATA: no managed CPP/H0/H1 permit.
import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { decode } from "../../../packages/sdk/src/cbor.ts";
const fixture = process.env.PITR_APP_FIXTURE, wasmPath = process.env.HOSTED_WASM;
if (!fixture || !wasmPath) throw Error("Explicit PUBLIC PITR_APP_FIXTURE + fresh owned HOSTED_WASM required");
const fb = await readFile(fixture), f = JSON.parse(fb);
const manifest = JSON.parse(await readFile(fixture.replace(/\.json$/, ".manifest.json"), "utf8"));
assert.equal(manifest.publicFixedTestValuesOnly, true);assert.equal(manifest.managedCompositionQualified, false);
assert.equal(manifest.sha256, createHash("sha256").update(fb).digest("hex"));
for (const [name, seed] of [["sign_sk", "43"], ["kem_sk", "44"], ["noise_sk", "47"]]) assert.equal(f.hosted[name], seed.repeat(32));
const hex = b => Buffer.from(b).toString("hex"), bytes = s => new Uint8Array(Buffer.from(s, "hex"));
const uuid = b => hex(b).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
const hash = (tag, b) => new Uint8Array(createHash("sha256").update(Buffer.concat([Buffer.from([Buffer.byteLength(tag)]), Buffer.from(tag), b])).digest());
const declared = JSON.parse(await readFile(new URL("./fixtures/public-genesis.json", import.meta.url), "utf8"));
const pins = new Uint8Array(Buffer.from(declared.pins, "base64")), trusted = decode(pins), root = trusted[0][0][0], rootPK = trusted[0][0][1];
assert.equal(f.root_pk, hex(rootPK));
const genesis = decode(bytes(f.items[0])), founding = decode(genesis.get(11)).get(3).find(o => o.get(0) === 1);
const xpublic = secret => new Uint8Array(createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), bytes(secret)]), format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" }).subarray(-32));
const claim = { schema: "mdbase-migration-claim/1", collection_id: f.collection, owner_account: uuid(founding.get(1)),
  started_us: "10413792000000001", target: { runtime: "shadow", root_key_id: hex(root), hosted: { device_id: f.hosted.device,
    sign_pk: f.hosted.sign_pk, kem_pk: hex(xpublic(f.hosted.kem_sk)), noise_pk: hex(xpublic(f.hosted.noise_sk)) } } };
const origin = "https://connect-lab.mdbase.dev";
// Independently declared PUBLIC compiled fixture, never an actual release asset.
const releaseSource = `export function appReleaseTrust(){return {schema:"mdbn-app-trust/release/1",environment:"lab",cpOrigin:${JSON.stringify(origin)},logOrigin:"https://log.test",trustedRoots:[Uint8Array.from(${JSON.stringify(Array.from(rootPK))})],policyPins:Uint8Array.from(${JSON.stringify(Array.from(pins))})};}`;
const digest = createHash("sha256").update(bytes(f.items[0])).digest("hex"), chain = hex(hash("mdbase/v1/chain", bytes(f.items.at(-1))));
const compiled = await build({ stdin: { contents: `
import { HostedCollection } from "./src/worker.ts";
import { Engine, encode, decode } from "./src/engine.ts";
import { productionParts } from "./src/factory.ts";
const f=${JSON.stringify(f)}, claim=${JSON.stringify(claim)}, pins=Uint8Array.from(${JSON.stringify(Array.from(pins))}), rootPK=Uint8Array.from(${JSON.stringify(Array.from(rootPK))});
const bytes=s=>Uint8Array.from(s.match(/../g)||[],v=>parseInt(v,16));
const uuid=s=>bytes(s.replaceAll("-",""));
const config=()=>encode(new Map([[0,uuid(f.collection)],[1,uuid(f.hosted.replica)],[2,uuid(f.hosted.device)],[3,[rootPK]],[4,f.hosted.signers.map(uuid)],[5,bytes(f.hosted.sign_sk)],[6,bytes(f.hosted.kem_sk)],[8,pins],[9,bytes(f.items[0])],[10,bytes(${JSON.stringify(digest)})]]));
const envConfig={KMS_KEY_ARN:"arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111",AWS_REGION:"eu-west-1",AWS_ACCESS_KEY_ID:"AKIDEXAMPLE",AWS_SECRET_ACCESS_KEY:"s".repeat(40),KMS_ENVIRONMENT:"lab",KMS_COLLECTIONS:f.collection,LOG_URL:"https://log.test",CP_URL:${JSON.stringify(origin)},CP_INBOUND_TOKEN:"t".repeat(40),HOSTED_SIGNERS:f.hosted.signers.join(",")};
class Probe extends HostedCollection {
  constructor(ctx,env) { super(ctx,env); this.collection=f.collection; this.calls=0;
    const parts=productionParts(envConfig,async(url,init)=>{this.calls++; const path=new URL(url).pathname;
      if(path.endsWith("/challenge"))return Response.json({challenge:"55".repeat(32)});
      if(!path.endsWith("/read"))throw Error("no outbound operation allowed");
      const proof=JSON.parse(init.body);if(proof.device_id!==f.hosted.device||proof.challenge!=="55".repeat(32)||!/^[0-9a-f]{128}$/.test(proof.sig))throw Error("closed CPP proof fixture mismatch");
      return Response.json(claim);
    });if(!parts)throw Error("public fixture factory refused");this.cppControl=parts.control;this.openNative();
  }
  openNative(){const e=this.engine=new Engine(this.ctx.storage);e.openForCppClaim(config(),this.cppControl);
    if(!e.logBind())throw Error("native binding refused");const items=f.items.map(bytes);
    for(let turn=0;turn<64;turn++){const calls=e.logCalls();if(!calls.length)return;
      for(const c of calls){const call=decode(c.frame),method=call.get(2),p=call.get(3);let result;
        if(method==="head")result=new Map([[0,items.length],[1,bytes(${JSON.stringify(chain)})],[2,1]]);
        else if(method==="read")result=new Map([[0,items.map((b,i)=>[i+1,b]).filter(([i,b])=>i>p.get(1)&&(p.get(3)!==1||[2,3,4,5,6].includes(decode(b).get(1))))],[1,items.length],[2,bytes(${JSON.stringify(chain)})],[3,1],[4,false],[6,false]]);
        else throw Error("non-readonly native log action");e.logReply(c.id,encode(new Map([[0,1],[1,call.get(1)],[2,result]])));c.frame.fill(0);
      }
    }throw Error("bounded native log exhausted");
  }
  async fetch(request){const mode=new URL(request.url).searchParams.get("mode");
    const originalSync=this.ctx.storage.sync.bind(this.ctx.storage);let syncCount=0;
    // Negative fault injection AFTER the actual platform promise, never a
    // synthetic successful ACK or caller authority input in production.
    if(mode==="lost-prepare"||mode==="drift-prepare"||mode==="negative-lost-settlement")Object.defineProperty(this.ctx.storage,"sync",{configurable:true,value:async()=>{
      await originalSync();syncCount++;
      if(mode==="lost-prepare"||mode==="negative-lost-settlement"&&syncCount===3)throw Error("physical_ack_lost");
      if(mode==="drift-prepare")this.logGen++;
    }});
    try{
      if(mode==="state"){const row=this.ctx.storage.sql.exec("SELECT driver,action,seq,settled FROM mig_native_action ORDER BY seq DESC LIMIT 1").toArray()[0];return Response.json({driver:row?Array.from(new Uint8Array(row.driver)):null,action:row?Array.from(new Uint8Array(row.action)):null,seq:row?.seq,settled:row?.settled});}
      if(mode==="negative-h1"||mode==="negative-lost-settlement"){
        // Synthetic checkpoint DATA only, not an H0 receipt/positive admission.
        const cpp=this.engine.beginCppClaim();this.engine.signCppClaimChallenge(cpp,new Uint8Array(32).fill(85));this.engine.openMigrationDriver(cpp,claim);this.engine.finishCppClaim(cpp);
        const cp=new Map([[0,1],[1,f.collection],[2,1],[3,"PUBLIC synthetic checkpoint, NOT held backup"],[9,false],[14,0],[20,0],[21,true]]);
        this.ctx.storage.sql.exec("INSERT INTO mig_checkpoint(k,v) VALUES(0,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",encode(cp));await this.ctx.storage.sync();this.openNative();
      }
      const ticket=await this.prepareMigrationPending(request.signal);this.assertMigrationConfirmed(ticket);
      if(mode==="negative-h1"||mode==="negative-lost-settlement"){const result=await this.commitMigrationKeyingWait(ticket,request.signal);return Response.json({result,sequence:ticket.sequence,settled:this.ctx.storage.sql.exec("SELECT settled FROM mig_native_action WHERE seq=?",ticket.sequence).toArray()[0].settled});}
      return Response.json(ticket);
    }catch(error){return Response.json({error:error.message,calls:this.calls},{status:409});}
    finally{if(syncCount)Object.defineProperty(this.ctx.storage,"sync",{configurable:true,value:originalSync});}
  }
}
export class ProbeA extends Probe{}export class ProbeB extends Probe{}
export default{fetch(request,env){const q=new URL(request.url).searchParams,ns=q.get("foreign")==="1"?env.OTHER:env.COLLECTIONS;return ns.get(ns.idFromName(f.collection)).fetch(request);}};
`, resolveDir: fileURLToPath(new URL("../", import.meta.url)), sourcefile: "journal-fixture.ts", loader: "ts" },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], plugins: [
    { name: "owned-native-module", setup(b) { b.onResolve({ filter: /hosted\.wasm$/ }, () => ({ path: "hosted.wasm", external: true })); } },
    { name: "public-fixture-trust", setup(b) { b.onResolve({ filter: /^#hosted-release-trust$/ }, () => ({ path: "public-fixture", namespace: "public-fixture" })); b.onLoad({ filter: /.*/, namespace: "public-fixture" }, () => ({ contents: releaseSource })); } }
  ] });
const wasm = await readFile(wasmPath), prefix = fileURLToPath(new URL("../.test-state/journal-", import.meta.url));
await mkdir(new URL("../.test-state/", import.meta.url), { recursive: true });
const scratch = await mkdtemp(prefix), negativeScratch = await mkdtemp(prefix), oldTmp = process.env.TMPDIR;
process.env.TMPDIR = scratch;
const options = path => convertV4MiniflareOptions({ name: "native-journal-public-fixture", modules: [
  { type: "ESModule", path: "journal-fixture.js", contents: compiled.outputFiles[0].text },
  { type: "CompiledWasm", path: "hosted.wasm", contents: wasm } ], compatibilityDate: "2026-10-05", port: 0,
  durableObjects: { COLLECTIONS: { className: "ProbeA", useSQLite: true }, OTHER: { className: "ProbeB", useSQLite: true } },
  resourcePersistencePath: path, resourceTmpPath: path });
let mf, passed = false;
try {
  mf = new Miniflare(options(scratch));
  const foreign = await mf.dispatchFetch("http://fixture.test/?foreign=1");assert.equal(foreign.status, 409);assert.equal((await foreign.json()).error, "physical_collection_mismatch");
  const prepared = await mf.dispatchFetch("http://fixture.test/");assert.equal(prepared.status, 200, await prepared.clone().text());
  const original = await prepared.json();assert.equal(original.collection, f.collection);assert.equal(original.sequence, 1);assert.equal(original.kind, 0);
  assert.equal((await mf.dispatchFetch("http://fixture.test/")).status, 409);
  await mf.dispose();mf = new Miniflare(options(scratch));
  const state = await (await mf.dispatchFetch("http://fixture.test/?mode=state")).json();
  assert.equal(uuid(state.driver), original.driver);assert.equal(uuid(state.action), original.action);assert.equal(state.seq, 1);assert.equal(state.settled, 0);
  assert.equal((await mf.dispatchFetch("http://fixture.test/")).status, 409, "reopen cannot mint a replacement action");
  await mf.dispose();mf = new Miniflare(options(negativeScratch));
  const settled = await mf.dispatchFetch("http://fixture.test/?mode=negative-h1");assert.equal(settled.status, 200, await settled.clone().text());
  const result = await settled.json();assert.equal(result.settled, 1);assert.match(result.result, /^[0-9a-f]{64}$/);
  await mf.dispose();mf = undefined;
  for(const [mode,expected,settledValue] of [["lost-prepare","physical_ack_lost",0],["drift-prepare","migration_host_changed",0],["negative-lost-settlement","physical_ack_lost",1]]){
    const faultScratch=await mkdtemp(prefix);mf=new Miniflare(options(faultScratch));
    const response=await mf.dispatchFetch(`http://fixture.test/?mode=${mode}`);assert.equal(response.status,409,await response.clone().text());assert.equal((await response.json()).error,expected);
    await mf.dispose();mf=new Miniflare(options(faultScratch));
    const saved=await(await mf.dispatchFetch("http://fixture.test/?mode=state")).json();assert.equal(saved.seq,1);assert.equal(saved.settled,settledValue,"lost ACK does not prove no landed effect/settlement");
    if(!settledValue)assert.equal((await mf.dispatchFetch("http://fixture.test/")).status,409,"original pending UNKNOWN forbids replay");
    await mf.dispose();mf=undefined;await rm(faultScratch,{recursive:true});
  }
  passed = true;
  console.log(`PASS actual native Driver/WASM/real workerd SQLite+storage.sync original pending restart/refused replay/foreign physical ID + negative-H1 atomic settlement physical-output boundary; wasm SHA256=${createHash("sha256").update(wasm).digest("hex")}; PUBLIC synthetic CPP/H0 DATA, no managed/H1-positive qualification`);
} finally {
  await mf?.dispose();if (oldTmp === undefined) delete process.env.TMPDIR;else process.env.TMPDIR = oldTmp;
  if (passed) { await rm(scratch, { recursive: true });await rm(negativeScratch, { recursive: true }); }
  else console.error(`Retained OWN isolated journal evidence: ${scratch}, ${negativeScratch}`);
}
