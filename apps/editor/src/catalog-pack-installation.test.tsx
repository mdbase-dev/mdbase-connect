import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TypePackApplyResult,
  TypePackAssessment,
  TypePackProvision
} from "@mdbase-dev/connect";
import { loadTypePackProvision, type ContractCatalogPack } from "./contract-catalog";
import { reviewCatalogPackInstallation } from "./catalog-pack-installation";
import type { CollectionGateway } from "./model";

vi.mock("./contract-catalog", async (importOriginal) => ({
  ...await importOriginal<typeof import("./contract-catalog")>(),
  loadTypePackProvision: vi.fn()
}));

const provision = {
  manifest: { kind: "mdbase.type-pack", id: "contacts", version: "1.0.0", resources: [] },
  resources: [],
  provides: []
} satisfies TypePackProvision;

const pack = {
  id: "contacts",
  version: "1.0.0",
  displayName: "Contacts",
  primaryType: "contact",
  provisionUrl: "https://example.test/contacts.json"
} as ContractCatalogPack;

describe("catalog pack installation review", () => {
  beforeEach(() => {
    vi.mocked(loadTypePackProvision).mockReset().mockResolvedValue(provision);
  });

  it("applies an applicable assessment and opens its primary type", async () => {
    const assessment = packAssessment(true);
    const gateway = gatewayWithAssessments([assessment]);
    const callbacks = packCallbacks();

    await reviewCatalogPackInstallation(pack, gateway, callbacks);

    expect(gateway.applyTypePack).toHaveBeenCalledWith(provision, assessment, {});
    expect(callbacks.openType).toHaveBeenCalledWith("contact");
    expect(callbacks.notify).toHaveBeenCalledWith("Added “Contacts” and opened the new type.");
  });

  it("requires digest-pinned confirmation before adopting unmanaged definitions", async () => {
    const conflict = packAssessment(false, {
      action: "conflict",
      currentDigest: `sha256:${"1".repeat(64)}`
    });
    const reviewed = packAssessment(true, { action: "adopt" });
    const gateway = gatewayWithAssessments([conflict, reviewed]);
    const callbacks = packCallbacks();

    await reviewCatalogPackInstallation(pack, gateway, callbacks);

    expect(callbacks.confirm).toHaveBeenCalledOnce();
    expect(gateway.applyTypePack).not.toHaveBeenCalled();
    await vi.mocked(callbacks.confirm).mock.calls[0]![0].onConfirm();
    const adoptions = { "_contracts/contact.md": conflict.resources[0]!.currentDigest! };
    expect(gateway.assessTypePack).toHaveBeenLastCalledWith(provision, adoptions);
    expect(gateway.applyTypePack).toHaveBeenCalledWith(provision, reviewed, adoptions);
  });
});

function gatewayWithAssessments(assessments: TypePackAssessment[]): CollectionGateway {
  return {
    assessTypePack: vi.fn(async () => assessments.shift()!),
    applyTypePack: vi.fn(async (_provision, assessment) => ({
      ...assessment,
      receipt: assessment.desired,
      cleanupDeferred: false
    } satisfies TypePackApplyResult))
  } as unknown as CollectionGateway;
}

function packCallbacks() {
  return {
    installedTypeNames: [],
    confirm: vi.fn(),
    refreshDescription: vi.fn(async () => ({ types: [{ name: "contact" }] })),
    isTypeDraftDirty: vi.fn(() => false),
    openType: vi.fn(async () => undefined),
    notify: vi.fn(),
    onError: vi.fn()
  } as unknown as Parameters<typeof reviewCatalogPackInstallation>[2];
}

function packAssessment(
  applicable: boolean,
  resource: Partial<TypePackAssessment["resources"][number]> = {}
): TypePackAssessment {
  const receipt = {
    id: "contacts",
    version: "1.0.0",
    digest: `sha256:${"2".repeat(64)}`,
    installedBy: "mdbase-editor",
    resources: []
  };
  return {
    status: applicable ? "install" : "conflict",
    applicable,
    assessmentDigest: `sha256:${"3".repeat(64)}`,
    desired: receipt,
    resources: [{
      source: "contracts/contact.md",
      target: "_contracts/contact.md",
      kind: "contract",
      mode: "managed",
      action: applicable ? "create" : "conflict",
      digest: `sha256:${"4".repeat(64)}`,
      ...resource
    }],
    lock: {
      target: "mdbase.lock.yaml",
      action: "create",
      digest: `sha256:${"5".repeat(64)}`
    },
    contractSetups: { choices: [], resources: [] }
  };
}
