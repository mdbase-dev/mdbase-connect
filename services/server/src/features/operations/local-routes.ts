import type {
  EncryptedRelayOperationRequest,
  GrantEncryption
} from "@mdbase/connect-protocol";
import {
  CONTROL_PROTOCOL_VERSION,
  ENCRYPTED_RELAY_PROTOCOL_VERSION,
  RELAY_ENCRYPTION_SUITE
} from "@mdbase/connect-protocol";
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
import { apiError } from "../../platform/http-errors.js";
import { bearerToken } from "../../platform/request-authentication.js";

interface LocalOperationRoutesOptions {
  db: DatabasePool;
  relay: RelayHub;
}

const operationSchema = z.enum(COLLECTION_OPERATIONS);
const encryptedRelayRequestSchema = z.object({
  type: z.literal("encrypted_operation_request"),
  protocol_version: z.literal(ENCRYPTED_RELAY_PROTOCOL_VERSION),
  suite: z.literal(RELAY_ENCRYPTION_SUITE),
  request_id: z.uuid(),
  grant_id: z.uuid(),
  application_id: z.uuid(),
  connector_id: z.uuid(),
  collection_id: z.uuid(),
  operation: operationSchema,
  scope_epoch: z.number().int().positive(),
  key_id: z.string().min(1).max(200),
  counter: z.string().regex(/^[1-9][0-9]{0,19}$/),
  ciphertext: z.string()
    .min(1)
    .max(2_800_000)
    .regex(/^[A-Za-z0-9_-]+$/)
}).strict();
const operationRequestSchema = z.object({
  protocol_version: z.literal(CONTROL_PROTOCOL_VERSION),
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
        return reply.code(403).send(apiError(
          "insufficient_access",
          "The application is not allowed to perform this operation."
        ));
      }
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
              "This grant requires encrypted relay protocol 1."
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
            "This grant was not authorized for encrypted relay protocol 1."
          ));
        }
        const operationRequest = operationRequestSchema.parse(request.body);
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
          protocol_version: CONTROL_PROTOCOL_VERSION,
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
          const denied = error.code === "access_paused"
            || error.code === "access_denied";
          return reply.code(denied ? 403 : 502).send(apiError(
            error.code,
            error.message
          ));
        }
        throw error;
      }
    }
  );
}

function matchesGrantEncryption(
  envelope: EncryptedRelayOperationRequest,
  grant: {
    grant_id: string;
    application_id: string;
    connector_id: string;
    local_id: string;
    encryption: GrantEncryption;
  },
  operation: string
): boolean {
  const encryption = grant.encryption;
  return envelope.protocol_version === encryption.protocol_version
    && envelope.suite === encryption.suite
    && envelope.grant_id === grant.grant_id
    && envelope.application_id === grant.application_id
    && envelope.connector_id === grant.connector_id
    && envelope.connector_id === encryption.connector_id
    && envelope.collection_id === grant.local_id
    && envelope.collection_id === encryption.collection_id
    && envelope.operation === operation
    && envelope.scope_epoch === encryption.scope_epoch
    && envelope.key_id === encryption.key_id;
}

function matchesGrantIdentity(
  envelope: EncryptedRelayOperationRequest,
  grant: {
    grant_id: string;
    application_id: string;
    connector_id: string;
    local_id: string;
    encryption: GrantEncryption | null;
  },
  operation: string
): boolean {
  return envelope.protocol_version === ENCRYPTED_RELAY_PROTOCOL_VERSION
    && envelope.suite === RELAY_ENCRYPTION_SUITE
    && envelope.grant_id === grant.grant_id
    && envelope.application_id === grant.application_id
    && envelope.connector_id === grant.connector_id
    && envelope.collection_id === grant.local_id
    && envelope.operation === operation;
}
