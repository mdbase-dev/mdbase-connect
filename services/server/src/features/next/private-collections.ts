// Private (end-to-end) collections on the next control plane. Mounted only with
// MDBASE_NEXT_PRIVATE_BOOTSTRAP=1.
//
// - Create (`POST /v1/next/collections/private`): an owner's registered device creates
//   it. Genesis is e2e, sets the owner and enrols that device only. No service device
//   is ever enrolled. The device's own initial rekey keys the collection.
// - Device enrol (`POST /v1/next/collections/:id/private/devices`): a registered device
//   of a current member account is enrolled, carrying its SAS commitment
//   (`device-enrol` key 7). It holds no key until an existing keyed device approves it
//   (SAS commit-then-reveal) and appends a `key_grant`.
// - Approval request (`POST /v1/next/collections/:id/private/devices/approval-request`):
//   an enrolled device asks, with its own signature, for a fresh SAS commitment; the
//   control plane appends the CP-signed `approval-request` (op 13: device and
//   commitment only, no enrolment or keys). The replica applies it only for an
//   active, unkeyed user device.
//
// The control plane never approves, never grants and never holds a collection key. It
// enrols with its policy key and mints log credentials, nothing more.
import type { FastifyInstance } from "fastify";
import type { DatabaseConnection, DatabasePool } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { requireConnector } from "../../platform/request-authentication.js";
import {
  authenticate, CreateError, currentIdentity, currentMember, ENROLMENT, enrolmentKey, enrolOp, exactEnrolment, inTransaction, lock, NIL,
  refuse, refuseRevoked, type Device, type Proof
} from "./bootstrap-common.js";
import { LOG_TOKEN_LIFETIME_MS, type LogServiceClient } from "./log-service-client.js";
import type { NextControlPlaneConfig } from "./policy-keys.js";
import { queueNextPolicy, registerNextCollection, type PolicyEmitter } from "./policy-outbox.js";
import { domainHash, encodeCbor, uuidBytes } from "./policy-wire.js";

/** `H("mdbase/v1/private-create", cbor[challenge, connector, device, collection])`, signed by the owner's device. */
export function privateCreateDigest(input: { challenge: Uint8Array; connector: string; device: string; collection: string }): Uint8Array {
  return domainHash("mdbase/v1/private-create", encodeCbor([input.challenge, uuidBytes(input.connector), uuidBytes(input.device), uuidBytes(input.collection)]));
}

/** `H("mdbase/v1/private-device-enrol", cbor[challenge, connector, device, collection, sas_commit])`, signed by the enrolling device. */
export function privateDeviceEnrolDigest(input: { challenge: Uint8Array; connector: string; device: string; collection: string; sasCommit: Uint8Array }): Uint8Array {
  return domainHash("mdbase/v1/private-device-enrol", encodeCbor([
    input.challenge, uuidBytes(input.connector), uuidBytes(input.device), uuidBytes(input.collection), input.sasCommit
  ]));
}

/** `H("mdbase/v1/private-approval-request", cbor[challenge, connector, device, collection, sas_commit])`, signed by the enrolled device. */
export function privateApprovalRequestDigest(input: { challenge: Uint8Array; connector: string; device: string; collection: string; sasCommit: Uint8Array }): Uint8Array {
  return domainHash("mdbase/v1/private-approval-request", encodeCbor([
    input.challenge, uuidBytes(input.connector), uuidBytes(input.device), uuidBytes(input.collection), input.sasCommit
  ]));
}

/**
 * This device's latest approval request (outbox order, then op order), with its
 * batch: the only one a retry may reuse. One row at most, projected in SQL.
 */
const LATEST_APPROVAL_REQUEST = `SELECT e.value->'sasCommit'->>'$hex' AS commit, b.seq, b.item, b.state
  FROM next_policy_outbox o
  LEFT JOIN next_policy_batches b ON b.id = o.batch_id
  CROSS JOIN LATERAL jsonb_array_elements(o.ops->'ops') WITH ORDINALITY AS e(value, ord)
  WHERE o.collection_id = $1 AND o.ops->'ops' @> $2::jsonb
    AND e.value->>'op' = 'approval-request' AND e.value->>'device' = $3
  ORDER BY o.id DESC, e.ord DESC LIMIT 1`;
