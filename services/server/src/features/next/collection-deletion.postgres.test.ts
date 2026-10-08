import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseConnection, type DatabasePool } from "../../db.js";
import { mergeCollectionDeletionFloors, recordCollectionDeletionIntent, requireCollectionNotDeleted, reconcileCollectionDeletionFloors, type CollectionDeletionFact } from "./collection-deletion.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const max = (1n << 64n) - 1n;
const fact = (epoch = 1n): CollectionDeletionFact => ({collection:randomUUID(),deletionId:randomUUID(),lifecycleEpoch:epoch});
describePg("permanent CP deletion denial facts (dedicated local Postgres, no native effects)", () => {
  let db: DatabasePool, admin: pg.Pool, schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost","127.0.0.1","::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Dedicated local test Postgres required");
    schema = `collection_deletion_${randomUUID().replaceAll("-","")}`;
    admin = new pg.Pool({connectionString:url.toString(),max:2});
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options",`-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
  },60000);
  afterAll(async () => {await db?.end();if(admin&&schema)await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin?.end();});
  async function tx<T>(work:(client:DatabaseConnection)=>Promise<T>):Promise<T>{
    const client=await db.connect();try{await client.query("BEGIN");const value=await work(client);await client.query("COMMIT");return value;}
    catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }
  const rows=async(collection:string)=>(await db.query("SELECT deletion_id,lifecycle_epoch::text AS epoch,authority,actor_id FROM next_collection_deletion_facts WHERE collection_id=$1 ORDER BY lifecycle_epoch",[collection])).rows;
  it("fresh UUID is not denied; first CP intent is permanent and exact retries retain identity/epoch/actor",async()=>{
    const collection=randomUUID(),actor=randomUUID();await requireCollectionNotDeleted(db,collection);
    const first=await tx(c=>recordCollectionDeletionIntent(c,collection,actor));
    expect(first).toMatchObject({collection,lifecycleEpoch:1n});
    expect(await tx(c=>recordCollectionDeletionIntent(c,collection,randomUUID()))).toEqual(first);
    await expect(requireCollectionNotDeleted(db,collection)).rejects.toThrow("collection_deleted");
    expect(await rows(collection)).toEqual([{deletion_id:first.deletionId,epoch:"1",authority:"cp-intent",actor_id:actor}]);
  });
  it("concurrent first requests leave exactly one immutable CP intent",async()=>{
    const collection=randomUUID();const requests=await Promise.all(Array.from({length:8},()=>tx(c=>recordCollectionDeletionIntent(c,collection,randomUUID()))));
    expect(new Set(requests.map(r=>r.deletionId)).size).toBe(1);expect(await rows(collection)).toHaveLength(1);
  });
  it("intent/floor survive real user and live next/hosted row cascades",async()=>{
    const actor=randomUUID(),collection=randomUUID();await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Test')",[actor,`${actor}@example.test`]);
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,'Test','mdbase')",[collection,actor]);
    await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'next','cloud_copy',$3)",[collection,actor,Buffer.alloc(16)]);
    const intent=await tx(c=>recordCollectionDeletionIntent(c,collection,actor));await tx(c=>mergeCollectionDeletionFloors(c,[intent]));
    await db.query("DELETE FROM users WHERE id=$1",[actor]);expect(await rows(collection)).toHaveLength(2);
    await expect(requireCollectionNotDeleted(db,collection)).rejects.toThrow("collection_deleted");
  });
  it("preserves MAXu64 exactly, repeats idempotently and retains higher/local/conflicting denial facts",async()=>{
    const floor=fact(max);const local=await tx(c=>recordCollectionDeletionIntent(c,floor.collection,randomUUID()));
    await tx(c=>mergeCollectionDeletionFloors(c,[floor]));await tx(c=>mergeCollectionDeletionFloors(c,[floor]));
    await tx(c=>mergeCollectionDeletionFloors(c,[{...floor,deletionId:randomUUID(),lifecycleEpoch:2n}]));
    expect((await rows(floor.collection)).map(r=>r.epoch)).toEqual(["1","2",max.toString()]);
    expect((await rows(floor.collection)).some(r=>r.deletion_id===local.deletionId)).toBe(true);
    await expect(requireCollectionNotDeleted(db,floor.collection)).rejects.toThrow("collection_deleted");
  });
  it("an already observed native floor supplies no fabricated CP intent",async()=>{
    const floor=fact(7n);await tx(c=>mergeCollectionDeletionFloors(c,[floor]));
    expect(await tx(c=>recordCollectionDeletionIntent(c,floor.collection,randomUUID()))).toEqual(floor);
    expect(await rows(floor.collection)).toHaveLength(1);
  });
  it("validates the entire page before any writes, including duplicate collections/u64/non-nil UUID",async()=>{
    const good=fact();const bad=[{...fact(),lifecycleEpoch:0n},{...fact(),lifecycleEpoch:max+1n},{...fact(),deletionId:"00000000-0000-0000-0000-000000000000"}];
    for(const value of bad){await expect(tx(c=>mergeCollectionDeletionFloors(c,[good,value]))).rejects.toThrow();expect(await rows(good.collection)).toHaveLength(0);}
    await expect(tx(c=>mergeCollectionDeletionFloors(c,[good,{...good,deletionId:randomUUID()}]))).rejects.toThrow("duplicate_collection_deletion_floor");
    await expect(tx(c=>mergeCollectionDeletionFloors(c,Array.from({length:129},()=>fact())))).rejects.toThrow("invalid_collection_deletion_page");
    expect(await rows(good.collection)).toHaveLength(0);
  });
  it("failed surrounding transaction leaves no acknowledged intent/page effects",async()=>{
    const value=fact();await expect(tx(async c=>{await mergeCollectionDeletionFloors(c,[value]);throw new Error("synthetic crash before commit");})).rejects.toThrow("synthetic crash");
    await requireCollectionNotDeleted(db,value.collection);expect(await rows(value.collection)).toHaveLength(0);
  });
  it("commits 130-row pinned pages and requires a final unchanged-generation empty check",async()=>{
    const values=Array.from({length:130},(_,i)=>({...fact(max),collection:`${(1000+i).toString(16).padStart(8,"0")}-0000-4000-8000-000000000000`}));
    let calls=0;
    const registry={registryCollectionDeletions:async(after:string|null,expected:bigint|null)=>{
      const index=calls++;
      expect(expected).toBe(index===0?null:max);
      expect(after).toBe(index===0?null:index===1?values[127]!.collection:values[129]!.collection);
      return index===0?{generation:max,rows:values.slice(0,128),after:values[127]!.collection,done:false}
        :{generation:max,rows:index===1?values.slice(128):[],after:values[129]!.collection,done:true};
    }};
    expect(await reconcileCollectionDeletionFloors(db,registry)).toBe(max);expect(calls).toBe(3);
    for(const value of [values[0]!,values[127]!,values[129]!]){
      expect((await rows(value.collection))[0]?.epoch).toBe(max.toString());await expect(requireCollectionNotDeleted(db,value.collection)).rejects.toThrow("collection_deleted");
    }
  });
  it("partial, final-check drift and restart preserve committed denial facts without returning a completed scan",async()=>{
    for(const failure of ["partial","final-drift"]){
      const value=fact(), values=failure==="partial"?[value,...Array.from({length:127},()=>fact())].sort((a,b)=>a.collection.localeCompare(b.collection)):[value];
      const cursor=values.at(-1)!.collection;let calls=0;
      const registry={registryCollectionDeletions:async()=>{
        if(calls++===0)return{generation:7n,rows:values,after:cursor,done:values.length<128};
        if(failure==="partial")throw new Error("synthetic peer unavailable");
        return{generation:8n,rows:[],after:cursor,done:true};
      }};
      await expect(reconcileCollectionDeletionFloors(db,registry)).rejects.toThrow(failure==="partial"?"synthetic peer unavailable":"generation_drift");
      expect(await rows(value.collection)).toHaveLength(1);await expect(requireCollectionNotDeleted(db,value.collection)).rejects.toThrow("collection_deleted");
      let retry=0;const current={registryCollectionDeletions:async()=>{const first=retry++===0;return{generation:8n,rows:first?values:[],after:cursor,done:!first||values.length<128};}};
      expect(await reconcileCollectionDeletionFloors(db,current)).toBe(8n);expect(await rows(value.collection)).toHaveLength(1);
    }
  });
  it("DB constraints reject nil identity and out-of-range epochs; no cascade references exist",async()=>{
    for(const epoch of ["0","18446744073709551616"]){await expect(db.query("INSERT INTO next_collection_deletion_facts(collection_id,deletion_id,lifecycle_epoch,authority) VALUES($1,$2,$3,'native-registry')",[randomUUID(),randomUUID(),epoch])).rejects.toThrow();}
    await expect(db.query("INSERT INTO next_collection_deletion_facts(collection_id,deletion_id,lifecycle_epoch,authority) VALUES($1,$2,1,'native-registry')",["00000000-0000-0000-0000-000000000000",randomUUID()])).rejects.toThrow();
    const constraints=await db.query("SELECT constraint_name FROM information_schema.table_constraints WHERE table_schema=$1 AND table_name='next_collection_deletion_facts' AND constraint_type='FOREIGN KEY'",[schema]);expect(constraints.rows).toEqual([]);
  });
});
