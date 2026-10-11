/** Fixed-run LAB CP checks/mutations. No restored state or caller permission flag
 * can authorize. Current responses are point observations, never reusable leases.
 */
import { sign, verify } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabaseConnection, DatabasePool } from "../../database-types.js";
import { bearerToken, requireSessionContext } from "../../platform/request-authentication.js";
import { apiError } from "../../platform/http-errors.js";
import { safeEqual } from "../../security.js";
import { CreateError, currentMember, currentSession, inTransaction, lock, NIL, refuseRevoked } from "./bootstrap-common.js";
import { recordCollectionDeletionIntent, requireCollectionNotDeleted } from "./collection-deletion.js";
import { originalGenesis } from "./hosted-routes.js";
import { pitrLabel, type LabPitrConfig } from "./lab-pitr-config.js";
import { ed25519PublicKeyObject, verifyCert, type NextControlPlaneConfig } from "./policy-keys.js";
import type { LogServiceClient } from "./log-service-client.js";
import { decodeCbor, domainHash, encodeCbor, encodeCert, keyId, policyItemSignedDigest, uuidBytes, type CpCert, type Decoded, type DeviceKind, type PolicySigner } from "./policy-wire.js";
import { queueNextPolicy } from "./policy-outbox.js";
import { projectNextGrant, type NextGrantSource } from "./grant-policy.js";

// The CP-only transcript is private to this fixed-purpose source route. Signed
// data never substitutes for native caller authentication or a one-shot witness.
interface CpOriginalFacts {
  audience: string; run: "gate4-pitr-lab-20261009-01"; collection: string; owner: string;
  rootPublicKey: Uint8Array; issuerPublicKey: Uint8Array; transportPublicKey: Uint8Array;
  genesisSha256: Uint8Array; challenge: Uint8Array; issuedAt: number;
}
const PREKEY_DOMAIN = "mdbase/v1/prekey-original-admission";
function admissionUuid(value: string): Uint8Array {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?![\s\S])/u.test(value) || value===NIL) throw new Error("invalid_prekey_subject");
  return uuidBytes(value);
}
function admissionAudience(value: string): string {
  const url = new URL(value);
  if (value.length>255 || !/^[\x21-\x7e]+$/u.test(value) || url.protocol!=="https:" || url.origin!==value
      || !/^[a-z0-9.-]+$/u.test(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error("invalid_prekey_audience");
  return value;
}
function nonzero32(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length!==32 || value.every(v=>v===0)) throw new Error("invalid_prekey_bytes");
  return value;
}
function originalFields(value: Decoded | undefined, keys: number[]): Map<number | string, Decoded> {
  if (!(value instanceof Map) || value.size!==keys.length || !keys.every(k=>value.has(k))) throw new Error("invalid_prekey_original");
  return value;
}
function originalBytes(value: Decoded | undefined, size: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length!==size) throw new Error("invalid_prekey_original");
  return value;
}
/** Crypto/shape checks only, not a reducer or whole-history acceptance. Native
 * independently verifies actual caller possession and exact bounded originals. */
function assertCpOriginalGenesis(raw: Uint8Array, collection: string, owner: string, root: Uint8Array, transport: Uint8Array): void {
  if (raw.length===0 || raw.length>64*1024) throw new Error("invalid_prekey_original");
  const item=originalFields(decodeCbor(raw,{maxDepth:32,canonicalStructs:true}),[0,1,2,3,4,6,11,12]),body=item.get(11);
  if (!(body instanceof Uint8Array)) throw new Error("invalid_prekey_original");
  const payload=originalFields(decodeCbor(body,{maxDepth:32,canonicalStructs:true}),[0,1,2,3]);
  const c=originalFields(payload.get(1),[0,1,2,3,4]),ops=payload.get(3),issued=payload.get(2);
  const cert:CpCert={policyPublicKey:originalBytes(c.get(0),32),notBefore:c.get(1) as number,notAfter:c.get(2) as number,
    root:originalBytes(c.get(3),16),signature:originalBytes(c.get(4),64)};
  if (!Array.isArray(ops) || ops.length===0) throw new Error("invalid_prekey_original");
  const genesis=originalFields(ops[0],[0,1,2,3]);
  if (item.get(0)!==1 || item.get(1)!==2 || item.get(3)!==1 || payload.get(0)!==1
      || !Buffer.from(originalBytes(item.get(2),16)).equals(Buffer.from(admissionUuid(collection)))
      || originalBytes(item.get(4),32).some(v=>v!==0) || genesis.get(0)!==1 || genesis.get(3)!==1
      || !Buffer.from(originalBytes(genesis.get(1),16)).equals(Buffer.from(admissionUuid(owner)))
      || !Buffer.from(originalBytes(genesis.get(2),16)).equals(Buffer.from(keyId(nonzero32(root))))
      || ops.filter(op=>op instanceof Map && op.get(0)===1).length!==1
      || !Number.isSafeInteger(issued) || (issued as number)<0
      || !Number.isSafeInteger(cert.notBefore) || !Number.isSafeInteger(cert.notAfter) || cert.notBefore>=cert.notAfter
      || (issued as number)<cert.notBefore || (issued as number)>cert.notAfter
      || !Buffer.from(cert.policyPublicKey).equals(Buffer.from(nonzero32(transport)))
      || !Buffer.from(originalBytes(item.get(6),16)).equals(Buffer.from(keyId(cert.policyPublicKey)))
      || !verifyCert(cert,root)
      || !verify(null,policyItemSignedDigest(collection,1,originalBytes(item.get(4),32),originalBytes(item.get(6),16),body),
        ed25519PublicKeyObject(cert.policyPublicKey),originalBytes(item.get(12),64))) throw new Error("invalid_prekey_original");
}
/** Only trusted configuration and locked source facts enter this closed template;
 * no device branch, arbitrary purpose/message/digest or generic signing API. */
