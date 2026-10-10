/** SDK wrappers for the replica operations, against MemoryReplica. */
import { describe, expect, it } from "vitest";
import { connect } from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";

const app = { name: "t", version: "0" };
const open = async (r: MemoryReplica) => connect({ app, connector: r.connector(), reconnect: false });

describe("definitions (§4.1)", () => {
  it("reads, writes with CAS, and lists resources", async () => {
    const r = new MemoryReplica({ confirmDelayMs: null });
    r.seedResource("_types/task.md", "---\nname: task\n---\n");
    const c = await open(r);
    const t = await c.resources.get("_types/task.md");
    expect(t.text).toContain("name: task");
    const w = await c.resources.put("_types/task.md", "---\nname: task\nfields: {}\n---\n", { baseRevision: t.revision });
    expect(w.state).toBe("pending");
    expect((await c.resources.get("_types/task.md")).state).toBe("pending");
    const stale = await c.resources.put("_types/task.md", "x", { baseRevision: t.revision });
    expect(stale.receipt.problem).toMatchObject({ code: "conflict", reason: "revision" });
    const dup = await c.resources.put("_types/task.md", "y", { mustNotExist: true });
    expect(dup.receipt.problem).toMatchObject({ code: "conflict", reason: "path_taken" });
    const fresh = await c.resources.put("_types/note.md", "---\nname: note\n---\n", { mustNotExist: true });
    expect(fresh.state).toBe("pending");
    await expect(c.resources.put("x", "y", { mustNotExist: true, baseRevision: t.revision })).rejects.toMatchObject({ code: "invalid_request" });
    r.confirmAll();
    const l = await c.resources.list({ folder: "_types" });
    expect(l.resources.map((x) => [x.path, x.state])).toEqual([
      ["_types/note.md", "confirmed"],
      ["_types/task.md", "confirmed"],
    ]);
    expect((await c.describe()).types.map((x) => x.name)).toContain("task");
    c.close();
  });
});

describe("links: backlinks and preflight (§4.2, §5)", () => {
  it("lists backlinks and previews rename rewrites and broken links on delete", async () => {
    const r = new MemoryReplica({ confirmDelayMs: null });
    const target = r.seed({ path: "notes/target.md", body: "t" });
    r.seed({ path: "a.md", body: "see [[target]] and ![[target]]" });
    r.seed({ path: "b.md", body: "nothing" });
    const c = await open(r);
    const bl = await c.backlinks(target.id);
    expect(bl.backlinks.map((b) => [b.record.path, b.links.length])).toEqual([["a.md", 2]]);
    const t = await c.get(target.id);
    const pr = await c.preflightRename(t, "notes/renamed.md");
    expect(pr.rewrites).toHaveLength(2);
    expect(pr.rewrites[0]!.to).toContain("[[notes/renamed");
    const pd = await c.preflightDelete(t);
    expect(pd.broken.map((b) => b.path)).toEqual(["a.md", "a.md"]);
    // Dry runs change nothing.
    expect((await c.get(target.id)).path).toBe("notes/target.md");
    expect((await c.pendingWrites()).length).toBe(0);
    c.close();
  });
});

describe("pending writes (§6)", () => {
  it("lists this session's pending mutations with their ops", async () => {
    const r = new MemoryReplica({ confirmDelayMs: null });
    const c = await open(r);
    const w = await c.create({ path: "a.md" });
    const p = await c.pendingWrites();
    expect(p.map((x) => [x.receipt.mutation, x.ops[0]!.kind])).toEqual([[w.mutationId, "create"]]);
    r.confirmAll();
    expect(await c.pendingWrites()).toEqual([]);
    c.close();
  });
});

describe("views (§4.3)", () => {
  it("lists views with the contract shape", async () => {
    const c = await open(new MemoryReplica());
    expect(await c.views.list()).toEqual({ sources: [], diagnostics: [], complete: true });
    c.close();
  });
});

describe("authorship (§3.2)", () => {
  it("record-view created_by/modified_by and change author round-trip", async () => {
    const w = await import("../src/wire.js");
    const { decode, encode } = await import("../src/cbor.js");
    const a = { account: "0192f3a4-6000-7abc-8def-0123456789ab", device: "0192f3a4-6000-7abc-8def-0123456789ac", grant: "0192f3a4-6000-7abc-8def-0123456789ad" };
    const ch = w.change.dec(decode(encode(w.change.enc({ id: a.account, path: "c.md", kind: "put", version: 3, author: a }))));
    expect(ch.author).toEqual(a);
    const enc = w.recordView.enc({
      id: a.account,
      path: "c.md",
      revision: `sha256:${"0".repeat(64)}`,
      frontmatter: new Map(),
      types: [],
      state: { state: "confirmed", confirmedSeq: 1 },
      createdBy: a,
      modifiedBy: { account: a.account, device: a.device },
    }) as Map<number, unknown>;
    expect([...enc.keys()]).toContain(13);
    expect(w.recordView.dec(decode(encode(enc as never))).createdBy).toEqual(a);
  });
});
