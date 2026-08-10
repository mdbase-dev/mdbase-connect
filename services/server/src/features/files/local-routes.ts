import { randomUUID } from "node:crypto";
import type {
  ConnectContractRequirements,
  EncryptedRelayOperationRequest,
  FileFrame,
  GrantEncryption,
  RelayFileFrame
} from "@mdbase-dev/connect-protocol";
import {
  decodeFileFrame,
  MAX_FILE_FRAME_BYTES,
  RELAY_FILE_PROTOCOL_VERSION
} from "@mdbase-dev/connect-protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DatabasePool } from "../../database-types.js";
import {
  apiError,
  insufficientAccessError
} from "../../platform/http-errors.js";
import { bearerToken } from "../../platform/request-authentication.js";
import {
  ConnectorOperationError,
  type RelayHub,
  RelayUnavailableError
} from "../../relay.js";
import { tokenHash } from "../../security.js";
import {
  encryptedRelayRequestSchema,
  matchesGrantEncryption,
  matchesGrantIdentity
} from "../operations/encrypted-envelope.js";

interface LocalFileRoutesOptions {
  db: DatabasePool;
  relay: RelayHub;
}

interface LocalFileGrant {
  grant_id: string;
  application_id: string;
  connector_id: string;
  local_id: string;
  encryption: GrantEncryption | null;
  contracts: ConnectContractRequirements;
  file_capability: unknown | null;
}

const collectionParamsSchema = z.object({ collectionId: z.uuid() });
const downloadParamsSchema = z.object({
  collectionId: z.uuid(),
  transferId: z.uuid(),
  chunkIndex: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
});

