import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { legacyNotificationWatermarkSchema, type LegacyMigrationDrain } from "../../hosted-provider-replies.js";
import { addToCohort, createCohort, readCohortCaptureSnapshot, releaseCohort, setCohortFrozen, setPaused, startAccountMigration } from "./migration-rollout.js";
import { inTransaction } from "./bootstrap-common.js";
import { prearchiveInventory } from "./migration-prearchive-inventory.js";
import { registerPrearchiveMigrationRoutes } from "./migration-prearchive.js";
import { registerMigrationProviderRoutes } from "./migration-provider.js";

const testUrl=process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved=process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite=testUrl && approved ? describe : describe.skip;
const token="synthetic-prearchive-migration-role-".repeat(2), actor="synthetic-prearchive-test";
const watermark=legacyNotificationWatermarkSchema.parse('"mdbase-legacy-notifications-v1:'+"a".repeat(64)+'"');

suite("prearchive original first-H6 authorization (real isolated PG)",()=>{
  let db: DatabasePool, admin: pg.Pool, schema: string;
  beforeAll(async()=>{
    const url=new URL(testUrl!);
    if(!["localhost","127.0.0.1","[::1]"].includes(url.hostname)||!/test/i.test(url.pathname)) throw new Error("Dedicated local test PostgreSQL required");
    schema="prearchive_"+randomUUID().replaceAll("-","");
    admin=new pg.Pool({connectionString:url.toString(),max:2}); await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options",`-csearch_path=${schema}`); db=await createDatabase(url.toString());
    await setPaused(db,false,"synthetic prearchive tests",actor);
  },60_000);
  afterAll(async()=>{await db?.end(); if(admin&&schema)await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin?.end();});

  async function fixture(environment="lab", emptyMember=false){
    const accounts=Array.from({length:emptyMember?3:2},()=>randomUUID()).sort(), collections=[randomUUID(),randomUUID()];
    const name="test-prearchive-"+randomUUID().slice(0,8);
    for(let i=0;i<accounts.length;i++){
      await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Synthetic')",[accounts[i],accounts[i]+"@example.test"]);
      if(i<2)await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,'Synthetic','mdbase')",[collections[i],accounts[i]]);
    }
    await createCohort(db,name,actor); await addToCohort(db,name,accounts,actor); await releaseCohort(db,name,actor);
    const capture=await inTransaction(db,async client=>{
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"); return readCohortCaptureSnapshot(client,name);
    });
    const inventory=prearchiveInventory(capture), target=inventory.selected[0]!;
    const run={migration_id:randomUUID(),started_at:"2026-10-15T00:00:00.123456Z"};
    let source: LegacyMigrationDrain={collection_id:target.collection_id,state:"active",head:4,started_at:null,retain_until:null,
      migration_id:null,in_flight:0,unresolved:0,applied_unreceipted:0};
    const provider={
      legacyMigrationDrain:vi.fn(async()=>({...source})),
      legacyMigrationFence:vi.fn(async()=>{
        source={...source,state:"migrating",...run};
        return {collection_id:target.collection_id,state:"migrating" as const,...run,retain_until:null,restored:[]};
      }),
      legacyMigrationSource:vi.fn(async()=>({drain:{...source},notificationWatermark:watermark}))
    };
    const app=Fastify(); registerPrearchiveMigrationRoutes(app,{db,token,environment,provider});
    registerMigrationProviderRoutes(app,{db,token,provider});
    const body={binding:capture.binding,inventory_sha256:inventory.inventory_sha256};
    const request=(kind="fence",payload:unknown=body,ordinal="0",credential=token,query="")=>app.inject({method:"POST",
      url:`/internal/v1/next/migration/cohorts/${name}/capture/collections/${ordinal}/${kind}${query}`,
      headers:{authorization:`Bearer ${credential}`},payload});
    return {app,accounts,collections,name,capture,inventory,target,provider,body,run,request,setSource:(value:Partial<LegacyMigrationDrain>)=>{source={...source,...value};}};
  }

  it.each(["lab","staging","production"])("authenticates first H6 before freeze/archive/start and preserves existing start-gated paths: %s",async environment=>{
    const f=await fixture(environment);
    try{
      expect(f.capture.frozen_at).toBeNull();
      await expect(startAccountMigration(db,f.target.account_id,environment)).rejects.toMatchObject({code:"backup_missing"});
      const old=await f.app.inject({method:"POST",url:`/internal/v1/next/migration/collections/${f.target.collection_id}/fence`,headers:{authorization:`Bearer ${token}`},payload:{}});
      expect(old.statusCode).toBe(409); expect(f.provider.legacyMigrationFence).not.toHaveBeenCalled();
      const response=await f.request(); expect(response.statusCode,response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({schema:"mdbase-migration-prearchive-fence/1",...f.body,ordinal:0,...f.target,fence:{...f.run}});
      expect(f.provider.legacyMigrationFence).toHaveBeenCalledExactlyOnceWith(f.target.collection_id,{deadline:expect.any(Number)});
      await setCohortFrozen(db,f.name,true,"synthetic freeze",actor);
      const drained=await f.request("drain",{...f.body,expected_run:f.run});
      expect(drained.statusCode,drained.body).toBe(200);
      expect(drained.json()).toMatchObject({schema:"mdbase-migration-prearchive-drain/1",notification_watermark:watermark,expected_run:f.run,drain:{...f.run,in_flight:0}});
      expect((await db.query("SELECT 1 FROM next_migration_archive_acceptances WHERE cohort=$1",[f.name])).rowCount).toBe(0);
      expect((await db.query("SELECT 1 FROM next_migration_cohort_members WHERE cohort=$1 AND started_at IS NOT NULL",[f.name])).rowCount).toBe(0);
      const retry=await f.request(); expect(retry.statusCode).toBe(409); expect(f.provider.legacyMigrationFence).toHaveBeenCalledTimes(1);
    }finally{await f.app.close();}
  });

  it.each(["hash","binding","other-cohort","ordinal","extra","query","token","unknown-environment"])("refuses untrusted scope/role before provider IO: %s",async kind=>{
    const f=await fixture(kind==="unknown-environment"?"unknown":"lab");
    try{
      const body=structuredClone(f.body);
      if(kind==="hash")body.inventory_sha256="0".repeat(64);
      if(kind==="binding")body.binding.membership_revision="99999";
      if(kind==="other-cohort")body.binding.batch_id="different-cohort";
      if(kind==="extra")Object.assign(body,{collections:[f.target.collection_id]});
      expect((await f.request("fence",body,kind==="ordinal"?"2":"0",kind==="token"?"user-session":token,kind==="query"?"?account=selected":"")).statusCode).not.toBe(200);
      expect(f.provider.legacyMigrationDrain).not.toHaveBeenCalled(); expect(f.provider.legacyMigrationFence).not.toHaveBeenCalled();
    }finally{await f.app.close();}
  });

  it.each(["quarantine-other","delete-other","unsettled-other","cutover-other","flip-other","terminal","membership"])("rejects the WHOLE union, not just ordinal zero: %s",async kind=>{
    const f=await fixture(), other=f.inventory.selected[1]!;
    try{
      if(kind==="quarantine-other")await db.query("UPDATE hosted_collections SET quarantined_at=now(),quarantine_reason='provider_collection_missing' WHERE id=$1",[other.collection_id]);
      if(kind==="delete-other")await db.query("INSERT INTO next_collection_deletion_facts(collection_id,deletion_id,lifecycle_epoch,authority) VALUES($1,$2,1,'cp-intent')",[other.collection_id,randomUUID()]);
      if(kind==="unsettled-other")await db.query("UPDATE hosted_collections SET authority_state='importing' WHERE id=$1",[other.collection_id]);
      if(kind==="cutover-other")await db.query("INSERT INTO next_migration_collections(collection_id,account_id,s_final,cutover_seq,barrier_f,final_digest) VALUES($1,$2,0,1,1,'test')",[other.collection_id,other.account_id]);
      if(kind==="flip-other")await db.query("INSERT INTO next_migration_account_flips(account_id,collections,evidence_digest) VALUES($1,'{}','test')",[other.account_id]);
      if(kind==="terminal")await db.query("UPDATE next_migration_cohort_members SET terminal_excluded_at=now() WHERE account_id=$1",[other.account_id]);
      if(kind==="membership")await db.query("UPDATE next_migration_cohorts SET membership_revision=membership_revision+1 WHERE name=$1",[f.name]);
      expect((await f.request()).statusCode).toBe(409); expect(f.provider.legacyMigrationDrain).not.toHaveBeenCalled(); expect(f.provider.legacyMigrationFence).not.toHaveBeenCalled();
    }finally{await f.app.close();}
  });

  it.each(["before-effect","after-effect","lost-reply"])("no replay/adoption around provider await: %s",async kind=>{
    const f=await fixture();
    try{
      const drift=async()=>{await db.query("UPDATE next_migration_cohorts SET membership_revision=membership_revision+1 WHERE name=$1",[f.name]);};
      if(kind==="before-effect")f.provider.legacyMigrationDrain.mockImplementationOnce(async()=>{await drift(); return {collection_id:f.target.collection_id,state:"active",head:4,started_at:null,retain_until:null,migration_id:null,in_flight:0,unresolved:0,applied_unreceipted:0};});
      else f.provider.legacyMigrationFence.mockImplementationOnce(async()=>{
        if(kind==="lost-reply")throw new Error("synthetic lost acknowledgement"); await drift();
        return {collection_id:f.target.collection_id,state:"migrating",...f.run,retain_until:null,restored:[]};
      });
      const reply=await f.request(); expect(reply.statusCode).toBe(kind==="before-effect"?409:503);
      if(kind==="before-effect")expect(f.provider.legacyMigrationFence).not.toHaveBeenCalled();
      else {expect(reply.json().error.code).toBe("migration_prearchive_effect_unknown"); expect(f.provider.legacyMigrationFence).toHaveBeenCalledTimes(1);}
    }finally{await f.app.close();}
  });

  it("includes empty-account flips in full-cohort authorization",async()=>{
    const f=await fixture("lab",true);
    try{
      await db.query("INSERT INTO next_migration_account_flips(account_id,collections,evidence_digest) VALUES($1,'{}','test')",[f.accounts[2]]);
      expect((await f.request()).statusCode).toBe(409); expect(f.provider.legacyMigrationDrain).not.toHaveBeenCalled();
    }finally{await f.app.close();}
  });

  it("allows scoped source preparation while global rollout is paused",async()=>{
    const f=await fixture();
    try{
      await setPaused(db,true,"synthetic paused scoped source",actor);
      expect((await f.request()).statusCode).toBe(200);
    }finally{await setPaused(db,false,"restore synthetic test state",actor);await f.app.close();}
  });

  it("preserves native retained-receipt counts and refuses fresh post-drain drift",async()=>{
    const f=await fixture();
    try{
      expect((await f.request()).statusCode).toBe(200);
      f.setSource({unresolved:2,applied_unreceipted:3});
      const first=await f.request("drain",{...f.body,expected_run:f.run});
      expect(first.statusCode,first.body).toBe(200); expect(first.json().drain).toMatchObject({unresolved:2,applied_unreceipted:3});
      const native=f.provider.legacyMigrationSource.getMockImplementation()!;
      f.provider.legacyMigrationSource.mockImplementationOnce(async()=>{
        const value=await native();
        await db.query("UPDATE next_migration_cohorts SET membership_revision=membership_revision+1 WHERE name=$1",[f.name]);return value;
      });
      expect((await f.request("drain",{...f.body,expected_run:f.run})).statusCode).toBe(409);
      expect(f.provider.legacyMigrationFence).toHaveBeenCalledTimes(1);
    }finally{await f.app.close();}
  });

  it.each(["run","stamp","in-flight","identity","watermark"])("drain binds exact original provider data: %s",async kind=>{
    const f=await fixture();
    try{
      expect((await f.request()).statusCode).toBe(200);
      if(kind==="run")f.setSource({migration_id:randomUUID()});
      if(kind==="stamp")f.setSource({started_at:"2026-10-15T00:00:00.1234560Z"});
      if(kind==="in-flight")f.setSource({in_flight:1});
      if(kind==="identity")f.setSource({collection_id:randomUUID()});
      if(kind==="watermark")f.provider.legacyMigrationSource.mockImplementationOnce(async()=>({drain:{collection_id:f.target.collection_id,state:"migrating",head:4,...f.run,retain_until:null,in_flight:0,unresolved:0,applied_unreceipted:0},notificationWatermark:"invalid" as typeof watermark}));
      expect((await f.request("drain",{...f.body,expected_run:f.run})).statusCode).not.toBe(200);
      expect(f.provider.legacyMigrationFence).toHaveBeenCalledTimes(1);
    }finally{await f.app.close();}
  });
});
