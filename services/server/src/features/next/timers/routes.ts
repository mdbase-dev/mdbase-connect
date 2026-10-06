import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AuthorityProofError, verifyAuthorityRequestProof } from "../../../authority-proof.js";
import { canonicalJson } from "../../../canonical-json.js";
import { lookupTimerReceipt, recordTimerReconcile, type TimerReceiptAuthority } from "./receipts.js";
import { z } from "zod";
import type { DatabasePool, DatabaseQueryable } from "../../../database-types.js";
import type { HostedProviderClient } from "../../../hosted-provider.js";
import { activeGrantForToken } from "../../../notifications.js";
import { apiError } from "../../../platform/http-errors.js";
import { bearerToken } from "../../../platform/request-authentication.js";
import { tokenHash } from "../../../security.js";
import {
  authorizeTimerOperation,
  grantMayFire,
  legacyTimerGrantResolver,
  type TimerGrant,
  type TimerGrantResolver,
  type TimerOperation
} from "./grants.js";
import {
  TimerError,
  criterionSchema,
  desiredTimer,
  namespaceSchema,
  putBodySchema,
  reconcileBodySchema,
  timerIdSchema
} from "./model.js";
import {
  cancelTimer,
  enforceTimerQuota,
  importTimer,
  listTimers,
  lockNamespace,
  putTimer,
  reconcileTimers
} from "./store.js";

export interface TimerRoutesOptions {
  db: DatabasePool;
  resolver?: TimerGrantResolver;
  hostedProvider?: HostedProviderClient;
  /** Called after a committed write, so the worker can fire timers due now. */
  onWrite?: () => void;
  writesPerMinute?: number;
}

type Request = FastifyRequest;
type GrantSource = (request: Request, reply: FastifyReply) => Promise<string | null>;
const recoverySchema = z.object({ protocol_version: z.literal(1),
  operation_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  expected_revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1)
}).strict();
const recoverableReconcileSchema = reconcileBodySchema.extend({ recovery: recoverySchema.optional() });

/** Per-grant write limiter (per process; the limit is a guard, not a quota). */
class WriteLimiter {
  private readonly windows = new Map<string, number[]>();

  constructor(private readonly perMinute: number) {}

  take(grantId: string, now = Date.now()): number | null {
    const recent = (this.windows.get(grantId) ?? []).filter((at) => at > now - 60_000);
    if (recent.length >= this.perMinute) {
      this.windows.set(grantId, recent);
      return recent[0] + 60_000 - now;
    }
    recent.push(now);
    this.windows.set(grantId, recent);
    if (this.windows.size > 10_000) {
      for (const [key, value] of this.windows) {
        if (value.every((at) => at <= now - 60_000)) this.windows.delete(key);
      }
    }
    return null;
  }
}

