// Minimal authenticated account metadata, usable before any data/describe/setup
// call. Backend is a persisted account marker, not inferred from grant transport,
// errors, collection ownership or the deployment's NEXT feature flag.
import type { FastifyInstance } from "fastify";
import type { DatabasePool, DatabaseQueryable } from "../../database-types.js";
import { AuthorityProofError, verifyAuthorityRequestProof } from "../../authority-proof.js";
import { apiError } from "../../platform/http-errors.js";
import { bearerToken } from "../../platform/request-authentication.js";
import { tokenHash } from "../../security.js";

type AccountBackend = "legacy" | "next";
function accountBackend(value: unknown): AccountBackend {
  if (value !== "legacy" && value !== "next") throw new Error("Account backend marker is unavailable or invalid.");
  return value;
}
export async function readAccountBackend(db: DatabaseQueryable, account: string): Promise<AccountBackend> {
  const row = (await db.query<{ account_backend: unknown }>("SELECT account_backend FROM users WHERE id = $1", [account])).rows[0];
  return accountBackend(row?.account_backend);
}

export function registerAccountBackendRoute(app: FastifyInstance, db: DatabasePool): void {
  app.get("/v1/account/backend", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    schema: { querystring: { type: "object", additionalProperties: false, properties: {} } }
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const token = bearerToken(request);
    if (!token) return reply.code(401).send(apiError("unauthenticated", "A retained application grant is required."));
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      // The consenting grant account, never the collection/connector's owner.
      // Hold token/grant/account currentness through proof validation and answer.
      const row = (await client.query<{ account_id: string; account_backend: unknown; proof_public_key: string | null; expires_at: Date }>(
        `SELECT g.user_id AS account_id, u.account_backend, g.proof_public_key, tok.expires_at
         FROM access_tokens tok JOIN grants g ON g.id = tok.grant_id JOIN users u ON u.id = g.user_id
         WHERE tok.token_hash = $1 AND tok.expires_at > clock_timestamp() AND tok.revoked_at IS NULL
           AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL AND u.suspended_at IS NULL
           AND g.user_id <> '00000000-0000-0000-0000-000000000000'::uuid
         FOR SHARE OF tok, g, u`, [tokenHash(token)]
      )).rows[0];
      if (!row?.proof_public_key || row.expires_at.getTime() <= Date.now()) {
        await client.query("ROLLBACK");
        return reply.code(401).send(apiError("unauthenticated", "The grant or its client proof binding is unavailable."));
      }
      verifyAuthorityRequestProof(request.headers, row.proof_public_key, {
        method: request.method, target: request.raw.url!, credential: token
      });
      const backend = accountBackend(row.account_backend);
      await client.query("COMMIT");
      return { account_id: row.account_id, backend };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof AuthorityProofError) return reply.code(401).send(apiError("unauthenticated", "Client request proof is invalid."));
      if (["55P03", "57014"].includes(String((error as { code?: string })?.code))) return reply.code(503).send(apiError("busy", "Account metadata is temporarily unavailable."));
      throw error;
    } finally { client.release(); }
  });
}
