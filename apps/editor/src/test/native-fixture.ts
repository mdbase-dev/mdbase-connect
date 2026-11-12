import { MdbasePeopleClient, type MdbaseApplicationConnection } from "@mdbase-dev/sdk";
import { createApplicationFixture, createTestApp, MemoryReplica, type MemoryReplicaOptions, type TestAppCollection, type TestAppOptions } from "@mdbase-dev/sdk/testing";
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
  const client = await replica.client();
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

/** Work before connecting: an application fixture with a "Notes" collection and
 * the app's unsynced collection, both real native connections over
 * MemoryReplica, behind the same front door `createMdbase` returns. */
export async function unsyncedFixture(phase: "signed_out" | "ready", seed?: (unsynced: MemoryReplica) => void) {
  const notes = await nativeConnection();
  const unsynced = await nativeConnection();
  seed?.(unsynced.replica);
  // A well-formed snapshot for the Notes collection: ready, or signed out.
  const template = await testApp({ collections: [{ id: notes.replica.collection, name: "Notes" }], phase });
  const fixture = createApplicationFixture({ declaration: template.controls.declaration, connections: [notes.connection],
    initialSnapshot: template.mdbase.getSnapshot(), unsynced: unsynced.connection });
  owned.push({ close: () => fixture.controls.close() });
  const mdbase = fixture.mdbase;
  const calls = (action: string) => fixture.controls.observedActions().filter((entry) => entry.action === action);
  /** What the SDK reports once something was saved in the unsynced collection. */
  const markWork = () => fixture.controls.publishSnapshot({ ...mdbase.getSnapshot(), unsyncedWork: { since: 1_762_000_000_000 } });
  return { mdbase, controls: fixture.controls, notes, unsynced, calls, markWork };
}
