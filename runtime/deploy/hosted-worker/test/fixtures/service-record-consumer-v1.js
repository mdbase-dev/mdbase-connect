// Prior seven-field consumer artifact: protocol-test fixture only.
// src/control.ts
var UUID3 = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
var KEY = /^[0-9a-f]{64}$/;
var MAX_RECORD_BYTES = 128 * 1024;
var MAX_TOKEN_BYTES = 8 * 1024;
var MAX_WRAPPED_BYTES = 64 * 1024;
var TOKEN_LIFETIME_MS = 15 * 6e4;
var REFRESH_MARGIN_MS = 6e4;
var TIMEOUT_MS2 = 1e4;
var ControlError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
  code;
  static {
    __name(this, "ControlError");
  }
};
var fromHex4 = /* @__PURE__ */ __name((s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16))), "fromHex");
function fromBase64(s) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return null;
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
__name(fromBase64, "fromBase64");
function statusError(status) {
  if (status === 409) return new ControlError("not_standard", "the collection is not a current cloud copy");
  if (status === 404) return new ControlError("not_found", "no such service device");
  if (status >= 500) return new ControlError("unavailable", `control plane answered ${status}`);
  return new ControlError("refused", `control plane answered ${status}`);
}
__name(statusError, "statusError");
function fetchFailure(cause, signal) {
  if (typeof AbortSignal.any !== "function") return "abort_any_unavailable";
  if (typeof AbortSignal.timeout !== "function") return "abort_timeout_unavailable";
  if (signal.aborted) return "caller_aborted";
  if (cause instanceof Error) {
    if (cause.name === "TimeoutError") return "timeout";
    if (cause.name === "AbortError") return "aborted";
    if (cause.message.includes("different request") || cause.message.includes("I/O on behalf")) return "io_context";
    if (cause.message.includes("signal") && cause.message.includes("AbortSignal")) return "signal_type";
    if (cause.name === "TypeError") return "type_error";
  }
  return "network";
}
__name(fetchFailure, "fetchFailure");
var ControlClient = class {
  constructor(config, fetchImpl = fetch, now = Date.now) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    const url = new URL(config.url);
    if (url.protocol !== "https:") throw new Error("the control plane URL must use https");
    if (config.token.length < 32) throw new Error("the control plane token must be at least 32 characters");
    this.base = url.toString().replace(/\/+$/, "");
    this.token = config.token;
    this.kind = config.kind ?? "hosted";
  }
  fetchImpl;
  now;
  static {
    __name(this, "ControlClient");
  }
  base;
  token;
  tokens = /* @__PURE__ */ new Map();
  kind;
  async call(path, init, limit, signal) {
    let response;
    try {
      const fetchImpl = this.fetchImpl;
      response = await fetchImpl(`${this.base}${path}`, {
        method: init.method,
        headers: { authorization: `Bearer ${this.token}`, ...init.body ? { "content-type": "application/json" } : {} },
        body: init.body ? JSON.stringify(init.body) : void 0,
        // workerd rejects redirect: "error"; never follow (the bearer must not be
        // forwarded) and refuse any 3xx explicitly below.
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS2)])
      });
    } catch (cause) {
      throw new ControlError("unavailable", `control plane unreachable (${fetchFailure(cause, signal)})`);
    }
    if (response.type === "opaqueredirect" || response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ControlError("refused", "control plane redirected; not followed");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw statusError(response.status);
    }
    const reader = response.body?.getReader();
    const chunks = [];
    let total = 0;
    for (; ; ) {
      const next = reader ? await reader.read() : { done: true, value: void 0 };
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new ControlError("invalid", "control plane answer too large");
      }
      chunks.push(next.value);
    }
    const all = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      all.set(c, off);
      off += c.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(all));
    } catch {
      throw new ControlError("invalid", "control plane answer is not JSON");
    }
  }
  /** This collection's service-device record of this deployment's kind. */
  async serviceDevice(collection, signal) {
    if (!UUID3.test(collection)) throw new ControlError("invalid", "collection");
    const r = await this.call(`/internal/v1/next/collections/${collection}/service-devices/${this.kind}`, { method: "GET" }, MAX_RECORD_BYTES, signal);
    const ok = r && typeof r === "object" && Object.keys(r).length === 7 && r.kind === this.kind && typeof r.device_id === "string" && UUID3.test(r.device_id) && [r.sign_pk, r.kem_pk, r.noise_pk].every((k) => typeof k === "string" && KEY.test(k)) && typeof r.wrapped_keys === "string" && typeof r.kms_key_arn === "string" && /^arn:[!-~]{1,2044}$/.test(r.kms_key_arn);
    const wrapped = ok ? fromBase64(r.wrapped_keys) : null;
    if (!ok || !wrapped || wrapped.length === 0 || wrapped.length > MAX_WRAPPED_BYTES) {
      throw new ControlError("invalid", "malformed service device record");
    }
    return {
      kind: this.kind,
      deviceId: r.device_id,
      signPk: fromHex4(r.sign_pk),
      kemPk: fromHex4(r.kem_pk),
      noisePk: fromHex4(r.noise_pk),
      wrappedKeys: wrapped,
      kmsKeyArn: r.kms_key_arn
    };
  }
  /** A role-0 log token for `device` in `collection`, from cache while it has a minute left. */
  async logToken(device, collection, signal) {
    if (!UUID3.test(device) || !UUID3.test(collection)) throw new ControlError("invalid", "device or collection");
    const key4 = `${device}/${collection}`;
    const now = this.now();
    const cached = this.tokens.get(key4);
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now) return cached;
    this.tokens.delete(key4);
    const r = await this.call(`/internal/v1/next/service-devices/${device}/log-token`, { method: "POST", body: { collection } }, MAX_TOKEN_BYTES, signal);
    const ok = r && typeof r === "object" && typeof r.token === "string" && /^[0-9a-f]+\.[0-9a-f]{128}$/.test(r.token) && typeof r.expires_at === "number" && Number.isSafeInteger(r.expires_at) && r.expires_at > now + REFRESH_MARGIN_MS && r.expires_at <= now + TOKEN_LIFETIME_MS + REFRESH_MARGIN_MS;
    if (!ok) throw new ControlError("invalid", "malformed log token");
    const token = { token: r.token, expiresAt: r.expires_at };
    this.tokens.set(key4, token);
    return token;
  }
  /** Forget cached tokens (on revocation, a collection leaving sync, or a refused token). */
  forget(collection) {
    if (!collection) return this.tokens.clear();
    for (const key4 of [...this.tokens.keys()]) if (key4.endsWith(`/${collection}`)) this.tokens.delete(key4);
  }
};

// fixture-end
