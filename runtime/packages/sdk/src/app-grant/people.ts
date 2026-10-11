/**
 * People metadata (identity, members) for a Private collection, read from Connect with
 * the app's grant: the same `PeopleAuthority` the cloud-copy path gives
 * `MdbasePeopleClient`. Connect answers `approval_required` until a computer of the
 * account approves the app, which surfaces as that collection availability reason.
 */
import { collectionUnavailableError } from "../collection-availability.js";
import { mdbaseError, MdbaseError } from "../errors.js";
import type { PeopleAuthority, PeopleRequestOptions } from "../people.js";

const MAX_BYTES = 1024 * 1024;
const REQUEST_MS = 15_000;
const unavailable = () => mdbaseError("unavailable", "people metadata is unavailable", "people_response");

export interface AppGrantPeopleSource {
  readonly cpOrigin: string;
  readonly fetch: typeof fetch;
  /** A current access token for the collection's grant; `force` refreshes it. */
  accessToken(collection: string, force: boolean): Promise<string>;
  /** False once the grant was forgotten in this browser. */
  holds(collection: string): boolean;
}

export function appGrantPeopleAuthority(collection: string, source: AppGrantPeopleSource): PeopleAuthority {
  const fenced = () => mdbaseError("unauthenticated", "people scope changed", "people_fenced");
  const authority: PeopleAuthority = {
    collection,
    isCurrent: () => source.holds(collection),
    async request(resource: "identity" | "members", options: PeopleRequestOptions = {}): Promise<unknown> {
      if (resource !== "identity" && resource !== "members") throw mdbaseError("invalid_request", "invalid people resource");
      for (let attempt = 0; ; attempt++) {
        options.signal?.throwIfAborted();
        if (!authority.isCurrent()) throw fenced();
        const token = await source.accessToken(collection, attempt > 0);
        const { status, body } = await get(source, `/v1/authorities/${collection}/${resource}`, token, options.signal);
        if (!authority.isCurrent()) throw fenced();
        if (status === 401 && attempt === 0) continue;
        if (status === 401) throw mdbaseError("unauthenticated", "people credential is no longer current", "people_fenced");
        if (status === 403) {
          const code = (body?.error as { code?: unknown } | undefined)?.code;
          if (code === "approval_required") throw collectionUnavailableError("approval_required");
          throw mdbaseError("forbidden", "people access was refused", resource === "members" && code === "insufficient_access" ? "people_permission_declined" : "people_access");
        }
        if (status === 404) throw mdbaseError("upgrade_required", "people metadata is unsupported", "people_unsupported");
        if (status !== 200 || !body) throw unavailable();
        return body;
      }
    },
  };
  return authority;
}

async function get(source: AppGrantPeopleSource, path: string, token: string, signal?: AbortSignal): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const ctrl = new AbortController(), abort = () => ctrl.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, REQUEST_MS);
  (timer as { unref?: () => void }).unref?.();
  try {
    const res = await source.fetch(`${source.cpOrigin}${path}`, {
      method: "GET", headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal,
      redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
    });
    const text = await res.text();
    if (text.length > MAX_BYTES) throw unavailable();
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch { body = null; }
    return { status: res.status, body };
  } catch (error) {
    if (signal?.aborted) throw mdbaseError("cancelled", "request cancelled");
    if (error instanceof MdbaseError) throw error;
    throw unavailable();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
