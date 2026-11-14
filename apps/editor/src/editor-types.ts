import type { JsonObject, TypePackReceipt, TypePackStatus, TypePackResource } from "@mdbase-dev/sdk";

export type { TypePackProvision, MdbaseDiagnostic, DataContractSelector } from "@mdbase-dev/connect-protocol";

export interface CollectionTypeDescriptor {
  name: string;
  version?: number;
  description?: string;
  revision?: string;
  path?: string;
  definition?: JsonObject;
  schema: JsonObject;
  collection?: JsonObject;
  lifecycle?: JsonObject;
  extensions: Record<string, unknown>;
}
export interface CollectionContractImplementationDescriptor {
  typeName: string;
  typeVersion: number;
  typePath?: string;
  digest: string;
  fields: Record<string, string>;
  binding?: JsonObject;
}
export interface CollectionContractDescriptor {
  contractType: "record";
  id: string;
  version: string;
  digest: string;
  schema: JsonObject;
  bindingSchema?: JsonObject;
  implementations: CollectionContractImplementationDescriptor[];
}
export interface CollectionDescription {
  authorityCapabilities?: readonly string[];
  protocolVersion: 1;
  collectionId: string;
  displayName: string;
  specVersion: string;
  operations: string[];
  changeCursor: number;
  types: CollectionTypeDescriptor[];
  contracts: CollectionContractDescriptor[];
  configuration?: JsonObject;
}
export interface CollectionTypeDocument { name: string; path: string; revision: string; document: string }
export interface QueryRecord<Frontmatter extends JsonObject = JsonObject> {
  path: string;
  revision?: string;
  frontmatter?: Frontmatter;
  effectiveFrontmatter?: Frontmatter;
  body?: string;
  types: string[];
  file: { path?: string; size?: number; mtime?: string; ctime?: string; tags?: string[]; links?: unknown[]; embeds?: unknown[]; folder?: string; name?: string; extension?: string };
}
export interface RecordDocument<Frontmatter extends JsonObject = JsonObject> extends QueryRecord<Frontmatter> {
  revision: string;
  frontmatter: Frontmatter;
  effectiveFrontmatter: Frontmatter;
  document?: string;
}
export interface CollectionFileDescriptor {
  fileId: string;
  path: string;
  revision: string;
  contentDigest: `sha256:${string}`;
  size: number;
  mediaType?: string;
  mediaClass: "image" | "audio" | "video" | "pdf" | "other";
  modifiedAt: string;
}
export interface MdbaseFileProgress { phase: "hashing" | "uploading" | "downloading"; transferredBytes: number; totalBytes: number }
export type DirectAccessStatus = "disabled" | "permission_required" | "checking" | "available" | "unavailable" | "denied";
export type MdbaseUnavailableReason = "not_authorized" | "authorization_lost" | "invalid_stored_grant" | "legacy_scope_reauthorization_required";
export interface DescribeOptions { fresh?: boolean; signal?: AbortSignal }
export interface MutationProgress {
  operation: "rename" | "delete";
  state: "preflighting" | "ready" | "applying" | "completed" | "cancelled";
  elapsedMs: number;
  cancellable: boolean;
  resumed: boolean;
  completedUnits: number;
  estimate?: { totalUnits: number; warnings: number; affectedRecords: number };
}
export interface PendingMutationSummary { requestId: string; operation: "create" | "update" | "rename" | "delete"; createdAt: string }
export interface RenamePreflightResult {
  from: string; to: string; dryRun: true; wouldRename: true;
  referencesAffected?: Array<{ path: string; field?: string; location?: string }>;
  warnings?: Array<{ path: string; message: string }>;
}
export interface DeletePreflightResult { path: string; deleted: false; dryRun: true; wouldDelete: true; brokenLinks?: Array<{ path: string }> }
export interface NoteChange { body?: string; patch?: JsonObject }

export type TypePackResourceDiff = TypePackResource & { digest: string };
export interface TypePackAssessment {
  status: TypePackStatus; applicable: boolean; assessmentDigest: string;
  current?: TypePackReceipt; desired: TypePackReceipt; resources: TypePackResourceDiff[];
  lock: { target: "mdbase.lock.yaml"; action: "create" | "update" | "unchanged"; digest: string };
  contractSetups: { choices: unknown[]; resources: TypePackResourceDiff[] };
}
export interface TypePackApplyResult extends TypePackAssessment { receipt: TypePackReceipt; cleanupDeferred: boolean }
