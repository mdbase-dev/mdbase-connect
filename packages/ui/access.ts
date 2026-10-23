import { t } from "@lingui/core/macro";
import { i18n } from "@mdbase-dev/ui/i18n";
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
    get label() { return t(i18n)({ message: "View and find records", context: "Application permission" }); },
    get description() { return t(i18n)({ message: "Read collection details, records, saved views, and type definitions.", context: "Application permission" }); },
    operations: [
      "describe",
      "changes",
      "read",
      "query",
      "list_views",
      "execute_view",
      "read_view_source",
      "read_type",
      "assess_type_pack",
      "validate"
    ]
  },
  {
    id: "change",
    get label() { return t(i18n)({ message: "Create and edit records", context: "Application permission" }); },
    get description() { return t(i18n)({ message: "Create, edit, rename, or move records.", context: "Application permission" }); },
    operations: ["create", "update", "rename"]
  },
  {
    id: "delete",
    get label() { return t(i18n)({ message: "Delete records", context: "Application permission" }); },
    get description() { return t(i18n)({ message: "Permanently remove records from this collection.", context: "Application permission" }); },
    operations: ["delete"]
  },
  {
    id: "manage",
    get label() { return t(i18n)({ message: "Manage collection structure", context: "Application permission" }); },
    get description() { return t(i18n)({ message: "Create or change saved views and type definitions.", context: "Application permission" }); },
    operations: [
      "create_view_source",
      "update_view_source",
      "delete_view_source",
      "create_type",
      "update_type",
      "apply_type_pack"
    ]
  },
  {
    id: "schedule",
    get label() { return t(i18n)({ message: "Schedule app activity", context: "Application permission" }); },
    get description() { return t(i18n)({ message: "View and manage timers owned by this application.", context: "Application permission" }); },
    operations: [
      "list_timers",
      "put_timer",
      "cancel_timer",
      "reconcile_timers"
    ]
  }
] as const;

const authorizationOperationLabels: Record<string, string> = {
  get describe() { return t(i18n)({ message: "Describe the collection", context: "Application permission" }); },
  get changes() { return t(i18n)({ message: "See collection changes", context: "Application permission" }); },
  get read() { return t(i18n)({ message: "Read records", context: "Application permission" }); },
  get query() { return t(i18n)({ message: "Search and query", context: "Application permission" }); },
  get list_views() { return t(i18n)({ message: "See saved views", context: "Application permission" }); },
  get execute_view() { return t(i18n)({ message: "Run saved views", context: "Application permission" }); },
  get read_view_source() { return t(i18n)({ message: "Inspect saved-view definitions", context: "Application permission" }); },
  get validate() { return t(i18n)({ message: "Check collection validity", context: "Application permission" }); },
  get create() { return t(i18n)({ message: "Create records", context: "Application permission" }); },
  get update() { return t(i18n)({ message: "Change records", context: "Application permission" }); },
  get rename() { return t(i18n)({ message: "Rename or move records", context: "Application permission" }); },
  get delete() { return t(i18n)({ message: "Delete records", context: "Application permission" }); },
  get create_view_source() { return t(i18n)({ message: "Create saved views", context: "Application permission" }); },
  get update_view_source() { return t(i18n)({ message: "Change saved views", context: "Application permission" }); },
  get delete_view_source() { return t(i18n)({ message: "Delete saved views", context: "Application permission" }); },
  get read_type() { return t(i18n)({ message: "View record types", context: "Application permission" }); },
  get create_type() { return t(i18n)({ message: "Add record types", context: "Application permission" }); },
  get update_type() { return t(i18n)({ message: "Change record types", context: "Application permission" }); },
  get assess_type_pack() { return t(i18n)({ message: "Check available record types", context: "Application permission" }); },
  get apply_type_pack() { return t(i18n)({ message: "Install or update record types", context: "Application permission" }); },
  get assess_collection_setup() { return t(i18n)({ message: "Check what this app needs to set up", context: "Application permission" }); },
  get apply_collection_setup() { return t(i18n)({ message: "Set up this app in the collection", context: "Application permission" }); },
  get list_timers() { return t(i18n)({ message: "See this app's scheduled activity", context: "Application permission" }); },
  get put_timer() { return t(i18n)({ message: "Create or update this app's scheduled activity", context: "Application permission" }); },
  get cancel_timer() { return t(i18n)({ message: "Cancel this app's scheduled activity", context: "Application permission" }); },
  get reconcile_timers() { return t(i18n)({ message: "Replace this app's scheduled activity", context: "Application permission" }); }
};

const TRANSPORT_CAPABILITIES = new Set(["sync"]);

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
  const reviewable = operations.filter(
    (operation) => !TRANSPORT_CAPABILITIES.has(operation)
  );
  const requested = new Set(reviewable);
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
  const other = reviewable.filter((operation) => !known.has(operation));

  if (other.length > 0) {
    groups.push({
      id: "other",
      label: t(i18n)({ message: "Other permissions", context: "Application permission" }),
      description: t(i18n)({ message: "Additional operations declared by this application.", context: "Application permission" }),
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

/** Display the grant's exact origin, not the application's general homepage.
 * A loopback web origin is development only; this label confers no trust. */
export function applicationAccessOriginLabel(origin: string): string {
  try {
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ? t(i18n)`Local development (${url.host})` : url.host || origin;
  } catch { return origin; }
}

function compareGrants<Grant extends ApplicationAccessGrant>(left: Grant, right: Grant): number {
  return compareText(left.collection_name, right.collection_name)
    || right.created_at.localeCompare(left.created_at);
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}
