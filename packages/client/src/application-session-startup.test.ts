import { describe, expect, it, vi } from "vitest";
import {
  MdbaseApplicationSession,
  MdbaseConnectError,
  MdbaseMemorySelection,
  operationsForApplicationCapabilities,
  type ConnectRequestOptions,
  type JsonObject,
  type MdbaseAppManifest,
  type MdbaseConnectionInfo
} from "./index.js";
import { MdbaseCollectionClient } from "./advanced.js";
import { connectProblem } from "./errors.js";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** Real public collection/session clients over the same raw-abort seam as fetch. */
function startupFixture(abortError?: Error) {
  const collectionId = "01922222-2222-7222-8222-222222222222";
  const applicationId = "01922222-2222-7222-8222-222222222221";
  const digest = `sha256:${"a".repeat(64)}`;
  const capabilities = { contract_version: 2 as const, required: ["collection.read" as const] };
  const contract = { id: "dev.example.startup", version: "1.0.0", digest };
  // Reproduce the decoded installed v2 bundle used by TaskNotes, including its contract selectors.
  const manifest = {
    manifest_version: 1,
    id: "dev.example.startup",
    name: "Startup regression",
    homepage: "https://startup.example/",
    redirect_uris: ["https://startup.example/callback"],
    requirements: {
      access: "full_collection", capabilities, contracts: [contract],
      configuration: [{ id: "startup", path: "/x-startup/features", predicate: "contains", value: "setup" }]
    },
    provisions: {
      type_packs: [],
      configuration: [{ requirement: "startup", operation: "set_add", path: "/x-startup/features", value: "setup" }]
    }
  } as unknown as MdbaseAppManifest;
  const operations = [...operationsForApplicationCapabilities(capabilities), "assess_collection_setup" as const, "apply_collection_setup" as const];
  let info: MdbaseConnectionInfo = {
    collectionId, displayName: "Relay collection", operations,
    scope: { contracts: [], access: "full_collection" },
    authority: { kind: "connector", durability: "computer" },
    route: "relay", directAccess: "checking"
  };
  const first = deferred<unknown>();
  const replacement = deferred<unknown>();
  const assessing = deferred<AbortSignal>();
  const reassessing = deferred<AbortSignal>();
  let assessments = 0;
  let listener: ((info: MdbaseConnectionInfo | null) => void) | undefined;
  const assessed = {
    valid: true, diagnostics: [], result: {
      status: "current", applicable: true, application_id: manifest.id,
      declaration_digest: digest, provision_digest: digest,
      collection_revision: digest, final_collection_revision: digest,
      configuration: [], type_packs: [], final_resource_revisions: {}, assessment_digest: digest
    }
  };
  const client = new MdbaseCollectionClient<JsonObject>({
    async operation<Result>(operation: string, _input: unknown, options?: ConnectRequestOptions): Promise<Result> {
      if (operation === "describe") return {
        protocol_version: 1, collection_id: collectionId, display_name: info.displayName,
        spec_version: "0.3.0", operations, change_cursor: 0, types: [],
        contracts: [{ contract_type: "record", ...contract, schema: {}, implementations: [] }]
      } as Result;
      if (operation !== "assess_collection_setup") throw new Error(`Unexpected operation: ${operation}`);
      const signal = options!.signal!;
      if (++assessments === 1) {
        signal.addEventListener("abort", () => first.reject(abortError ?? signal.reason), { once: true });
        assessing.resolve(signal);
        return await first.promise as Result;
      }
      reassessing.resolve(signal);
      return await replacement.promise as Result;
    }
  });
  const connection = Object.assign(client, {
    collectionId, operations,
    info: () => info,
    authorizationCapabilities: () => ({ authorized: true, sufficient: true, collectionId, grantedOperations: operations, missingOperations: [] }),
    onConnectionChange: (next: typeof listener) => { listener = next; return () => { listener = undefined; }; }
  });
  const selection = new MdbaseMemorySelection();
  selection.select(collectionId);
  const facade = {
    register: async () => ({ ok: true, value: { id: applicationId, family_identity: `bundle:${manifest.id}`, manifest_digest: "a".repeat(64), requirements: manifest.requirements } }),
    manifest: async () => ({ ok: true, value: manifest }),
    connections: () => [info], connection: () => connection,
    connectionApplicationId: () => applicationId,
    onConnectionsChange: () => () => undefined
  };
  const session = new MdbaseApplicationSession(facade as never, { selection, autoSelect: "never" });
  return {
    session, connection, selection, manifest, first, replacement, assessing, reassessing, assessed,
    assessmentCount: () => assessments,
    changeRoute: (direct: boolean) => {
      info = { ...info, directAccess: direct ? "available" : "unavailable", route: direct ? "direct" : "relay" };
      listener!(info);
    },
    cleanup: () => { first.resolve(assessed); replacement.resolve(assessed); session.destroy(); }
  };
}

