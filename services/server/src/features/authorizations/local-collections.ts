import { randomUUID } from "node:crypto";
import { assertFreshApplicationAuthorization, type ApplicationRequirements } from "../../application-requirements.js";
import { z } from "zod";
import type {
  ApplicationProvisions, ApplicationAuthorizationProof, ConnectProblem,
  CollectionContractDescriptor,
  CollectionTypeDescriptor
} from "@mdbase-dev/connect-protocol";
import { isConnectProblem } from "@mdbase-dev/connect-protocol";
import { accessView, COLLECTION_ACTIONS, COLLECTION_OPERATIONS, CollectionAccessDeniedError, requireCollectionAction, resolveLocalCollectionAccess } from "../../collection-access.js";
import { listLocalCollectionsVisibleToUser } from "../../collection-catalog.js";
import type { DatabasePool } from "../../db.js";
import { ConnectorOperationError, RelayUnavailableError, type RelayHub } from "../../relay.js";
import { GrantPlanningError, planCollectionGrant } from "../../grant-planner.js";
import { RequestValidationError } from "../../platform/http-errors.js";
import { contractSetupChoiceSchema } from "../../protocol-schemas.js";
import { approvePortalAuthorization } from "./approval-service.js";
import { sqlPlaceholders } from "../../platform/sql.js";

export interface LiveAuthorizationCollection {
  id: string;
  offer_id: string;
  kind: "local";
  connector_name: string;
  display_name: string;
  spec_version: string;
  contracts: CollectionContractDescriptor[];
  types: CollectionTypeDescriptor[];
  access: ReturnType<typeof accessView>;
}

