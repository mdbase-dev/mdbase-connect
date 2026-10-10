// Migration-token-only issuance. SQL identifies the account/start/service device;
// epoch/wake come exclusively from a fresh authenticated native-owner observation.
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabasePool, DatabaseQueryable } from "../../database-types.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import { legacyMigrationDrainSchema as legacyDrain, type LegacyMigrationDrain } from "../../hosted-provider-replies.js";
import { audit } from "../../platform/audit-events.js";
import { readBoundedJson } from "../../platform/bounded-json.js";
import { apiError } from "../../platform/http-errors.js";
import { bearerToken } from "../../platform/request-authentication.js";
import { safeEqual } from "../../security.js";
import type { NextControlPlaneConfig } from "./policy-keys.js";
import { keyId, type PolicySigner } from "./policy-wire.js";
import { signMigrationSourceWitness } from "./migration-source-witness.js";

const NIL = "00000000-0000-0000-0000-000000000000";
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u).refine(value => value !== NIL);
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,19})$/u).refine(value => BigInt(value) <= (1n << 64n) - 1n);
const chain = z.string().regex(/^[0-9a-f]{64}$/u);
const head = z.object({ seq: decimal, chain }).strict();
const admission = z.object({ schema: z.literal("mdbn-migration-admission/1"), collection: uuid, device_id: uuid,
  epoch: decimal, wake: decimal, fault_generation: decimal, applied_head: head, authenticated_head: head,
  control_chain: chain, challenge: z.string(),
}).strict();

class Refused extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
interface SourceRow {
  account: string; started_at: Date; device_id: string; root_key_id: Buffer;
  sign_pk: Buffer; kem_pk: Buffer; noise_pk: Buffer;
}
interface Options {
  db: DatabasePool; next: NextControlPlaneConfig; signer: PolicySigner;
  provider?: Pick<HostedProviderClient, "legacyMigrationDrain">; fetchImpl?: typeof fetch; now?: () => number;
}

async function sourceRow(db: DatabaseQueryable, collection: string, signer: PolicySigner, locked = false): Promise<SourceRow> {
  const row = (await db.query<SourceRow>(
    `SELECT h.user_id::text AS account,m.started_at,s.device_id::text,s.sign_pk,s.kem_pk,s.noise_pk,n.root_key_id
     FROM hosted_collections h JOIN users u ON u.id=h.user_id
     JOIN next_migration_cohort_members m ON m.account_id=u.id
     JOIN next_collections n ON n.collection_id=h.id AND n.owner_user_id=u.id
     JOIN next_service_devices s ON s.collection_id=n.collection_id AND s.kind='hosted'
     WHERE h.id=$1 AND h.authority_state='active' AND h.quarantined_at IS NULL
       AND u.account_backend='legacy' AND m.terminal_excluded_at IS NULL AND m.started_at IS NOT NULL
       AND n.runtime IN ('shadow','next') AND n.sync='cloud_copy' AND n.left_sync_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM next_migration_account_flips f WHERE f.account_id=u.id)
     ${locked ? "FOR SHARE OF h,u,m,s FOR UPDATE OF n" : ""}`, [collection]
  )).rows[0];
  if (!row) throw new Refused("migration_source_not_current");
  if (row.device_id === NIL || !row.root_key_id.equals(Buffer.from(signer.cert.root))
      || [row.sign_pk,row.kem_pk,row.noise_pk].some(key => key.length !== 32 || key.every(byte => byte === 0))) throw new Refused("migration_source_not_current");
  const tuple = JSON.stringify([{op:"device-enrol",device:row.device_id,account:NIL,kind:"hosted",
    signPublicKey:{$hex:row.sign_pk.toString("hex")},kemPublicKey:{$hex:row.kem_pk.toString("hex")},noisePublicKey:{$hex:row.noise_pk.toString("hex")}}]);
  const policy = await db.query(
    `SELECT 1 FROM next_policy_outbox o JOIN next_policy_batches b ON b.id=o.batch_id
     WHERE o.collection_id=$1 AND b.state='appended' AND b.lost_at IS NULL AND o.ops->'ops' @> $2::jsonb
       AND NOT EXISTS (SELECT 1 FROM next_policy_outbox revoke WHERE revoke.collection_id=$1
         AND (revoke.ops->'ops' @> $3::jsonb OR revoke.ops->'ops' @> $4::jsonb)) LIMIT 1`,
    [collection,tuple,JSON.stringify([{op:"device-revoke",device:row.device_id}]),JSON.stringify([{op:"cp-key-revoke",keyId:{$hex:Buffer.from(keyId(signer.cert.policyPublicKey)).toString("hex")}}])]
  );
  if (!policy.rows.length) throw new Refused("migration_source_not_current");
  return row;
}

function drained(source: LegacyMigrationDrain): void {
  // Expired unresolved journal rows cannot apply; applied receipts are already in
  // head. Requiring either count to be zero would discard retained evidence.
  if (source.state !== "migrating" || source.in_flight !== 0 || !source.started_at) throw new Refused("migration_source_not_drained");
}

