import { once } from "node:events";
import { generateKeyPairSync as keyPair, randomBytes, randomUUID, sign } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { CONNECT_CONTRACT_SUPPORT } from "@mdbase-dev/connect-protocol";
import { buildApp } from "../../app.js";
import { createDatabase, type DatabasePool } from "../../db.js";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { LocalRelayBroker, pipeSubject } from "../../relay-broker.js";
import { DEFAULT_NOISE_PIPE_LIMITS, registerNoisePipeClientRoute } from "./noise-pipes.js";
import { localGrantFixture } from "./next-fixtures.test-helper.js";
import { tokenHash } from "../../security.js";
import { deviceBindDigest, deviceRegistrationDigest } from "./devices.js";
import { registerNextRouteRoutes } from "./route-routes.js";
import { certToJson, ed25519RawPublicKey } from "./policy-keys.js";
import { certDigest, keyId } from "./policy-wire.js";


const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePostgres = testUrl && approved ? describe : describe.skip;

function nextConfig() {
  const pem = (key: ReturnType<typeof keyPair>["privateKey"]) => key.export({ format: "pem", type: "pkcs8" }).toString();
  const root = keyPair("ed25519");
  const policy = keyPair("ed25519");
  const rootPublicKey = ed25519RawPublicKey(root.privateKey);
  const now = Date.now();
  const unsigned = { policyPublicKey: ed25519RawPublicKey(policy.privateKey), notBefore: now - 60_000, notAfter: now + 90 * 86_400_000, root: keyId(rootPublicKey) };
  return {
    rootPublicKey,
    policyPrivateKeyPem: pem(policy.privateKey),
    policyCert: certToJson({ ...unsigned, signature: sign(null, certDigest(unsigned), root.privateKey) }),
    logService: { url: "http://127.0.0.1:9", tokenIssuerKeyPem: pem(keyPair("ed25519").privateKey), transportKeyPem: pem(keyPair("ed25519").privateKey) }
  };
}

/** Wait for the next message on a socket that satisfies `match`. */
function next<T>(socket: WebSocket, match: (data: Buffer, binary: boolean) => T | undefined, timeoutMs = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", listener);
      reject(new Error("timed out waiting for a message"));
    }, timeoutMs);
    const listener = (data: Buffer, binary: boolean) => {
      const value = match(data, binary);
      if (value === undefined) return;
      clearTimeout(timer);
      socket.off("message", listener);
      resolve(value);
    };
    socket.on("message", listener);
  });
}
const json = (type: string) => (data: Buffer, binary: boolean) => {
  if (binary) return undefined;
  const message = JSON.parse(data.toString()) as Record<string, unknown>;
  return message.type === type ? message : undefined;
};