export async function liveAuthorizationCollections(
  db: DatabasePool,
  relay: RelayHub,
  userId: string,
  authorizationId: string
): Promise<{
  collections: LiveAuthorizationCollection[];
  unavailable_connectors: Array<{
    connector_id: string;
    connector_name: string;
    reason: "offline" | "paused";
  }>;
}> {
  const authorization = await db.query<{
    requirements: ApplicationRequirements;
    provisions: ApplicationProvisions;
  }>(
    `SELECT a.requirements, a.provisions
     FROM authorization_requests ar
     JOIN applications a ON a.id = ar.application_id
     WHERE ar.id = $1 AND ar.user_id = $2
       AND ar.completed_at IS NULL AND ar.denied_at IS NULL
       AND ar.expires_at > now()`,
    [authorizationId, userId]
  );
  const pending = authorization.rows[0];
  if (!pending) return { collections: [], unavailable_connectors: [] };
  await db.query(
    `DELETE FROM authorization_collection_offers
     WHERE authorization_id = $1 AND expires_at <= now()`,
    [authorizationId]
  );
  const visibleCollections = await listLocalCollectionsVisibleToUser(db, userId);
  const visibleByConnector = new Map<string, Set<string>>();
  for (const collection of visibleCollections) {
    if (
      collection.authorityState !== "active"
      || !collection.connectorId
    ) continue;
    const ids = visibleByConnector.get(collection.connectorId) ?? new Set();
    ids.add(collection.authorityRowId);
    visibleByConnector.set(collection.connectorId, ids);
  }
  const ownerConnectors = await db.query<{
    id: string;
    name: string;
    inventory_revision: string | number;
  }>(
    `SELECT id, name, inventory_revision FROM connectors
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at`,
    [userId]
  );
  const ownerConnectorIds = new Set(ownerConnectors.rows.map(({ id }) => id));
  const sharedConnectorIds = [...visibleByConnector.keys()]
    .filter((id) => !ownerConnectorIds.has(id));
  const sharedConnectors = sharedConnectorIds.length
    ? await db.query<{
        id: string;
        name: string;
        inventory_revision: string | number;
      }>(
        `SELECT id, name, inventory_revision FROM connectors
         WHERE id IN (${sqlPlaceholders(sharedConnectorIds.length)})
           AND revoked_at IS NULL
         ORDER BY created_at`,
        sharedConnectorIds
      )
    : { rows: [] };
  const connectors = {
    rows: [...ownerConnectors.rows, ...sharedConnectors.rows]
  };
  const settled = await Promise.allSettled(connectors.rows.map(async (connector) => ({
    connector,
    response: await relay.authorizationOffers(
      connector.id,
      authorizationId,
      pending.requirements,
      pending.provisions
    )
  })));
  const collections: LiveAuthorizationCollection[] = [];
  const unavailableConnectors: Array<{
    connector_id: string;
    connector_name: string;
    reason: "offline" | "paused";
  }> = [];

  for (const [index, result] of settled.entries()) {
    const connector = connectors.rows[index];
    if (result.status === "rejected") {
      unavailableConnectors.push({
        connector_id: connector.id,
        connector_name: connector.name,
        reason: "offline"
      });
      continue;
    }
    if (result.value.response.paused) {
      unavailableConnectors.push({
        connector_id: connector.id,
        connector_name: connector.name,
        reason: "paused"
      });
      continue;
    }
    const authoritative = await db.query<{
      id: string;
      local_id: string;
      authority_epoch: string | number;
    }>(
      `SELECT id, local_id, authority_epoch FROM collections
       WHERE connector_id = $1
         AND present = true AND enabled = true AND authority_state = 'active'`,
      [connector.id]
    );
    const visibleIds = visibleByConnector.get(connector.id) ?? new Set();
    const byLocalId = new Map(authoritative.rows
      .filter((collection) => visibleIds.has(collection.id))
      .map((collection) => [collection.local_id, collection] as const));
    for (const offered of result.value.response.collections) {
      const collection = byLocalId.get(offered.collection_id);
      if (!collection) continue;
      const offer = await db.query<{ id: string }>(
        `INSERT INTO authorization_collection_offers
           (id, authorization_id, user_id, connector_id, collection_id, local_id,
            authority_epoch, inventory_revision, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '45 seconds')
         ON CONFLICT(authorization_id, connector_id, collection_id) DO UPDATE SET
           local_id = excluded.local_id,
           authority_epoch = excluded.authority_epoch,
           inventory_revision = excluded.inventory_revision,
           expires_at = excluded.expires_at
         WHERE authorization_collection_offers.consumed_at IS NULL
         RETURNING id`,
        [
          randomUUID(),
          authorizationId,
          userId,
          connector.id,
          collection.id,
          offered.collection_id,
          Number(collection.authority_epoch),
          Number(connector.inventory_revision)
        ]
      );
      if (!offer.rows[0]) continue;
      const access = await resolveLocalCollectionAccess(
        db,
        userId,
        collection.id
      );
      if (!access || !access.actions.has("application.authorize")) continue;
      collections.push({
        id: offered.collection_id,
        offer_id: offer.rows[0].id,
        kind: "local",
        connector_name: connector.name,
        display_name: offered.display_name,
        spec_version: offered.spec_version,
        contracts: offered.contracts,
        types: offered.types,
        access: accessView(access)
      });
    }
  }

  collections.sort((left, right) =>
    left.display_name.localeCompare(right.display_name, undefined, {
      sensitivity: "base"
    })
    || left.connector_name.localeCompare(right.connector_name, undefined, {
      sensitivity: "base"
    })
  );
  return {
    collections,
    unavailable_connectors: unavailableConnectors
  };
}

const consent = {
  userId: z.uuid(), requestId: z.uuid(), collectionId: z.uuid(),
  operations: z.array(z.enum(COLLECTION_OPERATIONS)),
  fileActions: z.array(z.enum(["list", "read", "add", "replace", "move", "delete"])).optional(),
  contractSetups: z.array(contractSetupChoiceSchema).max(20)
};
const approvalSchema = z.discriminatedUnion("source", [
  z.object({ ...consent, source: z.literal("portal"), offerId: z.uuid() }).strict(),
  z.object({ ...consent, source: z.literal("connector") }).strict()
]);
type LocalApprovalInput = z.infer<typeof approvalSchema>;

// Only expected domain errors cross this boundary. Unexpected failures remain
// internal errors; never serialize exception stacks, database text, or proofs.
const replySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approved"), approved: z.boolean() }).strict(),
  z.object({ kind: z.literal("validation"), message: z.string() }).strict(),
  z.object({ kind: z.literal("grant"), message: z.string() }).strict(),
  z.object({ kind: z.literal("access"), action: z.enum(COLLECTION_ACTIONS) }).strict(),
  z.object({ kind: z.literal("unavailable"), message: z.string() }).strict(),
  z.object({ kind: z.literal("connector"), problem: z.custom<ConnectProblem>(isConnectProblem), details: z.unknown().optional() }).strict()
]);
type ApprovalReply = z.infer<typeof replySchema>;

