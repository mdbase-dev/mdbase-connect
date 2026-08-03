import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptRelayResponse,
  encryptRelayRequest,
  MemoryGrantKeyStore
} from "../../client/src/crypto.js";
import { installMdbaseBrowserFixture, type MdbaseTestPage } from "./index.js";
import { connectorRelayFixture, generateConnectorKey } from "./relay.js";

class MemoryLocalStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

class FixturePage implements MdbaseTestPage {
  async evaluate<Result, Argument>(
    script: (argument: Argument) => Result | Promise<Result>,
    argument: Argument
  ): Promise<Result> {
    return script(argument);
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("browser authorization fixture", () => {
  it("seeds, reduces, expires, reloads, and removes a production-shaped grant", async () => {
    const storage = new MemoryLocalStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("location", { origin: "https://tasks.example" });
    const page = new FixturePage();
    const controller = await installMdbaseBrowserFixture(page, {
      serverUrl: "https://connect.example/",
      application: {
        manifestUrl: "https://tasks.example/mdbase-app.json",
        manifest: {
          manifest_version: 1,
          id: "dev.example.tasks",
          name: "Tasks",
          homepage: "https://tasks.example/",
          redirect_uris: ["https://tasks.example/callback"],
          requirements: {
            contracts: [],
            capabilities: {
              contract_version: 1,
              required: ["collection.inspect", "records.read"],
              optional: ["records.update"]
            }
          }
        }
      },
      collection: { id: "collection-1", name: "Tasks" },
      authority: {
        kind: "hosted",
        operationsUrl: "https://authority.example/operations",
        syncUrl: "https://authority.example/sync",
        filesUrl: "https://authority.example/files",
        replicaId: "replica-1"
      },
      directAccess: "enabled"
    });

    const tokenKey = [...storage.values.keys()].find((key) => key.includes(":token:"))!;
    expect(JSON.parse(storage.getItem(tokenKey)!)).toMatchObject({
      operations: ["describe", "read", "update"],
      authority: { replicaId: "replica-1" }
    });
    expect(await controller.isInstalled(page)).toBe(true);

    await controller.setOperations(page, ["describe"]);
    expect(JSON.parse(storage.getItem(tokenKey)!).operations).toEqual(["describe"]);
    await controller.expire(page);
    expect(JSON.parse(storage.getItem(tokenKey)!).expiresAt).toBeLessThan(Date.now());
    await controller.remove(page);
    expect(storage.getItem(tokenKey)).toBeNull();
  });

  it("decrypts and responds through the production encrypted relay profile", async () => {
    const applicationKeys = new MemoryGrantKeyStore();
    const application = await applicationKeys.create("application-key");
    const connector = await generateConnectorKey();
    const binding = {
      grantId: "10000000-0000-4000-8000-000000000001",
      applicationId: "dev.example.tasks",
      encryption: {
        protocol_version: 1 as const,
        suite: "P256-HKDF-SHA256-AES256GCM" as const,
        key_id: "fixture-key",
        scope_epoch: 1,
        connector_id: "20000000-0000-4000-8000-000000000002",
        collection_id: "30000000-0000-4000-8000-000000000003",
        application_agreement_public_key: application.agreementPublicKey,
        connector_agreement_public_key: connector.publicKey
      }
    };
    const request = await encryptRelayRequest(
      applicationKeys,
      application.handle,
      binding,
      "query",
      { filter: { status: "open" } },
      "40000000-0000-4000-8000-000000000004"
    );
    const relay = connectorRelayFixture(connector.privateKey, binding);

    await expect(relay.decrypt(request)).resolves.toMatchObject({
      operation: "query",
      input: { filter: { status: "open" } }
    });
    const response = await relay.success(request, { results: [{ path: "task.md" }] });
    await expect(decryptRelayResponse(
      applicationKeys,
      application.handle,
      binding,
      request,
      response
    )).resolves.toEqual({
      ok: true,
      result: { results: [{ path: "task.md" }] }
    });
  });
});
