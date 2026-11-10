#!/usr/bin/env node
/** LOCAL TEST: the whole Private device path of a first-party app, end to end,
 * on one loopback stack. Nothing here is LAB, staging or production, and no
 * installed daemon, account or managed artifact is used or changed.
 *
 *   node runtime/packages/sdk/scripts/app-private-device-local-e2e.mjs
 *
 * Options: `--rebuild` rebuilds the cargo artifacts; `--keep` keeps the run's
 * scratch directory and logs. Environment: `PLAYWRIGHT_MODULE` (a Playwright
 * `index.mjs` with Chromium installed; default as the browser smokes),
 * `MDBASE_E2E_CARGO` (`cargo`, or `rcargo` to build on the build VM). Needs
 * Docker (one disposable PostgreSQL container, removed at the end) and, for the
 * desktop's keychain, `dbus-daemon`, `gnome-keyring-daemon`, `gdbus` and
 * `secret-tool`.
 *
 * THE REAL CODE PATH
 * - Connect: the server's own entry (`services/server/src/index.ts`, bundled with
 *   the local build literal as `build:local` does), its migrations and every
 *   route, on PostgreSQL, started from environment variables alone with
 *   MDBASE_NEXT_PRIVATE_BOOTSTRAP=1 and, for the second half of the run,
 *   MDBASE_NEXT_PRIVATE_APP_DEVICES=1 (the server is restarted for that, as an
 *   operator would).
 * - The log service: the native `mdbn-log-server` binary (memory backend), with
 *   the stack's root key and token issuer.
 * - The desktop: the real `mdbase` CLI and daemon (`local-rehearsal` artifact, the
 *   product's own way to trust one local stack) in an isolated profile.
 * - The app: Chromium, the SDK's local application build of the current source
 *   (`createMdbase`, the application Worker, SQLite on OPFS, WebCrypto custody)
 *   and the real `app-runtime` WASM, declaring `offline.replica` as optional.
 *   Sign-in is a real click; registration, pairing, attestation, exchange, the
 *   listing, enrolment, the account-key unlock and the log traffic are the
 *   product's own requests.
 *
 * FIXTURES (each is the smallest stand-in, and none of them is authority)
 * - Identity: the server's development sign-in (`POST /v1/dev/session`,
 *   MDBASE_CONNECT_DEV_AUTH=1) creates the one throwaway account. That route
 *   leaves it on the legacy backend, so the test then runs the server's own
 *   `provisionNewAccountBackend` on the disposable database, which is what
 *   every real sign-up does for a new account.
 * - The portal: its application is not built or run. The test performs the
 *   portal's requests on the real routes with that session cookie (choose the
 *   account, read the request, approve with the shown fingerprint and the
 *   chosen collections). PORTAL_DIST names a one-file stand-in page, so the
 *   approval window the SDK opens gets the real server's own reply for
 *   `/pair/<id>`, including the opener policy it sets for approval pages
 *   (without it the app sees its window as closed and ends the sign-in).
 * - Trust: a throwaway root, policy key and log-token issuer made for this
 *   checkout (see app-private-device-local-stack.mjs).
 * - Two recording loopback fronts on the stack's two pinned origins. The one for
 *   Connect only forwards and records (it is how the test reads receipts,
 *   listings and refusals). The one for the log service also adds the CORS
 *   headers the deployed Worker adds (runtime/deploy/cloudflare-do/src/cors.rs);
 *   the native binary has none. Both refuse WebSocket compression so that
 *   recorded frames are the protocol's own bytes.
 * - Cloud copy: MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP=1 is set because the
 *   installation's collection listing is mounted with those routes; the hosted
 *   and escrow service URLs point at closed ports. The one cloud copy is a
 *   stand-in: the three control-plane rows the server's own PostgreSQL test
 *   seeds (collection, first policy batch, owner membership), with no hosted
 *   peer behind it. It can be offered, approved and listed, not opened. The
 *   negative leg therefore asserts sign-in and an unchanged listing, not an
 *   opened cloud copy.
 * - "An installation without the scope" on the proof-carrying routes: an
 *   installation cannot sign a proof for a collection it was never offered, so
 *   a signed-in installation's own consent row is deleted in the disposable
 *   database at the moment its real, correctly signed request is forwarded
 *   (and restored afterwards). The status route needs no proof and is also
 *   called with the credential of an installation that never had the scope.
 * - Key management: the daemon keeps an account key only in the OS keychain
 *   (it refuses the test file backend), so the desktop gets a real but
 *   throwaway one: `gnome-keyring-daemon` on a private D-Bus session bus with
 *   private XDG directories, the recipe of mdbase-cloud-ops
 *   `bin/with-release-keyring`. The person's own session bus and keyring are
 *   never contacted. The browser uses its own WebCrypto and IndexedDB in a
 *   throwaway Chromium profile. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { startHostedPostgres } from "../../../../scripts/lib/hosted-postgres-container.mjs";
import { availableTcpPort, delay, poll } from "../../../../scripts/lib/test-runtime.mjs";
import { bundleLocalServer, checkout, e2eRoot, ensureAppRuntime, ensureDesktop, ensureLocalSdk, ensureStack, ensureTools, runtimeRoot } from "./app-private-device-local-stack.mjs";

/** The app: nothing but the SDK's front door. The test drives it through
 * `window.e2e`; the sign-in button is clicked like any button. */
const PAGE = `
import { createMdbase } from SDK_INDEX;
try {
  const config = await (await fetch("/e2e-config.json", { cache: "no-store" })).json();
  const mdbase = createMdbase(config.declaration);
  const problem = p => p ? { key: p.key, code: p.code } : null;
  const view = () => {
    const s = mdbase.getSnapshot(), p = s.phase;
    return {
      phase: { kind: p.kind, collectionId: p.collectionId ?? null, problem: problem(p.problem ?? p.notice ?? null),
        ...(p.kind === "needs_unlock" ? { mode: p.mode, unlocking: p.unlocking } : {}),
        ...(p.kind === "choosing" ? { lastApproval: p.lastApproval ? { outcome: p.lastApproval.outcome } : null } : {}),
        ...(p.kind === "authorizing" ? { purpose: p.purpose } : {}) },
      status: s.status, problemCode: s.problem ?? null, selectedCollectionId: s.selectedCollectionId ?? null,
      collections: s.collections.map(c => ({ collectionId: c.collectionId, displayName: c.displayName, role: c.role, mode: c.mode ?? null, kind: c.kind ?? null })),
    };
  };
  const history = [];
  const note = () => { const line = JSON.stringify(view().phase); if (history[history.length - 1] !== line) history.push(line); };
  mdbase.subscribe(note); note();
  const failure = e => ({ name: e?.name ?? null, message: String(e?.message ?? e), code: e?.code ?? null, reason: e?.reason ?? null });
  const records = id => { const c = mdbase.connection(id); if (!c) throw Error("no connection for " + id); return c.records; };
  let signIn = null;
  document.getElementById("sign-in").addEventListener("click", () => { signIn = mdbase.signIn().then(() => ({ ok: true }), e => ({ ok: false, error: failure(e) })); });
  window.e2e = {
    view, history: () => history.map(line => JSON.parse(line)), signedIn: () => signIn,
    async settle(kinds, ms) {
      const until = Date.now() + ms;
      for (;;) {
        const v = view();
        if (kinds.includes(v.phase.kind) && v.phase.unlocking !== true) return v;
        if (Date.now() > until) throw Error("still " + JSON.stringify(v.phase) + " after " + ms + " ms; history " + JSON.stringify(history));
        await new Promise(next => setTimeout(next, 50));
      }
    },
    start: async () => { await mdbase.start(); return view(); },
    select: async id => { try { await mdbase.select(id); } catch (e) { return { ...view(), error: failure(e) }; } return view(); },
    unlock: async (id, secret) => { try { await mdbase.unlock(id, secret); } catch (e) { return { ...view(), error: failure(e) }; } return view(); },
    read: async (id, path) => { const r = await records(id).get({ path }, { document: true }); return { id: r.id, path: r.path, document: r.document }; },
    create: async (id, input) => { const w = await records(id).create(input); return { recordId: w.recordId }; },
    close: () => mdbase.close(),
  };
  window.e2eReady = true;
} catch (error) { window.e2eFailed = String(error?.stack ?? error); }
`;

