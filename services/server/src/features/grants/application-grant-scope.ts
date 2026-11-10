import type { GrantScope } from "@mdbase-dev/connect-protocol";

export function collectionGrantScope(): GrantScope {
  return { access: "full_collection", contracts: [] };
}

export function isCanonicalCollectionGrantScope(
  value: unknown
): value is GrantScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as { access?: unknown; contracts?: unknown };
  const keys = Object.keys(scope).sort();
  return keys.length === 2
    && keys[0] === "access"
    && keys[1] === "contracts"
    && scope.access === "full_collection"
    && Array.isArray(scope.contracts)
    && scope.contracts.length === 0;
}
