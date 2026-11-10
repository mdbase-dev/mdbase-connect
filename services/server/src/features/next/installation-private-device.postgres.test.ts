// An application's installation as a device of a Private collection
// (docs/installation-private-device.md): the routes that admit its credential,
// the consent each one needs, and the routes that keep refusing it.
import { ensureDevelopmentEntitlement } from "../account/entitlements.js";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { createDatabase, type DatabasePool } from "../../db.js";
import { randomToken, tokenHash } from "../../security.js";
import { registerErrorHandler } from "../../platform/error-handler.js";
import { removeInstallationAccess } from "../connectors/installation-pairing.js";
import { accountKeyFetchDigest, registerAccountKeyRoutes } from "./account-keys.js";
import { registerApprovalPeerRoutes } from "./approval-peer-routes.js";
import { registerCloudCopyRoutes } from "./cloud-copy-bootstrap.js";
import { collectionLogTokenDigest, registerCollectionLogTokenRoute } from "./collection-log-token.js";
import { deviceRegistrationDigest, issueDeviceChallenge, registerDevice } from "./devices.js";
import { LogServiceClient } from "./log-service-client.js";
import { certToJson, ed25519RawPublicKey, loadPolicySigner, parseNextControlPlaneEnv, type NextControlPlaneConfig } from "./policy-keys.js";
import { PolicyEmitter, queueNextPolicy } from "./policy-outbox.js";
import { certDigest, chainHash, decodeCbor, encodeCbor, keyId, type Cbor, type Decoded, type PolicyOp } from "./policy-wire.js";
import { privateCreateDigest, privateDeviceEnrolDigest, registerPrivateCollectionRoutes } from "./private-collections.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const field = (value: Decoded, key: number) => value instanceof Map ? value.get(key) : undefined;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const rawX = () => (generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);

describe("private app devices switch configuration", () => {
  const base = {
    MDBASE_NEXT_CONTROL_PLANE: "1", MDBASE_NEXT_ROOT_PUBLIC_KEY: "00".repeat(32), MDBASE_NEXT_POLICY_SIGNING_KEY: "pem", MDBASE_NEXT_POLICY_KEY_CERT: "{}",
    MDBASE_NEXT_LOG_SERVICE_URL: "https://log.example", MDBASE_NEXT_LOG_TOKEN_SIGNING_KEY: "pem", MDBASE_NEXT_LOG_TRANSPORT_KEY: "pem"
  };
  it("is off unless switched on with the private bootstrap", () => {
    // The private bootstrap alone, which staging and production already run, does not turn it on.
    expect(parseNextControlPlaneEnv(base)?.privateAppDevices).toBeUndefined();
    expect(parseNextControlPlaneEnv({ ...base, MDBASE_NEXT_PRIVATE_BOOTSTRAP: "1" })?.privateAppDevices).toBeUndefined();
    for (const off of ["", " ", "0"]) expect(parseNextControlPlaneEnv({ ...base, MDBASE_NEXT_PRIVATE_BOOTSTRAP: "1", MDBASE_NEXT_PRIVATE_APP_DEVICES: off })?.privateAppDevices).toBeUndefined();
    expect(parseNextControlPlaneEnv({ ...base, MDBASE_NEXT_PRIVATE_APP_DEVICES: "0" })?.privateAppDevices).toBeUndefined();
    expect(parseNextControlPlaneEnv({ ...base, MDBASE_NEXT_PRIVATE_BOOTSTRAP: "1", MDBASE_NEXT_PRIVATE_APP_DEVICES: " 1 " })).toMatchObject({ privateBootstrap: true, privateAppDevices: true });
  });
  it("refuses to start with a value that is not 0 or 1, or without the private bootstrap", () => {
    for (const bad of ["true", "yes", "on", "2", "5cdfa020-c201-4da8-845a-f2cc9969eade"]) {
      expect(() => parseNextControlPlaneEnv({ ...base, MDBASE_NEXT_PRIVATE_BOOTSTRAP: "1", MDBASE_NEXT_PRIVATE_APP_DEVICES: bad })).toThrow(/MDBASE_NEXT_PRIVATE_APP_DEVICES must be 0 or 1/);
    }
    expect(() => parseNextControlPlaneEnv({ ...base, MDBASE_NEXT_PRIVATE_APP_DEVICES: "1" })).toThrow(/MDBASE_NEXT_PRIVATE_APP_DEVICES=1 requires MDBASE_NEXT_PRIVATE_BOOTSTRAP=1/);
    expect(() => parseNextControlPlaneEnv({ ...base, MDBASE_NEXT_PRIVATE_BOOTSTRAP: "0", MDBASE_NEXT_PRIVATE_APP_DEVICES: "1" })).toThrow(/MDBASE_NEXT_PRIVATE_APP_DEVICES=1 requires MDBASE_NEXT_PRIVATE_BOOTSTRAP=1/);
  });
  it("refuses to start switched on when the account-key routes cannot be served", async () => {
    const db = await createDatabase("memory");
    const next: NextControlPlaneConfig = { ...configuration(), privateAppDevices: true };
    try {
      await expect(buildApp({ db, nextControlPlane: next })).rejects.toThrow(/MDBASE_NEXT_PRIVATE_APP_DEVICES=1 requires MDBASE_CONNECT_AUTH_RATE_LIMIT_SECRET/);
      // Off, the secret is not required for this feature.
      await (await buildApp({ db, nextControlPlane: configuration() })).app.close();
      const { app } = await buildApp({ db, nextControlPlane: next, authRateLimitSecret: "s".repeat(32) });
      try {
        // Mounted: an unauthenticated caller is refused, not told the route is missing.
        expect((await app.inject({ method: "GET", url: "/v1/next/account-key/status" })).statusCode).toBe(401);
      } finally { await app.close(); }
    } finally { await db.end(); }
  });
});

