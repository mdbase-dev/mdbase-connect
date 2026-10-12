// Original completion readback for invitation continuity and imported timers.
// Global topology/archive freeze stays unchanged. Terminal SQL labels alone
// are not a validated account flip; callers retain their original transaction.
import { createHash } from "node:crypto";
import type { DatabaseConnection, DatabaseQueryable } from "../../database-types.js";
import { flipEvidenceDigest } from "./account-backend-flip.js";
import { RequestValidationError } from "../../platform/http-errors.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HEX64=/^[0-9a-f]{64}$/u;
const MAX_COLLECTIONS=1000;
export class InvitationMigrationPending extends RequestValidationError {
  constructor(){super("This collection is being upgraded. Try again shortly.",{code:"collection_migrating",statusCode:409,details:{retry_after_seconds:5}});}
}
interface Terminal {
  started_at:Date;completed_at:Date;flipped_at:Date;collections:unknown;evidence_digest:string;
  cohort:string;archive_digest:string;
}
interface Cutover {
  collection_id:string;authority_state:string;quarantined_at:Date|null;
  runtime:string|null;sync:string|null;left_sync_at:Date|null;
  s_final:string|null;cutover_seq:string|null;barrier_f:string|null;final_digest:string|null;
}
/** Written by `startAccountMigration` for the tiny LAB profile (environment lab only). */
const LAB_START_PROFILE="lab-fixture-v1";
/** Written only by `completeMigrationBatch` in environment lab. */
export const LAB_COMPLETION_EVENT="next_migration.lab_complete";
const time=(v:unknown):number=>v instanceof Date?v.getTime():NaN;
const sequence=(v:unknown,positive=false):boolean=>typeof v==="string"&&/^(0|[1-9][0-9]*)$/u.test(v)&&BigInt(v)<=(1n<<63n)-1n&&(!positive||BigInt(v)>0n);

/** Caller already holds the original account/cohort locks from the refused
 * topology check. Reads only actual CP ledger/registry; no caller completion,
 * Outcome, arbitrary projection, profile flag or receipt is accepted here. */
export async function requireCompletedMigrationInvitation(client:DatabaseConnection,collection:string,owner:string):Promise<void> {
  const participation=(await client.query<{member:boolean;started_at:Date|null;frozen_at:Date|null;flipped_account:string|null}>(
    `SELECT m.account_id IS NOT NULL AS member,m.started_at,c.frozen_at,f.account_id::text AS flipped_account FROM users u
     LEFT JOIN next_migration_cohort_members m ON m.account_id=u.id
     LEFT JOIN next_migration_cohorts c ON c.name=m.cohort
     LEFT JOIN next_migration_account_flips f ON f.account_id=u.id WHERE u.id=$1`,[owner]
  )).rows[0];
  if(!participation)throw new InvitationMigrationPending();
  if(participation.started_at===null&&participation.frozen_at===null&&participation.flipped_account===null)return;
  // An account created on the next backend is flipped at creation with no
  // collections and no cohort membership: it never migrated. A staged flip
  // always has a cohort member row, which only account deletion removes.
  if(!participation.member&&participation.flipped_account!==null){
    const flip=(await client.query<{collections:unknown}>(
      "SELECT collections::text[] AS collections FROM next_migration_account_flips WHERE account_id=$1",[owner]
    )).rows[0];
    if(flip&&Array.isArray(flip.collections)&&flip.collections.length===0)return;
  }
  // Also guard an audited unfreeze: it is not a substitute for completion.
  await requireCompletedAccountMigration(client,collection,owner);
}

/** Strict original terminal-ledger readback, never the ordinary-account early
 * return. Caller retains its normal locks/authority/freeze checks separately;
 * this read-only observation does not authorize another freeze exception. */
