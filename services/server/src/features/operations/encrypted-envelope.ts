import type {
  EncryptedRelayOperation,
  EncryptedRelayOperationRequest,
  GrantEncryption
} from "@mdbase-dev/connect-protocol";
import {
  ENCRYPTED_RELAY_PROTOCOL_VERSION,
  RELAY_ENCRYPTION_SUITE
} from "@mdbase-dev/connect-protocol";
import { z } from "zod";
import { COLLECTION_OPERATIONS } from "../../collection-access.js";

export const encryptedRelayRequestSchema = z.object({
  type: z.literal("encrypted_operation_request"),
  protocol_version: z.literal(ENCRYPTED_RELAY_PROTOCOL_VERSION),
  suite: z.literal(RELAY_ENCRYPTION_SUITE),
  request_id: z.uuid(),
  grant_id: z.uuid(),
  application_id: z.uuid(),
  connector_id: z.uuid(),
  collection_id: z.uuid(),
  operation: z.enum([
    ...COLLECTION_OPERATIONS,
    "file_control"
  ] satisfies [EncryptedRelayOperation, ...EncryptedRelayOperation[]]),
  scope_epoch: z.number().int().positive(),
  key_id: z.string().min(1).max(200),
  counter: z.string().regex(/^[1-9][0-9]{0,19}$/),
  ciphertext: z.string()
    .min(1)
    .max(2_800_000)
    .regex(/^[A-Za-z0-9_-]+$/)
}).strict();

interface GrantIdentity {
  grant_id: string;
  application_id: string;
  connector_id: string;
  local_id: string;
}

export function matchesGrantEncryption(
  envelope: EncryptedRelayOperationRequest,
  grant: GrantIdentity & { encryption: GrantEncryption },
  operation: EncryptedRelayOperation
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

export function matchesGrantIdentity(
  envelope: EncryptedRelayOperationRequest,
  grant: GrantIdentity,
  operation: EncryptedRelayOperation
): boolean {
  return envelope.protocol_version === ENCRYPTED_RELAY_PROTOCOL_VERSION
    && envelope.suite === RELAY_ENCRYPTION_SUITE
    && envelope.grant_id === grant.grant_id
    && envelope.application_id === grant.application_id
    && envelope.connector_id === grant.connector_id
    && envelope.collection_id === grant.local_id
    && envelope.operation === operation;
}
