import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { registerMigrationSourceWitnessRoutes } from "./migration-source.js";
import { deleteAccountLocally } from "../../account-management.js";
import { setCohortFrozen } from "./migration-rollout.js";
import { certToJson, ed25519RawPublicKey, loadPolicySigner, type NextControlPlaneConfig } from "./policy-keys.js";
import { registerNextCollection } from "./policy-outbox.js";
import { certDigest, chainHash, decodeCbor, keyId, signPolicyItem, type PolicyOp } from "./policy-wire.js";

const testUrl=process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved=process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL==="I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg=testUrl&&approved?describe:describe.skip;
const NIL="00000000-0000-0000-0000-000000000000";
const token="m".repeat(40),outbound="h".repeat(40);
const root=generateKeyPairSync("ed25519").privateKey,policy=generateKeyPairSync("ed25519").privateKey;
const cert={policyPublicKey:ed25519RawPublicKey(policy),root:keyId(ed25519RawPublicKey(root)),notBefore:Date.now()-60000,notAfter:Date.now()+30*86400000};
const next:NextControlPlaneConfig={rootPublicKey:ed25519RawPublicKey(root),policyPrivateKeyPem:policy.export({format:"pem",type:"pkcs8"}).toString(),policyCert:certToJson({...cert,signature:sign(null,certDigest(cert),root)}),migrationToken:token,
  serviceTokens:{hosted:"H".repeat(40),escrow:"E".repeat(40)},cloudCopyBootstrap:{hosted:{url:"https://native.test",token:outbound},escrow:{url:"https://escrow.test",token:"e".repeat(40)}},
  logService:{url:"https://log.test",tokenIssuerKeyPem:policy.export({format:"pem",type:"pkcs8"}).toString(),transportKeyPem:policy.export({format:"pem",type:"pkcs8"}).toString()}};
const signer=loadPolicySigner(next,Date.now());
type LegacyMigrationDrain={collection_id:string;state:string;head:number;started_at:string|null;retain_until:string|null;in_flight:number;unresolved:number;applied_unreceipted:number;migration_id?:string|null};

