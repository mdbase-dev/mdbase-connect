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
const POLICY_STAGE_DELAY_MS = 2_000;

export type ConnectorPolicyStage =
  | "database_checkout"
  | "transaction_begin"
  | "connector_sequence_update"
  | "grant_inventory"
  | "transaction_commit"
  | "generation_before"
  | "snapshot_build"
  | "generation_after_build"
  | "generation_after_ack"
  | "connector_lookup"
  | "transaction_rollback"
  | "policy_delivery_ack"
  | "replacement_broadcast"
  | "initial_policy";

/** Privacy-safe timing discriminator for production-only policy stalls. */
export async function observeConnectorPolicyStage<T>(
  stage: ConnectorPolicyStage,
  operation: () => Promise<T>
): Promise<T> {
  let delayed = false;
  const timer = setTimeout(() => {
    delayed = true;
    console.warn("connector policy stage delayed", {
      class: "delivery_unavailable",
      stage
    });
  }, POLICY_STAGE_DELAY_MS);
  try {
    const result = await operation();
    if (delayed) console.warn("connector policy delayed stage settled", { stage, outcome: "ok" });
    return result;
  } catch (error) {
    if (delayed) {
      console.warn("connector policy delayed stage settled", { stage, outcome: "error" });
    } else {
      console.warn("connector policy stage failed", {
        class: "delivery_unavailable",
        stage,
        outcome: "error"
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function reportConnectorRelayClose(code: number, ready: boolean): void {
  const closeClass = code === 4001
    ? "replacement"
    : code === 1000 || code === 1001
      ? "normal"
      : "non_normal";
  console.info("connector relay closed", { close_class: closeClass, ready });
}

export class PolicySequenceExhaustedError extends Error {
  readonly code = "policy_sequence_exhausted";

  constructor() {
    super("The connector policy sequence is exhausted.");
    this.name = "PolicySequenceExhaustedError";
  }
}

export type PolicyMode = "lease_v1" | "legacy_ack_v0";

export interface LeasePolicySnapshot {
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

/** Frozen beta.90 shape. Do not add lease metadata: beta.90 ignores it. */
export interface LegacyPolicySnapshot {
  type: "policy_snapshot";
  protocol_version: 1;
  request_id: string;
  revision: string;
  grants: Array<Record<string, unknown>>;
}

export type PolicySnapshot = LeasePolicySnapshot | LegacyPolicySnapshot;

export async function resolvePolicyAppliedAck(input: {
  db: DatabasePool;
  requestId: string;
  message: { revision?: string; ok?: boolean; error?: { code?: string; message?: string } };
  expectedRevision?: string;
  connectorId?: string;
  generation?: string;
  mode: PolicyMode;
  initial: boolean;
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
  if (message.ok) {
    const observed = await input.db.query(
      `UPDATE connectors
       SET latest_policy_ack_mode = $3,
           latest_policy_ack_generation = relay_generation,
           latest_policy_ack_at = now(),
           policy_lease_adopted_at = CASE
             WHEN $3 = 'lease_v1' AND $4::boolean
               THEN COALESCE(policy_lease_adopted_at, now())
             ELSE policy_lease_adopted_at END
       WHERE id = $1 AND relay_generation = $2::bigint`,
      [connectorId, generation, input.mode, input.initial]
    );
    if (observed.rowCount !== 1 || !input.isStillCurrent()) {
      input.reject(new ConnectorOperationError(
        "stale_policy_acknowledgement",
        "The connector session changed before policy acknowledgement."
      ));
      return;
    }
    input.resolve();
  } else input.reject(new ConnectorOperationError(
    message.error?.code ?? "policy_apply_failed",
    message.error?.message ?? "The connector could not apply its policy."
  ));
}

export function policyGrantCreatedAtIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("Policy grant created_at is invalid.");
  }
  return date.toISOString();
}

export interface PolicyGrantSource {
  id: string;
  application_id: string;
  collection_id: string;
  operations: string[];
  scope: GrantScope;
  application_name: string;
  application_distribution: "web" | "portable";
  application_homepage: string;
  application_project_url?: string | null;
  application_origin: string;
  application_icon?: string | null;
  collection_name: string;
  notification_criteria: unknown[];
  created_at: Date | string;
  encryption?: unknown | null;
  file_capability?: unknown | null;
  application_authorization: ApplicationAuthorizationProof;
}

export function normalizePolicyGrant(grant: PolicyGrantSource): Record<string, unknown> {
  return {
    id: grant.id,
    application_id: grant.application_id,
    collection_id: grant.collection_id,
    operations: grant.operations,
    scope: grant.scope,
    application_name: grant.application_name,
    application_distribution: grant.application_distribution,
    application_homepage: grant.application_homepage,
    ...(grant.application_project_url == null
      ? {}
      : { application_project_url: grant.application_project_url }),
    application_origin: grant.application_origin === "null"
      ? "null"
      : new URL(grant.application_origin).origin,
    ...(grant.application_icon == null ? {} : { application_icon: grant.application_icon }),
    collection_name: grant.collection_name,
    notification_criteria: grant.notification_criteria,
    created_at: policyGrantCreatedAtIso(grant.created_at),
    ...(grant.encryption == null ? {} : { encryption: grant.encryption }),
    ...(grant.file_capability == null ? {} : { file_capability: grant.file_capability }),
    application_authorization: grant.application_authorization
  };
}

export async function buildPolicySnapshot(
  db: DatabasePool,
  connectorId: string,
  leaseMs: number,
  expectedRelayGeneration?: string,
  isStillCurrent: () => boolean = () => true,
  mode: PolicyMode = "lease_v1"
): Promise<PolicySnapshot | null> {
  const connection = await observeConnectorPolicyStage("database_checkout", () => db.connect());
  const rollback = () => observeConnectorPolicyStage(
    "transaction_rollback", () => connection.query("ROLLBACK")
  );
  try {
    if (!isStillCurrent()) return null;
    await observeConnectorPolicyStage("transaction_begin", () => connection.query("BEGIN"));
    if (!isStillCurrent()) {
      await rollback();
      return null;
    }
    const active = await observeConnectorPolicyStage("connector_sequence_update", () =>
      connection.query<{
        policy_sequence: string | number;
        database_now: Date | string;
      }>(
      `UPDATE connectors
       SET policy_sequence = policy_sequence + 1
       WHERE id = $1 AND revoked_at IS NULL
         AND policy_sequence < $2::bigint
         AND ($3::bigint IS NULL OR relay_generation = $3::bigint)
         AND user_id IN (SELECT id FROM users WHERE suspended_at IS NULL)
       RETURNING policy_sequence, now() AS database_now`,
      [connectorId, MAX_POLICY_SEQUENCE.toString(), expectedRelayGeneration ?? null]
    ));
    if (!active.rows[0]) {
      const existing = await observeConnectorPolicyStage("connector_lookup", () =>
        connection.query<{ policy_sequence: string | number }>(
        `SELECT policy_sequence FROM connectors
         WHERE id = $1 AND revoked_at IS NULL
           AND ($2::bigint IS NULL OR relay_generation = $2::bigint)
           AND user_id IN (SELECT id FROM users WHERE suspended_at IS NULL)`,
        [connectorId, expectedRelayGeneration ?? null]
      ));
      await rollback();
      if (existing.rows[0]
          && BigInt(existing.rows[0].policy_sequence) >= MAX_POLICY_SEQUENCE) {
        throw new PolicySequenceExhaustedError();
      }
      return null;
    }
    const grants = await observeConnectorPolicyStage("grant_inventory", () => connection.query<{
      id: string; application_id: string; application_name: string;
      application_distribution: "web" | "portable"; application_homepage: string;
      application_project_url: string | null; application_origin: string;
      application_icon: string | null; local_id: string; collection_name: string;
      operations: string[]; scope: GrantScope; encryption: unknown | null;
      file_capability: unknown | null;
      application_authorization: ApplicationAuthorizationProof;
      notification_criteria: unknown[]; created_at: Date | string;
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
         AND g.scope->>'access' = 'full_collection'
       ORDER BY g.id`,
      [connectorId]
    ));
    const sequenceValue = BigInt(active.rows[0].policy_sequence);
    if (sequenceValue > MAX_POLICY_SEQUENCE) throw new PolicySequenceExhaustedError();
    const sequence = Number(sequenceValue);
    const leaseIssuedAtMs = new Date(active.rows[0].database_now).getTime();
    const policyGrants = grants.rows.map((grant) => normalizePolicyGrant({
      ...grant,
      collection_id: grant.local_id
    }));
    await observeConnectorPolicyStage("transaction_commit", () => connection.query("COMMIT"));
    if (mode === "legacy_ack_v0") {
      return {
        type: "policy_snapshot",
        protocol_version: CONTROL_PROTOCOL_VERSION,
        request_id: randomUUID(),
        revision: canonicalSha256(policyGrants),
        grants: policyGrants
      };
    }
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
    await rollback();
    throw error;
  } finally {
    connection.release();
  }
}