export function createLocalApprovalService(db: DatabasePool, relay: RelayHub) {
  relay.registerAuthorizationHandler(async (authority, message): Promise<ApprovalReply> => {
    // A malformed internal command is an invariant failure, not bad user input.
    const parsed = approvalSchema.safeParse(message);
    if (!parsed.success) throw new Error("Invalid internal approval command.");
    const input = parsed.data;
    try {
      const approved = input.source === "portal"
        ? await approvePortalAuthorization(db, relay, input, authority)
        : await approveConnectorAuthorization(db, relay, input, authority);
      return { kind: "approved", approved };
    } catch (error) {
      if (error instanceof RequestValidationError) return { kind: "validation", message: error.message };
      if (error instanceof GrantPlanningError) return { kind: "grant", message: error.message };
      if (error instanceof CollectionAccessDeniedError) return { kind: "access", action: error.action };
      if (error instanceof RelayUnavailableError) return { kind: "unavailable", message: error.message };
      if (error instanceof ConnectorOperationError) return { kind: "connector", problem: error.problem, details: error.details };
      throw error;
    }
  });
  return {
    async portal(input: Extract<LocalApprovalInput, { source: "portal" }>): Promise<boolean> {
      // A routing hint only: the owner repeats all checks in its transaction.
      // No connection or row lock is held while waiting for the RPC.
      const selected = await db.query<{ connector_id: string | null }>(
        `SELECT offer.connector_id FROM authorization_requests ar
         LEFT JOIN authorization_collection_offers offer
           ON offer.id = $1 AND offer.authorization_id = ar.id AND offer.user_id = ar.user_id
           AND offer.local_id = $4 AND offer.consumed_at IS NULL AND offer.expires_at > now()
         WHERE ar.id = $2 AND ar.user_id = $3 AND ar.completed_at IS NULL
           AND ar.denied_at IS NULL AND ar.expires_at > now()`,
        [input.offerId, input.requestId, input.userId, input.collectionId]
      );
      if (!selected.rows[0]) return false;
      if (!selected.rows[0].connector_id) {
        throw new RequestValidationError("That collection is no longer being offered by a live connector. Refresh and choose again.");
      }
      return requestApproval(selected.rows[0].connector_id, input);
    },
    async connector(connectorId: string, input: Extract<LocalApprovalInput, { source: "connector" }>): Promise<boolean> {
      // Preserve invalid/expired selection errors even while the relay is offline.
      // The owner repeats this lookup; this never authorizes a grant.
      if (!await findConnectorApproval(db, connectorId, input)) return false;
      return requestApproval(connectorId, input);
    }
  };

  async function requestApproval(connectorId: string, input: LocalApprovalInput): Promise<boolean> {
    // Never retry or compensate here: a lost reply may follow a committed grant.
    // The existing authorization status endpoint is the reconciliation authority.
    const parsed = replySchema.safeParse(await relay.requestAuthorization(connectorId, input));
    if (!parsed.success) throw new Error("Invalid internal approval response.");
    const reply = parsed.data;
    switch (reply.kind) {
      case "approved": return reply.approved;
      case "validation": throw new RequestValidationError(reply.message);
      case "grant": throw new GrantPlanningError(reply.message);
      case "access": throw new CollectionAccessDeniedError(reply.action);
      case "unavailable": throw new RelayUnavailableError(reply.message);
      case "connector": throw new ConnectorOperationError(
        reply.problem.code === "unknown" ? reply.problem.server_code : reply.problem.code,
        reply.problem.message, reply.problem, reply.details
      );
    }
  }
}

