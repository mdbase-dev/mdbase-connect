import { randomBytes, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";

process.env.NODE_ENV = "test";
const run = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const requireFromServer = createRequire(new URL("../services/server/package.json", import.meta.url));
const { WebSocket } = requireFromServer("ws");
const { buildApp } = await import("../services/server/dist/app.js");
const { createDatabase } = await import("../services/server/dist/db.js");
const { createRelayBroker } = await import("../services/server/dist/relay-broker.js");
const { tokenHash } = await import("../services/server/dist/security.js");

const postgresPort = await availableTcpPort();
const natsPort = await availableTcpPort();
const natsMonitorPort = await availableTcpPort();
const suffix = `${process.pid}-${randomBytes(4).toString("hex")}`;
const postgresName = `mdbase-connect-relay-pg-${suffix}`;
const natsName = `mdbase-connect-relay-nats-${suffix}`;
const postgresPassword = randomBytes(24).toString("base64url");
const natsToken = randomBytes(32).toString("base64url");
const natsImage = `mdbase-connect-nats-e2e-${suffix}`;

let postgresProcess;
let natsProcess;
let natsImageBuilt = false;
let database;
let appA;
let appB;
let socketA;
let socketB;

try {
  postgresProcess = startContainer([
    "--name", postgresName,
    "-e", "POSTGRES_DB=mdbase_connect",
    "-e", "POSTGRES_USER=mdbase",
    "-e", `POSTGRES_PASSWORD=${postgresPassword}`,
    "-p", `127.0.0.1:${postgresPort}:5432`,
    "postgres:17-alpine"
  ], "postgres");
  await poll(async () => {
    try {
      await run("docker", ["exec", postgresName, "pg_isready", "-U", "mdbase", "-d", "mdbase_connect"]);
      return true;
    } catch {
      return null;
    }
  }, "PostgreSQL did not become ready", 200, 100);
  // The image briefly starts a bootstrap server before restarting PostgreSQL
  // as PID 1. Do not mistake that initialization window for final readiness.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  await poll(async () => {
    try {
      await run("docker", ["exec", postgresName, "pg_isready", "-U", "mdbase", "-d", "mdbase_connect"]);
      return true;
    } catch {
      return null;
    }
  }, "PostgreSQL did not become ready after initialization", 100, 100);

  await run("docker", [
    "build",
    "--file", "deploy/docker/Dockerfile.nats",
    "--tag", natsImage,
    "."
  ], { cwd: repoRoot });
  natsImageBuilt = true;
  natsProcess = startNats();
  await waitForTcp(natsPort, "NATS did not become ready");
  await poll(async () => {
    const response = await fetch(`http://127.0.0.1:${natsMonitorPort}/healthz`);
    return response.ok ? true : null;
  }, "NATS monitoring did not become ready");
  await renderHeadProbe();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  const brokerLogs = await run("docker", ["logs", natsName]);
  assert(!`${brokerLogs.stdout}${brokerLogs.stderr}`.includes("Client parser ERROR"),
    "Render's delayed HTTP port discovery polluted the broker logs");
  await run("docker", [
    "exec", natsName, "sh", "-c",
    "printf 'BROKEN\\r\\n' | nc -w 2 127.0.0.1 4222 >/dev/null"
  ]);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  const malformedLogs = await run("docker", ["logs", natsName]);
  assert(`${malformedLogs.stdout}${malformedLogs.stderr}`.includes("Client parser ERROR"),
    "The Render probe filter hid an unrelated NATS parser error");

  database = await createDatabase(
    `postgres://mdbase:${postgresPassword}@127.0.0.1:${postgresPort}/mdbase_connect`
  );
  const config = { servers: [`nats://127.0.0.1:${natsPort}`], token: natsToken };
  const brokerA = await createRelayBroker(config);
  const brokerB = await createRelayBroker(config);
  ({ app: appA } = await buildApp({
    db: database,
    devAuth: true,
    publicUrl: "http://127.0.0.1",
    relayBroker: brokerA
  }));
  const builtB = await buildApp({
    db: database,
    devAuth: true,
    publicUrl: "http://127.0.0.1",
    relayBroker: brokerB
  });
  appB = builtB.app;
  await Promise.all([
    appA.listen({ host: "127.0.0.1", port: 0 }),
    appB.listen({ host: "127.0.0.1", port: 0 })
  ]);
  const urlA = appUrl(appA);
  const urlB = appUrl(appB);

  const fixture = await seed(database, tokenHash);
  const connectorA = await connectFakeConnector({
    WebSocket,
    serverUrl: urlA,
    token: fixture.connectorToken,
    owner: "instance-a"
  });
  socketA = connectorA.socket;
  await connectorA.waitForPolicy();

  const crossA = await operation(urlB, fixture, "read", { path: "first.md" });
  assert(crossA.status === 200 && crossA.body.result?.owner === "instance-a",
    `Instance B did not route through the socket on A: ${JSON.stringify(crossA)}`);

  const large = "x".repeat(1_500_000);
  const largeResult = await operation(urlB, fixture, "read", { blob: large });
  assert(largeResult.status === 200 && largeResult.body.result?.input_bytes === large.length,
    `Large transient relay payload failed: ${JSON.stringify(largeResult.body)}`);

  await database.query("UPDATE grants SET operations = $2::jsonb WHERE id = $1", [
    fixture.grantId,
    JSON.stringify(["read"])
  ]);
  const policyCount = connectorA.policies.length;
  await builtB.relay.pushPolicy(fixture.connectorId);
  await poll(
    async () => connectorA.policies.length > policyCount
      && connectorA.policies.at(-1)?.grants?.[0]?.operations?.length === 1,
    "A policy update from B did not reach the socket on A"
  );
  await database.query("UPDATE grants SET operations = $2::jsonb WHERE id = $1", [
    fixture.grantId,
    JSON.stringify(["read", "query"])
  ]);
  await builtB.relay.pushPolicy(fixture.connectorId);

  const denied = await operation(urlB, fixture, "read", { deny: true });
  assert(denied.status === 403 && denied.body.error?.code === "access_denied",
    `Connector authorization error was not preserved across NATS: ${JSON.stringify(denied)}`);

  const closedA = closed(socketA);
  const connectorB = await connectFakeConnector({
    WebSocket,
    serverUrl: urlB,
    token: fixture.connectorToken,
    owner: "instance-b"
  });
  socketB = connectorB.socket;
  await connectorB.waitForPolicy();
  const [closeCode] = await closedA;
  assert(closeCode === 4001, `Older cross-instance connector closed with ${closeCode}, not 4001`);

  const crossB = await operation(urlA, fixture, "query", { limit: 5 });
  assert(crossB.status === 200 && crossB.body.result?.owner === "instance-b",
    `Instance A did not route through the replacement socket on B: ${JSON.stringify(crossB)}`);

  const burst = await Promise.all(Array.from({ length: 200 }, (_, index) => operation(
    index % 2 === 0 ? urlA : urlB,
    fixture,
    index % 3 === 0 ? "query" : "read",
    { index }
  )));
  assert(burst.every((result) => result.status === 200 && result.body.result?.owner === "instance-b"),
    "Concurrent cross-instance relay burst was incomplete");

  const encryption = {
    protocol_version: 1,
    suite: "P256-HKDF-SHA256-AES256GCM",
    key_id: `enc_${randomUUID()}`,
    scope_epoch: 1,
    connector_id: fixture.connectorId,
    collection_id: fixture.localCollectionId,
    application_public_key: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString("base64url"),
    connector_public_key: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString("base64url")
  };
  await database.query("UPDATE grants SET encryption = $2::jsonb WHERE id = $1", [
    fixture.grantId,
    JSON.stringify(encryption)
  ]);
  await builtB.relay.pushPolicy(fixture.connectorId);
  const encryptedEnvelope = {
    type: "encrypted_operation_request",
    protocol_version: 1,
    suite: encryption.suite,
    request_id: randomUUID(),
    grant_id: fixture.grantId,
    application_id: fixture.applicationId,
    connector_id: fixture.connectorId,
    collection_id: fixture.localCollectionId,
    operation: "read",
    scope_epoch: encryption.scope_epoch,
    key_id: encryption.key_id,
    counter: "1",
    ciphertext: "A".repeat(1_500_000)
  };
  const encryptedResult = await operation(urlA, fixture, "read", encryptedEnvelope);
  assert(encryptedResult.status === 200
      && encryptedResult.body.envelope?.type === "encrypted_operation_response"
      && encryptedResult.body.envelope?.request_id === encryptedEnvelope.request_id
      && encryptedResult.body.envelope?.ciphertext === encryptedEnvelope.ciphertext,
  `Large opaque encrypted response failed across instances: ${JSON.stringify({
    status: encryptedResult.status,
    envelope: encryptedResult.body.envelope && {
      ...encryptedResult.body.envelope,
      ciphertext: `[${encryptedResult.body.envelope.ciphertext?.length} bytes]`
    }
  })}`);
  await database.query("UPDATE grants SET encryption = NULL WHERE id = $1", [fixture.grantId]);
  await builtB.relay.pushPolicy(fixture.connectorId);

  await stopContainer(natsName, natsProcess);
  natsProcess = undefined;
  await poll(async () => {
    const [readyA, readyB] = await Promise.all([fetch(`${urlA}/ready`), fetch(`${urlB}/ready`)]);
    return readyA.status === 503 && readyB.status === 503;
  }, "Connect readiness did not fail closed when NATS stopped", 100, 100);
  const unavailable = await operation(urlA, fixture, "read", {});
  assert(unavailable.status === 503 && unavailable.body.error?.code === "connector_offline",
    `Relay did not fail closed during broker outage: ${JSON.stringify(unavailable)}`);

  natsProcess = startNats();
  await waitForTcp(natsPort, "Restarted NATS did not become ready");
  await poll(async () => {
    const [readyA, readyB] = await Promise.all([fetch(`${urlA}/ready`), fetch(`${urlB}/ready`)]);
    return readyA.ok && readyB.ok;
  }, "Connect instances did not recover after NATS restart", 200, 100);
  const recovered = await operation(urlA, fixture, "read", { recovered: true });
  assert(recovered.status === 200 && recovered.body.result?.owner === "instance-b",
    `Relay subscriptions did not recover after broker restart: ${JSON.stringify(recovered)}`);

  socketB.close(1000, "offline test");
  await closed(socketB);
  socketB = undefined;
  await poll(async () => {
    const result = await operation(urlA, fixture, "read", {});
    return result.status === 503;
  }, "Relay kept routing after the connector disconnected");

  const connectorA2 = await connectFakeConnector({
    WebSocket,
    serverUrl: urlA,
    token: fixture.connectorToken,
    owner: "instance-a-reconnected"
  });
  socketA = connectorA2.socket;
  await connectorA2.waitForPolicy();
  const reconnected = await operation(urlB, fixture, "read", {});
  assert(reconnected.status === 200 && reconnected.body.result?.owner === "instance-a-reconnected",
    `Relay did not follow a post-outage reconnect: ${JSON.stringify(reconnected)}`);

  const generation = await database.query(
    "SELECT relay_generation::text AS relay_generation FROM connectors WHERE id = $1",
    [fixture.connectorId]
  );
  assert(generation.rows[0]?.relay_generation === "3",
    `Expected three fenced connector generations, got ${generation.rows[0]?.relay_generation}`);
  const persisted = await database.query(
    "SELECT count(*)::int AS count FROM audit_events WHERE metadata::text LIKE $1",
    [`%${large.slice(0, 64)}%`]
  );
  assert(persisted.rows[0]?.count === 0, "Relay operation payload appeared in control-plane audit storage");

  process.stdout.write("multi-instance NATS relay end-to-end path passed\n");
} finally {
  for (const socket of [socketA, socketB]) {
    if (socket?.readyState === WebSocket.OPEN) socket.close(1000, "test cleanup");
  }
  await Promise.allSettled([appA?.close(), appB?.close()].filter(Boolean));
  if (database) await database.end();
  if (natsProcess) await stopContainer(natsName, natsProcess);
  if (postgresProcess) await stopContainer(postgresName, postgresProcess);
  if (natsImageBuilt) {
    await removeImage(natsImage).catch((error) => {
      process.stderr.write(`[relay-e2e:nats] could not remove temporary image: ${error.message}\n`);
    });
  }
}

