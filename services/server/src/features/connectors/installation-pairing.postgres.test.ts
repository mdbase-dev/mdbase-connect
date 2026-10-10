import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { randomToken, tokenHash } from "../../security.js";
import { pruneUsageHistory } from "../../usage-report.js";
import { registerErrorHandler } from "../../platform/error-handler.js";
import { connectorFromRequest, requireInstallationDeviceConnector } from "../../platform/request-authentication.js";
import { clientFingerprint, deviceRegistrationDigest } from "../next/devices.js";
import { ed25519RawPublicKey } from "../next/policy-keys.js";
import { registerNextDeviceRoutes } from "../next/device-routes.js";
import { registerApplicationManifest } from "../../manifest.js";
import { upsertApplication } from "../applications/store.js";
import { registerConnectorPairingRoutes } from "./pairing-routes.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const webOrigin = "https://lab.tasknotes-app.pages.dev";
const tasknotesId = "5cdfa020-c201-4da8-845a-f2cc9969eade";
const apps = new Map<string, {name: string; web: string; mobile: string}>([[tasknotesId, {name: "TaskNotes", web: webOrigin, mobile: "capacitor://app.tasknotes.dev"}]]);
const rawX = () => (generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("hex");
const publicOutcome = (body: Record<string, unknown>) => { const {token: _token, ...result} = body; return result; };

describePg("installation device sign-in on daemon pairing", () => {
  let db: DatabasePool;
  let admin: pg.Pool;
  let schema: string;
  const app = Fastify();
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Requires dedicated local test Postgres.");
    schema = `installation_pairing_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    await app.register(cookie);
    registerErrorHandler(app);
    registerConnectorPairingRoutes(app, { db, publicUrl: "https://connect.test", installationDevices: true, installationEnvironment: "lab" });
    registerNextDeviceRoutes(app, { db, log: { controlItemAt: async () => null } });
    app.get("/test/installation-scope", async (request, reply) => {
      const identity = await requireInstallationDeviceConnector(request, reply, db);
      if (!identity) return reply;
      return identity;
    });
    app.get("/test/controller-scope", async (request, reply) => {
      const identity = await connectorFromRequest(request, db);
      return identity ?? reply.code(401).send({ error: "invalid_controller" });
    });
  }, 60_000);
  afterAll(async () => {
    await app.close(); await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });
  async function registeredApp(family: string) {
    const id=randomUUID(), web=`https://app-${id}.example.test`, mobile=`capacitor://app-${id}.example.test`;
    apps.set(id,{name:"Independent Notes",web,mobile});
    await db.query("INSERT INTO applications(id,canonical_identity,family_identity,name,homepage,redirect_uris,installation_origins) VALUES($1,$2,$3,$4,$5,'[]',$6)",[id,randomUUID(),family,"Independent Notes",web,JSON.stringify({lab:{"app-runtime":[web],mobile:[mobile]}})]);
    return id;
  }
  it("registers TaskNotes as ordinary data; manifest upserts cannot expand installation origins", async () => {
    const seeded=(await db.query("SELECT * FROM applications WHERE id=$1",[tasknotesId])).rows[0];
    expect(seeded.installation_origins.lab["app-runtime"]).toEqual([webOrigin,"http://127.0.0.1:48218"]);
    expect(seeded.application_declaration.name).toBe("TaskNotes");
    const discovered=registerApplicationManifest(seeded.application_declaration);
    expect(discovered.digest).toBe(seeded.manifest_digest); expect(discovered.canonicalIdentity).toBe(seeded.canonical_identity);
    expect((await upsertApplication(db,discovered)).id).toBe(tasknotesId);
    expect((await db.query("SELECT installation_origins FROM applications WHERE id=$1",[tasknotesId])).rows[0].installation_origins).toEqual(seeded.installation_origins);
  });
  it("rejects non-object installation origin configuration in real PostgreSQL", async () => {
    for (const value of ["null", "[]", '"origin"', "3", "true"]) {
      await expect(db.query("UPDATE applications SET installation_origins=$2::jsonb WHERE id=$1",[tasknotesId,value])).rejects.toMatchObject({code:"23514"});
    }
    await expect(db.query("UPDATE applications SET installation_origins=NULL WHERE id=$1",[tasknotesId])).rejects.toMatchObject({code:"23502"});
    expect((await db.query("SELECT installation_origins FROM applications WHERE id=$1",[tasknotesId])).rows[0].installation_origins.lab["app-runtime"]).toEqual([webOrigin,"http://127.0.0.1:48218"]);
  });
  it("old LAB aliases refuse START and reconsent without mutating the original registered credential", async () => {
    const p=await prepared(); expect((await approveDevice(p.flow,p.owner)).statusCode).toBe(200);
    const paired=(await p.flow.exchange()).json();
    for (const alias of ["tasknotes-web","tasknotes-mobile"]) {
      const input=original(); input.installation.app_id=alias;
      for (const reconsent of [false,true]) {
        const payload={...input,installation:{...input.installation,reconsent,installation_id:reconsent?p.input.installation.installation_id:input.installation.installation_id,device_id:reconsent?p.input.installation.device_id:input.installation.device_id}};
        const result=await app.inject({method:"POST",url:"/v1/pairing-requests",headers:{origin:webOrigin,...(reconsent?{authorization:`Bearer ${paired.token}`}:{})},payload});
        expect(result.statusCode).toBe(403); expect(result.json().error.code).toBe("installation_app_not_allowed");
      }
      expect((await db.query("SELECT id FROM pairing_requests WHERE id=$1",[input.installation.request_id])).rows).toEqual([]);
    }
    expect(tokenHash((await p.flow.exchange()).json().token)).toBe(tokenHash(paired.token));
    expect((await db.query("SELECT app_id FROM installation_device_credentials WHERE connector_id=$1",[p.selected.connector_id])).rows[0].app_id).toBe(tasknotesId);
  });
  it("pairs a separately registered app with a different name and origin, without brand logic", async () => {
    const appId=await registeredApp("bundle:another.independent.app"), f=await prepared("app-runtime",false,undefined,undefined,appId);
    expect(f.selected.app_id).toBe(appId); expect(f.selected.app_origin).toBe(apps.get(appId)!.web);
    expect((await approveDevice(f.flow,f.owner)).statusCode).toBe(200);
    const paired=(await f.flow.exchange()).json(); expect(paired.status).toBe("paired"); expect(paired.connector.name).toBe("Independent Notes");
  });
  async function account() {
    const user = randomUUID(), session = randomUUID(), token = randomToken("session");
    await db.query("INSERT INTO users(id,email,name,account_backend) VALUES($1,$2,'Owner','next')", [user, `${user}@example.test`]);
    await db.query("INSERT INTO sessions(id,user_id,token_hash,provider,account_session_epoch,expires_at) VALUES($1,$2,$3,'password',(SELECT session_epoch FROM users WHERE id=$2),now()+interval '1 hour')", [session, user, tokenHash(token)]);
    return { user, session, headers: { cookie: `mdbase_session=${token}` } };
  }
  function original(kind: "app-runtime" | "mobile" = "app-runtime") {
    return { connector_name: "Caller-supplied name is not app identity", installation: { request_id: randomUUID(), pairing_secret: randomToken("pair"), installation_id: randomUUID(), device_id: randomUUID(), kind, app_id: tasknotesId, requested_create_collections:false, reconsent:false } };
  }
  type Input = ReturnType<typeof original> & {installation: ReturnType<typeof original>["installation"] & {renewal?: {request_id:string;pairing_secret:string}}};
  const originHeaders = (input:Input) => ({origin:input.installation.kind === "mobile" ? apps.get(input.installation.app_id)!.mobile : apps.get(input.installation.app_id)!.web});
  function channel(input: Input) {
    const base = `/v1/pairing-requests/${input.installation.request_id}`;
    const bearer = { authorization: `Bearer ${input.installation.pairing_secret}` };
    return { base, bearer, exchange: () => app.inject({ method: "POST", url: `${base}/exchange`, headers: bearer }) };
  }
  async function start(input: Input, origin = originHeaders(input).origin) {
    const result = await app.inject({ method: "POST", url: "/v1/pairing-requests", payload: input, headers:{origin} });
    expect(result.statusCode).toBe(201);
    expect(result.json().verification_uri).toBe(`https://connect.test/pair/${input.installation.request_id}`);
    expect(result.json().app_name).toBe(apps.get(input.installation.app_id)!.name);
    expect(result.headers["cache-control"]).toBe("no-store");
    return channel(input);
  }
  async function approveDevice(flow: ReturnType<typeof channel>, owner: Awaited<ReturnType<typeof account>>, fingerprint?:string, consent={collection_ids:[] as string[],create_collections:false}) {
    const inspected = await app.inject({method:"GET",url:flow.base,headers:owner.headers});
    return app.inject({method:"POST",url:`${flow.base}/approve`,headers:owner.headers,payload:{fingerprint:fingerprint??inspected.json().pairing?.fingerprint??"0000-0000-0000-0000",...consent}});
  }
  async function attest(input: Input, selected: Record<string, string>, privateKey = generateKeyPairSync("ed25519").privateKey) {
    const sign_pk = Buffer.from(ed25519RawPublicKey(privateKey)).toString("hex"), kem_pk = rawX(), noise_pk = rawX();
    const sig = sign(null, deviceRegistrationDigest({ challenge: Buffer.from(selected.challenge, "hex"), connectorId: selected.connector_id, deviceId: input.installation.device_id, signPk: Buffer.from(sign_pk, "hex"), kemPk: Buffer.from(kem_pk, "hex"), noisePk: Buffer.from(noise_pk, "hex") }), privateKey).toString("hex");
    const payload = { sign_pk, kem_pk, noise_pk, sig };
    const flow = channel(input);
    const result = await app.inject({ method: "POST", url: `${flow.base}/attest`, headers: flow.bearer, payload });
    return { payload, result };
  }
  async function prepared(kind: "app-runtime" | "mobile" = "app-runtime", create=false, existingOwner?:Awaited<ReturnType<typeof account>>, origin?:string, appId=tasknotesId) {
    const owner = existingOwner??await account(), input = original(kind);
    input.installation.app_id=appId;
    input.installation.requested_create_collections=create;
    const flow = await start(input, origin);
    expect((await app.inject({ method: "POST", url: `${flow.base}/select-account`, headers: owner.headers })).statusCode).toBe(200);
    const selected = (await flow.exchange()).json();
    expect(selected.status).toBe("account_selected"); expect(selected.account_id).toBe(owner.user); expect(selected.token).toBeUndefined();
    const proof = await attest(input, selected);
    expect(proof.result.statusCode).toBe(200);
    return { owner, input, flow, selected, proof };
  }
  function renewal(input:Input):Input {
    return {...input,installation:{...input.installation,request_id:randomUUID(),pairing_secret:randomToken("pair"),renewal:{request_id:input.installation.request_id,pairing_secret:input.installation.pairing_secret}}};
  }
  it("refuses legacy account selection without claiming the request or issuing a device", async () => {
    const owner = await account(), input = original(), flow = await start(input);
    await db.query("UPDATE users SET account_backend='legacy' WHERE id=$1", [owner.user]);
    const refused = await app.inject({ method: "POST", url: `${flow.base}/select-account`, headers: owner.headers });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("installation_legacy_backend");
    expect(refused.json().error.message).toMatch(/Finish migrating/);
    expect((await flow.exchange()).json()).toEqual({ status: "pending" });
    expect((await db.query("SELECT user_id FROM pairing_requests WHERE id=$1", [input.installation.request_id])).rows[0].user_id).toBeNull();
    expect((await db.query("SELECT device_id FROM installation_device_credentials WHERE pairing_id=$1", [input.installation.request_id])).rows).toEqual([]);
    await db.query("UPDATE users SET account_backend='next' WHERE id=$1", [owner.user]);
    expect((await app.inject({ method: "POST", url: `${flow.base}/select-account`, headers: owner.headers })).statusCode).toBe(200);
  });
  it("rechecks backend at attestation, approval and committed exchange replay; cancellation is still allowed", async () => {
    const f = await prepared();
    await db.query("UPDATE users SET account_backend='legacy' WHERE id=$1", [f.owner.user]);
    const attestation = await app.inject({ method: "POST", url: `${f.flow.base}/attest`, headers: f.flow.bearer, payload: f.proof.payload });
    expect(attestation.statusCode).toBe(409);
    expect(attestation.json().error.code).toBe("installation_legacy_backend");
    expect((await approveDevice(f.flow, f.owner)).json().error.code).toBe("installation_legacy_backend");
    expect((await f.flow.exchange()).json().error.code).toBe("installation_legacy_backend");
    expect((await db.query("SELECT device_id FROM installation_device_credentials WHERE pairing_id=$1", [f.input.installation.request_id])).rows).toEqual([]);
    expect((await app.inject({ method: "POST", url: `${f.flow.base}/deny`, headers: f.owner.headers })).statusCode).toBe(200);
    const paired = await prepared();
    expect((await approveDevice(paired.flow, paired.owner)).statusCode).toBe(200);
    expect((await paired.flow.exchange()).json().status).toBe("paired");
    await db.query("UPDATE users SET account_backend='legacy' WHERE id=$1", [paired.owner.user]);
    const replay = await paired.flow.exchange();
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe("installation_legacy_backend");
    expect(replay.json().token).toBeUndefined();
  });
  it.each(["app-runtime", "mobile"] as const)("preserves exact %s request through concurrent/lost committed exchange without another device", async kind => {
    const { owner, input, flow, selected, proof } = await prepared(kind);
    expect((await flow.exchange()).json().status).toBe("awaiting_approval");
    const inspected = (await app.inject({method:"GET",url:flow.base,headers:owner.headers})).json().pairing;
    expect(inspected.fingerprint).toMatch(/^[a-f0-9]{4}(?:-[a-f0-9]{4}){3}$/);
    expect(inspected.connector_name).toBe("TaskNotes"); expect(inspected.app_origin).toBe(originHeaders(input).origin);
    expect((await approveDevice(flow,owner)).statusCode).toBe(200);
    // Discard one committed reply; compare only public fields and token hashes.
    const discarded = (await flow.exchange()).json();
    const replies = await Promise.all(Array.from({ length: 4 }, () => flow.exchange()));
    for (const reply of replies) {
      expect(reply.statusCode).toBe(200); expect(publicOutcome(reply.json())).toEqual(publicOutcome(discarded)); expect(tokenHash(reply.json().token)).toBe(tokenHash(discarded.token));
    }
    expect(discarded.registration).toEqual({device_id:input.installation.device_id,sign_pk:proof.payload.sign_pk,kem_pk:proof.payload.kem_pk,noise_pk:proof.payload.noise_pk});
    expect(discarded.connector_id).toBe(selected.connector_id);
    const counts = await db.query("SELECT (SELECT count(*)::int FROM next_devices WHERE connector_id=$1) AS devices,(SELECT count(*)::int FROM installation_device_credentials WHERE connector_id=$1) AS credentials", [selected.connector_id]);
    expect(counts.rows[0]).toEqual({ devices: 1, credentials: 1 });
    expect((await db.query("SELECT kind FROM next_devices WHERE id=$1", [input.installation.device_id])).rows[0].kind).toBe(kind);
    const headers = { authorization: `Bearer ${discarded.token}` };
    expect((await app.inject({ method: "GET", url: "/test/installation-scope", headers })).json()).toEqual({ id: selected.connector_id, user_id: owner.user, installation_device_id:input.installation.device_id });
    expect((await app.inject({ method: "POST", url: "/v1/next/devices/challenge", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/test/controller-scope", headers })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/next/devices", headers, payload: {} })).statusCode).toBe(401);
    await db.query("UPDATE connectors SET revoked_at=now() WHERE id=$1", [selected.connector_id]);
    expect((await flow.exchange()).statusCode).toBe(403); expect((await app.inject({ method: "GET", url: "/test/installation-scope", headers })).statusCode).toBe(401);
  });
  it("rejects unknown/missing/foreign Origin and app ID at START before creating any request", async () => {
    const input = original();
    for (const origin of [undefined,"https://untrusted.example","https://app.tasknotes.dev","null"]) {
      const result = await app.inject({method:"POST",url:"/v1/pairing-requests",payload:input,headers:origin?{origin}:{}});
      expect(result.statusCode).toBe(403);
    }
    expect((await app.inject({method:"POST",url:"/v1/pairing-requests",payload:{...input,installation:{...input.installation,app_id:"third-party"}},headers:{origin:webOrigin}})).statusCode).toBe(403);
    expect((await db.query("SELECT id FROM pairing_requests WHERE id=$1",[input.installation.request_id])).rows).toEqual([]);
  });
  it("refuses approval before native attestation, wrong account and wrong secret", async () => {
    const owner = await account(), other = await account(), input = original(), flow = await start(input);
    expect((await flow.exchange()).json()).toEqual({ status: "pending" });
    expect((await approveDevice(flow,owner)).statusCode).toBe(409);
    expect((await app.inject({method:"POST",url:`${flow.base}/select-account`,headers:owner.headers})).statusCode).toBe(200);
    expect((await app.inject({method:"POST",url:`${flow.base}/select-account`,headers:other.headers})).statusCode).toBe(403);
    expect((await app.inject({method:"POST",url:`${flow.base}/exchange`,headers:{authorization:`Bearer ${randomToken("pair")}`}})).statusCode).toBe(404);
    expect((await approveDevice(flow,owner)).statusCode).toBe(409);
    expect((await db.query("SELECT id FROM next_devices WHERE id=$1",[input.installation.device_id])).rows).toEqual([]);
  });
  it("rejects original kind/installation/device/secret drift; caller name never supplies app identity", async () => {
    const input = original(); await start(input);
    for (const field of ["kind","installation_id","device_id","pairing_secret"] as const) {
      const changed = {...input,installation:{...input.installation,[field]:field==="kind"?"mobile":field==="pairing_secret"?randomToken("pair"):randomUUID()}};
      const reply = await app.inject({method:"POST",url:"/v1/pairing-requests",payload:changed,headers:originHeaders(input)});
      expect([403,404,409]).toContain(reply.statusCode);
    }
    const renamed = await app.inject({method:"POST",url:"/v1/pairing-requests",payload:{...input,connector_name:"Unverified name"},headers:originHeaders(input)});
    expect(renamed.statusCode).toBe(201); expect(renamed.json().app_name).toBe("TaskNotes");
  });
  it("attestation is exact-key/signature idempotent and substituted keys refuse", async () => {
    const {input,flow,selected,proof} = await prepared();
    expect((await app.inject({method:"POST",url:`${flow.base}/attest`,headers:flow.bearer,payload:proof.payload})).statusCode).toBe(200);
    expect((await attest(input,selected)).result.statusCode).toBe(409);
    expect((await app.inject({method:"POST",url:`${flow.base}/attest`,headers:flow.bearer,payload:{...proof.payload,sig:"00".repeat(64)}})).statusCode).toBe(400);
    expect((await db.query("SELECT sign_pk FROM installation_device_pairings WHERE pairing_id=$1",[input.installation.request_id])).rows[0].sign_pk.toString("hex")).toBe(proof.payload.sign_pk);
  });
  it("approval binds the displayed fingerprint and extends a nearly-expired approval window", async () => {
    const {owner,input,flow,proof} = await prepared();
    expect((await approveDevice(flow,owner,"0000-0000-0000-0000")).statusCode).toBe(403);
    expect((await db.query("SELECT approved_at FROM pairing_requests WHERE id=$1",[input.installation.request_id])).rows[0].approved_at).toBeNull();
    await db.query("UPDATE pairing_requests SET expires_at=now()+interval '2 seconds' WHERE id=$1",[input.installation.request_id]);
    expect((await approveDevice(flow,owner,clientFingerprint(Buffer.from(proof.payload.sign_pk,"hex")))).statusCode).toBe(200);
    const expiry = (await db.query("SELECT expires_at FROM pairing_requests WHERE id=$1",[input.installation.request_id])).rows[0].expires_at;
    expect(new Date(expiry).getTime()-Date.now()).toBeGreaterThan(9*60_000);
    expect((await flow.exchange()).statusCode).toBe(200);
  });
  it.each(["expired","denied"])("explicitly renews a %s window with the same attested actor and new window only", async state => {
    const {owner,input,flow,proof,selected} = await prepared();
    if (state==="denied") expect((await app.inject({method:"POST",url:`${flow.base}/deny`,headers:owner.headers})).statusCode).toBe(200);
    else await db.query("UPDATE pairing_requests SET expires_at=now()-interval '1 minute' WHERE id=$1",[input.installation.request_id]);
    const next = renewal(input);
    const freshWithoutOriginal = {...next,installation:{...next.installation,renewal:undefined}};
    expect((await app.inject({method:"POST",url:"/v1/pairing-requests",payload:freshWithoutOriginal,headers:originHeaders(input)})).statusCode).toBe(409);
    const renewed = await start(next);
    if (state === "denied") {
      expect((await renewed.exchange()).json()).toEqual({status:"pending"});
      const inspected = await app.inject({method:"GET",url:renewed.base,headers:owner.headers});
      expect(inspected.json().pairing.account_selected).toBe(false);
      expect((await approveDevice(renewed,owner,clientFingerprint(Buffer.from(proof.payload.sign_pk,"hex")))).statusCode).toBe(409);
      const other = await account();
      expect((await app.inject({method:"POST",url:`${renewed.base}/select-account`,headers:other.headers})).statusCode).toBe(403);
      expect((await renewed.exchange()).json()).toEqual({status:"pending"});
      expect((await db.query("SELECT account_selected_at FROM installation_device_pairings WHERE pairing_id=$1",[next.installation.request_id])).rows[0].account_selected_at).toBeNull();
      expect((await app.inject({method:"POST",url:`${renewed.base}/select-account`,headers:owner.headers})).statusCode).toBe(200);
    }
    const outcome = (await renewed.exchange()).json();
    expect(outcome.status).toBe("awaiting_approval"); expect(outcome.connector_id).toBe(selected.connector_id); expect(outcome.account_id).toBe(owner.user); expect(outcome.challenge).toBe(selected.challenge);
    expect((await flow.exchange()).statusCode).toBe(404);
    expect((await attest(next,outcome)).result.statusCode).toBe(409);
    expect((await approveDevice(renewed,owner,clientFingerprint(Buffer.from(proof.payload.sign_pk,"hex")))).statusCode).toBe(200);
    expect((await renewed.exchange()).json().registration).toEqual({device_id:input.installation.device_id,sign_pk:proof.payload.sign_pk,kem_pk:proof.payload.kem_pk,noise_pk:proof.payload.noise_pk});
    const counts = await db.query("SELECT count(*)::int AS n FROM next_devices WHERE connector_id=$1",[selected.connector_id]); expect(counts.rows[0].n).toBe(1);
    expect((await app.inject({method:"POST",url:"/v1/pairing-requests",payload:renewal(next),headers:originHeaders(input)})).statusCode).toBe(409);
  });
  it("concurrent closed-window renewal has one successor; wrong previous capability or binding cannot replace the actor", async () => {
    const {input} = await prepared();
    await db.query("UPDATE pairing_requests SET expires_at=now()-interval '1 minute' WHERE id=$1",[input.installation.request_id]);
    const next = renewal(input), wrongSecret = {...next,installation:{...next.installation,renewal:{request_id:input.installation.request_id,pairing_secret:randomToken("pair")}}};
    expect((await app.inject({method:"POST",url:"/v1/pairing-requests",payload:wrongSecret,headers:originHeaders(input)})).statusCode).toBe(404);
    const wrongBinding = {...next,installation:{...next.installation,device_id:randomUUID()}};
    expect((await app.inject({method:"POST",url:"/v1/pairing-requests",payload:wrongBinding,headers:originHeaders(input)})).statusCode).toBe(409);
    const results = await Promise.all([renewal(input),renewal(input)].map(payload=>app.inject({method:"POST",url:"/v1/pairing-requests",payload,headers:originHeaders(input)})));
    expect(results.map(r=>r.statusCode).sort()).toEqual([201,409]);
  });
  it("daily retention keeps consumed installations, while credential lifetime also survives independent window deletion", async () => {
    const {owner,input,flow,selected} = await prepared(); expect((await approveDevice(flow,owner)).statusCode).toBe(200);
    const outcome = (await flow.exchange()).json(), headers = {authorization:`Bearer ${outcome.token}`};
    const old = original(), stale = await start(old); await db.query("UPDATE pairing_requests SET expires_at=now()-interval '400 days' WHERE id=$1",[old.installation.request_id]);
    const pruned = await pruneUsageHistory(db,new Date(Date.now()+400*86_400_000)); expect(pruned.pairing_requests).toBeGreaterThan(0);
    expect((await app.inject({method:"GET",url:"/test/installation-scope",headers})).statusCode).toBe(200);
    expect((await app.inject({method:"POST",url:"/v1/next/devices/challenge",headers})).statusCode).toBe(200);
    expect((await flow.exchange()).statusCode).toBe(200); expect((await stale.exchange()).statusCode).toBe(404);
    await db.query("DELETE FROM pairing_requests WHERE id=$1",[input.installation.request_id]);
    expect((await app.inject({method:"GET",url:"/test/installation-scope",headers})).statusCode).toBe(200);
    expect((await db.query("SELECT count(*)::int AS n FROM installation_device_credentials WHERE connector_id=$1",[selected.connector_id])).rows[0].n).toBe(1);
    await db.query("UPDATE connectors SET revoked_at=now() WHERE id=$1",[selected.connector_id]);
    expect((await app.inject({method:"GET",url:"/test/installation-scope",headers})).statusCode).toBe(401);
  });
  it("denial, expired pending, session revocation, suspension and strict mode cannot issue credentials", async () => {
    const {owner,input,flow} = await prepared(); expect((await app.inject({method:"POST",url:`${flow.base}/deny`,headers:owner.headers})).statusCode).toBe(200);
    expect((await flow.exchange()).statusCode).toBe(404); expect((await app.inject({method:"POST",url:"/v1/pairing-requests",payload:input,headers:originHeaders(input)})).statusCode).toBe(404);
    const expired = original(), exp = await start(expired); await db.query("UPDATE pairing_requests SET expires_at=now()-interval '1 minute' WHERE id=$1",[expired.installation.request_id]); expect((await exp.exchange()).statusCode).toBe(404);
    const revoked = await prepared(); await db.query("UPDATE sessions SET revoked_at=now() WHERE id=$1",[revoked.owner.session]); expect((await approveDevice(revoked.flow,revoked.owner)).statusCode).toBe(401);
    await db.query("UPDATE users SET suspended_at=now() WHERE id=$1",[revoked.owner.user]); expect((await revoked.flow.exchange()).statusCode).toBe(403);
    const strict = await account(), strictInput=original(), strictFlow=await start(strictInput); await db.query("INSERT INTO next_account_keys(user_id,mode,version) VALUES($1,'strict',1)",[strict.user]);
    expect((await app.inject({method:"POST",url:`${strictFlow.base}/select-account`,headers:strict.headers})).statusCode).toBe(403);
    const transition = await prepared(); expect((await approveDevice(transition.flow,transition.owner)).statusCode).toBe(200); await db.query("INSERT INTO next_account_keys(user_id,mode,version) VALUES($1,'strict',1)",[transition.owner.user]); expect((await transition.flow.exchange()).statusCode).toBe(403);
  });
  async function scopeCollection(owner:string, member=owner) {
    const collection=randomUUID();
    await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'next','cloud_copy',$3)",[collection,owner,Buffer.alloc(32)]);
    const batch=(await db.query("INSERT INTO next_policy_batches(collection_id,seq,prev,item,issued_at,state) VALUES($1,1,$2,$3,1,'appended') RETURNING id",[collection,Buffer.alloc(32),Buffer.alloc(1)])).rows[0].id;
    const ops=[{op:"member-set",account:owner,role:"owner"},...(member===owner?[]:[{op:"member-set",account:member,role:"editor"}])];
    await db.query("INSERT INTO next_policy_outbox(collection_id,ops,batch_id) VALUES($1,$2,$3)",[collection,JSON.stringify({version:1,ops}),batch]);
    return collection;
  }
  it("persists only explicit UUIDs/create consent and refuses changed or undeclared approval",async()=>{
    const p=await prepared(); const approved=await scopeCollection(p.owner.user), other=await scopeCollection(p.owner.user);
    expect((await approveDevice(p.flow,p.owner,undefined,{collection_ids:[approved],create_collections:true})).statusCode).toBe(400);
    expect((await approveDevice(p.flow,p.owner,undefined,{collection_ids:[approved],create_collections:false})).statusCode).toBe(200);
    expect((await approveDevice(p.flow,p.owner,undefined,{collection_ids:[other],create_collections:false})).statusCode).toBe(409);
    const result=await p.flow.exchange(); expect(result.statusCode,result.body).toBe(200);
    expect(result.json()).toMatchObject({collection_ids:[approved],create_collections:false});
    expect((await db.query("SELECT collection_id FROM installation_collection_scopes WHERE connector_id=$1",[p.selected.connector_id])).rows).toEqual([{collection_id:approved}]);
    expect((await db.query("SELECT create_collections FROM installation_device_credentials WHERE connector_id=$1",[p.selected.connector_id])).rows[0].create_collections).toBe(false);
  });
  it("refuses foreign/private/left UUID approval and membership lost before exchange without issuing credentials",async()=>{
    const p=await prepared(), other=await account(); const foreign=await scopeCollection(other.user), priv=await scopeCollection(p.owner.user), left=await scopeCollection(p.owner.user);
    await db.query("UPDATE next_collections SET sync='private' WHERE collection_id=$1",[priv]);
    await db.query("UPDATE next_collections SET left_sync_at=now() WHERE collection_id=$1",[left]);
    for (const id of [foreign,priv,left,randomUUID()]) expect((await approveDevice(p.flow,p.owner,undefined,{collection_ids:[id],create_collections:false})).statusCode).toBeGreaterThanOrEqual(400);
    const member=await scopeCollection(other.user,p.owner.user);
    expect((await approveDevice(p.flow,p.owner,undefined,{collection_ids:[member],create_collections:false})).statusCode).toBe(200);
    await db.query("INSERT INTO next_policy_outbox(collection_id,ops) VALUES($1,$2)",[member,JSON.stringify({version:1,ops:[{op:"member-remove",account:p.owner.user}]})]);
    expect((await p.flow.exchange()).statusCode).toBe(409);
    expect((await db.query("SELECT connector_id FROM installation_device_credentials WHERE connector_id=$1",[p.selected.connector_id])).rows).toEqual([]);
  });
  async function rescope(p:Awaited<ReturnType<typeof prepared>>,token:string,create=false,origin=originHeaders(p.input).origin) {
    const input={...p.input,installation:{...p.input.installation,request_id:randomUUID(),pairing_secret:randomToken("pair"),reconsent:true,requested_create_collections:create}};
    const result=await app.inject({method:"POST",url:"/v1/pairing-requests",headers:{origin,authorization:`Bearer ${token}`},payload:input});
    expect(result.statusCode,result.body).toBe(201);
    return {input,flow:channel(input)};
  }
  it("emits explicit account/email confirmation only for the authenticated original request",async()=>{
    const owner=await account(),input=original(),flow=await start(input);
    expect((await flow.exchange()).json()).toEqual({status:"pending"});
    const inspected=(await app.inject({method:"GET",url:flow.base,headers:owner.headers})).json().pairing;
    expect(inspected.signed_in_account_email).toBe(`${owner.user}@example.test`);
    expect(inspected.account_selection_confirmed).toBeUndefined();
    expect((await app.inject({method:"POST",url:`${flow.base}/select-account`})).statusCode).toBe(401);
    expect((await app.inject({method:"POST",url:`${flow.base}/select-account`,headers:owner.headers})).statusCode).toBe(200);
    const selected=(await flow.exchange()).json();
    expect(selected).toMatchObject({request_id:input.installation.request_id,account_id:owner.user,account_email:`${owner.user}@example.test`,account_selection_confirmed:true});
    await db.query("UPDATE users SET email=$2 WHERE id=$1",[owner.user,`${owner.user}+changed@example.test`]);
    expect((await flow.exchange()).json().account_email).toBe(selected.account_email);
    expect((await db.query("SELECT portal_account_session_id FROM installation_device_pairings WHERE pairing_id=$1",[input.installation.request_id])).rows[0].portal_account_session_id).toBe(owner.session);
  });
  it("does not promote inherited renewal selection to exact-request portal confirmation",async()=>{
    const p=await prepared();
    await db.query("UPDATE pairing_requests SET expires_at=now()-interval '1 minute' WHERE id=$1",[p.input.installation.request_id]);
    const next=renewal(p.input),flow=await start(next),receipt=(await flow.exchange()).json();
    expect(receipt).toMatchObject({status:"awaiting_approval",account_id:p.owner.user,challenge:p.selected.challenge,connector_id:p.selected.connector_id});
    expect(receipt.account_selection_confirmed).toBeUndefined();
    expect(receipt.account_email).toBeUndefined();
    expect((await app.inject({method:"POST",url:`${flow.base}/select-account`,headers:p.owner.headers})).statusCode).toBe(200);
    expect((await flow.exchange()).json()).toMatchObject({request_id:next.installation.request_id,account_selection_confirmed:true,account_email:p.selected.account_email});
  });
  it("preserves manual legacy receipts without inferring confirmation from account_selected_at",async()=>{
    const p=await prepared(),collection=await scopeCollection(p.owner.user);
    await db.query("UPDATE installation_device_pairings SET portal_account_confirmed_at=NULL,portal_account_email=NULL,portal_account_session_id=NULL,portal_account_session_epoch=NULL WHERE pairing_id=$1",[p.input.installation.request_id]);
    expect((await p.flow.exchange()).json().account_selection_confirmed).toBeUndefined();
    const picked=await app.inject({method:"POST",url:`${p.flow.base}/approve`,headers:p.owner.headers,payload:{fingerprint:clientFingerprint(Buffer.from(p.proof.payload.sign_pk,"hex")),collection_ids:[collection],selected_collection_id:collection}});
    expect(picked.statusCode).toBe(403);
    expect((await approveDevice(p.flow,p.owner)).statusCode).toBe(200);
    const receipt=(await p.flow.exchange()).json();
    expect(receipt.status).toBe("paired");
    for(const field of ["account_email","account_selection_confirmed","selected_collection_id","created_collection_ids"]) expect(receipt[field]).toBeUndefined();
    expect((await app.inject({method:"POST",url:`${p.flow.base}/select-account`,headers:p.owner.headers})).statusCode).toBe(409);
  });
  async function approvePicked(p:Awaited<ReturnType<typeof prepared>>,flow:ReturnType<typeof channel>,ids:string[],selected:string) {
    return app.inject({method:"POST",url:`${flow.base}/approve`,headers:p.owner.headers,payload:{fingerprint:clientFingerprint(Buffer.from(p.proof.payload.sign_pk,"hex")),collection_ids:ids,selected_collection_id:selected}});
  }
  it("binds final existing-collection selection to the exact approved subset and stable receipt",async()=>{
    const p=await prepared(),selected=await scopeCollection(p.owner.user),other=await scopeCollection(p.owner.user);
    expect((await approvePicked(p,p.flow,[other],selected)).statusCode).toBe(400);
    expect((await approvePicked(p,p.flow,[selected],selected)).statusCode).toBe(200);
    expect((await approvePicked(p,p.flow,[selected],other)).statusCode).toBe(409);
    const receipt=(await p.flow.exchange()).json();
    expect(receipt).toMatchObject({request_id:p.input.installation.request_id,account_selection_confirmed:true,selected_collection_id:selected,created_collection_ids:[],collection_ids:[selected]});
    expect(publicOutcome((await p.flow.exchange()).json())).toEqual(publicOutcome(receipt));
  });
  it("requires independent reconsent confirmation and never borrows the initial receipt's provenance",async()=>{
    const p=await prepared(),first=await scopeCollection(p.owner.user),added=await scopeCollection(p.owner.user);
    expect((await approvePicked(p,p.flow,[first],first)).statusCode).toBe(200);
    const initial=(await p.flow.exchange()).json(),next=await rescope(p,initial.token);
    expect((await next.flow.exchange()).json().account_selection_confirmed).toBeUndefined();
    expect((await approvePicked(p,next.flow,[added],added)).statusCode).toBe(403);
    expect((await app.inject({method:"POST",url:`${next.flow.base}/select-account`,headers:p.owner.headers})).statusCode).toBe(200);
    expect((await approvePicked(p,next.flow,[added],added)).statusCode).toBe(200);
    const receipt=(await next.flow.exchange()).json();
    expect(receipt).toMatchObject({status:"scope_updated",request_id:next.input.installation.request_id,account_selection_confirmed:true,account_email:p.selected.account_email,selected_collection_id:added,created_collection_ids:[],added_collection_ids:[added]});
    expect(receipt.token).toBeUndefined(); expect(receipt.registration).toBeUndefined();
    expect((await next.flow.exchange()).json()).toEqual(receipt);
  });
  it("refuses initial consumption after the approved account epoch changes",async()=>{
    const p=await prepared(),collection=await scopeCollection(p.owner.user);
    expect((await approvePicked(p,p.flow,[collection],collection)).statusCode).toBe(200);
    await db.query("UPDATE users SET session_epoch=session_epoch+1 WHERE id=$1",[p.owner.user]);
    expect((await p.flow.exchange()).statusCode).toBe(403);
    expect((await db.query("SELECT 1 FROM installation_device_credentials WHERE connector_id=$1",[p.selected.connector_id])).rows).toEqual([]);
  });
  it("rechecks a retained final selection without reapplying removed scope",async()=>{
    const p=await prepared(),first=await scopeCollection(p.owner.user);
    expect((await approvePicked(p,p.flow,[first],first)).statusCode).toBe(200);
    const initial=(await p.flow.exchange()).json(),next=await rescope(p,initial.token);
    expect((await app.inject({method:"POST",url:`${next.flow.base}/select-account`,headers:p.owner.headers})).statusCode).toBe(200);
    expect((await approvePicked(p,next.flow,[],first)).statusCode).toBe(200);
    await db.query("DELETE FROM installation_collection_scopes WHERE connector_id=$1 AND collection_id=$2",[p.selected.connector_id,first]);
    expect((await next.flow.exchange()).statusCode).toBe(403);
    expect((await db.query("SELECT 1 FROM installation_collection_scopes WHERE connector_id=$1 AND collection_id=$2",[p.selected.connector_id,first])).rows).toEqual([]);
  });
  it("adds scope with unchanged credential/actor even after original window deletion; lost committed replies never reapply additions",async()=>{
    const p=await prepared("mobile",true), first=await scopeCollection(p.owner.user), added=await scopeCollection(p.owner.user);
    expect((await approveDevice(p.flow,p.owner,undefined,{collection_ids:[first],create_collections:true})).statusCode).toBe(200);
    const original=(await p.flow.exchange()).json();
    await db.query("DELETE FROM pairing_requests WHERE id=$1",[p.input.installation.request_id]);
    const next=await rescope(p,original.token);
    const inspected=(await app.inject({method:"GET",url:next.flow.base,headers:p.owner.headers})).json().pairing;
    expect(inspected).toMatchObject({scope_only:true,attested:true,retained_collection_ids:[first],retained_create_collections:true,fingerprint:clientFingerprint(Buffer.from(p.proof.payload.sign_pk,"hex"))});
    expect((await next.flow.exchange()).json().status).toBe("awaiting_approval");
    expect((await approveDevice(next.flow,p.owner,undefined,{collection_ids:[added],create_collections:false})).statusCode).toBe(200);
    const responses=await Promise.all([next.flow.exchange(),next.flow.exchange()]);
    for(const response of responses){ expect(response.statusCode,response.body).toBe(200); expect(response.json()).toMatchObject({status:"scope_updated",added_collection_ids:[added],approved_create_collections:false,connector_id:p.selected.connector_id,device_id:p.input.installation.device_id}); expect(response.json().token).toBeUndefined(); expect(response.json().registration).toBeUndefined(); }
    expect((await db.query("SELECT collection_id FROM installation_collection_scopes WHERE connector_id=$1 ORDER BY collection_id",[p.selected.connector_id])).rows.map(r=>r.collection_id)).toEqual([first,added].sort());
    expect((await db.query("SELECT create_collections FROM installation_device_credentials WHERE connector_id=$1",[p.selected.connector_id])).rows[0].create_collections).toBe(true);
    await db.query("DELETE FROM installation_collection_scopes WHERE connector_id=$1 AND collection_id=$2",[p.selected.connector_id,added]);
    expect((await next.flow.exchange()).statusCode).toBe(200);
    expect((await db.query("SELECT 1 FROM installation_collection_scopes WHERE connector_id=$1 AND collection_id=$2",[p.selected.connector_id,added])).rows).toEqual([]);
    expect((await app.inject({method:"POST",url:"/v1/next/devices/challenge",headers:{authorization:`Bearer ${original.token}`}})).statusCode).toBe(200);
    expect((await db.query("SELECT count(*)::int AS n FROM next_devices WHERE connector_id=$1",[p.selected.connector_id])).rows[0].n).toBe(1);
  });
  it("preserves the approved LAB loopback binding through initial/additive consent and explicit removal",async()=>{
    const origin="http://127.0.0.1:48218", p=await prepared("app-runtime",true,undefined,origin);
    const first=await scopeCollection(p.owner.user), added=await scopeCollection(p.owner.user);
    const inspected=(await app.inject({method:"GET",url:p.flow.base,headers:p.owner.headers})).json().pairing;
    expect(inspected).toMatchObject({app_origin:origin,app_id:tasknotesId,connector_name:"TaskNotes"});
    expect((await approveDevice(p.flow,p.owner,undefined,{collection_ids:[first],create_collections:true})).statusCode).toBe(200);
    const issued=await p.flow.exchange(); expect(issued.statusCode).toBe(200);
    const original=issued.json(), headers={authorization:`Bearer ${original.token}`};
    expect(publicOutcome(original)).toMatchObject({status:"paired",connector_id:p.selected.connector_id,collection_ids:[first],create_collections:true});
    expect((await app.inject({method:"POST",url:"/v1/next/devices/challenge",headers})).statusCode).toBe(200);
    expect((await app.inject({method:"GET",url:"/test/controller-scope",headers})).statusCode).toBe(401);
    const before=(await db.query("SELECT app_origin,kind,token_hash,sign_pk,kem_pk,noise_pk FROM installation_device_credentials WHERE connector_id=$1",[p.selected.connector_id])).rows[0];
    expect(before).toMatchObject({app_origin:origin,kind:"app-runtime"});
    const changed=await app.inject({method:"POST",url:"/v1/pairing-requests",headers:{origin:webOrigin},payload:p.input});
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe("installation_original_binding_changed");
    const next=await rescope(p,original.token,false,origin);
    expect((await approveDevice(next.flow,p.owner,undefined,{collection_ids:[added],create_collections:false})).statusCode).toBe(200);
    const committed=await next.flow.exchange(); expect(committed.statusCode).toBe(200);
    const replay=await next.flow.exchange(); expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(committed.json());
    expect(committed.json()).toMatchObject({status:"scope_updated",added_collection_ids:[added],approved_create_collections:false,connector_id:p.selected.connector_id,device_id:p.input.installation.device_id});
    expect(committed.json().token).toBeUndefined(); expect(committed.json().registration).toBeUndefined();
    const scopes=()=>db.query("SELECT collection_id FROM installation_collection_scopes WHERE connector_id=$1 ORDER BY collection_id",[p.selected.connector_id]);
    expect((await scopes()).rows.map(r=>r.collection_id)).toEqual([first,added].sort());
    const remove=()=>app.inject({method:"POST",url:`${next.flow.base}/remove-access`,headers:p.owner.headers,payload:{collection_id:first,confirm:true}});
    expect((await remove()).statusCode).toBe(200); expect((await remove()).statusCode).toBe(200);
    expect((await scopes()).rows.map(r=>r.collection_id)).toEqual([added]);
    expect((await p.flow.exchange()).statusCode).toBe(200); expect((await next.flow.exchange()).statusCode).toBe(200);
    expect((await scopes()).rows.map(r=>r.collection_id)).toEqual([added]);
    expect((await db.query("SELECT app_origin,kind,token_hash,sign_pk,kem_pk,noise_pk FROM installation_device_credentials WHERE connector_id=$1",[p.selected.connector_id])).rows[0]).toEqual(before);
    expect((await db.query("SELECT create_collections FROM installation_device_credentials WHERE connector_id=$1",[p.selected.connector_id])).rows[0].create_collections).toBe(true);
    expect((await db.query("SELECT count(*)::int AS n FROM next_devices WHERE connector_id=$1",[p.selected.connector_id])).rows[0].n).toBe(1);
    expect((await app.inject({method:"POST",url:"/v1/next/devices/challenge",headers})).statusCode).toBe(200);
  });
  it("re-consent requires existing exact credential and current approval epoch; denial changes no existing access",async()=>{
    const p=await prepared(); expect((await approveDevice(p.flow,p.owner)).statusCode).toBe(200); const original=(await p.flow.exchange()).json();
    const input={...p.input,installation:{...p.input.installation,request_id:randomUUID(),pairing_secret:randomToken("pair"),reconsent:true}};
    expect((await app.inject({method:"POST",url:"/v1/pairing-requests",headers:originHeaders(input),payload:input})).statusCode).toBe(401);
    expect((await app.inject({method:"POST",url:"/v1/pairing-requests",headers:{...originHeaders(input),authorization:`Bearer ${original.token}`},payload:{...input,installation:{...input.installation,device_id:randomUUID()}}})).statusCode).toBe(409);
    const next=await rescope(p,original.token,true);
    expect((await approveDevice(next.flow,p.owner,undefined,{collection_ids:[],create_collections:true})).statusCode).toBe(200);
    await db.query("UPDATE users SET session_epoch=session_epoch+1 WHERE id=$1",[p.owner.user]);
    expect((await next.flow.exchange()).statusCode).toBe(403);
    expect((await db.query("SELECT create_collections FROM installation_device_credentials WHERE connector_id=$1",[p.selected.connector_id])).rows[0].create_collections).toBe(false);
    const fresh=await account();
    expect((await approveDevice(next.flow,fresh)).statusCode).toBeGreaterThanOrEqual(400);
  });
  it("explicit Remove access revokes the app's grants and enrolled devices for one collection across its installations, atomically and idempotently",async()=>{
    const family="bundle:independent.notes.app", primary=await registeredApp(family), siblingApp=await registeredApp(family);
    const p=await prepared("mobile",true,undefined,undefined,primary),collection=await scopeCollection(p.owner.user);
    expect((await approveDevice(p.flow,p.owner,undefined,{collection_ids:[collection],create_collections:true})).statusCode).toBe(200);
    const original=(await p.flow.exchange()).json(), sibling=await prepared("app-runtime",false,p.owner,undefined,siblingApp);
    expect((await approveDevice(sibling.flow,p.owner,undefined,{collection_ids:[collection],create_collections:false})).statusCode).toBe(200);expect((await sibling.flow.exchange()).statusCode).toBe(200);
    const otherApp=await registeredApp("bundle:other.app"), other=await prepared("app-runtime",false,p.owner,undefined,otherApp);
    expect((await approveDevice(other.flow,p.owner,undefined,{collection_ids:[collection],create_collections:false})).statusCode).toBe(200);
    expect((await other.flow.exchange()).statusCode).toBe(200);
    for(const installed of [p,sibling,other]) {
      const keys=installed.proof.payload;
      const ops=[{op:"device-enrol",device:installed.input.installation.device_id,account:p.owner.user,kind:installed.input.installation.kind,signPublicKey:{$hex:keys.sign_pk},kemPublicKey:{$hex:keys.kem_pk},noisePublicKey:{$hex:keys.noise_pk}}];
      await db.query("INSERT INTO next_policy_outbox(collection_id,ops) VALUES($1,$2)",[collection,JSON.stringify({version:1,ops})]);
    }
    const local=randomUUID();
    await db.query("INSERT INTO collections(id,user_id,connector_id,local_id,display_name,spec_version) VALUES($1,$2,$3,$4,'Tasks','0.3.0')",[local,p.owner.user,p.selected.connector_id,collection]);
    async function grant(family:string,user=p.owner.user){
      const id=randomUUID(),appId=randomUUID(),log=randomUUID();
      await db.query("INSERT INTO applications(id,canonical_identity,family_identity,name,homepage,redirect_uris) VALUES($1,$2,$3,'Not trusted for identity','https://example.test','[]')",[appId,randomUUID(),family]);
      await db.query(`INSERT INTO grants(id,user_id,application_id,collection_id,operations,scope,application_installation_id,application_authorization) VALUES($1,$2,$3,$4,'["read"]','{"access":"full_collection","contracts":[]}', $5,'{"binding":{"protocol_version":4,"contracts":{"semantic_capabilities":1}}}')`,[id,user,appId,local,randomUUID()]);
      await db.query("INSERT INTO next_grant_bindings(grant_id,collection_id,log_grant_id,terms_digest) VALUES($1,$2,$3,$4)",[id,collection,log,Buffer.alloc(32)]);
      return {id,log};
    }
    const target=await grant(family), unrelated=await grant("bundle:other.app"), stranger=await account(), foreign=await grant(family,stranger.user);
    const next=await rescope(p,original.token);
    const remove=(headers=p.owner.headers,confirm=true)=>app.inject({method:"POST",url:`${next.flow.base}/remove-access`,headers,payload:{collection_id:collection,confirm}});
    expect((await remove(stranger.headers)).statusCode).toBe(403);expect((await remove(p.owner.headers,false)).statusCode).toBe(400);
    const result=await remove();expect(result.statusCode,result.body).toBe(200);expect(result.json()).toMatchObject({collection_id:collection,state:"revoking"});
    expect((await db.query("SELECT connector_id FROM installation_collection_scopes WHERE collection_id=$1",[collection])).rows).toEqual([{connector_id:other.selected.connector_id}]);
    expect((await db.query("SELECT active FROM next_grant_bindings WHERE grant_id=$1",[target.id])).rows[0].active).toBe(false);
    for(const id of [unrelated.id,foreign.id]) expect((await db.query("SELECT revoked_at FROM grants WHERE id=$1",[id])).rows[0].revoked_at).toBeNull();
    const revokes=(await db.query("SELECT ops FROM next_policy_outbox WHERE collection_id=$1 ORDER BY id",[collection])).rows.flatMap(row=>row.ops.ops).filter((op:{op:string})=>op.op.endsWith("revoke"));
    expect(revokes).toEqual([{op:"grant-revoke",grant:target.log},...([p,sibling].sort((a,b)=>a.selected.connector_id.localeCompare(b.selected.connector_id)).map(installed=>({op:"device-revoke",device:installed.input.installation.device_id})))]);
    expect((await remove()).statusCode).toBe(200);
    expect((await db.query("SELECT count(*)::int AS n FROM next_policy_outbox WHERE collection_id=$1",[collection])).rows[0].n).toBe(1+3+3);
    expect((await approveDevice(next.flow,p.owner,undefined,{collection_ids:[collection],create_collections:false})).statusCode).toBe(409);
    expect((await db.query("SELECT create_collections FROM installation_device_credentials WHERE connector_id=$1",[p.selected.connector_id])).rows[0].create_collections).toBe(true);
    expect((await p.flow.exchange()).statusCode).toBe(200); // receipt replay cannot reapply removed scope
    expect((await db.query("SELECT connector_id FROM installation_collection_scopes WHERE collection_id=$1",[collection])).rows).toEqual([{connector_id:other.selected.connector_id}]);
  });
  it("keeps original daemon pairing response and one-shot exchange semantics", async () => {
    const owner = await account();
    const first = await app.inject({method:"POST",url:"/v1/pairing-requests",payload:{connector_name:"Desktop"}}); expect(first.statusCode).toBe(201);
    const body = first.json(), base=`/v1/pairing-requests/${body.pairing_id}`, headers={authorization:`Bearer ${body.pairing_secret}`};
    expect((await app.inject({method:"POST",url:`${base}/approve`,headers:owner.headers})).json().deep_link).toMatch(/^mdbase-connect:\/\/paired/);
    const exchange = await app.inject({method:"POST",url:`${base}/exchange`,headers}); expect(exchange.statusCode).toBe(200); expect(typeof exchange.json().token).toBe("string");
    expect((await app.inject({method:"POST",url:`${base}/exchange`,headers})).statusCode).toBe(409);
  });
});
