import type { CollectionOperation } from "@mdbase-dev/connect-protocol";

interface CollectionOperationPolicy {
  requiresFullCollection: boolean;
  requiresPortableProfile: boolean;
  requiresWriteReplica: boolean;
}

/**
 * Server-side policy for every executable collection operation. Keeping this
 * exhaustive makes a new protocol operation a compile-time decision at each
 * authorization and replica boundary instead of an easy-to-miss allow-list
 * update.
 */
const COLLECTION_OPERATION_POLICIES = {
  describe: policy(),
  changes: policy(),
  read: policy(),
  query: policy({ requiresPortableProfile: true }),
  list_views: policy({
    requiresFullCollection: true,
    requiresPortableProfile: true
  }),
  execute_view: policy({
    requiresFullCollection: true,
    requiresPortableProfile: true
  }),
  read_view_source: policy(),
  create_view_source: policy({ requiresWriteReplica: true }),
  update_view_source: policy({ requiresWriteReplica: true }),
  delete_view_source: policy({ requiresWriteReplica: true }),
  validate: policy({ requiresFullCollection: true }),
  create: policy({ requiresWriteReplica: true }),
  update: policy({ requiresWriteReplica: true }),
  delete: policy({ requiresWriteReplica: true }),
  rename: policy({ requiresWriteReplica: true }),
  read_type: policy({
    requiresFullCollection: true,
    requiresPortableProfile: true
  }),
  create_type: policy({
    requiresFullCollection: true,
    requiresPortableProfile: true,
    requiresWriteReplica: true
  }),
  update_type: policy({
    requiresFullCollection: true,
    requiresPortableProfile: true,
    requiresWriteReplica: true
  }),
  assess_type_pack: policy({
    requiresFullCollection: true,
    requiresPortableProfile: true
  }),
  apply_type_pack: policy({
    requiresFullCollection: true,
    requiresPortableProfile: true,
    requiresWriteReplica: true
  }),
  list_timers: policy(),
  put_timer: policy({ requiresWriteReplica: true }),
  cancel_timer: policy({ requiresWriteReplica: true }),
  reconcile_timers: policy({ requiresWriteReplica: true }),
  sync: policy()
} as const satisfies Record<CollectionOperation, CollectionOperationPolicy>;

export function requiresFullCollectionAccess(
  operation: CollectionOperation
): boolean {
  return COLLECTION_OPERATION_POLICIES[operation].requiresFullCollection;
}

export function requiresPortableProfile(
  operation: CollectionOperation
): boolean {
  return COLLECTION_OPERATION_POLICIES[operation].requiresPortableProfile;
}

export function requiresWriteReplica(
  operation: CollectionOperation
): boolean {
  return COLLECTION_OPERATION_POLICIES[operation].requiresWriteReplica;
}

function policy(
  overrides: Partial<CollectionOperationPolicy> = {}
): CollectionOperationPolicy {
  return {
    requiresFullCollection: false,
    requiresPortableProfile: false,
    requiresWriteReplica: false,
    ...overrides
  };
}
