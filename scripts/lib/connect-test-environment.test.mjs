import assert from "node:assert/strict";
import test from "node:test";

import { createConnectEnvironment } from "./connect-environment.mjs";
import { sanitizeProjectName } from "./connect-test-environment.mjs";

test("keeps already-valid Compose project names stable", () => {
  assert.equal(
    sanitizeProjectName("mdbase-connect-e2e-1234-abcd"),
    "mdbase-connect-e2e-1234-abcd"
  );
});

test("preserves uniqueness when long project names share a prefix", () => {
  const shared = `bughunt-${"x".repeat(55)}`;
  const first = sanitizeProjectName(`${shared}-first`);
  const second = sanitizeProjectName(`${shared}-second`);

  assert.notEqual(first, second);
  assert.ok(first.length <= 63);
  assert.ok(second.length <= 63);
  assert.match(first, /^[a-z0-9][a-z0-9_-]*$/);
  assert.match(second, /^[a-z0-9][a-z0-9_-]*$/);
});

test("preserves uniqueness when normalization changes project names", () => {
  assert.notEqual(
    sanitizeProjectName("desktop suite"),
    sanitizeProjectName("desktop-suite")
  );
});

test("configures persistent development environments without ephemeral secrets", async () => {
  const environment = await createConnectEnvironment({
    projectName: "mdbase-connect-dev",
    connectPort: 18787,
    natsPort: 14222,
    build: true,
    disposable: false,
    randomizeCredentials: false,
    environment: {
      PUBLIC_URL: "http://127.0.0.1:18787",
      MDBASE_EDITOR_ORIGIN: "http://127.0.0.1:5173"
    }
  });

  assert.equal(environment.projectName, "mdbase-connect-dev");
  assert.equal(environment.serverUrl, "http://127.0.0.1:18787");
  assert.equal(environment.environment.MDBASE_CONNECT_BIND_PORT, "18787");
  assert.equal(environment.environment.MDBASE_CONNECT_NATS_BIND_PORT, "14222");
  assert.equal(
    environment.environment.MDBASE_EDITOR_ORIGIN,
    "http://127.0.0.1:5173"
  );
  assert.equal(
    Object.hasOwn(environment.environment, "POSTGRES_PASSWORD"),
    Object.hasOwn(process.env, "POSTGRES_PASSWORD")
  );
});

test("configures an isolated embedded hosted provider", async () => {
  const environment = await createConnectEnvironment({
    projectName: "mdbase-connect-hosted-dev",
    connectPort: 18788,
    natsPort: 14223,
    hostedProviderPort: 18790,
    embeddedHostedProvider: true,
    randomizeCredentials: false
  });

  assert.equal(environment.environment.COMPOSE_PROFILES, "hosted");
  assert.equal(
    environment.environment.MDBASE_CONNECT_HOSTED_PROVIDER_URL,
    "http://hosted-provider:8790"
  );
  assert.equal(
    environment.environment.MDBASE_CONNECT_HOSTED_PROVIDER_PUBLIC_URL,
    "http://127.0.0.1:18790"
  );
  assert.equal(environment.environment.MDBASE_CONNECT_HOSTED_COLLECTIONS, "1");
});
