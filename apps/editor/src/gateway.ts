import { t } from "@lingui/core/macro";
import { MdbaseConnectError } from "@mdbase-dev/connect";
import { isMdbaseError } from "@mdbase-dev/sdk";
import type { ConnectionSummary } from "./model";

// Readiness supports legacy release declarations and explicit v2 fixtures.
export const CORE_CAPABILITIES: readonly string[] = [
  "collection.inspect", "records.watch", "records.read", "records.query",
  "records.validate", "records.update", "records.rename", "files.list", "files.read",
  "collection.read"
];

export const TYPE_DEFINITION_CAPABILITIES: readonly string[] = [
  "definitions.read", "definitions.create", "definitions.update"
];

export function missingCoreCapabilities(connection: ConnectionSummary | null): string[] {
  return connection?.missingCapabilities?.filter((capability) =>
    CORE_CAPABILITIES.includes(capability)
  ) ?? [];
}

export function missingTypeCapabilities(connection: ConnectionSummary | null): string[] {
  return connection?.missingCapabilities?.filter((capability) =>
    TYPE_DEFINITION_CAPABILITIES.includes(capability)
  ) ?? [];
}

export function editorPermissions(connection: ConnectionSummary | null) {
  const permits = (operation: string) => Boolean(connection?.operations.some((allowed) => allowed === "all" || allowed === operation));
  return {
    canCreateNotes: permits("create"),
    canEditNotes: permits("update"),
    canRenameNotes: permits("rename"),
    canDeleteNotes: permits("delete"),
    canManageTypes: permits("create_type") && permits("update_type"),
    canInstallTypes: permits("apply_type_pack"),
    canAttachFiles: Boolean(connection?.fileActions?.includes("add"))
  };
}

export function gatewayError(error: unknown): string {
  if (error instanceof MdbaseConnectError) {
    if (error.problem.code === "connector_offline") return t`The computer holding this collection is offline.`;
    if (error.problem.recovery === "reauthorize") {
      return t`This collection needs authorization again. Choose the collection to continue.`;
    }
  }
  if (isMdbaseError(error) && error.recovery === "reauthorize") {
    return t`This collection needs authorization again. Choose the collection to continue.`;
  }
  if (error instanceof Error) return error.message;
  return t`The collection could not be reached.`;
}
