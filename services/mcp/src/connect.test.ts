import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryGrantKeyStore } from "@mdbase-dev/connect/crypto";
import { verifyAuthorityRequestProof } from "../../server/src/features/authority-transfer/authority-proof.js";
import { ConnectGateway } from "./connect.js";
import { createDatabase } from "./db.js";
import { PostgresGrantKeyStore } from "./key-store.js";
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

describe("Native token refresh", () => {
  it("signs native refresh requests so Connect verifies the authority proof and surfaces OAuth errors", async () => {
    const db = await createDatabase("memory");
    try {
      const secrets = new SecretBox(Buffer.alloc(32, 7));
      const keyStore = new PostgresGrantKeyStore(db, secrets);
      const key = await keyStore.create("native-grant");
      const setId = "01911111-1111-7111-8111-111111111111";
      const grantId = "01944444-4444-7444-8444-444444444444";
      const connectionId = "01977777-7777-7777-8777-777777777777";
      const authId = "01966666-6666-7666-8666-666666666666";
      const applicationId = "01988888-8888-7888-8888-888888888888";
      const nativeCompletion = {
        version: 1 as const,
        account_id: "01999999-9999-7999-8999-999999999999",
        authorization_request_id: authId,
        application_id: applicationId,
        application_declaration_id: "dev.mdbase.mcp",
        application_manifest_digest: "a".repeat(64),
        application_installation_id: "inst-native-1",
        application_origin: "https://mcp.example",
        collection_id: collectionId,
        grant_id: grantId,
        grant_signing_public_key: key.signingPublicKey,
        client_noise_public_key: "c".repeat(43)
      };
      await db.query("INSERT INTO mcp_connection_sets (id) VALUES ($1)", [setId]);
      await db.query(
        `INSERT INTO mcp_connections (
           id, connection_set_id, upstream_url, upstream_client_id, collection_id, grant_id,
           display_name, operations, scope, encryption, key_handle, credentials_ciphertext,
           access_expires_at, refresh_expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8::jsonb, $9::jsonb, NULL, $10, $11,
           now() - interval '1 minute', now() + interval '1 day'
         )`,
        [
          connectionId, setId, "https://connect.example", applicationId, collectionId, grantId,
          "Native Notes", JSON.stringify(["query"]), JSON.stringify({ contracts: [] }), key.handle,
          secrets.encrypt(JSON.stringify({
            accessToken: "expired-access",
            refreshToken: "native-refresh-token",
            nativeCompletion
          }))
        ]
      );
      const gateway = new ConnectGateway(
        db, secrets, keyStore, "https://connect.example",
        { id: "dev.mdbase.mcp" } as any, "https://mcp.example/oauth/connect/callback"
      );
      let verifiedProof = false;
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        expect(url.href).toBe("https://connect.example/oauth/token");
        const body = String(init?.body ?? "");
        const params = new URLSearchParams(body);
        expect(params.get("grant_type")).toBe("refresh_token");
        expect(params.get("refresh_token")).toBe("native-refresh-token");
        expect(params.get("client_id")).toBe(applicationId);
        verifyAuthorityRequestProof(
          Object.fromEntries(new Headers(init?.headers).entries()),
          key.signingPublicKey,
          {
            method: "POST",
            target: "/oauth/token",
            body,
            credential: "native-refresh-token"
          }
        );
        verifiedProof = true;
        return Response.json(
          { error: "invalid_grant", error_description: "Refresh token is invalid or expired." },
          { status: 400 }
        );
      }));
      await expect(gateway.operation(setId, connectionId, "query", {})).rejects.toMatchObject({
        code: "invalid_grant",
        message: "Refresh token is invalid or expired."
      });
      expect(verifiedProof).toBe(true);
    } finally {
      await db.end();
    }
  });
});
