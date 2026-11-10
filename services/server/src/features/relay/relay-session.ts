import type {
  ConnectContractSupport, EncryptedRelayEnvelope
} from "@mdbase-dev/connect-protocol";
import type { WebSocket } from "ws";
import type { RelayBrokerBinding } from "./relay-broker.js";
import type { PolicyMode } from "./relay-policy.js";
import type { RelayPolicySession } from "./relay-policy-session.js";
import type { ExpectedRelayResponse } from "./relay-routing.js";

export interface PendingRelayRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  socket: WebSocket;
  connectorId?: string;
  grantId?: string;
  requestBytes?: number;
  expectedEncrypted?: EncryptedRelayEnvelope;
  expectedType?: ExpectedRelayResponse;
  expectedPolicyRevision?: string;
  expectedPolicyConnectorId?: string;
  expectedPolicyGeneration?: string;
  expectedPolicyMode?: PolicyMode;
  expectedPolicyInitial?: boolean;
  mutationMayHaveExecuted: boolean;
}

export interface ConnectorRelaySession {
  generation: string;
  socket: WebSocket;
  binding: RelayBrokerBinding;
  capabilities: string[];
  contractSupport: ConnectContractSupport;
  lastUsageReportAt: number;
  mode: PolicyMode;
  ready: boolean;
  changedPolicyRequested: number;
  changedPolicySettled: number;
  policy: RelayPolicySession;
}
