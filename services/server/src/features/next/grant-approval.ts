// How the control plane learns that a device approved a grant on a private synced
// collection, and with what scope (mdbase-next interface note
// 2026-10-04-control-grant-approval-report.md, SEC-046).
//
// The `grant_approval` log item is sealed, so the control plane cannot read which grant
// it approves or which capabilities. The approving device reports both, signed with its
// device key, and the control plane checks in the log that a `grant_approval` signed by
// that device exists at the reported position. Replicas still enforce the real approval;
// this only lets the control plane's own services (timers, channels, delivery) honour
// what the user approved.
import { createHash, verify } from "node:crypto";
import { APPLICATION_CAPABILITY_DEFINITIONS, type ApplicationCapabilityId } from "@mdbase-dev/connect-protocol";
import type { DatabaseQueryable } from "../../database-types.js";
import { grantCapabilityGroups } from "./devices.js";
import type { LogServiceClient } from "./log-service-client.js";
import { ed25519PublicKeyObject } from "./policy-keys.js";
import { decodeCbor, domainHash, encodeCbor, uuidBytes, type Decoded } from "./policy-wire.js";

const GRANT_APPROVAL_KIND = 6;

export class GrantApprovalReportError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: string, message: string) {
    super(message);
  }
}

/** Sorted, de-duplicated capability names: the order signed and stored. */
function canonicalCapabilities(capabilities: readonly string[]): string[] {
  return [...new Set(capabilities)].sort();
}

/** `H("mdbase/v1/client-fp", client_pk)`: the full digest whose prefix is shown to users. */
export function clientKeyDigest(clientPk: Uint8Array): Uint8Array {
  return domainHash("mdbase/v1/client-fp", clientPk);
}

/**
 * `H("mdbase/v1/grant-approval-report", collection ‖ grant ‖ u64be(seq) ‖
 * canonical(capabilities) ‖ client_fp)`.
 */
export function grantApprovalReportDigest(collection: string, grant: string, seq: number, capabilities: readonly string[], clientFp: Uint8Array): Uint8Array {
  const position = Buffer.alloc(8);
  position.writeBigUInt64BE(BigInt(seq));
  return domainHash("mdbase/v1/grant-approval-report", Buffer.concat([
    uuidBytes(collection), uuidBytes(grant), position, encodeCbor(canonicalCapabilities(capabilities)), clientFp
  ]));
}

interface GrantContext {
  id: string;
  log_grant_id: string;
  user_id: string;
  active: boolean;
  collection: string | null;
  sync: "private" | "cloud_copy" | null;
  application_id: string;
  operations: string[];
  file_capability: unknown;
  semantic_capabilities: number | null;
  client_pk: Buffer | null;
}

async function grantContext(db: DatabaseQueryable, grantId: string): Promise<GrantContext | null> {
  const result = await db.query<GrantContext>(
    `SELECT g.id, COALESCE(binding.log_grant_id, g.id) AS log_grant_id, g.user_id,
            (g.revoked_at IS NULL AND g.activated_at IS NOT NULL AND u.suspended_at IS NULL
             AND (nc.runtime IS DISTINCT FROM 'next' OR binding.active = true)) AS active,
            COALESCE(col.local_id::text, g.hosted_collection_id::text) AS collection, nc.sync,
            g.application_id, g.operations, g.file_capability,
            (g.application_authorization->'binding'->'contracts'->>'semantic_capabilities')::int AS semantic_capabilities,
            k.client_pk
     FROM grants g
     JOIN users u ON u.id = g.user_id
     LEFT JOIN collections col ON col.id = g.collection_id
     LEFT JOIN next_collections nc ON nc.collection_id::text = COALESCE(col.local_id::text, g.hosted_collection_id::text)
     LEFT JOIN next_grant_client_keys k ON k.grant_id = g.id
     LEFT JOIN next_grant_bindings binding ON binding.grant_id = g.id
     WHERE g.id = $1 OR binding.log_grant_id = $1`,
    [grantId]
  );
  return result.rows[0] ?? null;
}

