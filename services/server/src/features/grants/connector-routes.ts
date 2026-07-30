import type {
  ApplicationNotifications,
  ApplicationRequirements,
  CollectionContractDescriptor
} from "@mdbase/connect-protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { COLLECTION_OPERATIONS } from "../../collection-access.js";
import type { DatabasePool } from "../../db.js";
import { collectionContractDescriptorSchema } from "../../protocol-schemas.js";
import type { RelayHub } from "../../relay.js";
import { audit } from "../../platform/audit-events.js";
import { apiError } from "../../platform/http-errors.js";
import { requireConnector } from "../../platform/request-authentication.js";
import {
  assertCollectionSupportsOperations,
  assertOperationsAllowedByRequirements,
  contractsSatisfy,
  requiredContractsForRequirements,
  requiresHostedCollection,
  rotateGrantEncryption,
  scopeForRequirements
} from "./policy.js";
import { createOrUpdateGrant } from "./service.js";

const operationSchema = z.enum(COLLECTION_OPERATIONS);

interface ConnectorGrantRouteOptions {
  db: DatabasePool;
  relay: RelayHub;
}

export function registerConnectorGrantRoutes(
  app: FastifyInstance,
  options: ConnectorGrantRouteOptions
): void {
  app.post("/v1/connectors/grants", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const input = z.object({
      application_id: z.uuid(),
      collection_id: z.uuid(),
      operations: z.array(operationSchema).min(1),
      contracts: z.array(collectionContractDescriptorSchema).max(100).optional()
    }).parse(request.body);
    if (input.contracts) {
      await options.db.query(
        `UPDATE collections SET contracts = $3::jsonb, last_seen_at = now()
         WHERE connector_id = $1 AND local_id = $2 AND enabled = true
           AND present = true AND authority_state = 'active'`,
        [connector.id, input.collection_id, JSON.stringify(input.contracts)]
      );
    }
    const collection = await options.db.query<{
      id: string;
      contracts: CollectionContractDescriptor[];
      spec_version: string;
    }>(
      `SELECT id, contracts, spec_version FROM collections
       WHERE connector_id = $1 AND local_id = $2 AND enabled = true
         AND present = true AND authority_state = 'active'`,
      [connector.id, input.collection_id]
    );
    if (!collection.rows[0]) {
      return reply.code(404).send(apiError(
        "collection_not_found",
        "Collection is not synchronized yet."
      ));
    }
    const application = await options.db.query<{
      id: string;
      distribution: "web" | "portable";
      homepage: string;
      requirements: ApplicationRequirements;
      notifications: ApplicationNotifications;
    }>(
      "SELECT id, distribution, homepage, requirements, notifications FROM applications WHERE id = $1",
      [input.application_id]
    );
    if (!application.rows[0]) {
      return reply.code(404).send(apiError(
        "application_not_found",
        "Application not found."
      ));
    }
    if (application.rows[0].distribution === "portable") {
      return reply.code(409).send(apiError(
        "portable_approval_required",
        "Downloaded applications must use their key-bound device authorization request."
      ));
    }
    if (requiresHostedCollection(application.rows[0].requirements)) {
      return reply.code(409).send(apiError(
        "incompatible_collection",
        "This application requires an mdbase cloud collection."
      ));
    }
    assertOperationsAllowedByRequirements(
      input.operations,
      application.rows[0].requirements
    );
    assertCollectionSupportsOperations(
      collection.rows[0].spec_version,
      input.operations
    );
    const scope = scopeForRequirements(
      application.rows[0].requirements,
      collection.rows[0].contracts
    );
    if (!contractsSatisfy(
      collection.rows[0].contracts,
      requiredContractsForRequirements(application.rows[0].requirements)
    )) {
      return reply.code(409).send(apiError(
        "incompatible_collection",
        "This collection does not provide the contracts required by the application."
      ));
    }
    const grant = await createOrUpdateGrant(options.db, {
      userId: connector.user_id,
      applicationId: input.application_id,
      collectionId: collection.rows[0].id,
      operations: input.operations,
      scope,
      applicationOrigin: new URL(application.rows[0].homepage).origin,
      notificationCriteria: application.rows[0].notifications.criteria
    });
    await options.relay.pushPolicy(connector.id);
    await audit(options.db, connector.user_id, "grant.created", grant.id, {
      ...input,
      connector_id: connector.id
    });
    return reply.code(201).send({ grant });
  });

  app.patch("/v1/connectors/grants/:grantId", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const { grantId } = z.object({ grantId: z.uuid() }).parse(request.params);
    const input = z.object({
      operations: z.array(operationSchema).min(1)
    }).parse(request.body);
    const current = await options.db.query<{
      requirements: ApplicationRequirements;
      spec_version: string;
    }>(
      `SELECT a.requirements, col.spec_version FROM grants g
       JOIN applications a ON a.id = g.application_id
       JOIN collections col ON col.id = g.collection_id
       WHERE g.id = $1 AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
         AND g.collection_id IN
         (SELECT id FROM collections WHERE connector_id = $2)`,
      [grantId, connector.id]
    );
    if (!current.rows[0]) {
      return reply.code(404).send(apiError(
        "grant_not_found",
        "Active grant not found."
      ));
    }
    assertOperationsAllowedByRequirements(
      input.operations,
      current.rows[0].requirements
    );
    assertCollectionSupportsOperations(
      current.rows[0].spec_version,
      input.operations
    );
    const grant = await options.db.query(
      `UPDATE grants SET operations = $3::jsonb
       WHERE id = $1 AND revoked_at IS NULL AND activated_at IS NOT NULL
         AND collection_id IN
         (SELECT id FROM collections WHERE connector_id = $2)
       RETURNING id, operations`,
      [grantId, connector.id, JSON.stringify([...new Set(input.operations)])]
    );
    if (!grant.rows[0]) {
      return reply.code(404).send(apiError(
        "grant_not_found",
        "Active grant not found."
      ));
    }
    await rotateGrantEncryption(options.db, grantId);
    await options.relay.pushPolicy(connector.id);
    await audit(options.db, connector.user_id, "grant.updated", grantId, input);
    return { grant: grant.rows[0] };
  });

  app.delete("/v1/connectors/grants/:grantId", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const { grantId } = z.object({ grantId: z.uuid() }).parse(request.params);
    const active = await options.db.query(
      `UPDATE grants SET revoked_at = now()
       WHERE id = $1 AND revoked_at IS NULL AND activated_at IS NOT NULL
         AND collection_id IN
         (SELECT id FROM collections WHERE connector_id = $2)
       RETURNING id`,
      [grantId, connector.id]
    );
    if (!active.rows[0]) {
      return reply.code(404).send(apiError(
        "grant_not_found",
        "Active grant not found."
      ));
    }
    await options.db.query(
      "UPDATE access_tokens SET revoked_at = now() WHERE grant_id = $1",
      [grantId]
    );
    await options.db.query(
      "UPDATE refresh_tokens SET revoked_at = now() WHERE grant_id = $1",
      [grantId]
    );
    await options.relay.pushPolicy(connector.id);
    await audit(options.db, connector.user_id, "grant.revoked", grantId, {
      connector_id: connector.id
    });
    return { ok: true };
  });
}
