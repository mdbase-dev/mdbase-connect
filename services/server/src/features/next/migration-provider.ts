// Dedicated migration-token fronts for provider fence/drain and canonical
// SHADOW bootstrap. Public target facts are not native H1/key readiness; these
// routes never grant serving authority, cut over, restore or unfreeze a source.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabaseConnection, DatabasePool, DatabaseQueryable } from "../../database-types.js";
import { HostedProviderResponseError, HostedProviderUnavailableError, type HostedProviderClient } from "../../hosted-provider.js";
import { audit } from "../../platform/audit-events.js";
import { apiError } from "../../platform/http-errors.js";
import { bearerToken } from "../../platform/request-authentication.js";
import { safeEqual } from "../../security.js";
import { CreateError, inTransaction, lock, refuseRevoked } from "./bootstrap-common.js";
import { configuredClaimAudience, consumeServiceClaimChallenge, issueServiceClaimChallenge, sameServiceClaim } from "./migration-claim-auth.js";
import { RolloutRefused } from "./migration-rollout.js";
import { createServiceCloudCopy, existingCloudCopy, type CloudCopyBootstrapOptions } from "./service-cloud-copy.js";
import { loadServiceDevice } from "./service-devices.js";

interface Claim { account: string; started_us: string; display_name: string }
interface Options {
  db: DatabasePool; token: string;
  provider?: Pick<HostedProviderClient, "legacyMigrationDrain" | "legacyMigrationFence">;
  bootstrap?: Omit<CloudCopyBootstrapOptions, "db">;
  /** Existing hosted-role credential + OWN canonical configured CP origin. */
  hostedRead?: { token: string; audience: string };
}

/** Current migration claim, not target/key readiness. Internal migration may
 * preserve an existing suspension; nothing here enables ordinary user access.
 * The locked form is for the final publication/audit, never a network await. */
async function claim(db: DatabaseQueryable, collection: string, locked = false): Promise<Claim> {
  const row = (await db.query<Claim>(
    `SELECT h.user_id::text AS account, h.display_name, (extract(epoch FROM m.started_at)*1000000)::bigint::text AS started_us
     FROM hosted_collections h JOIN users u ON u.id=h.user_id
     JOIN next_migration_cohort_members m ON m.account_id=u.id
     WHERE h.id=$1 AND h.authority_state='active' AND h.quarantined_at IS NULL
       AND u.account_backend='legacy' AND m.started_at IS NOT NULL AND m.terminal_excluded_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM next_collection_deletion_facts d WHERE d.collection_id=h.id)
       AND NOT EXISTS (SELECT 1 FROM next_migration_collections c WHERE c.collection_id=h.id)
       AND NOT EXISTS (SELECT 1 FROM next_migration_account_flips f WHERE f.account_id=u.id)
     ${locked ? "FOR SHARE OF h,u,m" : ""}`, [collection]
  )).rows[0];
  if (!row) throw new RolloutRefused("migration_source_not_current", "No current hosted migration claim.");
  return row;
}

/** Authenticated current CP facts for a native consumer's independent checks.
 * No provider/network/bootstrap effects, freshness lease or readiness boolean.
 * A missing target is ordinary pre-bootstrap DATA, not H1 permission. */
async function currentClaim(client: DatabaseConnection, collection: string, serviceRead = false) {
    const before = await claim(client, collection, true);
    // Same owner-before-collection order and immutable tuple checks as bootstrap.
    await lock(client, collection);
    let observedTarget = null;
    if (await existingCloudCopy(client, collection, before.account)) {
      const row = (await client.query<{ root_key_id: Buffer }>(
        "SELECT root_key_id FROM next_collections WHERE collection_id=$1 AND runtime='shadow' AND octet_length(root_key_id)=16", [collection]
      )).rows[0];
      if (!row) throw new CreateError(409, "collection_exists");
      // The service proof must use a key that cannot be replaced across SQL
      // awaits/verification/consume/COMMIT. Parent/context checks stay canonical.
      if (serviceRead) await client.query("SELECT device_id FROM next_service_devices WHERE collection_id=$1 AND kind='hosted' FOR SHARE", [collection]);
      // The H1 subject is hosted; no new escrow or app-grant obligation.
      const device = await loadServiceDevice(client, collection, { kind: "hosted" });
      if (!device || device.device_id === "00000000-0000-0000-0000-000000000000") throw new CreateError(503, "not_ready");
      if (serviceRead) await refuseRevoked(client, collection, device.device_id);
      observedTarget = { runtime: "shadow", root_key_id: row.root_key_id.toString("hex"), hosted: {
        device_id: device.device_id, sign_pk: device.sign_pk.toString("hex"),
        kem_pk: device.kem_pk.toString("hex"), noise_pk: device.noise_pk.toString("hex")
      } };
    }
    // Includes independently inserted deletion/cutover facts after SQL awaits.
    const after = await claim(client, collection, true);
    if (after.account !== before.account || after.started_us !== before.started_us) {
      throw new RolloutRefused("migration_source_changed", "The migration claim changed.");
    }
    return { schema: "mdbase-migration-claim/1", collection_id: collection,
      owner_account: before.account, started_us: before.started_us, target: observedTarget };
}

