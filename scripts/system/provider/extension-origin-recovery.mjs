import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";

// Real Chromium extension -> control plane -> HTTP hosted provider -> PostgreSQL.
// Only the first enrollment's origin is corrupted: setup and rejection both run
// in the real authority, rather than a mocked provisioning implementation.
export async function extensionOriginRecoveryE2E({
  controlUrl, cookie, directory, repoRoot, controlRequest, rawRequest,
  provider, database, provision, semanticVersion
}) {
  const created = await controlRequest(controlUrl, "/v1/hosted/collections", cookie, {
    method: "POST", body: { display_name: `[test] extension origin recovery v${semanticVersion}`, template: "mdbase", timezone: "UTC" }
  });
  const collectionId = created.collection.id;
  const extension = join(directory, `extension-origin-recovery-v${semanticVersion}`);
  const capabilities = semanticVersion === 2 ? ["collection.read", "records.create"] : [
    "collection.inspect", "records.watch", "records.read", "records.query", "records.create",
    "views.list", "views.execute", "views.source.read", "records.validate", "definitions.read", "collection.setup.apply"
  ];
  await mkdir(extension);
  const manifest = {
    manifest_version: 1, distribution: "portable", id: `dev.mdbase.extension-recovery-v${semanticVersion}-e2e`,
    name: "Extension recovery test", project_url: "https://apps.example/extension-recovery",
    requirements: {
      access: "full_collection", collection_kind: "hosted", contracts: provision.provides,
      capabilities: { contract_version: semanticVersion, required: capabilities, optional: [] }
    },
    provisions: { type_packs: [provision] }
  };
  await writeFile(join(extension, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "[test] hosted origin recovery", version: "1.0.0",
    host_permissions: ["http://127.0.0.1/*"], background: { service_worker: "background.js" }
  }));
  await writeFile(join(extension, "background.js"), "chrome.runtime.onInstalled.addListener(() => {});");
  await writeFile(join(extension, "index.html"), '<script src="sdk.js"></script><script src="harness.js"></script>');
  await writeFile(join(extension, "sdk.js"), await readFile(join(repoRoot, "packages/client/dist/browser/mdbase-connect.min.js")));
  await writeFile(join(extension, "harness.js"), `
    const manager = new MdbaseConnect.MdbaseConnect({ serverUrl: ${JSON.stringify(controlUrl)}, manifest: ${JSON.stringify(manifest)} });
    const unwrap = (result) => { if (!result.ok) throw new Error(result.problem.message); return result.value; };
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).includes('/operations/') && init.headers?.authorization) {
        globalThis.captured = { url: String(url), method: init.method, headers: { ...init.headers }, body: init.body };
      }
      return nativeFetch(url, { ...init, credentials: 'omit' });
    };
    globalThis.start = () => manager.authorize({
      capabilities: ${JSON.stringify(capabilities)}, openVerification() {},
      onDeviceCode(value) { globalThis.authorization = value; }
    }).then(async (result) => {
      const { connection } = unwrap(result);
      unwrap(await connection.create({ path: 'extension-proof.md', frontmatter: { type: 'task', title: 'Extension proof', status: 'open' }, body: 'Saved by an exact-origin extension.' }));
      const records = unwrap(await connection.query({ where: 'file.path == "extension-proof.md"' }));
      globalThis.result = { collectionId: connection.collectionId, count: records.results.length };
    }).catch((error) => { globalThis.failure = error.message; });
  `);
  let context;
  const enroll = provider.registerReplica;
  let rejectedEnrollments = 0;
  provider.registerReplica = function (id, replica) {
    if (id === collectionId && rejectedEnrollments++ === 0) {
      return enroll.call(this, id, { ...replica, allowedOrigin: "ftp://invalid.example" });
    }
    return enroll.call(this, id, replica);
  };
  try {
    context = await chromium.launchPersistentContext("", {
      channel: "chromium", headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const origin = new URL(worker.url()).protocol + "//" + new URL(worker.url()).host;
    assert.match(origin, /^chrome-extension:\/\/[a-p]{32}$/);
    const page = await context.newPage();
    await page.goto(`${origin}/index.html`);
    await page.evaluate(() => { void globalThis.start(); });
    await page.waitForFunction(() => globalThis.authorization || globalThis.failure);
    const authorization = await page.evaluate(() => globalThis.authorization);
    assert.equal(await page.evaluate(() => globalThis.failure), undefined, "extension authorization failed");
    assert.ok(authorization, "extension did not start device authorization");
    const claimed = await controlRequest(controlUrl, "/v1/device-authorization-requests/lookup", cookie, {
      method: "POST", body: { user_code: authorization.userCode }
    });
    const endpoint = `/v1/authorization-requests/${claimed.request_id}/approve`;
    const selection = {
      collection_id: collectionId,
      operations: ["describe", "changes", "read", "query", "list_views", "execute_view", "read_view_source", "validate", "read_type", "create", "assess_collection_setup", "apply_collection_setup"],
      contract_setups: provision.provides.map((contract) => ({ contract, mode: "starter" }))
    };
    const approve = (body) => rawRequest(controlUrl, endpoint, { cookie, method: "POST", body });
    const failed = await approve(selection);
    assert.equal(failed.status, 400, JSON.stringify(failed.body));
    assert.equal(failed.body.error.code, "invalid_application_origin");
    const installed = await provider.collectionContracts(collectionId);
    assert.ok(installed.some((contract) => contract.id === provision.provides[0].id));
    const cached = async () => (await database.query("SELECT contracts FROM hosted_collections WHERE id = $1", [collectionId])).rows[0].contracts;
    assert.deepEqual(await cached(), installed, "external commit must survive SQL rollback and refresh the cache");
    assert.equal((await database.query("SELECT id FROM grants WHERE hosted_collection_id = $1", [collectionId])).rows.length, 0);
    assert.equal((await database.query("SELECT completed_at FROM authorization_requests WHERE id = $1", [claimed.request_id])).rows[0].completed_at, null);
    // Also reproduce older damage / an unavailable compensation refresh.
    await database.query("UPDATE hosted_collections SET contracts = '[]'::jsonb WHERE id = $1", [collectionId]);
    const stale = await approve(selection);
    assert.equal(stale.status, 400, JSON.stringify(stale.body));
    assert.match(stale.body.error.message, /reload the approval page/);
    assert.equal(rejectedEnrollments, 1, "stale choices must not reach enrollment");
    assert.deepEqual(await cached(), installed);
    const reviewed = await approve({ ...selection, contract_setups: [] });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
    await page.waitForFunction(() => globalThis.result || globalThis.failure, undefined, { timeout: 30_000 });
    assert.equal(await page.evaluate(() => globalThis.failure), undefined);
    assert.deepEqual(await page.evaluate(() => globalThis.result), { collectionId, count: 1 });
    assert.deepEqual(await provider.collectionContracts(collectionId), installed, "retry must not replace existing mappings");
    const captured = await page.evaluate(() => globalThis.captured);
    assert.ok(captured.headers["x-mdbase-proof-signature"]);
    for (const wrongOrigin of [null, "null", "https://evil.example", `${origin}x`, "moz-extension://other"]) {
      const headers = { ...captured.headers };
      if (wrongOrigin !== null) headers.origin = wrongOrigin;
      const response = await fetch(captured.url, { method: captured.method, headers, body: captured.body });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, "origin_denied");
    }
    const noProof = await fetch(captured.url, { method: captured.method, headers: {
      authorization: captured.headers.authorization, "content-type": "application/json", origin
    }, body: captured.body });
    assert.equal(noProof.status, 401);
    assert.equal((await noProof.json()).error.code, "authority_proof_required");
    const replay = await fetch(captured.url, { method: captured.method, headers: { ...captured.headers, origin }, body: captured.body });
    assert.equal(replay.status, 401);
    assert.equal((await replay.json()).error.code, "authority_proof_replayed");
  } finally {
    provider.registerReplica = enroll;
    await context?.close(); // Own hermetic context; never the shared LAB browser.
    await controlRequest(controlUrl, `/v1/hosted/collections/${collectionId}`, cookie, { method: "DELETE" });
  }
}
