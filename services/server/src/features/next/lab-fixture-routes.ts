// Privileged LAB fixture provisioning, not a browser/admin backdoor. Registered
// keys and account identity come from ordinary connector authentication. Only
// explicit, bounded disposable fixture IDs are ever touched or returned.
import { verify } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DatabaseConnection, DatabasePool, DatabaseQueryable } from "../../database-types.js";
import { safeEqual } from "../../security.js";
import { apiError } from "../../platform/http-errors.js";
import { requireConnector } from "../../platform/request-authentication.js";
import { validateLabFixtureConfig, type LabFixtureConfig } from "./lab-fixture-config.js";
import { LogServiceClient, LogServiceError, LOG_TOKEN_LIFETIME_MS } from "./log-service-client.js";
import { ed25519PublicKeyObject, loadPolicySigner, type NextControlPlaneConfig } from "./policy-keys.js";
import { PolicyEmitter, registerNextCollection } from "./policy-outbox.js";
import { domainHash, encodeCbor, uuidBytes, type RegisteredDeviceKind } from "./policy-wire.js";

const TTL_MS = 2 * 60 * 60_000;
interface Proof { fixture_id: string; device_id: string; challenge: string; sig: string; label?: string }
interface Device { sign_pk: Buffer; kem_pk: Buffer; noise_pk: Buffer; kind: RegisteredDeviceKind }
interface Fixture { owner_user_id: string; connector_id: string; device_id: string; label: string; expires_at: Date; deleting_at: Date | null; deleted_at: Date | null }
class FixtureError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function labFixtureDigest(input: { challenge: Uint8Array; connector: string; device: string; fixture: string; action: "provision" | "delete" }): Uint8Array {
  return domainHash("mdbase/v1/lab-fixture", encodeCbor([input.challenge, uuidBytes(input.connector), uuidBytes(input.device), uuidBytes(input.fixture), input.action]));
}

async function authenticateProof(client: DatabaseConnection, body: Proof, connector: { id: string; user_id: string }, action: "provision" | "delete"): Promise<Device> {
  const devices = await client.query<Device>(
    "SELECT sign_pk, kem_pk, noise_pk, kind FROM next_devices WHERE id = $1 AND connector_id = $2 AND user_id = $3",
    [body.device_id, connector.id, connector.user_id]
  );
  const device = devices.rows[0];
  const challenge = Buffer.from(body.challenge, "hex");
  if (!device || !verify(null, labFixtureDigest({ challenge, connector: connector.id, device: body.device_id, fixture: body.fixture_id, action }), ed25519PublicKeyObject(device.sign_pk), Buffer.from(body.sig, "hex"))) {
    throw new FixtureError(403, "invalid_fixture_proof");
  }
  const used = await client.query(
    "UPDATE next_device_challenges SET used_at = now() WHERE challenge = $1 AND connector_id = $2 AND used_at IS NULL AND expires_at > now()",
    [challenge, connector.id]
  );
  if (used.rowCount !== 1) throw new FixtureError(403, "invalid_fixture_proof");
  return device;
}

interface Genesis { id: string; item: Buffer; state: string }
async function fixtureGenesis(db: DatabaseQueryable, fixture: string): Promise<Genesis> {
  const result = await db.query<Genesis>("SELECT id, item, state FROM next_policy_batches WHERE collection_id = $1 AND seq = 1 ORDER BY id LIMIT 1", [fixture]);
  if (!result.rows[0]) throw new FixtureError(503, "fixture_not_ready");
  return result.rows[0];
}

/** Local reservation is not ownership. Only exact external genesis bytes prove it. */
async function verifyFixtureGenesis(log: LogServiceClient, fixture: string, genesis: Genesis, deleting = false): Promise<boolean> {
  let external: Uint8Array | null;
  try { external = await log.controlItemAt(fixture, 1); } catch (error) {
    // A confirmed absent log needs no privileged deletion. Retained acknowledgement
    // permits local-only completion of a previously committed, unknown deletion.
    if (deleting && genesis.state === "appended" && error instanceof LogServiceError && error.code === "not_found") return false;
    throw error;
  }
  if (!external || !genesis.item.equals(Buffer.from(external))) throw new FixtureError(503, "fixture_not_ready");
  return true;
}