async function target(collection: string, options: Options) {
  const before = await claim(options.db, collection);
  if (!options.bootstrap) throw new RolloutRefused("migration_target_unavailable", "The SHADOW bootstrap is unavailable.", 503);
  const current = async (client: DatabaseQueryable) => {
    const observed = await claim(client, collection, true);
    if (observed.account !== before.account || observed.started_us !== before.started_us) {
      throw new RolloutRefused("migration_source_changed", "The migration claim changed.");
    }
  };
  // Runtime and owner are composed here, never selected by caller input. The
  // shared creator rechecks current around awaits and preserves committed keys.
  const result = await createServiceCloudCopy({ ...options.bootstrap, db: options.db }, {
    collection, owner: before.account, runtime: "shadow", displayName: before.display_name, current
  });
  return inTransaction(options.db, async client => {
    await current(client);
    await audit(client, before.account, "next_migration.target", collection, { runtime: "shadow" });
    return result;
  });
}

async function action(collection: string, fence: boolean, options: Options) {
  const before = await claim(options.db, collection);
  if (!options.provider) throw new RolloutRefused("migration_source_unavailable", "The legacy provider is unavailable.", 503);
  const deadline = Date.now() + 25_000;
  const source = await options.provider.legacyMigrationDrain(collection, { deadline });
  // Never re-fence a retained/cut-over collection through this launch front.
  // A missing run identity for a fenced source is not an active migration.
  if (!["active", "migrating"].includes(source.state) || source.retain_until !== null
      || (source.state === "migrating" && (!source.migration_id || !source.started_at))
      || (source.state === "active" && (source.migration_id != null || source.started_at !== null))) {
    throw new RolloutRefused("migration_source_not_current", "The legacy source is not pre-cutover.");
  }
  if (source.collection_id !== collection) throw new RolloutRefused("migration_source_unavailable", "The source identity does not match.", 503);
  // Recheck after the read, before any provider effect. Provider fencing itself
  // orders with legacy writers using its existing collection row lock.
  const current = await claim(options.db, collection);
  if (current.account !== before.account || current.started_us !== before.started_us) {
    throw new RolloutRefused("migration_source_changed", "The migration claim changed.");
  }
  // The existing provider client owns strict reply decoding; do not add another
  // codec here. This layer additionally binds its outcome to the observed run.
  const result = fence ? await options.provider.legacyMigrationFence(collection, { deadline }) : source;
  if (result.collection_id !== collection || (fence && (result.retain_until !== null
      || result.state !== "migrating" || !result.migration_id
      || result.migration_id === "00000000-0000-0000-0000-000000000000" || !result.started_at))) {
    throw new RolloutRefused("migration_source_unavailable", "The provider outcome is not a current source.", 503);
  }
  // A retry may observe this run, never silently adopt a replacement after a
  // provider rollback/restart during the await. The fence response is state DATA,
  // not an original-effect receipt or all-writer/external-I/O settlement ACK.
  if (fence && source.state === "migrating"
      && (result.migration_id !== source.migration_id || result.started_at !== source.started_at)) {
    throw new RolloutRefused("migration_source_changed", "The provider migration run changed.");
  }
  return inTransaction(options.db, async client => {
    const after = await claim(client, collection, true);
    if (after.account !== before.account || after.started_us !== before.started_us) {
      throw new RolloutRefused("migration_source_changed", "The migration claim changed.");
    }
    await audit(client, after.account, fence ? "next_migration.fence" : "next_migration.source", collection,
      { migration_id: result.migration_id ?? null, state: result.state });
    return result;
  });
}

