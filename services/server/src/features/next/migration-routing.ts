// Control-plane routing of migrated owners to the environment's hosted migration
// Worker. Migrated collections stay served by that deployment after the flip, so
// every environment that migrates needs this routing. The environment comes from
// this deployment's own configuration, never from a request, label or flag.
// Selection is operator-released frozen cohorts, plus the retained explicit CSV
// fallback in LAB only.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabaseQueryable } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { bearerToken } from "../../platform/request-authentication.js";
import { safeEqual } from "../../security.js";

/** The single production switch. Production routing stays refused until it is
 * explicitly enabled here, together with the production migration Worker's
 * custody, backup and monitoring readiness. */
export const PRODUCTION_MIGRATION_ROUTING_ENABLED = false;

// Each environment's canonical Connect origin and migration Worker name.
const ENVIRONMENTS = {
  lab: { publicUrl: "https://connect-lab.mdbase.dev", worker: "mdbase-next-hosted-mig-lab" },
  staging: { publicUrl: "https://connect-staging.mdbase.dev", worker: "mdbase-next-hosted-mig-staging" },
  production: { publicUrl: "https://connect.mdbase.dev", worker: "mdbase-next-hosted-mig-production" },
} as const;
type MigrationRoutingEnvironment = keyof typeof ENVIRONMENTS;

export interface MigrationRouting {
  environment: MigrationRoutingEnvironment;
  accounts: ReadonlySet<string>;
  hosted: { url: string; token: string };
  inboundToken: string;
}

export class MigrationRoutingRefused extends Error {
  constructor(readonly code: "invalid_migration_routing" | "migration_routing_environment_refused" | "migration_routing_production_disabled") {
    super(code);
  }
}

/** The deployment environment admitted for migration routing; otherwise a named refusal.
 * Local and unknown environments are never admitted. */
export function migrationRoutingEnvironment(environment: string | undefined,
  productionEnabled = PRODUCTION_MIGRATION_ROUTING_ENABLED): MigrationRoutingEnvironment {
  if (environment === "lab" || environment === "staging") return environment;
  if (environment === "production") {
    if (productionEnabled) return environment;
    throw new MigrationRoutingRefused("migration_routing_production_disabled");
  }
  throw new MigrationRoutingRefused("migration_routing_environment_refused");
}

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const NAMES = ["MDBASE_NEXT_MIGRATION_HOSTED_URL", "MDBASE_NEXT_MIGRATION_HOSTED_TOKEN", "MDBASE_NEXT_MIGRATION_INBOUND_TOKEN"] as const;
// Compatibility: the LAB control plane's existing setting names, accepted in LAB
// only. Remove once the LAB deployment uses NAMES.
const LAB_NAMES = ["MDBASE_NEXT_LAB_MIGRATION_HOSTED_URL", "MDBASE_NEXT_LAB_MIGRATION_HOSTED_TOKEN", "MDBASE_NEXT_LAB_MIGRATION_INBOUND_TOKEN"] as const;
const LAB_ACCOUNT = "MDBASE_NEXT_LAB_MIGRATION_ACCOUNT";