describePostgres("mdbase-next Noise pipes through the relay", () => {
  let admin: pg.Pool;
  let db: DatabasePool;
  let schema: string;
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let base: string;
  const broker = new LocalRelayBroker();
  const ids = { user: randomUUID(), connector: randomUUID(), collection: randomUUID(), localId: randomUUID(), application: randomUUID(), grant: randomUUID(), device: randomUUID() };
  const connectorToken = `con_${randomUUID()}`;
  const accessToken = `at_${randomUUID()}`;
  const deviceKey = keyPair("ed25519").privateKey;
  const deviceNoisePk = randomBytes(32);

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Pipe tests require a dedicated local test database.");
    schema = `mdbase_next_pipes_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Pipe owner')", [ids.user, `${ids.user}@example.test`]);
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash,relay_generation) VALUES($1,$2,'Daemon',$3,0)", [ids.connector, ids.user, tokenHash(connectorToken)]);
    await db.query(`INSERT INTO collections(id,user_id,connector_id,local_id,display_name,spec_version,enabled,present,authority_state)
      VALUES($1,$2,$3,$4,'Notes','0.3.0',true,true,'active')`, [ids.collection, ids.user, ids.connector, ids.localId]);
    ({ app } = await buildApp({ db, publicUrl: "http://connect.test", relayBroker: broker, nextControlPlane: nextConfig() }));
    base = (await app.listen({ host: "127.0.0.1", port: 0 })).replace(/^http/, "ws");
    // Application reconciliation seeds its jobs at startup and then every 6 hours.
    // Settle it before creating the hand-made grant, which has no manifest to satisfy.
    await (app as unknown as { drainApplicationReconciliation(): Promise<void> }).drainApplicationReconciliation();
    await db.query("INSERT INTO applications(id,canonical_identity,name,homepage,redirect_uris) VALUES($1,$2,'Pipe app','https://example.test','[]')", [ids.application, ids.application]);
    await db.query(`INSERT INTO grants(id,user_id,application_id,collection_id,operations,scope,application_installation_id,application_authorization,activated_at)
      VALUES($1,$2,$3,$4,'["read"]','{"access":"full_collection","contracts":[]}','pipe-installation',
      '{"binding":{"protocol_version":4,"contracts":{"semantic_capabilities":1}}}',now())`, [ids.grant, ids.user, ids.application, ids.collection]);
    await db.query("INSERT INTO access_tokens(id,token_hash,grant_id,expires_at) VALUES($1,$2,$3,now() + interval '1 hour')", [randomUUID(), tokenHash(accessToken), ids.grant]);
    await db.query("INSERT INTO next_grant_client_keys(grant_id, client_pk) VALUES($1,$2)", [ids.grant, randomBytes(32)]);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  }, 60_000);

  async function registerDevice() {
    const headers = { authorization: `Bearer ${connectorToken}` };
    const { challenge } = (await app.inject({ method: "POST", url: "/v1/next/devices/challenge", headers })).json() as { challenge: string };
    const keys = { signPk: Buffer.from(ed25519RawPublicKey(deviceKey)), kemPk: randomBytes(32), noisePk: deviceNoisePk };
    const digest = deviceRegistrationDigest({ challenge: Buffer.from(challenge, "hex"), connectorId: ids.connector, deviceId: ids.device, ...keys });
    const response = await app.inject({
      method: "POST", url: "/v1/next/devices", headers,
      payload: { device_id: ids.device, kind: "desktop", challenge, sign_pk: keys.signPk.toString("hex"), kem_pk: keys.kemPk.toString("hex"), noise_pk: keys.noisePk.toString("hex"), sig: Buffer.from(sign(null, digest, deviceKey)).toString("hex") }
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  let lastGeneration = "";
  async function daemon(bind = true, noisePipes = true): Promise<WebSocket> {
    const socket = new WebSocket(`${base}/v1/relay`, { headers: { authorization: `Bearer ${connectorToken}` } });
    socket.on("message", (data: Buffer, binary: boolean) => {
      if (binary) return;
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === "policy_snapshot") {
        socket.send(JSON.stringify({ type: "policy_applied", protocol_version: 1, request_id: message.request_id, revision: message.revision, ok: true }));
      }
    });
    await once(socket, "open");
    const welcome = next(socket, json("relay_welcome"));
    socket.send(JSON.stringify({
      type: "relay_hello", protocol_version: 1, connector_version: "0.1.0-test",
      capabilities: ["application-authorization-v4", "authorization-activation", "encrypted-relay", "policy-ack", "policy-freshness-lease-v1", "next_device_v1", ...(noisePipes ? ["noise_pipe_v1"] : [])],
      contract_support: CONNECT_CONTRACT_SUPPORT
    }));
    const { session_id: sessionId, device_nonce: nonce } = await welcome as { session_id: string; device_nonce: string };
    lastGeneration = sessionId;
    if (!bind) return socket;
    const bound = next(socket, json("device_bound"));
    socket.send(JSON.stringify({ type: "device_bind", device_id: ids.device, sig: Buffer.from(sign(null, deviceBindDigest(ids.connector, sessionId, Buffer.from(nonce, "hex")), deviceKey)).toString("hex") }));
    expect(await bound).toMatchObject({ device_id: ids.device, noise_pipes: noisePipes });
    return socket;
  }

  async function client(grant = ids.grant, target: { device?: string; noisePk?: string } = {}): Promise<WebSocket> {
    const socket = new WebSocket(`${base}/v1/next/relay/client`);
    await once(socket, "open");
    socket.send(JSON.stringify({
      type: "pipe_auth", access_token: accessToken, collection: ids.localId, grant,
      device: target.device ?? ids.device, device_noise_pk: target.noisePk ?? deviceNoisePk.toString("hex")
    }));
    return socket;
  }

  it("carries opaque bytes both ways and closes on the daemon's request", async () => {
    await registerDevice();
    const device = await daemon();
    const app1 = await client();
    const opened = await Promise.all([next(device, json("pipe_open")), next(app1, json("pipe_opened"))]);
    const pipeId = opened[0].pipe_id as string;
    expect(opened[0]).toMatchObject({ collection_id: ids.localId, grant_id: ids.grant });
    expect(opened[1].pipe_id).toBe(pipeId);
    const pipeBytes = Buffer.from(pipeId.replaceAll("-", ""), "hex");

    const toDevice = next(device, (data, binary) => (binary ? data : undefined));
    app1.send(Buffer.from("noise message 1"));
    const framed = await toDevice;
    expect(framed.subarray(0, 4).toString()).toBe("MDBN");
    expect(framed.subarray(4, 20).equals(pipeBytes)).toBe(true);
    expect(framed.subarray(20).toString()).toBe("noise message 1");

    const toClient = next(app1, (data, binary) => (binary ? data.toString() : undefined));
    device.send(Buffer.concat([Buffer.from("MDBN"), pipeBytes, Buffer.from("noise reply")]));
    expect(await toClient).toBe("noise reply");

    const closed = once(app1, "close");
    device.send(JSON.stringify({ type: "pipe_close", pipe_id: pipeId, reason: "unknown_grant" }));
    const [code, reason] = await closed;
    expect([code, reason.toString()]).toEqual([4000, "unknown_grant"]);
    device.close();
  });

  it("refuses a client without a matching active grant, and when no daemon is bound", async () => {
    const wrong = await client(randomUUID());
    const [code] = await once(wrong, "close");
    expect(code).toBe(4403);
    const offline = await client();

    const [offlineCode, offlineReason] = await once(offline, "close");
    expect([offlineCode, offlineReason.toString()]).toEqual([4404, "connector_offline"]);
  });

  it("reports actual device reachability across HTTP instances, without opening a pipe", async () => {
    // Different HTTP instance, shared internal broker; it has no daemon socket map.
    const metadataApp = Fastify();
    registerNextRouteRoutes(metadataApp, { db, publicUrl: "https://connect.example", broker });
    const route = async () => (await metadataApp.inject({ method: "GET", url: `/v1/next/collections/${ids.localId}/route`,
      headers: { authorization: `Bearer ${accessToken}` } })).json().targets[0].online;
    let socket: WebSocket | undefined;
    try {
      expect(await route()).toBe(false);
      socket = await daemon(false);
      expect(await route()).toBe(false);
      socket.close();
      await once(socket, "close");
      socket = await daemon(true, false);
      expect(await route()).toBe(false);
      socket.close();
      await once(socket, "close");
      socket = await daemon();
      let opened = 0;
      socket.on("message", (data, binary) => {
        if (!binary && JSON.parse(data.toString()).type === "pipe_open") opened++;
      });
      await expect.poll(route).toBe(true);
      const generation = lastGeneration;
      const invalid = await broker.request(ids.connector, generation,
        { version: 1, kind: "device_presence", message: { device_id: ids.device, extra: true } }, 1_000);
      expect(invalid.ok).toBe(false);
      const wrong = await broker.request(ids.connector, generation,
        { version: 1, kind: "device_presence", message: { device_id: randomUUID() } }, 1_000);
      expect(wrong).toEqual({ version: 1, ok: true, value: false });
      expect(opened).toBe(0);
      await db.query("UPDATE connectors SET relay_generation = relay_generation + 1 WHERE id = $1", [ids.connector]);
      expect(await route()).toBe(false);
      const stale = await broker.request(ids.connector, generation,
        { version: 1, kind: "device_presence", message: { device_id: ids.device } }, 1_000);
      expect(stale.ok).toBe(false);
      socket.close();
      await once(socket, "close");
      expect(await route()).toBe(false);
    } finally {
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        socket.close();
        await once(socket, "close");
      }
      await metadataApp.close();
    }
  });

  it("routes only to the named device's current bound socket with its registered key (SEC-039)", async () => {
    const unbound = await daemon(false);
    const pending = await client();
    expect((await once(pending, "close")).map(String)).toEqual(["4404", "connector_offline"]);
    unbound.close();
    await once(unbound, "close");

    const device = await daemon();
    const wrongDevice = await client(ids.grant, { device: randomUUID() });
    expect((await once(wrongDevice, "close")).map(String)).toEqual(["4000", "device_mismatch"]);
    const wrongKey = await client(ids.grant, { noisePk: randomBytes(32).toString("hex") });
    expect((await once(wrongKey, "close")).map(String)).toEqual(["4000", "device_key_mismatch"]);

    // A request still addressed to this socket's generation after a newer one exists
    // (e.g. a replacement whose fence failed to close it) is refused at routing time,
    // and the stale socket's pipes are closed.
    const live = await client();
    await next(live, json("pipe_opened"));
    const liveClosed = once(live, "close");
    const oldGeneration = lastGeneration;
    await db.query("UPDATE connectors SET relay_generation = relay_generation + 1 WHERE id = $1", [ids.connector]);
    const pipeId = randomUUID();
    const refused = new Promise<string>((resolve) => {
      void broker.subscribePipe(pipeSubject(pipeId, "client"), (data) => resolve(Buffer.from(data.subarray(1)).toString()));
    });
    await broker.publishPipe(pipeSubject("open", ids.connector, oldGeneration), Buffer.from(JSON.stringify({
      pipe_id: pipeId, collection_id: ids.localId, grant_id: ids.grant, device_id: ids.device, device_noise_pk: deviceNoisePk.toString("hex")
    })));
    expect(await refused).toBe("connector_offline");
    expect((await liveClosed).map(String)).toEqual(["4404", "connector_offline"]);
    device.close();
  });
});

describePostgres("Noise pipe revocation backstop", () => {
  let admin: pg.Pool;
  let db: DatabasePool;
  let schema: string;
  const broker = new LocalRelayBroker();
  const app = Fastify();
  let base = "";

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Pipe tests require a dedicated local test database.");
    schema = `mdbase_next_pipe_revocation_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    await app.register(websocket);
    registerNoisePipeClientRoute(app, { db, broker, limits: { ...DEFAULT_NOISE_PIPE_LIMITS, revalidateMs: 100 } });
    base = (await app.listen({ host: "127.0.0.1", port: 0 })).replace(/^http/, "ws");
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  }, 60_000);

  it("allocates no recurring queries or broker resources when admission resumes after client close", async () => {
    const id = await localGrantFixture(db);
    let resolveAdmission!: (value: unknown) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise((resolve) => { resolveAdmission = resolve; });
    const queries = vi.spyOn(db, "query").mockImplementationOnce(() => { entered(); return held as ReturnType<typeof db.query>; });
    const subscriptions = vi.spyOn(broker, "subscribePipe");
    const publications = vi.spyOn(broker, "publishPipe");
    const socket = new WebSocket(`${base}/v1/next/relay/client`);
    try {
      await once(socket, "open");
      socket.send(JSON.stringify({ type: "pipe_auth", access_token: "synthetic", collection: id, grant: id, device: randomUUID(), device_noise_pk: "11".repeat(32) }));
      await started;
      const closed = once(socket, "close");
      socket.close();
      await closed;
      await new Promise((resolve) => setTimeout(resolve, 20));
      resolveAdmission({ rows: [{ connector_id: id }], rowCount: 1, command: "SELECT", fields: [], oid: 0 });
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(queries).toHaveBeenCalledTimes(1);
      expect(subscriptions).not.toHaveBeenCalled();
      expect(publications).not.toHaveBeenCalled();
    } finally {
      queries.mockRestore(); subscriptions.mockRestore(); publications.mockRestore(); socket.close();
    }
  });

  it.each(["generation", "subscribe", "publish"])("cleans up close during suspended %s without starting revalidation", async (stage) => {
    const id = await localGrantFixture(db);
    let resume!: (value: unknown) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise((resolve) => { resume = resolve; });
    const result = (rows: unknown[]) => ({ rows, rowCount: rows.length, command: "SELECT", fields: [], oid: 0 });
    const queries = vi.spyOn(db, "query").mockResolvedValueOnce(result([{ connector_id: id }]));
    if (stage === "generation") queries.mockImplementationOnce(() => { entered(); return held as ReturnType<typeof db.query>; });
    else queries.mockResolvedValueOnce(result([{ relay_generation: 1 }]));
    const closeBinding = vi.fn(async () => undefined);
    const subscriptions = vi.spyOn(broker, "subscribePipe");
    if (stage === "subscribe") subscriptions.mockImplementationOnce(() => { entered(); return held as ReturnType<typeof broker.subscribePipe>; });
    else if (stage === "publish") subscriptions.mockResolvedValueOnce({ close: closeBinding });
    const publications = vi.spyOn(broker, "publishPipe");
    if (stage === "publish") publications.mockImplementationOnce(() => { entered(); return held as ReturnType<typeof broker.publishPipe>; });
    const socket = new WebSocket(`${base}/v1/next/relay/client`);
    try {
      await once(socket, "open");
      socket.send(JSON.stringify({ type: "pipe_auth", access_token: "synthetic", collection: id, grant: id, device: randomUUID(), device_noise_pk: "11".repeat(32) }));
      await started;
      const closed = once(socket, "close"); socket.close(); await closed;
      await new Promise((resolve) => setTimeout(resolve, 20));
      resume(stage === "generation" ? result([{ relay_generation: 1 }]) : stage === "subscribe" ? { close: closeBinding } : undefined);
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(queries).toHaveBeenCalledTimes(2);
      if (stage === "generation") expect(subscriptions).not.toHaveBeenCalled();
      else expect(closeBinding).toHaveBeenCalledTimes(1);
      if (stage !== "publish") expect(publications).not.toHaveBeenCalled();
    } finally {
      queries.mockRestore(); subscriptions.mockRestore(); publications.mockRestore(); socket.close();
    }
  });

  it.each(["grant", "token", "lookup"])("closes an open pipe at both ends on %s denial", async (revoked) => {
    const id = await localGrantFixture(db);
    await db.query("UPDATE grants SET activated_at = now() WHERE id = $1", [id]);
    await db.query("UPDATE collections SET enabled = true, present = true, authority_state = 'active' WHERE id = $1", [id]);
    await db.query("INSERT INTO next_grant_client_keys(grant_id, client_pk) VALUES($1,$2)", [id, randomBytes(32)]);
    const token = `at_${randomUUID()}`;
    await db.query("INSERT INTO access_tokens(id,token_hash,grant_id,expires_at) VALUES($1,$2,$3,now() + interval '1 hour')", [randomUUID(), tokenHash(token), id]);
    // The daemon's side, on the broker: accept the open, then watch the device subject.
    const toDevice: string[] = [];
    await broker.subscribePipe(pipeSubject("open", id, "1"), (data) => {
      const { pipe_id: pipeId } = JSON.parse(Buffer.from(data).toString()) as { pipe_id: string };
      void broker.subscribePipe(pipeSubject(pipeId, "device"), (message) => toDevice.push(`${message[0]}:${Buffer.from(message.subarray(1)).toString()}`));
      void broker.publishPipe(pipeSubject(pipeId, "client"), Buffer.of(1));
    });
    const socket = new WebSocket(`${base}/v1/next/relay/client`);
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "pipe_auth", access_token: token, collection: id, grant: id, device: randomUUID(), device_noise_pk: "11".repeat(32) }));
    await next(socket, json("pipe_opened"));
    const closed = once(socket, "close");
    const lookup = revoked === "lookup" ? vi.spyOn(db, "query").mockRejectedValueOnce(new Error("database unavailable")) : undefined;
    try {
      if (revoked === "grant") await db.query("UPDATE grants SET revoked_at = now() WHERE id = $1", [id]);
      else if (revoked === "token") await db.query("UPDATE access_tokens SET revoked_at = now() WHERE grant_id = $1", [id]);
      expect((await closed).map(String)).toEqual(revoked === "lookup" ? ["4404", "connector_offline"] : ["4403", "grant_inactive"]);
      expect(toDevice).toContain(revoked === "lookup" ? "2:authorization_unavailable" : "2:grant_revoked");
      const afterClose = vi.spyOn(db, "query");
      const callsAtClose = afterClose.mock.calls.length;
      try {
        await new Promise((resolve) => setTimeout(resolve, 350));
        expect(afterClose.mock.calls).toHaveLength(callsAtClose);
      } finally { afterClose.mockRestore(); }
    } finally {
      lookup?.mockRestore();
      socket.close();
    }
  });
});