async function findConnectorApproval(
  db: DatabasePool, connectorId: string,
  input: Extract<LocalApprovalInput, { source: "connector" }>
) {
  // Connector credentials represent only their own local authority, not account
  // visibility. The caller cannot supply a portal offer or another connector.
  const selection = await db.query<{
    authority_id: string;
    authority_epoch: string | number;
    inventory_revision: string | number;
    requirements: ApplicationRequirements;
    provisions: ApplicationProvisions;
    application_authorization: ApplicationAuthorizationProof | null;
  }>(
    `SELECT col.id AS authority_id, col.authority_epoch, con.inventory_revision,
            a.requirements, a.provisions, ar.application_authorization
     FROM authorization_requests ar
     JOIN applications a ON a.id = ar.application_id
     JOIN connectors con ON con.id = $3 AND con.user_id = ar.user_id
     JOIN collections col ON col.connector_id = con.id AND col.local_id = $4
     WHERE ar.id = $1 AND ar.user_id = $2
       AND ar.completed_at IS NULL AND ar.denied_at IS NULL
       AND ar.grant_id IS NULL AND ar.expires_at > now()
       AND (ar.collection_id IS NULL OR ar.collection_id = col.local_id)
       AND con.revoked_at IS NULL AND col.present = true AND col.enabled = true
       AND col.authority_state = 'active'`,
    [input.requestId, input.userId, connectorId, input.collectionId]
  );
  return selection.rows[0];
}

/** Runs on the relay owner, including the native-only live-offer prelude. */
async function approveConnectorAuthorization(
  db: DatabasePool, relay: RelayHub,
  input: Extract<LocalApprovalInput, { source: "connector" }>,
  authority: Parameters<typeof approvePortalAuthorization>[3]
): Promise<boolean> {
  const selected = await findConnectorApproval(db, authority.connectorId, input);
  if (!selected) return false;
  const files = selected.requirements.files;
  if (files && "optional" in files && files.optional?.length && input.fileActions === undefined) {
    throw new RequestValidationError("Choose optional file permissions explicitly in Connect before approving this request.");
  }
  const access = await resolveLocalCollectionAccess(db, input.userId, selected.authority_id);
  requireCollectionAction(access, "application.authorize");
  if (input.contractSetups.length) requireCollectionAction(access, "schema.manage");
  assertFreshApplicationAuthorization(selected.requirements);
  if (!selected.application_authorization) {
    throw new ConnectorOperationError("signed_authorization_required", "This request needs a signed application authorization.");
  }
  const binding = selected.application_authorization.binding;
  if (binding.authorization_id !== input.requestId
    || Date.parse(binding.expires_at) <= Date.now()
    || !Number.isFinite(Date.parse(binding.expires_at))
    || (binding.collection_id && binding.collection_id !== input.collectionId)) {
    throw new ConnectorOperationError("authorization_binding_mismatch", "The signed request is expired or belongs to a different approval.");
  }
  // Refuse escalation before creating an offer. Common approval repeats this
  // planning against the locked request and current access policy.
  planCollectionGrant({
    requestedOperations: input.operations,
    applicationOperationCeiling: binding.requested_operations,
    requestedFileActions: input.fileActions,
    requirements: selected.requirements,
    access: requireCollectionAction(access, "application.authorize")
  });
  if (relay.authorizationAuthority(authority.connectorId, binding.contracts) !== authority.generation) {
    throw new RelayUnavailableError();
  }
  const live = await relay.authorizationOffers(authority.connectorId, input.requestId, selected.requirements, selected.provisions);
  if (live.paused || !live.collections.some((collection) => collection.collection_id === input.collectionId)) {
    throw new ConnectorOperationError("collection_unavailable", "This computer is no longer offering that collection.");
  }
  const offerId = randomUUID();
  await db.query(
    `INSERT INTO authorization_collection_offers
       (id, authorization_id, user_id, connector_id, collection_id, local_id,
        authority_epoch, inventory_revision, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '45 seconds')
     ON CONFLICT(authorization_id, connector_id, collection_id) DO UPDATE SET
       id = excluded.id, authority_epoch = excluded.authority_epoch,
       inventory_revision = excluded.inventory_revision, expires_at = excluded.expires_at
     WHERE authorization_collection_offers.consumed_at IS NULL`,
    [offerId, input.requestId, input.userId, authority.connectorId, selected.authority_id,
      input.collectionId, Number(selected.authority_epoch), Number(selected.inventory_revision)]
  );
  return approvePortalAuthorization(db, relay, { ...input, offerId }, authority);
}
