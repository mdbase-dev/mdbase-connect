import { describe, expect, it, vi } from "vitest";
import type { MdbaseAppManifest } from "@mdbase-dev/connect-protocol";
import {
  MdbaseApplicationSession,
  MdbaseConnectError,
  MdbaseMemorySelection,
  MdbaseMemoryVerificationStore,
  type CollectionSetupAssessment,
  type TypePackAssessment
} from "./index.js";
import { connectProblem } from "./errors.js";
import { connectFailure, connectSuccess } from "./outcomes.js";

const collectionId = "00000000-0000-0000-0000-000000000042";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => { resolve = done; });
  return { promise, resolve };
}

function setupAssessment(applicationId = "dev.mdbase.session-test"): CollectionSetupAssessment {
  return {
    status: "provision",
    applicable: true,
    applicationId,
    declarationDigest: `sha256:${"a".repeat(64)}`,
    provisionDigest: `sha256:${"b".repeat(64)}`,
    collectionRevision: `sha256:${"c".repeat(64)}`,
    finalCollectionRevision: `sha256:${"d".repeat(64)}`,
    configuration: [],
    typePacks: [],
    finalResourceRevisions: {},
    assessmentDigest: `sha256:${"e".repeat(64)}`
  };
}

function manifest(overrides: Partial<MdbaseAppManifest> = {}): MdbaseAppManifest {
  return {
    manifest_version: 1,
    id: "dev.mdbase.session-test",
    name: "Session test",
    homepage: "https://session.example/",
    redirect_uris: ["https://session.example/callback"],
    requirements: {
      access: "full_collection",
      contracts: [],
      capabilities: {
        contract_version: 2,
        required: ["collection.read"],
        optional: ["records.edit"]
      }
    },
    ...overrides
  } as MdbaseAppManifest;
}

function setupManifest(): MdbaseAppManifest {
  return manifest({
    requirements: {
      access: "full_collection",
      contracts: [],
      capabilities: { contract_version: 2, required: [] },
      configuration: [{
        id: "session-test",
        path: "/x-session/features",
        predicate: "contains",
        value: "setup"
      }]
    },
    provisions: {
      type_packs: [],
      configuration: [{
        requirement: "session-test",
        operation: "set_add",
        path: "/x-session/features",
        value: "setup"
      }]
    }
  });
}

function connection(
  operations = [
    "describe",
    "changes",
    "read",
    "query",
    "list_views",
    "execute_view",
    "read_view_source",
    "validate",
    "read_type",
    "update",
    "rename"
  ],
  assessment?: CollectionSetupAssessment,
  access: "contract" | "full_collection" = "full_collection"
) {
  let currentAssessment = assessment;
  const applyCollectionSetup = vi.fn(async () => {
    if (currentAssessment) currentAssessment = { ...currentAssessment, status: "current" };
    return connectSuccess({
      assessment: currentAssessment!,
      receipt: {
        applicationId: currentAssessment!.applicationId,
        declarationDigest: currentAssessment!.declarationDigest,
        provisionDigest: currentAssessment!.provisionDigest,
        assessmentDigest: currentAssessment!.assessmentDigest,
        collectionRevision: currentAssessment!.finalCollectionRevision,
        configuration: [],
        typePacks: [],
        cleanupDeferred: false
      }
    });
  });
  const value = {
    collectionId,
    operations,
    info: () => ({
      collectionId,
      displayName: "Test collection",
      operations,
      scope: { contracts: [], access },
      authority: { kind: "hosted", durability: "provider" },
      route: "remote",
      directAccess: "disabled"
    }),
    authorizationCapabilities: (required: string[]) => ({
      authorized: true,
      sufficient: required.every((operation) => operations.includes(operation)),
      collectionId,
      grantedOperations: operations,
      missingOperations: required.filter((operation) => !operations.includes(operation))
    }),
    onConnectionChange: () => () => undefined,
    forget: vi.fn(),
    assessCollectionSetup: vi.fn(async () => connectSuccess(currentAssessment!)),
    applyCollectionSetup
  };
  return { value, applyCollectionSetup };
}