/** SHA-256 of the grant's terms: application, operations, file capability, client key. */
function termsDigest(grant: GrantContext): Buffer {
  return createHash("sha256").update(JSON.stringify([
    grant.log_grant_id,
    grant.application_id,
    [...grant.operations].sort(),
    grant.file_capability ?? null,
    grant.client_pk?.toString("hex") ?? null
  ])).digest();
}

const field = (value: Decoded, key: number) => (value instanceof Map ? value.get(key) : undefined);

/** Verify and record a device's approval report for a grant on a private collection. */
export async function reportGrantApproval(
  db: DatabaseQueryable,
  log: Pick<LogServiceClient, "controlItemAt">,
  connector: { id: string },
  grantId: string,
  body: Record<string, unknown>
): Promise<{ grant_id: string; approved_seq: number; capabilities: string[] }> {
  const deviceId = typeof body.device_id === "string" && /^[0-9a-f-]{36}$/.test(body.device_id) ? body.device_id : null;
  const seq = typeof body.seq === "number" && Number.isSafeInteger(body.seq) && body.seq > 0 ? body.seq : null;
  const capabilities = Array.isArray(body.capabilities) && body.capabilities.length > 0
    && body.capabilities.every((capability) => typeof capability === "string" && capability in APPLICATION_CAPABILITY_DEFINITIONS)
    ? canonicalCapabilities(body.capabilities as string[]) : null;
  const clientFp = typeof body.client_fp === "string" && /^[0-9a-f]{64}$/.test(body.client_fp) ? Buffer.from(body.client_fp, "hex") : null;
  const sig = typeof body.sig === "string" && /^[0-9a-f]{128}$/.test(body.sig) ? Buffer.from(body.sig, "hex") : null;
  if (!deviceId || !seq || !capabilities || !clientFp || !sig) throw new GrantApprovalReportError(400, "invalid_report", "The approval report is malformed.");
  const grant = await grantContext(db, grantId);
  if (!grant?.active || !grant.collection) throw new GrantApprovalReportError(404, "grant_not_found", "No active grant.");
  if (grant.sync !== "private") throw new GrantApprovalReportError(409, "approval_not_required", "Only grants on private synced collections need a device approval.");
  if (!grant.client_pk || !Buffer.from(clientKeyDigest(grant.client_pk)).equals(clientFp)) {
    throw new GrantApprovalReportError(409, "client_key_mismatch", "The approval names another app key than the grant's.");
  }
  const offered = new Set(grantCapabilityGroups(grant.semantic_capabilities ?? undefined, grant.operations) ?? []);
  if (!capabilities.every((capability) => offered.has(capability))) {
    throw new GrantApprovalReportError(409, "capabilities_not_offered", "The approved capabilities must be a subset of the grant's.");
  }
  const device = await db.query<{ sign_pk: Buffer }>(
    `SELECT d.sign_pk FROM next_devices d JOIN connectors c ON c.id = d.connector_id
     WHERE d.id = $1 AND d.connector_id = $2 AND d.user_id = $3 AND c.revoked_at IS NULL`,
    [deviceId, connector.id, grant.user_id]
  );
  const signPk = device.rows[0]?.sign_pk;
  if (!signPk) throw new GrantApprovalReportError(403, "device_not_allowed", "The device is not this connector's, or not the grant account's.");
  if (!verify(null, grantApprovalReportDigest(grant.collection, grant.log_grant_id, seq, capabilities, clientFp), ed25519PublicKeyObject(signPk), sig)) {
    throw new GrantApprovalReportError(403, "invalid_signature", "The approval report signature does not verify.");
  }
  const bytes = await log.controlItemAt(grant.collection, seq);
  let item: Decoded | undefined;
  try {
    item = bytes ? decodeCbor(bytes) : undefined;
  } catch {
    item = undefined;
  }
  const signer = item && field(item, 6);
  const itemCollection = item && field(item, 2);
  if (!item || field(item, 1) !== GRANT_APPROVAL_KIND
      || !(signer instanceof Uint8Array) || !Buffer.from(signer).equals(Buffer.from(uuidBytes(deviceId)))
      || !(itemCollection instanceof Uint8Array) || !Buffer.from(itemCollection).equals(Buffer.from(uuidBytes(grant.collection)))) {
    throw new GrantApprovalReportError(409, "approval_not_in_log", "No grant_approval signed by this device is at that position.");
  }
  // Replicas use the first valid approval in log order: keep the lowest position, and a
  // report for the current terms replaces one recorded for earlier terms (SEC-046 §2, §3).
  const terms = termsDigest(grant);
  const stored = await db.query<{ approved_seq: string; capabilities: string[] }>(
    `INSERT INTO next_grant_approvals (grant_id, device_id, approved_seq, capabilities, terms_digest, signature)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (grant_id) DO UPDATE SET
       device_id = EXCLUDED.device_id, approved_seq = EXCLUDED.approved_seq,
       capabilities = EXCLUDED.capabilities, terms_digest = EXCLUDED.terms_digest,
       signature = EXCLUDED.signature, reported_at = now()
     WHERE next_grant_approvals.terms_digest <> EXCLUDED.terms_digest
        OR EXCLUDED.approved_seq < next_grant_approvals.approved_seq
     RETURNING approved_seq, capabilities`,
    [grant.id, deviceId, seq, capabilities, terms, sig]
  );
  const current = stored.rows[0] ?? (await db.query<{ approved_seq: string; capabilities: string[] }>(
    "SELECT approved_seq, capabilities FROM next_grant_approvals WHERE grant_id = $1", [grant.id]
  )).rows[0]!;
  return { grant_id: grant.log_grant_id, approved_seq: Number(current.approved_seq), capabilities: current.capabilities };
}

