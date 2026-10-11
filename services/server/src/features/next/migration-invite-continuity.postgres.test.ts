// Actual isolated PostgreSQL/HTTP guarded CP APIs with PUBLIC synthetic verifier
// and cutover DATA. Not archive bytes, native H1/recovery or live migration proof.
import {randomUUID} from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import pg from "pg";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {createDatabase,type DatabasePool} from "../../db.js";
import {registerHostedSharingRoutes} from "../hosted/sharing-routes.js";
import {registerErrorHandler} from "../../platform/error-handler.js";
import {tokenHash} from "../../security.js";
import {createCohort,addToCohort,setCohortFrozen,releaseCohort,setPaused,cohortArchiveBinding,registerMigrationRolloutRoutes,acceptCohortArchive,flipEvidenceDigest} from "./migration-rollout.js";
import {registerNextCollection} from "./policy-outbox.js";
import {requireCompletedAccountMigration} from "./migration-sharing.js";

const testUrl=process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved=process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL==="I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite=testUrl&&approved?describe:describe.skip;
const actor="synthetic-invite-continuity",migrationToken="public-fixed-migration-invite-test-token";
suite("original emailed invite continuity (CP counterexamples, NOT native migration)",()=>{
  let db:DatabasePool,admin:pg.Pool,schema:string;
  const app=Fastify();
  beforeAll(async()=>{
    const url=new URL(testUrl!);
    if(!["localhost","127.0.0.1","::1","[::1]"].includes(url.hostname)||!/test/i.test(url.pathname))throw Error("Dedicated local test PostgreSQL required");
    schema=`migration_invites_${randomUUID().replaceAll("-","")}`;
    admin=new pg.Pool({connectionString:url.toString(),max:2});await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options",`-csearch_path=${schema}`);db=await createDatabase(url.toString());
    await app.register(cookie);registerErrorHandler(app);
    registerHostedSharingRoutes(app,{db,hostedCollections:true,hostedSharing:true});
    registerMigrationRolloutRoutes(app,{db,token:migrationToken,environment:"lab"});
  },60_000);
  afterAll(async()=>{await app.close();await db?.end();if(admin&&schema)await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin?.end();});
  async function account(owner=false){
    const id=randomUUID(),email=`${id}@example.test`,session=randomUUID();
    await db.query("INSERT INTO users(id,email,name,account_backend,session_epoch) VALUES($1,$2,'Synthetic invite continuity','legacy',1)",[id,email]);
    await db.query("INSERT INTO email_identities(id,user_id,email,normalized_email,verified_at,is_primary) VALUES($1,$2,$3,$3,now(),true)",[randomUUID(),id,email]);
    if(owner){
      await db.query("INSERT INTO account_entitlement_grants(id,user_id,profile_code,source,source_reference) VALUES($1,$2,'beta_v1','operator',$3)",[randomUUID(),id,randomUUID()]);
      await db.query("INSERT INTO account_storage_accounts(user_id,provider_account_id) VALUES($1,$2)",[id,randomUUID()]);
    }
    await db.query("INSERT INTO sessions(id,user_id,token_hash,provider,account_session_epoch,expires_at) VALUES($1,$2,$3,'password',1,now()+interval '1 day')",[randomUUID(),id,tokenHash(session)]);
    return {id,email,headers:{cookie:`mdbase_session=${session}`}};
  }
  type Role="viewer"|"editor";
  async function fixture(role:Role,fullArchive=true){
    const owner=await account(true),target=await account(),collection=randomUUID();
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template,provider_url,authority_state) VALUES($1,$2,'Synthetic source','mdbase','https://provider.example','active')",[collection,owner.id]);
    const created=await app.inject({method:"POST",url:`/v1/hosted/collections/${collection}/invitations`,headers:owner.headers,payload:{email:target.email,role}});
    expect(created.statusCode).toBe(202);
    const invitation=created.json().invitation as {id:string;token:string};
    const saved=(await db.query("SELECT * FROM collection_invitations WHERE id=$1",[invitation.id])).rows[0]!;
    const cohort=`invite-${randomUUID()}`;
    await createCohort(db,cohort,actor);await addToCohort(db,cohort,[owner.id],actor);
    await setCohortFrozen(db,cohort,true,"synthetic source freeze",actor);await releaseCohort(db,cohort,actor);await setPaused(db,false,"synthetic fixture",actor);
    const inventory=await cohortArchiveBinding(db,cohort);
    if(fullArchive){
      // Existing verifier DATA contract only. No archive writer/hold/bytes,
      // native receipt, SQL acceptance injection or shared LAB operation.
      const at=new Date((await db.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now).toISOString();
      const component=(name:string,hex:string)=>({commit:hex.repeat(40),image_digest:`sha256:${hex.repeat(64)}`,service_id:`srv-synthetic${name}`});
      await acceptCohortArchive(db,cohort,{schema:"mdbase-recovery-set/lab-cohort-v1",environment:"lab",bucket:"synthetic-archives",prefix:`legacy-archive/lab/2026/10/11/${cohort}`,backup_id:cohort,
        complete_sha256:"a".repeat(64),manifest_sha256:"b".repeat(64),source_commit:"f".repeat(40),migration_batch:inventory,archive_created_at:at,archive_completed_at:at,
        retention:{mode:"GOVERNANCE",days:116,retain_until:new Date(Date.parse(at)+116*86_400_000).toISOString(),inventory_digest:"c".repeat(64),count:"1"},
        runtime_provenance:{connect:component("connect","a"),hosted_provider:component("provider","b"),relay:component("relay","c"),mcp:component("mcp","d")}},"lab");
    }
    const started=await app.inject({method:"POST",url:`/internal/v1/next/migration/accounts/${owner.id}/start`,headers:{authorization:`Bearer ${migrationToken}`},payload:fullArchive?{}:{profile:"lab-fixture-v1",inventory}});
    expect(started.statusCode).toBe(200);
    return {owner,target,collection,invitation,saved,cohort,role};
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>;
  const accept=(f:Fixture,headers=f.target.headers)=>app.inject({method:"POST",url:"/v1/hosted/collection-invitations/accept",headers,payload:{token:f.invitation.token}});
  async function shadow(f:Fixture){
    await registerNextCollection(db,{collectionId:f.collection,ownerUserId:f.owner.id,runtime:"shadow",sync:"cloud_copy",rootKeyId:Buffer.alloc(16,17),ops:[{op:"genesis",owner:f.owner.id,root:Buffer.alloc(16,17),state:"cloud-copy"},{op:"member-set",account:f.owner.id,role:"owner"}]});
  }
  async function guardedFlip(f:Fixture){
    const headers={authorization:`Bearer ${migrationToken}`},facts={s_final:7,cutover_seq:11,barrier_f:13,final_digest:"e".repeat(64)};
    const recorded=await app.inject({method:"POST",url:`/internal/v1/next/migration/collections/${f.collection}/cutover`,headers,payload:facts});expect(recorded.statusCode).toBe(200);
    const flipped=await app.inject({method:"POST",url:`/internal/v1/next/migration/accounts/${f.owner.id}/flip`,headers,payload:{collections:[f.collection],evidence_digest:flipEvidenceDigest([{collection_id:f.collection,barrier_f:facts.barrier_f,final_digest:facts.final_digest}])}});
    expect(flipped.statusCode).toBe(200);
  }
  async function originalPending(f:Fixture){
    const row=(await db.query("SELECT * FROM collection_invitations WHERE id=$1",[f.invitation.id])).rows[0]!;
    expect(row.state).toBe("pending");expect(row.id).toBe(f.saved.id);expect(row.collection_id).toBe(f.collection);
    expect(row.token_hash===f.saved.token_hash).toBe(true);expect(row.expires_at).toEqual(f.saved.expires_at);
    for(const key of ["role","preset_version","actions","operations","scope_ceiling","file_ceiling"] as const)expect(row[key]).toEqual(f.saved[key]);
    expect((await db.query("SELECT count(*)::int AS n FROM collection_invitations WHERE collection_id=$1",[f.collection])).rows[0].n).toBe(1);
    expect((await db.query("SELECT id FROM collection_memberships WHERE collection_id=$1 AND user_id=$2",[f.collection,f.target.id])).rows).toHaveLength(0);
    expect((await db.query("SELECT id FROM next_policy_outbox WHERE collection_id=$1 AND ops->'ops' @> $2::jsonb",[f.collection,JSON.stringify([{op:"member-set",account:f.target.id}])])).rows).toHaveLength(0);
  }
  async function retryable(f:Fixture){
    const response=await accept(f);expect(response.statusCode).toBe(409);expect(response.headers["retry-after"]).toBe("5");expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().error).toMatchObject({code:"collection_migrating",details:{retry_after_seconds:5}});await originalPending(f);
  }
  it.each(["viewer","editor"] as const)("original %s link/immutable policy survives guarded CP flip with global freeze retained",async role=>{
    const f=await fixture(role);await retryable(f);await shadow(f);await retryable(f);await guardedFlip(f);
    const batch=(await db.query("SELECT frozen_at,completed_at FROM next_migration_cohorts WHERE name=$1",[f.cohort])).rows[0]!;
    expect(batch.frozen_at).not.toBeNull();expect(batch.completed_at).not.toBeNull();
    const accepted=await accept(f);expect(accepted.statusCode).toBe(201);
    expect(accepted.json().membership).toMatchObject({collection_id:f.collection,role,state:"active"});
    const row=(await db.query("SELECT * FROM collection_invitations WHERE id=$1",[f.invitation.id])).rows[0]!;
    expect(row.state).toBe("accepted");expect(row.accepted_membership_id).toBe(accepted.json().membership.id);
    expect(row.token_hash===f.saved.token_hash).toBe(true);expect(row.expires_at).toEqual(f.saved.expires_at);
    const policy=(await db.query("SELECT p.* FROM collection_membership_policies p JOIN collection_memberships m ON m.current_policy_id=p.id AND m.id=p.membership_id AND m.current_policy_revision=p.revision WHERE m.id=$1 AND m.collection_id=$2 AND m.user_id=$3",[row.accepted_membership_id,f.collection,f.target.id])).rows[0]!;
    for(const key of ["role","preset_version","actions","operations","scope_ceiling","file_ceiling"] as const)expect(policy[key]).toEqual(f.saved[key]);
    const outbox=(await db.query<{ops:{ops:unknown[]}}>("SELECT ops FROM next_policy_outbox WHERE collection_id=$1 AND ops->'ops' @> $2::jsonb",[f.collection,JSON.stringify([{op:"member-set",account:f.target.id}])])).rows;
    expect(outbox).toHaveLength(1);expect(outbox[0]!.ops.ops).toEqual([{op:"member-set",account:f.target.id,role}]);
    expect((await accept(f)).statusCode).toBe(400);
  });
  it("wrong target/expired original token refuse after guarded CP flip without side effects",async()=>{
    const f=await fixture("viewer"),other=await account();await shadow(f);await guardedFlip(f);
    expect((await accept(f,other.headers)).statusCode).toBe(400);await originalPending(f);
    await db.query("UPDATE collection_invitations SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1",[f.invitation.id]);
    expect((await accept(f)).statusCode).toBe(400);
    expect((await db.query("SELECT id FROM collection_memberships WHERE collection_id=$1 AND user_id=$2",[f.collection,f.target.id])).rows).toHaveLength(0);
  });
  it("forged NEXT/completed labels and tampered original cutover digest cannot authorize acceptance",async()=>{
    const f=await fixture("viewer");await shadow(f);
    // Deliberate negative corruption, NEVER positive terminal qualification.
    await db.query("UPDATE next_collections SET runtime='next' WHERE collection_id=$1",[f.collection]);
    await db.query("UPDATE users SET account_backend='next' WHERE id=$1",[f.owner.id]);
    await db.query("UPDATE next_migration_cohorts SET completed_at=now(),completed_revision=membership_revision WHERE name=$1",[f.cohort]);await retryable(f);
    const valid=await fixture("editor");await shadow(valid);await guardedFlip(valid);
    await db.query("UPDATE next_migration_account_flips SET evidence_digest=$2 WHERE account_id=$1",[valid.owner.id,"0".repeat(64)]);await retryable(valid);
  });
  it("strict terminal observation cannot admit an ordinary NEXT account without the original migration ledger",async()=>{
    const owner=await account(true),collection=randomUUID();
    await registerNextCollection(db,{collectionId:collection,ownerUserId:owner.id,runtime:"next",sync:"cloud_copy",rootKeyId:Buffer.alloc(16,17),ops:[{op:"genesis",owner:owner.id,root:Buffer.alloc(16,17),state:"cloud-copy"},{op:"member-set",account:owner.id,role:"owner"}]});
    await db.query("UPDATE users SET account_backend='next' WHERE id=$1",[owner.id]);
    const client=await db.connect();try{await client.query("BEGIN");await expect(requireCompletedAccountMigration(client,collection,owner.id)).rejects.toMatchObject({code:"collection_migrating"});await client.query("ROLLBACK");}finally{client.release();}
  });
  it("tiny guarded CP flip and freeform audited unfreeze cannot replace native verify/recovery completion",async()=>{
    const f=await fixture("viewer",false);await shadow(f);await guardedFlip(f);await retryable(f);
    await setCohortFrozen(db,f.cohort,false,"native verification complete (freeform text NOT proof)",actor);await retryable(f);
    expect((await db.query("SELECT completed_at FROM next_migration_cohorts WHERE name=$1",[f.cohort])).rows[0].completed_at).toBeNull();
  });
});
