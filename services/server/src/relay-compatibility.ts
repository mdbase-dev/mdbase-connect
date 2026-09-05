import type { ConnectContractRequirements, ConnectContractSupport } from "@mdbase-dev/connect-protocol";
import type { DatabaseQueryable } from "./database-types.js";
import { RelayUnavailableError } from "./relay-errors.js";
import {
  APPLICATION_DECLARATION_EVIDENCE_CAPABILITY,
  CONNECT_CONTRACT_SUPPORT,
  CONTROL_PROTOCOL_VERSION,
  MINIMUM_CONNECTOR_VERSION,
  POLICY_FRESHNESS_LEASE_CAPABILITY,
  POLICY_FRESHNESS_LEASE_MINIMUM_CONNECTOR_VERSION,
  RELAY_REQUIRED_CAPABILITIES
} from "@mdbase-dev/connect-protocol";
import type { WebSocket } from "ws";

const HANDSHAKE_TIMEOUT_MS = 5_000;
const INCOMPATIBLE_CLOSE_CODE = 4406;
export const CONNECTOR_UPDATE_URL =
  "https://mdbase.dev/downloads/";

export interface RelayHello {
  protocol_version: number;
  connector_version: string;
  capabilities: string[];
  contract_support: ConnectContractSupport;
}

export interface RelayContractMismatch {
  code: "transport_protocol_incompatible"
    | "authorization_binding_incompatible"
    | "capability_contract_incompatible"
    | "durable_mutation_unsupported";
  details: {
    contract: string;
    required: Array<number | string>;
    supported: Array<number | string>;
    peer: "connector";
  };
}

export async function receiveRelayHello(socket: WebSocket): Promise<RelayHello | null> {
  return new Promise((resolve) => {
    const finish = (value: RelayHello | null) => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      resolve(value);
    };
    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const value = JSON.parse(raw.toString()) as Record<string, unknown>;
        finish(value.type === "relay_hello"
          && typeof value.protocol_version === "number"
          && typeof value.connector_version === "string"
          && Array.isArray(value.capabilities)
          && value.capabilities.every((capability) => typeof capability === "string")
          && isContractSupport(value.contract_support)
          ? {
              protocol_version: value.protocol_version,
              connector_version: value.connector_version,
              capabilities: value.capabilities as string[],
              contract_support: value.contract_support
            }
          : null);
      } catch {
        finish(null);
      }
    };
    const onClose = () => finish(null);
    const timer = setTimeout(() => finish(null), HANDSHAKE_TIMEOUT_MS);
    socket.once("message", onMessage);
    socket.once("close", onClose);
  });
}

export function relayContractMismatch(
  actual: ConnectContractSupport
): RelayContractMismatch | undefined {
  const axes = [
    ["operation_transport", "transport_protocol_incompatible"],
    ["authorization_binding", "authorization_binding_incompatible"],
    ["semantic_capabilities", "capability_contract_incompatible"],
    ["durable_mutation", "durable_mutation_unsupported"]
  ] as const;
  for (const [contract, code] of axes) {
    const required = CONNECT_CONTRACT_SUPPORT[contract];
    if (!required.some((version) => actual[contract].includes(version))) {
      return {
        code,
        details: {
          contract,
          required: [...required],
          supported: actual[contract],
          peer: "connector"
        }
      };
    }
  }
  return undefined;
}

export function relayCapabilityMismatch(
  capabilities: readonly string[]
): RelayContractMismatch | undefined {
  const missing = RELAY_REQUIRED_CAPABILITIES.filter(
    (capability) => !capabilities.includes(capability)
  );
  return missing.length === 0
    ? undefined
    : {
        code: "capability_contract_incompatible",
        details: {
          contract: "relay_capability",
          required: [...RELAY_REQUIRED_CAPABILITIES],
          supported: [...capabilities],
          peer: "connector"
        }
      };
}

export function rejectIncompatibleRelay(
  socket: WebSocket,
  mismatch?: RelayContractMismatch,
  minimumConnectorVersion: string = MINIMUM_CONNECTOR_VERSION
): void {
  if (socket.readyState !== 1) return;
  socket.send(JSON.stringify({
    type: "relay_incompatible",
    protocol_version: CONTROL_PROTOCOL_VERSION,
    code: mismatch?.code ?? "connector_upgrade_required",
    message: "This mdbase Connect version is no longer compatible. Update the desktop app and reconnect.",
    ...(mismatch ? { details: mismatch.details } : {}),
    minimum_connector_version: minimumConnectorVersion,
    update_url: CONNECTOR_UPDATE_URL
  }), () => socket.close(INCOMPATIBLE_CLOSE_CODE, "Connector upgrade required"));
}

export function relaySupportsContracts(
  session: { contractSupport: ConnectContractSupport; capabilities: readonly string[] } | undefined,
  required: ConnectContractRequirements
): boolean {
  const support = session?.contractSupport;
  return Boolean(
    support
    && support.operation_transport.includes(required.operation_transport)
    && (required.operation_transport_recovery ?? []).every((version) =>
      support.operation_transport.includes(version))
    && support.authorization_binding.includes(required.authorization_binding)
    && support.semantic_capabilities.includes(required.semantic_capabilities)
    && (required.semantic_capabilities !== 2
      || session!.capabilities.includes(APPLICATION_DECLARATION_EVIDENCE_CAPABILITY))
    && (required.durable_mutation === undefined
      || support.durable_mutation.includes(required.durable_mutation))
  );
}

