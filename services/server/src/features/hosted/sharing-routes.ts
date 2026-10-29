import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CollectionAccessDeniedError } from "../../collection-access.js";
import {
  acceptHostedCollectionInvitation,
  CollectionInvitationError,
  createCollectionInvitationCode,
  createHostedCollectionInvitation,
  listHostedCollectionInvitations,
  listHostedCollectionMembers,
  revokeHostedCollectionInvitation
} from "../../collection-invitations.js";
import {
  changeHostedCollectionMembershipRole,
  revokeHostedCollectionMembership
} from "../../collection-membership-lifecycle.js";
import { COLLECTION_MEMBERSHIP_ROLES } from "../../collection-policy.js";
import type { DatabasePool } from "../../db.js";
import { requireUser } from "../../platform/request-authentication.js";
import { apiError } from "../../platform/http-errors.js";
import type { PolicyEmitter } from "../next/policy-outbox.js";

interface HostedSharingRoutesOptions {
  db: DatabasePool;
  hostedCollections?: boolean;
  hostedSharing?: boolean;
  tailscaleAuth?: boolean;
  nativePolicyEmitter?: Pick<PolicyEmitter, "publishCommitted">;
}

const collectionParams = z.object({ collectionId: z.uuid() });
const invitationParams = collectionParams.extend({ invitationId: z.uuid() });
const membershipParams = collectionParams.extend({ membershipId: z.uuid() });
const roleSchema = z.enum(COLLECTION_MEMBERSHIP_ROLES);