export interface GrantApproval {
  /** The grant is on a private synced collection, so a device approval is needed. */
  required: boolean;
  approved: boolean;
  /** The approved capability groups when approved; otherwise null. */
  capabilities: string[] | null;
}

/**
 * Whether a grant needs a device approval and what was approved. An approval counts only
 * while the grant is active, its terms are unchanged, and the approving device is still
 * active and the grant account's.
 */
export async function grantDeviceApproval(db: DatabaseQueryable, grantId: string): Promise<GrantApproval> {
  const grant = await grantContext(db, grantId);
  const required = grant?.sync === "private";
  if (!grant || !required) return { required, approved: false, capabilities: null };
  const approval = await db.query<{ capabilities: string[] }>(
    `SELECT a.capabilities FROM next_grant_approvals a
     JOIN next_devices d ON d.id = a.device_id
     JOIN connectors c ON c.id = d.connector_id
     WHERE a.grant_id = $1 AND a.terms_digest = $3 AND d.user_id = $2 AND c.revoked_at IS NULL`,
    [grant.id, grant.user_id, termsDigest(grant)]
  );
  const capabilities = approval.rows[0]?.capabilities;
  return grant.active && capabilities
    ? { required, approved: true, capabilities }
    : { required, approved: false, capabilities: null };
}

/**
 * The per-operation check notify uses: an operation of the grant is usable when no
 * approval is required, or when it belongs to an approved capability group.
 */
export function approvalAllowsOperation(approval: GrantApproval, operation: string): boolean {
  if (!approval.required) return true;
  if (!approval.approved || !approval.capabilities) return false;
  return approval.capabilities.some((capability) =>
    (APPLICATION_CAPABILITY_DEFINITIONS[capability as ApplicationCapabilityId] as readonly string[] | undefined)?.includes(operation) === true);
}
