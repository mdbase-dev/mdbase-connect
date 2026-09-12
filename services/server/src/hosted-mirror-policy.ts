import { SyncError } from "@mdbase-dev/connect-sync";
import { isCanonicalCollectionGrantScope } from "./application-grant-scope.js";
import {
  CollectionAccessDeniedError,
  requireCollectionAction,
  resolveHostedCollectionAccess,
  type CollectionAccessContext
} from "./collection-access.js";
import { membershipPolicyPreset } from "./collection-policy.js";
import {
  membershipBindingForAccess,
  matchesMembershipBinding,
  type StoredCollectionMembershipBinding
} from "./collection-membership-binding.js";
import type { DatabaseQueryable } from "./db.js";

/** Mirrors expose a whole collection. A partial policy cannot be represented by
 * the mirror protocol and must never be widened into a read/write mode. */
export function assertMirrorAccess(
  access: CollectionAccessContext,
  mode: "read_only" | "read_write"
): void {
  requireCollectionAction(access, "mirror.enroll");
  const required = membershipPolicyPreset(mode === "read_write" ? "editor" : "viewer");
  if (
    access.collection.authorityState !== "active" ||
    !isCanonicalCollectionGrantScope(access.scopeCeiling) ||
    access.fileCeiling.scope.kind !== "collection" ||
    required.operations.some((operation) => !access.operationCeiling.has(operation)) ||
    required.fileCeiling.actions.some((action) => !access.fileCeiling.actions.includes(action))
  ) {
    throw new CollectionAccessDeniedError(mode === "read_write" ? "record.write" : "mirror.enroll");
  }
}

/** Caller owns the transaction. All mirror issuance/rotation locks the collection
 * before pairing or replica rows, matching membership changes and revocation. */
export async function lockHostedMirrorAccess(
  db: DatabaseQueryable,
  userId: string,
  collectionId: string,
  mode: "read_only" | "read_write"
) {
  await db.query("SELECT id FROM hosted_collections WHERE id = $1 FOR UPDATE", [collectionId]);
  const access = requireCollectionAction(
    await resolveHostedCollectionAccess(db, userId, collectionId),
    "mirror.enroll"
  );
  assertMirrorAccess(access, mode);
  return access;
}

export async function insertHostedMirror(
  db: DatabaseQueryable,
  access: CollectionAccessContext,
  input: {
    id: string;
    name: string;
    mode: "read_only" | "read_write";
    allowedTypes: string[];
    tokenHash: string | null;
  }
): Promise<void> {
  assertMirrorAccess(access, input.mode);
  const binding = membershipBindingForAccess(access);
  await db.query(
    `INSERT INTO hosted_replicas
       (id, collection_id, authorized_user_id, name, purpose, mode, allowed_types, token_hash,
        membership_id, membership_policy_id, membership_policy_revision)
     VALUES ($1,$2,$3,$4,'mirror',$5,$6::jsonb,$7,$8,$9,$10)`,
    [
      input.id,
      access.collection.collectionId,
      access.userId,
      input.name,
      input.mode,
      JSON.stringify(input.allowedTypes),
      input.tokenHash,
      binding?.membershipId ?? null,
      binding?.policyId ?? null,
      binding?.policyRevision ?? null
    ]
  );
}

function assertMirrorBinding(
  access: CollectionAccessContext,
  replica: StoredCollectionMembershipBinding
): void {
  if (!matchesMembershipBinding(replica, membershipBindingForAccess(access))) {
    throw new SyncError(
      "replica_revoked",
      "This mirror requires authorization under the current membership."
    );
  }
}

export async function lockMirrorForRenewal(
  db: DatabaseQueryable,
  userId: string,
  replicaId: string
) {
  const located = await db.query<{ collection_id: string; mode: "read_only" | "read_write" }>(
    `SELECT collection_id, mode FROM hosted_replicas
     WHERE id = $1 AND authorized_user_id = $2 AND purpose = 'mirror' AND revoked_at IS NULL`,
    [replicaId, userId]
  );
  const location = located.rows[0];
  if (!location) throw new SyncError("replica_revoked", "This mirror has been revoked.");
  const access = await lockHostedMirrorAccess(db, userId, location.collection_id, location.mode);
  const current = await db.query<
    StoredCollectionMembershipBinding & {
      id: string;
      collection_id: string;
      name: string;
      mode: "read_only" | "read_write";
    }
  >(
    `SELECT replica.id, replica.collection_id, replica.name, replica.mode,
            replica.membership_id, replica.membership_policy_id, replica.membership_policy_revision
     FROM hosted_replicas replica JOIN users account ON account.id = replica.authorized_user_id
     WHERE replica.id = $1 AND replica.authorized_user_id = $2
       AND replica.purpose = 'mirror' AND replica.revoked_at IS NULL
       AND account.suspended_at IS NULL FOR UPDATE`,
    [replicaId, userId]
  );
  const replica = current.rows[0];
  if (!replica) throw new SyncError("replica_revoked", "This mirror has been revoked.");
  assertMirrorBinding(access, replica);
  return replica;
}

export async function approveMirrorPairing(
  db: DatabaseQueryable,
  userId: string,
  collectionId: string,
  pairingId: string
) {
  // Lock the collection before the pairing to serialize with member revocation.
  await db.query("SELECT id FROM hosted_collections WHERE id = $1 FOR UPDATE", [collectionId]);
  const pairing = await db.query<{ id: string; mode: "read_only" | "read_write" }>(
    `SELECT id, mode FROM mirror_pairing_requests
     WHERE id = $1 AND approved_at IS NULL AND consumed_at IS NULL
       AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`,
    [pairingId]
  );
  if (!pairing.rows[0]) return null;
  await lockHostedMirrorAccess(db, userId, collectionId, pairing.rows[0].mode);
  await db.query(
    `UPDATE mirror_pairing_requests
    SET user_id = $2, collection_id = $3, approved_at = now() WHERE id = $1`,
    [pairingId, userId, collectionId]
  );
  return pairing.rows[0];
}
