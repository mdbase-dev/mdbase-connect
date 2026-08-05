import { randomBytes, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import {
  APPLICATION_AUTHORIZATION_PROTOCOL_VERSION,
  authorizationContractRequirements,
  CONNECT_CONTRACT_SUPPORT,
  CONTROL_PROTOCOL_VERSION,
  decodeRelayFileFrame,
  encodeFileFrame,
  encodeRelayFileFrame,
  FILE_TRANSFER_PROTOCOL_VERSION,
  GRANT_ENCRYPTION_PROTOCOL_VERSION,
  OPERATION_TRANSPORT_PROTOCOL_VERSION,
  RELAY_CAPABILITIES
} from "../packages/protocol/dist/index.js";
import {
  applicationInstallationId,
  MemoryGrantKeyStore,
  signApplicationAuthorization
} from "../packages/client/dist/crypto-entry.js";
import { availableTcpPort, poll } from "./lib/test-runtime.mjs";

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
  }, "PostgreSQL did not become ready", 600, 100);
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
  assert(denied.status === 200
    && denied.body.ok === false
    && denied.body.problem?.code === "access_denied"
    && denied.body.problem?.category === "authorization"
    && denied.body.problem?.recovery === "reauthorize"
    && denied.body.problem?.operation_outcome === "rejected",
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
    protocol_version: GRANT_ENCRYPTION_PROTOCOL_VERSION,
    suite: "P256-HKDF-SHA256-AES256GCM",
    key_id: `enc_${randomUUID()}`,
    scope_epoch: 1,
    connector_id: fixture.connectorId,
    collection_id: fixture.localCollectionId,
    application_agreement_public_key: fixture.grantAgreementPublicKey,
    connector_agreement_public_key: fixture.connectorAgreementPublicKey
  };
  await database.query(
    `UPDATE grants
     SET encryption = $2::jsonb,
         file_capability = $3::jsonb
     WHERE id = $1`, [
    fixture.grantId,
    JSON.stringify(encryption),
    JSON.stringify({
      kind: "files",
      protocol_version: 1,
      actions: ["list", "read", "add", "replace"],
      scope: { kind: "collection" }
    })
  ]);
  await builtB.relay.pushPolicy(fixture.connectorId);
  const uploadTransferId = randomUUID();
  const uploadFrame = opaqueFileFrame({
    fixture,
    encryption,
    transferId: uploadTransferId,
    direction: "upload",
    plaintextLength: 128
  });
  const relayedUpload = await fetch(
    `${urlA}/v1/authorities/${fixture.localCollectionId}/files/upload`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.accessToken}`,
        "content-type": "application/mdbase-connect-file"
      },
      body: uploadFrame
    }
  );
  assert(relayedUpload.status === 204,
    `Opaque file upload did not cross NATS: ${relayedUpload.status} ${await relayedUpload.text()}`);
  assert(connectorB.fileUploads.length === 1
      && Buffer.compare(Buffer.from(connectorB.fileUploads[0]), Buffer.from(uploadFrame)) === 0,
  "The connector did not receive the exact opaque upload frame");

  const downloadTransferId = randomUUID();
  const downloadFrame = opaqueFileFrame({
    fixture,
    encryption,
    transferId: downloadTransferId,
    direction: "download",
    plaintextLength: 96
  });
  connectorB.setDownloadFrame(downloadFrame);
  const relayedDownload = await fetch(
    `${urlA}/v1/authorities/${fixture.localCollectionId}/files/download/${downloadTransferId}/0`,
    { headers: { authorization: `Bearer ${fixture.accessToken}` } }
  );
  assert(relayedDownload.status === 200
      && relayedDownload.headers.get("content-type") === "application/mdbase-connect-file"
      && Buffer.compare(
        Buffer.from(await relayedDownload.arrayBuffer()),
        Buffer.from(downloadFrame)
      ) === 0,
  "The exact opaque download frame did not return across NATS");

  const foreignFrame = opaqueFileFrame({
    fixture,
    encryption: { ...encryption, key_id: "foreign-key" },
    transferId: randomUUID(),
    direction: "upload",
    plaintextLength: 1
  });
  const rejectedFile = await fetch(
    `${urlA}/v1/authorities/${fixture.localCollectionId}/files/upload`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.accessToken}`,
        "content-type": "application/mdbase-connect-file"
      },
      body: foreignFrame
    }
  );
  assert(rejectedFile.status === 400 && connectorB.fileUploads.length === 1,
    "The control plane forwarded a file frame with a stale grant key");

  const encryptedEnvelope = {
    type: "encrypted_operation_request",
    protocol_version: OPERATION_TRANSPORT_PROTOCOL_VERSION,
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
  const authorizationId = randomUUID();
  const connectorToken = `con_${randomBytes(32).toString("base64url")}`;
  const accessToken = `acc_${randomBytes(32).toString("base64url")}`;
  const keyStore = new MemoryGrantKeyStore();
  const installationKey = await keyStore.create(`relay-e2e-installation:${applicationId}`);
  const grantKey = await keyStore.create(`relay-e2e-grant:${grantId}`);
  const connectorKey = await keyStore.create(`relay-e2e-connector:${connectorId}`);
  const issuedAt = new Date();
  const applicationAuthorization = await signApplicationAuthorization({
    protocol_version: APPLICATION_AUTHORIZATION_PROTOCOL_VERSION,
    authorization_id: authorizationId,
    application_id: applicationId,
    application_manifest_digest: "00".repeat(32),
    application_installation_id: await applicationInstallationId(installationKey),
    installation_signing_public_key: installationKey.signingPublicKey,
    grant_agreement_public_key: grantKey.agreementPublicKey,
    grant_signing_public_key: grantKey.signingPublicKey,
    flow: "authorization_code",
    authorization_nonce: randomBytes(32).toString("base64url"),
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + 10 * 60 * 1_000).toISOString(),
    redirect_uri: "https://relay-e2e.example/callback",
    state: "relay-e2e",
    code_challenge: randomBytes(32).toString("base64url"),
    contracts: authorizationContractRequirements(["read", "query"]),
    requested_operations: ["read", "query"],
    collection_id: collectionId
  }, installationKey);
  await db.query(
    "INSERT INTO users (id, email, name) VALUES ($1, $2, $3)",
    [userId, "relay-e2e@example.com", "Relay E2E"]
  );
  await db.query(
    "INSERT INTO connectors (id, user_id, name, token_hash) VALUES ($1, $2, $3, $4)",
    [connectorId, userId, "Relay E2E connector", hash(connectorToken)]
  );
  await db.query(
    `INSERT INTO collections
       (id, user_id, connector_id, local_id, display_name, spec_version, contracts)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [collectionId, userId, connectorId, localCollectionId, "Relay E2E collection", "0.3.0", "[]"]
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
       (id, user_id, application_id, collection_id, operations, scope,
        application_origin, application_authorization,
        application_installation_id, activated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, now())`,
    [
      grantId,
      userId,
      applicationId,
      collectionId,
      JSON.stringify(["read", "query"]),
      JSON.stringify({ contracts: [], access: "full_collection" }),
      "https://relay-e2e.example",
      JSON.stringify(applicationAuthorization),
      applicationAuthorization.binding.application_installation_id
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
    grantAgreementPublicKey: grantKey.agreementPublicKey,
    connectorAgreementPublicKey: connectorKey.agreementPublicKey,
    connectorToken,
    accessToken
  };
}

