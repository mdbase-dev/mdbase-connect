/**
 * Production hosted custody/admission factory (hosted components, installed
 * by the core). Active only when the deployment is fully configured for KMS; any
 * missing or partial setting leaves the default DENY seams in place (fail closed).
 *
 * Deployment settings (secrets unless noted):
 * - KMS_KEY_ARN, AWS_REGION (var), AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
 *   AWS_SESSION_TOKEN (optional), KMS_ENVIRONMENT (var: lab|staging|production),
 *   KMS_COLLECTIONS (comma-separated allowlist, never inferred from a request);
 * - CP_URL (var, https), CP_INBOUND_TOKEN: this deployment's control-plane token;
 * - Signed build-release-trust module binds environment/CP/log origins and pins.
 *   CP_ROOTS is optional legacy equality assertion ONLY, never authority.
 * - HOSTED_SIGNERS (deployment UUIDs), LOG_URL equals the signed release origin.
 */
import { ControlClient } from "./control.ts";
import { HostedAwsKms } from "./custody/aws-kms.ts";
import { appReleaseTrust } from "#hosted-release-trust";
import type { ReleaseTrust } from "./unconfigured-release-trust.ts";
import { HostedCustody, type DevicePublicKeys, type HostedControlPort, type VerifyOriginalGenesis } from "./custody/hosted-custody.ts";
import type { Custody, DeviceKeyWrapper, OpenKeys } from "./seams.ts";

export interface FactoryEnv {
  KMS_KEY_ARN?: string; AWS_REGION?: string; AWS_ACCESS_KEY_ID?: string; AWS_SECRET_ACCESS_KEY?: string;
  AWS_SESSION_TOKEN?: string; KMS_ENVIRONMENT?: string; KMS_COLLECTIONS?: string;
  CP_URL?: string; CP_INBOUND_TOKEN?: string; CP_ROOTS?: string; HOSTED_SIGNERS?: string;
  LOG_URL?: string; LAB?: string;
}

const list = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/** Bundled release literals ONLY. No caller-supplied/root/runtime selection.
 * Legacy CP_ROOTS can assert equality, never add/substitute authority. */
export function deploymentRelease(env: FactoryEnv): ReleaseTrust | null {
  const trust = appReleaseTrust();
  if (!trust || trust.schema !== "mdbn-app-trust/release/1"
      || trust.environment !== (env.KMS_ENVIRONMENT ?? (env.LAB === "1" ? "lab" : undefined))
      || env.CP_URL !== trust.cpOrigin || env.LOG_URL !== trust.logOrigin
      || !trust.policyPins.length || trust.policyPins.length > (64 << 10)
      || !trust.trustedRoots.length || trust.trustedRoots.length > 64) return null;
  if (env.CP_ROOTS !== undefined) {
    const declared = list(env.CP_ROOTS).sort();
    const bundled = trust.trustedRoots.map(pk => Array.from(pk, b => b.toString(16).padStart(2, "0")).join("")).sort();
    if (declared.length !== bundled.length || declared.some((r, i) => r !== bundled[i])) return null;
  }
  return trust;
}

export interface ProductionParts {
  kms: HostedAwsKms;
  control: ControlClient;
  roots: Uint8Array[];
  policyPins: Uint8Array;
  signers: string[];
  keyArn: string;
}

/** The configured production parts, or null (DENY) when anything is missing. */
export function productionParts(env: FactoryEnv, fetchImpl: typeof fetch = fetch): ProductionParts | null {
  const trust = deploymentRelease(env);
  const signers = list(env.HOSTED_SIGNERS);
  if (!env.KMS_KEY_ARN || !env.AWS_REGION || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY ||
      !env.CP_URL || !env.CP_INBOUND_TOKEN || !trust || signers.length === 0) return null;
  const environment = env.KMS_ENVIRONMENT as "lab" | "staging" | "production";
  try {
    const kms = new HostedAwsKms(
      { keyArn: env.KMS_KEY_ARN, region: env.AWS_REGION, environment, collections: list(env.KMS_COLLECTIONS) },
      () => ({ accessKeyId: env.AWS_ACCESS_KEY_ID!, secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
        ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) }),
      fetchImpl,
    );
    const control = new ControlClient({ url: env.CP_URL, token: env.CP_INBOUND_TOKEN, kind: "hosted" }, fetchImpl);
    return { kms, control, roots: trust.trustedRoots.map(pk => new Uint8Array(pk)), policyPins: new Uint8Array(trust.policyPins), signers, keyArn: env.KMS_KEY_ARN };
  } catch {
    return null;
  }
}

