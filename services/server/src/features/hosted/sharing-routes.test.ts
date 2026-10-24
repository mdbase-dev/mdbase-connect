import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../../db.js";
import { registerHostedSharingRoutes } from "./sharing-routes.js";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  revoke: vi.fn(),
  members: vi.fn(),
}));
vi.mock("../../platform/request-authentication.js", () => ({ requireUser: mocks.requireUser }));
vi.mock("../../collection-invitations.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../collection-invitations.js")>(),
  listHostedCollectionMembers: mocks.members,
}));
vi.mock("../../collection-membership-lifecycle.js", () => ({
  revokeHostedCollectionMembership: mocks.revoke,
  changeHostedCollectionMembershipRole: vi.fn(),
}));

let app: FastifyInstance | undefined;
afterEach(async () => { vi.useRealTimers(); await app?.close(); app = undefined; vi.clearAllMocks(); });

function fixture(native = true, publication = true) {
  const collection = randomUUID(), membership = randomUUID();
  mocks.requireUser.mockResolvedValue({ id: randomUUID() });
  mocks.members.mockResolvedValue([]);
  // Lifecycle has committed the database revocation and its durable policy row.
  mocks.revoke.mockResolvedValue({ membershipId: membership, state: "revoked", pendingProviderRevocations: 0 });
  const query = vi.fn(async () => ({ rows: native ? [{ collection_id: collection }] : [] }));
  const publishCommitted = vi.fn(async (_collection: string) => {});
  app = Fastify();
  const options = { db: { query } as unknown as DatabasePool, hostedCollections: true, hostedSharing: true,
    ...(publication ? { nativePolicyEmitter: { publishCommitted } } : {}) };
  registerHostedSharingRoutes(app, options);
  return { collection, membership, query, publishCommitted, remove: () => app!.inject({
    method: "DELETE", url: `/v1/hosted/collections/${collection}/members/${membership}`,
  }) };
}

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
