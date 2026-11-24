import { describe, expect, it, vi } from "vitest";
import { offlineShellScheduler } from "./offline-shell";

function harness(options: { idle?: boolean; worker?: boolean; controlled?: boolean; waiting?: boolean } = {}) {
  const register = vi.fn(() => Promise.resolve({} as ServiceWorkerRegistration));
  const postMessage = vi.fn();
  const getRegistration = vi.fn(() => Promise.resolve({ waiting: options.waiting ? { postMessage } : null } as unknown as ServiceWorkerRegistration));
  const changes: Array<{ listener: () => void; options: unknown }> = [];
  const reload = vi.fn();
  const idle: Array<() => void> = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const shell = offlineShellScheduler("/app/", {
    serviceWorker: options.worker === false ? undefined : {
      register, getRegistration, controller: options.controlled ? {} : null,
      addEventListener: (_type: string, listener: () => void, listenerOptions: unknown) => { changes.push({ listener, options: listenerOptions }); }
    } as unknown as Pick<ServiceWorkerContainer, "register" | "getRegistration" | "controller" | "addEventListener">,
    requestIdle: options.idle === false ? undefined : (callback) => { idle.push(callback); },
    setTimer: (callback, delay) => { timers.push({ callback, delay }); },
    reload
  });
  const runTimer = (index: number) => timers[index].callback();
  return { shell, register, idle, timers, runTimer, getRegistration, postMessage, changes, reload };
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

  it("moves a page controlled by an older release onto the waiting one at start, reloading once", async () => {
    const updated = harness({ controlled: true, waiting: true });
    updated.shell.start();
    await vi.waitFor(() => expect(updated.postMessage).toHaveBeenCalledWith({ type: "mdbase-shell:activate" }));
    expect(updated.getRegistration).toHaveBeenCalledWith("/app/");
    expect(updated.reload).not.toHaveBeenCalled();
    expect(updated.changes.map(change => change.options)).toEqual([{ once: true }]);
    updated.changes[0].listener();
    expect(updated.reload).toHaveBeenCalledTimes(1);
    expect(updated.register).not.toHaveBeenCalled();
  });

  it("never activates on a first install or when nothing waits", async () => {
    const first = harness({ controlled: false, waiting: true });
    first.shell.start();
    expect(first.getRegistration).not.toHaveBeenCalled();
    const current = harness({ controlled: true, waiting: false });
    current.shell.start();
    await vi.waitFor(() => expect(current.getRegistration).toHaveBeenCalled());
    await Promise.resolve();
    expect(current.postMessage).not.toHaveBeenCalled();
    expect(current.changes).toEqual([]);
  });
});
