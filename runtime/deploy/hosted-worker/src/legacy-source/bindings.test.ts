// The Worker's legacy source bindings without a database: settings fail closed with
// typed errors that never echo values, the source is bound to its configured
// collection, storage is GET-only and collection-scoped, and the transaction
// adapter passes only single read statements. The real-Postgres half (the role's
// refusals and the bound source over it) is in source.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BoundLegacySource, LegacyBindingError, legacyBindingSettings, legacyObjects, openLegacySource, openReadOnlyTx,
  readHoldExpiry, holdReader, type LegacySourceEnv, type PgClient, type PgConnect,
} from "./bindings.ts";
import { LegacySourceError } from "./source.ts";
import { aad, LegacyCryptoError, unwrapCollectionKey } from "./crypto.ts";

const CID = "4c18af2e-b04a-4b77-b83e-493c3695962e";
const OTHER = "5d29bf3f-c15b-4c88-a94f-5a4d47a6a73f";
const BLOB = "0192f0c1-7e1a-7b3c-8d4e-000000000001";
const SECRET_KEY = "S3cr3tAccessKeyValue0123456789abcdef0123456789abcdef0123456789ab";
const MASTER = Buffer.alloc(32, 7).toString("base64url");
const CONN = "postgresql://hyperdrive-user:hyperdrive-password@hyperdrive.local:5432/legacy";

function env(over: Partial<LegacySourceEnv> = {}): LegacySourceEnv {
  return {
    LAB: "1", LEGACY_SOURCE_ENVIRONMENT: "lab", LEGACY_SOURCE_COLLECTIONS: `${CID}`,
    LEGACY_DB: { connectionString: CONN },
    LEGACY_R2_ENDPOINT: `https://${"0123456789abcdef".repeat(2)}.r2.cloudflarestorage.com`,
    LEGACY_R2_BUCKET: "mdbase-connect-lab-files",
    LEGACY_R2_ACCESS_KEY_ID: "0123456789abcdef0123456789abcdef", LEGACY_R2_SECRET_ACCESS_KEY: SECRET_KEY,
    LEGACY_MASTER_KEY: MASTER,
    ...over,
  };
}

const binding = (code: string) => (e: unknown) => e instanceof LegacyBindingError && e.code === code;
const signal = () => AbortSignal.timeout(5000);

/** A fake pg client recording every statement it receives. */
function fakePg(rows: (sql: string) => Record<string, unknown>[] = () => []) {
  const seen: string[] = [];
  let connects = 0;
  let ends = 0;
  const connect: PgConnect = () => ({
    async connect() { connects++; },
    async query(sql: string) { seen.push(sql); return { rows: rows(sql) }; },
    async end() { ends++; },
  } satisfies PgClient);
  return { connect, seen, counts: () => ({ connects, ends }) };
}

test("missing bindings fail closed with a typed error naming only the settings", () => {
  for (const name of ["LEGACY_SOURCE_ENVIRONMENT", "LEGACY_SOURCE_COLLECTIONS", "LEGACY_DB", "LEGACY_R2_ENDPOINT",
    "LEGACY_R2_BUCKET", "LEGACY_R2_ACCESS_KEY_ID", "LEGACY_R2_SECRET_ACCESS_KEY", "LEGACY_MASTER_KEY"] as const) {
    assert.throws(() => legacyBindingSettings(env({ [name]: undefined })),
      (e: unknown) => binding("legacy_source_unconfigured")(e) && (e as Error).message.includes(name), name);
  }
  assert.throws(() => legacyBindingSettings({}), binding("legacy_source_unconfigured"));
  // Outside LAB nothing is configured, whatever else is set.
  assert.throws(() => legacyBindingSettings(env({ LAB: undefined })), binding("legacy_source_unconfigured"));
  assert.throws(() => legacyBindingSettings(env({ LAB: "0" })), binding("legacy_source_unconfigured"));
});

