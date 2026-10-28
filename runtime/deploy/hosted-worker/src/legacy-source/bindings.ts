/**
 * The Worker's **legacy source bindings**: how a LAB or managed hosted Worker reaches the
 * data it migrates from, read-only, for exactly the collections it is configured
 * for. Builds the `LegacySourceConfig` that `source.ts` reads through.
 *
 * - **Postgres:** a Hyperdrive binding (`LEGACY_DB`) whose origin user is the
 *   SELECT-only `mdbn_hosted_legacy_reader` role (`sql/legacy-reader-role.sql`:
 *   column-level SELECT on the reader's columns only). Each checkpoint opens one
 *   `REPEATABLE READ READ ONLY` transaction; live hold checks use a fixed SELECT
 *   in a separate read-only transaction. The adapter passes only single `SELECT`/`SHOW`
 *   statements. `source.ts` then refuses any role that could
 *   write. Three independent refusals: the adapter, the transaction, the role.
 * - **Storage:** the legacy R2 bucket over the S3 API with object-read-only
 *   credentials (an R2 binding cannot be read-only, and the bucket may live in
 *   another account). Only `GET` is ever sent, and only for this collection's
 *   committed blob keys (`v1/blobs/<collection>/<transfer>[.<attempt>]`).
 * - **Unwrap:** per-envelope legacy AES-GCM or MDBK v1/AWS-KMS scheme1. Both
 *   capabilities are required in staging/production. LAB may omit the entire
 *   distinct legacy KMS set; partial custody is misconfigured, and MDBK without
 *   custody refuses at unwrap. Configured KMS retains its fixed region/approved
 *   historical key ARNs and exact provider context. No native device-key
 *   credential fallback or request-selected URL.
 *   Raw legacy master/collection keys are wiped after nonextractable decrypt-only
 *   import. Unknown/malformed envelopes fail closed; never retry as another mode.
 * - **Admission:** explicit LAB or matching staging/production source and KMS
 *   environments. Production is an enumerated tier, never a staging fallback.
 *   Deployment target/custody authentication remains the shared profile's job.
 * - **Scope:** `LEGACY_SOURCE_COLLECTIONS` is an explicit allowlist, never inferred
 *   from a request; the source is bound to one of its collections and refuses to
 *   open any other.
 *
 * Any missing or malformed setting fails closed with a typed `LegacyBindingError`
 * whose message names settings, never their values.
 *
 * Settings (vars unless noted): `LAB` / `KMS_ENVIRONMENT` and `LEGACY_SOURCE_ENVIRONMENT` (above),
 * `LEGACY_SOURCE_COLLECTIONS`, `LEGACY_DB` (Hyperdrive), `LEGACY_R2_ENDPOINT`
 * (`https://<account>.r2.cloudflarestorage.com`), `LEGACY_R2_BUCKET`, and secrets
 * `LEGACY_R2_ACCESS_KEY_ID`, `LEGACY_R2_SECRET_ACCESS_KEY`, `LEGACY_R2_SESSION_TOKEN`
 * (temporary credentials only), `LEGACY_MASTER_KEY`. The distinct provider KMS
 * bindings are listed in `LegacySourceEnv` and validated by `./aws-kms.ts`.
 */
import { AwsClient } from "aws4fetch";
import type { AwsCredentials } from "../custody/aws-kms.ts";
import { LegacyAwsKms, validateLegacyKmsConfig, type LegacyAwsKmsConfig } from "./aws-kms.ts";
import type { LegacyUnwrapper } from "./crypto.ts";

/** Exhaustive persisted DEK writer formats in provider P8a014fe's reachable history. */
export const SUPPORTED_LEGACY_ENVELOPE_MODES = Object.freeze([
  "local-aes-gcm-v1", "mdbk-v1-aws-kms-scheme-1",
] as const);
import {
  LegacySource, LegacySourceError,
  type Checkpoint, type CheckpointRequest, type LegacyObjects, type LegacySourceConfig, type ReadOnlyTx, type Row,
} from "./source.ts";

