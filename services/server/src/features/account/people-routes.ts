import type { AccountProfile, CollectionMemberProfile, CurrentAccountResponse, PeoplePermission } from "@mdbase-dev/connect-protocol";
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
  /** Validated runtime identity issuer; never derived from request or routing URLs. */
  issuer: string;
  publicUrl: string;
  editorOrigin?: string;
}

interface PeopleGrant {
  user_id: string;
  public_subject: string;
  name: string;
  collection_id: string | null;
  local_collection_id: string | null;
  hosted_collection_id: string | null;
  people_permissions: PeoplePermission[] | null;
  membership_id: string | null;
  membership_policy_id: string | null;
  membership_policy_revision: number | null;
}

/** Identity metadata uses control-plane tokens for hosted AND local collections. */
export function registerPeopleRoutes(app: FastifyInstance, options: PeopleRoutesOptions): void {
  const { issuer } = options;
  const profile = (user: { public_subject: string; name: string }): AccountProfile => ({
    issuer, subject: user.public_subject, name: user.name
  });

  for (const permission of ["identity", "members"] as const) {
    app.get(`/v1/authorities/:collectionId/${permission}`, async (request, reply) => {
      reply.header("cache-control", "no-store");
      const { collectionId } = z.object({ collectionId: z.uuid() }).parse(request.params);
      const bearer = bearerToken(request);
      if (!bearer) return reply.code(401).send(apiError("invalid_token", "An application access token is required."));
      const result = await options.db.query<PeopleGrant>(
        `SELECT g.user_id, u.public_subject, u.name, g.collection_id,
                col.local_id AS local_collection_id, g.hosted_collection_id,
                g.people_permissions,
                g.membership_id, g.membership_policy_id, g.membership_policy_revision
         FROM access_tokens tok
         JOIN grants g ON g.id = tok.grant_id
         JOIN users u ON u.id = g.user_id
         JOIN applications app ON app.id = g.application_id
         LEFT JOIN collections col ON col.id = g.collection_id
         LEFT JOIN hosted_replicas replica ON replica.id = g.hosted_replica_id
         WHERE tok.token_hash = $1 AND tok.expires_at > now()
           AND tok.revoked_at IS NULL AND g.revoked_at IS NULL
           AND g.activated_at IS NOT NULL AND g.reauthorization_required_at IS NULL
           AND u.suspended_at IS NULL
           AND COALESCE(col.local_id, g.hosted_collection_id) = $2
           AND (g.collection_id IS NULL OR (col.enabled = true AND col.present = true))
           AND (g.hosted_replica_id IS NULL OR (replica.id IS NOT NULL AND replica.revoked_at IS NULL))
           AND g.application_authorization->'binding'->>'application_manifest_digest' = app.manifest_digest`,
        [tokenHash(bearer), collectionId]
      );
      const grant = result.rows[0];
      if (!grant) return reply.code(401).send(apiError("invalid_token", "The application authorization is no longer active."));
      // The grant records what the user approved from the exact signed
      // declaration. Nothing is inferred from collection.read or old grants.
      if (!grant.people_permissions?.includes(permission)) {
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
      if (permission === "identity") {
        const settingsUrl = personSettingsUrl(options, grant.hosted_collection_id ?? grant.local_collection_id);
        return {
          ...profile(grant),
          ...(settingsUrl ? { person_settings_url: settingsUrl } : {})
        } satisfies CurrentAccountResponse;
      }

      const owner = await options.db.query<{ public_subject: string; name: string }>(
        "SELECT public_subject, name FROM users WHERE id = $1 AND suspended_at IS NULL",
        [access.collection.ownerUserId]
      );
      const members: CollectionMemberProfile[] = owner.rows.map((row) => ({ ...profile(row), role: "owner" }));
      if (grant.hosted_collection_id) {
        const rows = await options.db.query<{ public_subject: string; name: string; role: "viewer" | "editor" }>(
          `SELECT account.public_subject, account.name, policy.role
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

/** A navigation route that may change freely; apps must never derive it from the issuer. */
function personSettingsUrl(options: PeopleRoutesOptions, collectionId: string | null): string | null {
  if (!options.editorOrigin || !collectionId) return null;
  const url = new URL("/", options.editorOrigin);
  url.searchParams.set("server", new URL(options.publicUrl).origin);
  url.searchParams.set("collection", collectionId);
  url.searchParams.set("surface", "settings");
  url.hash = "your-person";
  return url.href;
}
