// How the control plane learns that a device approved a grant on a private synced
// collection (mdbase-next interface note 2026-10-04-control-grant-approval-report.md).
//
// The `grant_approval` log item is sealed, so the control plane cannot read which
// grant it approves. The approving device reports it, signed with its device key, and
// the control plane checks in the log that a `grant_approval` signed by that device
// exists at the reported position. Replicas still enforce the real approval; this only
// lets the control plane's own services (timers, channels, delivery) treat the grant
// as usable.
import { verify } from "node:crypto";
import type { DatabaseQueryable } from "../../database-types.js";
import type { LogServiceClient } from "./log-service-client.js";
import { ed25519PublicKeyObject } from "./policy-keys.js";
import { decodeCbor, domainHash, uuidBytes, type Decoded } from "./policy-wire.js";

const GRANT_APPROVAL_KIND = 6;

export class GrantApprovalReportError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: string, message: string) {
    super(message);
  }
}

/** `H("mdbase/v1/grant-approval-report", collection ‖ grant ‖ u64be(seq))`. */
export function grantApprovalReportDigest(collection: string, grant: string, seq: number): Uint8Array {
  const position = Buffer.alloc(8);
  position.writeBigUInt64BE(BigInt(seq));
  return domainHash("mdbase/v1/grant-approval-report", Buffer.concat([uuidBytes(collection), uuidBytes(grant), position]));
}

interface GrantContext {
  user_id: string;
  active: boolean;
  collection: string | null;
  sync: "private" | "cloud_copy" | null;
}

async function grantContext(db: DatabaseQueryable, grantId: string): Promise<GrantContext | null> {
  const result = await db.query<GrantContext>(
    `SELECT g.user_id, (g.revoked_at IS NULL AND g.activated_at IS NOT NULL AND u.suspended_at IS NULL) AS active,
            COALESCE(col.local_id::text, g.hosted_collection_id::text) AS collection, nc.sync
     FROM grants g
     JOIN users u ON u.id = g.user_id
     LEFT JOIN collections col ON col.id = g.collection_id
     LEFT JOIN next_collections nc ON nc.collection_id::text = COALESCE(col.local_id::text, g.hosted_collection_id::text)
     WHERE g.id = $1`,
    [grantId]
  );
  return result.rows[0] ?? null;
}

const field = (value: Decoded, key: number) => (value instanceof Map ? value.get(key) : undefined);

/** Verify and record a device's approval report for a grant on a private collection. */
export async function reportGrantApproval(
  db: DatabaseQueryable,
  log: Pick<LogServiceClient, "controlItemAt">,
  connector: { id: string },
  grantId: string,
  body: Record<string, unknown>
): Promise<{ grant_id: string; approved_seq: number }> {
  const deviceId = typeof body.device_id === "string" && /^[0-9a-f-]{36}$/.test(body.device_id) ? body.device_id : null;
  const seq = typeof body.seq === "number" && Number.isSafeInteger(body.seq) && body.seq > 0 ? body.seq : null;
  const sig = typeof body.sig === "string" && /^[0-9a-f]{128}$/.test(body.sig) ? Buffer.from(body.sig, "hex") : null;
  if (!deviceId || !seq || !sig) throw new GrantApprovalReportError(400, "invalid_report", "The approval report is malformed.");
  const grant = await grantContext(db, grantId);
  if (!grant?.active || !grant.collection) throw new GrantApprovalReportError(404, "grant_not_found", "No active grant.");
  if (grant.sync !== "private") throw new GrantApprovalReportError(409, "approval_not_required", "Only grants on private synced collections need a device approval.");
  const device = await db.query<{ sign_pk: Buffer }>(
    `SELECT d.sign_pk FROM next_devices d JOIN connectors c ON c.id = d.connector_id
     WHERE d.id = $1 AND d.connector_id = $2 AND d.user_id = $3 AND c.revoked_at IS NULL`,
    [deviceId, connector.id, grant.user_id]
  );
  const signPk = device.rows[0]?.sign_pk;
  if (!signPk) throw new GrantApprovalReportError(403, "device_not_allowed", "The device is not this connector's, or not the grant account's.");
  if (!verify(null, grantApprovalReportDigest(grant.collection, grantId, seq), ed25519PublicKeyObject(signPk), sig)) {
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
  await db.query(
    `INSERT INTO next_grant_approvals (grant_id, device_id, approved_seq, signature)
     VALUES ($1, $2, $3, $4) ON CONFLICT (grant_id) DO NOTHING`,
    [grantId, deviceId, seq, sig]
  );
  return { grant_id: grantId, approved_seq: seq };
}

/**
 * Whether a grant needs a device approval (private synced collections) and has one.
 * An approval counts only while the grant is active and the approving device is still
 * active and the grant account's. Notify's resolver: `usable = active && (!required || approved)`.
 */
export async function grantDeviceApproval(db: DatabaseQueryable, grantId: string): Promise<{ required: boolean; approved: boolean }> {
  const grant = await grantContext(db, grantId);
  const required = grant?.sync === "private";
  if (!grant || !required) return { required, approved: false };
  const approval = await db.query(
    `SELECT 1 FROM next_grant_approvals a
     JOIN next_devices d ON d.id = a.device_id
     JOIN connectors c ON c.id = d.connector_id
     WHERE a.grant_id = $1 AND d.user_id = $2 AND c.revoked_at IS NULL`,
    [grantId, grant.user_id]
  );
  return { required, approved: grant.active && approval.rows.length > 0 };
}
