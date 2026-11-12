import { afterEach, describe, expect, it } from "vitest";
import { Float64, type ChangesWatchState, type MdbaseClient, type PlainValue } from "../src/index.js";
import { MemoryReplica, type MemoryContract } from "../src/testing/index.js";

const open: MdbaseClient[] = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });
async function client(replica: MemoryReplica, o: Parameters<MemoryReplica["client"]>[0] = {}) {
  const c = await replica.client(o);
  open.push(c);
  return c;
}

const TASK: MemoryContract = {
  id: "tasks.task", version: "1.0.0", type: "task", fields: { title: "title", done: "status" },
  contractDigest: `sha256:${"a".repeat(64)}`, path: "_contracts/tasks/task.md", binding: { archive: { folder: "Archive" } },
};

describe("MemoryReplica.client", () => {
  it("connects a client that does not reconnect unless asked", async () => {
    const replica = new MemoryReplica();
    const c = await client(replica);
    expect(c.collection).toBe(replica.collection);
    replica.dropConnections();
    await expect.poll(() => c.link).toBe("closed");
    const again = await client(replica, { reconnect: { minDelayMs: 1, maxDelayMs: 5 } });
    replica.dropConnections();
    await expect.poll(() => again.link).toBe("open");
  });
});

describe("MemoryReplica describe", () => {
  it("lists a declared contract and the type that implements it, with no records or type file", async () => {
    const c = await client(new MemoryReplica({ contracts: [TASK] }));
    const described = await c.describe();
    expect(described.contracts).toEqual([{
      id: "tasks.task", version: "1.0.0", path: "_contracts/tasks/task.md", digest: TASK.contractDigest,
      contractType: "record", implementedBy: ["task"],
    }]);
    expect(described.types).toEqual([{
      name: "task", path: "_types/task.md",
      implements: [{
        contract: "tasks.task", version: "1.0.0", fields: { title: "title", done: "status" },
        binding: { archive: { folder: "Archive" } }, digest: expect.stringMatching(/^sha256:/),
      }],
    }]);
  });

  it("names every implementing type once per contract version", async () => {
    const c = await client(new MemoryReplica({ contracts: [TASK, { ...TASK, type: "chore", binding: undefined }, { ...TASK, version: "2.0.0", type: "task" }] }));
    const { contracts, types } = await c.describe();
    expect(contracts.map(x => [x.version, x.implementedBy])).toEqual([["1.0.0", ["chore", "task"]], ["2.0.0", ["task"]]]);
    expect(types.find(t => t.name === "chore")!.implements[0]).not.toHaveProperty("binding");
    expect(types.find(t => t.name === "task")!.implements.map(i => i.version)).toEqual(["1.0.0", "2.0.0"]);
  });

  it("reads a type file's implements list, and follows a write to it", async () => {
    const replica = new MemoryReplica({ contracts: [TASK], confirmDelayMs: 0 });
    const path = replica.seedType("task", { implements: [{ contract: "tasks.task", version: "1.0.0", fields: { title: "name" }, binding: { archive: { folder: "Done" } } }] });
    const c = await client(replica);
    const before = (await c.describe()).types[0]!.implements;
    // The file is the source for fields and binding; the declaration gives the digests.
    expect(before).toEqual([{ contract: "tasks.task", version: "1.0.0", fields: { title: "name" }, binding: { archive: { folder: "Done" } }, digest: expect.stringMatching(/^sha256:/) }]);
    const file = await c.resources.get(path);
    await c.resources.put(path, file.text!.replace("Done", "Later"), { baseRevision: file.revision });
    expect((await c.describe()).types[0]!.implements[0]!.binding).toEqual({ archive: { folder: "Later" } });
  });

  it("lists a contract only a type file names, at the default path", async () => {
    const replica = new MemoryReplica();
    replica.seedType("note", { implements: [{ contract: "notes.note", version: "1.0.0", fields: {} }] });
    const { contracts } = await (await client(replica)).describe();
    expect(contracts).toEqual([expect.objectContaining({ id: "notes.note", path: "_contracts/notes.note.md", implementedBy: ["note"] })]);
  });

  it("refuses a type file whose implements entry names no contract", async () => {
    const replica = new MemoryReplica();
    replica.seedType("note", { implements: [{ version: "1.0.0" }] });
    await expect((await client(replica)).describe()).rejects.toThrow(/needs a contract and a version/);
  });

  it("reads documents through the parser it is given", async () => {
    // A stand-in for the app's YAML parser: nested blocks the default cannot read.
    const parse = (document: string) => {
      const [, head = "", body = ""] = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(document) ?? [];
      const frontmatter: Record<string, PlainValue> = {};
      const implementsList: Record<string, PlainValue>[] = [];
      for (const line of head.split("\n")) {
        const item = /^  - contract: (.+)$/.exec(line), field = /^    (\w+): (.+)$/.exec(line), top = /^(\w+): (.+)$/.exec(line);
        if (item) implementsList.push({ contract: item[1]!, fields: {} });
        else if (field) implementsList.at(-1)![field[1]!] = field[2]!;
        else if (top) frontmatter[top[1]!] = top[2]!;
      }
      if (implementsList.length) frontmatter.implements = implementsList;
      return { frontmatter, body };
    };
    const replica = new MemoryReplica({ parse, confirmDelayMs: 0 });
    replica.seedResource("_types/task.md", "---\nkind: mdbase.type\nname: task\nimplements:\n  - contract: tasks.task\n    version: 1.0.0\n---\n");
    const c = await client(replica);
    expect((await c.describe()).types[0]!.implements).toEqual([expect.objectContaining({ contract: "tasks.task", version: "1.0.0" })]);
    const write = await c.create({ path: "a.md", document: "---\ntitle: Plain text\n---\nBody\n" });
    await write.confirmed;
    expect(await c.get({ path: "a.md" }, { include: { body: true } })).toMatchObject({ frontmatter: { title: "Plain text" }, body: "Body\n" });
  });
});