/** Any earlier commitment of this device: its enrolment's or a previous request's. */
const EARLIER_COMMITMENT = `SELECT 1 FROM next_policy_outbox o
  WHERE o.collection_id = $1 AND (o.ops->'ops' @> $2::jsonb OR o.ops->'ops' @> $3::jsonb) LIMIT 1`;
type LatestRequest = { commit: string; seq: string | null; item: Buffer | null; state: string | null };
const latestRequest = async (client: { query: DatabaseConnection["query"] }, collection: string, device: string) =>
  (await client.query<LatestRequest>(LATEST_APPROVAL_REQUEST, [collection, JSON.stringify([{ op: "approval-request", device }]), device])).rows[0];

/** Whether the collection already exists: false when free, true when this owner's private collection, else refused. */
async function existing(client: DatabaseConnection, collection: string, owner: string): Promise<boolean> {
  const row = (await client.query<{ owner_user_id: string; sync: string; runtime: string; left: boolean }>(
    "SELECT owner_user_id, sync, runtime, left_sync_at IS NOT NULL AS left FROM next_collections WHERE collection_id = $1 FOR UPDATE", [collection]
  )).rows[0];
  if (row && (row.owner_user_id !== owner || row.sync !== "private" || row.runtime !== "next" || row.left)) throw new CreateError(409, "collection_exists");
  if (!row) {
    // A local collection with this logical ID that belongs to someone else is never adopted.
    const other = await client.query("SELECT 1 FROM collections WHERE local_id = $1 AND user_id <> $2 AND removed_at IS NULL", [collection, owner]);
    if (other.rows.length) throw new CreateError(409, "collection_exists");
  }
  return Boolean(row);
}

/** A current private collection on the next runtime (any owner); share-locked until the transaction ends. */
async function currentPrivate(client: DatabaseConnection, collection: string, owner?: string): Promise<void> {
  const current = await client.query(
    `SELECT 1 FROM next_collections WHERE collection_id = $1 AND sync = 'private' AND runtime = 'next' AND left_sync_at IS NULL
       AND ($2::uuid IS NULL OR owner_user_id = $2) FOR SHARE`,
    [collection, owner ?? null]
  );
  if (!current.rows.length) throw new CreateError(409, "not_current_private");
}

/** The enrolment tuple including the SAS commitment. */
const exactPrivateEnrolment = (device: string, account: string, d: Device, sasCommit: Buffer) => {
  const [op] = JSON.parse(exactEnrolment(device, account, d)) as Array<Record<string, unknown>>;
  return JSON.stringify([{ ...op, sasCommit: { $hex: sasCommit.toString("hex") } }]);
};