export function registerTimerRoutes(app: FastifyInstance, options: TimerRoutesOptions): void {
  const resolver = options.resolver ?? legacyTimerGrantResolver;
  const limiter = new WriteLimiter(options.writesPerMinute ?? 60);

  /** The app's own access token: the grant must name the collection in the path. */
  const appGrant: GrantSource = async (request, reply) => {
    const bearer = bearerToken(request);
    if (!bearer) {
      reply.code(401).send(apiError("unauthenticated", "Bearer token required."));
      return null;
    }
    const grant = await activeGrantForToken(options.db, tokenHash(bearer));
    if (!grant) {
      reply.code(401).send(apiError("unauthenticated", "Access token is invalid or expired."));
      return null;
    }
    return grant.grant_id;
  };

  /** The hosted replica's old-SDK shim, acting for a named grant. */
  const hostedShimGrant: GrantSource = async (request, reply) => {
    if (!options.hostedProvider?.authorizesInternalToken(bearerToken(request))) {
      reply.code(401).send(apiError("unauthenticated", "Hosted provider credential is invalid."));
      return null;
    }
    const grantId = z.object({ grant: z.uuid() }).parse(request.params).grant;
    // The provider credential acts only for cloud-copy grants, never for local
    // or end-to-end collections.
    const grant = await resolver.resolve(options.db, grantId);
    if (!grant || grant.state !== "cloud_copy") {
      reply.code(403).send(apiError("forbidden", "The hosted shim may act only for cloud-copy grants.", {
        reason: "not_cloud_copy"
      }));
      return null;
    }
    return grantId;
  };

  const run = async (
    request: Request,
    reply: FastifyReply,
    source: GrantSource,
    operation: TimerOperation,
    collectionFromPath: boolean,
    body: (grant: TimerGrant, db: DatabaseQueryable, authority: () => Promise<TimerReceiptAuthority>, deadline: number) => Promise<unknown>,
    criterionId?: string,
    namespace?: string,
    requireProof = false
  ): Promise<unknown> => {
    const write = request.method !== "GET";
    const deadline = Date.now() + 9_000;
    const checkDeadline = () => { if (Date.now() >= deadline) throw new TimerError(503, "busy", "Timer metadata deadline exceeded."); };
    const grantId = await source(request, reply);
    if (!grantId) return reply;
    try {
      const grant = await resolver.resolve(options.db, grantId);
      if (!grant) throw new TimerError(401, "unauthenticated", "The grant does not exist.");
      if (collectionFromPath) {
        const { collection } = z.object({ collection: z.uuid() }).parse(request.params);
        if (!grant.collectionIds.includes(collection)) {
          throw new TimerError(403, "forbidden", "The grant is not for this collection.", {
            reason: "collection_mismatch"
          });
        }
      }
      authorizeTimerOperation(grant, operation, criterionId);
      const retryAfter = write ? limiter.take(grant.grantId) : null;
      if (retryAfter !== null) {
        throw new TimerError(429, "rate_limited", "Too many timer writes for this grant.", {
          retry_after_ms: retryAfter
        });
      }
      const connection = await options.db.connect();
      try {
        await connection.query("BEGIN");
        await connection.query("SET LOCAL lock_timeout = '5s'");
        await connection.query("SET LOCAL statement_timeout = '5s'");
        checkDeadline();
        await lockNamespace(connection, grant.grantId, namespace!);
        const currentAuthority = async (): Promise<TimerReceiptAuthority> => {
          checkDeadline();
          const fields = `g.id, g.user_id, g.application_id, g.collection_id, g.hosted_collection_id,
            g.application_origin, g.application_authorization, g.scope, g.operations, g.notification_criteria,
            g.proof_public_key, u.account_backend`;
          let row: Record<string, unknown> | undefined;
          if (source === appGrant) {
            row = (await connection.query<Record<string, unknown>>(
              `/* mdbase:timer-authority-current:v1 */ SELECT ${fields}, tok.expires_at FROM access_tokens tok
               JOIN grants g ON g.id = tok.grant_id JOIN users u ON u.id = g.user_id
               WHERE tok.token_hash = $1 AND g.id = $2 AND tok.revoked_at IS NULL
                 AND tok.expires_at > clock_timestamp() AND g.revoked_at IS NULL
                 AND g.activated_at IS NOT NULL AND u.suspended_at IS NULL
                 AND g.user_id <> '00000000-0000-0000-0000-000000000000'::uuid
               FOR SHARE OF tok, g, u`, [tokenHash(bearerToken(request)!), grantId])).rows[0];
            if (!row || new Date(row.expires_at as Date).getTime() <= Date.now()) throw new TimerError(401, "unauthenticated", "The retained access token is no longer current.");
            if (requireProof) {
              if (typeof row.proof_public_key !== "string") throw new TimerError(401, "unauthenticated", "The retained client proof binding is unavailable.");
              const raw = request.rawBody;
              if (request.method !== "GET" && typeof raw !== "string") throw new Error("Timer request proof requires the original HTTP body.");
              verifyAuthorityRequestProof(request.headers, row.proof_public_key, { method: request.method,
                target: request.raw.url!, credential: bearerToken(request)!, body: request.method === "GET" ? undefined : raw as string });
            }
          } else {
            if (!options.hostedProvider?.authorizesInternalToken(bearerToken(request))) throw new TimerError(401, "unauthenticated", "Internal credential is no longer current.");
            row = (await connection.query<Record<string, unknown>>(
              `/* mdbase:timer-authority-current:v1 */ SELECT ${fields} FROM grants g JOIN users u ON u.id = g.user_id
               WHERE g.id = $1 AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
                 AND u.suspended_at IS NULL FOR SHARE OF g, u`, [grantId])).rows[0];
            if (!row) throw new TimerError(403, "forbidden", "The hosted grant is no longer current.");
          }
          if (row.account_backend !== "legacy" && row.account_backend !== "next") throw new Error("Invalid timer account backend marker.");
          const current = await resolver.resolve(connection, grantId);
          if (!current) throw new TimerError(401, "unauthenticated", "The grant does not exist.");
          if (source === hostedShimGrant && current.state !== "cloud_copy") throw new TimerError(403, "forbidden", "Hosted timer access requires a cloud copy.");
          if (collectionFromPath && !current.collectionIds.includes((request.params as { collection: string }).collection)) throw new TimerError(403, "forbidden", "The grant is no longer for this collection.");
          authorizeTimerOperation(current, operation, criterionId);
          checkDeadline();
          const stored = (await connection.query<{ application_installation_id: string; next_noise?: unknown }>(
            "SELECT * FROM grants WHERE id = $1", [grantId])).rows[0];
          if (!stored) throw new Error("Locked timer consent disappeared.");
          const { expires_at: _expires, ...terms } = row;
          return { grant: current, termsDigest: createHash("sha256").update(canonicalJson({ terms,
            installation_id: stored.application_installation_id, noise_consent: stored.next_noise ?? null, state: current.state,
            collection_ids: [...current.collectionIds].sort(), operations: [...current.operations].sort(), criteria: current.criteria })).digest() };
        };
        const authority = await currentAuthority();
        const result = await body(authority.grant, connection, currentAuthority, deadline);
        if (write) await enforceTimerQuota(connection, grant.grantId, namespace!);
        await currentAuthority();
        if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw new TimerError(413, "too_large", "Timer metadata response exceeds 1 MiB.");
        await connection.query("COMMIT");
        if (write) options.onWrite?.();
        return result;
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    } catch (error) {
      if (error instanceof AuthorityProofError) return reply.code(401).send(apiError("unauthenticated", "Client request proof is invalid."));
      if (["55P03", "57014"].includes(String((error as { code?: string })?.code))) return reply.code(503).send(apiError("busy", "Timer metadata is temporarily unavailable."));
      if (error instanceof TimerError) {
        return reply.code(error.statusCode).send(apiError(error.code, error.message, error.details));
      }
      if (error instanceof z.ZodError) {
        return reply.code(400).send(apiError("invalid_request", "Invalid timer request.", {
          issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message }))
        }));
      }
      throw error;
    }
  };

  const mount = (prefix: string, source: GrantSource, collectionFromPath: boolean) => {
    app.get(`${prefix}/:namespace`, async (request, reply) => {
      const namespace = parseOr400(namespaceSchema, (request.params as { namespace: string }).namespace, reply);
      if (namespace === undefined) return reply;
      reply.header("cache-control", "no-store");
      return run(request, reply, source, "list_timers", collectionFromPath, async (grant, db) => {
        const revision = (await db.query<{ intent_revision: string | number }>("SELECT intent_revision FROM next_timer_namespace_intents WHERE grant_id = $1 AND namespace = $2", [grant.grantId, namespace])).rows[0];
        return { namespace, intent_revision: Number(revision?.intent_revision ?? 0), timers: await listTimers(db, grant, namespace) };
      }, undefined, namespace);
    });

    app.put(`${prefix}/:namespace/:id`, async (request, reply) => {
      const params = parseOr400(
        z.object({ namespace: namespaceSchema, id: timerIdSchema }).passthrough(),
        request.params,
        reply
      );
      const input = params && parseOr400(putBodySchema, request.body, reply);
      if (!params || !input) return reply;
      return run(request, reply, source, "put_timer", collectionFromPath, (grant, db) =>
        putTimer(db, grant, params.namespace, input.criterion_id, desiredTimer({
          id: params.id,
          fire_at: input.fire_at,
          data: input.data
        })), input.criterion_id, params.namespace);
    });

    app.delete(`${prefix}/:namespace/:id`, async (request, reply) => {
      const params = parseOr400(
        z.object({ namespace: namespaceSchema, id: timerIdSchema }).passthrough(),
        request.params,
        reply
      );
      const query = parseOr400(
        z.object({ generation: z.coerce.number().int().positive().optional() }),
        request.query ?? {},
        reply
      );
      if (!params || !query) return reply;
      return run(request, reply, source, "cancel_timer", collectionFromPath, async (grant, db) => ({
        namespace: params.namespace,
        id: params.id,
        cancelled: await cancelTimer(db, grant, params.namespace, params.id, query.generation)
      }), undefined, params.namespace);
    });

    app.get(`${prefix}/:namespace/operations/:operation`, async (request, reply) => {
      const params = parseOr400(z.object({ namespace: namespaceSchema,
        operation: recoverySchema.shape.operation_id }).passthrough(), request.params, reply);
      if (!params) return reply;
      reply.header("cache-control", "no-store");
      return run(request, reply, source, "reconcile_timers", collectionFromPath, async (grant, db, current) => {
        const original = await lookupTimerReceipt(db, grant.grantId, params.namespace, params.operation, await current());
        return original ? { outcome: "committed", receipt: original }
          : { outcome: "unknown", namespace: params.namespace, operation_id: params.operation };
      }, undefined, params.namespace, true);
    });

    app.post(`${prefix}/:namespace/reconcile`, { config: { rawBody: true }, bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
      const namespace = parseOr400(namespaceSchema, (request.params as { namespace: string }).namespace, reply);
      const input = namespace !== undefined ? parseOr400(recoverableReconcileSchema, request.body, reply) : undefined;
      if (namespace === undefined || !input) return reply;
      reply.header("cache-control", "no-store");
      return run(request, reply, source, "reconcile_timers", collectionFromPath, (grant, db, current, deadline) => {
        const desired = input.timers.map(desiredTimer);
        const mutate = (fresh: TimerGrant) => reconcileTimers(db, fresh, namespace, input.criterion_id, desired, deadline);
        return input.recovery ? recordTimerReconcile(db, grant.grantId, namespace, {
          operationId: input.recovery.operation_id, expectedRevision: input.recovery.expected_revision,
          criterionId: input.criterion_id, desired
        }, current, mutate) : mutate(grant);
      }, input.criterion_id, namespace, input.recovery !== undefined);
    });
  };

  mount("/v1/next/collections/:collection/timers", appGrant, true);
  mount("/internal/v1/next/timers/:grant", hostedShimGrant, false);

  /** Cutover copy of active legacy timers (migration H10 / local takeover). */
  app.post("/internal/v1/next/timers/import", async (request, reply) => {
    if (!options.hostedProvider?.authorizesInternalToken(bearerToken(request))) {
      return reply.code(401).send(apiError("unauthenticated", "Internal credential is invalid."));
    }
    const input = parseOr400(importBodySchema, request.body, reply);
    if (!input) return reply;
    // Same scope as the shim: the provider credential imports cloud-copy timers only.
    try {
      return await importLegacyTimers(options.db, resolver, input.timers, "cloud_copy", () => {
        if (!options.hostedProvider?.authorizesInternalToken(bearerToken(request))) {
          throw new TimerError(401, "unauthenticated", "Internal credential is no longer current.");
        }
      });
    } catch (error) {
      if (["55P03", "57014"].includes(String((error as { code?: string })?.code))) return reply.code(503).send(apiError("busy", "Timer import is temporarily unavailable."));
      if (error instanceof TimerError) return reply.code(error.statusCode).send(apiError(error.code, error.message, error.details));
      throw error;
    }
  });
}

