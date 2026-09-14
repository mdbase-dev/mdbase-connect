import type { AccountProfile, CollectionMemberProfile, ApplicationPeopleRequirement } from "@mdbase-dev/connect-protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { resolveHostedCollectionAccess, resolveLocalCollectionAccess } from "../../collection-access.js";
import { matchesMembershipBinding, membershipBindingForAccess } from "../../collection-membership-binding.js";
import type { DatabasePool } from "../../db.js";
import { bearerToken } from "../../platform/request-authentication.js";
import { apiError } from "../../platform/http-errors.js";
import { tokenHash } from "../../security.js";

interface PeopleRoutesOptions {
  db: DatabasePool;
  publicUrl: string;
}

interface PeopleGrant {
  user_id: string;
  name: string;
  collection_id: string | null;
  hosted_collection_id: string | null;
  people: ApplicationPeopleRequirement | null;
  membership_id: string | null;
  membership_policy_id: string | null;
  membership_policy_revision: number | null;
}

/** Identity metadata uses control-plane tokens for hosted AND local collections. */
export function registerPeopleRoutes(app: FastifyInstance, options: PeopleRoutesOptions): void {
  // Stable configured deployment URL, never request Host or an authority/provider URL.
  const issuer = new URL(options.publicUrl).href.replace(/\/$/, "");
  const profile = (user: { user_id: string; name: string }): AccountProfile => ({
    issuer, subject: user.user_id, name: user.name
  });

  for (const permission of ["identity", "members"] as const) {
    app.get(`/v1/authorities/:collectionId/${permission}`, async (request, reply) => {
      reply.header("cache-control", "no-store");
      const { collectionId } = z.object({ collectionId: z.uuid() }).parse(request.params);
      const bearer = bearerToken(request);
      if (!bearer) return reply.code(401).send(apiError("invalid_token", "An application access token is required."));
      const result = await options.db.query<PeopleGrant>(
        `SELECT g.user_id, u.name, g.collection_id, g.hosted_collection_id,
                app.requirements->'people' AS people,
                g.membership_id, g.membership_policy_id, g.membership_policy_revision
         FROM access_tokens tok
         JOIN grants g ON g.id = tok.grant_id
         JOIN users u ON u.id = g.user_id
         JOIN applications app ON app.id = g.application_id
         LEFT JOIN collections col ON col.id = g.collection_id
         LEFT JOIN hosted_replicas replica ON replica.id = g.hosted_replica_id
         WHERE tok.token_hash = $1 AND tok.expires_at > now()
           AND tok.revoked_at IS NULL AND g.revoked_at IS NULL
           AND g.activated_at IS NOT NULL AND u.suspended_at IS NULL
           AND COALESCE(col.local_id, g.hosted_collection_id) = $2
           AND (g.collection_id IS NULL OR (col.enabled = true AND col.present = true))
           AND (g.hosted_replica_id IS NULL OR replica.revoked_at IS NULL)
           AND g.application_authorization->'binding'->>'application_manifest_digest' = app.manifest_digest`,
        [tokenHash(bearer), collectionId]
      );
      const grant = result.rows[0];
      if (!grant) return reply.code(401).send(apiError("invalid_token", "The application authorization is no longer active."));
      // This is required consent in the exact immutable, signed manifest. No new
      // scope is inferred from collection.read or a predecessor declaration.
      if (grant.people?.version !== 1 || !grant.people.permissions.includes(permission)) {
        return reply.code(403).send(apiError("insufficient_access", "This application was not approved to read this identity information."));
      }
      const access = grant.hosted_collection_id
        ? await resolveHostedCollectionAccess(options.db, grant.user_id, grant.hosted_collection_id)
        : grant.collection_id
          ? await resolveLocalCollectionAccess(options.db, grant.user_id, grant.collection_id)
          : null;
      if (!access || access.collection.authorityState !== "active"
        || !access.actions.has("application.authorize")
        || !matchesMembershipBinding(grant, membershipBindingForAccess(access))) {
        return reply.code(401).send(apiError("invalid_token", "Current collection membership no longer permits this authorization."));
      }
      if (permission === "identity") return profile(grant);

      const owner = await options.db.query<{ user_id: string; name: string }>(
        "SELECT id AS user_id, name FROM users WHERE id = $1 AND suspended_at IS NULL",
        [access.collection.ownerUserId]
      );
      const members: CollectionMemberProfile[] = owner.rows.map((row) => ({ ...profile(row), role: "owner" }));
      if (grant.hosted_collection_id) {
        const rows = await options.db.query<{ user_id: string; name: string; role: "viewer" | "editor" }>(
          `SELECT membership.user_id, account.name, policy.role
           FROM collection_memberships membership
           JOIN users account ON account.id = membership.user_id
           JOIN collection_membership_policies policy ON policy.id = membership.current_policy_id
           WHERE membership.collection_id = $1 AND membership.state = 'active'
             AND membership.revoked_at IS NULL AND account.suspended_at IS NULL
           ORDER BY membership.accepted_at, membership.id`,
          [grant.hosted_collection_id]
        );
        members.push(...rows.rows.map((row) => ({ ...profile(row), role: row.role })));
      }
      return { members };
    });
  }
}
