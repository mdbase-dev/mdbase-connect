// Public NEXT pins carried as an asset of the authenticated release bundle.
// This validates an asset against an ALREADY AUTHENTICATED manifest; it does not
// authenticate Sigstore/OIDC. Never derive `expected` from an unauthenticated file.
import { createHash } from "node:crypto";
import { certFromJson, verifyCert, type CpCertJson } from "./policy-keys.js";
import { weakSigningKey } from "./devices.js";
import { keyId } from "./policy-wire.js";

export interface NextTrustPayload {
  schema_version: 1;
  environment: "lab" | "staging" | "production";
  control_plane_origin: string;
  log_origin: string;
  issued_at: number;
  source: { repository: "mdbase-dev/mdbase-connect"; commit: string; version: string };
  roots: Array<{ key_id: string; public_key: string }>;
  policy_keys: Array<{ key_id: string; certificate: CpCertJson }>;
}

export interface NextTrustExpectation {
  environment: NextTrustPayload["environment"];
  controlPlaneOrigin: string;
  logOrigin: string;
  source: NextTrustPayload["source"];
  // SHA-256 of the exact canonical asset bytes, from the verified manifest.
  sha256: string;
  now: number;
}

const MAX_BYTES = 65536;
const hex = (value: unknown, size: number): value is string => typeof value === "string" && new RegExp(`^[0-9a-f]{${size * 2}}$`).test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function requireValue(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(`Invalid NEXT trust payload: ${reason}`);
}
function record(value: unknown, fields: string[]): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), "object expected");
  const r = value as Record<string, unknown>;
  requireValue(Object.keys(r).length === fields.length && fields.every((k) => Object.hasOwn(r, k)), "unknown or missing field");
  return r;
}
function origin(value: unknown): asserts value is string {
  requireValue(typeof value === "string" && value.length <= 512, "origin expected");
  const url = new URL(value);
  requireValue(url.protocol === "https:" && url.origin === value, "origin must be canonical HTTPS, without credentials/path/query/fragment");
}
// Validated fields contain ASCII strings and safe unsigned integers only. Lexical
// object-key order, preserved (key-ID ordered) arrays, no whitespace or newline.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const r = value as Record<string, unknown>;
    return `{${Object.keys(r).sort().map((k) => `${JSON.stringify(k)}:${canonical(r[k])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  requireValue(encoded !== undefined, "unencodable value");
  return encoded;
}

/** Structural/certificate validation, NOT release authentication. */
export function encodeNextTrustPayload(value: unknown): Uint8Array {
  const r = record(value, ["schema_version", "environment", "control_plane_origin", "log_origin", "issued_at", "source", "roots", "policy_keys"]);
  requireValue(r.schema_version === 1, "unsupported schema version");
  requireValue(typeof r.environment === "string" && ["lab", "staging", "production"].includes(r.environment), "environment");
  origin(r.control_plane_origin); origin(r.log_origin);
  requireValue(integer(r.issued_at), "issued_at");
  const source = record(r.source, ["repository", "commit", "version"]);
  requireValue(source.repository === "mdbase-dev/mdbase-connect" && hex(source.commit, 20), "source binding");
  requireValue(typeof source.version === "string" && /^[0-9A-Za-z.+-]{1,64}$/.test(source.version), "version");
  requireValue(Array.isArray(r.roots) && r.roots.length > 0 && r.roots.length <= 8, "1..8 root pins required");
  requireValue(Array.isArray(r.policy_keys) && r.policy_keys.length > 0 && r.policy_keys.length <= 32, "1..32 policy pins required");
  const roots = new Map<string, Buffer>();
  let previous = "";
  for (const value of r.roots) {
    const root = record(value, ["key_id", "public_key"]);
    requireValue(hex(root.key_id, 16) && hex(root.public_key, 32) && root.key_id > previous, "root shape/order/duplicate");
    const pk = Buffer.from(root.public_key, "hex");
    requireValue(!weakSigningKey(pk), "root signing key");
    requireValue(Buffer.from(keyId(pk)).toString("hex") === root.key_id, "root key ID");
    roots.set(root.key_id, pk); previous = root.key_id;
  }
  previous = "";
  let current = false;
  for (const value of r.policy_keys) {
    const pin = record(value, ["key_id", "certificate"]);
    requireValue(hex(pin.key_id, 16) && pin.key_id > previous, "policy shape/order/duplicate");
    const c = record(pin.certificate, ["policy_public_key", "not_before", "not_after", "root_key_id", "signature"]);
    requireValue(hex(c.policy_public_key, 32) && hex(c.root_key_id, 16) && hex(c.signature, 64), "certificate bytes");
    requireValue(integer(c.not_before) && integer(c.not_after), "certificate time");
    const cert = certFromJson(c as unknown as CpCertJson);
    requireValue(!weakSigningKey(cert.policyPublicKey), "policy signing key");
    const root = roots.get(String(c.root_key_id));
    requireValue(root && verifyCert(cert, root), "certificate/root signature");
    requireValue(!roots.has(pin.key_id) && Buffer.from(keyId(cert.policyPublicKey)).toString("hex") === pin.key_id, "policy key ID/principal");
    if (cert.notBefore <= r.issued_at && r.issued_at < cert.notAfter) current = true;
    previous = pin.key_id;
  }
  requireValue(current, "no certified policy key valid at issue time");
  const bytes = Buffer.from(canonical(r));
  requireValue(bytes.length <= MAX_BYTES, "asset exceeds 64 KiB");
  return bytes;
}

/** Authenticate the manifest FIRST (pinned OIDC identity/issuer); then call this. */
export function validateNextTrustPayload(bytes: Uint8Array, expected: NextTrustExpectation): NextTrustPayload {
  requireValue(bytes.length <= MAX_BYTES && hex(expected.sha256, 32), "asset size or missing authenticated digest");
  requireValue(createHash("sha256").update(bytes).digest("hex") === expected.sha256, "authenticated asset digest mismatch");
  const text = Buffer.from(bytes).toString("utf8");
  requireValue(Buffer.from(text).equals(Buffer.from(bytes)), "invalid UTF-8");
  const parsed: unknown = JSON.parse(text);
  const encoded = encodeNextTrustPayload(parsed);
  // This also rejects duplicate JSON keys, reordered keys/arrays, and whitespace.
  requireValue(Buffer.from(encoded).equals(Buffer.from(bytes)), "noncanonical asset");
  const payload = parsed as NextTrustPayload;
  requireValue(integer(expected.now) && payload.issued_at <= expected.now, "future issue time");
  origin(expected.controlPlaneOrigin); origin(expected.logOrigin);
  requireValue(payload.environment === expected.environment && payload.control_plane_origin === expected.controlPlaneOrigin && payload.log_origin === expected.logOrigin, "environment/origin binding");
  requireValue(payload.source.repository === expected.source.repository && payload.source.commit === expected.source.commit && payload.source.version === expected.source.version, "release source binding");
  return payload;
}