/** The core ControlClient as HostedCustody's port: hosted records only. */
export function hostedPort(control: ControlClient): HostedControlPort {
  return {
    async serviceDevice(collection, signal) {
      const r = await control.serviceDevice(collection, signal);
      if (r.kind !== "hosted") throw new Error("custody_invalid_record");
      return { ...r, kind: "hosted" };
    },
    logToken: (device, collection, signal) => control.logToken(device, collection, signal),
    forget: (collection) => control.forget(collection),
  };
}

/** The KMS wrapper for CP-requested service devices (production bootstrap). */
export function productionWrapper(parts: ProductionParts | null): DeviceKeyWrapper | null {
  return parts ? { wrapDeviceKeys: (input, signal) => parts.kms.wrapDeviceKeys(input, signal) } : null;
}

/**
 * The per-DO custody: one HostedCustody for this DO's one collection, created on
 * first use with a replica ID persisted in the DO (stable across wakes). Closed on
 * wake replacement/revocation via `close()`.
 */
export class ProductionCustody implements Custody {
  private custody: HostedCustody | null = null;
  /** Single flight: the one creation in progress (no second instance, no waiters
   * beyond callers already holding this promise). */
  private creating: Promise<HostedCustody> | null = null;
  private collection: string | null = null;
  /** Terminal: once closed, nothing is created or handed out again. */
  private closed = false;

  constructor(
    private readonly parts: ProductionParts,
    private readonly replicaId: () => Promise<string>,
    private readonly derive: (secret: Uint8Array) => DevicePublicKeys | null,
    private readonly verifyOriginal: VerifyOriginalGenesis,
  ) {}

  private async get(collection: string): Promise<HostedCustody> {
    if (this.closed || (this.collection && this.collection !== collection)) throw new Error("custody_unavailable");
    if (this.custody) return this.custody;
    this.collection = collection;
    this.creating ??= (async () => {
      const replicaId = await this.replicaId();
      // Closed while the replica ID was read: never create (or hand out) after close.
      if (this.closed) throw new Error("custody_aborted");
      const c = new HostedCustody(
        { collection, replicaId, keyArn: this.parts.keyArn, roots: this.parts.roots, policyPins: this.parts.policyPins, signers: this.parts.signers },
        hostedPort(this.parts.control), this.parts.kms, this.derive, this.verifyOriginal,
      );
      this.custody = c;
      return c;
    })().finally(() => {
      this.creating = null;
    });
    const c = await this.creating;
    if (this.closed) throw new Error("custody_aborted");
    return c;
  }

  async openSealer(collection: string, signal: AbortSignal): Promise<OpenKeys> {
    const keys = await (await this.get(collection)).openSealer(collection, signal);
    if (this.closed || signal.aborted) {
      keys.zeroize();
      throw new Error("custody_aborted");
    }
    return keys;
  }

  async logToken(collection: string, signal: AbortSignal): Promise<string> {
    const token = await (await this.get(collection)).logToken(collection, signal);
    // Closed (or aborted) while the token was minted: never hand it out.
    if (this.closed || signal.aborted) throw new Error("custody_aborted");
    return token;
  }

  /** Terminal: closes the custody (aborting pending CP/KMS work and wiping keys) and
   * refuses every later or in-flight request. */
  close(): void {
    this.closed = true;
    this.custody?.close();
  }
}
