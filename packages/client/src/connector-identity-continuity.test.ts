import { describe, expect, it } from "vitest";
import { MdbaseConnect, MemoryGrantKeyStore } from "./index.js";

const COLLECTION_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTOR_ID = "22222222-2222-4222-8222-222222222222";
const GRANT_ID = "33333333-3333-4333-8333-333333333333";

describe("connector identity continuity", () => {
  it("accepts policy rotation but rejects a connector substitution during renewal", async () => {
    const storage = new MemoryStorage();
    const keys = new MemoryGrantKeyStore();
    const application = await keys.create("grant-key");
    const firstConnector = await keys.create("connector-one");
    const secondConnector = await keys.create("connector-two");
    const manager = new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifest: "https://app.example/.well-known/mdbase-app.json",
      redirectUri: "https://app.example/callback",
      storage,
      keyStore: keys
    });
    const internals = Reflect.get(manager, "internals") as {
      storeTokenResponse(
        body: ReturnType<typeof tokenResponse>,
        clientId: string,
        keyHandle: string
      ): unknown;
    };

    internals.storeTokenResponse(
      tokenResponse(
        application.agreementPublicKey,
        firstConnector.agreementPublicKey,
        1
      ),
      "application",
      "grant-key"
    );
    internals.storeTokenResponse(
      tokenResponse(
        application.agreementPublicKey,
        firstConnector.agreementPublicKey,
        2
      ),
      "application",
      "grant-key"
    );

    expect(() => internals.storeTokenResponse(
      tokenResponse(
        application.agreementPublicKey,
        secondConnector.agreementPublicKey,
        3
      ),
      "application",
      "grant-key"
    )).toThrow(expect.objectContaining({
      code: "connector_identity_changed",
      requiresAuthorization: true,
      recovery: "reauthorize"
    }));

    const saved = JSON.parse(
      storage.getItem(
        "mdbase-connect:https://connect.example:"
          + "https://app.example/.well-known/mdbase-app.json:"
          + `token:${COLLECTION_ID}`
      )!
    );
    expect(saved.encryption).toMatchObject({
      scope_epoch: 2,
      connector_agreement_public_key: firstConnector.agreementPublicKey
    });
  });
});

function tokenResponse(
  applicationPublicKey: string,
  connectorPublicKey: string,
  scopeEpoch: number
) {
  return {
    access_token: `access-${scopeEpoch}`,
    refresh_token: `refresh-${scopeEpoch}`,
    expires_in: 300,
    refresh_expires_in: 3_600,
    collection_id: COLLECTION_ID,
    collection_name: "Continuity test",
    grant_id: GRANT_ID,
    operations: ["read"],
    scope: { contracts: [], access: "full_collection" },
    application_origin: "https://app.example",
    encryption: {
      protocol_version: 1,
      suite: "P256-HKDF-SHA256-AES256GCM",
      key_id: `key-${scopeEpoch}`,
      scope_epoch: scopeEpoch,
      connector_id: CONNECTOR_ID,
      collection_id: COLLECTION_ID,
      application_agreement_public_key: applicationPublicKey,
      connector_agreement_public_key: connectorPublicKey
    }
  };
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}
