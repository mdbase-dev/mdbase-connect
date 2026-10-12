import { connect, MdbasePeopleClient, type MdbaseApplicationConnection, type MdbaseClient } from "@mdbase-dev/sdk";
import { createTestApp, MemoryReplica, type MemoryReplicaOptions, type TestAppCollection, type TestAppOptions } from "@mdbase-dev/sdk/testing";
import { vi } from "vitest";
import manifest from "../../public/.well-known/mdbase-app.json";

// The SDK's test app supplies the front door and lifecycle snapshots. Data is
// the real public SDK client over MemoryReplica. Neither is native/LAB evidence.
const owned: Array<{ close(): unknown }> = [];

export function closeNativeFixtures(): void {
  for (const item of owned.splice(0).reverse()) void item.close();
}

export async function testApp(options: Omit<TestAppOptions, "declaration"> = {}) {
  const app = await createTestApp({
    declaration: { id: "editor.fixture", name: "Editor fixture", origin: "https://editor.mdbase.dev", environment: "lab", manifest },
    ...options
  });
  owned.push(app);
  const calls = (action: string) => app.controls.observedActions().filter((call) => call.action === action);
  return { ...app, calls };
}

async function nativeConnection(options: MemoryReplicaOptions = {}) {
  const replica = new MemoryReplica({ confirmDelayMs: 0, ...options });
  const client: MdbaseClient = await connect({ connector: replica.connector(), app: { name: "editor-native-test", version: "test" }, reconnect: false });
  owned.push(client);
  const metadata = vi.fn(async () => { throw new Error("No inferred metadata permission"); });
  const current = vi.fn(() => true);
  const connection: MdbaseApplicationConnection = {
    id: replica.collection, displayName: "Notes",
    scope: { account: "fixture-account", installation: "fixture-installation", collection: replica.collection },
    generation: "fixture-generation", records: client, files: client.files,
    people: new MdbasePeopleClient(client, { collection: replica.collection, request: metadata, isCurrent: current }),
    isCurrent: current
  };
  return { replica, client, connection, metadata, current };
}

/** A ready test app whose "Notes" collection is one real native connection
 * with controllable currentness and metadata. */
export async function readyFixture(options: MemoryReplicaOptions = {}, seed?: (replica: MemoryReplica) => void, others: readonly TestAppCollection[] = []) {
  const native = await nativeConnection(options);
  seed?.(native.replica);
  const app = await testApp({ collections: [{ id: native.replica.collection, name: "Notes" }, ...others] });
  app.controls.setConnections([native.connection]);
  return { ...app, ...native };
}
