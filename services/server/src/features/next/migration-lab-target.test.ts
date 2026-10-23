import { describe, expect, it, vi } from "vitest";
import { labTargetBootstrap, labTargetSubCause, migrationJobEnvironment } from "./migration-lab-target.js";
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
    return { query, connect: postgresLabConnect({ db, source: db, actor: "test", timers: true, environment: "lab",
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
    const error = await port(false).connect.prepareTarget(collection).catch(error => error);
    expect(error).toHaveProperty("code", "migration_target_unavailable");
    expect(labTargetSubCause(error, "lab")).toEqual({ call: "guard", guard: "composition" });
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
  it.each([undefined, "", "LAB", "Staging", "Production", "prod", "local", "lab ", "staging\n", "production "])("refuses unknown environment %j before network", environment => {
    const fetchImpl = vi.fn();
    expect(() => labTargetBootstrap({ ...config, environment }, fetchImpl)).toThrow(expect.objectContaining({ code: "lab_only" }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    ["staging", "https://connect-staging.mdbase.dev"], ["production", "https://connect.mdbase.dev"]
  ])("admits %s only against its fixed canonical origin", async (environment, url) => {
    const managed = { ...config, environment, url };
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(body()));
    await labTargetBootstrap(managed, fetchImpl)(collection);
    expect((fetchImpl.mock.calls[0]! as unknown as [URL])[0].href)
      .toBe(`${url}/internal/v1/next/migration/collections/${collection}/target`);
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ method: "POST", body: "{}", redirect: "error" });
  });
  it.each([
    ["staging", "https://connect-lab.mdbase.dev"], ["lab", "https://connect-staging.mdbase.dev"],
    ["staging", "https://connect.mdbase.dev"], ["staging", "http://connect-staging.mdbase.dev"],
    ["production", "https://connect-staging.mdbase.dev"], ["production", "https://connect-lab.mdbase.dev"],
    ...["", "not a URL", "http://connect.mdbase.dev", "https://arbitrary.invalid", "https://connect.mdbase.dev:444",
      "https://user:secret@connect.mdbase.dev", "https://connect.mdbase.dev/path", "https://connect.mdbase.dev/?target=other",
      "https://connect.mdbase.dev/#fragment"].map(url => ["production", url])
  ])("refuses %s target %s before transport", async (environment, url) => {
    const refused = vi.fn();
    await expect(labTargetBootstrap({ ...config, environment, url: url! }, refused)(collection))
      .rejects.toHaveProperty("code", "migration_target_unavailable");
    expect(refused).not.toHaveBeenCalled();
  });
  it.each(["http://connect-lab.mdbase.dev", "https://connect.mdbase.dev", "https://user:secret@connect-lab.mdbase.dev", "https://connect-lab.mdbase.dev/?scope=other"])("refuses noncanonical origin %s", async url => {
    const fetchImpl = vi.fn();
    const error = await labTargetBootstrap({ ...config, url }, fetchImpl)(collection).catch(error => error);
    expect(labTargetSubCause(error, "lab")).toEqual({ call: "guard", guard: "origin" });
    expect(labTargetSubCause(error, "production")).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(["collection", "owner", "private", "device-missing", "device-kind", "device-nil"])("does not treat HTTP200 as target identity proof: %s", async kind => {
    const value = body();
    if (kind === "collection") value.collection_id = account;
    if (kind === "owner") value.owner_account = collection;
    if (kind === "private") value.state = "private";
    if (kind === "device-missing") value.service_devices = [];
    if (kind === "device-kind") value.service_devices[1]!.kind = "hosted";
    if (kind === "device-nil") value.service_devices[0]!.device_id = "00000000-0000-0000-0000-000000000000";
    for (const [environment, url] of [["lab", config.url], ["staging", "https://connect-staging.mdbase.dev"], ["production", "https://connect.mdbase.dev"]]) {
      await expect(labTargetBootstrap({ ...config, environment, url: url! }, async () => Response.json(value))(collection))
        .rejects.toMatchObject({ code: "migration_target_unavailable" });
    }
  });
  it("retains only finite network causes, not exception messages or arbitrary names/codes", async () => {
    for (const code of ["ENOTFOUND", "private credential not for capture"]) {
      const failure = new TypeError("private message not for capture", { cause: { code } });
      const error = await labTargetBootstrap(config, async () => { throw failure; })(collection).catch(error => error);
      expect(labTargetSubCause(error, "lab")).toEqual({ call: "fetch", name: "TypeError", network_code: code === "ENOTFOUND" ? code : "unknown" });
    }
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

describe("migration job environment gate (deployment configuration only)", () => {
  it.each([["lab", "lab"], ["staging", "staging"], ["production", "production"], ["local", undefined],
    [undefined, undefined], ["", undefined], ["LAB", undefined], ["STAGING", undefined]] as const)("%j -> %j", (environment, expected) => {
    expect(migrationJobEnvironment(environment)).toBe(expected);
  });
  it.each(["Production", "prod", "local", "LAB", "", undefined])("refuses to compose the job's control-plane port in a %j deployment", environment => {
    const db = { query: vi.fn() } as unknown as Parameters<typeof postgresLabConnect>[0]["db"];
    expect(() => postgresLabConnect({ db, source: db, actor: "test", timers: true, environment,
      provider: {} as Parameters<typeof postgresLabConnect>[0]["provider"] })).toThrow(expect.objectContaining({ code: "lab_only" }));
    expect(db.query).not.toHaveBeenCalled();
  });
  it.each([
    ["lab", { profile: "lab-fixture-v1" }, false], ["lab", {}, true], ["staging", {}, true], ["production", {}, true]
  ] as const)("%s selects the contract from recorded start metadata %j", async (environment, metadata, managed) => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ backend: "legacy", member: true, released: true, frozen: true, started: true, excluded: false }] })
      .mockResolvedValueOnce({ rows: [{ metadata }] })
      .mockResolvedValueOnce({ rows: [{ id: collection, state: "active" }] })
      .mockResolvedValueOnce({ rows: [] });
    const db = { query } as unknown as Parameters<typeof postgresLabConnect>[0]["db"];
    const connect = postgresLabConnect({ db, source: db, actor: "operator", timers: true, environment,
      provider: {} as Parameters<typeof postgresLabConnect>[0]["provider"] });
    expect(await connect.preflight(account)).toEqual(managed
      ? { job: "managed", collections: [collection], backend: "legacy", cut_over_collections: [], run: null }
      : { collection, backend: "legacy" });
    expect(query.mock.calls[1]).toEqual([expect.stringContaining("LIMIT 2"), [account]]);
    expect(query.mock.calls[1]![0]).not.toContain("metadata->>"); // Never filter away contradictory starts.
  });
  it.each(["lab", "staging", "production"])("%s refuses missing, ambiguous or unknown recorded starts", async environment => {
    for (const rows of [[], [{ metadata: {} }, { metadata: {} }], [{ metadata: { profile: "lab-fixture-v1" } }, { metadata: {} }],
      [{ metadata: { profile: "future" } }], [{ metadata: { profile: null } }], [{ metadata: [] }], [{ metadata: null }]]) {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [{ member: true, released: true, frozen: true, started: true }] })
        .mockResolvedValueOnce({ rows });
      const db = { query } as unknown as Parameters<typeof postgresLabConnect>[0]["db"];
      const connect = postgresLabConnect({ db, source: db, actor: "operator", timers: true, environment,
        provider: {} as Parameters<typeof postgresLabConnect>[0]["provider"] });
      await expect(connect.preflight(account)).rejects.toHaveProperty("code", "start_profile_invalid");
      expect(query).toHaveBeenCalledTimes(2);
    }
  });
  it.each(["staging", "production"])("%s cannot adopt even a single LAB fixture start", async environment => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ member: true, released: true, frozen: true, started: true }] })
      .mockResolvedValueOnce({ rows: [{ metadata: { profile: "lab-fixture-v1" } }] });
    const db = { query } as unknown as Parameters<typeof postgresLabConnect>[0]["db"];
    const connect = postgresLabConnect({ db, source: db, actor: "operator", timers: true, environment,
      provider: {} as Parameters<typeof postgresLabConnect>[0]["provider"] });
    await expect(connect.preflight(account)).rejects.toHaveProperty("code", "start_profile_invalid");
    expect(query).toHaveBeenCalledTimes(2);
  });
});
