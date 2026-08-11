import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createHostedSnapshotLoader } = require("../dist/main/hosted-snapshot.js");

test("concurrent hosted snapshot callers share one main-process request", async () => {
  let requestCount = 0;
  let resolveRequest;
  const snapshot = {
    online: true,
    hosted_collections_available: true,
    hosted_collections: [],
    grants: [],
    pending_authorizations: []
  };
  const loadHostedSnapshot = createHostedSnapshotLoader(() => {
    requestCount += 1;
    if (requestCount > 1) return Promise.resolve(snapshot);
    return new Promise((resolve) => { resolveRequest = resolve; });
  });

  const first = loadHostedSnapshot();
  const second = loadHostedSnapshot();
  assert.equal(first, second);
  assert.equal(requestCount, 1);

  resolveRequest(snapshot);
  assert.deepEqual(await Promise.all([first, second]), [snapshot, snapshot]);
  assert.equal(requestCount, 1);

  assert.equal(await loadHostedSnapshot(), snapshot);
  assert.equal(requestCount, 2);
});

test("credential-store degradation becomes a typed offline snapshot with a retry cooldown", async () => {
  const error = Object.assign(new Error("Login keyring is locked."), {
    code: "credential_store_unavailable"
  });
  let currentTime = 1_000;
  let requestCount = 0;
  const snapshot = {
    online: true,
    hosted_collections_available: true,
    hosted_collections: [{ id: "collection" }],
    grants: [],
    pending_authorizations: []
  };
  const loadHostedSnapshot = createHostedSnapshotLoader(async () => {
    requestCount += 1;
    if (requestCount === 1) throw error;
    return snapshot;
  }, {
    retryAfterMs: 30_000,
    now: () => currentTime
  });

  assert.deepEqual(await loadHostedSnapshot(), {
    online: false,
    hosted_collections_available: false,
    hosted_collections: [],
    grants: [],
    pending_authorizations: []
  });
  assert.equal(requestCount, 1);

  currentTime += 29_999;
  assert.equal((await loadHostedSnapshot()).online, false);
  assert.equal(requestCount, 1);

  currentTime += 1;
  assert.equal(await loadHostedSnapshot(), snapshot);
  assert.equal(requestCount, 2);
});

test("hosted snapshot preserves successes and unrelated failures", async () => {
  const snapshot = {
    online: true,
    hosted_collections_available: true,
    hosted_collections: [{ id: "collection" }],
    grants: [],
    pending_authorizations: []
  };
  const loadSuccess = createHostedSnapshotLoader(async () => snapshot);
  assert.equal(await loadSuccess(), snapshot);

  const failure = new Error("Connect service unavailable");
  let requestCount = 0;
  const loadFailure = createHostedSnapshotLoader(async () => {
    requestCount += 1;
    throw failure;
  });
  await assert.rejects(loadFailure(), (error) => error === failure);
  await assert.rejects(loadFailure(), (error) => error === failure);
  assert.equal(requestCount, 2);
});