function startNats() {
  return startContainer([
    "--name", natsName,
    "-e", "PORT=10000",
    "-e", `NATS_AUTH_TOKEN=${natsToken}`,
    "-p", `127.0.0.1:${natsPort}:4222`,
    "-p", `127.0.0.1:${natsMonitorPort}:10000`,
    natsImage
  ], "nats");
}

function startContainer(args, label) {
  const child = spawn("docker", ["run", "--rm", ...args], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => process.stderr.write(`[relay-e2e:${label}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[relay-e2e:${label}] ${chunk}`));
  return child;
}

async function stopContainer(name, child) {
  if (child.exitCode !== null) return;
  try {
    await run("docker", ["stop", "--timeout", "5", name]);
  } catch {
    // The container may already have exited and removed itself.
  }
  if (child.exitCode === null) {
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))
    ]);
  }
}

async function removeImage(image) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await run("docker", ["image", "rm", "--force", image]);
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
}

async function seed(db, hash) {
  const userId = randomUUID();
  const connectorId = randomUUID();
  const collectionId = randomUUID();
  const localCollectionId = randomUUID();
  const applicationId = randomUUID();
  const grantId = randomUUID();
  const connectorToken = `con_${randomBytes(32).toString("base64url")}`;
  const accessToken = `acc_${randomBytes(32).toString("base64url")}`;
  await db.query(
    "INSERT INTO users (id, email, name) VALUES ($1, $2, $3)",
    [userId, "relay-e2e@example.com", "Relay E2E"]
  );
  await db.query(
    "INSERT INTO connectors (id, user_id, name, token_hash) VALUES ($1, $2, $3, $4)",
    [connectorId, userId, "Relay E2E connector", hash(connectorToken)]
  );
  await db.query(
    `INSERT INTO collections (id, connector_id, local_id, display_name, spec_version, contracts)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [collectionId, connectorId, localCollectionId, "Relay E2E collection", "0.3.0", "[]"]
  );
  await db.query(
    `INSERT INTO applications
       (id, canonical_identity, name, homepage, redirect_uris, requirements, provisions)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
    [
      applicationId,
      "bundle:dev.mdbase.relay-e2e:sha256:test",
      "Relay E2E app",
      "https://relay-e2e.example",
      JSON.stringify(["https://relay-e2e.example/callback"]),
      JSON.stringify({ contracts: [] }),
      JSON.stringify({ types: [] })
    ]
  );
  await db.query(
    `INSERT INTO grants
       (id, user_id, application_id, collection_id, operations, scope, application_origin)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
    [
      grantId,
      userId,
      applicationId,
      collectionId,
      JSON.stringify(["read", "query"]),
      JSON.stringify({ contracts: [], access: "full_collection" }),
      "https://relay-e2e.example"
    ]
  );
  await db.query(
    `INSERT INTO access_tokens (id, token_hash, grant_id, expires_at)
     VALUES ($1, $2, $3, now() + interval '1 hour')`,
    [randomUUID(), hash(accessToken), grantId]
  );
  return {
    connectorId,
    collectionId,
    localCollectionId,
    applicationId,
    grantId,
    connectorToken,
    accessToken
  };
}

async function connectFakeConnector({ WebSocket: Socket, serverUrl, token, owner }) {
  const socket = new Socket(serverUrl.replace(/^http/, "ws") + "/v1/relay", {
    headers: { authorization: `Bearer ${token}` }
  });
  const policies = [];
  let policyWaiter;
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "policy_snapshot") {
      policies.push(message);
      policyWaiter?.();
      policyWaiter = undefined;
      return;
    }
    if (message.type === "encrypted_operation_request") {
      socket.send(JSON.stringify({
        ...message,
        type: "encrypted_operation_response"
      }));
      return;
    }
    if (message.type !== "operation_request") return;
    if (message.input?.deny) {
      socket.send(JSON.stringify({
        type: "operation_response",
        protocol_version: 1,
        request_id: message.request_id,
        ok: false,
        error: { code: "access_denied", message: "Denied by the connector fixture." }
      }));
      return;
    }
    socket.send(JSON.stringify({
      type: "operation_response",
      protocol_version: 1,
      request_id: message.request_id,
      ok: true,
      result: {
        owner,
        operation: message.operation,
        input_bytes: typeof message.input?.blob === "string" ? message.input.blob.length : 0
      }
    }));
  });
  await new Promise((resolveOpen, reject) => {
    socket.once("open", resolveOpen);
    socket.once("error", reject);
  });
  return {
    socket,
    policies,
    async waitForPolicy() {
      if (policies.length > 0) return;
      await new Promise((resolvePolicy, reject) => {
        const timer = setTimeout(() => reject(new Error("Connector did not receive a policy snapshot")), 10_000);
        policyWaiter = () => {
          clearTimeout(timer);
          resolvePolicy();
        };
      });
    }
  };
}

async function operation(serverUrl, fixture, operationName, input) {
  const response = await fetch(
    `${serverUrl}/v1/collections/${fixture.collectionId}/operations/${operationName}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(input)
    }
  );
  return { status: response.status, body: await response.json() };
}

