import { afterEach, describe, expect, it, vi } from "vitest";
import { appBrowserDirectAccess } from "../src/app-host/browser-direct-access.js";
afterEach(() => {vi.unstubAllGlobals();});
describe("browser direct access compatibility", () => {
  it("returns immutable unsupported, without permission/network/plugin-file effects", async () => {
    const fetch = vi.fn(() => {throw Error("must not fetch");}), socket = vi.fn(() => {throw Error("must not connect");});
    vi.stubGlobal("fetch", fetch); vi.stubGlobal("WebSocket", socket);
    vi.stubGlobal("navigator", {get permissions() {throw Error("must not ask for local-network permission");}});
    const snapshot = appBrowserDirectAccess.snapshot();
    expect(snapshot).toEqual({status: "unsupported"}); expect(Object.isFrozen(snapshot)).toBe(true);
    expect(await appBrowserDirectAccess.check()).toBe(snapshot); expect(await appBrowserDirectAccess.request()).toBe(snapshot);
    appBrowserDirectAccess.disable(); expect(appBrowserDirectAccess.snapshot()).toBe(snapshot);
    expect(fetch).not.toHaveBeenCalled(); expect(socket).not.toHaveBeenCalled();
  });
  it("honors cancellation without claiming a failed connection or changing routes", async () => {
    const abort = new AbortController(); abort.abort();
    await expect(appBrowserDirectAccess.check({signal: abort.signal})).rejects.toThrow();
    await expect(appBrowserDirectAccess.request({signal: abort.signal})).rejects.toThrow();
    expect(appBrowserDirectAccess.snapshot().status).toBe("unsupported");
  });
});
