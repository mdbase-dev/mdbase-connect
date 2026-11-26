import { t } from "@lingui/core/macro";
import { isMdbaseError } from "@mdbase-dev/sdk";
import { MdbaseConnectError, type QueryResult } from "./connect-types";
import type { ConnectionSummary } from "./model";

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
    const diagnostics = formatDiagnosticIssues(connectDiagnostics(error.problem.details));
    if (diagnostics) return diagnostics;
  }
  if (isMdbaseError(error)) {
    if (error.recovery === "reauthorize") {
      return t`This collection needs authorization again. Choose the collection to continue.`;
    }
    const issues = formatDiagnosticIssues(error.issues);
    if (issues) return issues;
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return t`The collection could not be reached.`;
}

interface DiagnosticIssueLike {
  readonly severity?: string;
  readonly message?: string;
  readonly location?: string;
  readonly details?: unknown;
}

function connectDiagnostics(details: unknown): readonly DiagnosticIssueLike[] | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const diagnostics = (details as Record<string, unknown>).diagnostics;
  return Array.isArray(diagnostics) ? diagnostics as DiagnosticIssueLike[] : undefined;
}

function issueFieldLabel(issue: DiagnosticIssueLike): string | undefined {
  const raw = typeof issue.location === "string"
    ? issue.location
    : issue.details && typeof issue.details === "object" && !Array.isArray(issue.details)
      && typeof (issue.details as Record<string, unknown>).location === "string"
      ? (issue.details as Record<string, unknown>).location as string
      : undefined;
  if (!raw) return undefined;
  const trimmed = raw.startsWith("/") ? raw.slice(1) : raw;
  if (!trimmed) return undefined;
  return trimmed
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .join(".");
}

function formatDiagnosticIssues(issues: readonly DiagnosticIssueLike[] | undefined): string | undefined {
  if (!issues?.length) return undefined;
  const errors = issues.filter((issue) => issue.severity === "error" && typeof issue.message === "string" && issue.message.trim());
  const source = errors.length ? errors : issues.filter((issue) => typeof issue.message === "string" && issue.message.trim());
  if (!source.length) return undefined;
  const formatted: string[] = [];
  for (const issue of source) {
    const message = issue.message!.trim();
    const field = issueFieldLabel(issue);
    const entry = field && !message.includes(field) ? `${field}: ${message}` : message;
    if (!formatted.includes(entry)) formatted.push(entry);
    if (formatted.length >= 3) break;
  }
  return formatted.length ? formatted.join("; ") : undefined;
}

export type { QueryResult };