function configuration(): NextControlPlaneConfig {
  const root = generateKeyPairSync("ed25519").privateKey;
  const policy = generateKeyPairSync("ed25519").privateKey;
  const cert = { policyPublicKey: ed25519RawPublicKey(policy), notBefore: Date.now() - 60_000, notAfter: Date.now() + 30 * 86_400_000, root: keyId(ed25519RawPublicKey(root)) };
  const pem = (key: typeof root) => key.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    rootPublicKey: ed25519RawPublicKey(root), policyPrivateKeyPem: pem(policy), policyCert: certToJson({ ...cert, signature: sign(null, certDigest(cert), root) }),
    serviceTokens: {}, privateBootstrap: true,
    // The installation's list route is mounted with the cloud-copy routes; nothing here creates a cloud copy.
    cloudCopyBootstrap: { hosted: { url: "https://hosted.test", token: "hosted-out" }, escrow: { url: "https://escrow.test", token: "escrow-out" } },
    logService: { url: "http://log.test", tokenIssuerKeyPem: pem(generateKeyPairSync("ed25519").privateKey), transportKeyPem: pem(generateKeyPairSync("ed25519").privateKey) }
  };
}

/** The log service: control items per collection, with create, append, head and read. */
class Log {
  readonly logs = new Map<string, Buffer[]>();
  readonly fetch: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/v1/nonce")) return new Response("ab".repeat(32));
    const frame = decodeCbor(Buffer.from(init!.body as Uint8Array));
    const method = field(frame, 2);
    const params = field(frame, 3)!;
    const id = hex(field(params, 0) as Uint8Array);
    const items = this.logs.get(id);
    const chain = () => chainHash(items![items!.length - 1]!);
    let result: Cbor;
    if (method === "create_log") {
      if (!items) this.logs.set(id, [Buffer.from(field(params, 1) as Uint8Array)]);
      result = { struct: [[0, 1], [1, chainHash(this.logs.get(id)![0]!)]] };
    } else if (method === "head") {
      result = { struct: [[0, items!.length], [1, chain()], [2, 1]] };
    } else if (method === "append") {
      const expect = field(params, 1) as number;
      const prev = Buffer.from(field(params, 2) as Uint8Array);
      if (expect !== items!.length + 1 || !prev.equals(Buffer.from(chain()))) {
        result = { struct: [[0, 1], [1, items!.length], [2, chain()]] };
      } else {
        items!.push(...(field(params, 3) as Uint8Array[]).map((b) => Buffer.from(b)));
        result = { struct: [[0, 0], [1, expect], [2, items!.length]] };
      }
    } else if (method === "read") {
      if (!items) return new Response(encodeCbor({ struct: [[0, 1], [1, 1], [3, { struct: [[0, "not_found"]] }]] }));
      const after = field(params, 1) as number;
      const limit = field(params, 2) as number;
      result = { struct: [[0, items.slice(after, after + limit).map((item, i) => [after + i + 1, item])]] };
    } else throw new Error("unexpected log operation");
    return new Response(encodeCbor({ struct: [[0, 1], [1, 1], [2, result]] }), { headers: { "content-type": "application/vnd.mdbase.v1+cbor" } });
  };
}

