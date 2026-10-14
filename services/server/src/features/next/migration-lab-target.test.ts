import { describe, expect, it, vi } from "vitest";
import { labTargetBootstrap } from "./migration-lab-target.js";
import { postgresLabConnect } from "./migration-lab.js";

const account = "10000000-0000-4000-8000-000000000001", collection = "20000000-0000-4000-8000-000000000002";
const config = { environment: "lab", url: "https://connect-lab.mdbase.dev", token: "t".repeat(40), account };
const body = () => ({ collection_id: collection, owner_account: account, state: "cloud-copy", service_devices: [
  { kind: "hosted", device_id: "30000000-0000-4000-8000-000000000003" },
  { kind: "escrow", device_id: "40000000-0000-4000-8000-000000000004" }
] });

describe("control-plane target preparation port", () => {
  function port(recorded: boolean, callback?: (collection: string) => Promise<void>) {
    const query = vi.fn(async () => ({ rows: recorded ? [{ present: 1 }] : [] }));
    const db = { query } as unknown as Parameters<typeof postgresLabConnect>[0]["db"];
    return { query, connect: postgresLabConnect({ db, source: db, actor: "test", timers: true,
      provider: {} as Parameters<typeof postgresLabConnect>[0]["provider"],
      ...(callback ? { prepareTarget: callback } : {}) }) };
  }
  it("requires the canonical creator on an initial SHADOW preparation", async () => {
    const prepare = vi.fn(async () => undefined), p = port(false, prepare);
    await p.connect.prepareTarget(collection);
    expect(prepare).toHaveBeenCalledExactlyOnceWith(collection);
    expect(p.query.mock.calls[0]).toEqual([expect.stringContaining("x.owner_user_id=c.account_id"), [collection]]);
  });
  it("preserves the original NEXT target for a recorded routed-but-not-flipped rerun", async () => {
    const prepare = vi.fn(async () => { throw new Error("Must not re-enter pre-cutover creator"); }), p = port(true, prepare);
    await p.connect.prepareTarget(collection);
    expect(prepare).not.toHaveBeenCalled();
    expect(p.query.mock.calls[0]).toEqual([expect.stringContaining("x.runtime='next'"), [collection]]);
  });
  it("fails closed when the fresh-run composition omitted its canonical creator", async () => {
    await expect(port(false).connect.prepareTarget(collection)).rejects.toMatchObject({ code: "migration_target_unavailable" });
  });
});

describe("existing migration target bootstrap composition", () => {
  it("calls only the canonical target endpoint with its existing migration credential, empty body and no redirects", async () => {
    const fetchImpl = vi.fn(async () => Response.json(body()));
    await labTargetBootstrap(config, fetchImpl)(collection);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, request] = fetchImpl.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(url.href).toBe(`https://connect-lab.mdbase.dev/internal/v1/next/migration/collections/${collection}/target`);
    expect(request).toMatchObject({ method: "POST", body: "{}", redirect: "error",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" } });
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });
  it.each([undefined, "LAB", "staging", "production"])("refuses off-LAB %s before network", environment => {
    const fetchImpl = vi.fn();
    expect(() => labTargetBootstrap({ ...config, environment }, fetchImpl)).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(["http://connect-lab.mdbase.dev", "https://connect.mdbase.dev", "https://user:secret@connect-lab.mdbase.dev", "https://connect-lab.mdbase.dev/?scope=other"])("refuses noncanonical origin %s", url => {
    const fetchImpl = vi.fn(); expect(() => labTargetBootstrap({ ...config, url }, fetchImpl)).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(["collection", "owner", "private", "device-missing", "device-kind", "device-nil"])("does not treat HTTP200 as target identity proof: %s", kind => {
    const value = body();
    if (kind === "collection") value.collection_id = account;
    if (kind === "owner") value.owner_account = collection;
    if (kind === "private") value.state = "private";
    if (kind === "device-missing") value.service_devices = [];
    if (kind === "device-kind") value.service_devices[1]!.kind = "hosted";
    if (kind === "device-nil") value.service_devices[0]!.device_id = "00000000-0000-0000-0000-000000000000";
    return expect(labTargetBootstrap(config, async () => Response.json(value))(collection)).rejects.toMatchObject({ code: "migration_target_unavailable" });
  });
  it.each(["transport", "refused", "invalid", "oversize"])("fails closed without echoing raw errors or retrying: %s", async kind => {
    const fetchImpl = vi.fn(async () => {
      if (kind === "transport") throw new Error("private credential not for stdout");
      if (kind === "refused") return Response.json({ error: { message: "private credential not for stdout" } }, { status: 503 });
      return new Response(kind === "invalid" ? "not JSON" : "x".repeat(1024 * 1024 + 1));
    });
    const error = await labTargetBootstrap(config, fetchImpl)(collection).catch(error => error);
    expect(error.code).toBe("migration_target_unavailable");
    expect(error.message).not.toContain("credential"); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
