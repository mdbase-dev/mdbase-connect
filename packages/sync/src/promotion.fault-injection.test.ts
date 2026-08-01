import { beforeEach, describe, expect, it, vi } from "vitest";

const ids = vi.hoisted(() => ({
  collection: "11111111-1111-4111-8111-111111111111",
  otherCollection: "22222222-2222-4222-8222-222222222222",
  replica: "33333333-3333-4333-8333-333333333333",
  transfer: "44444444-4444-4444-8444-444444444444"
}));

const state = vi.hoisted(() => ({
  calls: [] as string[],
  checkpoint: null as null | Record<string, unknown>,
  registeredPath: null as string | null,
  registrationLookupUnavailable: false,
  manifest: {
    cursor: 7,
    digest: "a".repeat(64)
  },
  profile: {
    profile: {
      version: 1 as const,
      sync_url: `https://connect.test/v1/authorities/${ids.collection}/sync`,
      control_url: "https://connect.test",
      collection_id: ids.collection,
      replica_id: ids.replica,
      mode: "read_write" as const,
      enrollment_id: "55555555-5555-4555-8555-555555555555",
      access_token_expires_at: "2099-01-01T00:00:00.000Z"
    },
    credentials: {
      access_token: "access-token",
      refresh_token: "refresh-token"
    }
  }
}));

vi.mock("./index.js", () => ({
  HttpSyncTransport: class HttpSyncTransport {}
}));

vi.mock("./node.js", () => ({
  NodeMirrorStateStore: class NodeMirrorStateStore {},
  WritableDirectoryMirror: class WritableDirectoryMirror {
    async previewInitialization() {
      return {
        collisions: [],
        already_initialized: true,
        download_documents: 0,
        upload_documents: 0,
        unchanged_documents: 0,
        download_files: 0,
        unchanged_files: 0
      };
    }
    async sync() {
      state.calls.push("sync");
    }
    async authorityPromotionManifest() {
      state.calls.push("manifest");
      return state.manifest;
    }
  }
}));

vi.mock("./device.js", () => ({
  loadAuthorityPromotionCheckpoint: async () => state.checkpoint,
  loadMirrorProfile: async () => state.profile,
  markMirror: async () => {
    state.calls.push("mark-mirror");
  },
  clearMirrorMarker: async () => {
    state.calls.push("clear-marker");
  },
  readCollectionConfiguration: async () => "name: Original\n",
  restoreCollectionConfiguration: async () => {
    state.calls.push("restore-config");
  },
  retireMirrorAfterPromotion: async () => {
    state.calls.push("retire-mirror");
  },
  saveAuthorityPromotionCheckpoint: async (
    _root: string,
    checkpoint: Record<string, unknown>
  ) => {
    state.calls.push("save-checkpoint");
    state.checkpoint = { version: 1, ...checkpoint };
  },
  clearAuthorityPromotionCheckpoint: async () => {
    state.calls.push("clear-checkpoint");
    state.checkpoint = null;
  },
  setCollectionIdentity: async (_root: string, collectionId: string) => {
    state.calls.push(`set-identity:${collectionId}`);
  },
  updateMirrorCredentials: async () => state.profile
}));

vi.mock("./enrollment.js", () => ({
  canonicalConnectOrigin: (value: string) => new URL(value).origin,
  MirrorEnrollmentClient: class MirrorEnrollmentClient {}
}));

import { promoteMirrorAuthority } from "./promotion.js";

beforeEach(() => {
  state.calls.length = 0;
  state.checkpoint = null;
  state.registeredPath = null;
  state.registrationLookupUnavailable = false;
  state.manifest = {
    cursor: 7,
    digest: "a".repeat(64)
  };
});