async function observe(collection: string, device: string, options: Options) {
  const deployment = options.next.cloudCopyBootstrap?.hosted;
  if (!deployment) throw new Refused("migration_source_unavailable",503);
  const url = new URL("internal/v1/migration-admission", `${deployment.url.replace(/\/+$/u, "")}/`);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || deployment.token.length < 32) throw new Refused("migration_source_unavailable",503);
  const challenge = randomBytes(32).toString("base64");
  const response = await (options.fetchImpl ?? fetch)(url, { method:"POST",redirect:"manual",signal:AbortSignal.timeout(10_000),
    headers:{authorization:`Bearer ${deployment.token}`,"content-type":"application/json","cache-control":"no-store"},
    body:JSON.stringify({collection,challenge}),
  });
  if (!response.ok || !response.body) { void response.body?.cancel().catch(()=>undefined); throw new Refused("migration_source_unavailable",503); }
  const parsed = admission.parse(await readBoundedJson(response,4096));
  if (parsed.collection!==collection || parsed.device_id!==device || parsed.challenge!==challenge
      || parsed.applied_head.seq!==parsed.authenticated_head.seq || parsed.applied_head.chain!==parsed.authenticated_head.chain
      || parsed.applied_head.seq==="0") throw new Refused("migration_source_unavailable",503);
  return parsed;
}

async function issue(collection: string, options: Options) {
  if (!options.provider) throw new Refused("migration_source_unavailable",503);
  const before = await sourceRow(options.db,collection,options.signer);
  const deadline=Date.now()+25_000;
  let source:LegacyMigrationDrain;
  let observed:z.infer<typeof admission>;
  try {
    source=legacyDrain.parse(await options.provider.legacyMigrationDrain(collection,{deadline}));
    if(source.collection_id!==collection)throw new Refused("migration_source_unavailable",503); drained(source);
    observed=await observe(collection,before.device_id,options);
    const after=legacyDrain.parse(await options.provider.legacyMigrationDrain(collection,{deadline})); drained(after);
    if(after.collection_id!==source.collection_id || after.head!==source.head || after.started_at!==source.started_at || after.migration_id!==source.migration_id) throw new Refused("migration_source_changed");
  } catch(error) { if(error instanceof Refused) throw error; throw new Refused("migration_source_unavailable",503); }
  const client=await options.db.connect();
  try {
    await client.query("BEGIN"); await client.query("SET LOCAL lock_timeout='5s'"); await client.query("SET LOCAL statement_timeout='5s'");
    const current=await sourceRow(client,collection,options.signer,true);
    if(current.account!==before.account || new Date(current.started_at).getTime()!==new Date(before.started_at).getTime()
      || current.device_id!==before.device_id || !current.sign_pk.equals(before.sign_pk) || !current.kem_pk.equals(before.kem_pk) || !current.noise_pk.equals(before.noise_pk)) throw new Refused("migration_source_changed");
    const issuedAt=(options.now??Date.now)();
    const signed=signMigrationSourceWitness(options.signer,{target:collection,legacy:source.collection_id,device:current.device_id,
      frozenHead:BigInt(source.head),startedAt:new Date(current.started_at).getTime(),epoch:BigInt(observed.epoch),wake:BigInt(observed.wake),issuedAt});
    await audit(client,current.account,"next_migration.source_witness",collection,{source_head:String(source.head),epoch:observed.epoch,wake:observed.wake,expires_at:signed.expiresAt});
    await client.query("COMMIT");
    return {witness:Buffer.from(signed.witness).toString("base64"),expires_at:signed.expiresAt};
  } catch(error) { await client.query("ROLLBACK").catch(()=>undefined); throw error; } finally {client.release();}
}

export function registerMigrationSourceWitnessRoutes(app:FastifyInstance,options:Options):void {
  const token=options.next.migrationToken;
  if(!token) throw new Error("Migration witness registration needs the dedicated migration token.");
  app.post<{Params:{id:string}}>("/internal/v1/next/migration/collections/:id/source-witness",{bodyLimit:4096,config:{rateLimit:{max:20,timeWindow:"1 minute"}}},async(request,reply)=>{
    reply.header("cache-control","no-store");
    const presented=bearerToken(request);
    if(!presented||!safeEqual(presented,token))return reply.code(401).send(apiError("invalid_internal_token","The migration token is required."));
    const params=z.object({id:uuid}).strict().safeParse(request.params);
    const body=z.object({}).strict().safeParse(request.body??{});
    if(!params.success||!body.success)return reply.code(400).send(apiError("invalid_request","A canonical collection UUID and no caller-selected source facts are required."));
    try{return await issue(params.data.id,options);}catch(error){
      if(error instanceof Refused)return reply.code(error.status).send(apiError(error.code,"No current migration source witness."));
      if(["55P03","57014"].includes(String((error as {code?:unknown})?.code)))return reply.code(503).send(apiError("busy","Retry with a fresh source observation."));
      throw error;
    }
  });
}
