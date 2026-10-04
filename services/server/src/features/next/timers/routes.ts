import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DatabasePool, DatabaseQueryable } from "../../../database-types.js";
import type { HostedProviderClient } from "../../../hosted-provider.js";
import { activeGrantForToken } from "../../../notifications.js";
import { apiError } from "../../../platform/http-errors.js";
import { bearerToken } from "../../../platform/request-authentication.js";
import { tokenHash } from "../../../security.js";
import {
  authorizeTimerOperation,
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
    return z.object({ grant: z.uuid() }).parse(request.params).grant;
  };

  const run = async (
    request: Request,
    reply: FastifyReply,
    source: GrantSource,
    operation: TimerOperation,
    collectionFromPath: boolean,
    body: (grant: TimerGrant, db: DatabaseQueryable) => Promise<unknown>,
    criterionId?: string,
    namespace?: string
  ): Promise<unknown> => {
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
      if (operation === "list_timers") return await body(grant, options.db);
      const retryAfter = limiter.take(grant.grantId);
      if (retryAfter !== null) {
        throw new TimerError(429, "rate_limited", "Too many timer writes for this grant.", {
          retry_after_ms: retryAfter
        });
      }
      const connection = await options.db.connect();
      try {
        await connection.query("BEGIN");
        await lockNamespace(connection, grant.grantId, namespace!);
        const result = await body(grant, connection);
        await enforceTimerQuota(connection, grant.grantId, namespace!);
        await connection.query("COMMIT");
        options.onWrite?.();
        return result;
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    } catch (error) {
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
      return run(request, reply, source, "list_timers", collectionFromPath, async (grant) => ({
        namespace,
        timers: await listTimers(options.db, grant, namespace)
      }));
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

    app.post(`${prefix}/:namespace/reconcile`, async (request, reply) => {
      const namespace = parseOr400(namespaceSchema, (request.params as { namespace: string }).namespace, reply);
      const input = namespace !== undefined ? parseOr400(reconcileBodySchema, request.body, reply) : undefined;
      if (namespace === undefined || !input) return reply;
      return run(request, reply, source, "reconcile_timers", collectionFromPath, (grant, db) =>
        reconcileTimers(db, grant, namespace, input.criterion_id, input.timers.map(desiredTimer)),
      input.criterion_id, namespace);
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
    return importLegacyTimers(options.db, resolver, input.timers);
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
  timers: z.infer<typeof importBodySchema>["timers"]
): Promise<{ imported: number; existing: number; skipped: number }> {
  let imported = 0;
  let existing = 0;
  let skipped = 0;
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    const grants = new Map<string, TimerGrant | null>();
    for (const timer of timers) {
      if (!grants.has(timer.grant_id)) {
        grants.set(timer.grant_id, await resolver.resolve(connection, timer.grant_id));
      }
      const grant = grants.get(timer.grant_id);
      if (!grant || !grant.usable) {
        skipped += 1;
        continue;
      }
      if (await importTimer(connection, grant, timer)) imported += 1;
      else existing += 1;
    }
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
