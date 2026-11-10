import type { CollectionAccessContext } from "./collection-access.js";

export interface CollectionMembershipBinding {
  membershipId: string;
  policyId: string;
  policyRevision: number;
}

export interface StoredCollectionMembershipBinding {
  membership_id: string | null;
  membership_policy_id: string | null;
  membership_policy_revision: number | null;
}

export function membershipBindingForAccess(
  access: CollectionAccessContext
): CollectionMembershipBinding | null {
  return access.relationship === "member"
    ? {
        membershipId: access.membershipId!,
        policyId: access.policyId!,
        policyRevision: access.policyRevision
      }
    : null;
}

export function matchesMembershipBinding(
  stored: StoredCollectionMembershipBinding,
  expected: CollectionMembershipBinding | null
): boolean {
  return expected
    ? stored.membership_id === expected.membershipId
      && stored.membership_policy_id === expected.policyId
      && Number(stored.membership_policy_revision) === expected.policyRevision
    : stored.membership_id === null
      && stored.membership_policy_id === null
      && stored.membership_policy_revision === null;
}
