import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { tokenHash } from "../../security.js";
import { ensureDevelopmentEntitlement } from "../account/entitlements.js";
import { registerErrorHandler } from "../../platform/error-handler.js";
import { deviceRegistrationDigest, issueDeviceChallenge, registerDevice } from "./devices.js";
import { MODE_SWITCH_CAPABILITY, advertiseModeCapability, armModeFloor } from "./collection-mode-capability.js";
import { collectionModeDigest } from "./collection-mode-proof.js";
import { registerCollectionModeExecution, registerCollectionModeRecovery } from "./collection-mode-execution.js";
import { registerCollectionModeRoutes } from "./collection-mode-routes.js";
import { LOG_TOKEN_LIFETIME_MS, LogServiceClient } from "./log-service-client.js";
import { ed25519RawPublicKey } from "./policy-keys.js";
import { PolicyEmitter, PolicyPublicationDeferredError, queueNextPolicy, registerNextCollection } from "./policy-outbox.js";
import { decodeCbor, encodeCbor, signPolicyItem, type PolicyOp } from "./policy-wire.js";
import { parseServiceDevice, storeServiceDevice } from "./service-devices.js";
import { inTransaction } from "./bootstrap-common.js";
import { certify, FakeLogService, field } from "../../../test/policy-log.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const rawX = () => (generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
const rekeyItem = (collection: string, seq: number, prev: Uint8Array, signerId: string, fromEpoch: number, toEpoch: number, reason = 3) => {
  const payload = encodeCbor({ struct: [
    [0, 1], [1, toEpoch], [2, fromEpoch], [3, Buffer.alloc(32, 0xcc)], [4, []],
    [5, { struct: [[0, Buffer.alloc(16, 1)], [1, Buffer.alloc(32, 2)]] }], [6, reason],
  ] });
  return Buffer.from(encodeCbor({ struct: [
    [0, 1], [1, 3], [2, Buffer.from(collection.replaceAll("-", ""), "hex")], [3, seq], [4, prev],
    [6, Buffer.from(signerId.replaceAll("-", ""), "hex")], [11, payload], [12, Buffer.alloc(64, 0xaa)],
  ] }));
};

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
  let serviceFetch: typeof fetch = async () => { throw new Error("unexpected service effect"); };
  const server = () => {
    const app = Fastify(); void app.register(cookie); registerErrorHandler(app);
    registerCollectionModeRoutes(app, db, log);
    const next = { logService: {}, cloudCopyBootstrap: { hosted: { url: "https://hosted.example.test", token: "public-hosted-fixture".repeat(3) }, escrow: { url: "https://escrow.example.test", token: "public-escrow-fixture".repeat(3) } } } as Parameters<typeof registerCollectionModeExecution>[1]["next"];
    registerCollectionModeRecovery(app, { db, emitter, log, next });
    registerCollectionModeExecution(app, { db, emitter, log, next, fetchImpl: (...args) => serviceFetch(...args), now: () => now });
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
    await ensureDevelopmentEntitlement(db, user);
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Native source',$3)", [connector, user, tokenHash(token)]);
    const a = randomUUID(), b = randomUUID(), key = generateKeyPairSync("ed25519").privateKey;
    const keys = { sign_pk: ed25519RawPublicKey(key), kem_pk: rawX(), noise_pk: rawX() };
    const registration = await issueDeviceChallenge(db, connector);
    await registerDevice(db, { id: connector, user_id: user }, { device_id: a, kind: "desktop", ...Object.fromEntries(Object.entries(keys).map(([k,v]) => [k,hex(v)])),
      capabilities: [MODE_SWITCH_CAPABILITY], challenge: registration.challenge,
      sig: hex(sign(null, deviceRegistrationDigest({ challenge: Buffer.from(registration.challenge,"hex"), connectorId: connector, deviceId:a,signPk:keys.sign_pk,kemPk:keys.kem_pk,noisePk:keys.noise_pk }), key)) }, tokenHash(token));
    const other = randomUUID(), otherToken = randomUUID();
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'B',$3)", [other, user, tokenHash(otherToken)]);
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
    return {user,collection,connector,a,b,key,keys,request,headers,otherHeaders:{authorization:`Bearer ${otherToken}`}};
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
  /** An activated app grant on the collection, approved for `sync`, with a log binding and a token. */
  async function appGrant(f: Fixture, sync: "private"|"cloud_copy") {
    const grant=randomUUID(),logGrant=randomUUID();
    await db.query("INSERT INTO applications(id,canonical_identity,name,homepage,redirect_uris) VALUES($1::uuid,$1::text,'Notes','https://notes.example','[]')",[grant]);
    await db.query(`INSERT INTO grants(id,user_id,application_id,next_collection_id,next_collection_sync,operations,scope,application_installation_id,application_authorization,activated_at)
      VALUES($1,$2,$1,$3,$4,'["read"]','{"access":"full_collection","contracts":[]}','installation-1','{"binding":{"protocol_version":4}}',now())`,[grant,f.user,f.collection,sync]);
    await db.query("INSERT INTO next_grant_bindings(grant_id,collection_id,log_grant_id,terms_digest) VALUES($1,$2,$3,$4)",[grant,f.collection,logGrant,Buffer.alloc(32)]);
    await db.query("INSERT INTO access_tokens(id,token_hash,grant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[randomUUID(),tokenHash(randomUUID()),grant]);
    const revocations=async()=>(await db.query<{id:string;state:string|null}>(`SELECT o.id,b.state FROM next_policy_outbox o LEFT JOIN next_policy_batches b ON b.id=o.batch_id
      WHERE o.collection_id=$1 AND o.ops->'ops' @> $2::jsonb`,[f.collection,JSON.stringify([{op:"grant-revoke",grant:logGrant}])])).rows;
    return {grant,logGrant,revocations};
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

  it.each([3, 4])("releases adjacency after observing control kind %s without an owner finish or readiness claim", async kind => {
    const f=await fixture();await prepare(f);now+=LOG_TOKEN_LIFETIME_MS;await prepare(f);
    const policyHead=await log.head(f.collection);
    const mutation=()=>inTransaction(db,client=>queueNextPolicy(client,f.collection,[{op:"device-revoke",device:f.a}]));
    const http=Fastify();registerErrorHandler(http);http.post("/policy",mutation);
    try {
      const held=await http.inject({method:"POST",url:"/policy"});
      expect(held.statusCode,held.body).toBe(409);expect(held.json().error.code).toBe("collection_mode_change_in_progress");
    } finally {await http.close();}
    wire.logs.get(f.collection.replaceAll("-",""))!.push(Buffer.from(encodeCbor({struct:[[0,1],[1,kind],[2,Buffer.from(f.collection.replaceAll("-",""),"hex")],[3,policyHead.seq+1],[4,policyHead.chain],[5,2],[6,Buffer.from(f.a.replaceAll("-",""),"hex")],[11,Buffer.from("opaque native control fixture")]]})));
    // The periodic durable producer must discover the hold with NO pending outbox.
    await emitter.drain();
    const row=(await db.query("SELECT policy_hold_released_at,rekey_verified_at,completed_at FROM next_collection_mode_changes WHERE collection_id=$1",[f.collection])).rows[0];
    expect(row.policy_hold_released_at).not.toBeNull();expect(row.rekey_verified_at).toBeNull();expect(row.completed_at).toBeNull();
    if(kind===3){
      const denied=await app.inject({method:"POST",url:`/v1/next/collections/${f.collection}/mode/${f.request}/abandon`,headers:f.otherHeaders});
      expect(denied.statusCode,denied.body).toBe(409);expect(denied.json().error.code).toBe("mode_rekey_observed");
    }
    await mutation();await emitter.publishCommitted(f.collection);
    expect((await log.head(f.collection)).seq).toBe(policyHead.seq+2);
  });

  it("lets a surviving owner abandon a published unrekeyed switch, retaining publication and old epoch", async()=>{
    const f=await fixture();await prepare(f);now+=LOG_TOKEN_LIFETIME_MS;await prepare(f);
    const original=(await db.query("SELECT policy_outbox_id,source_epoch FROM next_collection_mode_changes WHERE collection_id=$1",[f.collection])).rows[0];
    const head=await log.head(f.collection),url=`/v1/next/collections/${f.collection}/mode/${f.request}/abandon`;
    expect((await app.inject({method:"POST",url})).statusCode).toBe(401);
    // A has been lost. B can release the CP hold without A's finish/key proof.
    const abandoned=await app.inject({method:"POST",url,headers:f.otherHeaders});
    expect(abandoned.statusCode,abandoned.body).toBe(200);expect(abandoned.json().phase).toBe("abandoned");
    const row=(await db.query("SELECT * FROM next_collection_mode_changes WHERE collection_id=$1",[f.collection])).rows[0];
    expect(row.abandoned_at).not.toBeNull();expect(row.policy_hold_released_at).not.toBeNull();
    expect(row.rekey_verified_at).toBeNull();expect(row.completed_at).toBeNull();expect(row.cancelled_at).toBeNull();
    expect(row.policy_outbox_id).toBe(original.policy_outbox_id);expect(String(row.source_epoch)).toBe(String(original.source_epoch));
    expect(await log.head(f.collection)).toEqual(head);
    expect((await db.query("SELECT sync FROM next_collections WHERE collection_id=$1",[f.collection])).rows[0].sync).toBe("private");
    expect((await db.query("SELECT count(*)::int AS n FROM next_service_devices WHERE collection_id=$1",[f.collection])).rows[0].n).toBe(0);
    expect((await app.inject({method:"POST",url,headers:f.otherHeaders})).json().phase).toBe("abandoned");
    // Not presented as finished Private while the services' epoch is current.
    const mode=async()=>(await app.inject({method:"GET",url:`/v1/next/collections/${f.collection}/mode`,headers:f.otherHeaders})).json();
    expect(await mode()).toMatchObject({current_mode:"private",change:{request_id:f.request,target_mode:"private",phase:"abandoned"}});
    expect((await prepare(f)).json().error.code).toBe("mode_abandoned");
    await inTransaction(db,client=>queueNextPolicy(client,f.collection,[{op:"device-revoke",device:f.a}]));
    await emitter.publishCommitted(f.collection);expect((await log.head(f.collection)).seq).toBe(head.seq+1);
    expect((await mode()).change.phase).toBe("abandoned");
    wire.failNextRead=true;expect((await mode()).change.phase).toBe("abandoned");
    // New mode switches are refused while an abandoned Private switch remains unrekeyed.
    const refusedCloud=await app.inject({method:"POST",url:`/v1/next/collections/${f.collection}/mode`,headers:f.otherHeaders,payload:{request_id:randomUUID(),target_mode:"cloud_copy"}});
    expect(refusedCloud.statusCode,refusedCloud.body).toBe(409);expect(refusedCloud.json().error.code).toBe("mode_abandoned");
    const refusedPrivate=await app.inject({method:"POST",url:`/v1/next/collections/${f.collection}/mode`,headers:f.otherHeaders,payload:{request_id:randomUUID(),target_mode:"private"}});
    expect(refusedPrivate.statusCode,refusedPrivate.body).toBe(409);expect(refusedPrivate.json().error.code).toBe("mode_abandoned");
    // Unavailable log fails closed on POST /mode too and inserts no row.
    wire.failNextRead=true;
    const refusedUnavailable=await app.inject({method:"POST",url:`/v1/next/collections/${f.collection}/mode`,headers:f.otherHeaders,payload:{request_id:randomUUID(),target_mode:"cloud_copy"}});
    expect(refusedUnavailable.statusCode,refusedUnavailable.body).toBe(409);expect(refusedUnavailable.json().error.code).toBe("mode_abandoned");
    expect((await db.query("SELECT count(*)::int AS n FROM next_collection_mode_changes WHERE collection_id=$1",[f.collection])).rows[0].n).toBe(1);
    // Retrying the abandoned request ID itself remains idempotent.
    const retryAbandoned=await app.inject({method:"POST",url:`/v1/next/collections/${f.collection}/mode`,headers:f.otherHeaders,payload:{request_id:f.request,target_mode:"private"}});
    expect(retryAbandoned.statusCode,retryAbandoned.body).toBe(202);expect(retryAbandoned.json().phase).toBe("abandoned");
    // A surviving switch-set owner's excluding rekey follows the revocation and unblocks new switches.
    const revoked=await log.head(f.collection);
    wire.logs.get(f.collection.replaceAll("-",""))!.push(rekeyItem(f.collection,revoked.seq+1,revoked.chain,f.b,1,2,3));
    expect((await mode()).change).toBeNull();
    const later=randomUUID();
    const intent=await app.inject({method:"POST",url:`/v1/next/collections/${f.collection}/mode`,headers:f.otherHeaders,payload:{request_id:later,target_mode:"cloud_copy"}});
    expect(intent.statusCode,intent.body).toBe(202);expect(intent.json().phase).toBe("waiting_for_device");
  });

  it("re-checks abandoned state after the out-of-lock log read so a concurrent newer abandon is still refused", async()=>{
    const f=await fixture();await prepare(f);now+=LOG_TOKEN_LIFETIME_MS;await prepare(f);
    expect((await app.inject({method:"POST",url:`/v1/next/collections/${f.collection}/mode/${f.request}/abandon`,headers:f.otherHeaders})).statusCode).toBe(200);
    const policyHead=await log.head(f.collection);
    wire.logs.get(f.collection.replaceAll("-",""))!.push(rekeyItem(f.collection,policyHead.seq+1,policyHead.chain,f.b,1,2,3));
    let injected=false;
    const raceLog: Pick<LogServiceClient,"controlItemsAfter"> = {
      controlItemsAfter: async (collection, after, limit) => {
        const result=await log.controlItemsAfter(collection,after,limit);
        if(!injected){
          injected=true;
          // Simulate a newer abandoned Private switch landing while rekeyFollows was outside DB locks.
          const newerBatch=(await db.query<{id:string}>("INSERT INTO next_policy_batches(collection_id,seq,prev,item,issued_at,state,appended_at) VALUES($1,$2,$3,$4,$5,'appended',now()) RETURNING id",
            [f.collection,policyHead.seq+2,Buffer.alloc(32),Buffer.from("newer switch fixture"),now])).rows[0]!.id;
          const newerOutbox=(await db.query<{id:string}>("INSERT INTO next_policy_outbox(collection_id,ops,batch_id) VALUES($1,'{\"ops\":[]}',$2) RETURNING id",[f.collection,newerBatch])).rows[0]!.id;
          await db.query(`INSERT INTO next_collection_mode_changes(collection_id,request_id,actor_id,source_mode,target_mode,policy_outbox_id,created_at,abandoned_at,policy_hold_released_at)
            VALUES($1,$2,$3,'cloud_copy','private',$4,now()+interval '1 second',now(),now())`,[f.collection,randomUUID(),f.user,newerOutbox]);
        }
        return result;
      }
    };
    const raceApp=Fastify();void raceApp.register(cookie);registerErrorHandler(raceApp);
    registerCollectionModeRoutes(raceApp,db,raceLog);
    try {
      const response=await raceApp.inject({method:"POST",url:`/v1/next/collections/${f.collection}/mode`,headers:f.otherHeaders,payload:{request_id:randomUUID(),target_mode:"cloud_copy"}});
      expect(response.statusCode,response.body).toBe(409);expect(response.json().error.code).toBe("mode_abandoned");
      expect(injected).toBe(true);
    } finally { await raceApp.close(); }
  });

  it("revokes cloud-copy app grants in the log when the collection becomes Private, once across retries", async()=>{
    const f=await fixture();
    const {grant,revocations}=await appGrant(f,"cloud_copy");
    // Publishing the switch does not yet change the collection's mode: the grant stands.
    await prepare(f);now+=LOG_TOKEN_LIFETIME_MS;await prepare(f);
    expect((await db.query("SELECT revoked_at FROM grants WHERE id=$1",[grant])).rows[0].revoked_at).toBeNull();
    expect(await revocations()).toEqual([]);
    const url=`/v1/next/collections/${f.collection}/mode/${f.request}/abandon`;
    expect((await app.inject({method:"POST",url,headers:f.otherHeaders})).statusCode).toBe(200);
    // Leaving cloud copy revokes the grant with its tokens, and queues its log revocation.
    const row=(await db.query("SELECT revoked_at,reauthorization_reason FROM grants WHERE id=$1",[grant])).rows[0];
    expect(row.revoked_at).not.toBeNull();expect(row.reauthorization_reason).toBe("collection_mode_changed");
    expect((await db.query("SELECT revoked_at FROM access_tokens WHERE grant_id=$1",[grant])).rows[0].revoked_at).not.toBeNull();
    expect((await db.query("SELECT active FROM next_grant_bindings WHERE grant_id=$1",[grant])).rows[0].active).toBe(false);
    const [queued]=await revocations();expect(queued).toMatchObject({state:null});
    // The emitter appends it to the log, where the hosted replica reads it.
    const head=await log.head(f.collection);
    await emitter.publishCommitted(f.collection);
    expect(await revocations()).toEqual([{id:queued!.id,state:"appended"}]);
    expect((await log.head(f.collection)).seq).toBe(head.seq+1);
    // A retried abandon is idempotent and queues nothing more.
    expect((await app.inject({method:"POST",url,headers:f.otherHeaders})).json().phase).toBe("abandoned");
    expect(await revocations()).toHaveLength(1);
  });

  it.each(["before-effect", "lost-ack", "wrong-device", "wrong-challenge", "service-unready", "missing-handler"])("service %s never completes early; both directions resume exact receipts after restart", async failure => {
    const f=await fixture();await prepare(f);now+=LOG_TOKEN_LIFETIME_MS;
    expect((await prepare(f)).json().phase).toBe("finishing");
    const policyHead=await log.head(f.collection);
    // Native acceptance is an authenticated proof fixture here, not a second
    // key/HPKE implementation. Real native receipt validity has Rust coverage.
    const receipt=rekeyItem(f.collection,policyHead.seq+1,policyHead.chain,f.a,1,2,3);
    wire.logs.get(f.collection.replaceAll("-",""))!.push(receipt);
    const head=await log.head(f.collection),retired=new Set<string>();let calls=0,uncertain=true;
    serviceFetch=async(input,init)=>{
      calls++;const body=JSON.parse(init!.body as string) as {collection:string;device:string;epoch:string;challenge:string};
      expect(new URL(String(input)).pathname).toBe("/internal/v1/collection-mode/retire");
      expect(body.collection).toBe(f.collection);expect(body.epoch).toBe("2");
      const escrow=new URL(String(input)).hostname.startsWith("escrow");
      if(uncertain&&escrow&&failure==="before-effect")throw new TypeError("synthetic pre-effect failure");
      if(uncertain&&escrow&&failure==="missing-handler")return new Response("Not Found",{status:404});
      retired.add(body.device);
      if(uncertain&&escrow&&failure==="service-unready")return Response.json({error:"not_ready"},{status:503});
      if(uncertain&&escrow&&failure==="lost-ack")throw new TypeError("synthetic lost retirement acknowledgement");
      return Response.json({...body,ready:true,...(uncertain&&escrow&&failure==="wrong-device"?{device:randomUUID()}:{}),...(uncertain&&escrow&&failure==="wrong-challenge"?{challenge:"ff".repeat(32)}:{})});
    };
    let target:"private"|"cloud_copy"="private",request=f.request,proofHead=head;
    const finish=async()=>{
      const issued=await issueDeviceChallenge(db,f.connector);
      const digest=collectionModeDigest({challenge:Buffer.from(issued.challenge,"hex"),connector:f.connector,device:f.a,collection:f.collection,request,target,finish:true,epoch:2n,seq:BigInt(proofHead.seq),chain:proofHead.chain,members:[]});
      return app.inject({method:"POST",url:`/v1/next/collections/${f.collection}/mode/${request}/finish`,headers:f.headers,payload:{device_id:f.a,challenge:issued.challenge,sig:hex(sign(null,digest,f.key)),epoch:"2",seq:String(proofHead.seq),chain:hex(proofHead.chain),members:[]}});
    };
    const failed=await finish();expect(failed.statusCode,failed.body).toBe(503);expect(failed.json().error.code).toBe("not_ready");
    const persisted=(await db.query("SELECT completed_at,rekey_verified_at,rekey_seq,policy_outbox_id FROM next_collection_mode_changes WHERE collection_id=$1",[f.collection])).rows[0];
    expect(persisted.completed_at).toBeNull();expect(persisted.rekey_verified_at).not.toBeNull();expect(String(persisted.rekey_seq)).toBe(String(head.seq));
    expect((await db.query("SELECT sync FROM next_collections WHERE collection_id=$1",[f.collection])).rows[0].sync).toBe("cloud_copy");
    expect((await db.query("SELECT count(*)::int AS n FROM next_service_devices WHERE collection_id=$1",[f.collection])).rows[0].n).toBe(2);
    await app.close();app=server();uncertain=false;
    const completed=await finish();expect(completed.statusCode,completed.body).toBe(200);expect(completed.json().phase).toBe("complete");expect(retired.size).toBe(2);
    expect((await log.head(f.collection)).seq).toBe(head.seq);
    expect((await db.query("SELECT sync FROM next_collections WHERE collection_id=$1",[f.collection])).rows[0].sync).toBe("private");
    expect((await db.query("SELECT policy_outbox_id FROM next_collection_mode_changes WHERE collection_id=$1",[f.collection])).rows[0].policy_outbox_id).toBe(persisted.policy_outbox_id);
    const settledCalls=calls;expect((await finish()).json().phase).toBe("complete");expect(calls).toBe(settledCalls);

    // Reverse direction: lost readiness must retain the exact generated service
    // identities and publication, not remint replacements on controller restart.
    // A Private app grant approved meanwhile must not outlive the switch: its log
    // revocation is queued ahead of the cloud-copy collection state.
    const privateGrant=await appGrant(f,"private");
    target="cloud_copy";request=randomUUID();uncertain=true;let factories=0;
    const ready=new Set<string>();
    serviceFetch=async(input,init)=>{
      const url=new URL(String(input)),kind=url.hostname.startsWith("escrow")?"escrow":"hosted";
      const body=JSON.parse(init!.body as string) as {collection:string;device:string;epoch:string;challenge:string};
      expect(body.collection).toBe(f.collection);
      if(url.pathname==="/internal/v1/service-devices"){
        factories++;return Response.json({kind,device_id:randomUUID(),sign_pk:Buffer.alloc(32,23).toString("hex"),kem_pk:hex(rawX()),noise_pk:hex(rawX()),wrapped_keys:Buffer.from("public generated fixture").toString("base64"),kms_key_arn:`arn:aws:kms:eu-west-1:000000000000:key/${kind}`});
      }
      calls++;expect(url.pathname).toBe("/internal/v1/collection-mode/ready");expect(body.epoch).toBe("2");
      if(uncertain&&kind==="escrow"&&failure==="before-effect")throw new TypeError("synthetic pre-observation failure");
      if(uncertain&&kind==="escrow"&&failure==="missing-handler")return new Response("Not Found",{status:404});
      ready.add(body.device);
      if(uncertain&&kind==="escrow"&&failure==="service-unready")return Response.json({error:"not_ready"},{status:503});
      if(uncertain&&kind==="escrow"&&failure==="lost-ack")throw new TypeError("synthetic lost readiness acknowledgement");
      return Response.json({...body,ready:true,...(uncertain&&kind==="escrow"&&failure==="wrong-device"?{device:randomUUID()}:{}),...(uncertain&&kind==="escrow"&&failure==="wrong-challenge"?{challenge:"ff".repeat(32)}:{})});
    };
    expect((await app.inject({method:"POST",url:`/v1/next/collections/${f.collection}/mode`,headers:f.headers,payload:{request_id:request,target_mode:target}})).statusCode).toBe(202);
    const issued=await issueDeviceChallenge(db,f.connector);
    const digest=collectionModeDigest({challenge:Buffer.from(issued.challenge,"hex"),connector:f.connector,device:f.a,collection:f.collection,request,target,finish:false,epoch:2n,seq:BigInt(proofHead.seq),chain:proofHead.chain,members:[]});
    const published=await app.inject({method:"POST",url:`/v1/next/collections/${f.collection}/mode/${request}/prepare`,headers:f.headers,payload:{device_id:f.a,challenge:issued.challenge,sig:hex(sign(null,digest,f.key)),epoch:"2",seq:String(proofHead.seq),chain:hex(proofHead.chain),members:[]}});
    expect(published.statusCode,published.body).toBe(202);proofHead=await log.head(f.collection);
    const [revoked]=await privateGrant.revocations();
    const modeOutbox=(await db.query("SELECT policy_outbox_id FROM next_collection_mode_changes WHERE collection_id=$1 AND request_id=$2",[f.collection,request])).rows[0].policy_outbox_id;
    expect(revoked).toMatchObject({state:"appended"});expect(BigInt(revoked!.id)).toBeLessThan(BigInt(modeOutbox));
    expect((await db.query("SELECT revoked_at FROM grants WHERE id=$1",[privateGrant.grant])).rows[0].revoked_at).not.toBeNull();
    const identities=(await db.query("SELECT device_id FROM next_service_devices WHERE collection_id=$1 ORDER BY device_id",[f.collection])).rows;
    expect(factories).toBe(2);const unready=await finish();expect(unready.statusCode,unready.body).toBe(503);expect(unready.json().error.code).toBe("not_ready");
    expect((await db.query("SELECT completed_at FROM next_collection_mode_changes WHERE collection_id=$1 AND request_id=$2",[f.collection,request])).rows[0].completed_at).toBeNull();
    await app.close();app=server();uncertain=false;
    const cloud=await finish();expect(cloud.statusCode,cloud.body).toBe(200);expect(cloud.json().phase).toBe("complete");expect(ready.size).toBe(2);
    expect(factories).toBe(2);expect((await log.head(f.collection)).seq).toBe(proofHead.seq);
    expect((await db.query("SELECT device_id FROM next_service_devices WHERE collection_id=$1 ORDER BY device_id",[f.collection])).rows).toEqual(identities);
    const readyCalls=calls;expect((await finish()).json().phase).toBe("complete");expect(calls).toBe(readyCalls);
  });

  it("accepts a qualifying non-adjacent CloudCopyOff rekey and rejects non-qualifying receipts", async () => {
    const finishProof = async (f: Fixture, epoch: bigint, seq: number, chain: Uint8Array) => {
      const issued = await issueDeviceChallenge(db, f.connector);
      const digest = collectionModeDigest({ challenge: Buffer.from(issued.challenge, "hex"), connector: f.connector, device: f.a, collection: f.collection, request: f.request, target: "private", finish: true, epoch, seq: BigInt(seq), chain, members: [] });
      return app.inject({ method: "POST", url: `/v1/next/collections/${f.collection}/mode/${f.request}/finish`, headers: f.headers, payload: { device_id: f.a, challenge: issued.challenge, sig: hex(sign(null, digest, f.key)), epoch: String(epoch), seq: String(seq), chain: hex(chain), members: [] } });
    };
    const okServices: typeof fetch = async (_input, init) => {
      const body = JSON.parse(init!.body as string) as { collection: string; device: string; epoch: string; challenge: string };
      return Response.json({ ...body, ready: true });
    };

    // 1. Non-adjacent qualifying CloudCopyOff rekey after Entry (kind 1), KeyGrant (kind 4), and Policy (kind 2 staying e2e).
    const f = await fixture();
    await prepare(f); now += LOG_TOKEN_LIFETIME_MS;
    expect((await prepare(f)).json().phase).toBe("finishing");
    const policyHead = await log.head(f.collection);
    const items = wire.logs.get(f.collection.replaceAll("-", ""))!;
    // Intervening data entry (kind=1)
    items.push(Buffer.from(encodeCbor({ struct: [[0, 1], [1, 1], [2, Buffer.from(f.collection.replaceAll("-", ""), "hex")], [3, policyHead.seq + 1], [4, policyHead.chain], [5, 1], [6, Buffer.from(f.b.replaceAll("-", ""), "hex")], [11, Buffer.from("sealed-entry")]] })));
    const entryHead = await log.head(f.collection);
    // Intervening key grant (kind=4)
    items.push(Buffer.from(encodeCbor({ struct: [[0, 1], [1, 4], [2, Buffer.from(f.collection.replaceAll("-", ""), "hex")], [3, entryHead.seq + 1], [4, entryHead.chain], [6, Buffer.from(f.b.replaceAll("-", ""), "hex")], [11, Buffer.from("key-grant")]] })));
    const grantHead = await log.head(f.collection);
    // Intervening policy item (kind=2) staying in e2e (device-revoke)
    items.push(Buffer.from(signPolicyItem(signer, { collection: f.collection, seq: grantHead.seq + 1, prev: grantHead.chain, issuedAt: now + 1000, previousIssuedAt: now, ops: [{ op: "device-revoke", device: f.b }] })));
    const revokeHead = await log.head(f.collection);
    // Non-qualifying receipts checked against the live log before the qualifying rekey lands:
    expect((await finishProof(f, 2n, policyHead.seq, policyHead.chain)).json().error.code).toBe("private_receipt_mismatch");
    expect((await finishProof(f, 3n, revokeHead.seq + 1, Buffer.alloc(32, 9))).json().error.code).toBe("private_receipt_mismatch");
    expect((await finishProof(f, 2n, entryHead.seq, entryHead.chain)).json().error.code).toBe("private_receipt_mismatch");
    expect((await finishProof(f, 2n, grantHead.seq, grantHead.chain)).json().error.code).toBe("private_receipt_mismatch");
    // Future seq not yet in log returns retryable 503 not_ready.
    const notYet = await finishProof(f, 2n, revokeHead.seq + 1, Buffer.alloc(32, 9));
    expect(notYet.statusCode).toBe(503); expect(notYet.json().error.code).toBe("not_ready");
    // Now append the qualifying non-adjacent CloudCopyOff rekey.
    items.push(rekeyItem(f.collection, revokeHead.seq + 1, revokeHead.chain, f.a, 1, 2, 3));
    const rekeyHead = await log.head(f.collection);
    // Chain mismatch returns retryable 503 not_ready and never verifies.
    const wrongChain = await finishProof(f, 2n, rekeyHead.seq, Buffer.alloc(32, 7));
    expect(wrongChain.statusCode).toBe(503); expect(wrongChain.json().error.code).toBe("not_ready");
    serviceFetch = okServices;
    const done = await finishProof(f, 2n, rekeyHead.seq, rekeyHead.chain);
    expect(done.statusCode, done.body).toBe(200); expect(done.json().phase).toBe("complete");
    const row = (await db.query("SELECT rekey_seq,completed_at FROM next_collection_mode_changes WHERE collection_id=$1", [f.collection])).rows[0];
    expect(String(row.rekey_seq)).toBe(String(rekeyHead.seq)); expect(row.completed_at).not.toBeNull();

    // 2. Non-qualifying reason (DeviceRevoked=1) and wrong payload from/epoch are rejected.
    for (const bad of [{ from: 1, to: 2, reason: 1 }, { from: 2, to: 3, reason: 3 }]) {
      const g = await fixture();
      await prepare(g); now += LOG_TOKEN_LIFETIME_MS; await prepare(g);
      const pHead = await log.head(g.collection);
      wire.logs.get(g.collection.replaceAll("-", ""))!.push(rekeyItem(g.collection, pHead.seq + 1, pHead.chain, g.a, bad.from, bad.to, bad.reason));
      const head = await log.head(g.collection);
      const res = await finishProof(g, 2n, head.seq, head.chain);
      expect(res.statusCode, res.body).toBe(409); expect(res.json().error.code).toBe("private_receipt_mismatch");
    }

    // 3. A second rekey after an earlier rekey is NOT the first rekey after the policy.
    const h = await fixture();
    await prepare(h); now += LOG_TOKEN_LIFETIME_MS; await prepare(h);
    const hPolicy = await log.head(h.collection);
    const hItems = wire.logs.get(h.collection.replaceAll("-", ""))!;
    hItems.push(rekeyItem(h.collection, hPolicy.seq + 1, hPolicy.chain, h.b, 1, 2, 1)); // earlier rekey
    const firstRekey = await log.head(h.collection);
    hItems.push(rekeyItem(h.collection, firstRekey.seq + 1, firstRekey.chain, h.a, 1, 2, 3)); // later CloudCopyOff
    const secondRekey = await log.head(h.collection);
    const rejectedSecond = await finishProof(h, 2n, secondRekey.seq, secondRekey.chain);
    expect(rejectedSecond.statusCode, rejectedSecond.body).toBe(409);
    expect(rejectedSecond.json().error.code).toBe("private_receipt_mismatch");

    // 4. An intervening policy item that leaves e2e (collection-state: cloud-copy) invalidates the switch.
    const k = await fixture();
    await prepare(k); now += LOG_TOKEN_LIFETIME_MS; await prepare(k);
    const kPolicy = await log.head(k.collection);
    const kItems = wire.logs.get(k.collection.replaceAll("-", ""))!;
    kItems.push(Buffer.from(signPolicyItem(signer, { collection: k.collection, seq: kPolicy.seq + 1, prev: kPolicy.chain, issuedAt: now + 1000, previousIssuedAt: now, ops: [{ op: "collection-state", state: "cloud-copy" }] })));
    const leftE2e = await log.head(k.collection);
    kItems.push(rekeyItem(k.collection, leftE2e.seq + 1, leftE2e.chain, k.a, 1, 2, 3));
    const afterLeave = await log.head(k.collection);
    const rejectedAfterLeave = await finishProof(k, 2n, afterLeave.seq, afterLeave.chain);
    expect(rejectedAfterLeave.statusCode, rejectedAfterLeave.body).toBe(409);
    expect(rejectedAfterLeave.json().error.code).toBe("private_receipt_mismatch");
  });

  it("returns 202 publishing_policy when foreground publishCommitted defers, without masking unrelated errors", async () => {
    // 1. Real PolicyPublicationDeferredError when the foreground wake slots (4) are saturated.
    const f = await fixture();
    await prepare(f); now += LOG_TOKEN_LIFETIME_MS;
    const blockers = await Promise.all(Array.from({ length: 4 }, () => fixture()));
    for (const b of blockers) await inTransaction(db, client => queueNextPolicy(client, b.collection, [{ op: "member-set", account: b.user, role: "owner" }]));
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let inAppend = 0;
    let allEntered!: () => void;
    const entered = new Promise<void>(resolve => { allEntered = resolve; });
    wire.beforeAppend = async () => {
      if (++inAppend === 4) allEntered();
      await blocked;
    };
    const wakes = blockers.map(b => emitter.publishCommitted(b.collection));
    try {
      await entered;
      const deferred = await prepare(f);
      expect(deferred.statusCode, deferred.body).toBe(202);
      expect(deferred.json()).toEqual({ request_id: f.request, phase: "publishing_policy" });
      const status = await app.inject({ method: "GET", url: `/v1/next/collections/${f.collection}/mode`, headers: f.headers });
      expect(status.json().change.phase).toBe("publishing_policy");
    } finally {
      wire.beforeAppend = undefined;
      release();
      await Promise.all(wakes);
    }
    // Durable outbox publishes cleanly on the next emitter drain.
    await emitter.drain();
    const afterDrain = await app.inject({ method: "GET", url: `/v1/next/collections/${f.collection}/mode`, headers: f.headers });
    expect(afterDrain.json().change.phase).toBe("finishing");

    // 2. Unrelated errors from publishCommitted are NOT masked as 202.
    const g = await fixture();
    await prepare(g); now += LOG_TOKEN_LIFETIME_MS;
    wire.failNextAppend = true;
    const err = await prepare(g);
    expect(err.statusCode, err.body).toBe(500);
    // Sanity check PolicyPublicationDeferredError type.
    expect(new PolicyPublicationDeferredError().message).toBe("policy publication deferred");
  });

  it("a later v2 advertisement unblocks the same request without resetting the floor; v1 does not", async () => {
    const f=await fixture(false); expect((await prepare(f)).statusCode).toBe(409);
    await advertiseModeCapability(db,f.b,["collection_mode_switch_v1"]);
    expect((await db.query("SELECT mode_switch_advertised FROM next_devices WHERE id=$1",[f.b])).rows[0].mode_switch_advertised).toBe(false);
    const stillBlocked=await prepare(f);
    expect(stillBlocked.statusCode).toBe(409); expect(stillBlocked.json().devices).toEqual([f.b]);
    await advertiseModeCapability(db,f.b,[MODE_SWITCH_CAPABILITY]);
    expect((await prepare(f)).json().phase).toBe("waiting_for_token_expiry"); const first=await floor(f);
    await advertiseModeCapability(db,f.b,[]); expect(await floor(f)).toEqual(first);
    expect((await db.query("SELECT mode_switch_advertised FROM next_devices WHERE id=$1",[f.b])).rows[0].mode_switch_advertised).toBe(true);
  });
});
