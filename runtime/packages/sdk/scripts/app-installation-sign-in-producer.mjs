/** Owned LOCAL TEST producer. Real Connect pairing/auth/device routes and PG;
 * seeded disposable account/session + portal actions are explicit test fixtures.
 * No deployed login, CORS, production/LAB or mobile qualification. */
import { randomUUID } from "node:crypto";
import { mkdir, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
export async function openInstallationTestProducer({checkout, output, publicUrl}) {
  const databaseUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
  if (!databaseUrl || process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL !== "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS") throw Error("explicit owned TEST database approval required");
  const url = new URL(databaseUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) throw Error("loopback TEST database only");
  const cp = resolve(checkout), out = resolve(output, `producer-${process.pid}`), mod = v => JSON.stringify(resolve(cp, `services/server/src/${v}.ts`));
  await mkdir(out, {recursive: true}); await symlink(resolve(cp, "services/server/node_modules"), resolve(out, "node_modules"), "dir");
  await build({stdin: {contents: `export {openDatabase} from ${mod("db")};export {runControlPlaneMigrations} from ${mod("migrations")};export {randomToken,tokenHash} from ${mod("security")};export {registerConnectorPairingRoutes} from ${mod("features/connectors/pairing-routes")};export {registerNextDeviceRoutes} from ${mod("features/next/device-routes")};export {requireInstallationDeviceConnector,connectorFromRequest} from ${mod("platform/request-authentication")};export {default as Fastify} from 'fastify';export {default as cookie} from '@fastify/cookie';`, resolveDir: resolve(cp, "services/server")}, bundle: true, packages: "external", platform: "node", format: "esm", outfile: resolve(out, "producer.mjs")});
  const c = await import(pathToFileURL(resolve(out, "producer.mjs")).href), admin = await c.openDatabase(databaseUrl), schema = `clients_installation_test_${randomUUID().replaceAll("-", "")}`;
  let db, app, created = false;
  const close = async () => {await app?.close(); await db?.end(); if (created) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end();};
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
    url.searchParams.set("options", `-csearch_path=${schema}`); db = await c.openDatabase(url.toString());
    await c.runControlPlaneMigrations(db, {lock: true, directory: resolve(cp, "services/server/migrations")});
    app = c.Fastify({logger: false}); await app.register(c.cookie);
    c.registerConnectorPairingRoutes(app, {db, publicUrl, installationDevices: true, installationEnvironment: "lab"});
    c.registerNextDeviceRoutes(app, {db, log: {controlItemAt: async () => null}});
    app.get("/test/installation", async (request, reply) => await c.requireInstallationDeviceConnector(request, reply, db) ?? reply);
    app.get("/test/controller", async (request, reply) => await c.connectorFromRequest(request, db) ?? reply.code(401).send({error: "invalid_controller"}));
    const accountId = randomUUID(), sessionId = randomUUID(), cookie = `mdbase_session=${c.randomToken("session")}`, secret = cookie.slice("mdbase_session=".length);
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Disposable test owner')", [accountId, `${accountId}@example.test`]);
    await db.query("INSERT INTO sessions(id,user_id,token_hash,provider,account_session_epoch,expires_at) VALUES($1,$2,$3,'password',(SELECT session_epoch FROM users WHERE id=$2),now()+interval '1 hour')", [sessionId, accountId, c.tokenHash(secret)]);
    const portal = async (base, action, payload) => {
      const r = await app.inject({method: "POST", url: `${base}/${action}`, headers: {cookie}, ...(payload === undefined ? {} : {payload})}); if (r.statusCode !== 200) throw Error(`owned portal ${action} refused`);
    };
    return {accountId, close, request: async ({method, path, headers, body}) => {
      // Fixed TEST reverse proxy; first-party browser Origin is retained. Not a
      // deployed CORS substitute or authentication shortcut in shipped code.
      const cleanHeaders = Object.fromEntries(Object.entries(headers).filter(([, value]) => typeof value === "string"));
      const r = await app.inject({method, url: path, headers: {...cleanHeaders, origin: publicUrl}, ...(body ? {payload: body} : {})});
      if (path === "/v1/pairing-requests" && r.statusCode === 201) await portal(`/v1/pairing-requests/${r.json().pairing_id}`, "select-account");
      if (path.endsWith("/attest") && r.statusCode === 200) {
        const base = path.slice(0, -7), inspected = await app.inject({method: "GET", url: base, headers: {cookie}}), fingerprint = inspected.json().pairing?.fingerprint;
        if (typeof fingerprint !== "string") throw Error("owned displayed fingerprint unavailable"); await portal(base, "approve", {fingerprint});
      }
      return {status: r.statusCode, headers: r.headers, body: r.body};
    }};
  } catch (e) {await close(); throw e;}
}
