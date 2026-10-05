// Control-plane keys for mdbase-next policy items (mdbase-next policy.md §3).
//
// The offline root key certifies an online policy key for a validity window. The
// server holds only the policy key and its certificate; a root private key is never
// configured on a server. Rotation: certify a new key offline (`next-cp-cert`), deploy
// it, and items signed by the old key stay valid because each embeds its certificate.
import { createPrivateKey, createPublicKey, verify as edVerify, type KeyObject } from "node:crypto";
import { certDigest, keyId, type CpCert, type PolicySigner } from "./policy-wire.js";
import { parseLabFixtureConfig, type LabFixtureConfig } from "./lab-fixture-config.js";

/** Refuse to start when the certificate expires within this window. */
const MIN_CERT_REMAINING_MS = 7 * 24 * 60 * 60 * 1000;

export interface CpCertJson {
  policy_public_key: string;
  not_before: number;
  not_after: number;
  root_key_id: string;
  signature: string;
}

export interface LogServiceConfig {
  url: string;
  tokenIssuerKeyPem: string;
  transportKeyPem: string;
}

export interface NextControlPlaneConfig {
  rootPublicKey: Uint8Array;
  policyPrivateKeyPem: string;
  policyCert: CpCertJson;
  logService: LogServiceConfig;
  /** Bearer tokens of the hosted replica and escrow deployments, per kind; absent until deployed. */
  serviceTokens: { hosted?: string; escrow?: string };
  /**
   * Outbound: where the control plane asks each deployment to generate its service
   * device when an owner creates a cloud copy. Set only by MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP=1;
   * these tokens authenticate the control plane to the deployment and differ from the
   * inbound `serviceTokens`.
   */
  cloudCopyBootstrap?: { hosted: { url: string; token: string }; escrow: { url: string; token: string } };
  /** Private collection create and device enrol routes; set only by MDBASE_NEXT_PRIVATE_BOOTSTRAP=1. */
  privateBootstrap?: true;
  labFixtures?: LabFixtureConfig;
}

function hexBytes(value: string, size: number, name: string): Uint8Array {
  if (!new RegExp(`^[0-9a-f]{${size * 2}}$`).test(value)) throw new Error(`${name} must be ${size} bytes of lowercase hex.`);
  return Buffer.from(value, "hex");
}

export function certFromJson(json: CpCertJson): CpCert {
  if (!Number.isSafeInteger(json.not_before) || !Number.isSafeInteger(json.not_after) || json.not_before >= json.not_after) {
    throw new Error("The policy key certificate needs an increasing integer validity window in milliseconds.");
  }
  return {
    policyPublicKey: hexBytes(json.policy_public_key, 32, "policy_public_key"),
    notBefore: json.not_before,
    notAfter: json.not_after,
    root: hexBytes(json.root_key_id, 16, "root_key_id"),
    signature: hexBytes(json.signature, 64, "signature"),
  };
}

