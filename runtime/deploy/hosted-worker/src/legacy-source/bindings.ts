/**
 * The Worker's **legacy source bindings**: how a LAB or staging hosted Worker reaches the
 * data it migrates from, read-only, for exactly the collections it is configured
 * for. Builds the `LegacySourceConfig` that `source.ts` reads through.
 *
 * - **Postgres:** a Hyperdrive binding (`LEGACY_DB`) whose origin user is the
 *   SELECT-only `mdbn_hosted_legacy_reader` role (`sql/legacy-reader-role.sql`:
 *   column-level SELECT on the reader's columns only). Every connection opens one
 *   `REPEATABLE READ READ ONLY` transaction, and this adapter passes only single
 *   `SELECT`/`SHOW` statements to it. `source.ts` then refuses any role that could
 *   write. Three independent refusals: the adapter, the transaction, the role.
 * - **Storage:** the legacy R2 bucket over the S3 API with object-read-only
 *   credentials (an R2 binding cannot be read-only, and the bucket may live in
 *   another account). Only `GET` is ever sent, and only for this collection's
 *   committed blob keys (`v1/blobs/<collection>/<transfer>[.<attempt>]`).
 * - **Unwrap:** the provider's legacy master key (`LEGACY_MASTER_KEY`, base64 of 32
 *   bytes), imported non-extractable for `decrypt` and wiped. This is the only
 *   supported wrapping: the LAB provider wraps with its legacy key (environment
 *   `local`); a staging collection key in that form unwraps the same way. A KMS
 *   (`MDBK`) wrapped key is refused (`kms`, "KMS-wrapped collection keys are not
 *   supported by this legacy source"): no KMS unwrap path is configured here.
 * - **Admission:** LAB (`LAB` = "1", `LEGACY_SOURCE_ENVIRONMENT` = "lab",
 *   `KMS_ENVIRONMENT` unset or "lab") or staging (`KMS_ENVIRONMENT` = "staging",
 *   `LEGACY_SOURCE_ENVIRONMENT` = "staging", `LAB` not "1"). Production
 *   (`KMS_ENVIRONMENT` = "production") and every other combination are refused.
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
 * (temporary credentials only), `LEGACY_MASTER_KEY`.
 */
import { AwsClient } from "aws4fetch";
import type { LegacyUnwrapper } from "./crypto.ts";
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

/** Where the legacy source is admitted (production never is). */
export type LegacySourceTier = "lab" | "staging";

export interface LegacyBindingSettings {
  tier: LegacySourceTier;
  collections: string[];
  connectionString: string;
  r2: LegacyR2Settings;
  /** Raw legacy master key; the caller imports it and wipes this copy. */
  masterKey: Uint8Array;
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
 * setting is read. Production is refused outright; staging needs the staging KMS
 * environment and no LAB flag; LAB needs `LAB=1` and no other KMS environment.
 */
function admissionTier(env: LegacySourceEnv): LegacySourceTier {
  const kms = env.KMS_ENVIRONMENT;
  if (kms === "production") {
    throw new LegacyBindingError("legacy_source_unconfigured", "legacy source bindings are refused in production (KMS_ENVIRONMENT)");
  }
  if (env.LAB === "1") {
    if (kms !== undefined && kms !== "" && kms !== "lab") throw misconfigured("KMS_ENVIRONMENT");
    return "lab";
  }
  if (kms === "staging") return "staging";
  throw new LegacyBindingError("legacy_source_unconfigured", "legacy source bindings are LAB- or staging-only (LAB, KMS_ENVIRONMENT)");
}

/** Parse and check every setting; refuse (typed) on anything missing or malformed. */
export function legacyBindingSettings(env: LegacySourceEnv): LegacyBindingSettings {
  const tier = admissionTier(env);
  const required = {
    LEGACY_SOURCE_ENVIRONMENT: env.LEGACY_SOURCE_ENVIRONMENT,
    LEGACY_SOURCE_COLLECTIONS: env.LEGACY_SOURCE_COLLECTIONS,
    LEGACY_DB: env.LEGACY_DB,
    LEGACY_R2_ENDPOINT: env.LEGACY_R2_ENDPOINT,
    LEGACY_R2_BUCKET: env.LEGACY_R2_BUCKET,
    LEGACY_R2_ACCESS_KEY_ID: env.LEGACY_R2_ACCESS_KEY_ID,
    LEGACY_R2_SECRET_ACCESS_KEY: env.LEGACY_R2_SECRET_ACCESS_KEY,
    LEGACY_MASTER_KEY: env.LEGACY_MASTER_KEY,
  };
  const missing = Object.entries(required).filter(([, v]) => v === undefined || v === null || v === "").map(([k]) => k);
  if (missing.length) {
    throw new LegacyBindingError("legacy_source_unconfigured", `legacy source bindings missing: ${missing.join(", ")}`);
  }
  if (env.LEGACY_SOURCE_ENVIRONMENT !== tier) throw misconfigured("LEGACY_SOURCE_ENVIRONMENT");
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
  return {
    tier,
    collections,
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
  let legacyMasterKey: CryptoKey;
  try {
    if (!settings.collections.includes(collection)) {
      throw new LegacyBindingError("legacy_source_foreign_collection", "the collection is not configured for this Worker");
    }
    legacyMasterKey = await crypto.subtle.importKey("raw", settings.masterKey, "AES-GCM", false, ["decrypt"]);
  } finally {
    settings.masterKey.fill(0);
  }
  const { connect } = deps;
  // Legacy-key wrapping only; no `kms` here, so an MDBK row refuses (crypto.ts).
  const unwrapper: LegacyUnwrapper = { environment: settings.tier === "lab" ? "local" : "staging", legacyMasterKey };
  const hold = holdReader(connect, settings.connectionString);
  return new BoundLegacySource(collection, {
    openTx: (signal) => openReadOnlyTx(connect, settings.connectionString, signal),
    holdExpiry: hold.read,
    releaseHold: hold.release,
    objects: legacyObjects(settings.r2, collection, deps.fetch),
    unwrapper,
  });
}
