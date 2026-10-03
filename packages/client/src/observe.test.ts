import { describe, expect, it, vi } from "vitest";
import { MdbaseCollectionClient } from "./collection-client.js";
import { connectSuccess } from "./outcomes.js";
import { connectError } from "./errors.js";
import type { CollectionOperation, JsonObject } from "@mdbase-dev/connect-protocol";
import type { ConnectRequestOptions, QueryRecord } from "./operation-types.js";

const row = (path: string, title = path): QueryRecord => ({ path, revision: title, types: ["note"], frontmatter: { title }, effectiveFrontmatter: { title }, body: title, file: {} });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check: () => boolean) {
  for (let i = 0; i < 150 && !check(); i++) await tick();
  expect(check()).toBe(true);
}
function authority(metadata = true) {
  const records = new Map([row("a.md"), row("b.md")].map(r => [r.path, r]));
  const events: Array<{ cursor: number; type: string; occurred_at: string; payload: JsonObject }> = [];
  let cursor = 0, reset = false, failures = 0;
  let hold: (() => Promise<void>) | undefined;
  const request = vi.fn(async (operation: CollectionOperation, raw: unknown, options?: ConnectRequestOptions) => {
    const input = raw as Record<string, any>;
    if (operation === "changes") {
      if (failures-- > 0) throw connectError("connector_offline", "Offline");
      const page = { cursor, has_more: false, reset, events: events.filter(e => e.cursor > (input.after ?? cursor)) };
      reset = false;
      return page;
    }
    if (operation === "query") {
      if (input.release_cursor) return { valid: true, result: { results: [] }, diagnostics: [] };
      let selected = [...records.values()];
      if (input.where) {
        const scope = input.where.match(/file.path in (\[.*?\])/);
        if (scope) {
          const paths = JSON.parse(scope[1]);
          selected = selected.filter(r => paths.includes(r.path));
        }
        if (input.where.includes("title")) selected = selected.filter(r => r.frontmatter?.title !== "excluded");
      }
      const offset = input.offset ?? 0;
      const page = selected.slice(offset, offset + (input.limit ?? 1000));
      const results = input.output === "metadata" ? page.map(r => ({ path: r.path, types: r.types, revision: r.revision,
        values: Object.fromEntries((input.select ?? []).map((field: string) => [field, r.file[field.slice(5)] ?? []]))
      })) : page.map(r => ({ ...r, body: input.include_body ? r.body : undefined, effective_frontmatter: r.effectiveFrontmatter }));
      const result = { ...(input.output ? { output: input.output } : {}), results, meta: { has_more: offset + page.length < selected.length } };
      await hold?.();
      return { valid: true, result, diagnostics: [] };
    }
    if (operation === "read") {
      const items = input.paths.map((path: string) => {
        const r = records.get(path);
        return r ? { path, status: "found", record: { ...r, file: { name: "", folder: "", size: 0, mtime: "" }, effective_frontmatter: r.effectiveFrontmatter } } : { path, status: "missing" };
      });
      await hold?.();
      options?.signal?.throwIfAborted();
      return { valid: true, result: { items }, diagnostics: [] };
    }
    throw new Error(operation);
  });
  const client = new MdbaseCollectionClient({ operation: request as any }, null, async () => connectSuccess(metadata));
  const observe = (query = {}) => client.observe(query, { coalesceMs: 5, watch: { pollIntervalMs: 100, retry: { initialDelayMs: 1, maxDelayMs: 1 } } });
  return { records, events, client, request, observe,
    emit(type = "mdbase.record.modified", payload: JsonObject = { path: "a.md" }) { events.push({ cursor: ++cursor, type, occurred_at: "now", payload }); },
    reset() { reset = true; }, fail() { failures = 1; }, hold(fn?: () => Promise<void>) { hold = fn; }
  };
}

