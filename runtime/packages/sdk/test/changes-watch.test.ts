import { describe, expect, it, vi } from "vitest";
import { connect, type CborValue, type ChangesWatch, type FramePort } from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";
import { clientFrame, changesResult, type ChangesResult } from "../src/wire.js";

const app = { name: "watch-model", version: "0" };
const id = "0192f3a4-6000-7abc-8def-0123456789ab";
const batch = (cursor = "opaque", path?: string): ChangesResult => ({
  cursor, reset: false, changes: path ? [{ id, path, kind: "put", version: 1 }] : [],
});
async function fixture(reconnect = false) {
  const replica = new MemoryReplica({ confirmDelayMs: null });
  const base = replica.connector();
  const requests: Array<{ id: number; port: FramePort; cursor: unknown }> = [];
  const cancellations: number[] = [];
  const ports: FramePort[] = [];
  let rejectCancel = false;
  const client = await connect({ app, reconnect: reconnect ? { minDelayMs: 1, maxDelayMs: 1 } : false,
    connector: { description: "actual Session/MemoryReplica held-frame model", open: async (hello, signal) => {
      const opened = await base.open(hello, signal); const port = opened.port;
      const send = port.send.bind(port);
      port.send = raw => {
        const f = clientFrame.dec(raw);
        if (f.kind === "request" && f.method === "changes") {
          requests.push({ id: f.id, port, cursor: (f.params as Map<number, unknown>).get(0) }); return;
        }
        if (f.kind === "request" && f.method === "cancel") {
          cancellations.push(f.id); if (rejectCancel) throw new Error("port failed during cancellation"); return;
        }
        send(raw);
      };
      ports.push(port); return opened;
    } },
  });
  const request = async (index = 0) => { await vi.waitFor(() => expect(requests.length).toBeGreaterThan(index)); return requests[index]!; };
  const reply = (index = 0, value = batch()) => {
    const r = requests[index]!; r.port.onframe?.(clientFrame.enc({ kind: "response", id: r.id, result: changesResult.enc(value) }));
  };
  const push = (value = batch(), index = 0) => ports[index]!.onframe?.(clientFrame.enc({ kind: "push", type: "changes", payload: changesResult.enc(value) }));
  return { client, requests, cancellations, ports, request, reply, push, rejectCancel: () => { rejectCancel = true; } };
}