function connectFixture(
  declaration: MdbaseAppManifest,
  grantedOperations?: string[],
  assessment?: CollectionSetupAssessment,
  access?: "contract" | "full_collection"
) {
  const connected = connection(grantedOperations, assessment, access);
  const authorize = vi.fn(async () => connectSuccess({ kind: "redirect", url: "https://connect.example" }));
  const register = vi.fn(async () => connectSuccess({
    id: "01922222-2222-7222-8222-222222222222",
    family_identity: `bundle:${declaration.id}`,
    manifest_digest: "ab".repeat(32),
    name: declaration.name,
    requirements: declaration.requirements ?? { contracts: [] }
  }));
  const loadManifest = vi.fn(async () => connectSuccess(declaration));
  const removeConnectionsListener = vi.fn();
  const onConnectionsChange = vi.fn((listener: (connections: unknown[]) => void) => {
    listener([connected.value.info()]);
    return removeConnectionsListener;
  });
  const facade = {
    register,
    manifest: loadManifest,
    connections: () => [connected.value.info()],
    connection: (id: string) => id === collectionId ? connected.value : null,
    unavailableReason: () => null,
    connectionApplicationId: () => "01922222-2222-7222-8222-222222222222",
    onConnectionsChange,
    authorize,
    completeAuthorization: vi.fn()
  };
  return {
    facade,
    authorize,
    register,
    loadManifest,
    onConnectionsChange,
    removeConnectionsListener,
    ...connected
  };
}

