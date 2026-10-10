#!/usr/bin/env node
/** Owned LOCAL TEST carrier: genuine CP auth/cloud-copy routes+PG/native LS,
 * original protected native device proofs/keys/bootstrap/adoption/read gate.
 * Memory encrypted custody/Node SQLite + service-generation fixtures are NOT
 * persistent browser/OS custody, deployed login/KMS or physical qualification. */
import assert from "node:assert/strict";
import {
  randomUUID,
  randomBytes,
  generateKeyPairSync,
  sign,
  createPublicKey,
  createHash,
} from "node:crypto";
import { readFileSync, mkdirSync, symlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { build } from "../node_modules/esbuild/lib/main.js";
const [artifact, connectCheckout, logBinary] = process.argv.slice(2),
  databaseUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
if (
  !artifact ||
  !connectCheckout ||
  !logBinary ||
  !databaseUrl ||
  process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL !==
    "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS"
)
  throw Error(
    "explicit artifacts/owned checkout/isolated TEST PG approval required",
  );
const url = new URL(databaseUrl);
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
  !/test/i.test(url.pathname)
)
  throw Error("loopback TEST database only");
const cp = resolve(connectCheckout),
  out = new URL(
    `../../../target/cloud-copy-http-${process.pid}/`,
    import.meta.url,
  );
mkdirSync(out, { recursive: true });
if (!existsSync(new URL("node_modules", out)))
  symlinkSync(
    resolve(cp, "services/server/node_modules"),
    new URL("node_modules", out),
    "dir",
  );
const mod = (name) =>
  JSON.stringify(resolve(cp, `services/server/src/${name}.ts`));
