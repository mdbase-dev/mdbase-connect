import type { ConnectRequestOptions } from "./operation-types.js";

export const EXPERIMENTAL_HOSTED_COLLABORATION_V1 = Symbol.for(
  "mdbase.connect.experimental-hosted-collaboration.v1"
);

export type ExperimentalCollaborationMode = "read_only" | "read_write";

export interface ExperimentalCollaborationTicketRequest extends ConnectRequestOptions {
  path: string;
  mode?: ExperimentalCollaborationMode;
  /** Bind reconnect to the room epoch learned from the previous ticket. */
  epoch?: number;
}

export interface ExperimentalCollaborationTicketResult {
  ticket: string;
  webSocketUrl: string;
  expiresAt: string;
  profile: "markdown-body-yjs-v13";
  mode: ExperimentalCollaborationMode;
  epoch: number;
}

export interface ExperimentalHostedCollaborationBridgeV1 {
  issueTicket(
    request: ExperimentalCollaborationTicketRequest
  ): Promise<ExperimentalCollaborationTicketResult>;
}

export function installExperimentalHostedCollaborationBridge(
  target: object,
  bridge: ExperimentalHostedCollaborationBridgeV1
): void {
  assertBridge(bridge);
  if (Object.prototype.hasOwnProperty.call(target, EXPERIMENTAL_HOSTED_COLLABORATION_V1)) {
    throw new TypeError("The experimental hosted collaboration bridge is already installed.");
  }
  Object.defineProperty(target, EXPERIMENTAL_HOSTED_COLLABORATION_V1, {
    value: Object.freeze({ issueTicket: bridge.issueTicket }),
    enumerable: false,
    configurable: false,
    writable: false
  });
}

export function getExperimentalHostedCollaborationBridge(
  target: unknown
): ExperimentalHostedCollaborationBridgeV1 | null {
  if ((typeof target !== "object" && typeof target !== "function") || target === null) {
    return null;
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    target,
    EXPERIMENTAL_HOSTED_COLLABORATION_V1
  );
  if (!descriptor
      || descriptor.enumerable
      || descriptor.configurable
      || descriptor.writable
      || !("value" in descriptor)) return null;
  return isBridge(descriptor.value) ? descriptor.value : null;
}

export function requireExperimentalHostedCollaborationBridge(
  target: unknown
): ExperimentalHostedCollaborationBridgeV1 {
  const bridge = getExperimentalHostedCollaborationBridge(target);
  if (!bridge) throw new TypeError("The experimental hosted collaboration bridge is unavailable.");
  return bridge;
}

function assertBridge(value: unknown): asserts value is ExperimentalHostedCollaborationBridgeV1 {
  if (!isBridge(value)) throw new TypeError("Invalid experimental hosted collaboration bridge.");
}

function isBridge(value: unknown): value is ExperimentalHostedCollaborationBridgeV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Reflect.ownKeys(value).length === 1
    && Object.prototype.hasOwnProperty.call(value, "issueTicket")
    && typeof (value as { issueTicket?: unknown }).issueTicket === "function";
}
