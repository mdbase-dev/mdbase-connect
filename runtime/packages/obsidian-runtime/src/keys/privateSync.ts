/**
 * Private sync in Obsidian: the state the UI shows, and the approval and
 * recovery flows.
 *
 * Private sync means a hosted blind log with no hosted replica. A new
 * device can't read until a keyed device of an owner or editor approves it, after
 * the user compares a six-digit code (`sealed-envelope.md` §5.3, commit then reveal:
 * `sasProtocol.ts`).
 *
 * Mobile Obsidian is often the *second* device. So both sides run here:
 * - **waiting:** this device shows its own code and tells the user where to approve
 *   it. When no device that could approve is online, it says so plainly, rather
 *   than looking stuck;
 * - **approving:** the hosting runtime lists `pending_devices` and the user
 *   confirms a code (`replica-client-api.md` §8.3). This works from a phone.
 *
 * This module is DOM-free: it turns runtime facts into a {@link PrivateSyncView},
 * and runs the flows against {@link PrivateSyncApi}. `ui.ts` renders the result.
 */

import { formatSas, parseSas, sasEqual } from "./sas.js";
import type { Protection } from "./keyStore.js";
import { formatRecoveryKey, newRecoverySecret, parseRecoveryKey, RecoveryKeyError } from "./recoveryKey.js";

/** A device waiting for approval (`pending_devices`, §8.3). */
export interface PendingDevice {
  readonly device: string;
  readonly account: string;
  readonly kind: "desktop" | "mobile" | "app-runtime" | "cli" | string;
  /**
   * Six digits, present only once the commit-then-reveal exchange has completed
   * for this device (`start_approval`, then the `approval` push).
   */
  readonly sas?: string;
  /** Display name from the control plane, if known. */
  readonly label?: string;
}

/** Technical states; local-only is migration/advanced Sync: off, not a product option. */
export type CollectionState = "local-only" | "private" | "cloud-copy";

/** The only signup/main-UI options. */
export const COLLECTION_OPTIONS = [
  { state: "cloud-copy", title: "Cloud copy", description: "Synced and served by hosted even when your devices are off." },
  { state: "private", title: "Private", description: "End-to-end synced. Apps need one of your devices online." },
] as const;
export const DEFAULT_COLLECTION_OPTION = "cloud-copy" as const;

/** Facts the UI needs, gathered from status, the key store and the runtime. */
export interface PrivateSyncFacts {
  readonly state: CollectionState;
  /** This device holds the current epoch key. */
  readonly keyed: boolean;
  /** This device may approve others: keyed, and the account is an owner or editor. */
  readonly canApprove: boolean;
  /** `sync-status` key 7. */
  readonly connection: "online" | "connecting" | "offline";
  /** Devices waiting for approval. Only the hosting app sees these. */
  readonly pending: readonly PendingDevice[];
  /**
   * This device's code while it waits, once an approver has challenged it and it
   * has revealed `r_N` (`JoinerApproval.onChallenge`). `null` before that.
   */
  readonly ownSas: string | null;
  /**
   * This device's `r_N` was revealed (or lost) without it being keyed, so it can't
   * answer another challenge. A retry needs a fresh commitment through an
   * `approval-request`.
   */
  readonly needsNewApprovalRequest?: boolean;
  /**
   * Devices online now that could approve this one (keyed, owner or editor). `null`
   * if unknown. Requested from replica/control as details of the
   * `waiting_for_key` incident.
   */
  readonly approversOnline: number | null;
  /**
   * The collection's recovery device, from the log; `null` if unknown.
   * - `none`: never set up.
   * - `enrolled`: active.
   * - `revoked`: revoked by a policy item. Every device alerts, because the
   *   control plane could remove it silently otherwise.
   * - `used`: it keyed a device. It must be rotated: revoke it, enrol a new one,
   *   rekey.
   */
  readonly recovery: "none" | "enrolled" | "revoked" | "used" | null;
  /** The user dismissed the recovery key offer. */
  readonly recoveryKeyDismissed: boolean;
  /** How this device's secrets are stored. */
  readonly keyProtection: Protection | null;
  /** The device identity was lost (browser storage cleared). */
  readonly identityLost: boolean;
}

/** An action the UI offers. */
export type PrivateSyncAction =
  | "approve-devices"
  | "use-recovery-key"
  | "set-up-recovery-key"
  | "replace-recovery-key"
  | "enrol-again"
  | "request-approval"
  | "retry-connection";