const flags = new Set(process.argv.slice(2));
for (const flag of flags) if (!["--rebuild", "--keep"].includes(flag)) throw Error(`unknown option ${flag}`);
const rebuild = flags.has("--rebuild"), keep = flags.has("--keep");
const step = name => console.log(`ok - ${name}`);
const section = name => console.log(`\n== ${name}`);
const hex = bytes => Buffer.from(bytes).toString("hex");
const uuidBytes = id => Buffer.from(id.replaceAll("-", ""), "hex");

// ---------------------------------------------------------------- build inputs
section("build inputs");
const server = await bundleLocalServer();
const stack = ensureStack(server.keys);
const tools = ensureTools(rebuild);
const runtimeWasm = ensureAppRuntime(rebuild);
const desktopBinary = ensureDesktop(stack, tools.verifier, rebuild);
const sdkLocal = ensureLocalSdk(stack, tools.verifier, runtimeWasm);
const playwrightModule = process.env.PLAYWRIGHT_MODULE ?? join(runtimeRoot, "tools/browser-smokes/node_modules/playwright/index.mjs");
if (!existsSync(playwrightModule)) throw Error(`Playwright not found at ${playwrightModule}; set PLAYWRIGHT_MODULE or install runtime/tools/browser-smokes`);
const { chromium } = await import(pathToFileURL(playwrightModule).href);
const connectOrigin = stack.config.connectOrigin, logOrigin = stack.config.logOrigin;
step(`local stack ${connectOrigin} (Connect), ${logOrigin} (log service)`);

// --------------------------------------------------------------------- the run
const run = join(e2eRoot, "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`);
mkdirSync(run, { recursive: true });
// Short: the daemon's Unix sockets live under its state directory.
const scratch = await mkdtemp(join(tmpdir(), "mdpd-"));
const cleanup = [];
const children = [];
const nonce = randomBytes(6).toString("hex");
const password = `e2e ${randomBytes(9).toString("base64url")} lantern orchard`;
const wrongPassword = `e2e ${randomBytes(9).toString("base64url")} lantern meadow`;
const desktopMarker = `desktop-wrote-${nonce}`, appMarker = `app-wrote-${nonce}`;
const desktopPath = `tasks/desk-${nonce}.md`, appPath = `tasks/app-${nonce}.md`;

function child(name, command, args, env, options = {}) {
  const log = createWriteStream(join(run, `${name}.log`), { flags: "a" });
  const process_ = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], ...options });
  process_.stdout.pipe(log, { end: false }); process_.stderr.pipe(log, { end: false });
  const entry = { name, process: process_, exited: new Promise(done => process_.once("exit", (code, signal) => done(code ?? signal))) };
  children.push(entry);
  return entry;
}
async function stop(entry, signal = "SIGTERM") {
  if (entry.process.exitCode === null && entry.process.signalCode === null) entry.process.kill(signal);
  await Promise.race([entry.exited, delay(10_000).then(() => entry.process.kill("SIGKILL"))]);
}
async function portFree(origin) {
  const port = Number(new URL(origin).port);
  await new Promise((free, busy) => {
    const probe = createServer();
    probe.once("error", () => busy(Error(`${origin} is in use; the local stack needs its pinned port (stop the other run, or delete ${stack.directory} for a new identity and rebuild)`)));
    probe.listen(port, "127.0.0.1", () => probe.close(free));
  });
  return port;
}

/** A recording loopback front for one pinned origin. HTTP bodies are kept
 * whole; WebSocket frames are unmasked and kept per direction. `hold` runs
 * before a request is forwarded (the test's only way to order its database
 * fixture against a request the app makes itself). */
function front({ port, target, cors, hold }) {
  const exchanges = [], streams = [], sockets = new Set();
  const allow = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, PUT",
    "access-control-allow-headers": "authorization, content-type, x-mdbase-nonce, x-mdbase-sig, range, x-amz-checksum-sha256",
    "access-control-expose-headers": "content-length, content-range, etag, x-amz-checksum-sha256, x-mdbase-next-nonce" };
  const listener = createServer((request, response) => {
    const parts = [];
    request.on("data", part => parts.push(part));
    request.on("end", async () => {
      const exchange = { method: request.method, path: request.url, headers: request.headers, body: Buffer.concat(parts), status: null, reply: null, at: Date.now() };
      if (cors && request.method === "OPTIONS") { response.writeHead(204, { ...allow, "access-control-max-age": "7200" }); response.end(); return; }
      try { await hold?.(exchange); } catch (error) { response.writeHead(599); response.end(String(error)); return; }
      exchanges.push(exchange);
      const headers = { ...request.headers }; delete headers["accept-encoding"];
      const upstream = httpRequest({ host: "127.0.0.1", port: target, method: request.method, path: request.url, headers }, reply => {
        const received = [];
        response.writeHead(reply.statusCode, { ...reply.headers, ...(cors ? allow : {}) });
        reply.on("data", part => { received.push(part); response.write(part); });
        reply.on("end", () => { exchange.reply = Buffer.concat(received); exchange.status = reply.statusCode; response.end(); });
        reply.on("error", () => response.destroy());
      });
      upstream.on("error", () => { exchange.status = 502; exchange.reply = Buffer.alloc(0); if (!response.headersSent) response.writeHead(502); response.end(); });
      upstream.end(exchange.body);
    });
  });
  const frames = (sink, skipHead) => {
    let pending = Buffer.alloc(0), head = skipHead;
    return part => {
      pending = Buffer.concat([pending, part]);
      if (head) { const end = pending.indexOf("\r\n\r\n"); if (end < 0) return; pending = pending.subarray(end + 4); head = false; }
      for (;;) {
        if (pending.length < 2) return;
        let length = pending[1] & 0x7f, offset = 2; const masked = (pending[1] & 0x80) !== 0;
        if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (pending.length < 10) return; length = Number(pending.readBigUInt64BE(2)); offset = 10; }
        const key = masked ? pending.subarray(offset, offset + 4) : null; if (masked) offset += 4;
        if (pending.length < offset + length) return;
        const payload = Buffer.from(pending.subarray(offset, offset + length));
        if (key) for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
        // Data frames only; RSV1 would be a compressed message.
        if ((pending[0] & 0x0f) <= 2) sink(payload, (pending[0] & 0x40) !== 0);
        pending = pending.subarray(offset + length);
      }
    };
  };
  listener.on("upgrade", (request, socket, first) => {
    const stream = { path: request.url, origin: request.headers.origin ?? null, sent: [], received: [], compressed: false };
    streams.push(stream);
    const upstream = connect(target, "127.0.0.1", () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i].toLowerCase() !== "sec-websocket-extensions") lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      const sent = frames((payload, rsv1) => { stream.sent.push(payload); stream.compressed ||= rsv1; }, false);
      const received = frames((payload, rsv1) => { stream.received.push(payload); stream.compressed ||= rsv1; }, true);
      if (first.length) { sent(first); upstream.write(first); }
      socket.on("data", part => { sent(part); upstream.write(part); });
      upstream.on("data", part => { received(part); socket.write(part); });
      socket.on("close", () => upstream.destroy()); upstream.on("close", () => socket.destroy());
    });
    socket.on("error", () => upstream.destroy()); upstream.on("error", () => socket.destroy());
  });
  listener.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  return { exchanges, streams, listen: () => new Promise((ready, failed) => { listener.once("error", failed); listener.listen(port, "127.0.0.1", ready); }),
    close: () => new Promise(done => { listener.close(() => done()); for (const socket of sockets) socket.destroy(); }) };
}
const json = exchange => { try { return JSON.parse(exchange.reply.toString("utf8")); } catch { return null; } };
const bearer = exchange => /^Bearer (.+)$/.exec(exchange.headers.authorization ?? "")?.[1] ?? null;
const pathOf = exchange => exchange.path.split("?")[0];

