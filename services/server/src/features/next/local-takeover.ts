// Retire one exact legacy connector after a native local takeover. Retain its
// collections and legacy grant/binding rows for fenced rollback; never activate
// grants, rotate keys, flip an account backend or infer authority from absence.
import { isDeepStrictEqual } from "node:util";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabaseConnection, DatabasePool } from "../../database-types.js";
import { bearerToken, requireConnector } from "../../platform/request-authentication.js";
import { apiError } from "../../platform/http-errors.js";
import { tokenHash } from "../../security.js";
import type { RelayHub } from "../../relay.js";
import { CreateError, inTransaction, refuse } from "./bootstrap-common.js";

const uuid = z.uuid().transform(v => v.toLowerCase()).refine(v => v !== "00000000-0000-0000-0000-000000000000");
const inputSchema = z.object({
  legacy_connector_id: uuid,
  legacy_collection_ids: z.array(uuid).min(1).max(1000),
  // This is the caller's observation, NOT the retirement timestamp or proof.
  taken_over_at: z.iso.datetime({ offset: true }).max(64),
}).strict().refine(v => new Set(v.legacy_collection_ids).size === v.legacy_collection_ids.length);
type Input = z.infer<typeof inputSchema>;
type Actor = { id: string; user_id: string; hash: string };

async function retire(client: DatabaseConnection, input: Input, actor: Actor): Promise<string> {
  // Account FIRST everywhere: serialize against legacy inventory's account
  // update lock without a connector/account lock-order inversion.
  const account = await client.query(
    "SELECT id FROM users WHERE id = $1 AND suspended_at IS NULL AND account_backend = 'next' FOR SHARE",
    [actor.user_id],
  );
  if (!account.rows.length) throw new CreateError(403, "identity_not_current");
  const current = await client.query(
    `SELECT c.id FROM connectors c JOIN next_devices d ON d.connector_id = c.id AND d.user_id = c.user_id
     WHERE c.id = $1 AND c.user_id = $2 AND c.token_hash = $3 AND c.revoked_at IS NULL
       AND d.kind IN ('desktop','cli') FOR SHARE OF c, d`, [actor.id, actor.user_id, actor.hash],
  );
  if (!current.rows.length) throw new CreateError(403, "identity_not_current");
  if (input.legacy_connector_id === actor.id) throw new CreateError(409, "legacy_connector_is_caller");
  // registerDevice takes this SAME connector lock before challenge consumption
  // and rechecks its original credential. No historical Next link may retire.
  const old = await client.query<{ revoked_at: Date | string | null; relay_generation: string }>(
    "SELECT revoked_at, relay_generation::text FROM connectors WHERE id = $1 AND user_id = $2 FOR UPDATE",
    [input.legacy_connector_id, actor.user_id],
  );
  if (!old.rows.length) throw new CreateError(403, "legacy_connector_unavailable");
  if ((await client.query("SELECT 1 FROM next_devices WHERE connector_id = $1 LIMIT 1", [input.legacy_connector_id])).rows.length) {
    throw new CreateError(409, "legacy_connector_is_next");
  }
  // Positive legacy registration is required. Include retired authority rows;
  // missing/removed collections do not establish permission or an empty success.
  // local_id is PostgreSQL uuid: canonical lowercase output and byte ordering
  // match normalized JS UUID ordering; text collation must not replace it.
  const inventory = (await client.query<{ local_id: string }>(
    `SELECT local_id FROM collections WHERE connector_id = $1 AND user_id = $2
       AND present = true AND removed_at IS NULL ORDER BY local_id LIMIT 1001 FOR UPDATE`,
    [input.legacy_connector_id, actor.user_id],
  )).rows.map(r => r.local_id);
  if (!isDeepStrictEqual(inventory, input.legacy_collection_ids)) throw new CreateError(409, "legacy_inventory_mismatch");
  const row = old.rows[0]!;
  // Original server timestamp and generation remain stable on an exact replay.
  // Current actor/target/inventory were rechecked above; replay is not authority.
  let generation = row.relay_generation;
  if (row.revoked_at === null) {
    const changed = await client.query<{ relay_generation: string }>(
      `UPDATE connectors SET revoked_at = clock_timestamp(), relay_generation = relay_generation + 1
       WHERE id = $1 RETURNING relay_generation::text`, [input.legacy_connector_id],
    );
    generation = changed.rows[0]!.relay_generation;
  }
  await client.query(
    `UPDATE collections SET authority_state = 'retired', enabled = false
     WHERE connector_id = $1 AND user_id = $2 AND present = true AND removed_at IS NULL`,
    [input.legacy_connector_id, actor.user_id],
  );
  return generation;
}

/** Ordinary CURRENT native desktop/CLI pairing only; never installation tokens. */
export function registerLocalTakeoverRoutes(app: FastifyInstance, options: { db: DatabasePool; relay: Pick<RelayHub, "fenceConnector"> }): void {
  app.post("/v1/next/migration/local-takeover", {
    bodyLimit: 64 * 1024,
    config: { rateLimit: { max: 12, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const actor = await requireConnector(request, reply, options.db);
    if (!actor) return;
    const parsed = inputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(apiError("invalid_request", "Invalid local takeover request."));
    const input = { ...parsed.data, legacy_collection_ids: [...parsed.data.legacy_collection_ids].sort() };
    let generation: string;
    try {
      generation = await inTransaction(options.db, client => retire(client, input, { ...actor, hash: tokenHash(bearerToken(request)!) }));
    } catch (error) { return refuse(reply, error, "Legacy retirement was not confirmed."); }
    // Revocation/generation are already committed, the hard server fence. An
    // unreachable broker converges with the existing bounded relay lease; retry
    // the SAME request to retry closure without changing timestamp/generation.
    await options.relay.fenceConnector(input.legacy_connector_id, generation).catch(() => undefined);
    return { retired: true, legacy_connector_id: input.legacy_connector_id };
  });
}
