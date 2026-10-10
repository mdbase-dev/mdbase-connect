import { afterEach, describe, it, expect, vi } from "vitest";
import { AppForegroundLogWake } from "../src/app-host/foreground-wake.js";
import type { AppWasmRuntime } from "../src/app-host/wasm-runtime.js";
import type { AppCpLogAuthority } from "../src/app-host/cp-authority.js";
function fixture() {
  const events: string[] = []; let current = true;
  const transport = {};
  const pump = { pump: vi.fn(async () => { events.push("pump"); }) };
  const authority = { endpoint: 37n, collection: "22222222-2222-2222-2222-222222222222", origin: "https://log.example", isCurrent: () => current,
    accessToken: vi.fn(async (_options: { signal: AbortSignal }) => { events.push("cp"); return "not-persisted"; }), logTransport: vi.fn(() => transport) };
  const runtime = { reconnectLogTransport: vi.fn(async () => { events.push("reconnect"); return pump; }), tick: vi.fn(() => { events.push("tick"); }) };
  const onUnavailable = vi.fn();
  const wake = new AppForegroundLogWake(runtime as unknown as AppWasmRuntime, authority as unknown as AppCpLogAuthority, { periodMs: 5000, onUnavailable });
  return { wake, runtime, pump, authority, events, onUnavailable, fence: () => { current = false; } };
}
afterEach(() => { vi.useRealTimers(); });
describe("foreground hints use existing authenticated native replacement, never remote push authority", () => {
  it("CP admission precedes SAME-owner reconnect/tick/pump; hidden/foreign hints no-op", async () => {
    const f = fixture(); expect(await f.wake.notificationHint(f.authority.collection)).toBe(false); expect(f.events).toEqual([]);
    expect(await f.wake.foreground()).toBe(true); expect(f.events).toEqual(["cp", "reconnect", "tick", "pump"]);
    expect(await f.wake.notificationHint("foreign")).toBe(false); expect(f.authority.accessToken).toHaveBeenCalledTimes(1); await f.wake.close();
  });
  it("coalesces foreground/CP hints while the first admitted wake is running", async () => {
    const f = fixture(); let resolve!: (value: string) => void;
    f.authority.accessToken.mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
    const a = f.wake.foreground(), b = f.wake.notificationHint(f.authority.collection); expect(f.authority.accessToken).toHaveBeenCalledTimes(1);
    resolve("admitted"); expect(await a).toBe(true); expect(await b).toBe(true); expect(f.runtime.reconnectLogTransport).toHaveBeenCalledTimes(1); await f.wake.close();
  });
  it("visible periodic head wake is bounded; hidden clears polling", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.wake.foreground(); await vi.advanceTimersByTimeAsync(5000);
    expect(f.runtime.reconnectLogTransport).toHaveBeenCalledTimes(2); f.wake.hidden(); await vi.advanceTimersByTimeAsync(15000);
    expect(f.authority.accessToken).toHaveBeenCalledTimes(2); await f.wake.close();
  });
  it("hidden after token await does not start a native replacement", async () => {
    const f = fixture(); let resolve!: (value: string) => void;
    f.authority.accessToken.mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
    const pending = f.wake.foreground(); f.wake.hidden(); resolve("admitted"); expect(await pending).toBe(false); expect(f.runtime.reconnectLogTransport).not.toHaveBeenCalled(); await f.wake.close();
  });
  it("offline CP failure does not retire/recreate local owners", async () => {
    const f = fixture(); f.authority.accessToken.mockRejectedValueOnce(new Error("private credential MUST NOT escape"));
    await expect(f.wake.foreground()).rejects.toMatchObject({ reason: "unavailable", message: "app foreground wake: unavailable" });
    expect(f.runtime.reconnectLogTransport).not.toHaveBeenCalled(); expect(await f.wake.foreground()).toBe(true); await f.wake.close();
  });
  it("source mutation after an await fences before replacement", async () => {
    const f = fixture(); f.authority.accessToken.mockImplementationOnce(async () => { f.authority.collection = "foreign"; return "admitted"; });
    await expect(f.wake.foreground()).rejects.toMatchObject({ reason: "fenced" }); expect(f.runtime.reconnectLogTransport).not.toHaveBeenCalled(); await f.wake.close();
  });
  it("closed scheduler aborts CP admission and waits; close is not native lease release", async () => {
    const f = fixture(); let resolve!: (value: string) => void, signal!: AbortSignal;
    f.authority.accessToken.mockImplementationOnce(options => { signal = options.signal; return new Promise(yes => { resolve = yes; }); });
    const pending = f.wake.foreground(), stopped = f.wake.close(); expect(signal.aborted).toBe(true); resolve("admitted");
    await expect(pending).rejects.toMatchObject({ reason: "fenced" }); await stopped; expect(f.runtime.reconnectLogTransport).not.toHaveBeenCalled();
  });
  it("periodic stale-owner failure is content-free and does not become unhandled", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.wake.foreground(); f.fence(); await vi.advanceTimersByTimeAsync(5000);
    expect(f.onUnavailable).toHaveBeenCalledTimes(1); expect(f.runtime.reconnectLogTransport).toHaveBeenCalledTimes(1); await f.wake.close();
  });
});