export function registerPrivateCollectionRoutes(app: FastifyInstance, options: {
  db: DatabasePool; next: NextControlPlaneConfig; emitter: PolicyEmitter;
  log: Pick<LogServiceClient, "controlItemAt" | "head" | "mintToken">; now?: () => number;
}): void {
  if (!options.next.privateBootstrap) throw new Error("private collection routes need MDBASE_NEXT_PRIVATE_BOOTSTRAP=1");
  const rootKeyId = Buffer.from(options.next.policyCert.root_key_id, "hex");
  const uuid = { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" };
  const proof = { device_id: uuid, challenge: { type: "string", pattern: "^[0-9a-f]{64}$" }, sig: { type: "string", pattern: "^[0-9a-f]{128}$" } };
  const limited = { bodyLimit: 4096, config: { rateLimit: { max: 6, timeWindow: "1 minute" } } };

  /** The exact bytes of a policy batch, as the log returns them at its position. */
  async function appendedBatch(collection: string, batch: { seq: string | number | null; item: Buffer | null; state: string | null } | undefined) {
    const seq = batch?.seq === null || batch?.seq === undefined ? null : Number(batch.seq);
    const external = seq !== null && batch?.state === "appended" ? await options.log.controlItemAt(collection, seq) : null;
    if (seq === null || !batch?.item || !external || !batch.item.equals(Buffer.from(external))) throw new CreateError(503, "not_ready");
    return { seq, item: batch.item };
  }

  const mint = (device: string, signPk: Buffer, collection: string) => {
    const expiresAt = (options.now ?? Date.now)() + LOG_TOKEN_LIFETIME_MS;
    return { device_id: device, token: options.log.mintToken({ device, signPublicKey: signPk, collection, expiresAt }), expires_at: expiresAt };
  };

  // ---- Create: a registered device of the owner. ----
  app.post<{ Body: Proof & { collection_id: string } }>("/v1/next/collections/private", {
    ...limited,
    schema: { body: {
      type: "object", additionalProperties: false, required: ["collection_id", "device_id", "challenge", "sig"],
      properties: { collection_id: uuid, ...proof }
    } }
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return reply;
    const body = { ...request.body, collection_id: request.body.collection_id.toLowerCase(), device_id: request.body.device_id.toLowerCase() };
    const collection = body.collection_id;
    if (collection === NIL || body.device_id === NIL) return reply.code(400).send(apiError("invalid_request", "Nil identifiers are not accepted."));
    const digest = (challenge: Uint8Array) => privateCreateDigest({ challenge, connector: connector.id, device: body.device_id, collection });
    let device: Device;
    try {
      // 1. Proof, current identity and ownership, then genesis, in one transaction.
      // Nothing here calls the network.
      device = await inTransaction(options.db, async (client) => {
        await lock(client, collection);
        const owner = await authenticate(client, body, connector, digest);
        await currentIdentity(client, connector, body.device_id, owner);
        if (!(await existing(client, collection, connector.user_id))) {
          await registerNextCollection(client, {
            collectionId: collection, ownerUserId: connector.user_id, runtime: "next", sync: "private", rootKeyId,
            ops: [
              { op: "genesis", owner: connector.user_id, root: rootKeyId, state: "e2e" },
              { op: "member-set", account: connector.user_id, role: "owner" },
              enrolOp(body.device_id, connector.user_id, owner)
            ]
          });
        }
        return owner;
      });
    } catch (error) {
      return refuse(reply, error, "The private collection was not created; retry with a fresh proof.");
    }
    try {
      // 2. Only an appended genesis whose exact bytes the log returns counts as created.
      await options.emitter.drainCollection(collection);
      const row = (await options.db.query<{ seq: string; item: Buffer; state: string }>(
        "SELECT seq, item, state FROM next_policy_batches WHERE collection_id = $1 AND seq = 1 ORDER BY id LIMIT 1", [collection]
      )).rows[0];
      const genesis = await appendedBatch(collection, row);
      const head = await options.log.head(collection);
      // 3. After every await: the identity, the collection and the enrolment are
      // current, and stay locked until the token is minted.
      return await inTransaction(options.db, async (client) => {
        await currentIdentity(client, connector, body.device_id, device);
        await currentPrivate(client, collection, connector.user_id);
        // Ownership and a historical genesis are not membership: the owner account
        // must still be a current member (a member-remove counts even while pending).
        await currentMember(client, collection, connector.user_id);
        await refuseRevoked(client, collection, body.device_id);
        // The requesting device must be the one the genesis enrolled, with the same keys.
        const enrolled = await client.query(
          `SELECT 1 FROM next_policy_outbox WHERE id = (SELECT min(id) FROM next_policy_outbox WHERE collection_id = $1)
             AND ops->'ops' @> $2::jsonb`,
          [collection, exactEnrolment(body.device_id, connector.user_id, device)]
        );
        if (!enrolled.rows.length) throw new CreateError(409, "collection_exists");
        return {
          collection_id: collection, state: "private", owner_account: connector.user_id,
          log_url: options.next.logService.url, head: { seq: head.seq, chain: Buffer.from(head.chain).toString("hex") },
          root_public_key: Buffer.from(options.next.rootPublicKey).toString("hex"), policy_cert: options.next.policyCert,
          genesis: { seq: 1, item: genesis.item.toString("hex") },
          // Advisory: the creating owner device is an editor user device, the legal
          // initial-rekey signer in e2e (never hosted or escrow); at genesis it is
          // the only active device, so it wraps the first epoch key to itself.
          rekey_recipients: [body.device_id],
          device: mint(body.device_id, device.sign_pk, collection)
        };
      });
    } catch (error) {
      if (error instanceof CreateError && error.status !== 503) return refuse(reply, error, "The private collection is not current for this device.");
      return reply.code(503).send(apiError("not_ready", "The private collection outcome is not verified; retry with a fresh proof."));
    }
  });

  // ---- Device enrol: a member account's registered device, with its SAS commitment. ----
  app.post<{ Params: { id: string }; Body: Proof & { sas_commit: string } }>("/v1/next/collections/:id/private/devices", {
    ...limited,
    schema: {
      params: { type: "object", required: ["id"], properties: { id: uuid } },
      body: {
        type: "object", additionalProperties: false, required: ["device_id", "challenge", "sig", "sas_commit"],
        properties: { ...proof, sas_commit: { type: "string", pattern: "^[0-9a-f]{64}$" } }
      }
    }
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return reply;
    const collection = request.params.id.toLowerCase();
    const body = { ...request.body, device_id: request.body.device_id.toLowerCase() };
    const sasCommit = Buffer.from(body.sas_commit, "hex");
    if (collection === NIL || body.device_id === NIL) return reply.code(400).send(apiError("invalid_request", "Nil identifiers are not accepted."));
    const digest = (challenge: Uint8Array) => privateDeviceEnrolDigest({ challenge, connector: connector.id, device: body.device_id, collection, sasCommit });
    const checks = async (client: DatabaseConnection, d: Device) => {
      // The connector, account and device are current and stay locked; the collection
      // is a current private one and the account a current member. A cloud copy, or a
      // collection that has left sync, refuses before any policy op exists.
      await currentIdentity(client, connector, body.device_id, d);
      await currentPrivate(client, collection);
      await currentMember(client, collection, connector.user_id);
      await refuseRevoked(client, collection, body.device_id);
    };
    let device: Device;
    try {
      device = await inTransaction(options.db, async (client) => {
        await lock(client, collection);
        const enrolling = await authenticate(client, body, connector, digest);
        await checks(client, enrolling);
        const prior = (await client.query(ENROLMENT, [collection, enrolmentKey(body.device_id)])).rows[0];
        if (prior) {
          // Idempotent only for the identical tuple and commitment.
          const same = (await client.query(ENROLMENT, [collection, exactPrivateEnrolment(body.device_id, connector.user_id, enrolling, sasCommit)])).rows.length > 0;
          if (!same) throw new CreateError(409, "device_enrolled_differently");
        } else if (!(await queueNextPolicy(client, collection, [{
          op: "device-enrol", device: body.device_id, account: connector.user_id, kind: enrolling.kind,
          signPublicKey: enrolling.sign_pk, kemPublicKey: enrolling.kem_pk, noisePublicKey: enrolling.noise_pk, sasCommit
        }]))) {
          throw new CreateError(409, "not_current_private");
        }
        return enrolling;
      });
    } catch (error) {
      return refuse(reply, error, "The device was not enrolled; retry with a fresh proof.");
    }
    try {
      await options.emitter.drainCollection(collection);
      const row = (await options.db.query<{ seq: string | null; item: Buffer | null; state: string | null }>(
        ENROLMENT, [collection, exactPrivateEnrolment(body.device_id, connector.user_id, device, sasCommit)]
      )).rows[0];
      const batch = await appendedBatch(collection, row);
      // The enrolling device pins the collection's genesis before it trusts the log.
      const genesisRow = (await options.db.query<{ seq: string | null; item: Buffer | null; state: string | null }>(
        "SELECT seq, item, state FROM next_policy_batches WHERE collection_id = $1 AND seq = 1 ORDER BY id LIMIT 1", [collection]
      )).rows[0];
      const genesis = await appendedBatch(collection, genesisRow);
      return await inTransaction(options.db, async (client) => {
        await checks(client, device);
        // An existing keyed device approves this one (SAS) and grants it the key next.
        return {
          collection_id: collection, enrolled_at: batch.seq, approval: "pending", log_url: options.next.logService.url,
          genesis: { seq: 1, item: genesis.item.toString("hex") },
          device: mint(body.device_id, device.sign_pk, collection)
        };
      });
    } catch (error) {
      if (error instanceof CreateError && error.status !== 503) return refuse(reply, error, "The private collection is not current for this device.");
      return reply.code(503).send(apiError("not_ready", "The enrolment is not verified; retry with a fresh proof."));
    }
  });

  // ---- Approval request: an enrolled device's fresh SAS commitment. ----
  app.post<{ Params: { id: string }; Body: Proof & { sas_commit: string } }>("/v1/next/collections/:id/private/devices/approval-request", {
    ...limited,
    schema: {
      params: { type: "object", required: ["id"], properties: { id: uuid } },
      body: {
        type: "object", additionalProperties: false, required: ["device_id", "challenge", "sig", "sas_commit"],
        properties: { ...proof, sas_commit: { type: "string", pattern: "^[0-9a-f]{64}$" } }
      }
    }
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return reply;
    const collection = request.params.id.toLowerCase();
    const body = { ...request.body, device_id: request.body.device_id.toLowerCase() };
    const sasCommit = Buffer.from(body.sas_commit, "hex");
    if (collection === NIL || body.device_id === NIL) return reply.code(400).send(apiError("invalid_request", "Nil identifiers are not accepted."));
    const digest = (challenge: Uint8Array) => privateApprovalRequestDigest({ challenge, connector: connector.id, device: body.device_id, collection, sasCommit });
    const checks = async (client: DatabaseConnection, d: Device) => {
      await currentIdentity(client, connector, body.device_id, d);
      await currentPrivate(client, collection);
      await currentMember(client, collection, connector.user_id);
      await refuseRevoked(client, collection, body.device_id);
      // Only for this account's device, enrolled with exactly these keys and
      // acknowledged by the log. The op itself carries no enrolment.
      const enrolled = await client.query(
        `SELECT 1 FROM next_policy_outbox o JOIN next_policy_batches b ON b.id = o.batch_id
          WHERE o.collection_id = $1 AND b.state = 'appended' AND o.ops->'ops' @> $2::jsonb LIMIT 1`,
        [collection, exactEnrolment(body.device_id, connector.user_id, d)]
      );
      if (!enrolled.rows.length) throw new CreateError(409, "not_enrolled");
    };
    let device: Device;
    try {
      device = await inTransaction(options.db, async (client) => {
        await lock(client, collection);
        const requesting = await authenticate(client, body, connector, digest);
        await checks(client, requesting);
        // A retry of this device's LATEST commitment reuses it. Any earlier one (its
        // enrolment's, or a superseded request: A, B, then A again) is stale and
        // refused: a revealed commitment is never reused.
        const latest = await latestRequest(client, collection, body.device_id);
        if (latest?.commit !== body.sas_commit) {
          const hexCommit = { $hex: body.sas_commit };
          const earlier = await client.query(EARLIER_COMMITMENT, [collection,
            JSON.stringify([{ op: "approval-request", device: body.device_id, sasCommit: hexCommit }]),
            JSON.stringify([{ op: "device-enrol", device: body.device_id, sasCommit: hexCommit }])]);
          if (earlier.rows.length) throw new CreateError(409, "stale_commitment");
          if (!(await queueNextPolicy(client, collection, [{ op: "approval-request", device: body.device_id, sasCommit }]))) {
            throw new CreateError(409, "not_current_private");
          }
        }
        return requesting;
      });
    } catch (error) {
      return refuse(reply, error, "The approval request was not queued; retry with a fresh proof.");
    }
    try {
      await options.emitter.drainCollection(collection);
      const row = await latestRequest(options.db, collection, body.device_id);
      // A concurrent request may have superseded this commitment while we waited.
      if (row?.commit !== body.sas_commit) throw new CreateError(409, "superseded");
      const batch = await appendedBatch(collection, row);
      return await inTransaction(options.db, async (client) => {
        await checks(client, device);
        // Still this device's latest request when answered.
        const current = await latestRequest(client, collection, body.device_id);
        if (current?.commit !== body.sas_commit || Number(current.seq) !== batch.seq) throw new CreateError(409, "superseded");
        return { collection_id: collection, requested_at: batch.seq, approval: "logged" };
      });
    } catch (error) {
      if (error instanceof CreateError && error.status !== 503) return refuse(reply, error, "The private collection is not current for this device.");
      return reply.code(503).send(apiError("not_ready", "The approval request is not verified; retry with a fresh proof."));
    }
  });
}