await build({
  stdin: {
    contents:
      'export * from "./src/app-host/index.ts";export * from "./src/app-host/cloud-copy-bootstrap.ts";export * from "./src/cbor.ts";export { MdbaseClient } from "./src/client.ts";export { inProcessConnector } from "./src/transport/inprocess.ts";export * from "../obsidian-runtime/src/index/appIndexHost.ts";',
    resolveDir: new URL("../", import.meta.url).pathname,
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: new URL("sdk.mjs", out).pathname,
});
await build({
  stdin: {
    contents: `export {openDatabase} from ${mod("db")};export {runControlPlaneMigrations} from ${mod("migrations")};export {tokenHash,randomToken} from ${mod("security")};export {registerConnectorPairingRoutes} from ${mod("features/connectors/pairing-routes")};export {default as cookie} from '@fastify/cookie';export {registerNextDeviceRoutes} from ${mod("features/next/device-routes")};export {registerCloudCopyRoutes} from ${mod("features/next/cloud-copy-bootstrap")};export {registerCollectionLogTokenRoute} from ${mod("features/next/collection-log-token")};export {keyId,certDigest} from ${mod("features/next/policy-wire")};export {LogServiceClient} from ${mod("features/next/log-service-client")};export {PolicyEmitter} from ${mod("features/next/policy-outbox")};export {loadPolicySigner,ed25519RawPublicKey,certToJson} from ${mod("features/next/policy-keys")};export {default as Fastify} from "fastify";`,
    resolveDir: resolve(cp, "services/server"),
  },
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  outfile: new URL("cp.mjs", out).pathname,
});
const sdk = await import(new URL("sdk.mjs", out)),
  c = await import(new URL("cp.mjs", out)),
  wasm = readFileSync(artifact),
  admin = await c.openDatabase(databaseUrl),
  suffix = `${process.pid}_${randomBytes(4).toString("hex")}`,
  schemas = [
    `clients_cloud_cp_test_${suffix}`,
    `clients_cloud_log_test_${suffix}`,
  ];
const schemaUrl = (s) => {
  const u = new URL(databaseUrl);
  u.searchParams.set("options", `-csearch_path=${s}`);
  return u.toString();
};
const root = generateKeyPairSync("ed25519").privateKey,
  policy = generateKeyPairSync("ed25519").privateKey,
  issuer = generateKeyPairSync("ed25519").privateKey,
  transport = generateKeyPairSync("ed25519").privateKey,
  pem = (k) => k.export({ type: "pkcs8", format: "pem" }).toString(),
  hex = (b) => Buffer.from(b).toString("hex"),
  rootPk = c.ed25519RawPublicKey(root),
  policyPk = c.ed25519RawPublicKey(policy);
// TEST pins from independently chosen local test root/leaf BEFORE CP responses.
// Not production roots or an alternative signed-asset authentication mechanism.
const id = async (pk) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", pk)).subarray(0, 16),
  pins = sdk.encode([
    [[await id(rootPk), rootPk]],
    [[await id(policyPk), policyPk, await id(rootPk)]],
  ]);
let pool, app, server;
const ownedSchemas = [],
  actors = [];
try {
  for (const s of schemas) {
    await admin.query(`CREATE SCHEMA ${s}`);
    ownedSchemas.push(s);
  }
  pool = await c.openDatabase(schemaUrl(schemas[0]));
  await c.runControlPlaneMigrations(pool, {
    lock: true,
    directory: resolve(cp, "services/server/migrations"),
  });
  const probe = createServer();
  await new Promise((yes, no) => {
    probe.once("error", no);
    probe.listen(0, "127.0.0.1", yes);
  });
  const port = probe.address().port;
  await new Promise((yes) => probe.close(yes));
  const logOrigin = `http://127.0.0.1:${port}`;
  server = spawn(resolve(logBinary), [], {
    env: {
      ...process.env,
      LOGSVC_LISTEN: `127.0.0.1:${port}`,
      LOGSVC_BACKEND: "pg",
      LOGSVC_PG_URL: schemaUrl(schemas[1]),
      LOGSVC_POOL: "4",
      LOGSVC_OBJECTS_DIR: new URL("objects", out).pathname,
      LOGSVC_PUBLIC_BASE: logOrigin,
      LOGSVC_ROOT_KEYS: hex(rootPk),
      LOGSVC_TOKEN_ISSUERS: hex(c.ed25519RawPublicKey(issuer)),
      LOGSVC_URL_SECRET: randomBytes(32).toString("hex"),
    },
    stdio: "ignore",
  });
  for (let i = 0; ; i++) {
    if (server.exitCode !== null) throw Error("owned native LS exited");
    try {
      assert(
        (
          await fetch(`${logOrigin}/v1/nonce`, {
            signal: AbortSignal.timeout(1000),
          })
        ).ok,
      );
      break;
    } catch {
      if (i >= 40) throw Error("owned native LS not ready");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const cert = {
      policyPublicKey: policyPk,
      notBefore: Date.now() - 60000,
      notAfter: Date.now() + 30 * 86400000,
      root: c.keyId(rootPk),
    },
    next = {
      rootPublicKey: rootPk,
      policyPrivateKeyPem: pem(policy),
      policyCert: c.certToJson({
        ...cert,
        signature: sign(null, c.certDigest(cert), root),
      }),
      serviceTokens: {},
      cloudCopyBootstrap: {
        hosted: {
          url: "https://hosted.fixture",
          token: "public-hosted-fixture",
        },
        escrow: {
          url: "https://escrow.fixture",
          token: "public-escrow-fixture",
        },
      },
      logService: {
        url: logOrigin,
        tokenIssuerKeyPem: pem(issuer),
        transportKeyPem: pem(transport),
      },
    };
  const log = new c.LogServiceClient({...next.logService}),
    emitter = new c.PolicyEmitter(
      pool,
      log,
      c.loadPolicySigner(next, Date.now()),
    );
  app = c.Fastify({ logger: false });
  const installedProbe = process.env.MDBN_CLOUD_COPY_INSTALLED_WEB_PROBE === "1";
  const firstPartyOrigin = "https://lab.tasknotes-app.pages.dev";
  let portalCookie;
  if (installedProbe) {
    await app.register(c.cookie);
    c.registerConnectorPairingRoutes(app, {db: pool, publicUrl: firstPartyOrigin, installationDevices: true, installationEnvironment: "lab"});
    app.addHook("preSerialization", async (request, reply, payload) => {
      // Explicit seeded-session TEST portal actions, never deployed login proof.
      const base = request.url === "/v1/pairing-requests" && reply.statusCode === 201
        ? `/v1/pairing-requests/${request.body.installation.request_id}`
        : request.url.endsWith("/attest") && reply.statusCode === 200 ? request.url.slice(0, -7) : null;
      if (!base) return payload;
      if (!portalCookie) throw Error("owned portal fixture missing");
      const headers = {cookie: portalCookie};
      if (request.url.endsWith("/attest")) {
        const inspected = await app.inject({method: "GET", url: base, headers});
        const fingerprint = inspected.json().pairing?.fingerprint;
        if (typeof fingerprint !== "string") throw Error("owned displayed fingerprint missing");
        const approved = await app.inject({method: "POST", url: `${base}/approve`, headers, payload: {fingerprint}});
        assert.equal(approved.statusCode, 200);
      } else {
        const selected = await app.inject({method: "POST", url: `${base}/select-account`, headers});
        assert.equal(selected.statusCode, 200);
      }
      return payload;
    });
  }
  c.registerNextDeviceRoutes(app, { db: pool, log });
  c.registerCloudCopyRoutes(app, {
    db: pool,
    next,
    emitter,
    log,
    fetchImpl: async (_url, opts) => {
      assert.equal(JSON.parse(opts.body).collection, collection);
      const kind = new URL(_url).hostname.split(".")[0],
        signPk = c.ed25519RawPublicKey(
          generateKeyPairSync("ed25519").privateKey,
        ),
        x = () =>
          createPublicKey(generateKeyPairSync("x25519").privateKey)
            .export({ type: "spki", format: "der" })
            .subarray(-32);
      return Response.json({
        kind,
        device_id: randomUUID(),
        sign_pk: hex(signPk),
        kem_pk: hex(x()),
        noise_pk: hex(x()),
        wrapped_keys: Buffer.from("opaque-owned-service-fixture").toString(
          "base64",
        ),
        kms_key_arn: "arn:fixture:owned-service",
      });
    },
  });
  c.registerCollectionLogTokenRoute(app, { db: pool, log });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const cpOrigin = `http://127.0.0.1:${app.server.address().port}`;
  const accountId = randomUUID(),
    collection = randomUUID();
  await pool.query(
    "INSERT INTO users(id,email,name) VALUES($1,$2,'[test]-clients-cloud-copy')",
    [accountId, `${accountId}@example.test`],
  );
  const trust = {
    schema: "mdbn-app-trust/release/1",
    environment: "test",
    cpOrigin,
    logOrigin,
    assetSha256: "aa".repeat(32),
    source: {
      repository: "mdbase-dev/mdbase-connect",
      commit: "bb".repeat(20),
      version: "0.0.0-test",
    },
    trustedRoots: [rootPk],
    policyPins: pins,
  };
  async function actor(purpose) {
    const connectorId = randomUUID(),
      bearer = `owned-connector-${randomUUID()}`;
    await pool.query(
      "INSERT INTO connectors(id,user_id,name,token_hash,relay_generation) VALUES($1,$2,'[test]-clients-cloud-copy',$3,1)",
      [connectorId, accountId, c.tokenHash(bearer)],
    );
    const session = {
        accountId,
        connectorId,
        deviceId: randomUUID(),
        installationId: randomUUID(),
        collection,
        purpose,
        approvalMode: "password-ak1",
        kind: "app-runtime",
        cpOrigin,
        logOrigin,
        isCurrent: () => true,
        installationOwned: () => true,
        connectorBearer: async () => bearer,
      },
      signal = new AbortController().signal,
      key = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      ),
      encrypted = new Map();
    const io = {
      read: async (ns) => encrypted.get(ns) ?? null,
      create: async (ns, bytes) => {
        if (encrypted.has(ns)) return false;
        encrypted.set(ns, new Uint8Array(bytes));
        return true;
      },
      compareAndSet: async (ns, expected, bytes) => {
        const old = encrypted.get(ns) ?? null;
        if (
          old === null
            ? expected !== null
            : expected === null ||
              !Buffer.from(old).equals(Buffer.from(expected))
        )
          return false;
        encrypted.set(ns, new Uint8Array(bytes));
        return true;
      },
    };
    const noise = new sdk.AppWebNoiseCustody(session, key, io),
      owner = { session, noise, key, io };
    actors.push(owner);
    let rt = await sdk.AppWasmRuntime.createDevice(wasm);
    owner.rt = rt;
    const identity = await new sdk.AppWebDeviceKeyCustody(
      session,
      key,
      io,
    ).openNativeDevice(rt, { signal, mode: "fresh", noise: { mode: "fresh" } });
    await new sdk.AppCpDeviceRegistration(rt, session, identity, noise, {
      allowLoopbackHttp: true,
    }).register({ signal });
    rt.prepareCloudCopyCollection(session);
    let outcome = { state: "none" },
      dropReply = true;
    const persistence = {
      restore: async () => structuredClone(outcome),
      pending: async (operation) => {
        outcome = { state: "pending", operation: structuredClone(operation) };
      },
      completed: async (metadata) => {
        outcome = { state: "completed", metadata: structuredClone(metadata) };
      },
    };
    const reopen = async () => {
      await rt.close();
      const restored = await noise.restore({ signal });
      assert(restored.receipt);
      rt = await sdk.AppWasmRuntime.createDevice(wasm);
      owner.rt = rt;
      const opened = await new sdk.AppWebDeviceKeyCustody(
        session,
        key,
        io,
      ).openNativeDevice(rt, {
        signal,
        mode: "existing",
        noise: { mode: "existing", envelope: restored.envelope },
      });
      assert.deepEqual(opened.signPublicKey, identity.signPublicKey);
      assert.deepEqual(opened.kemPublicKey, identity.kemPublicKey);
      assert.deepEqual(opened.noisePublicKey, identity.noisePublicKey);
      rt.acknowledgeDeviceRegistration(restored.receipt);
      rt.prepareCloudCopyCollection(session);
    };
    const lossy = new sdk.AppCpCloudCopyBootstrap(
      rt,
      session,
      trust,
      persistence,
      {
        allowLoopbackHttp: true,
        fetch: async (url, init) => {
          const r = await fetch(url, init);
          if (!r.ok) {
            const error = await r.clone().json();
            console.error(
              JSON.stringify({
                fixtureRoute: new URL(url).pathname,
                status: r.status,
                publicErrorCode: error.code ?? error.error?.code ?? null,
              }),
            );
          }
          if (
            dropReply &&
            new URL(url).pathname != "/v1/next/devices/challenge"
          ) {
            assert.equal(r.status, 200);
            await r.arrayBuffer();
            dropReply = false;
            throw Error("owned committed cloud-copy reply lost");
          }
          return r;
        },
      },
    );
    await assert.rejects(lossy.bootstrap({ signal }), (e) => {
      if (dropReply)
        throw Error(
          `cloud-copy bootstrap failed before planned loss: ${e.message}`,
        );
      return true;
    });
    assert(!dropReply);
    await reopen();
    let prohibitedHttp = 0;
    await assert.rejects(
      new sdk.AppCpCloudCopyBootstrap(rt, session, trust, persistence, {
        allowLoopbackHttp: true,
        fetch: async () => {
          prohibitedHttp++;
          throw Error("unknown must not auto-replay");
        },
      }).bootstrap({ signal }),
      { reason: "outcome_unknown" },
    );
    assert.equal(prohibitedHttp, 0);
    await reopen();
    owner.metadata = await new sdk.AppCpCloudCopyBootstrap(
      rt,
      session,
      trust,
      persistence,
      { allowLoopbackHttp: true },
    ).bootstrap({ signal, reconcile: "explicit-unknown-outcome" });
    assert.equal(
      hex(await log.controlItemAt(collection, 1)),
      hex(owner.metadata.genesisItem),
    );
    await reopen();
    const restoredBootstrap = new sdk.AppCpCloudCopyBootstrap(
      rt,
      session,
      trust,
      persistence,
      {
        allowLoopbackHttp: true,
        fetch: async () => {
          prohibitedHttp++;
          throw Error("completed must not HTTP");
        },
      },
    );
    const known = await restoredBootstrap.bootstrap({ signal });
    assert.equal(prohibitedHttp, 0);
    assert.equal(known.expectedGenesis, owner.metadata.expectedGenesis);
    const db = new DatabaseSync(":memory:"),
      version = db
        .prepare("SELECT sqlite_version() AS v")
        .get()
        .v.split(".")
        .map(Number);
    owner.db = db;
    owner.turns = 0;
    const backend = {
      needsRecovery: false,
      fence() {
        this.needsRecovery = true;
      },
      run(batch, limits) {
        owner.turns++;
        const tx = batch.mode === "Transaction";
        if (tx) db.exec("BEGIN IMMEDIATE");
        try {
          let rows = 0;
          const results = batch.stmts.map(({ sql, params }) => {
            const s = db.prepare(sql);
            s.setReadBigInts(true);
            const args = params.map((v) =>
                v.kind === "Null" ? null : v.value,
              ),
              names = s.columns().map((c) => c.name);
            if (!names.length) {
              const r = s.run(...args);
              return {
                columns: 0,
                values: [],
                changes: BigInt(r.changes),
                lastInsertRowid: BigInt(r.lastInsertRowid),
              };
            }
            assert(names.length <= limits.maxColumns);
            const values = [];
            for (const row of s.iterate(...args)) {
              assert(++rows <= limits.maxRows);
              for (const name of names) {
                const v = row[name];
                values.push(
                  v === null
                    ? { kind: "Null" }
                    : typeof v === "bigint"
                      ? { kind: "Integer", value: v }
                      : typeof v === "number"
                        ? { kind: "Real", value: v }
                        : typeof v === "string"
                          ? { kind: "Text", value: v }
                          : { kind: "Blob", value: new Uint8Array(v) },
                );
              }
            }
            return {
              columns: names.length,
              values,
              changes: 0n,
              lastInsertRowid: 0n,
            };
          });
          if (tx) db.exec("COMMIT");
          return results;
        } catch (e) {
          if (tx)
            try {
              db.exec("ROLLBACK");
            } catch {}
          this.fence();
          throw e;
        }
      },
    };
    const bridge = new sdk.AppBinaryIndexHost(backend),
      sql = {
        import: (x) => sdk.appSqlHost(bridge, x),
        fence: () => bridge.fence(),
        get needsRecovery() {
          return bridge.needsRecovery;
        },
      };
    restoredBootstrap.adoptCollection(
      {
        signal,
        replicaId: randomUUID(),
        endpoint: 37,
        cloudCopyOptIn: true,
        opened: "fresh",
        sqliteVersion: version[0] * 1000000 + version[1] * 1000 + version[2],
      },
      sql,
    );
    owner.authority = new sdk.AppCpLogAuthority(
      rt,
      { ...session, endpoint: 37, directOrigins: [] },
      { allowLoopbackHttp: true },
    );
    await owner.authority.accessToken({ signal });
    owner.pump = rt.bindLogTransport(owner.authority.logTransport());
    owner.client = await sdk.MdbaseClient.connect({
      app: { name: "owned-cloud-copy-fixture", version: "1" },
      connector: sdk.inProcessConnector(rt, { collection }),
      reconnect: false,
    });
    return owner;
  }
  const creator = await actor("create"),
    joining = await actor("join");
  assert.equal(
    creator.metadata.expectedGenesis,
    joining.metadata.expectedGenesis,
  );
  for (let i = 0; i < 16; i++) {
    for (const a of actors) {
      a.rt.tick();
      await a.pump.pump();
    }
    if (
      actors.every(
        (a) =>
          !a.rt.observations().requiresReopen &&
          a.rt.observations().status.confirmedThrough > 0,
      )
    )
      break;
  }
  for (const a of actors) {
    await a.client.query({ limit: 1 }, undefined, AbortSignal.timeout(5000));
    if (process.env.MDBN_CLOUD_COPY_DESCRIBE_PROBE === "1") {
      const result = await a.client.describe(AbortSignal.timeout(5000));
      assert(Array.isArray(result.types) && Array.isArray(result.contracts));
      // Exact PUBLIC description DTO, not secrets, task data or readiness inferred
      // from status. Populated task/catalog acceptance remains separate.
      console.log(
        JSON.stringify(
          { strictNativeDescribe: true, actor: actors.indexOf(a), result },
          (_k, value) =>
            value instanceof Map
              ? Array.from(value)
              : typeof value === "bigint"
                ? value.toString()
                : value,
        ),
      );
    }
    assert.equal(a.rt.observations().requiresReopen, false);
    assert(a.turns > 0);
    assert(
      !a.db
        .prepare("SELECT k FROM st_meta")
        .all()
        .some((r) => /keyring/i.test(r.k)),
    );
  }
  assert.equal(
    (
      await pool.query(
        "SELECT sync FROM next_collections WHERE collection_id=$1",
        [collection],
      )
    ).rows[0].sync,
    "cloud_copy",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) AS n FROM next_devices WHERE user_id=$1",
        [accountId],
      )
    ).rows[0].n,
    "2",
  );
  if (process.env.MDBN_CLOUD_COPY_WEB_PROBE === "1" || installedProbe) {
    const { runCloudCopyWebFixture } =
      await import("./app-cloud-copy-web-fixture.mjs");
    const browserActors = [];
    if (installedProbe) {
      const secret = c.randomToken("session"); portalCookie = `mdbase_session=${secret}`;
      await pool.query("INSERT INTO sessions(id,user_id,token_hash,provider,account_session_epoch,expires_at) VALUES($1,$2,$3,'password',(SELECT session_epoch FROM users WHERE id=$2),now()+interval '1 hour')", [randomUUID(), accountId, c.tokenHash(secret)]);
      // Public browser aliases route ONLY through the owned test proxy. Keep the
      // already constructed LS client on its actual private loopback endpoint.
      next.logService.url = "https://log.example.test";
    }
    for (let i = 0; i < (installedProbe ? 1 : 2); i++) {
      if (installedProbe) {browserActors.push({accountId, replicaId: randomUUID()}); continue;}
      const connectorId = randomUUID(),
        bearer = `owned-web-connector-${randomUUID()}`;
      await pool.query(
        "INSERT INTO connectors(id,user_id,name,token_hash,relay_generation) VALUES($1,$2,'[test]-clients-cloud-web',$3,1)",
        [connectorId, accountId, c.tokenHash(bearer)],
      );
      browserActors.push({
        accountId,
        connectorId,
        bearer,
        deviceId: randomUUID(),
        installationId: randomUUID(),
        replicaId: randomUUID(),
      });
    }
    await runCloudCopyWebFixture({
      artifact,
      cpOrigin,
      logOrigin,
      trust: installedProbe ? {...trust, environment: "lab", cpOrigin: firstPartyOrigin, logOrigin: next.logService.url, assetSha256: createHash("sha256").update(wasm).digest("hex")} : trust,
      collection,
      actors: browserActors,
      installationSignIn: installedProbe,
      playwrightModule: process.env.PLAYWRIGHT_MODULE,
      sqliteWasmDist: process.env.SQLITE_WASM_DIST,
    });
  }
  console.log(
    JSON.stringify({
      actualCpAuth: true,
      actualCloudCopyCreateJoin: true,
      actualNativeOriginalFixedDomains: true,
      actualPgNativeLs: true,
      originalEncryptedSignKemNoisePreserved: true,
      committedReplyLost: true,
      noAutomaticUnknownReplay: true,
      explicitOriginalReconciliation: true,
      confirmedCompletionBeforeHttp: true,
      actualNativeSqlAdoption: true,
      nativeQueryReadGates: true,
      strictNativeDescribeQualified:
        process.env.MDBN_CLOUD_COPY_DESCRIBE_PROBE === "1",
      describeContractsQualified: false, // populated application catalog not exercised
      ramOnlyKeyring: true,
      actors: actors.length,
      sqlTurns: actors.map((a) => a.turns),
      persistentWebCustodyQualified: false,
      authenticatedHostProducerQualified: false,
      productionReleaseQualified: false,
      serviceKmsQualified: false,
      taskSavedQualified: false,
      physicalDurabilityQualified: false,
      labAccess: false,
    }),
  );
} finally {
  for (const a of actors) {
    a.client?.close();
    await a.pump?.close();
    a.authority?.close();
    await a.rt?.close();
    a.db?.close();
  }
  await app?.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((r) => {
      const timer = setTimeout(() => {
        server.kill("SIGKILL");
        r();
      }, 3000);
      server.once("exit", () => {
        clearTimeout(timer);
        r();
      });
    });
  }
  await pool?.end();
  for (const s of ownedSchemas.reverse())
    await admin.query(`DROP SCHEMA ${s} CASCADE`);
  await admin.end();
}
