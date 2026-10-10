// Hermetic CP adapter tests: SQL responses substituted, no real PG/LAB/provider.
import { createHash, generateKeyPairSync } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { describe, expect, it } from "vitest";
import type { DatabasePool } from "../../database-types.js";
import { APPLICATION_CAPABILITY_DEFINITIONS } from "@mdbase-dev/connect-protocol";
import { projectNextGrant, type NextGrantSource } from "./grant-policy.js";
import { registerLabPitrRoutes } from "./lab-pitr-routes.js";
import { ed25519RawPublicKey, type NextControlPlaneConfig } from "./policy-keys.js";
import { keyId, signPolicyItem } from "./policy-wire.js";
const A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", D = "dddddddd-dddd-4ddd-addd-dddddddddddd";
const OWNER = "11111111-1111-4111-a111-111111111111", DEVICE = "22222222-2222-4222-a222-222222222222", HOSTED = "33333333-3333-4333-a333-333333333333";
const TOKEN = "p".repeat(40), ROOT = Buffer.alloc(16, 6), NOW = 1000;
const GRANT = "44444444-4444-4444-a444-444444444444";
const grantSource: NextGrantSource = { collection:A,sync:"cloud_copy",user_id:OWNER,application_id:"synthetic.reader",
  application_installation_id:HOSTED,declaration:"synthetic.reader",operations:[...APPLICATION_CAPABILITY_DEFINITIONS["collection.read"]],
  file_capability:{kind:"files",protocol_version:1,actions:["list","read"],scope:{kind:"collection"}},
  scope:{access:"full_collection",contracts:[]},semantic:2,client_pk:Buffer.alloc(32,5) };
const peer = (id = DEVICE) => ({ id, account: id === HOSTED ? "00000000-0000-0000-0000-000000000000" : OWNER,
  kind: id === HOSTED ? "hosted" : "cli", sign_pk: Buffer.alloc(32,2), kem_pk: Buffer.alloc(32,3), noise_pk: Buffer.alloc(32,4) });