test("admission matrix: LAB or staging only, production refused before any other setting", async () => {
  const staging = (over: Partial<LegacySourceEnv> = {}) =>
    env({ LAB: undefined, KMS_ENVIRONMENT: "staging", LEGACY_SOURCE_ENVIRONMENT: "staging", ...over });
  // Admitted: [env, tier].
  const admitted: Array<[LegacySourceEnv, string]> = [
    [env(), "lab"],
    [env({ KMS_ENVIRONMENT: "lab" }), "lab"],
    [env({ KMS_ENVIRONMENT: "" }), "lab"],
    [staging(), "staging"],
    [staging({ LAB: "0" }), "staging"],
  ];
  for (const [e, tier] of admitted) assert.equal(legacyBindingSettings(e).tier, tier, JSON.stringify([e.LAB, e.KMS_ENVIRONMENT]));
  // Refused: [env, code, the setting the message names].
  const refused: Array<[LegacySourceEnv, string, string]> = [
    [env({ KMS_ENVIRONMENT: "production" }), "legacy_source_unconfigured", "production"],
    [staging({ KMS_ENVIRONMENT: "production" }), "legacy_source_unconfigured", "production"],
    [env({ KMS_ENVIRONMENT: "production", LEGACY_SOURCE_ENVIRONMENT: "production" }), "legacy_source_unconfigured", "KMS_ENVIRONMENT"],
    [{ KMS_ENVIRONMENT: "production" }, "legacy_source_unconfigured", "production"],
    [env({ KMS_ENVIRONMENT: "staging" }), "legacy_source_misconfigured", "KMS_ENVIRONMENT"],
    [env({ LAB: undefined }), "legacy_source_unconfigured", "KMS_ENVIRONMENT"],
    [env({ LAB: undefined, KMS_ENVIRONMENT: "lab" }), "legacy_source_unconfigured", "LAB"],
    [env({ LAB: undefined, KMS_ENVIRONMENT: "Staging" }), "legacy_source_unconfigured", "KMS_ENVIRONMENT"],
    [staging({ LEGACY_SOURCE_ENVIRONMENT: "lab" }), "legacy_source_misconfigured", "LEGACY_SOURCE_ENVIRONMENT"],
    [staging({ LEGACY_SOURCE_ENVIRONMENT: "production" }), "legacy_source_misconfigured", "LEGACY_SOURCE_ENVIRONMENT"],
    [staging({ LEGACY_SOURCE_ENVIRONMENT: undefined }), "legacy_source_unconfigured", "LEGACY_SOURCE_ENVIRONMENT"],
    [staging({ LEGACY_MASTER_KEY: undefined }), "legacy_source_unconfigured", "LEGACY_MASTER_KEY"],
    [env({ LEGACY_SOURCE_ENVIRONMENT: "staging" }), "legacy_source_misconfigured", "LEGACY_SOURCE_ENVIRONMENT"],
  ];
  for (const [e, code, name] of refused) {
    assert.throws(() => legacyBindingSettings(e), (err: unknown) => binding(code)(err) && (err as Error).message.includes(name)
      && !(err as Error).message.includes(SECRET_KEY) && !(err as Error).message.includes(MASTER), `${code} ${name}`);
  }
  // Nothing connects for a refused tier; staging opens a bound source with its allowlist.
  const pg = fakePg();
  await assert.rejects(openLegacySource(staging({ KMS_ENVIRONMENT: "production" }), CID, { connect: pg.connect }), binding("legacy_source_unconfigured"));
  await assert.rejects(openLegacySource(staging(), OTHER, { connect: pg.connect }), binding("legacy_source_foreign_collection"));
  assert.ok(await openLegacySource(staging(), CID, { connect: pg.connect }) instanceof BoundLegacySource);
  assert.deepEqual(pg.counts(), { connects: 0, ends: 0 });
});

test("staging unwraps legacy-key collection keys only; a KMS-wrapped key is refused, never sent anywhere", async () => {
  const master = await crypto.subtle.importKey("raw", Buffer.alloc(32, 7), "AES-GCM", false, ["encrypt", "decrypt"]);
  const raw = new Uint8Array(32).fill(9), iv = new Uint8Array(12).fill(1);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad.collectionKey(CID) }, master, raw));
  const legacyWrapped = new Uint8Array([1, ...iv, ...ct]);
  const decryptOnly = await crypto.subtle.importKey("raw", Buffer.alloc(32, 7), "AES-GCM", false, ["decrypt"]);
  const unwrapper = { environment: "staging", legacyMasterKey: decryptOnly };
  const key = await unwrapCollectionKey(unwrapper, legacyWrapped, CID, signal());
  assert.equal(key.extractable, false);
  const keyRef = new TextEncoder().encode("arn:aws:kms:ap-southeast-1:000000000000:key/mrk-0123");
  const kmsWrapped = new Uint8Array([0x4d, 0x44, 0x42, 0x4b, 1, 1, 0, keyRef.length, 0, 0, 0, 4, ...keyRef, 1, 2, 3, 4]);
  await assert.rejects(unwrapCollectionKey(unwrapper, kmsWrapped, CID, signal()),
    (e: unknown) => e instanceof LegacyCryptoError && e.code === "kms" && /not supported by this legacy source/.test(e.message));
});