describe("change watch readiness and local lifetime (actual Client/Session wire models)", () => {
  it("acknowledges an empty first batch and retains callable-stop compatibility", async () => {
    const f = await fixture(), changed = vi.fn(); const watch = f.client.watchChanges(undefined, changed);
    const legacyStop: () => void = watch; const exportedType: ChangesWatch = watch;
    try {
      expect(exportedType.state).toBe("starting"); expect(Object.isFrozen(watch)).toBe(true);
      await f.request(); f.reply(); await watch.ready;
      expect(watch.state).toBe("active"); expect(watch.error).toBeNull(); expect(changed).not.toHaveBeenCalled();
      legacyStop(); expect(watch.state).toBe("closed");
    } finally { watch(); f.client.close(); }
  });
  it("exposes an initial refusal rather than silently becoming ready", async () => {
    const f = await fixture(), changed = vi.fn(); const watch = f.client.watchChanges(undefined, changed);
    try {
      const rejected = expect(watch.ready).rejects.toMatchObject({ code: "forbidden" });
      const r = await f.request(); r.port.onframe?.(clientFrame.enc({ kind: "response", id: r.id, problem: { code: "forbidden", message: "denied", recovery: "reauthorize" } }));
      await rejected; expect(watch.state).toBe("failed"); expect(watch.error?.code).toBe("forbidden");
      f.push(batch("late", "late.md")); expect(changed).not.toHaveBeenCalled();
    } finally { watch(); f.client.close(); }
  });
  it("rejects malformed initial results", async () => {
    const f = await fixture(), watch = f.client.watchChanges(undefined, () => {});
    try {
      const rejected = expect(watch.ready).rejects.toMatchObject({ code: "internal" });
      const r = await f.request(); r.port.onframe?.(clientFrame.enc({ kind: "response", id: r.id, result: new Map<number, CborValue>([[0, []], [1, "cursor"], [2, "not-bool"]]) }));
      await rejected; expect(watch.state).toBe("failed");
    } finally { watch(); f.client.close(); }
  });
  it("stop cancels the first request and fences its late result/pushes", async () => {
    const f = await fixture(), changed = vi.fn(), watch = f.client.watchChanges(undefined, changed);
    try {
      const rejected = expect(watch.ready).rejects.toMatchObject({ code: "cancelled" });
      await f.request(); watch(); await rejected;
      f.reply(0, batch("late", "late.md")); f.push(batch("later", "later.md")); await Promise.resolve();
      expect(watch.state).toBe("closed"); expect(changed).not.toHaveBeenCalled(); expect(f.cancellations).toHaveLength(1);
    } finally { watch(); f.client.close(); }
  });
  it("stop before start sends no watch request", async () => {
    const f = await fixture(), watch = f.client.watchChanges(undefined, () => {});
    const rejected = expect(watch.ready).rejects.toMatchObject({ code: "cancelled" });
    watch(); await rejected; await Promise.resolve(); expect(f.requests).toHaveLength(0); f.client.close();
  });
  it("handles a cancellation send failure without retaining the request", async () => {
    const f = await fixture(), watch = f.client.watchChanges(undefined, () => {});
    try {
      const rejected = expect(watch.ready).rejects.toMatchObject({ code: "cancelled" });
      await f.request(); const session = f.client.currentSession(); f.rejectCancel(); watch(); await rejected;
      expect(session["pending"].size).toBe(0); expect(watch.state).toBe("closed");
    } finally { watch(); f.client.close(); }
  });
  it("client close before acknowledgement cannot produce a late ready callback", async () => {
    const f = await fixture(), changed = vi.fn(), watch = f.client.watchChanges(undefined, changed);
    const rejected = expect(watch.ready).rejects.toBeDefined();
    await f.request(); f.client.close(); await rejected; f.reply(0, batch("late", "late.md"));
    await Promise.resolve(); expect(watch.state).toBe("closed"); expect(changed).not.toHaveBeenCalled(); watch();
  });
  it("buffers bounded startup pushes until the initial batch is delivered", async () => {
    const f = await fixture(), paths: string[] = [], watch = f.client.watchChanges(undefined, b => paths.push(...b.changes.map(c => c.path)));
    try {
      await f.request(); f.push(batch("second", "second.md")); f.push(batch("third", "third.md"));
      expect(paths).toEqual([]); f.reply(0, batch("first", "first.md")); await watch.ready;
      expect(paths).toEqual(["first.md", "second.md", "third.md"]); expect(watch.state).toBe("active");
    } finally { watch(); f.client.close(); }
  });
  it("stop from the initial callback purges startup pushes and rejects readiness", async () => {
    const f = await fixture(), paths: string[] = [];
    const watch = f.client.watchChanges(undefined, b => { paths.push(...b.changes.map(c => c.path)); watch(); });
    try {
      const rejected = expect(watch.ready).rejects.toMatchObject({ code: "cancelled" });
      await f.request(); f.push(batch("queued", "queued.md")); f.reply(0, batch("first", "first.md")); await rejected;
      expect(paths).toEqual(["first.md"]); expect(watch.state).toBe("closed");
    } finally { watch(); f.client.close(); }
  });
  it.each(["count", "weight"])("rejects startup queue %s exhaustion, never partial active success", async limit => {
    const f = await fixture(), changed = vi.fn(), watch = f.client.watchChanges(undefined, changed);
    try {
      const rejected = expect(watch.ready).rejects.toMatchObject({ code: "unavailable" }); await f.request();
      if (limit === "count") for (let i = 0; i < 17; i++) f.push(batch(String(i), "queued.md"));
      else f.push(batch("large", "x".repeat(600_000)));
      await rejected; f.reply(0, batch("late", "late.md")); await Promise.resolve();
      expect(watch.state).toBe("failed"); expect(changed).not.toHaveBeenCalled();
    } finally { watch(); f.client.close(); }
  });
  it("reports malformed pushes without pretending the subscription remains active", async () => {
    const f = await fixture(), watch = f.client.watchChanges(undefined, () => {});
    try {
      await f.request(); f.reply(); await watch.ready;
      f.ports[0]!.onframe?.(clientFrame.enc({ kind: "push", type: "changes", payload: null }));
      expect(watch.state).toBe("failed"); expect(watch.error?.code).toBe("internal");
    } finally { watch(); f.client.close(); }
  });
  it("old-session results/pushes cannot activate a new generation", async () => {
    const f = await fixture(true), paths: string[] = [], states: string[] = [];
    const watch = f.client.watchChanges(undefined, b => paths.push(...b.changes.map(c => c.path)));
    const off = watch.subscribe(state => states.push(state));
    try {
      await f.request(); f.reply(0, batch("old-cursor")); await watch.ready;
      const late = f.ports[0]!.onframe!; f.ports[0]!.close(); await f.request(1);
      expect(watch.state).toBe("starting"); expect(states).toContain("stale");
      expect(f.requests[1]!.cursor).toBe("old-cursor");
      late(clientFrame.enc({ kind: "push", type: "changes", payload: changesResult.enc(batch("wrong", "old.md")) }));
      expect(paths).toEqual([]); expect(watch.state).toBe("starting");
      f.reply(1, batch("new", "new.md")); await vi.waitFor(() => expect(watch.state).toBe("active"));
      expect(paths).toEqual(["new.md"]);
    } finally { off(); watch(); f.client.close(); }
  });
  it("throwing state observers do not interrupt terminal cleanup", async () => {
    const f = await fixture(), watch = f.client.watchChanges(undefined, () => {});
    try {
      watch.subscribe(() => { throw new Error("observer"); }); const rejected = expect(watch.ready).rejects.toBeDefined();
      await f.request(); f.client.close(); await rejected; expect(watch.state).toBe("closed");
    } finally { watch(); f.client.close(); }
  });
});