export function certToJson(cert: CpCert): CpCertJson {
  const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
  return { policy_public_key: hex(cert.policyPublicKey), not_before: cert.notBefore, not_after: cert.notAfter, root_key_id: hex(cert.root), signature: hex(cert.signature) };
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function ed25519PublicKeyObject(raw: Uint8Array): KeyObject {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export function ed25519RawPublicKey(key: KeyObject): Uint8Array {
  const der = (key.type === "private" ? createPublicKey(key) : key).export({ format: "der", type: "spki" });
  if (der.length !== 44 || !der.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) throw new Error("Expected an Ed25519 key.");
  return der.subarray(12);
}

export function verifyCert(cert: CpCert, rootPublicKey: Uint8Array): boolean {
  if (!Buffer.from(cert.root).equals(Buffer.from(keyId(rootPublicKey)))) return false;
  return edVerify(null, certDigest(cert), ed25519PublicKeyObject(rootPublicKey), cert.signature);
}

/**
 * Parse the `MDBASE_NEXT_*` key settings. Returns null when the mdbase-next control
 * plane is disabled; throws on a partial or malformed configuration.
 */
export function parseNextControlPlaneEnv(env: NodeJS.ProcessEnv): NextControlPlaneConfig | null {
  const labFixtures = parseLabFixtureConfig(env);
  const enabled = env.MDBASE_NEXT_CONTROL_PLANE?.trim() ?? "";
  if (enabled !== "" && enabled !== "0" && enabled !== "1") throw new Error("MDBASE_NEXT_CONTROL_PLANE must be 0 or 1.");
  if (enabled !== "1") return null;
  const root = env.MDBASE_NEXT_ROOT_PUBLIC_KEY?.trim() ?? "";
  const pem = env.MDBASE_NEXT_POLICY_SIGNING_KEY?.trim() ?? "";
  const cert = env.MDBASE_NEXT_POLICY_KEY_CERT?.trim() ?? "";
  const logServiceUrl = env.MDBASE_NEXT_LOG_SERVICE_URL?.trim() ?? "";
  const tokenIssuerKeyPem = env.MDBASE_NEXT_LOG_TOKEN_SIGNING_KEY?.trim() ?? "";
  const transportKeyPem = env.MDBASE_NEXT_LOG_TRANSPORT_KEY?.trim() ?? "";
  if (!root || !pem || !cert || !logServiceUrl || !tokenIssuerKeyPem || !transportKeyPem) {
    throw new Error("MDBASE_NEXT_CONTROL_PLANE=1 requires MDBASE_NEXT_ROOT_PUBLIC_KEY, MDBASE_NEXT_POLICY_SIGNING_KEY, MDBASE_NEXT_POLICY_KEY_CERT, MDBASE_NEXT_LOG_SERVICE_URL, MDBASE_NEXT_LOG_TOKEN_SIGNING_KEY and MDBASE_NEXT_LOG_TRANSPORT_KEY.");
  }
  const url = new URL(logServiceUrl);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("MDBASE_NEXT_LOG_SERVICE_URL must use https outside loopback.");
  }
  let parsedCert: CpCertJson;
  try {
    parsedCert = JSON.parse(cert) as CpCertJson;
  } catch {
    throw new Error("MDBASE_NEXT_POLICY_KEY_CERT must be the JSON printed by next-cp-cert.");
  }
  const serviceToken = (name: string) => {
    const value = env[name]?.trim() ?? "";
    if (value && value.length < 32) throw new Error(`${name} must be at least 32 characters.`);
    return value || undefined;
  };
  const hosted = serviceToken("MDBASE_NEXT_HOSTED_INTERNAL_TOKEN");
  const escrow = serviceToken("MDBASE_NEXT_ESCROW_INTERNAL_TOKEN");
  if (hosted && hosted === escrow) throw new Error("The hosted and escrow internal tokens must differ.");
  const bootstrap = env.MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP?.trim() ?? "";
  if (bootstrap !== "" && bootstrap !== "0" && bootstrap !== "1") throw new Error("MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP must be 0 or 1.");
  let cloudCopyBootstrap: NextControlPlaneConfig["cloudCopyBootstrap"];
  if (bootstrap === "1") {
    const deployment = (kind: "HOSTED" | "ESCROW") => {
      const url = env[`MDBASE_NEXT_${kind}_SERVICE_URL`]?.trim() ?? "";
      const token = serviceToken(`MDBASE_NEXT_${kind}_SERVICE_TOKEN`);
      if (!url || !token) throw new Error(`MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP=1 requires MDBASE_NEXT_${kind}_SERVICE_URL and MDBASE_NEXT_${kind}_SERVICE_TOKEN.`);
      if (new URL(url).protocol !== "https:") throw new Error(`MDBASE_NEXT_${kind}_SERVICE_URL must use https.`);
      return { url, token };
    };
    if (!hosted || !escrow) throw new Error("MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP=1 requires MDBASE_NEXT_HOSTED_INTERNAL_TOKEN and MDBASE_NEXT_ESCROW_INTERNAL_TOKEN.");
    cloudCopyBootstrap = { hosted: deployment("HOSTED"), escrow: deployment("ESCROW") };
    if (new Set([hosted, escrow, cloudCopyBootstrap.hosted.token, cloudCopyBootstrap.escrow.token]).size !== 4) {
      throw new Error("Inbound and outbound service tokens must all differ.");
    }
  }
  const privateBootstrap = env.MDBASE_NEXT_PRIVATE_BOOTSTRAP?.trim() ?? "";
  if (privateBootstrap !== "" && privateBootstrap !== "0" && privateBootstrap !== "1") throw new Error("MDBASE_NEXT_PRIVATE_BOOTSTRAP must be 0 or 1.");
  return {
    rootPublicKey: hexBytes(root, 32, "MDBASE_NEXT_ROOT_PUBLIC_KEY"),
    policyPrivateKeyPem: pem,
    policyCert: parsedCert,
    logService: { url: logServiceUrl, tokenIssuerKeyPem, transportKeyPem },
    serviceTokens: { ...(hosted ? { hosted } : {}), ...(escrow ? { escrow } : {}) },
    ...(cloudCopyBootstrap ? { cloudCopyBootstrap } : {}),
    ...(privateBootstrap === "1" ? { privateBootstrap: true as const } : {}),
    ...(labFixtures ? { labFixtures } : {}),
  };
}

/**
 * Load the policy signer and check it against the pinned root: the private key matches
 * the certificate, the root signed the certificate, and it is valid for at least
 * `MIN_CERT_REMAINING_MS` from `now`.
 */
export function loadPolicySigner(config: NextControlPlaneConfig, now: number): PolicySigner {
  const cert = certFromJson(config.policyCert);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(config.policyPrivateKeyPem);
  } catch {
    throw new Error("MDBASE_NEXT_POLICY_SIGNING_KEY must be a PEM-encoded Ed25519 private key.");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("MDBASE_NEXT_POLICY_SIGNING_KEY must be an Ed25519 key.");
  if (!Buffer.from(ed25519RawPublicKey(privateKey)).equals(Buffer.from(cert.policyPublicKey))) {
    throw new Error("MDBASE_NEXT_POLICY_SIGNING_KEY does not match the certificate's policy key.");
  }
  if (!verifyCert(cert, config.rootPublicKey)) throw new Error("The policy key certificate is not signed by MDBASE_NEXT_ROOT_PUBLIC_KEY.");
  if (cert.notBefore > now) throw new Error("The policy key certificate is not valid yet.");
  if (cert.notAfter - now < MIN_CERT_REMAINING_MS) throw new Error("The policy key certificate expires within 7 days; rotate it.");
  return { cert, privateKey };
}
