import { afterEach, describe, expect, it, vi } from "vitest";
import { installMdbaseBrowserFixture, type MdbaseTestPage } from "./index.js";

class MemoryLocalStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

class FixturePage implements MdbaseTestPage {
  init: Array<() => void> = [];
  async addInitScript<Argument>(
    script: (argument: Argument) => void | Promise<void>,
    argument: Argument
  ) {
    this.init.push(() => { void script(argument); });
  }
  async evaluate<Result, Argument>(
    script: (argument: Argument) => Result | Promise<Result>,
    argument: Argument
  ): Promise<Result> {
    return script(argument);
  }
  navigate() { for (const script of this.init) script(); }
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

    page.navigate();
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
});
