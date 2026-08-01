import { randomUUID } from "node:crypto";
import type { GrantEncryption, GrantScope } from "@mdbase-dev/connect-protocol";
import {
  requireCollectionAction,
  resolveHostedCollectionAccess,
  resolveLocalCollectionAccess
} from "../../collection-access.js";
import type { DatabaseQueryable } from "../../db.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import { randomToken, tokenHash } from "../../security.js";
import { authorityUrl } from "../../platform/authority-url.js";
import { RequestValidationError } from "../../platform/http-errors.js";
import { normalizedApplicationOrigin } from "./redirects.js";

export async function issueApplicationTokens(
  db: DatabaseQueryable,
  hostedProvider: HostedProviderClient | undefined,
  grantId: string
): Promise<{
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_expires_in: number;
  collection_id: string;
  collection_name: string;
  operations: string[];
  scope: GrantScope;
  grant_id: string;
  encryption: GrantEncryption | null;
  application_origin: string;
  authority?: {
    operations_url: string;
    sync_url: string;
    replica_id: string;
    access_token: string;
    proof_public_key?: string;
  };
}> {
  const grant = await db.query<{
    user_id: string;
    collection_id: string;
    local_authority_row_id: string | null;
    collection_name: string;
    hosted_collection_id: string | null;
    hosted_replica_id: string | null;
    provider_url: string | null;
    operations: string[];
    scope: GrantScope;
    encryption: GrantEncryption | null;
    proof_public_key: string | null;
    application_origin: string;
  }>(
    `SELECT g.user_id,
            COALESCE(col.local_id, g.hosted_collection_id) AS collection_id,
            g.collection_id AS local_authority_row_id,
            COALESCE(col.display_name, hosted.display_name) AS collection_name,
            g.hosted_collection_id, g.hosted_replica_id, hosted.provider_url,
            g.operations, g.scope, g.encryption, g.proof_public_key,
            CASE WHEN g.application_origin = '' THEN app.homepage
                 ELSE g.application_origin END AS application_origin
     FROM grants g
     JOIN users u ON u.id = g.user_id
     JOIN applications app ON app.id = g.application_id
     LEFT JOIN collections col ON col.id = g.collection_id
     LEFT JOIN hosted_collections hosted ON hosted.id = g.hosted_collection_id
     LEFT JOIN hosted_replicas replica ON replica.id = g.hosted_replica_id
     WHERE g.id = $1 AND g.revoked_at IS NULL
       AND g.activated_at IS NOT NULL
       AND u.suspended_at IS NULL
       AND (g.hosted_replica_id IS NULL OR replica.revoked_at IS NULL)`,
    [grantId]
  );
  if (!grant.rows[0]) throw new RequestValidationError("The application grant is no longer active.");
  if (grant.rows[0].hosted_collection_id) {
    requireCollectionAction(
      await resolveHostedCollectionAccess(
        db,
        grant.rows[0].user_id,
        grant.rows[0].hosted_collection_id
      ),
      "application.authorize"
    );
  } else if (grant.rows[0].local_authority_row_id) {
    requireCollectionAction(
      await resolveLocalCollectionAccess(
        db,
        grant.rows[0].user_id,
        grant.rows[0].local_authority_row_id
      ),
      "application.authorize"
    );
  }
  const accessToken = randomToken("mdb");
  const refreshToken = randomToken("ref");
  let authority: {
    operations_url: string;
    sync_url: string;
    replica_id: string;
    access_token: string;
    proof_public_key?: string;
  } | undefined;
  if (grant.rows[0].hosted_collection_id) {
    if (!hostedProvider || !grant.rows[0].hosted_replica_id || !grant.rows[0].provider_url) {
      throw new RequestValidationError("The hosted application capability is unavailable.");
    }
    const providerToken = randomToken("hsa");
    await hostedProvider.rotateReplicaToken(grant.rows[0].hosted_replica_id, providerToken, 3_600);
    authority = {
      operations_url: authorityUrl(
        grant.rows[0].provider_url,
        grant.rows[0].collection_id,
        "operations"
      ),
      sync_url: authorityUrl(
        grant.rows[0].provider_url,
        grant.rows[0].collection_id,
        "sync"
      ),
      replica_id: grant.rows[0].hosted_replica_id,
      access_token: providerToken,
      ...(grant.rows[0].proof_public_key
        ? { proof_public_key: grant.rows[0].proof_public_key }
        : {})
    };
  }
  await db.query(
    `INSERT INTO access_tokens (id, token_hash, grant_id, expires_at)
     VALUES ($1, $2, $3, now() + interval '1 hour')`,
    [randomUUID(), tokenHash(accessToken), grantId]
  );
  await db.query(
    `INSERT INTO refresh_tokens (id, token_hash, grant_id, expires_at)
     VALUES ($1, $2, $3, now() + interval '30 days')`,
    [randomUUID(), tokenHash(refreshToken), grantId]
  );
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_expires_in: 30 * 24 * 60 * 60,
    collection_id: grant.rows[0].collection_id,
    collection_name: grant.rows[0].collection_name,
    operations: grant.rows[0].operations,
    scope: grant.rows[0].scope,
    grant_id: grantId,
    encryption: grant.rows[0].encryption,
    application_origin: normalizedApplicationOrigin(grant.rows[0].application_origin),
    ...(authority ? { authority } : {})
  };
}
