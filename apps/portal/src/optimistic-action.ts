import type { ManagementOverview } from "@mdbase/connect-management";

export type OptimisticAction = { kind: "rename-computer" | "rename-collection"; id: string; name: string; previous: string };

export function applyOptimisticAction(data: ManagementOverview, action: OptimisticAction): ManagementOverview {
  switch (action.kind) {
    case "rename-computer": return {
      ...data,
      connectors: data.connectors.map(computer => computer.id === action.id ? { ...computer, name: action.name } : computer),
      collections: data.collections.map(collection => collection.connector_id === action.id ? { ...collection, connector_name: action.name } : collection)
    };
    case "rename-collection": return {
      ...data,
      hosted_collections: data.hosted_collections.map(collection => collection.id === action.id ? { ...collection, display_name: action.name } : collection)
    };
  }
}
