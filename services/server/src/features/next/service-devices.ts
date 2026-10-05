// Service devices of a cloud-copy collection: the hosted replica and escrow members
// (mdbase-next interface note 2026-10-04-control-hosted-replica.md §2, §3). The deployment
// generates the keys and returns the public halves plus its KMS-wrapped private keys;
// the control plane stores the record, enrols the public keys, and hands the record
// and role-0 log tokens back to the deployment of the same kind. It never unwraps.
import { z } from "zod";
import type { DatabaseQueryable } from "../../database-types.js";
import { weakAgreementKey, weakSigningKey } from "./devices.js";

export type ServiceKind = "hosted" | "escrow";

export const MAX_WRAPPED_KEYS_BYTES = 64 * 1024;
const MAX_GENERATE_RESPONSE_BYTES = 2 * MAX_WRAPPED_KEYS_BYTES;
const GENERATE_TIMEOUT_MS = 10_000;

export interface ServiceDeviceRecord {
  kind: ServiceKind;
  device_id: string;
  sign_pk: Buffer;
  kem_pk: Buffer;
  noise_pk: Buffer;
  wrapped_keys: Buffer;
  kms_key_arn: string;
}

export class ServiceDeviceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const key32 = z.string().regex(/^[0-9a-f]{64}$/u);
const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/u).max(Math.ceil(MAX_WRAPPED_KEYS_BYTES / 3) * 4);
const wireRecord = z.object({
  kind: z.enum(["hosted", "escrow"]),
  device_id: z.uuid(),
  sign_pk: key32,
  kem_pk: key32,
  noise_pk: key32,
  wrapped_keys: base64,
  kms_key_arn: z.string().min(1).max(2048).regex(/^arn:[!-~]+$/u)
}).strict();

type ServiceDeviceWire = z.infer<typeof wireRecord>;

/** Parse a record from its wire form. Rejects anything malformed or oversized. */
export function parseServiceDevice(value: unknown): ServiceDeviceRecord {
  const parsed = wireRecord.safeParse(value);
  if (!parsed.success) throw new ServiceDeviceError(502, "invalid_service_device", "The service device record is malformed.");
  if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/u.test(parsed.data.device_id)) {
    throw new ServiceDeviceError(502, "invalid_service_device", "A service device needs a non-nil ID.");
  }
  const wrapped = Buffer.from(parsed.data.wrapped_keys, "base64");
  if (wrapped.length === 0 || wrapped.length > MAX_WRAPPED_KEYS_BYTES || wrapped.toString("base64") !== parsed.data.wrapped_keys) {
    throw new ServiceDeviceError(502, "invalid_service_device", "The wrapped keys are malformed.");
  }
  const sign = Buffer.from(parsed.data.sign_pk, "hex");
  const kem = Buffer.from(parsed.data.kem_pk, "hex");
  const noise = Buffer.from(parsed.data.noise_pk, "hex");
  // Policy (replica policy.rs, policy.md §6.4) voids an all-zero noise_pk for every
  // kind but recovery, so escrow too enrols a real X25519 key, which it never serves.
  if (weakSigningKey(sign) || weakAgreementKey(kem) || weakAgreementKey(noise)) {
    throw new ServiceDeviceError(502, "invalid_service_device", "A service device key is weak or misplaced.");
  }
  return {
    kind: parsed.data.kind,
    device_id: parsed.data.device_id.toLowerCase(),
    sign_pk: sign,
    kem_pk: kem,
    noise_pk: noise,
    wrapped_keys: wrapped,
    kms_key_arn: parsed.data.kms_key_arn
  };
}

export function serviceDeviceWire(record: ServiceDeviceRecord): ServiceDeviceWire {
  return {
    kind: record.kind,
    device_id: record.device_id,
    sign_pk: record.sign_pk.toString("hex"),
    kem_pk: record.kem_pk.toString("hex"),
    noise_pk: record.noise_pk.toString("hex"),
    wrapped_keys: record.wrapped_keys.toString("base64"),
    kms_key_arn: record.kms_key_arn
  };
}

function sameRecord(a: ServiceDeviceRecord, b: ServiceDeviceRecord): boolean {
  return a.kind === b.kind && a.device_id === b.device_id && a.kms_key_arn === b.kms_key_arn
    && a.sign_pk.equals(b.sign_pk) && a.kem_pk.equals(b.kem_pk) && a.noise_pk.equals(b.noise_pk) && a.wrapped_keys.equals(b.wrapped_keys);
}