function signCpOriginalAdmission(signer: PolicySigner, facts: CpOriginalFacts): {admission:Uint8Array;expiresAt:number} {
  const root=nonzero32(facts.rootPublicKey);
  if (!Buffer.from(keyId(root)).equals(Buffer.from(signer.cert.root)) || facts.run!=="gate4-pitr-lab-20261009-01") throw new Error("invalid_prekey_root_or_run");
  const issuedAt=facts.issuedAt,expiresAt=Math.min(issuedAt+10000,signer.cert.notAfter);
  if (!Number.isSafeInteger(issuedAt) || issuedAt<0 || !Number.isSafeInteger(expiresAt)
      || issuedAt<signer.cert.notBefore || expiresAt<=issuedAt || expiresAt-issuedAt>10000) throw new Error("invalid_prekey_freshness");
  const claims=encodeCbor([1,admissionAudience(facts.audience),facts.run,"original-caller-prekey",admissionUuid(facts.collection),admissionUuid(facts.owner),
    root,nonzero32(facts.issuerPublicKey),nonzero32(facts.transportPublicKey),nonzero32(facts.genesisSha256),1,null,null,null,
    nonzero32(facts.challenge),issuedAt,expiresAt]);
  if (claims.length>2048) throw new Error("prekey_claims_too_large");
  const signature=sign(null,domainHash(PREKEY_DOMAIN,claims),signer.privateKey);
  const admission=Buffer.concat([Buffer.of(0x84,1),encodeCbor(claims),encodeCert(signer.cert),encodeCbor(signature)]);
  if (admission.length>4096) throw new Error("prekey_admission_too_large");
  return {admission,expiresAt};
}

const uuid = z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/).refine(v => v !== NIL);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const kinds = z.enum(["desktop", "mobile", "app-runtime", "cli", "hosted", "escrow"]);
const probe = z.object({ run: z.literal("gate4-pitr-lab-20261009-01"), collection: uuid, genesisSha256: hash,
  device: uuid, kind: kinds, signPublicKey: hash, policyKeyId: z.string().regex(/^[0-9a-f]{32}$/) }).strict();
const appGrantProbe = z.object({ run: z.literal("gate4-pitr-lab-20261009-01"), principal: z.literal("app-grant"),
  collection: uuid, grant: uuid, clientPublicKey: hash, genesisSha256: hash,
  policyKeyId: z.string().regex(/^[0-9a-f]{32}$/) }).strict();
const cpGenesisProbe = z.object({ run: z.literal("gate4-pitr-lab-20261009-01"), principal: z.literal("control-plane"),
  purpose: z.literal("pending-original-genesis"), collection: uuid, genesisSha256: hash,
  transportPublicKey: hash.refine(v => v !== "00".repeat(32)), issuerKeyId: z.string().regex(/^[0-9a-f]{32}$/),
  policyKeyId: z.string().regex(/^[0-9a-f]{32}$/) }).strict();
const cpCollectionProbe = cpGenesisProbe.extend({purpose:z.literal("collection")});
const cpNilReadProbe = cpGenesisProbe.omit({genesisSha256:true}).extend({collection:z.literal(NIL),
  purpose:z.literal("registry-read"),activeGenesisSha256:hash,deletedGenesisSha256:hash});
const cpNilPeekProbe = cpGenesisProbe.extend({collection:z.literal(NIL),purpose:z.literal("deletion-peek"),subject:uuid});
const cpNilRecordProbe = cpNilReadProbe.extend({purpose:z.literal("deletion-record"),subject:uuid,deletionId:uuid,
  lifecycleEpoch:z.string().regex(/^[1-9][0-9]{0,19}$/).refine(v=>BigInt(v)<=(1n<<64n)-1n)});
