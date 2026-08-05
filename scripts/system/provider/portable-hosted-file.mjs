import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";

export async function portableHostedFileE2E({
  controlUrl,
  cookie,
  collectionId,
  directory,
  repoRoot,
  controlRequest
}) {
  const bundle = (await readFile(
    join(repoRoot, "packages", "client", "dist", "browser", "mdbase-connect.min.js"),
    "utf8"
  )).replaceAll("</script", "<\\/script");
  const file = join(directory, "portable-hosted.html");
  await writeFile(file, `<!doctype html>
<meta charset="utf-8">
<title>Portable hosted mdbase E2E</title>
<button id="connect">Connect</button>
<output id="code"></output>
<script>${bundle}</script>
<script>
  const manager = new MdbaseConnect.MdbaseConnect({
    serverUrl: ${JSON.stringify(controlUrl)},
    manifest: {
      manifest_version: 1,
      distribution: "portable",
      id: "dev.mdbase.portable-hosted-e2e",
      name: "Portable Hosted E2E",
      project_url: "https://apps.example/portable-hosted-e2e",
      requirements: {
        access: "full_collection",
        contracts: [],
        collection_kind: "hosted"
      }
    }
  });
  globalThis.portableHarness = {
    environment: manager.environment(),
    initialConnections: manager.connections().length
  };
  const requireConnectSuccess = (outcome) => {
    if (!outcome.ok) throw Object.assign(new Error(outcome.problem.message), { problem: outcome.problem });
    return outcome.value;
  };
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("/v1/authorities/") && init.headers?.authorization) {
      globalThis.portableHarness.capturedRequest = {
        url,
        method: init.method,
        headers: { ...init.headers },
        body: init.body
      };
    }
    return nativeFetch(input, init);
  };
  document.querySelector("#connect").onclick = () => {
    manager.authorize({
      operations: ["describe", "query", "create", "sync"],
      openVerification() {},
      onDeviceCode(authorization) {
        globalThis.portableHarness.authorization = authorization;
        document.querySelector("#code").textContent = authorization.userCode;
      }
    }).then(async (authorizationOutcome) => {
      const { connection } = requireConnectSuccess(authorizationOutcome);
      const created = requireConnectSuccess(await connection.create({
        path: "portable-hosted-e2e.md",
        frontmatter: { title: "Created from a downloaded file" },
        body: "Direct to the hosted provider."
      }));
      const description = requireConnectSuccess(await connection.describe());
      const records = requireConnectSuccess(await connection.query({
        where: 'file.path == "portable-hosted-e2e.md"'
      }));
      globalThis.portableHarness.result = {
        route: connection.route,
        collectionId: connection.collectionId,
        displayName: description.displayName,
        created: created.path === "portable-hosted-e2e.md",
        records: records.results.length,
        syncAvailable: connection.sync() !== null,
        connections: manager.connections().length
      };
    }).catch((error) => {
      globalThis.portableHarness.error = {
        code: error && (error.problem?.code || error.code),
        message: error && error.message
      };
    });
  };
</script>`);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(new URL(`file://${file}`).href);
    const environment = await page.evaluate(() => globalThis.portableHarness);
    assert.equal(environment.environment.applicationOrigin, "null");
    assert.equal(environment.environment.credentialStorage, "memory");
    assert.equal(environment.initialConnections, 0);
    await page.click("#connect");
    await page.waitForFunction(() => Boolean(globalThis.portableHarness.authorization));
    const authorization = await page.evaluate(
      () => globalThis.portableHarness.authorization
    );
    const claimed = await controlRequest(
      controlUrl,
      "/v1/device-authorization-requests/lookup",
      cookie,
      {
        method: "POST",
        body: { user_code: authorization.userCode }
      }
    );
    const pending = await controlRequest(
      controlUrl,
      `/v1/authorization-requests/${claimed.request_id}`,
      cookie
    );
    assert.ok(pending.collections.length > 0);
    assert.ok(pending.collections.every((collection) => collection.kind === "hosted"));
    assert.ok(pending.collections.some((collection) => collection.id === collectionId));
    await controlRequest(
      controlUrl,
      `/v1/authorization-requests/${claimed.request_id}/approve`,
      cookie,
      {
        method: "POST",
        body: {
          collection_id: collectionId,
          operations: ["describe", "query", "create", "sync"]
        }
      }
    );
    await page.waitForFunction(
      () => Boolean(globalThis.portableHarness.result || globalThis.portableHarness.error),
      undefined,
      { timeout: 20_000 }
    );
    const result = await page.evaluate(() => globalThis.portableHarness);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.result, {
      route: "remote",
      collectionId,
      displayName: "Hosted writing",
      created: true,
      records: 1,
      syncAvailable: true,
      connections: 1
    });
    const captured = result.capturedRequest;
    assert.ok(captured.headers["x-mdbase-proof-signature"]);
    const noProof = await fetch(captured.url, {
      method: captured.method,
      headers: {
        authorization: captured.headers.authorization,
        "content-type": captured.headers["content-type"],
        origin: "null"
      },
      body: captured.body
    });
    assert.equal(noProof.status, 401);
    assert.equal((await noProof.json()).error.code, "authority_proof_required");
    const noProofOrOrigin = await fetch(captured.url, {
      method: captured.method,
      headers: {
        authorization: captured.headers.authorization,
        "content-type": captured.headers["content-type"]
      },
      body: captured.body
    });
    assert.equal(noProofOrOrigin.status, 403);
    assert.equal((await noProofOrOrigin.json()).error.code, "origin_denied");
    const replay = await fetch(captured.url, {
      method: captured.method,
      headers: { ...captured.headers, origin: "null" },
      body: captured.body
    });
    assert.equal(replay.status, 401);
    assert.equal((await replay.json()).error.code, "authority_proof_replayed");
    const tampered = await fetch(captured.url, {
      method: captured.method,
      headers: { ...captured.headers, origin: "null" },
      body: `${captured.body} `
    });
    assert.equal(tampered.status, 401);
    assert.equal((await tampered.json()).error.code, "invalid_authority_proof");
    const missingOrigin = await fetch(captured.url, {
      method: captured.method,
      headers: captured.headers,
      body: captured.body
    });
    assert.equal(missingOrigin.status, 403);
    assert.equal((await missingOrigin.json()).error.code, "origin_denied");

    const independentPage = await context.newPage();
    await independentPage.goto(new URL(`file://${file}`).href);
    const independent = await independentPage.evaluate(() => globalThis.portableHarness);
    assert.equal(independent.initialConnections, 0);
    assert.equal(independent.environment.credentialStorage, "memory");
    await independentPage.close();
    await context.close();
  } finally {
    await browser.close();
  }
}