describe("startup verification generations", () => {
  it.each([
    ["relay", false, false], ["direct", true, false], ["canonical declaration", false, true]
  ] as const)("keeps replacement verification alive when an obsolete assessment is cancelled (%s)", async (_label, direct, canonical) => {
    const fixture = startupFixture();
    if (canonical) fixture.manifest.requirements!.contracts = [];
    try {
      // Attach a handler before the route event makes a raw AbortError reject.
      const started = fixture.session.start().then(value => ({ value }), error => ({ error }));
      await fixture.assessing.promise;
      fixture.changeRoute(direct);
      const replacementSignal = await fixture.reassessing.promise;
      // Older SDKs did not abort the first assessment; let that stale response settle too.
      fixture.first.resolve(fixture.assessed);
      expect(await started).toMatchObject({ value: { ok: true } });
      expect(fixture.session.connection()).toBe(fixture.connection);
      expect(replacementSignal.aborted).toBe(false);
      expect(fixture.session.getSnapshot()).toMatchObject({ status: "checking_setup" });
      fixture.replacement.resolve(fixture.assessed);
      await vi.waitFor(() => expect(fixture.session.getSnapshot()).toMatchObject({ status: "ready", verification: "verified" }));
      expect(fixture.assessmentCount()).toBe(2);
      expect(fixture.session.connection()).toBe(fixture.connection);
    } finally { fixture.cleanup(); }
  });

  it("clearing selection during assessment remains unselected, not a failed startup", async () => {
    const fixture = startupFixture();
    try {
      const started = fixture.session.start().then(value => ({ value }), error => ({ error }));
      const signal = await fixture.assessing.promise;
      fixture.selection.select(null);
      fixture.first.resolve(fixture.assessed);
      expect(await started).toMatchObject({ value: { ok: true, value: { status: "unselected" } } });
      expect(signal.aborted).toBe(true);
      expect(fixture.session.connection()).toBeNull();
      expect(fixture.assessmentCount()).toBe(1);
    } finally { fixture.cleanup(); }
  });

  it.each([
    new Error("Broken assessment invariant"), new DOMException("An unrelated request aborted", "AbortError")
  ])("still rejects a non-owned fault from a superseded assessment (%s)", async fault => {
    const fixture = startupFixture(fault);
    try {
      const started = fixture.session.start().then(value => ({ value }), error => ({ error }));
      await fixture.assessing.promise;
      fixture.changeRoute(false);
      expect(await started).toEqual({ error: fault });
      expect(fixture.session.connection()).toBeNull();
      expect(fixture.session.getSnapshot().status).toBe("not_started");
    } finally { fixture.cleanup(); }
  });

  it("still rejects a genuine current assessment exception", async () => {
    const fixture = startupFixture();
    const fault = new Error("Broken active assessment");
    try {
      const started = fixture.session.start().then(value => ({ value }), error => ({ error }));
      await fixture.assessing.promise;
      fixture.first.reject(fault);
      expect(await started).toEqual({ error: fault });
      expect(fixture.session.getSnapshot().status).toBe("not_started");
    } finally { fixture.cleanup(); }
  });

  it.each(["temporarily_unavailable", "operation_cancelled"] as const)("keeps a current typed assessment failure visible (%s)", async code => {
    const fixture = startupFixture();
    try {
      const started = fixture.session.start();
      await fixture.assessing.promise;
      fixture.first.reject(new MdbaseConnectError(connectProblem(code, "Assessment failed")));
      expect(await started).toMatchObject({ ok: true, value: { status: "blocked", problem: { code } } });
      expect(fixture.session.getSnapshot()).toMatchObject({ status: "blocked", problem: { code } });
      expect(fixture.assessmentCount()).toBe(1);
    } finally { fixture.cleanup(); }
  });
});