const registry = z.object({ run: z.literal("gate4-pitr-lab-20261009-01"), after: uuid.nullable(),
  expected: z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/).refine(v => /^(?:0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= (1n << 64n) - 1n).nullable() }).strict();
const mutation = z.object({ run: z.literal("gate4-pitr-lab-20261009-01"), activeGenesisSha256: hash,
  deletedGenesisSha256: hash, device: uuid }).strict();
interface Peer { id: string; account: string; kind: DeviceKind; sign_pk: Buffer; kem_pk: Buffer; noise_pk: Buffer }
const denied = (): never => { throw new CreateError(409, "lab_pitr_authority_denied"); };

async function currentCollection(client: DatabaseConnection, pitr: LabPitrConfig, next: NextControlPlaneConfig,
  collection: string, expectedGenesis: string, now: number,
  mode: "ordinary" | "cp-genesis" | "cp-collection" = "ordinary"): Promise<void> {
  const pendingGenesis=mode==="cp-genesis";
  if ((collection !== pitr.active && collection !== pitr.deleted) || now < next.policyCert.not_before || now >= next.policyCert.not_after) denied();
  await requireCollectionNotDeleted(client, collection);
  const row = (await client.query<{ root_key_id: Buffer }>(
    `SELECT n.root_key_id FROM next_collections n JOIN users u ON u.id=n.owner_user_id
     WHERE n.collection_id=$1 AND n.owner_user_id=$2 AND n.runtime='next' AND n.sync='cloud_copy'
       AND n.left_sync_at IS NULL AND u.suspended_at IS NULL
       AND n.created_at>=to_timestamp($3::double precision/1000) AND n.display_name=$4
     FOR SHARE OF n,u`, [collection, pitr.owner, pitr.createdAfter, pitrLabel(pitr,collection)]
  )).rows[0];
  if (!row || !row.root_key_id.equals(Buffer.from(next.policyCert.root_key_id, "hex"))) denied();
  if (pendingGenesis) {
    // Initial owner membership may still be in the same sending genesis batch;
    // never fabricate an appended membership ACK. Any queued/lost removal denies.
    const removal = await client.query(`SELECT 1 FROM next_policy_outbox o
      CROSS JOIN LATERAL jsonb_array_elements(o.ops->'ops') AS e(value)
      WHERE o.collection_id=$1 AND e.value->>'account'=$2
        AND (e.value->>'op'='member-remove' OR (e.value->>'op'='member-set' AND e.value->>'role' IS DISTINCT FROM 'owner')) LIMIT 1`,
      [collection, pitr.owner]);
    if (removal.rows.length) denied();
  } else await currentMember(client, collection, pitr.owner, "owner");
  const genesis = await originalGenesis(client, collection, mode!=="ordinary"
    ? {owner:pitr.owner,root:next.policyCert.root_key_id,state:pendingGenesis?"sending-or-appended":"appended"} : undefined);
  if (genesis.hash !== expectedGenesis) denied(); // structural CP metadata; runtime still verifies the signed original.
  const policyKeyId = Buffer.from(keyId(Buffer.from(next.policyCert.policy_public_key, "hex"))).toString("hex");
  const revoked = await client.query(`SELECT 1 FROM next_policy_outbox
    WHERE collection_id=$1 AND ops->'ops' @> $2::jsonb LIMIT 1`,
    [collection, JSON.stringify([{ op: "cp-key-revoke", keyId: { $hex: policyKeyId } }])]);
  if (revoked.rows.length) denied(); // pending and delivered security-key denials both close.
}
async function currentPeer(client: DatabaseConnection, pitr: LabPitrConfig, collection: string, device: string): Promise<Peer> {
  const service = (await client.query<Peer>(`SELECT device_id::text AS id,$3::uuid::text AS account,kind,sign_pk,kem_pk,noise_pk
    FROM next_service_devices WHERE collection_id=$1 AND device_id=$2 AND created_at>=to_timestamp($4::double precision/1000)
    FOR SHARE`, [collection, device, NIL, pitr.createdAfter])).rows[0];
  const peer = service ?? (await client.query<Peer>(`SELECT d.id::text,u.id::text AS account,d.kind,d.sign_pk,d.kem_pk,d.noise_pk
    FROM next_devices d JOIN connectors c ON c.id=d.connector_id JOIN users u ON u.id=d.user_id
    WHERE d.id=$1 AND u.id=$2 AND c.user_id=u.id AND c.revoked_at IS NULL AND u.suspended_at IS NULL
      AND d.created_at>=to_timestamp($3::double precision/1000)
    FOR SHARE OF d,c,u`, [device, pitr.owner, pitr.createdAfter])).rows[0];
  if (!peer || peer.id !== device || [peer.sign_pk,peer.kem_pk,peer.noise_pk].some(k => k.length !== 32 || k.every(b => b === 0))) return denied();
  await refuseRevoked(client, collection, device);
  const tuple = JSON.stringify([{ op: "device-enrol", device, account: peer.account, kind: peer.kind,
    signPublicKey: { $hex: peer.sign_pk.toString("hex") }, kemPublicKey: { $hex: peer.kem_pk.toString("hex") }, noisePublicKey: { $hex: peer.noise_pk.toString("hex") } }]);
  const enrolled = await client.query(`SELECT 1 FROM next_policy_outbox o JOIN next_policy_batches b ON b.id=o.batch_id
    WHERE o.collection_id=$1 AND o.ops->>'version'='1' AND b.state='appended' AND b.lost_at IS NULL AND o.ops->'ops' @> $2::jsonb LIMIT 1`, [collection, tuple]);
  if (!enrolled.rows.length) return denied();
  return peer;
}
/** Stable grant lock first, matching publication order. This lookup is only a
 * lock target; exact original binding is reread after grant + collection locks. */
