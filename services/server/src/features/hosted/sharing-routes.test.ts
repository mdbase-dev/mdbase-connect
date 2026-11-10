import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../../db.js";
import { registerHostedSharingRoutes } from "./sharing-routes.js";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  revoke: vi.fn(),
  change: vi.fn(),
  members: vi.fn(),
}));
vi.mock("../../platform/request-authentication.js", () => ({ requireUser: mocks.requireUser }));
vi.mock("../collections/collection-invitations.js", async importOriginal => ({
  ...await importOriginal<typeof import("../collections/collection-invitations.js")>(),
  listHostedCollectionMembers: mocks.members,
}));
vi.mock("../collections/collection-membership-lifecycle.js", () => ({
  revokeHostedCollectionMembership: mocks.revoke,
  changeHostedCollectionMembershipRole: mocks.change,
}));

let app: FastifyInstance | undefined;
afterEach(async () => { vi.useRealTimers(); await app?.close(); app = undefined; vi.clearAllMocks(); });

function fixture(native = true, publication = true) {
  const collection = randomUUID(), membership = randomUUID();
  mocks.requireUser.mockResolvedValue({ id: randomUUID() });
  mocks.members.mockResolvedValue([]);
  // Lifecycle has committed the database revocation and its durable policy row.
  mocks.revoke.mockResolvedValue({ membershipId: membership, state: "revoked", pendingProviderRevocations: 0 });
  mocks.change.mockResolvedValue({ membershipId: membership, state: "active", policyRevision: 2, pendingProviderRevocations: 0 });
  const query = vi.fn(async () => ({ rows: native ? [{ collection_id: collection }] : [] }));
  const publishCommitted = vi.fn(async (_collection: string) => {});
  app = Fastify();
  const options = { db: { query } as unknown as DatabasePool, hostedCollections: true, hostedSharing: true,
    ...(publication ? { nativePolicyEmitter: { publishCommitted } } : {}) };
  registerHostedSharingRoutes(app, options);
  return { collection, membership, query, publishCommitted, remove: () => app!.inject({
    method: "DELETE", url: `/v1/hosted/collections/${collection}/members/${membership}`,
  }), change: (role: "viewer" | "editor" = "viewer") => app!.inject({
    method: "PATCH", url: `/v1/hosted/collections/${collection}/members/${membership}`, payload: { role },
  }) };
}

describe("public membership role publication boundary", () => {
  it.each(["viewer", "editor"] as const)("waits for read-only publication for %s during provider cleanup", async role => {
    const f = fixture();
    mocks.change.mockResolvedValue({ membershipId: f.membership, state: "changing", policyRevision: 2, pendingProviderRevocations: 1 });
    let release!: () => void;
    f.publishCommitted.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    let answered = false;
    const response = f.change(role).then(value => { answered = true; return value; });
    try {
      await vi.waitFor(() => expect(f.publishCommitted).toHaveBeenCalledWith(f.collection));
      expect(answered).toBe(false);
    } finally { release?.(); }
    const result = await response;
    expect(result.statusCode).toBe(202);
    expect(result.json().membership).toMatchObject({ state: "changing", role, pending_provider_revocations: 1 });
  });

  it("waits for native downgrade publication before returning the existing active shape", async () => {
    const f = fixture();
    let release!: () => void;
    f.publishCommitted.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    let answered = false;
    const response = f.change().then(value => { answered = true; return value; });
    try {
      await vi.waitFor(() => expect(f.publishCommitted).toHaveBeenCalledWith(f.collection));
      expect(answered).toBe(false);
    } finally { release?.(); }
    const result = await response;
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ membership: { id: f.membership, state: "active", role: "viewer", policy_revision: 2, pending_provider_revocations: 0 } });
  });

  it("returns removal's retryable error on failed publication and fences a repeated Viewer request", async () => {
    const f = fixture();
    f.publishCommitted.mockRejectedValueOnce(new Error("private transport detail"));
    const refused = await f.change();
    expect(refused.statusCode).toBe(503);
    expect(refused.headers["retry-after"]).toBe("2");
    expect(refused.json().error.code).toBe("collection_sharing_unavailable");
    expect(refused.body).not.toContain("private transport detail");
    expect((await f.change()).statusCode).toBe(200);
    expect(f.publishCommitted).toHaveBeenCalledTimes(2);
  });

  it("bounds an uncertain downgrade without cancelling publication", async () => {
    const f = fixture();
    let release!: () => void;
    f.publishCommitted.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    await app!.ready();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const response = f.change();
    await vi.waitFor(() => expect(f.publishCommitted).toHaveBeenCalledWith(f.collection));
    await vi.advanceTimersByTimeAsync(8_000);
    expect((await response).statusCode).toBe(503);
    release();
    await Promise.resolve();
    expect(f.publishCommitted).toHaveBeenCalledTimes(1);
  });

  it.each(["missing-publisher", "lookup-failure"])("fails closed on %s", async failure => {
    const f = fixture(true, failure !== "missing-publisher");
    if (failure === "lookup-failure") f.query.mockRejectedValueOnce(new Error("private database detail"));
    const refused = await f.change();
    expect(refused.statusCode).toBe(503);
    expect(refused.body).not.toContain("private database detail");
  });

  it("preserves ordinary upgrades without waiting for publication", async () => {
    const f = fixture();
    expect((await f.change("editor")).statusCode).toBe(200);
    expect(f.publishCommitted).not.toHaveBeenCalled();
  });

  it("preserves the legacy provider-only role path", async () => {
    const f = fixture(false);
    expect((await f.change()).statusCode).toBe(200);
    expect(f.publishCommitted).not.toHaveBeenCalled();
  });
});

