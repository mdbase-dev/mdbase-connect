import { randomUUID } from "node:crypto";
import { NEXT_ACCOUNT_CAPABILITY, NEXT_NOISE_CONSENT_CAPABILITY, POLICY_FRESHNESS_LEASE_CAPABILITY, type GrantPolicy } from "@mdbase-dev/connect-protocol";
import { describe, expect, it } from "vitest";
import type { NextRelayDevices } from "./features/next/devices.js";
import { ConnectorOperationError } from "./relay-errors.js";
import { noiseActivationReply, noisePushAuthority, selectNoiseConsentDevice } from "./relay-noise-consent.js";
import type { ConnectorRelaySession } from "./relay-session.js";

const NOISE = [NEXT_ACCOUNT_CAPABILITY, NEXT_NOISE_CONSENT_CAPABILITY, POLICY_FRESHNESS_LEASE_CAPABILITY, "next_device_v1", "noise_pipe_v1"];
const socket = { readyState: 1 } as unknown as ConnectorRelaySession["socket"];
const other = { readyState: 1 } as unknown as ConnectorRelaySession["socket"];

function session(overrides: Partial<ConnectorRelaySession> = {}): ConnectorRelaySession {
  return {
    generation: "7", socket, capabilities: [...NOISE], mode: "lease_v1", ready: true,
    policy: { isStopped: false }, ...overrides
  } as unknown as ConnectorRelaySession;
}

/** Device hooks: `bound` is what each socket is bound to; `present` is the pipe's own view. */
function devices(bound: Map<object, string | undefined>, present = true): NextRelayDevices {
  return {
    boundDevice: (s: object) => bound.get(s),
    presence: (s: object, _generation: string, message: { device_id: string }) =>
      ({ version: 1, ok: true, value: present && bound.get(s) === message.device_id })
  } as unknown as NextRelayDevices;
}

describe("Noise consent device selection", () => {
  const device = randomUUID();
  it("returns the bound device only for a current, fully negotiated lease session", () => {
    expect(selectNoiseConsentDevice(session(), devices(new Map([[socket, device]])), "7")).toBe(device);
  });
  it("is absent, not an error, when neither Noise consent nor account binding was negotiated", () => {
    expect(selectNoiseConsentDevice(undefined, devices(new Map()), "7")).toBeUndefined();
    expect(selectNoiseConsentDevice(session({ capabilities: ["next_device_v1"] }), devices(new Map()), "7")).toBeUndefined();
  });
  it("refuses Noise consent without the account binding dependency", () => {
    const s = session({ capabilities: NOISE.filter((c) => c !== NEXT_ACCOUNT_CAPABILITY) });
    expect(() => selectNoiseConsentDevice(s, devices(new Map([[socket, device]])), "7")).toThrow(ConnectorOperationError);
  });
  it.each([
    ["no bound device", session(), new Map<object, string | undefined>(), true],
    ["pipe not present", session(), new Map([[socket, device]]), false],
    ["stale generation", session({ generation: "6" }), new Map([[socket, device]]), true],
    ["not ready", session({ ready: false }), new Map([[socket, device]]), true],
    ["policy stopped", session({ policy: { isStopped: true } as ConnectorRelaySession["policy"] }), new Map([[socket, device]]), true],
    ["legacy ack mode", session({ mode: "legacy_ack_v0" }), new Map([[socket, device]]), true],
    ["closed socket", session({ socket: { readyState: 3 } as unknown as ConnectorRelaySession["socket"] }), new Map([[socket, device]]), true],
    ["no noise pipe", session({ capabilities: NOISE.filter((c) => c !== "noise_pipe_v1") }), new Map([[socket, device]]), true],
    ["no next device", session({ capabilities: NOISE.filter((c) => c !== "next_device_v1") }), new Map([[socket, device]]), true]
  ])("refuses rather than falling back when %s", (_name, s, bound, present) => {
    expect(() => selectNoiseConsentDevice(s, devices(bound, present), "7")).toThrow("Noise consent requires a current bound device");
  });
});

describe("Noise policy lease pinning", () => {
  const device = randomUUID();
  it("passes the lease through unchanged when Noise consent is not negotiated", () => {
    const bound = new Map([[socket, device]]);
    const pin = noisePushAuthority(["next_device_v1"], devices(bound), socket, () => true);
    expect(pin.noiseDevice).toBeUndefined();
    bound.set(socket, randomUUID());
    expect(pin.isStillCurrent()).toBe(true);
  });
  it("pins the bound device and ends the lease when the binding changes or disappears", () => {
    const bound = new Map([[socket, device]]);
    const pin = noisePushAuthority(NOISE, devices(bound), socket, () => true);
    expect(pin.noiseDevice).toBe(device);
    expect(pin.isStillCurrent()).toBe(true);
    bound.set(socket, randomUUID());
    expect(pin.isStillCurrent()).toBe(false);
    bound.set(socket, device);
    expect(pin.isStillCurrent()).toBe(true);
    bound.delete(socket);
    expect(pin.isStillCurrent()).toBe(false);
  });
  it("a negotiated session with no bound device never becomes current later", () => {
    const bound = new Map<object, string | undefined>();
    const pin = noisePushAuthority(NOISE, devices(bound), other, () => true);
    expect(pin.noiseDevice).toBeUndefined();
    expect(pin.isStillCurrent()).toBe(true);
    bound.set(other, device);
    expect(pin.isStillCurrent()).toBe(false);
  });
});

describe("Noise grant activation gate", () => {
  const device = randomUUID();
  const noise = { protocol_version: 1 as const, connector_id: randomUUID(), device_id: device, device_noise_pk: "ab".repeat(32), collection_id: randomUUID() };
  it("lets legacy grants through without consulting the device", () => {
    expect(noiseActivationReply({} as GrantPolicy, () => { throw new Error("must not select"); })).toBeUndefined();
  });
  it("activates only at exactly the consenting device", () => {
    expect(noiseActivationReply({ next_noise: noise } as GrantPolicy, () => device)).toBeUndefined();
    const reply = noiseActivationReply({ next_noise: noise } as GrantPolicy, () => randomUUID());
    expect(reply).toMatchObject({ ok: false, error: { kind: "unavailable", code: "connector_offline" } });
    expect(noiseActivationReply({ next_noise: noise } as GrantPolicy, () => undefined)).toMatchObject({ ok: false });
  });
  it("turns a contract refusal into a connector problem and rethrows anything else", () => {
    const refused = noiseActivationReply({ next_noise: noise } as GrantPolicy, () => {
      throw new ConnectorOperationError("capability_contract_incompatible", "missing dependency");
    });
    expect(refused).toMatchObject({ ok: false, error: { kind: "connector", problem: expect.objectContaining({ message: "missing dependency" }) } });
    expect(() => noiseActivationReply({ next_noise: noise } as GrantPolicy, () => { throw new TypeError("boom"); })).toThrow(TypeError);
  });
});
