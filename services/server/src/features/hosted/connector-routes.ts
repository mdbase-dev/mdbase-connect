import { approveMirrorPairing } from "../../hosted-mirror-policy.js";
import type {
  CollectionContractDescriptor,
  CollectionOperation,
  ContractSetupChoice
} from "@mdbase-dev/connect-protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  COLLECTION_OPERATIONS,
  requireCollectionAction,
  resolveHostedCollectionAccess,
  type CollectionAccessContext
} from "../../collection-access.js";
import { resolveHostedCollection } from "../../collection-catalog.js";
import type { HostedAuthorityRegistry } from "../../hosted.js";
import { effectiveHostedContractDescriptors } from "../../hosted.js";
import { audit } from "../../platform/audit-events.js";
import { apiError } from "../../platform/http-errors.js";
import { requireConnector } from "../../platform/request-authentication.js";
import { contractSetupChoiceSchema } from "../../protocol-schemas.js";
import {
  createHostedCollectionForUser,
  deleteHostedCollectionForUser,
  hostedControlSnapshot,
  narrowHostedGrantForUser,
  renameHostedCollectionForUser,
  revokeHostedGrantForUser,
  revokeHostedReplicaForUser,
  type HostedServiceOptions
} from "./service.js";

interface ConnectorHostedRoutesOptions extends HostedServiceOptions {
  publicUrl: string;
  hostedReference?: HostedAuthorityRegistry;
  approveAuthorization(input: {
    requestId: string;
    userId: string;
    collectionId: string;
    operations: CollectionOperation[];
    contracts: CollectionContractDescriptor[];
    contractSetups: ContractSetupChoice[];
    access: CollectionAccessContext;
  }): Promise<unknown | null>;
}

const operationSchema = z.enum(COLLECTION_OPERATIONS);

