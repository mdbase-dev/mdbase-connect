import { randomUUID } from "node:crypto";
import {
  COLLECTION_OPERATIONS,
  type CollectionOperation,
  type FileAction,
  type FileCapability,
  type GrantScope,
  type ReplicaCollaborationCapability
} from "@mdbase-dev/connect-protocol";
import { z } from "zod";
import { requiresWriteReplica } from "./collection-operation-policy.js";
import { collectionContractDescriptorSchema } from "./protocol-schemas.js";
import type {
  DatabasePool,
  DatabaseQueryable
} from "./db.js";

export const COLLECTION_ACTIONS = [
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
] as const;

export type CollectionAction = typeof COLLECTION_ACTIONS[number];

export const COLLECTION_MEMBERSHIP_ROLES = ["viewer", "editor"] as const;
export type CollectionMembershipRole = typeof COLLECTION_MEMBERSHIP_ROLES[number];
export type CollectionRole = "owner" | CollectionMembershipRole;

export const COLLECTION_MEMBERSHIP_PRESET_VERSION = 2;

const FILE_ACTIONS = ["list", "read", "add", "replace", "move", "delete"] as const;

const VIEWER_ACTIONS: readonly CollectionAction[] = [
  "collection.discover",
  "record.read",
  "application.authorize",
  "mirror.enroll"
];

const EDITOR_ACTIONS: readonly CollectionAction[] = [
  ...VIEWER_ACTIONS,
  "record.write",
  "schema.manage",
  "collection.rename",
  "members.manage"
];

const VIEWER_OPERATIONS: readonly CollectionOperation[] = COLLECTION_OPERATIONS.filter(
  (operation) => !requiresWriteReplica(operation)
);

const VIEWER_FILE_ACTIONS: readonly FileAction[] = ["list", "read"];
const EDITOR_FILE_ACTIONS: readonly FileAction[] = [...FILE_ACTIONS];

const uniqueArray = <T extends z.ZodTypeAny>(item: T) => z.array(item).min(1).superRefine(
  (values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: "Values must be unique." });
    }
  }
);

const actionArraySchema = uniqueArray(z.enum(COLLECTION_ACTIONS));
const operationArraySchema = uniqueArray(z.enum(COLLECTION_OPERATIONS));
const fileActionArraySchema = uniqueArray(z.enum(FILE_ACTIONS));
const grantScopeSchema = z.discriminatedUnion("access", [
  z.object({
    access: z.literal("full_collection"),
    contracts: z.array(collectionContractDescriptorSchema).max(0)
  }).strict(),
  z.object({
    access: z.literal("contract"),
    contracts: z.array(collectionContractDescriptorSchema)
  }).strict()
]);
const fileScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("collection") }).strict(),
  z.object({
    kind: z.literal("selected_folders"),
    folders: uniqueArray(z.string().trim().min(1).max(1024))
  }).strict()
]);
const collaborationCapabilitySchema = z.object({
  contract_version: z.literal(1),
  profiles: z.tuple([z.literal("markdown-body-yjs-v13")]),
  access: z.enum(["read_only", "read_write"])
}).strict();

const fileCapabilitySchema = z.object({
  kind: z.literal("files"),
  protocol_version: z.literal(1),
  actions: fileActionArraySchema,
  scope: fileScopeSchema
}).strict();

const storedPolicySchema = z.object({
  id: z.string().uuid(),
  membership_id: z.string().uuid(),
  collection_id: z.string().uuid(),
  user_id: z.string().uuid(),
  owner_user_id: z.string().uuid(),
  revision: z.coerce.number().int().positive(),
  role: z.enum(COLLECTION_MEMBERSHIP_ROLES),
  preset_version: z.coerce.number().int().positive(),
  actions: actionArraySchema,
  operations: operationArraySchema,
  scope_ceiling: grantScopeSchema,
  file_ceiling: fileCapabilitySchema,
  collaboration_ceiling: collaborationCapabilitySchema.nullable()
}).strict();

export interface CollectionMembershipPolicy {
  id: string;
  membershipId: string;
  collectionId: string;
  userId: string;
  ownerUserId: string;
  revision: number;
  role: CollectionMembershipRole;
  presetVersion: number;
  actions: readonly CollectionAction[];
  operations: readonly CollectionOperation[];
  scopeCeiling: GrantScope;
  fileCeiling: FileCapability;
  collaborationCeiling: ReplicaCollaborationCapability | null;
}

