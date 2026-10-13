// Connect grant lifecycle -> immutable policy grants (control-plane.md §2.2).
// Call on the caller's transaction client after activation/key copy/narrowing.
import { createHash, randomUUID } from "node:crypto";
import { type FileCapability, type GrantScope } from "@mdbase-dev/connect-protocol";
import { exactNextPermissionCapabilities } from "@mdbase-dev/connect-protocol/next-authorization";
import { freshLegacyNextOperations, type FreshLegacyAuthorization } from "./fresh-authorization.js";
import type { DatabaseQueryable } from "../../database-types.js";
import { RequestValidationError } from "../../platform/http-errors.js";
import { queueNextPolicy } from "./policy-outbox.js";
import type { PolicyOp } from "./policy-wire.js";

function refusal(): never {
  throw new RequestValidationError("This app needs an update before it can connect. Try again after it updates.", {
    statusCode: 409, code: "application_reauthorization_required"
  });
}

/** Never add record capabilities to satisfy files, or file rights to satisfy records. */
export function exactNextGrantCapabilities(semantic: number | null, operations: readonly string[], files: FileCapability | null, nextBound = false): string[] {
  // Only a previously published next binding (or validated fresh approval below)
  // admits semantic1. Retained predecessor grants do not acquire new authority.
  if (semantic !== 2 && !(semantic === 1 && nextBound)) return refusal();
  return exactNextPermissionCapabilities(operations, files?.actions ?? []) ?? refusal();
}

/** Check a permission proposal before any external provider policy change. */
export async function assertNextGrantPermissions(db: DatabaseQueryable, grantId: string, operations: readonly string[]): Promise<void> {
  const result = await db.query<{ semantic: number | null; file_capability: FileCapability | null; next_bound: boolean }>(
    `SELECT (g.application_authorization->'binding'->'contracts'->>'semantic_capabilities')::int AS semantic, g.file_capability,
       (b.grant_id IS NOT NULL) AS next_bound
     FROM grants g LEFT JOIN collections col ON col.id = g.collection_id
     JOIN next_collections nc ON nc.collection_id::text = COALESCE(col.local_id::text, g.hosted_collection_id::text, g.next_collection_id::text)
     LEFT JOIN next_grant_bindings b ON b.grant_id = g.id AND b.collection_id = nc.collection_id
     WHERE g.id = $1 AND nc.runtime = 'next' AND nc.left_sync_at IS NULL`, [grantId]
  );
  const row = result.rows[0];
  if (row) exactNextGrantCapabilities(row.semantic, operations, row.file_capability, row.next_bound);
}

export interface NextGrantSource {
  collection: string; sync: "private" | "cloud_copy";
  user_id: string; application_id: string; application_installation_id: string;
  operations: string[]; file_capability: FileCapability | null; scope: GrantScope;
  semantic: number | null; declaration: string | null; client_pk: Buffer | null;
  /** Derived from existing next_grant_bindings, never an application claim. */
  next_bound?: boolean;
}

/** Canonical current terms shared by publication and the isolated PITR observation.
 * Pure projection only: no policy publication or authority lease. */
export function projectNextGrant(row: NextGrantSource): {
  terms: Buffer; policy: Omit<Extract<PolicyOp, { op: "grant" }>, "grant">;
} {
  const capabilities = exactNextGrantCapabilities(row.semantic, row.operations, row.file_capability, row.next_bound);
  if (row.scope.access !== "full_collection" || row.scope.contracts.length !== 0 || !row.declaration
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.application_installation_id)
      || row.client_pk?.length !== 32) return refusal();
  const folders = row.file_capability?.scope.kind === "selected_folders" ? row.file_capability.scope.folders : undefined;
  if (folders?.length === 0) return refusal();
  const terms = createHash("sha256").update(JSON.stringify([
    row.collection, row.user_id, row.application_id, row.declaration, row.application_installation_id,
    capabilities, row.client_pk.toString("hex"), folders ? [...folders].sort() : null
  ])).digest();
  return { terms, policy: { op: "grant", installation: row.application_installation_id,
    appId: row.declaration, account: row.user_id, capabilities, clientPublicKey: row.client_pk,
    ...(folders ? row.sync === "private" ? { folderScoped: true } : { fileFolders: [...folders].sort() } : {}) } };
}

/** No-op for legacy/shadow/device-log grants. Refuse unrepresentable next grants. */
export async function queueNextGrantPolicy(db: DatabaseQueryable, grantId: string, freshLegacy?: FreshLegacyAuthorization): Promise<string | null> {
  // Lock before the read: a concurrent narrowing/revoke must be observed after
  // waiting, never projected from a pre-lock snapshot. The caller owns the tx.
  await db.query("SELECT id FROM grants WHERE id = $1 FOR UPDATE", [grantId]);
  const result = await db.query<NextGrantSource & { id: string }>(
    `SELECT g.id, nc.collection_id::text AS collection, nc.sync, g.user_id, g.application_id,
            g.application_installation_id, g.operations, g.file_capability, g.scope,
            (g.application_authorization->'binding'->'contracts'->>'semantic_capabilities')::int AS semantic,
            g.application_authorization->'binding'->>'application_declaration_id' AS declaration, k.client_pk
     FROM grants g
     LEFT JOIN collections col ON col.id = g.collection_id
     JOIN next_collections nc ON nc.collection_id::text = COALESCE(col.local_id::text, g.hosted_collection_id::text, g.next_collection_id::text)
     LEFT JOIN next_grant_client_keys k ON k.grant_id = g.id
     WHERE g.id = $1 AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
       AND nc.runtime = 'next' AND nc.left_sync_at IS NULL`, [grantId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const prior = (await db.query<{ collection_id: string; log_grant_id: string; terms_digest: Buffer; active: boolean }>(
    "SELECT collection_id, log_grant_id, terms_digest, active FROM next_grant_bindings WHERE grant_id = $1 FOR UPDATE", [grantId]
  )).rows[0];
  if (row.semantic === 1 && freshLegacy) freshLegacyNextOperations(freshLegacy, row.operations);
  // The binding table's sole publisher is this function. Its existence proves
  // that a semantic1 grant went through fresh validation, without a new marker.
  const { terms, policy } = projectNextGrant({ ...row, next_bound: !!prior || (row.semantic === 1 && !!freshLegacy) });
  if (prior?.active && prior.terms_digest.equals(terms)) return prior.log_grant_id;
  const logGrantId = randomUUID();
  const ops: PolicyOp[] = [];
  if (prior?.active) {
    if (prior.collection_id !== row.collection) throw new Error("An active grant cannot move between collections.");
    ops.push({ op: "grant-revoke", grant: prior.log_grant_id });
  }
  ops.push({ ...policy, grant: logGrantId });
  if (!await queueNextPolicy(db, row.collection, ops)) throw new Error("Next grant collection disappeared before policy publication.");
  await db.query(
    `INSERT INTO next_grant_bindings(grant_id, collection_id, log_grant_id, terms_digest, active)
     VALUES($1,$2,$3,$4,true) ON CONFLICT(grant_id) DO UPDATE SET
       collection_id = EXCLUDED.collection_id, log_grant_id = EXCLUDED.log_grant_id,
       terms_digest = EXCLUDED.terms_digest, active = true`, [grantId, row.collection, logGrantId, terms]
  );
  // A private device must approve each new log identity (and its sealed folders).
  await db.query("DELETE FROM next_grant_approvals WHERE grant_id = $1", [grantId]);
  return logGrantId;
}