/** What the UI shows. */
export interface PrivateSyncView {
  readonly tone: "ok" | "waiting" | "attention" | "error";
  readonly title: string;
  readonly body: readonly string[];
  /** This device's code, formatted (`"042 917"`), while waiting. */
  readonly code: string | null;
  readonly actions: readonly PrivateSyncAction[];
}

/** Turn facts into what the status panel shows. Pure. */
export function describePrivateSync(f: PrivateSyncFacts): PrivateSyncView {
  if (f.state === "local-only") {
    return {
      tone: "attention",
      title: "Sync: off",
      body: ["Turn sync on in collection settings: choose Private or Cloud copy."],
      code: null,
      actions: [],
    };
  }
  if (f.state === "cloud-copy") {
    return { tone: "ok", title: "Cloud copy", body: [COLLECTION_OPTIONS[0].description], code: null, actions: [] };
  }
  if (f.identityLost) {
    return {
      tone: "error",
      title: "This device needs to be approved again",
      body: [
        "This device's keys for the collection were removed with the app's storage, so it can no longer read the synced notes.",
        "Your notes in this vault are untouched. Enrol this device again and approve it from another device, or use your recovery key.",
      ],
      code: null,
      actions: ["enrol-again", "use-recovery-key"],
    };
  }
  if (!f.keyed) {
    const body: string[] = [
      "This collection is end-to-end encrypted. Another of your devices that already has it must approve this one.",
      f.ownSas
        ? "Type this code on the other device to approve this one. Only do so on a device you own."
        : "On a device that already has this collection, open mdbase and choose Review devices. This device then shows a code to type there.",
    ];
    if (f.connection !== "online") {
      body.push("This device is offline. Approval needs a connection on both devices.");
    } else if (f.approversOnline === 0) {
      body.push(
        "None of your other devices is online right now. Open mdbase (or Obsidian with mdbase) on a device that has this collection, or use your recovery key.",
      );
    }
    if (f.needsNewApprovalRequest) {
      return {
        tone: "attention",
        title: "Approval needs to start again",
        body: [
          "An approval was started for this device but didn't finish. For safety, each approval code can only be used once.",
          "Request approval again, then start the approval on your other device.",
        ],
        code: null,
        actions: ["request-approval", "use-recovery-key"],
      };
    }
    return {
      tone: "waiting",
      title: "Waiting for approval",
      body,
      code: f.ownSas ? formatSas(f.ownSas) : null,
      actions: f.connection === "online" ? ["use-recovery-key"] : ["retry-connection", "use-recovery-key"],
    };
  }
  const actions: PrivateSyncAction[] = [];
  const body: string[] = [COLLECTION_OPTIONS[1].description];
  let tone: PrivateSyncView["tone"] = "ok";
  let title = "Private";
  if (f.pending.length > 0 && f.canApprove) {
    tone = "attention";
    title = f.pending.length === 1 ? "A device is waiting for approval" : `${f.pending.length} devices are waiting for approval`;
    body.push("Only approve a device if it is yours and shows the same code.");
    actions.push("approve-devices");
  }
  if (f.recovery === "revoked") {
    tone = "error";
    title = "Your recovery key was removed";
    body.push(
      "The recovery key for this collection was revoked. If you didn't do this, check your mdbase account's devices and sessions. Set up a new recovery key to keep a way back in.",
    );
    actions.push("set-up-recovery-key");
  } else if (f.recovery === "used") {
    if (tone === "ok") tone = "attention";
    body.push("The recovery key was used to bring a device back. Replace it: the old key is retired and the collection is re-encrypted.");
    actions.push("replace-recovery-key");
  } else if (f.recovery === "none" && !f.recoveryKeyDismissed) {
    if (tone === "ok") tone = "attention";
    body.push("No recovery key is set up. If you lose all your devices, the notes can't be recovered from mdbase.");
    actions.push("set-up-recovery-key");
  }
  if (f.connection !== "online") {
    body.push(f.connection === "connecting" ? "Connecting…" : "Offline: changes are kept on this device and sync when it reconnects.");
  }
  return { tone, title, body, code: null, actions };
}