let pg, postgres, connect_, log, hold = null;
let failed = false;
try {
  // ------------------------------------------------------------ the local stack
  section("local stack");
  const connectPort = await portFree(connectOrigin), logPort = await portFree(logOrigin);
  postgres = await startHostedPostgres("private-device-e2e");
  cleanup.push(() => postgres.stop());
  await postgres.createDatabase("private_device_e2e_test");
  const databaseUrl = postgres.databaseUrl("private_device_e2e_test");
  step(`disposable PostgreSQL container ${postgres.container}`);

  const logInner = await availableTcpPort(), connectInner = await availableTcpPort();
  const logServer = child("log-service", tools.log, ["--listen", `127.0.0.1:${logInner}`, "--backend", "mem", "--public-base", logOrigin],
    { PATH: process.env.PATH, ...stack.logEnv });
  log = front({ port: logPort, target: logInner, cors: true }); await log.listen(); cleanup.push(() => log.close());
  await poll(async () => (await fetch(`${logOrigin}/health`)).ok, "the log service never answered", 100, 100);
  step("native log service (memory backend) behind its recording front");

  // Outbound cloud-copy service settings the listing route's mount requires; nothing listens there.
  const token = () => randomBytes(24).toString("hex");
  const serverEnv = { PATH: process.env.PATH, ...stack.serverEnv, PORT: String(connectInner), DATABASE_URL: databaseUrl,
    MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP: "1", MDBASE_NEXT_HOSTED_SERVICE_URL: "http://127.0.0.1:9", MDBASE_NEXT_ESCROW_SERVICE_URL: "http://127.0.0.1:9",
    MDBASE_NEXT_HOSTED_SERVICE_TOKEN: token(), MDBASE_NEXT_ESCROW_SERVICE_TOKEN: token(), MDBASE_NEXT_HOSTED_INTERNAL_TOKEN: token(), MDBASE_NEXT_ESCROW_INTERNAL_TOKEN: token() };
  // The stand-in for the portal build: one inert page, served by the real server's approval-page rule.
  const portalDist = join(run, "portal"); mkdirSync(portalDist, { recursive: true });
  writeFileSync(join(portalDist, "index.html"), '<!doctype html><meta charset="utf-8"><title>Portal stand-in</title><p>Portal stand-in: the test performs the portal\'s requests.</p>');
  serverEnv.PORTAL_DIST = portalDist;
  connect_ = front({ port: connectPort, target: connectInner, cors: false, hold: exchange => hold?.(exchange) }); await connect_.listen(); cleanup.push(() => connect_.close());
  let connectServer = null, boots = 0;
  async function bootConnect(appDevices) {
    if (connectServer) await stop(connectServer);
    connectServer = child(`connect-${++boots}`, process.execPath, [server.entry], { ...serverEnv, ...(appDevices ? { MDBASE_NEXT_PRIVATE_APP_DEVICES: "1" } : {}) });
    const exited = connectServer.exited.then(code => { throw Error(`the Connect server exited (${code}); see ${join(run, `connect-${boots}.log`)}`); });
    exited.catch(() => {});
    await Promise.race([exited, poll(async () => (await fetch(`${connectOrigin}/health`)).ok, "the Connect server never answered", 300, 100)]);
  }
  await bootConnect(false);
  step("Connect server (own entry, PostgreSQL, private bootstrap, app devices OFF)");

  const require_ = createRequire(join(checkout, "services/server/package.json"));
  pg = new (require_("pg").Pool)({ connectionString: databaseUrl, max: 2 });
  cleanup.push(() => pg.end());
  const rows = async (text, values = []) => (await pg.query(text, values)).rows;

  // ---------------------------------------------------- the account (dev sign-in)
  const session = await fetch(`${connectOrigin}/v1/dev/session`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Private device e2e", email: `private-device-${nonce}@example.test` }) });
  const cookie = session.headers.get("set-cookie")?.split(";")[0];
  if (!session.ok || !cookie) throw Error(`development sign-in failed (${session.status})`);
  // The development route leaves the account on the legacy backend. Every real
  // sign-up runs this same server function for a new account (MDBASE_NEW_ACCOUNT_BACKEND=next).
  const accountId = (await session.json()).user.id, writer = await pg.connect();
  try { await writer.query("BEGIN"); await server.keys.provisionNewAccountBackend(writer, accountId, "next"); await writer.query("COMMIT"); }
  catch (error) { await writer.query("ROLLBACK").catch(() => {}); throw error; } finally { writer.release(); }
  /** The portal's own requests, on the real routes, as the signed-in person. */
  const portal = async (method, path, body) => {
    const reply = await fetch(`${connectOrigin}${path}`, { method, headers: { cookie, origin: connectOrigin, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await reply.text(); let value = null; try { value = JSON.parse(text); } catch { /* not JSON */ }
    return { status: reply.status, value, text };
  };

  // ------------------------------------------------------- step 1: the desktop
  section("1. the desktop creates a Private collection, sets the account key and writes a record");
  const state = join(scratch, "s"), folder = join(scratch, "notes"), home = join(scratch, "h");
  await mkdir(home, { recursive: true });
  // Nothing of the person's desktop session is inherited: its own HOME, XDG
  // directories and session bus, and on that bus its own keychain.
  const bus = `unix:path=${join(scratch, "bus")}`;
  const desktopEnv = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"),
    XDG_RUNTIME_DIR: join(home, "run"), DBUS_SESSION_BUS_ADDRESS: bus, LANG: "C.UTF-8", MDBASE_CONNECT_HOME: join(scratch, "no-connect"), MDBASE_HOME: state };
  for (const directory of [desktopEnv.XDG_CONFIG_HOME, desktopEnv.XDG_DATA_HOME, desktopEnv.XDG_STATE_HOME, desktopEnv.XDG_RUNTIME_DIR]) await mkdir(directory, { recursive: true, mode: 0o700 });
  const tool = (command, args, input) => new Promise((done, refused) => {
    const process_ = spawn(command, args, { env: desktopEnv, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = ""; process_.stdout.on("data", part => { out += part; }); process_.stderr.on("data", part => { err += part; });
    process_.once("error", refused);
    process_.once("exit", code => code === 0 ? done(out) : refused(Error(`${command} ${args.join(" ")} failed (${code}): ${err}`)));
    process_.stdin.end(input ?? "");
  });
  child("desktop-bus", "dbus-daemon", ["--session", "--nofork", `--address=${bus}`], desktopEnv);
  await poll(() => existsSync(join(scratch, "bus")), "the private session bus never started", 100, 50);
  const keyring = child("desktop-keyring", "gnome-keyring-daemon", ["--foreground", "--unlock", "--components=secrets"], desktopEnv, { stdio: ["pipe", "pipe", "pipe"] });
  keyring.process.stdin.end(randomBytes(32).toString("hex"));
  await tool("gdbus", ["wait", "--session", "--timeout", "14", "org.freedesktop.secrets"]);
  // A storage probe only (never a credential), as with-release-keyring does before any pairing.
  await tool("secret-tool", ["store", "--label=[test] private device e2e keychain probe", "service", "dev.mdbase.e2e.keychain-probe"], "keychain-probe");
  assert.equal(await tool("secret-tool", ["lookup", "service", "dev.mdbase.e2e.keychain-probe"]), "keychain-probe");
  await tool("secret-tool", ["clear", "service", "dev.mdbase.e2e.keychain-probe"]);
  step("throwaway OS keychain on a private session bus");
  /** The real CLI as its own process; a secret goes in on stdin, never as an argument. */
  const mdbase = (args, input) => new Promise((done, refused) => {
    const cli = spawn(desktopBinary, ["--state-dir", state, "--json", ...args], { env: desktopEnv, cwd: scratch, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = ""; cli.stdout.on("data", part => { out += part; }); cli.stderr.on("data", part => { err += part; });
    cli.once("error", refused);
    cli.once("exit", code => {
      if (code === 0) { try { done(out.trim() ? JSON.parse(out) : null); } catch { refused(Error(`mdbase ${args.join(" ")}: unreadable output:\n${out}`)); } return; }
      const error = Error(`mdbase ${args.join(" ")} failed (${code}):\n${out}${err}`); error.stdout = out; refused(error);
    });
    cli.stdin.end(input === undefined ? "" : `${input}\n`);
  });
  await mkdir(join(folder, "_types"), { recursive: true }); await mkdir(join(folder, "tasks"));
  await writeFile(join(folder, "mdbase.yaml"), 'spec_version: "0.3.0"\nname: Private notes\n');
  await writeFile(join(folder, "_types", "task.md"), ["---", "kind: mdbase.type", "name: task", "version: 1", "schema:", "  dialect: json-schema-2020-12", "  value:",
    "    type: object", "    required: [title, status]", "    properties:", "      title: { type: string }", "      status: { type: string, enum: [open, done] }", "---", ""].join("\n"));
  await writeFile(join(folder, "tasks", "a.md"), "---\ntype: task\ntitle: Seed\nstatus: open\n---\nSeed.\n");
  const daemon = child("desktop-daemon", desktopBinary, ["--state-dir", state, "daemon", "run"], desktopEnv, { cwd: scratch });
  cleanup.push(async () => { await mdbase(["daemon", "stop"]).catch(() => {}); await stop(daemon); });
  const daemonGone = daemon.exited.then(code => { throw Error(`the desktop daemon exited (${code}); see ${join(run, "desktop-daemon.log")}`); });
  daemonGone.catch(() => {});
  await Promise.race([daemonGone, poll(async () => (await mdbase(["daemon", "status"])).readiness.ready, "the desktop daemon never became ready", 200, 100)]);
  const signIn = await mdbase(["account", "sign-in", "--server", connectOrigin]);
  const desktopPairing = new URL(signIn.verification_uri).pathname.split("/").pop();
  const approvedDesktop = await portal("POST", `/v1/pairing-requests/${desktopPairing}/approve`, {});
  if (approvedDesktop.status !== 200) throw Error(`the desktop's sign-in was not approved (${approvedDesktop.status}): ${approvedDesktop.text}`);
  await poll(async () => {
    const { account } = await mdbase(["status"]);
    if (account.last_error && !account.pairing) throw Error(`desktop sign-in failed: ${JSON.stringify(account.last_error)}`);
    return account.signed_in && !account.pairing;
  }, "the desktop never finished signing in", 300, 100);
  step("desktop daemon (real mdbase, isolated profile) signed in to the local Connect");
  const added = await mdbase(["collection", "add", folder, "--name", "Private notes"]);
  await poll(async () => (await mdbase(["collection", "list"])).some(c => c.id === added.id && c.state === "ready"), "the collection never became ready", 300, 100);
  const collectionId = added.id;
  const enabled = await mdbase(["sync", "enable", collectionId, "--mode", "private"]);
  console.log(`   sync enable: ${JSON.stringify(enabled)}`);
  await poll(async () => (await rows("SELECT sync FROM next_collections WHERE collection_id=$1", [collectionId]))[0]?.sync === "private", "Connect never recorded the Private collection", 300, 100);
  const recorded = (await rows("SELECT * FROM next_collections WHERE collection_id=$1", [collectionId]))[0];
  console.log(`   next_collections row: ${JSON.stringify(recorded)}`);
  const setup = await mdbase(["private", "setup"], password);
  const recoveryKey = setup.recovery_key;
  assert.equal(typeof recoveryKey, "string", "private setup returns the recovery key once");
  console.log(`   private setup: ${JSON.stringify({ ...setup, recovery_key: "(kept)" })}`);
  console.log(`   private status: ${JSON.stringify(await mdbase(["private", "status"]))}`);
  await mdbase(["create", "--path", desktopPath, "--type", "task", "--fields", JSON.stringify({ title: desktopMarker, status: "open" }), "-C", folder]);
  assert.match(readFileSync(join(folder, desktopPath), "utf8"), new RegExp(desktopMarker));
  step(`Private collection ${collectionId}, account key set with an encryption password, record ${desktopPath} written`);
  // ------------------------------------------------------------------ the app
  section("the app (Chromium, the SDK's local application build, real app-runtime WASM)");
  const appPort = await availableTcpPort(), appOrigin = `http://127.0.0.1:${appPort}`;
  const manifest = { manifest_version: 1, id: "dev.mdbase.e2e.private-device", name: "Private device e2e", homepage: appOrigin, redirect_uris: [`${appOrigin}/callback`],
    requirements: { access: "full_collection", contracts: [], capabilities: { contract_version: 2, required: ["collection.read", "records.create", "records.edit"], optional: ["offline.replica"] } } };
  const declaration = { id: "private-device-e2e", name: "Private device e2e", origin: appOrigin, environment: "local", manifest };
  const appDirectory = join(run, "app"); mkdirSync(appDirectory);
  writeFileSync(join(appDirectory, "page.mjs"), PAGE.replace("SDK_INDEX", JSON.stringify(join(sdkLocal, "dist/index.js"))));
  // Served beside the SDK's own modules, so `./worker.js` and `../native/*` resolve as they do for a bundling app.
  await build({ entryPoints: [join(appDirectory, "page.mjs")], outfile: join(appDirectory, "e2e-page.js"), bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "error" });
  const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".map": "application/json", ".html": "text/html" };
  const sdkDist = join(sdkLocal, "dist");
  const appServer = createServer((request, response) => {
    const path = new URL(request.url, appOrigin).pathname;
    const send = (file, type) => { response.writeHead(200, { "content-type": type, "cache-control": "no-store" }); createReadStream(file).pipe(response); };
    if (path === "/" || path === "/callback") { response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      response.end('<!doctype html><meta charset="utf-8"><title>Private device e2e</title><button id="sign-in">Sign in</button><script type="module" src="/sdk/application/e2e-page.js"></script>'); return; }
    if (path === "/e2e-config.json") { response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify({ declaration })); return; }
    if (path === "/sdk/application/e2e-page.js") return send(join(appDirectory, "e2e-page.js"), "text/javascript");
    if (path.startsWith("/sdk/")) {
      const file = normalize(join(sdkDist, path.slice(5)));
      if (file.startsWith(sdkDist + sep) && existsSync(file) && statSync(file).isFile()) return send(file, types[extname(file)] ?? "application/octet-stream");
    }
    response.writeHead(404); response.end();
  });
  await new Promise((ready, refused) => { appServer.once("error", refused); appServer.listen(appPort, "127.0.0.1", ready); });
  cleanup.push(() => new Promise(done => { appServer.closeAllConnections(); appServer.close(done); }));
  const browsers = new Set();
  cleanup.push(async () => { for (const context of browsers) await context.close().catch(() => {}); });
  /** One Chromium profile is one installation of the app. */
  async function open(profile) {
    const context = await chromium.launchPersistentContext(join(run, "profiles", profile), { headless: true });
    browsers.add(context);
    const page = context.pages()[0] ?? await context.newPage();
    const browserLog = createWriteStream(join(run, `browser-${profile}.log`), { flags: "a" });
    page.on("console", message => browserLog.write(`${message.type()}: ${message.text()}\n`));
    page.on("pageerror", error => browserLog.write(`pageerror: ${error?.stack ?? error}\n`));
    await page.goto(`${appOrigin}/`);
    await page.waitForFunction(() => window.e2eReady === true || typeof window.e2eFailed === "string", null, { timeout: 60_000 });
    const broken = await page.evaluate(() => window.e2eFailed ?? null);
    if (broken) throw Error(`the app page failed to load: ${broken}`);
    return { context, page, profile, close: async () => { browsers.delete(context); await context.close(); } };
  }
  const app = (browser, method, ...args) => browser.page.evaluate(([name, values]) => window.e2e[name](...values), [method, args]);
  const settle = (browser, kinds, ms = 120_000) => app(browser, "settle", kinds, ms);
  const since = (from, test) => connect_.exchanges.slice(from).filter(exchange => exchange.status !== null && test(exchange));
  const awaitExchange = (from, test, what) => poll(() => since(from, test).at(-1) ?? null, `${what} was never seen`, 600, 100);

  /** Sign the installation in. The click is the person's; `choose` is the
   * person's decision in the portal, made from what the portal would show. */
  async function signInApp(browser, choose) {
    const from = connect_.exchanges.length;
    await app(browser, "start");
    const [popup] = await Promise.all([browser.context.waitForEvent("page", { timeout: 60_000 }), browser.page.click("#sign-in")]);
    await popup.waitForURL(url => url.pathname.startsWith("/pair/"), { timeout: 60_000 });
    const pairingId = new URL(popup.url()).pathname.split("/").pop();
    const selected = await portal("POST", `/v1/pairing-requests/${pairingId}/select-account`);
    assert.equal(selected.status, 200, `select-account: ${selected.text}`);
    const shown = await poll(async () => {
      const reply = await portal("GET", `/v1/pairing-requests/${pairingId}`);
      return typeof reply.value?.pairing?.fingerprint === "string" ? reply.value.pairing : null;
    }, "the app never attested its device", 600, 100);
    const approval = await portal("POST", `/v1/pairing-requests/${pairingId}/approve`, { fingerprint: shown.fingerprint, ...choose(shown) });
    assert.equal(approval.status, 200, `approve: ${approval.text}`);
    const outcome = await browser.page.evaluate(() => window.e2e.signedIn());
    assert.deepEqual(outcome, { ok: true }, "the app's signIn() resolved");
    const exchanged = await awaitExchange(from, exchange => exchange.method === "POST" && pathOf(exchange) === `/v1/pairing-requests/${pairingId}/exchange` && typeof json(exchange)?.token === "string", "the credential exchange")
      .catch(async error => { throw Error(`${error.message}; the app shows ${JSON.stringify(await app(browser, "view").catch(() => null))}`); });
    const receipt = json(exchanged);
    const connectorId = (await rows("SELECT connector_id FROM installation_device_pairings WHERE pairing_id=$1", [pairingId]))[0].connector_id;
    const view = await settle(browser, ["choosing", "ready", "needs_unlock", "needs_setup", "opening", "problem", "signed_out"]);
    return { from, pairingId, shown, approval: approval.value, receipt, token: receipt.token, connectorId, view };
  }
  const listing = (from, token_) => awaitExchange(from, exchange => exchange.method === "GET" && pathOf(exchange) === "/v1/next/collections" && bearer(exchange) === token_ && exchange.status === 200, "the installation's collection listing");
  const scopeRows = connectorId => rows("SELECT collection_id, private_device FROM installation_collection_scopes WHERE connector_id=$1 ORDER BY collection_id", [connectorId]);
  /** A request as an installation credential alone would send it (no proof can be signed outside the app). */
  const asInstallation = async (token_, method, path, headers = {}, body) => {
    const reply = await fetch(`${connectOrigin}${path}`, { method, headers: { authorization: `Bearer ${token_}`, origin: appOrigin, ...headers, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await reply.text(); let value = null; try { value = JSON.parse(text); } catch { /* not JSON */ }
    return { status: reply.status, code: value?.error?.code ?? value?.error ?? value?.code ?? null, text };
  };
  const unsignedProof = () => ({ device_id: "11111111-1111-4111-8111-111111111111", challenge: hex(randomBytes(32)), sig: hex(randomBytes(64)) });

  // ------------------------------------------------- step 8a: app devices off
  section("8a. negative: the same app while the server's app-device switch is off");
  // The cloud-copy stand-in: the three control-plane rows the server's own PostgreSQL
  // test seeds for a cloud copy. It can be offered, approved and listed; with no hosted
  // peer behind it, it cannot be opened.
  const cloudCopyId = randomUUID();
  await rows("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'next','cloud_copy',$3)", [cloudCopyId, accountId, Buffer.alloc(32)]);
  const seededBatch = (await rows("INSERT INTO next_policy_batches(collection_id,seq,prev,item,issued_at,state) VALUES($1,1,$2,$3,1,'appended') RETURNING id", [cloudCopyId, Buffer.alloc(32), Buffer.alloc(1)]))[0].id;
  await rows("INSERT INTO next_policy_outbox(collection_id,ops,batch_id) VALUES($1,$2,$3)", [cloudCopyId, JSON.stringify({ version: 1, ops: [{ op: "member-set", account: accountId, role: "owner" }] }), seededBatch]);
  const a = await open("a-app-devices-off");
  const signedA = await signInApp(a, shown => {
    assert.equal(shown.requested_private_device, undefined, "the request was not granted device access");
    console.log(`   offered: ${JSON.stringify(shown.collections)}`);
    assert.ok(shown.collections.every(collection => collection.kind !== "private_device"), "no Private device choice is offered");
    assert.ok(shown.collections.some(collection => collection.collection_id === cloudCopyId), "the cloud copy is offered");
    // What the portal sends for a cloud-copy choice.
    return { collection_ids: [cloudCopyId], create_collections: false, selected_collection_id: cloudCopyId };
  });
  const registered = since(0, exchange => exchange.method === "POST" && pathOf(exchange) === "/v1/apps/register" && exchange.status === 200).at(-1);
  const applicationId = json(registered)?.application?.id;
  assert.match(String(applicationId), /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/, "the app registered itself");
  assert.equal((await rows("SELECT id FROM applications WHERE id=$1", [applicationId])).length, 1);
  const startA = since(signedA.from, exchange => exchange.method === "POST" && pathOf(exchange) === "/v1/pairing-requests").at(0);
  assert.equal(JSON.parse(startA.body.toString()).installation.requested_private_device, true, "the SDK asks (the app declares offline.replica)");
  assert.equal((await rows("SELECT requested_private_device FROM installation_device_pairings WHERE pairing_id=$1", [signedA.pairingId]))[0].requested_private_device, false, "the server did not grant the ask");
  assert.equal(Object.hasOwn(signedA.receipt, "private_device_collection_ids"), false, "the receipt names no Private device collection");
  assert.deepEqual(signedA.receipt.collection_ids, [cloudCopyId]);
  assert.equal(signedA.receipt.selected_collection_id, cloudCopyId, "the receipt carries the cloud-copy selection, as before");
  assert.deepEqual(await scopeRows(signedA.connectorId), [{ collection_id: cloudCopyId, private_device: false }], "the only scope is the cloud copy's, and it is not device access");
  const listedA = await listing(signedA.from, signedA.token);
  assert.equal(listedA.path, "/v1/next/collections?include=file_actions", "the listing is the one every SDK already sends");
  console.log(`   listing: ${listedA.reply.toString()}`);
  const rowsA = json(listedA).collections;
  assert.deepEqual(rowsA.map(row => row.collection_id), [cloudCopyId], "the listing is unchanged: the cloud copy, and no Private row");
  assert.ok(rowsA.every(row => !Object.hasOwn(row, "mode")), "no row carries a mode the SDK did not ask for");
  assert.deepEqual(signedA.view.collections.map(row => row.collectionId), [cloudCopyId], "the app lists the cloud copy only");
  console.log(`   the app after sign-in: ${JSON.stringify(signedA.view.phase)}`);
  step("sign-in succeeds; no device access in the request, the receipt, the scope or the listing; the cloud copy is listed as before");
  const offEnrol = await asInstallation(signedA.token, "POST", `/v1/next/collections/${collectionId}/private/devices`, {}, { ...unsignedProof(), sas_commit: hex(randomBytes(32)) });
  const offStatus = await asInstallation(signedA.token, "GET", "/v1/next/account-key/status");
  const proof = unsignedProof();
  const offFetch = await asInstallation(signedA.token, "GET", "/v1/next/account-key", { "x-mdbase-device-id": proof.device_id, "x-mdbase-challenge": proof.challenge, "x-mdbase-signature": proof.sig });
  console.log(`   app devices off, installation credential: enrol ${offEnrol.status} ${offEnrol.code}, status ${offStatus.status} ${offStatus.code}, fetch ${offFetch.status} ${offFetch.code}`);
  for (const refusal of [offEnrol, offStatus, offFetch]) assert.deepEqual([refusal.status, refusal.code], [401, "invalid_connector"], "with the switch off these routes do not admit an installation credential");
  step("enrol and both account-key routes refuse the installation credential as they always have (401 invalid_connector)");
  await app(a, "close"); await a.close();

  // ------------------------------------------- the operator turns the switch on
  section("the operator turns app devices on");
  await bootConnect(true);
  step("Connect restarted with MDBASE_NEXT_PRIVATE_APP_DEVICES=1");

  // ------------------------------------------------------------------- step 2
  section("2. the app signs in; the approval names the Private collection");
  const b = await open("b-main");
  const signedB = await signInApp(b, shown => {
    assert.equal(shown.requested_private_device, true, "the request was granted device access");
    const offered = shown.collections.filter(collection => collection.kind === "private_device").map(collection => collection.collection_id);
    assert.deepEqual(offered, [collectionId], "the Private collection is offered for device access");
    // What the portal sends when only Private device collections are chosen: no selection.
    return { collection_ids: [], create_collections: false, private_device_collection_ids: [collectionId] };
  });
  assert.deepEqual(signedB.receipt.private_device_collection_ids, [collectionId], "the receipt names the Private device collection");
  assert.equal(Object.hasOwn(signedB.receipt, "selected_collection_id"), false, "Connect never names a Private device collection as the selection");
  assert.deepEqual(await scopeRows(signedB.connectorId), [{ collection_id: collectionId, private_device: true }]);
  const listedB = await listing(signedB.from, signedB.token);
  assert.equal(listedB.path, "/v1/next/collections?include=file_actions,mode");
  const rowB = json(listedB).collections.find(row => row.collection_id === collectionId);
  assert.equal(rowB?.mode, "private", "the listing shows the collection as Private");
  assert.deepEqual(signedB.view.collections.map(collection => [collection.collectionId, collection.mode]), [[collectionId, "private"]]);
  step("receipt and include=file_actions,mode listing show the collection as Private; the app lists it as Private");

  // ------------------------------------------------------------------- step 3
  section("3. selecting it enrols the app's device and reaches needs_unlock (password)");
  // The receipt carries no selection. The SDK opens a sole approved collection by
  // itself, exactly as it opens a sole cloud copy (leg 8a); with several, it is select().
  let from = connect_.exchanges.length;
  if (signedB.view.phase.kind === "choosing") await app(b, "select", collectionId);
  let view = await settle(b, ["needs_unlock", "ready", "problem", "needs_setup", "needs_approval"]);
  assert.deepEqual([view.phase.kind, view.phase.collectionId, view.phase.mode, view.phase.problem], ["needs_unlock", collectionId, "password", null], JSON.stringify(view.phase));
  assert.equal(view.selectedCollectionId, collectionId);
  const enrolB = since(signedB.from, exchange => exchange.method === "POST" && pathOf(exchange) === `/v1/next/collections/${collectionId}/private/devices` && bearer(exchange) === signedB.token);
  assert.equal(enrolB.length >= 1 && enrolB.every(exchange => exchange.status === 200), true, "the app enrolled its own device with its installation credential");
  assert.equal(json(enrolB[0]).approval, "pending");
  step("device enrolled by the app runtime; phase needs_unlock, mode password");

  // ------------------------------------------------------------------- step 4
  section("4. a wrong password stays locked; the right one opens");
  const accountKey = (from, token) => since(from, exchange => bearer(exchange) === token && pathOf(exchange).startsWith("/v1/next/account-key")).map(exchange => `${exchange.method} ${pathOf(exchange)} ${exchange.status}`);
  const STATUS = "GET /v1/next/account-key/status 200", BUNDLE = "GET /v1/next/account-key 200";
  let unlockFrom = connect_.exchanges.length;
  // Shorter than any encryption password can be: refused in the app, no request.
  view = await app(b, "unlock", collectionId, { password: "too short" });
  assert.deepEqual([view.phase.kind, view.phase.unlocking, view.phase.problem?.key], ["needs_unlock", false, "wrong_secret"], JSON.stringify(view.phase));
  assert.deepEqual(accountKey(unlockFrom, signedB.token), [], "a password under the length policy made no account-key request");
  for (const attempt of [wrongPassword, `${wrongPassword} again`]) {
    view = await app(b, "unlock", collectionId, { password: attempt });
    assert.deepEqual([view.phase.kind, view.phase.unlocking, view.phase.problem?.key], ["needs_unlock", false, "wrong_secret"], JSON.stringify(view.phase));
  }
  // The account-wide fetch budget (10 an hour) was spent once, not per attempt.
  assert.deepEqual(accountKey(unlockFrom, signedB.token), [STATUS, BUNDLE, STATUS], "two wrong passwords: one sealed bundle fetch, then status only");
  step("wrong password, three times: needs_unlock, problem wrong_secret; one sealed bundle fetch in all");
  view = await app(b, "unlock", collectionId, { password });
  assert.equal(view.error, undefined, `unlock() with the right password rejected: ${JSON.stringify(view)}`);
  view = await settle(b, ["ready", "needs_unlock", "problem", "needs_setup"]);
  assert.deepEqual([view.phase.kind, view.phase.collectionId], ["ready", collectionId], JSON.stringify(view.phase));
  assert.deepEqual(accountKey(unlockFrom, signedB.token), [STATUS, BUNDLE, STATUS, STATUS], "the right password reused the bundle already fetched for this locked collection");
  step("right password: ready, without a second bundle fetch");

  // ------------------------------------------------------------------- step 5
  section("5. records cross in both directions, decrypted on both sides");
  const readInApp = (browser, path, marker) => poll(async () => {
    const record = await app(browser, "read", collectionId, path);
    return record.document.includes(marker) ? record : null;
  }, `the app never read ${path}`, 600, 200);
  const fromDesktop = await readInApp(b, desktopPath, desktopMarker);
  assert.match(fromDesktop.document, /status: open/);
  step(`the app read the desktop's record ${desktopPath}`);
  await app(b, "create", collectionId, { type: "task", path: appPath, frontmatter: { title: appMarker, status: "open" }, body: `Body ${appMarker}.\n` });
  await poll(async () => {
    const record = await mdbase(["read", appPath, "-C", folder]).catch(() => null);
    return record && JSON.stringify(record).includes(appMarker);
  }, `the desktop never read ${appPath}`, 600, 200);
  assert.match(readFileSync(join(folder, appPath), "utf8"), new RegExp(appMarker), "the app's record is a plain file on the desktop");
  step(`the desktop read the app's record ${appPath}`);

  // ------------------------------------------------------------------- step 6
  section("6. close and reopen the app without any secret");
  await app(b, "close"); await b.close();
  from = connect_.exchanges.length;
  const b2 = await open("b-main");
  await app(b2, "start");
  view = await settle(b2, ["ready", "choosing", "needs_unlock", "problem", "signed_out"]);
  if (view.phase.kind === "choosing") { await app(b2, "select", collectionId); view = await settle(b2, ["ready", "needs_unlock", "problem"]); }
  assert.deepEqual([view.phase.kind, view.phase.collectionId], ["ready", collectionId], JSON.stringify(view.phase));
  assert.equal((await app(b2, "history")).some(phase => phase.kind === "needs_unlock"), false, "the reopened app never asked for a secret");
  assert.deepEqual(since(from, exchange => pathOf(exchange).startsWith("/v1/next/account-key")).map(pathOf), [], "no account-key request was made");
  assert.match((await readInApp(b2, appPath, appMarker)).document, new RegExp(appMarker));
  step("reopened: ready with its own stored device key, no unlock and no account-key request");

  // ------------------------------------------------------------------- step 7
  section("7. a second fresh installation unlocks with the recovery key");
  const c = await open("c-recovery-key");
  const signedC = await signInApp(c, () => ({ collection_ids: [], create_collections: false, private_device_collection_ids: [collectionId] }));
  assert.notEqual(signedC.connectorId, signedB.connectorId);
  if (signedC.view.phase.kind === "choosing") await app(c, "select", collectionId);
  view = await settle(c, ["needs_unlock", "ready", "problem"]);
  assert.deepEqual([view.phase.kind, view.phase.mode], ["needs_unlock", "password"], JSON.stringify(view.phase));
  unlockFrom = connect_.exchanges.length;
  // A mistyped recovery key (one character dropped) is refused in the app: no request, no budget.
  view = await app(c, "unlock", collectionId, { recoveryKey: recoveryKey.slice(0, -1) });
  assert.deepEqual([view.phase.kind, view.phase.unlocking, view.phase.problem?.key], ["needs_unlock", false, "invalid_recovery_key"], JSON.stringify(view.phase));
  assert.deepEqual(accountKey(unlockFrom, signedC.token), [], "a malformed recovery key made no account-key request");
  view = await app(c, "unlock", collectionId, { recoveryKey });
  assert.equal(view.error, undefined, `unlock() with the recovery key rejected: ${JSON.stringify(view)}`);
  view = await settle(c, ["ready", "needs_unlock", "problem"]);
  assert.deepEqual([view.phase.kind, view.phase.collectionId], ["ready", collectionId], JSON.stringify(view.phase));
  assert.deepEqual(accountKey(unlockFrom, signedC.token), [STATUS, BUNDLE], "the recovery key fetched the sealed bundle once");
  await readInApp(c, desktopPath, desktopMarker); await readInApp(c, appPath, appMarker);
  step("second installation: needs_unlock; a mistyped recovery key is invalid_recovery_key with no request; the recovery key opens it and it reads both records");
  await app(c, "close"); await c.close();

  // ------------------------------------------------------------------ step 8b
  section("8b. negative: an installation without the scope, with app devices on");
  const neverStatus = await asInstallation(signedA.token, "GET", "/v1/next/account-key/status");
  assert.deepEqual([neverStatus.status, neverStatus.code], [403, "installation_collection_not_approved"], "an installation that never had the scope");
  step("account-key status: 403 installation_collection_not_approved for an installation that never had the scope");
  // The proof-carrying routes: the app's own signed request, with its consent row gone when Connect handles it.
  const d = await open("d-scope-removed");
  const others = [signedA.token, signedB.token, signedC.token], settled = [signedB.connectorId, signedC.connectorId];
  /** This installation's own request: an installation credential that is none of the earlier ones. */
  const own = exchange => String(bearer(exchange)).startsWith("idev_") && !others.includes(bearer(exchange));
  const removeScope = async () => {
    const removed = await rows("DELETE FROM installation_collection_scopes WHERE collection_id=$1 AND private_device AND connector_id <> ALL($2::uuid[]) RETURNING to_jsonb(installation_collection_scopes.*) AS scope", [collectionId, settled]);
    assert.equal(removed.length, 1, "the consent row existed"); return removed[0].scope;
  };
  const restoreScope = scope => rows("INSERT INTO installation_collection_scopes SELECT * FROM jsonb_populate_record(NULL::installation_collection_scopes, $1::jsonb)", [JSON.stringify(scope)]);
  const withoutScope = async (matches, action) => {
    let scope = null; const from_ = connect_.exchanges.length;
    hold = async exchange => { if (scope === null && own(exchange) && matches(exchange)) scope = await removeScope(); };
    try {
      await action();
      const refused = await poll(() => since(from_, exchange => own(exchange) && matches(exchange)).at(0) ?? null, "the app's own request was never seen", 600, 100);
      assert.ok(scope, "the request was held and the consent row removed before it was forwarded");
      return { status: refused.status, code: json(refused)?.error?.code ?? json(refused)?.error ?? null, token: bearer(refused) };
    } finally { hold = null; if (scope) await restoreScope(scope); }
  };
  // The sole approved collection opens by itself after sign-in, so the hold is armed before it.
  let signedD = null;
  const enrolRefused = await withoutScope(exchange => exchange.method === "POST" && pathOf(exchange) === `/v1/next/collections/${collectionId}/private/devices`,
    async () => { signedD = await signInApp(d, () => ({ collection_ids: [], create_collections: false, private_device_collection_ids: [collectionId] })); if (signedD.view.phase.kind === "choosing") await app(d, "select", collectionId); });
  assert.deepEqual([enrolRefused.status, enrolRefused.code], [403, "installation_collection_not_approved"]);
  assert.equal(enrolRefused.token, signedD.token, "the refused request was this installation's own");
  view = await settle(d, ["problem", "needs_unlock", "ready", "choosing", "needs_approval", "signed_out", "needs_setup"]);
  assert.equal(["needs_unlock", "ready"].includes(view.phase.kind), false, `the app did not join: ${JSON.stringify(view.phase)}`);
  console.log(`   the app after the refused enrolment: ${JSON.stringify(view.phase)}`);
  step("enrol: 403 installation_collection_not_approved (the app's own signed request)");
  await app(d, "close"); await d.close();
  const d2 = await open("d-scope-removed");
  await app(d2, "start");
  view = await settle(d2, ["choosing", "needs_unlock", "ready", "problem", "needs_approval", "signed_out"]);
  if (view.phase.kind !== "needs_unlock") { await app(d2, "select", collectionId); view = await settle(d2, ["needs_unlock", "ready", "problem", "needs_approval"]); }
  assert.deepEqual([view.phase.kind, view.phase.mode], ["needs_unlock", "password"], JSON.stringify(view.phase));
  const fetchRefused = await withoutScope(exchange => exchange.method === "GET" && pathOf(exchange) === "/v1/next/account-key",
    async () => { view = await app(d2, "unlock", collectionId, { password }); });
  assert.deepEqual([fetchRefused.status, fetchRefused.code], [403, "installation_collection_not_approved"]);
  assert.equal(view.phase.kind, "needs_unlock", JSON.stringify(view.phase));
  assert.notEqual(view.phase.problem, null, "the refused unlock is reported");
  console.log(`   the app after the refused unlock: ${JSON.stringify(view.phase)}`);
  step("account-key fetch: 403 installation_collection_not_approved (the app's own signed proof)");
  await app(d2, "close"); await d2.close();

  // --------------------------------------------------------- sealed bytes only
  section("the log service only ever saw sealed bytes");
  const markers = [desktopMarker, appMarker, `desk-${nonce}`, `app-${nonce}`].map(text => Buffer.from(text));
  const id = uuidBytes(collectionId);
  const seen = [];
  for (const exchange of log.exchanges) seen.push({ origin: exchange.headers.origin ?? null, bytes: [Buffer.from(exchange.path), exchange.body, exchange.reply ?? Buffer.alloc(0)] });
  for (const stream of log.streams) { assert.equal(stream.compressed, false, "no compressed WebSocket message"); seen.push({ origin: stream.origin, bytes: [Buffer.from(stream.path), Buffer.concat(stream.sent), Buffer.concat(stream.received)] }); }
  const total = party => seen.filter(party).reduce((sum, entry) => sum + entry.bytes.reduce((n, part) => n + part.length, 0), 0);
  const names = party => seen.filter(party).some(entry => entry.bytes.some(part => part.includes(id)));
  const fromApp = entry => entry.origin === appOrigin, fromOthers = entry => entry.origin !== appOrigin;
  // Not vacuous: the recorder sees the protocol's own bytes (the collection id) from the app and from the desktop.
  assert.ok(total(fromApp) > 0 && names(fromApp), "the app's log traffic was recorded and names the collection");
  assert.ok(total(fromOthers) > 0 && names(fromOthers), "the desktop's and Connect's log traffic was recorded and names the collection");
  for (const entry of seen) for (const part of entry.bytes) for (const marker of markers)
    assert.equal(part.includes(marker), false, `plaintext ${marker} reached the log service`);
  step(`${log.exchanges.length} requests and ${log.streams.length} sockets, ${total(fromApp)} bytes from the app and ${total(fromOthers)} from the desktop and Connect: no record title, body or path in the clear`);

  console.log("\nPASS: the Private device path, end to end on the local stack");
} catch (error) {
  failed = true;
  console.error(`\nFAILED: ${error?.stack ?? error}`);
  console.error(`logs: ${run}`);
} finally {
  // What Connect was asked and answered (throwaway credentials of a disposable database), for reading a failure.
  if (connect_) writeFileSync(join(run, "connect-exchanges.jsonl"), connect_.exchanges.map(exchange => JSON.stringify({ method: exchange.method, path: exchange.path, status: exchange.status,
    origin: exchange.headers.origin ?? null, request: exchange.body.toString("utf8").slice(0, 2000), reply: exchange.reply?.toString("utf8").slice(0, 4000) ?? null })).join("\n") + "\n");
  // Bounded: a step that hangs must not keep the container or a child alive.
  for (const close of cleanup.reverse()) await Promise.race([Promise.resolve().then(close).catch(() => {}), delay(15_000)]);
  for (const entry of children) await stop(entry).catch(() => {});
  if (!keep) await rm(scratch, { recursive: true, force: true });
  else console.log(`kept: ${scratch}`);
}
process.exit(failed ? 1 : 0);