export function registerLabFixtureRoutes(app: FastifyInstance, options: {
  db: DatabasePool; config: LabFixtureConfig; next: NextControlPlaneConfig;
  environment?: string; publicUrl: string; emitter: PolicyEmitter; log?: LogServiceClient
}): void {
  validateLabFixtureConfig(options.config, options.environment, options.publicUrl);
  loadPolicySigner(options.next, Date.now());
  const log = options.log ?? new LogServiceClient(options.next.logService);
  const rootKeyId = Buffer.from(options.next.policyCert.root_key_id, "hex");
  const common = {
    fixture_id: { type: "string", format: "uuid" }, device_id: { type: "string", format: "uuid" },
    challenge: { type: "string", pattern: "^[0-9a-f]{64}$" }, sig: { type: "string", pattern: "^[0-9a-f]{128}$" }
  };
  for (const action of ["provision", "delete"] as const) {
    app.post<{ Body: Proof }>(`/internal/v1/next/lab/fixtures/${action}`, {
      bodyLimit: 4096,
      config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
      schema: { body: {
        type: "object", additionalProperties: false,
        required: ["fixture_id", "device_id", "challenge", "sig", ...(action === "provision" ? ["label"] : [])],
        properties: { ...common, ...(action === "provision" ? { label: { type: "string", pattern: "^\\[test\\] [A-Za-z0-9 _.-]{1,80}$" } } : {}) }
      } }
    }, async (request, reply) => {
      reply.header("cache-control", "no-store");
      // Recheck the hard boundary even when routes are called through composition.
      validateLabFixtureConfig(options.config, options.environment, options.publicUrl);
      const admin = request.headers["x-mdbase-lab-admin"];
      if (typeof admin !== "string" || !safeEqual(admin, options.config.adminToken)
        || request.headers.authorization === `Bearer ${admin}`) {
        return reply.code(403).send(apiError("fixture_admin_required", "LAB fixture authorization required."));
      }
      const connector = await requireConnector(request, reply, options.db);
      if (!connector) return reply;
      // UUID bytes and PostgreSQL UUID values are canonical; text lock keys and
      // identity comparisons must use that same representation before any work.
      const body = { ...request.body, fixture_id: request.body.fixture_id.toLowerCase(), device_id: request.body.device_id.toLowerCase() };
      const client = await options.db.connect();
      let device: Device;
      let expiry: Date;
      let alreadyDeleted = false;
      try {
        await client.query("BEGIN");
        // Global fixture quota/identity lock. No network operation holds this lock.
        await client.query("SELECT pg_advisory_xact_lock(20261004, 46)");
        device = await authenticateProof(client, body, connector, action);
        const existing = await client.query<Fixture>("SELECT owner_user_id, connector_id, device_id, label, expires_at, deleting_at, deleted_at FROM next_lab_fixtures WHERE fixture_id = $1 FOR UPDATE", [body.fixture_id]);
        const fixture = existing.rows[0];
        if (fixture && (fixture.owner_user_id !== connector.user_id || fixture.connector_id !== connector.id || fixture.device_id !== body.device_id)) {
          throw new FixtureError(404, "fixture_not_found");
        }
        if (action === "provision") {
          if (fixture) {
            if (fixture.label !== body.label || fixture.deleted_at || fixture.deleting_at || fixture.expires_at.getTime() <= Date.now()) throw new FixtureError(409, "fixture_specification_changed");
            expiry = fixture.expires_at;
          } else {
            const counts = await client.query<{ total: string; owned: string }>(
              "SELECT count(*) AS total, count(*) FILTER (WHERE owner_user_id = $1) AS owned FROM next_lab_fixtures WHERE deleted_at IS NULL", [connector.user_id]
            );
            if (Number(counts.rows[0]!.total) >= 10 || Number(counts.rows[0]!.owned) >= 2) throw new FixtureError(429, "fixture_quota");
            const collision = await client.query("SELECT 1 FROM next_collections WHERE collection_id = $1", [body.fixture_id]);
            if (collision.rows.length) throw new FixtureError(409, "fixture_specification_changed");
            expiry = new Date(Date.now() + TTL_MS);
            await client.query("INSERT INTO next_lab_fixtures(fixture_id,owner_user_id,connector_id,device_id,label,expires_at) VALUES($1,$2,$3,$4,$5,$6)", [body.fixture_id, connector.user_id, connector.id, body.device_id, body.label, expiry]);
            await registerNextCollection(client, {
              collectionId: body.fixture_id, ownerUserId: connector.user_id, runtime: "next", sync: "private", rootKeyId,
              ops: [
                { op: "genesis", owner: connector.user_id, root: rootKeyId, state: "e2e" },
                { op: "member-set", account: connector.user_id, role: "owner" },
                { op: "device-enrol", device: body.device_id, account: connector.user_id, kind: device.kind, signPublicKey: device.sign_pk, kemPublicKey: device.kem_pk, noisePublicKey: device.noise_pk }
              ]
            });
          }
        } else {
          if (!fixture) throw new FixtureError(404, "fixture_not_found");
          alreadyDeleted = Boolean(fixture.deleted_at);
          expiry = fixture.expires_at;
          await client.query("UPDATE next_lab_fixtures SET deleting_at = COALESCE(deleting_at, now()) WHERE fixture_id = $1", [body.fixture_id]);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (error instanceof FixtureError) return reply.code(error.status).send(apiError(error.code, "LAB fixture request refused."));
        throw error;
      } finally {
        client.release();
      }
      // A failed/unknown service call retains the exact ownership ledger and
      // outbox bytes for a fresh-proof retry. Never mint for an unverified fixture.
      try {
        if (action === "delete") {
          if (!alreadyDeleted) {
            const cleanup = await options.db.connect();
            try {
              await cleanup.query("BEGIN");
              // Same lock domain as policy emission/recovery (#602); deleting the
              // log and its outbox cannot race an in-flight genesis append.
              await cleanup.query("SET LOCAL lock_timeout = '5s'");
              await cleanup.query("SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text, 20261004))", [body.fixture_id]);
              const genesis = await fixtureGenesis(cleanup, body.fixture_id);
              if (await verifyFixtureGenesis(log, body.fixture_id, genesis, true)) {
                // Exact-position read confirms a previously unknown create commit.
                // Persist that existing acknowledgement BEFORE delete: if delete
                // commits but its response is lost, retry can finish local cleanup
                // on confirmed not_found, never by deleting an unverified object.
                if (genesis.state !== "appended") await options.db.query("UPDATE next_policy_batches SET state = 'appended', appended_at = COALESCE(appended_at, now()), error = NULL WHERE id = $1", [genesis.id]);
                try { await log.deleteLog(body.fixture_id); } catch (error) {
                  if (!(error instanceof LogServiceError) || error.code !== "not_found") throw error;
                }
              }
              await cleanup.query("DELETE FROM next_collections WHERE collection_id = $1 AND owner_user_id = $2", [body.fixture_id, connector.user_id]);
              await cleanup.query("UPDATE next_lab_fixtures SET deleted_at = now() WHERE fixture_id = $1", [body.fixture_id]);
              await cleanup.query("COMMIT");
            } catch (error) { await cleanup.query("ROLLBACK").catch(() => undefined); throw error; } finally { cleanup.release(); }
          }
          return reply.code(204).send();
        }
        await options.emitter.drainCollection(body.fixture_id);
        const genesis = await fixtureGenesis(options.db, body.fixture_id);
        if (genesis.state !== "appended") throw new FixtureError(503, "fixture_not_ready");
        await verifyFixtureGenesis(log, body.fixture_id, genesis);
        await log.setQuota(body.fixture_id, { storageBytes: 16 * 1024 * 1024, itemsPerSecond: 5, bytesPerSecond: 256 * 1024, burstItems: 10 });
        const head = await log.head(body.fixture_id);
        const ready = await options.db.query(
          `UPDATE next_lab_fixtures SET ready_at = now() WHERE fixture_id = $1
           AND deleting_at IS NULL AND deleted_at IS NULL AND expires_at > now()
           AND EXISTS (SELECT 1 FROM connectors c JOIN users u ON u.id = c.user_id
                       WHERE c.id = $2 AND c.revoked_at IS NULL AND u.suspended_at IS NULL)`, [body.fixture_id, connector.id]
        );
        if (ready.rowCount !== 1) throw new FixtureError(409, "fixture_not_ready");
        const expiresAt = Math.min(Date.now() + LOG_TOKEN_LIFETIME_MS, expiry!.getTime());
        return {
          fixture_id: body.fixture_id, collection: body.fixture_id, owner_account: connector.user_id, state: "e2e",
          log_url: options.next.logService.url, head: { seq: head.seq, chain: Buffer.from(head.chain).toString("hex") },
          root_public_key: Buffer.from(options.next.rootPublicKey).toString("hex"), policy_cert: options.next.policyCert,
          genesis: { seq: 1, item: genesis.item.toString("hex") },
          device: { device_id: body.device_id, sign_pk: device!.sign_pk.toString("hex"), kem_pk: device!.kem_pk.toString("hex"), noise_pk: device!.noise_pk.toString("hex"), token: log.mintToken({ device: body.device_id, signPublicKey: device!.sign_pk, collection: body.fixture_id, expiresAt }), expires_at: expiresAt }
        };
      } catch {
        return reply.code(503).send(apiError("fixture_not_ready", "LAB fixture outcome is not verified; retain the fixture ID and retry with a fresh proof."));
      }
    });
  }
}
