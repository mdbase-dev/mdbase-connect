// Fenced local rollback preparation only. No backend change, connector unrevoke,
// grant activation or permission authority is implied by these binding tuples.
import { isDeepStrictEqual } from "node:util";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { GrantEncryption } from "@mdbase-dev/connect-protocol";
import { RELAY_ENCRYPTION_SUITE } from "@mdbase-dev/connect-protocol";
import type { DatabaseConnection, DatabasePool } from "../../database-types.js";
import { bearerToken, requireConnector } from "../../platform/request-authentication.js";
import { apiError } from "../../platform/http-errors.js";
import { tokenHash } from "../../security.js";
import { rotateGrantEncryption } from "../grants/policy.js";
import { CreateError, inTransaction, refuse } from "./bootstrap-common.js";

const uuid = z.uuid().transform(v => v.toLowerCase()).refine(v => v !== "00000000-0000-0000-0000-000000000000");
const inputSchema = z.object({
  legacy_connector_id: uuid,
  legacy_collection_ids: z.array(uuid).min(1).max(1000),
  collection_id: uuid,
  rollback_id: uuid,
}).strict().refine(v => new Set(v.legacy_collection_ids).size === v.legacy_collection_ids.length
  && v.legacy_collection_ids.includes(v.collection_id));
const resultSchema = z.object({
  collection_id: uuid, rollback_id: uuid,
  bindings: z.array(z.object({
    grant_id: uuid, key_id: z.string().min(1).max(128),
    scope_epoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  }).strict()).max(1000),
}).strict();
type Input = z.infer<typeof inputSchema>;
type Result = z.infer<typeof resultSchema>;
type Actor = { id: string; user_id: string; hash: string };
type Grant = { id: string; encryption: GrantEncryption | null };
type Receipt = { user_id: string; legacy_connector_id: string; legacy_collection_ids: string[]; response: unknown };

/** No newly supplied permission/public-key values; preserve the existing exact binding. */
function bindings(grants: Grant[], input: Input): Result["bindings"] {
  if (grants.length > 1000) throw new CreateError(409, "rollback_binding_inventory_too_large");
  return grants.map(({ id, encryption: e }) => {
    if (!e || e.protocol_version !== 1 || e.suite !== RELAY_ENCRYPTION_SUITE
        || e.connector_id !== input.legacy_connector_id || e.collection_id !== input.collection_id
        || typeof e.key_id !== "string" || e.key_id.length === 0 || e.key_id.length > 128
        || !Number.isSafeInteger(e.scope_epoch) || e.scope_epoch < 1) {
      throw new CreateError(409, "legacy_binding_unavailable");
    }
    return { grant_id: id, key_id: e.key_id, scope_epoch: e.scope_epoch };
  });
}

async function activeGrants(client: DatabaseConnection, input: Input, user: string): Promise<Grant[]> {
  return (await client.query<Grant>(
    `SELECT g.id, g.encryption FROM grants g JOIN collections col ON col.id = g.collection_id
     WHERE col.connector_id = $1 AND col.user_id = $2 AND col.local_id = $3
       AND col.present = true AND col.removed_at IS NULL
       AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
     ORDER BY g.id LIMIT 1001 FOR UPDATE OF g`,
    [input.legacy_connector_id, user, input.collection_id],
  )).rows;
}