describe("observe", () => {
  it("loads progressive immutable pages, then coalesces a continuous burst into readMany", async () => {
    const f = authority();
    const observation = f.client.observe({}, { pageSize: 1, coalesceMs: 10, watch: { pollIntervalMs: 100 } });
    const lengths: number[] = [];
    observation.subscribe(snapshot => lengths.push(snapshot.records.length));
    expect((await observation.ready).ok).toBe(true);
    expect(lengths).toContain(1);
    expect(Object.isFrozen(observation.getSnapshot().records[0]?.frontmatter)).toBe(true);
    f.request.mockClear();
    f.records.set("a.md", row("a.md", "new"));
    for (let i = 0; i < 200; i++) f.emit();
    await until(() => observation.getSnapshot().records[0]?.revision === "new");
    expect(f.request.mock.calls.filter(([operation]) => operation === "read")).toHaveLength(1);
    expect(f.request.mock.calls.some(([operation, input]) => operation === "query" && (input as any).output === "metadata")).toBe(true);
    observation.close();
  });

  it("retains query-derived file links, embeds and tags across document batching", async () => {
    const f = authority();
    f.records.set("a.md", { ...row("a.md"), file: { links: ["old.md"], tags: ["old"], embeds: ["old.png"] } });
    const o = f.observe(); await o.ready;
    expect(o.getSnapshot().records[0]?.file).toMatchObject({ links: ["old.md"], tags: ["old"], embeds: ["old.png"] });
    f.records.set("a.md", { ...row("a.md", "new"), file: { links: ["new.md"], tags: ["new"], embeds: ["new.png"] } }); f.emit();
    await until(() => o.getSnapshot().records[0]?.revision === "new");
    expect(o.getSnapshot().records[0]?.file).toMatchObject({ links: ["new.md"], tags: ["new"], embeds: ["new.png"] }); o.close();
  });

  it("rereads both rename endpoints and confirms delayed deletes against current membership", async () => {
    const f = authority(); const o = f.observe(); await o.ready;
    f.records.delete("a.md"); f.records.set("c.md", row("c.md"));
    f.emit("mdbase.record.renamed", { from: "a.md", to: "c.md" });
    f.emit("mdbase.record.deleted", { path: "b.md" }); // restored before the event arrives
    await until(() => o.getSnapshot().records.some(r => r.path === "c.md"));
    expect(o.getSnapshot().records.map(r => r.path)).toEqual(["b.md", "c.md"]);
    o.close();
  });

  it("uses the authority's query membership, never client-side type/filter semantics", async () => {
    const f = authority(); const o = f.observe({ where: 'title != "excluded"' }); await o.ready;
    f.records.set("a.md", row("a.md", "excluded")); f.emit();
    await until(() => o.getSnapshot().records.length === 1);
    expect(o.getSnapshot().records[0]?.path).toBe("b.md"); o.close();
  });

  it.each(["reset", "gap", "schema"])("fully reconciles %s and starts a new watch", async kind => {
    const f = authority(); const o = f.observe(); await o.ready;
    f.records.delete("a.md");
    if (kind === "reset") f.reset();
    else f.emit(kind === "gap" ? "mdbase.collection.invalidated" : "mdbase.type.changed", {});
    await until(() => o.getSnapshot().generation > 1 && o.getSnapshot().state === "ready");
    expect(o.getSnapshot().records.map(r => r.path)).toEqual(["b.md"]);
    f.records.set("b.md", row("b.md", "after-reset")); f.emit("mdbase.record.modified", { path: "b.md" });
    await until(() => o.getSnapshot().records[0]?.revision === "after-reset"); o.close();
  });

  it("applies an explicitly path-local predicate at the authority before targeted reads", async () => {
    const f = authority();
    const o = f.client.observe({ where: 'title != "excluded"' }, { invalidation: "paths", coalesceMs: 5, watch: { pollIntervalMs: 100 } }); await o.ready;
    f.request.mockClear(); f.records.set("a.md", row("a.md", "excluded")); f.emit();
    await until(() => o.getSnapshot().records.length === 1);
    expect(o.getSnapshot().generation).toBe(1);
    expect(f.request.mock.calls.some(([op, input]) => op === "query" && (input as any).where === '(title != "excluded") && (file.path in ["a.md"])')).toBe(true);
    expect(f.request.mock.calls.some(([op]) => op === "read")).toBe(false); o.close();
  });

  it("rearms targeted reads when a schema reset cancels a debounce timer", async () => {
    const f = authority(); const o = f.observe(); await o.ready;
    f.emit(); f.emit("mdbase.type.changed", {});
    await until(() => o.getSnapshot().generation > 1 && o.getSnapshot().state === "ready");
    f.records.set("a.md", row("a.md", "after-debounce-reset")); f.emit();
    await until(() => o.getSnapshot().records[0]?.revision === "after-debounce-reset"); o.close();
  });

  it("catches events occurring during the initial scan", async () => {
    const f = authority(); let release!: () => void;
    f.hold(() => new Promise<void>(resolve => { release = resolve; }));
    const o = f.observe(); await until(() => !!release);
    f.records.set("a.md", row("a.md", "during-load")); f.emit();
    f.hold(); release(); await o.ready;
    await until(() => o.getSnapshot().records[0]?.revision === "during-load"); o.close();
  });

  it("reconciles an offset-only structural shift that skipped an unchanged row", async () => {
    const f = authority(false);
    const o = f.client.observe({}, { pageSize: 1, coalesceMs: 5, watch: { pollIntervalMs: 100 } });
    let shifted = false;
    o.subscribe((snapshot, delta) => {
      if (delta.reason === "page" && !shifted) { shifted = true; f.records.delete("a.md"); f.emit("mdbase.record.deleted", { path: "a.md" }); }
    });
    await o.ready;
    await until(() => o.getSnapshot().generation > 1 && o.getSnapshot().state === "ready");
    expect(o.getSnapshot().records.map(r => r.path)).toEqual(["b.md"]); o.close();
  });

  it("fences stale loads, exposes cancellation and closes a paused query", async () => {
    const f = authority(); let release!: () => void;
    f.hold(() => new Promise<void>(resolve => { release = resolve; }));
    const o = f.observe(); await until(() => !!release);
    o.close(); f.hold(); release();
    expect(await o.ready).toMatchObject({ ok: false, problem: { code: "operation_cancelled" } });
    expect(o.getSnapshot().state).toBe("closed"); expect(o.getSnapshot().records).toHaveLength(0);
  });

  it("preserves newer local overlays against concurrent remote reads and commits", async () => {
    const f = authority(); const o = f.observe(); await o.ready;
    const first = o.optimistic([row("a.md", "local-1")]);
    const second = o.optimistic([row("a.md", "local-2")]);
    f.records.set("a.md", row("a.md", "local-1"));
    await first.commit();
    expect(o.getSnapshot().records[0]?.revision).toBe("local-2");
    f.records.set("a.md", row("a.md", "local-2")); await second.commit();
    f.records.set("a.md", row("a.md", "external")); f.emit();
    await until(() => o.getSnapshot().records[0]?.revision === "external"); o.close();
  });

  it("manual mode makes no changes/watch requests and refresh retires accepted writes", async () => {
    const f = authority(false); const o = f.client.observe({}, { mode: "manual" }); await o.ready;
    const overlay = o.optimistic([], ["a.md"]); expect(o.getSnapshot().records).toHaveLength(1);
    overlay.rollback(); expect(o.getSnapshot().records).toHaveLength(2);
    f.records.delete("a.md"); await o.refresh();
    expect(o.getSnapshot().records).toHaveLength(1);
    expect(f.request.mock.calls.some(([op]) => op === "changes")).toBe(false); o.close();
  });

  it("bounds the pending backlog by reloading instead of dropping changes", async () => {
    const f = authority(); const o = f.client.observe({}, { maxPendingPaths: 1, watch: { pollIntervalMs: 100 } }); await o.ready;
    f.records.set("a.md", row("a.md", "changed"));
    f.emit(); f.emit("mdbase.record.modified", { path: "b.md" });
    await until(() => o.getSnapshot().generation > 1 && o.getSnapshot().state === "ready");
    expect(o.getSnapshot().records[0]?.revision).toBe("changed"); o.close();
  });

  it("queues a follow-up for a path changed while its read is in flight", async () => {
    const f = authority(); const o = f.observe(); await o.ready;
    let release!: () => void;
    f.hold(() => new Promise<void>(resolve => { release = resolve; }));
    f.records.set("a.md", row("a.md", "first")); f.emit();
    await until(() => !!release);
    f.records.set("a.md", row("a.md", "second")); f.emit();
    await new Promise(resolve => setTimeout(resolve, 110));
    f.hold(); release();
    await until(() => o.getSnapshot().records[0]?.revision === "second");
    expect(f.request.mock.calls.filter(([op]) => op === "read").length).toBeGreaterThanOrEqual(3); // initial + two drains
    o.close();
  });

  it("does not retire an overlay accepted after an older reload started", async () => {
    const f = authority(false); const o = f.client.observe({}, { mode: "manual" }); await o.ready;
    let release!: () => void;
    f.hold(() => new Promise<void>(resolve => { release = resolve; }));
    const refresh = o.refresh(); await until(() => !!release);
    o.optimistic([row("a.md", "accepted-later")]).commit();
    f.hold(); release(); await refresh;
    expect(o.getSnapshot().records[0]?.revision).toBe("accepted-later");
    f.records.set("a.md", row("a.md", "accepted-later")); await o.refresh();
    f.records.set("a.md", row("a.md", "external")); await o.refresh();
    expect(o.getSnapshot().records[0]?.revision).toBe("external"); o.close();
  });

  it("acknowledges a qualified local echo without a document reread, refreshing authority-derived file metadata", async () => {
    const f = authority(); const o = f.observe(); await o.ready;
    f.request.mockClear();
    const accepted = row("a.md", "accepted");
    f.records.set(accepted.path, { ...accepted, file: { links: ["target.md"], tags: ["tag"], embeds: ["asset.png"] } });
    f.emit("mdbase.record.modified", { path: accepted.path, revision: accepted.revision! });
    o.optimistic([accepted]).commit();
    await until(() => o.getSnapshot().records[0]?.file.links?.[0] === "target.md");
    expect(o.getSnapshot().records[0]?.file).toMatchObject({ tags: ["tag"], embeds: ["asset.png"] });
    expect(f.request.mock.calls.some(([op]) => op === "read")).toBe(false);
    expect(o.getSnapshot().records[0]?.revision).toBe("accepted"); o.close();
  });

  it("cancels a stale targeted read across reset reconciliation", async () => {
    const f = authority(); const o = f.observe(); await o.ready;
    let release!: () => void;
    f.hold(() => new Promise<void>(resolve => { release = resolve; })); f.emit();
    await until(() => !!release);
    f.hold(); f.records.delete("a.md"); f.reset();
    await until(() => o.getSnapshot().generation > 1 && o.getSnapshot().state === "ready");
    release(); await tick();
    expect(o.getSnapshot().records.map(r => r.path)).toEqual(["b.md"]); o.close();
  });

  it("keeps existing metadata rows visible during progressive body hydration", async () => {
    const f = authority(false); const o = f.client.observe({}, { mode: "manual", pageSize: 1 }); await o.ready;
    const snapshots: number[] = [];
    o.subscribe(snapshot => snapshots.push(snapshot.records.length));
    await o.hydrate();
    expect(snapshots.every(count => count === 2)).toBe(true); o.close();
  });

  it("fully reloads ordered queries rather than pretending a point read can sort them", async () => {
    const f = authority(); const o = f.observe({ orderBy: [{ field: "file.mtime" }] }); await o.ready;
    f.emit(); await until(() => o.getSnapshot().generation > 1);
    expect(f.request.mock.calls.some(([op]) => op === "read")).toBe(false); o.close();
  });

  it("retains stale rows and reports a failed record batch, not false deletions", async () => {
    const f = authority(); const o = f.observe(); await o.ready;
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (op, input, options) => {
      if (op === "read") throw connectError("access_denied", "Record denied");
      return original(op, input, options);
    });
    f.emit(); await until(() => o.getSnapshot().state === "error");
    expect(o.getSnapshot().records).toHaveLength(2);
    expect(o.getSnapshot().problem?.code).toBe("access_denied");
    f.request.mockImplementation(original); expect((await o.refresh()).ok).toBe(true); o.close();
  });

  it("rejects invalid budgets/aggregate queries before dispatch and honors an already aborted signal", async () => {
    const f = authority();
    for (const value of [0, -1, 1.5, NaN]) expect(() => f.client.observe({}, { maxPendingPaths: value })).toThrow(TypeError);
    expect(() => f.client.observe({ groupBy: [] })).toThrow(TypeError);
    const o = f.client.observe({}, { signal: AbortSignal.abort() });
    expect(await o.ready).toMatchObject({ ok: false }); expect(f.request).not.toHaveBeenCalled();
  });

  it("reconnects with the saved cursor and surfaces permanent reread errors", async () => {
    const f = authority(); const o = f.observe(); await o.ready;
    f.fail(); f.records.set("a.md", row("a.md", "reconnected")); f.emit();
    await until(() => o.getSnapshot().records[0]?.revision === "reconnected");
    f.request.mockImplementationOnce(async () => { throw connectError("access_denied", "Denied"); });
    await o.refresh(); expect(o.getSnapshot()).toMatchObject({ state: "error", problem: { code: "access_denied" } }); o.close();
  });
});