describePg("migration source issuance (isolated PostgreSQL, mocked authenticated peers)",()=>{
  let db:DatabasePool,admin:pg.Pool,schema:string;
  beforeAll(async()=>{
    const url=new URL(testUrl!);if(!["localhost","127.0.0.1","::1"].includes(url.hostname)||!/test/i.test(url.pathname))throw new Error("Dedicated local test PostgreSQL required");
    schema=`migration_source_${randomUUID().replaceAll("-","")}`;admin=new pg.Pool({connectionString:url.toString(),max:2});await admin.query(`CREATE SCHEMA "${schema}"`);url.searchParams.set("options",`-csearch_path=${schema}`);db=await createDatabase(url.toString());
  },60000);
  afterAll(async()=>{await db?.end();if(admin&&schema)await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin?.end();});
  async function fixture(started=true){
    const account=randomUUID(),collection=randomUUID(),device=randomUUID(),cohort=`c-${randomUUID().slice(0,8)}`;
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Test')",[account,`${account}@example.test`]);
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,'Source','mdbase')",[collection,account]);
    await db.query("INSERT INTO next_migration_cohorts(name,released_at) VALUES($1,now())",[cohort]);
    await db.query("INSERT INTO next_migration_cohort_members(account_id,cohort,started_at) VALUES($1,$2,CASE WHEN $3 THEN date_trunc('milliseconds',now())+interval '321 microseconds' ELSE NULL END)",[account,cohort,started]);
    const keys={sign_pk:Buffer.alloc(32,1),kem_pk:Buffer.alloc(32,2),noise_pk:Buffer.alloc(32,3)};
    const ops:PolicyOp[]=[{op:"genesis",owner:account,root:cert.root,state:"cloud-copy"},{op:"member-set",account,role:"owner"},{op:"device-enrol",device,account:NIL,kind:"hosted",signPublicKey:keys.sign_pk,kemPublicKey:keys.kem_pk,noisePublicKey:keys.noise_pk}];
    await registerNextCollection(db,{collectionId:collection,ownerUserId:account,runtime:"shadow",sync:"cloud_copy",rootKeyId:cert.root,ops});
    await db.query("INSERT INTO next_service_devices(collection_id,kind,device_id,sign_pk,kem_pk,noise_pk,wrapped_keys,kms_key_arn) VALUES($1,'hosted',$2,$3,$4,$5,$6,'synthetic-test')",[collection,device,keys.sign_pk,keys.kem_pk,keys.noise_pk,Buffer.from("test-only-wrap")]);
    const issuedAt=Date.now(),item=signPolicyItem(signer,{collection,seq:1,prev:Buffer.alloc(32),issuedAt,previousIssuedAt:0,ops});
    const batch=(await db.query<{id:string}>("INSERT INTO next_policy_batches(collection_id,seq,prev,item,issued_at,state,appended_at) VALUES($1,1,$2,$3,$4,'appended',now()) RETURNING id",[collection,Buffer.alloc(32),item,issuedAt])).rows[0]!.id;
    await db.query("UPDATE next_policy_outbox SET batch_id=$2 WHERE collection_id=$1",[collection,batch]);
    let source:LegacyMigrationDrain={collection_id:collection,state:"migrating",head:42,started_at:new Date().toISOString(),retain_until:null,in_flight:0,unresolved:3,applied_unreceipted:2,migration_id:randomUUID()};
    let calls=0,reads=0;let during:(()=>Promise<void>)|undefined;let alter:((value:Record<string,unknown>)=>void)|undefined;let unavailable=false;
    const app=Fastify();
    registerMigrationSourceWitnessRoutes(app,{db,next,signer,provider:{legacyMigrationDrain:async(id)=>{expect(id).toBe(collection);reads++;return {...source};}},fetchImpl:async(input,init)=>{
      calls++;expect(String(input)).toBe("https://native.test/internal/v1/migration-admission");expect(init?.redirect).toBe("manual");expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${outbound}`);
      const body=JSON.parse(String(init?.body)) as {collection:string;challenge:string};expect(body.collection).toBe(collection);expect(Buffer.from(body.challenge,"base64").length).toBe(32);expect(Buffer.from(body.challenge,"base64").toString("base64")).toBe(body.challenge);expect(Object.keys(body).sort()).toEqual(["challenge","collection"]);
      await during?.();if(unavailable)return new Response("deny",{status:503});
      const value:Record<string,unknown>={schema:"mdbn-migration-admission/1",collection,device_id:device,epoch:"2",wake:"18446744073709551615",fault_generation:"9007199254740993",applied_head:{seq:"1",chain:Buffer.from(chainHash(item)).toString("hex")},authenticated_head:{seq:"1",chain:Buffer.from(chainHash(item)).toString("hex")},control_chain:Buffer.from(chainHash(item)).toString("hex"),challenge:body.challenge};alter?.(value);return new Response(JSON.stringify(value));
    }});
    const request=(authorization=`Bearer ${token}`,body:unknown={})=>app.inject({method:"POST",url:`/internal/v1/next/migration/collections/${collection}/source-witness`,headers:{authorization},payload:body});
    return {account,collection,device,batch,cohort,app,request,get calls(){return calls;},get reads(){return reads;},get source(){return source;},set source(value:LegacyMigrationDrain){source=value;},set during(value:(()=>Promise<void>)|undefined){during=value;},set alter(value:((value:Record<string,unknown>)=>void)|undefined){alter=value;},set unavailable(value:boolean){unavailable=value;}};
  }
  it("binds actual source/head/start/native u64 facts; pause after start and retained journal evidence do not strand migration",async()=>{
    const f=await fixture();try{
      const result=await f.request();expect(result.statusCode,result.body).toBe(200);expect(result.headers["cache-control"]).toBe("no-store");expect(f.calls).toBe(1);expect(f.reads).toBe(2);
      const outer=decodeCbor(Buffer.from(result.json().witness,"base64")) as unknown[];const claims=decodeCbor(outer[1] as Uint8Array) as unknown[];
      const millis=(await db.query<{ms:string}>("SELECT floor(extract(epoch FROM started_at)*1000)::text AS ms FROM next_migration_cohort_members WHERE account_id=$1",[f.account])).rows[0]!.ms;
      expect(claims).toHaveLength(10);expect(claims[3]).toBe(2);expect(claims[5]).toBe(42);expect(claims[6]).toBe(Number(millis));expect(claims[7]).toBe((1n<<64n)-1n);expect(Number(claims[9])-Number(claims[8])).toBe(900000);
      expect((await db.query("SELECT 1 FROM audit_events WHERE event_type='next_migration.source_witness' AND subject_id=$1",[f.collection])).rows).toHaveLength(1);
    }finally{await f.app.close();}
  });
  it("keeps a terminal-excluded hosted account suspended and refuses fresh witnesses without native/provider effects",async()=>{
    const f=await fixture();try{
      expect((await f.request()).statusCode).toBe(200);
      await setCohortFrozen(db,f.cohort,true,"synthetic capture","synthetic-local-pg");
      await deleteAccountLocally(db,{userId:f.account,sessionId:randomUUID(),authorized:true,queueProviderCleanup:true});
      const calls=f.calls,reads=f.reads;
      const result=await f.request();expect(result.statusCode,result.body).toBe(409);
      expect(result.json().error.code).toBe("migration_source_not_current");
      expect(f.calls).toBe(calls);expect(f.reads).toBe(reads);
      expect((await db.query("SELECT terminal_excluded_at FROM next_migration_cohort_members WHERE account_id=$1",[f.account])).rows[0].terminal_excluded_at).not.toBeNull();
      expect((await db.query("SELECT account_backend,suspended_at FROM users WHERE id=$1",[f.account])).rows[0]).toMatchObject({account_backend:"legacy",suspended_at:expect.any(Date)});
      expect((await db.query("SELECT 1 FROM hosted_collections WHERE id=$1",[f.collection])).rowCount).toBe(1);
    }finally{await f.app.close();}
  });
  it("never accepts app/session/service credentials or caller-selected source facts",async()=>{
    const f=await fixture();try{
      for(const authorization of ["Bearer session-test","Bearer app-test",`Bearer ${next.serviceTokens.hosted}`])expect((await f.request(authorization)).statusCode).toBe(401);
      for(const body of [{epoch:"2"},{wake:"1"},{head:42},{started_at:new Date().toISOString()},{url:"https://elsewhere.test"},{device_id:f.device}])expect((await f.request(undefined,body)).statusCode).toBe(400);
      expect(f.calls).toBe(0);expect(f.reads).toBe(0);
    }finally{await f.app.close();}
  });
  it.each(["collection","device_id","challenge","epoch","wake","fault_generation","applied_head","control_chain"])("refuses native identity/precision/freshness mismatch: %s",async(field)=>{
    const f=await fixture();try{
      f.alter=value=>{value[field]=field==="applied_head"?{seq:"2",chain:"11".repeat(32)}:field==="collection"||field==="device_id"?randomUUID():field==="challenge"?Buffer.alloc(32).toString("base64"):field==="control_chain"?"bad":"9007199254740993.0";};
      const result=await f.request();expect(result.statusCode,result.body).toBe(503);expect(result.body).not.toContain('"witness"');
    }finally{await f.app.close();}
  });
  it.each(["account-delete","collection-delete","flip","start-change","device-change","keys-change","leave-sync","suspend"])("rechecks CP currentness after native await: %s",async(change)=>{
    const f=await fixture();try{
      f.during=async()=>{
        if(change==="account-delete")await db.query("DELETE FROM users WHERE id=$1",[f.account]);
        if(change==="collection-delete")await db.query("DELETE FROM hosted_collections WHERE id=$1",[f.collection]);
        if(change==="flip")await db.query("UPDATE users SET account_backend='next' WHERE id=$1",[f.account]);
        if(change==="start-change")await db.query("UPDATE next_migration_cohort_members SET started_at=started_at+interval '1 second' WHERE account_id=$1",[f.account]);
        if(change==="device-change")await db.query("UPDATE next_service_devices SET device_id=$2 WHERE collection_id=$1",[f.collection,randomUUID()]);
        if(change==="keys-change")await db.query("UPDATE next_service_devices SET noise_pk=$2 WHERE collection_id=$1",[f.collection,Buffer.alloc(32,8)]);
        if(change==="leave-sync")await db.query("UPDATE next_collections SET left_sync_at=now() WHERE collection_id=$1",[f.collection]);
        if(change==="suspend")await db.query("UPDATE users SET suspended_at=now() WHERE id=$1",[f.account]);
      };
      const result=await f.request();expect(result.statusCode,result.body).toBe(409);expect(result.body).not.toContain('"witness"');
    }finally{await f.app.close();}
  });
  it("refuses paused-before-start, lost enrolment, pending service revoke or CP signing-key revoke",async()=>{
    const unstarted=await fixture(false);try{expect((await unstarted.request()).statusCode).toBe(409);expect(unstarted.calls).toBe(0);}finally{await unstarted.app.close();}
    for(const op of [null,{op:"device-revoke",device:"DEVICE"},{op:"cp-key-revoke",keyId:{$hex:Buffer.from(keyId(signer.cert.policyPublicKey)).toString("hex")}}]){
      const f=await fixture();try{
        if(!op)await db.query("UPDATE next_policy_batches SET lost_at=now() WHERE id=$1",[f.batch]);
        else await db.query("INSERT INTO next_policy_outbox(collection_id,ops) VALUES($1,$2)",[f.collection,JSON.stringify({version:1,ops:[op.op==="device-revoke"?{...op,device:f.device}:op]})]);
        expect((await f.request()).statusCode).toBe(409);expect(f.calls).toBe(0);
      }finally{await f.app.close();}
    }
  });
  it("refuses source refence/head drift and unavailable native peer",async()=>{
    for(const mode of ["head","run","active","in-flight","unavailable"]){const f=await fixture();try{
      f.during=async()=>{if(mode==="head")f.source={...f.source,head:43};if(mode==="run")f.source={...f.source,migration_id:randomUUID()};};
      if(mode==="active")f.source={...f.source,state:"active"};if(mode==="in-flight")f.source={...f.source,in_flight:1};if(mode==="unavailable")f.unavailable=true;
      const result=await f.request();expect(result.statusCode,result.body).toBe(mode==="unavailable"?503:409);expect(result.body).not.toContain('"witness"');
    }finally{await f.app.close();}}
  });
});
