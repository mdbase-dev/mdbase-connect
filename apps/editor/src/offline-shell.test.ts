import { describe, expect, it, vi } from "vitest";
import { offlineShellScheduler } from "./offline-shell";

function harness(options: { idle?: boolean; worker?: boolean } = {}) {
  const register = vi.fn(() => Promise.resolve({} as ServiceWorkerRegistration));
  const idle: Array<() => void> = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const shell = offlineShellScheduler("/app/", {
    serviceWorker: options.worker === false ? undefined : { register } as unknown as Pick<ServiceWorkerContainer, "register">,
    requestIdle: options.idle === false ? undefined : (callback) => { idle.push(callback); },
    setTimer: (callback, delay) => { timers.push({ callback, delay }); }
  });
  const runTimer = (index: number) => timers[index].callback();
  return { shell, register, idle, timers, runTimer };
}

describe("offline shell registration", () => {
  it("waits for first usable, a settle delay and idle, then registers the build's worker, scope and type", () => {
    const { shell, register, idle, timers, runTimer } = harness();
    shell.ready();
    expect(timers).toHaveLength(1);
    expect(timers[0].delay).toBeGreaterThan(0);
    runTimer(0);
    expect(register).not.toHaveBeenCalled();
    idle.shift()!();
    expect(register).toHaveBeenCalledWith("/app/mdbase-shell-sw.js", { scope: "/app/", type: "module" });
  });

  it("registers once across ready renders and the fallback timer", () => {
    const { shell, register, idle, timers, runTimer } = harness();
    shell.start();
    shell.ready();
    shell.ready();
    expect(timers).toHaveLength(2);
    runTimer(1);
    idle[0]();
    runTimer(0);
    expect(idle).toHaveLength(1);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("falls back to a delayed registration on screens that never become usable", () => {
    const { shell, register, idle, timers, runTimer } = harness();
    shell.start();
    expect(timers[0].delay).toBeGreaterThan(0);
    runTimer(0);
    runTimer(1);
    expect(register).not.toHaveBeenCalled();
    idle[0]();
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("registers without idle callbacks and does nothing without service workers", () => {
    const direct = harness({ idle: false });
    direct.shell.ready();
    direct.runTimer(0);
    expect(direct.register).toHaveBeenCalledTimes(1);
    const unsupported = harness({ worker: false });
    unsupported.shell.ready();
    unsupported.shell.start();
    unsupported.runTimer(0);
    expect(unsupported.timers).toHaveLength(1);
    expect(unsupported.idle).toHaveLength(0);
  });
});