export interface MembershipPolicySnapshot {
  role: CollectionMembershipRole;
  presetVersion: number;
  actions: readonly CollectionAction[];
  operations: readonly CollectionOperation[];
  scopeCeiling: GrantScope;
  fileCeiling: FileCapability;
  collaborationCeiling: ReplicaCollaborationCapability | null;
}

export function membershipPolicyPreset(
  role: CollectionMembershipRole,
  options: { collaboration?: boolean } = {}
): MembershipPolicySnapshot {
  const editor = role === "editor";
  return {
    role,
    presetVersion: COLLECTION_MEMBERSHIP_PRESET_VERSION,
    actions: [...(editor ? EDITOR_ACTIONS : VIEWER_ACTIONS)],
    operations: [...(editor ? COLLECTION_OPERATIONS : VIEWER_OPERATIONS)],
    scopeCeiling: { access: "full_collection", contracts: [] },
    fileCeiling: {
      kind: "files",
      protocol_version: 1,
      actions: [...(editor ? EDITOR_FILE_ACTIONS : VIEWER_FILE_ACTIONS)],
      scope: { kind: "collection" }
    },
    collaborationCeiling: options.collaboration
      ? {
          contract_version: 1,
          profiles: ["markdown-body-yjs-v13"],
          access: editor ? "read_write" : "read_only"
        }
      : null
  };
}

/**
 * Internal foundation used by tests and, later, invitation acceptance. It is
 * deliberately not exposed as an HTTP operation. The hosted collection row is
 * locked so membership creation cannot race an authority transition.
 */
