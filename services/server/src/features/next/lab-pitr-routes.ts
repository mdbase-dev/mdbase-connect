/** Fixed-run LAB CP checks/mutations. No restored state or caller permission flag
 * can authorize. Current responses are point observations, never reusable leases.
 */
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
import type { NextControlPlaneConfig } from "./policy-keys.js";
import type { LogServiceClient } from "./log-service-client.js";
import { keyId, type DeviceKind } from "./policy-wire.js";
import { queueNextPolicy } from "./policy-outbox.js";
import { projectNextGrant, type NextGrantSource } from "./grant-policy.js";

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
const registry = z.object({ run: z.literal("gate4-pitr-lab-20261009-01"), after: uuid.nullable(),
  expected: z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/).refine(v => /^(?:0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= (1n << 64n) - 1n).nullable() }).strict();
const mutation = z.object({ run: z.literal("gate4-pitr-lab-20261009-01"), activeGenesisSha256: hash,
  deletedGenesisSha256: hash, device: uuid }).strict();
interface Peer { id: string; account: string; kind: DeviceKind; sign_pk: Buffer; kem_pk: Buffer; noise_pk: Buffer }
const denied = (): never => { throw new CreateError(409, "lab_pitr_authority_denied"); };

async function currentCollection(client: DatabaseConnection, pitr: LabPitrConfig, next: NextControlPlaneConfig,
  collection: string, expectedGenesis: string, now: number, pendingGenesis = false): Promise<void> {
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
  const genesis = await originalGenesis(client, collection, pendingGenesis ? {owner:pitr.owner,root:next.policyCert.root_key_id} : undefined);
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
export function registerLabPitrRoutes(app: FastifyInstance, options: {
  db: DatabasePool; next: NextControlPlaneConfig;
  log: Pick<LogServiceClient, "labPitrCollectionDeletions" | "pitrControlIdentity">; now?: () => number;
}): void {
  const pitr = options.next.logService.labPitr;
  const token = options.next.pitrAuthorityToken;
  if (!pitr || !token) return; // Parser requires both together; ordinary deployments expose no routes.
  const policyKeyId = Buffer.from(keyId(Buffer.from(options.next.policyCert.policy_public_key, "hex"))).toString("hex");
  const limit = { bodyLimit: 4096, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } };
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
  app.post("/internal/v1/next/lab-pitr/current-cp-genesis", limit, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const presented = bearerToken(request);
    if (!presented || !safeEqual(presented, token)) return reply.code(401).send(apiError("invalid_internal_token", "Internal token required."));
    const input = cpGenesisProbe.safeParse(request.body);
    if (!input.success) return reply.code(400).send(apiError("invalid_request", "Exact original CP genesis identity required."));
    const b = input.data;
    try {
      const identity = options.log.pitrControlIdentity(); // public startup snapshot only
      if (!identity || (b.collection !== pitr.active && b.collection !== pitr.deleted) || b.policyKeyId !== policyKeyId
        || b.transportPublicKey !== identity.transportPublicKey || b.issuerKeyId !== identity.issuerKeyId) denied();
      return await inTransaction(options.db, async client => {
        await lock(client, b.collection);
        await currentCollection(client, pitr, options.next, b.collection, b.genesisSha256, (options.now ?? Date.now)(), true);
        const checkedAt = (options.now ?? Date.now)();
        if (!Number.isSafeInteger(checkedAt) || checkedAt < options.next.policyCert.not_before || checkedAt >= options.next.policyCert.not_after) denied();
        return { ...b, current: true, checkedAt };
      });
    } catch (error) {
      const status = error instanceof CreateError || (error instanceof Error && error.message === "collection_deleted") ? 409 : 503;
      return reply.code(status).send(apiError(status === 409 ? "lab_pitr_authority_denied" : "lab_pitr_authority_unavailable", "Original CP genesis authority not established."));
    }
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
