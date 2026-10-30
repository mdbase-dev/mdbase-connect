import { describe, expect, it, vi } from "vitest";
import { ApplicationPrivateCollections, withPrivateCollections, type ApplicationPrivateGrants } from "../src/application/private-collections.js";
import type { CollectionAvailability } from "../src/collection-availability.js";
import type { MdbaseClient } from "../src/client.js";
import type { AppWebSignInSnapshot } from "../src/app-host/web-sign-in-session.js";
import type { MdbaseApplicationDeclaration } from "../src/application/declaration.js";
import { pipeCloseError } from "../src/transport/relay-pipe.js";
import { mdbaseError } from "../src/errors.js";

const P = "11111111-1111-4111-8111-111111111111";
const H = "22222222-2222-4222-8222-222222222222";
const scope = { account: "acct", installation: "inst" };
const declaration = { id: "app", origin: "https://app.example" } as unknown as MdbaseApplicationDeclaration;

function fakeGrants(initial: CollectionAvailability) {
  let availability = initial;
  const waiters: Array<(a: CollectionAvailability) => void> = [];
  const grants = {
    collections: vi.fn(async () => [{ collectionId: P, displayName: "Notes", operations: [], role: null, availability }]),
    availability: vi.fn(async () => availability),
    waitForAvailable: vi.fn((_id: string, o: { onAvailability?: (a: CollectionAvailability) => void; signal?: AbortSignal }) =>
      new Promise<CollectionAvailability>((resolve, reject) => {
        o.signal?.addEventListener("abort", () => reject(o.signal!.reason));
        waiters.push(a => { o.onAvailability?.(a); resolve(a); });
      })),
    connector: vi.fn(),
    people: vi.fn(() => ({})),
    setup: vi.fn(() => ({ assess: vi.fn(async () => "ready" as const), plan: vi.fn(), apply: vi.fn() })),
    forget: vi.fn(async (_id: string) => {}),
    forgetAllGrants: vi.fn(async () => {}),
    authorize: vi.fn(async () => ({ collectionId: P })),
  };
  return { grants: grants as unknown as ApplicationPrivateGrants & typeof grants, online: (a: CollectionAvailability) => { availability = a; waiters.splice(0).forEach(w => w(a)); } };
}
function client(collection = P) {
  type Listener = Parameters<MdbaseClient["onLink"]>[0];
  const listeners = new Set<Listener>();
  const fake = { collection, files: {}, close: vi.fn(),
    onLink: vi.fn((fn: Listener) => { listeners.add(fn); fn("open", null); return () => { listeners.delete(fn); }; }),
    link: (state: Parameters<Listener>[0], error: Parameters<Listener>[1] = null) => { for (const fn of listeners) fn(state, error); },
    listeners,
  };
  return fake as unknown as MdbaseClient & Pick<typeof fake, "close" | "link" | "listeners">;
}
const paired = (over: Partial<AppWebSignInSnapshot> = {}): AppWebSignInSnapshot => ({
  status: "unselected", signIn: { state: "paired", accountId: "acct", installationId: "inst" } as AppWebSignInSnapshot["signIn"],
  collections: [{ collectionId: H, displayName: "Hosted", role: "owner" }], selectedCollectionId: null, problem: null, timing: null, ...over,
}) as AppWebSignInSnapshot;
const until = async (check: () => boolean) => { for (let i = 0; i < 50 && !check(); i++) await new Promise(r => setTimeout(r, 0)); expect(check()).toBe(true); };

