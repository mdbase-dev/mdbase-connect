/** Internal companion boundary only. Expected facts must come from the original
 * protected preparation and verified Worker account, never current UI labels.
 * Valid metadata is not a credential, custody ACK, admitted client or READY. */
import { mdbaseError } from "../errors.js";

const fields = [
  "account_id", "authorization_request_id", "application_id", "application_declaration_id",
  "application_manifest_digest", "application_installation_id", "application_origin",
  "collection_id", "grant_id", "grant_signing_public_key", "client_noise_public_key",
] as const;
export type NativeCompletion = Readonly<{ version: 1 } & Record<typeof fields[number], string>>;
export interface ExpectedNativeCompletion {
  readonly accountId: string;
  readonly authorizationRequestId: string;
  readonly applicationId: string;
  readonly declarationId: string;
  readonly manifestDigest: string;
  readonly applicationInstallationId: string;
  readonly applicationOrigin: string;
  readonly collectionId: string;
  readonly grantSigningPublicKey: string;
  readonly clientNoisePublicKey: string;
  /** Only when independently known from the same original approved outcome. */
  readonly grantId?: string;
}

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const refused = () => mdbaseError("unauthenticated", "native completion does not match the original approved preparation");
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function publicBytes(value: string, length: number, prefix?: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const raw = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    return raw.length === length && (prefix === undefined || raw.charCodeAt(0) === prefix)
      && btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "") === value;
  } catch { return false; }
}

/** Validate BEFORE credential persistence/publication. This does not validate the
 * token secrets or replace the issuer's original-grant/attestation checks. */
export function nativeCompletionFromToken(value: unknown, expected: ExpectedNativeCompletion): NativeCompletion {
  const token = object(value), completion = object(token?.native_completion);
  if (!completion || !Object.hasOwn(completion, "version") || completion.version !== 1 || Object.keys(completion).length !== fields.length + 1
      || fields.some((field) => !Object.hasOwn(completion, field) || typeof completion[field] !== "string")) throw refused();
  const c = completion as unknown as NativeCompletion;
  for (const field of ["account_id", "authorization_request_id", "application_id", "application_installation_id", "collection_id", "grant_id"] as const) {
    if (!uuid.test(c[field])) throw refused();
  }
  if (!c.application_declaration_id || !/^[0-9a-f]{64}$/.test(c.application_manifest_digest)
      || !publicBytes(c.grant_signing_public_key, 65, 4) || !publicBytes(c.client_noise_public_key, 32)) throw refused();
  try { if (new URL(c.application_origin).origin !== c.application_origin) throw refused(); }
  catch { throw refused(); }
  const bindings = {
    account_id: expected.accountId, authorization_request_id: expected.authorizationRequestId,
    application_id: expected.applicationId, application_declaration_id: expected.declarationId,
    application_manifest_digest: expected.manifestDigest, application_installation_id: expected.applicationInstallationId,
    application_origin: expected.applicationOrigin, collection_id: expected.collectionId,
    grant_signing_public_key: expected.grantSigningPublicKey, client_noise_public_key: expected.clientNoisePublicKey,
  };
  if (Object.entries(bindings).some(([field, wanted]) => c[field as keyof typeof bindings] !== wanted)
      || (expected.grantId !== undefined && c.grant_id !== expected.grantId)
      || token!.collection_id !== c.collection_id || token!.grant_id !== c.grant_id
      || token!.application_origin !== c.application_origin) throw refused();
  return Object.freeze({ ...c });
}