describe("authority promotion fault injection", () => {
  it("cancels before local materialization when the fenced manifest differs", async () => {
    state.manifest = { cursor: 7, digest: "b".repeat(64) };
    const fetch = scenarioFetch();

    await expect(promoteMirrorAuthority("/mirror", options(fetch))).rejects.toThrow(
      "does not exactly match"
    );

    expect(state.calls).toContain("cancel-transfer");
    expect(state.calls).not.toContain("save-checkpoint");
    expect(state.calls.some((call) => call.startsWith("set-identity:"))).toBe(false);
  });

  it("rolls back the folder and registration when local validation fails", async () => {
    const fetch = scenarioFetch();
    const callbacks = options(fetch);
    callbacks.validateCollection = async () => {
      state.calls.push("validate");
      throw new Error("validation failed");
    };

    await expect(promoteMirrorAuthority("/mirror", callbacks)).rejects.toThrow(
      "validation failed"
    );

    expect(state.calls).toEqual(expect.arrayContaining([
      "remove-registration",
      "restore-config",
      "mark-mirror",
      "clear-checkpoint",
      "cancel-transfer"
    ]));
  });

  it("retries an outcome-uncertain completion without repeating materialization", async () => {
    const fetch = scenarioFetch({ failFirstCompletion: true });

    const result = await promoteMirrorAuthority("/mirror", {
      ...options(fetch),
      pollIntervalMs: 0
    });

    expect(result).toMatchObject({
      collectionId: ids.collection,
      authorityEpoch: 2
    });
    expect(state.calls.filter((call) => call === "register")).toHaveLength(1);
    expect(state.calls.filter((call) => call === "complete-transfer")).toHaveLength(2);
    expect(state.calls).toContain("retire-mirror");
  });

  it("rolls back a materialized folder when the server declares the transfer inactive", async () => {
    const fetch = scenarioFetch({ inactiveCompletion: true });

    await expect(promoteMirrorAuthority("/mirror", options(fetch))).rejects.toThrow(
      "Transfer is inactive"
    );

    expect(state.calls).toEqual(expect.arrayContaining([
      "remove-registration",
      "restore-config",
      "mark-mirror",
      "clear-checkpoint"
    ]));
  });

  it("rejects a same-origin response that substitutes another collection identity", async () => {
    const fetch = scenarioFetch({ collectionId: ids.otherCollection });
    const callbacks = options(fetch);
    callbacks.registerCollection = async (_path, collectionId) => {
      state.calls.push("register");
      return collectionId;
    };

    await expect(promoteMirrorAuthority("/mirror", callbacks)).rejects.toThrow(
      "does not match this mirrored collection"
    );

    expect(state.calls.some((call) =>
      call === `set-identity:${ids.otherCollection}`
    )).toBe(false);
    expect(state.calls).not.toContain("open-verification");
  });

  it("rejects identity substitution after browser approval but before materialization", async () => {
    const fetch = scenarioFetch({ preparedCollectionId: ids.otherCollection });

    await expect(
      promoteMirrorAuthority("/mirror", options(fetch))
    ).rejects.toThrow("does not match this mirrored collection");

    expect(state.calls).toContain("open-verification");
    expect(state.calls).not.toContain("save-checkpoint");
    expect(state.calls.some((call) => call.startsWith("set-identity:"))).toBe(false);
  });

  it("preserves recovery state when completion returns another identity", async () => {
    const fetch = scenarioFetch({ completionCollectionId: ids.otherCollection });

    await expect(
      promoteMirrorAuthority("/mirror", options(fetch))
    ).rejects.toThrow("does not match the local recovery checkpoint");

    expect(state.checkpoint).toMatchObject({
      collection_id: ids.collection,
      transfer_id: ids.transfer
    });
    expect(state.calls).not.toContain("retire-mirror");
  });

  it("reconciles a local registration that committed before its reply timed out", async () => {
    const fetch = scenarioFetch();
    const callbacks = options(fetch);
    callbacks.registerCollection = async () => {
      state.calls.push("agent-committed-registration");
      state.registeredPath = "/mirror";
      throw new Error("local agent reply timed out");
    };

    const result = await promoteMirrorAuthority("/mirror", callbacks);

    expect(result.collectionId).toBe(ids.collection);
    expect(state.calls).toContain("validate");
    expect(state.calls).not.toContain("remove-registration");
    expect(state.calls).toContain("retire-mirror");
  });

  it("preserves and resumes recovery when a timed-out registration cannot be queried", async () => {
    const fetch = scenarioFetch();
    const callbacks = options(fetch);
    callbacks.registerCollection = async () => {
      state.calls.push("agent-registration-outcome-unknown");
      state.registeredPath = "/mirror";
      state.registrationLookupUnavailable = true;
      throw new Error("local agent reply timed out");
    };

    await expect(promoteMirrorAuthority("/mirror", callbacks)).rejects.toThrow(
      "may have registered this collection"
    );

    expect(state.checkpoint).toMatchObject({
      collection_id: ids.collection,
      transfer_id: ids.transfer
    });
    expect(state.calls).not.toContain("restore-config");
    expect(state.calls).not.toContain("clear-checkpoint");
    expect(state.calls).not.toContain("cancel-transfer");

    state.registrationLookupUnavailable = false;
    const result = await promoteMirrorAuthority("/mirror", callbacks);

    expect(result.collectionId).toBe(ids.collection);
    expect(
      state.calls.filter((call) => call === "agent-registration-outcome-unknown")
    ).toHaveLength(1);
    expect(state.calls).toContain("retire-mirror");
  });

  it("does not claim an already registered local collection", async () => {
    state.registeredPath = "/mirror";

    await expect(
      promoteMirrorAuthority("/mirror", options(scenarioFetch()))
    ).rejects.toThrow("already registered as a local collection");

    expect(state.calls).not.toContain("request-transfer");
  });
});

