import type {
  ConnectContractRequirements,
  EncryptedRelayOperationRequest,
  GrantEncryption
} from "@mdbase-dev/connect-protocol";
import {
  isMutatingOperation,
  LEGACY_OPERATION_TRANSPORT_PROTOCOL_VERSION,
  OPERATION_TRANSPORT_PROTOCOL_VERSION,
  permitsOperationTransport
} from "@mdbase-dev/connect-protocol";
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
import { recordProtocolUsage } from "../../protocol-telemetry.js";
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
  protocol_version: z.union([
    z.literal(OPERATION_TRANSPORT_PROTOCOL_VERSION),
    z.literal(LEGACY_OPERATION_TRANSPORT_PROTOCOL_VERSION)
  ]),
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
        user_id: string;
        application_id: string;
        application_installation_id: string;
        collection_id: string;
        operations: string[];
        connector_id: string;
        local_id: string;
        encryption: GrantEncryption | null;
        contracts: ConnectContractRequirements;
      }>(
        `SELECT g.id AS grant_id, g.user_id, g.application_id,
                g.application_installation_id, g.collection_id, g.operations,
                g.encryption,
                g.application_authorization->'binding'->'contracts' AS contracts,
                col.connector_id, col.local_id
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
      let operationRequestProtocol: number = OPERATION_TRANSPORT_PROTOCOL_VERSION;
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
          let routedGrant = grant;
          if (!matchesGrantEncryption(
            envelope,
            { ...grant, encryption: grant.encryption },
            params.operation
          )) {
            const recoveryAllowed = isMutatingOperation(params.operation, {
              action: "mutate"
            }) && permitsOperationTransport(
              grant.contracts,
              envelope.protocol_version,
              true
            );
            const recovered = recoveryAllowed
              ? await recoveryGrant(options.db, grant, envelope, params.operation)
              : null;
            if (recovered) {
              routedGrant = recovered;
            } else if (matchesGrantIdentity(envelope, grant, params.operation)) {
              return reply.code(409).send(apiError(
                "encryption_binding_stale",
                "The encrypted grant binding changed. Refresh authorization and retry."
              ));
            } else {
              return reply.code(400).send(apiError(
                "invalid_encrypted_envelope",
                "Encrypted relay metadata does not match the active grant or an authorized recovery grant."
              ));
            }
          }
          void recordProtocolUsage(options.db, {
            userId: grant.user_id,
            surface: "relay",
            version: envelope.protocol_version
          }).catch(() => undefined);
          const encryptedResponse = await options.relay.routeEncrypted(
            routedGrant.connector_id,
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
        operationRequestProtocol = operationRequest.protocol_version;
        if (!permitsOperationTransport(
          grant.contracts,
          operationRequest.protocol_version
        )) {
          return reply.code(400).send(apiError(
            "transport_protocol_incompatible",
            "The operation transport protocol does not match the signed grant."
          ));
        }
        void recordProtocolUsage(options.db, {
          userId: grant.user_id,
          surface: "relay",
          version: operationRequest.protocol_version
        }).catch(() => undefined);
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
          protocol_version: operationRequest.protocol_version,
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
            if (error.code === "connector_busy") {
              return reply
                .header("retry-after", "1")
                .code(503)
                .send(apiError(error.code, error.message));
            }
            return reply.code(502).send(apiError(error.code, error.message));
          }
          return {
            protocol_version: operationRequestProtocol,
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

type LocalGrant = {
  grant_id: string;
  user_id: string;
  application_id: string;
  application_installation_id: string;
  collection_id: string;
  operations: string[];
  connector_id: string;
  local_id: string;
  encryption: GrantEncryption | null;
  contracts: ConnectContractRequirements;
};

async function recoveryGrant(
  db: DatabasePool,
  active: LocalGrant,
  envelope: EncryptedRelayOperationRequest,
  operation: typeof COLLECTION_OPERATIONS[number]
): Promise<LocalGrant | null> {
  const result = await db.query<LocalGrant>(
    `SELECT old.id AS grant_id, old.user_id, old.application_id,
            old.application_installation_id, old.collection_id, old.operations,
            old.encryption,
            old.application_authorization->'binding'->'contracts' AS contracts,
            col.connector_id, col.local_id
     FROM grants old
     JOIN collections col ON col.id = old.collection_id
     WHERE old.id = $1 AND old.user_id = $2 AND old.application_id = $3
       AND old.application_installation_id = $4 AND old.collection_id = $5
       AND old.activated_at IS NOT NULL
       AND col.connector_id = $6 AND col.local_id = $7
       AND col.enabled = true AND col.present = true
       AND col.authority_state = 'active'`,
    [
      envelope.grant_id,
      active.user_id,
      active.application_id,
      active.application_installation_id,
      active.collection_id,
      active.connector_id,
      active.local_id
    ]
  );
  const candidate = result.rows[0];
  if (!candidate?.encryption || !candidate.operations.includes(operation)) return null;
  return matchesGrantEncryption(
    envelope,
    { ...candidate, encryption: candidate.encryption },
    operation
  ) ? candidate : null;
}
