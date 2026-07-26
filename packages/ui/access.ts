export interface ApplicationAccessGrant {
  application_id: string;
  application_family_id?: string;
  application_name: string;
  collection_id: string;
  collection_name: string;
  created_at: string;
}

export interface ApplicationAccessGroup<Grant extends ApplicationAccessGrant> {
  applicationId: string;
  applicationName: string;
  collectionCount: number;
  grants: Grant[];
}

export interface AuthorizationOperationGroup {
  id: string;
  label: string;
  description: string;
  operations: Array<{
    id: string;
    label: string;
  }>;
}

const authorizationOperationGroups = [
  {
    id: "view",
    label: "View and find records",
    description: "Read collection details, records, saved views, and type definitions.",
    operations: [
      "describe",
      "changes",
      "read",
      "query",
      "list_views",
      "execute_view",
      "read_view_source",
      "read_type",
      "validate"
    ]
  },
  {
    id: "change",
    label: "Change records",
    description: "Create, edit, rename, move, or delete records.",
    operations: ["create", "update", "rename", "delete"]
  },
  {
    id: "manage",
    label: "Manage collection structure",
    description: "Create or change saved views and type definitions.",
    operations: [
      "create_view_source",
      "update_view_source",
      "delete_view_source",
      "create_type",
      "update_type"
    ]
  },
  {
    id: "schedule",
    label: "Schedule app activity",
    description: "View and manage timers owned by this application.",
    operations: [
      "list_timers",
      "put_timer",
      "cancel_timer",
      "reconcile_timers"
    ]
  }
] as const;

const authorizationOperationLabels: Record<string, string> = {
  describe: "Describe the collection",
  changes: "See collection changes",
  read: "Read records",
  query: "Search and query",
  list_views: "See saved views",
  execute_view: "Run saved views",
  read_view_source: "Inspect saved-view definitions",
  validate: "Check collection validity",
  create: "Create records",
  update: "Change records",
  rename: "Rename or move records",
  delete: "Delete records",
  create_view_source: "Create saved views",
  update_view_source: "Change saved views",
  delete_view_source: "Delete saved views",
  read_type: "Inspect type definitions",
  create_type: "Create type definitions",
  update_type: "Change type definitions",
  list_timers: "List application timers",
  put_timer: "Create or update timers",
  cancel_timer: "Cancel timers",
  reconcile_timers: "Reconcile application timers"
};

export function groupApplicationAccess<Grant extends ApplicationAccessGrant>(
  grants: readonly Grant[]
): ApplicationAccessGroup<Grant>[] {
  const groups = new Map<string, ApplicationAccessGroup<Grant>>();

  for (const grant of grants) {
    const groupId = grant.application_family_id || grant.application_id;
    const current = groups.get(groupId);
    if (current) {
      current.grants.push(grant);
      continue;
    }
    groups.set(groupId, {
      applicationId: groupId,
      applicationName: grant.application_name,
      collectionCount: 0,
      grants: [grant]
    });
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      collectionCount: new Set(group.grants.map((grant) => grant.collection_id)).size,
      grants: [...group.grants].sort(compareGrants)
    }))
    .sort((left, right) => compareText(left.applicationName, right.applicationName));
}

export function groupAuthorizationOperations(
  operations: readonly string[]
): AuthorizationOperationGroup[] {
  const requested = new Set(operations);
  const groups: AuthorizationOperationGroup[] = authorizationOperationGroups
    .map((group) => ({
      id: group.id,
      label: group.label,
      description: group.description,
      operations: group.operations
        .filter((operation) => requested.has(operation))
        .map((operation) => ({
          id: operation,
          label: authorizationOperationLabel(operation)
        }))
    }))
    .filter((group) => group.operations.length > 0);
  const known = new Set<string>(authorizationOperationGroups.flatMap((group) => group.operations));
  const other = operations.filter((operation) => !known.has(operation));

  if (other.length > 0) {
    groups.push({
      id: "other",
      label: "Other permissions",
      description: "Additional operations declared by this application.",
      operations: other.map((operation) => ({
        id: operation,
        label: authorizationOperationLabel(operation)
      }))
    });
  }

  return groups;
}

export function authorizationOperationLabel(operation: string): string {
  return authorizationOperationLabels[operation]
    ?? `${operation[0]?.toUpperCase() ?? ""}${operation.slice(1).replaceAll("_", " ")}`;
}

function compareGrants<Grant extends ApplicationAccessGrant>(left: Grant, right: Grant): number {
  return compareText(left.collection_name, right.collection_name)
    || right.created_at.localeCompare(left.created_at);
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}