function appUrl(app) {
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Connect did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

function closed(socket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve([1000, Buffer.alloc(0)]);
  return new Promise((resolveClose) => socket.once("close", (code, reason) => resolveClose([code, reason])));
}

async function waitForTcp(port, message) {
  await poll(() => canConnect(port), message, 200, 50);
}

function canConnect(port) {
  return new Promise((resolveConnect) => {
    const socket = new (requireFromServer("node:net").Socket)();
    socket.setTimeout(250);
    socket.once("connect", () => {
      socket.destroy();
      resolveConnect(true);
    });
    socket.once("error", () => resolveConnect(null));
    socket.once("timeout", () => {
      socket.destroy();
      resolveConnect(null);
    });
    socket.connect(port, "127.0.0.1");
  });
}

async function renderHeadProbe() {
  await run("docker", [
    "exec", natsName, "sh", "-c",
    "(sleep 2; printf 'HEAD / HTTP/1.1\\r\\nHost: mdbase-connect-relay-broker\\r\\nConnection: close\\r\\n\\r\\n') | nc -w 4 127.0.0.1 4222 >/dev/null"
  ]);
}

async function availableTcpPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a test port");
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

async function poll(action, failureMessage, attempts = 100, delayMs = 100) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await action();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
  }
  throw new Error(failureMessage, { cause: lastError });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
