import {
  COLLECTION_OPERATIONS,
  type CollectionOperation,
  type FileCapability,
  type GrantScope
} from "@mdbase-dev/connect-protocol";
import type { DatabaseQueryable } from "./db.js";
import {
  resolveHostedCollection,
  resolveLocalCollection,
  type CollectionLocator
} from "./collection-catalog.js";
import {
  COLLECTION_ACTIONS,
  resolveActiveMembershipPolicy,
  type CollectionAction,
  type CollectionMembershipPolicy,
  type CollectionRole
} from "./collection-policy.js";

export { COLLECTION_ACTIONS, COLLECTION_OPERATIONS };
export type { CollectionAction, CollectionRole };

export interface CollectionAccessContext {
  collection: CollectionLocator;
  userId: string;
  relationship: "owner" | "member";
  role: CollectionRole;
  membershipId: string | null;
  policyId: string | null;
  policyRevision: number;
  actions: ReadonlySet<CollectionAction>;
  operationCeiling: ReadonlySet<CollectionOperation>;
  scopeCeiling: GrantScope;
  fileCeiling: FileCapability;
}

export interface CollectionAccessView {
  relationship: "owner" | "member";
  role: CollectionRole;
  can_authorize_applications: boolean;
  can_manage_collection: boolean;
  can_rename_collection: boolean;
  can_delete_collection: boolean;
  can_manage_members: boolean;
}

const OWNER_ACTIONS: ReadonlySet<CollectionAction> = new Set(COLLECTION_ACTIONS);
const OWNER_OPERATIONS: ReadonlySet<CollectionOperation> = new Set(
  COLLECTION_OPERATIONS
);
const OWNER_FILE_CEILING: FileCapability = {
  kind: "files",
  protocol_version: 1,
  actions: ["list", "read", "add", "replace", "move", "delete"],
  scope: { kind: "collection" }
};

export async function resolveHostedCollectionAccess(
  db: DatabaseQueryable,
  userId: string,
  collectionId: string
): Promise<CollectionAccessContext | null> {
  const collection = await resolveHostedCollection(db, collectionId);
  if (!collection) return null;
  if (collection.locator.ownerUserId === userId) {
    return ownerAccess(collection.locator, userId);
  }
  if (collection.locator.authorityState !== "active") return null;
  const policy = await resolveActiveMembershipPolicy(db, {
    collectionId: collection.locator.collectionId,
    ownerUserId: collection.locator.ownerUserId,
    userId
  });
  return policy ? memberAccess(collection.locator, policy) : null;
}

export async function resolveLocalCollectionAccess(
  db: DatabaseQueryable,
  userId: string,
  authorityRowId: string
): Promise<CollectionAccessContext | null> {
  const collection = await resolveLocalCollection(db, authorityRowId);
  if (!collection || collection.ownerUserId !== userId) return null;
  return ownerAccess(collection, userId);
}

export function requireCollectionAction(
  access: CollectionAccessContext | null,
  action: CollectionAction
): CollectionAccessContext {
  if (!access || !access.actions.has(action)) {
    throw new CollectionAccessDeniedError(action);
  }
  return access;
}

export function accessView(
  access: CollectionAccessContext
): CollectionAccessView {
  const canRename = access.actions.has("collection.rename");
  const canDelete = access.actions.has("collection.delete");
  return {
    relationship: access.relationship,
    role: access.role,
    can_authorize_applications: access.actions.has("application.authorize"),
    can_manage_collection: canRename && canDelete,
    can_rename_collection: canRename,
    can_delete_collection: canDelete,
    can_manage_members: access.actions.has("members.manage")
  };
}

export function ownerAccess(
  collection: CollectionLocator,
  userId: string
): CollectionAccessContext {
  return {
    collection,
    userId,
    relationship: "owner",
    role: "owner",
    membershipId: null,
    policyId: null,
    policyRevision: collection.authorityEpoch,
    actions: OWNER_ACTIONS,
    operationCeiling: OWNER_OPERATIONS,
    scopeCeiling: { access: "full_collection", contracts: [] },
    fileCeiling: structuredClone(OWNER_FILE_CEILING)
  };
}

export function memberAccess(
  collection: CollectionLocator,
  policy: CollectionMembershipPolicy
): CollectionAccessContext {
  return {
    collection,
    userId: policy.userId,
    relationship: "member",
    role: policy.role,
    membershipId: policy.membershipId,
    policyId: policy.id,
    policyRevision: policy.revision,
    actions: new Set(policy.actions),
    operationCeiling: new Set(policy.operations),
    scopeCeiling: structuredClone(policy.scopeCeiling),
    fileCeiling: structuredClone(policy.fileCeiling)
  };
}

export class CollectionAccessDeniedError extends Error {
  constructor(readonly action: CollectionAction) {
    super(`Collection access does not permit ${action}.`);
    this.name = "CollectionAccessDeniedError";
  }
}

type LocalCollectionUnavailableReason = "claimed_by_newer_runtime" | "paused";

const UNAVAILABLE_MESSAGES: Record<LocalCollectionUnavailableReason, string> = {
  claimed_by_newer_runtime:
    "This collection is now managed by a newer mdbase runtime on its computer.",
  paused: "This collection is paused on its computer."
};

/**
 * The `collection_unavailable` error for a local collection that rejects an
 * otherwise valid access token, or null when the token is not valid for it at
 * all. Routes then report an unavailable collection instead of calling a valid
 * token invalid; only a holder of a live grant for that collection learns the
 * reason. Removal and authority moves revoke grants in the same transaction,
 * so they remain invalid tokens.
 */
export async function localCollectionUnavailableError(
  db: DatabaseQueryable,
  tokenDigest: string,
  localId: string
) {
  const result = await db.query<{
    enabled: boolean;
    present: boolean;
    authority_state: string;
    unavailable_reason: string | null;
  }>(
    `SELECT col.enabled, col.present, col.authority_state, col.unavailable_reason
     FROM access_tokens tok
     JOIN grants g ON g.id = tok.grant_id
     JOIN users u ON u.id = g.user_id
     JOIN collections col ON col.id = g.collection_id
     WHERE tok.token_hash = $1 AND tok.expires_at > now()
       AND tok.revoked_at IS NULL
       AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
       AND u.suspended_at IS NULL
       AND col.local_id = $2`,
    [tokenDigest, localId]
  );
  const collection = result.rows[0];
  if (
    !collection
    || collection.enabled
    || !collection.present
    || collection.authority_state !== "active"
  ) {
    return null;
  }
  const reason: LocalCollectionUnavailableReason =
    collection.unavailable_reason === "claimed_by_newer_runtime"
      ? "claimed_by_newer_runtime"
      : "paused";
  return {
    error: {
      code: "collection_unavailable",
      message: UNAVAILABLE_MESSAGES[reason],
      details: { reason }
    }
  };
}
