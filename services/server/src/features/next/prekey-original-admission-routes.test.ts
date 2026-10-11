// Hermetic HTTP + real Ed25519 producer; CP database replies are substituted.
import {createHash,createPrivateKey,sign,verify} from "node:crypto";
import Fastify from "fastify";
import {describe,expect,it} from "vitest";
import type {DatabasePool} from "../../database-types.js";
import {registerLabPitrRoutes} from "./lab-pitr-routes.js";
import {LogServiceClient} from "./log-service-client.js";
import {certToJson,ed25519PublicKeyObject,ed25519RawPublicKey,loadPolicySigner,type NextControlPlaneConfig} from "./policy-keys.js";
import {certDigest,decodeCbor,domainHash,keyId,signPolicyItem} from "./policy-wire.js";
const A="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",D="dddddddd-dddd-4ddd-addd-dddddddddddd",OWNER="11111111-1111-4111-a111-111111111111";
const TOKEN="p".repeat(40),NOW=1791100000000,CHALLENGE="35".repeat(32),NIL="00000000-0000-0000-0000-000000000000";
// PUBLIC SYNTHETIC TEST SEEDS ONLY.
const key=(n:number)=>createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),Buffer.alloc(32,n)]),format:"der",type:"pkcs8"});
async function fixture(failure?:string){
  const root=key(0x31),policy=key(0x32),issuer=key(0x33),transport=key(0x34),rootPk=ed25519RawPublicKey(root);
  const certify=(k:ReturnType<typeof key>)=>{const c={policyPublicKey:ed25519RawPublicKey(k),notBefore:1790000000000,notAfter:1800000000000,root:keyId(rootPk)};return {...c,signature:sign(null,certDigest(c),root)};};
  const cert=certify(policy),oldCert=certify(transport),pem=(k:ReturnType<typeof key>)=>k.export({type:"pkcs8",format:"pem"}).toString();
  const pitr={run:"gate4-pitr-lab-20261009-01" as const,active:A,deleted:D,owner:OWNER,createdAfter:1,logUrl:"https://synthetic-log.example.test",hostedUrl:"https://synthetic-hosted.example.test"};
  const next:NextControlPlaneConfig={rootPublicKey:rootPk,policyPrivateKeyPem:pem(policy),policyCert:certToJson(cert),
    logService:{url:"https://normal.example.test",tokenIssuerKeyPem:pem(issuer),transportKeyPem:pem(transport),labPitr:pitr},serviceTokens:{},pitrAuthorityToken:TOKEN};
  const signer=loadPolicySigner(next,NOW),log=new LogServiceClient(next.logService,async()=>{throw Error("unexpected_network");});
  const originals=new Map([A,D].map(collection=>[collection,Buffer.from(signPolicyItem({cert:oldCert,privateKey:transport},
    {collection,seq:1,prev:Buffer.alloc(32),issuedAt:NOW-10000,previousIssuedAt:0,ops:[{op:"genesis",owner:OWNER,root:keyId(rootPk),state:failure==="e2e"?"e2e":"cloud-copy"}]}))]));
  let now=NOW,connects=0,releases=0,originalReads=0;const queries:string[]=[];
  let commitResolve:()=>void=()=>{},commitReachedResolve:()=>void=()=>{};
  const heldCommit=new Promise<void>(resolve=>{commitResolve=resolve;}),commitReached=new Promise<void>(resolve=>{commitReachedResolve=resolve;});
  const query=async(sql:string,values:unknown[]=[])=>{
    queries.push(sql);
    if(sql==="COMMIT"){
      if(failure==="held-commit"){commitReachedResolve();await heldCommit;}
      if(failure==="commit-loss")throw Error("synthetic unknown commit");
      if(failure==="expired-commit")now+=10000;
      if(failure==="clock-backward")now--;
      return {rows:[]};
    }
    if(sql==="BEGIN"||sql==="ROLLBACK"||sql.startsWith("SET LOCAL")||sql.includes("pg_advisory_xact_lock")){
      if(failure==="lock"&&sql.includes("pg_advisory_xact_lock"))throw Error("synthetic lock failure");return {rows:[]};
    }
    if(sql.includes("FROM next_collection_deletion_facts"))return {rows:failure==="deleted"?[{one:1}]:[]};
    if(sql.includes("SELECT n.root_key_id"))return {rows:failure==="unadmitted"?[]:[{root_key_id:failure==="root-drift"?Buffer.alloc(16,9):Buffer.from(cert.root)}]};
    if(sql.includes("e.value->>'role' IS DISTINCT FROM 'owner'"))return {rows:failure==="owner-removal"?[{one:1}]:[]};
    if(sql.includes("CASE WHEN octet_length(item)")){
      originalReads++;let item=originals.get(String(values[0]));
      if(failure==="missing-original")return {rows:[]};
      if(item&&failure==="signature-tamper"){item=Buffer.from(item);item[item.length-1]!^=1;}
      if(failure==="original-drift"&&originalReads>1)item=originals.get(D);
      const row={state:failure==="parked"?"parked":"appended",lost_at:failure==="lost"?new Date(0):null,item:failure==="oversized"?null:item};
      if(failure==="ambiguous")return {rows:[row,row]};
      if(failure==="lost-reissued")return {rows:[{...row,lost_at:new Date(0)},row]};
      return {rows:[row]};
    }
    if(sql.includes("FROM next_policy_outbox")&&values[1]){
      const op=JSON.parse(String(values[1]))[0];expect(op.op).toBe("cp-key-revoke");
      if(failure==="clock-expired")now=cert.notAfter;
      if(failure==="identity-drift")identity={...identity,issuerPublicKey:"09".repeat(32)};
      return {rows:failure==="signing-key-revoked"||failure==="original-key-revoked"&&op.keyId.$hex===Buffer.from(keyId(oldCert.policyPublicKey)).toString("hex")?[{one:1}]:[]};
    }
    throw Error("unrecognized synthetic SQL");
  };
  const db={async connect(){connects++;if(failure==="database")throw Error("synthetic database unavailable");return {query,release(){releases++;}};},query,async end(){}} as unknown as DatabasePool;
  let identity=log.pitrAdmissionIdentity()!;
  const app=Fastify();registerLabPitrRoutes(app,{db,next,log,now:()=>failure==="invalid-clock"?NaN:now,
    ...(failure==="missing-source"?{}:{admission:{signer,audience:failure==="audience"?"http://connect-lab.mdbase.dev":"https://connect-lab.mdbase.dev",
      identity:{pitrAdmissionIdentity:()=>failure==="missing-issuer"?null:failure==="issuer-id-only"?{transportPublicKey:identity.transportPublicKey,issuerPublicKey:"09".repeat(16)}:identity}}})});
  const request=(change:object={},authorization=`Bearer ${TOKEN}`,suffix="")=>app.inject({method:"POST",url:"/internal/v1/next/lab-pitr/original-cp-admission"+suffix,
    headers:{authorization},payload:{collection:A,challenge:CHALLENGE,...change}});
  return {app,request,queries,originals,signer,counts:()=>({connects,releases}),commitReached,releaseCommit:commitResolve};
}
describe("CP-only admitted original HTTP source",()=>{
  it("authenticates and validates exact challenge/selector before CP SQL",async()=>{
    const f=await fixture();try{
      expect((await f.request({},"Bearer wrong")).statusCode).toBe(401);
      for(const invalid of [{device:A},{owner:OWNER},{root:"01".repeat(32)},{purpose:"other"},{challenge:"00".repeat(32)},{challenge:CHALLENGE+"\n"},
        {challenge:"AB".repeat(32)},{collection:NIL}])expect((await f.request(invalid)).statusCode).toBe(400);
      expect((await f.request({},`Bearer ${TOKEN}`,"?role=cp")).statusCode).toBe(400);
      expect((await f.request({collection:OWNER})).statusCode).toBe(409);expect(f.queries).toEqual([]);expect(f.counts().connects).toBe(0);
    }finally{await f.app.close();}
  });
  it("emits exact signed CP-null admission from loaded existing keys and locked raw originals",async()=>{
    const f=await fixture();try{
      for(const collection of [A,D]){
        const r=await f.request({collection});expect(r.statusCode).toBe(200);expect(r.headers["cache-control"]).toBe("no-store");
        expect(Object.keys(r.json()).sort()).toEqual(["admission","expires_at"]);
        const outer=decodeCbor(Buffer.from(r.json().admission,"base64"),{maxDepth:5,canonicalStructs:true}) as [number,Uint8Array,Map<number,unknown>,Uint8Array];
        const c=decodeCbor(outer[1],{maxDepth:2,canonicalStructs:true}) as unknown[];expect(c).toHaveLength(17);expect(c.slice(11,14)).toEqual([null,null,null]);
        expect(Buffer.from(c[4] as Uint8Array).toString("hex")).toBe(collection.replaceAll("-",""));
        expect(Buffer.from(c[9] as Uint8Array)).toEqual(createHash("sha256").update(f.originals.get(collection)!).digest());
        expect(Buffer.from(c[14] as Uint8Array).toString("hex")).toBe(CHALLENGE);
        expect(verify(null,domainHash("mdbase/v1/prekey-original-admission",outer[1]),ed25519PublicKeyObject(f.signer.cert.policyPublicKey),outer[3])).toBe(true);
      }
      expect(f.counts()).toEqual({connects:2,releases:2});expect(f.queries.filter(q=>q==="COMMIT")).toHaveLength(2);
      expect(f.queries.some(q=>/INSERT|UPDATE|DELETE/.test(q)&&!q.includes("FOR SHARE"))).toBe(false);
    }finally{await f.app.close();}
  });
  it.each(["missing-source","missing-issuer","issuer-id-only","unadmitted","root-drift","owner-removal","missing-original","lost","ambiguous","lost-reissued",
    "oversized","parked","signature-tamper","e2e","original-drift","signing-key-revoked","original-key-revoked","identity-drift","clock-expired","invalid-clock",
    "expired-commit","clock-backward","commit-loss","lock","database","audience"])("refuses source drift/failure without signed success: %s",async failure=>{
    const f=await fixture(failure);try{const r=await f.request();expect([409,503]).toContain(r.statusCode);expect(r.json().admission).toBeUndefined();expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.body).not.toContain("synthetic");expect(f.counts().releases).toBe(f.counts().connects-(failure==="database"?1:0));
    }finally{await f.app.close();}
  });
  it("holds signed output until the actual COMMIT promise settles",async()=>{
    const f=await fixture("held-commit");try{
      let done=false;const pending=f.request().then(r=>{done=true;return r;});await f.commitReached;await new Promise(resolve=>setImmediate(resolve));expect(done).toBe(false);
      f.releaseCommit();expect((await pending).statusCode).toBe(200);expect(f.counts().releases).toBe(1);
    }finally{f.releaseCommit();await f.app.close();}
  });
});
