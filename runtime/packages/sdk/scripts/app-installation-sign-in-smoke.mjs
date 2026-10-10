// Isolated real browser IDB/WebLocks/WebCrypto + actual native original owner.
// CP replies/selected account are EXPLICIT fixtures; NOT authenticated production
// or LAB qualification. Persistent profile is owned and removed; never /tmp.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { openInstallationTestProducer } from "./app-installation-sign-in-producer.mjs";
const playwright = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "@playwright/test");
const wasmPath = process.env.MDBN_APP_WASM;
if (!wasmPath) throw Error("MDBN_APP_WASM must name an explicitly built app-runtime artifact");
const wasm = await readFile(wasmPath), hash = createHash("sha256").update(wasm).digest("hex");
const root = resolve(new URL("../../../target/installation-sign-in-browser/", import.meta.url).pathname);
await mkdir(root, {recursive: true}); const profile = await mkdtemp(`${root}/profile-`);
const webOrigin = "https://lab.tasknotes-app.pages.dev";
const producer = process.env.MDBN_CONNECT_CHECKOUT ? await openInstallationTestProducer({checkout: process.env.MDBN_CONNECT_CHECKOUT, output: root, publicUrl: webOrigin}) : null;
const result = await build({stdin: {contents: `export {AppProtectedInstallationSignIn} from './installation-sign-in.js'; export {AppInstallationStore} from './installation-store.js'; export {acquireAppInstallationLease} from './owner.js'; export {AppWebCloudCopyHost} from './cloud-copy-host.js'; export {AppWasmRuntime} from './wasm-runtime.js';`, resolveDir: resolve(new URL("../dist/app-host/", import.meta.url).pathname)}, bundle: true, write: false, format: "esm", platform: "browser", target: "es2022"});
const bundle = result.outputFiles[0].contents;
const server = createServer(async (req, res) => {
  try {
    if (producer && req.url?.startsWith("/v1/")) {
      let size = 0; const chunks = [];
      for await (const part of req) {size += part.length; if (size > 32768) throw Error("test request bound"); chunks.push(part);}
      const result = await producer.request({method: req.method, path: req.url, headers: {authorization: req.headers.authorization, "content-type": req.headers["content-type"]}, body: Buffer.concat(chunks).toString("utf8")});
      res.writeHead(result.status, {"content-type": "application/json", "cache-control": "no-store"}); res.end(result.body); return;
    }
    res.setHeader("content-type", req.url === "/bundle.js" ? "text/javascript" : req.url === "/runtime.wasm" ? "application/wasm" : "text/html");
    res.end(req.url === "/bundle.js" ? bundle : req.url === "/runtime.wasm" ? wasm : "<!doctype html><title>isolated protected installation test</title>");
  } catch (e) {
    console.error(e instanceof Error && /^owned portal (select-account|approve) refused$/.test(e.message) ? e.message : "owned test proxy boundary failed");
    res.writeHead(500, {"content-type": "application/json"}); res.end('{"error":"owned_test_boundary_unavailable"}');
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const localOrigin = `http://127.0.0.1:${server.address().port}`, origin = producer ? webOrigin : localOrigin;
let context;
async function openPage() {
  const page = await context.newPage();
  if (producer) await page.route(`${origin}/**`, async route => {
    const request = route.request(), url = new URL(request.url());
    const response = await route.fetch({url: `${localOrigin}${url.pathname}${url.search}`});
    await route.fulfill({response});
  });
  await page.goto(origin); return page;
}
async function run(mode, phase, expected = null) {
  context = await playwright.chromium.launchPersistentContext(profile, {headless: true});
  const page = await openPage();
  const result = await page.evaluate(async ({origin, mode, phase, expected, realProducer, accountId, artifactSha256}) => {
    const m = await import("/bundle.js"), signal = new AbortController().signal, trace = [];
    const account = accountId ?? "11111111-1111-4111-8111-111111111111", connector = "22222222-2222-4222-8222-222222222222";
    let selected = phase !== "fresh", proof = null, requests = 0, signs = 0, nativeOpens = 0, closing = false, acknowledged = false, identities = null;
    const hex = b => Array.from(b, v => v.toString(16).padStart(2, "0")).join("");
    // Instrument only public proof/receipt/opaque result metadata; never inspect
    // secret loans. The host, not this harness, owns ALL custody/native intake.
    const originalOpen = m.AppWasmRuntime.prototype.openDeviceConsuming;
    m.AppWasmRuntime.prototype.openDeviceConsuming = function(options) {
      nativeOpens++; const result = originalOpen.call(this, options);
      identities = [hex(result.signPublicKey), hex(result.kemPublicKey), hex(result.noisePublicKey)]; return result;
    };
    const originalSign = m.AppWasmRuntime.prototype.signCpEnrol;
    m.AppWasmRuntime.prototype.signCpEnrol = function(challenge) {signs++; return originalSign.call(this, challenge);};
    let flow;
    const request = async (url, init) => {
      requests++; if (phase === "offline") throw Error("offline must not attempt pairing HTTP");
      if (init.credentials !== "omit" || init.redirect !== "error" || init.cache !== "no-store") throw Error("ambient credential");
      trace.push(new URL(url).pathname.split("/").at(-1));
      if (realProducer) {
        const response = await fetch(url, init);
        if (phase === "fresh" && url.endsWith("/attest") && response.ok) {await response.text(); throw Error("fixture: real committed attestation response lost");}
        return response;
      }
      const v = flow.view();
      const selection = {request_id: v.requestId, account_id: account, connector_id: connector, device_id: v.deviceId, installation_id: v.installationId, kind: v.kind, challenge: "ab".repeat(32), approval_mode: "password-ak1", app_id: v.appId, app_origin: origin, expires_at: Date.now() + 600000};
      let status = 200, body;
      if (url.endsWith("/v1/pairing-requests")) {
        const i = JSON.parse(init.body).installation; if (i.request_id !== v.requestId || !/^pair_[A-Za-z0-9_-]{43}$/.test(i.pairing_secret)) throw Error("original missing");
        body = {pairing_id: v.requestId, pairing_secret: i.pairing_secret, verification_uri: `${origin}/pair/${v.requestId}`, expires_in: 600, installation_device: true, app_id: v.appId, app_origin: origin, app_name: "TaskNotes"}; status = 201;
      } else if (url.endsWith("/attest")) {
        proof = JSON.parse(init.body); if (phase === "fresh") throw Error("fixture: committed attestation response lost"); body = {ok: true};
      } else if (!selected) {status = 202; body = {status: "pending"};}
      else if (!proof) {status = 202; body = {status: "account_selected", ...selection};}
      else body = {status: "paired", ...selection, connector: {id: connector, name: "TaskNotes"}, token: `idev_${"a".repeat(43)}`, registration: {device_id: v.deviceId, sign_pk: proof.sign_pk, kem_pk: proof.kem_pk, noise_pk: proof.noise_pk}};
      return new Response(JSON.stringify(body), {status});
    };
    flow = await m.AppProtectedInstallationSignIn.open({origin, cpOrigin: origin, appId: "tasknotes-web", environment: "lab", mode, signal, locks: navigator.locks, allowLoopbackHttp: true, fetch: request});
    const original = flow.view();
    let busy = false;
    try {await m.AppProtectedInstallationSignIn.open({origin, cpOrigin: origin, appId: "tasknotes-web", environment: "lab", mode: "existing", signal, locks: navigator.locks, allowLoopbackHttp: true, fetch: request});} catch (e) {busy = e.reason === "busy";}
    if (!busy) throw Error("second owner bypassed pre-account slot");
    if (phase === "fresh") {
      await flow.start(); selected = true; await flow.exchange();
      let refused = false; try {flow.confirmedSelection();} catch {refused = true;} if (!refused) throw Error("keys before user account confirmation");
      await flow.confirmSelectedAccount(account);
    } else if (phase === "offline") {await flow.start(); await flow.exchange(); if (requests) throw Error("known completion HTTP");}
    const confirmed = flow.confirmedSelection();
    const lease = await m.acquireAppInstallationLease(navigator.locks, {account, installation: confirmed.installationId}, signal);
    const installation = Object.freeze({scope: Object.freeze({account, installation: confirmed.installationId}), isCurrent: () => !closing && flow.isCurrent()});
    let host;
    try {
      // Bundled release context is explicitly a fixture here; native collection
      // verification is not claimed by this installation-only carrier test.
      const release = Object.freeze({schema: "mdbn-app-trust/release/1", environment: "lab", cpOrigin: origin, logOrigin: "https://log.example.test", assetSha256: artifactSha256, source: Object.freeze({repository: "mdbase-dev/mdbase-connect", commit: "bb".repeat(20), version: "0.0.0-test"}), trustedRoots: [new Uint8Array(32).fill(9)], policyPins: Uint8Array.of(0x82)});
      host = await m.AppWebCloudCopyHost.openInstallationDevice({signIn: flow, installation, release, origin, signal, allowLoopbackHttp: true, loadRuntime: async () => new Uint8Array(await (await fetch("/runtime.wasm")).arrayBuffer())});
      if (nativeOpens !== 1) throw Error("second native device open");
      if (expected && JSON.stringify(expected.identities) !== JSON.stringify(identities)) throw Error("original actor drift");
      if (phase === "fresh") {
        let refused = false; try {host.registeredReceipt();} catch {refused = true;} if (!refused) throw Error("unpaired host published registration");
        refused = false; try {await host.attestInstallation();} catch (e) {refused = e.reason === "outcome_unknown";} if (!refused) throw Error("lost attestation outcome not preserved");
      } else {
        if (phase !== "offline") {await host.attestInstallation(); await flow.exchange(); await host.completeInstallationSignIn();}
        const receipt = host.registeredReceipt(); acknowledged = true;
        if (hex(receipt.signPublicKey) !== identities[0] || hex(receipt.kemPublicKey) !== identities[1] || hex(receipt.noisePublicKey) !== identities[2]) throw Error("ACK actor drift");
      }
      if (nativeOpens !== 1) throw Error("sign-in continuation reopened native device");
      // Ledger persists ONLY nonextractable handle + ciphertext; public origin
      // store never contains a raw capability/plaintext account tuple.
      const dbs = await indexedDB.databases(), ledger = dbs.find(v => v.name.startsWith("mdbase.app.installation.v1."));
      const db = await new Promise((resolve, reject) => {const req = indexedDB.open(ledger.name); req.onerror = () => reject(Error("inspect")); req.onsuccess = () => resolve(req.result);});
      const record = await new Promise((resolve, reject) => {const tx = db.transaction("installation-sign-in", "readonly"), req = tx.objectStore("installation-sign-in").get("original"); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(Error("inspect record"));}); db.close();
      if (Object.keys(record).sort().join() !== "encrypted,key,revision,version" || record.key.extractable || !(record.encrypted instanceof Uint8Array)) throw Error("plaintext ledger");
      let exportRefused = false; try {await crypto.subtle.exportKey("raw", record.key);} catch {exportRefused = true;} if (!exportRefused) throw Error("exportable origin KEK");
      return {original: {requestId: original.requestId, installationId: original.installationId, deviceId: original.deviceId}, identities, requests, signs, nativeOpens, acknowledged, state: flow.view().state, revision: record.revision, exportRefused, busy};
    } finally {
      closing = true; await host?.close(); await lease.release(); await flow.close();
      if ((await navigator.locks.query()).held.length) throw Error("locks leaked");
    }
  }, {origin, mode, phase, expected, realProducer: producer !== null, accountId: producer?.accountId, artifactSha256: hash});
  const version = context.browser()?.version(); await context.close(); context = null; return {...result, browser: version};
}
try {
  const fresh = await run("fresh", "fresh"); assert.equal(fresh.signs, 1); assert.equal(fresh.state, "awaiting_approval");
  const resumed = await run("existing", "resumed", fresh); assert.equal(resumed.signs, 0); assert.equal(resumed.state, "paired"); assert.deepEqual(resumed.original, fresh.original);
  const offline = await run("existing", "offline", fresh); assert.equal(offline.requests, 0); assert.equal(offline.signs, 0); assert(offline.acknowledged); assert.deepEqual(offline.original, fresh.original);
  context = await playwright.chromium.launchPersistentContext(profile, {headless: true});
  const page = await openPage();
  const integrity = await page.evaluate(async origin => {
    const m = await import("/bundle.js"), signal = new AbortController().signal;
    const options = {origin, cpOrigin: origin, appId: "tasknotes-web", environment: "lab", mode: "existing", signal, locks: navigator.locks, allowLoopbackHttp: true, fetch: () => {throw Error("integrity must not call CP");}};
    const dbs = await indexedDB.databases(), name = dbs.find(v => v.name.startsWith("mdbase.app.installation.v1.")).name;
    const db = await new Promise((resolve, reject) => {const req = indexedDB.open(name); req.onerror = () => reject(Error("inspect")); req.onsuccess = () => resolve(req.result);});
    const record = await new Promise(resolve => {const req = db.transaction("installation-sign-in", "readonly").objectStore("installation-sign-in").get("original"); req.onsuccess = () => resolve(req.result);});
    const write = value => new Promise((resolve, reject) => {const tx = db.transaction("installation-sign-in", "readwrite", {durability: "strict"}), store = tx.objectStore("installation-sign-in"); value === null ? store.delete("original") : store.put(value, "original"); tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(Error("test write"));});
    let refusals = 0;
    const refuse = async value => {try {const flow = await m.AppProtectedInstallationSignIn.open(value); await flow.close(); throw Error("unexpected admit");} catch (e) {if (e.reason !== "recovery_required") throw e; refusals++;}};
    try {
      await refuse({...options, mode: "fresh"});
      const corrupt = structuredClone(record); corrupt.encrypted[20] ^= 1; await write(corrupt); await refuse(options);
      await write(null); await refuse(options); await refuse({...options, mode: "fresh"});
      await write(record); const restored = await m.AppProtectedInstallationSignIn.open(options); const state = restored.view().state; await restored.close();
      if (state !== "paired" || (await navigator.locks.query()).held.length) throw Error("failed restore/leaked ownership");
      return {refusals, originalRestored: state, zeroLocks: true};
    } finally {db.close();}
  }, origin);
  await context.close(); context = null;
  console.log(JSON.stringify({qualification: producer ? "actual Connect PG/routes + browser protected installation SAME-native cloud host; seeded account/session/portal actions, release context and proxy fixtures" : "actual browser protected installation SAME-native cloud host; CP selection/approval and release fixtures", artifactSha256: hash, fresh: {...fresh, identities: undefined}, resumed: {...resumed, identities: undefined}, offline: {...offline, identities: undefined}, integrity}));
} finally {await context?.close(); await new Promise(resolve => server.close(resolve)); await producer?.close(); await rm(profile, {recursive: true, force: true});}
