// Original completion readback for invitation continuity and imported timers.
// Global topology/archive freeze stays unchanged. Terminal SQL labels alone
// are not a validated account flip; callers retain their original transaction.
import { createHash } from "node:crypto";
import type { DatabaseConnection, DatabaseQueryable } from "../../database-types.js";
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
       c.name AS cohort,a.verified_result->'migration_batch'->>'membership_digest' AS archive_digest
     FROM users u JOIN next_migration_cohort_members m ON m.account_id=u.id
     JOIN next_migration_cohorts c ON c.name=m.cohort
     JOIN next_migration_account_flips f ON f.account_id=u.id
     JOIN next_migration_archive_acceptances a ON a.cohort=c.name AND a.membership_revision=c.completed_revision
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
  // No accepted archive/completed cohort exists for the tiny profile today.
  // Its genuine verification/recovery completion producer is a separate gate;
  // never infer it from an audited free-text unfreeze or terminal status bits.
  if(!terminal||!HEX64.test(terminal.evidence_digest)||!Array.isArray(terminal.collections)
    ||terminal.collections.length===0||terminal.collections.length>MAX_COLLECTIONS
    ||terminal.collections.some(v=>typeof v!=="string"||!UUID.test(v)))throw new InvitationMigrationPending();
  const named=[...terminal.collections as string[]].sort();
  if(new Set(named).size!==named.length||!named.includes(collection.toLowerCase())
    ||!Number.isFinite(time(terminal.started_at))||!Number.isFinite(time(terminal.flipped_at))||!Number.isFinite(time(terminal.completed_at))
    ||time(terminal.flipped_at)<time(terminal.started_at)||time(terminal.completed_at)<time(terminal.flipped_at))throw new InvitationMigrationPending();
  // Recompute the ORIGINAL entire cohort/account inventory formula. Completion
  // revision/event existence alone cannot authorize changed or omitted topology.
  const cohortRows=(await client.query<{account:string;collection:string|null}>(
    `SELECT m.account_id::text AS account,h.id::text AS collection
     FROM next_migration_cohort_members m LEFT JOIN hosted_collections h
       ON h.user_id=m.account_id AND h.authority_state<>'transferred'
     WHERE m.cohort=$1 ORDER BY m.account_id,h.id LIMIT 2001`,[terminal.cohort]
  )).rows;
  const inventory=new Map<string,string[]>();let hosted=0;
  for(const row of cohortRows){
    const ids=inventory.get(row.account)??[];
    if(row.collection!==null){ids.push(row.collection);hosted++;}
    inventory.set(row.account,ids);
  }
  const allCollections=new Set<string>();
  const canonical= [...inventory].every(([account,ids])=>UUID.test(account)&&account!=="00000000-0000-0000-0000-000000000000"
    &&ids.every(id=>{if(!UUID.test(id)||id==="00000000-0000-0000-0000-000000000000"||allCollections.has(id))return false;allCollections.add(id);return true;}));
  // Same frozen migrationMembershipDigest formula; importing rollout orchestration
  // here would create an account-management/sharing dependency cycle.
  const cohortDigest=createHash("sha256").update("mdbase-legacy-batch-membership/v1\n","ascii")
    .update(JSON.stringify([...inventory].map(([account,ids])=>[account,[...ids].sort()]).sort((a,b)=>String(a[0])<String(b[0])?-1:String(a[0])>String(b[0])?1:0)),"utf8").digest("hex");
  if(cohortRows.length>2000||inventory.size===0||inventory.size>1000||hosted>1000||!canonical
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
