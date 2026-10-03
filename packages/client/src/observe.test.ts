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
        values: Object.fromEntries((input.select ?? []).map((field: string) => [field.slice(5), r.file[field.slice(5)] ?? []]))
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
  it.each([true, false])("loads full-row pages without discovery/document RPCs (metadata support: %s)", async metadata => {
    const f = authority(metadata), original = { ...row("a.md"), frontmatter: { nested: { tags: ["input"] } } };
    f.records.set(original.path, original);
    const o = f.client.observe({ includeBody: true, frontmatterMode: "both", limit: 1 }, { mode: "manual" });
    const pages: Array<ReturnType<typeof o.getSnapshot>> = [];
    o.subscribe((snapshot, delta) => {
      if (delta.reason === "page") {
        pages.push(snapshot);
        expect(delta.upserts).toHaveLength(1);
        expect(delta.removed).toEqual([]);
        expect(Object.isFrozen(delta.upserts)).toBe(true);
      } else expect(delta.upserts).toEqual([]);
    });
    expect((await o.ready).ok).toBe(true);
    expect(f.request.mock.calls.map(([op]) => op)).toEqual(["query", "query"]);
    for (const [, input] of f.request.mock.calls) expect(input).toMatchObject({ include_body: true, frontmatter_mode: "both" });
    expect(pages.map(page => page.records.length)).toEqual([1, 2]);
    expect(pages[0]!.records[0]).toBe(o.getSnapshot().records[0]);
    expect(o.getSnapshot().records[0]).toMatchObject({ revision: "a.md", body: "a.md", effectiveFrontmatter: { title: "a.md" } });
    original.frontmatter.nested.tags.push("external mutation");
    expect(pages[0]!.records[0]!.frontmatter).toEqual({ nested: { tags: ["input"] } });
    expect(Object.isFrozen((pages[0]!.records[0]!.frontmatter as any).nested.tags)).toBe(true);
    o.close();
  });

  it("bounds read-ahead to one page and cancels that page when a subscriber closes", async () => {
    const f = authority(), original = f.request.getMockImplementation()!;
    let waiting = false, cancelled = false;
    f.request.mockImplementation(async (op, input, options) => {
      if (op === "query" && (input as any).offset === 1) {
        waiting = true;
        await new Promise<void>((_, reject) => options!.signal!.addEventListener("abort", () => {
          cancelled = true; reject(connectError("operation_cancelled", "Closed"));
        }, { once: true }));
      }
      return original(op, input, options);
    });
    const o = f.client.observe({}, { mode: "manual", pageSize: 1 });
    o.subscribe((snapshot, delta) => {
      if (delta.reason !== "page") return;
      expect(waiting).toBe(true);
      expect(f.request.mock.calls).toHaveLength(2);
      expect(snapshot.records).toHaveLength(1);
      o.close();
    });
    expect(await o.ready).toMatchObject({ ok: false, problem: { code: "operation_cancelled" } });
    expect(cancelled).toBe(true);
    expect(o.getSnapshot()).toMatchObject({ state: "closed", records: [{ path: "a.md" }] });
    expect(f.request.mock.calls).toHaveLength(2);
  });

  it("keeps page deltas relative to visible rows through overlays, replacement and hydration", async () => {
    const f = authority(), o = f.client.observe({}, { mode: "manual", pageSize: 1 }); await o.ready;
    const visible = new Map(o.getSnapshot().records.map(row => [row.path, row]));
    o.subscribe((snapshot, delta) => {
      for (const path of delta.removed) visible.delete(path);
      for (const row of delta.upserts) visible.set(row.path, row);
      expect([...visible.keys()].sort()).toEqual(snapshot.records.map(row => row.path).sort());
      for (const row of snapshot.records) expect(visible.get(row.path)).toBe(row);
    });
    const overlay = o.optimistic([row("b.md", "local")], ["a.md"]);
    f.records.delete("a.md"); f.records.set("b.md", row("b.md", "remote")); f.records.set("c.md", row("c.md"));
    await o.refresh();
    expect(o.getSnapshot().records[0]?.revision).toBe("local");
    overlay.rollback();
    expect(o.getSnapshot().records[0]?.revision).toBe("remote");
    f.records.delete("c.md"); await o.hydrate();
    expect(o.getSnapshot().records.map(row => row.path)).toEqual(["b.md"]);
    expect(o.getSnapshot().records[0]?.body).toBe("remote"); o.close();
  });

  it("starts a replacement watch without waiting for a retired initial ready promise", async () => {
    const f = authority(); let release!: () => void;
    f.hold(() => new Promise<void>(resolve => { release = resolve; }));
    const o = f.observe(); await until(() => !!release);
    f.hold(); await o.refresh();
    f.records.set("a.md", row("a.md", "replacement-watch")); f.emit();
    await until(() => o.getSnapshot().records[0]?.revision === "replacement-watch");
    release(); expect(await o.ready).toMatchObject({ ok: true });
    expect(o.getSnapshot().records[0]?.revision).toBe("replacement-watch"); o.close();
  });

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
    f.request.mockClear();
    o.optimistic([row("b.md", "accepted")]).commit(); await tick();
    expect(f.request).not.toHaveBeenCalled();
    f.records.delete("a.md"); f.records.set("b.md", row("b.md", "accepted")); await o.refresh();
    expect(o.getSnapshot().records).toHaveLength(1);
    f.records.set("b.md", row("b.md", "later")); await o.refresh();
    expect(o.getSnapshot().records[0]?.revision).toBe("later");
    expect(f.request.mock.calls.some(([op]) => op === "changes")).toBe(false); o.close();
  });

  it("bounds the pending backlog by reloading instead of dropping changes", async () => {
    const f = authority(); const o = f.client.observe({}, { maxPendingPaths: 1, watch: { pollIntervalMs: 100 } }); await o.ready;
    f.records.set("a.md", row("a.md", "changed"));
    f.emit(); f.emit("mdbase.record.modified", { path: "b.md" });
    await until(() => o.getSnapshot().generation > 1 && o.getSnapshot().state === "ready");
    expect(o.getSnapshot().records[0]?.revision).toBe("changed"); o.close();
  });

  it("bounds commit confirmations even while the initial query is paused", async () => {
    const f = authority(); let release!: () => void;
    f.hold(() => new Promise<void>(resolve => { release = resolve; }));
    const o = f.client.observe({}, { maxPendingPaths: 1 });
    try {
      await until(() => !!release); f.hold();
      const accepted = [row("a.md", "accepted-a"), row("b.md", "accepted-b")];
      for (const record of accepted) f.records.set(record.path, record);
      o.optimistic(accepted).commit(); await tick();
      expect(o.getSnapshot().generation).toBe(2);
      expect(await o.ready).toMatchObject({ ok: true });
    } finally { release(); o.close(); }
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
    expect(f.request.mock.calls.filter(([op]) => op === "read").length).toBeGreaterThanOrEqual(2); // two drains; initial pages need no reads
    o.close();
  });

  it("confirms a write whose echo was already being read before acceptance", async () => {
    const f = authority(), o = f.observe(); await o.ready;
    let release!: () => void;
    f.request.mockClear(); f.hold(() => new Promise<void>(resolve => { release = resolve; })); f.emit();
    await until(() => !!release);
    const accepted = row("a.md", "accepted-after-echo");
    f.records.set("a.md", { ...accepted, file: { tags: ["confirmed"] } });
    o.optimistic([accepted]).commit(); f.hold(); release();
    await until(() => o.getSnapshot().records[0]?.file.tags?.[0] === "confirmed");
    expect(f.request.mock.calls.filter(([op]) => op === "query").length).toBeGreaterThanOrEqual(2);
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

  it.each(["during", "after"])("keeps a failed path and the error visible when unrelated changes arrive %s the failed reread", async arrival => {
    const f = authority(), o = f.observe(); await o.ready;
    const original = f.request.getMockImplementation()!;
    let rejectRead!: () => void, sawB = false;
    o.subscribeChanges(change => { if (change.kind === "record.updated" && change.path === "b.md") sawB = true; });
    f.request.mockImplementation(async (op, input, options) => {
      if (op === "read" && (input as any).paths.includes("a.md")) {
        await new Promise<void>((_, reject) => { rejectRead = () => reject(connectError("access_denied", "A denied")); });
      }
      return original(op, input, options);
    });
    try {
      f.records.set("a.md", row("a.md", "changed-a")); f.emit();
      await until(() => !!rejectRead);
      if (arrival === "during") { f.emit("mdbase.record.modified", { path: "b.md" }); await until(() => sawB); }
      rejectRead(); await until(() => o.getSnapshot().state === "error");
      f.records.set("b.md", row("b.md", "changed-b"));
      if (arrival === "after") f.emit("mdbase.record.modified", { path: "b.md" });
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(o.getSnapshot()).toMatchObject({ state: "error", problem: { code: "access_denied" } });
      expect(o.getSnapshot().records.map(row => row.revision)).toEqual(["a.md", "b.md"]);
      f.request.mockImplementation(original); await o.refresh();
      expect(o.getSnapshot()).toMatchObject({ state: "ready", problem: null });
      expect(o.getSnapshot().records.map(row => row.revision)).toEqual(["changed-a", "changed-b"]);
    } finally { o.close(); }
  });

  it("confirms a committed overlay after its watch echo has already finished", async () => {
    const f = authority(), o = f.observe(); await o.ready;
    let reconciled = false;
    o.subscribe((_, delta) => { if (delta.reason === "changes") reconciled = true; });
    const accepted = row("a.md", "accepted-after-drain");
    const overlay = o.optimistic([accepted]);
    f.records.set("a.md", { ...accepted, file: { links: ["target.md"], tags: ["tag"], embeds: ["asset.png"] } });
    f.emit();
    try {
      await until(() => reconciled); await tick();
      expect(o.getSnapshot().records[0]?.file).toEqual({});
      f.request.mockClear(); overlay.commit();
      await until(() => o.getSnapshot().records[0]?.file.links?.[0] === "target.md");
      expect(o.getSnapshot().records[0]?.file).toMatchObject({ tags: ["tag"], embeds: ["asset.png"] });
      expect(f.request.mock.calls.some(([op]) => op === "read")).toBe(false);
    } finally { o.close(); }
  });

  it.each(["refresh", "hydrate"] as const)("settles ready with a superseding initial %s before the retired query settles", async operation => {
    const f = authority(); let release!: () => void;
    f.hold(() => new Promise<void>(resolve => { release = resolve; }));
    const o = f.observe();
    let ready: Awaited<typeof o.ready> | undefined;
    void o.ready.then(value => { ready = value; });
    try {
      await until(() => !!release);
      f.hold(); expect((await o[operation]()).ok).toBe(true); await tick();
      expect(ready).toMatchObject({ ok: true });
      expect(o.getSnapshot()).toMatchObject({ state: "ready", generation: 2 });
    } finally { release(); o.close(); }
  });

  it("marks a permanent watch failure as stopped and ignores later commit work until refresh", async () => {
    const f = authority(), o = f.observe(); await o.ready;
    await tick();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (op, input, options) => {
      if (op === "changes") throw connectError("access_denied", "Watch denied");
      return original(op, input, options);
    });
    try {
      await until(() => o.getSnapshot().state === "error");
      expect(o.getSnapshot()).toMatchObject({ watchStatus: { state: "closed" }, problem: { code: "access_denied" } });
      o.optimistic([row("a.md", "local")]).commit(); await tick();
      expect(o.getSnapshot().state).toBe("error");
    } finally { o.close(); }
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

  it("rejects malformed derived file facts without installing partial upserts or deletions", async () => {
    const f = authority(), o = f.observe(); await o.ready;
    const original = f.request.getMockImplementation()!, before = o.getSnapshot().records;
    f.records.delete("a.md"); f.records.set("b.md", row("b.md", "new"));
    f.request.mockImplementation(async (op, input, options) => {
      const value = await original(op, input, options);
      if (op === "query" && (input as any).output === "metadata") (value as any).result.results[0].values["links"] = null;
      return value;
    });
    f.emit(); f.emit("mdbase.record.modified", { path: "b.md" });
    await until(() => o.getSnapshot().state === "error");
    expect(o.getSnapshot().problem?.code).toBe("invalid_operation_response");
    expect(o.getSnapshot().records).toEqual(before); o.close();
  });

  it("does not start a watch when a subscriber closes the completed scan", async () => {
    const f = authority(), watch = vi.spyOn(f.client, "watch"), o = f.observe();
    o.subscribe(snapshot => { if (snapshot.state === "ready") o.close(); });
    expect((await o.ready).ok).toBe(true);
    expect(o.getSnapshot()).toMatchObject({ state: "closed" });
    expect(o.getSnapshot().records).toHaveLength(2);
    expect(watch).not.toHaveBeenCalled();
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