async function lockPitrAppGrant(db: DatabaseConnection, collection: string, logGrant: string): Promise<string> {
  const refs = await db.query<{ grant_id: string }>(
    "SELECT grant_id::text FROM next_grant_bindings WHERE collection_id=$1 AND log_grant_id=$2", [collection, logGrant]);
  if (refs.rows.length !== 1) return denied();
  const locked = await db.query("SELECT id FROM grants WHERE id=$1 FOR SHARE", [refs.rows[0]!.grant_id]);
  if (locked.rows.length !== 1) return denied();
  return refs.rows[0]!.grant_id;
}
async function assertPitrAppGrant(db: DatabaseConnection, pitr: LabPitrConfig,
  collection: string, logGrant: string, clientPublicKey: string, lockedGrant: string): Promise<void> {
  const result = await db.query<NextGrantSource & { terms_digest: Buffer }>(
    `SELECT n.collection_id::text AS collection,n.sync,g.user_id,g.application_id,g.application_installation_id,
      g.operations,g.file_capability,g.scope,
      (g.application_authorization->'binding'->'contracts'->>'semantic_capabilities')::int AS semantic,
      g.application_authorization->'binding'->>'application_declaration_id' AS declaration,
      k.client_pk,b.terms_digest
    FROM next_grant_bindings b JOIN grants g ON g.id=b.grant_id
    JOIN next_grant_client_keys k ON k.grant_id=g.id
    LEFT JOIN collections col ON col.id=g.collection_id
    LEFT JOIN connectors connector ON connector.id=col.connector_id
    LEFT JOIN hosted_collections hc ON hc.id=g.hosted_collection_id
    JOIN next_collections n ON n.collection_id::text=COALESCE(col.local_id::text,hc.id::text)
    WHERE b.collection_id=$1 AND b.log_grant_id=$2 AND b.active=true AND n.collection_id=b.collection_id AND g.id=$5
      AND g.user_id=$3 AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
      AND g.created_at>=to_timestamp($4::double precision/1000)
      AND g.membership_id IS NULL AND g.membership_policy_id IS NULL AND g.membership_policy_revision IS NULL
      AND (g.collection_id IS NULL OR (col.enabled=true AND col.present=true AND col.authority_state='active' AND connector.revoked_at IS NULL))
      AND (g.hosted_collection_id IS NULL OR (hc.authority_state='active' AND hc.quarantined_at IS NULL))
    FOR SHARE OF b,g,k`, [collection, logGrant, pitr.owner, pitr.createdAfter, lockedGrant]);
  if (result.rows.length !== 1) return denied();
  const row = result.rows[0]!;
  if (row.collection !== collection || row.sync !== "cloud_copy" || row.user_id !== pitr.owner
      || !row.client_pk || row.client_pk.length !== 32 || row.client_pk.every(b => b === 0)
      || row.client_pk.toString("hex") !== clientPublicKey) return denied();
  let projected: ReturnType<typeof projectNextGrant>;
  try { projected = projectNextGrant(row); } catch { return denied(); }
  if (!row.terms_digest.equals(projected.terms)) return denied();
  // Pending or delivered revoke closes the original immutable log identity.
  const revoked = await db.query(`SELECT 1 FROM next_policy_outbox
    WHERE collection_id=$1 AND ops->'ops' @> $2::jsonb LIMIT 1`,
    [collection, JSON.stringify([{ op: "grant-revoke", grant: logGrant }])]);
  if (revoked.rows.length) return denied();
  const tuple = JSON.stringify([{ ...projected.policy, grant: logGrant,
    clientPublicKey: { $hex: clientPublicKey } }]);
  const applied = await db.query(`SELECT 1 FROM next_policy_outbox o JOIN next_policy_batches b ON b.id=o.batch_id
    WHERE o.collection_id=$1 AND o.ops->>'version'='1' AND b.state='appended' AND b.lost_at IS NULL
      AND o.ops->'ops' @> $2::jsonb LIMIT 1`, [collection, tuple]);
  if (!applied.rows.length) return denied();
}
/** Nil may propagate denial for D after deletion/leave/member loss, never serve it.
 * Still require live admitted owner/root and appended signed-original metadata for
 * the exact subject set fixed by the nil-purpose route (peek: one; page/record:
 * both). No request-controlled bypass in ordinary collection checks. */
