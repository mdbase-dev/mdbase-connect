import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { tokenHash } from "../../security.js";
import { registerErrorHandler } from "../../platform/error-handler.js";
import { deviceRegistrationDigest, issueDeviceChallenge, registerDevice } from "./devices.js";
import { MODE_SWITCH_CAPABILITY, advertiseModeCapability, armModeFloor } from "./collection-mode-capability.js";
import { collectionModeDigest } from "./collection-mode-proof.js";
import { registerCollectionModeExecution } from "./collection-mode-execution.js";
import { registerCollectionModeRoutes } from "./collection-mode-routes.js";
import { LOG_TOKEN_LIFETIME_MS, LogServiceClient } from "./log-service-client.js";
import { ed25519RawPublicKey } from "./policy-keys.js";
import { PolicyEmitter, queueNextPolicy, registerNextCollection } from "./policy-outbox.js";
import { decodeCbor, type PolicyOp } from "./policy-wire.js";
import { parseServiceDevice, storeServiceDevice } from "./service-devices.js";
import { inTransaction } from "./bootstrap-common.js";
import { certify, FakeLogService, field } from "../../../test/policy-log.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const rawX = () => (generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);

// Real PG, authenticated HTTP proofs, signed policy/outbox and conditional log
// transport. Epoch/S are native proof fixtures; real key/trust behavior is tested
// in the Rust engine suite, not reimplemented in this transport fixture.
describePg("collection mode capability floor and token drain", () => {
  let db: DatabasePool, admin: pg.Pool, schema: string;
  let now = Date.now();
  const root = generateKeyPairSync("ed25519").privateKey;
  const policy = generateKeyPairSync("ed25519").privateKey;
  const issuer = generateKeyPairSync("ed25519");
  const signer = certify(root, policy, now);
  const wire = new FakeLogService(ed25519RawPublicKey(issuer.privateKey));
  const log = new LogServiceClient({ url: "https://log.example.test", tokenIssuerKeyPem: issuer.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    transportKeyPem: generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString() }, wire.fetch, () => now);
  let emitter: PolicyEmitter;
  const server = () => {
    const app = Fastify(); registerErrorHandler(app);
    registerCollectionModeRoutes(app, db);
    registerCollectionModeExecution(app, { db, emitter, log, next: {} as Parameters<typeof registerCollectionModeExecution>[1]["next"], now: () => now });
    return app;
  };
  let app: ReturnType<typeof server>;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("dedicated local test Postgres only");
    schema = `mode_floor_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 }); await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`); db = await createDatabase(url.toString());
    emitter = new PolicyEmitter(db, log, signer, () => undefined, 2000, () => now); app = server();
  }, 60_000);
  afterAll(async () => {
    await app?.close(); await emitter?.close(); await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin?.end();
  });
  async function fixture(bAdvertised = true) {
    const user = randomUUID(), collection = randomUUID(), token = randomUUID(), connector = randomUUID();
    await db.query("INSERT INTO users(id,email,name,account_backend) VALUES($1,$2,'Owner','next')", [user, `${user}@example.test`]);
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Native source',$3)", [connector, user, tokenHash(token)]);
    const a = randomUUID(), b = randomUUID(), key = generateKeyPairSync("ed25519").privateKey;
    const keys = { sign_pk: ed25519RawPublicKey(key), kem_pk: rawX(), noise_pk: rawX() };
    const registration = await issueDeviceChallenge(db, connector);
    await registerDevice(db, { id: connector, user_id: user }, { device_id: a, kind: "desktop", ...Object.fromEntries(Object.entries(keys).map(([k,v]) => [k,hex(v)])),
      capabilities: [MODE_SWITCH_CAPABILITY], challenge: registration.challenge,
      sig: hex(sign(null, deviceRegistrationDigest({ challenge: Buffer.from(registration.challenge,"hex"), connectorId: connector, deviceId:a,signPk:keys.sign_pk,kemPk:keys.kem_pk,noisePk:keys.noise_pk }), key)) }, tokenHash(token));
    const other = randomUUID();
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'B',$3)", [other, user, tokenHash(randomUUID())]);
    await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk,mode_switch_advertised) VALUES($1,$2,$3,'desktop',$4,$5,$6,$7)", [b,other,user,keys.sign_pk,keys.kem_pk,keys.noise_pk,bAdvertised]);
    const services = (["hosted","escrow"] as const).map((kind,i) => parseServiceDevice({kind,device_id:randomUUID(),sign_pk:Buffer.alloc(32,11+i).toString("hex"),kem_pk:hex(rawX()),noise_pk:hex(rawX()),wrapped_keys:Buffer.from(`synthetic-${kind}`).toString("base64"),kms_key_arn:`arn:aws:kms:eu-west-1:000000000000:key/${kind}`}));
    const enrol = (id: string, account: string, kind: "desktop"|"hosted"|"escrow", k = keys): PolicyOp => ({op:"device-enrol",device:id,account,kind,signPublicKey:k.sign_pk,kemPublicKey:k.kem_pk,noisePublicKey:k.noise_pk});
    await inTransaction(db, client => registerNextCollection(client, {collectionId:collection, ownerUserId:user,runtime:"next",sync:"cloud_copy",rootKeyId:signer.cert.root,
      ops:[{op:"genesis",owner:user,root:signer.cert.root,state:"cloud-copy"},{op:"member-set",account:user,role:"owner"},enrol(a,user,"desktop"),enrol(b,user,"desktop"),...services.map(s=>enrol(s.device_id,"00000000-0000-0000-0000-000000000000",s.kind,s))]}));
    for (const record of services) await storeServiceDevice(db, collection, record);
    await emitter.publishCommitted(collection);
    const request = randomUUID(), headers = { authorization: `Bearer ${token}` };
    const intent = await app.inject({method:"POST",url:`/v1/next/collections/${collection}/mode`,headers,payload:{request_id:request,target_mode:"private"}});
    expect(intent.statusCode,intent.body).toBe(202);
    return {user,collection,connector,a,b,key,keys,request,headers};
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function prepare(f: Fixture, head?: Awaited<ReturnType<typeof log.head>>) {
    head ??= await log.head(f.collection);
    const issued = await issueDeviceChallenge(db, f.connector);
    const members = [f.a,f.b].sort();
    const digest = collectionModeDigest({challenge:Buffer.from(issued.challenge,"hex"),connector:f.connector,device:f.a,collection:f.collection,request:f.request,target:"private",finish:false,epoch:1n,seq:BigInt(head.seq),chain:head.chain,members});
    return app.inject({method:"POST",url:`/v1/next/collections/${f.collection}/mode/${f.request}/prepare`,headers:f.headers,
      payload:{device_id:f.a,challenge:issued.challenge,sig:hex(sign(null,digest,f.key)),epoch:"1",seq:String(head.seq),chain:hex(head.chain),members}});
  }
  const floor = async (f: Fixture) => (await db.query<{mode_floor_raised_at:Date|null}>("SELECT mode_floor_raised_at FROM next_collections WHERE collection_id=$1",[f.collection])).rows[0].mode_floor_raised_at;

  it("refuses the older-writer race at arm: names offline/unadvertised B and publishes no switch", async () => {
    const f = await fixture(false);
    const response = await prepare(f);
    expect(response.statusCode,response.body).toBe(409); expect(response.json().devices).toEqual([f.b]);
    expect(response.json().error.code).toBe("mode_devices_need_update");
    expect(await floor(f)).toBeNull(); expect((await log.head(f.collection)).seq).toBe(1);
    expect((await db.query("SELECT policy_outbox_id FROM next_collection_mode_changes WHERE collection_id=$1",[f.collection])).rows[0].policy_outbox_id).toBeNull();
  });

  it("waits the maximum token TTL across restart, then publishes; the old cached token has expired", async () => {
    const f = await fixture();
    const cached = log.mintToken({device:f.b,signPublicKey:f.keys.sign_pk,collection:f.collection,expiresAt:now+LOG_TOKEN_LIFETIME_MS});
    const raisedAt = now;
    const first = await prepare(f); expect(first.statusCode,first.body).toBe(202);
    expect(first.json().phase).toBe("waiting_for_token_expiry");
    expect(first.json().retry_at).toBe(new Date(raisedAt+LOG_TOKEN_LIFETIME_MS).toISOString());
    await app.close(); app=server(); now=raisedAt+LOG_TOKEN_LIFETIME_MS-1;
    expect((await prepare(f)).json().phase).toBe("waiting_for_token_expiry");
    expect((await log.head(f.collection)).seq).toBe(1);
    now++; const ready=await prepare(f); expect(ready.statusCode,ready.body).toBe(202); expect(ready.json().phase).toBe("finishing");
    expect((await log.head(f.collection)).seq).toBe(2);
    const claims=decodeCbor(Buffer.from(cached.split(".")[0],"hex")); expect(Number(field(claims,3))).toBeLessThanOrEqual(now);
    const stable=await floor(f); await db.query("UPDATE next_collections SET sync='cloud_copy' WHERE collection_id=$1",[f.collection]);
    expect(await inTransaction(db,client=>armModeFloor(client,f.collection,[f.a,f.b],now+LOG_TOKEN_LIFETIME_MS))).toBe(raisedAt+LOG_TOKEN_LIFETIME_MS);
    expect(await floor(f)).toEqual(stable);
  });

  it("does not publish a native membership view at a different prefix; a fresh proof resumes the same outbox", async () => {
    const f=await fixture(); const raised=now; await prepare(f); now=raised+LOG_TOKEN_LIFETIME_MS;
    const stale=await log.head(f.collection);
    await inTransaction(db,client=>queueNextPolicy(client,f.collection,[{op:"member-set",account:f.user,role:"owner"}])); await emitter.publishCommitted(f.collection);
    const refused=await prepare(f,stale); expect(refused.statusCode,refused.body).toBe(409); expect(refused.json().error.code).toBe("mode_source_changed");
    expect((await log.head(f.collection)).seq).toBe(2);
    const resumed=await prepare(f); expect(resumed.statusCode,resumed.body).toBe(202); expect((await log.head(f.collection)).seq).toBe(3);
  });

  it("a later advertisement unblocks the same request without resetting the floor", async () => {
    const f=await fixture(false); expect((await prepare(f)).statusCode).toBe(409);
    await advertiseModeCapability(db,f.b,[MODE_SWITCH_CAPABILITY]);
    expect((await prepare(f)).json().phase).toBe("waiting_for_token_expiry"); const first=await floor(f);
    await advertiseModeCapability(db,f.b,[]); expect(await floor(f)).toEqual(first);
    expect((await db.query("SELECT mode_switch_advertised FROM next_devices WHERE id=$1",[f.b])).rows[0].mode_switch_advertised).toBe(true);
  });
});