export const importBodySchema = z.object({
  timers: z.array(z.object({
    grant_id: z.uuid(),
    namespace: namespaceSchema,
    id: timerIdSchema,
    criterion_id: criterionSchema,
    fire_at: z.string().refine((value) => Number.isFinite(Date.parse(value))),
    data: z.unknown().optional()
  }).strict()).max(10_000)
}).strict();

/** Import legacy timers. Unknown or unusable grants are skipped, not errors. */
export async function importLegacyTimers(
  db: DatabasePool,
  resolver: TimerGrantResolver,
  timers: z.infer<typeof importBodySchema>["timers"],
  onlyState?: TimerGrant["state"],
  // Direct H10/local-takeover callers own their authenticated boundary; the
  // HTTP shim supplies its retained service-credential check explicitly.
  checkCaller?: () => void
): Promise<{ imported: number; existing: number; skipped: number }> {
  let imported = 0;
  let existing = 0;
  let skipped = 0;
  const deadline = Date.now() + 9_000;
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("SET LOCAL lock_timeout = '5s'");
    await connection.query("SET LOCAL statement_timeout = '5s'");
    const check = () => {
      if (Date.now() >= deadline) throw new TimerError(503, "busy", "Timer import deadline exceeded.");
      checkCaller?.();
    };
    const current = async (id: string): Promise<TimerGrant | null> => {
      check();
      const locked = await connection.query(
        `/* mdbase:timer-authority-current:v1 */ SELECT g.id FROM grants g JOIN users u ON u.id = g.user_id
         WHERE g.id = $1 AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
           AND u.suspended_at IS NULL AND g.user_id <> '00000000-0000-0000-0000-000000000000'::uuid
         FOR SHARE OF g, u`, [id]);
      if (!locked.rows.length) return null;
      const grant = await resolver.resolve(connection, id);
      if (!grant) return null;
      // Hold any existing collection mode row too, so a PRIVATE transition
      // cannot race the data projection or COMMIT. Missing approval still denies.
      for (const collection of grant.collectionIds) {
        await connection.query("SELECT collection_id FROM next_collections WHERE collection_id = $1 FOR SHARE", [collection]);
      }
      const fresh = await resolver.resolve(connection, id);
      check();
      return fresh && fresh.usable && (!onlyState || fresh.state === onlyState) ? fresh : null;
    };
    const accepted = new Map<string, { state: TimerGrant["state"]; criteria: Set<string>; namespaces: Set<string> }>();
    // Global grant locks precede namespace locks; imports acquire them in a
    // deterministic order so multi-grant batches cannot invert the lock order.
    for (const timer of [...timers].sort((a, b) => a.grant_id.localeCompare(b.grant_id)
      || a.namespace.localeCompare(b.namespace) || a.id.localeCompare(b.id))) {
      check();
      await lockNamespace(connection, timer.grant_id, timer.namespace);
      const grant = await current(timer.grant_id); // never borrow a pre-wait snapshot
      if (!grant || !grantMayFire(grant, timer.criterion_id)) { skipped += 1; continue; }
      const seen = accepted.get(timer.grant_id) ?? { state: grant.state, criteria: new Set<string>(), namespaces: new Set<string>() };
      if (seen.state !== grant.state) throw new TimerError(403, "forbidden", "Timer import authority changed.");
      seen.criteria.add(timer.criterion_id); seen.namespaces.add(timer.namespace); accepted.set(timer.grant_id, seen);
      if (await importTimer(connection, grant, timer)) imported += 1;
      else existing += 1;
    }
    for (const [id, seen] of accepted) {
      const grant = await current(id);
      if (!grant || grant.state !== seen.state || [...seen.criteria].some(c => !grantMayFire(grant, c))) {
        throw new TimerError(403, "forbidden", "Timer import authority changed.");
      }
      for (const namespace of seen.namespaces) await enforceTimerQuota(connection, id, namespace);
    }
    check();
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
  return { imported, existing, skipped };
}

function parseOr400<T extends z.ZodType>(
  schema: T,
  value: unknown,
  reply: FastifyReply
): z.infer<T> | undefined {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  reply.code(400).send(apiError("invalid_request", "Invalid timer request.", {
    issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message }))
  }));
  return undefined;
}
