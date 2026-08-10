import type { ConnectContractSupport } from "@mdbase-dev/connect-protocol";
import {
  CONNECT_CONTRACT_SUPPORT,
  CONTROL_PROTOCOL_VERSION,
  MINIMUM_CONNECTOR_VERSION,
  RELAY_REQUIRED_CAPABILITIES
} from "@mdbase-dev/connect-protocol";
import type { WebSocket } from "ws";

const HANDSHAKE_TIMEOUT_MS = 5_000;
const INCOMPATIBLE_CLOSE_CODE = 4406;
export const CONNECTOR_UPDATE_URL =
  "https://github.com/mdbase-dev/mdbase-connect/releases/latest";

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
  mismatch?: RelayContractMismatch
): void {
  if (socket.readyState !== 1) return;
  socket.send(JSON.stringify({
    type: "relay_incompatible",
    protocol_version: CONTROL_PROTOCOL_VERSION,
    code: mismatch?.code ?? "connector_upgrade_required",
    message: "This mdbase Connect version is no longer compatible. Update the desktop app and reconnect.",
    ...(mismatch ? { details: mismatch.details } : {}),
    minimum_connector_version: MINIMUM_CONNECTOR_VERSION,
    update_url: CONNECTOR_UPDATE_URL
  }), () => socket.close(INCOMPATIBLE_CLOSE_CODE, "Connector upgrade required"));
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
