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
  MAX_FILE_CHUNK_BYTES,
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
const { createDatabase, openDatabase } = await import("../services/server/dist/db.js");
const { createRelayBroker } = await import("../services/server/dist/relay-broker.js");
const { ensureApplicationReconciliation } = await import(
  "../services/server/dist/application-reconciliation.js"
);
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
let databaseA;
let databaseB;
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

  const databaseUrl =
    `postgres://mdbase:${postgresPassword}@127.0.0.1:${postgresPort}/mdbase_connect`;
  databaseA = await createDatabase(databaseUrl);
  const fixture = await seed(databaseA, tokenHash);
  // Use independent pools so readiness proves visibility through the same
  // database boundary used by two separately deployed Connect instances.
  databaseB = await openDatabase(databaseUrl);
  const config = { servers: [`nats://127.0.0.1:${natsPort}`], token: natsToken };
  const brokerA = await createRelayBroker(config);
  const brokerB = await createRelayBroker(config);
  ({ app: appA } = await buildApp({
    db: databaseA,
    devAuth: true,
    publicUrl: "http://127.0.0.1",
    relayBroker: brokerA
  }));
  const builtB = await buildApp({
    db: databaseB,
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

  // Seed the production reconciliation job explicitly before draining. Worker
  // startup seeds asynchronously, so draining without this barrier could see
  // an empty queue and return before the startup seed completed.
  await ensureApplicationReconciliation(databaseA, fixture.applicationId);
  // Force both instance workers across the committed fixture. Before the
  // declaration matched its full-collection grant, this deterministically
  // revoked the grant and token that only occasionally raced in merge runs.
  await Promise.all([
    appA.drainApplicationReconciliation(),
    appB.drainApplicationReconciliation()
  ]);

  const connectorA = await connectFakeConnector({
    WebSocket,
    serverUrl: urlA,
    token: fixture.connectorToken,
    owner: "instance-a"
  });
  socketA = connectorA.socket;
  await connectorA.waitForPolicy();
  const initialPolicy = connectorA.policies.at(-1);
  const initialPolicyPredicates = {
    one_grant: initialPolicy?.grants?.length === 1,
    read_allowed: initialPolicy?.grants?.[0]?.operations?.includes("read") === true,
    query_allowed: initialPolicy?.grants?.[0]?.operations?.includes("query") === true
  };
  assert(Object.values(initialPolicyPredicates).every(Boolean),
    `Connector did not apply the committed authorization: ${JSON.stringify(initialPolicyPredicates)}`);
  await waitForAuthorizationReadiness([
    { name: "instance-a", db: databaseA },
    { name: "instance-b", db: databaseB }
  ], fixture);

  // This is the authorization assertion, not a readiness probe. In particular,
  // never retry this request if its live bearer credential is rejected.
  const crossA = await operation(urlB, fixture, "read", { path: "first.md" });
  if (crossA.status !== 200 || crossA.body.result?.owner !== "instance-a") {
    const diagnostics = await authorizationDiagnosticsForInstances([
      { name: "instance-a", db: databaseA },
      { name: "instance-b", db: databaseB }
    ], fixture);
    throw new Error(
      "Instance B did not route through the socket on A: "
      + JSON.stringify({
        status: crossA.status,
        error_code: crossA.body.error?.code ?? null,
        authorization_predicates: diagnostics
      })
    );
  }

  const large = "x".repeat(1_500_000);
  const largeResult = await operation(urlB, fixture, "read", { blob: large });
  assert(largeResult.status === 200 && largeResult.body.result?.input_bytes === large.length,
    `Large transient relay payload failed: ${JSON.stringify(largeResult.body)}`);

  const oversizedBrokerResponseBytes = 6 * 1_024 * 1_024;
  const oversizedBrokerResponse = await operation(urlB, fixture, "query", {
    response_bytes: oversizedBrokerResponseBytes
  });
  assert(
    oversizedBrokerResponse.status === 200
      && oversizedBrokerResponse.body.result?.blob?.length === oversizedBrokerResponseBytes,
    `A legitimate response above NATS max_payload did not use bounded framing: ${JSON.stringify({
      status: oversizedBrokerResponse.status,
      body: oversizedBrokerResponse.body.result && {
        ...oversizedBrokerResponse.body.result,
        blob: `[${oversizedBrokerResponse.body.result.blob?.length} bytes]`
      }
    })}`
  );
  assert((await fetch(`${urlA}/health`)).ok && (await fetch(`${urlB}/health`)).ok,
    "A large framed response terminated a Connect instance");

  await databaseA.query("UPDATE grants SET operations = $2::jsonb WHERE id = $1", [
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
  await databaseA.query("UPDATE grants SET operations = $2::jsonb WHERE id = $1", [
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

  const burstRequests = Array.from({ length: 200 }, (_, index) => ({
    serverUrl: index % 2 === 0 ? urlA : urlB,
    operationName: index % 3 === 0 ? "query" : "read",
    input: { index }
  }));
  const burst = await Promise.all(burstRequests.map((request) => operation(
    request.serverUrl,
    fixture,
    request.operationName,
    request.input
  )));
  const busyIndexes = [];
  const invalidResults = [];
  for (const [index, result] of burst.entries()) {
    if (result.status === 200 && result.body.result?.owner === "instance-b") continue;
    if (result.status === 200
        && result.body.ok === false
        && result.body.problem?.code === "connector_busy"
        && result.body.problem?.category === "availability"
        && result.body.problem?.recovery === "retry") {
      busyIndexes.push(index);
      continue;
    }
    invalidResults.push({ index, status: result.status, body: result.body });
  }
  assert(invalidResults.length === 0,
    `Concurrent cross-instance relay burst returned invalid results: ${JSON.stringify(invalidResults)}`);
  for (const index of busyIndexes) {
    const request = burstRequests[index];
    const retried = await operation(
      request.serverUrl,
      fixture,
      request.operationName,
      request.input
    );
    assert(retried.status === 200 && retried.body.result?.owner === "instance-b",
      `A retryable cross-instance relay request did not recover: ${JSON.stringify({ index, retried })}`);
  }

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
  await databaseA.query(
    `UPDATE grants
     SET encryption = $2::jsonb,
         file_capability = $3::jsonb,
         operations = $4::jsonb
     WHERE id = $1`, [
    fixture.grantId,
    JSON.stringify(encryption),
    JSON.stringify({
      kind: "files",
      protocol_version: 1,
      actions: ["list", "read", "add", "replace"],
      scope: { kind: "collection" }
    }),
    JSON.stringify(["read", "query", "create"])
  ]);
  await builtB.relay.pushPolicy(fixture.connectorId);
  const uploadTransferId = randomUUID();
  const uploadFrame = opaqueFileFrame({
    fixture,
    encryption,
    transferId: uploadTransferId,
    direction: "upload",
    // The encrypted frame is larger than NATS's 4 MiB max_payload once its
    // protocol header and authentication tag are included.
    plaintextLength: MAX_FILE_CHUNK_BYTES
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
    plaintextLength: MAX_FILE_CHUNK_BYTES
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

  const timedMutation = {
    ...encryptedEnvelope,
    request_id: randomUUID(),
    operation: "create",
    counter: "2",
    deadline_unix_ms: Date.now() + 250,
    ciphertext: "bXV0YXRpb24"
  };
  const unknownMutation = await operation(urlA, fixture, "create", timedMutation);
  assert(unknownMutation.status === 409
      && unknownMutation.body.error?.code === "operation_outcome_unknown"
      && unknownMutation.body.error?.operation_outcome === "unknown"
      && unknownMutation.body.error?.details?.request_id === timedMutation.request_id,
  `A post-dispatch mutation deadline lost its unknown outcome across NATS: ${JSON.stringify(unknownMutation)}`);

  const recoveredMutation = await operation(urlA, fixture, "create", {
    ...timedMutation,
    deadline_unix_ms: Date.now() + 5_000
  });
  assert(recoveredMutation.status === 200
      && recoveredMutation.body.envelope?.request_id === timedMutation.request_id
      && recoveredMutation.body.envelope?.counter === timedMutation.counter
      && recoveredMutation.body.envelope?.ciphertext === timedMutation.ciphertext,
  `The same durable mutation identity did not recover with a fresh deadline: ${JSON.stringify(recoveredMutation)}`);
  await databaseA.query("UPDATE grants SET encryption = NULL WHERE id = $1", [fixture.grantId]);
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

  const generation = await databaseA.query(
    "SELECT relay_generation::text AS relay_generation FROM connectors WHERE id = $1",
    [fixture.connectorId]
  );
  assert(generation.rows[0]?.relay_generation === "3",
    `Expected three fenced connector generations, got ${generation.rows[0]?.relay_generation}`);
  const persisted = await databaseA.query(
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
  await Promise.allSettled(
    [databaseA, databaseB].filter(Boolean).map((database) => database.end())
  );
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
    application_declaration_id: "dev.mdbase.relay-e2e",
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
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      "INSERT INTO users (id, email, name) VALUES ($1, $2, $3)",
      [userId, "relay-e2e@example.com", "Relay E2E"]
    );
    await connection.query(
      "INSERT INTO connectors (id, user_id, name, token_hash) VALUES ($1, $2, $3, $4)",
      [connectorId, userId, "Relay E2E connector", hash(connectorToken)]
    );
    await connection.query(
      `INSERT INTO collections
         (id, user_id, connector_id, local_id, display_name, spec_version, contracts)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [collectionId, userId, connectorId, localCollectionId, "Relay E2E collection", "0.3.0", "[]"]
    );
    await connection.query(
      `INSERT INTO applications
         (id, canonical_identity, name, homepage, redirect_uris, requirements, provisions)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
      [
        applicationId,
        "bundle:dev.mdbase.relay-e2e:sha256:test",
        "Relay E2E app",
        "https://relay-e2e.example",
        JSON.stringify(["https://relay-e2e.example/callback"]),
        JSON.stringify({ contracts: [], access: "full_collection" }),
        JSON.stringify({ types: [] })
      ]
    );
    await connection.query(
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
    await connection.query(
      `INSERT INTO access_tokens (id, token_hash, grant_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [randomUUID(), hash(accessToken), grantId]
    );
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
  return {
    userId,
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

async function waitForAuthorizationReadiness(instances, fixture) {
  let diagnostics;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    diagnostics = await authorizationDiagnosticsForInstances(instances, fixture);
    if (diagnostics.every(({ predicates }) => predicates.authorized)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(
    "Committed relay authorization was not ready on both instances: "
    + JSON.stringify({ authorization_predicates: diagnostics })
  );
}

async function authorizationDiagnosticsForInstances(instances, fixture) {
  return Promise.all(instances.map(async ({ name, db }) => ({
    instance: name,
    predicates: await authorizationDiagnostics(db, fixture)
  })));
}

async function authorizationDiagnostics(db, fixture) {
  const result = await db.query(
    `SELECT
       EXISTS(SELECT 1 FROM access_tokens WHERE token_hash = $1) AS token_present,
       EXISTS(SELECT 1 FROM access_tokens
         WHERE token_hash = $1 AND grant_id = $3) AS token_grant_match,
       EXISTS(SELECT 1 FROM access_tokens
         WHERE token_hash = $1 AND expires_at > now()) AS token_not_expired,
       EXISTS(SELECT 1 FROM access_tokens
         WHERE token_hash = $1 AND revoked_at IS NULL) AS token_not_revoked,
       EXISTS(SELECT 1 FROM grants WHERE id = $3) AS grant_present,
       EXISTS(SELECT 1 FROM grants
         WHERE id = $3 AND revoked_at IS NULL AND activated_at IS NOT NULL) AS grant_active,
       EXISTS(SELECT 1 FROM grants
         WHERE id = $3 AND user_id = $4 AND collection_id = $5
           AND application_id = $7) AS grant_links_match,
       EXISTS(SELECT 1 FROM users WHERE id = $4) AS user_present,
       EXISTS(SELECT 1 FROM users
         WHERE id = $4 AND suspended_at IS NULL) AS user_not_suspended,
       EXISTS(SELECT 1 FROM connectors WHERE id = $6) AS connector_present,
       EXISTS(SELECT 1 FROM connectors
         WHERE id = $6 AND user_id = $4 AND revoked_at IS NULL) AS connector_active,
       EXISTS(SELECT 1 FROM collections WHERE id = $5) AS collection_present,
       EXISTS(SELECT 1 FROM collections
         WHERE id = $5 AND connector_id = $6 AND local_id = $2) AS collection_links_match,
       EXISTS(SELECT 1 FROM collections
         WHERE id = $5 AND enabled = true) AS collection_enabled,
       EXISTS(SELECT 1 FROM collections
         WHERE id = $5 AND present = true) AS collection_inventory_present,
       EXISTS(SELECT 1 FROM collections
         WHERE id = $5 AND authority_state = 'active') AS collection_authority_active,
       EXISTS(SELECT 1 FROM applications
         WHERE id = $7 AND requirements->>'access' = 'full_collection') AS application_scope_compatible,
       EXISTS(
         SELECT 1
         FROM access_tokens tok
         JOIN grants g ON g.id = tok.grant_id
         JOIN users u ON u.id = g.user_id
         JOIN collections col ON col.id = g.collection_id
         WHERE tok.token_hash = $1 AND tok.expires_at > now()
           AND tok.revoked_at IS NULL
           AND g.id = $3 AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
           AND g.user_id = $4 AND g.application_id = $7 AND g.collection_id = $5
           AND u.suspended_at IS NULL
           AND col.connector_id = $6 AND col.local_id = $2 AND col.enabled = true
           AND col.present = true AND col.authority_state = 'active'
       ) AS authorized`,
    [
      tokenHash(fixture.accessToken),
      fixture.localCollectionId,
      fixture.grantId,
      fixture.userId,
      fixture.collectionId,
      fixture.connectorId,
      fixture.applicationId
    ]
  );
  return result.rows[0];
}

async function connectFakeConnector({ WebSocket: Socket, serverUrl, token, owner }) {
  const socket = new Socket(serverUrl.replace(/^http/, "ws") + "/v1/relay", {
    headers: { authorization: `Bearer ${token}` }
  });
  const policies = [];
  const messageTypes = [];
  const encryptedRequestCounts = new Map();
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
      const respond = () => socket.send(JSON.stringify({
        ...message,
        type: "encrypted_operation_response"
      }));
      const count = (encryptedRequestCounts.get(message.request_id) ?? 0) + 1;
      encryptedRequestCounts.set(message.request_id, count);
      if (message.operation === "create" && count === 1) {
        return;
      }
      respond();
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
        input_bytes: typeof message.input?.blob === "string" ? message.input.blob.length : 0,
        ...(Number.isSafeInteger(message.input?.response_bytes)
          ? { blob: "x".repeat(message.input.response_bytes) }
          : {})
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
      chunk_size: Math.max(64 * 1024, plaintextLength),
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