export async function createHostedCollectionMembership(
  db: DatabasePool,
  input: {
    collectionId: string;
    ownerUserId: string;
    userId: string;
    role: CollectionMembershipRole;
    invitedByUserId?: string;
    collaboration?: boolean;
  }
): Promise<CollectionMembershipPolicy> {
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    const collection = await connection.query<{ user_id: string; authority_state: string }>(
      `SELECT user_id, authority_state FROM hosted_collections
       WHERE id = $1 FOR UPDATE`,
      [input.collectionId]
    );
    const authority = collection.rows[0];
    if (
      !authority
      || authority.user_id !== input.ownerUserId
      || authority.authority_state !== "active"
    ) {
      throw new CollectionMembershipPolicyError(
        "collection_unavailable",
        "The collection is not available for membership changes."
      );
    }
    const policy = await insertHostedCollectionMembershipPolicy(connection, {
      collectionId: input.collectionId,
      ownerUserId: input.ownerUserId,
      userId: input.userId,
      invitedByUserId: input.invitedByUserId ?? input.ownerUserId,
      snapshot: membershipPolicyPreset(input.role, {
        collaboration: input.collaboration === true
      })
    });
    await connection.query("COMMIT");
    return policy;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

export async function insertHostedCollectionMembershipPolicy(
  db: DatabaseQueryable,
  input: {
    collectionId: string;
    ownerUserId: string;
    userId: string;
    invitedByUserId: string | null;
    snapshot: MembershipPolicySnapshot;
  }
): Promise<CollectionMembershipPolicy> {
  if (input.userId === input.ownerUserId) {
    throw new CollectionMembershipPolicyError(
      "owner_is_not_member",
      "The collection owner cannot be represented as a membership."
    );
  }
  await db.query(
    `INSERT INTO collection_identities (id, owner_user_id)
     VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [input.collectionId, input.ownerUserId]
  );
  const identity = await db.query<{ owner_user_id: string }>(
    "SELECT owner_user_id FROM collection_identities WHERE id = $1 FOR UPDATE",
    [input.collectionId]
  );
  if (identity.rows[0]?.owner_user_id !== input.ownerUserId) {
    throw new CollectionMembershipPolicyError(
      "collection_identity_mismatch",
      "The collection identity does not match its current owner."
    );
  }
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM collection_memberships
     WHERE collection_id = $1 AND user_id = $2 AND revoked_at IS NULL
     FOR UPDATE`,
    [input.collectionId, input.userId]
  );
  if (existing.rows[0]) {
    throw new CollectionMembershipPolicyError(
      "membership_exists",
      "The user already has an active membership for this collection."
    );
  }
  const parsedSnapshot = storedPolicySchema.pick({
    role: true,
    preset_version: true,
    actions: true,
    operations: true,
    scope_ceiling: true,
    file_ceiling: true,
    collaboration_ceiling: true
  }).safeParse({
    role: input.snapshot.role,
    preset_version: input.snapshot.presetVersion,
    actions: input.snapshot.actions,
    operations: input.snapshot.operations,
    scope_ceiling: input.snapshot.scopeCeiling,
    file_ceiling: input.snapshot.fileCeiling,
    collaboration_ceiling: input.snapshot.collaborationCeiling
  });
  if (!parsedSnapshot.success) {
    throw new CollectionMembershipPolicyError(
      "invalid_policy_snapshot",
      "The membership policy snapshot is invalid."
    );
  }
  const membershipId = randomUUID();
  const policyId = randomUUID();
  const revision = 1;
  const snapshot = parsedSnapshot.data;
  await db.query(
    `INSERT INTO collection_memberships
       (id, collection_id, user_id, invited_by_user_id)
     VALUES ($1, $2, $3, $4)`,
    [membershipId, input.collectionId, input.userId, input.invitedByUserId]
  );
  await db.query(
    `INSERT INTO collection_membership_policies
       (id, membership_id, revision, role, preset_version, actions,
        operations, scope_ceiling, file_ceiling, collaboration_ceiling)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb,
             $10::jsonb)`,
    [
      policyId,
      membershipId,
      revision,
      snapshot.role,
      snapshot.preset_version,
      JSON.stringify(snapshot.actions),
      JSON.stringify(snapshot.operations),
      JSON.stringify(snapshot.scope_ceiling),
      JSON.stringify(snapshot.file_ceiling),
      snapshot.collaboration_ceiling === null
        ? null
        : JSON.stringify(snapshot.collaboration_ceiling)
    ]
  );
  await db.query(
    `UPDATE collection_memberships
     SET current_policy_id = $2, current_policy_revision = $3, updated_at = now()
     WHERE id = $1`,
    [membershipId, policyId, revision]
  );
  return {
    id: policyId,
    membershipId,
    collectionId: input.collectionId,
    userId: input.userId,
    ownerUserId: input.ownerUserId,
    revision,
    role: snapshot.role,
    presetVersion: snapshot.preset_version,
    actions: snapshot.actions,
    operations: snapshot.operations,
    scopeCeiling: snapshot.scope_ceiling,
    fileCeiling: snapshot.file_ceiling,
    collaborationCeiling: snapshot.collaboration_ceiling
  };
}

export async function resolveActiveMembershipPolicy(
  db: DatabaseQueryable,
  input: { collectionId: string; ownerUserId: string; userId: string }
): Promise<CollectionMembershipPolicy | null> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT policy.id, policy.membership_id, membership.collection_id,
            membership.user_id, identity.owner_user_id, policy.revision,
            policy.role, policy.preset_version, policy.actions,
            policy.operations, policy.scope_ceiling, policy.file_ceiling,
            policy.collaboration_ceiling
     FROM collection_memberships membership
     JOIN collection_identities identity
       ON identity.id = membership.collection_id
     JOIN collection_membership_policies policy
       ON policy.id = membership.current_policy_id
      AND policy.membership_id = membership.id
      AND policy.revision = membership.current_policy_revision
     WHERE membership.collection_id = $1
       AND membership.user_id = $2
       AND membership.state = 'active'
       AND membership.revoked_at IS NULL`,
    [input.collectionId, input.userId]
  );
  const decoded = storedPolicySchema.safeParse(result.rows[0]);
  if (!decoded.success || decoded.data.owner_user_id !== input.ownerUserId) return null;
  return {
    id: decoded.data.id,
    membershipId: decoded.data.membership_id,
    collectionId: decoded.data.collection_id,
    userId: decoded.data.user_id,
    ownerUserId: decoded.data.owner_user_id,
    revision: decoded.data.revision,
    role: decoded.data.role,
    presetVersion: decoded.data.preset_version,
    actions: decoded.data.actions,
    operations: decoded.data.operations,
    scopeCeiling: decoded.data.scope_ceiling,
    fileCeiling: decoded.data.file_ceiling,
    collaborationCeiling: decoded.data.collaboration_ceiling
  };
}

export class CollectionMembershipPolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CollectionMembershipPolicyError";
  }
}
