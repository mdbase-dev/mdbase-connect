import type { GrantScope } from "@mdbase-dev/connect-protocol";

export function collectionGrantScope(): GrantScope {
  return { access: "full_collection", contracts: [] };
}

export function isCanonicalCollectionGrantScope(
  value: unknown
): value is GrantScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as { access?: unknown; contracts?: unknown };
  return scope.access === "full_collection"
    && Array.isArray(scope.contracts)
    && scope.contracts.length === 0;
}
