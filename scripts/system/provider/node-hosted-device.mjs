import assert from "node:assert/strict";
import { MdbaseConnect } from "../../../packages/client/dist/index.js";
import {
  MemoryApplicationIdentityStore,
  MemoryGrantKeyStore
} from "../../../packages/client/dist/crypto-entry.js";
import { requireConnectSuccess } from "../../../packages/testing/dist/index.js";

// Real Node SDK/device-flow traffic to the disposable control plane/provider:
// no browser fetch wrapper may synthesize an Origin header for these requests.
export async function nodeHostedDeviceE2E({ controlUrl, cookie, collectionId, controlRequest }) {
  assert.equal(typeof window, "undefined");
  const manager = new MdbaseConnect({
    serverUrl: controlUrl,
    manifest: {
      manifest_version: 1,
      distribution: "portable",
      id: "dev.mdbase.node-hosted-e2e",
      name: "Node Hosted E2E",
      project_url: "https://apps.example/node-hosted-e2e",
      requirements: {
        access: "full_collection",
        contracts: [],
        collection_kind: "hosted",
        capabilities: {
          contract_version: 2,
          required: ["collection.read", "records.create", "records.delete", "offline.replica"],
          optional: []
        }
      }
    },
    keyStore: new MemoryGrantKeyStore(),
    identityStore: new MemoryApplicationIdentityStore()
  });
  const controller = new AbortController();
  const device = Promise.withResolvers();
  const authorization = manager.authorize({
    capabilities: ["collection.read", "records.create", "records.delete", "offline.replica"],
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
    openVerification() {},
    onDeviceCode(details) { device.resolve(details); }
  });
  try {
    const details = await Promise.race([
      device.promise,
      authorization.then((outcome) => {
        throw new Error(`Node authorization ended before a device code: ${outcome.ok ? "connected" : outcome.problem.code}`);
      })
    ]);
    const claimed = await controlRequest(controlUrl, "/v1/device-authorization-requests/lookup", cookie, {
      method: "POST", body: { user_code: details.userCode }
    });
    await controlRequest(controlUrl, `/v1/authorization-requests/${claimed.request_id}/approve`, cookie, {
      method: "POST",
      body: {
        collection_id: collectionId,
        operations: [
          "describe", "changes", "read", "query", "list_views", "execute_view",
          "read_view_source", "validate", "read_type", "create", "delete", "sync"
        ]
      }
    });
    const { connection } = requireConnectSuccess(await authorization);
    assert.equal(connection.collectionId, collectionId);
    const path = "node-hosted-device-e2e.md";
    requireConnectSuccess(await connection.create({
      path, frontmatter: { title: "Created by the Node device-flow SDK" }, body: "No Origin header."
    }));
    const record = requireConnectSuccess(await connection.read({ path }));
    assert.equal(record.frontmatter.title, "Created by the Node device-flow SDK");
    assert.equal(record.body.trimEnd(), "No Origin header.");
    const sync = connection.sync();
    assert.ok(sync);
    assert.equal((await sync.transport.openSession()).mode, "read_write");
    requireConnectSuccess(await connection.delete({ path }));
    assert.equal(connection.pendingMutations().length, 0);
  } finally {
    controller.abort();
    await authorization;
    await manager.forgetAll();
  }
}