async function currentNilSubjects(client: DatabaseConnection,pitr:LabPitrConfig,next:NextControlPlaneConfig,
  subjects:readonly {collection:string;genesisSha256:string;state:"appended"|"sending-or-appended"}[],now:number):Promise<void>{
  if(!Number.isSafeInteger(now)||now<next.policyCert.not_before||now>=next.policyCert.not_after)denied();
  for(const subject of [...subjects].sort((a,b)=>a.collection.localeCompare(b.collection))){
    const collection=subject.collection;
    if(collection!==pitr.active&&collection!==pitr.deleted)denied();
    await lock(client,collection);
    const rows=await client.query<{root_key_id:Buffer}>(`SELECT n.root_key_id FROM next_collections n JOIN users u ON u.id=n.owner_user_id
      WHERE n.collection_id=$1 AND n.owner_user_id=$2 AND n.runtime='next' AND n.sync='cloud_copy'
        AND u.suspended_at IS NULL AND n.created_at>=to_timestamp($3::double precision/1000) AND n.display_name=$4
      FOR SHARE OF n,u`,[collection,pitr.owner,pitr.createdAfter,pitrLabel(pitr,collection)]);
    if(rows.rows.length!==1||!rows.rows[0]!.root_key_id.equals(Buffer.from(next.policyCert.root_key_id,"hex")))denied();
    const genesis=await originalGenesis(client,collection,{owner:pitr.owner,root:next.policyCert.root_key_id,state:subject.state});
    if(genesis.hash!==subject.genesisSha256)denied();
    const policyKeyId=Buffer.from(keyId(Buffer.from(next.policyCert.policy_public_key,"hex"))).toString("hex");
    const revoked=await client.query(`SELECT 1 FROM next_policy_outbox WHERE collection_id=$1 AND ops->'ops' @> $2::jsonb LIMIT 1`,
      [collection,JSON.stringify([{op:"cp-key-revoke",keyId:{$hex:policyKeyId}}])]);
    if(revoked.rows.length)denied();
  }
}
export function registerLabPitrRoutes(app: FastifyInstance, options: {
  db: DatabasePool; next: NextControlPlaneConfig;
  log: Pick<LogServiceClient, "labPitrCollectionDeletions" | "pitrControlIdentity">; now?: () => number;
  admission?: { signer: PolicySigner; audience: string; identity: Pick<LogServiceClient, "pitrAdmissionIdentity"> };
}): void {
  const pitr = options.next.logService.labPitr;
  const token = options.next.pitrAuthorityToken;
  if (!pitr || !token) return; // Parser requires both together; ordinary deployments expose no routes.
  const policyKeyId = Buffer.from(keyId(Buffer.from(options.next.policyCert.policy_public_key, "hex"))).toString("hex");
  const limit = { bodyLimit: 4096, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } };
  app.post("/internal/v1/next/lab-pitr/original-cp-admission", {...limit,bodyLimit:1024}, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const presented = bearerToken(request);
    if (!presented || !safeEqual(presented, token)) return reply.code(401).send(apiError("invalid_internal_token", "Internal token required."));
    const input = z.object({collection:uuid,challenge:z.string().regex(/^[0-9a-f]{64}(?![\s\S])/u).refine(v=>v!=="00".repeat(32))}).strict().safeParse(request.body);
    if (!input.success || !z.object({}).strict().safeParse(request.query).success) return reply.code(400).send(apiError("invalid_request", "Exact collection and challenge required."));
    const b = input.data;
    try {
      const source = options.admission, identity = source?.identity.pitrAdmissionIdentity();
      if (!source || !identity) throw new Error("prekey_source_unavailable");
      if (b.collection!==pitr.active && b.collection!==pitr.deleted) denied();
      const issuer = Buffer.from(identity.issuerPublicKey,"hex"), transport = Buffer.from(identity.transportPublicKey,"hex");
      const oldIdentity = options.log.pitrControlIdentity();
      if (!hash.safeParse(identity.issuerPublicKey).success || !hash.safeParse(identity.transportPublicKey).success
          || !oldIdentity || oldIdentity.transportPublicKey!==identity.transportPublicKey
          || oldIdentity.issuerKeyId!==Buffer.from(keyId(issuer)).toString("hex")
          || Buffer.from(source.signer.cert.policyPublicKey).toString("hex")!==options.next.policyCert.policy_public_key
          || !Buffer.from(source.signer.cert.root).equals(Buffer.from(keyId(options.next.rootPublicKey)))) denied();
      let issuedAt = -1;
      const signed = await inTransaction(options.db,async client=>{
        await lock(client,b.collection);
        const original = await originalGenesis(client,b.collection,{owner:pitr.owner,root:options.next.policyCert.root_key_id,state:"sending-or-appended"});
        assertCpOriginalGenesis(Buffer.from(original.item,"base64"),b.collection,pitr.owner,options.next.rootPublicKey,transport);
        // The final reread still counts complete original history and pending
        // owner/key denial under the same collection/security locks.
        await currentCollection(client,pitr,options.next,b.collection,original.hash,(options.now??Date.now)(),"cp-genesis");
        const originalKeyRevoked = await client.query(`SELECT 1 FROM next_policy_outbox
          WHERE collection_id=$1 AND ops->'ops' @> $2::jsonb LIMIT 1`,
          [b.collection,JSON.stringify([{op:"cp-key-revoke",keyId:{$hex:Buffer.from(keyId(transport)).toString("hex")}}])]);
        if (originalKeyRevoked.rows.length) denied();
        const currentIdentity = source.identity.pitrAdmissionIdentity();
        if (!currentIdentity || currentIdentity.issuerPublicKey!==identity.issuerPublicKey || currentIdentity.transportPublicKey!==identity.transportPublicKey) denied();
        issuedAt = (options.now??Date.now)();
        return signCpOriginalAdmission(source.signer,{audience:source.audience,run:pitr.run,collection:b.collection,owner:pitr.owner,
          rootPublicKey:options.next.rootPublicKey,issuerPublicKey:issuer,transportPublicKey:transport,
          genesisSha256:Buffer.from(original.hash,"hex"),challenge:Buffer.from(b.challenge,"hex"),issuedAt});
      }); // No signature can escape a failed or unknown COMMIT.
      const now = (options.now??Date.now)();
      if (!Number.isSafeInteger(now) || now<issuedAt || now>=signed.expiresAt) denied();
      return {admission:Buffer.from(signed.admission).toString("base64"),expires_at:signed.expiresAt};
    } catch(error) {
      const status = error instanceof CreateError || (error instanceof Error && error.message==="collection_deleted") ? 409 : 503;
      return reply.code(status).send(apiError(status===409?"lab_pitr_authority_denied":"lab_pitr_authority_unavailable","Original CP admission not established."));
    }
  });
  app.post("/internal/v1/next/lab-pitr/current", limit, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const presented = bearerToken(request);
    if (!presented || !safeEqual(presented, token)) return reply.code(401).send(apiError("invalid_internal_token", "Internal token required."));
    const input = probe.safeParse(request.body);
    if (!input.success) return reply.code(400).send(apiError("invalid_request", "Exact current identity required."));
    const b = input.data;
    try {
      if ((b.collection !== pitr.active && b.collection !== pitr.deleted) || b.policyKeyId !== policyKeyId) denied();
      return await inTransaction(options.db, async client => {
        await lock(client, b.collection);
        await currentCollection(client, pitr, options.next, b.collection, b.genesisSha256, (options.now ?? Date.now)());
        const peer = await currentPeer(client, pitr, b.collection, b.device);
        if (peer.kind !== b.kind || peer.sign_pk.toString("hex") !== b.signPublicKey) denied();
        const checkedAt = (options.now ?? Date.now)();
        if (!Number.isSafeInteger(checkedAt) || checkedAt < options.next.policyCert.not_before || checkedAt >= options.next.policyCert.not_after) denied();
        return { ...b, current: true, checkedAt };
      });
    } catch (error) {
      const status = error instanceof CreateError || (error instanceof Error && error.message === "collection_deleted") ? 409 : 503;
      return reply.code(status).send(apiError(status === 409 ? "lab_pitr_authority_denied" : "lab_pitr_authority_unavailable", "Current authority not established."));
    }
  });
  for(const [path,schema,mode] of [
    ["current-cp-genesis",cpGenesisProbe,"cp-genesis"],
    ["current-cp-collection",cpCollectionProbe,"cp-collection"],
  ] as const) app.post(`/internal/v1/next/lab-pitr/${path}`, limit, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const presented = bearerToken(request);
    if (!presented || !safeEqual(presented, token)) return reply.code(401).send(apiError("invalid_internal_token", "Internal token required."));
    const input = schema.safeParse(request.body);
    if (!input.success) return reply.code(400).send(apiError("invalid_request", "Exact original CP genesis identity required."));
    const b = input.data;
    try {
      const identity = options.log.pitrControlIdentity(); // public startup snapshot only
      if (!identity || (b.collection !== pitr.active && b.collection !== pitr.deleted) || b.policyKeyId !== policyKeyId
        || b.transportPublicKey !== identity.transportPublicKey || b.issuerKeyId !== identity.issuerKeyId) denied();
      return await inTransaction(options.db, async client => {
        await lock(client, b.collection);
        await currentCollection(client, pitr, options.next, b.collection, b.genesisSha256, (options.now ?? Date.now)(), mode);
        const checkedAt = (options.now ?? Date.now)();
        if (!Number.isSafeInteger(checkedAt) || checkedAt < options.next.policyCert.not_before || checkedAt >= options.next.policyCert.not_after) denied();
        return { ...b, current: true, checkedAt };
      });
    } catch (error) {
      const status = error instanceof CreateError || (error instanceof Error && error.message === "collection_deleted") ? 409 : 503;
      return reply.code(status).send(apiError(status === 409 ? "lab_pitr_authority_denied" : "lab_pitr_authority_unavailable", "Original CP genesis authority not established."));
    }
  });
  for(const [path,schema] of [["current-cp-nil-peek",cpNilPeekProbe],["current-cp-nil-read",cpNilReadProbe],["current-cp-nil-record",cpNilRecordProbe]] as const)
  app.post(`/internal/v1/next/lab-pitr/${path}`,limit,async(request,reply)=>{
    reply.header("cache-control","no-store");
    const presented=bearerToken(request);
    if(!presented||!safeEqual(presented,token))return reply.code(401).send(apiError("invalid_internal_token","Internal token required."));
    const input=schema.safeParse(request.body);
    if(!input.success)return reply.code(400).send(apiError("invalid_request","Exact original CP nil identity required."));
    const b=input.data;
    try{
      const identity=options.log.pitrControlIdentity();
      if(!identity||b.policyKeyId!==policyKeyId||b.transportPublicKey!==identity.transportPublicKey||b.issuerKeyId!==identity.issuerKeyId)denied();
      if(b.purpose!=="registry-read"&&b.subject!==pitr.active&&b.subject!==pitr.deleted)denied();
      return await inTransaction(options.db,async client=>{
        // create_log reads its deletion floor BEFORE persisting genesis. A single
        // subject peek can therefore observe its immutable sending original;
        // requiring the other not-yet-created subject would deadlock real seed.
        const subjects=b.purpose==="deletion-peek"
          ? [{collection:b.subject,genesisSha256:b.genesisSha256,state:"sending-or-appended" as const}]
          : [{collection:pitr.active,genesisSha256:b.activeGenesisSha256,state:"appended" as const},
             {collection:pitr.deleted,genesisSha256:b.deletedGenesisSha256,state:"appended" as const}];
        await currentNilSubjects(client,pitr,options.next,subjects,(options.now??Date.now)());
        if(b.purpose==="deletion-record"){
          // Exact denial fact only. Equal cp-intent/native rows may coexist;
          // ANY other retained tuple closes rather than selecting a winner.
          const facts=await client.query<{deletion_id:string;epoch:string}>(`SELECT deletion_id::text,lifecycle_epoch::text AS epoch
            FROM next_collection_deletion_facts WHERE collection_id=$1 ORDER BY lifecycle_epoch,deletion_id,authority LIMIT 3 FOR SHARE`,[b.subject]);
          if(!facts.rows.length||facts.rows.length>2||facts.rows.some(f=>f.deletion_id!==b.deletionId||f.epoch!==b.lifecycleEpoch))denied();
        }
        const checkedAt=(options.now??Date.now)();
        if(!Number.isSafeInteger(checkedAt)||checkedAt<options.next.policyCert.not_before||checkedAt>=options.next.policyCert.not_after)denied();
        return {...b,current:true,checkedAt};
      });
    }catch(error){const status=error instanceof CreateError?409:503;
      return reply.code(status).send(apiError(status===409?"lab_pitr_authority_denied":"lab_pitr_authority_unavailable","Current nil authority not established."));}
  });
  app.post("/internal/v1/next/lab-pitr/current-app-grant", limit, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const presented = bearerToken(request);
    if (!presented || !safeEqual(presented, token)) return reply.code(401).send(apiError("invalid_internal_token", "Internal token required."));
    const input = appGrantProbe.safeParse(request.body);
    if (!input.success) return reply.code(400).send(apiError("invalid_request", "Exact original app-grant identity required."));
    const b = input.data;
    try {
      if ((b.collection !== pitr.active && b.collection !== pitr.deleted) || b.policyKeyId !== policyKeyId) denied();
      return await inTransaction(options.db, async client => {
        const lockedGrant = await lockPitrAppGrant(client, b.collection, b.grant);
        await lock(client, b.collection);
        await currentCollection(client, pitr, options.next, b.collection, b.genesisSha256, (options.now ?? Date.now)());
        await assertPitrAppGrant(client, pitr, b.collection, b.grant, b.clientPublicKey, lockedGrant);
        const checkedAt = (options.now ?? Date.now)();
        if (!Number.isSafeInteger(checkedAt) || checkedAt < options.next.policyCert.not_before || checkedAt >= options.next.policyCert.not_after) denied();
        return { ...b, current: true, checkedAt };
      });
    } catch (error) {
      const status = error instanceof CreateError || (error instanceof Error && error.message === "collection_deleted") ? 409 : 503;
      return reply.code(status).send(apiError(status === 409 ? "lab_pitr_authority_denied" : "lab_pitr_authority_unavailable", "Current authority not established."));
    }
  });
  app.post("/internal/v1/next/lab-pitr/registry", limit, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const presented = bearerToken(request);
    if (!presented || !safeEqual(presented, token)) return reply.code(401).send(apiError("invalid_internal_token", "Internal token required."));
    const input = registry.safeParse(request.body);
    if (!input.success) return reply.code(400).send(apiError("invalid_request", "Exact fixed-run registry cut required."));
    try {
      const b = input.data;
      const page = await options.log.labPitrCollectionDeletions(b.run, b.after, b.expected === null ? null : BigInt(b.expected));
      return { run: pitr.run, generation: page.generation.toString(), after: page.after, done: page.done,
        rows: page.rows.map(row => ({ ...row, lifecycleEpoch: row.lifecycleEpoch.toString() })) };
    } catch {
      return reply.code(503).send(apiError("lab_pitr_authority_unavailable", "Isolated registry cut not established."));
    }
  });
  app.post("/v1/next/lab-pitr/delete-revoke", limit, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (request.headers.origin !== "https://connect-lab.mdbase.dev") return reply.code(403).send(apiError("origin_denied", "Fixture CP origin required."));
    const context = await requireSessionContext(request, reply, options.db);
    if (!context) return reply;
    if (context.user.id !== pitr.owner) return reply.code(403).send(apiError("not_owner", "Fixture owner required."));
    const input = mutation.safeParse(request.body);
    if (!input.success) return reply.code(400).send(apiError("invalid_request", "Exact run mutation required."));
    try {
      const result = await inTransaction(options.db, async client => {
        for (const id of [pitr.active, pitr.deleted].sort()) await lock(client, id);
        await currentSession(client, context.sessionId, context.user.id);
        const now = (options.now ?? Date.now)();
        await currentCollection(client, pitr, options.next, pitr.active, input.data.activeGenesisSha256, now);
        await currentCollection(client, pitr, options.next, pitr.deleted, input.data.deletedGenesisSha256, now);
        const peer = await currentPeer(client, pitr, pitr.active, input.data.device);
        if (peer.account !== pitr.owner || peer.kind === "hosted" || peer.kind === "escrow") denied();
        const hosted = (await client.query<{device_id: string}>("SELECT device_id::text FROM next_service_devices WHERE collection_id=$1 AND kind='hosted' FOR SHARE", [pitr.active])).rows[0];
        if (!hosted) denied();
        await currentPeer(client, pitr, pitr.active, hosted!.device_id); // Keep an independently current hosted survivor.
        if (!await queueNextPolicy(client, pitr.active, [{ op: "device-revoke", device: peer.id }])) denied();
        const deletion = await recordCollectionDeletionIntent(client, pitr.deleted, context.user.id);
        return { run: pitr.run, deleted: deletion.collection, deletionId: deletion.deletionId,
          lifecycleEpoch: deletion.lifecycleEpoch.toString(), revokedCollection: pitr.active, revokedDevice: peer.id };
      });
      // CP denial journal + outbox only. NOT a native Deleted ACK, purge or erasure.
      return result;
    } catch (error) {
      const status = error instanceof CreateError || (error instanceof Error && error.message === "collection_deleted") ? 409 : 503;
      return reply.code(status).send(apiError(status === 409 ? "lab_pitr_authority_denied" : "lab_pitr_authority_unavailable", "Mutation outcome not established."));
    }
  });
}