async function rotate(client: DatabaseConnection, input: Input, actor: Actor): Promise<Result> {
  // Installation-scoped app-runtime/mobile tokens cannot enter this route. Even
  // ordinary pairing must be a CURRENT enrolled native desktop/CLI and account.
  const current = await client.query(
    `SELECT c.id FROM connectors c JOIN users u ON u.id = c.user_id
       JOIN next_devices d ON d.connector_id = c.id AND d.user_id = u.id
     WHERE c.id = $1 AND u.id = $2 AND c.token_hash = $3 AND c.revoked_at IS NULL
       AND u.suspended_at IS NULL AND u.account_backend = 'next' AND d.kind IN ('desktop','cli')
     FOR SHARE OF c, u, d`, [actor.id, actor.user_id, actor.hash],
  );
  if (!current.rows.length) throw new CreateError(403, "identity_not_current");
  if (input.legacy_connector_id === actor.id) throw new CreateError(409, "legacy_connector_is_caller");
  // Serialize this exact durable receipt key, including requests from different
  // callers/old connectors. Conflicting reuse is refused BEFORE any rotation.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 20261008))",
    [`${input.collection_id}:${input.rollback_id}`]);
  const old = await client.query(
    "SELECT id FROM connectors WHERE id = $1 AND user_id = $2 FOR UPDATE",
    [input.legacy_connector_id, actor.user_id],
  );
  // A retired old target is allowed; its credential is NOT an authentication path.
  if (!old.rows.length) throw new CreateError(403, "legacy_connector_unavailable");
  const inventory = (await client.query<{ local_id: string }>(
    `SELECT local_id FROM collections WHERE connector_id = $1 AND user_id = $2
       AND present = true AND removed_at IS NULL ORDER BY local_id LIMIT 1001 FOR SHARE`,
    [input.legacy_connector_id, actor.user_id],
  )).rows.map(r => r.local_id);
  if (!isDeepStrictEqual(inventory, input.legacy_collection_ids)) {
    throw new CreateError(409, "legacy_inventory_mismatch");
  }
  // Fresh legacy ownership/registration is the membership boundary; do not infer
  // it from a historical receipt or a grant row. No Next grant/policy is changed.
  const prior = (await client.query<Receipt>(
    "SELECT user_id, legacy_connector_id, legacy_collection_ids, response FROM next_local_rollback_bindings WHERE collection_id = $1 AND rollback_id = $2",
    [input.collection_id, input.rollback_id],
  )).rows[0];
  if (prior && (prior.user_id !== actor.user_id || prior.legacy_connector_id !== input.legacy_connector_id
      || !isDeepStrictEqual(prior.legacy_collection_ids, input.legacy_collection_ids))) {
    throw new CreateError(409, "rollback_id_conflict");
  }
  const grants = await activeGrants(client, input, actor.user_id);
  const now = bindings(grants, input);
  if (prior) {
    const parsed = resultSchema.safeParse(prior.response);
    if (!parsed.success || parsed.data.collection_id !== input.collection_id || parsed.data.rollback_id !== input.rollback_id) {
      throw new Error("Invalid durable rollback binding receipt.");
    }
    // No receipt is an authorization bypass. A revoked/narrowed/new binding set
    // refuses preparation; the receipt is immutable and never rotates again.
    if (!isDeepStrictEqual(parsed.data.bindings, now)) throw new CreateError(409, "rollback_bindings_changed");
    return parsed.data;
  }
  if (now.some(b => b.scope_epoch >= Number.MAX_SAFE_INTEGER)) throw new CreateError(409, "legacy_epoch_exhausted");
  for (const grant of grants) await rotateGrantEncryption(client, grant.id);
  const response: Result = { collection_id: input.collection_id, rollback_id: input.rollback_id,
    bindings: bindings(await activeGrants(client, input, actor.user_id), input) };
  await client.query(
    `INSERT INTO next_local_rollback_bindings(collection_id,rollback_id,user_id,legacy_connector_id,legacy_collection_ids,caller_connector_id,response)
     VALUES($1,$2,$3,$4,$5::uuid[],$6,$7::jsonb)`,
    [input.collection_id, input.rollback_id, actor.user_id, input.legacy_connector_id,
      input.legacy_collection_ids, actor.id, JSON.stringify(response)],
  );
  return response;
}

/** Current native pairing only; enabled with the Next control plane by app.ts. */
export function registerLocalRollbackBindingRoutes(app: FastifyInstance, db: DatabasePool): void {
  app.post("/v1/next/migration/local-rollback/rotate-bindings", {
    bodyLimit: 64 * 1024,
    config: { rateLimit: { max: 12, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const actor = await requireConnector(request, reply, db);
    if (!actor) return;
    const parsed = inputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(apiError("invalid_request", "Invalid local rollback binding request."));
    const input = { ...parsed.data, legacy_collection_ids: [...parsed.data.legacy_collection_ids].sort() };
    const hash = tokenHash(bearerToken(request)!);
    try { return await inTransaction(db, client => rotate(client, input, { ...actor, hash })); }
    catch (error) { return refuse(reply, error, "Local rollback binding preparation was not confirmed."); }
  });
}
