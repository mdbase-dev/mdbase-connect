import { validateGrantEncryption } from "./crypto.js";
import { connectError } from "./errors.js";
import type { StoredToken } from "./internal-types.js";
import {
  parseGrantScope,
  validAuthorityTokenResponse,
  validFileCapability
} from "./runtime-utils.js";

interface StoredTokenResponseOptions {
  body: any;
  clientId: string;
  keyHandle?: string;
  previous: StoredToken | null;
  defaultApplicationOrigin: string;
  pinConnectorIdentity(connectorId: string, publicKey: string): void;
}

export function storedTokenFromResponse({
  body,
  clientId,
  keyHandle,
  previous,
  defaultApplicationOrigin,
  pinConnectorIdentity
}: StoredTokenResponseOptions): StoredToken {
  const collectionId = body.collection_id;
  if (typeof collectionId !== "string") {
    throw connectError("invalid_token_response", "Authorization returned no collection ID.");
  }
  const scope = parseGrantScope(body.scope);
  if (!scope) {
    throw connectError(
      "invalid_token_response",
      "Authorization returned no valid collection scope."
    );
  }
  if (body.authority && !validAuthorityTokenResponse(body.authority, collectionId)) {
    throw connectError(
      "invalid_token_response",
      "Authorization returned an invalid remote authority capability."
    );
  }
  if (body.authority && body.encryption) {
    throw connectError(
      "invalid_token_response",
      "Authorization returned conflicting collection transports."
    );
  }
  if (body.file_capability !== null && body.file_capability !== undefined
      && !validFileCapability(body.file_capability)) {
    throw connectError(
      "invalid_token_response",
      "Authorization returned an invalid file capability."
    );
  }
  if (body.encryption) {
    try {
      validateGrantEncryption(body.encryption);
    } catch {
      throw connectError(
        "invalid_token_response",
        "Authorization returned an invalid encrypted relay binding."
      );
    }
    pinConnectorIdentity(
      body.encryption.connector_id,
      body.encryption.connector_agreement_public_key
    );
    if (
      body.encryption.collection_id !== collectionId
      || typeof body.grant_id !== "string"
      || body.grant_id.length === 0
    ) {
      throw connectError(
        "invalid_token_response",
        "Authorization returned an encrypted relay binding for another grant."
      );
    }
  }
  if (
    previous?.encryption
    && body.encryption
    && previous.keyHandle
    && previous.keyHandle === keyHandle
    && (
      previous.grantId !== body.grant_id
      || previous.encryption.connector_id !== body.encryption.connector_id
      || previous.encryption.connector_agreement_public_key
        !== body.encryption.connector_agreement_public_key
      || previous.encryption.application_agreement_public_key
        !== body.encryption.application_agreement_public_key
    )
  ) {
    throw connectError(
      "connector_identity_changed",
      "The connector identity changed during authorization renewal. Reauthorize before sending collection data."
    );
  }
  return {
    version: 1,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    clientId,
    collectionId,
    collectionName: body.collection_name ?? `Collection ${collectionId.slice(0, 8)}`,
    operations: body.operations,
    scope,
    expiresAt: Date.now() + body.expires_in * 1_000,
    refreshExpiresAt: body.refresh_expires_in
      ? Date.now() + body.refresh_expires_in * 1_000
      : undefined,
    grantId: body.grant_id,
    encryption: body.encryption ?? undefined,
    fileCapability: body.file_capability ?? undefined,
    applicationOrigin: body.application_origin ?? defaultApplicationOrigin,
    keyHandle,
    savedAt: Date.now(),
    authority: body.authority ? {
      operationsUrl: body.authority.operations_url,
      syncUrl: body.authority.sync_url,
      filesUrl: body.authority.files_url,
      replicaId: body.authority.replica_id,
      accessToken: body.authority.access_token,
      proofPublicKey: body.authority.proof_public_key
    } : undefined
  };
}