type Row = Omit<ServiceDeviceRecord, "kind"> & { kind: ServiceKind };
const COLUMNS = "device.kind, device.device_id::text AS device_id, device.sign_pk, device.kem_pk, device.noise_pk, device.wrapped_keys, device.kms_key_arn";

/**
 * Store the record of `collection`'s service device of its kind. Idempotent for the
 * same record; a different record for the same collection and kind is refused, so a
 * retried bootstrap never replaces an enrolled device. Run inside the caller's transaction.
 */
export async function storeServiceDevice(db: DatabaseQueryable, collection: string, given: ServiceDeviceRecord): Promise<ServiceDeviceRecord> {
  // Every writer gets the parser's checks, not only records that came over HTTP.
  const record = parseServiceDevice(serviceDeviceWire(given));
  await db.query(
    `INSERT INTO next_service_devices(collection_id, kind, device_id, sign_pk, kem_pk, noise_pk, wrapped_keys, kms_key_arn)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [collection, record.kind, record.device_id, record.sign_pk, record.kem_pk, record.noise_pk, record.wrapped_keys, record.kms_key_arn]
  );
  const stored = await loadServiceDevice(db, collection, { kind: record.kind }, true);
  if (!stored || !sameRecord(stored, record)) throw new ServiceDeviceError(409, "service_device_conflict", "A different service device is already recorded.");
  return stored;
}

/**
 * The record of `collection`'s service device of a kind, or with a device id. Unless
 * `anyState`, only while the collection is cloud copy and has not left sync, checked in
 * the same statement under a share lock on the collection row, so a concurrent leave
 * either waits for this read or is seen by it.
 */
export async function loadServiceDevice(
  db: DatabaseQueryable,
  collection: string,
  by: { kind: ServiceKind } | { device: string },
  anyState = false
): Promise<ServiceDeviceRecord | null> {
  const [column, value] = "kind" in by ? ["kind", by.kind] : ["device_id", by.device];
  const current = anyState ? "" : "AND parent.sync = 'cloud_copy' AND parent.left_sync_at IS NULL";
  const result = await db.query<Row>(
    `SELECT ${COLUMNS} FROM next_service_devices device
     JOIN next_collections parent ON parent.collection_id = device.collection_id
     WHERE device.collection_id = $1 AND device.${column} = $2 ${current}
     FOR SHARE OF parent`,
    [collection, value]
  );
  return result.rows[0] ?? null;
}

export interface ServiceDeploymentConfig {
  url: string;
  token: string;
}

/**
 * Ask the deployment of `kind` to generate a service device for `collection`
 * (`POST <deployment>/internal/v1/service-devices`). The response is bounded and must
 * name the requested kind. The deployment need not be idempotent or keep state: the
 * control plane's first stored record wins (`storeServiceDevice`), a retry after a
 * committed store reuses that record without calling the deployment again, and a
 * device generated for a store that never committed is discarded unused.
 */
export async function generateServiceDevice(
  deployment: ServiceDeploymentConfig,
  kind: ServiceKind,
  collection: string,
  fetchImpl: typeof fetch = fetch
): Promise<ServiceDeviceRecord> {
  const url = new URL("internal/v1/service-devices", `${deployment.url.replace(/\/+$/u, "")}/`);
  if (url.protocol !== "https:") throw new ServiceDeviceError(503, "service_deployment_unavailable", "The service deployment must use HTTPS.");
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${deployment.token}`, "content-type": "application/json" },
      body: JSON.stringify({ collection }),
      redirect: "error",
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS)
    });
  } catch {
    throw new ServiceDeviceError(503, "service_deployment_unavailable", "The service deployment is unavailable.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ServiceDeviceError(response.status >= 500 ? 503 : 502, "service_deployment_refused", `The service deployment answered ${response.status}.`);
  }
  const text = await readBounded(response, MAX_GENERATE_RESPONSE_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ServiceDeviceError(502, "invalid_service_device", "The service device record is malformed.");
  }
  const record = parseServiceDevice(body);
  if (record.kind !== kind) throw new ServiceDeviceError(502, "invalid_service_device", "The deployment returned another kind of device.");
  return record;
}

async function readBounded(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new ServiceDeviceError(502, "invalid_service_device", "The service device record is too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
