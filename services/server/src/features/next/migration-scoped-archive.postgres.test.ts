import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { legacyNotificationWatermarkSchema, type LegacyMigrationDrain } from "../../hosted-provider-replies.js";
import { inTransaction } from "./bootstrap-common.js";
import { SCOPED_HOSTED_ARCHIVE_SCHEMA } from "./migration-archive-profile.js";
import { prearchiveInventory } from "./migration-prearchive-inventory.js";
import { registerMigrationProviderRoutes } from "./migration-provider.js";
import { acceptCohortArchive, addToCohort, createCohort, parseVerifiedBatchArchive, readCohortCaptureSnapshot, registerMigrationRolloutRoutes, releaseCohort, setCohortFrozen, setPaused, startAccountMigration } from "./migration-rollout.js";

const testUrl=process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved=process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite=testUrl&&approved?describe:describe.skip;
const token="synthetic-scoped-archive-role-".repeat(2), actor="synthetic-archive-test";
const watermark=legacyNotificationWatermarkSchema.parse('"mdbase-legacy-notifications-v1:'+"a".repeat(64)+'"');

suite("accepted scoped archive original-H6 bridge (isolated real PostgreSQL)",()=>{
  let db:DatabasePool,admin:pg.Pool,schema:string;
  beforeAll(async()=>{
    const url=new URL(testUrl!);
    if(!["localhost","127.0.0.1","[::1]"].includes(url.hostname)||!/test/i.test(url.pathname))throw new Error("Dedicated local test PostgreSQL required");
    schema="scoped_archive_"+randomUUID().replaceAll("-","");admin=new pg.Pool({connectionString:url.toString(),max:2});
    await admin.query(`CREATE SCHEMA "${schema}"`);url.searchParams.set("options",`-csearch_path=${schema}`);
    db=await createDatabase(url.toString());await setPaused(db,false,"synthetic scoped archive",actor);
  },60_000);
  afterAll(async()=>{await db?.end();if(admin&&schema)await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin?.end();});

  async function fixture(environment="lab",collectionCount=1){
    const account=randomUUID(),collections=Array.from({length:collectionCount},()=>randomUUID()).sort(),collection=collections[0]!,name="test-scoped-"+randomUUID().slice(0,8);
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Synthetic')",[account,account+"@example.test"]);
    for(const id of collections)await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,'Synthetic','mdbase')",[id,account]);
    await createCohort(db,name,actor);await addToCohort(db,name,[account],actor);await releaseCohort(db,name,actor);
    await setCohortFrozen(db,name,true,"synthetic scoped archive",actor);
    const capture=await inTransaction(db,async client=>{
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");return readCohortCaptureSnapshot(client,name);
    });
    const inventory=prearchiveInventory(capture);
    const now=(await db.query<{now:Date}>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0]!.now;
    const source:LegacyMigrationDrain={collection_id:collection,state:"migrating",migration_id:randomUUID(),started_at:new Date(now.getTime()-1000).toISOString(),
      retain_until:null,head:4,in_flight:0,unresolved:0,applied_unreceipted:0};
    // Synthetic trusted-verifier metadata boundary, NOT signature/restore proof.
    const verified={schema:SCOPED_HOSTED_ARCHIVE_SCHEMA,environment,bucket:"synthetic-archive",
      prefix:`legacy-archive/${environment}/2026/10/15/test-scoped`,backup_id:"test-scoped",complete_sha256:"a".repeat(64),manifest_sha256:"b".repeat(64),source_commit:"c".repeat(40),
      migration_batch:capture.binding,archive_created_at:now.toISOString(),archive_completed_at:now.toISOString(),
      retention:{mode:"GOVERNANCE",days:116,retain_until:new Date(now.getTime()+116*86400000).toISOString(),inventory_digest:"d".repeat(64),count:"5"},
      scoped_recovery:{inventory_sha256:inventory.inventory_sha256,
        selection_sha256:createHash("sha256").update("mdbase-scoped-archive-selection/v1\n").update(JSON.stringify(inventory.selected.map(value=>[value.account_id,value.collection_id]))).digest("hex"),
        source_rows_sha256:"e".repeat(64),recovered_inventory_sha256:"f".repeat(64),original_h6_journal_sha256:"1".repeat(64),
        source_fences:inventory.selected.map(value=>({account_id:account,collection_id:value.collection_id,
          migration_id:value.collection_id===collection?source.migration_id!:randomUUID(),started_at:source.started_at!,head:source.head,
          in_flight:0,unresolved:0,applied_unreceipted:0,notification_watermark:watermark,fence_reply_sha256:"2".repeat(64),drain_reply_sha256:"3".repeat(64)}))}};
    const provider={legacyMigrationDrain:vi.fn(async()=>({...source})),
      legacyMigrationSource:vi.fn(async()=>({drain:{...source},notificationWatermark:watermark})),
      legacyMigrationFence:vi.fn(async()=>{throw new Error("Unexpected physical refence");})};
    const app=Fastify();registerMigrationProviderRoutes(app,{db,token,environment,provider});
    registerMigrationRolloutRoutes(app,{db,token,environment});
    const request=(kind="fence",credential=token)=>app.inject({method:kind==="fence"?"POST":"GET",
      url:`/internal/v1/next/migration/collections/${collection}/${kind}`,headers:{authorization:`Bearer ${credential}`},...(kind==="fence"?{payload:{}}:{})});
    const accept=()=>acceptCohortArchive(db,name,verified,environment);
    const start=()=>startAccountMigration(db,account,environment);
    return {app,provider,verified,source,account,collection,name,capture,request,accept,start};
  }

  it.each(["lab","staging","production"])("ordinary start follows acceptance; native fronts consume ORIGINAL without physical fence: %s",async environment=>{
    const f=await fixture(environment);try{
      await expect(f.start()).rejects.toMatchObject({code:"backup_missing"});
      expect((await f.request()).statusCode).toBe(409);
      await f.accept();expect((await f.request()).statusCode).toBe(409); // start guard retained
      const receiving=await f.app.inject({url:`/internal/v1/next/migration/cohorts/${f.name}/archive-binding?view=receiving-v1`,
        headers:{authorization:`Bearer ${token}`}});
      expect(receiving.statusCode,receiving.body).toBe(200);
      expect(receiving.json().archive.verified_result).toEqual(f.verified);
      expect(receiving.json().members.map((member:{view:{account_id:string}})=>member.view.account_id)).toEqual([f.account]);
      await f.start();
      const fenced=await f.request();expect(fenced.statusCode,fenced.body).toBe(200);
      expect(fenced.json()).toEqual({collection_id:f.collection,state:"migrating",migration_id:f.source.migration_id,
        started_at:f.source.started_at,retain_until:null,restored:[]});
      expect(f.provider.legacyMigrationFence).not.toHaveBeenCalled();expect(f.provider.legacyMigrationDrain).not.toHaveBeenCalled();
      expect(f.provider.legacyMigrationSource).toHaveBeenCalledTimes(1);
      const drained=await f.request("source");expect(drained.statusCode,drained.body).toBe(200);expect(drained.json()).toEqual(f.source);
      expect(f.provider.legacyMigrationFence).not.toHaveBeenCalled();
    }finally{await f.app.close();}
  });

  it.each(["complete","reordered","subset"])("complete multi-hosted original union: %s",async kind=>{
    const f=await fixture("lab",2);try{
      if(kind==="reordered")f.verified.scoped_recovery.source_fences.reverse();
      if(kind==="subset")f.verified.scoped_recovery.source_fences.pop();
      if(kind==="complete"){
        await f.accept();await f.start();const reply=await f.request();expect(reply.statusCode,reply.body).toBe(200);
      }else await expect(f.accept()).rejects.toMatchObject({code:"migration_archive_source_changed"});
      expect(f.provider.legacyMigrationFence).not.toHaveBeenCalled();
    }finally{await f.app.close();}
  });

  it("accepts retained unresolved/applied journal evidence when in_flight is zero (provider H6 settlement)",async()=>{
    const f=await fixture("lab",2);try{
      const original=f.verified.scoped_recovery.source_fences.find(value=>value.collection_id===f.collection)!;
      original.unresolved=f.source.unresolved=4;original.applied_unreceipted=f.source.applied_unreceipted=2;
      parseVerifiedBatchArchive(f.verified);
      await f.accept();await f.start();
      const fenced=await f.request();expect(fenced.statusCode,fenced.body).toBe(200);
      const drained=await f.request("source");expect(drained.statusCode,drained.body).toBe(200);
      expect(drained.json()).toMatchObject({in_flight:0,unresolved:4,applied_unreceipted:2});
      expect(f.provider.legacyMigrationFence).not.toHaveBeenCalled();
    }finally{await f.app.close();}
  });

  it.each(["inventory","selection","owner","collection","missing","duplicate","future-fence","unsafe-head","in-flight","negative-unresolved","fractional-unresolved","unsafe-unresolved","negative-applied","unsafe-applied","production","count"])("rejects bad complete scoped evidence before acceptance/start: %s",async kind=>{
    const f=await fixture();try{
      const proof=f.verified.scoped_recovery;
      if(kind==="inventory")proof.inventory_sha256="0".repeat(64);
      if(kind==="selection")proof.selection_sha256="0".repeat(64);
      if(kind==="owner")proof.source_fences[0]!.account_id=randomUUID();
      if(kind==="collection")proof.source_fences[0]!.collection_id=randomUUID();
      if(kind==="missing")proof.source_fences=[];
      if(kind==="duplicate")proof.source_fences.push({...proof.source_fences[0]!});
      if(kind==="future-fence")proof.source_fences[0]!.started_at=new Date(Date.parse(f.verified.archive_created_at)+1000).toISOString();
      if(kind==="unsafe-head")proof.source_fences[0]!.head=9007199254740992;
      if(kind==="in-flight")proof.source_fences[0]!.in_flight=1;
      if(kind==="negative-unresolved")proof.source_fences[0]!.unresolved=-1;
      if(kind==="fractional-unresolved")proof.source_fences[0]!.unresolved=1.5;
      if(kind==="unsafe-unresolved")proof.source_fences[0]!.unresolved=9007199254740992;
      if(kind==="negative-applied")proof.source_fences[0]!.applied_unreceipted=-1;
      if(kind==="unsafe-applied")proof.source_fences[0]!.applied_unreceipted=9007199254740992;
      if(kind==="production")f.verified.environment="production";
      if(kind==="count")f.verified.retention.count="2";
      await expect(f.accept()).rejects.toMatchObject({code:expect.stringMatching(/backup_missing|migration_archive_source_changed/)});
      expect((await f.request()).statusCode).toBe(409);expect(f.provider.legacyMigrationFence).not.toHaveBeenCalled();
    }finally{await f.app.close();}
  });

  it.each(["run","stamp","head","in-flight","watermark","retention","active","postread-claim","revision"])("never adopts/refences changed original source: %s",async kind=>{
    const f=await fixture();try{
      await f.accept();await f.start();
      if(kind==="run")f.source.migration_id=randomUUID();
      if(kind==="stamp")f.source.started_at=f.source.started_at!.replace("Z","+00:00");
      if(kind==="head")f.source.head++;
      if(kind==="in-flight")f.source.in_flight=1;
      if(kind==="retention")f.source.retain_until=new Date().toISOString();
      if(kind==="active")f.source.state="active";
      if(kind==="watermark")f.provider.legacyMigrationSource.mockImplementationOnce(async()=>({drain:{...f.source},notificationWatermark:legacyNotificationWatermarkSchema.parse('"mdbase-legacy-notifications-v1:'+"b".repeat(64)+'"')}));
      if(kind==="postread-claim")f.provider.legacyMigrationSource.mockImplementationOnce(async()=>{
        await db.query("UPDATE hosted_collections SET quarantined_at=now(),quarantine_reason='provider_collection_missing' WHERE id=$1",[f.collection]);
        return {drain:{...f.source},notificationWatermark:watermark};
      });
      if(kind==="revision")await db.query("UPDATE next_migration_cohorts SET membership_revision=membership_revision+1 WHERE name=$1",[f.name]);
      const reply=await f.request();expect(reply.statusCode,reply.body).toBe(409);expect(f.provider.legacyMigrationFence).not.toHaveBeenCalled();
    }finally{await f.app.close();}
  });

  it("does not grant original lineage to an earlier fixture claim or another token",async()=>{
    const f=await fixture();try{
      await db.query("UPDATE next_migration_cohort_members SET started_at=now()-interval '1 hour' WHERE account_id=$1",[f.account]);
      await f.accept();expect((await f.request()).statusCode).toBe(409);
      expect((await f.request("fence","ordinary-user-role")).statusCode).toBe(401);
      expect(f.provider.legacyMigrationFence).not.toHaveBeenCalled();
    }finally{await f.app.close();}
  });

  it("SQL elapsed guard preserves existing profiles and rejects malformed scoped structure",async()=>{
    const f=await fixture();try{
      parseVerifiedBatchArchive(f.verified);
      // Function accepts only millisecond trusted timestamps.
      const check=async(value:unknown)=>(await db.query<{valid:boolean}>("SELECT next_migration_archive_elapsed_valid($1::jsonb,date_trunc('milliseconds',now()),date_trunc('milliseconds',now())) AS valid",[JSON.stringify(value)])).rows[0]!.valid;
      expect(await check(f.verified)).toBe(true);
      const retained=structuredClone(f.verified);Object.assign(retained.scoped_recovery.source_fences[0]!,{unresolved:4,applied_unreceipted:9007199254740991});
      expect(await check(retained)).toBe(true);
      for(const kind of ["in-flight","relative-stamp","duplicate","unknown","unsafe-head","negative-unresolved","fractional-unresolved","unsafe-unresolved","string-unresolved","negative-applied","unsafe-applied","null-applied"]){
        const malformed=structuredClone(f.verified), fence=malformed.scoped_recovery.source_fences[0]!;
        if(kind==="in-flight")fence.in_flight=1;
        if(kind==="relative-stamp")fence.started_at="yesterday";
        if(kind==="duplicate")malformed.scoped_recovery.source_fences.push({...fence});
        if(kind==="unknown")Object.assign(fence,{pre_fenced:true});
        if(kind==="unsafe-head")fence.head=9007199254740992;
        if(kind==="negative-unresolved")fence.unresolved=-1;
        if(kind==="fractional-unresolved")fence.unresolved=1.5;
        if(kind==="unsafe-unresolved")fence.unresolved=9007199254740992;
        if(kind==="string-unresolved")Object.assign(fence,{unresolved:"4"});
        if(kind==="negative-applied")fence.applied_unreceipted=-1;
        if(kind==="unsafe-applied")fence.applied_unreceipted=9007199254740992;
        if(kind==="null-applied")Object.assign(fence,{applied_unreceipted:null});
        expect(await check(malformed),kind).toBe(false);
      }
      const old={...f.verified,schema:"mdbase-recovery-set/v4",environment:"staging"};delete (old as Partial<typeof old>).scoped_recovery;
      expect(await check(old)).toBe(true);
    }finally{await f.app.close();}
  });
});
