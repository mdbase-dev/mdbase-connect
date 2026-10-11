// Where an app connects for a collection (mdbase-next replica-client-api §12.3;
// sdk interface note 2026-10-04-sdk-relay-pipe-and-local-only.md §1).
//
// `GET /v1/next/collections/:id/route` with the app's access token returns the targets
// the app may open a Noise session to: the daemon serving a local collection, or the
// enrolled desktops of a Private collection, through the relay; the hosted replica of a
// cloud-copy collection directly. Only grants with a registered client key are routed:
// without one, the daemon has nothing to authenticate the app against. `availability`
// says whether the app can open the collection now, and if not, why.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RegisteredDeviceKind } from "./policy-wire.js";
import type { DatabaseQueryable } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { bearerToken } from "../../platform/request-authentication.js";
import { tokenHash } from "../../security.js";
import { RelayBrokerUnavailableError, type RelayBroker } from "../../relay-broker.js";
import { hostedClientOrigin, hostedRouteTarget, type RouteTarget } from "./hosted-route-target.js";
export type { RouteTarget } from "./hosted-route-target.js";
import { pitrCollection, type LabPitrConfig } from "./lab-pitr-config.js";
import { grantDeviceApproval } from "./grant-approval.js";
import { nativeDevices, nativeGrant, nativeGrantStanding, supersededLegacyGrant } from "./native-grant-target.js";
import { CreateError, currentMember } from "./bootstrap-common.js";

/** Whether the app can open the collection now and, if not, why (SDK describeError reasons). */
export type RouteAvailability =
  | { state: "available" }
  | { state: "unavailable"; reason: "device_offline" | "desktop_update_required" | "old_connector_running" | "approval_required" | "sync_required" | "access_removed" | "no_device_registered" };

const routeGrant = (collection: string, row: { grant_id: string; authorization_grant: string }) => ({
  collection, grant: row.grant_id,
  ...(row.authorization_grant && row.authorization_grant !== row.grant_id ? { authorization_grant: row.authorization_grant } : {})
});
const unavailableRoute = (collection: string, row: { grant_id: string; authorization_grant: string }, reason: "sync_required" | "access_removed") =>
  ({ ...routeGrant(collection, row), targets: [] as RouteTarget[], availability: { state: "unavailable", reason } satisfies RouteAvailability });

type RouteDevice = { device_id: string; kind: RegisteredDeviceKind; noise_pk: Buffer; connector_id: string; relay_generation: string; last_active_ms: number | null; update_required: boolean; local_id: string };
type Candidate = { value: RouteTarget; serving: boolean; oldConnectorRunning: boolean; updateRequired: boolean; lastActive: number };

/** Presence of each device from the relay owner, sorted serving first. */
async function deviceCandidates(broker: Pick<RelayBroker, "request">, devices: readonly RouteDevice[], url: string): Promise<Candidate[]> {
  const candidates = await Promise.all(devices.map(async (target) => {
    let online = false;
    let oldConnectorRunning = false;
    try {
      // Ask the actual owner, not this HTTP instance's local socket map or a
      // recent policy ACK. No daemon operation, policy push, or pipe is opened.
      const presence = await broker.request(target.connector_id, String(target.relay_generation),
        { version: 1, kind: "device_presence", message: { device_id: target.device_id } }, 1_000);
      online = presence.ok && presence.value === true;
      oldConnectorRunning = online && presence.ok && presence.detail?.old_connector_running === true;
    } catch (error) {
      if (!(error instanceof RelayBrokerUnavailableError)) throw error;
    }
    const value: RouteTarget = { kind: target.kind, device: target.device_id, noise_pk: target.noise_pk.toString("hex"), url, online, relay_collection: target.local_id };
    return { value, serving: online && !oldConnectorRunning, oldConnectorRunning, updateRequired: !online && target.update_required, lastActive: target.last_active_ms ?? Number.NEGATIVE_INFINITY };
  }));
  // Serving first, then online, then desktop/CLI daemons before other kinds, then
  // latest activity. UUID is the stable final tie-breaker. Current local authority
  // is bound 1:1 to a connector/device, including per-installation app devices.
  const daemonRank = (kind: RouteTarget["kind"]) => kind === "desktop" || kind === "cli" ? 0 : 1;
  return candidates.sort((a, b) => Number(b.serving) - Number(a.serving)
    || Number(b.value.online) - Number(a.value.online)
    || daemonRank(a.value.kind) - daemonRank(b.value.kind)
    || b.lastActive - a.lastActive
    || a.value.device.localeCompare(b.value.device));
}