function options(fetch: typeof globalThis.fetch) {
  return {
    fetch,
    pollIntervalMs: 0,
    registeredCollectionPath: async () => {
      state.calls.push("lookup-registration");
      if (state.registrationLookupUnavailable) {
        throw new Error("local agent unavailable");
      }
      return state.registeredPath;
    },
    registerCollection: async () => {
      state.calls.push("register");
      return ids.collection;
    },
    validateCollection: async () => {
      state.calls.push("validate");
    },
    removeCollection: async () => {
      state.calls.push("remove-registration");
    },
    onVerification: async () => {
      state.calls.push("open-verification");
    }
  };
}

function scenarioFetch(input: {
  collectionId?: string;
  preparedCollectionId?: string;
  completionCollectionId?: string;
  failFirstCompletion?: boolean;
  inactiveCompletion?: boolean;
} = {}): typeof globalThis.fetch {
  const collectionId = input.collectionId ?? ids.collection;
  const preparedCollectionId = input.preparedCollectionId ?? collectionId;
  const completionCollectionId = input.completionCollectionId ?? collectionId;
  let completionAttempts = 0;
  return (async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(request));
    if (
      init?.method === "POST"
      && url.pathname.endsWith("/authority-transfers")
    ) {
      state.calls.push("request-transfer");
      return jsonResponse({
        transfer: transfer("requested", collectionId),
        verification_uri: `https://connect.test/transfer/${ids.transfer}`
      }, 201);
    }
    if (url.pathname.endsWith("/prepare")) {
      state.calls.push("prepare-transfer");
      return jsonResponse({
        transfer: transfer("prepared", preparedCollectionId)
      });
    }
    if (url.pathname.endsWith("/complete")) {
      state.calls.push("complete-transfer");
      completionAttempts += 1;
      if (input.failFirstCompletion && completionAttempts === 1) {
        throw new TypeError("connection reset after commit");
      }
      if (input.inactiveCompletion) {
        return jsonResponse({
          error: {
            code: "authority_transfer_inactive",
            message: "Transfer is inactive"
          }
        }, 409);
      }
      return jsonResponse({
        status: "completed",
        collection_id: completionCollectionId,
        authority_epoch: 2
      });
    }
    if (init?.method === "DELETE") {
      state.calls.push("cancel-transfer");
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof globalThis.fetch;
}

function transfer(
  status: "requested" | "prepared",
  collectionId: string
) {
  return {
    id: ids.transfer,
    collection_id: collectionId,
    replica_id: ids.replica,
    state: status,
    final_head: status === "prepared" ? 7 : null,
    authority_epoch: status === "prepared" ? 2 : null,
    manifest_digest: status === "prepared" ? "a".repeat(64) : null,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    verification_uri: `https://connect.test/transfer/${ids.transfer}`
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
