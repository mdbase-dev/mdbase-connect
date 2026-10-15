import {createHash,randomUUID} from "node:crypto";
import {copyFile,mkdtemp,readdir,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import pg from "pg";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {createDatabase,openDatabase,type DatabasePool} from "../../db.js";
import {assertControlPlaneMigrationsCurrent,runControlPlaneMigrations} from "../../migrations.js";
import type {HostedAuthorityRegistry} from "../../hosted.js";
import {createAccountCollection} from "./collection-creation.js";
const testUrl=process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved=process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL==="I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg=testUrl&&approved?describe:describe.skip;
describePg("account creation migration and transactional legacy receipt",()=>{
  let db:DatabasePool,admin:pg.Pool,schema:string;
  beforeAll(async()=>{
    const url=new URL(testUrl!);
    if(!["localhost","127.0.0.1","::1"].includes(url.hostname)||!/test/i.test(url.pathname))throw new Error("Requires dedicated local test Postgres.");
    schema=`account_create_${randomUUID().replaceAll("-","")}`;
    admin=new pg.Pool({connectionString:url.toString(),max:2});await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options",`-csearch_path=${schema}`);db=await createDatabase(url.toString());
  },60_000);
  afterAll(async()=>{await db?.end();if(admin&&schema)await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin?.end();});
  async function account(){const id=randomUUID();await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Owner')",[id,`${id}@example.test`]);return id;}
  it("the standard runner fills genuine missing 0076 after 0081, preserving applied SQL and immutable intent",async()=>{
    const directory=resolve(import.meta.dirname,"../../../migrations");
    const missing="0076_account_collection_creations";
    const baseline=await mkdtemp(join(tmpdir(),"account-creation-migrations-"));
    const gapSchema=`account_gap_${randomUUID().replaceAll("-","")}`;
    let gap:DatabasePool|undefined;
    try {
      // Build the actual predecessor migration directory, not a forged ledger.
      for(const file of await readdir(directory))if(file.endsWith(".sql")&&file!==`${missing}.sql`)await copyFile(join(directory,file),join(baseline,file));
      await admin.query(`CREATE SCHEMA "${gapSchema}"`);
      const url=new URL(testUrl!);url.searchParams.set("options",`-csearch_path=${gapSchema}`);
      gap=await openDatabase(url.toString());
      const options={lock:true,isolatedTestSchema:true};
      await runControlPlaneMigrations(gap,{...options,directory:baseline});
      const ledger=async()=>(await gap!.query("SELECT id,checksum,applied_at FROM schema_migrations ORDER BY id")).rows;
      const before=await ledger();
      expect(before.some(row=>row.id==="0081_lab_fixture_invitation_backend")).toBe(true);
      expect(before.some(row=>row.id===missing)).toBe(false);
      expect((await gap.query("SELECT to_regclass('account_collection_creations')::text AS name")).rows[0].name).toBeNull();
      await expect(assertControlPlaneMigrationsCurrent(gap)).rejects.toThrow(`migration ${missing} has not been applied`);
      await runControlPlaneMigrations(gap,options);
      const after=await ledger();
      expect(after.filter(row=>row.id!==missing)).toEqual(before);
      const sql=await readFile(join(directory,`${missing}.sql`),"utf8");
      expect(after.filter(row=>row.id===missing)).toEqual([{id:missing,checksum:createHash("sha256").update(sql).digest("hex"),applied_at:expect.any(Date)}]);
      await assertControlPlaneMigrationsCurrent(gap);
      const owner=randomUUID(),request=randomUUID(),collection=randomUUID();
      await gap.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Owner')",[owner,`${owner}@example.test`]);
      await gap.query("INSERT INTO account_collection_creations(user_id,request_id,collection_id,display_name,timezone,runtime) VALUES($1,$2,$3,'Original','UTC','legacy')",[owner,request,collection]);
      await expect(gap.query("UPDATE account_collection_creations SET display_name='Changed' WHERE user_id=$1",[owner])).rejects.toMatchObject({code:"23514"});
      await runControlPlaneMigrations(gap,options);
      expect(await ledger()).toEqual(after);
      expect((await gap.query("SELECT display_name FROM account_collection_creations WHERE user_id=$1",[owner])).rows).toEqual([{display_name:"Original"}]);
    } finally {
      await gap?.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${gapSchema}" CASCADE`);
      await rm(baseline,{recursive:true,force:true});
    }
  },60_000);

  it("freezes all original intent fields and publication; permits only one-way first receipt",async()=>{
    const owner=await account(),request=randomUUID(),collection=randomUUID();
    await db.query("INSERT INTO account_collection_creations(user_id,request_id,collection_id,display_name,timezone,runtime) VALUES($1,$2,$3,'Original','UTC','legacy')",[owner,request,collection]);
    for(const [field,value] of [["user_id",randomUUID()],["request_id",randomUUID()],["collection_id",randomUUID()],["display_name","Replacement"],["timezone","Australia/Melbourne"],["runtime","next"]]) {
      await expect(db.query(`UPDATE account_collection_creations SET ${field}=$3 WHERE user_id=$1 AND request_id=$2`,[owner,request,value])).rejects.toMatchObject({code:"23514"});
    }
    await expect(db.query("UPDATE account_collection_creations SET created_at=created_at+interval '1 second' WHERE user_id=$1 AND request_id=$2",[owner,request])).rejects.toMatchObject({code:"23514"});
    await db.query("UPDATE account_collection_creations SET published_at=now() WHERE user_id=$1 AND request_id=$2",[owner,request]);
    await db.query("UPDATE account_collection_creations SET published_at=COALESCE(published_at,now()) WHERE user_id=$1 AND request_id=$2",[owner,request]);
    await expect(db.query("UPDATE account_collection_creations SET published_at=NULL WHERE user_id=$1 AND request_id=$2",[owner,request])).rejects.toMatchObject({code:"23514"});
  });
  it("concurrent same-intent reservation stores exactly one server UUID/name",async()=>{
    const owner=await account(),request=randomUUID(),ids=[randomUUID(),randomUUID()];
    await Promise.all(ids.map((id,index)=>db.query("INSERT INTO account_collection_creations(user_id,request_id,collection_id,display_name,timezone,runtime) VALUES($1,$2,$3,$4,'UTC','legacy') ON CONFLICT(user_id,request_id) DO NOTHING",[owner,request,id,`Name ${index}`])));
    const rows=(await db.query("SELECT * FROM account_collection_creations WHERE user_id=$1 AND request_id=$2",[owner,request])).rows;
    expect(rows).toHaveLength(1);expect(rows[0].display_name).toBe(`Name ${ids.indexOf(rows[0].collection_id)}`);
  });
  it("commits legacy publication with its receipt; renamed or deleted acknowledged objects are never recreated",async()=>{
    const owner=await account(),requestId=randomUUID();
    const create=vi.fn(async()=>{});
    const options={db,hostedCollections:true,publicUrl:"https://connect.test",hostedReference:{create} as unknown as HostedAuthorityRegistry};
    const principal=async()=>{};const input={requestId,displayName:"Original",timezone:"UTC"};
    const first=await createAccountCollection(options,owner,input,principal);
    const intent=(await db.query("SELECT * FROM account_collection_creations WHERE user_id=$1 AND request_id=$2",[owner,requestId])).rows[0];
    expect(intent.collection_id).toBe(first.id);expect(intent.published_at).not.toBeNull();
    await db.query("UPDATE hosted_collections SET display_name='Renamed' WHERE id=$1",[first.id]);
    expect((await createAccountCollection(options,owner,input,principal)).display_name).toBe("Renamed");
    expect(create).toHaveBeenCalledTimes(1);
    await db.query("DELETE FROM hosted_collections WHERE id=$1",[first.id]);
    await expect(createAccountCollection(options,owner,input,principal)).rejects.toMatchObject({code:"collection_unavailable"});
    expect(create).toHaveBeenCalledTimes(1);
  });
});