export function registerMigrationProviderRoutes(app: FastifyInstance, options: Options): void {
  const params = z.object({ id: z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?![\s\S])/u)
    .refine(id => id !== "00000000-0000-0000-0000-000000000000") }).strict();
  const empty = z.object({}).strict();
  const hostedRead = options.hostedRead;
  if (hostedRead) {
    const audience = configuredClaimAudience(hostedRead.audience);
    if (!hostedRead.token || safeEqual(hostedRead.token, options.token)) throw new Error("Hosted claim read requires its distinct existing role credential.");
    const device = params.shape.id;
    const challengeBody = z.object({ device_id: device }).strict();
    const readBody = challengeBody.extend({ challenge: z.string().regex(/^[0-9a-f]{64}(?![\s\S])/u), sig: z.string().regex(/^[0-9a-f]{128}(?![\s\S])/u) }).strict();
    for (const kind of ["challenge", "read"] as const) {
      app.post(`/internal/v1/next/migration/collections/:id/claim/${kind}`, {
        bodyLimit: 1024, config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
        onRequest: async (request, reply) => {
          reply.header("cache-control", "no-store");
          const token = bearerToken(request);
          if (!token || !safeEqual(token, hostedRead.token)) return reply.code(401).send(apiError("invalid_internal_token", "The hosted role credential is required."));
        }
      }, async (request, reply) => {
        const p = params.safeParse(request.params), body = (kind === "read" ? readBody : challengeBody).safeParse(request.body);
        if (!p.success || !body.success || !empty.safeParse(request.query).success) return reply.code(400).send(apiError("invalid_request", "A canonical service proof is required."));
        try {
          return await inTransaction(options.db, async client => {
            const before = await currentClaim(client, p.data.id, true);
            let nonce: { challenge: string } | undefined;
            if (kind === "challenge") nonce = await issueServiceClaimChallenge(client, audience, before, body.data.device_id);
            else await consumeServiceClaimChallenge(client, audience, before, readBody.parse(body.data));
            // Same transaction: the consume cannot commit without the final
            // canonical source/target/key/revocation read and exact comparison.
            const after = await currentClaim(client, p.data.id, true);
            if (!sameServiceClaim(before, after)) throw new CreateError(409, "migration_subject_not_current");
            return kind === "challenge" ? nonce! : after;
          });
        } catch (error) {
          if (error instanceof RolloutRefused || error instanceof CreateError) return reply.code(error.status).send(apiError(error.code, "No current authenticated migration claim."));
          if (["55P03", "57014", "40P01", "40001"].includes(String((error as { code?: unknown })?.code))) return reply.code(503).send(apiError("busy", "No authenticated claim outcome."));
          throw error; // Includes unknown COMMIT: never emit claim success.
        }
      });
    }
  }
  for (const kind of ["source", "fence", "target", "claim"] as const) {
    app.route({ method: kind === "source" || kind === "claim" ? "GET" : "POST", url: `/internal/v1/next/migration/collections/:id/${kind}`,
      bodyLimit: 4096, config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      handler: async (request, reply) => {
        reply.header("cache-control", "no-store");
        const token = bearerToken(request);
        if (!token || !safeEqual(token, options.token)) return reply.code(401).send(apiError("invalid_internal_token", "The migration token is required."));
        const p = params.safeParse(request.params);
        const claimBody = kind === "claim" && ((request.headers["content-length"] ?? "0") !== "0"
          || request.headers["transfer-encoding"] !== undefined);
        if (!p.success || claimBody || !empty.safeParse(request.query).success || !empty.safeParse(request.body ?? {}).success) {
          return reply.code(400).send(apiError("invalid_request", "A canonical collection UUID and no caller-selected source facts are required."));
        }
        try {
          if (kind === "claim") return await inTransaction(options.db, client => currentClaim(client, p.data.id));
          return kind === "target" ? await target(p.data.id, options) : await action(p.data.id, kind === "fence", options);
        }
        catch (error) {
          if (error instanceof RolloutRefused) return reply.code(error.status).send(apiError(error.code, error.message));
          if (error instanceof CreateError) return reply.code(error.status).send(apiError(error.code, "No current SHADOW bootstrap outcome."));
          if (error instanceof HostedProviderResponseError || error instanceof HostedProviderUnavailableError || error instanceof z.ZodError) {
            return reply.code(503).send(apiError("migration_source_unavailable", "No verified provider outcome; retry the same collection."));
          }
          if (["55P03", "57014", "40P01", "40001"].includes(String((error as { code?: unknown })?.code))) {
            return reply.code(503).send(apiError("busy", "Busy; retry."));
          }
          throw error;
        }
      }
    });
  }
}