export type LegacyBindingCode =
  | "legacy_source_unconfigured"
  | "legacy_source_misconfigured"
  | "legacy_source_foreign_collection"
  | "legacy_source_read_only";

/** Why the legacy source bindings refused. Names settings, never their values. */
export class LegacyBindingError extends Error {
  constructor(readonly code: LegacyBindingCode, message: string) {
    super(message);
  }
}

export interface LegacySourceEnv {
  LAB?: string;
  KMS_ENVIRONMENT?: string;
  LEGACY_SOURCE_ENVIRONMENT?: string;
  LEGACY_SOURCE_COLLECTIONS?: string;
  LEGACY_DB?: { connectionString?: unknown };
  LEGACY_R2_ENDPOINT?: string;
  LEGACY_R2_BUCKET?: string;
  LEGACY_R2_ACCESS_KEY_ID?: string;
  LEGACY_R2_SECRET_ACCESS_KEY?: string;
  LEGACY_R2_SESSION_TOKEN?: string;
  LEGACY_MASTER_KEY?: string;
  LEGACY_KMS_REGION?: string;
  LEGACY_KMS_KEY_ARNS?: string;
  LEGACY_KMS_ACCESS_KEY_ID?: string;
  LEGACY_KMS_SECRET_ACCESS_KEY?: string;
  LEGACY_KMS_SESSION_TOKEN?: string;
  /** Trusted credential issuer expiry, epoch milliseconds (required for STS). */
  LEGACY_KMS_CREDENTIALS_EXPIRES_AT?: string;
}

/** The host's Postgres client (in the Worker, `pg.Client` over the Hyperdrive string). */
export interface PgClient {
  connect(): Promise<unknown>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
  end(): Promise<unknown>;
}
export type PgConnect = (connectionString: string) => PgClient;

