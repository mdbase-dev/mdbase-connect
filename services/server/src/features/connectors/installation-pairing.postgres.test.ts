import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { randomToken, tokenHash } from "../../security.js";
import { pruneUsageHistory } from "../../usage-report.js";
import { connectorFromRequest, requireInstallationDeviceConnector } from "../../platform/request-authentication.js";
import { clientFingerprint, deviceRegistrationDigest } from "../next/devices.js";
import { ed25519RawPublicKey } from "../next/policy-keys.js";
import { registerNextDeviceRoutes } from "../next/device-routes.js";
import { installationApp } from "./installation-pairing.js";
import { registerConnectorPairingRoutes } from "./pairing-routes.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const webOrigin = "https://lab.tasknotes-app.pages.dev";
const rawX = () => (generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("hex");
const publicOutcome = (body: Record<string, unknown>) => { const {token: _token, ...result} = body; return result; };

describe("first-party installation identity map", () => {
  it("uses fixed environment origins and native schemes, never a caller URL or missing Origin", () => {
    expect(installationApp("lab", "tasknotes-web", webOrigin, "app-runtime")).toEqual({id:"tasknotes-web",origin:webOrigin,name:"TaskNotes"});
    expect(installationApp("production", "tasknotes-mobile", "capacitor://app.tasknotes.dev", "mobile").name).toBe("TaskNotes");
    for (const [environment,app,origin,kind] of [
      ["lab","tasknotes-web","https://app.tasknotes.dev","app-runtime"],
      ["production","tasknotes-web",webOrigin,"app-runtime"],
      ["lab","unknown",webOrigin,"app-runtime"],
      ["lab","tasknotes-web","https://untrusted.example","app-runtime"],
      ["lab","tasknotes-web",undefined,"app-runtime"],
      [undefined,"tasknotes-web",webOrigin,"app-runtime"],
      ["__proto__","tasknotes-web",webOrigin,"app-runtime"],
      ["lab","tasknotes-mobile","null","mobile"],
      ["lab","tasknotes-web",webOrigin,"mobile"],
    ] as const) expect(() => installationApp(environment,app,origin,kind)).toThrow();
  });
});

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
  async function account() {
    const user = randomUUID(), session = randomUUID(), token = randomToken("session");
    await db.query("INSERT INTO users(id,email,name,account_backend) VALUES($1,$2,'Owner','next')", [user, `${user}@example.test`]);
    await db.query("INSERT INTO sessions(id,user_id,token_hash,provider,account_session_epoch,expires_at) VALUES($1,$2,$3,'password',(SELECT session_epoch FROM users WHERE id=$2),now()+interval '1 hour')", [session, user, tokenHash(token)]);
    return { user, session, headers: { cookie: `mdbase_session=${token}` } };
  }
  function original(kind: "app-runtime" | "mobile" = "app-runtime") {
    return { connector_name: "Caller-supplied name is not app identity", installation: { request_id: randomUUID(), pairing_secret: randomToken("pair"), installation_id: randomUUID(), device_id: randomUUID(), kind, app_id: kind === "mobile" ? "tasknotes-mobile" : "tasknotes-web" } };
  }
  type Input = ReturnType<typeof original> & {installation: ReturnType<typeof original>["installation"] & {renewal?: {request_id:string;pairing_secret:string}}};
  const originHeaders = (input:Input) => ({origin:input.installation.kind === "mobile" ? "capacitor://app.tasknotes.dev" : webOrigin});
  function channel(input: Input) {
    const base = `/v1/pairing-requests/${input.installation.request_id}`;
    const bearer = { authorization: `Bearer ${input.installation.pairing_secret}` };
    return { base, bearer, exchange: () => app.inject({ method: "POST", url: `${base}/exchange`, headers: bearer }) };
  }
  async function start(input: Input) {
    const result = await app.inject({ method: "POST", url: "/v1/pairing-requests", payload: input, headers:originHeaders(input) });
    expect(result.statusCode).toBe(201);
    expect(result.json().verification_uri).toBe(`https://connect.test/pair/${input.installation.request_id}`);
    expect(result.json().app_name).toBe("TaskNotes");
    expect(result.headers["cache-control"]).toBe("no-store");
    return channel(input);
  }
  async function approveDevice(flow: ReturnType<typeof channel>, owner: Awaited<ReturnType<typeof account>>, fingerprint?:string) {
    const inspected = await app.inject({method:"GET",url:flow.base,headers:owner.headers});
    return app.inject({method:"POST",url:`${flow.base}/approve`,headers:owner.headers,payload:{fingerprint:fingerprint??inspected.json().pairing?.fingerprint??"0000-0000-0000-0000"}});
  }
  async function attest(input: Input, selected: Record<string, string>, privateKey = generateKeyPairSync("ed25519").privateKey) {
    const sign_pk = Buffer.from(ed25519RawPublicKey(privateKey)).toString("hex"), kem_pk = rawX(), noise_pk = rawX();
    const sig = sign(null, deviceRegistrationDigest({ challenge: Buffer.from(selected.challenge, "hex"), connectorId: selected.connector_id, deviceId: input.installation.device_id, signPk: Buffer.from(sign_pk, "hex"), kemPk: Buffer.from(kem_pk, "hex"), noisePk: Buffer.from(noise_pk, "hex") }), privateKey).toString("hex");
    const payload = { sign_pk, kem_pk, noise_pk, sig };
    const flow = channel(input);
    const result = await app.inject({ method: "POST", url: `${flow.base}/attest`, headers: flow.bearer, payload });
    return { payload, result };
  }
  async function prepared(kind: "app-runtime" | "mobile" = "app-runtime") {
    const owner = await account(), input = original(kind), flow = await start(input);
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
    expect((await app.inject({ method: "GET", url: "/test/installation-scope", headers })).json()).toEqual({ id: selected.connector_id, user_id: owner.user });
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
  it("keeps original daemon pairing response and one-shot exchange semantics", async () => {
    const owner = await account();
    const first = await app.inject({method:"POST",url:"/v1/pairing-requests",payload:{connector_name:"Desktop"}}); expect(first.statusCode).toBe(201);
    const body = first.json(), base=`/v1/pairing-requests/${body.pairing_id}`, headers={authorization:`Bearer ${body.pairing_secret}`};
    expect((await app.inject({method:"POST",url:`${base}/approve`,headers:owner.headers})).json().deep_link).toMatch(/^mdbase-connect:\/\/paired/);
    const exchange = await app.inject({method:"POST",url:`${base}/exchange`,headers}); expect(exchange.statusCode).toBe(200); expect(typeof exchange.json().token).toBe("string");
    expect((await app.inject({method:"POST",url:`${base}/exchange`,headers})).statusCode).toBe(409);
  });
});
