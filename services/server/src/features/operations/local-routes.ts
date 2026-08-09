import type {
  EncryptedRelayOperationRequest,
  GrantEncryption
} from "@mdbase-dev/connect-protocol";
import { OPERATION_TRANSPORT_PROTOCOL_VERSION } from "@mdbase-dev/connect-protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { COLLECTION_OPERATIONS } from "../../collection-access.js";
import type { DatabasePool } from "../../database-types.js";
import {
  ConnectorOperationError,
  type RelayHub,
  RelayUnavailableError
} from "../../relay.js";
import { tokenHash } from "../../security.js";
import {
  apiError,
  insufficientAccessError
} from "../../platform/http-errors.js";
import { bearerToken } from "../../platform/request-authentication.js";
import {
  encryptedRelayRequestSchema,
  matchesGrantEncryption,
  matchesGrantIdentity
} from "./encrypted-envelope.js";

interface LocalOperationRoutesOptions {
  db: DatabasePool;
  relay: RelayHub;
}

const operationSchema = z.enum(COLLECTION_OPERATIONS);
const operationRequestSchema = z.object({
  protocol_version: z.literal(OPERATION_TRANSPORT_PROTOCOL_VERSION),
  request_id: z.uuid(),
  input: z.unknown()
}).strict();

export function registerLocalOperationRoutes(
  app: FastifyInstance,
  options: LocalOperationRoutesOptions
): void {
  app.post(
    "/v1/authorities/:collectionId/operations/:operation",
    async (request, reply) => {
      const params = z.object({
        collectionId: z.uuid(),
        operation: operationSchema
      }).parse(request.params);
      const bearer = bearerToken(request);
      if (!bearer) {
        return reply.code(401).send(apiError(
          "invalid_token",
          "Bearer token required."
        ));
      }
      const authorized = await options.db.query<{
        grant_id: string;
        application_id: string;
        operations: string[];
        connector_id: string;
        local_id: string;
        encryption: GrantEncryption | null;
      }>(
        `SELECT g.id AS grant_id, g.application_id, g.operations,
                g.encryption, col.connector_id, col.local_id
         FROM access_tokens tok
         JOIN grants g ON g.id = tok.grant_id
         JOIN users u ON u.id = g.user_id
         JOIN collections col ON col.id = g.collection_id
         WHERE tok.token_hash = $1 AND tok.expires_at > now()
           AND tok.revoked_at IS NULL
           AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
           AND u.suspended_at IS NULL
           AND col.local_id = $2 AND col.enabled = true
           AND col.present = true AND col.authority_state = 'active'`,
        [tokenHash(bearer), params.collectionId]
      );
      const grant = authorized.rows[0];
      if (!grant) {
        return reply.code(401).send(apiError(
          "invalid_token",
          "Access token is invalid or expired."
        ));
      }
      if (!grant.operations.includes(params.operation)) {
        return reply.code(403).send(insufficientAccessError(
          [params.operation],
          grant.operations,
          "The application is not allowed to perform this operation."
        ));
      }
      let operationRequestId: string | undefined;
      try {
        if (grant.encryption) {
          let envelope: EncryptedRelayOperationRequest;
          try {
            envelope = encryptedRelayRequestSchema.parse(
              request.body
            ) as EncryptedRelayOperationRequest;
          } catch {
            return reply.code(426).send(apiError(
              "encryption_required",
              "This grant requires grant encryption profile 1."
            ));
          }
          if (!matchesGrantEncryption(
            envelope,
            { ...grant, encryption: grant.encryption },
            params.operation
          )) {
            if (matchesGrantIdentity(envelope, grant, params.operation)) {
              return reply.code(409).send(apiError(
                "encryption_binding_stale",
                "The encrypted grant binding changed. Refresh authorization and retry."
              ));
            }
            return reply.code(400).send(apiError(
              "invalid_encrypted_envelope",
              "Encrypted relay metadata does not match the active grant."
            ));
          }
          const encryptedResponse = await options.relay.routeEncrypted(
            grant.connector_id,
            envelope
          );
          return { ok: true, envelope: encryptedResponse };
        }
        if (
          (request.body as { type?: unknown } | null)?.type
          === "encrypted_operation_request"
        ) {
          return reply.code(400).send(apiError(
            "encryption_not_configured",
            "This grant was not authorized for grant encryption profile 1."
          ));
        }
        const operationRequest = operationRequestSchema.parse(request.body);
        operationRequestId = operationRequest.request_id;
        const result = await options.relay.route({
          connectorId: grant.connector_id,
          localCollectionId: grant.local_id,
          requestId: operationRequest.request_id,
          grantId: grant.grant_id,
          applicationId: grant.application_id,
          operation: params.operation,
          operationInput: operationRequest.input
        });
        return {
          protocol_version: OPERATION_TRANSPORT_PROTOCOL_VERSION,
          request_id: operationRequest.request_id,
          ok: true,
          result
        };
      } catch (error) {
        if (error instanceof RelayUnavailableError) {
          return reply.code(503).send(apiError(
            "connector_offline",
            error.message
          ));
        }
        if (error instanceof ConnectorOperationError) {
          if (!operationRequestId) {
            return reply.code(502).send(apiError(error.code, error.message));
          }
          return {
            protocol_version: OPERATION_TRANSPORT_PROTOCOL_VERSION,
            request_id: operationRequestId,
            ok: false,
            problem: error.problem
          };
        }
        throw error;
      }
    }
  );
}
