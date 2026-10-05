import { afterEach, describe, expect, it, vi } from "vitest";
import { MdbaseConnect } from "./index.js";
import { mdbaseNext } from "./next.js";
import { MemoryStorage } from "./runtime-utils.js";

const COLLECTION = "0192f3a4-6000-7abc-8def-0123456789ab";
const GRANT = "0192f3a4-6000-7abc-8def-0123456789ad";
const SERVER = "https://cp.example.test";
const MANIFEST = "https://app.example.test/.well-known/mdbase-app.json";

// The /next entry reaches transport internals by name; this pins that coupling to
// the public construction path (stored grant → MdbaseConnect → connection).
describe("@mdbase-dev/connect/next public entry", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("routes for a retained grant through the public connection, token kept internal", async () => {
    const storage = new MemoryStorage();
    storage.setItem(`mdbase-connect:${SERVER}:${MANIFEST}:token:${COLLECTION}`, JSON.stringify({
      version: 1, accessToken: "retained-token", clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: COLLECTION, collectionName: "c", operations: ["query"],
      scope: { contracts: [], access: "full_collection" }, expiresAt: Date.now() + 3_600_000,
      grantId: GRANT, keyHandle: "key-1", applicationOrigin: "https://app.example.test", savedAt: 1
    }));
    const connect = new MdbaseConnect({ serverUrl: SERVER, manifest: MANIFEST, redirectUri: "https://app.example.test/",
      storage, directAccess: "disabled", relayEncryption: "disabled" });
    const connection = connect.connection(COLLECTION)!;
    expect(connection).toBeTruthy();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(String(url)).toBe(`${SERVER}/v1/next/collections/${COLLECTION}/route`);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer retained-token");
      return Response.json({ collection: COLLECTION, grant: GRANT, targets: [] });
    });
    const next = mdbaseNext(connection);
    expect(mdbaseNext(connection)).toBe(next);
    const route = await next.route(COLLECTION);
    expect(route).toEqual({ collection: COLLECTION, grant: GRANT, targets: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Object.keys(next).sort()).toEqual(["openPipe", "route"]);
    expect(JSON.stringify(route)).not.toContain("retained-token");
  });
});
