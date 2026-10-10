import type { Connector } from "./port.js";

// Internal connector identity, not descriptions or caller-controlled options.
// This scopes SDK consistency behavior; it is NOT a native read/auth gate.
const nextRelay = new WeakSet<Connector>();
export function registerNextRelayFence<T extends Connector>(connector: T): T {
  nextRelay.add(connector);
  return connector;
}
export function usesNextRelayFence(connector: Connector): boolean {
  return nextRelay.has(connector);
}
