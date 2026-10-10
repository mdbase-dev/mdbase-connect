/**
 * `POST /internal/v1/service-devices {collection}`: the control plane asks this
 * deployment for the hosted service device of a new cloud-copy collection (Connect
 * cloud-copy bootstrap). Keys are generated in the engine wasm, the 96-byte secret is
 * wrapped by custody's KMS seam and wiped, and only public keys plus the envelope are
 * returned. The deployment keeps no state and need not be idempotent: the control
 * plane's first stored record wins, and a device it never stores is discarded unused.
 *
 * Authenticated by `HOSTED_SERVICE_TOKEN` (the control plane's outbound token for this
 * deployment, distinct from the token the deployment presents to the control plane).
 */
import type { GeneratedDevice } from "./keygen.js";
import type { DeviceKeyWrapper } from "./seams.js";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const MAX_BODY_BYTES = 1024;
const MAX_ENVELOPE_BYTES = 64 * 1024;
const WRAP_TIMEOUT_MS = 8_000;

function equal(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

const hex = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");

function base64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const error = (status: number, code: string) => json(status, { error: code });

async function boundedText(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limit) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Shared service-token guard; authenticate before reading any request body. */
export function serviceAuthorization(request: Request, serviceToken?: string): Response | null {
  if (request.method !== "POST") return error(405, "method_not_allowed");
  const token = serviceToken ?? "";
  if (token.length < 32 || !equal(request.headers.get("authorization") ?? "", `Bearer ${token}`)) {
    return error(401, "invalid_service_token");
  }
  return null;
}

/** Authenticate and decode the shared bounded CP service request. */
export async function serviceCollection(request: Request, serviceToken?: string): Promise<string | Response> {
  const denied = serviceAuthorization(request, serviceToken);
  if (denied) return denied;
  const text = await boundedText(request, MAX_BODY_BYTES);
  try {
    const body = text === null ? null : JSON.parse(text) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Object.keys(body).length !== 1 ||
      typeof body.collection !== "string" || !UUID.test(body.collection)) return error(400, "invalid_request");
    return body.collection;
  } catch { return error(400, "invalid_request"); }
}

export async function generateServiceDevice(
  request: Request,
  deps: {
    serviceToken?: string; generate: () => GeneratedDevice; wrapper: DeviceKeyWrapper; newId?: () => string;
    /** This deployment's service role (default `hosted`). */
    kind?: "hosted" | "escrow";
  },
): Promise<Response> {
  const collection = await serviceCollection(request, deps.serviceToken);
  if (collection instanceof Response) return collection;
  const device = (deps.newId ?? (() => crypto.randomUUID()))();
  const keys = deps.generate();
  let wrapped: { envelope: Uint8Array; kmsKeyArn: string };
  try {
    wrapped = await deps.wrapper.wrapDeviceKeys({ collection, device, secret: keys.secret }, AbortSignal.timeout(WRAP_TIMEOUT_MS));
  } catch {
    return error(503, "custody_unavailable");
  } finally {
    keys.secret.fill(0);
  }
  const { envelope, kmsKeyArn } = wrapped;
  if (!(envelope instanceof Uint8Array) || envelope.length === 0 || envelope.length > MAX_ENVELOPE_BYTES
    || typeof kmsKeyArn !== "string" || !/^arn:[!-~]{1,2044}$/.test(kmsKeyArn)) {
    return error(503, "custody_unavailable");
  }
  return json(200, {
    kind: deps.kind ?? "hosted",
    device_id: device,
    sign_pk: hex(keys.signPk),
    kem_pk: hex(keys.kemPk),
    noise_pk: hex(keys.noisePk),
    wrapped_keys: base64(envelope),
    kms_key_arn: kmsKeyArn,
  });
}
