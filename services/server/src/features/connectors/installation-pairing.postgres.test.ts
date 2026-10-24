import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { deleteAccountLocally } from "../../account-management.js";
import { createExternalSession } from "../../external-auth.js";
import { capabilityOperationsForContractVersion, MDBASE_TIMER_FIRED_CONTRACT } from "@mdbase-dev/connect-protocol";
import { createTestApplicationIdentity, testApplicationAuthorization } from "../../application-authorization.test-helper.js";
import { clientNoiseKeyMessage, storeRequestClientNoiseKey, verifiedClientNoiseKey } from "../next/client-key.js";
import { approveNativeAuthorization } from "../authorizations/native-approval-service.js";
import { fileRequestForRequirements } from "../../application-requirements.js";
import { acceptCohortArchive, addToCohort, cohortArchiveBinding, createCohort, flipAccountBackend, flipEvidenceDigest, releaseCohort, setCohortFrozen, setPaused, startAccountMigration } from "../next/migration-rollout.js";
import { ZERO_HOSTED_ARCHIVE_SCHEMA } from "../next/migration-archive-profile.js";
import { randomToken, tokenHash } from "../../security.js";
import { pruneUsageHistory } from "../../usage-report.js";
import { registerErrorHandler } from "../../platform/error-handler.js";
import { connectorFromRequest, requireInstallationDeviceConnector } from "../../platform/request-authentication.js";
import { clientFingerprint, deviceRegistrationDigest } from "../next/devices.js";
import { certToJson, ed25519RawPublicKey, type NextControlPlaneConfig } from "../next/policy-keys.js";
import { certDigest, keyId } from "../next/policy-wire.js";
import { buildApp } from "../../app.js";
import { registerNextDeviceRoutes } from "../next/device-routes.js";
import { registerApplicationManifest } from "../../manifest.js";
import { upsertApplication } from "../applications/store.js";
import { registerConnectorPairingRoutes } from "./pairing-routes.js";
import { registerInstallationSignOutRoute } from "./installation-signout.js";
import { backgroundTimerGrantResolver, dataPermitted } from "../next/timers/grants.js";
import { registerTimerRoutes } from "../next/timers/routes.js";
import { lockNamespace } from "../next/timers/store.js";
import { TimerWorker, notificationsConsumer, timerEventId } from "../next/timers/worker.js";
import { PushTargetSealer } from "../next/push-target-seal.js";
import { buildPolicySnapshot, type LeasePolicySnapshot } from "../../relay-policy.js";
import { NotificationService, type NotificationTransports } from "../../notifications.js";
import { registerNotificationRoutes } from "../notifications/routes.js";

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
  const fenced: [string, string][] = [];
  const nativePushes: Array<{connector:string;grants:string[]}> = [];
  const policyWakes: string[] = [];
  const emitter = { publishCommitted: async (collection: string) => { policyWakes.push(collection); } };
  let acknowledgeNativePush = async () => {};
  const channelSealer = new PushTargetSealer({keyId:"synthetic",key:Buffer.alloc(32,42),previousKeys:{}});
  const transports = {webPush:{send:async()=>undefined},fcm:{send:async()=>undefined}};
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
    registerConnectorPairingRoutes(app, { db, publicUrl: "https://connect.test", installationDevices: true, installationEnvironment: "lab", relay:{pushPolicy:async(connector)=>{
      const snapshot=await buildPolicySnapshot(db,connector,55_000,undefined,()=>true,"lease_v1",true,true,true) as LeasePolicySnapshot;
      nativePushes.push({connector,grants:snapshot.grants.map(g=>String(g.id))});
      await acknowledgeNativePush();
    }}, nativePolicyEmitter: emitter });
    registerNextDeviceRoutes(app, { db, log: { controlItemAt: async () => null }, relay: { fenceConnector: async () => "closed" } });
    registerInstallationSignOutRoute(app, { db, emitter, relay: { fenceConnector: async (id, generation) => { fenced.push([id, generation]); return "closed"; } } });
    const resolver = backgroundTimerGrantResolver(db,"lab");
    registerTimerRoutes(app, { db, resolver });
    registerNotificationRoutes(app,{db,grantResolver:resolver,transports,
      service:new NotificationService(db,transports,1000,()=>undefined,channelSealer,resolver)});
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
  it("keeps TaskNotes0066 identity and legacy origins when re-registering its declaration", async () => {
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
  it("self-registers Journal without operator origins, refuses a lookalike, and keeps explicit device consent", async () => {
    const web = `https://journal-${randomUUID()}.example.test`, mobile = `capacitor://journal.example.test`;
    const discovered = registerApplicationManifest({ manifest_version: 1, id: "dev.example.journal", name: "Journal",
      homepage: `${web}/`, redirect_uris: [`${web}/callback`], requirements: { access: "full_collection", contracts: [] },
      installation_origins: { lab: { mobile: [mobile] } } });
    const registered = await upsertApplication(db, discovered);
    apps.set(registered.id, { name: "Journal", web, mobile });
    expect((await db.query("SELECT installation_origins FROM applications WHERE id=$1", [registered.id])).rows[0].installation_origins).toEqual({});
    const input = original(); input.installation.app_id = registered.id;
    const refused = await app.inject({ method: "POST", url: "/v1/pairing-requests", payload: input, headers: { origin: "https://journal-lookalike.example.test" } });
    expect(refused.statusCode).toBe(403); expect(refused.json().error.code).toBe("installation_app_not_allowed");
    expect((await db.query("SELECT id FROM pairing_requests WHERE id=$1", [input.installation.request_id])).rows).toEqual([]);
    const f = await prepared("app-runtime", false, undefined, undefined, registered.id);
    const shown = (await app.inject({ method: "GET", url: f.flow.base, headers: f.owner.headers })).json().pairing;
    expect(shown).toMatchObject({ connector_name: "Journal", app_origin: web });
    expect((await f.flow.exchange()).json().token).toBeUndefined();
    expect((await db.query("SELECT connector_id FROM installation_device_credentials WHERE connector_id=$1", [f.selected.connector_id])).rows).toEqual([]);
    expect((await approveDevice(f.flow, f.owner)).statusCode).toBe(200);
    expect((await f.flow.exchange()).json()).toMatchObject({ status: "paired", connector: { name: "Journal" } });
    const m = await prepared("mobile", false, undefined, undefined, registered.id);
    expect(m.selected).toMatchObject({ app_id: registered.id, app_origin: mobile });
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
  type Input = ReturnType<typeof original> & {installation: ReturnType<typeof original>["installation"] & {renewal?: {request_id:string;pairing_secret:string}; recovery_collection_id?:string}};
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
  async function approveDevice(flow: ReturnType<typeof channel>, owner: Awaited<ReturnType<typeof account>>, fingerprint?:string, consent:{collection_ids:string[];create_collections:boolean;selected_collection_id?:string}={collection_ids:[],create_collections:false}) {
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
  async function prepared(kind: "app-runtime" | "mobile" = "app-runtime", create=false, existingOwner?:Awaited<ReturnType<typeof account>>, origin?:string, appId=tasknotesId, recoveryCollection?:string) {
    const owner = existingOwner??await account(), input:Input = original(kind);
    if (recoveryCollection) input.installation.recovery_collection_id=recoveryCollection;
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
  it.each([false, true])("confirms a returning password account's authenticated primary email with null legacy email (reconsent=%s)", async reconsent => {
    const prior = await prepared(); expect((await approveDevice(prior.flow, prior.owner)).statusCode).toBe(200);
    const credential = (await prior.flow.exchange()).json(); expect(credential.status).toBe("paired");
    const email = `${randomUUID()}@example.test`;
    await db.query("INSERT INTO email_identities(id,user_id,email,normalized_email,verified_at,is_primary) VALUES($1,$2,$3,$3,now(),true)", [randomUUID(), prior.owner.user, email]);
    await db.query("UPDATE users SET email=NULL WHERE id=$1", [prior.owner.user]);
    const input = original();
    if (reconsent) { input.installation.installation_id = prior.input.installation.installation_id; input.installation.device_id = prior.input.installation.device_id; input.installation.reconsent = true; }
    const created = await app.inject({method:"POST",url:"/v1/pairing-requests",headers:{...originHeaders(input),...(reconsent ? {authorization:`Bearer ${credential.token}`} : {})},payload:input});
    expect(created.statusCode).toBe(201); const flow = channel(input);
    // The exact pre-fix legacy-email assignment must still violate applied0067;
    // fixing the request path must NOT relax or rewrite that all-or-none guard.
    await expect(db.query(`UPDATE installation_device_pairings SET
      portal_account_confirmed_at=now(),portal_account_email=u.email,
      portal_account_session_id=$3,portal_account_session_epoch=u.session_epoch
      FROM users u WHERE pairing_id=$1 AND u.id=$2`,[input.installation.request_id,prior.owner.user,prior.owner.session])).rejects.toMatchObject({code:"23514",constraint:"installation_portal_confirmation_complete"});
    const selected = await app.inject({method:"POST",url:`${flow.base}/select-account`,headers:prior.owner.headers,payload:{email:"not-authority@example.test"}});
    expect(selected.statusCode).toBe(200);
    const confirmation = (await db.query("SELECT portal_account_confirmed_at,portal_account_email,portal_account_session_id,portal_account_session_epoch FROM installation_device_pairings WHERE pairing_id=$1",[input.installation.request_id])).rows[0];
    expect(confirmation).toMatchObject({portal_account_email:email,portal_account_session_id:prior.owner.session});
    expect(confirmation.portal_account_confirmed_at).not.toBeNull(); expect(confirmation.portal_account_session_epoch).not.toBeNull();
    expect((await app.inject({method:"GET",url:flow.base,headers:prior.owner.headers})).json().pairing.signed_in_account_email).toBe(email);
    // Another authenticated email must not rewrite this request's explicit evidence.
    await db.query("UPDATE email_identities SET email=$2,normalized_email=$2 WHERE user_id=$1",[prior.owner.user,`changed-${email}`]);
    expect((await app.inject({method:"POST",url:`${flow.base}/select-account`,headers:prior.owner.headers})).statusCode).toBe(200);
    expect((await db.query("SELECT portal_account_confirmed_at,portal_account_email,portal_account_session_id,portal_account_session_epoch FROM installation_device_pairings WHERE pairing_id=$1",[input.installation.request_id])).rows[0]).toEqual(confirmation);
    expect((await db.query("SELECT portal_account_email FROM installation_device_pairings WHERE pairing_id=$1",[prior.input.installation.request_id])).rows[0].portal_account_email).toBe(`${prior.owner.user}@example.test`);
    expect((await db.query("SELECT device_id FROM installation_device_credentials WHERE pairing_id=$1",[input.installation.request_id])).rows).toEqual([]);
  });
  it.each([false,true])("confirms an authenticated GitHub login without any email (reconsent=%s)", async reconsent => {
    const prior = await prepared(); expect((await approveDevice(prior.flow,prior.owner)).statusCode).toBe(200);
    const credential=(await prior.flow.exchange()).json(); expect(credential.status).toBe("paired");
    const login=`fixture-${randomUUID().slice(0,8)}`;
    await db.query("UPDATE users SET email=NULL,name='Not an authenticated login' WHERE id=$1",[prior.owner.user]);
    await db.query("INSERT INTO external_identities(provider,subject,user_id,login,email,email_verified) VALUES('github',$1,$2,$3,NULL,false)",[randomUUID(),prior.owner.user,login]);
    await db.query("UPDATE sessions SET provider='github' WHERE id=$1",[prior.owner.session]);
    const input=original(); if(reconsent){input.installation.installation_id=prior.input.installation.installation_id;input.installation.device_id=prior.input.installation.device_id;input.installation.reconsent=true;}
    expect((await app.inject({method:"POST",url:"/v1/pairing-requests",headers:{...originHeaders(input),...(reconsent?{authorization:`Bearer ${credential.token}`}:{})},payload:input})).statusCode).toBe(201);
    const flow=channel(input);
    const selected=await app.inject({method:"POST",url:`${flow.base}/select-account`,headers:prior.owner.headers,payload:{email:"spoof@example.test",provider:"github",login:"spoof"}});
    expect(selected.statusCode).toBe(200);
    const pairing=(await app.inject({method:"GET",url:flow.base,headers:prior.owner.headers})).json().pairing;
    expect(pairing).toMatchObject({account_selection_confirmed:true,account_email:null,account_provider:"github",account_login:login});
    const frozen=(await db.query("SELECT portal_account_confirmed_at,portal_account_email,portal_account_provider,portal_account_login,portal_account_session_id,portal_account_session_epoch FROM installation_device_pairings WHERE pairing_id=$1",[input.installation.request_id])).rows[0];
    expect(frozen).toMatchObject({portal_account_email:null,portal_account_provider:"github",portal_account_login:login,portal_account_session_id:prior.owner.session});
    if(!reconsent) expect((await attest(input,(await flow.exchange()).json())).result.statusCode).toBe(200);
    expect((await approveDevice(flow,prior.owner)).statusCode).toBe(200);
    const paired=(await flow.exchange()).json(); expect(paired).toMatchObject({status:reconsent?"scope_updated":"paired",account_email:null,account_provider:"github",account_login:login,account_selection_confirmed:true});
    await db.query("UPDATE external_identities SET login='changed',email='changed@example.test' WHERE user_id=$1",[prior.owner.user]);
    expect((await app.inject({method:"POST",url:`${flow.base}/select-account`,headers:prior.owner.headers})).statusCode).toBe(200);
    expect((await db.query("SELECT portal_account_confirmed_at,portal_account_email,portal_account_provider,portal_account_login,portal_account_session_id,portal_account_session_epoch FROM installation_device_pairings WHERE pairing_id=$1",[input.installation.request_id])).rows[0]).toEqual(frozen);
  });
  it("refuses unavailable authenticated identity without partial confirmation, backfill or an internal constraint failure", async () => {
    const owner = await account(); await db.query("UPDATE users SET email=NULL WHERE id=$1",[owner.user]);
    const input = original(), flow = await start(input);
    const selected = await app.inject({method:"POST",url:`${flow.base}/select-account`,headers:owner.headers,payload:{email:"invented@example.test",provider:"github",login:"invented"}});
    expect(selected.statusCode).toBe(403); expect(selected.json().error.code).toBe("installation_account_identity_unavailable");
    expect(selected.json().error.message).toBe("We couldn't identify your account. Sign in again to continue.");
    const unchanged = (await db.query("SELECT p.user_id,i.account_selected_at,i.portal_account_confirmed_at,i.portal_account_email,i.portal_account_session_id,i.portal_account_session_epoch FROM pairing_requests p JOIN installation_device_pairings i ON i.pairing_id=p.id WHERE p.id=$1",[input.installation.request_id])).rows[0];
    expect(Object.values(unchanged)).toEqual([null,null,null,null,null,null]);
    expect((await flow.exchange()).json()).toEqual({status:"pending"});
  });
  it("keeps forward confirmation complete and request-local without backfilling any identity", async () => {
    const owner=await account(), input=original(); await start(input);
    for(const fields of [
      "portal_account_provider='github',portal_account_login='login'",
      "portal_account_confirmed_at=now(),portal_account_session_id=$2,portal_account_session_epoch=0",
      "portal_account_confirmed_at=now(),portal_account_session_id=$2,portal_account_session_epoch=0,portal_account_provider='github'",
      "portal_account_confirmed_at=now(),portal_account_session_id=$2,portal_account_session_epoch=0,portal_account_provider='github',portal_account_login=''",
      "portal_account_confirmed_at=now(),portal_account_session_id=$2,portal_account_session_epoch=0,portal_account_provider='password',portal_account_login='login'",
      "portal_account_confirmed_at=now(),portal_account_session_id=$2,portal_account_session_epoch=0,portal_account_email='owner@example.test',portal_account_provider='github',portal_account_login='login'",
    ]) await expect(db.query(`UPDATE installation_device_pairings SET ${fields} WHERE pairing_id=$1`,fields.includes("$2")?[input.installation.request_id,owner.session]:[input.installation.request_id])).rejects.toMatchObject({code:"23514",constraint:"installation_portal_confirmation_complete"});
    const empty=(await db.query("SELECT portal_account_confirmed_at,portal_account_email,portal_account_provider,portal_account_login,portal_account_session_id,portal_account_session_epoch FROM installation_device_pairings WHERE pairing_id=$1",[input.installation.request_id])).rows[0];
    expect(Object.values(empty)).toEqual([null,null,null,null,null,null]);
  });
  it("lets an account created on a next deployment select the app at once, without the upgrade notice", async () => {
    const session = await createExternalSession(db, {
      provider: "github", subject: randomUUID(), login: "new-person", email: null, emailVerified: false, name: "New Person", avatarUrl: null
    }, { allowAccountCreation: true, newAccountBackend: "next" });
    const owner = { user: session.userId, headers: { cookie: `mdbase_session=${session.token}` } };
    const input = original(), flow = await start(input);
    expect((await app.inject({ method: "POST", url: `${flow.base}/select-account`, headers: owner.headers })).statusCode).toBe(200);
    expect((await flow.exchange()).json()).toMatchObject({ status: "account_selected", account_id: owner.user });
    expect((await app.inject({ method: "GET", url: flow.base, headers: owner.headers })).json().pairing.account_upgraded).toBe(false);
  });
  it("shows upgrade readiness before account selection without claiming the request or issuing a device", async () => {
    const owner = await account(), input = original(), flow = await start(input);
    const inspect = () => app.inject({ method: "GET", url: flow.base, headers: owner.headers });
    expect((await inspect()).json().pairing.account_upgrade).toBeNull();
    await db.query("UPDATE users SET account_backend='legacy' WHERE id=$1", [owner.user]);
    const beforeConsent = await inspect();
    expect(beforeConsent.statusCode).toBe(200);
    expect(beforeConsent.json().pairing).toMatchObject({ account_upgrade: "not_scheduled", account_selected: false, collections: [] });
    expect((await flow.exchange()).json()).toEqual({ status: "pending" });
    const refused = await app.inject({ method: "POST", url: `${flow.base}/select-account`, headers: owner.headers });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("installation_legacy_backend");
    expect(refused.json().error).toMatchObject({ message: expect.stringMatching(/support@mdbase\.dev/), details: { upgrade: "not_scheduled" } });
    expect(refused.json().error.message).not.toMatch(/legacy|backend|migrat/i);
    const cohort = `refusal-${randomUUID()}`;
    await db.query("INSERT INTO next_migration_cohorts(name) VALUES($1)", [cohort]);
    await db.query("INSERT INTO next_migration_cohort_members(account_id,cohort) VALUES($1,$2)", [owner.user, cohort]);
    expect((await inspect()).json().pairing.account_upgrade).toBe("scheduled");
    const scheduled = await app.inject({ method: "POST", url: `${flow.base}/select-account`, headers: owner.headers });
    expect(scheduled.json().error.details).toEqual({ upgrade: "scheduled" });
    await db.query("UPDATE next_migration_cohort_members SET started_at=now() WHERE account_id=$1", [owner.user]);
    expect((await inspect()).json().pairing.account_upgrade).toBe("in_progress");
    const upgrading = await app.inject({ method: "POST", url: `${flow.base}/select-account`, headers: owner.headers });
    expect(upgrading.json().error).toMatchObject({ message: expect.stringMatching(/being upgraded/), details: { upgrade: "in_progress" } });
    // A receipted rollback keeps the start claim; the denial stops saying "being upgraded".
    const hosted = randomUUID();
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,'Notes','mdbase')", [hosted, owner.user]);
    const step = (type: string, at: string) => db.query(
      "INSERT INTO audit_events(id,user_id,event_type,subject_id,metadata,created_at) VALUES($1,$2,$3,$4,'{}',$5)",
      [randomUUID(), owner.user, type, hosted, at]);
    await step("next_migration.fence", "2026-10-18T01:00:00Z");
    expect((await app.inject({ method: "POST", url: `${flow.base}/select-account`, headers: owner.headers })).json().error.details).toEqual({ upgrade: "in_progress" });
    // Intent/provider binding and a queued/appended abort barrier are not a rollback receipt.
    for (const event of ["next_migration.rollback_intent", "next_migration.rollback_provider_binding", "next_migration.appendbase_abort_barrier"]) {
      await step(event, "2026-10-18T01:30:00Z");
      expect((await inspect()).json().pairing.account_upgrade).toBe("in_progress");
    }
    await step("next_migration.rollback", "2026-10-18T02:00:00Z");
    expect((await inspect()).json().pairing.account_upgrade).toBe("postponed");
    const postponed = await app.inject({ method: "POST", url: `${flow.base}/select-account`, headers: owner.headers });
    expect(postponed.statusCode).toBe(409);
    expect(postponed.json().error).toMatchObject({ code: "installation_legacy_backend", message: expect.stringMatching(/paused/), details: { upgrade: "postponed" } });
    expect(postponed.json().error.message).not.toMatch(/being upgraded|try again|legacy|backend|migrat/i);
    // An operator restart fences again: the upgrade is in progress once more.
    await step("next_migration.fence", "2026-10-18T03:00:00Z");
    expect((await inspect()).json().pairing.account_upgrade).toBe("in_progress");
    expect((await app.inject({ method: "POST", url: `${flow.base}/select-account`, headers: owner.headers })).json().error.details).toEqual({ upgrade: "in_progress" });
    expect((await flow.exchange()).json()).toEqual({ status: "pending" });
    expect((await db.query("SELECT user_id FROM pairing_requests WHERE id=$1", [input.installation.request_id])).rows[0].user_id).toBeNull();
    expect((await db.query("SELECT device_id FROM installation_device_credentials WHERE pairing_id=$1", [input.installation.request_id])).rows).toEqual([]);
    await db.query("UPDATE users SET account_backend='next' WHERE id=$1", [owner.user]);
    expect((await inspect()).json().pairing.account_upgrade).toBeNull();
    expect((await app.inject({ method: "POST", url: `${flow.base}/select-account`, headers: owner.headers })).statusCode).toBe(200);
  });
  it("tells the requesting app, by its secret only, that its window was cancelled", async () => {
    const owner = await account(), input = original(), flow = await start(input);
    expect((await app.inject({ method: "POST", url: `${flow.base}/deny`, headers: owner.headers })).statusCode).toBe(200);
    for (const replay of [await flow.exchange(), await app.inject({ method: "POST", url: "/v1/pairing-requests", payload: input, headers: originHeaders(input) })]) {
      expect(replay.statusCode).toBe(404);
      expect(replay.json().error.code).toBe("installation_pairing_denied");
    }
    const wrongSecret = await app.inject({ method: "POST", url: `${flow.base}/exchange`, headers: { authorization: "Bearer pair_wrong" } });
    expect(wrongSecret.json().error.code).toBe("installation_pairing_not_found");
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
    for (const origin of [undefined,"https://untrusted.example","https://app.tasknotes.dev.lookalike.example","null"]) {
      const result = await app.inject({method:"POST",url:"/v1/pairing-requests",payload:input,headers:origin?{origin}:{}});
      expect(result.statusCode).toBe(403);
    }
    expect((await app.inject({method:"POST",url:"/v1/pairing-requests",payload:{...input,installation:{...input.installation,app_id:"third-party"}},headers:{origin:webOrigin}})).statusCode).toBe(403);
    expect((await db.query("SELECT id FROM pairing_requests WHERE id=$1",[input.installation.request_id])).rows).toEqual([]);
  });
  it("accepts TaskNotes' registered homepage origin without an environment-specific operator entry", async () => {
    const input = original();
    const result = await app.inject({ method: "POST", url: "/v1/pairing-requests", payload: input, headers: { origin: "https://app.tasknotes.dev" } });
    expect(result.statusCode).toBe(201); expect(result.json().app_name).toBe("TaskNotes");
    expect((await channel(input).exchange()).json()).toEqual({ status: "pending" });
    expect((await db.query("SELECT app_origin FROM installation_device_pairings WHERE pairing_id=$1", [input.installation.request_id])).rows[0].app_origin).toBe("https://app.tasknotes.dev");
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
  async function scopeCollection(owner:string, member=owner, sync: "cloud_copy" | "private" = "cloud_copy") {
    const collection=randomUUID();
    await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'next',$4,$3)",[collection,owner,Buffer.alloc(32),sync]);
    const batch=(await db.query("INSERT INTO next_policy_batches(collection_id,seq,prev,item,issued_at,state) VALUES($1,1,$2,$3,1,'appended') RETURNING id",[collection,Buffer.alloc(32),Buffer.alloc(1)])).rows[0].id;
    const ops=[{op:"member-set",account:owner,role:"owner"},...(member===owner?[]:[{op:"member-set",account:member,role:"editor"}])];
    await db.query("INSERT INTO next_policy_outbox(collection_id,ops,batch_id) VALUES($1,$2,$3)",[collection,JSON.stringify({version:1,ops}),batch]);
    return collection;
  }
  it("offers the same account's Private collection in ordinary Sign in with zero Hosted collections", async () => {
    const owner=await account(), foreign=await account();
    const privateId=await scopeCollection(owner.user,owner.user,"private");
    const foreignId=await scopeCollection(foreign.user,foreign.user,"private");
    await db.query("UPDATE next_collections SET display_name='[test] Original Private' WHERE collection_id=$1",[privateId]);
    const p=await prepared("app-runtime",true,owner);
    const shown=(await app.inject({method:"GET",url:p.flow.base,headers:owner.headers})).json().pairing;
    expect(shown.collections).toContainEqual({collection_id:privateId,display_name:"[test] Original Private",role:"owner",kind:"private"});
    expect(shown.collections.some((c:{collection_id:string})=>c.collection_id===foreignId)).toBe(false);
    expect((await db.query("SELECT collection_id FROM installation_collection_scopes WHERE connector_id=$1",[p.selected.connector_id])).rows).toEqual([]);
    expect((await p.flow.exchange()).json().status).toBe("awaiting_approval");
  });
  async function nativeApp() {
    const declaration=registerApplicationManifest({manifest_version:1,id:`dev.example.native-${randomUUID()}`,name:"[test] Native Notes",distribution:"web",homepage:webOrigin,
      redirect_uris:[`${webOrigin}/callback`],requirements:{contracts:[],access:"full_collection",capabilities:{contract_version:2,required:["collection.read"]},files:{required:["list","read"],scope:{kind:"collection"}}}});
    const registered=await upsertApplication(db,declaration);
    apps.set(registered.id,{name:"[test] Native Notes",web:webOrigin,mobile:`capacitor://app-${registered.id}.example.test`});
    return registered.id;
  }
  async function privatePrepared(create=false) { return prepared("app-runtime",create,undefined,undefined,await nativeApp()); }
  async function nativeCompanion(p: Awaited<ReturnType<typeof prepared>>, options: {nonce?:string;user?:string;appId?:string}={}) {
    const id=randomUUID(), nativeApp=options.appId??p.input.installation.app_id;
    const a=(await db.query("SELECT * FROM applications WHERE id=$1",[nativeApp])).rows[0];
    const registered=registerApplicationManifest(a.application_declaration);
    const capabilities=a.requirements.capabilities;
    const operations=[...new Set(capabilities.required.flatMap((capability:Parameters<typeof capabilityOperationsForContractVersion>[1])=>capabilityOperationsForContractVersion(capabilities.contract_version,capability)??[]))];
    const signing=createTestApplicationIdentity();
    const redirect=`${apps.get(nativeApp)!.web}/callback`;
    const proof=await testApplicationAuthorization({applicationId:nativeApp,authorizationId:id,
      applicationManifestDigest:a.manifest_digest,applicationDeclarationId:registered.manifest.id,
      flow:"authorization_code",redirectUri:redirect,state:randomUUID(),codeChallenge:Buffer.alloc(32,8).toString("base64url"),
      semanticCapabilityContractVersion:capabilities.contract_version,requestedOperations:operations,requestedFiles:fileRequestForRequirements(a.requirements),
      grantSigningPublicKey:signing.publicKey,authorizationNonce:options.nonce??Buffer.from(p.selected.challenge,"hex").toString("base64url")});
    await db.query(`INSERT INTO authorization_requests(id,user_id,application_id,flow,requested_operations,operation_transport_protocol,
      application_agreement_public_key,application_signing_public_key,application_authorization,application_installation_id,redirect_uri,code_challenge,state,expires_at)
      VALUES($1,$2,$3,'authorization_code',$4::jsonb,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,now()+interval '10 minutes')`,
      [id,options.user??null,nativeApp,JSON.stringify(operations),proof.binding.contracts.operation_transport,
        proof.binding.grant_agreement_public_key,signing.publicKey,JSON.stringify(proof),proof.binding.application_installation_id,redirect,proof.binding.code_challenge,proof.binding.state]);
    const noise=Buffer.from(rawX(),"hex");
    const signature=sign("sha256",clientNoiseKeyMessage(id,noise),{key:signing.privateKey,dsaEncoding:"ieee-p1363"});
    await storeRequestClientNoiseKey(db,id,verifiedClientNoiseKey(JSON.stringify({public_key:noise.toString("base64url"),signature:signature.toString("base64url")}),proof.binding)!);
    return {id,operations,attach:()=>app.inject({method:"POST",url:`${p.flow.base}/native-authorization`,headers:p.flow.bearer,payload:{authorization_request_id:id}})};
  }
  async function approvePrivate(p: Awaited<ReturnType<typeof prepared>>, collection: string) {
    return app.inject({method:"POST",url:`${p.flow.base}/approve`,headers:p.owner.headers,payload:{fingerprint:clientFingerprint(Buffer.from(p.proof.payload.sign_pk,"hex")),collection_ids:[],create_collections:false,selected_collection_id:collection,selected_collection_kind:"private"}});
  }
  async function servingNative(owner:string,collection:string) {
    const connector=randomUUID(),device=randomUUID(),signKey=ed25519RawPublicKey(generateKeyPairSync("ed25519").privateKey),kem=Buffer.from(rawX(),"hex"),noise=Buffer.from(rawX(),"hex");
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash,relay_generation) VALUES($1,$2,'Native fixture',$3,1)",[connector,owner,tokenHash(randomUUID())]);
    await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$3,'desktop',$4,$5,$6)",[device,connector,owner,signKey,kem,noise]);
    const batch=(await db.query("SELECT id FROM next_policy_batches WHERE collection_id=$1 AND state='appended' ORDER BY seq DESC LIMIT 1",[collection])).rows[0].id;
    await db.query("INSERT INTO next_policy_outbox(collection_id,ops,batch_id) VALUES($1,$2::jsonb,$3)",[collection,JSON.stringify({version:1,ops:[{op:"device-enrol",device,account:owner,kind:"desktop",signPublicKey:{$hex:signKey.toString("hex")},kemPublicKey:{$hex:kem.toString("hex")},noisePublicKey:{$hex:noise.toString("hex")}}]}),batch]);
    return connector;
  }
  it("pushes unified Private consent after COMMIT and waits for the original Native ACK without holding authority locks",async()=>{
    const p=await privatePrepared(),collection=await scopeCollection(p.owner.user,p.owner.user,"private"),connector=await servingNative(p.owner.user,collection),n=await nativeCompanion(p);
    expect((await n.attach()).statusCode).toBe(200);
    let release!:()=>void,entered!:()=>void,completed=false;
    const started=new Promise<void>(resolve=>{entered=resolve;}),ack=new Promise<void>(resolve=>{release=resolve;});
    acknowledgeNativePush=async()=>{entered();await ack;};
    const before=nativePushes.length,pending=approvePrivate(p,collection).then(response=>{completed=true;return response;});
    try {
      await started;
      expect(completed).toBe(false);
      const original=(await db.query("SELECT g.id,b.log_grant_id FROM authorization_requests ar JOIN grants g ON g.id=ar.grant_id JOIN next_grant_bindings b ON b.grant_id=g.id WHERE ar.id=$1",[n.id])).rows[0];
      expect(nativePushes.slice(before)).toEqual([{connector,grants:[original.log_grant_id]}]);
      const observer=await db.connect();
      try {
        await observer.query("BEGIN");
        await observer.query("SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT",[p.owner.user]);
        await observer.query("SELECT id FROM pairing_requests WHERE id=$1 FOR UPDATE NOWAIT",[p.input.installation.request_id]);
        await observer.query("SELECT id FROM authorization_requests WHERE id=$1 FOR UPDATE NOWAIT",[n.id]);
        await observer.query("ROLLBACK");
      }finally{observer.release();}
      release();const approved=await pending;expect(approved.statusCode,approved.body).toBe(200);
      expect((await p.flow.exchange()).json()).toMatchObject({status:"paired",collection_ids:[],native_selection:{authorization_request_id:n.id,collection_id:collection}});
      expect((await db.query("SELECT * FROM installation_collection_scopes WHERE connector_id=$1",[p.selected.connector_id])).rows).toEqual([]);
    }finally{release();acknowledgeNativePush=async()=>{};await pending;}
  });
  it("keeps committed unified consent and original keys when the Native push fails",async()=>{
    const p=await privatePrepared(),collection=await scopeCollection(p.owner.user,p.owner.user,"private"),n=await nativeCompanion(p);
    await servingNative(p.owner.user,collection);expect((await n.attach()).statusCode).toBe(200);
    const original=(await db.query("SELECT client_pk,signature FROM next_authorization_client_keys WHERE request_id=$1",[n.id])).rows[0];
    acknowledgeNativePush=async()=>{throw new Error("synthetic unavailable Native");};
    try {
      const approved=await approvePrivate(p,collection);expect(approved.statusCode,approved.body).toBe(200);
      expect(approved.json()).toHaveProperty("native_authorization_uri",`/oauth/authorize?request_id=${n.id}`);
      const grant=(await db.query("SELECT grant_id FROM authorization_requests WHERE id=$1",[n.id])).rows[0].grant_id;
      expect((await db.query("SELECT client_pk,signature FROM next_grant_client_keys WHERE grant_id=$1",[grant])).rows[0]).toEqual(original);
      expect((await db.query("SELECT id FROM grants WHERE next_collection_id=$1",[collection])).rows).toEqual([{id:grant}]);
      expect((await p.flow.exchange()).json()).toMatchObject({status:"paired",collection_ids:[],native_selection:{authorization_request_id:n.id,collection_id:collection}});
    }finally{acknowledgeNativePush=async()=>{};}
  });
  it("allows a migrated account to approve an app after completed zero-Hosted migration without thawing its archive",async()=>{
    const p=await privatePrepared(), collection=await scopeCollection(p.owner.user,p.owner.user,"private");
    const cohort=`approve-${randomUUID().slice(0,8)}`,actor="synthetic-local-pg";
    // Isolated fixture starts legacy, then uses the normal accepted-archive/start/flip lifecycle.
    await db.query("UPDATE users SET account_backend='legacy' WHERE id=$1",[p.owner.user]);
    await createCohort(db,cohort,actor);await addToCohort(db,cohort,[p.owner.user],actor);await releaseCohort(db,cohort,actor);
    await setCohortFrozen(db,cohort,true,"synthetic archive",actor);
    const binding=await cohortArchiveBinding(db,cohort),clock=new Date((await db.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now).toISOString();
    const archive={schema:ZERO_HOSTED_ARCHIVE_SCHEMA,environment:"lab",bucket:"synthetic-archives",prefix:`legacy-archive/lab/2026/10/14/${cohort}`,backup_id:cohort,
      complete_sha256:"a".repeat(64),manifest_sha256:"b".repeat(64),source_commit:"c".repeat(40),migration_batch:binding,archive_created_at:clock,archive_completed_at:clock,
      retention:{mode:"GOVERNANCE",days:116,retain_until:new Date(Date.parse(clock)+116*86_400_000).toISOString(),inventory_digest:"d".repeat(64),count:"2"}};
    await acceptCohortArchive(db,cohort,archive,"lab");await setPaused(db,false,"synthetic migration",actor);
    await startAccountMigration(db,p.owner.user,"lab");await flipAccountBackend(db,p.owner.user,[],flipEvidenceDigest([]),{enabled:true},"lab");
    const frozen=(await db.query("SELECT frozen_at,completed_at,completed_revision FROM next_migration_cohorts WHERE name=$1",[cohort])).rows[0];
    expect(frozen.frozen_at).not.toBeNull();expect(frozen.completed_at).not.toBeNull();
    const n=await nativeCompanion(p);expect((await n.attach()).statusCode).toBe(200);
    const result=await approvePrivate(p,collection);expect(result.statusCode,result.body).toBe(200);
    expect((await p.flow.exchange()).json()).toMatchObject({status:"paired",collection_ids:[],native_selection:{authorization_request_id:n.id,collection_id:collection}});
    const hosted=await scopeCollection(p.owner.user),q=await prepared("app-runtime",false,p.owner,undefined,p.input.installation.app_id);
    expect((await approveDevice(q.flow,q.owner,undefined,{collection_ids:[hosted],create_collections:false,selected_collection_id:hosted})).statusCode).toBe(200);
    expect((await q.flow.exchange()).json()).toMatchObject({status:"paired",collection_ids:[hosted],selected_collection_id:hosted});
    expect((await db.query("SELECT frozen_at,completed_at,completed_revision FROM next_migration_cohorts WHERE name=$1",[cohort])).rows[0]).toEqual(frozen);
    expect((await db.query("SELECT verified_result FROM next_migration_archive_acceptances WHERE cohort=$1",[cohort])).rows[0].verified_result).toEqual(archive);
    await expect(setCohortFrozen(db,cohort,false,"must stay frozen",actor)).rejects.toMatchObject({code:"migration_frozen"});
  });
  it("atomically approves a Private choice and genuine original zero-scope installation",async()=>{
    const p=await privatePrepared(true), collection=await scopeCollection(p.owner.user,p.owner.user,"private"), n=await nativeCompanion(p);
    expect((await n.attach()).statusCode).toBe(200);
    expect((await n.attach()).statusCode).toBe(200);
    expect((await db.query("SELECT grant_id FROM authorization_requests WHERE id=$1",[n.id])).rows[0].grant_id).toBeNull();
    const approved=await approvePrivate(p,collection);
    expect(approved.statusCode,approved.body).toBe(200);
    expect(approved.json()).toMatchObject({ok:true,native_authorization_uri:`/oauth/authorize?request_id=${n.id}`});
    const grant=(await db.query("SELECT g.* FROM grants g JOIN authorization_requests ar ON ar.grant_id=g.id WHERE ar.id=$1",[n.id])).rows[0];
    expect(grant).toMatchObject({user_id:p.owner.user,next_collection_id:collection});
    const paired=(await p.flow.exchange()).json();
    expect(paired).toMatchObject({status:"paired",collection_ids:[],create_collections:false,native_selection:{authorization_request_id:n.id,collection_id:collection}});
    expect(paired).not.toHaveProperty("selected_collection_id");expect(paired).not.toHaveProperty("created_collection_ids");
    expect((await db.query("SELECT collection_id FROM installation_collection_scopes WHERE connector_id=$1",[p.selected.connector_id])).rows).toEqual([]);
    expect((await approvePrivate(p,collection)).json()).not.toHaveProperty("native_authorization_uri");
    expect((await db.query("SELECT count(*)::int AS n FROM grants WHERE next_collection_id=$1",[collection])).rows[0].n).toBe(1);
  });
  it("erases an account whose installation made an approved Native choice",async()=>{
    const p=await privatePrepared(true), collection=await scopeCollection(p.owner.user,p.owner.user,"private"), n=await nativeCompanion(p);
    expect((await n.attach()).statusCode).toBe(200);
    expect((await approvePrivate(p,collection)).statusCode).toBe(200);
    expect((await db.query("SELECT grant_id FROM installation_native_authorizations WHERE account_id=$1",[p.owner.user])).rows[0].grant_id).not.toBeNull();
    await deleteAccountLocally(db,{userId:p.owner.user,sessionId:randomUUID(),authorized:true,queueProviderCleanup:false});
    expect((await db.query("SELECT id FROM users WHERE id=$1",[p.owner.user])).rows).toEqual([]);
    expect((await db.query("SELECT pairing_id FROM installation_native_authorizations WHERE account_id=$1",[p.owner.user])).rows).toEqual([]);
  });
  it.each(["nonce","account","app"])("refuses a swapped Native %s before grant or association",async wrong=>{
    const p=await privatePrepared(), foreign=await account();
    const appId=wrong==="app" ? await nativeApp() : undefined;
    const n=await nativeCompanion(p,{...(wrong==="nonce"?{nonce:Buffer.alloc(32,9).toString("base64url")}:{ }),...(wrong==="account"?{user:foreign.user}:{}),...(appId?{appId}:{})});
    expect((await n.attach()).statusCode).toBe(409);
    expect((await db.query("SELECT pairing_id FROM installation_native_authorizations WHERE pairing_id=$1",[p.input.installation.request_id])).rows).toEqual([]);
    expect((await db.query("SELECT grant_id FROM authorization_requests WHERE id=$1",[n.id])).rows[0].grant_id).toBeNull();
  });
  it("does not replace the original companion or immutable selected target",async()=>{
    const p=await privatePrepared(), collection=await scopeCollection(p.owner.user,p.owner.user,"private"), other=await scopeCollection(p.owner.user,p.owner.user,"private");
    const first=await nativeCompanion(p), second=await nativeCompanion(p);
    expect((await first.attach()).statusCode).toBe(200);expect((await second.attach()).statusCode).toBe(409);
    expect((await approvePrivate(p,collection)).statusCode).toBe(200);expect((await approvePrivate(p,other)).statusCode).toBe(409);
    await expect(db.query("UPDATE installation_native_authorizations SET authorization_request_id=$2 WHERE pairing_id=$1",[p.input.installation.request_id,second.id])).rejects.toMatchObject({code:"P0001"});
    expect((await db.query("SELECT grant_id FROM authorization_requests WHERE id=$1",[second.id])).rows[0].grant_id).toBeNull();
  });
  it("requires the original chooser: ordinary Native approve cannot bypass a linked cancelled parent",async()=>{
    const p=await privatePrepared(), collection=await scopeCollection(p.owner.user,p.owner.user,"private"), n=await nativeCompanion(p);
    expect((await n.attach()).statusCode).toBe(200);
    expect((await app.inject({method:"POST",url:`${p.flow.base}/deny`,headers:p.owner.headers})).statusCode).toBe(200);
    await expect(approveNativeAuthorization(db,{requestId:n.id,userId:p.owner.user,collectionId:collection,operations:n.operations})).rejects.toThrow("original app collection chooser");
    expect((await db.query("SELECT grant_id FROM authorization_requests WHERE id=$1",[n.id])).rows[0].grant_id).toBeNull();
  });
  it("rolls back Native grant and choice if account-only installation approval fails",async()=>{
    const p=await privatePrepared(), collection=await scopeCollection(p.owner.user,p.owner.user,"private"), n=await nativeCompanion(p);
    await servingNative(p.owner.user,collection);const before=nativePushes.length;
    expect((await n.attach()).statusCode).toBe(200);
    await db.query(`CREATE FUNCTION fail_native_registration_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic registration failure'; END $$;
      CREATE TRIGGER fail_native_registration_test BEFORE UPDATE ON installation_device_pairings FOR EACH ROW EXECUTE FUNCTION fail_native_registration_test()`);
    try {
      expect((await approvePrivate(p,collection)).statusCode).toBe(500);
      expect((await db.query("SELECT grant_id,completed_at FROM authorization_requests WHERE id=$1",[n.id])).rows[0]).toMatchObject({grant_id:null,completed_at:null});
      expect((await db.query("SELECT approved_at FROM installation_native_authorizations WHERE pairing_id=$1",[p.input.installation.request_id])).rows[0].approved_at).toBeNull();
      expect((await db.query("SELECT approved_at FROM pairing_requests WHERE id=$1",[p.input.installation.request_id])).rows[0].approved_at).toBeNull();
      expect((await db.query("SELECT id FROM grants WHERE next_collection_id=$1",[collection])).rows).toEqual([]);
      expect(nativePushes.slice(before)).toEqual([]);
    } finally { await db.query("DROP TRIGGER fail_native_registration_test ON installation_device_pairings; DROP FUNCTION fail_native_registration_test()"); }
  });
  it("rechecks original account epoch before Native mutation",async()=>{
    const p=await privatePrepared(), collection=await scopeCollection(p.owner.user,p.owner.user,"private"), n=await nativeCompanion(p);
    expect((await n.attach()).statusCode).toBe(200);await db.query("UPDATE users SET session_epoch=session_epoch+1 WHERE id=$1",[p.owner.user]);
    expect((await approvePrivate(p,collection)).statusCode).toBe(401);
    expect((await db.query("SELECT grant_id FROM authorization_requests WHERE id=$1",[n.id])).rows[0].grant_id).toBeNull();
  });
  it.each(["expiry","origin","manifest","Noise key","denial"])("rechecks original Native %s after attachment, before any grant",async kind=>{
    const p=await privatePrepared(),collection=await scopeCollection(p.owner.user,p.owner.user,"private"),n=await nativeCompanion(p);
    expect((await n.attach()).statusCode).toBe(200);
    if(kind==="expiry") await db.query("UPDATE authorization_requests SET expires_at=now()-interval '1 second' WHERE id=$1",[n.id]);
    if(kind==="origin") await db.query("UPDATE authorization_requests SET redirect_uri='https://wrong.example.test/callback' WHERE id=$1",[n.id]);
    if(kind==="manifest") expect((await db.query("UPDATE applications SET manifest_digest=$2 WHERE id=$1",[p.input.installation.app_id,"f".repeat(64)])).rowCount).toBe(1);
    if(kind==="Noise key") await db.query("DELETE FROM next_authorization_client_keys WHERE request_id=$1",[n.id]);
    if(kind==="denial") await db.query("UPDATE authorization_requests SET denied_at=now() WHERE id=$1",[n.id]);
    const approval=await approvePrivate(p,collection);expect(approval.statusCode,approval.body).toBe(409);
    expect((await db.query("SELECT grant_id FROM authorization_requests WHERE id=$1",[n.id])).rows[0].grant_id).toBeNull();
    expect((await db.query("SELECT approved_at FROM pairing_requests WHERE id=$1",[p.input.installation.request_id])).rows[0].approved_at).toBeNull();
  });
  it("keeps Native recovery constrained to its original Private CID with zero Hosted scopes",async()=>{
    const owner=await account(), collection=await scopeCollection(owner.user,owner.user,"private");
    const p=await prepared("app-runtime",false,owner,undefined,await nativeApp(),collection), n=await nativeCompanion(p);
    expect((await n.attach()).statusCode).toBe(200);
    const approval=await approvePrivate(p,collection);expect(approval.statusCode,approval.body).toBe(200);
    const paired=(await p.flow.exchange()).json();
    expect(paired).toMatchObject({status:"paired",recovery_collection_id:collection,collection_ids:[],create_collections:false,native_selection:{authorization_request_id:n.id,collection_id:collection}});
    expect(paired).not.toHaveProperty("selected_collection_id");
    expect((await db.query("SELECT collection_id FROM installation_collection_scopes WHERE connector_id=$1",[p.selected.connector_id])).rows).toEqual([]);
  });
  it("additive Private approval preserves the original Hosted scopes and device actor",async()=>{
    const original=await privatePrepared(), hosted=await scopeCollection(original.owner.user), collection=await scopeCollection(original.owner.user,original.owner.user,"private");
    expect((await approveDevice(original.flow,original.owner,undefined,{collection_ids:[hosted],create_collections:false,selected_collection_id:hosted})).statusCode).toBe(200);
    const credential=(await original.flow.exchange()).json();
    const input={...original.input,installation:{...original.input.installation,request_id:randomUUID(),pairing_secret:randomToken("pair"),reconsent:true}};
    expect((await app.inject({method:"POST",url:"/v1/pairing-requests",headers:{...originHeaders(input),authorization:`Bearer ${credential.token}`},payload:input})).statusCode).toBe(201);
    const flow=channel(input);
    expect((await app.inject({method:"POST",url:`${flow.base}/select-account`,headers:original.owner.headers})).statusCode).toBe(200);
    const p={...original,input,flow,selected:(await flow.exchange()).json()}, n=await nativeCompanion(p);
    expect((await n.attach()).statusCode).toBe(200);expect((await approvePrivate(p,collection)).statusCode).toBe(200);
    const result=(await flow.exchange()).json();
    expect(result).toMatchObject({status:"scope_updated",added_collection_ids:[],connector_id:original.selected.connector_id,device_id:original.input.installation.device_id,native_selection:{authorization_request_id:n.id,collection_id:collection}});
    expect(result).not.toHaveProperty("selected_collection_id");
    expect((await db.query("SELECT collection_id FROM installation_collection_scopes WHERE connector_id=$1",[original.selected.connector_id])).rows).toEqual([{collection_id:hosted}]);
    expect((await app.inject({method:"GET",url:"/test/installation-scope",headers:{authorization:`Bearer ${credential.token}`}})).statusCode).toBe(200);
  });
  it.each(["own","foreign","missing"])("recovery explains only the confirmed account's exact legacy target (%s)",async variant=>{
    const owner=await account(),holder=variant==="foreign"?await account():owner;
    const target=randomUUID(),legacy=randomUUID();
    if(variant!=="missing"){
      await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Old desktop',$3)",[legacy,holder.user,randomUUID()]);
      await db.query("INSERT INTO collections(id,user_id,connector_id,local_id,display_name,spec_version,enabled,present,authority_state) VALUES($1,$2,$3,$1,'Original local collection','0.3.0',true,true,'active')",[target,holder.user,legacy]);
    }
    const input=original();input.installation.recovery_collection_id=target;
    const flow=await start(input);
    const before=await app.inject({method:"GET",url:flow.base,headers:owner.headers});
    expect(before.statusCode,before.body).toBe(200);
    expect(before.json().pairing.collections).toEqual([]);
    expect((await app.inject({method:"POST",url:`${flow.base}/select-account`,headers:owner.headers})).statusCode).toBe(200);
    const inspected=await app.inject({method:"GET",url:flow.base,headers:owner.headers});
    expect(inspected.statusCode).toBe(variant==="own"?409:403);
    expect(inspected.json().error.code).toBe(variant==="own"?"collection_not_yet_migrated":"installation_collection_unavailable");
    if(variant==="own")expect(inspected.json().error.message).toContain("update the mdbase desktop app");
    const selected=(await flow.exchange()).json();
    expect(selected.status).toBe("account_selected");
    expect(selected.token).toBeUndefined();
    expect((await db.query("SELECT id FROM next_devices WHERE id=$1",[input.installation.device_id])).rows).toEqual([]);
    expect((await db.query("SELECT connector_id FROM installation_collection_scopes WHERE connector_id=$1",[selected.connector_id])).rows).toEqual([]);
  });
  it("recovery target echoes its original CID before proof and credential commit", async () => {
    const owner=await account(), target=await scopeCollection(owner.user);
    const p=await prepared("app-runtime",false,owner,undefined,tasknotesId,target);
    expect(p.selected.recovery_collection_id).toBe(target);
    expect((await app.inject({method:"GET",url:p.flow.base,headers:owner.headers})).json().pairing).toMatchObject({recovery_collection_id:target,can_create_collection:false});
    expect((await p.flow.exchange()).json()).toMatchObject({status:"awaiting_approval",recovery_collection_id:target});
    expect((await approveDevice(p.flow,owner,undefined,{collection_ids:[target],create_collections:false,selected_collection_id:target})).statusCode).toBe(200);
    expect((await p.flow.exchange()).json()).toMatchObject({status:"paired",recovery_collection_id:target,collection_ids:[target],selected_collection_id:target,created_collection_ids:[],create_collections:false});
  });
  it.each(["wrong","additional","omitted","unselected","create"])("recovery target rejects %s consent before mutations", async variant => {
    const owner=await account(), target=await scopeCollection(owner.user), other=await scopeCollection(owner.user);
    const p=await prepared("app-runtime",false,owner,undefined,tasknotesId,target);
    const consent:{collection_ids:string[];selected_collection_id?:string;create_collections:boolean}={collection_ids:[target],selected_collection_id:target,create_collections:false};
    if(variant==="wrong"){consent.collection_ids=[other];consent.selected_collection_id=other;}
    if(variant==="additional")consent.collection_ids=[target,other];
    if(variant==="omitted")consent.collection_ids=[];
    if(variant==="unselected")delete consent.selected_collection_id;
    if(variant==="create")consent.create_collections=true;
    const refused=await approveDevice(p.flow,owner,undefined,consent);
    expect(refused.statusCode).toBe(409);expect(refused.json().error.code).toBe("installation_recovery_target_changed");
    expect((await db.query("SELECT approved_at FROM pairing_requests WHERE id=$1",[p.input.installation.request_id])).rows[0].approved_at).toBeNull();
    expect((await db.query("SELECT approved_collection_ids,selected_collection_id,timer_consent FROM installation_device_pairings WHERE pairing_id=$1",[p.input.installation.request_id])).rows[0]).toEqual({approved_collection_ids:[],selected_collection_id:null,timer_consent:null});
    expect((await db.query("SELECT id FROM next_devices WHERE id=$1",[p.input.installation.device_id])).rows).toEqual([]);
    expect((await db.query("SELECT connector_id FROM installation_collection_scopes WHERE connector_id=$1",[p.selected.connector_id])).rows).toEqual([]);
  });
  it("recovery target rejects changed START retry and renewal intent", async () => {
    const input:Input=original();input.installation.recovery_collection_id=randomUUID();await start(input);
    for(const target of [undefined,randomUUID()]){
      const changed={...input,installation:{...input.installation,recovery_collection_id:target}};
      const result=await app.inject({method:"POST",url:"/v1/pairing-requests",headers:originHeaders(input),payload:changed});
      expect(result.statusCode).toBe(409);expect(result.json().error.code).toBe("installation_recovery_target_changed");
    }
    await db.query("UPDATE pairing_requests SET expires_at=now()-interval '1 minute' WHERE id=$1",[input.installation.request_id]);
    const next=renewal(input);next.installation.recovery_collection_id=randomUUID();
    const result=await app.inject({method:"POST",url:"/v1/pairing-requests",headers:originHeaders(next),payload:next});
    expect(result.statusCode).toBe(409);expect(result.json().error.code).toBe("installation_recovery_target_changed");
    expect((await db.query("SELECT id FROM pairing_requests WHERE id=$1",[next.installation.request_id])).rows).toEqual([]);
  });
  it("recovery target cannot race another otherwise authorized collection into approval", async () => {
    const owner=await account(), target=await scopeCollection(owner.user), other=await scopeCollection(owner.user);
    const p=await prepared("app-runtime",false,owner,undefined,tasknotesId,target);
    const [right,wrong]=await Promise.all([target,other].map(id=>approveDevice(p.flow,owner,undefined,{collection_ids:[id],create_collections:false,selected_collection_id:id})));
    expect(right.statusCode).toBe(200);expect(wrong.statusCode).toBe(409);
    expect((await p.flow.exchange()).json().collection_ids).toEqual([target]);
  });
  it("recovery target refuses a switched account or epoch after attestation before approval", async () => {
    const owner=await account(), other=await account(), target=await scopeCollection(owner.user,other.user);
    const p=await prepared("app-runtime",false,owner,undefined,tasknotesId,target);
    const consent={collection_ids:[target],create_collections:false,selected_collection_id:target};
    expect((await approveDevice(p.flow,other,undefined,consent)).statusCode).toBeGreaterThanOrEqual(400);
    await db.query("UPDATE users SET session_epoch=session_epoch+1 WHERE id=$1",[owner.user]);
    expect((await approveDevice(p.flow,owner,undefined,consent)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await db.query("SELECT approved_at FROM pairing_requests WHERE id=$1",[p.input.installation.request_id])).rows[0].approved_at).toBeNull();
    expect((await db.query("SELECT id FROM next_devices WHERE id=$1",[p.input.installation.device_id])).rows).toEqual([]);
  });
  it("recovery target START echoes intent without target lookup or pending authority", async () => {
    const input:Input=original(), target=randomUUID();input.installation.recovery_collection_id=target;
    const result=await app.inject({method:"POST",url:"/v1/pairing-requests",headers:originHeaders(input),payload:input});
    expect(result.statusCode).toBe(201);expect(result.json().recovery_collection_id).toBe(target);
    const pending=await channel(input).exchange();expect(pending.statusCode).toBe(202);expect(pending.json()).toEqual({status:"pending"});
    expect((await db.query("SELECT user_id,approved_at FROM pairing_requests WHERE id=$1",[input.installation.request_id])).rows[0]).toEqual({user_id:null,approved_at:null});
  });
  it.each(["create","file"])("recovery target rejects %s expansion at START without a row", async variant => {
    const input:Input=original();input.installation.recovery_collection_id=randomUUID();
    const installation={...input.installation,...(variant==="create"?{requested_create_collections:true}:{file_access:{collection_id:input.installation.recovery_collection_id,actions:["read"],reason:"[test] recovery"}})};
    const result=await app.inject({method:"POST",url:"/v1/pairing-requests",headers:originHeaders(input),payload:{...input,installation}});
    expect(result.statusCode).toBe(400);expect(result.json().error.code).toBe("installation_invalid_scope");
    expect((await db.query("SELECT id FROM pairing_requests WHERE id=$1",[input.installation.request_id])).rows).toEqual([]);
  });
  it("recovery target refuses Private targets without hosted scope or credentials", async () => {
    const owner=await account(), target=await scopeCollection(owner.user);await db.query("UPDATE next_collections SET sync='private' WHERE collection_id=$1",[target]);
    const p=await prepared("app-runtime",false,owner,undefined,tasknotesId,target);
    expect((await approveDevice(p.flow,owner,undefined,{collection_ids:[target],create_collections:false,selected_collection_id:target})).statusCode).toBeGreaterThanOrEqual(400);
    expect((await db.query("SELECT approved_at FROM pairing_requests WHERE id=$1",[p.input.installation.request_id])).rows[0].approved_at).toBeNull();
    expect((await db.query("SELECT id FROM next_devices WHERE id=$1",[p.input.installation.device_id])).rows).toEqual([]);
  });
  it("recovery target has immutable SQL intent and complete approved scope constraints", async () => {
    const owner=await account(), target=await scopeCollection(owner.user), other=await scopeCollection(owner.user);
    const p=await prepared("app-runtime",false,owner,undefined,tasknotesId,target);
    for(const changed of [null,other])await expect(db.query("UPDATE installation_device_pairings SET recovery_collection_id=$2 WHERE pairing_id=$1",[p.input.installation.request_id,changed])).rejects.toMatchObject({code:"23514",constraint:"installation_recovery_target_immutable"});
    expect((await approveDevice(p.flow,owner,undefined,{collection_ids:[target],create_collections:false,selected_collection_id:target})).statusCode).toBe(200);
    for(const fields of ["selected_collection_id=NULL","approved_collection_ids='{}'::uuid[]","approved_create_collections=true","requested_create_collections=true","created_collection_ids=ARRAY[selected_collection_id]"])
      await expect(db.query(`UPDATE installation_device_pairings SET ${fields} WHERE pairing_id=$1`,[p.input.installation.request_id])).rejects.toMatchObject({code:"23514",constraint:"installation_recovery_scope"});
    expect((await p.flow.exchange()).json().collection_ids).toEqual([target]);
  });
  it("recovery target rejects parent approval with an unapproved child and null epoch", async () => {
    const owner=await account(), target=await scopeCollection(owner.user);
    const p=await prepared("app-runtime",false,owner,undefined,tasknotesId,target);
    await expect(db.query("UPDATE pairing_requests SET approved_at=now() WHERE id=$1",[p.input.installation.request_id])).rejects.toMatchObject({code:"23514",constraint:"installation_recovery_approval_complete"});
    expect((await db.query("SELECT approved_at FROM pairing_requests WHERE id=$1",[p.input.installation.request_id])).rows[0].approved_at).toBeNull();
  });
  it("recovery target rejects clearing epoch and changing scope after parent approval", async () => {
    const owner=await account(), target=await scopeCollection(owner.user), other=await scopeCollection(owner.user);
    const p=await prepared("app-runtime",false,owner,undefined,tasknotesId,target);
    expect((await approveDevice(p.flow,owner,undefined,{collection_ids:[target],create_collections:false,selected_collection_id:target})).statusCode).toBe(200);
    await expect(db.query("UPDATE installation_device_pairings SET approved_session_epoch=NULL,approved_collection_ids=ARRAY[$2::uuid],selected_collection_id=$2 WHERE pairing_id=$1",[p.input.installation.request_id,other])).rejects.toMatchObject({code:"23514",constraint:"installation_recovery_scope"});
    expect((await p.flow.exchange()).json().collection_ids).toEqual([target]);
  });
  it("recovery target rejects an unapproved-shaped child beneath an approved parent", async () => {
    const owner=await account(), target=await scopeCollection(owner.user);
    const p=await prepared("app-runtime",false,owner,undefined,tasknotesId,target);
    expect((await approveDevice(p.flow,owner,undefined,{collection_ids:[target],create_collections:false,selected_collection_id:target})).statusCode).toBe(200);
    await expect(db.query("UPDATE installation_device_pairings SET approved_session_epoch=NULL,approved_collection_ids='{}'::uuid[],selected_collection_id=NULL WHERE pairing_id=$1",[p.input.installation.request_id])).rejects.toMatchObject({code:"23514",constraint:"installation_recovery_approval_complete"});
    expect((await p.flow.exchange()).json().collection_ids).toEqual([target]);
  });
  it("recovery target rejects committing complete child scope without parent approval", async () => {
    const owner=await account(), target=await scopeCollection(owner.user);
    const p=await prepared("app-runtime",false,owner,undefined,tasknotesId,target);
    await expect(db.query("UPDATE installation_device_pairings SET approved_session_epoch=0,approved_collection_ids=ARRAY[$2::uuid],selected_collection_id=$2 WHERE pairing_id=$1",[p.input.installation.request_id,target])).rejects.toMatchObject({code:"23514",constraint:"installation_recovery_approval_complete"});
    expect((await db.query("SELECT approved_session_epoch,approved_collection_ids FROM installation_device_pairings WHERE pairing_id=$1",[p.input.installation.request_id])).rows[0]).toEqual({approved_session_epoch:null,approved_collection_ids:[]});
  });
  it.each(["child-first","parent-first"])("recovery target permits complete approval in one transaction (%s)", async order => {
    const owner=await account(), target=await scopeCollection(owner.user);
    const p=await prepared("app-runtime",false,owner,undefined,tasknotesId,target), client=await db.connect();
    try {
      await client.query("BEGIN");
      const statements=["UPDATE installation_device_pairings SET approved_session_epoch=(SELECT session_epoch FROM users WHERE id=$3),approved_collection_ids=ARRAY[$2::uuid],selected_collection_id=$2 WHERE pairing_id=$1","UPDATE pairing_requests SET approved_at=now() WHERE id=$1"];
      if(order==="parent-first")statements.reverse();
      for(const sql of statements)await client.query(sql,sql.includes("$2")?[p.input.installation.request_id,target,owner.user]:[p.input.installation.request_id]);
      await client.query("COMMIT");
    } finally {await client.query("ROLLBACK");client.release();}
    expect((await p.flow.exchange()).json().collection_ids).toEqual([target]);
  });
  it("recovery target rechecks the session epoch after waiting for the account lock post-attestation", async () => {
    const owner=await account(), target=await scopeCollection(owner.user);
    const p=await prepared("app-runtime",false,owner,undefined,tasknotesId,target), blocker=await db.connect();
    const blockerPid=(await blocker.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await blocker.query("BEGIN");await blocker.query("UPDATE users SET session_epoch=session_epoch+1 WHERE id=$1",[owner.user]);
    const pending=approveDevice(p.flow,owner,undefined,{collection_ids:[target],create_collections:false,selected_collection_id:target});
    try {
      let waiting=false;
      for(let i=0;i<200&&!waiting;i++){
        waiting=(await db.query<{waiting:boolean}>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT account_backend FROM users%FOR UPDATE%' AND $1=ANY(pg_blocking_pids(pid))) AS waiting",[blockerPid])).rows[0].waiting;
        if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(waiting,"approval must pass cookie authentication and block on its account FOR UPDATE").toBe(true);
      await blocker.query("COMMIT");
      const refused=await pending;expect(refused.statusCode,refused.body).toBe(403);expect(refused.json().error.code).toBe("identity_not_current");
      expect((await db.query("SELECT approved_at FROM pairing_requests WHERE id=$1",[p.input.installation.request_id])).rows[0].approved_at).toBeNull();
      expect((await db.query("SELECT approved_collection_ids,selected_collection_id,timer_consent FROM installation_device_pairings WHERE pairing_id=$1",[p.input.installation.request_id])).rows[0]).toEqual({approved_collection_ids:[],selected_collection_id:null,timer_consent:null});
      expect((await db.query("SELECT id FROM next_devices WHERE id=$1",[p.input.installation.device_id])).rows).toEqual([]);
      expect((await db.query("SELECT connector_id FROM installation_collection_scopes WHERE connector_id=$1",[p.selected.connector_id])).rows).toEqual([]);
      expect((await db.query("SELECT id FROM next_background_grants WHERE approval_request_id=$1",[p.input.installation.request_id])).rows).toEqual([]);
    } finally {await blocker.query("ROLLBACK");blocker.release();await pending;}
  });
  it("recovery target fields remain omitted from all ordinary Add responses", async () => {
    const input=original(), started=await app.inject({method:"POST",url:"/v1/pairing-requests",headers:originHeaders(input),payload:input});
    expect(started.statusCode).toBe(201);expect(started.json()).not.toHaveProperty("recovery_collection_id");
    const p=await prepared();expect(p.selected).not.toHaveProperty("recovery_collection_id");
    expect((await app.inject({method:"GET",url:p.flow.base,headers:p.owner.headers})).json().pairing).not.toHaveProperty("recovery_collection_id");
    expect((await p.flow.exchange()).json()).not.toHaveProperty("recovery_collection_id");
    expect((await approveDevice(p.flow,p.owner)).statusCode).toBe(200);expect((await p.flow.exchange()).json()).not.toHaveProperty("recovery_collection_id");
  });
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
  it("carries a collection hint in the verification URL without resolving or granting it at START", async () => {
    for (const hint of [randomUUID(), await scopeCollection((await account()).user)]) {
      const input = original();
      const result = await app.inject({ method: "POST", url: "/v1/pairing-requests", headers: originHeaders(input), payload: { ...input, collection_hint: hint } });
      expect(result.statusCode, result.body).toBe(201);
      expect(result.json().verification_uri).toBe(`https://connect.test/pair/${input.installation.request_id}?collection_hint=${hint}`);
      expect((await channel(input).exchange()).json()).toEqual({ status: "pending" });
    }
  });
  it("surfaces a collection hint only after explicit account confirmation and only from its approvable list", async () => {
    const owner = await account(), hint = await scopeCollection(owner.user), input = original(), flow = await start(input);
    const inspect = () => app.inject({ method: "GET", url: `${flow.base}?collection_hint=${hint}`, headers: owner.headers });
    expect((await inspect()).json().pairing).toMatchObject({ collections: [{collection_id:hint}], collection_hint: null, selected_collection_id: null });
    expect((await flow.exchange()).json()).toEqual({ status: "pending" });
    expect((await app.inject({ method: "POST", url: `${flow.base}/select-account`, headers: owner.headers })).statusCode).toBe(200);
    expect((await inspect()).json().pairing).toMatchObject({ collection_hint: hint, selected_collection_id: null, approved_collection_ids: [] });
  });
  it("hands back to the app only through a return URL it declared", async () => {
    const web = `https://reader-${randomUUID()}.example.test`, mobile = "capacitor://reader.example.test", back = "dev.example.reader://paired";
    const registered = await upsertApplication(db, registerApplicationManifest({ manifest_version: 1, id: "dev.example.reader", name: "Reader",
      homepage: `${web}/`, redirect_uris: [`${web}/callback`, back], requirements: { access: "full_collection", contracts: [] },
      installation_origins: { lab: { mobile: [mobile] } } }));
    apps.set(registered.id, { name: "Reader", web, mobile });
    const f = await prepared("mobile", false, undefined, undefined, registered.id);
    const inspect = (returnUrl: string) => app.inject({ method: "GET", url: `${f.flow.base}?return_url=${encodeURIComponent(returnUrl)}`, headers: f.owner.headers });
    expect((await inspect(back)).json().pairing.return_url).toBe(back);
    for (const other of [`${back}/x`, "https://attacker.example.test/", `${web}/`, "dev.example.other://paired", "com.attacker.app://paired",
      `http://reader.example.test/callback`, web.replace("https:", "http:") + "/callback", "dev.example.reader://*", mobile])
      expect((await inspect(other)).json().pairing.return_url).toBeNull();
  });
  it("never hands back through a wildcard, even one stored before manifests refused them", async () => {
    const web = `https://reader-${randomUUID()}.example.test`, mobile = "capacitor://reader.example.test", wildcard = "dev.example.reader://*";
    const registered = await upsertApplication(db, registerApplicationManifest({ manifest_version: 1, id: "dev.example.reader", name: "Reader",
      homepage: `${web}/`, redirect_uris: [`${web}/callback`], requirements: { access: "full_collection", contracts: [] },
      installation_origins: { lab: { mobile: [mobile] } } }));
    await db.query("UPDATE applications SET redirect_uris=$2::jsonb, application_declaration=jsonb_set(application_declaration,'{redirect_uris}',$2::jsonb) WHERE id=$1",
      [registered.id, JSON.stringify([`${web}/callback`, wildcard])]);
    apps.set(registered.id, { name: "Reader", web, mobile });
    const f = await prepared("mobile", false, undefined, undefined, registered.id);
    const inspect = (returnUrl: string) => app.inject({ method: "GET", url: `${f.flow.base}?return_url=${encodeURIComponent(returnUrl)}`, headers: f.owner.headers });
    for (const other of [wildcard, "dev.example.reader://paired"]) expect((await inspect(other)).json().pairing.return_url).toBeNull();
    expect((await inspect(`${web}/callback`)).json().pairing.return_url).toBe(`${web}/callback`);
  });
  it("hands back to no URL for an app that never declared one", async () => {
    const f = await prepared("mobile");
    const r = await app.inject({ method: "GET", url: `${f.flow.base}?return_url=${encodeURIComponent("dev.example.reader://paired")}`, headers: f.owner.headers });
    expect(r.json().pairing.return_url).toBeNull();
  });
  it("does not distinguish ineligible collection hints or grant from an eligible Private/Hosted hint", async () => {
    const p = await prepared(), target = await scopeCollection(p.owner.user), chosen = await scopeCollection(p.owner.user);
    const other = await account(), foreign = await scopeCollection(other.user), priv = await scopeCollection(p.owner.user), left = await scopeCollection(p.owner.user), revoked = await scopeCollection(p.owner.user);
    await db.query("UPDATE next_collections SET sync='private' WHERE collection_id=$1", [priv]);
    await db.query("UPDATE next_collections SET left_sync_at=now() WHERE collection_id=$1", [left]);
    await db.query("INSERT INTO next_policy_outbox(collection_id,ops) VALUES($1,$2)", [revoked, JSON.stringify({ version: 1, ops: [{ op: "device-revoke", device: p.input.installation.device_id }] })]);
    const inspect = (hint?: string) => app.inject({ method: "GET", url: `${p.flow.base}${hint ? `?collection_hint=${hint}` : ""}`, headers: p.owner.headers });
    const baseline = await inspect(); expect(baseline.statusCode).toBe(200); expect(baseline.json().pairing.collection_hint).toBeNull();
    for (const hint of [foreign, left, revoked, randomUUID()]) {
      const result = await inspect(hint); expect(result.statusCode).toBe(200); expect(result.body).toBe(baseline.body);
    }
    expect((await inspect(target)).json().pairing.collection_hint).toBe(target);
    expect((await inspect(priv)).json().pairing.collection_hint).toBe(priv);
    expect((await approvePrivate(p,priv)).statusCode).toBe(409); // A hint is no signed companion or consent.
    expect((await db.query("SELECT collection_id FROM installation_collection_scopes WHERE connector_id=$1", [p.selected.connector_id])).rows).toEqual([]);
    expect((await app.inject({ method: "POST", url: `${p.flow.base}/approve`, headers: p.owner.headers, payload: { fingerprint: clientFingerprint(Buffer.from(p.proof.payload.sign_pk, "hex")), collection_ids: [chosen], create_collections: false, selected_collection_id: chosen } })).statusCode).toBe(200);
    expect((await p.flow.exchange()).json().selected_collection_id).toBe(chosen);
    expect((await db.query("SELECT collection_id FROM installation_collection_scopes WHERE connector_id=$1", [p.selected.connector_id])).rows).toEqual([{ collection_id: chosen }]);
  });
  it("carries a collection hint for reconsent but still requires fresh account confirmation", async () => {
    const p = await prepared(); expect((await approveDevice(p.flow, p.owner)).statusCode).toBe(200);
    const credential = (await p.flow.exchange()).json(), hint = await scopeCollection(p.owner.user);
    const input = { ...p.input, installation: { ...p.input.installation, request_id: randomUUID(), pairing_secret: randomToken("pair"), reconsent: true } };
    const started = await app.inject({ method: "POST", url: "/v1/pairing-requests", headers: { ...originHeaders(input), authorization: `Bearer ${credential.token}` }, payload: { ...input, collection_hint: hint } });
    expect(started.statusCode, started.body).toBe(201); expect(new URL(started.json().verification_uri).searchParams.get("collection_hint")).toBe(hint);
    const flow = channel(input), url = `${flow.base}?collection_hint=${hint}`;
    expect((await app.inject({ method: "GET", url, headers: p.owner.headers })).json().pairing.collection_hint).toBeNull();
    expect((await app.inject({ method: "POST", url: `${flow.base}/select-account`, headers: p.owner.headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url, headers: p.owner.headers })).json().pairing.collection_hint).toBe(hint);
  });
  it.each(["not-a-uuid", "00000000-0000-0000-0000-000000000000", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"])("rejects malformed collection hint %s before creating a request", async hint => {
    const input = original();
    expect((await app.inject({ method: "POST", url: "/v1/pairing-requests", headers: originHeaders(input), payload: { ...input, collection_hint: hint } })).statusCode).toBe(400);
    expect((await db.query("SELECT id FROM pairing_requests WHERE id=$1", [input.installation.request_id])).rows).toEqual([]);
  });
  async function rescope(p:Awaited<ReturnType<typeof prepared>>,token:string,create=false,origin=originHeaders(p.input).origin) {
    const input={...p.input,installation:{...p.input.installation,request_id:randomUUID(),pairing_secret:randomToken("pair"),reconsent:true,requested_create_collections:create}};
    const result=await app.inject({method:"POST",url:"/v1/pairing-requests",headers:{origin,authorization:`Bearer ${token}`},payload:input});
    expect(result.statusCode,result.body).toBe(201);
    return {input,flow:channel(input)};
  }
  it("enforces complete confirmation and rejects created IDs without a final selection in PostgreSQL",async()=>{
    const p=await prepared();
    await expect(db.query("UPDATE installation_device_pairings SET portal_account_email=NULL WHERE pairing_id=$1",[p.input.installation.request_id])).rejects.toMatchObject({code:"23514"});
    await expect(db.query("UPDATE installation_device_pairings SET created_collection_ids=$2 WHERE pairing_id=$1",[p.input.installation.request_id,[randomUUID()]])).rejects.toMatchObject({code:"23514"});
    const row=(await db.query("SELECT portal_account_email,selected_collection_id,created_collection_ids FROM installation_device_pairings WHERE pairing_id=$1",[p.input.installation.request_id])).rows[0];
    expect(row).toEqual({portal_account_email:p.selected.account_email,selected_collection_id:null,created_collection_ids:[]});
  });
  it("previews only the authenticated portal account's catalog without disclosing it or identity to the SDK",async()=>{
    const owner=await account(), other=await account();
    const own=await scopeCollection(owner.user), foreign=await scopeCollection(other.user);
    const input=original(), flow=await start(input);
    expect((await app.inject({method:"GET",url:flow.base})).statusCode).toBe(401);
    const shown=(await app.inject({method:"GET",url:flow.base,headers:owner.headers})).json().pairing;
    expect(shown).toMatchObject({app_origin:webOrigin,account_selected:false,signed_in_account_email:`${owner.user}@example.test`});
    expect(shown.collections.map((c:{collection_id:string})=>c.collection_id)).toEqual([own]);
    expect(shown.collections.some((c:{collection_id:string})=>c.collection_id===foreign)).toBe(false);
    expect(shown.account_selection_confirmed).toBeUndefined();
    expect((await flow.exchange()).json()).toEqual({status:"pending"});
    const row=(await db.query("SELECT p.user_id,d.portal_account_confirmed_at,d.account_selected_at FROM pairing_requests p JOIN installation_device_pairings d ON d.pairing_id=p.id WHERE p.id=$1",[input.installation.request_id])).rows[0];
    expect(row).toEqual({user_id:null,portal_account_confirmed_at:null,account_selected_at:null});
    expect((await db.query("SELECT id FROM next_devices WHERE id=$1",[input.installation.device_id])).rows).toEqual([]);
    expect((await app.inject({method:"POST",url:`${flow.base}/approve`,headers:owner.headers,payload:{collection_ids:[own],selected_collection_id:own,create_collections:false}})).statusCode).toBeGreaterThanOrEqual(400);
    expect((await flow.exchange()).json()).toEqual({status:"pending"});
  });
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
  async function approvePicked(p:Awaited<ReturnType<typeof prepared>>,flow:ReturnType<typeof channel>,ids:string[],selected:string,timers?:boolean) {
    return app.inject({method:"POST",url:`${flow.base}/approve`,headers:p.owner.headers,payload:{fingerprint:clientFingerprint(Buffer.from(p.proof.payload.sign_pk,"hex")),collection_ids:ids,selected_collection_id:selected,...(timers!==undefined?{timer_consent:timers}:{})}});
  }
  async function timerApp(nativeDelivery?: {mode:"managed_fcm";firebase_project_id:string}|{mode:"webhook";url:string}) {
    const id = await registeredApp(`bundle:synthetic.reminders.${randomUUID()}`);
    await db.query("UPDATE applications SET requirements=$2::jsonb,notifications=$3::jsonb WHERE id=$1", [id,
      JSON.stringify({access:"full_collection",contracts:[],capabilities:{contract_version:2,required:["collection.read"],optional:["background.schedule"]}}),
      JSON.stringify({criteria:[{id:"synthetic.reminder",event:MDBASE_TIMER_FIRED_CONTRACT,presentation:{title:"Reminder"}}],...(nativeDelivery?{native_delivery:nativeDelivery}:{})})]);
    return id;
  }
  it("issues genuine installation timer grants for only the approved request collections, with exact stable exchange metadata",async()=>{
    const id=await timerApp(),p=await prepared("app-runtime",true,undefined,undefined,id);
    const first=await scopeCollection(p.owner.user),second=await scopeCollection(p.owner.user),unselected=await scopeCollection(p.owner.user);
    const approved=await app.inject({method:"POST",url:`${p.flow.base}/approve`,headers:p.owner.headers,payload:{fingerprint:clientFingerprint(Buffer.from(p.proof.payload.sign_pk,"hex")),collection_ids:[first,second],selected_collection_id:first,create_collections:true,timer_consent:true}});
    expect(approved.statusCode,approved.body).toBe(200);
    expect((await db.query("SELECT 1 FROM next_background_grants WHERE approval_request_id=$1",[p.input.installation.request_id])).rows).toHaveLength(0);
    const receipt=(await p.flow.exchange()).json();
    expect(receipt.status).toBe("paired"); expect(receipt.timer_consent).toBe(true);
    expect(receipt.timer_grants.map((grant:{collection_id:string})=>grant.collection_id)).toEqual([first,second].sort());
    expect(receipt.timer_grants.some((grant:{collection_id:string})=>grant.collection_id===unselected)).toBe(false);
    const rows=(await db.query("SELECT * FROM next_background_grants WHERE approval_request_id=$1 ORDER BY collection_id",[p.input.installation.request_id])).rows;
    expect(rows).toHaveLength(2);
    for(const grant of rows) {
      expect(grant).toMatchObject({principal_kind:"installation",legacy_grant_id:null,native_connector_id:p.selected.connector_id,installation_id:p.input.installation.installation_id,device_id:p.input.installation.device_id,user_id:p.owner.user,application_id:id});
      expect(grant.sign_pk.toString("hex")).toBe(p.proof.payload.sign_pk);
      expect(grant.kem_pk.toString("hex")).toBe(p.proof.payload.kem_pk);
      expect(grant.noise_pk.toString("hex")).toBe(p.proof.payload.noise_pk);
      expect(grant.timer_declaration.digest).toBe(receipt.timer_grants.find((ref:{grant_id:string})=>ref.grant_id===grant.id).declaration_digest);
    }
    expect((await db.query("SELECT 1 FROM grants WHERE id=ANY($1::uuid[])",[rows.map(row=>row.id)])).rowCount).toBe(0);
    for(const reply of await Promise.all([p.flow.exchange(),p.flow.exchange()])) {
      expect(publicOutcome(reply.json())).toEqual(publicOutcome(receipt));
      expect(tokenHash(reply.json().token)).toBe(tokenHash(receipt.token));
    }
    expect((await db.query("SELECT 1 FROM next_background_grants WHERE approval_request_id=$1",[p.input.installation.request_id])).rows).toHaveLength(2);
  });
  async function currentTimerFixture(application?:string) {
    const p=await prepared("app-runtime",false,undefined,undefined,application ?? await timerApp()),collection=await scopeCollection(p.owner.user);
    expect((await approvePicked(p,p.flow,[collection],collection,true)).statusCode).toBe(200);
    const receipt=(await p.flow.exchange()).json(),grantId=receipt.timer_grants[0].grant_id as string;
    const batch=(await db.query("INSERT INTO next_policy_batches(collection_id,seq,prev,item,issued_at,state) VALUES($1,2,$2,$3,2,'appended') RETURNING id",[collection,Buffer.alloc(32),Buffer.alloc(1)])).rows[0].id;
    const enrol={op:"device-enrol",device:p.input.installation.device_id,account:p.owner.user,kind:p.input.installation.kind,
      signPublicKey:{$hex:p.proof.payload.sign_pk},kemPublicKey:{$hex:p.proof.payload.kem_pk},noisePublicKey:{$hex:p.proof.payload.noise_pk}};
    await db.query("INSERT INTO next_policy_outbox(collection_id,ops,batch_id) VALUES($1,$2,$3)",[collection,JSON.stringify({version:1,ops:[enrol]}),batch]);
    const resolver=backgroundTimerGrantResolver(db,"lab");
    expect((await resolver.resolve(db,grantId))?.usable).toBe(true);
    return {p,collection,grantId,batch,resolver,token:receipt.token as string};
  }
  const timerPath = (f:Awaited<ReturnType<typeof currentTimerFixture>>) => `/v1/next/collections/${f.collection}/background-grants/${f.grantId}/timers/reminders`;
  it("authenticates the original installation consent on the shared opaque timer and exact receipt routes",async()=>{
    const f=await currentTimerFixture(),headers={authorization:`Bearer ${f.token}`},base=timerPath(f);
    const fire_at=new Date(Date.now()+3_600_000).toISOString();
    const listed=await app.inject({method:"GET",url:base,headers});
    expect(listed.statusCode,listed.body).toBe(200);
    expect(listed.json()).toEqual({namespace:"reminders",intent_revision:0,timers:[]});
    const opaque=await app.inject({method:"PUT",url:`${base}/one`,headers,payload:{criterion_id:"synthetic.reminder",fire_at,data:{content:"never store"}}});
    expect(opaque.statusCode,opaque.body).toBe(400);
    expect((await db.query("SELECT 1 FROM next_timers WHERE grant_id=$1",[f.grantId])).rows).toHaveLength(0);
    const put=await app.inject({method:"PUT",url:`${base}/one`,headers,payload:{criterion_id:"synthetic.reminder",fire_at}});
    expect(put.statusCode,put.body).toBe(200); expect(put.json().generation).toBe(1);
    expect(put.json().data).toBeUndefined();
    const operation_id=Date.now().toString(16).padStart(12,"0").replace(/(.{8})(.{4})/,"$1-$2")+"-7000-8000-"+randomUUID().slice(-12);
    const payload={criterion_id:"synthetic.reminder",timers:[{id:"two",fire_at}],recovery:{protocol_version:1,operation_id,expected_revision:1}};
    const receipt=await app.inject({method:"POST",url:`${base}/reconcile`,headers,payload});
    expect(receipt.statusCode,receipt.body).toBe(200);
    expect(receipt.json()).toMatchObject({protocol_version:1,operation_id,expected_revision:1,committed_revision:2,result:{cancelled_ids:["one"]}});
    const replay=await app.inject({method:"POST",url:`${base}/reconcile`,headers,payload});
    expect(replay.statusCode,replay.body).toBe(200); expect(replay.json()).toEqual(receipt.json());
    const lookup=await app.inject({method:"GET",url:`${base}/operations/${operation_id}`,headers});
    expect(lookup.statusCode,lookup.body).toBe(200); expect(lookup.json()).toEqual({outcome:"committed",receipt:receipt.json()});
    const conflict=await app.inject({method:"POST",url:`${base}/reconcile`,headers,payload:{...payload,timers:[]}});
    expect(conflict.statusCode).toBe(409); expect(conflict.json().error.code).toBe("operation_conflict");
    const unknown=await app.inject({method:"GET",url:`${base}/operations/${operation_id.slice(0,-12)+randomUUID().slice(-12)}`,headers});
    expect(unknown.statusCode).toBe(200); expect(unknown.json().outcome).toBe("unknown");
    const cancelled=await app.inject({method:"DELETE",url:`${base}/two?generation=1`,headers});
    expect(cancelled.statusCode,cancelled.body).toBe(200); expect(cancelled.json().cancelled).toBe(true);
    expect((await db.query("SELECT intent_revision FROM next_timer_namespace_intents WHERE grant_id=$1",[f.grantId])).rows[0].intent_revision).toBe("3");
    await db.query("UPDATE next_background_grants SET revoked_at=now() WHERE id=$1",[f.grantId]);
    expect((await app.inject({method:"GET",url:`${base}/operations/${operation_id}`,headers})).statusCode).toBe(403);
  });
  it("never treats public consent references, other installations, ordinary controller or legacy/internal credentials as native timer authority",async()=>{
    const f=await currentTimerFixture(),other=await currentTimerFixture(),base=timerPath(f);
    for(const headers of [{},{authorization:"Bearer invalid"},{authorization:`Bearer ${other.token}`}]) {
      expect((await app.inject({method:"GET",url:base,headers})).statusCode).toBe(401);
    }
    const ordinary=randomToken("connector");
    await db.query("UPDATE connectors SET token_hash=$2 WHERE id=$1",[f.p.selected.connector_id,tokenHash(ordinary)]);
    expect((await app.inject({method:"GET",url:"/test/controller-scope",headers:{authorization:`Bearer ${ordinary}`}})).statusCode).toBe(200);
    expect((await app.inject({method:"GET",url:base,headers:{authorization:`Bearer ${ordinary}`}})).statusCode).toBe(401);
    const headers={authorization:`Bearer ${f.token}`};
    expect((await app.inject({method:"GET",url:base.replace(f.collection,other.collection),headers})).statusCode).toBe(403);
    expect((await app.inject({method:"GET",url:base.replace(f.grantId,other.grantId),headers})).statusCode).toBe(401);
    expect((await app.inject({method:"GET",url:`/v1/next/collections/${f.collection}/timers/reminders`,headers})).statusCode).toBe(401);
    expect((await app.inject({method:"GET",url:`/internal/v1/next/timers/${f.grantId}/reminders`,headers})).statusCode).toBe(401);
    const p=await prepared("app-runtime",false,undefined,undefined,await timerApp()),collection=await scopeCollection(p.owner.user);
    expect((await approvePicked(p,p.flow,[collection],collection,false)).statusCode).toBe(200);
    const receipt=(await p.flow.exchange()).json();
    expect((await app.inject({method:"GET",url:base,headers:{authorization:`Bearer ${receipt.token}`}})).statusCode).toBe(401);
    await db.query("UPDATE installation_device_credentials SET token_hash=$2 WHERE connector_id=$1",[f.p.selected.connector_id,tokenHash(randomToken("ct"))]);
    expect((await app.inject({method:"GET",url:base,headers})).statusCode).toBe(401);
  });
  it("rechecks the dedicated credential after preliminary timer admission, not just its public grant reference",async()=>{
    const f=await currentTimerFixture(),receiver=Fastify(); let changed=false;
    registerErrorHandler(receiver);
    registerTimerRoutes(receiver,{db,resolver:{async resolve(queryable,id) {
      const grant=await f.resolver.resolve(queryable,id);
      if(queryable===db && !changed) {
        changed=true;
        await db.query("UPDATE installation_device_credentials SET token_hash=$2 WHERE connector_id=$1",[f.p.selected.connector_id,tokenHash(randomToken("ct"))]);
      }
      return grant;
    }}});
    try {
      const result=await receiver.inject({method:"PUT",url:`${timerPath(f)}/one`,headers:{authorization:`Bearer ${f.token}`},payload:{criterion_id:"synthetic.reminder",fire_at:new Date(Date.now()+3_600_000).toISOString()}});
      expect(changed).toBe(true); expect(result.statusCode,result.body).toBe(401);
      expect((await db.query("SELECT 1 FROM next_timers WHERE grant_id=$1",[f.grantId])).rows).toHaveLength(0);
    } finally { await receiver.close(); }
  });
  it("holds native policy before waiting on the shared real timer namespace lock",async()=>{
    const f=await currentTimerFixture(),blocker=await db.connect(),probe=await db.connect();
    let pending:ReturnType<typeof app.inject>|undefined;
    try {
      await blocker.query("BEGIN"); await lockNamespace(blocker,f.grantId,"reminders");
      const pid=(await blocker.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      pending=app.inject({method:"GET",url:timerPath(f),headers:{authorization:`Bearer ${f.token}`}});
      let waiting=false;
      for(let attempt=0;attempt<100;attempt++) {
        waiting=(await db.query<{waiting:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_locks w JOIN pg_locks h
          ON h.locktype=w.locktype AND h.classid=w.classid AND h.objid=w.objid AND h.objsubid=w.objsubid
          WHERE h.pid=$1 AND h.locktype='advisory' AND h.granted AND NOT w.granted) AS waiting`,[pid])).rows[0].waiting;
        if(waiting) break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(waiting).toBe(true);
      await probe.query("BEGIN"); await probe.query("SET LOCAL lock_timeout = '100ms'");
      await expect(probe.query("SELECT 1 FROM next_collections WHERE collection_id=$1 FOR UPDATE",[f.collection])).rejects.toMatchObject({code:"55P03"});
      await probe.query("ROLLBACK"); await blocker.query("COMMIT");
      expect((await pending).statusCode).toBe(200);
    } finally {
      await probe.query("ROLLBACK"); await blocker.query("ROLLBACK");
      if(pending) await pending;
      probe.release(); blocker.release();
    }
  });
  it.each(["declaration","device-key","member-remove","scope"])("rechecks native timer HTTP authority after %s changes",async change=>{
    const f=await currentTimerFixture(),headers={authorization:`Bearer ${f.token}`},base=timerPath(f);
    expect((await app.inject({method:"GET",url:base,headers})).statusCode).toBe(200);
    if(change==="declaration") await db.query("UPDATE applications SET notifications=$2::jsonb WHERE id=$1",[f.p.input.installation.app_id,JSON.stringify({criteria:[]})]);
    if(change==="device-key") await db.query("UPDATE next_devices SET noise_pk=$2 WHERE id=$1",[f.p.input.installation.device_id,Buffer.alloc(32,91)]);
    if(change==="member-remove") await db.query("INSERT INTO next_policy_outbox(collection_id,ops) VALUES($1,$2)",[f.collection,JSON.stringify({version:1,ops:[{op:"member-remove",account:f.p.owner.user}]})]);
    if(change==="scope") await db.query("DELETE FROM installation_collection_scopes WHERE connector_id=$1 AND collection_id=$2",[f.p.selected.connector_id,f.collection]);
    expect((await app.inject({method:"GET",url:base,headers})).statusCode).toBe(403);
    expect((await db.query("SELECT 1 FROM next_timers WHERE grant_id=$1",[f.grantId])).rows).toHaveLength(0);
  });
  it("reapproves native reminder consent using the actual no-email provider confirmation without changing device custody",async()=>{
    const f=await currentTimerFixture(),login=`fixture-${randomUUID().slice(0,8)}`;
    await db.query("UPDATE users SET email=NULL,name='Not provider identity' WHERE id=$1",[f.p.owner.user]);
    await db.query("INSERT INTO external_identities(provider,subject,user_id,login,email,email_verified) VALUES('github',$1,$2,$3,NULL,false)",[randomUUID(),f.p.owner.user,login]);
    await db.query("UPDATE sessions SET provider='github' WHERE id=$1",[f.p.owner.session]);
    const input=original(); input.installation.installation_id=f.p.input.installation.installation_id;
    input.installation.device_id=f.p.input.installation.device_id; input.installation.app_id=f.p.input.installation.app_id; input.installation.reconsent=true;
    expect((await app.inject({method:"POST",url:"/v1/pairing-requests",headers:{...originHeaders(input),authorization:`Bearer ${f.token}`},payload:input})).statusCode).toBe(201);
    const flow=channel(input);
    expect((await app.inject({method:"POST",url:`${flow.base}/select-account`,headers:f.p.owner.headers,payload:{email:"not-authority@example.test",login:"not-authority"}})).statusCode).toBe(200);
    expect((await approvePicked(f.p,flow,[f.collection],f.collection,true)).statusCode).toBe(200);
    const receipt=(await flow.exchange()).json();
    expect(receipt).toMatchObject({status:"scope_updated",account_email:null,account_provider:"github",account_login:login,account_selection_confirmed:true,timer_consent:true});
    expect(receipt.timer_grants).toHaveLength(1); expect(receipt.timer_grants[0].grant_id).not.toBe(f.grantId);
    const credential=(await db.query("SELECT device_id,sign_pk,kem_pk,noise_pk,token_hash FROM installation_device_credentials WHERE connector_id=$1",[f.p.selected.connector_id])).rows[0];
    expect(credential.device_id).toBe(input.installation.device_id); expect(credential.token_hash).toBe(tokenHash(f.token));
    for(const key of ["sign_pk","kem_pk","noise_pk"] as const) expect(credential[key].toString("hex")).toBe(f.p.proof.payload[key]);
    expect((await f.resolver.resolve(db,f.grantId))?.usable).toBe(false);
    expect((await app.inject({method:"GET",url:timerPath(f).replace(f.grantId,receipt.timer_grants[0].grant_id),headers:{authorization:`Bearer ${f.token}`}})).statusCode).toBe(200);
  });
  const channelPath = (f:Awaited<ReturnType<typeof currentTimerFixture>>) => timerPath(f).replace("/timers/reminders","/notifications/channels");
  const webChannel = (f:Awaited<ReturnType<typeof currentTimerFixture>>) => ({installation_id:f.p.input.installation.installation_id,
    criteria:["synthetic.reminder"],subscription:{endpoint:"https://push.example.test/synthetic",expirationTime:null,keys:{p256dh:"synthetic-p256dh-key",auth:"synthetic-auth"}}});
  it("registers and removes native channels with the same current authority and sealed original installation scope",async()=>{
    const f=await currentTimerFixture(),headers={authorization:`Bearer ${f.token}`},url=channelPath(f),payload=webChannel(f);
    const registered=await app.inject({method:"POST",url,headers,payload});
    expect(registered.statusCode,registered.body).toBe(201);
    const channel=registered.json().channel_id;
    const row=(await db.query("SELECT * FROM push_channels WHERE id=$1",[channel])).rows[0];
    expect(row).toMatchObject({grant_id:f.grantId,installation_id:payload.installation_id,kind:"web_push",endpoint:null,p256dh:null,auth:null,fcm_token:null,sealed_key_id:"synthetic"});
    expect(channelSealer.open(f.grantId,payload.installation_id,row.sealed_target).endpoint).toBe(payload.subscription.endpoint);
    const repeated=await app.inject({method:"POST",url,headers,payload});
    expect(repeated.statusCode,repeated.body).toBe(201); expect(repeated.json().channel_id).toBe(channel);
    const sealed=(await db.query("SELECT sealed_target FROM push_channels WHERE id=$1",[channel])).rows[0].sealed_target;
    expect((await app.inject({method:"POST",url,headers,payload:{...payload,criteria:["not-approved"]}})).statusCode).toBe(400);
    expect((await app.inject({method:"POST",url,headers,payload:{...payload,installation_id:randomUUID()}})).statusCode).toBe(403);
    expect((await db.query("SELECT sealed_target FROM push_channels WHERE id=$1",[channel])).rows[0].sealed_target).toBe(sealed);
    expect((await db.query("SELECT criterion_id FROM notification_subscriptions WHERE channel_id=$1",[channel])).rows).toEqual([{criterion_id:"synthetic.reminder"}]);
    expect((await app.inject({method:"DELETE",url:`${url}/${randomUUID()}`,headers})).statusCode).toBe(404);
    expect((await app.inject({method:"DELETE",url:`${url}/${channel}`,headers})).statusCode).toBe(204);
    expect((await db.query("SELECT 1 FROM push_channels WHERE id=$1",[channel])).rows).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM notification_subscriptions WHERE channel_id=$1",[channel])).rows).toHaveLength(0);
  });
  it("never admits another installation, cookie, ordinary or legacy channel route and refuses unsealed native targets",async()=>{
    const f=await currentTimerFixture(),other=await currentTimerFixture(),url=channelPath(f),payload=webChannel(f),headers={authorization:`Bearer ${f.token}`};
    for(const bad of [{},f.p.owner.headers,{authorization:"Bearer invalid"},{authorization:`Bearer ${other.token}`}]) {
      expect((await app.inject({method:"POST",url,headers:bad,payload})).statusCode).toBe(401);
    }
    expect((await app.inject({method:"POST",url:url.replace(f.collection,other.collection),headers,payload})).statusCode).toBe(403);
    expect((await app.inject({method:"POST",url:"/v1/notifications/channels",headers,payload})).statusCode).toBe(401);
    const unsealed=Fastify(); registerErrorHandler(unsealed);
    registerNotificationRoutes(unsealed,{db,grantResolver:f.resolver,transports,service:new NotificationService(db,transports,1000,()=>undefined,undefined,f.resolver)});
    try { expect((await unsealed.inject({method:"POST",url,headers,payload})).statusCode).toBe(503); }
    finally { await unsealed.close(); }
    expect((await db.query("SELECT 1 FROM push_channels WHERE grant_id=$1",[f.grantId])).rows).toHaveLength(0);
    await db.query("UPDATE next_background_grants SET revoked_at=now() WHERE id=$1",[f.grantId]);
    expect((await app.inject({method:"POST",url,headers,payload})).statusCode).toBe(403);
  });
  it("wires the one native resolver into configured app timers and channels, and rejects an unspecified registry environment",async()=>{
    const f=await currentTimerFixture(),root=generateKeyPairSync("ed25519").privateKey,policy=generateKeyPairSync("ed25519").privateKey;
    const cert={policyPublicKey:ed25519RawPublicKey(policy),root:keyId(ed25519RawPublicKey(root)),notBefore:Date.now()-60_000,notAfter:Date.now()+30*86_400_000};
    const pem=(key:typeof root)=>key.export({format:"pem",type:"pkcs8"}).toString();
    const next:NextControlPlaneConfig={rootPublicKey:ed25519RawPublicKey(root),policyPrivateKeyPem:pem(policy),policyCert:certToJson({...cert,signature:sign(null,certDigest(cert),root)}),
      serviceTokens:{},logService:{url:"http://127.0.0.1:1",tokenIssuerKeyPem:pem(policy),transportKeyPem:pem(generateKeyPairSync("ed25519").privateKey)}};
    await expect(buildApp({db,nextControlPlane:next,nextTimers:{}})).rejects.toThrow("Native timers require a configured installation registry environment.");
    const built=await buildApp({db,environment:"lab",publicUrl:"https://connect.example.test",nextControlPlane:next,nextTimers:{pollIntervalMs:60_000},notifications:{transports,pushTargetSealer:channelSealer,pollIntervalMs:60_000}});
    try {
      const headers={authorization:`Bearer ${f.token}`};
      expect((await built.app.inject({method:"GET",url:timerPath(f),headers})).statusCode).toBe(200);
      const result=await built.app.inject({method:"POST",url:channelPath(f),headers,payload:webChannel(f)});
      expect(result.statusCode,result.body).toBe(201);
    } finally { await built.app.close(); }
  });
  it("keeps managed FCM targets sealed without deleting a different native grant's channel",async()=>{
    const id=await timerApp({mode:"managed_fcm",firebase_project_id:"synthetic-project"});
    const first=await currentTimerFixture(id),second=await currentTimerFixture(id),token="synthetic-shared-fcm-token-1234567890";
    for(const f of [first,second]) {
      const result=await app.inject({method:"POST",url:channelPath(f),headers:{authorization:`Bearer ${f.token}`},payload:{installation_id:f.p.input.installation.installation_id,criteria:["synthetic.reminder"],transport:"fcm",token}});
      expect(result.statusCode,result.body).toBe(201);
    }
    const rows=(await db.query("SELECT grant_id,installation_id,sealed_target,fcm_token,fcm_project_id FROM push_channels WHERE grant_id=ANY($1::uuid[])",[[first.grantId,second.grantId]])).rows;
    expect(rows).toHaveLength(2);
    for(const row of rows) {
      expect(row.fcm_token).toBeNull(); expect(row.fcm_project_id).toBe("synthetic-project");
      expect(channelSealer.open(row.grant_id,row.installation_id,row.sealed_target).fcm_token).toBe(token);
    }
    const noFcm=await currentTimerFixture();
    expect((await app.inject({method:"POST",url:channelPath(noFcm),headers:{authorization:`Bearer ${noFcm.token}`},payload:{installation_id:noFcm.p.input.installation.installation_id,criteria:["synthetic.reminder"],transport:"fcm",token}})).statusCode).toBe(400);
  });
  async function dueNativeTimer(f:Awaited<ReturnType<typeof currentTimerFixture>>,future=false) {
    const result=await app.inject({method:"PUT",url:`${timerPath(f)}/due`,headers:{authorization:`Bearer ${f.token}`},payload:{criterion_id:"synthetic.reminder",fire_at:new Date(Date.now()+(future?3_600_000:-1000)).toISOString()}});
    expect(result.statusCode,result.body).toBe(200);
  }
  async function waitForWorkerLock(pid:number,query:string) {
    for(let attempt=0;attempt<200;attempt++) {
      const row=(await db.query<{waiting:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2) AS waiting`,[pid,`%${query}%`])).rows[0];
      if(row.waiting)return;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw new Error("Native timer worker did not wait on the owned PostgreSQL lock.");
  }
  it("holds original native consent before timer CAS wait, then withdrawal denies downstream signal admission",async()=>{
    const f=await currentTimerFixture();await dueNativeTimer(f);
    const blocker=await db.connect(),probe=await db.connect(),worker=new TimerWorker(db,[],{resolver:f.resolver});let firing:Promise<number>|undefined;
    try {
      await blocker.query("BEGIN");await blocker.query("SELECT 1 FROM next_timers WHERE grant_id=$1 FOR UPDATE",[f.grantId]);
      const pid=(await blocker.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      firing=worker.fireDue();void firing.catch(()=>{});await waitForWorkerLock(pid,"UPDATE next_timers");
      await probe.query("BEGIN");await probe.query("SET LOCAL lock_timeout='100ms'");
      await expect(probe.query("UPDATE next_background_grants SET revoked_at=clock_timestamp() WHERE id=$1",[f.grantId])).rejects.toMatchObject({code:"55P03"});
      await probe.query("ROLLBACK");await blocker.query("COMMIT");expect(await firing).toBe(1);
      await db.query("UPDATE next_background_grants SET revoked_at=clock_timestamp() WHERE id=$1",[f.grantId]);
      const consumer=notificationsConsumer(()=>undefined,f.resolver);await worker.drainConsumer(consumer);
      const event=timerEventId(f.grantId,"reminders","due",1);
      expect((await db.query("SELECT event_id,generation,data FROM next_timer_events WHERE grant_id=$1",[f.grantId])).rows).toEqual([{event_id:event,generation:"1",data:null}]);
      expect((await db.query("SELECT 1 FROM next_timer_event_receipts WHERE event_id=$1 AND consumer='notifications'",[event])).rows).toHaveLength(1);
      expect((await db.query("SELECT 1 FROM notification_signals WHERE grant_id=$1",[f.grantId])).rows).toHaveLength(0);
    } finally {try{await probe.query("ROLLBACK");await blocker.query("ROLLBACK");}finally{probe.release();blocker.release();}if(firing)await firing;}
  });
  it("never fires an old native generation after the real timer CAS lock wait replaces it",async()=>{
    const f=await currentTimerFixture();await dueNativeTimer(f);
    const blocker=await db.connect(),worker=new TimerWorker(db,[],{resolver:f.resolver});let firing:Promise<number>|undefined;
    try {
      await blocker.query("BEGIN");await blocker.query("SELECT 1 FROM next_timers WHERE grant_id=$1 FOR UPDATE",[f.grantId]);
      const pid=(await blocker.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      firing=worker.fireDue();void firing.catch(()=>{});await waitForWorkerLock(pid,"UPDATE next_timers");
      await blocker.query("UPDATE next_timers SET generation=2,fire_at=clock_timestamp()+interval '1 hour' WHERE grant_id=$1",[f.grantId]);
      await blocker.query("COMMIT");expect(await firing).toBe(0);
      expect((await db.query("SELECT generation,status,fired_at FROM next_timers WHERE grant_id=$1",[f.grantId])).rows).toEqual([{generation:"2",status:"scheduled",fired_at:null}]);
      expect((await db.query("SELECT 1 FROM next_timer_events WHERE grant_id=$1",[f.grantId])).rows).toHaveLength(0);
    } finally {try{await blocker.query("ROLLBACK");}finally{blocker.release();}if(firing)await firing;}
  });
  it.each(["grant-withdrawal","policy-removal"] as const)("holds native policy before receipt uniqueness wait and serializes %s",async mode=>{
    const f=await currentTimerFixture();await dueNativeTimer(f);const worker=new TimerWorker(db,[],{resolver:f.resolver});expect(await worker.fireDue()).toBe(1);
    const event=timerEventId(f.grantId,"reminders","due",1),blocker=await db.connect(),probe=await db.connect();let draining:Promise<number>|undefined;
    const consumer=notificationsConsumer(()=>undefined,f.resolver);
    try {
      await blocker.query("BEGIN");await blocker.query("INSERT INTO next_timer_event_receipts(consumer,event_id) VALUES('notifications',$1)",[event]);
      const pid=(await blocker.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      draining=worker.drainConsumer(consumer);void draining.catch(()=>{});await waitForWorkerLock(pid,"INSERT INTO next_timer_event_receipts");
      await probe.query("BEGIN");await probe.query("SET LOCAL lock_timeout='100ms'");
      const removal=[f.collection,JSON.stringify({version:1,ops:[{op:"member-remove",account:f.p.owner.user}]})];
      if(mode==="policy-removal") await expect(probe.query("INSERT INTO next_policy_outbox(collection_id,ops) VALUES($1,$2)",removal)).rejects.toMatchObject({code:"55P03"});
      else await expect(probe.query("UPDATE next_background_grants SET revoked_at=clock_timestamp() WHERE id=$1",[f.grantId])).rejects.toMatchObject({code:"55P03"});
      await probe.query("ROLLBACK");await blocker.query("COMMIT");await draining;
      // A policy FK also waits behind admission: do not manufacture a change
      // inside a lock interval where the actual PostgreSQL engine forbids it.
      if(mode==="policy-removal")await db.query("INSERT INTO next_policy_outbox(collection_id,ops) VALUES($1,$2)",removal);
      else await db.query("UPDATE next_background_grants SET revoked_at=clock_timestamp() WHERE id=$1",[f.grantId]);
      expect((await f.resolver.resolve(db,f.grantId))?.usable).toBe(false);
      expect((await db.query("SELECT 1 FROM next_timer_event_receipts WHERE event_id=$1 AND consumer='notifications'",[event])).rows).toHaveLength(1);
      expect((await db.query("SELECT 1 FROM notification_signals WHERE grant_id=$1",[f.grantId])).rows).toHaveLength(0);
      expect((await db.query("SELECT 1 FROM grants WHERE id=$1",[f.grantId])).rows).toHaveLength(0);
    } finally {try{await probe.query("ROLLBACK");await blocker.query("ROLLBACK");}finally{probe.release();blocker.release();}if(draining)await draining;}
  });
  it("fires one native generation and consumes one receipt into the existing sealed-channel delivery queue",async()=>{
    const f=await currentTimerFixture(); await dueNativeTimer(f);
    const channel=randomUUID(),subscription=randomUUID(),sealer=new PushTargetSealer({keyId:"synthetic",key:Buffer.alloc(32,42),previousKeys:{}});
    const sealed=sealer.seal(f.grantId,f.p.input.installation.installation_id,{endpoint:"https://push.example.test/synthetic",p256dh:"synthetic-p256dh",auth:"synthetic-auth"});
    await db.query("INSERT INTO push_channels(id,grant_id,installation_id,kind,sealed_target,sealed_key_id) VALUES($1,$2,$3,'web_push',$4,'synthetic')",[channel,f.grantId,f.p.input.installation.installation_id,sealed]);
    await db.query("INSERT INTO notification_subscriptions(id,grant_id,channel_id,criterion_id) VALUES($1,$2,$3,'synthetic.reminder')",[subscription,f.grantId,channel]);
    let wakes=0; const consumer=notificationsConsumer(()=>{wakes++;},f.resolver);
    const first=new TimerWorker(db,[consumer],{resolver:f.resolver}),second=new TimerWorker(db,[consumer],{resolver:f.resolver});
    expect((await Promise.all([first.fireDue(),second.fireDue()])).reduce((sum,n)=>sum+n,0)).toBe(1);
    const event=timerEventId(f.grantId,"reminders","due",1);
    expect((await db.query("SELECT event_id,generation,data FROM next_timer_events WHERE grant_id=$1",[f.grantId])).rows).toEqual([{event_id:event,generation:"1",data:null}]);
    expect((await Promise.all([first.drainConsumer(consumer),second.drainConsumer(consumer)])).reduce((sum,n)=>sum+n,0)).toBe(1);
    expect(wakes).toBe(1);
    expect((await db.query("SELECT consumer,event_id FROM next_timer_event_receipts WHERE event_id=$1",[event])).rows).toEqual([{consumer:"notifications",event_id:event}]);
    expect((await db.query("SELECT signal_id,grant_id,criterion_id,cursor FROM notification_signals WHERE grant_id=$1",[f.grantId])).rows).toEqual([{signal_id:event,grant_id:f.grantId,criterion_id:"synthetic.reminder",cursor:event}]);
    expect((await db.query("SELECT nd.status FROM notification_deliveries nd JOIN notification_subscriptions ns ON ns.id=nd.subscription_id WHERE ns.grant_id=$1",[f.grantId])).rows).toEqual([{status:"pending"}]);
    expect((await db.query("SELECT sealed_target FROM push_channels WHERE id=$1",[channel])).rows[0].sealed_target).toBe(sealed);
    expect((await db.query("SELECT 1 FROM grants WHERE id=$1",[f.grantId])).rows).toHaveLength(0);
  });
  it("consumes a fired event without a signal after native consent withdrawal",async()=>{
    const f=await currentTimerFixture(); await dueNativeTimer(f);
    const consumer=notificationsConsumer(()=>undefined,f.resolver),worker=new TimerWorker(db,[consumer],{resolver:f.resolver});
    expect(await worker.fireDue()).toBe(1);
    await db.query("UPDATE next_background_grants SET revoked_at=now() WHERE id=$1",[f.grantId]);
    expect(await worker.drainConsumer(consumer)).toBe(1);
    const event=timerEventId(f.grantId,"reminders","due",1);
    expect((await db.query("SELECT 1 FROM next_timer_event_receipts WHERE event_id=$1",[event])).rows).toHaveLength(1);
    expect((await db.query("SELECT 1 FROM notification_signals WHERE grant_id=$1",[f.grantId])).rows).toHaveLength(0);
  });
  it("denies due firing after pending membership removal and cancels future timers on permanent native withdrawal",async()=>{
    const f=await currentTimerFixture(); await dueNativeTimer(f);
    await db.query("INSERT INTO next_policy_outbox(collection_id,ops) VALUES($1,$2)",[f.collection,JSON.stringify({version:1,ops:[{op:"member-remove",account:f.p.owner.user}]})]);
    const worker=new TimerWorker(db,[],{resolver:f.resolver}); expect(await worker.fireDue()).toBe(0);
    expect((await db.query("SELECT status,fired_at FROM next_timers WHERE grant_id=$1",[f.grantId])).rows).toEqual([{status:"cancelled",fired_at:null}]);
    expect((await db.query("SELECT 1 FROM next_timer_events WHERE grant_id=$1",[f.grantId])).rows).toHaveLength(0);
    const future=await currentTimerFixture(); await dueNativeTimer(future,true);
    await db.query("UPDATE next_background_grants SET revoked_at=now() WHERE id=$1",[future.grantId]);
    await worker.tick();
    expect((await db.query("SELECT status FROM next_timers WHERE grant_id=$1",[future.grantId])).rows).toEqual([{status:"cancelled"}]);
  });
  async function queuedNativeNotification(mode:"web_push"|"fcm"|"webhook"="web_push") {
    const application=await timerApp(mode==="fcm"?{mode:"managed_fcm",firebase_project_id:"synthetic-project"}:mode==="webhook"?{mode:"webhook",url:"https://hooks.example.test/notify"}:undefined);
    const f=await currentTimerFixture(application);
    if(mode!=="webhook") {
      const payload=mode==="web_push"?webChannel(f):{installation_id:f.p.input.installation.installation_id,criteria:["synthetic.reminder"],transport:"fcm",token:"synthetic-native-fcm-token-1234567890"};
      const registered=await app.inject({method:"POST",url:channelPath(f),headers:{authorization:`Bearer ${f.token}`},payload});
      expect(registered.statusCode,registered.body).toBe(201);
    }
    await dueNativeTimer(f);
    const consumer=notificationsConsumer(()=>undefined,f.resolver),worker=new TimerWorker(db,[consumer],{resolver:f.resolver});
    expect(await worker.fireDue()).toBe(1); await worker.drainConsumer(consumer);
    return {...f,event:timerEventId(f.grantId,"reminders","due",1)};
  }
  it.each(["web_push","fcm","webhook"] as const)("dispatches native %s with current permission and frozen content-free presentation",async mode=>{
    const f=await queuedNativeNotification(mode),records:Array<{kind:string;target:unknown;payload:string}>=[];
    const recorded:NotificationTransports={
      webPush:{send:async(target,payload)=>{records.push({kind:"web_push",target,payload});}},
      fcm:{send:async(target,payload)=>{records.push({kind:"fcm",target,payload});}},
      webhook:{send:async(target,payload)=>{records.push({kind:"webhook",target,payload});},publicKeys:()=>[]}
    };
    const service=new NotificationService(db,recorded,1000,()=>undefined,channelSealer,f.resolver);
    await service.drainOnce(); await service.drainOnce();
    const matching=records.filter(record=>record.payload.includes(f.event)); expect(matching).toHaveLength(1);
    const envelope=JSON.parse(matching[0].payload),notification=mode==="webhook"?envelope.notification:envelope;
    expect(notification).toEqual({type:"mdbase.notification",version:1,signal_id:f.event,criterion_id:"synthetic.reminder",cursor:f.event,presentation:{title:"Reminder"}});
    if(mode==="fcm") expect(matching[0].target).toEqual({projectId:"synthetic-project",token:"synthetic-native-fcm-token-1234567890"});
    if(mode==="web_push") expect(matching[0].target).toMatchObject({endpoint:"https://push.example.test/synthetic"});
    if(mode==="webhook") expect(matching[0].target).toMatchObject({url:"https://hooks.example.test/notify"});
    const delivered=mode==="webhook"?await db.query("SELECT status FROM notification_webhook_deliveries WHERE signal_id=(SELECT id FROM notification_signals WHERE signal_id=$1)",[f.event])
      :await db.query("SELECT status FROM notification_deliveries WHERE signal_id=(SELECT id FROM notification_signals WHERE signal_id=$1)",[f.event]);
    expect(delivered.rows).toEqual([{status:"sent"}]);
  });
  it.each(["withdrawal","device","declaration","channel"])("does not dispatch queued native notifications after %s changes",async change=>{
    const f=await queuedNativeNotification(),sent:string[]=[];
    if(change==="withdrawal") await db.query("UPDATE next_background_grants SET revoked_at=now() WHERE id=$1",[f.grantId]);
    if(change==="device") await db.query("INSERT INTO next_policy_outbox(collection_id,ops) VALUES($1,$2)",[f.collection,JSON.stringify({version:1,ops:[{op:"device-revoke",device:f.p.input.installation.device_id}]})]);
    if(change==="declaration") await db.query("UPDATE applications SET notifications=$2::jsonb WHERE id=$1",[f.p.input.installation.app_id,JSON.stringify({criteria:[]})]);
    if(change==="channel") await db.query("UPDATE push_channels SET disabled_at=now() WHERE grant_id=$1",[f.grantId]);
    const service=new NotificationService(db,{webPush:{send:async(_target,payload)=>{sent.push(payload);}}},1000,()=>undefined,channelSealer,f.resolver);
    await service.drainOnce(); expect(sent.filter(payload=>payload.includes(f.event))).toHaveLength(0);
    expect((await db.query("SELECT status FROM notification_deliveries WHERE signal_id=(SELECT id FROM notification_signals WHERE signal_id=$1)",[f.event])).rows[0].status).not.toBe("sent");
  });
  it.each(["target","lease"])("uses the actual current native %s after preliminary delivery selection",async change=>{
    const f=await queuedNativeNotification(),sent:Array<{endpoint:string;payload:string}>=[]; let changed=false;
    const resolver={async resolve(queryable:Parameters<typeof f.resolver.resolve>[0],id:string) {
      if(id===f.grantId && !changed) {
        changed=true;
        if(change==="target") await db.query("UPDATE push_channels SET sealed_target=$2 WHERE grant_id=$1",[f.grantId,channelSealer.seal(f.grantId,f.p.input.installation.installation_id,{endpoint:"https://push.example.test/current",p256dh:"synthetic-p256dh-key",auth:"synthetic-auth"})]);
        else await db.query("UPDATE notification_deliveries SET lease_token=$2 WHERE signal_id=(SELECT id FROM notification_signals WHERE signal_id=$1)",[f.event,randomUUID()]);
      }
      return f.resolver.resolve(queryable,id);
    }};
    const service=new NotificationService(db,{webPush:{send:async(target,payload)=>{sent.push({endpoint:target.endpoint,payload});}}},1000,()=>undefined,channelSealer,resolver);
    await service.drainOnce(); expect(changed).toBe(true);
    const matching=sent.filter(record=>record.payload.includes(f.event));
    expect(matching).toHaveLength(change==="target"?1:0);
    if(change==="target") expect(matching[0].endpoint).toBe("https://push.example.test/current");
    else expect((await db.query("SELECT status FROM notification_deliveries WHERE signal_id=(SELECT id FROM notification_signals WHERE signal_id=$1)",[f.event])).rows[0].status).toBe("sending");
  });
  it("releases native policy after transport admission, waits for the genuine result and prevents later admission after withdrawal",async()=>{
    const f=await queuedNativeNotification(); let admit!:()=>void,release!:()=>void,withdrawn:Promise<unknown>|undefined;
    const entered=new Promise<void>(resolve=>{admit=resolve;}),completion=new Promise<void>(resolve=>{release=resolve;});
    let sent=0,settled=false;
    const service=new NotificationService(db,{webPush:{send:async(_target,payload)=>{
      if(payload.includes(f.event)) { sent++; withdrawn=db.query("UPDATE next_background_grants SET revoked_at=now() WHERE id=$1",[f.grantId]); admit(); await completion; }
    }}},1000,()=>undefined,channelSealer,f.resolver);
    const drain=service.drainOnce().then(result=>{settled=true;return result;});
    try {
      await entered; await withdrawn; expect(settled).toBe(false); expect(sent).toBe(1);
      release(); await drain;
      const row=(await db.query("SELECT status FROM notification_deliveries WHERE signal_id=(SELECT id FROM notification_signals WHERE signal_id=$1)",[f.event])).rows[0];
      expect(row.status).toBe("sent");
      await db.query("UPDATE notification_deliveries SET status='pending',available_at=now() WHERE signal_id=(SELECT id FROM notification_signals WHERE signal_id=$1)",[f.event]);
      await service.drainOnce(); expect(sent).toBe(1);
      expect((await db.query("SELECT status FROM notification_deliveries WHERE signal_id=(SELECT id FROM notification_signals WHERE signal_id=$1)",[f.event])).rows[0].status).toBe("discarded");
    } finally { release(); await drain; }
  });
  it("does not hide admission invariant failures as retryable network errors or treat undefined transport rejection as success",async()=>{
    const failed=await queuedNativeNotification(),sent:string[]=[];
    const resolver={async resolve(queryable:Parameters<typeof failed.resolver.resolve>[0],id:string) {
      if(id===failed.grantId) throw new Error("Synthetic admission invariant failure");
      return failed.resolver.resolve(queryable,id);
    }};
    const service=new NotificationService(db,{webPush:{send:async(_target,payload)=>{sent.push(payload);}}},1000,()=>undefined,channelSealer,resolver);
    await expect(service.drainOnce()).rejects.toThrow("Notification delivery admission failed.");
    expect(sent.filter(payload=>payload.includes(failed.event))).toHaveLength(0);
    expect((await db.query("SELECT status FROM notification_deliveries WHERE signal_id=(SELECT id FROM notification_signals WHERE signal_id=$1)",[failed.event])).rows[0].status).toBe("sending");
    const rejected=await queuedNativeNotification();
    const rejecting=new NotificationService(db,{webPush:{send:async(_target,payload)=>{
      if(payload.includes(rejected.event)) return Promise.reject(undefined);
    }}},1000,()=>undefined,channelSealer,rejected.resolver);
    await rejecting.drainOnce();
    expect((await db.query("SELECT status,last_error FROM notification_deliveries WHERE signal_id=(SELECT id FROM notification_signals WHERE signal_id=$1)",[rejected.event])).rows).toEqual([{status:"retry",last_error:"Push delivery failed."}]);
  });
  it("resolves actual native timer consent as opaque, exact collection authority, independent of transient pairing-window custody",async()=>{
    const f=await currentTimerFixture(),grant=(await f.resolver.resolve(db,f.grantId))!;
    expect(grant).toMatchObject({grantId:f.grantId,userId:f.p.owner.user,applicationId:f.p.input.installation.app_id,
      connectorId:f.p.selected.connector_id,collectionIds:[f.collection],state:"e2e",usable:true});
    expect(dataPermitted(grant)).toBe(false); expect(grant.operations.has("put_timer")).toBe(true);
    expect(grant.criteria.map(criterion=>criterion.id)).toEqual(["synthetic.reminder"]);
    await db.query("DELETE FROM pairing_requests WHERE id=$1",[f.p.input.installation.request_id]);
    expect((await f.resolver.resolve(db,f.grantId))?.usable).toBe(true);
    await db.query("UPDATE applications SET name='New display name' WHERE id=$1",[f.p.input.installation.app_id]);
    expect((await f.resolver.resolve(db,f.grantId))?.usable).toBe(true);
    expect((await backgroundTimerGrantResolver(db,"production").resolve(db,f.grantId))?.usable).toBe(false);
    await db.query("UPDATE applications SET notifications=$2::jsonb WHERE id=$1",[f.p.input.installation.app_id,JSON.stringify({criteria:[{id:"synthetic.reminder",event:MDBASE_TIMER_FIRED_CONTRACT,presentation:{title:"Changed terms"}}]})]);
    expect((await f.resolver.resolve(db,f.grantId))?.usable).toBe(false);
  });
  it.each(["sign_pk","kem_pk","noise_pk"])("refuses a changed current native %s without adopting the new key",async key=>{
    const f=await currentTimerFixture(),original=(await db.query(`SELECT ${key} AS key FROM next_devices WHERE id=$1`,[f.p.input.installation.device_id])).rows[0].key;
    await db.query(`UPDATE next_devices SET ${key}=$2 WHERE id=$1`,[f.p.input.installation.device_id,Buffer.alloc(32,17)]);
    expect((await f.resolver.resolve(db,f.grantId))?.usable).toBe(false);
    await db.query(`UPDATE next_devices SET ${key}=$2 WHERE id=$1`,[f.p.input.installation.device_id,original]);
    expect((await f.resolver.resolve(db,f.grantId))?.usable).toBe(true);
  });
  it.each(["sending","lost"])("requires exact acknowledged enrollment, not a %s batch",async state=>{
    const f=await currentTimerFixture();
    await db.query("UPDATE next_policy_batches SET state=$2 WHERE id=$1",[f.batch,state==="lost"?"appended":"sending"]);
    if(state==="lost") await db.query("UPDATE next_policy_batches SET lost_at=now() WHERE id=$1",[f.batch]);
    expect((await f.resolver.resolve(db,f.grantId))?.usable).toBe(false);
  });
  it.each(["device-revoke","member-remove"])("refuses historical enrollment after even a pending %s",async op=>{
    const f=await currentTimerFixture();
    const removal=op==="device-revoke"?{op,device:f.p.input.installation.device_id}:{op,account:f.p.owner.user};
    await db.query("INSERT INTO next_policy_outbox(collection_id,ops) VALUES($1,$2)",[f.collection,JSON.stringify({version:1,ops:[removal]})]);
    expect((await f.resolver.resolve(db,f.grantId))?.usable).toBe(false);
  });
  it("permanently denies removed exact collection scope and holds live consent until its engine transaction commits",async()=>{
    const f=await currentTimerFixture(),client=await db.connect();
    try {
      await client.query("BEGIN"); expect((await f.resolver.resolve(client,f.grantId))?.usable).toBe(true);
      let settled=false;
      const withdrawn=db.query("UPDATE next_background_grants SET revoked_at=now() WHERE id=$1",[f.grantId]).then(()=>{settled=true;});
      await new Promise(resolve=>setTimeout(resolve,30)); expect(settled).toBe(false);
      await client.query("COMMIT"); await withdrawn;
      expect((await f.resolver.resolve(db,f.grantId))?.usable).toBe(false);
    } finally { await client.query("ROLLBACK"); client.release(); }
    const scoped=await currentTimerFixture();
    await db.query("DELETE FROM installation_collection_scopes WHERE connector_id=$1 AND collection_id=$2",[scoped.p.selected.connector_id,scoped.collection]);
    await db.query("INSERT INTO installation_collection_scopes(connector_id,collection_id) VALUES($1,$2)",[scoped.p.selected.connector_id,scoped.collection]);
    expect((await scoped.resolver.resolve(db,scoped.grantId))?.usable).toBe(false);
    expect(await scoped.resolver.resolve(db,randomUUID())).toBeNull();
  });
  it.each([false,undefined])("finishes setup with timer choice %s without granting reminders",async timers=>{
    const p=await prepared("app-runtime",false,undefined,undefined,await timerApp()),collection=await scopeCollection(p.owner.user);
    expect((await approvePicked(p,p.flow,[collection],collection,timers)).statusCode).toBe(200);
    const receipt=(await p.flow.exchange()).json();
    expect(receipt.status).toBe("paired"); expect(receipt.timer_consent).toBe(timers??null); expect(receipt.timer_grants).toEqual([]);
    expect((await db.query("SELECT 1 FROM installation_collection_scopes WHERE connector_id=$1 AND collection_id=$2",[p.selected.connector_id,collection])).rowCount).toBe(1);
    expect((await db.query("SELECT 1 FROM next_background_grants WHERE approval_request_id=$1",[p.input.installation.request_id])).rowCount).toBe(0);
  });
  it("refuses timer declaration drift and missing original confirmation/selection, while explicit decline still finishes setup",async()=>{
    const id=await timerApp(),p=await prepared("app-runtime",false,undefined,undefined,id),collection=await scopeCollection(p.owner.user);
    const withoutSelection=await app.inject({method:"POST",url:`${p.flow.base}/approve`,headers:p.owner.headers,payload:{fingerprint:clientFingerprint(Buffer.from(p.proof.payload.sign_pk,"hex")),collection_ids:[collection],timer_consent:true}});
    expect(withoutSelection.statusCode).toBe(403);
    await db.query("UPDATE applications SET notifications=$2::jsonb WHERE id=$1",[id,JSON.stringify({criteria:[{id:"synthetic.reminder",event:MDBASE_TIMER_FIRED_CONTRACT,presentation:{title:"Changed"}}]})]);
    const drift=await approvePicked(p,p.flow,[collection],collection,true);
    expect(drift.statusCode).toBe(409); expect(drift.json().error.code).toBe("installation_timer_declaration_changed");
    expect((await db.query("SELECT approved_at FROM pairing_requests WHERE id=$1",[p.input.installation.request_id])).rows[0].approved_at).toBeNull();
    expect((await approvePicked(p,p.flow,[collection],collection,false)).statusCode).toBe(200);
    expect((await p.flow.exchange()).json()).toMatchObject({status:"paired",timer_consent:false,timer_grants:[]});
    const noDeclaration=await prepared(),other=await scopeCollection(noDeclaration.owner.user);
    const refused=await approvePicked(noDeclaration,noDeclaration.flow,[other],other,true);
    expect(refused.statusCode).toBe(403); expect(refused.json().error.code).toBe("installation_timers_not_declared");
    expect((await approvePicked(noDeclaration,noDeclaration.flow,[other],other,false)).statusCode).toBe(200);
    expect((await noDeclaration.flow.exchange()).json()).toMatchObject({status:"paired",timer_consent:false,timer_grants:[]});
  });
  it("withdraws immediately on reconsent approval; later older exchange cannot revive a grant or replace custody",async()=>{
    const p=await prepared("app-runtime",false,undefined,undefined,await timerApp()),collection=await scopeCollection(p.owner.user);
    expect((await approvePicked(p,p.flow,[collection],collection,true)).statusCode).toBe(200);
    const initial=(await p.flow.exchange()).json(),firstId=initial.timer_grants[0].grant_id;
    const older=await rescope(p,initial.token),withdraw=await rescope(p,initial.token);
    for(const next of [older,withdraw]) expect((await app.inject({method:"POST",url:`${next.flow.base}/select-account`,headers:p.owner.headers})).statusCode).toBe(200);
    expect((await approvePicked(p,older.flow,[],collection,true)).statusCode).toBe(200);
    const second=(await db.query("SELECT id,revoked_at FROM next_background_grants WHERE approval_request_id=$1",[older.input.installation.request_id])).rows[0];
    expect(second.revoked_at).toBeNull(); expect(second.id).not.toBe(firstId);
    expect((await approvePicked(p,withdraw.flow,[],collection,false)).statusCode).toBe(200);
    expect((await db.query("SELECT revoked_at FROM next_background_grants WHERE id=$1",[second.id])).rows[0].revoked_at).toBeInstanceOf(Date);
    const late=(await older.flow.exchange()).json(); expect(late.timer_grants[0].grant_id).toBe(second.id);
    const off=(await withdraw.flow.exchange()).json(); expect(off).toMatchObject({status:"scope_updated",timer_consent:false,timer_grants:[]});
    expect((await db.query("SELECT 1 FROM next_background_grants WHERE native_connector_id=$1 AND revoked_at IS NULL",[p.selected.connector_id])).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM installation_collection_scopes WHERE connector_id=$1 AND collection_id=$2",[p.selected.connector_id,collection])).rowCount).toBe(1);
    expect((await db.query("SELECT token_hash FROM installation_device_credentials WHERE connector_id=$1",[p.selected.connector_id])).rows[0].token_hash).toBe(tokenHash(initial.token));
    const fresh=await rescope(p,initial.token);
    expect((await app.inject({method:"POST",url:`${fresh.flow.base}/select-account`,headers:p.owner.headers})).statusCode).toBe(200);
    expect((await approvePicked(p,fresh.flow,[],collection,true)).statusCode).toBe(200);
    const third=(await db.query("SELECT id FROM next_background_grants WHERE approval_request_id=$1",[fresh.input.installation.request_id])).rows[0].id;
    expect([firstId,second.id]).not.toContain(third);
    expect((await app.inject({method:"POST",url:`${fresh.flow.base}/deny`,headers:p.owner.headers})).statusCode).toBe(200);
    expect((await db.query("SELECT revoked_at FROM next_background_grants WHERE id=$1",[third])).rows[0].revoked_at).toBeInstanceOf(Date);
    await expect(db.query("UPDATE next_background_grants SET revoked_at=NULL WHERE id=$1",[second.id])).rejects.toThrow(/permanent/);
  });
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
  it("account management removes installed scope after pairing expiry without touching another account or collection",async()=>{
    const appId=await registeredApp("bundle:managed.installation"), p=await prepared("app-runtime",false,undefined,undefined,appId);
    const collection=await scopeCollection(p.owner.user), keep=await scopeCollection(p.owner.user), stranger=await account();
    expect((await approveDevice(p.flow,p.owner,undefined,{collection_ids:[collection,keep],create_collections:false})).statusCode).toBe(200);
    expect((await p.flow.exchange()).statusCode).toBe(200);
    const keys=p.proof.payload;
    await db.query("INSERT INTO next_policy_outbox(collection_id,ops) VALUES($1,$2)",[collection,JSON.stringify({version:1,ops:[{op:"device-enrol",device:p.input.installation.device_id,account:p.owner.user,kind:"app-runtime",signPublicKey:{$hex:keys.sign_pk},kemPublicKey:{$hex:keys.kem_pk},noisePublicKey:{$hex:keys.noise_pk}}]})]);
    await db.query("UPDATE pairing_requests SET expires_at=now()-interval '1 hour' WHERE id=$1",[p.input.installation.request_id]);
    const remove=(headers=p.owner.headers,confirm=true)=>app.inject({method:"POST",url:`/v1/account/applications/${appId}/remove-installation-access`,headers,payload:{collection_id:collection,confirm}});
    expect((await remove({},true)).statusCode).toBe(401);
    expect((await remove(p.owner.headers,false)).statusCode).toBe(400);
    expect((await remove(stranger.headers)).statusCode).toBe(200); // opaque no-op, no foreign registry lookup
    expect((await db.query("SELECT collection_id FROM installation_collection_scopes WHERE connector_id=$1",[p.selected.connector_id])).rows).toHaveLength(2);
    const woken=policyWakes.length, result=await remove(); expect(result.statusCode,result.body).toBe(200);
    expect(result.json()).toEqual({ok:true,state:"revoking",collection_id:collection});
    // The committed device-revoke is delivered now, not left for the global outbox poll.
    expect(policyWakes.slice(woken)).toEqual([collection]);
    expect((await db.query("SELECT collection_id FROM installation_collection_scopes WHERE connector_id=$1",[p.selected.connector_id])).rows).toEqual([{collection_id:keep}]);
    expect((await remove()).statusCode).toBe(200);
    const revoked=(await db.query("SELECT ops FROM next_policy_outbox WHERE collection_id=$1",[collection])).rows.flatMap(row=>row.ops.ops).filter((op:{op:string})=>op.op==="device-revoke");
    expect(revoked).toEqual([{op:"device-revoke",device:p.input.installation.device_id}]);
    expect((await db.query("SELECT id FROM grants WHERE user_id=$1",[p.owner.user])).rows).toEqual([]);
  });

  it("account management withdraws creation-only authority without deleting collections or creating grants", async () => {
    const p=await prepared("app-runtime",true), collection=await scopeCollection(p.owner.user);
    expect((await approveDevice(p.flow,p.owner,undefined,{collection_ids:[],create_collections:true})).statusCode).toBe(200);
    expect((await p.flow.exchange()).statusCode).toBe(200);
    const path=`/v1/account/installations/${p.selected.connector_id}`;
    expect((await app.inject({method:"DELETE",url:path})).statusCode).toBe(401);
    const removed=await app.inject({method:"DELETE",url:path,headers:p.owner.headers});
    expect(removed.statusCode,removed.body).toBe(200);
    expect(removed.json()).toEqual({ok:true,revoked:true,collections:0,fence:"closed"});
    expect((await db.query("SELECT revoked_at FROM connectors WHERE id=$1",[p.selected.connector_id])).rows[0].revoked_at).not.toBeNull();
    expect((await db.query("SELECT collection_id FROM next_collections WHERE collection_id=$1",[collection])).rows).toHaveLength(1);
    expect((await db.query("SELECT id FROM grants WHERE user_id=$1",[p.owner.user])).rows).toEqual([]);
    expect((await db.query("SELECT id FROM next_policy_outbox WHERE collection_id=$1",[collection])).rows).toHaveLength(1);
    expect((await p.flow.exchange()).statusCode).toBe(403);
  });

  it.each(["self", "account"] as const)("%s signs an installation out: device revoked, scopes gone, bearer dead; ordinary connectors refused",async(mode)=>{
    const p=await prepared(),collection=await scopeCollection(p.owner.user),device=p.input.installation.device_id,keys=p.proof.payload;
    expect((await approveDevice(p.flow,p.owner,undefined,{collection_ids:[collection],create_collections:false})).statusCode).toBe(200);
    const token=(await p.flow.exchange()).json().token as string, bearer={authorization:`Bearer ${token}`};
    await db.query("INSERT INTO next_policy_outbox(collection_id,ops) VALUES($1,$2)",[collection,JSON.stringify({version:1,ops:[{op:"device-enrol",device,account:p.owner.user,kind:p.input.installation.kind,signPublicKey:{$hex:keys.sign_pk},kemPublicKey:{$hex:keys.kem_pk},noisePublicKey:{$hex:keys.noise_pk}}]})]);
    const ordinary=randomToken("con");
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Desktop',$3)",[randomUUID(),p.owner.user,tokenHash(ordinary)]);
    const refused=await app.inject({method:"DELETE",url:"/v1/next/installation",headers:{authorization:`Bearer ${ordinary}`}});
    expect(refused.statusCode).toBe(403); expect(refused.json().error.code).toBe("installation_required");
    const signOut=()=>app.inject({method:"DELETE",url:mode==="self"?"/v1/next/installation":`/v1/account/installations/${p.selected.connector_id}`,headers:mode==="self"?bearer:p.owner.headers});
    if(mode==="account") {
      const stranger=await account();
      expect((await app.inject({method:"DELETE",url:`/v1/account/installations/${p.selected.connector_id}`,headers:stranger.headers})).statusCode).toBe(404);
    }
    const woken=policyWakes.length, out=await signOut();
    expect(out.statusCode,out.body).toBe(200); expect(out.json()).toEqual({ok:true,revoked:true,collections:1,fence:"closed"});
    expect(policyWakes.slice(woken)).toEqual([collection]);
    expect(fenced.map(([id])=>id)).toContain(p.selected.connector_id);
    expect((await db.query("SELECT collection_id FROM installation_collection_scopes WHERE connector_id=$1",[p.selected.connector_id])).rows).toEqual([]);
    const revokes=(await db.query("SELECT ops FROM next_policy_outbox WHERE collection_id=$1",[collection])).rows.flatMap(row=>row.ops.ops).filter((op:{op:string})=>op.op==="device-revoke");
    expect(revokes).toEqual([{op:"device-revoke",device}]);
    const dead=await app.inject({method:"POST",url:"/v1/next/devices/challenge",headers:bearer});
    expect(dead.statusCode).toBe(401); expect(dead.json().error.code).toBe("invalid_connector");
    const again=await signOut();
    expect(again.statusCode).toBe(mode==="self"?401:404); expect(again.json().error.code).toBe(mode==="self"?"invalid_connector":"installation_not_found");
  });
  it("keeps original daemon pairing response and one-shot exchange semantics", async () => {
    const owner = await account();
    const first = await app.inject({method:"POST",url:"/v1/pairing-requests",payload:{connector_name:"Desktop"}}); expect(first.statusCode).toBe(201);
    const body = first.json(), base=`/v1/pairing-requests/${body.pairing_id}`, headers={authorization:`Bearer ${body.pairing_secret}`};
    expect((await app.inject({method:"POST",url:`${base}/approve`,headers:owner.headers})).json().deep_link).toMatch(/^mdbase-connect:\/\/paired/);
    const exchange = await app.inject({method:"POST",url:`${base}/exchange`,headers}); expect(exchange.statusCode).toBe(200); expect(typeof exchange.json().token).toBe("string");
    expect((await app.inject({method:"POST",url:`${base}/exchange`,headers})).statusCode).toBe(409);
  });
  it("asks for a declared optional file action on one scoped collection, records the decision, and reports a decline",async()=>{
    const family=randomUUID(),appId=await registeredApp(family);
    await db.query("UPDATE applications SET requirements=$2::jsonb WHERE id=$1",[appId,JSON.stringify({access:"full_collection",contracts:[],files:{required:["list","read"],optional:["add"],scope:{kind:"collection"}}})]);
    const p=await prepared("app-runtime",false,undefined,undefined,appId),collection=await scopeCollection(p.owner.user);
    expect((await approvePicked(p,p.flow,[collection],collection)).statusCode).toBe(200);
    const token=(await p.flow.exchange()).json().token,origin=originHeaders(p.input).origin;
    const ask=(actions:string[],reason="Add the image you just chose")=>{
      const input={...p.input,installation:{...p.input.installation,request_id:randomUUID(),pairing_secret:randomToken("pair"),reconsent:true,file_access:{collection_id:collection,actions,reason}}};
      return {input,flow:channel(input),sent:app.inject({method:"POST",url:"/v1/pairing-requests",headers:{origin,authorization:`Bearer ${token}`},payload:input})};
    };
    // Undeclared actions and multi-line reasons are refused before any request exists.
    expect((await ask(["delete"]).sent).json()).toMatchObject({error:{code:"installation_file_access_undeclared"}});
    expect((await ask(["add"],"line one\nline two").sent).statusCode).toBe(400);
    const granted=ask(["add"]);
    expect((await granted.sent).statusCode).toBe(201);
    const shown=(await app.inject({method:"GET",url:granted.flow.base,headers:p.owner.headers})).json().pairing;
    expect(shown.file_access).toEqual({collection_id:collection,collection_name:"New collection",actions:["add"],reason:"Add the image you just chose",approved_actions:null});
    expect((await granted.flow.exchange()).json().status).toBe("awaiting_approval");
    const fingerprint=clientFingerprint(Buffer.from(p.proof.payload.sign_pk,"hex"));
    expect((await app.inject({method:"POST",url:`${granted.flow.base}/approve`,headers:p.owner.headers,payload:{fingerprint,collection_ids:[collection],file_actions:["add"]}})).statusCode).toBe(400);
    expect((await app.inject({method:"POST",url:`${granted.flow.base}/approve`,headers:p.owner.headers,payload:{fingerprint,file_actions:["add"]}})).statusCode).toBe(200);
    expect((await app.inject({method:"POST",url:`${granted.flow.base}/deny`,headers:p.owner.headers})).statusCode).toBe(409);
    const receipt=await granted.flow.exchange();
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json()).toEqual({status:"file_access_updated",request_id:granted.input.installation.request_id,collection_id:collection,file_actions:["add"]});
    expect((await db.query("SELECT file_actions FROM installation_collection_scopes WHERE connector_id=$1 AND collection_id=$2",[p.selected.connector_id,collection])).rows).toEqual([{file_actions:["add"]}]);
    const declined=ask(["add"]);
    expect((await declined.sent).statusCode).toBe(201);
    expect((await app.inject({method:"POST",url:`${declined.flow.base}/deny`,headers:p.owner.headers})).statusCode).toBe(200);
    const answer=await declined.flow.exchange();
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({status:"declined",request_id:declined.input.installation.request_id});
    // The earlier decision stays recorded.
    expect((await db.query("SELECT file_actions FROM installation_collection_scopes WHERE connector_id=$1 AND collection_id=$2",[p.selected.connector_id,collection])).rows).toEqual([{file_actions:["add"]}]);
  });
});