export function registerLocalFileRoutes(
  app: FastifyInstance,
  options: LocalFileRoutesOptions
): void {
  app.post(
    "/v1/authorities/:collectionId/files/control",
    async (request, reply) => {
      const params = collectionParamsSchema.parse(request.params);
      const grant = await authorizedFileGrant(request, options.db, params.collectionId);
      if (!grant) return invalidToken(reply);
      if (!grant.file_capability) {
        return reply.code(403).send(insufficientAccessError(
          ["files"],
          [],
          "The application has no collection file access."
        ));
      }
      if (!grant.encryption) {
        return reply.code(426).send(apiError(
          "encryption_required",
          "Local collection files require grant encryption profile 1."
        ));
      }
      let envelope: EncryptedRelayOperationRequest;
      try {
        envelope = encryptedRelayRequestSchema.parse(
          request.body
        ) as EncryptedRelayOperationRequest;
      } catch {
        return reply.code(426).send(apiError(
          "encryption_required",
          "Local collection files require grant encryption profile 1."
        ));
      }
      if (!matchesGrantEncryption(
        envelope,
        { ...grant, encryption: grant.encryption },
        "file_control"
      )) {
        if (matchesGrantIdentity(envelope, grant, "file_control")) {
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
      try {
        return {
          ok: true,
          envelope: await options.relay.routeEncrypted(grant.connector_id, envelope)
        };
      } catch (error) {
        return relayError(reply, error);
      }
    }
  );

  app.post(
    "/v1/authorities/:collectionId/files/upload",
    { bodyLimit: MAX_FILE_FRAME_BYTES },
    async (request, reply) => {
      const params = collectionParamsSchema.parse(request.params);
      const grant = await authorizedFileGrant(request, options.db, params.collectionId);
      if (!grant) return invalidToken(reply);
      const activeGrant = requireBinaryFileGrant(reply, grant);
      if (!activeGrant) return;
      if (!Buffer.isBuffer(request.body)) {
        return reply.code(415).send(apiError(
          "invalid_file_frame",
          "The request must use application/mdbase-connect-file."
        ));
      }
      let inner: FileFrame;
      try {
        inner = decodeFileFrame(request.body);
      } catch {
        return reply.code(400).send(apiError(
          "invalid_file_frame",
          "The encrypted file frame is invalid."
        ));
      }
      if (inner.kind !== "upload_chunk" || !frameMatchesGrant(inner, activeGrant)) {
        return reply.code(400).send(apiError(
          "invalid_file_frame",
          "The encrypted file frame does not match the active grant."
        ));
      }
      const relayRequest = relayFrame(
        "upload_chunk",
        activeGrant.grant_id,
        inner.header.transfer_id,
        inner.header.chunk_index,
        request.body
      );
      try {
        const response = await options.relay.routeFile(activeGrant.connector_id, relayRequest);
        if (response.kind !== "upload_acknowledged") {
          throw new ConnectorOperationError(
            "invalid_relay_file_response",
            "The connector did not acknowledge the uploaded file chunk."
          );
        }
        return reply.code(204).send();
      } catch (error) {
        return relayError(reply, error);
      }
    }
  );

  app.get(
    "/v1/authorities/:collectionId/files/download/:transferId/:chunkIndex",
    async (request, reply) => {
      const params = downloadParamsSchema.parse(request.params);
      const grant = await authorizedFileGrant(request, options.db, params.collectionId);
      if (!grant) return invalidToken(reply);
      const activeGrant = requireBinaryFileGrant(reply, grant);
      if (!activeGrant) return;
      const relayRequest = relayFrame(
        "download_request",
        activeGrant.grant_id,
        params.transferId,
        params.chunkIndex,
        new Uint8Array()
      );
      try {
        const response = await options.relay.routeFile(activeGrant.connector_id, relayRequest);
        if (response.kind !== "download_chunk") {
          throw new ConnectorOperationError(
            "invalid_relay_file_response",
            "The connector did not return the requested file chunk."
          );
        }
        let inner: FileFrame;
        try {
          inner = decodeFileFrame(response.payload);
        } catch {
          throw new ConnectorOperationError(
            "invalid_relay_file_response",
            "The connector returned an invalid encrypted file frame."
          );
        }
        if (inner.kind !== "download_chunk"
            || inner.header.transfer_id !== params.transferId
            || inner.header.chunk_index !== params.chunkIndex
            || !frameMatchesGrant(inner, activeGrant)) {
          throw new ConnectorOperationError(
            "invalid_relay_file_response",
            "The connector returned a file frame for a different grant or chunk."
          );
        }
        return reply
          .header("content-type", "application/mdbase-connect-file")
          .send(Buffer.from(response.payload));
      } catch (error) {
        return relayError(reply, error);
      }
    }
  );
}

async function authorizedFileGrant(
  request: FastifyRequest,
  db: DatabasePool,
  collectionId: string
): Promise<LocalFileGrant | null> {
  const bearer = bearerToken(request);
  if (!bearer) return null;
  const result = await db.query<LocalFileGrant>(
    `SELECT g.id AS grant_id, g.application_id, g.encryption,
            g.application_authorization->'binding'->'contracts' AS contracts,
            g.file_capability, col.connector_id, col.local_id
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
    [tokenHash(bearer), collectionId]
  );
  return result.rows[0] ?? null;
}

function requireBinaryFileGrant(
  reply: FastifyReply,
  grant: LocalFileGrant
): (LocalFileGrant & { encryption: GrantEncryption }) | null {
  if (!grant.file_capability) {
    reply.code(403).send(insufficientAccessError(
      ["files"],
      [],
      "The application has no collection file access."
    ));
    return null;
  }
  if (!grant.encryption) {
    reply.code(426).send(apiError(
      "encryption_required",
      "Local collection files require grant encryption profile 1."
    ));
    return null;
  }
  return { ...grant, encryption: grant.encryption };
}

function frameMatchesGrant(
  frame: FileFrame,
  grant: LocalFileGrant & { encryption: GrantEncryption }
): boolean {
  const header = frame.header;
  return header.protection === "grant_aead_v1"
    && header.grant_id === grant.grant_id
    && header.authority_id === grant.connector_id
    && header.authority_id === grant.encryption.connector_id
    && header.collection_id === grant.local_id
    && header.collection_id === grant.encryption.collection_id
    && header.scope_epoch === grant.encryption.scope_epoch
    && header.key_id === grant.encryption.key_id;
}

function relayFrame(
  kind: "upload_chunk" | "download_request",
  grantId: string,
  transferId: string,
  chunkIndex: number,
  payload: Uint8Array
): RelayFileFrame {
  return {
    kind,
    header: {
      protocol_version: RELAY_FILE_PROTOCOL_VERSION,
      type: kind,
      request_id: randomUUID(),
      grant_id: grantId,
      transfer_id: transferId,
      chunk_index: chunkIndex
    },
    payload
  };
}

function invalidToken(reply: FastifyReply): unknown {
  return reply.code(401).send(apiError(
    "invalid_token",
    "Access token is invalid or expired."
  ));
}

function relayError(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof RelayUnavailableError) {
    return reply.code(503).send(apiError("connector_offline", error.message));
  }
  if (error instanceof ConnectorOperationError) {
    return reply.code(502).send(apiError(error.code, error.message));
  }
  throw error;
}