export async function requireCompletedAccountMigration(client:DatabaseQueryable,collection:string,owner:string):Promise<void> {
  const terminal=(await client.query<Terminal>(
    `SELECT m.started_at,c.completed_at,f.flipped_at,f.collections::text[] AS collections,f.evidence_digest,
       c.name AS cohort,COALESCE(a.verified_result->'migration_batch'->>'membership_digest',l.membership_digest) AS archive_digest
     FROM users u JOIN next_migration_cohort_members m ON m.account_id=u.id
     JOIN next_migration_cohorts c ON c.name=m.cohort
     JOIN next_migration_account_flips f ON f.account_id=u.id
     LEFT JOIN next_migration_archive_acceptances a ON a.cohort=c.name AND a.membership_revision=c.completed_revision
     -- Without an accepted archive, only the LAB completion written by
     -- completeMigrationBatch in environment lab, for this completed revision
     -- and this owner's LAB start binding, supplies the membership digest.
     LEFT JOIN LATERAL (SELECT e.metadata->>'membership_digest' AS membership_digest FROM audit_events e
       WHERE a.cohort IS NULL AND e.user_id IS NULL AND e.event_type='${LAB_COMPLETION_EVENT}' AND e.subject_id=c.name
         AND e.metadata->>'membership_revision'=c.completed_revision::text
         AND EXISTS (SELECT 1 FROM audit_events s WHERE s.user_id=u.id AND s.event_type='next_migration.start'
           AND s.subject_id=u.id::text AND s.metadata->>'profile'='${LAB_START_PROFILE}'
           AND s.metadata->'inventory'->>'batch_id'=c.name
           AND s.metadata->'inventory'->>'membership_revision'=c.completed_revision::text
           AND s.metadata->'inventory'->>'membership_digest'=e.metadata->>'membership_digest')
       ORDER BY e.created_at DESC LIMIT 1) l ON true
     JOIN next_collections n ON n.owner_user_id=u.id AND n.collection_id=$2
     WHERE u.id=$1 AND u.account_backend='next' AND u.suspended_at IS NULL
       AND m.started_at IS NOT NULL AND m.terminal_excluded_at IS NULL
       AND c.released_at IS NOT NULL AND c.completed_at IS NOT NULL AND c.completed_revision=c.membership_revision
       AND n.runtime='next' AND n.sync='cloud_copy' AND n.left_sync_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM next_migration_cohort_members remaining JOIN users ru ON ru.id=remaining.account_id
         LEFT JOIN next_migration_account_flips rf ON rf.account_id=ru.id
         WHERE remaining.cohort=c.name AND remaining.terminal_excluded_at IS NULL
           AND (remaining.started_at IS NULL OR ru.account_backend<>'next' OR rf.account_id IS NULL))
     FOR SHARE OF u,m,c,f,n`,[owner,collection]
  )).rows[0];
  // Never infer completion from an audited free-text unfreeze or terminal
  // status bits: a completed cohort needs an accepted archive or LAB completion.
  if(!terminal||!HEX64.test(terminal.evidence_digest)||!Array.isArray(terminal.collections)
    ||terminal.collections.length===0||terminal.collections.length>MAX_COLLECTIONS
    ||terminal.collections.some(v=>typeof v!=="string"||!UUID.test(v)))throw new InvitationMigrationPending();
  const named=[...terminal.collections as string[]].sort();
  if(new Set(named).size!==named.length||!named.includes(collection.toLowerCase())
    ||!Number.isFinite(time(terminal.started_at))||!Number.isFinite(time(terminal.flipped_at))||!Number.isFinite(time(terminal.completed_at))
    ||time(terminal.flipped_at)<time(terminal.started_at)||time(terminal.completed_at)<time(terminal.flipped_at))throw new InvitationMigrationPending();
  // Recompute the ORIGINAL entire cohort/account inventory formula. Completion
  // revision/event existence alone cannot authorize changed or omitted topology.
  const {cohortRows,inventory,hosted}=await cohortInventory(client,terminal.cohort);
  const cohortDigest=membershipDigest(inventory);
  if(cohortRows.length>2000||inventory.size===0||inventory.size>1000||hosted>1000||cohortDigest===null
    ||!HEX64.test(terminal.archive_digest)||cohortDigest!==terminal.archive_digest)throw new InvitationMigrationPending();
  const rows=(await client.query<Cutover>(
    `SELECT h.id::text AS collection_id,h.authority_state,h.quarantined_at,n.runtime,n.sync,n.left_sync_at,
       r.s_final::text,r.cutover_seq::text,r.barrier_f::text,r.final_digest
     FROM hosted_collections h
     LEFT JOIN next_migration_collections r ON r.collection_id=h.id AND r.account_id=h.user_id
     LEFT JOIN next_collections n ON n.collection_id=h.id AND n.owner_user_id=h.user_id
     WHERE h.user_id=$1 AND h.authority_state<>'transferred' ORDER BY h.id LIMIT $2 FOR SHARE OF h`,[owner,MAX_COLLECTIONS+1]
  )).rows;
  if(rows.length!==named.length||rows.some((r,i)=>r.collection_id!==named[i]
    ||r.authority_state!=="active"||r.quarantined_at!==null||r.runtime!=="next"||r.sync!=="cloud_copy"||r.left_sync_at!==null
    ||!sequence(r.s_final)||!sequence(r.cutover_seq,true)||!sequence(r.barrier_f,true)
    ||BigInt(r.barrier_f!)<BigInt(r.cutover_seq!)||typeof r.final_digest!=="string"||!HEX64.test(r.final_digest)))throw new InvitationMigrationPending();
  const digest=createHash("sha256").update(rows.map(r=>`${r.collection_id}:${r.barrier_f}:${r.final_digest}\n`).join("")).digest("hex");
  if(digest!==terminal.evidence_digest)throw new InvitationMigrationPending();
  const audit=(await client.query(
    `SELECT 1 FROM audit_events WHERE user_id=$1 AND event_type='next_migration.flip' AND subject_id=$1::text
       AND metadata->>'evidence_digest'=$2 AND metadata->'collections'=$3::jsonb LIMIT 1`,[owner,digest,JSON.stringify(named)]
  )).rows;
  if(!audit.length)throw new InvitationMigrationPending();
}