export interface LegacyR2Settings {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Closed shared environment selection; LAB remains isolated fixture machinery. */
export type LegacySourceTier = "lab" | "staging" | "production";

export interface LegacyBindingSettings {
  tier: LegacySourceTier;
  collections: string[];
  connectionString: string;
  r2: LegacyR2Settings;
  /** Raw legacy master key; the caller imports it and wipes this copy. */
  masterKey: Uint8Array;
  /** Absent only for LAB with the entire dedicated KMS set absent. */
  kms?: LegacyAwsKmsConfig;
  /** Separate legacy unwrap authority; absent with kms, never native AWS_* fallback. */
  kmsCredentials?: AwsCredentials;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The provider commits `<transfer>` or, for a re-attempted completion,
// `<transfer>.<attempt>` (connect-hosted-provider files/upload.rs).
const COMMITTED_BLOB = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/;
const R2_ENDPOINT = /^https:\/\/[0-9a-f]{32}\.r2\.cloudflarestorage\.com$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const CREDENTIAL = /^[A-Za-z0-9+/=_.:-]{16,2048}$/;
const MAX_COLLECTIONS = 16;
/** One statement that only reads: SELECT or SHOW, no statement separator, no row locks. */
const READ_STATEMENT = /^\s*(?:SELECT|SHOW)\b/i;
const ROW_LOCK = /\bFOR\s+(?:UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i;

const misconfigured = (what: string) => new LegacyBindingError("legacy_source_misconfigured", `${what} is malformed`);

function decodeKey(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw misconfigured("LEGACY_MASTER_KEY");
  let bin: string;
  try {
    bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  } catch {
    throw misconfigured("LEGACY_MASTER_KEY");
  }
  if (bin.length !== 32) throw misconfigured("LEGACY_MASTER_KEY");
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * The admission tier from the deployment's own environment, before any other
 * setting is read. Staging/production must be selected explicitly, with no LAB
 * flag. LAB needs `LAB=1` and no foreign KMS environment. No production default.
 */
function admissionTier(env: LegacySourceEnv): LegacySourceTier {
  const kms = env.KMS_ENVIRONMENT;
  if (env.LAB === "1") {
    if (kms !== undefined && kms !== "" && kms !== "lab") throw misconfigured("KMS_ENVIRONMENT");
    return "lab";
  }
  if (env.LAB !== undefined && env.LAB !== "" && env.LAB !== "0") throw misconfigured("LAB");
  if (kms === "staging" || kms === "production") return kms;
  throw new LegacyBindingError("legacy_source_unconfigured", "legacy source requires an explicit LAB or managed KMS_ENVIRONMENT");
}

/** Parse and check every setting; refuse (typed) on anything missing or malformed. */
export function legacyBindingSettings(env: LegacySourceEnv): LegacyBindingSettings {
  const tier = admissionTier(env);
  if (!env.LEGACY_SOURCE_ENVIRONMENT) {
    throw new LegacyBindingError("legacy_source_unconfigured", "legacy source bindings missing: LEGACY_SOURCE_ENVIRONMENT");
  }
  if (env.LEGACY_SOURCE_ENVIRONMENT !== tier) throw misconfigured("LEGACY_SOURCE_ENVIRONMENT");
  const kmsRequired = {
    LEGACY_KMS_REGION: env.LEGACY_KMS_REGION,
    LEGACY_KMS_KEY_ARNS: env.LEGACY_KMS_KEY_ARNS,
    LEGACY_KMS_ACCESS_KEY_ID: env.LEGACY_KMS_ACCESS_KEY_ID,
    LEGACY_KMS_SECRET_ACCESS_KEY: env.LEGACY_KMS_SECRET_ACCESS_KEY,
  };
  // Only complete absence opts LAB out. Empty/null/malformed values and orphan
  // optional metadata are configuration, not an absent capability or mode hint.
  const hasKms = Object.values({ ...kmsRequired, sessionToken: env.LEGACY_KMS_SESSION_TOKEN,
    expiresAt: env.LEGACY_KMS_CREDENTIALS_EXPIRES_AT }).some(value => value !== undefined);
  const required = {
    LEGACY_SOURCE_ENVIRONMENT: env.LEGACY_SOURCE_ENVIRONMENT,
    LEGACY_SOURCE_COLLECTIONS: env.LEGACY_SOURCE_COLLECTIONS,
    LEGACY_DB: env.LEGACY_DB,
    LEGACY_R2_ENDPOINT: env.LEGACY_R2_ENDPOINT,
    LEGACY_R2_BUCKET: env.LEGACY_R2_BUCKET,
    LEGACY_R2_ACCESS_KEY_ID: env.LEGACY_R2_ACCESS_KEY_ID,
    LEGACY_R2_SECRET_ACCESS_KEY: env.LEGACY_R2_SECRET_ACCESS_KEY,
    LEGACY_MASTER_KEY: env.LEGACY_MASTER_KEY,
    ...(tier !== "lab" || hasKms ? kmsRequired : {}),
  };
  const missing = Object.entries(required).filter(([, v]) => v === undefined || v === null || v === "").map(([k]) => k);
  if (missing.length) {
    const code = tier === "lab" && hasKms && missing.some(name => name.startsWith("LEGACY_KMS_"))
      ? "legacy_source_misconfigured" : "legacy_source_unconfigured";
    throw new LegacyBindingError(code, `legacy source bindings missing: ${missing.join(", ")}`);
  }
  for (const [name, value] of Object.entries(required)) {
    if (name !== "LEGACY_DB" && typeof value !== "string") throw misconfigured(name);
  }
  const collections = env.LEGACY_SOURCE_COLLECTIONS!.split(",").map((c) => c.trim());
  if (!collections.length || collections.length > MAX_COLLECTIONS || collections.some((c) => !UUID.test(c))
      || new Set(collections).size !== collections.length || collections.includes("00000000-0000-0000-0000-000000000000")) {
    throw misconfigured("LEGACY_SOURCE_COLLECTIONS");
  }
  const cs = env.LEGACY_DB!.connectionString;
  if (typeof cs !== "string" || !/^postgres(?:ql)?:\/\/[^\s]+$/.test(cs) || cs.length > 4096) throw misconfigured("LEGACY_DB");
  if (!R2_ENDPOINT.test(env.LEGACY_R2_ENDPOINT!)) throw misconfigured("LEGACY_R2_ENDPOINT");
  if (!BUCKET.test(env.LEGACY_R2_BUCKET!)) throw misconfigured("LEGACY_R2_BUCKET");
  for (const name of ["LEGACY_R2_ACCESS_KEY_ID", "LEGACY_R2_SECRET_ACCESS_KEY"] as const) {
    if (!CREDENTIAL.test(env[name]!)) throw misconfigured(name);
  }
  if (env.LEGACY_R2_SESSION_TOKEN !== undefined && env.LEGACY_R2_SESSION_TOKEN !== ""
      && !CREDENTIAL.test(env.LEGACY_R2_SESSION_TOKEN)) {
    throw misconfigured("LEGACY_R2_SESSION_TOKEN");
  }
  let kms: LegacyAwsKmsConfig | undefined, kmsCredentials: AwsCredentials | undefined;
  if (tier !== "lab" || hasKms) {
    kms = {
      region: env.LEGACY_KMS_REGION!, environment: tier, collections,
      keyArns: env.LEGACY_KMS_KEY_ARNS!.split(","),
    };
    try { validateLegacyKmsConfig(kms); }
    catch { throw misconfigured("LEGACY_KMS_REGION/LEGACY_KMS_KEY_ARNS"); }
    if (!/^[A-Z0-9]{10,128}$/.test(env.LEGACY_KMS_ACCESS_KEY_ID!)) throw misconfigured("LEGACY_KMS_ACCESS_KEY_ID");
    const secret = env.LEGACY_KMS_SECRET_ACCESS_KEY!;
    if (typeof secret !== "string" || secret.length < 16 || secret.length > 256) throw misconfigured("LEGACY_KMS_SECRET_ACCESS_KEY");
    const sessionToken = env.LEGACY_KMS_SESSION_TOKEN;
    const expiry = env.LEGACY_KMS_CREDENTIALS_EXPIRES_AT;
    if (sessionToken !== undefined && (typeof sessionToken !== "string" || sessionToken.length === 0 || sessionToken.length > 8192 || /[\r\n]/.test(sessionToken))) throw misconfigured("LEGACY_KMS_SESSION_TOKEN");
    if (expiry !== undefined && (typeof expiry !== "string" || !/^\d{1,16}$/.test(expiry) || !Number.isSafeInteger(Number(expiry)) || Number(expiry) <= Date.now() + 30_000)) {
      throw misconfigured("LEGACY_KMS_CREDENTIALS_EXPIRES_AT");
    }
    if (sessionToken !== undefined && expiry === undefined) throw misconfigured("LEGACY_KMS_CREDENTIALS_EXPIRES_AT");
    kmsCredentials = {
      accessKeyId: env.LEGACY_KMS_ACCESS_KEY_ID!, secretAccessKey: secret,
      ...(sessionToken !== undefined ? { sessionToken } : {}),
      ...(expiry !== undefined ? { expiresAt: Number(expiry) } : {}),
    };
  }
  return {
    tier,
    collections,
    kms,
    kmsCredentials,
    connectionString: cs,
    r2: {
      endpoint: env.LEGACY_R2_ENDPOINT!, bucket: env.LEGACY_R2_BUCKET!,
      accessKeyId: env.LEGACY_R2_ACCESS_KEY_ID!, secretAccessKey: env.LEGACY_R2_SECRET_ACCESS_KEY!,
      ...(env.LEGACY_R2_SESSION_TOKEN ? { sessionToken: env.LEGACY_R2_SESSION_TOKEN } : {}),
    },
    masterKey: decodeKey(env.LEGACY_MASTER_KEY!),
  };
}

/** Refuse anything but one read statement before it reaches the connection. */
function readStatement(sql: string): string {
  if (typeof sql !== "string" || !READ_STATEMENT.test(sql) || sql.includes(";") || ROW_LOCK.test(sql)) {
    throw new LegacyBindingError("legacy_source_read_only", "only single SELECT/SHOW statements reach the legacy source");
  }
  return sql;
}

/** Run `work`, ending the client if `signal` aborts first (pg has no per-query cancel). */
async function abortable<T>(client: PgClient, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      void client.end().catch(() => {});
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * One `REPEATABLE READ READ ONLY` checkpoint transaction on its own connection.
 * Only read statements pass; `close` rolls back and ends the connection.
 */
export async function openReadOnlyTx(connect: PgConnect, connectionString: string, signal: AbortSignal): Promise<ReadOnlyTx> {
  const client = connect(connectionString);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection may already be gone; ending it below is what matters.
    } finally {
      await client.end().catch(() => {});
    }
  };
  try {
    await abortable(client, signal, () => client.connect());
    await abortable(client, signal, () => client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"));
  } catch (e) {
    closed = true;
    await client.end().catch(() => {});
    throw e;
  }
  return {
    async query(sql, params, querySignal) {
      readStatement(sql);
      if (closed) throw new LegacySourceError("no_session", "the source transaction is closed");
      return (await abortable(client, querySignal, () => client.query(sql, params))).rows;
    },
    close,
  };
}

/** The backup hold's live expiry on a fresh connection (outside the checkpoint). */
export async function readHoldExpiry(connect: PgConnect, connectionString: string, hold: string, signal: AbortSignal): Promise<Date | null> {
  if (!UUID.test(hold)) throw new LegacySourceError("invalid_request", "the backup hold is not a canonical uuid");
  const tx = await openReadOnlyTx(connect, connectionString, signal);
  try {
    return holdRow(await tx.query(HOLD_EXPIRY, [hold], signal));
  } finally {
    await tx.close();
  }
}

/**
 * Hold re-checks on ONE reused connection, each in its own short READ ONLY
 * transaction (a fresh snapshot every time, never the checkpoint's). A fresh
 * connection per page/stream exhausted the Hyperdrive origin pool beside the
 * open checkpoint. Any failure drops the connection; the next check reconnects.
 */
export function holdReader(connect: PgConnect, connectionString: string): {
  read(hold: string, signal: AbortSignal): Promise<Date | null>; release(): Promise<void>;
} {
  let client: PgClient | null = null;
  let busy = false, released = false;
  const drop = async () => {
    const c = client;
    client = null;
    if (c) await c.end().catch(() => {});
  };
  return {
    async read(hold, signal) {
      if (!UUID.test(hold)) throw new LegacySourceError("invalid_request", "the backup hold is not a canonical uuid");
      if (busy) return readHoldExpiry(connect, connectionString, hold, signal);
      busy = true;
      released = false;
      try {
        if (!client) {
          const fresh = connect(connectionString);
          client = fresh;
          await abortable(fresh, signal, () => fresh.connect());
        }
        const live = client;
        await abortable(live, signal, () => live.query("BEGIN READ ONLY"));
        try {
          return holdRow((await abortable(live, signal, () => live.query(readStatement(HOLD_EXPIRY), [hold]))).rows);
        } finally {
          await abortable(live, signal, () => live.query("ROLLBACK"));
        }
      } catch (e) {
        await drop();
        throw e;
      } finally {
        busy = false;
        if (released) await drop();
      }
    },
    /** End the kept connection (no checkpoint is open); a later check reconnects. */
    async release() {
      released = true;
      if (!busy) await drop();
    },
  };
}

const HOLD_EXPIRY = "SELECT expires_at FROM hosted_provider_backup_holds WHERE id = $1::uuid";

function holdRow(rows: Row[]): Date | null {
  if (rows.length > 1) throw new LegacySourceError("source_shape", "backup hold id is not unique");
  const v = rows[0]?.expires_at;
  if (v === undefined || v === null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new LegacySourceError("source_shape", "backup hold expiry is not a timestamp");
  return d;
}

/**
 * Read-only legacy storage for one collection: S3 `GET` of its committed blob keys
 * only. The returned object has `get` and nothing else.
 */
export function legacyObjects(r2: LegacyR2Settings, collection: string, fetchImpl: typeof fetch = fetch): LegacyObjects {
  if (!UUID.test(collection)) throw new LegacyBindingError("legacy_source_foreign_collection", "the collection is not a canonical uuid");
  const aws = new AwsClient({
    accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey,
    ...(r2.sessionToken ? { sessionToken: r2.sessionToken } : {}),
    service: "s3", region: "auto",
  });
  const prefix = `v1/blobs/${collection}/`;
  return Object.freeze({
    async get(key: string, signal: AbortSignal) {
      if (typeof key !== "string" || !key.startsWith(prefix)) {
        throw new LegacyBindingError("legacy_source_foreign_collection", "the object is not one of this collection's blobs");
      }
      if (!COMMITTED_BLOB.test(key.slice(prefix.length))) throw new LegacySourceError("source_shape", "the object key is not a committed blob key");
      signal.throwIfAborted();
      const signed = await aws.sign(`${r2.endpoint}/${r2.bucket}/${key}`, { method: "GET" });
      const res = await fetchImpl(signed, { signal });
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        throw new LegacySourceError("object_unavailable", `legacy storage answered ${res.status}`);
      }
      const length = res.headers.get("content-length");
      const size = length !== null && /^\d{1,15}$/.test(length) ? Number(length) : NaN;
      if (!Number.isSafeInteger(size)) {
        await res.body.cancel();
        throw new LegacySourceError("object_mismatch", "legacy storage sent no object length");
      }
      return { body: res.body, size };
    },
  });
}

/** A legacy source that opens checkpoints of its one bound collection only. */
export class BoundLegacySource extends LegacySource {
  constructor(readonly collection: string, config: LegacySourceConfig) {
    super(config);
  }

  override async openCheckpoint(req: CheckpointRequest, signal: AbortSignal): Promise<Checkpoint> {
    if (req?.collection !== this.collection) {
      throw new LegacyBindingError("legacy_source_foreign_collection", "the source is bound to another collection");
    }
    return super.openCheckpoint(req, signal);
  }
}

export interface LegacySourceDeps {
  connect: PgConnect;
  fetch?: typeof fetch;
}

/**
 * The legacy source for `collection`, from this Worker's bindings. Refuses (typed)
 * when the bindings are missing or malformed, or when the collection is not in the
 * configured allowlist; nothing is connected or fetched before these checks pass.
 */
export async function openLegacySource(env: LegacySourceEnv, collection: string, deps: LegacySourceDeps): Promise<BoundLegacySource> {
  const settings = legacyBindingSettings(env);
  let unwrapper: LegacyUnwrapper;
  try {
    if (!settings.collections.includes(collection)) {
      throw new LegacyBindingError("legacy_source_foreign_collection", "the collection is not configured for this Worker");
    }
    const { kms: config, kmsCredentials } = settings;
    const kms = config && kmsCredentials ? new LegacyAwsKms(config, () => kmsCredentials, deps.fetch) : undefined;
    const legacyMasterKey = await crypto.subtle.importKey("raw", settings.masterKey, "AES-GCM", false, ["decrypt"]);
    unwrapper = { environment: settings.tier, legacyMasterKey, kms };
  } finally {
    settings.masterKey.fill(0);
  }
  const { connect } = deps;
  const hold = holdReader(connect, settings.connectionString);
  return new BoundLegacySource(collection, {
    openTx: (signal) => openReadOnlyTx(connect, settings.connectionString, signal),
    holdExpiry: hold.read,
    releaseHold: hold.release,
    objects: legacyObjects(settings.r2, collection, deps.fetch),
    unwrapper,
  });
}
