import { describe, expect, it, vi } from "vitest";
import type { MdbaseAppManifest } from "@mdbase-dev/connect-protocol";
import {
  MdbaseApplicationSession,
  MdbaseMemorySelection,
  MdbaseMemoryVerificationStore,
  type CollectionSetupAssessment,
  type TypePackAssessment
} from "./index.js";
import { connectSuccess } from "./outcomes.js";

const collectionId = "00000000-0000-0000-0000-000000000042";

function manifest(overrides: Partial<MdbaseAppManifest> = {}): MdbaseAppManifest {
  return {
    manifest_version: 1,
    id: "dev.mdbase.session-test",
    name: "Session test",
    homepage: "https://session.example/",
    redirect_uris: ["https://session.example/callback"],
    requirements: {
      contracts: [],
      capabilities: {
        contract_version: 1,
        required: ["collection.inspect", "records.read"],
        optional: ["records.update"]
      }
    },
    ...overrides
  } as MdbaseAppManifest;
}

function connection(
  operations = ["describe", "read", "update"],
  assessment?: CollectionSetupAssessment
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
    info: () => ({
      collectionId,
      displayName: "Test collection",
      operations,
      scope: { contracts: [], access: "full_collection" },
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
  assessment?: CollectionSetupAssessment
) {
  const connected = connection(grantedOperations, assessment);
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
    await expect(cancelled).rejects.toMatchObject({
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
    await expect(abandoned).rejects.toMatchObject({
      problem: { code: "operation_cancelled", operation_outcome: "not_sent" }
    });

    await expect(session.start()).resolves.toMatchObject({ ok: true });
    expect(fixture.register).toHaveBeenCalledTimes(2);
    expect(fixture.onConnectionsChange).toHaveBeenCalledOnce();
  });

  it("destroys owned listeners and supports a Strict Mode-style restart", async () => {
    const fixture = connectFixture(manifest());
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });
    const staleListener = vi.fn();
    session.subscribe(staleListener);
    await session.start();
    const callsBeforeDestroy = staleListener.mock.calls.length;

    session.destroy();
    await session.start();

    expect(fixture.removeConnectionsListener).toHaveBeenCalledOnce();
    expect(fixture.onConnectionsChange).toHaveBeenCalledTimes(2);
    expect(staleListener).toHaveBeenCalledTimes(callsBeforeDestroy);
    expect(fixture.register).toHaveBeenCalledTimes(2);
  });

  it("compiles manifest capabilities and never accepts an application operation array", async () => {
    const fixture = connectFixture(manifest());
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection()
    });
    await session.start();

    await session.authorize("choose");

    expect(fixture.authorize).toHaveBeenCalledWith(expect.objectContaining({
      operations: ["describe", "read", "update"]
    }));
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
          "records.read": { state: "requires_authorization", missingOperations: ["read"] },
          "records.update": { state: "requires_authorization", requirement: "optional" }
        }
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

    await session.ensureCapabilities(["records.update"], {
      signal: controller.signal,
      timeoutMs: 4321
    });

    expect(fixture.authorize).toHaveBeenCalledWith(expect.objectContaining({
      operations: ["describe", "read", "update"],
      signal: controller.signal,
      timeoutMs: 4321
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
        contracts: [],
        capabilities: {
          contract_version: 1,
          required: ["collection.inspect", "records.read", "collection.setup.apply"]
        }
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
        contracts: [],
        capabilities: {
          contract_version: 1,
          required: ["collection.inspect", "records.read", "collection.setup.apply"]
        }
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
