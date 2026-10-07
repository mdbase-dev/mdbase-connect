import { NEXT_ACCOUNT_CAPABILITY, NEXT_NOISE_CONSENT_CAPABILITY, type GrantPolicy } from "@mdbase-dev/connect-protocol";
import type { WebSocket } from "ws";
import type { NextRelayDevices } from "./features/next/devices.js";
import type { RelayBrokerReply } from "./relay-broker.js";
import { nextAccountNegotiated } from "./relay-compatibility.js";
import { ConnectorOperationError } from "./relay-errors.js";
import { brokerError, brokerProblem } from "./relay-routing.js";
import type { ConnectorRelaySession } from "./relay-session.js";

/** Explicit Noise-consent negotiation needs the consent capability and the pipe. */
function noiseConsentNegotiated(capabilities: readonly string[]): boolean {
  return capabilities.includes(NEXT_NOISE_CONSENT_CAPABILITY) && capabilities.includes("noise_pipe_v1");
}

/** Exact local owner mode; absent legacy encryption is never mode authority. */
export function selectNoiseConsentDevice(
  session: ConnectorRelaySession | undefined, devices: NextRelayDevices | undefined, generation: string
): string | undefined {
  if (!session?.capabilities.includes(NEXT_ACCOUNT_CAPABILITY)
      && !session?.capabilities.includes(NEXT_NOISE_CONSENT_CAPABILITY)) return undefined;
  if (!session.capabilities.includes(NEXT_ACCOUNT_CAPABILITY)) {
    throw new ConnectorOperationError("capability_contract_incompatible", "Noise consent requires the account binding dependency.");
  }
  const deviceId = devices?.boundDevice(session.socket);
  const presence = deviceId ? devices?.presence(session.socket, generation, { device_id: deviceId }) : undefined;
  if (session.generation !== generation || !session.ready || session.policy.isStopped
      || session.mode !== "lease_v1" || !nextAccountNegotiated(session.capabilities)
      || !noiseConsentNegotiated(session.capabilities) || session.socket.readyState !== 1
      || !deviceId || !presence?.ok || presence.value !== true) {
    throw new ConnectorOperationError("capability_contract_incompatible", "Noise consent requires a current bound device and the exact negotiated authorization contract.");
  }
  return deviceId;
}

/** A policy lease pins the bound device negotiated for Noise consent; a changed device ends it. */
export function noisePushAuthority(
  capabilities: readonly string[], devices: NextRelayDevices | undefined, socket: WebSocket, isStillCurrent: () => boolean
): { noiseDevice: string | undefined; isStillCurrent: () => boolean } {
  const negotiated = noiseConsentNegotiated(capabilities);
  const noiseDevice = negotiated ? devices?.boundDevice(socket) : undefined;
  return { noiseDevice, isStillCurrent: () => isStillCurrent() && (!negotiated || devices?.boundDevice(socket) === noiseDevice) };
}

/** Activating a Noise grant must reach exactly its consenting device; otherwise refuse. */
export function noiseActivationReply(grant: GrantPolicy, select: () => string | undefined): RelayBrokerReply | undefined {
  if (!grant.next_noise) return undefined;
  try {
    if (select() !== grant.next_noise.device_id) return brokerError("unavailable", "connector_offline", "The selected Noise device is offline.");
    return undefined;
  } catch (error) {
    if (error instanceof ConnectorOperationError) return brokerProblem(error.problem, error.details);
    throw error;
  }
}
