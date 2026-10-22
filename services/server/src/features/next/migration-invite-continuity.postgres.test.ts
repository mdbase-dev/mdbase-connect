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
import {labCohortCompletionEvidence,requireCompletedAccountMigration,requireCompletedMigrationInvitation,requireMigrationJobCompletion} from "./migration-sharing.js";
import {completeMigrationBatch} from "./migration-topology.js";
import {provisionNewAccountBackend} from "./account-backend-flip.js";
import {fakeLegacyProvider,recordEmptyTimerImport,type FakeLegacyProvider} from "./legacy-provider.test-helper.js";

const testUrl=process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved=process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL==="I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite=testUrl&&approved?describe:describe.skip;
const actor="synthetic-invite-continuity",migrationToken="public-fixed-migration-invite-test-token";
suite("original emailed invite continuity (CP counterexamples, NOT native migration)",()=>{
  let db:DatabasePool,admin:pg.Pool,schema:string;
  const app=Fastify();
  const legacy=new Map<string,FakeLegacyProvider>();
  const fake=(id:string)=>legacy.get(id)??legacy.set(id,fakeLegacyProvider(id)).get(id)!;
  beforeAll(async()=>{
    const url=new URL(testUrl!);
    if(!["localhost","127.0.0.1","::1","[::1]"].includes(url.hostname)||!/test/i.test(url.pathname))throw Error("Dedicated local test PostgreSQL required");
    schema=`migration_invites_${randomUUID().replaceAll("-","")}`;
    admin=new pg.Pool({connectionString:url.toString(),max:2});await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options",`-csearch_path=${schema}`);db=await createDatabase(url.toString());
    await app.register(cookie);registerErrorHandler(app);
    registerHostedSharingRoutes(app,{db,hostedCollections:true,hostedSharing:true});
    registerMigrationRolloutRoutes(app,{db,token:migrationToken,environment:"lab",provider:{
      legacyMigrationDrain:(id,options)=>fake(id).legacyMigrationDrain(id,options),
      legacyMigrationRetain:(id,until,options)=>fake(id).legacyMigrationRetain(id,until,options),
      legacyMigrationSource:(id,options)=>fake(id).legacyMigrationSource(id,options)},timers:true});
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
  async function guardedFlip(f:Fixture,via=app){
    const headers={authorization:`Bearer ${migrationToken}`},facts={s_final:7,cutover_seq:11,barrier_f:13,final_digest:"e".repeat(64)};
    const recorded=await via.inject({method:"POST",url:`/internal/v1/next/migration/collections/${f.collection}/cutover`,headers,payload:facts});expect(recorded.statusCode).toBe(200);
    await recordEmptyTimerImport(db,f.owner.id,fake(f.collection).source);
    const flipped=await via.inject({method:"POST",url:`/internal/v1/next/migration/accounts/${f.owner.id}/flip`,headers,payload:{collections:[f.collection],evidence_digest:flipEvidenceDigest([{collection_id:f.collection,barrier_f:facts.barrier_f,final_digest:facts.final_digest}])}});
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
  async function newNextOwnerInvite(){
    const owner=await account(true),target=await account(),collection=randomUUID();
    const client=await db.connect();try{await client.query("BEGIN");await provisionNewAccountBackend(client,owner.id,"next");await client.query("COMMIT");}finally{client.release();}
    await registerNextCollection(db,{collectionId:collection,ownerUserId:owner.id,runtime:"next",sync:"cloud_copy",rootKeyId:Buffer.alloc(16,17),ops:[{op:"genesis",owner:owner.id,root:Buffer.alloc(16,17),state:"cloud-copy"},{op:"member-set",account:owner.id,role:"owner"}]});
    const created=await app.inject({method:"POST",url:`/v1/hosted/collections/${collection}/invitations`,headers:owner.headers,payload:{email:target.email,role:"viewer"}});
    expect(created.statusCode,created.body).toBe(202);
    const token=(created.json().invitation as {token:string}).token;
    return {owner,target,collection,accept:()=>app.inject({method:"POST",url:"/v1/hosted/collection-invitations/accept",headers:target.headers,payload:{token}})};
  }
  it("a never-migrated account created on the next backend keeps ordinary invitation acceptance",async()=>{
    const f=await newNextOwnerInvite();
    const accepted=await f.accept();expect(accepted.statusCode,accepted.body).toBe(201);
    expect(accepted.json().membership).toMatchObject({collection_id:f.collection,role:"viewer",state:"active"});
  });
  it("a forged non-empty flip without cohort membership is not treated as a new next account",async()=>{
    const f=await newNextOwnerInvite();
    // Deliberate negative corruption: a flip naming collections can only come from a staged migration.
    await db.query("UPDATE next_migration_account_flips SET collections=ARRAY[$2::uuid] WHERE account_id=$1",[f.owner.id,f.collection]);
    const refused=await f.accept();expect(refused.statusCode).toBe(409);expect(refused.json().error.code).toBe("collection_migrating");
    expect((await db.query("SELECT id FROM collection_memberships WHERE collection_id=$1 AND user_id=$2",[f.collection,f.target.id])).rows).toHaveLength(0);
  });
  const completion=async(cohort:string)=>(await db.query("SELECT completed_at,completed_revision::text,membership_revision::text FROM next_migration_cohorts WHERE name=$1",[cohort])).rows[0]!;
  const labCompletions=async(cohort:string)=>(await db.query("SELECT metadata FROM audit_events WHERE event_type='next_migration.lab_complete' AND subject_id=$1",[cohort])).rows;
  async function guarded<T>(body:(client:pg.PoolClient)=>Promise<T>):Promise<T>{
    const client=await db.connect();try{await client.query("BEGIN");const r=await body(client);await client.query("ROLLBACK");return r;}finally{client.release();}
  }
  it("a suspended owner's completed migration keeps every original invitation pending; only the migration job readback passes",async()=>{
    const f=await fixture("viewer");await shadow(f);await guardedFlip(f);
    await db.query("UPDATE users SET suspended_at=now(),session_epoch=session_epoch+1 WHERE id=$1",[f.owner.id]);
    await guarded(client=>requireMigrationJobCompletion(client,f.collection,f.owner.id));
    await guarded(client=>expect(requireCompletedMigrationInvitation(client,f.collection,f.owner.id)).rejects.toMatchObject({code:"collection_migrating"}));
    await guarded(client=>expect(requireCompletedAccountMigration(client,f.collection,f.owner.id)).rejects.toMatchObject({code:"collection_migrating"}));
    expect((await accept(f)).statusCode).not.toBe(201);await originalPending(f);
  });
  it("a LAB-profile cohort completes in environment lab on its verified flip, without an archive acceptance",async()=>{
    const f=await fixture("viewer",false);await shadow(f);await retryable(f);await guardedFlip(f);
    const batch=await completion(f.cohort);
    expect(batch.completed_at).not.toBeNull();expect(batch.completed_revision).toBe(batch.membership_revision);
    expect((await db.query("SELECT 1 FROM next_migration_archive_acceptances WHERE cohort=$1",[f.cohort])).rows).toHaveLength(0);
    const binding=await cohortArchiveBinding(db,f.cohort);
    expect(await labCompletions(f.cohort)).toEqual([{metadata:{cohort:f.cohort,membership_revision:batch.membership_revision,membership_digest:binding.membership_digest,
      evidence_digest:flipEvidenceDigest([{collection_id:f.collection,barrier_f:13,final_digest:"e".repeat(64)}])}}]);
    await guarded(client=>requireCompletedAccountMigration(client,f.collection,f.owner.id));
    const accepted=await accept(f);expect(accepted.statusCode,accepted.body).toBe(201);
    // Completion is not undone by a free-text unfreeze.
    await expect(setCohortFrozen(db,f.cohort,false,"freeform text after completion",actor)).rejects.toMatchObject({code:"migration_frozen"});
    expect((await completion(f.cohort)).completed_at).not.toBeNull();
  });
  it.each(["staging","production","LAB",undefined])("LAB-profile completion is unreachable outside environment lab: %s",async environment=>{
    // The LAB start itself is refused outside lab; start in lab to model a
    // LAB-profile cohort that a non-LAB server then flips.
    const f=await fixture("viewer",false),other=Fastify();
    registerMigrationRolloutRoutes(other,{db,token:migrationToken,environment,provider:{
      legacyMigrationDrain:(id,options)=>fake(id).legacyMigrationDrain(id,options),
      legacyMigrationRetain:(id,until,options)=>fake(id).legacyMigrationRetain(id,until,options),
      legacyMigrationSource:(id,options)=>fake(id).legacyMigrationSource(id,options)},timers:true});
    try{await shadow(f);await guardedFlip(f,other);}finally{await other.close();}
    expect((await completion(f.cohort)).completed_at).toBeNull();expect(await labCompletions(f.cohort)).toHaveLength(0);
    // The evidence holds; only the environment refuses it, including on a direct call.
    const batch=(await db.query("SELECT frozen_at,membership_revision::text AS revision FROM next_migration_cohorts WHERE name=$1",[f.cohort])).rows[0]!;
    expect(await guarded(client=>labCohortCompletionEvidence(client,f.cohort,batch.revision))).not.toBeNull();
    const client=await db.connect();
    try{await client.query("BEGIN");await completeMigrationBatch(client,f.cohort,batch.revision,batch.frozen_at,environment);await client.query("COMMIT");}finally{client.release();}
    expect((await completion(f.cohort)).completed_at).toBeNull();expect(await labCompletions(f.cohort)).toHaveLength(0);
    await guarded(client=>expect(requireCompletedAccountMigration(client,f.collection,f.owner.id)).rejects.toMatchObject({code:"collection_migrating"}));
    await retryable(f);
  });
  it("LAB completion requires the start audit binding to the current inventory",async()=>{
    const f=await fixture("viewer",false);await shadow(f);
    await db.query("UPDATE audit_events SET metadata=jsonb_set(metadata,'{inventory,membership_digest}',to_jsonb($2::text)) WHERE event_type='next_migration.start' AND subject_id=$1",[f.owner.id,"0".repeat(64)]);
    await guardedFlip(f);
    expect((await completion(f.cohort)).completed_at).toBeNull();expect(await labCompletions(f.cohort)).toHaveLength(0);await retryable(f);
  });
  it("LAB completion evidence refuses changed cutovers after the flip",async()=>{
    const f=await fixture("viewer",false);await shadow(f);await guardedFlip(f);
    await db.query("UPDATE next_migration_collections SET final_digest=$2 WHERE collection_id=$1",[f.collection,"d".repeat(64)]);
    const revision=(await completion(f.cohort)).membership_revision;
    expect(await guarded(client=>labCohortCompletionEvidence(client,f.cohort,revision))).toBeNull();
  });
  it("forged completion with a LAB completion event needs the owner's LAB start binding and the completed revision",async()=>{
    const f=await fixture("viewer",false),staging=Fastify();
    registerMigrationRolloutRoutes(staging,{db,token:migrationToken,environment:"staging",provider:{
      legacyMigrationDrain:(id,options)=>fake(id).legacyMigrationDrain(id,options),
      legacyMigrationRetain:(id,until,options)=>fake(id).legacyMigrationRetain(id,until,options),
      legacyMigrationSource:(id,options)=>fake(id).legacyMigrationSource(id,options)},timers:true});
    try{await shadow(f);await guardedFlip(f,staging);}finally{await staging.close();}
    const revision=(await completion(f.cohort)).membership_revision,binding=await cohortArchiveBinding(db,f.cohort);
    // Deliberate negative corruption, NEVER positive terminal qualification.
    await db.query("UPDATE next_migration_cohorts SET completed_at=now(),completed_revision=membership_revision WHERE name=$1",[f.cohort]);
    const forge=(rev:string)=>db.query("INSERT INTO audit_events(id,user_id,event_type,subject_id,metadata) VALUES($1,NULL,'next_migration.lab_complete',$2,$3::jsonb)",
      [randomUUID(),f.cohort,JSON.stringify({cohort:f.cohort,membership_revision:rev,membership_digest:binding.membership_digest,evidence_digest:"0".repeat(64)})]);
    await forge(String(BigInt(revision)+1n));await retryable(f);
    await db.query("UPDATE audit_events SET metadata=jsonb_set(metadata,'{profile}','\"other\"') WHERE event_type='next_migration.start' AND subject_id=$1",[f.owner.id]);
    await forge(revision);await retryable(f);
  });
});
