// Real local native namespace/IDs; actual LOG wrapper, synthetic CLOSED native
// base and phase. This does not qualify the Rust auth/service or managed PITR.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,mkdirSync,mkdtempSync,rmSync} from "node:fs";
import {dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
const source=`
import {LogCollection as Required,default as required} from "../../cloudflare-do/src/pitr-worker.mjs";
const A="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",D="dddddddd-dddd-4ddd-addd-dddddddddddd",NIL="00000000-0000-0000-0000-000000000000";
function configured(env){let gets=0;const binding={run:"gate4-pitr-lab-20261009-01",active:A,deleted:D,codeConfigSha256:"ab".repeat(32),members:[
  ...[A,D].map(collection=>({kind:"log",collection,namespace:"01".repeat(16),object:env.LOG.idFromName(collection).toString()})),
  {kind:"registry",collection:NIL,namespace:"01".repeat(16),object:env.LOG.idFromName(NIL).toString()},
  ...[A,D].map(collection=>({kind:"hosted",collection,namespace:"02".repeat(16),object:env.HOSTED.idFromName(collection).toString()}))]};
  const scoped=Object.create(env);Object.defineProperties(scoped,{PITR_BINDING:{value:JSON.stringify(binding)},PITR_MINIMUM_EPOCH:{value:"1"},PITR_PHASE:{value:{async get(){
    gets++;const bytes=new TextEncoder().encode(JSON.stringify({schema:"mdbn-lab-pitr-phase/1",binding,epoch:7,phase:"seed",issuedAt:Date.now()-1000,expiresAt:Date.now()+60000}));
    return {size:bytes.length,body:new ReadableStream({start(c){c.enqueue(bytes);c.close();}})};}}}});
  for(const key of ["LOGSVC_ROOT_KEYS","LOGSVC_TOKEN_ISSUERS","LOGSVC_URL_SECRET","OBJECTS","METRICS"])
    Object.defineProperty(scoped,key,{get(){throw Error("forbidden secret/native ordinary binding");}});
  return {scoped,gets:()=>gets};
}
class Harness extends Required{
  constructor(ctx,env){const f=configured(env);super(ctx,f.scoped);this.phaseGets=f.gets;}
  async fetch(request){const r=await super.fetch(request);return Response.json({status:r.status,noStore:r.headers.get("cache-control"),
    restriction:this.test_restriction!==null,cut:this.test_cut!==null,phaseGets:this.phaseGets(),drained:this.test_work.drained});}
}
export class Logs extends Harness{} export class Hosted extends Harness{} export class Foreign extends Harness{}
export default {fetch(request,env){const u=new URL(request.url),kind=u.searchParams.get("kind"),c=u.searchParams.get("c"),url="https://actor.test/v1/rpc?c="+c;
  if(kind==="route")return required.fetch(new Request(url,{method:"POST"}),configured(env).scoped);
  const ns=kind==="hosted"?env.HOSTED:kind==="foreign"?env.FOREIGN:env.LOG;
  return ns.getByName(c).fetch(new Request(url,{method:"POST"}));}};
`;
const compiled=await build({stdin:{resolveDir:fileURLToPath(new URL("./",import.meta.url)),sourcefile:"pitr-log-namespace.js",loader:"js",contents:source},bundle:true,write:false,format:"esm",platform:"browser",external:["cloudflare:workers"],plugins:[{name:"closed-base-and-private-test-view",setup(b){
  b.onLoad({filter:/cloudflare-do\/src\/pitr-worker\.mjs$/},args=>({contents:readFileSync(args.path,"utf8").replace(/#(state|work|restriction|cut|stopResources)\b/g,"test_$1"),loader:"js"}));
  b.onResolve({filter:/build\/worker\/shim\.mjs$/},()=>({path:"native",namespace:"fake"}));
  b.onLoad({filter:/.*/,namespace:"fake"},()=>({contents:`import {DurableObject} from "cloudflare:workers";export class LogCollection extends DurableObject{
    constructor(ctx,env){super(ctx,env);if(env.LOGSVC_PITR_REQUIRED!=="1")throw Error("ordinary constructor");ctx.setWebSocketAutoResponse(undefined);}
    async alarm(){await this.ctx.storage.deleteAlarm();return new Response(null);}
    async webSocketMessage(ws){ws.close(1008,"PITR closed");} async webSocketError(ws){ws.close(1008,"PITR closed");}async webSocketClose(){}
  }`}));
}}]});
const A="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",D="dddddddd-dddd-4ddd-addd-dddddddddddd",NIL="00000000-0000-0000-0000-000000000000";
test("real LOG namespace restricts A/D/nil while hosted/foreign/nonmember refuse; actual outer stays503",async()=>{
  const prefix=fileURLToPath(new URL("../../../target/pl-",import.meta.url));mkdirSync(dirname(prefix),{recursive:true});const scratch=mkdtempSync(prefix),oldTmp=process.env.TMPDIR;
  process.env.TMPDIR=scratch;let mf,passed=false;
  try{
    mf=new Miniflare(convertV4MiniflareOptions({name:"pitr-log-native-namespace",modules:true,script:compiled.outputFiles[0].text,compatibilityDate:"2026-10-05",
      durableObjects:{LOG:{className:"Logs",useSQLite:true},HOSTED:{className:"Hosted",useSQLite:true},FOREIGN:{className:"Foreign",useSQLite:true}},resourcePersistencePath:scratch,resourceTmpPath:scratch,port:0}));
    for(const [kind,c,valid] of [["log",A,true],["log",D,true],["log",NIL,true],["hosted",A,false],["hosted",D,false],["foreign",A,false],["foreign",NIL,false],["log","33333333-3333-4333-a333-333333333333",false]]){
      const r=await mf.dispatchFetch("https://fixture.test/?kind="+kind+"&c="+c);assert.equal(r.status,200,await r.clone().text());
      assert.deepEqual(await r.json(),{status:503,noStore:"no-store",restriction:valid,cut:valid,phaseGets:valid?1:0,drained:true});
    }
    for(const c of [A,D,NIL]){const r=await mf.dispatchFetch("https://fixture.test/?kind=route&c="+c);assert.equal(r.status,503);assert.equal(r.headers.get("cache-control"),"no-store");}
    passed=true;
  }finally{await mf?.dispose();if(oldTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=oldTmp;if(passed)rmSync(scratch,{recursive:true});else console.error("Retained local LOG evidence: "+scratch);}
});
