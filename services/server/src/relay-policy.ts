import { randomUUID } from "node:crypto";
import type {
  ApplicationAuthorizationProof,
  GrantScope
} from "@mdbase-dev/connect-protocol";
import { CONTROL_PROTOCOL_VERSION } from "@mdbase-dev/connect-protocol";
import { canonicalSha256 } from "./canonical-json.js";
import type { DatabasePool } from "./db.js";
import { ConnectorOperationError } from "./relay-errors.js";

const MAX_POLICY_SEQUENCE = BigInt(Number.MAX_SAFE_INTEGER);

export class PolicySequenceExhaustedError extends Error {
  readonly code = "policy_sequence_exhausted";

  constructor() {
    super("The connector policy sequence is exhausted.");
    this.name = "PolicySequenceExhaustedError";
  }
}

export interface PolicySnapshot {
  type: "policy_snapshot";
  protocol_version: 1;
  request_id: string;
  revision: string;
  connector_id: string;
  sequence: number;
  lease_issued_at_ms: number;
  lease_expires_at_ms: number;
  grants: Array<Record<string, unknown>>;
}

export async function resolvePolicyAppliedAck(input: {
  db: DatabasePool;
  requestId: string;
  message: { revision?: string; ok?: boolean; error?: { code?: string; message?: string } };
  expectedRevision?: string;
  connectorId?: string;
  generation?: string;
  isStillCurrent(): boolean;
  resolve(): void;
  reject(error: Error): void;
}): Promise<void> {
  const { connectorId, generation, message } = input;
  if (message.revision !== input.expectedRevision || !connectorId || !generation) {
    input.reject(new ConnectorOperationError(
      "invalid_policy_acknowledgement",
      "The connector acknowledged a different policy revision."
    ));
    return;
  }
  const current = await input.db.query<{ relay_generation: string | number }>(
    `SELECT c.relay_generation FROM connectors c
     JOIN users u ON u.id = c.user_id
     WHERE c.id = $1 AND c.revoked_at IS NULL AND u.suspended_at IS NULL`,
    [connectorId]
  );
  if (!input.isStillCurrent()
      || !current.rows[0]
      || String(current.rows[0].relay_generation) !== generation) {
    input.reject(new ConnectorOperationError(
      "stale_policy_acknowledgement",
      "The connector session changed before policy acknowledgement."
    ));
    return;
  }
  if (message.ok) input.resolve();
  else input.reject(new ConnectorOperationError(
    message.error?.code ?? "policy_apply_failed",
    message.error?.message ?? "The connector could not apply its policy."
  ));
}

export async function buildPolicySnapshot(
  db: DatabasePool,
  connectorId: string,
  leaseMs: number
): Promise<PolicySnapshot | null> {
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    const active = await connection.query<{
      policy_sequence: string | number;
      database_now: Date | string;
    }>(
      `UPDATE connectors
       SET policy_sequence = policy_sequence + 1
       WHERE id = $1 AND revoked_at IS NULL
         AND policy_sequence < $2::bigint
         AND user_id IN (SELECT id FROM users WHERE suspended_at IS NULL)
       RETURNING policy_sequence, now() AS database_now`,
      [connectorId, MAX_POLICY_SEQUENCE.toString()]
    );
    if (!active.rows[0]) {
      const existing = await connection.query<{ policy_sequence: string | number }>(
        `SELECT policy_sequence FROM connectors
         WHERE id = $1 AND revoked_at IS NULL
           AND user_id IN (SELECT id FROM users WHERE suspended_at IS NULL)`,
        [connectorId]
      );
      await connection.query("ROLLBACK");
      if (existing.rows[0]
          && BigInt(existing.rows[0].policy_sequence) >= MAX_POLICY_SEQUENCE) {
        throw new PolicySequenceExhaustedError();
      }
      return null;
    }
    const grants = await connection.query<{
      id: string; application_id: string; application_name: string;
      application_distribution: "web" | "portable"; application_homepage: string;
      application_project_url: string | null; application_origin: string;
      application_icon: string | null; local_id: string; collection_name: string;
      operations: string[]; scope: GrantScope; encryption: unknown | null;
      file_capability: unknown | null;
      application_authorization: ApplicationAuthorizationProof;
      notification_criteria: unknown[]; created_at: string;
    }>(
      `SELECT g.id, g.application_id, a.name AS application_name,
              a.distribution AS application_distribution,
              a.homepage AS application_homepage,
              a.project_url AS application_project_url,
              CASE WHEN g.application_origin = '' THEN a.homepage
                   ELSE g.application_origin END AS application_origin,
              a.icon AS application_icon,
              c.local_id, c.display_name AS collection_name, g.operations, g.scope,
              g.encryption, g.file_capability, g.application_authorization,
              g.notification_criteria, g.created_at
       FROM grants g
       JOIN collections c ON c.id = g.collection_id
       JOIN applications a ON a.id = g.application_id
       WHERE c.connector_id = $1 AND g.revoked_at IS NULL
         AND g.activated_at IS NOT NULL
       ORDER BY g.id`,
      [connectorId]
    );
    const sequenceValue = BigInt(active.rows[0].policy_sequence);
    if (sequenceValue > MAX_POLICY_SEQUENCE) throw new PolicySequenceExhaustedError();
    const sequence = Number(sequenceValue);
    const leaseIssuedAtMs = new Date(active.rows[0].database_now).getTime();
    const policyGrants = grants.rows.map((grant) => ({
      id: grant.id,
      application_id: grant.application_id,
      collection_id: grant.local_id,
      operations: grant.operations,
      scope: grant.scope,
      application_name: grant.application_name,
      application_distribution: grant.application_distribution,
      application_homepage: grant.application_homepage,
      ...(grant.application_project_url
        ? { application_project_url: grant.application_project_url }
        : {}),
      application_origin: grant.application_origin === "null"
        ? "null"
        : new URL(grant.application_origin).origin,
      application_icon: grant.application_icon,
      collection_name: grant.collection_name,
      notification_criteria: grant.notification_criteria,
      created_at: grant.created_at,
      ...(grant.encryption ? { encryption: grant.encryption } : {}),
      ...(grant.file_capability ? { file_capability: grant.file_capability } : {}),
      application_authorization: grant.application_authorization
    }));
    await connection.query("COMMIT");
    const leaseExpiresAtMs = leaseIssuedAtMs + leaseMs;
    const policyBody = {
      connector_id: connectorId,
      sequence,
      lease_issued_at_ms: leaseIssuedAtMs,
      lease_expires_at_ms: leaseExpiresAtMs,
      grants: policyGrants
    };
    return {
      type: "policy_snapshot",
      protocol_version: CONTROL_PROTOCOL_VERSION,
      request_id: randomUUID(),
      revision: canonicalSha256(policyBody),
      ...policyBody
    };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}