describe("public membership removal publication boundary", () => {
  it("does not acknowledge native removal until the committed policy reaches the log", async () => {
    const f = fixture();
    let release!: () => void;
    f.publishCommitted.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    let answered = false;
    const response = f.remove().then(value => { answered = true; return value; });
    try {
      await vi.waitFor(() => expect(f.publishCommitted).toHaveBeenCalledWith(f.collection));
      expect(answered).toBe(false);
    } finally { release?.(); }
    expect((await response).statusCode).toBe(200);
  });

  it("does not list a member as gone before native policy publication", async () => {
    const f = fixture();
    let release!: () => void;
    f.publishCommitted.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    let answered = false;
    const response = app!.inject({ method: "GET", url: `/v1/hosted/collections/${f.collection}/members` })
      .then(value => { answered = true; return value; });
    try {
      await vi.waitFor(() => expect(f.publishCommitted).toHaveBeenCalledWith(f.collection));
      expect(answered).toBe(false);
    } finally { release?.(); }
    expect((await response).statusCode).toBe(200);
  });

  it("refuses success on uncertain publication and republishes on idempotent retry", async () => {
    const f = fixture();
    f.publishCommitted.mockRejectedValueOnce(new Error("private transport detail"));
    const refused = await f.remove();
    expect(refused.statusCode).toBe(503);
    expect(refused.headers["retry-after"]).toBe("2");
    expect(refused.body).not.toContain("private transport detail");
    expect((await f.remove()).statusCode).toBe(200);
    expect(f.publishCommitted).toHaveBeenCalledTimes(2);
    expect(mocks.revoke).toHaveBeenCalledTimes(2);
  });

  it("fails closed if native publication is not configured", async () => {
    const f = fixture(true, false);
    expect((await f.remove()).statusCode).toBe(503);
  });

  it("bounds the HTTP wait without cancelling the original publication", async () => {
    const f = fixture();
    let release!: () => void;
    f.publishCommitted.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    await app!.ready();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const response = f.remove();
    await vi.waitFor(() => expect(f.publishCommitted).toHaveBeenCalledWith(f.collection));
    await vi.advanceTimersByTimeAsync(8_000);
    expect((await response).statusCode).toBe(503);
    release();
    await Promise.resolve();
    expect(f.publishCommitted).toHaveBeenCalledTimes(1);
  });

  it("does not infer legacy authority from a failed native lookup", async () => {
    const f = fixture();
    f.query.mockRejectedValueOnce(new Error("private database detail"));
    const refused = await f.remove();
    expect(refused.statusCode).toBe(503);
    expect(refused.body).not.toContain("private database detail");
  });

  it("preserves the legacy provider-only completion path", async () => {
    const f = fixture(false);
    expect((await f.remove()).statusCode).toBe(200);
    expect(f.publishCommitted).not.toHaveBeenCalled();
  });
});
