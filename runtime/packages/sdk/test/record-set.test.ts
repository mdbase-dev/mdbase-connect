// recordSet(): a whole collection read once and kept current, over MemoryReplica.
import { afterEach, describe, expect, it, vi } from "vitest";
import { connect, mdbaseError, RecordSet, type ChangesWatch, type ChangesWatchState, type MdbaseClient, type MdbaseError, type QueryResult, type RecordSetChange, type RecordView } from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";
import type { ChangesResult } from "../src/wire.js";

const clients: MdbaseClient[] = [];
afterEach(() => { vi.useRealTimers(); for (const c of clients.splice(0)) c.close(); });
async function open(replica: MemoryReplica, reconnect = false) {
  const client = await connect({
    connector: replica.connector(), app: { name: "record-set-test", version: "test" },
    reconnect: reconnect ? { minDelayMs: 1, maxDelayMs: 1 } : false,
  });
  clients.push(client);
  return client;
}
const paths = (set: RecordSet) => set.getSnapshot().records.map((r) => r.path).sort();
/** Every change the set reports, as `kind path` (a rename as `put old -> new`). */
function follow(set: RecordSet): string[] {
  const seen: string[] = [];
  set.subscribe((changes: readonly RecordSetChange[]) => {
    for (const c of changes) {
      seen.push(c.kind === "remove" ? `remove ${c.previous.path}`
        : c.previous && c.previous.path !== c.record.path ? `put ${c.previous.path} -> ${c.record.path}` : `put ${c.record.path}`);
    }
  });
  return seen;
}
const current = (set: RecordSet) => vi.waitFor(() => expect(set.getSnapshot().state).toBe("current"));