/** Why the app can or cannot open the collection through these devices now. */
async function deviceAvailability(db: DatabaseQueryable, candidates: readonly Candidate[], authorizationGrant: string): Promise<RouteAvailability> {
  if (candidates.length === 0) return { state: "unavailable", reason: "no_device_registered" };
  // Private collections: the replica admits the app only after a device approves the grant.
  const approval = await grantDeviceApproval(db, authorizationGrant);
  if (approval.required && !approval.approved) return { state: "unavailable", reason: "approval_required" };
  if (candidates.some((candidate) => candidate.serving)) return { state: "available" };
  if (candidates.some((candidate) => candidate.oldConnectorRunning)) return { state: "unavailable", reason: "old_connector_running" };
  if (candidates.some((candidate) => candidate.updateRequired)) return { state: "unavailable", reason: "desktop_update_required" };
  return { state: "unavailable", reason: "device_offline" };
}

export function registerNextRouteRoutes(app: FastifyInstance, options: { db: DatabaseQueryable; publicUrl: string; broker: Pick<RelayBroker, "request">; hostedClientUrl?: string; labPitr?: LabPitrConfig }): void {
  const hostedOrigin = options.hostedClientUrl ? hostedClientOrigin(options.hostedClientUrl) : undefined;
  // Always `wss:`, except for a loopback development server (SDK request).
  const relayUrl = new URL("/v1/next/relay/client", options.publicUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(relayUrl.hostname);
  relayUrl.protocol = relayUrl.protocol === "http:" && loopback ? "ws:" : "wss:";
  app.get("/v1/next/collections/:id/route", {
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const token = bearerToken(request);
    if (!token) return reply.code(401).send(apiError("invalid_token", "Bearer token required."));
    const origin = pitrCollection(options.labPitr, id) ? options.labPitr!.hostedUrl : hostedOrigin;
    const hosted = origin ? await hostedRouteTarget(options.db, tokenHash(token), id, origin) : null;
    const hash = tokenHash(token);
    const grant = await options.db.query<{ grant_id: string; authorization_grant: string; policy_required: boolean; policy_active: boolean; has_client_key: boolean; device_id: string | null; kind: RegisteredDeviceKind | null; noise_pk: Buffer | null; local_id: string; connector_id: string; relay_generation: string; last_active_ms: number | null; update_required: boolean }>(
      `SELECT COALESCE(binding.log_grant_id, g.id) AS grant_id, g.id AS authorization_grant,
              (nc.runtime = 'next') AS policy_required, COALESCE(binding.active, false) AS policy_active,
              (k.grant_id IS NOT NULL) AS has_client_key,
              d.id AS device_id, d.kind, d.noise_pk, col.local_id,
              c.id AS connector_id, c.relay_generation,
              (extract(epoch FROM c.last_seen_at) * 1000)::double precision AS last_active_ms,
              (c.incompatibility_code IS NOT NULL) AS update_required
       FROM access_tokens tok
       JOIN grants g ON g.id = tok.grant_id
       JOIN users u ON u.id = g.user_id
       JOIN collections col ON col.id = g.collection_id
       JOIN connectors c ON c.id = col.connector_id AND c.revoked_at IS NULL
       LEFT JOIN next_grant_client_keys k ON k.grant_id = g.id
       LEFT JOIN next_collections nc ON nc.collection_id = col.local_id
       LEFT JOIN next_grant_bindings binding ON binding.grant_id = g.id
       -- SEC-047: only a device of the account that granted the app.
       LEFT JOIN next_devices d ON d.connector_id = c.id AND d.user_id = g.user_id
       WHERE tok.token_hash = $1 AND tok.expires_at > now() AND tok.revoked_at IS NULL
         AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
         AND u.suspended_at IS NULL
         AND col.local_id = $2 AND col.enabled = true
         AND col.present = true AND col.authority_state = 'active'`,
      [hash, id]
    );
    // A Private native collection: the grant targets the collection itself and is
    // served by the granting account's enrolled desktop/CLI devices.
    const native = grant.rows[0] || hosted?.grant ? null : await nativeGrant(options.db, hash, id);
    const row = grant.rows[0] ?? hosted?.grant ?? (native ? { ...native, policy_required: true } : undefined);
    if (!row) {
      // Taken over by a native collection: the app must be set up again for it.
      const superseded = await supersededLegacyGrant(options.db, hash, id);
      if (superseded) return unavailableRoute(id, superseded, "sync_required");
      return reply.code(401).send(apiError("invalid_token", "Access token is invalid or expired for this collection."));
    }
    if (!row.has_client_key) {
      // The binding's authorization ID lets a client that still holds the grant
      // signing key attach a key (POST /v1/next/grants/client-key).
      const binding = (await options.db.query<{ authorization_id: string | null }>(
        "SELECT application_authorization->'binding'->>'authorization_id' AS authorization_id FROM grants WHERE id = $1",
        [row.authorization_grant]
      )).rows[0];
      return reply.code(409).send(apiError("client_key_required", "This grant has no registered Noise key; authorize the app again to register one.", {
        grant_id: row.authorization_grant,
        ...(binding?.authorization_id ? { authorization_id: binding.authorization_id } : {})
      }));
    }
    if (row.policy_required && !row.policy_active) {
      return reply.code(409).send(apiError("application_reauthorization_required", "This grant has no next policy binding; authorize the application again."));
    }
    if (native) {
      const standing = await nativeGrantStanding(options.db, id, native.user_id);
      if (standing !== "current") return unavailableRoute(id, native, standing);
    }
    const devices = native
      ? (await nativeDevices(options.db, id, native.user_id)).map((device) => ({ ...device, local_id: id }))
      : grant.rows.flatMap((target) => target.device_id && target.noise_pk && target.kind
        ? [{ ...target, device_id: target.device_id, noise_pk: target.noise_pk, kind: target.kind }] : []);
    const candidates = await deviceCandidates(options.broker, devices, relayUrl.toString());
    const targets = candidates.map(({ value }) => value);
    // Preferred direct target, never an assertion of serving readiness. Daemon
    // ordering/fallbacks below it are unchanged.
    if (hosted?.target) targets.unshift(hosted.target);
    const availability: RouteAvailability = hosted?.target ? { state: "available" }
      : await deviceAvailability(options.db, candidates, row.authorization_grant);
    return { ...routeGrant(id, row), targets, availability, ...(targets.length === 0 ? { reason: "no_device_registered" } : {}) };
  });

  // C2: the collections this app installation may switch between, one entry per active
  // grant of the same user and installation. A grant is `routable` when it has a
  // registered Noise key (otherwise it works only through the old envelope). Private
  // native grants and grants superseded by a native collection carry `availability`.
  app.get("/v1/next/apps/collections", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const token = bearerToken(request);
    if (!token) return reply.code(401).send(apiError("invalid_token", "Bearer token required."));
    const caller = await options.db.query<{ user_id: string; application_id: string; installation: string }>(
      `SELECT g.user_id, g.application_id, g.application_installation_id AS installation
       FROM access_tokens tok JOIN grants g ON g.id = tok.grant_id JOIN users u ON u.id = g.user_id
       WHERE tok.token_hash = $1 AND tok.expires_at > now() AND tok.revoked_at IS NULL
         AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL AND u.suspended_at IS NULL`,
      [tokenHash(token)]
    );
    const self = caller.rows[0];
    if (!self) return reply.code(401).send(apiError("invalid_token", "Access token is invalid or expired."));
    const grants = await options.db.query<{
      grant_id: string; authorization_grant: string; collection: string; display_name: string; operations: string[];
      sync: "private" | "cloud_copy" | null; routable: boolean; native: boolean; superseded: boolean;
    }>(
      `SELECT COALESCE(binding.log_grant_id, g.id) AS grant_id, g.id AS authorization_grant,
              COALESCE(col.local_id::text, hc.id::text, g.next_collection_id::text) AS collection,
              CASE WHEN nc.runtime='next' AND nc.sync IN ('cloud_copy','private') AND nc.left_sync_at IS NULL THEN COALESCE(nc.display_name,'New collection')
                   ELSE COALESCE(col.display_name, hc.display_name, nc.display_name) END AS display_name, g.operations,
              nc.sync, (k.grant_id IS NOT NULL AND (nc.runtime IS DISTINCT FROM 'next' OR binding.active = true)) AS routable,
              (g.next_collection_id IS NOT NULL) AS native,
              (g.collection_id IS NOT NULL AND col.authority_state = 'retired') AS superseded
       FROM grants g
       LEFT JOIN collections col ON col.id = g.collection_id
       LEFT JOIN hosted_collections hc ON hc.id = g.hosted_collection_id
       LEFT JOIN next_collections nc ON nc.collection_id::text = COALESCE(col.local_id::text, hc.id::text, g.next_collection_id::text)
       LEFT JOIN next_grant_client_keys k ON k.grant_id = g.id
       LEFT JOIN next_grant_bindings binding ON binding.grant_id = g.id
       WHERE g.user_id = $1 AND g.application_id = $2 AND g.application_installation_id = $3
         AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
         -- A legacy collection taken over by a native one stays listed: it needs setting up again.
         AND (g.collection_id IS NULL OR (col.enabled = true AND col.present = true AND col.authority_state = 'active')
           OR (col.present = true AND col.authority_state = 'retired' AND nc.runtime = 'next'))
         AND (g.hosted_collection_id IS NULL OR (hc.authority_state = 'active' AND hc.quarantined_at IS NULL))
       ORDER BY display_name, g.id`,
      [self.user_id, self.application_id, self.installation]
    );
    // A collection set up again natively is listed once, by its native grant.
    const nativeCollections = new Set(grants.rows.filter((row) => row.native).map((row) => row.collection));
    const rows = grants.rows.filter((row) => !row.superseded || !nativeCollections.has(row.collection));
    const collections = await Promise.all(rows.map(async (row) => {
      let availability: RouteAvailability | undefined;
      let role: string | null = null;
      if (row.superseded) availability = { state: "unavailable", reason: "sync_required" };
      else if (row.native && row.routable) {
        const standing = await nativeGrantStanding(options.db, row.collection, self.user_id);
        // Display and UI gating only; every action is still checked where it lands.
        if (standing === "current") {
          role = await currentMember(options.db, row.collection, self.user_id).catch((error: unknown) => {
            if (error instanceof CreateError) return null; // left between the two reads: omit
            throw error;
          });
        }
        availability = standing === "current"
          ? await deviceAvailability(options.db, await deviceCandidates(options.broker,
            (await nativeDevices(options.db, row.collection, self.user_id)).map((device) => ({ ...device, local_id: row.collection })),
            relayUrl.toString()), row.authorization_grant)
          : { state: "unavailable", reason: standing };
      }
      return {
        collection: row.collection,
        name: row.display_name,
        grant: row.grant_id,
        ...(row.authorization_grant !== row.grant_id ? { authorization_grant: row.authorization_grant } : {}),
        state: row.sync === "cloud_copy" ? "synced" : row.sync === "private" ? "synced_e2e" : "local",
        operations: row.operations,
        routable: row.routable && !row.superseded,
        ...(availability ? { availability } : {}),
        ...(role === "owner" || role === "editor" || role === "viewer" ? { role } : {})
      };
    }));
    return { collections };
  });
}
