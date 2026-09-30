import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupPwaInstall } from "./pwa-install";

let stop: (() => void) | undefined;
let mode: EventTarget & { matches: boolean };
const banner = () => document.querySelector(".pwa-install");
const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".pwa-install button"));
function installEvent(outcome: "accepted" | "dismissed" = "accepted") {
  const event = new Event("beforeinstallprompt", { cancelable: true });
  const prompt = vi.fn(async () => {});
  Object.assign(event, { prompt, userChoice: Promise.resolve({ outcome }) });
  window.dispatchEvent(event);
  return { event, prompt };
}
beforeEach(() => {
  vi.useFakeTimers();
  mode = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => mode);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Chrome");
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("optional PWA invitation", () => {
  it("delays the invitation and only invokes the native prompt on a click", async () => {
    stop = setupPwaInstall("mdbase editor");
    const { event, prompt } = installEvent();
    expect(event.defaultPrevented).toBe(true);
    expect(banner()).toBeNull();
    vi.advanceTimersByTime(30_000);
    expect(banner()?.textContent).toContain("mdbase editor");
    expect(prompt).not.toHaveBeenCalled();
    buttons()[0]!.click();
    buttons()[0]!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(banner()).toBeNull();
  });
  it("does not prompt unsupported browsers", () => {
    stop = setupPwaInstall("mdbase editor");
    vi.advanceTimersByTime(30_000);
    expect(banner()).toBeNull();
  });
  it("handles native eligibility arriving after the delay", () => {
    stop = setupPwaInstall("mdbase editor");
    vi.advanceTimersByTime(30_000);
    installEvent();
    expect(banner()).not.toBeNull();
  });
  it("remembers Not now for 30 days", () => {
    stop = setupPwaInstall("mdbase editor");
    installEvent();
    vi.advanceTimersByTime(30_000);
    buttons()[1]!.click();
    expect(banner()).toBeNull();
    stop();
    stop = setupPwaInstall("mdbase editor");
    expect(installEvent().event.defaultPrevented).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(banner()).toBeNull();
    stop();
    vi.advanceTimersByTime(30 * 24 * 60 * 60 * 1000);
    stop = setupPwaInstall("mdbase editor");
    installEvent();
    vi.advanceTimersByTime(30_000);
    expect(banner()).not.toBeNull();
  });
  it("also cools down after native dismissal", async () => {
    stop = setupPwaInstall("mdbase editor");
    installEvent("dismissed");
    vi.advanceTimersByTime(30_000);
    buttons()[0]!.click();
    await vi.advanceTimersByTimeAsync(0);
    stop();
    stop = setupPwaInstall("mdbase editor");
    installEvent();
    vi.advanceTimersByTime(30_000);
    expect(banner()).toBeNull();
  });
  it("hides on installation or standalone transition", () => {
    stop = setupPwaInstall("mdbase editor");
    installEvent();
    vi.advanceTimersByTime(30_000);
    window.dispatchEvent(new Event("appinstalled"));
    expect(banner()).toBeNull();
    stop();
    stop = setupPwaInstall("mdbase editor");
    installEvent();
    vi.advanceTimersByTime(30_000);
    mode.matches = true;
    mode.dispatchEvent(new Event("change"));
    expect(banner()).toBeNull();
  });
  it("never invites already installed users", () => {
    mode.matches = true;
    stop = setupPwaInstall("mdbase editor");
    expect(installEvent().event.defaultPrevented).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(banner()).toBeNull();
  });
  it("offers manual Home Screen instructions on iOS Safari", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone Version/18.0 Safari/604.1");
    stop = setupPwaInstall("mdbase editor");
    vi.advanceTimersByTime(30_000);
    expect(banner()?.textContent).toContain("tap Share, then Add to Home Screen");
    expect(buttons().map(button => button.textContent)).toEqual(["Not now"]);
  });
  it("survives blocked storage and failed native prompts", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    stop = setupPwaInstall("mdbase editor");
    const { prompt } = installEvent();
    prompt.mockRejectedValueOnce(new Error("unavailable"));
    vi.advanceTimersByTime(30_000);
    buttons()[0]!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(banner()).toBeNull();
  });
  it("cleans up listeners and the pending timer", () => {
    stop = setupPwaInstall("mdbase editor");
    stop();
    expect(installEvent().event.defaultPrevented).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(banner()).toBeNull();
  });
});