describe("MemoryReplica seeds", () => {
  it("takes plain frontmatter and the exact forms", async () => {
    const replica = new MemoryReplica();
    const r = replica.seed({ path: "a.md", frontmatter: { meta: { label: "x", tags: ["a"] }, ratio: new Float64(1), big: 2n ** 60n } });
    expect(r.frontmatter.get("meta")).toEqual(new Map<string, unknown>([["label", "x"], ["tags", ["a"]]]));
    expect(r.frontmatter.get("ratio")).toBeInstanceOf(Float64);
    replica.editElsewhere(r.id, { frontmatter: { meta: { label: "y" }, ratio: null } });
    const c = await client(replica);
    expect((await c.get(r.id)).frontmatter).toEqual({ meta: { label: "y" }, big: (2n ** 60n).toString() });
  });
});

describe("MemoryReplica read faults", () => {
  it("failNextRead fails one request of that method and no other", async () => {
    const replica = new MemoryReplica();
    const r = replica.seed({ path: "a.md" });
    const c = await client(replica);
    replica.failNextRead("get");
    expect((await c.query({})).records).toHaveLength(1);
    await expect(c.get(r.id)).rejects.toMatchObject({ code: "unavailable", reason: "storage_busy" });
    expect((await c.get(r.id)).path).toBe("a.md");
    replica.failNextRead("query", { code: "forbidden", recovery: "reauthorize", message: "no" });
    await expect(c.query({})).rejects.toMatchObject({ code: "forbidden" });
  });

  it("pauseReads holds a scan until released", async () => {
    const replica = new MemoryReplica();
    replica.seed({ path: "a.md" });
    const c = await client(replica);
    const release = replica.pauseReads("query");
    let done = false;
    const scan = c.query({}).then(result => { done = true; return result; });
    expect((await c.get({ path: "a.md" })).path).toBe("a.md");
    expect(done).toBe(false);
    // Asking again while held returns the same release.
    expect(replica.pauseReads("query")).toBe(release);
    release();
    expect((await scan).records).toHaveLength(1);
    expect((await c.query({})).records).toHaveLength(1);
  });

  it("drives a change watch through starting, active, stale and failed", async () => {
    const replica = new MemoryReplica();
    const c = await client(replica, { reconnect: { minDelayMs: 1, maxDelayMs: 5 } });
    const states: ChangesWatchState[] = [];
    const release = replica.pauseReads("changes");
    const watch = c.watchChanges(() => {});
    watch.subscribe(state => { if (states.at(-1) !== state) states.push(state); });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(watch.state).toBe("starting");
    release();
    await watch.ready;
    expect(watch.state).toBe("active");
    replica.dropConnections();
    await expect.poll(() => states).toEqual(["starting", "active", "stale", "starting", "active"]);
    watch();

    replica.failNextRead("changes");
    const failing = c.watchChanges(() => {});
    await expect(failing.ready).rejects.toMatchObject({ code: "unavailable" });
    expect(failing.state).toBe("failed");
  });

  it("holds a record set's first scan, then fills it", async () => {
    const replica = new MemoryReplica();
    replica.seed({ path: "a.md", types: ["task"] });
    const c = await client(replica);
    const release = replica.pauseReads("query");
    const set = c.recordSet({ types: ["task"] });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(set.getSnapshot().records).toHaveLength(0);
    release();
    await expect.poll(() => set.getSnapshot().records.length).toBe(1);
    set.close();
  });
});
