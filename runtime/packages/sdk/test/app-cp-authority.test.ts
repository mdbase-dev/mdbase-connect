import { describe, expect, it, vi } from "vitest";
import { AppCpLogAuthority, type AppCpSession } from "../src/app-host/cp-authority.js";
import type { AppWasmRuntime } from "../src/app-host/wasm-runtime.js";
const C = "22222222-2222-2222-2222-222222222222", D = "44444444-4444-4444-4444-444444444444", K = "66666666-6666-6666-6666-666666666666";
const now = 1_800_000_000_000;
const ok = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
function fixture(fetchOverride?: typeof fetch) {
  let current = true, time = now;
  const challenge = new Uint8Array(32).fill(0x11), signature = new Uint8Array(64).fill(0x77);
  const runtime = { bindCpConnector: vi.fn(), signCpLogToken: vi.fn(() => signature), signLogHttp: vi.fn(() => new Uint8Array(64)), retireLog: vi.fn() };
  const session: AppCpSession = { connectorId: K, deviceId: D, collection: C, cpOrigin: "https://cp.example", logOrigin: "https://log.example", directOrigins: ["https://object.example"], endpoint: 37, isCurrent: () => current, connectorBearer: vi.fn(async () => "private-connector-bearer") };
  const fetch = vi.fn(fetchOverride ?? (async (u: RequestInfo | URL) => String(u).endsWith("/challenge") ? ok({ challenge: "11".repeat(32), expires_at: time + 60_000 }) : ok({ token: "ls-device-token", expires_at: time + 15 * 60_000 })));
  const authority = new AppCpLogAuthority(runtime as unknown as AppWasmRuntime, session, { fetch, now: () => time });
  return { authority, runtime, session, fetch, signature, challenge, stale: () => { current = false; }, tick: (ms: number) => { time += ms; } };
}
const signal = () => new AbortController().signal;
describe("app CP log-token authority", () => {
  it("requires actual token response before LS transport, fixed route/body/connector headers then caches bounded expiry", async () => {
    const f = fixture(); expect(f.authority.isCurrent()).toBe(false); expect(() => f.authority.logTransport()).toThrow(); expect(f.runtime.bindCpConnector).toHaveBeenCalledWith(f.session);
    expect(await f.authority.accessToken({ signal: signal() })).toBe("ls-device-token"); expect(f.authority.isCurrent()).toBe(true); expect(f.authority.logTransport().isCurrent()).toBe(true);
    const first = f.fetch.mock.calls[0]!, second = f.fetch.mock.calls[1]!; expect(first[0]).toBe("https://cp.example/v1/next/devices/challenge"); expect(second[0]).toBe(`https://cp.example/v1/next/collections/${C}/log-token`);
    expect(first[1]).toMatchObject({ method: "POST", credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", headers: { authorization: "Bearer private-connector-bearer" } });
    expect(JSON.parse(second[1]!.body as string)).toEqual({ device_id: D, challenge: "11".repeat(32), sig: "77".repeat(64) });
    expect(f.runtime.signCpLogToken).toHaveBeenCalledTimes(1); expect(f.signature.every(b => b === 0)).toBe(true);
    expect(await f.authority.accessToken({ signal: signal() })).toBe("ls-device-token"); expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("expiry triggers one fresh challenge, not identity retirement or background retry", async () => {
    const f = fixture(); await f.authority.accessToken({ signal: signal() }); f.tick(15 * 60_000); expect(f.authority.isCurrent()).toBe(true);
    await f.authority.accessToken({ signal: signal() }); expect(f.fetch).toHaveBeenCalledTimes(4); expect(f.runtime.retireLog).not.toHaveBeenCalled();
  });
  it("fences stale selection after bearer await, clears all key owners, no CP request", async () => {
    const f = fixture(); f.session.connectorBearer = async () => { f.stale(); return "credential"; };
    await expect(f.authority.accessToken({ signal: signal() })).rejects.toMatchObject({ reason: "fenced" }); expect(f.fetch).not.toHaveBeenCalled(); expect(f.runtime.retireLog).toHaveBeenCalledTimes(1);
  });
  it("fences stale challenge after fetch with no signing or mint and sanitized error", async () => {
    let stale = () => {}; const f = fixture(async () => { stale(); return ok({ challenge: "11".repeat(32), expires_at: now + 60_000 }); }); stale = f.stale;
    await expect(f.authority.accessToken({ signal: signal() })).rejects.toThrow("app CP authority: fenced"); expect(f.runtime.signCpLogToken).not.toHaveBeenCalled(); expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects late mint after close; aborts outstanding network and never installs a token", async () => {
    let late!: (r: Response) => void;
    const f = fixture(async u => String(u).endsWith("/challenge") ? ok({ challenge: "11".repeat(32), expires_at: now + 60_000 }) : new Promise<Response>(r => { late = r; }));
    const p = f.authority.accessToken({ signal: signal() }); while (!late) await new Promise(r => setTimeout(r, 0)); f.authority.close(); late(ok({ token: "late-secret", expires_at: now + 60_000 }));
    await expect(p).rejects.toMatchObject({ reason: "fenced" }); expect(f.authority.isCurrent()).toBe(false); expect(f.runtime.retireLog).toHaveBeenCalledTimes(1); expect(f.signature.every(b => b === 0)).toBe(true);
    expect((f.fetch.mock.calls[1]![1]!.signal as AbortSignal).aborted).toBe(true);
  });
  it.each([{}, { challenge: "11".repeat(31), expires_at: now + 60_000 }, { challenge: "11".repeat(32), expires_at: now }, { challenge: "11".repeat(32), expires_at: "later" }])("refuses malformed/expired challenge before signing", async reply => {
    const f = fixture(async () => ok(reply)); await expect(f.authority.accessToken({ signal: signal() })).rejects.toMatchObject({ reason: "response" }); expect(f.runtime.signCpLogToken).not.toHaveBeenCalled(); expect(f.authority.isCurrent()).toBe(false);
  });
  it.each([{ token: "x", expires_at: now }, { token: "has spaces", expires_at: now + 60_000 }, { token: "x", expires_at: now + 17 * 60_000 }, { token: "x", expires_at: "later" }])("refuses invalid mint without marking authenticated", async reply => {
    const f = fixture(async u => String(u).endsWith("/challenge") ? ok({ challenge: "11".repeat(32), expires_at: now + 60_000 }) : ok(reply)); await expect(f.authority.accessToken({ signal: signal() })).rejects.toMatchObject({ reason: "response" }); expect(f.authority.isCurrent()).toBe(false); expect(f.signature.every(b => b === 0)).toBe(true);
  });
  it("bounds response before parsing/allocating and sanitizes arbitrary fetch errors", async () => {
    const big = fixture(async () => new Response("", { headers: { "content-length": "1000000" } })); await expect(big.authority.accessToken({ signal: signal() })).rejects.toMatchObject({ reason: "unavailable" }); expect(big.runtime.signCpLogToken).not.toHaveBeenCalled();
    const broken = fixture(async () => { throw Error("private-connector-bearer private URL"); }); await expect(broken.authority.accessToken({ signal: signal() })).rejects.toThrow("app CP authority: unavailable"); expect(broken.fetch).toHaveBeenCalledTimes(1);
  });
  it("pins endpoint/origins/connector and retires on mutable identity changes", async () => {
    const f = fixture(); await f.authority.accessToken({ signal: signal() }); Object.assign(f.session, { connectorId: "77777777-7777-7777-7777-777777777777" });
    await expect(f.authority.accessToken({ signal: signal() })).rejects.toMatchObject({ reason: "fenced" }); expect(f.runtime.retireLog).toHaveBeenCalledTimes(1); expect(f.authority.isCurrent()).toBe(false);
  });
});