async function cohortInventory(client:DatabaseQueryable,cohort:string){
  const cohortRows=(await client.query<{account:string;collection:string|null}>(
    `SELECT m.account_id::text AS account,h.id::text AS collection
     FROM next_migration_cohort_members m LEFT JOIN hosted_collections h
       ON h.user_id=m.account_id AND h.authority_state<>'transferred'
     WHERE m.cohort=$1 ORDER BY m.account_id,h.id LIMIT 2001`,[cohort]
  )).rows;
  const inventory=new Map<string,string[]>();let hosted=0;
  for(const row of cohortRows){
    const ids=inventory.get(row.account)??[];
    if(row.collection!==null){ids.push(row.collection);hosted++;}
    inventory.set(row.account,ids);
  }
  return {cohortRows,inventory,hosted};
}

/** Same frozen migrationMembershipDigest formula, or null for a non-canonical
 * inventory; importing rollout orchestration here would create an
 * account-management/sharing dependency cycle. */
function membershipDigest(inventory:ReadonlyMap<string,readonly string[]>):string|null {
  const allCollections=new Set<string>();
  const canonical=[...inventory].every(([account,ids])=>UUID.test(account)&&account!=="00000000-0000-0000-0000-000000000000"
    &&ids.every(id=>{if(!UUID.test(id)||id==="00000000-0000-0000-0000-000000000000"||allCollections.has(id))return false;allCollections.add(id);return true;}));
  if(!canonical)return null;
  return createHash("sha256").update("mdbase-legacy-batch-membership/v1\n","ascii")
    .update(JSON.stringify([...inventory].map(([account,ids])=>[account,[...ids].sort()]).sort((a,b)=>String(a[0])<String(b[0])?-1:String(a[0])>String(b[0])?1:0)),"utf8").digest("hex");
}

