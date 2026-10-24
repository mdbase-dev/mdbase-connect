/**
 * Private (end-to-end) collections: device approval (`replica-client-api.md` §8.3) and
 * the recovery key, offered at setup, skippable, and recommended.
 *
 * The recovery-key methods are proposed in the private-collection transport
 * contract; the replica and control components own their semantics.
 */
import { bool, Codec, enumOf, struct, tstr, uuid } from "./codec.js";
import { problem } from "./wire.js";
import type { Problem, Uuid } from "./wire.js";

/** `device-kind` (policy.md). */
export const DEVICE_KINDS = ["desktop", "mobile", "app_runtime", "cli", "hosted", "escrow", "recovery"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export interface PendingDevice {
  device: Uuid;
  account: Uuid;
  kind: DeviceKind | string;
  /** Current challenge/reveal readiness only: NOT approval or key delivery. */
  exchangeReady: boolean;
  /** @deprecated Decode-only legacy field. NEVER display it or use it as approval input. */
  sas?: string;
}

const kinds = enumOf<DeviceKind>("device-kind", DEVICE_KINDS);
/** Unknown kinds (a newer control plane) display as "unknown" rather than failing the list. */
const deviceKind: Codec<string> = {
  name: "device-kind",
  enc: (v) => kinds.enc(v as DeviceKind),
  dec: (c) => {
    try {
      return kinds.dec(c);
    } catch {
      return "unknown";
    }
  },
};

const pendingDeviceShape = struct<PendingDevice>("pending-device", [
  [0, "device", uuid],
  [1, "account", uuid],
  [2, "kind", deviceKind],
  [3, "sas", tstr, "opt"], // Reserved: decode-only.
  [4, "exchangeReady", bool],
]);
export const pendingDevice: Codec<PendingDevice> = {
  ...pendingDeviceShape,
  enc: v => pendingDeviceShape.enc({ ...v, sas: undefined }),
};

/** Host-only `approval` push, not a joiner code or an approval result. */
export interface ApprovalReadiness {
  device: Uuid;
  exchangeReady: boolean;
  /** @deprecated Decode-only legacy field; NEVER display or copy into approval input. */
  sas?: string;
}
const approvalReadinessShape = struct<ApprovalReadiness>("approval-readiness", [
  [0, "device", uuid],
  [1, "sas", tstr, "opt"], // Reserved: decode-only.
  [2, "exchangeReady", bool],
]);
export const approvalReadiness: Codec<ApprovalReadiness> = {
  ...approvalReadinessShape,
  enc: v => approvalReadinessShape.enc({ ...v, sas: undefined }),
};

export interface RecoveryKeyStatus {
  configured: boolean;
  device?: Uuid;
}

export const recoveryKeyStatus = struct<RecoveryKeyStatus>("recovery-key-status", [
  [0, "configured", bool],
  [1, "device", uuid, "opt"],
]);

export const recoveryKeyCreated = struct<{ phrase: string; device: Uuid }>("recovery-key-created", [
  [0, "phrase", tstr],
  [1, "device", uuid],
]);

/** Format a requester's locally generated code; never display an approver's code. */
export function formatSas(sas: string): string {
  return /^\d{6}$/.test(sas) ? `${sas.slice(0, 3)} ${sas.slice(3)}` : sas;
}

// ------------------------------------------------------------------ account key (AK1 §6)

/**
 * Where an account-key unlock stands on this replica. `refused` carries the typed
 * `AccountKeyRefusal` as a problem (`details.reason` is the refusal name).
 */
export const ACCOUNT_KEY_STATES = ["idle", "reading_ahead", "pending_grant", "keyed", "refused"] as const;
export type AccountKeyState = (typeof ACCOUNT_KEY_STATES)[number];
export const accountKeyState = enumOf<AccountKeyState>("account-key-state", ACCOUNT_KEY_STATES);

export interface AccountKeyStatus {
  state: AccountKeyState;
  problem?: Problem;
}

export const accountKeyStatus = struct<AccountKeyStatus>("account-key-status", [
  [0, "state", accountKeyState],
  [1, "problem", problem, "opt"],
]);
