import { describe, expect, it } from "vitest";
import { RUNTIME_GLOBAL, sharedRuntime, type ClientPort, type RuntimeInstance, type SessionAuth } from "../src/shared/registry.js";
import type { ApiVersion, RuntimeInfo } from "../src/shared/skew.js";

class FakeRuntime implements RuntimeInstance {
  hosting = new Set<string>();
  log: string[];
  constructor(readonly info: RuntimeInfo, log: string[], private lease: Map<string, string>) {
    this.log = log;
  }
  async openHost(id: string) {
    const holder = this.lease.get(id);
    if (holder) throw new Error(`lease held by ${holder}`);
    this.lease.set(id, this.info.runtimeVersion);
    this.hosting.add(id);
    this.log.push(`open ${this.info.runtimeVersion} ${id}`);
  }
  async closeHost(id: string) {
    this.lease.delete(id);
    this.hosting.delete(id);
    this.log.push(`close ${this.info.runtimeVersion} ${id}`);
  }
  connect(id: string, api: ApiVersion, auth: SessionAuth): ClientPort & { via: string; auth: SessionAuth } {
    if (!this.hosting.has(id)) throw new Error("not hosting");
    return { via: `${this.info.runtimeVersion}@${api.major}.${api.minor}`, auth, close() {} };
  }
  async dispose() {
    this.log.push(`dispose ${this.info.runtimeVersion}`);
  }
}

const info = (v: string, minor = 0): RuntimeInfo => ({
  abiMajor: 1,
  runtimeVersion: v,
  sem: { major: 1, minor },
  serves: [{ major: 1, minor: 0 }],
  speaks: [{ major: 1, minor: 0 }],
});

function setup() {
  const g: Record<string, unknown> = {};
  const log: string[] = [];
  const lease = new Map<string, string>();
  const slot = sharedRuntime(1, g);
  const make = (v: string) => async () => new FakeRuntime(info(v), log, lease);
  return { g, log, lease, slot, make };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve: () => resolve() };
}
const ctx = { logSemMajor: 1, daemonHosts: false, auth: { kind: "host" } as SessionAuth };
const via = (p: ClientPort | null) => (p as unknown as { via: string } | null)?.via;