export function registerConnectorHostedRoutes(
  app: FastifyInstance,
  options: ConnectorHostedRoutesOptions
): void {
  app.get("/v1/connectors/hosted-control", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    return hostedControlSnapshot(
      options,
      options.hostedReference,
      options.publicUrl,
      connector.user_id
    );
  });

  app.post("/v1/connectors/hosted/collections", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const input = z.object({
      display_name: z.string().trim().min(1).max(200),
      template: z.literal("mdbase").default("mdbase"),
      timezone: ianaTimezoneSchema
    }).strict().parse(request.body);
    const collection = await createHostedCollectionForUser(
      options,
      options.hostedReference,
      options.publicUrl,
      connector.user_id,
      input.display_name,
      input.template,
      input.timezone
    );
    return reply.code(201).send({ collection });
  });

  app.patch(
    "/v1/connectors/hosted/collections/:collectionId",
    async (request, reply) => {
      const connector = await requireConnector(request, reply, options.db);
      if (!connector) return;
      const { collectionId } = z.object({
        collectionId: z.uuid()
      }).parse(request.params);
      const input = z.object({
        display_name: z.string().trim().min(1).max(200)
      }).strict().parse(request.body);
      const collection = await renameHostedCollectionForUser(
        options,
        connector.user_id,
        collectionId,
        input.display_name
      );
      if (!collection) {
        return reply.code(404).send(apiError(
          "hosted_collection_not_found",
          "Hosted collection not found."
        ));
      }
      return { collection };
    }
  );

  app.delete(
    "/v1/connectors/hosted/collections/:collectionId",
    async (request, reply) => {
      const connector = await requireConnector(request, reply, options.db);
      if (!connector) return;
      const { collectionId } = z.object({
        collectionId: z.uuid()
      }).parse(request.params);
      if (!await deleteHostedCollectionForUser(
        options,
        options.hostedReference,
        connector.user_id,
        collectionId
      )) {
        return reply.code(404).send(apiError(
          "hosted_collection_not_found",
          "Hosted collection not found."
        ));
      }
      return { ok: true };
    }
  );

  app.post(
    "/v1/connectors/mirror-pairing-requests/:pairingId/approve",
    async (request, reply) => {
      const connector = await requireConnector(request, reply, options.db);
      if (!connector) return;
      const { pairingId } = z.object({
        pairingId: z.uuid()
      }).parse(request.params);
      const input = z.object({
        collection_id: z.uuid()
      }).strict().parse(request.body);
      const connection = await options.db.connect();
      let approved;
      try {
        await connection.query("BEGIN");
        approved = await approveMirrorPairing(connection, connector.user_id, input.collection_id, pairingId);
        await connection.query("COMMIT");
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
      if (!approved) {
        return reply.code(404).send(apiError(
          "mirror_pairing_not_found",
          "Mirror setup expired, was already used, or the collection was not found."
        ));
      }
      await audit(
        options.db,
        connector.user_id,
        "hosted_replica.pairing_approved",
        pairingId,
        {
          collection_id: input.collection_id,
          connector_id: connector.id,
          mode: approved.mode,
          source: "desktop"
        }
      );
      return { ok: true };
    }
  );

  app.delete(
    "/v1/connectors/hosted/replicas/:replicaId",
    async (request, reply) => {
      const connector = await requireConnector(request, reply, options.db);
      if (!connector) return;
      const { replicaId } = z.object({
        replicaId: z.uuid()
      }).parse(request.params);
      const revocationStatus = await revokeHostedReplicaForUser(
        options,
        options.hostedReference,
        connector.user_id,
        replicaId
      );
      if (!revocationStatus) {
        return reply.code(404).send(apiError(
          "replica_not_found",
          "Mirror not found."
        ));
      }
      return { ok: true, revocation_status: revocationStatus };
    }
  );

  app.post(
    "/v1/connectors/hosted/authorization-requests/:requestId/approve",
    async (request, reply) => {
      const connector = await requireConnector(request, reply, options.db);
      if (!connector) return;
      const { requestId } = z.object({
        requestId: z.uuid()
      }).parse(request.params);
      const input = z.object({
        collection_id: z.uuid(),
        operations: z.array(operationSchema),
        contract_setups: z.array(contractSetupChoiceSchema).max(20).default([])
      }).strict().parse(request.body);
      if (!options.hostedProvider) {
        return reply.code(503).send(apiError(
          "hosted_provider_unavailable",
          "Hosted application access is temporarily unavailable."
        ));
      }
      const access = await resolveHostedCollectionAccess(
        options.db,
        connector.user_id,
        input.collection_id
      );
      const collection = await resolveHostedCollection(
        options.db,
        input.collection_id
      );
      if (
        !access
        || !collection
        || collection.locator.authorityState !== "active"
      ) {
        return reply.code(404).send(apiError(
          "hosted_collection_not_found",
          "Hosted collection not found."
        ));
      }
      requireCollectionAction(access, "application.authorize");
      if (input.contract_setups.length > 0) {
        requireCollectionAction(access, "schema.manage");
      }
      const approved = await options.approveAuthorization({
        requestId,
        userId: connector.user_id,
        collectionId: collection.locator.collectionId,
        operations: input.operations,
        contracts: effectiveHostedContractDescriptors(
          collection.contracts,
          collection.template
        ),
        contractSetups: input.contract_setups,
        access
      });
      if (!approved) {
        return reply.code(404).send(apiError(
          "authorization_not_found",
          "Authorization request expired or was not found."
        ));
      }
      return { ok: true };
    }
  );

  app.patch(
    "/v1/connectors/hosted/grants/:grantId",
    async (request, reply) => {
      const connector = await requireConnector(request, reply, options.db);
      if (!connector) return;
      const { grantId } = z.object({
        grantId: z.uuid()
      }).parse(request.params);
      const input = z.object({
        operations: z.array(operationSchema)
      }).strict().parse(request.body);
      const grant = await narrowHostedGrantForUser(
        options,
        connector.user_id,
        grantId,
        input.operations
      );
      if (!grant) {
        return reply.code(404).send(apiError(
          "grant_not_found",
          "Active hosted grant not found."
        ));
      }
      return { grant };
    }
  );

  app.delete(
    "/v1/connectors/hosted/grants/:grantId",
    async (request, reply) => {
      const connector = await requireConnector(request, reply, options.db);
      if (!connector) return;
      const { grantId } = z.object({
        grantId: z.uuid()
      }).parse(request.params);
      const revocationStatus = await revokeHostedGrantForUser(
        options,
        connector.user_id,
        grantId
      );
      if (!revocationStatus) {
        return reply.code(404).send(apiError(
          "grant_not_found",
          "Hosted grant not found."
        ));
      }
      return { ok: true, revocation_status: revocationStatus };
    }
  );
}

const ianaTimezoneSchema = z.string().trim().min(1).refine((timezone) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return timezone.toLowerCase() !== "local" && !/^[+-]\d{2}:\d{2}$/.test(timezone);
  } catch {
    return false;
  }
}, "timezone must be a valid IANA identifier");