/** Evidence for completing a LAB-profile cohort without an archive acceptance,
 * or null. Every member started with the LAB profile bound to the cohort's
 * CURRENT inventory (name, revision, digest, change time), none is excluded,
 * and every member flipped on exactly its current, routed cutovers. Caller holds
 * the cohort FOR UPDATE; this grants nothing by itself: only
 * `completeMigrationBatch` in environment lab acts on it. */
export async function labCohortCompletionEvidence(client:DatabaseQueryable,cohort:string,revision:string)
  :Promise<{membership_digest:string;evidence_digest:string}|null> {
  const batch=(await client.query<{revision:string;changed:Date}>(
    "SELECT membership_revision::text AS revision,membership_changed_at AS changed FROM next_migration_cohorts WHERE name=$1",[cohort]
  )).rows[0];
  if(!batch||batch.revision!==revision)return null;
  const {cohortRows,inventory,hosted}=await cohortInventory(client,cohort);
  const digest=membershipDigest(inventory);
  if(digest===null||cohortRows.length>2000||inventory.size===0||inventory.size>1000||hosted>1000)return null;
  const binding={batch_id:cohort,membership_revision:revision,membership_digest:digest,membership_changed_at:new Date(batch.changed).toISOString()};
  const members=(await client.query<{account:string;started:boolean;excluded:boolean;backend:string;collections:string[]|null;evidence_digest:string|null;bound:boolean}>(
    `SELECT m.account_id::text AS account,m.started_at IS NOT NULL AS started,m.terminal_excluded_at IS NOT NULL AS excluded,
       u.account_backend AS backend,f.collections::text[] AS collections,f.evidence_digest,
       EXISTS (SELECT 1 FROM audit_events s WHERE s.user_id=m.account_id AND s.event_type='next_migration.start'
         AND s.subject_id=m.account_id::text AND s.metadata->>'profile'='${LAB_START_PROFILE}' AND s.metadata->'inventory'=$2::jsonb) AS bound
     FROM next_migration_cohort_members m JOIN users u ON u.id=m.account_id
     LEFT JOIN next_migration_account_flips f ON f.account_id=m.account_id
     WHERE m.cohort=$1 ORDER BY m.account_id`,[cohort,JSON.stringify(binding)]
  )).rows;
  if(members.length!==inventory.size)return null;
  const cutovers:{collection_id:string;barrier_f:string;final_digest:string}[]=[];
  for(const member of members){
    if(!member.started||member.excluded||member.backend!=="next"||!member.bound||!Array.isArray(member.collections)||member.evidence_digest===null)return null;
    const rows=(await client.query<{collection_id:string;barrier_f:string|null;final_digest:string|null;routed:boolean}>(
      `SELECT h.id::text AS collection_id,r.barrier_f::text,r.final_digest,
         h.authority_state='active' AND h.quarantined_at IS NULL AND n.runtime='next' AND n.sync='cloud_copy' AND n.left_sync_at IS NULL AS routed
       FROM hosted_collections h
       LEFT JOIN next_migration_collections r ON r.collection_id=h.id AND r.account_id=h.user_id
       LEFT JOIN next_collections n ON n.collection_id=h.id AND n.owner_user_id=h.user_id
       WHERE h.user_id=$1 AND h.authority_state<>'transferred' ORDER BY h.id`,[member.account]
    )).rows;
    if(rows.some(r=>!r.routed||r.barrier_f===null||r.final_digest===null)
      ||[...member.collections].sort().join()!==rows.map(r=>r.collection_id).join()
      ||rows.map(r=>r.collection_id).join()!==(inventory.get(member.account)??[]).join())return null;
    const owned=rows.map(r=>({collection_id:r.collection_id,barrier_f:r.barrier_f!,final_digest:r.final_digest!}));
    if(flipEvidenceDigest(owned)!==member.evidence_digest)return null;
    cutovers.push(...owned);
  }
  return {membership_digest:digest,evidence_digest:flipEvidenceDigest(cutovers)};
}