describe("SDK-10 Private collections", () => {
  it("lists Private collections beside hosted ones and shows the open one as selected", async () => {
    const { grants } = fakeGrants({ state: "available" });
    const privates = new ApplicationPrivateCollections({ declaration, grants: async () => grants, connect: async () => client(), onChange: () => {} });
    await privates.refresh("acct");
    expect(privates.entries()).toEqual([expect.objectContaining({ collectionId: P, kind: "private", role: "editor" })]);

    const listed = withPrivateCollections(paired(), privates.entries(), privates.state());
    expect(listed.collections.map(c => [c.collectionId, c.kind ?? "cloud_copy"])).toEqual([[H, "cloud_copy"], [P, "private"]]);
    expect(listed.selectedCollectionId).toBeNull();

    await privates.openCollection(P, scope);
    expect(privates.state()).toMatchObject({ status: "ready", problem: null });
    const open = withPrivateCollections(paired(), privates.entries(), privates.state());
    expect(open).toMatchObject({ status: "ready", selectedCollectionId: P });
    expect(privates.connection(P)).toMatchObject({ id: P, displayName: "Notes", scope: { collection: P } });
    // A hosted collection open in the session wins over the overlay.
    expect(withPrivateCollections(paired({ status: "ready", selectedCollectionId: H }), privates.entries(), privates.state()).selectedCollectionId).toBe(H);
    // Signed out: nothing added.
    const out = paired({ status: "signed_out", signIn: null });
    expect(withPrivateCollections(out, privates.entries(), privates.state())).toBe(out);
  });

  it("shows why while waiting for the computer, then connects when it comes online", async () => {
    const { grants, online } = fakeGrants({ state: "unavailable", reason: "approval_required" } as CollectionAvailability);
    const opened = client();
    const privates = new ApplicationPrivateCollections({ declaration, grants: async () => grants, connect: async () => opened, onChange: () => {} });
    await privates.refresh("acct");
    const pending = privates.openCollection(P, scope);
    await until(() => privates.state()?.status === "blocked");
    expect(privates.state()?.problem).toBe("device_approval_required");
    online({ state: "available" });
    await pending;
    expect(privates.state()?.status).toBe("ready");
    expect(privates.entries()[0]?.availability).toEqual({ state: "available" });
  });

  it("closing (another selection, sign-out) stops the wait and closes the client", async () => {
    const { grants } = fakeGrants({ state: "unavailable", reason: "device_offline" } as CollectionAvailability);
    const privates = new ApplicationPrivateCollections({ declaration, grants: async () => grants, connect: async () => client(), onChange: () => {} });
    await privates.refresh("acct");
    const pending = privates.openCollection(P, scope).catch(e => e);
    await until(() => privates.state()?.problem === "device_offline");
    await privates.forgetAll();
    await pending;
    expect(privates.state()).toBeNull();
    expect(privates.entries()).toEqual([]);
    expect(grants.forgetAllGrants).toHaveBeenCalledOnce();

    const { grants: g2 } = fakeGrants({ state: "available" });
    const c = client();
    const p2 = new ApplicationPrivateCollections({ declaration, grants: async () => g2, connect: async () => c, onChange: () => {} });
    await p2.openCollection(P, scope);
    p2.close();
    expect(c.close).toHaveBeenCalled();
    expect(p2.connection(P)).toBeNull();
  });

  it("waits while the collection is still getting ready instead of connecting early", async () => {
    const { grants, online } = fakeGrants({ state: "opening" });
    const connect = vi.fn(async () => client());
    const privates = new ApplicationPrivateCollections({ declaration, grants: async () => grants, connect, onChange: () => {} });
    const pending = privates.openCollection(P, scope);
    await until(() => grants.waitForAvailable.mock.calls.length === 1);
    expect(privates.state()?.status).toBe("opening");
    expect(connect).not.toHaveBeenCalled();
    online({ state: "available" });
    await pending;
    expect(privates.state()?.status).toBe("ready");
  });

  it("recovers assessment backpressure automatically on the original connection without approval or apply", async () => {
    vi.useFakeTimers();
    const { grants } = fakeGrants({ state: "available" }), opened = client(), connect = vi.fn(async () => opened);
    const setup = grants.setup(); grants.setup.mockReturnValue(setup);
    setup.assess.mockRejectedValueOnce(mdbaseError("rate_limited", "another setup review is active"));
    const privates = new ApplicationPrivateCollections({ declaration, grants: async () => grants, connect, onChange: () => {} });
    const pending = privates.openCollection(P, scope); void pending.catch(() => {});
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(privates.state()).toMatchObject({ status: "opening", problem: null });
      expect(setup.assess).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000); await pending;
      expect(privates.state()).toMatchObject({ status: "ready", problem: null });
      expect(connect).toHaveBeenCalledTimes(1); expect(setup.assess).toHaveBeenCalledTimes(2);
      expect(grants.authorize).not.toHaveBeenCalled(); expect(setup.plan).not.toHaveBeenCalled(); expect(setup.apply).not.toHaveBeenCalled();
    } finally {privates.close(); vi.useRealTimers();}
  });
  it("retires a delayed assessment retry when its original collection closes", async () => {
    vi.useFakeTimers();
    const { grants } = fakeGrants({ state: "available" }), setup = grants.setup(); grants.setup.mockReturnValue(setup);
    setup.assess.mockRejectedValueOnce(mdbaseError("rate_limited", "another setup review is active"));
    const privates = new ApplicationPrivateCollections({ declaration, grants: async () => grants, connect: async () => client(), onChange: () => {} });
    const pending = privates.openCollection(P, scope).catch(() => {});
    try {
      await vi.advanceTimersByTimeAsync(0); privates.close(); await pending;
      await vi.advanceTimersByTimeAsync(120000);
      expect(setup.assess).toHaveBeenCalledTimes(1); expect(privates.state()).toBeNull();
      expect(grants.authorize).not.toHaveBeenCalled(); expect(setup.apply).not.toHaveBeenCalled();
    } finally {privates.close(); vi.useRealTimers();}
  });
  it("the list is settled once read, or once its read fails (a request then stops waiting)", async () => {
    const onChange = vi.fn();
    const privates = new ApplicationPrivateCollections({ declaration, grants: async () => { throw new Error("storage unavailable"); }, onChange });
    expect(privates.listing("acct")).toBe(true);
    await expect(privates.refresh("acct")).rejects.toThrow("storage unavailable");
    expect(privates.listing("acct")).toBe(false);
    expect(onChange).toHaveBeenCalled();
    privates.ensure("acct"); // no retry loop for a failed read
    expect(privates.listing("other")).toBe(true);
  });

  it("refreshes availability on link changes without reopening, approval or losing the ready connection", async () => {
    const { grants, online } = fakeGrants({ state: "available" });
    const c = client();
    const privates = new ApplicationPrivateCollections({ declaration, grants: async () => grants, connect: async () => c, onChange: vi.fn() });
    await privates.refresh("acct");
    await privates.openCollection(P, scope);
    const connection = privates.connection(P);
    online({ state: "unavailable", reason: "device_offline" });
    c.link("closed");
    await until(() => privates.entries()[0]?.availability?.state === "unavailable");
    expect(privates.state()?.status).toBe("ready");
    expect(privates.connection(P)).toBe(connection);
    online({ state: "available" });
    c.link("open");
    await until(() => privates.entries()[0]?.availability?.state === "available");
    expect(grants.authorize).not.toHaveBeenCalled();
    expect(c.close).not.toHaveBeenCalled();
    privates.close();
    expect(c.listeners.size).toBe(0);
  });

  it("fences a delayed availability response after the collection closes", async () => {
    const { grants } = fakeGrants({ state: "available" });
    const c = client();
    const privates = new ApplicationPrivateCollections({ declaration, grants: async () => grants, connect: async () => c, onChange: vi.fn() });
    await privates.refresh("acct");
    await privates.openCollection(P, scope);
    let resolve!: (a: CollectionAvailability) => void;
    grants.availability.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    c.link("closed");
    await until(() => !!resolve);
    privates.close();
    resolve({ state: "unavailable", reason: "access_removed" });
    await new Promise(r => setTimeout(r, 0));
    expect(privates.state()).toBeNull();
    expect(privates.entries()[0]?.availability).toEqual({ state: "available" });
  });

  it("keeps bounded first-open relay diagnostics in the Private snapshot, not hosted details or close text", async () => {
    const { grants } = fakeGrants({ state: "available" });
    const error = pipeCloseError(1006, "private-close-text");
    const connect = vi.fn(async () => { throw error; });
    const privates = new ApplicationPrivateCollections({ declaration, grants: async () => grants, connect, onChange: vi.fn() });
    await privates.refresh("acct");
    await expect(privates.openCollection(P, scope)).rejects.toBe(error);
    const snapshot = withPrivateCollections(paired({ problemDetail: { name: "HostedError", code: "stale" } }), privates.entries(), privates.state());
    expect(snapshot).toMatchObject({ status: "blocked", selectedCollectionId: P, problem: "relay_closed",
      problemDetail: { name: "MdbaseError", code: "unavailable", relay: { closeCode: 1006, closeClass: "abnormal" } } });
    expect(JSON.stringify(snapshot)).not.toContain("private-close-text");
    expect(JSON.stringify(snapshot)).not.toContain("HostedError");
    expect(grants.setup).not.toHaveBeenCalled();
    expect(privates.connection(P)).toBeNull();
    privates.close();
  });

  it("reports a live relay close without demoting READY or replaying work, then clears details on reconnect", async () => {
    const { grants } = fakeGrants({ state: "available" });
    const c = client();
    const connect = vi.fn(async () => c);
    const privates = new ApplicationPrivateCollections({ declaration, grants: async () => grants, connect, onChange: vi.fn() });
    await privates.refresh("acct");
    await privates.openCollection(P, scope);
    const connection = privates.connection(P);
    c.link("reconnecting", pipeCloseError(1011, "private-close-text"));
    expect(withPrivateCollections(paired(), privates.entries(), privates.state())).toMatchObject({ status: "ready", problem: "relay_closed",
      problemDetail: { name: "MdbaseError", code: "unavailable", relay: { closeCode: 1011, closeClass: "internal_error" } } });
    expect(privates.connection(P)).toBe(connection);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(grants.authorize).not.toHaveBeenCalled();
    expect(c.close).not.toHaveBeenCalled();
    c.link("open");
    const recovered = withPrivateCollections(paired(), privates.entries(), privates.state());
    expect(recovered.problem).toBeNull();
    expect(recovered).not.toHaveProperty("problemDetail");
    privates.close();
  });

  it("sign-out wipes grants the list never knew about (persisted before its completion was recorded)", async () => {
    const Y = "33333333-3333-4333-8333-333333333333";
    const { grants } = fakeGrants({ state: "available" });
    // The backing store holds X (=P, listed) and Y (in the store only).
    const backing = new Set([P, Y]);
    grants.forget.mockImplementation(async (id: string) => { backing.delete(id); });
    grants.forgetAllGrants.mockImplementation(async () => { backing.clear(); });
    const privates = new ApplicationPrivateCollections({ declaration, grants: async () => grants, connect: async () => client(), onChange: () => {} });
    await privates.refresh("acct");
    expect(privates.entries().map(c => c.collectionId)).toEqual([P]);
    await privates.forgetAll();
    expect(grants.forgetAllGrants).toHaveBeenCalledOnce();
    expect(backing.size).toBe(0);
    expect(privates.entries()).toEqual([]);
  });

  it("sign-out wipe failure is not swallowed: forgetAll rejects and the list still clears", async () => {
    const { grants } = fakeGrants({ state: "available" });
    grants.forgetAllGrants.mockRejectedValue(new Error("grant storage could not be cleared"));
    const privates = new ApplicationPrivateCollections({ declaration, grants: async () => grants, connect: async () => client(), onChange: () => {} });
    await privates.refresh("acct");
    await expect(privates.forgetAll()).rejects.toThrow("grant storage could not be cleared");
    expect(privates.entries()).toEqual([]);
    expect(privates.state()).toBeNull();
  });

  it("access removed blocks without waiting", async () => {
    const { grants } = fakeGrants({ state: "unavailable", reason: "access_removed" } as CollectionAvailability);
    const privates = new ApplicationPrivateCollections({ declaration, grants: async () => grants, connect: async () => client(), onChange: () => {} });
    await privates.openCollection(P, scope);
    expect(privates.state()).toMatchObject({ status: "blocked", problem: "access_removed" });
    expect(grants.waitForAvailable).not.toHaveBeenCalled();
  });
});