describe("MdbaseApplicationSession", () => {
  it("coalesces concurrent and repeated starts into one owned base session", async () => {
    const fixture = connectFixture(manifest());
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });

    const [first, second] = await Promise.all([session.start(), session.start()]);
    const repeated = await session.start();

    expect(first).toBe(second);
    expect(repeated.ok).toBe(true);
    expect(fixture.register).toHaveBeenCalledOnce();
    expect(fixture.loadManifest).toHaveBeenCalledOnce();
    expect(fixture.onConnectionsChange).toHaveBeenCalledOnce();
  });

  it("lets one concurrent caller cancel without abandoning another caller's start", async () => {
    const fixture = connectFixture(manifest());
    const successfulRegistration = fixture.register.getMockImplementation()!;
    let releaseRegistration!: (value: Awaited<ReturnType<typeof successfulRegistration>>) => void;
    const registrationGate = new Promise<Awaited<ReturnType<typeof successfulRegistration>>>(
      (resolve) => { releaseRegistration = resolve; }
    );
    fixture.register.mockImplementationOnce(() => registrationGate);
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });
    const controller = new AbortController();

    const cancelled = session.start({ signal: controller.signal, timeoutMs: null });
    const continuing = session.start({ timeoutMs: null });
    controller.abort("framework remount");
    await expect(cancelled).resolves.toMatchObject({
      ok: false,
      problem: { code: "operation_cancelled", operation_outcome: "not_sent" }
    });
    releaseRegistration(await successfulRegistration());

    await expect(continuing).resolves.toMatchObject({ ok: true });
    expect(fixture.register).toHaveBeenCalledOnce();
    expect(fixture.onConnectionsChange).toHaveBeenCalledOnce();
  });

  it("detaches a cancelled black-hole start and can restart without stale ownership", async () => {
    const fixture = connectFixture(manifest());
    fixture.register.mockImplementationOnce(() => new Promise(() => undefined));
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });
    const controller = new AbortController();

    const abandoned = session.start({ signal: controller.signal, timeoutMs: null });
    controller.abort("strict mode cleanup");
    await expect(abandoned).resolves.toMatchObject({
      ok: false,
      problem: { code: "operation_cancelled", operation_outcome: "not_sent" }
    });

    await expect(session.start()).resolves.toMatchObject({ ok: true });
    expect(fixture.register).toHaveBeenCalledTimes(2);
    expect(fixture.onConnectionsChange).toHaveBeenCalledOnce();
  });

  it("destroys owned listeners and makes destroy terminal", async () => {
    const fixture = connectFixture(manifest());
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });
    const staleListener = vi.fn();
    session.subscribe(staleListener);
    await session.start();
    const callsBeforeDestroy = staleListener.mock.calls.length;

    session.destroy();
    const restarted = await session.start();

    expect(fixture.removeConnectionsListener).toHaveBeenCalledOnce();
    expect(fixture.onConnectionsChange).toHaveBeenCalledOnce();
    expect(staleListener).toHaveBeenCalledTimes(callsBeforeDestroy + 1);
    expect(fixture.register).toHaveBeenCalledOnce();
    expect(restarted).toMatchObject({ ok: false, problem: { code: "session_destroyed" } });
    expect(session.getSnapshot()).toEqual({ status: "destroyed", connections: [] });
  });

  it.each(["authorize", "ensureCapabilities"] as const)(
    "aborts and fences in-flight %s publication on destroy",
    async (method) => {
      const fixture = connectFixture(manifest(), ["describe", "read"]);
      const pending = deferred<ReturnType<typeof connectSuccess>>();
      let signal: AbortSignal | undefined;
      fixture.authorize.mockImplementationOnce((options) => {
        signal = options?.signal;
        return pending.promise as never;
      });
      const selection = new MdbaseMemorySelection();
      const finishAuthorization = vi.spyOn(selection, "finishAuthorization");
      const session = new MdbaseApplicationSession(fixture.facade as never, { selection });
      await session.start();

      const operation = method === "authorize"
        ? session.authorize("choose", { timeoutMs: null })
        : session.ensureCapabilities(["records.edit"], { timeoutMs: null });
      await vi.waitFor(() => expect(signal).toBeInstanceOf(AbortSignal));
      session.destroy();
      expect(signal?.aborted).toBe(true);
      pending.resolve(connectSuccess({ kind: "connected", connection: fixture.value }));

      await expect(operation).resolves.toMatchObject({ problem: { code: "session_destroyed" } });
      expect(session.getSnapshot()).toEqual({ status: "destroyed", connections: [] });
      expect(finishAuthorization).not.toHaveBeenCalled();
    }
  );

  it("aborts and fences an in-flight callback on destroy", async () => {
    const fixture = connectFixture(manifest());
    const pending = deferred<ReturnType<typeof connectSuccess>>();
    let signal: AbortSignal | undefined;
    fixture.facade.completeAuthorization.mockImplementationOnce((_url, options) => {
      signal = options?.signal;
      return pending.promise as never;
    });
    const selection = new MdbaseMemorySelection();
    const finishAuthorization = vi.spyOn(selection, "finishAuthorization");
    const session = new MdbaseApplicationSession(fixture.facade as never, { selection });
    await session.start();

    const operation = session.handleAuthorizationCallback(
      "https://session.example/callback?code=secret&state=secret",
      { timeoutMs: null }
    );
    await vi.waitFor(() => expect(signal).toBeInstanceOf(AbortSignal));
    session.destroy();
    expect(signal?.aborted).toBe(true);
    pending.resolve(connectSuccess({ connection: fixture.value }));

    await expect(operation).resolves.toMatchObject({ problem: { code: "session_destroyed" } });
    expect(session.getSnapshot()).toEqual({ status: "destroyed", connections: [] });
    expect(finishAuthorization).not.toHaveBeenCalled();
  });

  it("aborts and fences collection setup apply without masking an unknown mutation outcome", async () => {
    const declaration = setupManifest();
    const assessment = setupAssessment(declaration.id);
    const fixture = connectFixture(
      declaration,
      ["describe", "read", "assess_collection_setup", "apply_collection_setup"],
      assessment
    );
    const pending = deferred<ReturnType<typeof connectSuccess>>();
    let signal: AbortSignal | undefined;
    fixture.applyCollectionSetup.mockImplementationOnce((_input, options) => {
      signal = options?.signal;
      return pending.promise as never;
    });
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });
    await session.start();

    const operation = session.applyCollectionSetup({ timeoutMs: null });
    await vi.waitFor(() => expect(signal).toBeInstanceOf(AbortSignal));
    session.destroy();
    expect(signal?.aborted).toBe(true);
    pending.resolve(connectFailure(connectProblem(
      "operation_outcome_unknown",
      "The setup may have been applied.",
      { operationOutcome: "unknown" }
    )) as never);

    await expect(operation).resolves.toMatchObject({
      problem: { code: "operation_outcome_unknown", operation_outcome: "unknown" }
    });
    expect(fixture.applyCollectionSetup).toHaveBeenCalledOnce();
    expect(session.getSnapshot()).toEqual({ status: "destroyed", connections: [] });
    expect(fixture.value.assessCollectionSetup).toHaveBeenCalledOnce();
  });

  it("publishes start failures with the original typed problem and retries", async () => {
    const fixture = connectFixture(manifest());
    fixture.register.mockResolvedValueOnce(connectFailure(connectProblem(
      "temporarily_unavailable",
      "Registration is unavailable."
    )));
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });

    expect(session.getSnapshot()).toEqual({ status: "not_started", connections: [] });
    const first = await session.start();
    expect(first).toMatchObject({ ok: false, problem: { code: "temporarily_unavailable" } });
    expect(session.getSnapshot()).toMatchObject({
      status: "start_failed",
      problem: { code: "temporarily_unavailable", message: "Registration is unavailable." }
    });

    await expect(session.start()).resolves.toMatchObject({ ok: true });
    expect(fixture.register).toHaveBeenCalledTimes(2);
  });

  it("returns lifecycle outcomes without synchronously throwing", async () => {
    const fixture = connectFixture(manifest());
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });

    expect(session.select(collectionId)).toMatchObject({ problem: { code: "session_not_started" } });
    expect(session.clearSelection()).toMatchObject({ problem: { code: "session_not_started" } });
    expect(session.forget(collectionId)).toMatchObject({ problem: { code: "session_not_started" } });
    const authorization = session.authorize("choose");
    const callback = session.handleAuthorizationCallback("https://session.example/callback?code=x&state=y");
    const capabilities = session.ensureCapabilities(["collection.read"]);
    const setup = session.applyCollectionSetup();

    await expect(authorization).resolves.toMatchObject({ problem: { code: "session_not_started" } });
    await expect(callback).resolves.toMatchObject({ problem: { code: "session_not_started" } });
    await expect(capabilities).resolves.toMatchObject({ problem: { code: "session_not_started" } });
    await expect(setup).resolves.toMatchObject({ problem: { code: "session_not_started" } });
  });

  it("waits for an in-progress start before handling a callback", async () => {
    const fixture = connectFixture(manifest());
    const successfulRegistration = fixture.register.getMockImplementation()!;
    let releaseRegistration!: (value: Awaited<ReturnType<typeof successfulRegistration>>) => void;
    fixture.register.mockImplementationOnce(() => new Promise((resolve) => {
      releaseRegistration = resolve;
    }));
    fixture.facade.completeAuthorization.mockResolvedValue(connectSuccess({
      connection: fixture.value,
      returnTo: "/"
    }));
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });

    const starting = session.start({ timeoutMs: null });
    expect(session.getSnapshot().status).toBe("starting");
    const callback = session.handleAuthorizationCallback(
      "https://session.example/callback?code=x&state=y",
      { timeoutMs: null }
    );
    expect(fixture.facade.completeAuthorization).not.toHaveBeenCalled();
    releaseRegistration(await successfulRegistration());

    await expect(starting).resolves.toMatchObject({ ok: true });
    await expect(callback).resolves.toMatchObject({ ok: true });
    expect(fixture.facade.completeAuthorization).toHaveBeenCalledOnce();
  });

  it("returns a typed timeout and abandons shared startup after its last waiter", async () => {
    const fixture = connectFixture(manifest());
    fixture.register.mockImplementationOnce(() => new Promise(() => undefined));
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });

    await expect(session.start({ timeoutMs: 1 })).resolves.toMatchObject({
      ok: false,
      problem: { code: "timeout", operation_outcome: "not_sent" }
    });
    expect(session.getSnapshot().status).toBe("not_started");
  });

  it("abandons provisional setup verification and fences stale publications after timeout", async () => {
    vi.useFakeTimers();
    const declaration = setupManifest();
    const fixture = connectFixture(
      declaration,
      ["describe", "read", "assess_collection_setup", "apply_collection_setup"]
    );
    let resolveAssessment!: (value: never) => void;
    fixture.value.assessCollectionSetup.mockImplementationOnce(() => new Promise((resolve) => {
      resolveAssessment = resolve as (value: never) => void;
    }));
    const selection = new MdbaseMemorySelection();
    const select = vi.spyOn(selection, "select");
    const session = new MdbaseApplicationSession(fixture.facade as never, { selection });

    const starting = session.start({ timeoutMs: 1_000 });
    await vi.waitFor(() => expect(fixture.value.assessCollectionSetup).toHaveBeenCalledOnce());
    expect(session.getSnapshot().status).toBe("checking_setup");
    expect(session.select(collectionId)).toMatchObject({ problem: { code: "session_starting" } });
    expect(session.clearSelection()).toMatchObject({ problem: { code: "session_starting" } });
    expect(session.forget(collectionId)).toMatchObject({ problem: { code: "session_starting" } });
    expect(fixture.value.forget).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(starting).resolves.toMatchObject({ problem: { code: "timeout" } });
    expect(session.getSnapshot().status).toBe("not_started");
    expect(fixture.removeConnectionsListener).toHaveBeenCalledOnce();

    resolveAssessment(connectSuccess({}) as never);
    await vi.runAllTimersAsync();
    expect(session.getSnapshot().status).toBe("not_started");
  });

  it("returns the exact startup problem from every lifecycle-dependent method", async () => {
    const fixture = connectFixture(manifest());
    fixture.register.mockResolvedValueOnce(connectFailure(connectProblem(
      "temporarily_unavailable",
      "Registration is unavailable."
    )));
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });
    await session.start();
    const snapshot = session.getSnapshot();
    if (snapshot.status !== "start_failed") throw new Error("Expected startup failure.");

    const syncOutcomes = [
      session.select(collectionId),
      session.clearSelection(),
      session.forget(collectionId)
    ];
    for (const outcome of syncOutcomes) {
      expect(outcome.ok || outcome.problem).toBe(snapshot.problem);
    }
    for (const outcome of await Promise.all([
      session.authorize("choose"),
      session.handleAuthorizationCallback("https://session.example/callback?code=x&state=y"),
      session.completeAuthorization("https://session.example/callback?code=x&state=y"),
      session.ensureCapabilities(["collection.read"]),
      session.applyCollectionSetup()
    ])) {
      expect(outcome.ok || outcome.problem).toBe(snapshot.problem);
    }
  });

  it("turns thrown expected startup problems into start_failed and restores unknown throws", async () => {
    const expectedFixture = connectFixture(manifest());
    const expectedProblem = connectProblem("temporarily_unavailable", "Registration threw.");
    expectedFixture.register.mockRejectedValueOnce(new MdbaseConnectError(expectedProblem));
    const expected = new MdbaseApplicationSession(expectedFixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });

    await expect(expected.start()).resolves.toMatchObject({ ok: false, problem: expectedProblem });
    expect(expected.getSnapshot()).toMatchObject({ status: "start_failed", problem: expectedProblem });

    const unknownFixture = connectFixture(manifest());
    unknownFixture.register.mockRejectedValueOnce(new Error("broken fixture"));
    const unknown = new MdbaseApplicationSession(unknownFixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });
    await expect(unknown.start()).rejects.toThrow("broken fixture");
    expect(unknown.getSnapshot().status).toBe("not_started");
  });

  it("requires reauthorization for a saved grant bound to a previous application identity without checking setup", async () => {
    const fixture = connectFixture(manifest());
    fixture.facade.connectionApplicationId = () => "01911111-1111-7111-8111-111111111111";
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });

    const started = await session.start();

    expect(started).toMatchObject({ ok: true, value: { status: "authorization_required" } });
    expect(fixture.value.assessCollectionSetup).not.toHaveBeenCalled();
    expect(fixture.authorize).not.toHaveBeenCalled();
  });

  it("treats a missing validated connection application identity as requiring authorization", async () => {
    const fixture = connectFixture(manifest());
    fixture.facade.connectionApplicationId = () => null;
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });

    await expect(session.start()).resolves.toMatchObject({
      ok: true,
      value: { status: "authorization_required" }
    });
  });

  it("classifies an authority declaration mismatch as authorization required rather than blocked", async () => {
    const declaration = setupManifest();
    const fixture = connectFixture(
      declaration,
      ["describe", "read", "assess_collection_setup", "apply_collection_setup"]
    );
    fixture.value.assessCollectionSetup.mockResolvedValue(connectFailure(connectProblem(
      "application_declaration_mismatch",
      "The saved grant belongs to an earlier application declaration."
    )) as never);
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });

    const started = await session.start();

    expect(started).toMatchObject({ ok: true, value: { status: "authorization_required" } });
    expect(session.getSnapshot().status).not.toBe("blocked");
  });

  it("reviews setup drift after explicit selected reauthorization succeeds", async () => {
    const declaration = setupManifest();
    const assessment: CollectionSetupAssessment = {
      status: "provision",
      applicable: true,
      applicationId: declaration.id,
      declarationDigest: `sha256:${"a".repeat(64)}`,
      provisionDigest: `sha256:${"b".repeat(64)}`,
      collectionRevision: `sha256:${"c".repeat(64)}`,
      finalCollectionRevision: `sha256:${"d".repeat(64)}`,
      configuration: [],
      typePacks: [],
      finalResourceRevisions: {},
      assessmentDigest: `sha256:${"e".repeat(64)}`
    };
    const fixture = connectFixture(
      declaration,
      ["describe", "read", "assess_collection_setup", "apply_collection_setup"],
      assessment
    );
    let savedApplicationId = "01911111-1111-7111-8111-111111111111";
    fixture.facade.connectionApplicationId = () => savedApplicationId;
    fixture.authorize.mockImplementationOnce(async () => {
      savedApplicationId = "01922222-2222-7222-8222-222222222222";
      return connectSuccess({ kind: "connected", connection: fixture.value });
    });
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });
    await session.start();

    const authorized = await session.authorize("selected");

    expect(authorized).toMatchObject({ ok: true, value: { kind: "connected" } });
    expect(session.getSnapshot()).toMatchObject({ status: "setup_review_required" });
    expect(fixture.value.assessCollectionSetup).toHaveBeenCalledOnce();
  });

  it("compiles manifest capabilities and never accepts an application operation array", async () => {
    const fixture = connectFixture(manifest());
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });
    await session.start();

    await session.authorize("choose");

    const options = fixture.authorize.mock.calls[0]?.[0];
    expect(options).not.toHaveProperty("operations");
  });

  it("reports semantic authorization gaps for required capabilities", async () => {
    const fixture = connectFixture(manifest(), ["describe"]);
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });

    const started = await session.start();

    expect(started.ok && started.value.status).toBe("authorization_required");
    expect(session.getSnapshot()).toMatchObject({
      capabilities: {
        requiredAvailable: false,
        values: {
          "collection.read": {
            state: "requires_authorization",
            missingOperations: [
              "changes",
              "read",
              "query",
              "list_views",
              "execute_view",
              "read_view_source",
              "validate",
              "read_type"
            ]
          },
          "records.edit": { state: "requires_authorization", requirement: "optional" }
        }
      }
    });
  });

  it("requires renewed authorization when a full-collection application has a contract-scoped grant", async () => {
    const declaration = manifest({
      requirements: {
        contracts: [],
        access: "full_collection",
        capabilities: {
          contract_version: 2,
          required: ["collection.read"]
        }
      }
    });
    const fixture = connectFixture(declaration, undefined, undefined, "contract");
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });

    const started = await session.start();

    expect(started.ok && started.value.status).toBe("authorization_required");
    expect(session.getSnapshot()).toMatchObject({
      status: "authorization_required",
      info: { scope: { access: "contract" } }
    });
  });

  it("rejects a legacy contract-scoped application manifest", async () => {
    const declaration = manifest({
      requirements: {
        contracts: [],
        access: "contract",
        capabilities: {
          contract_version: 2,
          required: ["collection.read"]
        }
      }
    });
    const fixture = connectFixture(declaration, undefined, undefined, "contract");
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });

    const started = await session.start();

    expect(started).toMatchObject({
      ok: false,
      problem: { code: "invalid_application_manifest" }
    });
  });

  it("rejects a manifest that omits explicit collection access", async () => {
    const declaration = manifest();
    delete declaration.requirements!.access;
    const fixture = connectFixture(declaration);
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });

    const started = await session.start();

    expect(started).toMatchObject({
      ok: false,
      problem: {
        code: "invalid_application_manifest",
        details: { issues: [{ path: "/requirements/access" }] }
      }
    });
  });

  it("carries request options through ensureCapabilities authorization", async () => {
    const fixture = connectFixture(manifest(), ["describe", "read"]);
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });
    await session.start();
    const controller = new AbortController();

    await session.ensureCapabilities(["records.edit"], {
      signal: controller.signal,
      timeoutMs: 4321
    });

    expect(fixture.authorize).toHaveBeenCalledWith(expect.objectContaining({
      capabilities: ["records.edit"],
      signal: expect.any(AbortSignal),
      timeoutMs: null
    }));
    expect(fixture.authorize.mock.calls[0]?.[0]).not.toHaveProperty("operations");
  });

  it("preserves already granted optional groups when requesting another capability", async () => {
    const declaration = manifest({
      requirements: {
        access: "full_collection",
        contracts: [],
        capabilities: {
          contract_version: 2,
          required: ["collection.read"],
          optional: ["records.create", "records.edit"]
        }
      }
    });
    const fixture = connectFixture(declaration, [
      "describe", "changes", "read", "query", "list_views", "execute_view",
      "read_view_source", "validate", "read_type", "create"
    ]);
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });
    await session.start();

    await session.ensureCapabilities(["records.edit"]);

    expect(fixture.authorize).toHaveBeenCalledWith(expect.objectContaining({
      capabilities: ["collection.read", "records.create", "records.edit"]
    }));
  });

  it("inspects definition evolution and applies only the exact reviewed assessment", async () => {
    const desired = {
      id: "dev.mdbase.tasks",
      version: "2.0.0",
      digest: `sha256:${"a".repeat(64)}`,
      installedBy: "dev.mdbase.session-test",
      resources: []
    };
    const typePackAssessment: TypePackAssessment = {
      status: "upgrade",
      applicable: true,
      assessmentDigest: `sha256:${"b".repeat(64)}`,
      current: { ...desired, version: "1.0.0" },
      desired,
      resources: [],
      lock: { target: "mdbase.lock.yaml", action: "update", digest: `sha256:${"c".repeat(64)}` },
      contractSetups: { choices: [], resources: [] }
    };
    const assessment: CollectionSetupAssessment = {
      status: "provision",
      applicable: true,
      applicationId: "dev.mdbase.session-test",
      declarationDigest: `sha256:${"a".repeat(64)}`,
      provisionDigest: `sha256:${"d".repeat(64)}`,
      collectionRevision: `sha256:${"e".repeat(64)}`,
      finalCollectionRevision: `sha256:${"f".repeat(64)}`,
      configuration: [],
      typePacks: [typePackAssessment],
      finalResourceRevisions: {},
      assessmentDigest: `sha256:${"b".repeat(64)}`
    };
    const declaration = manifest({
      requirements: {
        access: "full_collection",
        contracts: [],
        capabilities: { contract_version: 2, required: [] }
      },
      provisions: {
        type_packs: [{ manifest: { kind: "mdbase.type-pack", id: desired.id, version: desired.version, resources: [] }, resources: [], provides: [] }]
      }
    });
    const fixture = connectFixture(
      declaration,
      ["describe", "read", "assess_collection_setup", "apply_collection_setup"],
      assessment
    );
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection(),
      verificationStore: new MdbaseMemoryVerificationStore()
    });

    await session.start();
    expect(fixture.value.assessCollectionSetup).toHaveBeenCalledOnce();
    expect(session.getSnapshot()).toMatchObject({
      status: "setup_review_required",
      update: {
        status: "provision",
        typePacks: [{ status: "upgrade", desiredVersion: "2.0.0", canApply: true }]
      }
    });

    const applied = await session.applyCollectionSetup();

    expect(applied.ok && applied.value.status).toBe("ready");
    expect(fixture.applyCollectionSetup).toHaveBeenCalledWith(expect.objectContaining({
      applicationId: "dev.mdbase.session-test",
      expectedAssessmentDigest: assessment.assessmentDigest
    }), expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: null }));
  });

  it("makes unmanaged managed definitions reviewable with digest-pinned adoption", async () => {
    const desired = {
      id: "dev.mdbase.requests",
      version: "1.0.0",
      digest: `sha256:${"a".repeat(64)}`,
      installedBy: "dev.mdbase.session-test",
      resources: []
    };
    const conflictResource = {
      source: "types/request.md",
      target: "_types/request.md",
      kind: "type" as const,
      mode: "managed" as const,
      action: "conflict" as const,
      digest: `sha256:${"b".repeat(64)}`,
      currentDigest: `sha256:${"c".repeat(64)}`,
      reason: "_types/request.md exists but is not managed by dev.mdbase.requests."
    };
    const baseAssessment: CollectionSetupAssessment = {
      status: "conflict",
      applicable: false,
      applicationId: "dev.mdbase.session-test",
      declarationDigest: `sha256:${"d".repeat(64)}`,
      provisionDigest: `sha256:${"e".repeat(64)}`,
      collectionRevision: `sha256:${"f".repeat(64)}`,
      finalCollectionRevision: `sha256:${"0".repeat(64)}`,
      configuration: [],
      typePacks: [{
        status: "conflict",
        applicable: false,
        assessmentDigest: `sha256:${"1".repeat(64)}`,
        desired,
        resources: [conflictResource],
        lock: { target: "mdbase.lock.yaml", action: "create", digest: `sha256:${"2".repeat(64)}` },
        contractSetups: { choices: [], resources: [] }
      }],
      finalResourceRevisions: {},
      assessmentDigest: `sha256:${"3".repeat(64)}`
    };
    const reviewedAssessment: CollectionSetupAssessment = {
      ...baseAssessment,
      status: "provision",
      applicable: true,
      assessmentDigest: `sha256:${"4".repeat(64)}`,
      typePacks: [{
        ...baseAssessment.typePacks[0]!,
        status: "install",
        applicable: true,
        resources: [{ ...conflictResource, action: "update" }]
      }]
    };
    const declaration = manifest({
      requirements: {
        access: "full_collection",
        contracts: [],
        capabilities: { contract_version: 2, required: [] }
      },
      provisions: {
        type_packs: [{
          manifest: {
            kind: "mdbase.type-pack",
            id: desired.id,
            version: desired.version,
            resources: []
          },
          resources: [],
          provides: []
        }]
      }
    });
    const fixture = connectFixture(
      declaration,
      ["describe", "read", "assess_collection_setup", "apply_collection_setup"],
      reviewedAssessment
    );
    fixture.value.assessCollectionSetup
      .mockResolvedValueOnce(connectSuccess(baseAssessment))
      .mockResolvedValueOnce(connectSuccess(reviewedAssessment));
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection(),
      verificationStore: new MdbaseMemoryVerificationStore()
    });

    await session.start();

    expect(fixture.value.assessCollectionSetup).toHaveBeenNthCalledWith(2,
      expect.objectContaining({
        typePackAdoptions: {
          [desired.id]: { [conflictResource.target]: conflictResource.currentDigest }
        }
      }),
      expect.anything()
    );
    expect(session.getSnapshot()).toMatchObject({
      status: "setup_review_required",
      update: { canApply: true, typePacks: [{ canApply: true }] }
    });

    await session.applyCollectionSetup();

    expect(fixture.applyCollectionSetup).toHaveBeenCalledWith(expect.objectContaining({
      typePackAdoptions: {
        [desired.id]: { [conflictResource.target]: conflictResource.currentDigest }
      },
      expectedAssessmentDigest: reviewedAssessment.assessmentDigest
    }), expect.anything());
  });
});
