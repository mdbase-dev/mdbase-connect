/** Narrow retained-consent metadata API; independent of data setup and transport. */
import type { MdbaseConnection } from "./connection.js";
import { signAuthorityRequest } from "./crypto.js";
import { base64UrlBytes, bytesToBase64Url } from "./base64.js";
import { connectError, MdbaseConnectError } from "./errors.js";
import type { StoredToken } from "./internal-types.js";
import type { ConnectRequestOptions } from "./operation-types.js";
import { requestAbortReason, withCooperativeRequestBudget } from "./request-budget.js";

export interface AccountBackendInfo {
  /** Consenting grant's account, not the collection owner's account. */
  readonly accountId: string;
  readonly backend: "legacy" | "next";
}
const PATH = "/v1/account/backend";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const invalid = () => connectError("invalid_operation_response", "Invalid account backend metadata or consent binding.");
function origin(value: string): string {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.origin !== value.replace(/\/$/u, "")) throw invalid();
    return u.origin;
  } catch { throw invalid(); }
}
function binding(t: StoredToken): string {
  if (!t.grantId || !UUID.test(t.grantId) || !t.clientId || !t.keyHandle || !t.applicationOrigin
    || !t.accessToken || !Number.isFinite(t.expiresAt) || t.expiresAt <= Date.now()
    || !Number.isFinite(t.savedAt)) throw invalid();
  // Capture every persisted grant field before any async lease/key/network work.
  // This stays private and is never a diagnostic or a public account identity.
  return JSON.stringify(t);
}
function signingPoint(value: string): void {
  if (!/^[A-Za-z0-9_-]{87}$/u.test(value)) throw invalid();
  const bytes = base64UrlBytes(value);
  if (bytes.length !== 65 || bytes[0] !== 4 || bytesToBase64Url(bytes) !== value) throw invalid();
}
async function body(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    await response.body?.cancel().catch(() => {});
    throw invalid();
  }
  const reader = response.body?.getReader();
  if (!reader) throw invalid();
  const parts: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw requestAbortReason(signal);
    for (;;) {
      const r = await reader.read();
      if (signal.aborted) throw requestAbortReason(signal);
      if (r.done) break;
      size += r.value.byteLength;
      if (size > 4096) throw invalid();
      parts.push(r.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw invalid(); }
  } finally {
    parts.length = 0;
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Read authoritative account routing BEFORE application.start/select, describe or
 * setup. Failure is an opening error, never an implicit legacy selection. Uses the
 * existing AuthorityProofV1 grant key internally for this ONE fixed GET only.
 */
export async function accountBackend(
  connection: MdbaseConnection,
  options: ConnectRequestOptions = {}
): Promise<AccountBackendInfo> {
  try {
    // Internal bracket seam, not public credential, key or generic request access.
    const transport = connection["transport"];
    const server = origin(transport["serverUrl"]); // Before credentials/key access.
    return await withCooperativeRequestBudget({
      ...options,
      timeoutMs: options.timeoutMs == null ? 10_000 : Math.min(options.timeoutMs, 10_000)
    }, 10_000, async budget => {
      const token = transport.currentToken();
      if (!token) throw connectError("not_authorized", "Retained consent is required to select an account backend.");
      const expected = binding(token);
      const leases = transport["grantKeyLeases"]();
      const check = () => {
        if (budget.signal.aborted) throw requestAbortReason(budget.signal);
        const current = transport.currentToken();
        if (origin(transport["serverUrl"]) !== server || !current || binding(current) !== expected) {
          throw connectError("authority_authorization_changed", "Retained consent changed while selecting an account backend.");
        }
      };
      try {
        await leases.retain(token, budget.signal);
        check();
        const store = transport["keyStore"];
        const key = await store.get(token.keyHandle!);
        check();
        if (!key?.signingPublicKey || key.handle !== token.keyHandle) {
          throw connectError("missing_grant_key", "Retained consent proof key is unavailable.");
        }
        signingPoint(key.signingPublicKey);
        const proof = await signAuthorityRequest(store, token.keyHandle!, key.signingPublicKey, {
          method: "GET", target: PATH, credential: token.accessToken
        });
        check();
        const response = await fetch(`${server}${PATH}`, {
          method: "GET", headers: { authorization: `Bearer ${token.accessToken}`, ...proof },
          signal: budget.signal, credentials: "omit", redirect: "error", cache: "no-store"
        });
        try { check(); }
        catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw connectError(response.status === 401 || response.status === 403 ? "not_authorized" : "operation_failed",
            "Account backend metadata is unavailable.", { status: response.status });
        }
        const value = await body(response, budget.signal);
        check();
        if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
        const r = value as Record<string, unknown>;
        if (Object.keys(r).length !== 2 || typeof r.account_id !== "string" || !UUID.test(r.account_id)
          || (r.backend !== "legacy" && r.backend !== "next")) throw invalid();
        return Object.freeze({ accountId: r.account_id, backend: r.backend });
      } catch (error) {
        if (budget.signal.aborted) throw requestAbortReason(budget.signal);
        throw error;
      } finally { leases.release(); }
    });
  } catch (error) {
    if (error instanceof MdbaseConnectError) throw error;
    // Never leak crypto/store/fetch error payloads (or select a legacy fallback).
    throw connectError("operation_failed", "Account backend metadata could not be read.");
  }
}