describePg("installation Private device access", () => {
  let db: DatabasePool;
  let admin: pg.Pool;
  let schema: string;
  let emitter: PolicyEmitter;
  /** A registered application, and the operator configuration with the switch on (`config`) and off (`base`). */
  const application = randomUUID();
  const base = configuration();
  const config: NextControlPlaneConfig = { ...base, privateAppDevices: true };
  /** The operator turns the switch off on the running `app` server, then on again. */
  async function switchedOff<T>(run: () => Promise<T>): Promise<T> {
    delete config.privateAppDevices;
    try { return await run(); } finally { config.privateAppDevices = true; }
  }
  const log = new Log();
  const client = new LogServiceClient(config.logService, log.fetch);
  /** `app`: the switch is on. `off`: the same server with it off (the private bootstrap still on). */
  const app = Fastify(), off = Fastify();

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Private device tests require dedicated local test Postgres.");
    schema = `private_device_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    emitter = new PolicyEmitter(db, client, loadPolicySigner(config, Date.now()));
    for (const [server, next] of [[app, config], [off, base]] as [FastifyInstance, NextControlPlaneConfig][]) {
      await server.register(cookie);
      registerErrorHandler(server);
      registerCloudCopyRoutes(server, { db, next, emitter, log: client });
      registerPrivateCollectionRoutes(server, { db, next, emitter, log: client });
      registerAccountKeyRoutes(server, { db, next, emitter, log: client, rateLimitSecret: "private-device-test-rate-limit-secret-32-bytes" });
      registerCollectionLogTokenRoute(server, { db, log: client, privateDevice: next });
      registerApprovalPeerRoutes(server, db);
    }
    const web = `https://app-${application}.example.test`;
    await db.query("INSERT INTO applications(id,canonical_identity,family_identity,name,homepage,redirect_uris,installation_origins) VALUES($1,$2,$3,'Independent Notes',$4,'[]',$5)",
      [application, randomUUID(), `bundle:test.${application}`, web, JSON.stringify({ lab: { "app-runtime": [web] } })]);
  }, 60_000);
  afterAll(async () => {
    await app.close(); await off.close(); await emitter?.close(); await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  /** An ordinary daemon: its own connector and registered desktop device. */
  async function identity(user = randomUUID()) {
    const connector = { id: randomUUID(), user_id: user };
    const token = randomUUID();
    const device = randomUUID();
    const key = generateKeyPairSync("ed25519").privateKey;
    const signPk = ed25519RawPublicKey(key);
    const kemPk = rawX(); const noisePk = rawX();
    await db.query("INSERT INTO users(id,email,name,account_backend) VALUES($1,$2,'Owner','next') ON CONFLICT DO NOTHING", [user, `${user}@example.test`]);
    await ensureDevelopmentEntitlement(db, user);
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Daemon',$3)", [connector.id, user, tokenHash(token)]);
    const registration = await issueDeviceChallenge(db, connector.id);
    await registerDevice(db, connector, {
      device_id: device, kind: "desktop", sign_pk: hex(signPk), kem_pk: hex(kemPk), noise_pk: hex(noisePk), challenge: registration.challenge,
      sig: hex(sign(null, deviceRegistrationDigest({ challenge: Buffer.from(registration.challenge, "hex"), connectorId: connector.id, deviceId: device, signPk, kemPk, noisePk }), key))
    }, tokenHash(token));
    return { connector, device, key, headers: { authorization: `Bearer ${token}` } };
  }
  type Who = Awaited<ReturnType<typeof identity>>;
  /** A paired installation of the application: its own connector, app-runtime device and dedicated credential, and no scope. */
  async function installation(user: string): Promise<Who> {
    const who = await identity(user), token = `idev_${randomUUID()}`;
    await db.query("UPDATE next_devices SET kind='app-runtime' WHERE id=$1", [who.device]);
    await db.query("UPDATE connectors SET token_hash=$2 WHERE id=$1", [who.connector.id, tokenHash(randomUUID())]);
    await db.query(`INSERT INTO installation_device_credentials(pairing_id,connector_id,device_id,installation_id,token_hash,app_id,app_origin,kind,sign_pk,kem_pk,noise_pk)
      SELECT $1,$2,id,$3,$4,$5,$6,kind,sign_pk,kem_pk,noise_pk FROM next_devices WHERE id=$7`,
      [randomUUID(), who.connector.id, randomUUID(), tokenHash(token), application, `https://app-${application}.example.test`, who.device]);
    return { ...who, headers: { authorization: `Bearer ${token}` } };
  }
  /** The person's recorded consent, as credential exchange writes it. */
  const consent = (who: Who, collection: string, privateDevice = true) => db.query(
    "INSERT INTO installation_collection_scopes(connector_id,collection_id,private_device) VALUES($1,$2,$3) ON CONFLICT (connector_id,collection_id) DO UPDATE SET private_device=$3",
    [who.connector.id, collection, privateDevice]);
  const queue = async (collection: string, ops: PolicyOp[], drain = true) => {
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      expect(await queueNextPolicy(c, collection, ops)).toBe(true);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    if (drain) await emitter.drainCollection(collection);
  };
  /** A Private collection created by the owner's own desktop daemon. */
  async function created(owner: Who) {
    const collection = randomUUID();
    const { challenge } = await issueDeviceChallenge(db, owner.connector.id);
    const digest = privateCreateDigest({ challenge: Buffer.from(challenge, "hex"), connector: owner.connector.id, device: owner.device, collection });
    const response = await app.inject({ method: "POST", url: "/v1/next/collections/private", headers: owner.headers,
      payload: { collection_id: collection, device_id: owner.device, challenge, sig: hex(sign(null, digest, owner.key)) } });
    expect(response.statusCode, response.body).toBe(200);
    return collection;
  }
  const commit = () => hex(randomBytes(32));
  /** `signer` proves `device` under `who`'s bearer; by default the installation's own device and key. */
  async function enrol(who: Who, collection: string, server = app, signer: Pick<Who, "device" | "key"> = who) {
    const { challenge } = await issueDeviceChallenge(db, who.connector.id), sas = commit();
    const digest = privateDeviceEnrolDigest({ challenge: Buffer.from(challenge, "hex"), connector: who.connector.id, device: signer.device, collection, sasCommit: Buffer.from(sas, "hex") });
    return server.inject({ method: "POST", url: `/v1/next/collections/${collection}/private/devices`, headers: who.headers,
      payload: { device_id: signer.device, challenge, sig: hex(sign(null, digest, signer.key)), sas_commit: sas } });
  }
  async function refresh(who: Who, collection: string, server = app, signer: Pick<Who, "device" | "key"> = who) {
    const { challenge } = await issueDeviceChallenge(db, who.connector.id);
    const digest = collectionLogTokenDigest({ challenge: Buffer.from(challenge, "hex"), connector: who.connector.id, device: signer.device, collection });
    return server.inject({ method: "POST", url: `/v1/next/collections/${collection}/log-token`, headers: who.headers,
      payload: { device_id: signer.device, challenge, sig: hex(sign(null, digest, signer.key)) } });
  }
  async function fetchKey(who: Who, server = app, signer: Pick<Who, "device" | "key"> = who) {
    const { challenge } = await issueDeviceChallenge(db, who.connector.id);
    const sig = hex(sign(null, accountKeyFetchDigest({ challenge: Buffer.from(challenge, "hex"), connector: who.connector.id, device: signer.device, account: who.connector.user_id }), signer.key));
    return server.inject({ method: "GET", url: "/v1/next/account-key", headers: { ...who.headers, "x-mdbase-device-id": signer.device, "x-mdbase-challenge": challenge, "x-mdbase-signature": sig } });
  }
  const status = (who: Who, server = app) => server.inject({ method: "GET", url: "/v1/next/account-key/status", headers: who.headers });
  const listed = (who: Who, include?: string, server = app) => server.inject({ method: "GET", url: `/v1/next/collections${include ? `?include=${include}` : ""}`, headers: who.headers });
  const code = (response: { json(): { error?: { code?: string } } }) => response.json().error?.code;
  /** The account's sealed bundle, as a desktop stores it; the server checks no secret. */
  async function passwordKey(user: string) {
    const id = randomBytes(32), bundle = randomBytes(96);
    await db.query("INSERT INTO next_account_keys(user_id,mode,version,key_id,bundle,proof_pk) VALUES($1,'password',1,$2,$3,$4)", [user, id, bundle, randomBytes(32)]);
    return { key_id: hex(id), bundle: hex(bundle) };
  }
  const enrolments = async (collection: string, device: string) => (await db.query<{ kind: string }>(
    `SELECT e.value->>'kind' AS kind FROM next_policy_outbox o CROSS JOIN LATERAL jsonb_array_elements(o.ops->'ops') e(value)
     WHERE o.collection_id=$1 AND e.value->>'op'='device-enrol' AND e.value->>'device'=$2`, [collection, device])).rows;
  /** Every route that must reject `who` before it reads the body. */
  async function refusedEverywhereElse(who: Who, collection: string, server = app) {
    const proof = { device_id: who.device, challenge: "ab".repeat(32), sig: "cd".repeat(64) }, h32 = "ef".repeat(32);
    const witness = { account_id: who.connector.user_id, collection_id: collection, recovery_device: randomUUID(), reporter: who.device,
      strict_version: 1, revoked_at: 1, applied_at: 1, epoch: 1, signature: "cd".repeat(64) };
    const requests: [string, string, unknown][] = [
      ["PUT", "/v1/next/account-key", { ...proof, expected_version: 0, key_id: h32, bundle: "aa", proof_pk: h32 }],
      ["POST", "/v1/next/account-key/strict", { ...proof, expected_version: 1 }],
      ["POST", `/v1/next/collections/${collection}/private/strict-witness`, { ...proof, witness }],
      ["POST", `/v1/next/collections/${collection}/private/account-key-device`, { ...proof, recovery_device: randomUUID(), sign_pk: h32, kem_pk: h32, pop: "cd".repeat(64) }],
      ["POST", "/v1/next/collections/private", { ...proof, collection_id: randomUUID() }],
      ["POST", `/v1/next/collections/${collection}/private/devices/approval-request`, { ...proof, sas_commit: h32 }],
      ["POST", `/v1/next/collections/${collection}/device-approval/peer`, { peer: "AAAA" }],
      ["POST", `/v1/next/collections/${collection}/device-approval/inbox`, proof],
      ["POST", `/v1/next/collections/${collection}/device-approval/ack`, { ...proof, ids: [randomUUID()] }],
    ];
    for (const [method, url, payload] of requests) {
      const response = await server.inject({ method: method as "POST", url, headers: who.headers, payload: payload as object });
      expect([response.statusCode, code(response)], `${method} ${url}: ${response.body}`).toEqual([401, "invalid_connector"]);
    }
  }

  it("needs explicit Private device consent, then enrols the approved app-runtime device unkeyed", async () => {
    const owner = await identity(), collection = await created(owner), who = await installation(owner.connector.user_id);
    const account = await passwordKey(owner.connector.user_id);
    // Membership, an app-runtime device and the switch being on are not consent.
    for (const response of [await enrol(who, collection), await refresh(who, collection), await status(who), await fetchKey(who)]) {
      expect([response.statusCode, code(response)], response.body).toEqual([403, "installation_collection_not_approved"]);
    }
    expect((await listed(who, "mode")).json()).toEqual({ collections: [] });
    // Nor is a cloud-copy scope for the same collection.
    await consent(who, collection, false);
    for (const response of [await enrol(who, collection), await refresh(who, collection), await status(who), await fetchKey(who)]) {
      expect([response.statusCode, code(response)], response.body).toEqual([403, "installation_collection_not_approved"]);
    }
    expect((await listed(who, "mode")).json()).toEqual({ collections: [] });
    expect(await enrolments(collection, who.device)).toEqual([]);

    await consent(who, collection);
    const enrolled = await enrol(who, collection);
    expect(enrolled.statusCode, enrolled.body).toBe(200);
    expect(enrolled.headers["cache-control"]).toBe("no-store");
    expect(enrolled.json()).toMatchObject({ collection_id: collection, approval: "pending", log_url: "http://log.test", genesis: { seq: 1 }, device: { device_id: who.device } });
    expect(Object.keys(enrolled.json()).sort()).toEqual(["approval", "collection_id", "device", "display_name", "enrolled_at", "genesis", "log_url"]);
    // The control plane enrols; it grants no key. The device is an app-runtime device of the member account.
    expect(await enrolments(collection, who.device)).toEqual([{ kind: "app-runtime" }]);
    expect((await db.query("SELECT 1 FROM next_policy_outbox WHERE collection_id=$1 AND ops::text LIKE '%key%grant%'", [collection])).rows).toEqual([]);
    const token = await refresh(who, collection);
    expect(token.statusCode, token.body).toBe(200);
    expect(Object.keys(token.json()).sort()).toEqual(["expires_at", "token"]);

    // The list is opt-in: without `mode` it is the cloud-copy list in its old shape.
    expect((await listed(who)).json()).toEqual({ collections: [] });
    expect((await listed(who, "file_actions")).json()).toEqual({ collections: [] });
    expect((await listed(who, "mode")).json()).toEqual({ collections: [{ collection_id: collection, display_name: "New collection", role: "owner", mode: "private" }] });
    expect((await listed(who, "file_actions,mode")).json()).toEqual({ collections: [{ collection_id: collection, display_name: "New collection", role: "owner", file_actions: [], mode: "private" }] });

    // The sealed bundle and the status reach it with its own device proof.
    expect((await status(who)).json()).toEqual({ mode: "password", version: 1, key_id: account.key_id });
    const fetched = await fetchKey(who);
    expect(fetched.statusCode, fetched.body).toBe(200);
    expect(fetched.json()).toEqual({ mode: "password", version: 1, ...account });
    // A sibling installation of the same application and account holds no consent of its own.
    const sibling = await installation(owner.connector.user_id);
    for (const response of [await enrol(sibling, collection), await refresh(sibling, collection), await status(sibling), await fetchKey(sibling)]) {
      expect([response.statusCode, code(response)], response.body).toEqual([403, "installation_collection_not_approved"]);
    }
    await refusedEverywhereElse(who, collection);
  });

  it("enrols a non-owner member and lists its role", async () => {
    const owner = await identity(), collection = await created(owner), member = randomUUID(), who = await installation(member);
    await consent(who, collection);
    // Consent without membership answers as an unknown collection and enrols nothing.
    const early = await enrol(who, collection);
    expect([early.statusCode, code(early)], early.body).toEqual([404, "not_found"]);
    expect([(await status(who)).statusCode, (await fetchKey(who)).statusCode]).toEqual([403, 403]);
    expect((await listed(who, "mode")).json()).toEqual({ collections: [] });
    expect((await refresh(who, collection)).statusCode).toBe(409);
    await queue(collection, [{ op: "member-set", account: member, role: "viewer" }]);
    const enrolled = await enrol(who, collection);
    expect(enrolled.statusCode, enrolled.body).toBe(200);
    expect((await refresh(who, collection)).statusCode).toBe(200);
    expect((await listed(who, "mode")).json().collections).toEqual([{ collection_id: collection, display_name: "New collection", role: "viewer", mode: "private" }]);
    expect((await status(who)).json()).toEqual({ mode: "none", version: 0 });
    // Removal from the collection ends all of it, with the scope row still present.
    await queue(collection, [{ op: "member-remove", account: member }]);
    expect((await enrol(who, collection)).statusCode).toBe(404);
    expect((await refresh(who, collection)).statusCode).toBe(409);
    expect([(await status(who)).statusCode, (await fetchKey(who)).statusCode]).toEqual([403, 403]);
    expect((await listed(who, "mode")).json()).toEqual({ collections: [] });
  });

  it("pins every proof to the credential's own approved device", async () => {
    const owner = await identity(), collection = await created(owner), who = await installation(owner.connector.user_id);
    await passwordKey(owner.connector.user_id);
    await consent(who, collection);
    // The account's desktop device, signed by its own key, under the installation's bearer.
    // (A connector has one device, so the credential's own device is the only other candidate.)
    for (const response of [await enrol(who, collection, app, owner), await refresh(who, collection, app, owner), await fetchKey(who, app, owner)]) {
      expect([response.statusCode, code(response)], response.body).toEqual([403, "invalid_proof"]);
    }
    expect(await enrolments(collection, owner.device)).toEqual([{ kind: "desktop" }]);
    expect(await enrolments(collection, who.device)).toEqual([]);
    await expect(db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$3,'app-runtime',$4,$5,$6)",
      [randomUUID(), who.connector.id, who.connector.user_id, ed25519RawPublicKey(generateKeyPairSync("ed25519").privateKey), rawX(), rawX()])).rejects.toMatchObject({ code: "23505" });
    // A changed device key is not the approved device either.
    await db.query("UPDATE next_devices SET kem_pk=$2 WHERE id=$1", [who.device, rawX()]);
    for (const response of [await enrol(who, collection), await refresh(who, collection), await status(who), await fetchKey(who)]) {
      expect([response.statusCode, code(response)], response.body).toEqual([401, "invalid_connector"]);
    }
  });

  it("refuses a revoked device and never reactivates it", async () => {
    const owner = await identity(), collection = await created(owner), who = await installation(owner.connector.user_id);
    await passwordKey(owner.connector.user_id);
    await consent(who, collection);
    expect((await enrol(who, collection)).statusCode).toBe(200);
    await queue(collection, [{ op: "device-revoke", device: who.device }], false);
    for (const response of [await enrol(who, collection), await refresh(who, collection)]) {
      expect([response.statusCode, code(response)], response.body).toEqual([409, "device_revoked"]);
    }
    // Its only consent is for a collection it is revoked in, so the account key is closed to it too.
    expect([(await status(who)).statusCode, (await fetchKey(who)).statusCode]).toEqual([403, 403]);
    expect((await listed(who, "mode")).json()).toEqual({ collections: [] });
    // Consent for another collection restores the account key, not the revoked device.
    const second = await created(owner);
    await consent(who, second);
    expect((await status(who)).statusCode).toBe(200);
    expect((await listed(who, "mode")).json().collections.map((row: { collection_id: string }) => row.collection_id)).toEqual([second]);
    expect((await enrol(who, collection)).statusCode).toBe(409);
  });

  it("gives a strict account no bundle and no account inventory", async () => {
    const owner = await identity(), collection = await created(owner), who = await installation(owner.connector.user_id);
    await consent(who, collection);
    expect((await enrol(who, collection)).statusCode).toBe(200);
    await db.query("INSERT INTO next_account_keys(user_id,mode,version) VALUES($1,'strict',2)", [owner.connector.user_id]);
    expect((await fetchKey(who)).json()).toEqual({ mode: "strict", version: 2 });
    // The daemon sees the account's pending strict targets; the installation only the mode.
    expect((await status(owner)).json()).toMatchObject({ mode: "strict", version: 2, complete: expect.any(Boolean), pending: expect.any(Array) });
    expect((await status(who)).json()).toEqual({ mode: "strict", version: 2 });
    await refusedEverywhereElse(who, collection);
  });

  it("stops every use when the switch is turned off after enrolment, and answers as a server that never had it on", async () => {
    const owner = await identity(), collection = await created(owner), who = await installation(owner.connector.user_id);
    const account = await passwordKey(owner.connector.user_id);
    await consent(who, collection);
    expect((await enrol(who, collection)).statusCode).toBe(200);
    expect((await refresh(who, collection)).statusCode).toBe(200);
    expect((await fetchKey(who)).statusCode).toBe(200);
    await switchedOff(async () => {
      for (const response of [await enrol(who, collection), await status(who), await fetchKey(who)]) {
        expect([response.statusCode, response.json()], response.body).toEqual([401, { error: { code: "invalid_connector", message: "Connector credential is invalid." } }]);
      }
      const token = await refresh(who, collection);
      expect([token.statusCode, code(token)], token.body).toEqual([403, "installation_collection_not_approved"]);
      for (const include of [undefined, "file_actions", "mode", "file_actions,mode"]) expect((await listed(who, include)).json()).toEqual({ collections: [] });
      await refusedEverywhereElse(who, collection);
      // The account's own daemon is not an installation and is untouched.
      expect((await refresh(owner, collection)).statusCode).toBe(200);
      expect((await fetchKey(owner)).statusCode).toBe(200);
    });
    // The switch names no application and holds no consent: on again, the person's consent still stands.
    expect((await status(who)).json()).toEqual({ mode: "password", version: 1, key_id: account.key_id });
    expect((await refresh(who, collection)).statusCode).toBe(200);
    expect(await enrolments(collection, who.device)).toEqual([{ kind: "app-runtime" }]);
  });

  it("answers exactly as before while the switch is off", async () => {
    const owner = await identity(), collection = await created(owner), who = await installation(owner.connector.user_id);
    await passwordKey(owner.connector.user_id);
    await consent(who, collection);
    for (const response of [await enrol(who, collection, off), await status(who, off), await fetchKey(who, off)]) {
      expect([response.statusCode, response.json()], response.body).toEqual([401, { error: { code: "invalid_connector", message: "Connector credential is invalid." } }]);
    }
    const token = await refresh(who, collection, off);
    expect([token.statusCode, code(token)], token.body).toEqual([403, "installation_collection_not_approved"]);
    for (const include of [undefined, "file_actions", "mode", "file_actions,mode"]) expect((await listed(who, include, off)).json()).toEqual({ collections: [] });
    expect(await enrolments(collection, who.device)).toEqual([]);
    await refusedEverywhereElse(who, collection, off);
    // The ordinary daemon is untouched by either configuration.
    for (const server of [app, off]) {
      expect((await status(owner, server)).json()).toMatchObject({ mode: "password", version: 1 });
      expect((await fetchKey(owner, server)).statusCode).toBe(200);
      expect((await refresh(owner, collection, server)).statusCode).toBe(200);
    }
  });

  it("removing access revokes the enrolled device and denies its token", async () => {
    const owner = await identity(), user = owner.connector.user_id, collection = await created(owner), who = await installation(user);
    await passwordKey(user);
    await consent(who, collection);
    expect((await enrol(who, collection)).statusCode).toBe(200);
    expect((await refresh(who, collection)).statusCode).toBe(200);
    const session = randomUUID();
    await db.query("INSERT INTO sessions(id,user_id,token_hash,provider,account_session_epoch,expires_at) VALUES($1,$2,$3,'password',(SELECT session_epoch FROM users WHERE id=$2),now()+interval '1 hour')",
      [session, user, tokenHash(randomToken("session"))]);
    expect(await removeInstallationAccess(db, { applicationId: application }, user, session, collection, "lab")).toEqual({ ok: true, state: "revoking", collection_id: collection });
    expect((await db.query("SELECT 1 FROM installation_collection_scopes WHERE connector_id=$1", [who.connector.id])).rows).toEqual([]);
    // The same device-revoke a cloud copy gets: a keyed device then rekeys it out (replica).
    expect((await db.query("SELECT 1 FROM next_policy_outbox WHERE collection_id=$1 AND ops->'ops' @> $2::jsonb", [collection, JSON.stringify([{ op: "device-revoke", device: who.device }])])).rows).toHaveLength(1);
    for (const response of [await enrol(who, collection), await refresh(who, collection), await status(who), await fetchKey(who)]) {
      expect([response.statusCode, code(response)], response.body).toEqual([403, "installation_collection_not_approved"]);
    }
    expect((await listed(who, "mode")).json()).toEqual({ collections: [] });
    // A later consent for the same collection does not undo the revocation.
    await consent(who, collection);
    for (const response of [await enrol(who, collection), await refresh(who, collection)]) expect([response.statusCode, code(response)], response.body).toEqual([409, "device_revoked"]);
    // The owner's desktop keeps working.
    expect((await refresh(owner, collection)).statusCode).toBe(200);
  });

  it("never carries consent across a change of the collection's mode", async () => {
    const owner = await identity(), user = owner.connector.user_id, who = await installation(user);
    await passwordKey(user);
    // A cloud copy the installation was approved for as a cloud copy.
    const collection = randomUUID();
    await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'next','cloud_copy',$3)", [collection, user, Buffer.alloc(32)]);
    const batch = (await db.query("INSERT INTO next_policy_batches(collection_id,seq,prev,item,issued_at,state) VALUES($1,1,$2,$3,1,'appended') RETURNING id", [collection, Buffer.alloc(32), Buffer.alloc(1)])).rows[0].id;
    await db.query("INSERT INTO next_policy_outbox(collection_id,ops,batch_id) VALUES($1,$2,$3)", [collection, JSON.stringify({ version: 1, ops: [{ op: "member-set", account: user, role: "owner" }] }), batch]);
    await consent(who, collection, false);
    const row = { collection_id: collection, display_name: "New collection", role: "owner" };
    expect((await listed(who)).json()).toEqual({ collections: [row] });
    expect((await listed(who, "mode")).json()).toEqual({ collections: [{ ...row, mode: "cloud_copy" }] });
    expect((await status(who)).statusCode).toBe(403);

    // It becomes Private: the cloud-copy scope is not Private device consent.
    await db.query("UPDATE next_collections SET sync='private' WHERE collection_id=$1", [collection]);
    for (const response of [await enrol(who, collection), await refresh(who, collection), await status(who), await fetchKey(who)]) {
      expect([response.statusCode, code(response)], response.body).toEqual([403, "installation_collection_not_approved"]);
    }
    for (const include of [undefined, "mode"]) expect((await listed(who, include)).json()).toEqual({ collections: [] });

    // With Private device consent it lists as Private; back as a cloud copy, that consent is not a cloud-copy scope.
    await consent(who, collection);
    expect((await listed(who, "mode")).json()).toEqual({ collections: [{ ...row, mode: "private" }] });
    expect((await status(who)).statusCode).toBe(200);
    await db.query("UPDATE next_collections SET sync='cloud_copy' WHERE collection_id=$1", [collection]);
    for (const response of [await enrol(who, collection), await refresh(who, collection), await status(who), await fetchKey(who)]) {
      expect([response.statusCode, code(response)], response.body).toEqual([403, "installation_collection_not_approved"]);
    }
    for (const include of [undefined, "mode"]) expect((await listed(who, include)).json()).toEqual({ collections: [] });
  });
});
