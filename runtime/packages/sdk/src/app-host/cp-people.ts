/** Fixed, pinned CP people GETs. No record payload, path, key, or issuer inference. */
import { LOCAL_APPLICATION_BUILD, localApplicationHttpOrigin } from "../application/local-build.js";
import { uuidToBytes } from "../codec.js";
import { mdbaseError, MdbaseError } from "../errors.js";
import type { PeopleAuthority, PeopleRequestOptions } from "../people.js";
import type { AppCpSession } from "./cp-authority.js";

export interface AppCpPeopleOptions { fetch?: typeof globalThis.fetch; allowLoopbackHttp?: boolean }
const unavailable = () => mdbaseError("unavailable", "people metadata is unavailable", "people_response");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}
function endpoint(value: number | bigint): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw unavailable();
  const result = BigInt(value);
  if (result < 0n || result > (1n << 64n) - 1n) throw unavailable();
  return result;
}
/** Shares the genuine registered-device session pin, never its signing authority. */
export class AppCpPeopleAuthority implements PeopleAuthority {
  private readonly cpOrigin: string;
  private readonly rawOrigin: string;
  readonly collection: string;
  private readonly connector: string;
  private readonly device: string;
  private readonly ep: bigint;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly lifetime = new AbortController();
  constructor(private readonly session: AppCpSession, options: AppCpPeopleOptions = {}) {
    this.rawOrigin = session.cpOrigin;
    const url = new URL(this.rawOrigin);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
        (url.protocol !== "https:" && !(options.allowLoopbackHttp === true && url.protocol === "http:" && (LOCAL_APPLICATION_BUILD ? localApplicationHttpOrigin(session.cpOrigin) : ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))))
      throw mdbaseError("invalid_request", "invalid people CP origin", "people_binding");
    this.cpOrigin = url.origin;
    this.collection = session.collection; this.connector = session.connectorId; this.device = session.deviceId; this.ep = endpoint(session.endpoint);
    for (const id of [this.collection, this.connector, this.device]) if (uuidToBytes(id).every(value => value === 0)) throw mdbaseError("invalid_request", "nil people binding", "people_binding");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!this.isCurrent()) throw mdbaseError("unauthenticated", "people scope is not current", "people_fenced");
  }
  isCurrent(): boolean {
    try { return !this.lifetime.signal.aborted && this.session.isCurrent() === true && this.session.cpOrigin === this.rawOrigin && this.session.collection === this.collection && this.session.connectorId === this.connector && this.session.deviceId === this.device && endpoint(this.session.endpoint) === this.ep; }
    catch { return false; }
  }
  private check(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (!this.isCurrent()) throw mdbaseError("unauthenticated", "people scope changed", "people_fenced");
  }
  async request(resource: "identity" | "members", options: PeopleRequestOptions = {}): Promise<unknown> {
    if (resource !== "identity" && resource !== "members") throw mdbaseError("invalid_request", "invalid people resource");
    this.check(options.signal);
    const ctrl = new AbortController(), abort = () => ctrl.abort();
    options.signal?.addEventListener("abort", abort, { once: true }); this.lifetime.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15_000); (timer as { unref?: () => void }).unref?.();
    const bytes = new Uint8Array(1024 * 1024); let count = 0;
    let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const bearer = await this.session.connectorBearer({ signal: ctrl.signal }); this.check(options.signal);
      if (ctrl.signal.aborted) throw unavailable();
      if (typeof bearer !== "string" || !/^(idev_|ct_)/.test(bearer) || bearer.length > 16 * 1024 || /[^\x21-\x7e]/.test(bearer))
        throw mdbaseError("unauthenticated", "invalid people credential", "people_binding");
      const fetchImpl = this.fetchImpl;
      response = await fetchImpl(`${this.cpOrigin}/v1/authorities/${this.collection}/${resource}?device_id=${this.device}`, {
        method: "GET", headers: { authorization: `Bearer ${bearer}` }, signal: ctrl.signal,
        // Default cache mode so Chrome reuses the CORS preflight; the CP sends Cache-Control: no-store.
        redirect: "error", credentials: "omit", cache: "default", referrerPolicy: "no-referrer",
      });
      this.check(options.signal); if (ctrl.signal.aborted) throw unavailable();
      const length = response.headers.get("content-length");
      if (length !== null && /^(0|[1-9][0-9]*)$/.test(length) && Number(length) > bytes.length) throw unavailable();
      if (!response.body) throw unavailable(); reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        try { this.check(options.signal); if (ctrl.signal.aborted) throw unavailable(); if (done) break;
          if (count + value.length > bytes.length) throw unavailable(); bytes.set(value, count); count += value.length;
        } finally { value?.fill(0); }
      }
      const body = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count))));
      this.check(options.signal);
      if (response.status === 401) throw mdbaseError("unauthenticated", "people credential is no longer current", "people_fenced");
      if (response.status === 403) {
        const error = object(body.error);
        throw mdbaseError("forbidden", "people access was refused", resource === "members" && error.code === "people_permission_declined" ? "people_permission_declined" : "people_access");
      }
      if (response.status === 404) throw mdbaseError("upgrade_required", "people metadata is unsupported", "people_unsupported");
      if (!response.ok) throw unavailable();
      return body;
    } catch (error) {
      this.check(options.signal);
      if (error instanceof MdbaseError) throw error;
      throw unavailable();
    } finally {
      ctrl.abort(); bytes.fill(0); void (reader?.cancel() ?? response?.body?.cancel())?.catch(() => {}); reader?.releaseLock();
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort); this.lifetime.signal.removeEventListener("abort", abort);
    }
  }
  close(): void { this.lifetime.abort(); }
}
