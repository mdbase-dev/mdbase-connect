import { describe, expect, it, vi } from "vitest";
import {
  MirrorEnrollmentClient,
  MirrorEnrollmentError,
  canonicalConnectOrigin,
  type MirrorEnrollment,
  type MirrorEnrollmentHttpRequest,
  type MirrorEnrollmentHttpResponse
} from "./enrollment.js";

const CONTROL_URL = "https://connect.example";
const COLLECTION_ID = "00000000-0000-4000-8000-000000000001";
const REPLICA_ID = "00000000-0000-4000-8000-000000000002";
const PAIRING_ID = "00000000-0000-4000-8000-000000000003";
const REFRESH = "mir_refresh_credential_private";
const ACCESS = "hsr_access_credential_private";
const NOW = Date.parse("2026-07-27T00:00:00.000Z");

describe("MirrorEnrollmentClient", () => {
  it("enrolls through explicit browser approval without exposing credentials in URLs", async () => {
    let now = NOW;
    const calls: MirrorEnrollmentHttpRequest[] = [];
    const responses: MirrorEnrollmentHttpResponse[] = [
      pairing(),
      { status: 202, body: { status: "pending" } },
      paired({ replica: { name: "Obsidian vault" } })
    ];
    const verification = vi.fn();
    const statuses: string[] = [];
    const client = new MirrorEnrollmentClient({
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds; },
      request: async (request) => {
        calls.push(request);
        return responses.shift()!;
      }
    });

    const result = await client.enroll({
      controlUrl: `${CONTROL_URL}/`,
      mirrorName: "  Obsidian vault  ",
      mode: "read_write",
      collectionId: COLLECTION_ID
    }, {
      onVerification: verification,
      onStatus: (status) => statuses.push(status.state)
    });

    expect(verification).toHaveBeenCalledWith(expect.objectContaining({
      controlUrl: CONTROL_URL,
      pairingId: PAIRING_ID,
      verificationUri: `${CONTROL_URL}/mirror/${PAIRING_ID}`,
      requested: {
        mirrorName: "Obsidian vault",
        mode: "read_write",
        collectionId: COLLECTION_ID
      }
    }));
    expect(verification.mock.calls[0]?.[0]).not.toHaveProperty("refreshCredential");
    expect(JSON.stringify(verification.mock.calls[0]?.[0])).not.toContain(REFRESH);
    expect(statuses).toEqual(["waiting_for_approval"]);
    expect(result).toEqual(enrollment());
    expect(calls[0]).toMatchObject({
      url: `${CONTROL_URL}/v1/mirror-pairing-requests`,
      body: {
        mirror_name: "Obsidian vault",
        mode: "read_write",
        collection_id: COLLECTION_ID
      }
    });
    expect(calls.slice(1).map((call) => call.url)).toEqual([
      `${CONTROL_URL}/v1/mirror-pairing-requests/${PAIRING_ID}/exchange`,
      `${CONTROL_URL}/v1/mirror-pairing-requests/${PAIRING_ID}/exchange`
    ]);
    expect(calls.every((call) => !call.url.includes(REFRESH))).toBe(true);
    expect(calls.slice(1).every((call) =>
      call.headers?.authorization === `Bearer ${REFRESH}`
    )).toBe(true);
  });

  it("rejects verification redirects outside the trusted Connect origin", async () => {
    const client = clientFor([pairing({
      verification_uri: `https://attacker.example/mirror/${PAIRING_ID}`
    })]);
    await expect(client.begin({
      controlUrl: CONTROL_URL,
      mirrorName: "Vault",
      mode: "read_write"
    })).rejects.toMatchObject({
      code: "invalid_mirror_enrollment_response",
      message: "Connect returned an untrusted mirror verification URI."
    });
  });

  it("rejects a different collection or mirror mode returned after approval", async () => {
    const differentCollection = clientFor([
      pairing(),
      paired({ replica: { collection_id: "00000000-0000-4000-8000-000000000099" } })
    ]);
    const session = await differentCollection.begin({
      controlUrl: CONTROL_URL,
      mirrorName: "Vault",
      mode: "read_write",
      collectionId: COLLECTION_ID
    });
    await expect(differentCollection.waitForApproval(session)).rejects.toMatchObject({
      code: "invalid_mirror_enrollment_response",
      message: "Connect returned a different hosted collection."
    });

    const differentMode = clientFor([
      pairing(),
      paired({ replica: { mode: "read_only" } })
    ]);
    const modeSession = await differentMode.begin({
      controlUrl: CONTROL_URL,
      mirrorName: "Vault",
      mode: "read_write"
    });
    await expect(differentMode.waitForApproval(modeSession)).rejects.toMatchObject({
      code: "invalid_mirror_enrollment_response",
      message: "Connect returned a mirror with a different access mode."
    });

    const differentName = clientFor([
      pairing(),
      paired({ replica: { name: "Impersonated mirror" } })
    ]);
    const nameSession = await differentName.begin({
      controlUrl: CONTROL_URL,
      mirrorName: "Vault",
      mode: "read_write"
    });
    await expect(differentName.waitForApproval(nameSession)).rejects.toMatchObject({
      code: "invalid_mirror_enrollment_response",
      message: "Connect returned a mirror with a different name."
    });

    const untrustedProvider = clientFor([
      pairing(),
      paired({ sync_url: "file:///tmp/provider" })
    ]);
    const providerSession = await untrustedProvider.begin({
      controlUrl: CONTROL_URL,
      mirrorName: "Vault",
      mode: "read_write"
    });
    await expect(untrustedProvider.waitForApproval(providerSession)).rejects.toMatchObject({
      code: "invalid_mirror_enrollment_response",
      message: "Connect returned an untrusted mirror provider URL."
    });
  });

  it("retries transient network and server failures without retrying a denied request", async () => {
    let now = NOW;
    const statuses: Array<{ state: string; code?: string }> = [];
    const request = vi.fn()
      .mockResolvedValueOnce(pairing())
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce({
        status: 503,
        body: { error: { code: "provider_offline", message: "Provider unavailable." } }
      })
      .mockResolvedValueOnce(paired());
    const client = new MirrorEnrollmentClient({
      request,
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds; }
    });
    const session = await client.begin({
      controlUrl: CONTROL_URL,
      mirrorName: "Vault",
      mode: "read_write"
    });
    await expect(client.waitForApproval(session, {
      onStatus: (status) => statuses.push({
        state: status.state,
        code: status.error?.code
      })
    })).resolves.toMatchObject({ replicaId: REPLICA_ID });
    expect(statuses).toEqual([
      { state: "retrying", code: "mirror_enrollment_unreachable" },
      { state: "retrying", code: "provider_offline" }
    ]);

    const deniedRequest = vi.fn()
      .mockResolvedValueOnce(pairing())
      .mockResolvedValueOnce({
        status: 404,
        body: {
          error: {
            code: "mirror_pairing_not_found",
            message: "Mirror approval expired or was not found."
          }
        }
      });
    const denied = new MirrorEnrollmentClient({
      request: deniedRequest,
      now: () => NOW,
      wait: async () => undefined
    });
    const deniedSession = await denied.begin({
      controlUrl: CONTROL_URL,
      mirrorName: "Vault",
      mode: "read_only"
    });
    await expect(denied.waitForApproval(deniedSession)).rejects.toMatchObject({
      status: 404,
      code: "mirror_pairing_not_found"
    });
    expect(deniedRequest).toHaveBeenCalledTimes(2);
  });

  it("uses stable, secret-free errors when begin or renewal cannot reach Connect", async () => {
    const privateFailure = new Error(`network rejected ${REFRESH}`);
    const client = new MirrorEnrollmentClient({
      request: async () => { throw privateFailure; }
    });
    await expect(client.begin({
      controlUrl: CONTROL_URL,
      mirrorName: "Vault",
      mode: "read_only"
    })).rejects.toMatchObject({
      code: "mirror_enrollment_unreachable",
      message: "Connect could not be reached for mirror enrollment."
    });
    await expect(client.renew(enrollment())).rejects.toMatchObject({
      code: "mirror_enrollment_unreachable",
      message: "Connect could not be reached for mirror enrollment."
    });
    await expect(client.begin({
      controlUrl: CONTROL_URL,
      mirrorName: "Vault",
      mode: "read_only"
    })).rejects.not.toThrow(REFRESH);
  });

  it("expires deterministically and never polls after the approval deadline", async () => {
    let now = NOW;
    const request = vi.fn()
      .mockResolvedValueOnce(pairing({ expires_in: 1 }))
      .mockResolvedValue({ status: 202, body: { status: "pending" } });
    const client = new MirrorEnrollmentClient({
      request,
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds; }
    });
    const session = await client.begin({
      controlUrl: CONTROL_URL,
      mirrorName: "Vault",
      mode: "read_only"
    });
    await expect(client.waitForApproval(session)).rejects.toMatchObject({
      code: "mirror_enrollment_expired"
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("cancels while waiting without making another exchange request", async () => {
    const controller = new AbortController();
    const request = vi.fn()
      .mockResolvedValueOnce(pairing())
      .mockResolvedValueOnce({ status: 202, body: { status: "pending" } });
    const client = new MirrorEnrollmentClient({
      request,
      now: () => NOW,
      wait: async () => { controller.abort(); }
    });
    const session = await client.begin({
      controlUrl: CONTROL_URL,
      mirrorName: "Vault",
      mode: "read_write"
    });
    await expect(client.waitForApproval(session, {
      signal: controller.signal
    })).rejects.toMatchObject({
      code: "mirror_enrollment_cancelled"
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("renews with the enrollment credential and validates the stable replica identity", async () => {
    const calls: MirrorEnrollmentHttpRequest[] = [];
    const client = new MirrorEnrollmentClient({
      now: () => NOW,
      request: async (request) => {
        calls.push(request);
        return paired({
          replica: { name: "Obsidian vault" },
          token: "hsr_rotated_access_credential"
        });
      }
    });
    const renewed = await client.renew(enrollment());
    expect(renewed).toEqual({
      ...enrollment(),
      accessToken: "hsr_rotated_access_credential"
    });
    expect(calls).toEqual([expect.objectContaining({
      url: `${CONTROL_URL}/v1/mirror-pairing-requests/${PAIRING_ID}/renew`,
      headers: { authorization: `Bearer ${REFRESH}` }
    })]);

    const substituted = new MirrorEnrollmentClient({
      request: async () => paired({
        replica: { id: "00000000-0000-4000-8000-000000000099" }
      })
    });
    await expect(substituted.renew(enrollment())).rejects.toMatchObject({
      code: "invalid_mirror_enrollment_response",
      message: "Connect returned a different mirror replica."
    });

    const legacyName = new MirrorEnrollmentClient({
      request: async () => paired({
        replica: { name: "Original browser enrollment" }
      })
    });
    await expect(legacyName.renew({
      ...enrollment(),
      name: "This computer mirror"
    })).resolves.toMatchObject({
      replicaId: REPLICA_ID,
      name: "Original browser enrollment"
    });
  });

  it("validates control origins, local inputs, and malformed success responses", async () => {
    expect(() => canonicalConnectOrigin("http://connect.example")).toThrow(
      "Connect URL must use HTTPS outside loopback development."
    );
    expect(() => canonicalConnectOrigin("https://user:secret@connect.example")).toThrow(
      "Connect URL must be an origin without credentials"
    );
    expect(canonicalConnectOrigin("http://127.0.0.1:8787/")).toBe(
      "http://127.0.0.1:8787"
    );

    const invalidInput = clientFor([]);
    await expect(invalidInput.begin({
      controlUrl: CONTROL_URL,
      mirrorName: " ",
      mode: "read_write"
    })).rejects.toMatchObject({ code: "invalid_mirror_name" });
    await expect(invalidInput.begin({
      controlUrl: CONTROL_URL,
      mirrorName: "Vault",
      mode: "read_write",
      collectionId: "../another-collection"
    })).rejects.toMatchObject({ code: "invalid_collection_id" });
    await expect(invalidInput.begin({
      controlUrl: CONTROL_URL,
      mirrorName: "Vault",
      mode: "invalid" as "read_write"
    })).rejects.toMatchObject({ code: "invalid_mirror_mode" });

    const malformed = clientFor([{ status: 201, body: { pairing_id: PAIRING_ID } }]);
    await expect(malformed.begin({
      controlUrl: CONTROL_URL,
      mirrorName: "Vault",
      mode: "read_write"
    })).rejects.toBeInstanceOf(MirrorEnrollmentError);

    const unreasonableDeadline = clientFor([pairing({ expires_in: 86_401 })]);
    await expect(unreasonableDeadline.begin({
      controlUrl: CONTROL_URL,
      mirrorName: "Vault",
      mode: "read_write"
    })).rejects.toMatchObject({ code: "invalid_mirror_enrollment_response" });
  });
});

function clientFor(responses: MirrorEnrollmentHttpResponse[]): MirrorEnrollmentClient {
  let now = NOW;
  return new MirrorEnrollmentClient({
    now: () => now,
    wait: async (milliseconds) => { now += milliseconds; },
    request: async () => responses.shift()!
  });
}

function pairing(
  overrides: Partial<Record<string, unknown>> = {}
): MirrorEnrollmentHttpResponse {
  return {
    status: 201,
    body: {
      pairing_id: PAIRING_ID,
      pairing_secret: REFRESH,
      verification_uri: `${CONTROL_URL}/mirror/${PAIRING_ID}`,
      expires_in: 600,
      ...overrides
    }
  };
}

function paired(
  overrides: {
    replica?: Partial<{
      id: string;
      collection_id: string;
      name: string;
      mode: "read_only" | "read_write";
    }>;
    token?: string;
    token_expires_at?: string;
    sync_url?: string;
  } = {}
): MirrorEnrollmentHttpResponse {
  return {
    status: 200,
    body: {
      status: "paired",
      replica: {
        id: REPLICA_ID,
        collection_id: COLLECTION_ID,
        name: "Vault",
        mode: "read_write",
        ...overrides.replica
      },
      token: overrides.token ?? ACCESS,
      token_expires_at: overrides.token_expires_at ?? "2026-07-27T01:00:00.000Z",
      sync_url: overrides.sync_url ?? CONTROL_URL
    }
  };
}

function enrollment(): MirrorEnrollment {
  return {
    controlUrl: CONTROL_URL,
    providerUrl: CONTROL_URL,
    collectionId: COLLECTION_ID,
    replicaId: REPLICA_ID,
    mode: "read_write",
    name: "Obsidian vault",
    enrollmentId: PAIRING_ID,
    accessToken: ACCESS,
    refreshCredential: REFRESH,
    accessTokenExpiresAt: "2026-07-27T01:00:00.000Z"
  };
}
