// Native starter collection for an account that has moved to the next control plane.
//
// Signup reserves a starter in `account_onboarding` (UUID, template version, timezone).
// After a genuine whole-account flip, the first onboarding call here creates that
// reservation natively: a service-created cloud copy at exactly the reserved UUID,
// with the template sealed as its first content in the same idempotent creation.
// The row's existing claim and provisioned columns make it one-time:
// - before the flip, nothing is created and the caller retries;
// - an unsupported template or timezone, a legacy or foreign collection at the UUID,
//   or a reservation that changed underneath stops without a substitute;
// - provisioned is marked only after creation and content return, and a lost
//   acknowledgement re-converges on the same UUID;
// - a starter the owner deleted stays deleted.
// Content comes only from the configured port; without one the route refuses and
// creates nothing, so no empty starter is ever made.
import type { FastifyInstance, FastifyReply } from "fastify";
import type { DatabaseConnection } from "../../database-types.js";
import { isIanaTimezone } from "../../hosted.js";
import { apiError } from "../../platform/http-errors.js";
import { requireSessionContext, requireUser } from "../../platform/request-authentication.js";
import { STARTER_COLLECTION_NAME, STARTER_TEMPLATE_VERSION } from "../../starter-collection.js";
import { CreateError, currentAccount, currentSession, inTransaction, isLockTimeout } from "./bootstrap-common.js";
import { createServiceCloudCopy, type CloudCopyBootstrapOptions } from "./service-cloud-copy.js";
import { ServiceDeviceError } from "./service-devices.js";

/** Seals the starter template as a new cloud copy's first content. Idempotent per
 * collection: the same request returns the same readback; other content is refused. */
export interface StarterContentPort {
  seal(input: { collection: string; templateVersion: typeof STARTER_TEMPLATE_VERSION; timezone: string }): Promise<unknown>;
}

type NativeStarter =
  | { status: "not_scheduled" }
  | { status: "pending" }
  | { status: "ready" | "deleted"; collectionId: string; templateVersion: string; timezone: string };

interface Reservation {
  starter_collection_id: string;
  template_version: string;
  timezone: string;
  provisioned_at: Date | null;
}

/** A claim older than this may be retaken; creation is idempotent at the UUID. */
const CLAIM_LEASE = "2 minutes";

/** The account's flip is genuine and complete: next backend plus its flip record. */
async function requireFlippedAccount(client: DatabaseConnection, account: string): Promise<void> {
  const row = (await client.query<{ moved: boolean }>(
    `SELECT u.account_backend = 'next' AND f.account_id IS NOT NULL AS moved
     FROM users u LEFT JOIN next_migration_account_flips f ON f.account_id = u.id WHERE u.id = $1`, [account]
  )).rows[0];
  if (!row?.moved) throw new CreateError(409, "onboarding_not_ready");
}

