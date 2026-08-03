import { describe, expect, it, vi } from "vitest";
import type { MdbaseAppManifest, TypePackAssessment } from "@mdbase-dev/connect-protocol";
import {
  MdbaseApplicationSession,
  MdbaseMemorySelection,
  MdbaseMemoryVerificationStore,
  connectSuccess
} from "./index.js";

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
  assessment?: TypePackAssessment
) {
  let currentAssessment = assessment;
  const applyTypePack = vi.fn(async (input) => {
    if (currentAssessment) currentAssessment = { ...currentAssessment, status: "current" };
    return connectSuccess({ ...currentAssessment, receipt: currentAssessment!.desired, cleanup_deferred: false });
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
    assessTypePack: vi.fn(async () => connectSuccess(currentAssessment!)),
    applyTypePack
  };
  return { value, applyTypePack };
}

function connectFixture(
  declaration: MdbaseAppManifest,
  grantedOperations?: string[],
  assessment?: TypePackAssessment
) {
  const connected = connection(grantedOperations, assessment);
  const authorize = vi.fn(async () => connectSuccess({ kind: "redirect", url: "https://connect.example" }));
  const facade = {
    manifest: async () => connectSuccess(declaration),
    connections: () => [connected.value.info()],
    connection: (id: string) => id === collectionId ? connected.value : null,
    unavailableReason: () => null,
    onConnectionsChange: (listener: (connections: unknown[]) => void) => {
      listener([connected.value.info()]);
      return () => undefined;
    },
    authorize,
    completeAuthorization: vi.fn()
  };
  return { facade, authorize, ...connected };
}

describe("MdbaseApplicationSession", () => {
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

  it("inspects definition evolution and applies only the exact reviewed assessment", async () => {
    const desired = {
      id: "dev.mdbase.tasks",
      version: "2.0.0",
      digest: `sha256:${"a".repeat(64)}`,
      installed_by: "dev.mdbase.session-test",
      resources: []
    };
    const assessment: TypePackAssessment = {
      status: "upgrade",
      applicable: true,
      assessment_digest: `sha256:${"b".repeat(64)}`,
      current: { ...desired, version: "1.0.0" },
      desired,
      resources: [],
      lock: { target: "mdbase.lock.yaml", action: "update", digest: `sha256:${"c".repeat(64)}` },
      contract_setups: { choices: [], resources: [] }
    };
    const declaration = manifest({
      requirements: {
        contracts: [],
        capabilities: {
          contract_version: 1,
          required: ["collection.inspect", "records.read", "definitions.type-pack.apply"]
        }
      },
      provisions: {
        type_packs: [{ manifest: { kind: "mdbase.type-pack", id: desired.id, version: desired.version, resources: [] }, resources: [], provides: [] }]
      }
    });
    const fixture = connectFixture(
      declaration,
      ["describe", "read", "assess_type_pack", "apply_type_pack"],
      assessment
    );
    const session = new MdbaseApplicationSession(fixture.facade as never, {
      selection: new MdbaseMemorySelection(),
      verificationStore: new MdbaseMemoryVerificationStore()
    });

    await session.start();
    expect(session.getSnapshot()).toMatchObject({
      status: "definition_review_required",
      updates: [{ status: "upgrade", desiredVersion: "2.0.0", canApply: true }]
    });

    const applied = await session.applyDefinitionUpdates();

    expect(applied.ok && applied.value.status).toBe("ready");
    expect(fixture.applyTypePack).toHaveBeenCalledWith(expect.objectContaining({
      installed_by: "dev.mdbase.session-test",
      expected_assessment_digest: assessment.assessment_digest
    }));
  });
});
