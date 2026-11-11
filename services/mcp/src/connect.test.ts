import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryGrantKeyStore } from "@mdbase-dev/connect/crypto";
import { ConnectGateway } from "./connect.js";
import { SecretBox } from "./security.js";

const collectionId = "01922222-2222-7222-8222-222222222222";
const otherCollectionId = "01933333-3333-7333-8333-333333333333";

function authorityAt(origin: string, collection = collectionId) {
  return {
    operations_url: `${origin}/v1/authorities/${collection}/operations`,
    sync_url: `${origin}/v1/authorities/${collection}/sync`,
    files_url: `${origin}/v1/authorities/${collection}/files`
  };
}

async function exchange(authority: Record<string, string>) {
  const keyStore = new MemoryGrantKeyStore();
  const key = await keyStore.create("grant");
  const gateway = new ConnectGateway(
    {} as any, new SecretBox(Buffer.alloc(32, 7)), keyStore, "https://connect.example",
    {} as any, "https://mcp.example/callback"
  );
  const save = vi.spyOn(gateway as any, "saveConnection").mockResolvedValue({
    id: "connection", collection_id: collectionId, display_name: "Hosted", operations: ["query"],
    scope: { contracts: [] }, encryption: null
  });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    access_token: "upstream-access", refresh_token: "upstream-refresh", token_type: "Bearer",
    expires_in: 3_600, refresh_expires_in: 2_592_000, collection_id: collectionId,
    operations: ["query"], scope: { contracts: [] }, grant_id: "01944444-4444-7444-8444-444444444444",
    encryption: null,
    authority: {
      ...authority,
      replica_id: "01955555-5555-7555-8555-555555555555",
      access_token: "hosted-access",
      proof_public_key: key.signingPublicKey
    }
  })));
  const result = gateway.exchangeAuthorization({
    authorizationId: "01966666-6666-7666-8666-666666666666", manifestDigest: "a".repeat(64),
    code: "code", verifier: "verifier", applicationId: "application",
    connectionSetId: "set", keyHandle: "grant"
  });
  return { result, save };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Connect token authority", () => {
  it("stores an authority bound to its collection", async () => {
    const { result, save } = await exchange(authorityAt("https://hosted.example"));
    await expect(result).resolves.toMatchObject({ authority: "remote" });
    expect(save).toHaveBeenCalledOnce();
  });

  it.each([
    ["another collection", authorityAt("https://hosted.example", otherCollectionId)],
    ["plain HTTP", authorityAt("http://hosted.example")],
    ["two origins", { ...authorityAt("https://hosted.example"), sync_url: authorityAt("https://other.example").sync_url }],
    ["another path", { ...authorityAt("https://hosted.example"), operations_url: "https://hosted.example/collect" }],
    ["a query", { ...authorityAt("https://hosted.example"), operations_url: `${authorityAt("https://hosted.example").operations_url}?to=other` }]
  ])("refuses an authority on %s before storing it", async (_name, authority) => {
    const { result, save } = await exchange(authority);
    await expect(result).rejects.toMatchObject({ code: "invalid_operation_response" });
    expect(save).not.toHaveBeenCalled();
  });
});
