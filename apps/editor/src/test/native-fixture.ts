import { connect, MdbasePeopleClient, type Mdbase, type MdbaseApplicationConnection, type MdbaseApplicationEntry, type MdbaseApplicationSnapshot, type MdbaseClient, type MdbaseSnapshot } from "@mdbase-dev/sdk";
import { createApplicationFixture, MemoryReplica, type MemoryReplicaOptions } from "@mdbase-dev/sdk/testing";
import { vi } from "vitest";
import manifest from "../../public/.well-known/mdbase-app.json";

// SDK-owned public fixture supplies lifecycle/readiness metadata. Data is the
// real public SDK client over MemoryReplica. Neither is native/LAB evidence.
const owned: Array<{ close(): void }> = [];

export function closeNativeFixtures(): void {
  for (const item of owned.splice(0).reverse()) item.close();
}

const facet = { checking: false, assessment: null, problem: null };
export const signedOut: MdbaseApplicationSnapshot = {
  status: "signed_out", signIn: null, collections: [], selectedCollectionId: null, problem: null, timing: null,
  selection: { state: "none", requested: { collectionId: null, source: "none", displayName: null, approved: false }, usable: null, problem: null },
  readiness: { ...facet, facets: { capabilities: facet, contracts: facet, configuration: facet, files: facet, people: facet, notifications: facet } }
};
export const paired: NonNullable<MdbaseApplicationSnapshot["signIn"]> = {
  requestId: "fixture-request", installationId: "fixture-installation", deviceId: "fixture-device", appId: "fixture-app", kind: "app-runtime",
  verificationUri: "https://mdbase.test/approve", state: "paired", accountId: "fixture-account", accountProvider: "github", accountLogin: "editor-user",
  collectionIds: [], createCollections: false, requestedCreateCollections: false
};

/** Test-only: the SDK fixture's application behind the `createMdbase` front door,
 * mirroring how `createMdbase` maps each call onto the application. */
export function fixtureMdbase(entry: MdbaseApplicationEntry): Mdbase {
  const app = entry.application();
  const view = () => app.getSnapshot() as MdbaseSnapshot;
  const settle = async (pending: Promise<unknown>) => { await pending; return view(); };
  return {
    getSnapshot: view, subscribe: (listener) => app.subscribe(listener),
    start: (options) => settle(app.start(options)), signIn: (options) => settle(app.authorize(options)),
    addCollection: (options) => settle(app.approve(null, options)), approve: (id, options) => settle(app.approve(id, options)),
    select: (id, options) => settle(app.select(id, options)), chooseAnother: (options) => settle(app.chooseAnother(options)),
    refreshCollectionList: (options) =>
      app.refreshCollectionList ? settle(app.refreshCollectionList(options)) : Promise.reject(new Error("No refreshCollectionList")),
    reauthorize: (options) => settle(app.reauthorize(options)),
    configure: (options) => settle(app.configure(options)),
    forget: (id, options) => settle(app.forget(id, options)), deleteCollection: (id, options) => settle(app.deleteCollection(id, options)),
    requestAccess: (request, options) => app.requestAccess(request, options), assess: (options) => app.assess(options),
    setup: { plan: (options) => app.setup.plan(options), apply: async (plan, options) => ({ outcome: "applied", snapshot: await settle(app.setup.apply(plan, options)) }) },
    connection: (id) => entry.connection(id), setForeground: (active) => app.setForeground(active),
    signOut: (options) => app.signOut ? settle(app.signOut(options)) : Promise.reject(new Error("No signOut")), close: () => app.close(), application: app
  };
}

export function applicationFixture(initial: Partial<MdbaseApplicationSnapshot> = {}) {
  const fixture = createApplicationFixture({
    declaration: { id: "editor.fixture", name: "Editor fixture", origin: "https://editor.mdbase.dev", environment: "lab", manifest },
    connections: [],
    initialSnapshot: { ...signedOut, ...initial }
  });
  owned.push(fixture.controls);
  const application = fixture.entry.application();
  const publish = (patch: Partial<MdbaseApplicationSnapshot>) => fixture.controls.publishSnapshot({ ...application.getSnapshot(), ...patch });
  fixture.controls.setHandler("start", () => {
    const current = application.getSnapshot();
    return current.status === "not_started" ? { ...current, status: "signed_out" } : current;
  });
  return { entry: fixture.entry, mdbase: fixtureMdbase(fixture.entry), application, publish, controls: fixture.controls };
}

export async function nativeConnection(options: MemoryReplicaOptions = {}) {
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

/** A selected, READY fixture scope bound to one real native connection. */
export async function readyFixture(options: MemoryReplicaOptions = {}, seed?: (replica: MemoryReplica) => void) {
  const native = await nativeConnection(options);
  seed?.(native.replica);
  const app = applicationFixture({
    status: "ready", signIn: paired, selectedCollectionId: native.replica.collection,
    collections: [{ collectionId: native.replica.collection, displayName: "Notes", role: "owner" }],
    selection: { state: "usable", requested: { collectionId: native.replica.collection, source: "user", displayName: "Notes", approved: true },
      usable: { collectionId: native.replica.collection, displayName: "Notes", role: "owner" }, problem: null }
  });
  app.publish({ readiness: { ...app.application.getSnapshot().readiness, assessment: { status: "ready", problem: null } } });
  app.controls.setConnections([native.connection]);
  return { ...native, ...app };
}