async function connectFakeConnector({ WebSocket: Socket, serverUrl, token, owner }) {
  const socket = new Socket(serverUrl.replace(/^http/, "ws") + "/v1/relay", {
    headers: { authorization: `Bearer ${token}` }
  });
  const policies = [];
  const messageTypes = [];
  let closeDetails;
  let policyWaiter;
  let welcomeWaiter;
  let downloadFrame;
  const fileUploads = [];
  socket.on("close", (code, reason) => {
    closeDetails = { code, reason: reason.toString() };
  });
  socket.on("message", (raw, isBinary) => {
    if (isBinary) {
      const request = decodeRelayFileFrame(new Uint8Array(raw));
      if (request.kind === "upload_chunk") fileUploads.push(request.payload);
      const kind = request.kind === "upload_chunk"
        ? "upload_acknowledged"
        : "download_chunk";
      socket.send(encodeRelayFileFrame({
        kind,
        header: { ...request.header, type: kind },
        payload: kind === "download_chunk" ? downloadFrame : new Uint8Array()
      }));
      return;
    }
    const message = JSON.parse(raw.toString());
    messageTypes.push(message.type);
    if (message.type === "relay_welcome") {
      welcomeWaiter?.();
      welcomeWaiter = undefined;
      return;
    }
    if (message.type === "policy_snapshot") {
      policies.push(message);
      socket.send(JSON.stringify({
        type: "policy_applied",
        protocol_version: CONTROL_PROTOCOL_VERSION,
        request_id: message.request_id,
        revision: message.revision,
        ok: true
      }));
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
        protocol_version: OPERATION_TRANSPORT_PROTOCOL_VERSION,
        request_id: message.request_id,
        ok: false,
        problem: {
          problem_version: 1,
          code: "access_denied",
          category: "authorization",
          recovery: "reauthorize",
          message: "Denied by the connector fixture.",
          operation_outcome: "rejected"
        }
      }));
      return;
    }
    socket.send(JSON.stringify({
      type: "operation_response",
      protocol_version: OPERATION_TRANSPORT_PROTOCOL_VERSION,
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
    socket.once("open", () => {
      socket.send(JSON.stringify({
        type: "relay_hello",
        protocol_version: CONTROL_PROTOCOL_VERSION,
        connector_version: "0.1.0-e2e",
        capabilities: [...RELAY_CAPABILITIES],
        contract_support: CONNECT_CONTRACT_SUPPORT
      }));
      resolveOpen();
    });
    socket.once("error", reject);
  });
  if (!messageTypes.includes("relay_welcome")) {
    await new Promise((resolveWelcome, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Connector ${owner} did not receive relay_welcome`)),
        10_000
      );
      welcomeWaiter = () => {
        clearTimeout(timer);
        resolveWelcome();
      };
    });
  }
  return {
    socket,
    policies,
    fileUploads,
    setDownloadFrame(frame) {
      downloadFrame = frame;
    },
    async waitForPolicy() {
      if (policies.length > 0) return;
      await new Promise((resolvePolicy, reject) => {
        const timer = setTimeout(() => reject(new Error(
          `Connector ${owner} did not receive a policy snapshot: `
          + JSON.stringify({ messageTypes, closeDetails })
        )), 10_000);
        policyWaiter = () => {
          clearTimeout(timer);
          resolvePolicy();
        };
      });
    }
  };
}

function opaqueFileFrame({ fixture, encryption, transferId, direction, plaintextLength }) {
  return encodeFileFrame({
    kind: direction === "upload" ? "upload_chunk" : "download_chunk",
    header: {
      protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
      protection: "grant_aead_v1",
      grant_id: fixture.grantId,
      authority_id: fixture.connectorId,
      collection_id: fixture.localCollectionId,
      transfer_id: transferId,
      direction,
      chunk_size: 64 * 1024,
      chunk_index: 0,
      offset: 0,
      plaintext_length: plaintextLength,
      total_size: plaintextLength,
      scope_epoch: encryption.scope_epoch,
      key_id: encryption.key_id
    },
    payload: new Uint8Array(plaintextLength + 16)
  });
}

async function operation(serverUrl, fixture, operationName, input) {
  const body = input?.type === "encrypted_operation_request"
    ? input
    : {
        protocol_version: OPERATION_TRANSPORT_PROTOCOL_VERSION,
        request_id: randomUUID(),
        input
      };
  const response = await fetch(
    `${serverUrl}/v1/authorities/${fixture.localCollectionId}/operations/${operationName}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
