import { afterEach, describe, expect, it } from "vitest";
import { connect, type MdbaseClient } from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";

const app = { name: "memory faults", version: "0" };
const open: MdbaseClient[] = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });
async function client(replica: MemoryReplica) {
  const c = await connect({ connector: replica.connector(), app });
  open.push(c);
  return c;
}

describe("MemoryReplica fault parity", () => {
  it("failNextWrite refuses once; stalled writes stay pending until confirmed", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: 0 });
    const c = await client(replica);
    replica.failNextWrite();
    await expect(c.submit([{ kind: "create", id: crypto.randomUUID(), path: "a.md", body: "a" }])).rejects.toMatchObject({ code: "unavailable" });
    await expect.poll(() => c.ledger.getSnapshot().pending.length).toBe(0);
    replica.stallConfirmations();
    const saved = await c.save(c.submit([{ kind: "create", id: crypto.randomUUID(), path: "b.md", body: "b" }]).then((w) => w[0]!), { timeoutMs: 50 });
    expect(saved.outcome).toBe("saved_on_device");
    expect(c.ledger.getSnapshot().pending).toHaveLength(1);
    replica.confirmAll();
    await expect.poll(() => c.ledger.getSnapshot().pending.length).toBe(0);
  });

  it("remote edits, renames and deletes arrive as typed changes", async () => {
    const replica = new MemoryReplica();
    const r = replica.seed({ path: "t.md", types: ["task"], frontmatter: { done: false } });
    const c = await client(replica);
    const start = (await c.changes()).cursor;
    replica.editElsewhere(r.id, { frontmatter: { done: true } });
    expect((await c.get(r.id)).frontmatter.get("done")).toBe(true);
    replica.renameElsewhere(r.id, "u.md");
    expect((await c.get(r.id)).path).toBe("u.md");
    replica.deleteElsewhere(r.id);
    await expect(c.get(r.id)).rejects.toMatchObject({ code: "not_found" });
    const seen = (await c.changes(start)).changes;
    expect(seen.map((ch) => ch.kind)).toEqual(["put", "remove", "put", "remove"]);
    expect(seen.every((ch) => ch.types?.[0] === "task")).toBe(true);
  });

  it("holds and conflicts round trip; describe lists seeded types; Bases reads decode", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: 0 });
    const r = replica.seed({ path: "n.md", types: ["note"], frontmatter: { title: "N" }, body: "mine" });
    replica.seedType("note", { fields: { title: { type: "string" } } });
    const view = replica.seedBaseView({ path: "views/notes.base", types: ["note"], columns: ["file.name", "title"] });
    const holdId = replica.hold(r.id, { theirs: "theirs" });
    const entry = replica.conflict(r.id, { field: "title", kept: "K", lost: "L" });
    const c = await client(replica);
    expect((await c.getStatus()).holds).toBe(1);
    await c.resolveHold(holdId, "take_theirs");
    expect(await c.listHolds()).toEqual([]);
    expect((await c.get(r.id, { body: true })).body).toBe("theirs");
    expect(await c.listConflicts(r.id)).toEqual([entry]);
    await c.dismissConflict(entry);
    expect(await c.listConflicts()).toEqual([]);
    expect((await c.describe()).types.map((t) => t.name)).toContain("note");

    const rows = await c.executeAppBases({ record: view.record, sourceRevision: view.sourceRevision, ordinal: view.ordinal, hints: new Map(), captureTimezone: "UTC" });
    expect(rows.kind).toBe("success");
    const views = await c.listAppBasesViews({ captureTimezone: "UTC", limit: 16 });
    expect(views.kind === "success" && views.views.map((v) => v.path)).toEqual(["views/notes.base"]);
  });

  it("loseNextResponse: a write whose reply was lost is captured once and settles", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: 0 });
    const c = await client(replica);
    replica.loseNextResponse();
    const id = crypto.randomUUID();
    const outcome = await c.submit([{ kind: "create", id, path: "lost.md", body: "x" }]).then(() => "ok", (e) => e.code);
    expect(outcome).toBe("ok");
    await expect.poll(async () => (await c.get(id).catch(() => null))?.path, { timeout: 5000 }).toBe("lost.md");
    await expect.poll(() => c.ledger.getSnapshot().pending.length, { timeout: 5000 }).toBe(0);
  });
});