export async function currentRelayGeneration(
  db: DatabaseQueryable,
  connectorId: string
): Promise<string | null> {
  const result = await db.query<{ relay_generation: string | number }>(
    `SELECT c.relay_generation FROM connectors c
     JOIN users u ON u.id = c.user_id
     WHERE c.id = $1 AND c.revoked_at IS NULL AND u.suspended_at IS NULL`,
    [connectorId]
  );
  return result.rows[0] ? String(result.rows[0].relay_generation) : null;
}

export async function lockAuthorizationGeneration(
  transaction: DatabaseQueryable,
  connectorId: string
): Promise<string | null> {
  // Caller owns BEGIN/COMMIT. Match account/inventory lock order: user,
  // connector, then collection. Suspension and generation replacement must
  // wait for publication; never acquire another pool connection here.
  const owner = await transaction.query(
    `SELECT id FROM users WHERE id = (SELECT user_id FROM connectors WHERE id = $1)
       AND suspended_at IS NULL FOR UPDATE`,
    [connectorId]
  );
  if (!owner.rows[0]) throw new RelayUnavailableError();
  // Single-table FOR UPDATE is exactly FOR UPDATE OF c; keeping the
  // already-locked user out of this query also makes lock ordering explicit.
  const authority = await transaction.query<{ relay_generation: string | number }>(
    `SELECT c.relay_generation FROM connectors c
     WHERE c.id = $1 AND c.user_id = $2 AND c.revoked_at IS NULL
     FOR UPDATE`,
    [connectorId, owner.rows[0].id]
  );
  return authority.rows[0] ? String(authority.rows[0].relay_generation) : null;
}

export async function recordIncompatibleRelay(
  db: DatabaseQueryable,
  connectorId: string,
  socket: WebSocket,
  hello: RelayHello | null,
  mismatch: RelayContractMismatch | undefined,
  connected: boolean
): Promise<void> {
  try {
    if (!connected) {
      await db.query(
        `UPDATE connectors
         SET connector_version = $2,
             last_incompatible_at = now(),
             incompatibility_code = $3,
             minimum_connector_version = $4,
             connector_update_url = $5
         WHERE id = $1`,
        [
          connectorId,
          hello?.connector_version ?? null,
          mismatch?.code ?? "connector_upgrade_required",
          MINIMUM_CONNECTOR_VERSION,
          CONNECTOR_UPDATE_URL
        ]
      );
    }
  } finally {
    rejectIncompatibleRelay(socket, mismatch);
  }
}

export async function rejectUnavailableRelay(
  db: DatabaseQueryable,
  connectorId: string,
  socket: WebSocket,
  hello: RelayHello,
  legacyMode: boolean,
  isConnected: () => boolean
): Promise<void> {
  const leaseBoundary = await db.query<{
    policy_lease_negotiated_at: Date | null;
    policy_lease_adopted_at: Date | null;
  }>(
    `SELECT c.policy_lease_negotiated_at, c.policy_lease_adopted_at FROM connectors c
     JOIN users u ON u.id = c.user_id
     WHERE c.id = $1 AND c.revoked_at IS NULL AND u.suspended_at IS NULL`,
    [connectorId]
  );
  if (legacyMode && (
    leaseBoundary.rows[0]?.policy_lease_negotiated_at
    || leaseBoundary.rows[0]?.policy_lease_adopted_at
  )) {
    if (!isConnected()) {
      await db.query(
        `UPDATE connectors
         SET connector_version = $2,
             last_incompatible_at = now(),
             incompatibility_code = 'capability_contract_incompatible',
             minimum_connector_version = $3,
             connector_update_url = $4
         WHERE id = $1 AND revoked_at IS NULL
           AND (policy_lease_negotiated_at IS NOT NULL
             OR policy_lease_adopted_at IS NOT NULL)
           AND user_id IN (
             SELECT id FROM users WHERE suspended_at IS NULL
           )`,
        [connectorId, hello.connector_version,
          POLICY_FRESHNESS_LEASE_MINIMUM_CONNECTOR_VERSION, CONNECTOR_UPDATE_URL]
      );
    }
    rejectIncompatibleRelay(socket, {
      code: "capability_contract_incompatible",
      details: {
        contract: "relay_capability",
        required: [POLICY_FRESHNESS_LEASE_CAPABILITY],
        supported: hello.capabilities,
        peer: "connector"
      }
    }, POLICY_FRESHNESS_LEASE_MINIMUM_CONNECTOR_VERSION);
  } else socket.close(4003, "Invalid connector credential");
}

export function connectorVersionAtLeast(actual: string, minimum: string): boolean {
  const left = parseConnectorVersion(actual);
  const right = parseConnectorVersion(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index]! > right.core[index]!;
    }
  }
  if (left.prerelease.length === 0) return true;
  if (right.prerelease.length === 0) return false;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return false;
    if (rightPart === undefined) return true;
    if (leftPart === rightPart) continue;
    const leftNumber = /^[0-9]+$/u.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^[0-9]+$/u.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) return leftNumber > rightNumber;
    if (leftNumber !== null) return false;
    if (rightNumber !== null) return true;
    return leftPart > rightPart;
  }
  return true;
}

function isContractSupport(value: unknown): value is ConnectContractSupport {
  if (!value || typeof value !== "object") return false;
  const support = value as Record<string, unknown>;
  return [
    "operation_transport",
    "authorization_binding",
    "semantic_capabilities",
    "durable_mutation"
  ].every((axis) => Array.isArray(support[axis])
    && (support[axis] as unknown[]).every((version) => Number.isInteger(version)));
}

function parseConnectorVersion(value: string): {
  core: [number, number, number];
  prerelease: string[];
} | null {
  const match = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? []
  };
}
