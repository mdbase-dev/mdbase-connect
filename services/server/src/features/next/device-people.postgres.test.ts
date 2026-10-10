import { randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { tokenHash } from "../../security.js";
import { registerPeopleRoutes } from "../account/people-routes.js";
import { registerErrorHandler } from "../../platform/error-handler.js";
import { enrolOp } from "./bootstrap-common.js";
import { queueNextPolicy, registerNextCollection } from "./policy-outbox.js";
import type { PolicyOp } from "./policy-wire.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
suite("current next-device people without legacy authority (isolated PostgreSQL)",()=>{
  let db:DatabasePool, admin:pg.Pool, schema:string;
  const app=Fastify();
  beforeAll(async()=>{
    const url=new URL(testUrl!);
    if(!["localhost","127.0.0.1","[::1]"].includes(url.hostname)||!/test/i.test(url.pathname))throw new Error("Requires isolated local test PostgreSQL.");
    schema=`device_people_${randomUUID().replaceAll("-","")}`;
    admin=new pg.Pool({connectionString:url.toString(),max:2});await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options",`-csearch_path=${schema}`);db=await createDatabase(url.toString());
    registerErrorHandler(app);registerPeopleRoutes(app,{db,issuer:"https://id.example",publicUrl:"https://connect.example",editorOrigin:"https://editor.example"});
  },60000);
  afterAll(async()=>{await app.close();await db?.end();if(admin&&schema)await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin?.end();});
  async function fixture(sync:"private"|"cloud_copy"="cloud_copy",callerIsOwner=false,enrol=true){
    const owner=randomUUID(),member=randomUUID(),connector=randomUUID(),device=randomUUID(),collection=randomUUID(),token=`ct_${randomUUID()}`;
    for(const [id,name] of [[owner,"Owner"],[member,"Member"]])await db.query("INSERT INTO users(id,email,name,account_backend) VALUES($1,$2,$3,'next')",[id,`${id}@private.example`,name]);
    const account=callerIsOwner?owner:member;
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'People device',$3)",[connector,account,tokenHash(token)]);
    const keys={kind:"desktop" as const,sign_pk:randomBytes(32),kem_pk:randomBytes(32),noise_pk:randomBytes(32)};
    await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$3,'desktop',$4,$5,$6)",[device,connector,account,keys.sign_pk,keys.kem_pk,keys.noise_pk]);
    const root=randomBytes(16);
    await registerNextCollection(db,{collectionId:collection,ownerUserId:owner,runtime:"next",sync,rootKeyId:root,ops:[
      {op:"genesis",owner,root,state:sync==="private"?"e2e":"cloud-copy"},
      {op:"member-set",account:owner,role:"owner"},
      {op:"member-set",account:member,role:"viewer"},...(enrol?[enrolOp(device,account,keys)]:[]),
    ]});
    // This suite qualifies CP metadata admission. Real policy crypto/key delivery
    // is separately covered by the replica; never claim fake item bytes as crypto.
    async function acknowledge(){
      const seq=Number((await db.query<{seq:string|null}>("SELECT max(seq) AS seq FROM next_policy_batches WHERE collection_id=$1",[collection])).rows[0]!.seq??0)+1;
      const batch=(await db.query<{id:string}>("INSERT INTO next_policy_batches(collection_id,seq,prev,item,issued_at,state) VALUES($1,$2,$3,$4,$5,'appended') RETURNING id",[collection,seq,Buffer.alloc(32),Buffer.from([1]),Date.now()])).rows[0]!.id;
      await db.query("UPDATE next_policy_outbox SET batch_id=$2 WHERE collection_id=$1 AND batch_id IS NULL",[collection,batch]);return batch;
    }
    const batch=await acknowledge();
    const get=(permission:"identity"|"members",id=collection,did:string|null=device,bearer=token)=>app.inject({method:"GET",url:`/v1/authorities/${id}/${permission}${did?`?device_id=${did}`:""}`,headers:{authorization:`Bearer ${bearer}`}});
    const queue=(ops:PolicyOp[])=>queueNextPolicy(db,collection,ops);
    return {owner,member,account,connector,device,collection,token,keys,batch,get,queue,acknowledge};
  }
  it.each(["cloud_copy","private"] as const)("returns exact public identity/member metadata for %s, without hosted/grant rows",async sync=>{
    const f=await fixture(sync);
    const identity=await f.get("identity",f.collection.toUpperCase(),f.device.toUpperCase());
    expect(identity.statusCode,identity.body).toBe(200);expect(identity.json()).toMatchObject({issuer:"https://id.example",name:"Member",account_id:f.member,person_settings_url:expect.stringContaining("your-person")});
    expect(identity.json().subject).toMatch(/^acct_[0-9a-f]{32}$/);expect(identity.headers["cache-control"]).toBe("no-store");
    const members=await f.get("members");expect(members.statusCode,members.body).toBe(200);
    expect(members.json().members.map((r:{account_id:string;role:string})=>({account:r.account_id,role:r.role}))).toEqual(expect.arrayContaining([{account:f.owner,role:"owner"},{account:f.member,role:"viewer"}]));
    expect(members.body).not.toContain("private.example");
    expect((await db.query("SELECT id FROM hosted_collections WHERE id=$1",[f.collection])).rows).toEqual([]);
    expect((await db.query("SELECT id FROM grants WHERE logical_collection_id=$1",[f.collection])).rows).toEqual([]);
  });
  it("ordinary native owner metadata does not depend on account backend flip",async()=>{
    const f=await fixture("private",true);await db.query("UPDATE users SET account_backend='legacy' WHERE id=$1",[f.owner]);
    expect((await f.get("identity")).json().account_id).toBe(f.owner);
  });
  it("requires the exact registered device/connector/token and current collection",async()=>{
    const f=await fixture();
    expect((await f.get("identity",f.collection,null)).statusCode).toBe(400);
    expect((await f.get("identity",f.collection,randomUUID())).statusCode).toBe(403);
    expect((await f.get("identity",randomUUID())).statusCode).toBe(409);
    expect((await f.get("identity",f.collection,f.device,"ct_unknown")).statusCode).toBe(401);
    await db.query("UPDATE connectors SET revoked_at=now() WHERE id=$1",[f.connector]);
    expect((await f.get("identity")).statusCode).toBe(401);
  });
  it.each(["shadow","left","deleted","owner-suspended","caller-suspended","keys"] as const)("refuses %s without disclosing a directory",async state=>{
    const f=await fixture();
    if(state==="shadow")await db.query("UPDATE next_collections SET runtime='shadow' WHERE collection_id=$1",[f.collection]);
    if(state==="left")await db.query("UPDATE next_collections SET left_sync_at=now() WHERE collection_id=$1",[f.collection]);
    if(state==="deleted")await db.query("INSERT INTO next_collection_deletion_facts(collection_id,deletion_id,lifecycle_epoch,authority) VALUES($1,$2,1,'native-registry')",[f.collection,randomUUID()]);
    if(state==="owner-suspended"||state==="caller-suspended")await db.query("UPDATE users SET suspended_at=now() WHERE id=$1",[state==="owner-suspended"?f.owner:f.member]);
    if(state==="keys")await db.query("UPDATE next_devices SET sign_pk=$2 WHERE id=$1",[f.device,randomBytes(32)]);
    for(const permission of ["identity","members"] as const){const response=await f.get(permission);expect(response.statusCode).toBeGreaterThanOrEqual(400);expect(response.json()).not.toHaveProperty("members");}
  });
  it.each(["sign_pk","kem_pk","noise_pk","kind"] as const)("requires original enrolment %s",async field=>{
    const f=await fixture();
    await db.query(`UPDATE next_devices SET ${field}=$2 WHERE id=$1`,[f.device,field==="kind"?"mobile":randomBytes(32)]);
    expect((await f.get("identity")).json().error.code).toBe("not_enrolled");
  });
  it("queued removal denies immediately; re-addition cannot restore historical device metadata",async()=>{
    const f=await fixture();await f.queue([{op:"member-remove",account:f.member}]);
    expect((await f.get("identity")).json().error.code).toBe("not_member");
    await f.acknowledge();await f.queue([{op:"member-set",account:f.member,role:"viewer"}]);await f.acknowledge();
    expect((await f.get("identity")).json().error.code).toBe("device_revoked");
    expect((await f.get("members")).statusCode).toBe(409);
  });
  it("acknowledged membership cannot substitute for pending/lost exact device enrolment",async()=>{
    const f=await fixture("private",false,false);await f.queue([enrolOp(f.device,f.account,f.keys)]);
    expect((await f.get("identity")).json().error.code).toBe("not_enrolled");
    const batch=await f.acknowledge();expect((await f.get("identity")).statusCode).toBe(200);
    await db.query("UPDATE next_policy_batches SET lost_at=now() WHERE id=$1",[batch]);
    expect((await f.get("members")).json().error.code).toBe("not_enrolled");
  });
  it("unacknowledged/lost enrolment and membership do not grant people access",async()=>{
    const f=await fixture();await db.query("UPDATE next_policy_batches SET state='sending' WHERE id=$1",[f.batch]);
    expect((await f.get("identity")).json().error.code).toBe("not_member");
    await db.query("UPDATE next_policy_batches SET state='appended',lost_at=now() WHERE id=$1",[f.batch]);
    expect((await f.get("members")).json().error.code).toBe("not_member");
  });
});
