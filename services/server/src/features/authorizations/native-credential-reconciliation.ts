// First slice: immutable native token-completion metadata, NOT a credential
// reconciliation endpoint, replay mechanism or native admission certificate.
import { isDeepStrictEqual } from "node:util";
import { parseApplicationAuthorization, ApplicationAuthorizationError } from "../../application-authorization.js";
import type { DatabaseQueryable } from "../../database-types.js";
import { RequestValidationError } from "../../platform/http-errors.js";
import { isP256PublicKey } from "../../security.js";
import { verifiedClientNoiseKey } from "../next/client-key.js";
import { normalizedApplicationOrigin } from "./redirects.js";

export interface NativeTokenCompletion {
  version: 1;
  account_id: string;
  authorization_request_id: string;
  application_id: string;
  application_declaration_id: string;
  application_manifest_digest: string;
  application_installation_id: string;
  application_origin: string;
  collection_id: string;
  grant_id: string;
  grant_signing_public_key: string;
  client_noise_public_key: string;
}

/** Original approved rows in one joined read; no new authority lock order. */
export async function nativeTokenCompletion(
  db: DatabaseQueryable,
  grantId: string,
  expected: { accountId: string; collectionId: string; origin: string }
): Promise<NativeTokenCompletion> {
  const rows = await db.query<{
    user_id: string;
    application_id: string;
    next_collection_id: string;
    application_installation_id: string | null;
    application_authorization: unknown;
    proof_public_key: string | null;
    application_origin: string;
    request_id: string;
    request_user_id: string | null;
    request_application_id: string;
    request_installation_id: string | null;
    request_authorization: unknown;
    request_signing_key: string | null;
    request_agreement_key: string | null;
    request_collection_id: string | null;
    request_flow: string;
    request_redirect_uri: string | null;
    request_state: string | null;
    request_code_challenge: string | null;
    request_noise_key: Buffer | null;
    request_attestation: Buffer | null;
    grant_noise_key: Buffer | null;
    grant_attestation: Buffer | null;
  }>(
    `SELECT g.user_id, g.application_id, g.next_collection_id,
            g.application_installation_id, g.application_authorization,
            g.proof_public_key, g.application_origin,
            ar.id AS request_id, ar.user_id AS request_user_id,
            ar.application_id AS request_application_id,
            ar.application_installation_id AS request_installation_id,
            ar.application_authorization AS request_authorization,
            ar.application_signing_public_key AS request_signing_key,
            ar.application_agreement_public_key AS request_agreement_key,
            ar.collection_id AS request_collection_id, ar.flow AS request_flow,
            ar.redirect_uri AS request_redirect_uri, ar.state AS request_state,
            ar.code_challenge AS request_code_challenge,
            ck.client_pk AS request_noise_key, ck.signature AS request_attestation,
            gk.client_pk AS grant_noise_key, gk.signature AS grant_attestation
     FROM grants g
     JOIN authorization_requests ar ON ar.grant_id = g.id
       AND ar.id::text = g.application_authorization->'binding'->>'authorization_id'
     LEFT JOIN next_authorization_client_keys ck ON ck.request_id = ar.id
     LEFT JOIN next_grant_client_keys gk ON gk.grant_id = g.id
     WHERE g.id = $1 AND g.next_collection_id = $2
       AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
       AND ar.completed_at IS NOT NULL AND ar.denied_at IS NULL`,
    [grantId, expected.collectionId]
  );
  const fail = () => new RequestValidationError("The native grant does not match its original approved authorization.");
  const row = rows.rows[0];
  if (rows.rows.length !== 1 || !row) throw fail();
  try {
    // Parse the retained shape, not fresh-at-now: completed request/proof expiry
    // is NOT the lifetime of the independently current approved grant.
    const proof = parseApplicationAuthorization(row.application_authorization);
    const requestProof = parseApplicationAuthorization(row.request_authorization);
    const binding = proof.binding;
    const origin = normalizedApplicationOrigin(row.application_origin);
    if (
      row.user_id !== expected.accountId || row.request_user_id !== row.user_id
      || row.application_id !== row.request_application_id || binding.application_id !== row.application_id
      || row.request_id !== binding.authorization_id
      || row.application_installation_id !== binding.application_installation_id
      || row.request_installation_id !== binding.application_installation_id
      || row.proof_public_key !== binding.grant_signing_public_key
      || row.request_signing_key !== binding.grant_signing_public_key
      || row.request_agreement_key !== binding.grant_agreement_public_key
      || !isP256PublicKey(binding.grant_signing_public_key)
      || !isDeepStrictEqual(proof, requestProof)
      || row.next_collection_id !== expected.collectionId
      || row.request_collection_id !== (binding.collection_id ?? null)
      || (binding.collection_id !== undefined && binding.collection_id !== row.next_collection_id)
      || row.request_flow !== "authorization_code" || binding.flow !== row.request_flow
      || !binding.redirect_uri || row.request_redirect_uri !== binding.redirect_uri
      || row.request_state !== (binding.state ?? null)
      || row.request_code_challenge !== binding.code_challenge
      || origin !== expected.origin || origin !== normalizedApplicationOrigin(new URL(binding.redirect_uri).origin)
      || !row.request_noise_key || !row.grant_noise_key
      || !row.request_attestation || !row.grant_attestation
      || !row.request_noise_key.equals(row.grant_noise_key)
      || !row.request_attestation.equals(row.grant_attestation)
    ) throw fail();
    const noise = verifiedClientNoiseKey(JSON.stringify({
      public_key: row.request_noise_key.toString("base64url"),
      signature: row.request_attestation.toString("base64url")
    }), binding);
    if (!noise) throw fail();
    return {
      version: 1,
      account_id: row.user_id,
      authorization_request_id: row.request_id,
      application_id: row.application_id,
      application_declaration_id: binding.application_declaration_id,
      application_manifest_digest: binding.application_manifest_digest,
      application_installation_id: binding.application_installation_id,
      application_origin: origin,
      collection_id: row.next_collection_id,
      grant_id: grantId, // AUTHORIZATION grant, never the policy-log/IK alias.
      grant_signing_public_key: binding.grant_signing_public_key,
      client_noise_public_key: noise.publicKey.toString("base64url")
    };
  } catch (error) {
    if (error instanceof ApplicationAuthorizationError || error instanceof TypeError) throw fail();
    throw error;
  }
}
