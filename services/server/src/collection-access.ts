import type {
  CollectionOperation,
  GrantScope
} from "@mdbase/connect-protocol";
import type { DatabaseQueryable } from "./db.js";
import {
  resolveHostedCollection,
  resolveLocalCollection,
  type CollectionLocator
} from "./collection-catalog.js";

export const COLLECTION_OPERATIONS = [
  "describe",
  "changes",
  "read",
  "query",
  "validate",
  "list_views",
  "execute_view",
  "read_view_source",
  "create_view_source",
  "update_view_source",
  "delete_view_source",
  "create",
  "update",
  "delete",
  "rename",
  "read_type",
  "create_type",
  "update_type",
  "install_type_pack",
  "list_timers",
  "put_timer",
  "cancel_timer",
  "reconcile_timers",
  "sync"
] as const satisfies readonly CollectionOperation[];

export type CollectionAction =
  | "collection.discover"
  | "record.read"
  | "record.write"
  | "application.authorize"
  | "mirror.enroll"
  | "schema.manage"
  | "collection.rename"
  | "collection.delete"
  | "authority.transfer"
  | "members.manage";

export type CollectionRole = "owner" | "manager" | "editor" | "viewer";

export interface CollectionAccessContext {
  collection: CollectionLocator;
  userId: string;
  relationship: "owner" | "member";
  role: CollectionRole;
  policyId: string | null;
  policyRevision: number;
  actions: ReadonlySet<CollectionAction>;
  operationCeiling: ReadonlySet<CollectionOperation>;
  scopeCeiling: GrantScope;
}

export interface CollectionAccessView {
  relationship: "owner" | "member";
  role: CollectionRole;
  can_authorize_applications: boolean;
  can_manage_collection: boolean;
  can_manage_members: boolean;
}

const OWNER_ACTIONS: ReadonlySet<CollectionAction> = new Set([
  "collection.discover",
  "record.read",
  "record.write",
  "application.authorize",
  "mirror.enroll",
  "schema.manage",
  "collection.rename",
  "collection.delete",
  "authority.transfer",
  "members.manage"
]);

const OWNER_OPERATIONS: ReadonlySet<CollectionOperation> = new Set(
  COLLECTION_OPERATIONS
);

export async function resolveHostedCollectionAccess(
  db: DatabaseQueryable,
  userId: string,
  collectionId: string
): Promise<CollectionAccessContext | null> {
  const collection = await resolveHostedCollection(db, collectionId);
  if (!collection || collection.locator.ownerUserId !== userId) return null;
  return ownerAccess(collection.locator, userId);
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
  return {
    relationship: access.relationship,
    role: access.role,
    can_authorize_applications: access.actions.has("application.authorize"),
    can_manage_collection:
      access.actions.has("collection.rename")
      && access.actions.has("collection.delete"),
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
    policyId: null,
    policyRevision: collection.authorityEpoch,
    actions: OWNER_ACTIONS,
    operationCeiling: OWNER_OPERATIONS,
    scopeCeiling: { access: "full_collection", contracts: [] }
  };
}

export class CollectionAccessDeniedError extends Error {
  constructor(readonly action: CollectionAction) {
    super(`Collection access does not permit ${action}.`);
    this.name = "CollectionAccessDeniedError";
  }
}