export function parseMigrationRouting(env: NodeJS.ProcessEnv,
  { productionEnabled = PRODUCTION_MIGRATION_ROUTING_ENABLED }: { productionEnabled?: boolean } = {}): MigrationRouting | undefined {
  const read = (name: string) => env[name]?.trim() ?? "";
  const current = NAMES.map(read), lab = LAB_NAMES.map(read), account = read(LAB_ACCOUNT);
  if (![...current, ...lab, account].some(Boolean)) return undefined;
  const environment = migrationRoutingEnvironment(env.MDBASE_CONNECT_ENVIRONMENT, productionEnabled);
  const invalid = () => new MigrationRoutingRefused("invalid_migration_routing");
  const legacy = lab.some(Boolean);
  if ((legacy || account) && environment !== "lab") throw invalid();
  if (legacy && current.some(Boolean)) throw invalid();
  const [url, token, inboundToken] = legacy ? lab : current;
  const scope = ENVIRONMENTS[environment];
  if (env.PUBLIC_URL !== scope.publicUrl || env.MDBASE_NEXT_CONTROL_PLANE !== "1" || Buffer.byteLength(account, "utf8") > 8192
      || !url || !token || !inboundToken
      || token.length < 32 || inboundToken.length < 32 || token === inboundToken) throw invalid();
  const accounts = account ? account.split(",").map(value => value.trim()) : [];
  if (accounts.length > 128 || new Set(accounts).size !== accounts.length
      || accounts.some(value => !UUID.test(value) || value === "00000000-0000-0000-0000-000000000000")) throw invalid();
  let origin: URL;
  try { origin = new URL(url); } catch { throw invalid(); }
  if (origin.origin !== url || origin.protocol !== "https:" || origin.username || origin.password || origin.port
      || origin.pathname !== "/" || origin.search || origin.hash
      || !new RegExp(`^${scope.worker}\\.[a-z0-9-]+\\.workers\\.dev$`, "u").test(origin.hostname)) throw invalid();
  return { environment, accounts: new Set(accounts), hosted: { url, token }, inboundToken };
}

/** This is deployment routing, not permission to fence/import/flip. Canonical
 * migration guards still validate the exact current batch, claim and device.
 * Keep routing after start/flip and while global rollout is paused. */
