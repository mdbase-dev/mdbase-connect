// Local synthetic fixtures only. Uses the unmodified production HostedCollection
// handlers, WASM, Noise, admission, object reader and SQLite in actual workerd.
import { WorkerEntrypoint } from "cloudflare:workers";
import { HostedCollection } from "../src/worker.ts";
import { Engine } from "../src/engine.ts";
import { decode, encode, type CborValue } from "../../../packages/sdk/src/cbor.ts";
interface TestEnv { FIXTURES: Fetcher; COLLECTIONS: DurableObjectNamespace; LOG: Fetcher; FIXTURE_SIGN_PK:string; }
const hex = (v: Uint8Array) => [...v].map(x => x.toString(16).padStart(2,"0")).join("");
let objectFetches = 0, verifiedPoPs=0;
const unhex=(s:string)=>Uint8Array.from(s.match(/../g)??[],h=>parseInt(h,16));
const sha=async(b:Uint8Array)=>new Uint8Array(await crypto.subtle.digest("SHA-256",b));
const concat=(...parts:Uint8Array[])=>{const out=new Uint8Array(parts.reduce((n,b)=>n+b.length,0));let p=0;for(const b of parts){out.set(b,p);p+=b.length;}return out;};
const methods: Record<string,number> = {};
let holdObjects=false, objectWaiting=0;
const releases: (()=>void)[]=[];
async function fixture(env: TestEnv): Promise<Map<number,CborValue>> {
 const r = await env.FIXTURES.fetch("https://fixture/fixture.cbor");
 if (!r.ok) throw Error("fixture unavailable");
 return decode(new Uint8Array(await r.arrayBuffer())) as Map<number,CborValue>;
}
// Test-only control can retire native authority, not manufacture admission.
// No test hook or request route is added to the shipped Worker.
export class NoiseHosted extends HostedCollection {
 async fetch(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if(path === "/harness/status") {
   const state = this as unknown as {engine:Engine|null;attachmentPermit:{session:number}|null};
   const proof=state.engine?.admission();
   return Response.json({serving:state.engine?.serving(),held:!!state.attachmentPermit,active:state.attachmentPermit ? state.engine?.attachmentActive(state.attachmentPermit.session):false,admission:Array.isArray(proof)?proof[0]:null});
  }
  if(path === "/harness/stale") {
   for(const ws of this.ctx.getWebSockets()) {
    const a=ws.deserializeAttachment() as Record<string,unknown>;
    ws.serializeAttachment({...a,wake:"ended-synthetic-wake"});
   }
   return Response.json({stale:true});
  }
  if(path === "/harness/retire") {
   const engine = (this as unknown as {engine:Engine|null}).engine;
   if(!engine) throw Error("no engine to retire");
   engine.logRetire();
   return Response.json({retired:true});
  }
  return super.fetch(request);
 }
}
export class FixtureLog extends WorkerEntrypoint<TestEnv> {
 async fetch(request: Request): Promise<Response> {
  const u = new URL(request.url);
  if(u.pathname === "/harness/counts") return Response.json({objectFetches,objectWaiting,verifiedPoPs,methods});
  if(u.pathname === "/harness/hold") {holdObjects=true;return Response.json({holding:true});}
  if(u.pathname === "/harness/release") {holdObjects=false;for(const release of releases.splice(0))release();return Response.json({released:true});}
  if(u.pathname === "/v1/nonce") return new Response("ab".repeat(32));
  const f = await fixture(this.env);
  const descriptors = f.get(7) as [Uint8Array,number,string][];
  if(u.hostname === "objects.test") {
   const d = descriptors.find(d => "/"+d[2] === u.pathname);
   if(!d || request.headers.get("range") !== `bytes=0-${d[1]-1}`) return new Response(null,{status:416});
   objectFetches++;
   if(holdObjects){objectWaiting++;try{await new Promise<void>(r=>releases.push(r));}finally{objectWaiting--;}}
   const r = await this.env.FIXTURES.fetch("https://fixture/"+d[2]);
   return new Response(r.body,{status:206,headers:{
    "content-length":String(d[1]), "content-range":`bytes 0-${d[1]-1}/${d[1]}`,
    "x-amz-checksum-sha256":btoa(String.fromCharCode(...d[0])),
   }});
  }
  if(u.pathname !== "/v1/rpc" || request.method !== "POST") return new Response(null,{status:404});
  // Small, bounded synthetic metadata request. File bodies never arrayBuffer().
  const bytes = new Uint8Array(await request.arrayBuffer());
  if(bytes.length > 1<<20) return new Response(null,{status:413});
  const q = decode(bytes) as Map<number,CborValue>;
  if(request.headers.get("authorization") !== "Bearer synthetic-local-only" ||
     request.headers.get("x-mdbase-nonce") !== "ab".repeat(32) ||
     !/^[0-9a-f]{128}$/.test(request.headers.get("x-mdbase-sig") ?? "")) throw Error("missing native PoP");
  const method=String(q.get(2));
  const encoder=new TextEncoder(), p0=(q.get(3) as Map<number,CborValue>).get(0);
  const key0=p0 instanceof Uint8Array&&p0.length===16?p0:new Uint8Array(16);
  const tag=encoder.encode("mdbase/v1/ls-http");
  const digest=await sha(concat(Uint8Array.of(tag.length),tag,encoder.encode(method),Uint8Array.of(0),encoder.encode("/v1/rpc"),Uint8Array.of(0),key0,await sha(encoder.encode("synthetic-local-only")),await sha(bytes),unhex("ab".repeat(32))));
  const publicKey=await crypto.subtle.importKey("raw",unhex(this.env.FIXTURE_SIGN_PK),{name:"Ed25519"},false,["verify"]);
  if(!await crypto.subtle.verify({name:"Ed25519"},publicKey,unhex(request.headers.get("x-mdbase-sig")!),digest))throw Error("native PoP signature mismatch");
  verifiedPoPs++;methods[method]=(methods[method]??0)+1;
  const p = q.get(3) as Map<number,CborValue>, items = f.get(1) as Uint8Array[];
  let result:CborValue;
  switch(q.get(2)) {
   case "head": result=new Map<number,CborValue>([[0,items.length],[1,f.get(8)!],[2,1]]);break;
   case "read": result=new Map<number,CborValue>([
    [0,items.map((b,i)=>[i+1,b]).filter(([i,b])=>Number(i)>Number(p.get(1)) &&
     (p.get(3)!==1 || [2,3,4,5,6].includes(Number((decode(b as Uint8Array) as Map<number,CborValue>).get(1)))))],
    [1,items.length],[2,f.get(8)!],[3,1],[4,false],[6,false],
   ]);break;
   case "get_object": {
    const address = p.get(1) as Uint8Array;
    const d=descriptors.find(d=>hex(d[0])===hex(address));
    if(!d) throw Error("unknown object");
    result=new Map<number,CborValue>([[1,new Map<number,CborValue>([
     [0,"https://objects.test/"+d[2]],[1,new Map()],[2,Date.now()+60_000],
    ])],[2,d[1]],[3,d[0]]]);break;
   }
   default: throw Error("unexpected fixture method");
  }
  return new Response(encode(new Map<number,CborValue>([[0,1],[1,q.get(1)!],[2,result]])),{headers:{"content-type":"application/cbor"}});
 }
}
export default {
 fetch(request:Request,env:TestEnv):Promise<Response> {
  const u=new URL(request.url);
  if(["/harness/counts","/harness/hold","/harness/release"].includes(u.pathname)) return env.LOG.fetch(request);
  const scenario=u.searchParams.get("case") ?? "positive";
  if(!["positive","await","stale"].includes(scenario))return Promise.resolve(new Response(null,{status:400}));
  return env.COLLECTIONS.get(env.COLLECTIONS.idFromName("synthetic-noise-"+scenario)).fetch(request);
 }
};
