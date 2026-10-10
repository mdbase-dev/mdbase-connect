/**
 * Seams owned by the hosted workstream (src/custody/, src/admission/). The core
 * calls only these interfaces. Defaults DENY: nothing is served and no key is
 * opened unless a real implementation (or the explicit LAB stub) is installed.
 */

/** Key material for one collection, RAM only. Wiped by `zeroize()` after handoff. */
export interface OpenKeys {
  /** The hosted service device ID (UUID). */
  deviceId: string;
  /** Ed25519 signing seed (32 bytes). */
  signSk: Uint8Array;
  /** X25519 KEM private key (32 bytes). */
  kemSk: Uint8Array;
  /** Control-plane root public keys this replica trusts (32 bytes each). */
  roots: Uint8Array[];
  /** Device trust roots (UUIDs). */
  signers: string[];
  /** The replica ID of this hosted instance (UUID, stable per collection). */
  replicaId: string;
  /** Bundled shared signed-release normalized pins; never CP/runtime authority. */
  policyPins: Uint8Array;
  /** Independently verified ORIGINAL signed bytes and plain SHA256 checksum. */
  originalGenesis: Uint8Array;
  genesisSha256: Uint8Array;
  /** The Noise static secret (32 bytes) for app sessions, when custody holds one;
   * handed to the engine's RAM once and wiped by `zeroize()`. */
  noiseSk?: Uint8Array;
  /** The service device's public keys, derived from the held secrets. */
  publicKeys?: { signPk: Uint8Array; kemPk: Uint8Array; noisePk: Uint8Array };
  zeroize(): void;
}

export interface Custody {
  /** KMS unwrap into memory for `collection` (per-role context), or throw. */
  openSealer(collection: string, signal: AbortSignal): Promise<OpenKeys>;
  /** The log bearer token for the service device (CP-issued, short-lived). */
  logToken(collection: string, signal: AbortSignal): Promise<string>;
}

/**
 * KMS wrap of a newly generated hosted service device (cloud-copy bootstrap; the
 * deployment's `POST /internal/v1/service-devices`). Owned by hosted (src/custody/).
 *
 * - `secret` is exactly 96 bytes, `signSeed ‖ kemSk ‖ noiseSk`. The implementation
 *   must not retain or copy it beyond the KMS request; the caller wipes it in a
 *   `finally` whether this resolves or rejects.
 * - Encryption context binds role, environment, collection, device, purpose
 *   `device-key` and envelope version 1; the key is the configured ARN only.
 * - `envelope` is the MDBK v1 envelope (opaque to the core and the control plane),
 *   at most 64 KiB. `kmsKeyArn` is informational for the record.
 * - Abort on `signal`; reject on any KMS error (the control plane retries the whole
 *   generation, and an unstored device is discarded unused).
 */
export interface DeviceKeyWrapper {
  wrapDeviceKeys(
    input: { collection: string; device: string; secret: Uint8Array },
    signal: AbortSignal,
  ): Promise<{ envelope: Uint8Array; kmsKeyArn: string }>;
}

export const DENY_WRAPPER: DeviceKeyWrapper = {
  wrapDeviceKeys: async () => {
    throw new Error("custody_unavailable");
  },
};

export type AdmissionOp = "hello" | "call" | "output" | "ack" | "wake";

export interface Admission {
  check(ctx: { collection: string; op: AdmissionOp; grant?: string; clientPk?: Uint8Array }): Promise<"allow" | "deny">;
}

export const DENY_CUSTODY: Custody = {
  openSealer: async () => {
    throw new Error("custody_unavailable");
  },
  logToken: async () => {
    throw new Error("custody_unavailable");
  },
};

export const DENY_ADMISSION: Admission = { check: async () => "deny" };