async function migrationAccount(db: DatabaseQueryable, routing: MigrationRouting | undefined, account: string): Promise<boolean> {
  if (!routing) return false;
  if (routing.accounts.has(account)) return true;
  const row = (await db.query<{ eligible: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM next_migration_cohort_members m
     JOIN next_migration_cohorts c ON c.name=m.cohort
     WHERE m.account_id=$1 AND c.released_at IS NOT NULL AND c.frozen_at IS NOT NULL
       AND m.terminal_excluded_at IS NULL) AS eligible`, [account])).rows[0];
  return row?.eligible === true;
}

/** A routed collection whose migration route was retired (LAB fixture disposal):
 * it has no hosted deployment at all, neither the migration Worker nor the default. */
async function migrationRouteRetired(db: DatabaseQueryable, routing: MigrationRouting | undefined, collection: string): Promise<boolean> {
  if (!routing) return false;
  const row = (await db.query<{ retired: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM next_migration_routing_retirements WHERE collection_id=$1) AS retired", [collection])).rows[0];
  return row?.retired === true;
}

type MigrationRoute = "default" | "migration" | "retired";

/** Only a legacy hosted collection (a `hosted_collections` id) of a routed owner
 * migrates, so only it is served by the migration Worker. Every other collection,
 * including one a routed owner creates after the flip and any CP-native cloud copy
 * it already had, stays on the control plane's own deployments. All retained
 * authoritative ownership mappings must agree; missing/ambiguous is never a
 * migration match. */
export async function migrationRoute(db: DatabaseQueryable, routing: MigrationRouting | undefined, collection: string): Promise<MigrationRoute> {
  if (!routing) return "default";
  const result = await db.query<{ owner: string; legacy: boolean }>(
    `SELECT owners.owner, EXISTS (SELECT 1 FROM hosted_collections WHERE id=$1) AS legacy FROM (
       SELECT owner_user_id::text AS owner FROM next_collections WHERE collection_id=$1
       UNION SELECT user_id::text FROM hosted_collections WHERE id=$1
       UNION SELECT user_id::text FROM collections WHERE local_id=$1
       UNION SELECT owner_user_id::text FROM collection_identities WHERE id=$1) owners`, [collection]);
  if (result.rows.length > 1) throw new Error("ambiguous_collection_owner");
  const row = result.rows[0];
  if (row?.legacy !== true || !await migrationAccount(db, routing, row.owner)) return "default";
  return await migrationRouteRetired(db, routing, collection) ? "retired" : "migration";
}

type Deployments = { hosted: { url: string; token: string }; escrow: { url: string; token: string } };
/** null: the collection's migration route was retired, so it has no service deployments. */
export async function migrationDeployments(db: DatabaseQueryable, normal: Deployments, routing: MigrationRouting | undefined, collection: string): Promise<Deployments | null> {
  const route = await migrationRoute(db, routing, collection);
  return route === "retired" ? null : route === "migration" ? { ...normal, hosted: routing!.hosted } : normal;
}

const RETIRED_EVENT = "next_migration.routing_retired";

/** LAB fixture disposal: retire a routed collection's migration route, so a
 * released LAB scope leaves no live route or wake to a Worker that no longer
 * serves it. Idempotent; the audit event is written once with the first retirement. */
async function retireMigrationRoute(db: DatabaseQueryable, routing: MigrationRouting | undefined, collection: string, actor: string, reason: string) {
  if (routing?.environment !== "lab") throw new MigrationRouteRetireRefused(503, "lab_only");
  const route = await migrationRoute(db, routing, collection);
  if (route === "default") throw new MigrationRouteRetireRefused(409, "not_migration_routed");
  try {
    const row = (await db.query<{ retired_at: Date }>(
      `WITH inserted AS (INSERT INTO next_migration_routing_retirements (collection_id, actor, reason) VALUES ($1, $2, $3)
         ON CONFLICT (collection_id) DO NOTHING RETURNING retired_at),
       logged AS (INSERT INTO audit_events (id, user_id, event_type, subject_id, metadata)
         SELECT gen_random_uuid(), NULL, $4, $1, jsonb_build_object('collection_id', $1::text, 'actor', $2::text, 'reason', $3::text) FROM inserted)
       SELECT retired_at FROM inserted UNION ALL SELECT retired_at FROM next_migration_routing_retirements WHERE collection_id = $1`,
      [collection, actor, reason, RETIRED_EVENT])).rows[0];
    if (!row) throw new MigrationRouteRetireRefused(503, "busy");
    return { collection_id: collection, retired_at: row.retired_at.toISOString() };
  } catch (error) {
    // Only a registered next collection is woken or served by a hosted deployment.
    if ((error as { code?: unknown })?.code === "23503") throw new MigrationRouteRetireRefused(404, "collection_not_found");
    throw error;
  }
}

class MigrationRouteRetireRefused extends Error {
  constructor(readonly status: number, readonly code: "lab_only" | "not_migration_routed" | "collection_not_found" | "busy") { super(code); }
}

/** `POST …/collections/:id/routing/retire`: the migration token only, mounted in LAB only. */
export function registerMigrationRouteRetireRoute(app: FastifyInstance, options: { db: DatabaseQueryable; token: string; routing: MigrationRouting }): void {
  if (options.routing.environment !== "lab") return;
  const params = z.object({ id: z.uuid() }).strict();
  const body = z.object({ actor: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(500) }).strict();
  app.post("/internal/v1/next/migration/collections/:id/routing/retire", {
    bodyLimit: 4096, config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const token = bearerToken(request);
    if (!token || !safeEqual(token, options.token)) return reply.code(401).send(apiError("invalid_internal_token", "The migration token is required."));
    const p = params.safeParse(request.params), b = body.safeParse(request.body);
    if (!p.success || !b.success) return reply.code(400).send(apiError("invalid_request", "A canonical collection UUID, actor and reason are required."));
    try {
      return await retireMigrationRoute(options.db, options.routing, p.data.id, b.data.actor, b.data.reason);
    } catch (error) {
      if (error instanceof MigrationRouteRetireRefused) return reply.code(error.status).send(apiError(error.code, "The migration route was not retired."));
      if (["55P03", "57014", "40P01", "40001"].includes(String((error as { code?: unknown })?.code))) return reply.code(503).send(apiError("busy", "Busy; retry."));
      throw error;
    }
  });
}