describe("a record set", () => {
  it("reads a collection larger than one page, showing pages as they arrive", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: 0 });
    for (let i = 0; i < 2_300; i++) replica.seed({ path: `notes/${i}.md` });
    const set = (await open(replica)).recordSet();
    const sizes: number[] = [];
    set.subscribe(() => sizes.push(set.getSnapshot().records.length));
    expect(set.getSnapshot()).toMatchObject({ state: "loading", records: [], problem: null });
    await set.ready;
    expect(set.getSnapshot()).toMatchObject({ state: "current", problem: null });
    expect(set.getSnapshot().records).toHaveLength(2_300);
    expect(sizes).toEqual(expect.arrayContaining([1_000, 2_000, 2_300]));
  });

  it("follows creates, edits, renames and deletes, and says what changed", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: 0 });
    const a = replica.seed({ path: "notes/a.md", frontmatter: { title: "a" } });
    const client = await open(replica), set = client.recordSet();
    await set.ready;
    const seen = follow(set), before = set.getSnapshot();
    replica.seed({ path: "notes/b.md" });
    await vi.waitFor(() => expect(paths(set)).toEqual(["notes/a.md", "notes/b.md"]));
    expect(set.getSnapshot()).not.toBe(before);
    replica.editElsewhere(a.id, { frontmatter: { title: "changed" } });
    await vi.waitFor(() => expect(set.get(a.id)?.frontmatter.title).toBe("changed"));
    replica.renameElsewhere(a.id, "notes/moved.md");
    await vi.waitFor(() => expect(paths(set)).toEqual(["notes/b.md", "notes/moved.md"]));
    replica.deleteElsewhere(a.id);
    await vi.waitFor(() => expect(paths(set)).toEqual(["notes/b.md"]));
    expect(seen).toEqual(["put notes/b.md", "put notes/a.md", "put notes/a.md -> notes/moved.md", "remove notes/moved.md"]);
    expect(set.getSnapshot().state).toBe("current");
  });

  it("keeps the same snapshot until something changes", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: 0 });
    replica.seed({ path: "notes/a.md" });
    const set = (await open(replica)).recordSet();
    await set.ready;
    expect(set.getSnapshot()).toBe(set.getSnapshot());
    expect(Object.isFrozen(set.getSnapshot().records)).toBe(true);
  });

  it("holds only records of its types, as they gain and lose them", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: 0 });
    replica.seed({ path: "tasks/a.md", types: ["Task"] });
    const note = replica.seed({ path: "notes/n.md", types: ["note"] });
    const client = await open(replica), set = client.recordSet({ types: ["task"] });
    await set.ready;
    expect(paths(set)).toEqual(["tasks/a.md"]);
    const find = vi.spyOn(client, "find");
    // A change to a record of other types is not even read.
    replica.editElsewhere(note.id, { body: "still a note" });
    replica.seed({ path: "tasks/b.md", types: ["task"] });
    await vi.waitFor(() => expect(paths(set)).toEqual(["tasks/a.md", "tasks/b.md"]));
    expect(find).toHaveBeenCalledTimes(1);
    note.types = ["task"];
    replica.editElsewhere(note.id, { body: "now a task" });
    await vi.waitFor(() => expect(paths(set)).toEqual(["notes/n.md", "tasks/a.md", "tasks/b.md"]));
    note.types = ["note"];
    replica.editElsewhere(note.id, { body: "a note again" });
    await vi.waitFor(() => expect(paths(set)).toEqual(["tasks/a.md", "tasks/b.md"]));
  });

  it("shows this app's own write as pending, then confirmed", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: null });
    const client = await open(replica), set = client.recordSet();
    await set.ready;
    const write = await client.create({ path: "notes/mine.md", body: "x" });
    await vi.waitFor(() => expect(set.get(write.recordId)?.state.state).toBe("pending"));
    replica.confirmAll();
    await vi.waitFor(() => expect(set.get(write.recordId)?.state.state).toBe("confirmed"));
  });

  it("catches up after a dropped connection from the change feed, without reading everything again", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: 0 });
    const a = replica.seed({ path: "notes/a.md" });
    replica.seed({ path: "notes/b.md" });
    const client = await open(replica, true), set = client.recordSet();
    await set.ready;
    // The feed's cursor is only known once a change has been read.
    replica.seed({ path: "notes/c.md" });
    await vi.waitFor(() => expect(paths(set)).toHaveLength(3));
    const pages = vi.spyOn(client, "pages"), states: string[] = [];
    set.subscribe(() => states.push(set.getSnapshot().state));
    replica.dropConnections();
    replica.deleteElsewhere(a.id);
    replica.seed({ path: "notes/d.md" });
    await vi.waitFor(() => expect(paths(set)).toEqual(["notes/b.md", "notes/c.md", "notes/d.md"]));
    await current(set);
    expect(states).toContain("stale");
    expect(pages).not.toHaveBeenCalled();
  });

  it("reads everything again when the feed cannot say what changed, and reports the difference", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: 0 });
    const a = replica.seed({ path: "notes/a.md" });
    replica.seed({ path: "notes/b.md" });
    const client = await open(replica, true), set = client.recordSet();
    await set.ready;
    const seen = follow(set), watch = vi.spyOn(client, "watchChanges");
    // No change has been read, so the set has no cursor: after the drop the
    // feed starts from now and what happened meanwhile is unread.
    replica.dropConnections();
    replica.deleteElsewhere(a.id);
    replica.seed({ path: "notes/c.md" });
    await vi.waitFor(() => expect(paths(set)).toEqual(["notes/b.md", "notes/c.md"]));
    await current(set);
    expect(seen.sort()).toEqual(["put notes/c.md", "remove notes/a.md"]);
    expect(watch).not.toHaveBeenCalled();
  });

  it("starts the read again when the collection changes under it", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: 0 });
    for (let i = 0; i < 1_500; i++) replica.seed({ path: `notes/${i}.md` });
    const client = await open(replica), query = client.query.bind(client);
    let moved = false;
    vi.spyOn(client, "query").mockImplementation(async (...args) => {
      const page = await query(...args);
      // Between the first page and the second, another device adds a record.
      if (!moved) { moved = true; replica.seed({ path: "notes/late.md" }); }
      return page;
    });
    const set = client.recordSet();
    await set.ready;
    expect(set.getSnapshot().records).toHaveLength(1_501);
  });

  it("reads everything once when more records changed than are worth rereading", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: 0 });
    const client = await open(replica), set = client.recordSet();
    await set.ready;
    const find = vi.spyOn(client, "find");
    for (let i = 0; i < 700; i++) replica.seed({ path: `notes/${i}.md` });
    await vi.waitFor(() => expect(set.getSnapshot().records).toHaveLength(700));
    await current(set);
    // The first few changes are reread one by one before the rest pile up.
    expect(find.mock.calls.length).toBeLessThan(100);
  });

  it("waits out a passing failure by itself", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: 0 });
    replica.seed({ path: "notes/a.md" });
    const client = await open(replica), pages = client.pages.bind(client);
    let failures = 2;
    vi.spyOn(client, "pages").mockImplementation(async function* (...args) {
      if (failures-- > 0) throw mdbaseError("unavailable", "busy");
      yield* pages(...args);
    });
    const set = client.recordSet(), states: string[] = [];
    set.subscribe(() => states.push(`${set.getSnapshot().state}:${set.getSnapshot().problem?.code ?? ""}`));
    await set.ready;
    expect(states).toContain("loading:unavailable");
    expect(set.getSnapshot()).toMatchObject({ state: "current", problem: null });
    expect(paths(set)).toEqual(["notes/a.md"]);
  });

  it("fails on a refusal it cannot wait out, keeps its records, and reloads on request", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: 0 });
    replica.seed({ path: "notes/a.md" });
    const client = await open(replica), set = client.recordSet();
    await set.ready;
    const pages = vi.spyOn(client, "pages").mockImplementation(async function* () {
      throw mdbaseError("forbidden", "access was removed");
    });
    await expect(set.reload()).rejects.toMatchObject({ code: "forbidden" });
    expect(set.getSnapshot()).toMatchObject({ state: "failed", problem: { code: "forbidden", recovery: "reauthorize" } });
    expect(paths(set)).toEqual(["notes/a.md"]);
    pages.mockRestore();
    replica.seed({ path: "notes/b.md" });
    await set.reload();
    expect(set.getSnapshot()).toMatchObject({ state: "current", problem: null });
    expect(paths(set)).toEqual(["notes/a.md", "notes/b.md"]);
  });

  it("rejects ready when the first read fails for good", async () => {
    const client = await open(new MemoryReplica({ confirmDelayMs: 0 }));
    vi.spyOn(client, "pages").mockImplementation(async function* () { throw mdbaseError("forbidden", "no"); });
    const set = client.recordSet();
    await expect(set.ready).rejects.toMatchObject({ code: "forbidden" });
    expect(set.getSnapshot()).toMatchObject({ state: "failed", records: [] });
  });

  it("keeps showing a collection that is still arriving, and reads it again until it is whole", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: 0 });
    replica.seed({ path: "notes/a.md" });
    const client = await open(replica), pages = client.pages.bind(client);
    let arriving = true;
    vi.spyOn(client, "pages").mockImplementation(async function* (...args) {
      for await (const page of pages(...args)) yield (arriving ? { ...page, complete: false } : page) as QueryResult;
    });
    const set = client.recordSet();
    await vi.waitFor(() => expect(paths(set)).toEqual(["notes/a.md"]));
    expect(set.getSnapshot()).toMatchObject({ state: "loading", problem: null });
    replica.seed({ path: "notes/b.md" });
    arriving = false;
    await set.ready;
    expect(paths(set)).toEqual(["notes/a.md", "notes/b.md"]);
  });

  it("closes with its signal and with the client, and stops reporting", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: 0 });
    const client = await open(replica), abort = new AbortController();
    const bySignal = client.recordSet({ signal: abort.signal }), byClient = client.recordSet();
    await Promise.all([bySignal.ready, byClient.ready]);
    const seen = follow(bySignal);
    abort.abort();
    expect(bySignal.getSnapshot().state).toBe("closed");
    replica.seed({ path: "notes/a.md" });
    await vi.waitFor(() => expect(paths(byClient)).toEqual(["notes/a.md"]));
    expect(seen).toEqual([]);
    await expect(bySignal.reload()).rejects.toMatchObject({ code: "cancelled" });
    client.close();
    expect(byClient.getSnapshot().state).toBe("closed");
    const unready = client.recordSet({ signal: abort.signal });
    await expect(unready.ready).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("a record set whose change watch fails", () => {
  const record = (path: string) => ({ id: path, path, revision: "r1", types: [], state: { state: "confirmed", confirmedSeq: 1 } }) as unknown as RecordView;
  /** A client whose watches the test drives by hand. */
  function stub(link: "open" | "closed" = "open") {
    const watches: Array<{ cursor: string | undefined; go(state: ChangesWatchState, error?: MdbaseError): void; changes(batch: ChangesResult): void }> = [];
    const rows = new Map([["a.md", record("a.md")]]);
    const client = {
      link, status: { pending: 0 }, rows, watches,
      onStatus: () => () => {},
      async *pages() { yield { records: [...rows.values()], complete: true, asOf: 1 } as QueryResult; },
      async find(id: string) { return rows.get(id) ?? null; },
      watchChanges(changes: (batch: ChangesResult) => void, o: { cursor?: string } = {}): ChangesWatch {
        let state: ChangesWatchState = "starting", error: MdbaseError | null = null;
        const listeners = new Set<(s: ChangesWatchState, e: MdbaseError | null) => void>();
        const watch = Object.assign(() => {}, { ready: Promise.resolve(), subscribe: (fn: (s: ChangesWatchState, e: MdbaseError | null) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; } });
        Object.defineProperties(watch, { state: { get: () => state }, error: { get: () => error } });
        watches.push({ cursor: o.cursor, changes, go: (next, why) => { state = next; error = why ?? null; for (const fn of [...listeners]) fn(state, error); } });
        return watch as ChangesWatch;
      },
    };
    return client;
  }
  const make = (client: ReturnType<typeof stub>) => new RecordSet(client as unknown as ConstructorParameters<typeof RecordSet>[0]);

  it("replaces the watch and resumes the feed where it had read to", async () => {
    const client = stub(), set = make(client);
    client.watches[0]!.go("active");
    await set.ready;
    client.rows.set("b.md", record("b.md"));
    client.watches[0]!.changes({ cursor: "7", reset: false, changes: [{ id: "b.md", path: "b.md", kind: "put", version: 7 }] });
    await vi.waitFor(() => expect(paths(set)).toEqual(["a.md", "b.md"]));
    client.watches[0]!.go("failed", mdbaseError("unavailable", "change watch startup buffer exceeded"));
    expect(set.getSnapshot()).toMatchObject({ state: "stale", problem: { code: "unavailable" } });
    await vi.waitFor(() => expect(client.watches).toHaveLength(2));
    expect(client.watches[1]!.cursor).toBe("7");
    client.watches[1]!.go("active");
    await current(set);
    expect(set.getSnapshot().problem).toBeNull();
    set.close();
  });

  it("a reload while the watch is being replaced replaces it at once", async () => {
    const client = stub(), set = make(client);
    client.watches[0]!.go("active");
    await set.ready;
    client.watches[0]!.go("failed", mdbaseError("unavailable", "change watch startup buffer exceeded"));
    client.rows.set("b.md", record("b.md"));
    const reloaded = set.reload();
    expect(client.watches).toHaveLength(2);
    client.watches[1]!.go("active");
    await reloaded;
    expect(paths(set)).toEqual(["a.md", "b.md"]);
    set.close();
  });

  it("does not lose a reset that arrives while it is reading everything", async () => {
    const client = stub(), set = make(client), pages = client.pages.bind(client);
    let reads = 0;
    client.pages = async function* () {
      // During the first read the feed says it cannot tell what changed.
      if (reads++ === 0) { client.rows.set("b.md", record("b.md")); client.watches[0]!.changes({ cursor: "9", reset: true, changes: [] }); yield { records: [record("a.md")], complete: true, asOf: 1 } as QueryResult; }
      else yield* pages();
    };
    client.watches[0]!.go("active");
    await set.ready;
    expect(reads).toBe(2);
    expect(paths(set)).toEqual(["a.md", "b.md"]);
    set.close();
  });

  it("fails when the watch was refused, and when the client has closed", async () => {
    const refused = stub(), first = make(refused);
    refused.watches[0]!.go("active");
    await first.ready;
    refused.watches[0]!.go("failed", mdbaseError("forbidden", "access was removed"));
    expect(first.getSnapshot()).toMatchObject({ state: "failed", problem: { code: "forbidden" }, records: [{ path: "a.md" }] });
    const gone = stub("closed"), second = make(gone);
    gone.watches[0]!.go("failed", mdbaseError("unavailable", "link closed"));
    await expect(second.ready).rejects.toMatchObject({ code: "unavailable" });
    expect(gone.watches).toHaveLength(1);
  });
});