describe("shared runtime registry", () => {
  it("is one slot per ABI major on the global", () => {
    const { g, slot } = setup();
    expect(sharedRuntime(1, g)).toBe(slot);
    expect(sharedRuntime(2, g)).not.toBe(slot);
    expect(Object.keys(g)).toEqual([]); // non-enumerable
    expect(g[RUNTIME_GLOBAL]).toBeDefined();
  });

  it("instantiates a version once and shares it", async () => {
    const { slot } = setup();
    let created = 0;
    const create = async () => {
      created++;
      return new FakeRuntime(info("1.0.0"), [], new Map());
    };
    await Promise.all([slot.register("tasknotes", info("1.0.0"), create), slot.register("mdbase", info("1.0.0"), create)]);
    expect(created).toBe(1);
  });

  it("first hosts, equal attaches as client", async () => {
    const { slot, make } = setup();
    await slot.register("a", info("1.0.0"), make("1.0.0"));
    await slot.register("b", info("1.0.0"), make("1.0.0"));
    const a = await slot.attach("a", "1.0.0", "c1", ctx);
    const b = await slot.attach("b", "1.0.0", "c1", ctx);
    expect(a.role.kind).toBe("host");
    expect(b.role.kind).toBe("client");
    expect(via(b.port)).toBe("1.0.0@1.0");
  });

  it("a newer runtime takes over and re-homes existing clients", async () => {
    const { slot, make, log } = setup();
    await slot.register("old", info("1.0.0"), make("1.0.0"));
    await slot.register("new", info("1.2.0"), make("1.2.0"));
    const a = await slot.attach("old", "1.0.0", "c1", ctx);
    const rehomed: string[] = [];
    a.onRehome((p) => rehomed.push(via(p)!));
    const b = await slot.attach("new", "1.2.0", "c1", ctx);
    expect(b.role).toEqual({ kind: "host" });
    expect(a.role).toEqual({ kind: "client", of: "1.2.0", api: { major: 1, minor: 0 } });
    expect(rehomed).toEqual(["1.2.0@1.0"]);
    expect(log).toEqual(["open 1.0.0 c1", "close 1.0.0 c1", "open 1.2.0 c1"]);
    expect(slot.hostOf("c1")?.runtimeVersion).toBe("1.2.0");
  });

  it("unloading the hosting plugin hands the collection to the remaining runtime", async () => {
    const { slot, make, log } = setup();
    await slot.register("old", info("1.0.0"), make("1.0.0"));
    await slot.register("new", info("1.2.0"), make("1.2.0"));
    const a = await slot.attach("old", "1.0.0", "c1", ctx);
    await slot.attach("new", "1.2.0", "c1", ctx);
    await slot.unregister("new");
    expect(slot.hostOf("c1")?.runtimeVersion).toBe("1.0.0");
    expect(a.role.kind).toBe("host");
    expect(log.slice(-3)).toEqual(["close 1.2.0 c1", "open 1.0.0 c1", "dispose 1.2.0"]);
  });

  it("the host closes when the last attachment detaches, freeing the lease", async () => {
    const { slot, make, lease } = setup();
    await slot.register("a", info("1.0.0"), make("1.0.0"));
    const a = await slot.attach("a", "1.0.0", "c1", ctx);
    expect(lease.get("c1")).toBe("1.0.0");
    await a.detach();
    expect(lease.has("c1")).toBe(false);
    expect(slot.hostOf("c1")).toBeNull();
  });

  it("a stale detached handle never closes a later attachment's host", async () => {
    const { slot, make, log, lease } = setup();
    await slot.register("a", info("1.0.0"), make("1.0.0"));
    await slot.register("b", info("1.0.0"), make("1.0.0"));
    const a = await slot.attach("a", "1.0.0", "c1", ctx);
    await a.detach();
    const b = await slot.attach("b", "1.0.0", "c1", ctx);
    const port = b.port;
    await a.detach();
    expect(b.port).toBe(port);
    expect(b.port).not.toBeNull();
    expect(slot.hostOf("c1")?.runtimeVersion).toBe("1.0.0");
    expect(lease.get("c1")).toBe("1.0.0");
    expect(log.filter(line => line.startsWith("close"))).toHaveLength(1);
    await b.detach();
    expect(lease.size).toBe(0);
    expect(log.filter(line => line.startsWith("close"))).toHaveLength(2);
  });

  it("queued detach, reattach and stale detach preserve the replacement lease", async () => {
    const { slot, make, log, lease } = setup();
    await slot.register("a", info("1.0.0"), make("1.0.0"));
    await slot.register("b", info("1.0.0"), make("1.0.0"));
    const a = await slot.attach("a", "1.0.0", "c1", ctx);
    const first = a.detach();
    const replacement = slot.attach("b", "1.0.0", "c1", ctx);
    const stale = a.detach();
    await first;
    const b = await replacement;
    await stale;
    expect(b.port).not.toBeNull();
    expect(lease.get("c1")).toBe("1.0.0");
    expect(slot.hostOf("c1")?.runtimeVersion).toBe("1.0.0");
    expect(log.filter(line => line.startsWith("close"))).toHaveLength(1);
    await slot.unregister("b");
    expect(lease.size).toBe(0);
  });

  it("a failed takeover leaves the old host in place", async () => {
    const { slot, log, lease } = setup();
    await slot.register("old", info("1.0.0"), async () => new FakeRuntime(info("1.0.0"), log, lease));
    const broken = new FakeRuntime(info("1.3.0"), log, lease);
    broken.openHost = async () => {
      throw new Error("lease held by another window");
    };
    await slot.register("new", info("1.3.0"), async () => broken);
    const a = await slot.attach("old", "1.0.0", "c1", ctx);
    await expect(slot.attach("new", "1.3.0", "c1", ctx)).rejects.toThrow(/lease/);
    expect(slot.hostOf("c1")?.runtimeVersion).toBe("1.0.0");
    expect(via(a.port)).toBe("1.0.0@1.0");
  });

  it("rolls back a newly opened host if its first session fails", async () => {
    const { slot, log, lease } = setup();
    const rt = new FakeRuntime(info("1.0.0"), log, lease);
    const connect = rt.connect.bind(rt);
    rt.connect = () => { throw new Error("session rejected"); };
    await slot.register("a", info("1.0.0"), async () => rt);
    await expect(slot.attach("a", "1.0.0", "c1", ctx)).rejects.toThrow("session rejected");
    expect(lease.has("c1")).toBe(false);
    expect(slot.hostOf("c1")).toBeNull();
    expect(log).toEqual(["open 1.0.0 c1", "close 1.0.0 c1"]);
    rt.connect = connect;
    const a = await slot.attach("a", "1.0.0", "c1", ctx);
    expect(a.role.kind).toBe("host");
    await a.detach();
    expect(lease.size).toBe(0);
  });

  it("preserves host ownership if first-session rollback cannot flush", async () => {
    const { slot, log, lease } = setup();
    const rt = new FakeRuntime(info("1.0.0"), log, lease);
    const close = rt.closeHost.bind(rt);
    rt.connect = () => { throw new Error("session rejected"); };
    rt.closeHost = async () => { throw new Error("flush failed"); };
    await slot.register("a", info("1.0.0"), async () => rt);
    const failure = await slot.attach("a", "1.0.0", "c1", ctx).catch(error => error as AggregateError);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((e: Error) => e.message)).toEqual(["session rejected", "flush failed"]);
    expect(slot.hostOf("c1")?.runtimeVersion).toBe("1.0.0");
    expect(lease.get("c1")).toBe("1.0.0");
    rt.closeHost = close;
    await slot.unregister("a");
    expect(lease.size).toBe(0);
    expect(slot.hostOf("c1")).toBeNull();
  });

  it("retries unregister when both session rollback and the first cleanup fail", async () => {
    const { slot, log, lease } = setup();
    const rt = new FakeRuntime(info("1.0.0"), log, lease);
    const close = rt.closeHost.bind(rt);
    rt.connect = () => { throw new Error("session rejected"); };
    rt.closeHost = async () => { throw new Error("flush failed"); };
    await slot.register("a", info("1.0.0"), async () => rt);
    await expect(slot.attach("a", "1.0.0", "c1", ctx)).rejects.toBeInstanceOf(AggregateError);
    await expect(slot.unregister("a")).rejects.toThrow("flush failed");
    expect(lease.get("c1")).toBe("1.0.0");
    expect(slot.versions()).toEqual(["1.0.0"]);
    rt.closeHost = close;
    await slot.unregister("a");
    expect(lease.size).toBe(0);
    expect(slot.hostOf("c1")).toBeNull();
    expect(slot.versions()).toEqual([]);
    expect(log.at(-1)).toBe("dispose 1.0.0");
  });

  it("retries a failed dispose without disposing a different runtime", async () => {
    const { slot, log, lease } = setup();
    const rt = new FakeRuntime(info("1.0.0"), log, lease);
    const dispose = rt.dispose.bind(rt);
    rt.dispose = async () => { throw new Error("worker teardown failed"); };
    await slot.register("a", info("1.0.0"), async () => rt);
    await slot.register("b", info("1.1.0"), async () => new FakeRuntime(info("1.1.0"), log, lease));
    await expect(slot.unregister("a")).rejects.toThrow("worker teardown failed");
    expect(slot.versions()).toEqual(["1.0.0", "1.1.0"]);
    rt.dispose = dispose;
    await slot.unregister("a");
    expect(slot.versions()).toEqual(["1.1.0"]);
    expect(log).toEqual(["dispose 1.0.0"]);
  });

  it("allows retrying the last detach after a failed flush", async () => {
    const { slot, log, lease } = setup();
    const rt = new FakeRuntime(info("1.0.0"), log, lease);
    const close = rt.closeHost.bind(rt);
    await slot.register("a", info("1.0.0"), async () => rt);
    const a = await slot.attach("a", "1.0.0", "c1", ctx);
    rt.closeHost = async () => { throw new Error("flush failed"); };
    await expect(a.detach()).rejects.toThrow("flush failed");
    expect(a.port).toBeNull();
    expect(slot.hostOf("c1")?.runtimeVersion).toBe("1.0.0");
    expect(lease.get("c1")).toBe("1.0.0");
    rt.closeHost = close;
    await a.detach();
    await a.detach(); // idempotent after successful close
    expect(lease.size).toBe(0);
    expect(slot.hostOf("c1")).toBeNull();
    expect(log.filter(line => line.startsWith("close"))).toHaveLength(1);
  });

  it("can retry unregister after its last attachment fails to flush", async () => {
    const { slot, log, lease } = setup();
    const rt = new FakeRuntime(info("1.0.0"), log, lease);
    const close = rt.closeHost.bind(rt);
    await slot.register("a", info("1.0.0"), async () => rt);
    await slot.attach("a", "1.0.0", "c1", ctx);
    rt.closeHost = async () => { throw new Error("flush failed"); };
    await expect(slot.unregister("a")).rejects.toThrow("flush failed");
    expect(slot.versions()).toEqual(["1.0.0"]);
    expect(lease.has("c1")).toBe(true);
    rt.closeHost = close;
    await slot.unregister("a");
    expect(lease.size).toBe(0);
    expect(slot.versions()).toEqual([]);
    expect(log.at(-1)).toBe("dispose 1.0.0");
  });

  for (const phase of ["close", "dispose"] as const) {
    it(`waits for delayed ${phase} before registering and attaching the same version`, async () => {
      const { slot, log, lease } = setup();
      const old = new FakeRuntime(info("1.0.0"), log, lease);
      const next = new FakeRuntime(info("1.0.0"), log, lease);
      const entered = deferred();
      const finish = deferred();
      if (phase === "close") {
        const close = old.closeHost.bind(old);
        old.closeHost = async (id) => { entered.resolve(); await finish.promise; await close(id); };
      } else {
        const dispose = old.dispose.bind(old);
        old.dispose = async () => { entered.resolve(); await finish.promise; await dispose(); };
      }
      await slot.register("a", info("1.0.0"), async () => old);
      await slot.attach("a", "1.0.0", "c1", ctx);
      const retiring = slot.unregister("a");
      await entered.promise;
      let created = false;
      const registering = slot.register("b", info("1.0.0"), async () => { created = true; return next; });
      const attaching = slot.attach("b", "1.0.0", "c1", ctx);
      let registered = false;
      void registering.then(() => { registered = true; });
      await Promise.resolve();
      await Promise.resolve();
      expect(registered).toBe(false);
      expect(created).toBe(false);
      finish.resolve();
      await retiring;
      await registering;
      const b = await attaching;
      expect(created).toBe(true);
      expect(b.port).not.toBeNull();
      expect(old.hosting.size).toBe(0);
      expect(next.hosting.has("c1")).toBe(true);
      expect(slot.hostOf("c1")?.runtimeVersion).toBe("1.0.0");
      expect(log.filter(line => line.startsWith("dispose"))).toHaveLength(1);
      await b.detach();
      expect(lease.size).toBe(0);
    });
  }

  it("unregister waits for an already-opening attachment before retiring it", async () => {
    const { slot, log, lease } = setup();
    const rt = new FakeRuntime(info("1.0.0"), log, lease);
    const open = rt.openHost.bind(rt);
    const entered = deferred();
    const finish = deferred();
    rt.openHost = async (id) => { entered.resolve(); await finish.promise; await open(id); };
    await slot.register("a", info("1.0.0"), async () => rt);
    const attaching = slot.attach("a", "1.0.0", "c1", ctx);
    await entered.promise;
    const retiring = slot.unregister("a");
    finish.resolve();
    const a = await attaching;
    await retiring;
    expect(a.port).toBeNull();
    expect(lease.size).toBe(0);
    expect(rt.hosting.size).toBe(0);
    expect(slot.hostOf("c1")).toBeNull();
    expect(slot.versions()).toEqual([]);
    expect(log).toEqual(["open 1.0.0 c1", "close 1.0.0 c1", "dispose 1.0.0"]);
  });

  it("a failed retirement rejects queued registration until cleanup is retried", async () => {
    const { slot, log, lease } = setup();
    const rt = new FakeRuntime(info("1.0.0"), log, lease);
    const dispose = rt.dispose.bind(rt);
    const entered = deferred();
    const finish = deferred();
    rt.dispose = async () => { entered.resolve(); await finish.promise; throw new Error("teardown failed"); };
    await slot.register("a", info("1.0.0"), async () => rt);
    const retiring = slot.unregister("a");
    const rejected = expect(retiring).rejects.toThrow("teardown failed");
    await entered.promise;
    const registering = expect(slot.register("b", info("1.0.0"), async () => { throw new Error("must not create yet"); })).rejects.toThrow("retiring");
    const attaching = expect(slot.attach("b", "1.0.0", "c1", ctx)).rejects.toThrow("active runtime");
    finish.resolve();
    await rejected;
    await registering;
    await attaching;
    expect(rt.hosting.size).toBe(0);
    rt.dispose = dispose;
    await slot.unregister("a");
    expect(lease.size).toBe(0);
    expect(slot.versions()).toEqual([]);
    const next = new FakeRuntime(info("1.0.0"), log, lease);
    await slot.register("b", info("1.0.0"), async () => next);
    const b = await slot.attach("b", "1.0.0", "c1", ctx);
    expect(next.hosting.has("c1")).toBe(true);
    await b.detach();
  });

  it("passes each plugin's own authority through, also after a handoff", async () => {
    const { slot, make } = setup();
    await slot.register("tasknotes", info("1.0.0"), make("1.0.0"));
    await slot.register("third-party", info("1.0.0"), make("1.0.0"));
    await slot.register("mdbase", info("1.1.0"), make("1.1.0"));
    await slot.attach("tasknotes", "1.0.0", "c1", ctx);
    const grant: SessionAuth = { kind: "grant", grant: "g1", clientPk: new Uint8Array(32) };
    const tp = await slot.attach("third-party", "1.0.0", "c1", { ...ctx, auth: grant });
    const authOf = (p: ClientPort | null) => (p as unknown as { auth: SessionAuth }).auth;
    expect(authOf(tp.port)).toBe(grant);
    await slot.attach("mdbase", "1.1.0", "c1", ctx);
    expect(authOf(tp.port)).toBe(grant);
  });
});
