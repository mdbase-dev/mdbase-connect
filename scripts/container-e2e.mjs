import assert from "node:assert/strict";
import {
  startConnectTestEnvironment,
  waitForReady
} from "./lib/connect-test-environment.mjs";

const environment = await startConnectTestEnvironment();

try {
  phase("checking the packaged server and loopback boundary");
  const publishedPort = (
    await environment.compose(["port", "connect", "8787"], { capture: true })
  ).trim();
  assert.equal(
    publishedPort,
    `127.0.0.1:${environment.connectPort}`,
    "The development server must only bind to host loopback"
  );

  const health = await request("/health");
  assert.equal(health.response.status, 200);
  assert.deepEqual(
    {
      ok: health.body.ok,
      service: health.body.service,
      protocol_version: health.body.protocol_version
    },
    { ok: true, service: "mdbase-connect", protocol_version: 1 }
  );
  const ready = await request("/ready");
  assert.equal(ready.response.status, 200);
  assert.equal(ready.body.ok, true);
  const auth = await request("/v1/auth/config");
  assert.deepEqual(
    {
      provider: auth.body.provider,
      development_login: auth.body.development_login
    },
    { provider: "development", development_login: true }
  );
  const portal = await fetch(`${environment.serverUrl}/`);
  assert.equal(portal.status, 200);
  assert.match(await portal.text(), /mdbase/i);

  phase("creating an isolated identity and completing real connector pairing");
  const session = await request("/v1/dev/session", {
    method: "POST",
    body: {
      name: "Container E2E",
      email: "container-e2e@example.com"
    }
  });
  assert.equal(session.response.status, 200);
  const cookie = session.response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "Development login did not set a session cookie");

  const pairing = await request("/v1/pairing-requests", {
    method: "POST",
    body: { connector_name: "Container E2E computer" }
  });
  assert.equal(pairing.response.status, 201);
  assert.match(pairing.body.pairing_secret, /^pair_/);
  assert.equal(
    new URL(pairing.body.verification_uri).origin,
    environment.serverUrl
  );

  const approval = await request(
    `/v1/pairing-requests/${pairing.body.pairing_id}/approve`,
    { method: "POST", cookie }
  );
  assert.equal(approval.response.status, 200);

  const exchange = await request(
    `/v1/pairing-requests/${pairing.body.pairing_id}/exchange`,
    {
      method: "POST",
      authorization: `Bearer ${pairing.body.pairing_secret}`
    }
  );
  assert.equal(exchange.response.status, 200);
  assert.equal(exchange.body.status, "paired");
  assert.match(exchange.body.token, /^con_/);

  const control = await request("/v1/connectors/control", {
    authorization: `Bearer ${exchange.body.token}`
  });
  assert.equal(control.response.status, 200);
  assert.equal(control.body.account.connector_name, "Container E2E computer");
  assert.equal(control.body.account.user_email, "container-e2e@example.com");

  const invalid = await request("/v1/connectors/control", {
    authorization: `Bearer con_not-a-real-credential-0123456789`
  });
  assert.equal(invalid.response.status, 401);

  phase("restarting the packaged server without losing durable credentials");
  await environment.compose(["restart", "connect"]);
  await waitForReady(environment.serverUrl);
  const afterRestart = await request("/v1/connectors/control", {
    authorization: `Bearer ${exchange.body.token}`
  });
  assert.equal(afterRestart.response.status, 200);
  assert.equal(
    afterRestart.body.account.connector_name,
    "Container E2E computer"
  );

  process.stdout.write("Container control-plane end-to-end path passed\n");
} catch (error) {
  await environment.compose(["logs", "--no-color"]).catch(() => {});
  throw error;
} finally {
  await environment.close();
}

function phase(message) {
  process.stdout.write(`\n== ${message}\n`);
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.authorization) {
    headers.set("authorization", options.authorization);
  }
  const response = await fetch(`${environment.serverUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}