async function settled(client: DatabaseConnection, account: string, row: Reservation): Promise<NativeStarter> {
  const collection = row.starter_collection_id;
  const facts = (await client.query<{ created: boolean; current: boolean; deleted: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM next_collections WHERE collection_id = $1 AND owner_user_id = $2
                      AND runtime = 'next' AND sync = 'cloud_copy') AS created,
            EXISTS (SELECT 1 FROM next_collections WHERE collection_id = $1 AND owner_user_id = $2
                      AND runtime = 'next' AND sync = 'cloud_copy' AND left_sync_at IS NULL) AS current,
            EXISTS (SELECT 1 FROM next_collection_deletion_facts WHERE collection_id = $1) AS deleted`,
    [collection, account]
  )).rows[0]!;
  const result = { collectionId: collection, templateVersion: row.template_version, timezone: row.timezone };
  if (facts.created && facts.deleted) return { status: "deleted", ...result };
  if (facts.current) return { status: "ready", ...result };
  throw new CreateError(409, "starter_unavailable");
}

async function provisionNativeStarter(
  options: CloudCopyBootstrapOptions & { starterContent?: StarterContentPort },
  account: string,
  current: (client: DatabaseConnection) => Promise<void>
): Promise<NativeStarter> {
  const principal = async (client: DatabaseConnection) => { await current(client); await requireFlippedAccount(client, account); };
  const claimed = await inTransaction(options.db, async (client): Promise<NativeStarter | Reservation> => {
    await principal(client);
    const row = (await client.query<Reservation>(
      `SELECT starter_collection_id::text, template_version, timezone, provisioned_at
       FROM account_onboarding WHERE user_id = $1 FOR UPDATE`, [account]
    )).rows[0];
    if (!row) return { status: "not_scheduled" };
    if (row.template_version !== STARTER_TEMPLATE_VERSION || !isIanaTimezone(row.timezone)) throw new CreateError(409, "starter_unavailable");
    if (row.provisioned_at) return settled(client, account, row);
    const collection = row.starter_collection_id;
    if ((await client.query("SELECT 1 FROM hosted_collections WHERE id = $1", [collection])).rows.length) throw new CreateError(409, "starter_unavailable");
    // Created, then deleted by its owner before the acknowledgement was recorded.
    if ((await client.query("SELECT 1 FROM next_collection_deletion_facts WHERE collection_id = $1", [collection])).rows.length) {
      const outcome = await settled(client, account, row);
      await client.query("UPDATE account_onboarding SET provisioned_at = now(), provisioning_started_at = NULL, updated_at = now() WHERE user_id = $1", [account]);
      return outcome;
    }
    if (!options.starterContent) throw new CreateError(503, "starter_content_unavailable");
    const claim = await client.query(
      `UPDATE account_onboarding SET provisioning_started_at = now(), updated_at = now()
       WHERE user_id = $1 AND provisioned_at IS NULL
         AND (provisioning_started_at IS NULL OR provisioning_started_at < now() - interval '${CLAIM_LEASE}')
       RETURNING 1`, [account]
    );
    return claim.rows.length ? row : { status: "pending" };
  });
  if ("status" in claimed) return claimed;

  const row = claimed, content = options.starterContent!;
  try {
    await createServiceCloudCopy(options, {
      collection: row.starter_collection_id, owner: account, runtime: "next", displayName: STARTER_COLLECTION_NAME, current: principal,
      // An unanswered seal is an unknown outcome; the same request retries it.
      initialContent: () => content.seal({ collection: row.starter_collection_id, templateVersion: STARTER_TEMPLATE_VERSION, timezone: row.timezone })
        .catch(() => { throw new CreateError(503, "not_ready"); })
    });
  } catch (error) {
    await options.db.query(
      "UPDATE account_onboarding SET provisioning_started_at = NULL, updated_at = now() WHERE user_id = $1 AND provisioned_at IS NULL", [account]
    ).catch(() => undefined);
    throw error;
  }
  return inTransaction(options.db, async client => {
    await principal(client);
    // Exactly the reservation that was claimed: any drift stops, never re-targets.
    const marked = await client.query(
      `UPDATE account_onboarding SET provisioned_at = COALESCE(provisioned_at, now()), provisioning_started_at = NULL, updated_at = now()
       WHERE user_id = $1 AND starter_collection_id = $2 AND template_version = $3 AND timezone = $4
       RETURNING provisioned_at`, [account, row.starter_collection_id, row.template_version, row.timezone]
    );
    if (!marked.rows.length) throw new CreateError(409, "starter_unavailable");
    return settled(client, account, { ...row, provisioned_at: new Date() });
  });
}

const REFUSALS: Record<string, [number, string]> = {
  account_collection_quota_exceeded: [429, "Your account has reached its synced collection limit. Delete a synced collection before setting up your starter collection."],
  onboarding_not_ready: [409, "Your account is still moving. Try again in a little while."],
  starter_unavailable: [409, "Your starter collection can't be set up automatically."],
  starter_content_unavailable: [503, "Starter collections are temporarily unavailable. Try again later."],
  migration_frozen: [409, "Your account is still moving. Try again in a little while."],
  identity_not_current: [403, "Sign in again to continue."]
};

function refuse(reply: FastifyReply, error: unknown) {
  if (error instanceof CreateError && REFUSALS[error.code]) {
    const [status, message] = REFUSALS[error.code]!;
    return reply.code(status).send(apiError(error.code, message));
  }
  if (error instanceof CreateError && error.status !== 503 || error instanceof ServiceDeviceError) {
    return reply.code(409).send(apiError("starter_unavailable", REFUSALS.starter_unavailable![1]));
  }
  if (error instanceof CreateError || isLockTimeout(error)) {
    return reply.code(503).send(apiError("not_ready", "Your starter collection isn't ready yet. Try again."));
  }
  throw error;
}

/** Not mounted by the app until the hosted starter content client is wired. */
export function registerNativeStarterRoutes(
  app: FastifyInstance,
  options: CloudCopyBootstrapOptions & { starterContent?: StarterContentPort; tailscaleAuth?: boolean }
): void {
  app.post("/v1/next/onboarding/starter-collection", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    let account: string;
    let current: (client: DatabaseConnection) => Promise<void>;
    if (options.tailscaleAuth) {
      const user = await requireUser(request, reply, options.db, true);
      if (!user) return reply;
      account = user.id;
      current = (client) => currentAccount(client, user.id);
    } else {
      const context = await requireSessionContext(request, reply, options.db);
      if (!context) return reply;
      account = context.user.id;
      current = (client) => currentSession(client, context.sessionId, context.user.id);
    }
    try {
      const result = await provisionNativeStarter(options, account, current);
      if (result.status === "not_scheduled") {
        return reply.code(404).send(apiError("onboarding_not_scheduled", "No starter collection is waiting for this account."));
      }
      if (result.status === "pending") return reply.code(202).send({ status: "pending" });
      return { status: result.status, collection_id: result.collectionId, template_version: result.templateVersion, timezone: result.timezone };
    } catch (error) {
      return refuse(reply, error);
    }
  });
}