async function fixture(failure?: string) {
  const privateKey = generateKeyPairSync("ed25519").privateKey;
  const cert = { policyPublicKey: ed25519RawPublicKey(privateKey), notBefore: 0, notAfter: 10000, root: ROOT, signature: Buffer.alloc(64,8) };
  const items = new Map([A,D].map(collection => [collection, Buffer.from(signPolicyItem({privateKey,cert}, {
    collection,seq:1,prev:Buffer.alloc(32),issuedAt:500,previousIssuedAt:0,
    ops:[{op:"genesis",owner:failure==="cp-genesis-owner"?HOSTED:OWNER,root:failure==="cp-genesis-root"?Buffer.alloc(16,9):ROOT,state:"cloud-copy"}]
  }))])); // Ephemeral test signer; not a deployed policy issuer.
  const hashes = Object.fromEntries([...items].map(([id,item]) => [id,createHash("sha256").update(item).digest("hex")]));
  const queries: string[] = [], writes: string[] = []; let connects = 0, releases = 0, now = NOW;
  const query = async (sql: string, values: unknown[] = []) => {
    queries.push(sql);
    if (failure === "lock" && sql.includes("pg_advisory_xact_lock")) throw Error("synthetic private database detail");
    if (sql.startsWith("INSERT")) { writes.push(sql); return {rows:[]}; }
    if (sql.startsWith("SELECT sync")) return {rows: failure === "queue" ? [] : [{sync:"cloud_copy"}]};
    if (sql.includes("FROM sessions s")) return {rows:failure === "session" ? [] : [{one:1}]};
    if (sql.includes("FROM next_collection_deletion_facts")) {
      if (sql.includes("ORDER BY")) return {rows:[{collection_id:D,deletion_id:HOSTED,epoch:"1"}]};
      return {rows:failure === "deleted" ? [{one:1}] : []};
    }
    if (sql.includes("SELECT n.root_key_id")) return {rows:failure === "parent" ? [] : [{root_key_id:failure === "root" ? Buffer.alloc(16,9) : ROOT}]};
    if (sql.includes("e.value->>'op' AS op")) return {rows:[{op:failure === "member" ? "member-remove" : "member-set",role:"owner"}]};
    if (sql.includes("CASE WHEN octet_length(item)")) {
      if (failure==="genesis") return {rows:[]};
      const item=items.get(String(values[0]));
      const row={state:failure==="cp-sending"?"sending":failure==="cp-parked"?"parked":"appended",item,lost_at:failure==="cp-lost"?new Date(0):null};
      if(failure==="cp-duplicate")return {rows:[row,row]};
      if(failure==="cp-lost-with-live-reissue")return {rows:[{...row,lost_at:new Date(0)},{...row,state:"sending"}]};
      if(failure==="cp-missing-loss")return {rows:[{state:"sending",item}]};
      return {rows:[row]};
    }
    if (sql.includes("e.value->>'role' IS DISTINCT FROM 'owner'")) {
      expect(sql).not.toContain("b.state = 'appended'"); expect(values).toEqual([A,OWNER]);
      return {rows:["cp-owner-remove","cp-owner-downgrade"].includes(failure??"")?[{one:1}]:[]};
    }
    if (sql.includes("SELECT device_id::text FROM next_service_devices")) return {rows:failure === "survivor" ? [] : [{device_id:HOSTED}]};
    if (sql.includes("device_id::text AS id")) return {rows:values[1] === HOSTED ? [peer(HOSTED)] : []};
    if (sql.includes("FROM next_devices d")) return {rows:failure === "identity" ? [] : [{...peer(),kind:failure === "kind" ? "mobile" : "cli",sign_pk:failure === "key" ? Buffer.alloc(32,9) : peer().sign_pk}]};
    if (sql.includes("SELECT grant_id::text FROM next_grant_bindings")) return {rows:failure==="grant-binding"?[]:[{grant_id:DEVICE}]};
    if (sql==="SELECT id FROM grants WHERE id=$1 FOR SHARE") return {rows:failure==="grant-lock"?[]:[{id:DEVICE}]};
    if (sql.includes("FROM next_grant_bindings b JOIN grants g")) { expect(sql).toContain("AND g.id=$5"); expect(values).toEqual([A,GRANT,OWNER,1,DEVICE]); return {rows:["grant-row","grant-rebound"].includes(failure??"")?[]:[{...grantSource,
      collection:failure==="grant-collection"?D:A,scope:failure==="grant-scope"?{access:"selected_contracts",contracts:[]}:grantSource.scope,
      client_pk:failure==="grant-key"?Buffer.alloc(32,9):failure==="grant-zero"?Buffer.alloc(32):grantSource.client_pk,
      terms_digest:failure==="grant-terms"?Buffer.alloc(32,9):projectNextGrant(grantSource).terms}]}; }
    if (sql.includes("FROM next_policy_outbox")) {
      const op = JSON.parse(String(values[1]))[0];
      if (op.op === "grant-revoke") return {rows:failure==="grant-revoked"?[{one:1}]:[]};
      if (op.op === "grant") {
        expect(op).toEqual({...projectNextGrant(grantSource).policy,grant:GRANT,clientPublicKey:{$hex:grantSource.client_pk!.toString("hex")}});
        if(failure==="grant-clock") now=cert.notAfter;
        return {rows:failure==="grant-pending"?[]:[{one:1}]};
      }
      if (op.op === "device-revoke") return {rows:failure === "revoked" ? [{one:1}] : []};
      if (op.op === "cp-key-revoke") { if(failure==="cp-clock")now=cert.notAfter; return {rows:failure === "security-key" ? [{one:1}] : []}; }
      if (op.op === "device-enrol") {
        expect(op).toHaveProperty("signPublicKey"); expect(op).toHaveProperty("kemPublicKey"); expect(op).toHaveProperty("noisePublicKey");
        if (failure === "clock") now = cert.notAfter;
        return {rows:failure === "enrolment" ? [] : [{one:1}]};
      }
    }
    return {rows:[]};
  };
  const db = { async connect() { connects++; if (failure === "database") throw Error("synthetic database unavailable"); return {query,release(){releases++;}}; },
    async query() { return {rows:[{id:failure === "owner" ? HOSTED : OWNER,session_id:DEVICE,last_seen_at:new Date(),email:"synthetic@example.test",name:"Synthetic",authentication_provider:"session"}]}; }, async end(){} } as unknown as DatabasePool;
  const next = { rootPublicKey:Buffer.alloc(32,1),policyPrivateKeyPem:"synthetic unused",policyCert:{policy_public_key:Buffer.from(cert.policyPublicKey).toString("hex"),not_before:0,not_after:10000,root_key_id:ROOT.toString("hex"),signature:"08".repeat(64)},
    logService:{url:"https://normal.example.test",tokenIssuerKeyPem:"synthetic unused",transportKeyPem:"synthetic unused",labPitr:{run:"gate4-pitr-lab-20261009-01",active:A,deleted:D,owner:OWNER,createdAfter:1,logUrl:"https://synthetic-log.example.test",hostedUrl:"https://synthetic-hosted.example.test"}},
    serviceTokens:{},pitrAuthorityToken:TOKEN } satisfies NextControlPlaneConfig;
  const app = Fastify(); await app.register(cookie); registerLabPitrRoutes(app,{db,next,now:()=>now,log:{pitrControlIdentity:()=>failure==="cp-identity"?null:{transportPublicKey:"07".repeat(32),issuerKeyId:"08".repeat(16)},labPitrCollectionDeletions:async()=>{if(failure==="registry")throw Error("synthetic registry unavailable");return {generation:7n,after:null,done:true,rows:[]};}}});
  const body = {run:next.logService.labPitr.run,collection:A,device:DEVICE,kind:"cli",signPublicKey:peer().sign_pk.toString("hex"),genesisSha256:hashes[A],policyKeyId:Buffer.from(keyId(cert.policyPublicKey)).toString("hex")};
  const current = (change:object={},authorization=`Bearer ${TOKEN}`) => app.inject({method:"POST",url:"/internal/v1/next/lab-pitr/current",headers:{authorization},payload:{...body,...change}});
  const mutate = (change:object={},origin="https://connect-lab.mdbase.dev") => app.inject({method:"POST",url:"/v1/next/lab-pitr/delete-revoke",headers:{origin,cookie:"mdbase_session=synthetic-session"},payload:{run:body.run,device:DEVICE,activeGenesisSha256:hashes[A],deletedGenesisSha256:hashes[D],...change}});
  const grantBody={run:body.run,principal:"app-grant",collection:A,grant:GRANT,clientPublicKey:grantSource.client_pk!.toString("hex"),genesisSha256:hashes[A],policyKeyId:body.policyKeyId};
  const currentGrant=(change:object={},authorization=`Bearer ${TOKEN}`)=>app.inject({method:"POST",url:"/internal/v1/next/lab-pitr/current-app-grant",headers:{authorization},payload:{...grantBody,...change}});
  const cpBody={run:body.run,principal:"control-plane",purpose:"pending-original-genesis",collection:A,
    genesisSha256:hashes[A],transportPublicKey:"07".repeat(32),issuerKeyId:"08".repeat(16),policyKeyId:body.policyKeyId};
  const currentCp=(change:object={},authorization=`Bearer ${TOKEN}`)=>app.inject({method:"POST",url:"/internal/v1/next/lab-pitr/current-cp-genesis",headers:{authorization},payload:{...cpBody,...change}});
  return {app,current,mutate,currentGrant,grantBody,currentCp,cpBody,queries,writes,body,counts:()=>({connects,releases})};
}
describe("fixed-run current CP adapter", () => {
  it("authenticates and validates scope before authority SQL", async () => {
    const f=await fixture(); try {
      expect((await f.current({},"Bearer wrong")).statusCode).toBe(401);
      for(const change of [{run:"other"},{current:true},{kind:"app"}]) expect((await f.current(change)).statusCode).toBe(400);
      for(const change of [{collection:HOSTED},{policyKeyId:"ff".repeat(16)}]) expect((await f.current(change)).statusCode).toBe(409);
      expect(f.queries).toEqual([]); expect(f.counts().connects).toBe(0);
    } finally {await f.app.close();}
  });
  it("checks original hash, kind, exact key and floors before a no-store point observation", async () => {
    const f=await fixture(); try {
      const r=await f.current(); expect(r.statusCode).toBe(200); expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.json()).toEqual({...f.body,current:true,checkedAt:NOW}); expect(f.writes).toEqual([]); expect(f.queries.at(-1)).toBe("COMMIT");
      expect(f.queries.some(q=>q.includes("n.created_at>=to_timestamp"))).toBe(true);
    } finally {await f.app.close();}
  });
  it.each(["deleted","parent","root","member","genesis","identity","kind","key","revoked","security-key","enrolment","clock","lock","database"])("keeps %s closed and emits no positive observation", async failure => {
    const f=await fixture(failure); try {
      const r=await f.current(); expect([409,503]).toContain(r.statusCode); expect(r.json()).not.toHaveProperty("current");
      expect(r.body).not.toContain("synthetic private database detail"); expect(f.writes).toEqual([]);
      if(failure!=="database") {expect(f.queries.at(-1)).toBe("ROLLBACK");expect(f.counts().releases).toBe(1);}
    } finally {await f.app.close();}
  });
  it("refuses wrong signed-original hash", async () => {
    const f=await fixture(); try {expect((await f.current({genesisSha256:"ff".repeat(32)})).statusCode).toBe(409);} finally {await f.app.close();}
  });
});
describe("distinct CP original sending-genesis observation",()=>{
  it("requires exact principal/public identity and authority bearer before SQL",async()=>{
    const f=await fixture();try{
      expect((await f.currentCp({},"Bearer wrong")).statusCode).toBe(401);
      for(const change of [{principal:"device"},{principal:"app-grant"},{purpose:"nil"},{device:DEVICE},{transportPublicKey:"00".repeat(32)}]) expect((await f.currentCp(change)).statusCode).toBe(400);
      for(const change of [{collection:HOSTED},{transportPublicKey:"09".repeat(32)},{issuerKeyId:"09".repeat(16)},{policyKeyId:"09".repeat(16)}]) expect((await f.currentCp(change)).statusCode).toBe(409);
      expect(f.queries).toEqual([]);expect(f.counts().connects).toBe(0);
    }finally{await f.app.close();}
  });
  it.each([undefined,"cp-sending"])("observes only the original %s bytes without a publication/membership ACK",async failure=>{
    const f=await fixture(failure);try{
      const r=await f.currentCp();expect(r.statusCode).toBe(200);expect(r.headers["cache-control"]).toBe("no-store");expect(r.json()).toEqual({...f.cpBody,current:true,checkedAt:NOW});
      const original=f.queries.find(q=>q.includes("CASE WHEN octet_length(item)"))!;
      expect(original).toContain("SELECT state, lost_at,");expect(original).toContain("seq=1 ORDER BY id LIMIT 2 FOR SHARE");
      expect(original).not.toContain("lost_at IS NULL");
      expect(f.queries.some(q=>q.includes("e.value->>'op' AS op"))).toBe(false);expect(f.queries.some(q=>q.includes("FROM next_devices"))).toBe(false);expect(f.writes).toEqual([]);
      if(failure==="cp-sending")expect((await f.current()).statusCode).toBe(503); // device path remains appended-only
    }finally{await f.app.close();}
  });
  it.each(["deleted","parent","root","security-key","cp-owner-remove","cp-owner-downgrade","cp-lost","cp-lost-with-live-reissue","cp-missing-loss","cp-duplicate","cp-parked","cp-genesis-owner","cp-genesis-root","cp-identity","cp-clock","lock","database"])("closes %s",async failure=>{
    const f=await fixture(failure);try{const r=await f.currentCp();expect([409,503]).toContain(r.statusCode);expect(r.json()).not.toHaveProperty("current");expect(f.writes).toEqual([]);}finally{await f.app.close();}
  });
  it("refuses foreign original genesis bytes",async()=>{const f=await fixture();try{expect((await f.currentCp({genesisSha256:"ff".repeat(32)})).statusCode).toBe(409);}finally{await f.app.close();}});
});
describe("canonical grant projection shared by publication/current observation",()=>{
  it("preserves the original publication terms algorithm and wire fields",()=>{
    const p=projectNextGrant(grantSource);
    expect(p.terms).toEqual(createHash("sha256").update(JSON.stringify([A,OWNER,"synthetic.reader","synthetic.reader",HOSTED,["collection.read"],"05".repeat(32),null])).digest());
    expect(p.policy).toEqual({op:"grant",installation:HOSTED,appId:"synthetic.reader",account:OWNER,capabilities:["collection.read"],clientPublicKey:Buffer.alloc(32,5)});
    const files={...grantSource.file_capability!,scope:{kind:"selected_folders" as const,folders:["z","a"]}};
    expect(projectNextGrant({...grantSource,file_capability:files}).policy).toHaveProperty("fileFolders",["a","z"]);
    expect(projectNextGrant({...grantSource,file_capability:files,sync:"private"}).policy).toHaveProperty("folderScoped",true);
  });
  it("retains exact-permission/scope/client-key refusals",()=>{
    for(const change of [{semantic:1},{operations:[]},{client_pk:Buffer.alloc(31)},{scope:{access:"full_collection",contracts:["unsupported"]}}]) expect(()=>projectNextGrant({...grantSource,...change} as NextGrantSource)).toThrow();
  });
});
describe("original app-grant current CP observation",()=>{
  it("uses a distinct original principal and authenticates before SQL",async()=>{
    const f=await fixture();try{
      expect((await f.currentGrant({},"Bearer wrong")).statusCode).toBe(401);
      for(const c of [{principal:"device"},{device:DEVICE},{current:true},{grant:"00000000-0000-0000-0000-000000000000"}]) expect((await f.currentGrant(c)).statusCode).toBe(400);
      expect((await f.current(f.grantBody)).statusCode).toBe(400);
      expect((await f.currentGrant({collection:HOSTED})).statusCode).toBe(409);expect(f.queries).toEqual([]);
    }finally{await f.app.close();}
  });
  it("locks the stable grant first, checks exact current terms/applied key/floors, and never publishes",async()=>{
    const f=await fixture();try{
      const r=await f.currentGrant();expect(r.statusCode).toBe(200);expect(r.json()).toEqual({...f.grantBody,current:true,checkedAt:NOW});
      expect(r.headers["cache-control"]).toBe("no-store");expect(f.writes).toEqual([]);
      expect(f.queries.findIndex(q=>q==="SELECT id FROM grants WHERE id=$1 FOR SHARE")).toBeLessThan(f.queries.findIndex(q=>q.includes("pg_advisory_xact_lock")));
      expect(f.queries.some(q=>q.includes("FOR SHARE OF b,g,k")&&q.includes("g.created_at>=to_timestamp")&&q.includes("g.membership_id IS NULL"))).toBe(true);
      expect(f.queries.at(-1)).toBe("COMMIT");
    }finally{await f.app.close();}
  });
  it.each(["grant-binding","grant-lock","grant-row","grant-rebound","grant-collection","grant-scope","grant-key","grant-zero","grant-terms","grant-revoked","grant-pending","grant-clock","deleted","security-key","member","genesis","root","database"])("closes %s without a positive or publication",async failure=>{
    const f=await fixture(failure);try{const r=await f.currentGrant();expect([409,503]).toContain(r.statusCode);expect(r.json()).not.toHaveProperty("current");expect(f.writes).toEqual([]);if(failure!=="database")expect(f.queries.at(-1)).toBe("ROLLBACK");}finally{await f.app.close();}
  });
});
describe("isolated registry cut HTTP adapter", () => {
  it("authenticates and narrows metadata without CP signer export", async () => {
    const f=await fixture();try{
      const request=(payload,authorization=`Bearer ${TOKEN}`)=>f.app.inject({method:"POST",url:"/internal/v1/next/lab-pitr/registry",headers:{authorization},payload});
      const b={run:f.body.run,after:null,expected:null};
      expect((await request(b,"Bearer wrong")).statusCode).toBe(401);
      expect((await request({...b,expected:"18446744073709551616"})).statusCode).toBe(400);
      const r=await request(b);expect(r.statusCode).toBe(200);expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.json()).toEqual({run:b.run,generation:"7",after:null,done:true,rows:[]});expect(f.writes).toEqual([]);
    }finally{await f.app.close();}
  });
  it("keeps unavailable isolated cuts UNKNOWN",async()=>{
    const f=await fixture("registry");try{const r=await f.app.inject({method:"POST",url:"/internal/v1/next/lab-pitr/registry",headers:{authorization:`Bearer ${TOKEN}`},payload:{run:f.body.run,after:null,expected:null}});
      expect(r.statusCode).toBe(503);expect(r.json()).not.toHaveProperty("rows");expect(r.body).not.toContain("synthetic registry unavailable");
    }finally{await f.app.close();}
  });
});
describe("fixed-run owner CP denial mutation", () => {
  it("requires CP origin and actual owner session", async () => {
    for(const failure of [undefined,"owner"]) {const f=await fixture(failure);try {
      expect((await f.mutate({},failure ? undefined : "https://evil.example.test")).statusCode).toBe(403);
      expect(f.writes).toEqual([]);expect(f.counts().connects).toBe(0);
    } finally {await f.app.close();}}
  });
  it("locks both originals and checks a survivor before atomically journalling D/revoking A peer", async () => {
    const f=await fixture();try {
      const r=await f.mutate();expect(r.statusCode).toBe(200);expect(r.json()).toMatchObject({deleted:D,revokedCollection:A,revokedDevice:DEVICE,lifecycleEpoch:"1"});
      expect(f.queries.filter(q=>q.includes("pg_advisory_xact_lock"))).toHaveLength(2);
      expect(f.writes).toHaveLength(2);expect(f.queries.at(-1)).toBe("COMMIT");expect(r.json()).not.toHaveProperty("Deleted");
    } finally {await f.app.close();}
  });
  it.each(["owner","session","deleted","revoked","security-key","enrolment","survivor","queue"])("refuses %s before any committed denial", async failure => {
    const f=await fixture(failure);try {const r=await f.mutate();expect([403,409,503]).toContain(r.statusCode);expect(f.writes).toEqual([]);}finally{await f.app.close();}
  });
});