export function registerHostedSharingRoutes(
  app: FastifyInstance,
  options: HostedSharingRoutesOptions
): void {
  app.post(
    "/v1/hosted/collection-invitation-codes",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
      if (!user) return;
      requireHostedSharing(options, true);
      const created = await createCollectionInvitationCode(options.db, user.id);
      return reply.header("cache-control", "no-store").code(201).send({
        invitation_code: created.code,
        expires_at: created.expiresAt
      });
    }
  );

  app.post(
    "/v1/hosted/collections/:collectionId/invitations",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
      if (!user) return;
      requireHostedSharing(options, true);
      const { collectionId } = collectionParams.parse(request.params);
      const body = z
        .union([
          z.object({ email: z.string().trim().min(3).max(320), role: roleSchema }).strict(),
          z.object({ invitee_code: z.string().trim().min(8).max(32), role: roleSchema }).strict()
        ])
        .parse(request.body);
      const invitation = await createHostedCollectionInvitation(options.db, {
        collectionId,
        actorUserId: user.id,
        role: body.role,
        target: "email" in body ? { email: body.email } : { inviteeCode: body.invitee_code }
      });
      return reply
        .header("cache-control", "no-store")
        .code(202)
        .send({
          invitation: {
            id: invitation.id,
            collection_id: invitation.collectionId,
            target_mode: invitation.targetMode,
            submitted_email: invitation.submittedEmail,
            role: invitation.role,
            state: invitation.state,
            expires_at: invitation.expiresAt,
            token: invitation.token
          }
        });
    }
  );

  app.get("/v1/hosted/collections/:collectionId/invitations", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    requireHostedSharing(options);
    const { collectionId } = collectionParams.parse(request.params);
    reply.header("cache-control", "no-store");
    return {
      invitations: await listHostedCollectionInvitations(options.db, user.id, collectionId)
    };
  });

  app.delete(
    "/v1/hosted/collections/:collectionId/invitations/:invitationId",
    async (request, reply) => {
      const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
      if (!user) return;
      requireHostedSharing(options);
      const { collectionId, invitationId } = invitationParams.parse(request.params);
      const revoked = await revokeHostedCollectionInvitation(options.db, {
        collectionId,
        actorUserId: user.id,
        invitationId
      });
      if (!revoked) throw sharingNotFound();
      return reply.code(204).send();
    }
  );

  app.post(
    "/v1/hosted/collection-invitations/accept",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
      if (!user) return;
      requireHostedSharing(options, true);
      const { token } = z
        .object({
          token: z.string().trim().min(16).max(256)
        })
        .strict()
        .parse(request.body);
      // Typed migration refusals and Retry-After belong to the shared handler.
      reply.header("cache-control", "no-store");
      const accepted = await acceptHostedCollectionInvitation(options.db, {
        userId: user.id,
        token
      });
      // Acceptance is committed even if publication is temporarily unavailable;
      // wait for the existing bounded publisher without making the consumed link fail.
      await publishMembershipPolicy(options, accepted.collectionId);
      return reply.code(201).send({
        membership: {
          id: accepted.membershipId,
          collection_id: accepted.collectionId,
          role: accepted.role,
          state: "active"
        }
      });
    }
  );

  app.get("/v1/hosted/collections/:collectionId/members", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    requireHostedSharing(options);
    const { collectionId } = collectionParams.parse(request.params);
    reply.header("cache-control", "no-store");
    // Authorize first. A concurrent committed removal must not be reported as
    // gone to its owner before the log has fenced subsequent content writes.
    const members = await listHostedCollectionMembers(options.db, user.id, collectionId);
    if (!await publishMembershipPolicy(options, collectionId)) {
      return reply.header("retry-after", "2").code(503).send(
        apiError("collection_sharing_unavailable", "Member changes are not yet confirmed. Retry the request.")
      );
    }
    return { members };
  });

  app.patch(
    "/v1/hosted/collections/:collectionId/members/:membershipId",
    async (request, reply) => {
      const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
      if (!user) return;
      requireHostedSharing(options);
      const { collectionId, membershipId } = membershipParams.parse(request.params);
      const { role } = z.object({ role: roleSchema }).strict().parse(request.body);
      if (role === "editor") requireHostedSharing(options, true);
      const changed = await hideMembershipAuthorization(() =>
        changeHostedCollectionMembershipRole(options.db, {
          collectionId,
          actorUserId: user.id,
          membershipId,
          role
        })
      );
      return reply.code(changed.state === "changing" ? 202 : 200).send({
        membership: {
          id: changed.membershipId,
          state: changed.state,
          role,
          policy_revision: changed.policyRevision,
          pending_provider_revocations: changed.pendingProviderRevocations
        }
      });
    }
  );

  app.delete(
    "/v1/hosted/collections/:collectionId/members/:membershipId",
    async (request, reply) => {
      const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
      if (!user) return;
      requireHostedSharing(options);
      const { collectionId, membershipId } = membershipParams.parse(request.params);
      const revoked = await hideMembershipAuthorization(() =>
        revokeHostedCollectionMembership(options.db, {
          collectionId,
          actorUserId: user.id,
          membershipId
        })
      );
      // Database revocation alone does not fence the log's next content append.
      // Repeat this barrier even for an idempotent already-revoked membership:
      // a previous request may have committed but not confirmed publication.
      if (!await publishMembershipPolicy(options, collectionId)) {
        return reply.header("retry-after", "2").code(503).send(
          apiError("collection_sharing_unavailable", "Member removal is not yet confirmed. Retry the request.")
        );
      }
      return reply.code(revoked.state === "revoking" ? 202 : 200).send({
        membership: {
          id: revoked.membershipId,
          state: revoked.state,
          pending_provider_revocations: revoked.pendingProviderRevocations
        }
      });
    }
  );
}

async function publishMembershipPolicy(options: HostedSharingRoutesOptions, collectionId: string): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const native = await options.db.query(
      "SELECT collection_id FROM next_collections WHERE collection_id = $1", [collectionId]
    );
    if (!native.rows.length) return true;
    if (!options.nativePolicyEmitter) return false;
    // Bound the request, not the emitter-owned append. Uncertain publication
    // keeps its original durable bytes and is retried by the same producer.
    await Promise.race([
      options.nativePolicyEmitter.publishCommitted(collectionId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("policy publication deferred")), 8_000);
        timer.unref();
      })
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requireHostedSharing(options: HostedSharingRoutesOptions, admission = false): void {
  if (!options.hostedCollections || (admission && !options.hostedSharing)) throw sharingNotFound();
}

async function hideMembershipAuthorization<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CollectionAccessDeniedError) throw sharingNotFound();
    throw error;
  }
}

function sharingNotFound(): CollectionInvitationError {
  return new CollectionInvitationError(
    "collection_sharing_not_found",
    "Collection sharing is unavailable."
  );
}
