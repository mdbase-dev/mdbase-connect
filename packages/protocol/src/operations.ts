/**
 * The executable collection-operation contract. Runtime parsers, capability
 * compilation, and public types must all consume this value; do not maintain a
 * second operation allow-list at an SDK or service boundary.
 */
export const COLLECTION_OPERATIONS = [
  "describe",
  "changes",
  "read",
  "query",
  "list_views",
  "execute_view",
  "read_view_source",
  "create_view_source",
  "update_view_source",
  "delete_view_source",
  "validate",
  "create",
  "update",
  "delete",
  "rename",
  "read_type",
  "create_type",
  "update_type",
  "assess_type_pack",
  "apply_type_pack",
  "list_timers",
  "put_timer",
  "cancel_timer",
  "reconcile_timers",
  "sync"
] as const;

export type CollectionOperation = typeof COLLECTION_OPERATIONS[number];

const COLLECTION_OPERATION_SET: ReadonlySet<string> = new Set(
  COLLECTION_OPERATIONS
);

export function isCollectionOperation(value: string): value is CollectionOperation {
  return COLLECTION_OPERATION_SET.has(value);
}

export function areCollectionOperations(
  values: readonly string[]
): values is readonly CollectionOperation[] {
  return values.every(isCollectionOperation);
}