test("misconfigured bindings fail closed and never echo a value", () => {
  const cases: Array<[Partial<LegacySourceEnv>, string]> = [
    [{ LEGACY_SOURCE_ENVIRONMENT: "production" }, "LEGACY_SOURCE_ENVIRONMENT"],
    [{ LEGACY_SOURCE_COLLECTIONS: "not-a-uuid" }, "LEGACY_SOURCE_COLLECTIONS"],
    [{ LEGACY_SOURCE_COLLECTIONS: CID.toUpperCase() }, "LEGACY_SOURCE_COLLECTIONS"],
    [{ LEGACY_SOURCE_COLLECTIONS: `${CID},${CID}` }, "LEGACY_SOURCE_COLLECTIONS"],
    [{ LEGACY_SOURCE_COLLECTIONS: "00000000-0000-0000-0000-000000000000" }, "LEGACY_SOURCE_COLLECTIONS"],
    [{ LEGACY_SOURCE_COLLECTIONS: Array.from({ length: 17 }, (_, i) => `${CID.slice(0, -2)}${String(i).padStart(2, "0")}`).join(",") }, "LEGACY_SOURCE_COLLECTIONS"],
    [{ LEGACY_DB: {} }, "LEGACY_DB"],
    [{ LEGACY_DB: { connectionString: 42 } }, "LEGACY_DB"],
    [{ LEGACY_DB: { connectionString: "mysql://x" } }, "LEGACY_DB"],
    [{ LEGACY_R2_ENDPOINT: "http://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com" }, "LEGACY_R2_ENDPOINT"],
    [{ LEGACY_R2_ENDPOINT: "https://evil.example/0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com" }, "LEGACY_R2_ENDPOINT"],
    [{ LEGACY_R2_ENDPOINT: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/" }, "LEGACY_R2_ENDPOINT"],
    [{ LEGACY_R2_BUCKET: "../other" }, "LEGACY_R2_BUCKET"],
    [{ LEGACY_R2_SECRET_ACCESS_KEY: "short" }, "LEGACY_R2_SECRET_ACCESS_KEY"],
    [{ LEGACY_R2_SESSION_TOKEN: "has spaces in it and more" }, "LEGACY_R2_SESSION_TOKEN"],
    [{ LEGACY_MASTER_KEY: Buffer.alloc(31, 7).toString("base64") }, "LEGACY_MASTER_KEY"],
    [{ LEGACY_MASTER_KEY: Buffer.alloc(33, 7).toString("base64") }, "LEGACY_MASTER_KEY"],
    [{ LEGACY_MASTER_KEY: "not base64 at all!" }, "LEGACY_MASTER_KEY"],
  ];
  for (const [over, name] of cases) {
    assert.throws(() => legacyBindingSettings(env(over)), (e: unknown) => {
      const m = (e as Error).message;
      return binding("legacy_source_misconfigured")(e) && m.includes(name)
        && !m.includes(SECRET_KEY) && !m.includes("hyperdrive-password") && !m.includes(String(Object.values(over)[0]));
    }, name);
  }
  // Both base64 alphabets of a 32-byte key are accepted (the provider accepts both).
  for (const k of [Buffer.alloc(32, 250).toString("base64"), Buffer.alloc(32, 250).toString("base64url")]) {
    assert.equal(legacyBindingSettings(env({ LEGACY_MASTER_KEY: k })).masterKey.length, 32);
  }
});

test("a foreign collection never opens: not configured, or not the bound one; nothing connects", async () => {
  const pg = fakePg();
  await assert.rejects(openLegacySource(env(), OTHER, { connect: pg.connect }), binding("legacy_source_foreign_collection"));
  await assert.rejects(openLegacySource(env({ LEGACY_MASTER_KEY: undefined }), CID, { connect: pg.connect }),
    binding("legacy_source_unconfigured"));
  const src = await openLegacySource(env({ LEGACY_SOURCE_COLLECTIONS: `${CID},${OTHER}` }), CID, { connect: pg.connect });
  assert.ok(src instanceof BoundLegacySource);
  await assert.rejects(src.openCheckpoint({
    collection: OTHER, S0: 1, expectedState: "active", backupHold: BLOB, retainUntil: "2027-01-01T00:00:00Z",
  }, signal()), binding("legacy_source_foreign_collection"));
  assert.deepEqual(pg.counts(), { connects: 0, ends: 0 });
});

test("storage is GET-only, signed, and scoped to the collection's committed blob keys", async () => {
  const requests: Request[] = [];
  const fetchImpl = (async (r: Request) => {
    requests.push(r);
    if (r.url.endsWith("missing")) return new Response(null, { status: 404 });
    if (r.url.includes(OTHER)) return new Response("nope", { status: 403 });
    return new Response("bytes!", { status: 200, headers: { "content-length": "6" } });
  }) as typeof fetch;
  const settings = legacyBindingSettings(env({ LEGACY_R2_SESSION_TOKEN: "temporary-session-token-0123456789" }));
  const objects = legacyObjects(settings.r2, CID, fetchImpl);
  assert.deepEqual(Object.keys(objects), ["get"], "no write, delete or list surface");
  assert.ok(Object.isFrozen(objects));

  const got = await objects.get(`v1/blobs/${CID}/${BLOB}`, signal());
  assert.equal(got?.size, 6);
  // A re-attempted completion commits `<transfer>.<attempt>`.
  const attempt = await objects.get(`v1/blobs/${CID}/${BLOB}.01a14188-0c3e-7000-8000-00000000000a`, signal());
  assert.equal(attempt?.size, 6);
  await attempt!.body.cancel();
  assert.equal(await new Response(got!.body).text(), "bytes!");
  const r = requests[0];
  assert.equal(r.method, "GET");
  assert.equal(r.url, `${settings.r2.endpoint}/mdbase-connect-lab-files/v1/blobs/${CID}/${BLOB}`);
  assert.match(r.headers.get("authorization") ?? "", /^AWS4-HMAC-SHA256 Credential=0123456789abcdef0123456789abcdef\//);
  assert.equal(r.headers.get("x-amz-security-token"), "temporary-session-token-0123456789");

  for (const key of [`v1/blobs/${OTHER}/${BLOB}`, `v1/staging/${CID}/${BLOB}`, `v1/blobs/${CID}`, "r2/obj-1",
    `v1/blobs/${CID.toUpperCase()}/${BLOB}`, `../v1/blobs/${CID}/${BLOB}`]) {
    await assert.rejects(objects.get(key, signal()), binding("legacy_source_foreign_collection"), key);
  }
  for (const key of [`v1/blobs/${CID}/${BLOB}/../../${OTHER}/${BLOB}`, `v1/blobs/${CID}/x`, `v1/blobs/${CID}/${BLOB}?x-id=PutObject`,
    `v1/blobs/${CID}/${BLOB}.`, `v1/blobs/${CID}/${BLOB}.x`, `v1/blobs/${CID}/${BLOB}.${OTHER}.${OTHER}`]) {
    await assert.rejects(objects.get(key, signal()), (e: unknown) => e instanceof LegacySourceError && e.code === "source_shape", key);
  }
  assert.equal(requests.length, 2, "refused keys are never fetched");
  assert.throws(() => legacyObjects(settings.r2, "not-a-uuid", fetchImpl), binding("legacy_source_foreign_collection"));
});

test("storage refusals: a denied or length-less answer is an error, a missing object is null", async () => {
  const settings = legacyBindingSettings(env());
  const answer = (res: () => Response) => legacyObjects(settings.r2, CID, (async () => res()) as typeof fetch);
  assert.equal(await answer(() => new Response(null, { status: 404 })).get(`v1/blobs/${CID}/${BLOB}`, signal()), null);
  await assert.rejects(answer(() => new Response("denied", { status: 403 })).get(`v1/blobs/${CID}/${BLOB}`, signal()),
    (e: unknown) => e instanceof LegacySourceError && e.code === "object_unavailable");
  await assert.rejects(answer(() => new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200 }))
    .get(`v1/blobs/${CID}/${BLOB}`, signal()), (e: unknown) => e instanceof LegacySourceError && e.code === "object_mismatch");
});

test("the transaction adapter opens REPEATABLE READ READ ONLY and passes only single read statements", async () => {
  const pg = fakePg((sql) => (sql.startsWith("SELECT expires_at") ? [{ expires_at: new Date("2030-01-01T00:00:00Z") }] : []));
  const tx = await openReadOnlyTx(pg.connect, CONN, signal());
  assert.deepEqual(pg.seen, ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"]);
  for (const sql of [
    "INSERT INTO hosted_provider_backup_holds DEFAULT VALUES",
    "  update hosted_provider_collections set head = 0",
    "DELETE FROM hosted_provider_records",
    "WITH d AS (DELETE FROM hosted_provider_records RETURNING 1) SELECT * FROM d",
    "SELECT 1; DROP TABLE hosted_provider_records",
    "SELECT id FROM hosted_provider_collections FOR UPDATE",
    "SELECT id FROM hosted_provider_collections FOR NO KEY UPDATE",
    "SET default_transaction_read_only = off",
    "COMMIT",
    "BEGIN READ WRITE",
    "COPY hosted_provider_records TO STDOUT",
    "SELECTX 1",
  ]) {
    await assert.rejects(tx.query(sql, [], signal()), binding("legacy_source_read_only"), sql);
  }
  await tx.query("SELECT 1", [], signal());
  await tx.query("show transaction_isolation", [], signal());
  assert.deepEqual(pg.seen.slice(1), ["SELECT 1", "show transaction_isolation"], "refused statements never reach the connection");
  await tx.close();
  await tx.close();
  assert.equal(pg.seen.at(-1), "ROLLBACK");
  assert.deepEqual(pg.counts(), { connects: 1, ends: 1 });
  await assert.rejects(tx.query("SELECT 1", [], signal()), (e: unknown) => e instanceof LegacySourceError && e.code === "no_session");

  const exp = await readHoldExpiry(pg.connect, CONN, BLOB, signal());
  assert.equal(exp?.toISOString(), "2030-01-01T00:00:00.000Z");
  await assert.rejects(readHoldExpiry(pg.connect, CONN, "x; DROP TABLE y", signal()),
    (e: unknown) => e instanceof LegacySourceError && e.code === "invalid_request");
});

test("hold re-checks reuse one connection, each in a fresh READ ONLY transaction; a failure reconnects", async () => {
  let fail = false;
  const pg = fakePg((sql) => {
    if (fail && sql.startsWith("SELECT expires_at")) { fail = false; throw new Error("gone"); }
    return sql.startsWith("SELECT expires_at") ? [{ expires_at: new Date("2030-01-01T00:00:00Z") }] : [];
  });
  const { read, release } = holdReader(pg.connect, CONN);
  for (let i = 0; i < 5; i++) assert.equal((await read(BLOB, signal()))?.toISOString(), "2030-01-01T00:00:00.000Z");
  assert.deepEqual(pg.counts(), { connects: 1, ends: 0 }, "one connection for every check");
  assert.deepEqual(pg.seen.slice(0, 3), ["BEGIN READ ONLY", "SELECT expires_at FROM hosted_provider_backup_holds WHERE id = $1::uuid", "ROLLBACK"]);
  fail = true;
  await assert.rejects(read(BLOB, signal()), /gone/);
  assert.deepEqual(pg.counts(), { connects: 1, ends: 1 });
  assert.ok(await read(BLOB, signal()));
  assert.deepEqual(pg.counts(), { connects: 2, ends: 1 });
  await assert.rejects(read("x; DROP TABLE y", signal()), (e: unknown) => e instanceof LegacySourceError && e.code === "invalid_request");
  await release();
  assert.deepEqual(pg.counts(), { connects: 2, ends: 2 }, "release ends the kept connection");
  await release();
  assert.deepEqual(pg.counts(), { connects: 2, ends: 2 });
});

test("an aborted connect or query ends the connection", async () => {
  let ends = 0;
  const hanging: PgConnect = () => ({
    connect: () => new Promise(() => {}),
    async query() { return { rows: [] }; },
    async end() { ends++; },
  });
  const ac = new AbortController();
  const opening = openReadOnlyTx(hanging, CONN, ac.signal);
  ac.abort(new Error("stop"));
  await assert.rejects(opening, /stop/);
  assert.ok(ends >= 1);
});