/** What the flows need from the runtime (client API §8.3 plus the recovery-key methods). */
export interface PrivateSyncApi {
  pendingDevices(): Promise<PendingDevice[]>;
  /**
   * `start_approval`: draw `r_A`, send it to the device, and resolve when it
   * revealed `r_N` matching its commitment (the `approval` push), or with the
   * `approval_failed` reason.
   */
  startApproval(device: string): Promise<{ ok: true; sas: string } | { ok: false; reason: string }>;
  /**
   * Appends the `key_grant` after the replica re-checks the code. At most 3 failed
   * attempts per enrolled device; then the device must enrol again.
   */
  approveDevice(device: string, sas: string): Promise<void>;
  rejectDevice(device: string): Promise<void>;
  /**
   * New-device side: renew `r_N` and ask the control plane to append an
   * `approval-request {device, sas_commit}` with the fresh commitment.
   */
  requestApprovalAgain(): Promise<void>;
  /**
   * Derive the recovery device's keys from `secret` (HKDF, one `info` per key),
   * request its enrolment, and key it only after checking that the enrol item in
   * the log carries exactly the derived keys (the control plane must not
   * be able to substitute its own). When an active recovery device exists, the
   * runtime revokes it, enrols the new one and rekeys (rotation).
   */
  enrolRecoveryKey(secret: Uint8Array): Promise<void>;
  /** Use `secret` to key this device (the recovery device signs the `key_grant`). */
  recoverWithKey(secret: Uint8Array): Promise<void>;
}

/** Outcome of an approval attempt. */
export type ApproveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: "format" | "mismatch" | "gone" | "not_started" | "locked"; readonly attemptsLeft?: number };

/**
 * Approval of one pending device on this (keyed) device.
 *
 * The user is asked to **type the code shown on the new device**. This device's
 * own code isn't displayed, so approval can't be clicked through without reading
 * the other screen. The code is compared here first, so a typo never reaches the
 * replica, and the replica compares again and counts failures.
 */
export class DeviceApproval {
  private failures = 0;
  private sas: string | null = null;

  constructor(
    private readonly api: PrivateSyncApi,
    readonly device: string,
  ) {}

  /** Challenge the new device (`start_approval`). It then shows its code. */
  async start(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.failures >= 3) return { ok: false, reason: "too_many_attempts" };
    const r = await this.api.startApproval(this.device);
    if (!r.ok) return r;
    this.sas = r.sas;
    return { ok: true };
  }

  async confirm(typed: string): Promise<ApproveResult> {
    if (this.failures >= 3) return { ok: false, problem: "locked" };
    if (!this.sas) return { ok: false, problem: "not_started" };
    const code = parseSas(typed);
    if (!code) return { ok: false, problem: "format" };
    const pending = (await this.api.pendingDevices()).find((d) => d.device === this.device);
    if (!pending) return { ok: false, problem: "gone" };
    if (!sasEqual(code, this.sas)) {
      this.failures++;
      return this.failures >= 3 ? { ok: false, problem: "locked" } : { ok: false, problem: "mismatch", attemptsLeft: 3 - this.failures };
    }
    await this.api.approveDevice(this.device, code);
    return { ok: true };
  }
}

/**
 * Recovery key setup. The user must type the last group back before it is
 * enrolled, so a key that was never written down is never relied on.
 */
export class RecoveryKeySetup {
  private constructor(
    private readonly secret: Uint8Array,
    readonly formatted: string,
  ) {}

  static async create(secret: Uint8Array = newRecoverySecret()): Promise<RecoveryKeySetup> {
    return new RecoveryKeySetup(secret, await formatRecoveryKey(secret));
  }

  /** The group the user is asked to type back. */
  get confirmGroup(): string {
    return this.formatted.slice(this.formatted.lastIndexOf("-") + 1);
  }

  /** True if `typed` matches the last group. */
  confirms(typed: string): boolean {
    return typed.trim().toUpperCase() === this.confirmGroup;
  }

  /** Enrol it. Wipes the secret from memory afterwards. */
  async enrol(api: PrivateSyncApi, typedConfirmation: string): Promise<boolean> {
    if (!this.confirms(typedConfirmation)) return false;
    try {
      await api.enrolRecoveryKey(this.secret);
    } finally {
      this.secret.fill(0);
    }
    return true;
  }
}

/** Import a recovery key the user typed, and key this device with it. */
export async function recoverFromKey(api: PrivateSyncApi, typed: string): Promise<{ ok: true } | { ok: false; problem: RecoveryKeyError["problem"] }> {
  let secret: Uint8Array;
  try {
    secret = await parseRecoveryKey(typed);
  } catch (e) {
    if (e instanceof RecoveryKeyError) return { ok: false, problem: e.problem };
    throw e;
  }
  try {
    await api.recoverWithKey(secret);
  } finally {
    secret.fill(0);
  }
  return { ok: true };
}
